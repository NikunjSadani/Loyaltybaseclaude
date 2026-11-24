import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Msg91Service } from '../notifications/msg91.service';
import { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import { GifsyTenantGrantService } from '../common/rbac/gifsy-tenant-grant.service';
import type { Permission } from '../common/rbac/permissions';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isGifsyOperator, platformWide } from '../common/tenant-scope';
import { formatDateIST, istDateKey } from '../common/ist-date';
import { allowedRecipientDomains, REPORTS_CLIENT_ID, splitRecipientsByDomain } from '../common/report-recipients';
import {
  FUND_SPEND_TYPE_LABEL,
  FundLine,
  FundRateRow,
  FundStatement,
  periodSummary,
  rateInForce,
  type FundSpendType,
} from './fund-statement.engine';
import { loadFundInputs, type FundInputs } from './fund-sources.loader';
import { buildLowBalanceEmail } from './fund-alert-email';
import { statementOf } from './fund-statement-of';

export { statementOf };
import { istDayStart } from './fund-day';
import {
  FundStatementQueryDto,
  RecordFundAdjustmentDto,
  RecordFundReceiptDto,
  RecordOpeningBalanceDto,
  SetAgencyFeeDto,
  SetItemDiscountDto,
  UpdateFundAlertsDto,
} from './dto/fund.dto';

/** The client low-balance step's own time budget (round 4 item 6) — the digest keeps its own. */
export const FUND_ALERT_BUDGET_MS = 60_000;

const n = (v: bigint | number | null | undefined): number => (v == null ? 0 : Number(v));
const toPaise = (rupees: number): bigint => BigInt(Math.round(rupees * 100));

/** Shown to a client admin instead of a raw mail-server error (C11). */
export const CLIENT_ALERT_ERROR_TEXT = 'The last low-balance e-mail could not be delivered. Gifsy has been notified.';

/** Per-client fund figures for the Daily Ops Digest. */
export interface FundDigestFigures {
  balancePaise: bigint;
  committedPaise: bigint;
  thresholdPaise: bigint | null;
  isLow: boolean;
  hasOpening: boolean;
  /** Items flagged without a rate (voucher item discount / agency fee) — the digest calls them out. */
  missingRates: number;
  recipients: number;
  lastAlertSentOn: string | null;
  lastAlertError: string | null;
}

export type FundAlertStatus =
  | 'sent'
  | 'sent-to-test-address'
  | 'already-sent-today'
  | 'not-low'
  | 'no-threshold'
  | 'no-recipients'
  | 'no-opening'
  | 'client-inactive'
  | 'disabled-in-environment'
  | 'test-recipient-not-internal'
  | 'not-checked-time-budget'
  | 'email-not-configured'
  | 'failed';

export interface FundAlertOutcome {
  clientId: string;
  status: FundAlertStatus;
  error?: string;
  recipients?: number;
}

/**
 * Where low-balance e-mails may go in THIS environment (B5). There was no environment guard for client-facing
 * scheduled e-mails, so this adds one, fail-safe:
 *   FUND_ALERTS_LIVE=true            → the client's configured recipients (set on PRODUCTION only);
 *   else FUND_ALERTS_TEST_RECIPIENT  → ONE test address (subject says who it would have gone to) — staging;
 *   else                             → nothing is sent (outcome "disabled-in-environment", shown in the digest).
 * The test address must be on an INTERNAL domain (REPORTS_RECIPIENT_DOMAINS, default gifsy.in — re-audit B4): any other
 * value is refused loudly (mode "invalid-test", outcome "test-recipient-not-internal"), never used.
 */
export function fundAlertTarget(
  env: NodeJS.ProcessEnv = process.env,
): { mode: 'live' } | { mode: 'test'; to: string } | { mode: 'off' } | { mode: 'invalid-test'; value: string } {
  if ((env.FUND_ALERTS_LIVE ?? '').trim().toLowerCase() === 'true') return { mode: 'live' };
  const t = (env.FUND_ALERTS_TEST_RECIPIENT ?? '').trim().toLowerCase();
  if (!t) return { mode: 'off' };
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) && splitRecipientsByDomain([t], allowedRecipientDomains(env.REPORTS_RECIPIENT_DOMAINS)).allowed.length === 1;
  return ok ? { mode: 'test', to: t } : { mode: 'invalid-test', value: t };
}

type RateDraft = Omit<FundRateRow, 'createdAt'> & { rewardLabel?: string | null; note: string | null };

/**
 * Fund reconciliation (FUND-RECONCILIATION-DESIGN.md). Tenant routes are scoped by the caller's (assumed) clientId;
 * the settings routes live in the Gifsy console (owner D6) and target a client by slug. Reads: Gifsy operators with
 * payouts:read + CLIENT_ADMIN of the own tenant. Writes: Gifsy operators holding payouts:manage_fund. Every write is
 * audited. Spend is COMPUTED on read (fund-sources.loader + the pure engine) — nothing here touches a money path.
 */
@Injectable()
export class FundService {
  private readonly logger = new Logger(FundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly msg91: Msg91Service,
    private readonly gifsyRoles: GifsyRoleService,
    private readonly grants: GifsyTenantGrantService,
  ) {}

  // ── Guards ──────────────────────────────────────────────────────────────────────────────────

  /** The client this caller works on. An un-assumed Gifsy owner has no client context → 400. */
  tenantOf(user: JwtPayload): string {
    if (platformWide(user) || !user.clientId || user.clientId === REPORTS_CLIENT_ID) {
      throw new BadRequestException('Open a client first (switch into the client from the Gifsy console) to see or record its fund.');
    }
    return user.clientId;
  }

  /** The caller's effective permission (GIFSY_ADMIN all; GIFSY_STAFF = its GifsyRole; CLIENT_ADMIN read only). */
  async hasPermission(user: JwtPayload, perm: Permission): Promise<boolean> {
    if (user.role === 'GIFSY_ADMIN') return true;
    if (user.role === 'GIFSY_STAFF') return (await this.gifsyRoles.getPermissions(user.gifsyRoleId)).has(perm);
    if (user.role === 'CLIENT_ADMIN') return perm === 'payouts:read';
    return false;
  }

  /** May record receipts / adjustments / the opening balance (and change settings in the console). */
  async canManage(user: JwtPayload): Promise<boolean> {
    return isGifsyOperator(user) && (await this.hasPermission(user, 'payouts:manage_fund'));
  }

  private async assertManage(user: JwtPayload): Promise<string> {
    const clientId = this.tenantOf(user);
    if (!(await this.canManage(user))) throw new ForbiddenException('Only Gifsy can record fund entries.');
    return clientId;
  }

