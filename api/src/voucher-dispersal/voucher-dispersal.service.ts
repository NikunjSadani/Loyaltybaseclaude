import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Prisma,
  VoucherDispersalCampaignStatus as CS,
  VoucherDispersalRowStatus as RS,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { HubbleNotConfiguredError, HubbleOrderResult, HubbleService } from '../hubble/hubble.service';
import { configuredDispersalBrands } from './voucher-dispersal.brands';
import {
  DispersalBrandLimits,
  DispersalFileError,
  ParsedDispersalRow,
  readDispersalSheet,
  validateDispersalRows,
} from './voucher-dispersal.parse';
import { buildDispersalReport, buildDispersalTemplate, DispersalReportRow } from './voucher-dispersal.xlsx';
import { formatDateIST } from '../common/ist-date';
import {
  DISPERSAL_RETRY_MIN_AGE_MS,
  LOCAL_FAILURE_SOURCES,
  MAX_RESENDS,
  VoucherDispersalProcessor,
} from './voucher-dispersal.processor';
import { maskVoucherCodeForAudit } from '../rewards/voucher-issuance';
import {
  ConfirmDispersalCampaignDto,
  CreateDispersalCampaignDto,
  ListDispersalCampaignsQueryDto,
  ListDispersalRowsQueryDto,
} from './dto/voucher-dispersal.dto';

/**
 * Voucher Dispersal — campaign lifecycle (create → upload/preview → confirm → process → report).
 * PLATFORM-LEVEL Gifsy tool (owner 2026-11-16): campaigns are NOT tenant data; every GIFSY_ADMIN —
 * assumed or not — sees every campaign. `billedToClientId` is a reporting label only. Recipients are
 * bare phone numbers (never looked up against users / outlets). The money engine is
 * VoucherDispersalProcessor; this service owns validation, confirm/cancel/retry/resend and the reads.
 */

type CampaignRow = Prisma.VoucherDispersalCampaignGetPayload<Record<string, never>>;
type DbRow = Prisma.VoucherDispersalRowGetPayload<Record<string, never>>;
type ReceiptLite = { id: string; status: string; sentAt: Date | null; deliveredAt: Date | null; readAt: Date | null; failureReason: string | null; updatedAt?: Date | null };

const ROWS_PAGE_SIZE = 100;
const CAMPAIGNS_PAGE_SIZE = 50;
const CREATE_CHUNK = 1000;
const PREVIEW_STATUSES: RS[] = [RS.VALID, RS.INVALID, RS.DUPLICATE];
const NOT_VALID: RS[] = [RS.INVALID, RS.DUPLICATE, RS.CANCELLED];
/** Cross-campaign warning window (coordinator decision: warn, never block). */
const RECENT_VOUCHER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const rupees = (paise: bigint | number | null | undefined) => (paise == null ? 0 : Number(paise) / 100);

/** Message (WhatsApp) view of a row — receipt wins, then the row mirror, then the send record. */
export function messageView(row: Pick<DbRow, 'status' | 'whatsappReceiptId' | 'sentAt' | 'messageClaimedAt' | 'messageError' | 'messageStatus' | 'messageDeliveredAt' | 'messageReadAt' | 'messageFailureReason'>, receipt?: ReceiptLite | null): {
  status: string;
  receiptId: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failureReason: string | null;
} {
  const base = { receiptId: row.whatsappReceiptId ?? null, sentAt: row.sentAt ?? null };
  if (row.status !== RS.BOUGHT) return { ...base, status: 'NOT_APPLICABLE', deliveredAt: null, readAt: null, failureReason: null };
  if (receipt) {
    // L10: the send succeeded (row.sentAt) but the receipt's SENT write blipped → still SENT.
    const st = receipt.status === 'QUEUED' && row.sentAt ? 'SENT' : receipt.status;
    return {
      ...base,
      status: st,
      sentAt: receipt.sentAt ?? row.sentAt ?? null,
      deliveredAt: receipt.deliveredAt,
      readAt: receipt.readAt,
      failureReason: receipt.failureReason,
    };
  }
  if (row.messageStatus) {
    return {
      ...base,
      status: row.messageStatus,
      deliveredAt: row.messageDeliveredAt ?? null,
      readAt: row.messageReadAt ?? null,
      failureReason: row.messageFailureReason ?? row.messageError ?? null,
    };
  }
  if (row.messageError) return { ...base, status: 'FAILED', deliveredAt: null, readAt: null, failureReason: row.messageError };
  if (row.messageClaimedAt) return { ...base, status: 'SENDING', deliveredAt: null, readAt: null, failureReason: null };
  return { ...base, status: 'NOT_SENT_YET', deliveredAt: null, readAt: null, failureReason: null };
}

const MSG_SENT = new Set(['SENT', 'SENT_UNTRACKED', 'DELIVERED', 'READ']);

/**
 * Admin-response mask for a voucher code — the SAME rule as audit rows (maskVoucherCodeForAudit): "••••" +
 * the last 4 characters only for a 12+ char code, else fully "••••". The full code is never returned to
 * an admin, never in report.xlsx.
 */
export function maskDispersalCode(code: string | null | undefined): string | null {
  return typeof code === 'string' && code.trim() ? maskVoucherCodeForAudit(code) : null;
}

/** The first WhatsApp has an outcome (sent, failed or unknown) — only then may an admin resend. */
function firstSendSettled(r: Pick<DbRow, 'sentAt' | 'messageError' | 'whatsappReceiptId' | 'messageStatus'>): boolean {
  return !!(r.sentAt || r.messageError || r.whatsappReceiptId || r.messageStatus);
}

@Injectable()
export class VoucherDispersalService {
  private readonly logger = new Logger(VoucherDispersalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hubble: HubbleService,
    private readonly processor: VoucherDispersalProcessor,
  ) {}

