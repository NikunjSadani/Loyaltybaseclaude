import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Msg91Service } from '../notifications/msg91.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isGifsyOperator, platformWide } from '../common/tenant-scope';
import { formatDateIST, istDateKey } from '../common/ist-date';
import { istDayStart } from './fund-day';
import { REPORTS_CLIENT_ID } from '../common/report-recipients';
import {
  buildFundStatement,
  FUND_SPEND_TYPE_LABEL,
  FundLine,
  FundStatement,
  periodSummary,
  rateInForce,
  type FundSpendType,
} from './fund-statement.engine';
import { loadFundInputs, type FundInputs } from './fund-sources.loader';
import { voucherBrandOf } from './fund-brand';
import { buildLowBalanceEmail } from './fund-alert-email';
import {
  FundStatementQueryDto,
  RecordFundAdjustmentDto,
  RecordFundReceiptDto,
  RecordOpeningBalanceDto,
  SetAgencyFeeDto,
  SetBrandDiscountDto,
  UpdateFundAlertsDto,
} from './dto/fund.dto';

const n = (v: bigint | number | null | undefined): number => (v == null ? 0 : Number(v));
const toPaise = (rupees: number): bigint => BigInt(Math.round(rupees * 100));

/** Per-client fund figures for the Daily Ops Digest / low-balance alert. */
export interface FundDigestFigures {
  balancePaise: bigint;
  committedPaise: bigint;
  thresholdPaise: bigint | null;
  isLow: boolean;
  hasOpening: boolean;
  /** Items flagged without a rate (voucher brand / agency fee) — the digest calls them out. */
  missingRates: number;
  recipients: number;
  lastAlertSentOn: string | null;
  lastAlertError: string | null;
}

export interface FundAlertOutcome {
  clientId: string;
  status: 'sent' | 'already-sent-today' | 'not-low' | 'no-threshold' | 'no-recipients' | 'email-not-configured' | 'failed';
  error?: string;
  recipients?: number;
}

/**
 * Fund reconciliation (FUND-RECONCILIATION-DESIGN.md). Tenant-scoped by the caller's (assumed) clientId. Reads:
 * GIFSY operators + CLIENT_ADMIN of the own tenant (read-only). Writes: Gifsy operators only, always audited.
 * Spend is COMPUTED on read (fund-sources.loader + the pure engine) — nothing here touches a money path.
 */
@Injectable()
export class FundService {
  private readonly logger = new Logger(FundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly msg91: Msg91Service,
  ) {}

  // ── Guards ──────────────────────────────────────────────────────────────────────────────────

  /** The client this caller works on. An un-assumed Gifsy owner has no client context → 400. */
  tenantOf(user: JwtPayload): string {
    if (platformWide(user) || !user.clientId || user.clientId === REPORTS_CLIENT_ID) {
      throw new BadRequestException('Open a client first (switch into the client from the Gifsy console) to see or record its fund.');
    }
    return user.clientId;
  }

  private assertManage(user: JwtPayload): string {
    if (!isGifsyOperator(user)) throw new ForbiddenException('Only Gifsy can record fund entries or change fund settings.');
    return this.tenantOf(user);
  }

  canManage(user: JwtPayload): boolean {
    return isGifsyOperator(user);
  }

  // ── Computation ─────────────────────────────────────────────────────────────────────────────

  async compute(clientId: string): Promise<{ inputs: FundInputs; stmt: FundStatement }> {
    const inputs = await loadFundInputs(this.prisma, clientId);
    const stmt = buildFundStatement({ items: inputs.items, entries: inputs.entries, rates: inputs.rates });
    return { inputs, stmt };
  }

  private async settingsRow(clientId: string) {
    return this.prisma.fundSettings.findUnique({ where: { clientId } });
  }

  // ── Reads ───────────────────────────────────────────────────────────────────────────────────

  async summary(user: JwtPayload) {
    const clientId = this.tenantOf(user);
    const [{ stmt }, settings] = await Promise.all([this.compute(clientId), this.settingsRow(clientId)]);
    return this.summaryDto(clientId, stmt, settings, this.canManage(user));
  }