  /** Gifsy console target (owner D6): an operator; a staff member only for a client they hold a grant for. */
  async consoleClient(user: JwtPayload, slug: string, write: boolean): Promise<string> {
    if (!isGifsyOperator(user)) throw new ForbiddenException('Forbidden');
    if (!(await this.hasPermission(user, write ? 'payouts:manage_fund' : 'payouts:read'))) {
      throw new ForbiddenException(`Forbidden: missing permission ${write ? 'payouts:manage_fund' : 'payouts:read'}`);
    }
    if (user.role === 'GIFSY_STAFF' && !(await this.grants.hasGrantUncached(user.sub, slug))) {
      throw new ForbiddenException('You do not have access to this client.');
    }
    const c = await this.prisma.client.findUnique({ where: { id: slug }, select: { id: true } });
    if (!c || slug === REPORTS_CLIENT_ID) throw new NotFoundException(`Client "${slug}" not found.`);
    return slug;
  }

  // ── Computation ─────────────────────────────────────────────────────────────────────────────

  async compute(clientId: string): Promise<{ inputs: FundInputs; stmt: FundStatement }> {
    const inputs = await loadFundInputs(this.prisma, clientId);
    return { inputs, stmt: statementOf(inputs) };
  }

  private async settingsRow(clientId: string) {
    return this.prisma.fundSettings.findUnique({ where: { clientId } });
  }

  private async clientActive(clientId: string): Promise<{ active: boolean; name: string }> {
    const c = await this.prisma.client.findUnique({ where: { id: clientId }, select: { status: true, internalName: true, branding: true } });
    const display = ((c?.branding ?? {}) as Record<string, unknown>).displayName;
    const name = typeof display === 'string' && display.trim() ? display.trim() : c?.internalName ?? clientId;
    return { active: !c || (c.status ?? 'ACTIVE') === 'ACTIVE', name };
  }

  // ── Reads ───────────────────────────────────────────────────────────────────────────────────

  async summary(user: JwtPayload) {
    const clientId = this.tenantOf(user);
    const [{ stmt }, settings, client, canManage] = await Promise.all([
      this.compute(clientId),
      this.settingsRow(clientId),
      this.clientActive(clientId),
      this.canManage(user),
    ]);
    return this.summaryDto(clientId, stmt, settings, { canManage, internal: isGifsyOperator(user), clientActive: client.active });
  }

  summaryDto(
    clientId: string,
    stmt: FundStatement,
    settings: {
      lowBalanceThresholdPaise: bigint | null;
      alertRecipients: unknown;
      lowAlertLastSentOn: string | null;
      lowAlertLastError: string | null;
      lowAlertLastRecipients?: number | null;
      lowAlertLastStatus?: string | null;
      lowAlertLastCheckedAt?: Date | null;
    } | null,
    o: { canManage: boolean; internal: boolean; clientActive: boolean },
  ) {
    const t = stmt.totals;
    const threshold = settings?.lowBalanceThresholdPaise ?? null;
    const err = settings?.lowAlertLastError ?? null;
    return {
      clientId,
      asOf: new Date().toISOString(),
      openingDate: stmt.openingDate ? stmt.openingDate.toISOString() : null,
      hasOpening: !!stmt.openingDate,
      canManage: o.canManage,
      /** Settings are managed in the Gifsy console (owner D6); a Gifsy operator gets the link. */
      settingsConsoleHref: o.internal ? `/admin/fund/settings` : null,
      totals: {
        openingPaise: n(t.openingPaise),
        receiptsPaise: n(t.receiptsPaise),
        adjustmentsPaise: n(t.adjustmentsPaise),
        committedPaise: n(t.committedPaise),
        paidPaise: n(t.paidPaise),
        returnedPaise: n(t.returnedPaise),
        balancePaise: n(t.balancePaise),
        // Committed spend is already deducted from the balance, so what is available IS the balance (design §4).
        availablePaise: n(t.balancePaise),
        faceTotalPaise: n(t.faceTotalPaise),
        discountTotalPaise: n(t.discountTotalPaise),
        feeTotalPaise: n(t.feeTotalPaise),
        tdsTotalPaise: n(t.tdsTotalPaise),
      },
      byType: stmt.byType.map((b) => ({
        type: b.type,
        label: FUND_SPEND_TYPE_LABEL[b.type],
        count: b.count,
        facePaise: n(b.facePaise),
        discountPaise: n(b.discountPaise),
        feePaise: n(b.feePaise),
        committedPaise: n(b.committedPaise),
        paidPaise: n(b.paidPaise),
        returnedPaise: n(b.returnedPaise),
        returnedCount: b.returnedCount,
        netChargedPaise: n(b.netChargedPaise),
      })),
      receivables: {
        totalPaise: n(stmt.receivables.totalPaise),
        items: stmt.receivables.items.map((r) => ({
          ref: r.ref,
          description: r.description,
          type: r.type,
          sourceKind: r.source.kind,
          sourceId: r.source.id,
          paidAt: r.paidAt ? r.paidAt.toISOString() : null,
          amountPaise: n(r.amountPaise),
        })),
      },
      preOpeningReturns: {
        facePaise: n(stmt.preOpeningReturns.facePaise),
        items: stmt.preOpeningReturns.items.map((r) => ({
          ref: r.ref,
          type: r.type,
          returnedAt: r.returnedAt.toISOString(),
          facePaise: n(r.facePaise),
          sourceKind: r.source.kind,
          sourceId: r.source.id,
        })),
      },
      excludedEntries: stmt.excludedEntries.map((e) => ({ id: e.id, kind: e.kind, amountPaise: n(e.amountPaise), date: e.date.toISOString(), ref: e.ref })),
      flagCounts: stmt.flagCounts,
      itemsWithoutRate: stmt.itemsWithoutRate,
      lowBalance: {
        thresholdPaise: threshold == null ? null : n(threshold),
        isLow: threshold != null && t.balancePaise < threshold,
        /** Why daily e-mails are paused (A7): no opening balance yet, or the client is not ACTIVE. */
        alertsPaused: threshold == null ? null : !stmt.openingDate ? 'NO_OPENING' : !o.clientActive ? 'CLIENT_INACTIVE' : null,
        lastAlertSentOn: settings?.lowAlertLastSentOn ?? null,
        lastAlertRecipients: settings?.lowAlertLastRecipients ?? null,
        // A client admin never sees a raw mail-server error (C11).
        lastAlertError: err == null ? null : o.internal ? err : CLIENT_ALERT_ERROR_TEXT,
        recipients: recipientsOf(settings?.alertRecipients).length,
        /** Re-audit B4: said plainly to everyone — on this server alert e-mails do not reach the client. */
        emailsSwitchedOff: fundAlertTarget().mode !== 'live',
        /** Re-audit B2: the last daily check (never a silent skip). */
        lastCheck: settings?.lowAlertLastStatus ? { status: settings.lowAlertLastStatus, at: settings.lowAlertLastCheckedAt ? settings.lowAlertLastCheckedAt.toISOString() : null } : null,
      },
    };
  }