  /** GIFSY_ADMIN only — re-checked here at the data boundary (the controller's @Roles is the first gate). */
  private assertAdmin(user: JwtPayload): void {
    if (user?.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Voucher Dispersal is available to Gifsy admins only.');
  }

  // ─── Brands / template ────────────────────────────────────────────────────────

  /** The configured brands with their LIVE Hubble limits; a brand Hubble could not answer for is marked unavailable. */
  async resolveBrandLimits(): Promise<DispersalBrandLimits[]> {
    const brands = configuredDispersalBrands();
    if (!this.hubble.isConfigured()) {
      return brands.map((b) => ({ ...b, available: false, unavailableReason: 'Hubble is not configured in this environment', product: null }));
    }
    return Promise.all(
      brands.map(async (b) => {
        try {
          const product = await this.hubble.getProduct(b.productId);
          return { ...b, available: true, unavailableReason: null, product };
        } catch (e) {
          const why = e instanceof HubbleNotConfiguredError ? 'Hubble is not configured' : String((e as Error)?.message ?? e).slice(0, 200);
          this.logger.warn(`[dispersal] brand ${b.key} (${b.productId}) limits unavailable: ${why}`);
          return { ...b, available: false, unavailableReason: why, product: null };
        }
      }),
    );
  }

  async brands(user: JwtPayload) {
    this.assertAdmin(user);
    const limits = await this.resolveBrandLimits();
    return limits.map((b) => {
      const p = b.product;
      const fixedKnown = !!p && p.denominationType === 'FIXED' && p.denominations.length > 0;
      return {
        key: b.key,
        label: b.label,
        productId: b.productId,
        minAmount: p?.minValue ?? null,
        maxAmount: p?.maxValue ?? null,
        denominations: fixedKnown ? p!.denominations : null,
        denominationType: p?.denominationType ?? null,
        available: b.available,
        unavailableReason: b.unavailableReason,
      };
    });
  }

  async template(user: JwtPayload): Promise<Buffer> {
    this.assertAdmin(user);
    return buildDispersalTemplate(await this.resolveBrandLimits());
  }

  // ─── Create ───────────────────────────────────────────────────────────────────

  async createCampaign(user: JwtPayload, dto: CreateDispersalCampaignDto) {
    this.assertAdmin(user);
    const name = dto.name.trim();
    const programLabel = dto.programLabel.replace(/\s+/g, ' ').trim();
    if (!name) throw new BadRequestException('Campaign name is required.');
    if (!programLabel) throw new BadRequestException('Program label is required (it appears in the WhatsApp message).');
    const billedToClientId = dto.billedToClientId?.trim() || null;
    if (billedToClientId) {
      const c = await this.prisma.client.findUnique({ where: { id: billedToClientId }, select: { id: true } });
      if (!c) throw new BadRequestException(`Unknown client "${billedToClientId}".`);
    }
    if (!Number.isInteger(dto.budgetRupees) || dto.budgetRupees <= 0) throw new BadRequestException('Budget must be a whole number of rupees above 0.');
    const c = await this.prisma.voucherDispersalCampaign.create({
      data: {
        name,
        programLabel,
        billedToClientId,
        note: dto.note?.trim() || null,
        budgetPaise: BigInt(dto.budgetRupees) * 100n,
        status: CS.DRAFT,
        createdById: user.sub,
      },
    });
    await this.auditCampaign(user, c.id, 'CREATE', 'VOUCHER_DISPERSAL_CREATED', {
      name,
      programLabel,
      billedToClientId,
      budgetRupees: dto.budgetRupees,
    });
    return this.campaignView(c);
  }

  // ─── Upload / preview ─────────────────────────────────────────────────────────

  async upload(user: JwtPayload, id: string, file: Express.Multer.File | undefined) {
    this.assertAdmin(user);
    const camp = await this.getCampaignOr404(id);
    if (camp.status !== CS.DRAFT && camp.status !== CS.PREVIEWED) {
      throw new ConflictException(`Rows can only be uploaded before the campaign is confirmed (status ${camp.status}).`);
    }
    if (!file?.buffer?.length) throw new BadRequestException('Attach the filled template (.xlsx) as "file".');
    let parsed: ParsedDispersalRow[];
    let sheet: ReturnType<typeof readDispersalSheet>;
    try {
      sheet = readDispersalSheet(file.buffer);
      parsed = validateDispersalRows(sheet.rows, await this.resolveBrandLimits());
    } catch (e) {
      if (e instanceof DispersalFileError) throw new BadRequestException(e.message);
      throw e;
    }

    const warnings = await this.recentVoucherWarnings(id, parsed);
    const data: Prisma.VoucherDispersalRowCreateManyInput[] = parsed.map((r) => ({
      campaignId: id,
      rowNumber: r.rowNumber,
      phone: r.phone,
      rawPhone: r.rawPhone.slice(0, 40) || null,
      dedupePhone: r.dedupePhone,
      name: r.name || '',
      amountPaise: r.amountRupees != null && Number.isInteger(r.amountRupees) ? BigInt(r.amountRupees) * 100n : null,
      brandKey: r.brandKey,
      brandLabel: r.brandLabel?.slice(0, 80) ?? null,
      productId: r.productId,
      note: r.note,
      status: r.status as RS,
      invalidReason: r.invalidReason?.slice(0, 500) ?? null,
      warning: r.phone && r.status === 'VALID' ? warnings.get(r.phone) ?? null : null,
      // The Hubble idempotency key is fixed NOW — before anything can reach Hubble.
      hubbleReferenceId: r.status === 'VALID' ? `vd${randomBytes(12).toString('hex')}` : null,
    }));

    const fileName = (file.originalname ?? 'upload.xlsx').slice(0, 200);
    const previewId = `pv${randomBytes(12).toString('hex')}`;
    const updated = await this.prisma.$transaction(
      async (tx) => {
        const lock = await tx.voucherDispersalCampaign.updateMany({
          where: { id, status: { in: [CS.DRAFT, CS.PREVIEWED] } },
          data: { status: CS.PREVIEWED, previewId, sourceFileName: fileName, uploadedAt: new Date(), uploadedById: user.sub },
        });
        if (lock.count !== 1) throw new ConflictException('The campaign was confirmed or cancelled meanwhile — refresh.');
        const live = await tx.voucherDispersalRow.count({ where: { campaignId: id, status: { notIn: PREVIEW_STATUSES } } });
        if (live > 0) throw new ConflictException('This campaign already has rows in processing — it cannot be re-uploaded.');
        await tx.voucherDispersalRow.deleteMany({ where: { campaignId: id } });
        for (let i = 0; i < data.length; i += CREATE_CHUNK) {
          await tx.voucherDispersalRow.createMany({ data: data.slice(i, i + CREATE_CHUNK) });
        }
        return tx.voucherDispersalCampaign.findUniqueOrThrow({ where: { id } });
      },
      { timeout: 60_000 },
    );

    const summary = this.previewSummary(
      parsed.map((r) => ({
        status: r.status as RS,
        amountPaise: r.amountRupees != null && Number.isInteger(r.amountRupees) ? BigInt(r.amountRupees) * 100n : null,
        brandKey: r.brandKey,
        brandLabel: r.brandLabel,
      })),
      updated.budgetPaise,
    );
    const warningCount = data.filter((d) => d.warning).length;
    const skippedRows = sheet.skippedBlank + sheet.skippedFormulaOnly;
    const skippedNote = skippedRows
      ? `${skippedRows} row${skippedRows === 1 ? '' : 's'} skipped: ${[
          sheet.skippedBlank ? `${sheet.skippedBlank} blank` : '',
          sheet.skippedFormulaOnly ? `${sheet.skippedFormulaOnly} with formulas but no saved values (open the file in Excel, save, and upload again)` : '',
        ]
          .filter(Boolean)
          .join('; ')}`
      : null;
    const hiddenNote = sheet.hiddenIncluded
      ? `${sheet.hiddenIncluded} hidden row${sheet.hiddenIncluded === 1 ? '' : 's'} included (they are hidden in Excel but will be sent)`
      : null;
    const fullSummary = {
      ...summary,
      warningCount,
      skippedBlankRows: sheet.skippedBlank,
      skippedFormulaRows: sheet.skippedFormulaOnly,
      skippedNote,
      hiddenRowsIncluded: sheet.hiddenIncluded,
      hiddenNote,
    };
    await this.auditCampaign(user, id, 'IMPORT', 'VOUCHER_DISPERSAL_UPLOADED', {
      warningCount,
      skippedRows,
      hiddenRowsIncluded: sheet.hiddenIncluded,
      fileName,
      total: summary.total,
      valid: summary.valid,
      invalid: summary.invalid,
      duplicates: summary.duplicates,
      totalRupees: summary.totalRupees,
      overBudget: summary.overBudget,
    });
    return {
      previewId,
      campaign: await this.campaignView(updated),
      rows: parsed.map((r) => ({
        rowNumber: r.rowNumber,
        phone: r.phone ?? r.rawPhone,
        name: r.name,
        amount: r.amountRupees,
        brand: r.brandLabel,
        brandKey: r.brandKey,
        note: r.note,
        status: r.status,
        invalidReason: r.invalidReason,
        warning: r.phone && r.status === 'VALID' ? warnings.get(r.phone) ?? null : null,
      })),
      summary: fullSummary,
    };
  }

  /**
   * Cross-campaign warning (coordinator decision — warn, never block): a phone that got a voucher (BOUGHT)
   * in ANY other campaign in the last 30 days. Returns phone → "Already got a ₹X <brand> voucher on
   * <date> in campaign <name>" (the most recent one).
   */
  private async recentVoucherWarnings(campaignId: string, parsed: ParsedDispersalRow[]): Promise<Map<string, string>> {
    const phones = [...new Set(parsed.filter((r) => r.phone && r.status === 'VALID').map((r) => r.phone!))];
    const out = new Map<string, string>();
    const since = new Date(Date.now() - RECENT_VOUCHER_WINDOW_MS);
    for (let i = 0; i < phones.length; i += 1000) {
      const hits = await this.prisma.voucherDispersalRow.findMany({
        where: { phone: { in: phones.slice(i, i + 1000) }, status: RS.BOUGHT, boughtAt: { gte: since }, campaignId: { not: campaignId } },
        orderBy: { boughtAt: 'desc' },
        include: { campaign: { select: { name: true } } },
      });
      for (const h of hits) {
        if (!h.phone || out.has(h.phone)) continue;
        out.set(
          h.phone,
          `Already got a ₹${rupees(h.amountPaise).toLocaleString('en-IN')} ${h.brandLabel ?? ''} voucher on ${h.boughtAt ? formatDateIST(h.boughtAt) : '?'} in campaign "${h.campaign.name}"`.replace(/\s+/g, ' '),
        );
      }
    }
    return out;
  }

  /** Preview / budget summary over rows (VALID-or-later rows are the ones that will be bought). */
  previewSummary(
    rows: { status: RS; amountPaise: bigint | null; brandKey: string | null; brandLabel: string | null }[],
    budgetPaise: bigint,
  ) {
    let valid = 0;
    let invalid = 0;
    let duplicates = 0;
    let totalPaise = 0n;
    const perBrand = new Map<string, { brandKey: string; brand: string; count: number; totalPaise: bigint }>();
    for (const r of rows) {
      if (r.status === RS.INVALID) invalid++;
      else if (r.status === RS.DUPLICATE) duplicates++;
      else if (r.status !== RS.CANCELLED) {
        valid++;
        const a = r.amountPaise ?? 0n;
        totalPaise += a;
        const k = r.brandKey ?? '?';
        const b = perBrand.get(k) ?? { brandKey: k, brand: r.brandLabel ?? k, count: 0, totalPaise: 0n };
        b.count++;
        b.totalPaise += a;
        perBrand.set(k, b);
      }
    }
    const totalRupees = rupees(totalPaise);
    return {
      total: rows.length,
      valid,
      invalid,
      duplicates,
      totalRupees,
      budgetRupees: rupees(budgetPaise),
      overBudget: totalPaise > budgetPaise,
      perBrand: [...perBrand.values()].map((b) => ({ brandKey: b.brandKey, brand: b.brand, count: b.count, totalRupees: rupees(b.totalPaise) })),
    };
  }

  // ─── Confirm ──────────────────────────────────────────────────────────────────

  async confirm(user: JwtPayload, id: string, dto: ConfirmDispersalCampaignDto) {
    this.assertAdmin(user);
    if (!this.hubble.isConfigured()) {
      throw new ServiceUnavailableException('Hubble is not configured in this environment — nothing can be bought.');
    }
    const result = await this.prisma.$transaction(async (tx) => {
      // Row-lock the campaign (the same lock every buy claim takes) and re-check everything under it.
      const camp = await tx.voucherDispersalCampaign.update({ where: { id }, data: { updatedAt: new Date() } }).catch(() => null);
      if (!camp) throw new NotFoundException('Campaign not found.');
      // IDEMPOTENT: a repeated confirm (double click, network-dropped retry) for the preview that was
      // already confirmed returns the campaign as it is — no second queueing, nothing bought twice
      // (rows are only ever bought from QUEUED via the guarded claim).
      const alreadyConfirmed: CS[] = [CS.CONFIRMED, CS.PROCESSING, CS.COMPLETED, CS.COMPLETED_WITH_ERRORS];
      if (alreadyConfirmed.includes(camp.status) && camp.previewId && camp.previewId === dto.previewId) {
        return { updated: camp, validCount: 0, totalRupees: 0, repeat: true };
      }
      if (camp.status !== CS.PREVIEWED) throw new ConflictException(`Only a previewed campaign can be confirmed (status ${camp.status}).`);
      if (!camp.previewId || camp.previewId !== dto.previewId) {
        throw new ConflictException('This preview is out of date (the file was re-uploaded, maybe in another tab). Review the current preview and confirm again.');
      }
      const valid = await tx.voucherDispersalRow.aggregate({
        where: { campaignId: id, status: RS.VALID },
        _count: { _all: true },
        _sum: { amountPaise: true },
      });
      const validCount = valid._count._all;
      const totalPaise = BigInt(valid._sum.amountPaise ?? 0n);
      if (validCount === 0) throw new BadRequestException('There are no valid rows to issue.');
      if (totalPaise > BigInt(camp.budgetPaise)) {
        throw new BadRequestException(
          `The valid rows total ₹${rupees(totalPaise).toLocaleString('en-IN')}, over the ₹${rupees(camp.budgetPaise).toLocaleString('en-IN')} budget. Remove rows or raise the budget (new campaign).`,
        );
      }
      // Stale-preview protection: confirm exactly what the admin saw.
      if (dto.expectedValidCount !== validCount || BigInt(dto.expectedTotalRupees) * 100n !== totalPaise) {
        throw new ConflictException(
          `The preview changed: it now has ${validCount} valid row(s) totalling ₹${rupees(totalPaise).toLocaleString('en-IN')} (you confirmed ${dto.expectedValidCount} / ₹${Number(dto.expectedTotalRupees).toLocaleString('en-IN')}). Review the preview again.`,
        );
      }
      const q = await tx.voucherDispersalRow.updateMany({
        where: { campaignId: id, status: RS.VALID, hubbleReferenceId: { not: null } },
        data: { status: RS.QUEUED },
      });
      if (q.count !== validCount) throw new ConflictException('The rows changed while confirming — refresh and try again.');
      const now = new Date();
      const updated = await tx.voucherDispersalCampaign.update({
        where: { id },
        data: { status: CS.PROCESSING, confirmedById: user.sub, confirmedAt: now },
      });
      return { updated, validCount, totalRupees: rupees(totalPaise), repeat: false };
    });
    if (result.repeat) return this.campaignView(result.updated);
    await this.auditCampaign(user, id, 'APPROVE', 'VOUCHER_DISPERSAL_CONFIRMED', {
      previewId: dto.previewId,
      validCount: result.validCount,
      totalRupees: result.totalRupees,
    });
    this.processor.kick(id);
    return this.campaignView(result.updated);
  }

  // ─── Process (in-request bounded pass) ────────────────────────────────────────

  async process(user: JwtPayload, id: string) {
    this.assertAdmin(user);
    await this.getCampaignOr404(id);
    // Bounded so the worst case (budget + one in-flight Hubble call ≤15 s + canary verify) stays under the
    // frontend proxy's ~30 s limit — the UI calls this repeatedly; the scheduler drain does the heavy lifting.
    const pass = await this.processor.drain({ campaignId: id, budgetMs: 10_000, maxBuys: 10 });
    return { pass, ...(await this.detail(user, id)) };
  }

  // ─── Reads ────────────────────────────────────────────────────────────────────

  async list(user: JwtPayload, q: ListDispersalCampaignsQueryDto) {
    this.assertAdmin(user);
    const page = q.page ?? 1;
    const camps = await this.prisma.voucherDispersalCampaign.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * CAMPAIGNS_PAGE_SIZE,
      take: CAMPAIGNS_PAGE_SIZE,
    });
    const ids = camps.map((c) => c.id);
    const groups = ids.length
      ? await this.prisma.voucherDispersalRow.groupBy({
          by: ['campaignId', 'status'],
          where: { campaignId: { in: ids } },
          _count: { _all: true },
          _sum: { amountPaise: true },
        })
      : [];
    const names = await this.clientNames(camps.map((c) => c.billedToClientId));
    const items = camps.map((c) => {
      const g = groups.filter((x) => x.campaignId === c.id);
      const n = (s: RS) => g.find((x) => x.status === s)?._count._all ?? 0;
      const sum = (s: RS) => BigInt(g.find((x) => x.status === s)?._sum.amountPaise ?? 0n);
      return {
        ...this.campaignViewSync(c, names),
        summary: {
          total: g.reduce((a, x) => a + x._count._all, 0),
          valid: g.filter((x) => !NOT_VALID.includes(x.status)).reduce((a, x) => a + x._count._all, 0),
          invalid: n(RS.INVALID),
          duplicates: n(RS.DUPLICATE),
          queued: n(RS.QUEUED),
          pending: n(RS.QUEUED) + n(RS.BUYING) + n(RS.PENDING_RECONCILE),
          bought: n(RS.BOUGHT),
          buyFailed: n(RS.BUY_FAILED),
          cancelled: n(RS.CANCELLED),
          spentRupees: rupees(sum(RS.BOUGHT)),
        },
      };
    });
    // Contract (UI): a plain array, newest first; `?page=` pages through CAMPAIGNS_PAGE_SIZE at a time.
    return items;
  }

  async detail(user: JwtPayload, id: string) {
    this.assertAdmin(user);
    const camp = await this.getCampaignOr404(id);
    const rows = await this.prisma.voucherDispersalRow.findMany({
      where: { campaignId: id },
      select: {
        status: true,
        amountPaise: true,
        brandKey: true,
        brandLabel: true,
        whatsappReceiptId: true,
        sentAt: true,
        messageClaimedAt: true,
        messageError: true,
        messageStatus: true,
        messageDeliveredAt: true,
        messageReadAt: true,
        messageFailureReason: true,
      },
    });
    const receipts = await this.receiptsFor(rows.map((r) => r.whatsappReceiptId));
    const base = this.previewSummary(rows, camp.budgetPaise);
    const n = (s: RS) => rows.filter((r) => r.status === s).length;
    const sumOf = (ss: RS[]) => rows.filter((r) => ss.includes(r.status)).reduce((a, r) => a + (r.amountPaise ?? 0n), 0n);
    let messageSent = 0;
    let delivered = 0;
    let read = 0;
    let messageFailed = 0;
    let messageNotSent = 0;
    for (const r of rows) {
      if (r.status !== RS.BOUGHT) continue;
      const m = messageView(r as never, r.whatsappReceiptId ? receipts.get(r.whatsappReceiptId) : null);
      if (MSG_SENT.has(m.status)) messageSent++;
      if (m.status === 'DELIVERED' || m.status === 'READ') delivered++;
      if (m.status === 'READ') read++;
      if (m.status === 'FAILED' || m.status === 'UNKNOWN') messageFailed++;
      if (m.status === 'NOT_SENT_YET' || m.status === 'SENDING' || m.status === 'QUEUED') messageNotSent++;
    }
    return {
      campaign: await this.campaignView(camp),
      hubbleConfigured: this.hubble.isConfigured(),
      summary: {
        ...base,
        queued: n(RS.QUEUED),
        buying: n(RS.BUYING),
        pendingReconcile: n(RS.PENDING_RECONCILE),
        pending: n(RS.QUEUED) + n(RS.BUYING) + n(RS.PENDING_RECONCILE),
        bought: n(RS.BOUGHT),
        buyFailed: n(RS.BUY_FAILED),
        cancelled: n(RS.CANCELLED),
        spentRupees: rupees(sumOf([RS.BOUGHT])),
        committedRupees: rupees(sumOf([RS.BUYING, RS.PENDING_RECONCILE, RS.BOUGHT])),
        messageSent,
        delivered,
        read,
        messageFailed,
        messageNotSent,
      },
    };
  }

  async rows(user: JwtPayload, id: string, q: ListDispersalRowsQueryDto) {
    this.assertAdmin(user);
    const camp = await this.getCampaignOr404(id);
    const page = q.page ?? 1;
    const where: Prisma.VoucherDispersalRowWhereInput = { campaignId: id, ...(q.status ? { status: q.status as RS } : {}) };
    const [total, rows] = await Promise.all([
      this.prisma.voucherDispersalRow.count({ where }),
      this.prisma.voucherDispersalRow.findMany({
        where,
        orderBy: { rowNumber: 'asc' },
        skip: (page - 1) * ROWS_PAGE_SIZE,
        take: ROWS_PAGE_SIZE,
      }),
    ]);
    const receipts = await this.receiptsFor(rows.map((r) => r.whatsappReceiptId));
    return {
      rows: rows.map((r) => this.rowView(r, r.whatsappReceiptId ? receipts.get(r.whatsappReceiptId) : null, camp.status)),
      page,
      pageSize: ROWS_PAGE_SIZE,
      total,
    };
  }

  /** Admin row projection — the voucher code is MASKED (shared audit rule: last 4 of a 12+ char code). */
  rowView(r: DbRow, receipt?: ReceiptLite | null, campaignStatus?: CS) {
    const m = messageView(r, receipt);
    const retryAt = this.retryAvailableAt(r);
    return {
      id: r.id,
      rowNumber: r.rowNumber,
      phone: r.phone ?? r.rawPhone,
      name: r.name,
      amount: r.amountPaise != null ? rupees(r.amountPaise) : null,
      brand: r.brandLabel,
      brandKey: r.brandKey,
      note: r.note,
      status: r.status,
      invalidReason: r.invalidReason,
      warning: r.warning,
      pendingReason: r.status === RS.PENDING_RECONCILE ? r.pendingReason : null,
      lastReconcileAt: r.lastReconcileAt,
      lastReconcileResult: r.lastReconcileResult,
      hubbleReferenceId: r.hubbleReferenceId,
      hubbleOrderId: r.hubbleOrderId,
      boughtAt: r.boughtAt,
      buyFailureReason: r.status === RS.BUY_FAILED ? r.buyFailureReason : null,
      buyFailureSource: r.status === RS.BUY_FAILED ? r.buyFailureSource : null,
      voucherCodeMasked: maskDispersalCode(r.voucherCode),
      hasPin: !!r.voucherPin,
      whatsapp: m,
      // Flat message fields (UI contract): SENT / DELIVERED / READ / FAILED, or null while not sent.
      ...this.flatMessage(r, m, receipt),
      attempts: r.attempts,
      resendCount: r.resendCount,
      canResend: r.status === RS.BOUGHT && !!r.voucherCode && firstSendSettled(r) && r.resendCount < MAX_RESENDS,
      canRetryBuy:
        campaignStatus !== CS.CANCELLED &&
        ((r.status === RS.BUY_FAILED && !(LOCAL_FAILURE_SOURCES.includes(r.buyFailureSource ?? '') && r.referenceSentAt && (retryAt === null || retryAt.getTime() > Date.now()))) ||
          (r.status === RS.PENDING_RECONCILE && retryAt !== null && retryAt.getTime() <= Date.now())),
      retryAvailableAt: r.status === RS.PENDING_RECONCILE ? retryAt : null,
    };
  }

  /** UI-facing flat message fields. SENT_UNTRACKED → SENT; an UNKNOWN send outcome → FAILED (+ error). */
  private flatMessage(r: DbRow, m: ReturnType<typeof messageView>, receipt?: ReceiptLite | null) {
    const map: Record<string, 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'> = {
      SENT: 'SENT',
      SENT_UNTRACKED: 'SENT',
      DELIVERED: 'DELIVERED',
      READ: 'READ',
      FAILED: 'FAILED',
      UNKNOWN: 'FAILED',
    };
    const messageStatus = map[m.status] ?? null;
    return {
      messageStatus,
      messageSentAt: m.sentAt,
      messageDeliveredAt: m.deliveredAt,
      messageReadAt: m.readAt,
      messageFailedAt: messageStatus === 'FAILED' ? (receipt?.updatedAt ?? r.updatedAt) : null,
      messageError: messageStatus === 'FAILED' ? (m.failureReason ?? r.messageError ?? 'Message failed') : null,
    };
  }

  async report(user: JwtPayload, id: string): Promise<{ buffer: Buffer; fileName: string }> {
    this.assertAdmin(user);
    const camp = await this.getCampaignOr404(id);
    const rows = await this.prisma.voucherDispersalRow.findMany({ where: { campaignId: id }, orderBy: { rowNumber: 'asc' } });
    const receipts = await this.receiptsFor(rows.map((r) => r.whatsappReceiptId));
    const out: DispersalReportRow[] = rows.map((r) => {
      const m = messageView(r, r.whatsappReceiptId ? receipts.get(r.whatsappReceiptId) : null);
      const failure =
        r.status === RS.INVALID || r.status === RS.DUPLICATE
          ? r.invalidReason
          : r.status === RS.BUY_FAILED
            ? r.buyFailureReason
            : r.status === RS.PENDING_RECONCILE
              ? `Pending with Hubble (${r.pendingReason ?? 'reconciling'})`
              : null;
      return {
        rowNumber: r.rowNumber,
        phone: r.phone ?? r.rawPhone ?? '',
        name: r.name,
        amountRupees: r.amountPaise != null ? rupees(r.amountPaise) : null,
        brand: r.brandLabel,
        voucherStatus: r.status,
        hubbleReference: r.hubbleOrderId
          ? `${r.hubbleOrderId} (ref ${r.hubbleReferenceId ?? '-'})`
          : r.hubbleReferenceId && r.status !== RS.VALID && r.status !== RS.QUEUED && r.status !== RS.CANCELLED
            ? `ref ${r.hubbleReferenceId}`
            : null,
        boughtAt: r.boughtAt,
        failureReason: failure,
        whatsappStatus: m.status,
        sentAt: m.sentAt,
        deliveredAt: m.deliveredAt,
        readAt: m.readAt,
        messageFailureReason: m.failureReason,
      };
    });
    const safeName = camp.name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'campaign';
    await this.auditCampaign(user, id, 'EXPORT', 'VOUCHER_DISPERSAL_REPORT_DOWNLOADED', { rows: rows.length });
    return { buffer: buildDispersalReport(out), fileName: `voucher-dispersal-${safeName}-${new Date().toISOString().slice(0, 10)}.xlsx` };
  }

  // ─── Row actions ──────────────────────────────────────────────────────────────

  /**
   * Re-send the WhatsApp for a BOUGHT row — never buys. Only after the first send has an outcome, at most
   * MAX_RESENDS times per row. The previous receipt is detached at the START (a failed resend can never
   * hide behind an old DELIVERED); a successful resend gets a NEW receipt. The campaign's completed status
   * is re-settled afterwards (COMPLETED ↔ COMPLETED_WITH_ERRORS).
   */
  async resend(user: JwtPayload, id: string, rowId: string) {
    this.assertAdmin(user);
    const row = await this.getRowOr404(id, rowId);
    if (row.status !== RS.BOUGHT || !row.voucherCode) {
      throw new ConflictException(`Only a bought voucher can be re-sent (row status ${row.status}).`);
    }
    if (!firstSendSettled(row)) {
      throw new ConflictException('The WhatsApp for this voucher is still being sent — wait for its result before resending.');
    }
    if (row.resendCount >= MAX_RESENDS) {
      throw new ConflictException(`This voucher has already been re-sent ${MAX_RESENDS} times — the limit per recipient.`);
    }
    const claimedAt = new Date();
    const claim = await this.prisma.voucherDispersalRow.updateMany({
      where: { id: row.id, status: RS.BOUGHT, updatedAt: row.updatedAt, resendCount: row.resendCount },
      data: {
        messageClaimedAt: claimedAt,
        resendCount: { increment: 1 },
        whatsappReceiptId: null,
        sentAt: null,
        messageError: null,
        messageStatus: null,
        messageDeliveredAt: null,
        messageReadAt: null,
        messageFailureReason: null,
      },
    });
    if (claim.count !== 1) throw new ConflictException('This row changed meanwhile — refresh and try again.');
    const res = await this.processor.deliver(row.id, claimedAt);
    await this.processor.audit(
      row.id,
      'VOUCHER_DISPERSAL_RESENT',
      { campaignId: id, resendNumber: row.resendCount + 1, previousReceiptId: row.whatsappReceiptId, receiptId: res.receiptId, error: res.error },
      user.sub,
    );
    await this.processor.settleCampaign(id).catch((e: unknown) => this.logger.error(`[dispersal] settle after resend failed: ${e}`));
    const fresh = await this.prisma.voucherDispersalRow.findFirstOrThrow({ where: { id: row.id } });
    const rc = await this.receiptsFor([fresh.whatsappReceiptId]);
    const camp = await this.getCampaignOr404(id);
    return this.rowView(fresh, fresh.whatsappReceiptId ? rc.get(fresh.whatsappReceiptId) : null, camp.status);
  }

  /** When an indeterminate row may be manually re-placed (2 h after its last place attempt / flag). */
  retryAvailableAt(r: Pick<DbRow, 'placeAttemptAt' | 'pendingSince' | 'createdAt'>): Date | null {
    const anchors = [r.placeAttemptAt, r.pendingSince].filter((d): d is Date => !!d).map((d) => new Date(d).getTime());
    if (anchors.length === 0) return null;
    return new Date(Math.max(...anchors) + DISPERSAL_RETRY_MIN_AGE_MS);
  }

  /**
   * Manual retry of a row that did not get a voucher. Same Hubble safety rules as the engine:
   *  - BUY_FAILED locally (NOT_SENT / BUDGET) and the reference NEVER reached Hubble → re-queued with the
   *    SAME (unused) reference.
   *  - BUY_FAILED locally but the reference DID reach Hubble on an earlier attempt → treated like an
   *    indeterminate row (2 h rule, Hubble asked, canary) → re-queued with the SAME reference.
   *  - BUY_FAILED by Hubble (FAILED / REJECTED): Hubble is asked again first. It now holds a voucher →
   *    delivered, NOT bought again. FAILED, or a canary-verified "no order" → re-queued with a NEW
   *    reference (the old one is kept in previousReferenceIds; Hubble may refuse to reuse a failed one).
   *  - PENDING_RECONCILE: only ≥ 2 h after the last place attempt, and only when Hubble — asked now —
   *    has no order AND the canary verifies that answer → re-queued with the SAME reference.
   * The re-queue and the campaign re-open happen in ONE transaction under the campaign lock (a CANCELLED
   * campaign is refused inside it). Idempotent: repeated while queued / buying / bought → current state.
   */
  async retryBuy(user: JwtPayload, id: string, rowId: string) {
    this.assertAdmin(user);
    const camp = await this.getCampaignOr404(id);
    if (camp.status === CS.CANCELLED || camp.status === CS.DRAFT || camp.status === CS.PREVIEWED) {
      throw new ConflictException(`Retry is not available on a ${camp.status} campaign.`);
    }
    if (!this.hubble.isConfigured()) throw new ServiceUnavailableException('Hubble is not configured in this environment.');
    const row = await this.getRowOr404(id, rowId);
    // IDEMPOTENT: a repeated retry while the first is queued / in flight / done returns that state.
    const already = await this.retryInFlight(row.id);
    if (already) return already;
    const audit = (outcome: string, extra: Record<string, unknown> = {}) =>
      this.processor.audit(row.id, 'VOUCHER_DISPERSAL_RETRY_BUY', { campaignId: id, fromStatus: row.status, outcome, ...extra }, user.sub);

    const localFailure = row.status === RS.BUY_FAILED && LOCAL_FAILURE_SOURCES.includes(row.buyFailureSource ?? '');
    const indeterminate = row.status === RS.PENDING_RECONCILE || (localFailure && !!row.referenceSentAt);
    if (row.status !== RS.BUY_FAILED && row.status !== RS.PENDING_RECONCILE) {
      throw new ConflictException(`Retry is only for a failed or long-pending row (row status ${row.status}).`);
    }

    let newRef: string | null = null;
    let canaryRef: string | null = null;
    if (localFailure && !row.referenceSentAt) {
      // Never reached Hubble with this reference → nothing to check; reuse it.
    } else {
      if (indeterminate) {
        const at = this.retryAvailableAt(row);
        if (!at || at.getTime() > Date.now()) {
          await audit('REFUSED_TOO_RECENT', { availableAt: at?.toISOString() ?? null });
          throw new ConflictException(
            `Hubble may still create this order. A retry is allowed 2 hours after the last attempt${at ? ` (from ${at.toISOString()})` : ''}; until then it keeps being checked automatically.`,
          );
        }
      }
      const look = await this.lookup(row.hubbleReferenceId!);
      if (look.kind === 'ERROR') {
        await audit('REFUSED_LOOKUP_FAILED', { why: look.why });
        throw new ConflictException(`Could not reach Hubble to check this row (${look.why}). Try again later.`);
      }
      if (look.kind === 'ORDER') {
        const st = String(look.body.status ?? '').toUpperCase();
        if (st !== 'FAILED') {
          const outcome = await this.processor.applyBody(row, look.body);
          await audit(`HUBBLE_HAS_ORDER_${st || 'UNKNOWN'}`, { applied: outcome });
          if (outcome === 'BOUGHT') await this.processor.sendMessage(row.id);
          return this.retryResult(row.id, `Hubble already holds an order for this row (${st}) — applied, nothing bought again.`);
        }
        // Hubble DEFINITIVELY failed this reference → a new reference for the new attempt.
        newRef = `vd${randomBytes(12).toString('hex')}`;
      } else {
        const canary = await this.processor.verifyNotFoundCanary(row.hubbleReferenceId!);
        if (!canary.ok) {
          await audit('REFUSED_NO_ORDER_UNVERIFIED', { why: canary.why.slice(0, 300) });
          throw new ConflictException(`Hubble says it has no order for this row, but that answer could not be verified (${canary.why.slice(0, 200)}). Not retried.`);
        }
        canaryRef = canary.canaryRef;
        // Indeterminate → SAME reference (if the original ever lands, Hubble dedups it).
        // Definitively failed by Hubble (FAILED / REJECTED) and verified gone → a new reference.
        if (!indeterminate) newRef = `vd${randomBytes(12).toString('hex')}`;
      }
    }

    const r = await this.processor.requeueUnderLock(
      id,
      { id: row.id, status: row.status, updatedAt: row.updatedAt, voucherCode: null },
      {
        buyFailureReason: null,
        buyFailureSource: null,
        claimToken: null,
        pendingReason: null,
        ...(newRef
          ? {
              hubbleReferenceId: newRef,
              previousReferenceIds: { push: row.hubbleReferenceId! },
              hubbleOrderId: null,
              placeResponded: null,
              referenceSentAt: null,
            }
          : {}),
      },
    );
    if (r === 'CAMPAIGN_CLOSED') {
      await audit('REFUSED_CAMPAIGN_CLOSED');
      throw new ConflictException('The campaign was cancelled meanwhile — nothing re-queued.');
    }
    if (r === 'LOST') {
      const inflight = await this.retryInFlight(row.id);
      if (inflight) return inflight;
      throw new ConflictException('This row changed meanwhile — refresh and try again.');
    }
    await audit(newRef ? 'REQUEUED_NEW_REFERENCE' : 'REQUEUED_SAME_REFERENCE', { previousFailure: row.buyFailureSource ?? row.pendingReason, canaryRef });
    this.processor.kick(id);
    return this.retryResult(
      row.id,
      newRef ? 'Queued for purchase again (new Hubble reference).' : 'Queued for purchase again with the same Hubble reference.',
    );
  }

  private async lookup(ref: string): Promise<{ kind: 'ORDER'; body: HubbleOrderResult } | { kind: 'NONE' } | { kind: 'ERROR'; why: string }> {
    try {
      const body = await this.hubble.getOrderByReference(ref);
      return body ? { kind: 'ORDER', body } : { kind: 'NONE' };
    } catch (e) {
      return { kind: 'ERROR', why: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }

  private async retryResult(rowId: string, message: string) {
    const fresh = await this.prisma.voucherDispersalRow.findFirstOrThrow({ where: { id: rowId } });
    const rc = await this.receiptsFor([fresh.whatsappReceiptId]);
    const camp = await this.prisma.voucherDispersalCampaign.findUnique({ where: { id: fresh.campaignId }, select: { status: true } });
    return { message, row: this.rowView(fresh, fresh.whatsappReceiptId ? rc.get(fresh.whatsappReceiptId) : null, camp?.status) };
  }

  /** Idempotent answer when a retry is repeated while the row is already queued / in flight / bought. */
  private async retryInFlight(rowId: string) {
    const now = await this.prisma.voucherDispersalRow.findFirst({ where: { id: rowId }, select: { status: true } });
    const msg: Partial<Record<RS, string>> = {
      [RS.QUEUED]: 'Already queued for purchase.',
      [RS.BUYING]: 'A purchase for this row is in progress.',
      [RS.BOUGHT]: 'This row already has its voucher — nothing bought again.',
    };
    const m = now ? msg[now.status] : undefined;
    return m ? this.retryResult(rowId, m) : null;
  }

  // ─── Cancel ───────────────────────────────────────────────────────────────────

  /**
   * Before confirm: the whole campaign is cancelled (nothing was ever sent to Hubble).
   * While processing: QUEUED rows not yet sent to Hubble are cancelled; rows already with Hubble
   * (BUYING / PENDING_RECONCILE) keep being reconciled and BOUGHT rows are untouched (and still messaged).
   */
  async cancel(user: JwtPayload, id: string) {
    this.assertAdmin(user);
    const result = await this.prisma.$transaction(async (tx) => {
      const camp = await tx.voucherDispersalCampaign.update({ where: { id }, data: { updatedAt: new Date() } }).catch(() => null);
      if (!camp) throw new NotFoundException('Campaign not found.');
      const from = camp.status;
      if (from === CS.DRAFT || from === CS.PREVIEWED) {
        // Only VALID rows are cancelled — INVALID / DUPLICATE rows keep their status + reason (visible).
        const r = await tx.voucherDispersalRow.updateMany({
          where: { campaignId: id, status: RS.VALID },
          data: { status: RS.CANCELLED },
        });
        const c = await tx.voucherDispersalCampaign.update({
          where: { id },
          data: { status: CS.CANCELLED, cancelledAt: new Date(), cancelledById: user.sub },
        });
        return { c, from, cancelledRows: r.count, inFlight: 0, bought: 0 };
      }
      if (from === CS.PROCESSING || from === CS.CONFIRMED) {
        const r = await tx.voucherDispersalRow.updateMany({
          where: { campaignId: id, status: RS.QUEUED },
          data: { status: RS.CANCELLED },
        });
        const inFlight = await tx.voucherDispersalRow.count({
          where: { campaignId: id, status: { in: [RS.BUYING, RS.PENDING_RECONCILE] } },
        });
        const bought = await tx.voucherDispersalRow.count({ where: { campaignId: id, status: RS.BOUGHT } });
        const c = await tx.voucherDispersalCampaign.update({
          where: { id },
          data: { status: CS.CANCELLED, cancelledAt: new Date(), cancelledById: user.sub },
        });
        return { c, from, cancelledRows: r.count, inFlight, bought };
      }
      throw new ConflictException(`A ${from} campaign cannot be cancelled.`);
    });
    await this.auditCampaign(user, id, 'UPDATE', 'VOUCHER_DISPERSAL_CANCELLED', {
      fromStatus: result.from,
      cancelledRows: result.cancelledRows,
      stillWithHubble: result.inFlight,
      alreadyBought: result.bought,
    });
    return {
      campaign: await this.campaignView(result.c),
      cancelledRows: result.cancelledRows,
      stillWithHubble: result.inFlight,
      alreadyBought: result.bought,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private async getCampaignOr404(id: string): Promise<CampaignRow> {
    const c = await this.prisma.voucherDispersalCampaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Campaign not found.');
    return c;
  }

  private async getRowOr404(campaignId: string, rowId: string): Promise<DbRow> {
    const r = await this.prisma.voucherDispersalRow.findFirst({ where: { id: rowId, campaignId } });
    if (!r) throw new NotFoundException('Row not found in this campaign.');
    return r;
  }

  private async receiptsFor(ids: (string | null | undefined)[]): Promise<Map<string, ReceiptLite>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const out = new Map<string, ReceiptLite>();
    for (let i = 0; i < list.length; i += 1000) {
      const chunk = await this.prisma.messageDeliveryReceipt.findMany({
        where: { id: { in: list.slice(i, i + 1000) } },
        select: { id: true, status: true, sentAt: true, deliveredAt: true, readAt: true, failureReason: true, updatedAt: true },
      });
      for (const r of chunk) out.set(r.id, { ...r, status: String(r.status) });
    }
    return out;
  }

  private async clientNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (list.length === 0) return new Map();
    const rows = await this.prisma.client.findMany({ where: { id: { in: list } }, select: { id: true, internalName: true, branding: true } });
    return new Map(
      rows.map((c) => {
        const dn = ((c.branding ?? {}) as Record<string, unknown>).displayName;
        return [c.id, typeof dn === 'string' && dn.trim() ? dn.trim() : c.internalName];
      }),
    );
  }

  private async campaignView(c: CampaignRow) {
    return this.campaignViewSync(c, await this.clientNames([c.billedToClientId]));
  }

  private campaignViewSync(c: CampaignRow, names: Map<string, string>) {
    return {
      id: c.id,
      name: c.name,
      programLabel: c.programLabel,
      billedToClient: c.billedToClientId ? { id: c.billedToClientId, name: names.get(c.billedToClientId) ?? c.billedToClientId } : null,
      note: c.note,
      budgetRupees: rupees(c.budgetPaise),
      status: c.status,
      sourceFileName: c.sourceFileName,
      uploadedAt: c.uploadedAt,
      createdById: c.createdById,
      createdAt: c.createdAt,
      confirmedById: c.confirmedById,
      confirmedAt: c.confirmedAt,
      cancelledById: c.cancelledById,
      cancelledAt: c.cancelledAt,
      completedAt: c.completedAt,
      updatedAt: c.updatedAt,
      previewId: c.status === CS.PREVIEWED ? c.previewId : null,
      canCancel: c.status === CS.DRAFT || c.status === CS.PREVIEWED || c.status === CS.CONFIRMED || c.status === CS.PROCESSING,
    };
  }

  private async auditCampaign(
    user: JwtPayload,
    id: string,
    action: 'CREATE' | 'UPDATE' | 'IMPORT' | 'APPROVE' | 'EXPORT',
    event: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog
      .create({
        data: {
          actorId: user.sub,
          action,
          entityType: 'VOUCHER_DISPERSAL_CAMPAIGN',
          entityId: id,
          metadata: { event, ...metadata } as Prisma.InputJsonValue,
        },
      })
      .catch((e: unknown) => this.logger.error(`[dispersal] audit ${event} failed for campaign ${id}: ${e}`));
  }
}