  summaryDto(
    clientId: string,
    stmt: FundStatement,
    settings: { lowBalanceThresholdPaise: bigint | null; alertRecipients: unknown; lowAlertLastSentOn: string | null; lowAlertLastError: string | null } | null,
    canManage: boolean,
  ) {
    const t = stmt.totals;
    const threshold = settings?.lowBalanceThresholdPaise ?? null;
    return {
      clientId,
      asOf: new Date().toISOString(),
      openingDate: stmt.openingDate ? stmt.openingDate.toISOString() : null,
      hasOpening: !!stmt.openingDate,
      canManage,
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
      brandsWithoutRate: stmt.brandsWithoutRate,
      lowBalance: {
        thresholdPaise: threshold == null ? null : n(threshold),
        isLow: threshold != null && t.balancePaise < threshold,
        lastAlertSentOn: settings?.lowAlertLastSentOn ?? null,
        lastAlertError: settings?.lowAlertLastError ?? null,
        recipients: recipientsOf(settings?.alertRecipients).length,
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

  async settings(user: JwtPayload) {
    const clientId = this.tenantOf(user);
    const [settings, rates, catalogue] = await Promise.all([
      this.settingsRow(clientId),
      this.prisma.fundRate.findMany({ where: { clientId }, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }] }),
      this.prisma.rewardCatalog.findMany({
        where: { clientId, redemptionMode: 'GIFT_CARD' },
        select: { id: true, name: true, metadata: true, deletedAt: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    const names = await this.userNames(rates.map((r) => r.createdById));
    const now = new Date();
    const feeRows = rates.filter((r) => r.kind === 'AGENCY_FEE');
    const discRows = rates.filter((r) => r.kind === 'VOUCHER_DISCOUNT');
    const cur = rateInForce(feeRows, now);

    const brands = new Map<string, { brandKey: string; brandLabel: string; items: string[] }>();
    for (const item of catalogue) {
      const b = voucherBrandOf(item);
      const e = brands.get(b.brandKey) ?? { brandKey: b.brandKey, brandLabel: b.brandLabel, items: [] };
      e.items.push(item.deletedAt ? `${item.name} (deleted)` : item.name);
      brands.set(b.brandKey, e);
    }
    for (const r of discRows) {
      if (r.brandKey && !brands.has(r.brandKey)) brands.set(r.brandKey, { brandKey: r.brandKey, brandLabel: r.brandLabel ?? r.brandKey, items: [] });
    }

    return {
      canManage: this.canManage(user),
      thresholdPaise: settings?.lowBalanceThresholdPaise == null ? null : n(settings.lowBalanceThresholdPaise),
      alertRecipients: recipientsOf(settings?.alertRecipients),
      lastAlertSentOn: settings?.lowAlertLastSentOn ?? null,
      lastAlertError: settings?.lowAlertLastError ?? null,
      currentFee: cur
        ? { feeType: cur.feeType, rateBps: cur.rateBps, flatPaise: cur.flatPaise == null ? null : n(cur.flatPaise), effectiveFrom: cur.effectiveFrom.toISOString() }
        : null,
      feeRates: feeRows.map((r) => ({
        id: r.id,
        feeType: r.feeType,
        rateBps: r.rateBps,
        flatPaise: r.flatPaise == null ? null : n(r.flatPaise),
        effectiveFrom: r.effectiveFrom.toISOString(),
        note: r.note,
        createdAt: r.createdAt.toISOString(),
        createdByName: r.createdById ? names.get(r.createdById) ?? null : null,
      })),
      discountRates: discRows.map((r) => ({
        id: r.id,
        brandKey: r.brandKey,
        brandLabel: r.brandLabel,
        rateBps: r.rateBps,
        effectiveFrom: r.effectiveFrom.toISOString(),
        note: r.note,
        createdAt: r.createdAt.toISOString(),
        createdByName: r.createdById ? names.get(r.createdById) ?? null : null,
      })),
      brands: [...brands.values()]
        .map((b) => {
          const r = rateInForce(discRows.filter((d) => d.brandKey === b.brandKey), now);
          return { ...b, currentRateBps: r?.rateBps ?? null, currentEffectiveFrom: r ? r.effectiveFrom.toISOString() : null };
        })
        .sort((a, b) => a.brandLabel.localeCompare(b.brandLabel)),
    };
  }

  // ── Writes (Gifsy only, audited) ────────────────────────────────────────────────────────────

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

  async recordReceipt(user: JwtPayload, dto: RecordFundReceiptDto) {
    const clientId = this.assertManage(user);
    this.assertNotFuture(dto.receivedOn, 'The date received');
    const at = istDayStart(dto.receivedOn);
    const amountPaise = toPaise(dto.amountRupees);
    if (amountPaise <= 0n) throw new BadRequestException('Amount must be more than ₹0');
    const ref = dto.referenceNumber.trim();
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, clientId);
      await this.assertAfterOpening(tx, clientId, at, 'This receipt');
      const dup = await tx.fundReceipt.findFirst({ where: { clientId, entryType: 'RECEIPT', referenceNumber: ref }, select: { receiptNumber: true } });
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
  }

  async recordAdjustment(user: JwtPayload, dto: RecordFundAdjustmentDto) {
    const clientId = this.assertManage(user);
    this.assertNotFuture(dto.date, 'The adjustment date');
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException('A reason is required for an adjustment');
    const at = istDayStart(dto.date);
    const amountPaise = toPaise(dto.amountRupees);
    if (amountPaise === 0n) throw new BadRequestException('An adjustment cannot be ₹0');
    return this.prisma.$transaction(async (tx) => {
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
  }

  async recordOpening(user: JwtPayload, dto: RecordOpeningBalanceDto) {
    const clientId = this.assertManage(user);
    this.assertNotFuture(dto.asOfDate, 'The opening balance date');
    const at = istDayStart(dto.asOfDate);
    const amountPaise = toPaise(dto.amountRupees);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lock(tx, clientId);
        const existing = await tx.fundReceipt.findFirst({ where: { clientId, entryType: 'OPENING_BALANCE' }, select: { receiptNumber: true } });
        if (existing) {
          throw new ConflictException(`An opening balance is already recorded (${existing.receiptNumber}). Correct it with an adjustment.`);
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

  async updateAlerts(user: JwtPayload, dto: UpdateFundAlertsDto) {
    const clientId = this.assertManage(user);
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

  async setAgencyFee(user: JwtPayload, dto: SetAgencyFeeDto) {
    const clientId = this.assertManage(user);
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
    return this.createRate(user, clientId, {
      kind: 'AGENCY_FEE',
      feeType: dto.feeType,
      rateBps,
      flatPaise,
      effectiveFrom: istDayStart(dto.effectiveFrom),
      note: dto.note?.trim() || null,
    });
  }

  async setBrandDiscount(user: JwtPayload, dto: SetBrandDiscountDto) {
    const clientId = this.assertManage(user);
    const brandKey = dto.brandKey.trim();
    if (!/^(brand|hubble|item):.+/.test(brandKey)) throw new BadRequestException('Unknown voucher brand');
    return this.createRate(user, clientId, {
      kind: 'VOUCHER_DISCOUNT',
      brandKey,
      brandLabel: dto.brandLabel.trim(),
      rateBps: Math.round(dto.percent * 100),
      effectiveFrom: istDayStart(dto.effectiveFrom),
      note: dto.note?.trim() || null,
    });
  }

  private async createRate(
    user: JwtPayload,
    clientId: string,
    data: Omit<Prisma.FundRateUncheckedCreateInput, 'clientId' | 'createdById'>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.fundRate.create({ data: { ...data, clientId, createdById: user.sub } });
      await tx.auditLog.create({
        data: {
          action: 'CREATE',
          entityType: 'FUND_RATE',
          entityId: row.id,
          actorId: user.sub,
          newValues: {
            clientId,
            kind: row.kind,
            brandKey: row.brandKey,
            feeType: row.feeType,
            rateBps: row.rateBps,
            flatPaise: row.flatPaise?.toString() ?? null,
            effectiveFrom: row.effectiveFrom.toISOString(),
            note: row.note,
          },
        },
      });
      return { id: row.id };
    });
  }

  private async userNames(ids: Array<string | null>): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((x): x is string => !!x))];
    if (uniq.length === 0) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  // ── Digest + daily low-balance alert ─────────────────────────────────────────────────────────

  /** null = the client has no fund set-up at all (no entry, no rate, no settings) → the digest shows nothing. */
  async digestFigures(clientId: string): Promise<FundDigestFigures | null> {
    const [settings, entryCount, rateCount] = await Promise.all([
      this.settingsRow(clientId),
      this.prisma.fundReceipt.count({ where: { clientId } }),
      this.prisma.fundRate.count({ where: { clientId } }),
    ]);
    if (!settings && entryCount === 0 && rateCount === 0) return null;
    const { stmt } = await this.compute(clientId);
    const threshold = settings?.lowBalanceThresholdPaise ?? null;
    return {
      balancePaise: stmt.totals.balancePaise,
      committedPaise: stmt.totals.committedPaise,
      thresholdPaise: threshold,
      isLow: threshold != null && stmt.totals.balancePaise < threshold,
      hasOpening: !!stmt.openingDate,
      missingRates: (stmt.flagCounts.NO_BRAND_RATE ?? 0) + (stmt.flagCounts.NO_FEE_RATE ?? 0),
      recipients: recipientsOf(settings?.alertRecipients).length,
      lastAlertSentOn: settings?.lowAlertLastSentOn ?? null,
      lastAlertError: settings?.lowAlertLastError ?? null,
    };
  }

  /**
   * Once-a-day low-balance e-mails (called by the daily scheduled-reports run, BEFORE the digest so the digest can
   * report each outcome). Never throws; never blocks anything. At most one e-mail per client per IST day
   * (fund_settings.lowAlertLastSentOn, claimed with a compare-and-set before sending). A failure is stored on the
   * settings row (shown on the screen + the digest) and logged as an error.
   */
  async runLowBalanceAlerts(nowMs: number): Promise<Map<string, FundAlertOutcome>> {
    const out = new Map<string, FundAlertOutcome>();
    const today = istDateKey(new Date(nowMs));
    let rows: Array<{ clientId: string; lowBalanceThresholdPaise: bigint | null; alertRecipients: unknown; lowAlertLastSentOn: string | null }>;
    try {
      rows = await this.prisma.fundSettings.findMany({
        where: { lowBalanceThresholdPaise: { not: null }, clientId: { not: REPORTS_CLIENT_ID } },
        select: { clientId: true, lowBalanceThresholdPaise: true, alertRecipients: true, lowAlertLastSentOn: true },
      });
    } catch (e) {
      this.logger.error(`Fund low-balance alerts: could not read the settings: ${(e as Error)?.message ?? e}`);
      return out;
    }
    for (const s of rows) {
      const clientId = s.clientId;
      try {
        const to = recipientsOf(s.alertRecipients);
        const { stmt } = await this.compute(clientId);
        const threshold = s.lowBalanceThresholdPaise!;
        if (stmt.totals.balancePaise >= threshold) {
          out.set(clientId, { clientId, status: 'not-low' });
          continue;
        }
        if (to.length === 0) {
          out.set(clientId, { clientId, status: 'no-recipients' });
          continue;
        }
        if (s.lowAlertLastSentOn === today) {
          out.set(clientId, { clientId, status: 'already-sent-today', recipients: to.length });
          continue;
        }
        if (!this.msg91.isEmailConfigured()) {
          const error = 'E-mail is not configured on this server (MSG91_SMTP_PASS) — the low-balance e-mail was NOT sent.';
          await this.prisma.fundSettings.update({ where: { clientId }, data: { lowAlertLastError: error } });
          this.logger.error(`Fund low-balance alert for ${clientId}: ${error}`);
          out.set(clientId, { clientId, status: 'email-not-configured', error });
          continue;
        }
        // Claim today's send (compare-and-set) so two concurrent runs can never both e-mail.
        const claim = await this.prisma.fundSettings.updateMany({
          where: { clientId, OR: [{ lowAlertLastSentOn: null }, { lowAlertLastSentOn: { not: today } }] },
          data: { lowAlertLastSentOn: today },
        });
        if (claim.count === 0) {
          out.set(clientId, { clientId, status: 'already-sent-today', recipients: to.length });
          continue;
        }
        const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { internalName: true, branding: true } });
        const display = ((client?.branding ?? {}) as Record<string, unknown>).displayName;
        const clientName = typeof display === 'string' && display.trim() ? display.trim() : client?.internalName ?? clientId;
        const mail = buildLowBalanceEmail({
          clientName,
          dateLabel: formatDateIST(new Date(nowMs)),
          balancePaise: stmt.totals.balancePaise,
          committedPaise: stmt.totals.committedPaise,
          thresholdPaise: threshold,
        });
        try {
          const res = await this.msg91.sendEmail({ to, subject: mail.subject, html: mail.html });
          const rejected = res.rejected.length ? `relay rejected ${res.rejected.join(', ')}` : null;
          await this.prisma.fundSettings.update({ where: { clientId }, data: { lowAlertLastError: rejected } });
          await this.prisma.auditLog.create({
            data: {
              action: 'EXPORT',
              entityType: 'FUND_LOW_BALANCE_ALERT',
              entityId: clientId,
              metadata: { clientId, date: today, recipients: to, balancePaise: stmt.totals.balancePaise.toString(), thresholdPaise: threshold.toString(), rejected: res.rejected },
            },
          });
          out.set(clientId, rejected ? { clientId, status: 'failed', error: rejected, recipients: to.length } : { clientId, status: 'sent', recipients: to.length });
        } catch (e) {
          const error = ((e as Error)?.message ?? String(e)).slice(0, 300);
          // Release today's claim so a forced re-run can retry; keep the error visible.
          await this.prisma.fundSettings.update({ where: { clientId }, data: { lowAlertLastSentOn: s.lowAlertLastSentOn, lowAlertLastError: error } });
          this.logger.error(`Fund low-balance alert for ${clientId} failed: ${error}`);
          out.set(clientId, { clientId, status: 'failed', error, recipients: to.length });
        }
      } catch (e) {
        const error = ((e as Error)?.message ?? String(e)).slice(0, 300);
        this.logger.error(`Fund low-balance alert for ${clientId} failed: ${error}`);
        out.set(clientId, { clientId, status: 'failed', error });
      }
    }
    return out;
  }
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
    brandLabel: l.brandLabel,
    rateLabel: l.rateLabel,
    receivablePaise: n(l.receivablePaise),
    flags: l.flags,
  };
}