  async statement(user: JwtPayload, q: FundStatementQueryDto) {
    const clientId = this.tenantOf(user);
    const { stmt } = await this.compute(clientId);
    const from = q.from ? istDayStart(q.from) : null;
    // `to` is inclusive of that IST day.
    const to = q.to ? new Date(istDayStart(q.to).getTime() + 24 * 3600_000) : null;
    if (from && to && from.getTime() >= to.getTime()) throw new BadRequestException('"from" must be on or before "to"');
    const needle = q.q?.trim().toLowerCase() ?? '';
    const filtered = stmt.lines.filter(
      (l) =>
        (!from || l.date.getTime() >= from.getTime()) &&
        (!to || l.date.getTime() < to.getTime()) &&
        (!q.type || l.type === q.type) &&
        (!q.status || l.status === q.status) &&
        (!q.event || l.event === q.event) &&
        (!needle ||
          l.ref.toLowerCase().includes(needle) ||
          l.description.toLowerCase().includes(needle) ||
          (l.utr ?? '').toLowerCase().includes(needle)),
    );
    if ((q.order ?? 'desc') === 'desc') filtered.reverse();
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const slice = filtered.slice((page - 1) * limit, page * limit);
    const ps = periodSummary(stmt, from, to);
    return {
      lines: slice.map(lineDto),
      pagination: { page, limit, total: filtered.length, pages: Math.max(1, Math.ceil(filtered.length / limit)) },
      period: {
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null,
        /** The period figures cover ALL spend types / statuses of the date range (C6) — never the other filters. */
        scope: 'ALL_TYPES_FOR_PERIOD' as const,
        openingBalancePaise: n(ps.openingBalancePaise),
        closingBalancePaise: n(ps.closingBalancePaise),
        openingEntryPaise: n(ps.openingEntryPaise),
        receiptsPaise: n(ps.receiptsPaise),
        adjustmentsPaise: n(ps.adjustmentsPaise),
        chargesPaise: n(ps.chargesPaise),
        returnsPaise: n(ps.returnsPaise),
        byType: ps.byType.map((b) => ({
          type: b.type,
          label: FUND_SPEND_TYPE_LABEL[b.type],
          count: b.count,
          facePaise: n(b.facePaise),
          discountPaise: n(b.discountPaise),
          feePaise: n(b.feePaise),
          chargesPaise: n(b.chargesPaise),
          returnsPaise: n(b.returnsPaise),
        })),
      },
    };
  }

  async entries(user: JwtPayload) {
    const clientId = this.tenantOf(user);
    const rows = await this.prisma.fundReceipt.findMany({
      where: { clientId },
      orderBy: [{ receivedAt: 'desc' }, { createdAt: 'desc' }],
    });
    const names = await this.userNames(rows.map((r) => r.createdByUserId));
    return {
      entries: rows.map((r) => ({
        id: r.id,
        entryType: r.entryType,
        receiptNumber: r.receiptNumber,
        amountPaise: n(r.amountPaise),
        date: r.receivedAt.toISOString(),
        paymentMode: r.paymentMode,
        referenceNumber: r.referenceNumber,
        bankName: r.bankName,
        notes: r.notes,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
        createdByName: r.createdByUserId ? names.get(r.createdByUserId) ?? null : null,
      })),
    };
  }

  /** GET /v1/fund/settings — READ-ONLY view for /admin/fund (the settings are managed in the console, owner D6). */
  async tenantSettings(user: JwtPayload) {
    const clientId = this.tenantOf(user);
    return this.settingsView(clientId, user);
  }

  /** GET /v1/gifsy/clients/:slug/fund — the console Fund section. */
  async consoleSettings(user: JwtPayload, slug: string) {
    const clientId = await this.consoleClient(user, slug, false);
    return this.settingsView(clientId, user);
  }

  private async settingsView(clientId: string, user: JwtPayload) {
    const [settings, rates, catalogue, canManage] = await Promise.all([
      this.settingsRow(clientId),
      this.prisma.fundRate.findMany({ where: { clientId }, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }] }),
      this.prisma.rewardCatalog.findMany({
        where: { clientId, redemptionMode: 'GIFT_CARD' },
        select: { id: true, name: true, code: true, metadata: true, deletedAt: true, status: true },
        orderBy: { name: 'asc' },
      }),
      this.canManage(user),
    ]);
    const internal = isGifsyOperator(user);
    const names = await this.userNames(rates.map((r) => r.createdById));
    const now = new Date();
    const feeRows = rates.filter((r) => r.kind === 'AGENCY_FEE');
    const discRows = rates.filter((r) => r.kind === 'VOUCHER_DISCOUNT');
    const cur = rateInForce(feeRows, now);
    const nextOf = <T extends { effectiveFrom: Date; createdAt: Date }>(rows: T[]) =>
      rows.filter((r) => r.effectiveFrom.getTime() > now.getTime()).sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())[0] ?? null;
    const nextFee = nextOf(feeRows);
    const err = settings?.lowAlertLastError ?? null;
    const rateDto = (r: (typeof rates)[number]) => ({
      id: r.id,
      feeType: r.feeType,
      rewardId: r.rewardId,
      rewardLabel: r.rewardLabel,
      rateBps: r.rateBps,
      flatPaise: r.flatPaise == null ? null : n(r.flatPaise),
      effectiveFrom: r.effectiveFrom.toISOString(),
      note: r.note,
      repricedLines: r.repricedLines,
      repriceDeltaPaise: r.repriceDeltaPaise == null ? null : n(r.repriceDeltaPaise),
      createdAt: r.createdAt.toISOString(),
      createdByName: r.createdById ? names.get(r.createdById) ?? null : null,
    });
    const items = catalogue.map((c) => {
      const rows = discRows.filter((d) => d.rewardId === c.id);
      const r = rateInForce(rows, now);
      const nx = nextOf(rows);
      return {
        rewardId: c.id,
        name: c.name,
        code: c.code,
        brandText: brandTextOf(c.metadata),
        deleted: !!c.deletedAt,
        active: !c.deletedAt && c.status === 'ACTIVE',
        currentRateBps: r?.rateBps ?? null,
        currentEffectiveFrom: r ? r.effectiveFrom.toISOString() : null,
        scheduledRateBps: nx?.rateBps ?? null,
        scheduledFrom: nx ? nx.effectiveFrom.toISOString() : null,
      };
    });
    return {
      clientId,
      canManage,
      managedInConsole: true,
      consoleHref: internal ? `/admin/fund/settings` : null,
      thresholdPaise: settings?.lowBalanceThresholdPaise == null ? null : n(settings.lowBalanceThresholdPaise),
      alertRecipients: recipientsOf(settings?.alertRecipients),
      lastAlertSentOn: settings?.lowAlertLastSentOn ?? null,
      lastAlertRecipients: settings?.lowAlertLastRecipients ?? null,
      lastAlertError: err == null ? null : internal ? err : CLIENT_ALERT_ERROR_TEXT,
      alertEnvironment: internal ? fundAlertTarget().mode : null,
      emailsSwitchedOff: fundAlertTarget().mode !== 'live',
      lastCheck: settings?.lowAlertLastStatus ? { status: settings.lowAlertLastStatus, at: settings.lowAlertLastCheckedAt ? settings.lowAlertLastCheckedAt.toISOString() : null } : null,
      currentFee: cur
        ? { feeType: cur.feeType, rateBps: cur.rateBps, flatPaise: cur.flatPaise == null ? null : n(cur.flatPaise), effectiveFrom: cur.effectiveFrom.toISOString() }
        : null,
      scheduledFee: nextFee
        ? { feeType: nextFee.feeType, rateBps: nextFee.rateBps, flatPaise: nextFee.flatPaise == null ? null : n(nextFee.flatPaise), effectiveFrom: nextFee.effectiveFrom.toISOString() }
        : null,
      feeRates: feeRows.map(rateDto),
      discountRates: discRows.map(rateDto),
      items,
    };
  }

  // ── Writes: receipts / adjustments / opening (tenant routes, Gifsy only, audited) ─────────────

  private todayKey(): string {
    return istDateKey(new Date());
  }

  private assertNotFuture(key: string, what: string) {
    if (key > this.todayKey()) throw new BadRequestException(`${what} cannot be in the future`);
  }

  /** Serialise fund writes per client (receipt numbering + the opening-date checks). */
  private async lock(tx: Prisma.TransactionClient, clientId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fund:${clientId}`}))`;
  }

  private async nextNumber(tx: Prisma.TransactionClient, clientId: string, prefix: string, dateKey: string): Promise<string> {
    const count = await tx.fundReceipt.count({ where: { clientId } });
    return `${prefix}-${dateKey.replace(/-/g, '')}-${String(count + 1).padStart(4, '0')}-${randomBytes(2).toString('hex').toUpperCase()}`;
  }

  private async assertAfterOpening(tx: Prisma.TransactionClient, clientId: string, at: Date, what: string) {
    const opening = await tx.fundReceipt.findFirst({ where: { clientId, entryType: 'OPENING_BALANCE' }, select: { receivedAt: true } });
    if (opening && at.getTime() < opening.receivedAt.getTime()) {
      throw new BadRequestException(
        `${what} is dated before the opening balance date (${formatDateIST(opening.receivedAt)}) — it is already inside the opening balance. Record an adjustment dated on/after the opening date instead.`,
      );
    }
  }

  /** B9: a receipt-number clash (P2002 on the per-client unique) → a clear 409, nothing saved. */
  private numberClash(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new ConflictException('Two entries were recorded at the same moment and got the same number — nothing was saved. Please try again.');
    }
    throw e;
  }

  async recordReceipt(user: JwtPayload, dto: RecordFundReceiptDto) {
    const clientId = await this.assertManage(user);
    this.assertNotFuture(dto.receivedOn, 'The date received');
    const at = istDayStart(dto.receivedOn);
    const amountPaise = toPaise(dto.amountRupees);
    if (amountPaise <= 0n) throw new BadRequestException('Amount must be more than ₹0');
    const ref = dto.referenceNumber.trim();
    if (!ref) throw new BadRequestException('UTR / reference is required');
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lock(tx, clientId);
        await this.assertAfterOpening(tx, clientId, at, 'This receipt');
        // B7: the same UTR in another case / with spaces is the same receipt.
        const dup = await tx.fundReceipt.findFirst({
          where: { clientId, entryType: 'RECEIPT', referenceNumber: { equals: ref, mode: 'insensitive' } },
          select: { receiptNumber: true },
        });
        if (dup) throw new ConflictException(`A receipt with UTR / reference "${ref}" is already recorded (${dup.receiptNumber}).`);
        const receipt = await tx.fundReceipt.create({
          data: {
            clientId,
            entryType: 'RECEIPT',
            receiptNumber: await this.nextNumber(tx, clientId, 'FR', dto.receivedOn),
            amountPaise,
            receivedAt: at,
            paymentMode: dto.paymentMode?.trim() || 'BANK_TRANSFER',
            referenceNumber: ref,
            bankName: dto.bankName?.trim() || null,
            notes: dto.notes?.trim() || null,
            createdByUserId: user.sub,
          },
        });
        await tx.auditLog.create({
          data: {
            action: 'CREATE',
            entityType: 'FUND_RECEIPT',
            entityId: receipt.id,
            actorId: user.sub,
            newValues: { clientId, entryType: 'RECEIPT', amountPaise: amountPaise.toString(), receivedOn: dto.receivedOn, referenceNumber: ref },
          },
        });
        return { id: receipt.id, receiptNumber: receipt.receiptNumber, amountPaise: n(amountPaise) };
      });
    } catch (e) {
      return this.numberClash(e);
    }
  }

  async recordAdjustment(user: JwtPayload, dto: RecordFundAdjustmentDto) {
    const clientId = await this.assertManage(user);
    this.assertNotFuture(dto.date, 'The adjustment date');
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException('A reason is required for an adjustment');
    const at = istDayStart(dto.date);
    const amountPaise = toPaise(dto.amountRupees);
    if (amountPaise === 0n) throw new BadRequestException('An adjustment cannot be ₹0');
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lock(tx, clientId);
        await this.assertAfterOpening(tx, clientId, at, 'This adjustment');
        const row = await tx.fundReceipt.create({
          data: {
            clientId,
            entryType: 'ADJUSTMENT',
            receiptNumber: await this.nextNumber(tx, clientId, 'FA', dto.date),
            amountPaise,
            receivedAt: at,
            paymentMode: 'ADJUSTMENT',
            reason,
            createdByUserId: user.sub,
          },
        });
        await tx.auditLog.create({
          data: {
            action: 'CREATE',
            entityType: 'FUND_ADJUSTMENT',
            entityId: row.id,
            actorId: user.sub,
            newValues: { clientId, entryType: 'ADJUSTMENT', amountPaise: amountPaise.toString(), date: dto.date, reason },
          },
        });
        return { id: row.id, receiptNumber: row.receiptNumber, amountPaise: n(amountPaise) };
      });
    } catch (e) {
      return this.numberClash(e);
    }
  }

  async recordOpening(user: JwtPayload, dto: RecordOpeningBalanceDto) {
    const clientId = await this.assertManage(user);
    this.assertNotFuture(dto.asOfDate, 'The opening balance date');
    const at = istDayStart(dto.asOfDate);
    const amountPaise = toPaise(dto.amountRupees);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lock(tx, clientId);
        const existing = await tx.fundReceipt.findFirst({ where: { clientId, entryType: 'OPENING_BALANCE' }, select: { receiptNumber: true } });
        if (existing) {
          // Owner D2 (2026-11-23): the opening balance can never be changed; a correction is an adjustment.
          throw new ConflictException(`An opening balance is already recorded (${existing.receiptNumber}) and cannot be changed. Correct it with an adjustment.`);
        }
        const earlier = await tx.fundReceipt.count({ where: { clientId, receivedAt: { lt: at } } });
        if (earlier > 0) {
          throw new BadRequestException(
            `${earlier} receipt(s)/adjustment(s) are dated before ${dto.asOfDate}; they would fall inside the opening balance. Choose an opening date on/before the earliest entry.`,
          );
        }
        const row = await tx.fundReceipt.create({
          data: {
            clientId,
            entryType: 'OPENING_BALANCE',
            receiptNumber: await this.nextNumber(tx, clientId, 'FO', dto.asOfDate),
            amountPaise,
            receivedAt: at,
            paymentMode: 'OPENING_BALANCE',
            notes: dto.notes?.trim() || null,
            createdByUserId: user.sub,
          },
        });
        await tx.auditLog.create({
          data: {
            action: 'CREATE',
            entityType: 'FUND_OPENING_BALANCE',
            entityId: row.id,
            actorId: user.sub,
            newValues: { clientId, entryType: 'OPENING_BALANCE', amountPaise: amountPaise.toString(), asOfDate: dto.asOfDate },
          },
        });
        return { id: row.id, receiptNumber: row.receiptNumber, amountPaise: n(amountPaise) };
      });
    } catch (e) {
      // The partial unique index is the last line of defence against a concurrent second opening.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('An opening balance is already recorded for this client.');
      }
      throw e;
    }
  }

  // ── Writes: settings (Gifsy console, owner D6) ────────────────────────────────────────────────

  async updateAlerts(user: JwtPayload, slug: string, dto: UpdateFundAlertsDto) {
    const clientId = await this.consoleClient(user, slug, true);
    const recipients = [...new Set(dto.alertRecipients.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const threshold = dto.thresholdRupees == null ? null : toPaise(dto.thresholdRupees);
    if (threshold != null && recipients.length === 0) {
      throw new BadRequestException('Add at least one alert recipient for the low-balance threshold (or clear the threshold).');
    }
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.fundSettings.findUnique({ where: { clientId } });
      const row = await tx.fundSettings.upsert({
        where: { clientId },
        create: { clientId, lowBalanceThresholdPaise: threshold, alertRecipients: recipients, updatedById: user.sub },
        update: { lowBalanceThresholdPaise: threshold, alertRecipients: recipients, updatedById: user.sub },
      });
      await tx.auditLog.create({
        data: {
          action: before ? 'UPDATE' : 'CREATE',
          entityType: 'FUND_SETTINGS',
          entityId: clientId,
          actorId: user.sub,
          oldValues: before
            ? { lowBalanceThresholdPaise: before.lowBalanceThresholdPaise?.toString() ?? null, alertRecipients: before.alertRecipients as Prisma.InputJsonValue }
            : undefined,
          newValues: { lowBalanceThresholdPaise: threshold?.toString() ?? null, alertRecipients: recipients },
        },
      });
      return { thresholdPaise: row.lowBalanceThresholdPaise == null ? null : n(row.lowBalanceThresholdPaise), alertRecipients: recipients };
    });
  }

  async setAgencyFee(user: JwtPayload, slug: string, dto: SetAgencyFeeDto) {
    const clientId = await this.consoleClient(user, slug, true);
    let rateBps: number | null = null;
    let flatPaise: bigint | null = null;
    if (dto.feeType === 'PERCENT') {
      if (dto.percent == null) throw new BadRequestException('Enter the agency fee %');
      if (dto.flatRupees != null) throw new BadRequestException('A % fee has no flat ₹ amount');
      rateBps = Math.round(dto.percent * 100);
    } else {
      if (dto.flatRupees == null) throw new BadRequestException('Enter the flat ₹ fee per payout');
      if (dto.percent != null) throw new BadRequestException('A flat fee has no %');
      flatPaise = toPaise(dto.flatRupees);
    }
    return this.saveRate(user, clientId, {
      kind: 'AGENCY_FEE',
      feeType: dto.feeType,
      rateBps,
      flatPaise,
      effectiveFrom: istDayStart(dto.effectiveFrom),
      note: dto.note?.trim() || null,
    }, dto.confirmToken);
  }

  /** Owner D4: the voucher discount is per voucher ITEM (RewardCatalog id) of this client. */
  async setItemDiscount(user: JwtPayload, slug: string, dto: SetItemDiscountDto) {
    const clientId = await this.consoleClient(user, slug, true);
    const item = await this.prisma.rewardCatalog.findFirst({
      where: { id: dto.rewardId, clientId, redemptionMode: 'GIFT_CARD' },
      select: { id: true, name: true },
    });
    if (!item) throw new BadRequestException("That voucher item is not in this client's catalogue.");
    return this.saveRate(user, clientId, {
      kind: 'VOUCHER_DISCOUNT',
      rewardId: item.id,
      rewardLabel: item.name,
      rateBps: Math.round(dto.percent * 100),
      effectiveFrom: istDayStart(dto.effectiveFrom),
      note: dto.note?.trim() || null,
    }, dto.confirmToken);
  }

  /**
   * Owner D1 (2026-11-23): a BACK-DATED rate (effectiveFrom ≤ now — incl. today, which re-prices lines committed
   * earlier today) re-prices already-committed lines. The first call returns a PREVIEW (lines re-priced, balance
   * change, period) and a confirm token; only a second call carrying that token saves — server-enforced. If the
   * figures moved in between, the token no longer matches → 409 and a fresh preview is needed. The saved row records
   * the re-pricing (→ an informational statement line) and the audit has old/new + the delta. A future-dated rate
   * re-prices nothing and saves at once.
   */
  private async saveRate(user: JwtPayload, clientId: string, draft: RateDraft, confirmToken?: string) {
    const now = new Date();
    const backdated = draft.effectiveFrom.getTime() <= now.getTime();
    // 1) Back-dated, no token yet → the preview only (nothing written).
    if (backdated && !confirmToken) {
      const preview = repricePreview(clientId, await loadFundInputs(this.prisma, clientId), draft, now);
      return {
        saved: false,
        requiresConfirmation: true,
        preview: {
          linesRepriced: preview.linesRepriced,
          deltaPaise: n(preview.deltaPaise),
          effectiveFrom: draft.effectiveFrom.toISOString(),
          from: (preview.repricedFrom ?? draft.effectiveFrom).toISOString(),
          to: now.toISOString(),
        },
        confirmToken: preview.token,
      };
    }
    // 2) The save — ATOMIC (re-audit A2/B3): a per-client advisory lock, then the preview is RECOMPUTED and the token
    //    verified INSIDE the transaction. A double-click / two concurrent confirms serialise on the lock; the second
    //    sees the first row in the rates fingerprint → token mismatch → 409, never a double save.
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fund-rate:${clientId}`}))`;
        let preview: { linesRepriced: number; deltaPaise: bigint; repricedFrom: Date | null; token: string } | null = null;
        if (backdated) {
          const cutoff = confirmToken ? tokenCutoff(confirmToken) : null;
          if (!cutoff) throw new ConflictException('The confirmation is not valid — review the preview and confirm again.');
          const txInputs = await loadFundInputs(tx as never, clientId);
          const verify = repricePreview(clientId, txInputs, draft, now, cutoff);
          if (!timingSafeEqualStr(confirmToken!, verify.token)) {
            throw new ConflictException('The figures changed since the preview (new spend or another rate change). Review the new preview and confirm again.');
          }
          // Round 5 N6: the figures STORED (statement line + audit) cover everything committed up to the confirm —
          // incl. spend between the preview and now — recomputed inside this transaction.
          preview = repricePreview(clientId, txInputs, draft, now, now);
        }
        // B5: the audit row names the rate in force before this one (future-dated rows too).
        const sameKind = await tx.fundRate.findMany({
          where: { clientId, kind: draft.kind, ...(draft.kind === 'VOUCHER_DISCOUNT' ? { rewardId: draft.rewardId ?? null } : {}) },
          select: { feeType: true, rateBps: true, flatPaise: true, effectiveFrom: true, createdAt: true, kind: true, rewardId: true },
        });
        const previous = rateInForce(sameKind as FundRateRow[], draft.effectiveFrom);
        const created = await tx.fundRate.create({
          data: {
            clientId,
            kind: draft.kind,
            feeType: draft.feeType ?? null,
            rewardId: draft.rewardId ?? null,
            rewardLabel: draft.rewardLabel ?? null,
            rateBps: draft.rateBps ?? null,
            flatPaise: draft.flatPaise ?? null,
            effectiveFrom: draft.effectiveFrom,
            note: draft.note,
            repricedLines: preview ? preview.linesRepriced : null,
            repriceDeltaPaise: preview ? preview.deltaPaise : null,
            repricedFrom: preview ? preview.repricedFrom : null,
            createdById: user.sub,
          },
        });
        await tx.auditLog.create({
          data: {
            action: 'CREATE',
            entityType: 'FUND_RATE',
            entityId: created.id,
            actorId: user.sub,
            oldValues: previous
              ? { feeType: previous.feeType ?? null, rateBps: previous.rateBps ?? null, flatPaise: previous.flatPaise?.toString() ?? null, effectiveFrom: previous.effectiveFrom.toISOString() }
              : { previousRate: null },
            newValues: {
              clientId,
              kind: created.kind,
              rewardId: created.rewardId,
              feeType: created.feeType,
              rateBps: created.rateBps,
              flatPaise: created.flatPaise?.toString() ?? null,
              effectiveFrom: created.effectiveFrom.toISOString(),
              note: created.note,
              backdated,
              ...(preview ? { linesRepriced: preview.linesRepriced, balanceDeltaPaise: preview.deltaPaise.toString() } : {}),
            },
          },
        });
        return { created, preview };
      },
      // The recompute reads the client's spend inside the transaction — give it room (tens of thousands of rows).
      { maxWait: 10_000, timeout: 120_000 },
    );
    return {
      saved: true,
      id: result.created.id,
      scheduled: !backdated,
      effectiveFrom: result.created.effectiveFrom.toISOString(),
      ...(result.preview ? { linesRepriced: result.preview.linesRepriced, deltaPaise: n(result.preview.deltaPaise) } : {}),
    };
  }

  private async userNames(ids: Array<string | null>): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((x): x is string => !!x))];
    if (uniq.length === 0) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  // ── Digest line + daily low-balance e-mail (ONE statement compute, inside the digest run) ─────

  /**
   * For the Daily Ops Digest (called per tenant INSIDE the digest's lease + time budget — A7): the figures and, when
   * due, today's low-balance e-mail, from ONE statement compute. null figures = no fund set-up (no line). Alerts are
   * skipped (and say why) for a client without an opening balance, a non-ACTIVE client, no threshold / recipients.
   * At most one e-mail per client per IST day (compare-and-set claim; released on failure or relay rejection — B6, so
   * a forced re-run retries). Never throws for an e-mail problem; never blocks anything.
   */
  async digestAndAlert(
    clientId: string,
    nowMs: number,
    opts: { send?: boolean; deadlineMs?: number; clock?: () => number } = {},
  ): Promise<{ figures: FundDigestFigures | null; alert?: FundAlertOutcome }> {
    const [settings, entryCount, rateCount] = await Promise.all([
      this.settingsRow(clientId),
      this.prisma.fundReceipt.count({ where: { clientId } }),
      this.prisma.fundRate.count({ where: { clientId } }),
    ]);
    if (!settings && entryCount === 0 && rateCount === 0) return { figures: null };
    const { stmt } = await this.compute(clientId);
    const threshold = settings?.lowBalanceThresholdPaise ?? null;
    const to = recipientsOf(settings?.alertRecipients);
    const isLow = threshold != null && stmt.totals.balancePaise < threshold;
    const figures: FundDigestFigures = {
      balancePaise: stmt.totals.balancePaise,
      committedPaise: stmt.totals.committedPaise,
      thresholdPaise: threshold,
      isLow,
      hasOpening: !!stmt.openingDate,
      missingRates: (stmt.flagCounts.NO_ITEM_RATE ?? 0) + (stmt.flagCounts.NO_FEE_RATE ?? 0),
      recipients: to.length,
      lastAlertSentOn: settings?.lowAlertLastSentOn ?? null,
      lastAlertError: settings?.lowAlertLastError ?? null,
    };
    if (opts.send === false) return { figures };
    if (threshold == null) return { figures, alert: { clientId, status: 'no-threshold' } };
    if (!stmt.openingDate) return { figures, alert: { clientId, status: 'no-opening' } };
    const client = await this.clientActive(clientId);
    if (!client.active) return { figures, alert: { clientId, status: 'client-inactive' } };
    if (!isLow) return { figures, alert: { clientId, status: 'not-low' } };
    if (to.length === 0) return { figures, alert: { clientId, status: 'no-recipients' } };
    const today = istDateKey(new Date(nowMs));
    if (settings!.lowAlertLastSentOn === today) return { figures, alert: { clientId, status: 'already-sent-today', recipients: settings!.lowAlertLastRecipients ?? to.length } };
    const target = fundAlertTarget();
    if (target.mode === 'off') return { figures, alert: { clientId, status: 'disabled-in-environment' } };
    if (target.mode === 'invalid-test') {
      const error = `FUND_ALERTS_TEST_RECIPIENT "${target.value}" is not on an internal domain (${allowedRecipientDomains().join(', ')}) — refused, nothing sent.`;
      this.logger.error(`Fund low-balance alert for ${clientId}: ${error}`);
      return { figures, alert: { clientId, status: 'test-recipient-not-internal', error } };
    }
    if (!this.msg91.isEmailConfigured()) {
      const error = 'E-mail is not configured on this server (MSG91_SMTP_PASS) — the low-balance e-mail was NOT sent.';
      await this.prisma.fundSettings.update({ where: { clientId }, data: { lowAlertLastError: error } });
      this.logger.error(`Fund low-balance alert for ${clientId}: ${error}`);
      return { figures, alert: { clientId, status: 'email-not-configured', error } };
    }
    // Past the alert step's budget (the step already recorded "not checked") → never send late.
    if (opts.deadlineMs != null && (opts.clock ?? Date.now)() >= opts.deadlineMs) {
      return { figures, alert: { clientId, status: 'not-checked-time-budget' } };
    }
    // Claim today's send (compare-and-set) so two concurrent runs can never both e-mail.
    const claim = await this.prisma.fundSettings.updateMany({
      where: { clientId, OR: [{ lowAlertLastSentOn: null }, { lowAlertLastSentOn: { not: today } }] },
      data: { lowAlertLastSentOn: today },
    });
    if (claim.count === 0) return { figures, alert: { clientId, status: 'already-sent-today', recipients: to.length } };
    const release = (error: string) =>
      this.prisma.fundSettings.update({ where: { clientId }, data: { lowAlertLastSentOn: settings!.lowAlertLastSentOn, lowAlertLastError: error } });
    const mail = buildLowBalanceEmail({
      clientName: client.name,
      dateLabel: formatDateIST(new Date(nowMs)),
      balancePaise: stmt.totals.balancePaise,
      committedPaise: stmt.totals.committedPaise,
      thresholdPaise: threshold,
    });
    const sendTo = target.mode === 'live' ? to : [target.to];
    const subject = target.mode === 'live' ? mail.subject : `[TEST — would go to ${to.length} recipient(s): ${to.join(', ')}] ${mail.subject}`;
    try {
      const res = await this.msg91.sendEmail({ to: sendTo, subject, html: mail.html });
      if (res.rejected.length > 0) {
        const error = `the mail relay rejected ${res.rejected.join(', ')}`;
        await release(error); // B6: a forced re-run retries
        this.logger.error(`Fund low-balance alert for ${clientId}: ${error}`);
        return { figures, alert: { clientId, status: 'failed', error, recipients: sendTo.length } };
      }
      await this.prisma.fundSettings.update({ where: { clientId }, data: { lowAlertLastError: null, lowAlertLastRecipients: sendTo.length } });
      await this.prisma.auditLog.create({
        data: {
          action: 'EXPORT',
          entityType: 'FUND_LOW_BALANCE_ALERT',
          entityId: clientId,
          metadata: { clientId, date: today, mode: target.mode, recipients: sendTo, balancePaise: stmt.totals.balancePaise.toString(), thresholdPaise: threshold.toString() },
        },
      });
      return { figures, alert: { clientId, status: target.mode === 'live' ? 'sent' : 'sent-to-test-address', recipients: sendTo.length } };
    } catch (e) {
      const error = ((e as Error)?.message ?? String(e)).slice(0, 300);
      await release(error);
      this.logger.error(`Fund low-balance alert for ${clientId} failed: ${error}`);
      return { figures, alert: { clientId, status: 'failed', error, recipients: sendTo.length } };
    }
  }

  /**
   * The client low-balance e-mails as their OWN step of the daily run (re-audit B2) — independent of the internal
   * digest's early exits (no digest recipients, list unreadable, digest already sent today). Every client with a
   * threshold is checked once; the outcome (sent / not-low / no-opening / switched off / failed …) is stored on its
   * settings row (lowAlertLastStatus / lowAlertLastCheckedAt — shown in the console and the client view) and returned
   * for the digest, so a skip is never silent. Never throws.
   */
  async runLowBalanceAlerts(
    nowMs: number,
    budgetMs = FUND_ALERT_BUDGET_MS,
    clock: () => number = () => Date.now(),
  ): Promise<{ results: Map<string, { figures: FundDigestFigures | null; alert?: FundAlertOutcome }>; error?: string }> {
    const results = new Map<string, { figures: FundDigestFigures | null; alert?: FundAlertOutcome }>();
    let rows: Array<{ clientId: string }>;
    try {
      rows = await this.prisma.fundSettings.findMany({
        where: { lowBalanceThresholdPaise: { not: null }, clientId: { not: REPORTS_CLIENT_ID } },
        select: { clientId: true },
      });
    } catch (e) {
      const error = ((e as Error)?.message ?? String(e)).slice(0, 300);
      this.logger.error(`Fund low-balance alerts: could not read the settings: ${error}`);
      return { results, error };
    }
    const deadline = clock() + budgetMs;
    for (const { clientId } of rows) {
      let r: { figures: FundDigestFigures | null; alert?: FundAlertOutcome };
      if (clock() >= deadline) {
        // Own time budget (round 4 item 6): the rest are recorded as not checked — never a silent skip.
        this.logger.error(`Fund low-balance alert for ${clientId}: not checked — the step's time budget was used up`);
        r = { figures: null, alert: { clientId, status: 'not-checked-time-budget' } };
        results.set(clientId, r);
        try {
          await this.prisma.fundSettings.update({ where: { clientId }, data: { lowAlertLastStatus: r.alert!.status, lowAlertLastCheckedAt: new Date(nowMs) } });
        } catch (e) {
          this.logger.error(`Fund low-balance alert for ${clientId}: could not record the outcome: ${(e as Error)?.message ?? e}`);
        }
        continue;
      }
      try {
        // Round 5 N5: race the client's computation against what is left of the budget. A timed-out client is
        // "not checked — time budget"; its computation cannot send afterwards (digestAndAlert re-checks the deadline
        // right before claiming the day's e-mail).
        const remaining = Math.max(0, deadline - clock());
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), remaining);
        });
        const raced = await Promise.race([this.digestAndAlert(clientId, nowMs, { deadlineMs: deadline, clock }), timeout]);
        if (timer) clearTimeout(timer);
        if (raced === 'timeout') {
          this.logger.error(`Fund low-balance alert for ${clientId}: not checked — the step's time budget ran out during its check`);
          r = { figures: null, alert: { clientId, status: 'not-checked-time-budget' } };
        } else {
          r = raced;
        }
      } catch (e) {
        const error = ((e as Error)?.message ?? String(e)).slice(0, 300);
        this.logger.error(`Fund low-balance alert for ${clientId} failed: ${error}`);
        r = { figures: null, alert: { clientId, status: 'failed', error } };
      }
      results.set(clientId, r);
      try {
        await this.prisma.fundSettings.update({
          where: { clientId },
          data: { lowAlertLastStatus: r.alert?.status ?? null, lowAlertLastCheckedAt: new Date(nowMs) },
        });
      } catch (e) {
        this.logger.error(`Fund low-balance alert for ${clientId}: could not record the outcome: ${(e as Error)?.message ?? e}`);
      }
    }
    return { results };
  }
}

/**
 * Owner D1 preview: the statement with and without the new rate (saved "now"). Lines re-priced = spend lines whose
 * charge differs; delta = the balance change (negative = the advance goes down). The token binds the client, the
 * exact rate and the computed figures — a confirm whose figures no longer match is refused.
 */
export function repricePreview(
  clientId: string,
  inputs: FundInputs,
  draft: RateDraft,
  now: Date,
  /** Only lines committed BEFORE this instant count (the preview's own timestamp — carried inside the token). */
  cutoff: Date = now,
): { linesRepriced: number; deltaPaise: bigint; repricedFrom: Date | null; token: string } {
  const before = statementOf(inputs);
  const newRow: FundRateRow = { ...draft, createdAt: now };
  const after = statementOf({ ...inputs, rates: [...inputs.rates, newRow] });
  // Re-audit round 4 item 7: the preview + token cover only spend committed BEFORE the preview was made, so new spend
  // arriving between the preview and the confirm (it is charged at the new rate anyway) never forces another 409.
  // Returned items net to zero and are not "re-priced".
  const charged = (st: FundStatement) => {
    const m = new Map<string, { charged: bigint; at: Date }>();
    for (const l of st.lines) {
      if (l.event !== 'CHARGE' || l.status === 'RETURNED' || l.date.getTime() >= cutoff.getTime()) continue;
      m.set(`${l.source.kind}:${l.source.id}:${l.ref}`, { charged: l.chargedPaise, at: l.date });
    }
    return m;
  };
  const bMap = charged(before);
  const aMap = charged(after);
  let lines = 0;
  let deltaPaise = 0n;
  let from: Date | null = null;
  for (const [k, v] of aMap) {
    const old = bMap.get(k);
    const oldCharged = old?.charged ?? 0n;
    if (oldCharged !== v.charged) {
      lines += 1;
      deltaPaise += oldCharged - v.charged; // a higher charge takes more off the advance
      if (!from || v.at.getTime() < from.getTime()) from = v.at;
    }
  }
  const fingerprint = inputs.rates.length + ':' + inputs.rates.reduce((m, r) => Math.max(m, r.createdAt.getTime()), 0);
  // Round 5 N6: an HMAC keyed with the API's existing JWT_SECRET (the app refuses to boot without it — jwt.strategy),
  // so a token can only come from this server's own preview; no new secret / env var.
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set — cannot sign the rate-change confirmation.');
  const hash = createHmac('sha256', secret)
    .update(
      JSON.stringify({
        clientId,
        kind: draft.kind,
        rewardId: draft.rewardId ?? null,
        feeType: draft.feeType ?? null,
        rateBps: draft.rateBps ?? null,
        flatPaise: draft.flatPaise?.toString() ?? null,
        effectiveFrom: draft.effectiveFrom.toISOString(),
        cutoff: cutoff.getTime(),
        lines,
        delta: deltaPaise.toString(),
        fingerprint,
      }),
    )
    .digest('hex')
    .slice(0, 32);
  return { linesRepriced: lines, deltaPaise, repricedFrom: from, token: `${cutoff.getTime()}.${hash}` };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The preview timestamp carried inside a confirm token ("<ms>.<hash>"), or null for a malformed token. */
export function tokenCutoff(token: string): Date | null {
  const m = /^(\d{10,16})\.[0-9a-f]{32}$/.exec(token);
  return m ? new Date(Number(m[1])) : null;
}

/** The voucher item's brand text for the operator (metadata brand / brandName; never used for pricing). */
function brandTextOf(m: unknown): string | null {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  for (const k of ['brand', 'brandName']) {
    const v = (m as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export function recipientsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

export function lineDto(l: FundLine) {
  return {
    seq: l.seq,
    date: l.date.toISOString(),
    event: l.event,
    type: l.type as FundSpendType | null,
    ref: l.ref,
    description: l.description,
    sourceKind: l.source.kind,
    sourceId: l.source.id,
    facePaise: n(l.facePaise),
    discountPaise: n(l.discountPaise),
    feePaise: n(l.feePaise),
    tdsPaise: n(l.tdsPaise),
    chargedPaise: n(l.chargedPaise),
    amountPaise: n(l.amountPaise),
    balancePaise: n(l.balancePaise),
    status: l.status,
    committedAt: l.committedAt ? l.committedAt.toISOString() : null,
    paidAt: l.paidAt ? l.paidAt.toISOString() : null,
    returnedAt: l.returnedAt ? l.returnedAt.toISOString() : null,
    utr: l.utr,
    itemLabel: l.itemLabel,
    rateLabel: l.rateLabel,
    receivablePaise: n(l.receivablePaise),
    flags: l.flags,
  };
}
