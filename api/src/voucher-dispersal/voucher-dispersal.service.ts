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
  VoucherDispersalBatchStatus as BS,
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
  CAMPAIGN_LOCK_TX,
  SETTLE_FAILURES_BEFORE_ALERT,
  budgetBreakdown,
  overBudget,
  type BudgetBreakdown,
} from './voucher-dispersal.processor';
import { maskVoucherCodeForAudit } from '../rewards/voucher-issuance';
import {
  ConfirmDispersalCampaignDto,
  CreateDispersalCampaignDto,
  EditDispersalCampaignDto,
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
type BatchRow = Prisma.VoucherDispersalBatchGetPayload<Record<string, never>>;
type Tx = Prisma.TransactionClient;
type EarlierRow = { id: string; phone: string | null; status: RS; batchNumber: number; dedupePhone: string | null };
type SheetNotes = {
  skippedBlankRows: number | null;
  skippedFormulaRows: number | null;
  skippedNote: string | null;
  hiddenRowsIncluded: number | null;
  hiddenNote: string | null;
};

/** The upload notes for skipped (blank / formula-only) and hidden rows — null counts = not recorded. */
export function sheetNotes(blank: number | null, formulaOnly: number | null, hidden: number | null): SheetNotes {
  const skipped = (blank ?? 0) + (formulaOnly ?? 0);
  return {
    skippedBlankRows: blank,
    skippedFormulaRows: formulaOnly,
    skippedNote: skipped
      ? `${skipped} row${skipped === 1 ? '' : 's'} skipped: ${[
          blank ? `${blank} blank` : '',
          formulaOnly ? `${formulaOnly} with formulas but no saved values (open the file in Excel, save, and upload again)` : '',
        ]
          .filter(Boolean)
          .join('; ')}`
      : null,
    hiddenRowsIncluded: hidden,
    hiddenNote: hidden ? `${hidden} hidden row${hidden === 1 ? '' : 's'} included (they are hidden in Excel but will be sent)` : null,
  };
}
type ReceiptLite = { id: string; status: string; sentAt: Date | null; deliveredAt: Date | null; readAt: Date | null; failureReason: string | null; updatedAt?: Date | null };

const ROWS_PAGE_SIZE = 100;
const CAMPAIGNS_PAGE_SIZE = 50;
const CREATE_CHUNK = 1000;
const PREVIEW_STATUSES: RS[] = [RS.VALID, RS.INVALID, RS.DUPLICATE];
const NOT_VALID: RS[] = [RS.INVALID, RS.DUPLICATE, RS.CANCELLED];
/** Rows that hold (or held, and may still get) this campaign's voucher for their phone. */
const LIVE_ROW: RS[] = [RS.QUEUED, RS.BUYING, RS.PENDING_RECONCILE, RS.BOUGHT, RS.BUY_FAILED];
/** Rows whose purchase is not finished — a new batch waits until there are none. */
const IN_FLIGHT: RS[] = [RS.QUEUED, RS.BUYING, RS.PENDING_RECONCILE];
const EDIT_EVENT = 'VOUCHER_DISPERSAL_EDITED';
const settleFailing = (c: { settleFailures?: number | null }) => (c.settleFailures ?? 0) >= SETTLE_FAILURES_BEFORE_ALERT;
/** A batch row marked DUPLICATE because its phone is live in an EARLIER batch (reason text set by uploadBatch). */
const CROSS_BATCH_REASON = /^Already (sent )?in batch \d+/;

/** Why "Add more people" is not available for a campaign status (null = available). Re-checked server-side. */
export const SETTLE_FAILING_REASON = "This campaign's status update keeps failing — contact Gifsy tech.";

export function addPeopleBlockedReason(status: CS, settleFailing = false): string | null {
  // A campaign whose status settle keeps failing stays PROCESSING — say so, never "still being bought".
  if (settleFailing) return SETTLE_FAILING_REASON;
  if (status === CS.COMPLETED || status === CS.COMPLETED_WITH_ERRORS) return null;
  if (status === CS.CANCELLED) return 'This campaign was cancelled — people cannot be added to it.';
  if (status === CS.DRAFT || status === CS.PREVIEWED) return 'Confirm the first file before adding more people (this campaign is still in setup).';
  return 'Vouchers in this campaign are still being bought — you can add more people once every purchase has finished (the campaign shows Completed).';
}

const inr = (paise: bigint | number) => `₹${rupees(paise).toLocaleString('en-IN')}`;
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
      CAMPAIGN_LOCK_TX,
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
      // Stale-preview protection FIRST (re-review L8): confirm exactly what the admin saw, then the budget.
      if (dto.expectedValidCount !== validCount || BigInt(dto.expectedTotalRupees) * 100n !== totalPaise) {
        throw new ConflictException(
          `The preview changed: it now has ${validCount} valid row(s) totalling ₹${rupees(totalPaise).toLocaleString('en-IN')} (you confirmed ${dto.expectedValidCount} / ₹${Number(dto.expectedTotalRupees).toLocaleString('en-IN')}). Review the preview again.`,
        );
      }
      if (totalPaise > BigInt(camp.budgetPaise)) {
        throw new BadRequestException(
          `The valid rows total ₹${rupees(totalPaise).toLocaleString('en-IN')}, over the ₹${rupees(camp.budgetPaise).toLocaleString('en-IN')} budget. Remove rows, or Edit campaign to raise the budget.`,
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
    }, CAMPAIGN_LOCK_TX);
    if (result.repeat) return this.campaignView(result.updated);
    await this.auditCampaign(user, id, 'APPROVE', 'VOUCHER_DISPERSAL_CONFIRMED', {
      previewId: dto.previewId,
      validCount: result.validCount,
      totalRupees: result.totalRupees,
    });
    this.processor.kick(id);
    return this.campaignView(result.updated);
  }


  // ─── Edit (name / budget) ─────────────────────────────────────────────────────

  /**
   * Money that can still be spent on this campaign — the lowest the budget may go. ONE definition shared
   * with the buy engine (`mayStillCostWhere` / `budgetBreakdown` in the processor): spent (BOUGHT) · with
   * Hubble, not yet confirmed (BUYING + PENDING_RECONCILE) · failed purchases Hubble may still complete
   * (BUY_FAILED whose reference reached Hubble) · queued (confirmed, not yet bought). Rows of an unconfirmed
   * batch are VALID and never count.
   */
  private async budgetUsage(db: Tx | PrismaService, campaignId: string): Promise<BudgetBreakdown> {
    return budgetBreakdown(db, campaignId);
  }

  /** "spent ₹A · with Hubble (not yet confirmed) ₹B · failed purchases Hubble may still complete ₹C · queued ₹D". */
  private usageText(b: BudgetBreakdown): string {
    return `spent ${inr(b.spentPaise)} · with Hubble (not yet confirmed) ${inr(b.withHubblePaise)} · failed purchases Hubble may still complete ${inr(b.failedMayCompletePaise)} · queued ${inr(b.queuedPaise)}`;
  }

  /**
   * PATCH /campaigns/:id — rename and/or change the budget. Not on a CANCELLED campaign. The budget may go
   * up, or down to (never below) the floor (`budgetUsage`), computed under the campaign row lock (the same lock
   * every buy claim takes, so no purchase can slip in between the check and the write). Every edit is audited
   * INSIDE the same transaction (AuditLog VOUCHER_DISPERSAL_EDITED: actor, time, old → new) — no edit without
   * history — and listed on the detail page.
   */
  async editCampaign(user: JwtPayload, id: string, dto: EditDispersalCampaignDto) {
    this.assertAdmin(user);
    // null is "not a value" — a 400, never a crash (the DTO refuses it too).
    if ((dto as { name?: unknown }).name === null) throw new BadRequestException('The campaign name cannot be empty.');
    if ((dto as { budgetRupees?: unknown }).budgetRupees === null) throw new BadRequestException('Budget must be a whole number of rupees above 0.');
    const name = dto.name === undefined ? undefined : dto.name.replace(/\s+/g, ' ').trim();
    if (name !== undefined && !name) throw new BadRequestException('The campaign name cannot be empty.');
    if (name === undefined && dto.budgetRupees === undefined) {
      throw new BadRequestException('Nothing to change — send a new name and/or budget.');
    }
    if (dto.budgetRupees !== undefined && (!Number.isInteger(dto.budgetRupees) || dto.budgetRupees <= 0)) {
      throw new BadRequestException('Budget must be a whole number of rupees above 0.');
    }
    const r = await this.prisma.$transaction(async (tx) => {
      const camp = await tx.voucherDispersalCampaign.update({ where: { id }, data: { updatedAt: new Date() } }).catch(() => null);
      if (!camp) throw new NotFoundException('Campaign not found.');
      if (camp.status === CS.CANCELLED) throw new ConflictException('A cancelled campaign cannot be edited.');
      const changes: { field: 'name' | 'budgetRupees'; from: string | number; to: string | number }[] = [];
      if (name !== undefined && name !== camp.name) changes.push({ field: 'name', from: camp.name, to: name });
      const newBudget = dto.budgetRupees !== undefined ? BigInt(dto.budgetRupees) * 100n : BigInt(camp.budgetPaise);
      if (newBudget !== BigInt(camp.budgetPaise)) changes.push({ field: 'budgetRupees', from: rupees(camp.budgetPaise), to: rupees(newBudget) });
      if (changes.length === 0) throw new BadRequestException('Nothing to change — the name and budget already have these values.');
      if (newBudget < BigInt(camp.budgetPaise)) {
        const usage = await this.budgetUsage(tx, id);
        if (newBudget < usage.floorPaise) {
          throw new BadRequestException(`The budget can't go below ${inr(usage.floorPaise)} — ${this.usageText(usage)}.`);
        }
      }
      const updated = await tx.voucherDispersalCampaign.update({
        where: { id },
        data: { ...(name !== undefined ? { name } : {}), budgetPaise: newBudget },
      });
      const pickChanged = (src: { name: string; budgetPaise: bigint }) =>
        Object.fromEntries(changes.map((c) => [c.field, c.field === 'name' ? src.name : rupees(src.budgetPaise)]));
      await this.auditCampaignTx(tx, user, id, 'UPDATE', EDIT_EVENT, { changes }, { oldValues: pickChanged(camp), newValues: pickChanged(updated) });
      return { updated };
    }, CAMPAIGN_LOCK_TX);
    return this.campaignView(r.updated);
  }

  /** The campaign's edit history (newest first) for the detail page. */
  private async editHistory(id: string) {
    const logs = await this.prisma.auditLog.findMany({
      where: { entityType: 'VOUCHER_DISPERSAL_CAMPAIGN', entityId: id, metadata: { path: ['event'], equals: EDIT_EVENT } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const names = await this.userNames(logs.map((l) => l.actorId));
    return logs.map((l) => {
      const m = (l.metadata ?? {}) as { changes?: { field: string; from: unknown; to: unknown }[] };
      return {
        at: l.createdAt,
        byId: l.actorId,
        byName: l.actorId ? names.get(l.actorId) ?? null : null,
        changes: Array.isArray(m.changes) ? m.changes.map((c) => ({ field: c.field, from: c.from, to: c.to })) : [],
      };
    });
  }

  // ─── Add more people (batches 2, 3, …) ────────────────────────────────────────

  /** Lock the campaign row and refuse unless people may be added now (finished, nothing in flight). */
  private async lockForBatch(tx: Tx, id: string): Promise<CampaignRow> {
    const camp = await tx.voucherDispersalCampaign.update({ where: { id }, data: { updatedAt: new Date() } }).catch(() => null);
    if (!camp) throw new NotFoundException('Campaign not found.');
    const why = addPeopleBlockedReason(camp.status, settleFailing(camp));
    if (why) throw new ConflictException(why);
    const inFlight = await tx.voucherDispersalRow.count({ where: { campaignId: id, status: { in: IN_FLIGHT } } });
    if (inFlight > 0) throw new ConflictException(addPeopleBlockedReason(CS.PROCESSING)!);
    return camp;
  }

  /**
   * Rows of OTHER batches for these phones that matter to a new batch: live rows (they own the phone — the new
   * row is DUPLICATE) and dead rows still holding a phone's one-voucher key (they give it up). A plain read;
   * run once OUTSIDE the lock to build the preview, and again UNDER the lock to re-check.
   */
  private async earlierRowsFor(db: Tx | PrismaService, campaignId: string, phones: string[], excludeBatch: number | null) {
    const out: EarlierRow[] = [];
    for (let i = 0; i < phones.length; i += 1000) {
      out.push(
        ...(await db.voucherDispersalRow.findMany({
          where: {
            campaignId,
            phone: { in: phones.slice(i, i + 1000) },
            ...(excludeBatch !== null ? { batchNumber: { not: excludeBatch } } : {}),
            OR: [{ status: { in: LIVE_ROW } }, { dedupePhone: { not: null } }],
          },
          select: { id: true, phone: true, status: true, batchNumber: true, dedupePhone: true },
          orderBy: [{ batchNumber: 'asc' }, { rowNumber: 'asc' }],
        })),
      );
    }
    return out;
  }

  /** Stable signature of what the duplicate check depends on (to detect a change between the two reads). */
  private earlierSignature(rows: EarlierRow[]): string {
    return rows.map((r) => `${r.id}:${r.status}:${r.dedupePhone ?? ''}`).sort().join('|');
  }

  /** Pure: the new batch's rows given the earlier batches' rows (cross-batch DUPLICATE + key hand-over). */
  private buildBatchRows(parsed: ParsedDispersalRow[], warnings: Map<string, string>, earlier: EarlierRow[]) {
    const liveBy = new Map<string, { batchNumber: number; status: RS }>();
    for (const e of earlier) if (e.phone && LIVE_ROW.includes(e.status) && !liveBy.has(e.phone)) liveBy.set(e.phone, e);
    let crossBatchDuplicates = 0;
    const built = parsed.map((r) => {
      let status = r.status as RS;
      let invalidReason = r.invalidReason;
      let dedupePhone = r.dedupePhone;
      const live = r.phone ? liveBy.get(r.phone) : undefined;
      if (live) {
        dedupePhone = null;
        if (status === RS.VALID) {
          status = RS.DUPLICATE;
          crossBatchDuplicates++;
          invalidReason =
            live.status === RS.BUY_FAILED
              ? `Already in batch ${live.batchNumber}, where its purchase failed — use Retry on that row instead (one voucher per phone per campaign)`
              : `Already sent in batch ${live.batchNumber} — one voucher per phone per campaign`;
        }
      }
      const amountPaise = r.amountRupees != null && Number.isInteger(r.amountRupees) ? BigInt(r.amountRupees) * 100n : null;
      return {
        r,
        status,
        invalidReason,
        dedupePhone,
        amountPaise,
        warning: r.phone && status === RS.VALID ? warnings.get(r.phone) ?? null : null,
        // The Hubble idempotency key is fixed NOW — before anything can reach Hubble.
        hubbleReferenceId: status === RS.VALID ? `vd${randomBytes(12).toString('hex')}` : null,
      };
    });
    // A DEAD earlier row (INVALID / DUPLICATE / CANCELLED — never bought, never will be) holding a phone's
    // one-voucher key gives it up to this batch's row for that phone.
    const taking = new Set(built.map((b) => b.dedupePhone).filter((x): x is string => !!x));
    const release = earlier.filter((e) => e.dedupePhone && taking.has(e.dedupePhone) && NOT_VALID.includes(e.status)).map((e) => e.id);
    return { built, crossBatchDuplicates, release };
  }

  /**
   * POST /campaigns/:id/batches — upload another file to a FINISHED campaign (COMPLETED /
   * COMPLETED_WITH_ERRORS, nothing in flight). Same parse + validation as the first file. A phone that
   * already has a live row in an earlier batch (bought, or failed and retryable there) is DUPLICATE with
   * the batch named; the one-voucher-per-phone DB key spans every batch. Re-uploading while the campaign's
   * newest batch is still unconfirmed REPLACES that batch's rows (same number, new previewId). Nothing is
   * bought until confirmBatch; until then the batch's rows count in no total, list summary or report.
   * Money-audit M3: parsing, the live Hubble limits, the warnings and the duplicate lookup all run OUTSIDE the
   * campaign row lock; the locked transaction only re-checks (batch state + the duplicate set) and writes.
   */
  async uploadBatch(user: JwtPayload, id: string, file: Express.Multer.File | undefined) {
    this.assertAdmin(user);
    const pre = await this.getCampaignOr404(id);
    const why = addPeopleBlockedReason(pre.status, settleFailing(pre));
    if (why) throw new ConflictException(why);
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
    const fileName = (file.originalname ?? 'upload.xlsx').slice(0, 200);
    const previewId = `pv${randomBytes(12).toString('hex')}`;
    const phones = [...new Set(parsed.map((r) => r.phone).filter((x): x is string => !!x))];
    // Outside the lock: which batch would be replaced, and the duplicate check against earlier batches.
    const waitingBefore = await this.prisma.voucherDispersalBatch.findFirst({ where: { campaignId: id, status: BS.PREVIEWED } });
    const earlierBefore = await this.earlierRowsFor(this.prisma, id, phones, waitingBefore?.batchNumber ?? null);
    let plan = this.buildBatchRows(parsed, warnings, earlierBefore);
    const notes = sheetNotes(sheet.skippedBlank, sheet.skippedFormulaOnly, sheet.hiddenIncluded);
    const now = new Date();

    const res = await this.prisma.$transaction(
      async (tx) => {
        const camp = await this.lockForBatch(tx, id);
        let batch = await tx.voucherDispersalBatch.findFirst({ where: { campaignId: id, status: BS.PREVIEWED } });
        const sheetCounts = { skippedBlankRows: sheet.skippedBlank, skippedFormulaRows: sheet.skippedFormulaOnly, hiddenRowsIncluded: sheet.hiddenIncluded };
        if (batch) {
          const live = await tx.voucherDispersalRow.count({
            where: { campaignId: id, batchNumber: batch.batchNumber, status: { notIn: PREVIEW_STATUSES } },
          });
          if (live > 0) throw new ConflictException(`Batch ${batch.batchNumber} already has rows in processing — refresh.`);
          await tx.voucherDispersalRow.deleteMany({ where: { campaignId: id, batchNumber: batch.batchNumber } });
          batch = await tx.voucherDispersalBatch.update({
            where: { id: batch.id },
            data: { previewId, sourceFileName: fileName, uploadedById: user.sub, uploadedAt: now, ...sheetCounts },
          });
        } else {
          const last = await tx.voucherDispersalBatch.findFirst({ where: { campaignId: id }, orderBy: { batchNumber: 'desc' } });
          batch = await tx.voucherDispersalBatch.create({
            data: {
              campaignId: id,
              batchNumber: Math.max(1, last?.batchNumber ?? 1) + 1,
              status: BS.PREVIEWED,
              previewId,
              sourceFileName: fileName,
              uploadedById: user.sub,
              uploadedAt: now,
              ...sheetCounts,
            },
          });
        }
        const n = batch.batchNumber;
        // Re-check the duplicate set under the lock: anything that changed since the outside read → rebuild.
        const earlierNow = await this.earlierRowsFor(tx, id, phones, n);
        if (this.earlierSignature(earlierNow) !== this.earlierSignature(earlierBefore)) plan = this.buildBatchRows(parsed, warnings, earlierNow);
        if (plan.release.length) await tx.voucherDispersalRow.updateMany({ where: { id: { in: plan.release } }, data: { dedupePhone: null } });

        const data: Prisma.VoucherDispersalRowCreateManyInput[] = plan.built.map((b) => ({
          campaignId: id,
          batchNumber: n,
          rowNumber: b.r.rowNumber,
          phone: b.r.phone,
          rawPhone: b.r.rawPhone.slice(0, 40) || null,
          dedupePhone: b.dedupePhone,
          name: b.r.name || '',
          amountPaise: b.amountPaise,
          brandKey: b.r.brandKey,
          brandLabel: b.r.brandLabel?.slice(0, 80) ?? null,
          productId: b.r.productId,
          note: b.r.note,
          status: b.status,
          invalidReason: b.invalidReason?.slice(0, 500) ?? null,
          warning: b.warning,
          hubbleReferenceId: b.hubbleReferenceId,
        }));
        for (let i = 0; i < data.length; i += CREATE_CHUNK) {
          await tx.voucherDispersalRow.createMany({ data: data.slice(i, i + CREATE_CHUNK) });
        }
        const usage = await this.budgetUsage(tx, id);
        const view = this.batchPreviewView(
          camp,
          batch,
          plan.built.map((b) => ({
            rowNumber: b.r.rowNumber,
            phone: b.r.phone ?? b.r.rawPhone,
            name: b.r.name,
            amountPaise: b.amountPaise,
            amountRupees: b.r.amountRupees,
            brandLabel: b.r.brandLabel,
            brandKey: b.r.brandKey,
            note: b.r.note,
            status: b.status,
            invalidReason: b.invalidReason,
            warning: b.warning,
          })),
          usage.floorPaise,
          notes,
        );
        // Inside the transaction (money-audit M4): no batch without its audit row.
        await this.auditCampaignTx(tx, user, id, 'IMPORT', 'VOUCHER_DISPERSAL_BATCH_UPLOADED', {
          batchNumber: n,
          fileName,
          warningCount: view.summary.warningCount,
          skippedRows: sheet.skippedBlank + sheet.skippedFormulaOnly,
          hiddenRowsIncluded: sheet.hiddenIncluded,
          total: view.summary.total,
          valid: view.summary.valid,
          invalid: view.summary.invalid,
          duplicates: view.summary.duplicates,
          crossBatchDuplicates: view.summary.crossBatchDuplicates,
          totalRupees: view.summary.totalRupees,
          remainingBudgetRupees: view.summary.remainingBudgetRupees,
          overBudget: view.summary.overBudget,
        });
        return { camp, view };
      },
      // Only re-checks + writes run under the lock (≤ 5,000 rows inserted in chunks of 1,000); the same
      // timeout / maxWait as every other campaign-lock transaction, so none of them times out waiting.
      CAMPAIGN_LOCK_TX,
    );
    return { ...res.view, campaign: await this.campaignView(res.camp) };
  }

  /** GET /campaigns/:id/batches/:n — the preview of a batch that is waiting for confirmation (resume). */
  async batchPreview(user: JwtPayload, id: string, n: number) {
    this.assertAdmin(user);
    const camp = await this.getCampaignOr404(id);
    const batch = await this.prisma.voucherDispersalBatch.findFirst({ where: { campaignId: id, batchNumber: n } });
    if (!batch) throw new NotFoundException(`Batch ${n} not found on this campaign.`);
    if (batch.status !== BS.PREVIEWED) {
      throw new ConflictException(
        batch.status === BS.CONFIRMED
          ? `Batch ${n} is already confirmed — its rows are on the campaign page.`
          : `Batch ${n} was discarded — upload the file again to add these people.`,
      );
    }
    const rows = await this.prisma.voucherDispersalRow.findMany({ where: { campaignId: id, batchNumber: n }, orderBy: { rowNumber: 'asc' } });
    const { floorPaise } = await this.budgetUsage(this.prisma, id);
    const view = this.batchPreviewView(
      camp,
      batch,
      rows.map((r) => ({
        rowNumber: r.rowNumber,
        phone: r.phone ?? r.rawPhone,
        name: r.name,
        amountPaise: r.amountPaise,
        amountRupees: r.amountPaise != null ? rupees(r.amountPaise) : null,
        brandLabel: r.brandLabel,
        brandKey: r.brandKey,
        note: r.note,
        status: r.status,
        invalidReason: r.invalidReason,
        warning: r.warning,
      })),
      floorPaise,
      // The skipped / hidden-row counts are kept on the batch (money-audit M5); null = not recorded.
      sheetNotes(batch.skippedBlankRows, batch.skippedFormulaRows, batch.hiddenRowsIncluded),
    );
    return { ...view, campaign: await this.campaignView(camp) };
  }

  /** Shared preview shape for a batch (upload reply + resume). The budget is checked against what is LEFT. */
  private batchPreviewView(
    camp: CampaignRow,
    batch: BatchRow,
    rows: {
      rowNumber: number;
      phone: string | null;
      name: string;
      amountPaise: bigint | null;
      amountRupees: number | null;
      brandLabel: string | null;
      brandKey: string | null;
      note: string | null;
      status: RS;
      invalidReason: string | null;
      warning: string | null;
    }[],
    floorPaise: bigint,
    notes: SheetNotes,
  ) {
    const base = this.previewSummary(rows, camp.budgetPaise);
    const totalPaise = rows.filter((r) => r.status === RS.VALID).reduce((a, r) => a + (r.amountPaise ?? 0n), 0n);
    const rawLeft = BigInt(camp.budgetPaise) - floorPaise;
    const remaining = rawLeft < 0n ? 0n : rawLeft;
    return {
      batchNumber: batch.batchNumber,
      batchStatus: batch.status,
      previewId: batch.status === BS.PREVIEWED ? batch.previewId : null,
      rows: rows.map((r) => ({
        rowNumber: r.rowNumber,
        phone: r.phone,
        name: r.name,
        amount: r.amountRupees,
        brand: r.brandLabel,
        brandKey: r.brandKey,
        note: r.note,
        status: r.status,
        invalidReason: r.invalidReason,
        warning: r.warning,
      })),
      summary: {
        ...base,
        overBudget: totalPaise > remaining || rawLeft < 0n,
        alreadyCommittedRupees: rupees(floorPaise),
        remainingBudgetRupees: rupees(remaining),
        /** > 0 when spending ALREADY exceeds the budget (nothing is left; shown as "over budget by ₹X"). */
        overBudgetRupees: rawLeft < 0n ? rupees(-rawLeft) : 0,
        crossBatchDuplicates: rows.filter((r) => r.status === RS.DUPLICATE && CROSS_BATCH_REASON.test(r.invalidReason ?? '')).length,
        warningCount: rows.filter((r) => r.warning).length,
        ...notes,
      },
    };
  }

  /**
   * POST /campaigns/:id/batches/:n/confirm — buy this batch's VALID rows. Under the campaign row lock (the lock
   * every buy claim takes): the campaign must be finished with nothing in flight; the preview id and the
   * numbers must match what the admin saw; floor (spent + with Hubble + failed-may-complete + queued) + this
   * batch ≤ budget (else refuse — raise the budget). The batch flips PREVIEWED→CONFIRMED with a conditional
   * update, its VALID rows → QUEUED, and the campaign → PROCESSING so the existing engine buys them and
   * re-settles the status across ALL batches. The audit row is written in the same transaction.
   * IDEMPOTENT per batch: a repeated / racing confirm quoting the confirmed preview id returns the campaign.
   */
  async confirmBatch(user: JwtPayload, id: string, n: number, dto: ConfirmDispersalCampaignDto) {
    this.assertAdmin(user);
    if (!this.hubble.isConfigured()) {
      throw new ServiceUnavailableException('Hubble is not configured in this environment — nothing can be bought.');
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const camp = await tx.voucherDispersalCampaign.update({ where: { id }, data: { updatedAt: new Date() } }).catch(() => null);
      if (!camp) throw new NotFoundException('Campaign not found.');
      const readBatch = () => tx.voucherDispersalBatch.findFirst({ where: { campaignId: id, batchNumber: n } });
      const confirmedHere = async () => {
        const b = await readBatch();
        return !!b && b.status === BS.CONFIRMED && !!b.previewId && b.previewId === dto.previewId;
      };
      const batch = await readBatch();
      if (!batch) throw new NotFoundException(n === 1 ? 'Batch 1 is the first file — it is confirmed from the campaign setup.' : `Batch ${n} not found on this campaign.`);
      if (batch.status === BS.CONFIRMED && batch.previewId === dto.previewId) return { repeat: true as const };
      if (batch.status === BS.DISCARDED) throw new ConflictException(`Batch ${n} was discarded — upload the file again to add these people.`);
      if (batch.status === BS.CONFIRMED) throw new ConflictException(`Batch ${n} is already confirmed.`);
      const why = addPeopleBlockedReason(camp.status, settleFailing(camp));
      if (why) {
        if (await confirmedHere()) return { repeat: true as const };
        throw new ConflictException(why);
      }
      const inFlight = await tx.voucherDispersalRow.count({ where: { campaignId: id, status: { in: IN_FLIGHT } } });
      if (inFlight > 0) {
        if (await confirmedHere()) return { repeat: true as const };
        throw new ConflictException(addPeopleBlockedReason(CS.PROCESSING)!);
      }
      if (!batch.previewId || batch.previewId !== dto.previewId) {
        throw new ConflictException('This preview is out of date (the file was re-uploaded, maybe in another tab). Review the current preview and confirm again.');
      }
      const valid = await tx.voucherDispersalRow.aggregate({
        where: { campaignId: id, batchNumber: n, status: RS.VALID },
        _count: { _all: true },
        _sum: { amountPaise: true },
      });
      const validCount = valid._count._all;
      const totalPaise = BigInt(valid._sum.amountPaise ?? 0n);
      if (validCount === 0) throw new BadRequestException('There are no valid rows in this batch to issue.');
      // A changed preview is reported before the budget (re-review L8).
      if (dto.expectedValidCount !== validCount || BigInt(dto.expectedTotalRupees) * 100n !== totalPaise) {
        throw new ConflictException(
          `The preview changed: it now has ${validCount} valid row(s) totalling ${inr(totalPaise)} (you confirmed ${dto.expectedValidCount} / ₹${Number(dto.expectedTotalRupees).toLocaleString('en-IN')}). Review the preview again.`,
        );
      }
      const { floorPaise } = await this.budgetUsage(tx, id);
      if (floorPaise + totalPaise > BigInt(camp.budgetPaise)) {
        throw new BadRequestException(
          `This batch's valid rows total ${inr(totalPaise)}; with ${inr(floorPaise)} already spent or committed that makes ${inr(floorPaise + totalPaise)}, over the ${inr(camp.budgetPaise)} budget. Raise the budget (Edit campaign) or remove rows, then confirm again.`,
        );
      }
      const now = new Date();
      const flip = await tx.voucherDispersalBatch.updateMany({
        where: { id: batch.id, status: BS.PREVIEWED, previewId: dto.previewId },
        data: { status: BS.CONFIRMED, confirmedById: user.sub, confirmedAt: now },
      });
      if (flip.count !== 1) {
        if (await confirmedHere()) return { repeat: true as const };
        throw new ConflictException('This batch changed while confirming — refresh and try again.');
      }
      const q = await tx.voucherDispersalRow.updateMany({
        where: { campaignId: id, batchNumber: n, status: RS.VALID, hubbleReferenceId: { not: null } },
        data: { status: RS.QUEUED },
      });
      if (q.count !== validCount) throw new ConflictException('The rows changed while confirming — refresh and try again.');
      const updated = await tx.voucherDispersalCampaign.update({ where: { id }, data: { status: CS.PROCESSING, completedAt: null } });
      await this.auditCampaignTx(tx, user, id, 'APPROVE', 'VOUCHER_DISPERSAL_BATCH_CONFIRMED', {
        batchNumber: n,
        previewId: dto.previewId,
        validCount,
        totalRupees: rupees(totalPaise),
        fromStatus: camp.status,
      });
      return { repeat: false as const, updated };
    }, CAMPAIGN_LOCK_TX);
    if (result.repeat) return this.campaignView(await this.getCampaignOr404(id));
    this.processor.kick(id);
    return this.campaignView(result.updated);
  }

  /** Discard an unconfirmed batch's rows (inside the caller's campaign-locked transaction). */
  private async discardPendingBatchTx(tx: Tx, campaignId: string, batch: BatchRow, userId: string, reason: string): Promise<number> {
    const live = await tx.voucherDispersalRow.count({
      where: { campaignId, batchNumber: batch.batchNumber, status: { notIn: PREVIEW_STATUSES } },
    });
    if (live > 0) throw new ConflictException(`Batch ${batch.batchNumber} already has rows in processing — refresh.`);
    const del = await tx.voucherDispersalRow.deleteMany({ where: { campaignId, batchNumber: batch.batchNumber, status: { in: PREVIEW_STATUSES } } });
    const flip = await tx.voucherDispersalBatch.updateMany({
      where: { id: batch.id, status: BS.PREVIEWED },
      data: { status: BS.DISCARDED, previewId: null, discardedById: userId, discardedAt: new Date(), discardReason: reason },
    });
    if (flip.count !== 1) throw new ConflictException(`Batch ${batch.batchNumber} changed meanwhile — refresh.`);
    return del.count;
  }

  /**
   * POST /campaigns/:id/batches/:n/discard — drop an unconfirmed batch: its rows are deleted (they never
   * reached Hubble and count in no total) and the batch stays listed as DISCARDED (who / when). A confirmed
   * batch cannot be discarded (Cancel campaign stops rows not yet bought). Audited in the same transaction.
   */
  async discardBatch(user: JwtPayload, id: string, n: number) {
    this.assertAdmin(user);
    const r = await this.prisma.$transaction(async (tx) => {
      const camp = await tx.voucherDispersalCampaign.update({ where: { id }, data: { updatedAt: new Date() } }).catch(() => null);
      if (!camp) throw new NotFoundException('Campaign not found.');
      const batch = await tx.voucherDispersalBatch.findFirst({ where: { campaignId: id, batchNumber: n } });
      if (!batch) {
        if (n === 1) throw new ConflictException('Batch 1 is the first file — it cannot be discarded (use Cancel campaign instead).');
        throw new NotFoundException(`Batch ${n} not found on this campaign.`);
      }
      if (batch.status === BS.DISCARDED) throw new ConflictException(`Batch ${n} was already discarded.`);
      if (batch.status === BS.CONFIRMED) {
        throw new ConflictException(
          `Batch ${n} is already confirmed — its vouchers are being or have been bought, so it cannot be discarded. Use Cancel campaign to stop rows not bought yet.`,
        );
      }
      const discardedRows = await this.discardPendingBatchTx(tx, id, batch, user.sub, 'Discarded by an admin before confirming');
      await this.auditCampaignTx(tx, user, id, 'UPDATE', 'VOUCHER_DISPERSAL_BATCH_DISCARDED', { batchNumber: n, discardedRows });
      return { camp, discardedRows };
    }, CAMPAIGN_LOCK_TX);
    return { campaign: await this.campaignView(r.camp), batchNumber: n, discardedRows: r.discardedRows };
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
          by: ['campaignId', 'batchNumber', 'status'],
          where: { campaignId: { in: ids } },
          _count: { _all: true },
          _sum: { amountPaise: true },
        })
      : [];
    const pending = await this.pendingBatchNumbers(ids);
    const names = await this.clientNames(camps.map((c) => c.billedToClientId));
    const items = camps.map((c) => {
      // An unconfirmed batch's rows count in no summary (they are only a preview until confirmed).
      const p = pending.get(c.id) ?? null;
      const mine = groups.filter((x) => x.campaignId === c.id && x.batchNumber !== p);
      const by = new Map<RS, { _count: { _all: number }; _sum: { amountPaise: bigint | null } }>();
      for (const x of mine) {
        const cur = by.get(x.status) ?? { _count: { _all: 0 }, _sum: { amountPaise: null } };
        cur._count._all += x._count._all;
        if (x._sum.amountPaise != null) cur._sum.amountPaise = BigInt(cur._sum.amountPaise ?? 0n) + BigInt(x._sum.amountPaise);
        by.set(x.status, cur);
      }
      const g = [...by.entries()].map(([status, v]) => ({ status, ...v }));
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
          pendingBatchNumber: p,
        },
      };
    });
    // Contract (UI): a plain array, newest first; `?page=` pages through CAMPAIGNS_PAGE_SIZE at a time.
    return items;
  }

  async detail(user: JwtPayload, id: string) {
    this.assertAdmin(user);
    const camp = await this.getCampaignOr404(id);
    const allRows = await this.prisma.voucherDispersalRow.findMany({
      where: { campaignId: id },
      select: {
        batchNumber: true,
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
    const batchRecords = await this.prisma.voucherDispersalBatch.findMany({ where: { campaignId: id }, orderBy: { batchNumber: 'asc' } });
    const pendingBatch = batchRecords.find((b) => b.status === BS.PREVIEWED)?.batchNumber ?? null;
    // Every total covers ALL confirmed batches; an unconfirmed batch is only a preview (shown in `batches`).
    const rows = allRows.filter((r) => r.batchNumber !== pendingBatch);
    const receipts = await this.receiptsFor(rows.map((r) => r.whatsappReceiptId));
    const base = this.previewSummary(rows, camp.budgetPaise);
    const usage = await this.budgetUsage(this.prisma, id);
    const over = overBudget(usage, BigInt(camp.budgetPaise));
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
        /** The lowest the budget may be edited down to (spent + committed + queued). */
        budgetFloorRupees: rupees(usage.floorPaise),
        /**
         * > 0 only when money already spent or with Hubble (spent + with Hubble + failed-may-complete — NOT queued)
         * exceeds the budget, e.g. a refused purchase Hubble completed later (re-review M1).
         */
        overBudgetRupees: rupees(over.overPaise),
        /** Queued vouchers that no longer fit in the budget (the buy step will refuse them). */
        queuedAtRiskRupees: rupees(over.queuedAtRiskPaise),
        /** Rows (distinct) that had FAILED and that Hubble later reported bought / processing (audited loudly). */
        lateCompletedRows: await this.prisma.voucherDispersalRow.count({ where: { campaignId: id, lateCompletedAt: { not: null } } }),
        /** The SAME breakdown the floor, batch confirm and retry checks use (money-audit M1). */
        budgetUsage: {
          spentRupees: rupees(usage.spentPaise),
          withHubbleRupees: rupees(usage.withHubblePaise),
          failedMayCompleteRupees: rupees(usage.failedMayCompletePaise),
          queuedRupees: rupees(usage.queuedPaise),
          floorRupees: rupees(usage.floorPaise),
        },
        messageSent,
        delivered,
        read,
        messageFailed,
        messageNotSent,
      },
      batches: await this.batchViews(camp, batchRecords, allRows),
      edits: await this.editHistory(id),
    };
  }

  /** Unconfirmed (PREVIEWED) batch number per campaign — at most one each. */
  private async pendingBatchNumbers(campaignIds: string[]): Promise<Map<string, number>> {
    if (campaignIds.length === 0) return new Map();
    const list = await this.prisma.voucherDispersalBatch.findMany({
      where: { campaignId: { in: campaignIds }, status: BS.PREVIEWED },
      select: { campaignId: true, batchNumber: true },
    });
    return new Map(list.map((b) => [b.campaignId, b.batchNumber]));
  }

  /**
   * Batch list for the detail page. Batch 1 = the campaign's own first file (no batch record: its file /
   * uploader / confirm fields are the campaign's). Counts come from the rows of each batch.
   */
  private async batchViews(camp: CampaignRow, records: BatchRow[], rows: { batchNumber: number; status: RS; amountPaise: bigint | null }[]) {
    type Entry = {
      batchNumber: number;
      status: 'PREVIEWED' | 'CONFIRMED' | 'DISCARDED' | 'CANCELLED';
      sourceFileName: string | null;
      uploadedById: string | null;
      uploadedAt: Date | null;
      confirmedById: string | null;
      confirmedAt: Date | null;
      discardedById: string | null;
      discardedAt: Date | null;
      discardReason: string | null;
      previewId: string | null;
    };
    const entries: Entry[] = [];
    if (camp.uploadedAt || rows.some((r) => r.batchNumber === 1)) {
      entries.push({
        batchNumber: 1,
        status: camp.confirmedAt ? 'CONFIRMED' : camp.status === CS.CANCELLED ? 'CANCELLED' : 'PREVIEWED',
        sourceFileName: camp.sourceFileName,
        uploadedById: camp.uploadedById,
        uploadedAt: camp.uploadedAt,
        confirmedById: camp.confirmedById,
        confirmedAt: camp.confirmedAt,
        discardedById: null,
        discardedAt: null,
        discardReason: null,
        previewId: null,
      });
    }
    for (const b of records) {
      entries.push({
        batchNumber: b.batchNumber,
        status: b.status,
        sourceFileName: b.sourceFileName,
        uploadedById: b.uploadedById,
        uploadedAt: b.uploadedAt,
        confirmedById: b.confirmedById,
        confirmedAt: b.confirmedAt,
        discardedById: b.discardedById,
        discardedAt: b.discardedAt,
        discardReason: b.discardReason,
        previewId: b.status === BS.PREVIEWED ? b.previewId : null,
      });
    }
    const names = await this.userNames(entries.flatMap((e) => [e.uploadedById, e.confirmedById, e.discardedById]));
    return entries.map((e) => {
      const mine = rows.filter((r) => r.batchNumber === e.batchNumber);
      const n = (ss: RS[]) => mine.filter((r) => ss.includes(r.status)).length;
      const sum = (ss: RS[]) => mine.filter((r) => ss.includes(r.status)).reduce((a, r) => a + (r.amountPaise ?? 0n), 0n);
      const validStatuses = mine.map((r) => r.status).filter((st) => !NOT_VALID.includes(st));
      return {
        ...e,
        uploadedByName: e.uploadedById ? names.get(e.uploadedById) ?? null : null,
        confirmedByName: e.confirmedById ? names.get(e.confirmedById) ?? null : null,
        discardedByName: e.discardedById ? names.get(e.discardedById) ?? null : null,
        total: mine.length,
        valid: validStatuses.length,
        invalid: n([RS.INVALID]),
        duplicates: n([RS.DUPLICATE]),
        bought: n([RS.BOUGHT]),
        buyFailed: n([RS.BUY_FAILED]),
        pending: n(IN_FLIGHT),
        cancelled: n([RS.CANCELLED]),
        totalRupees: rupees(mine.filter((r) => !NOT_VALID.includes(r.status)).reduce((a, r) => a + (r.amountPaise ?? 0n), 0n)),
        spentRupees: rupees(sum([RS.BOUGHT])),
      };
    });
  }

  async rows(user: JwtPayload, id: string, q: ListDispersalRowsQueryDto) {
    this.assertAdmin(user);
    const camp = await this.getCampaignOr404(id);
    const page = q.page ?? 1;
    // An unconfirmed batch's rows are listed only when asked for by number (its preview).
    const pending = q.batch ? null : (await this.pendingBatchNumbers([id])).get(id) ?? null;
    const where: Prisma.VoucherDispersalRowWhereInput = {
      campaignId: id,
      ...(q.status ? { status: q.status as RS } : {}),
      ...(q.batch ? { batchNumber: q.batch } : pending !== null ? { batchNumber: { not: pending } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.voucherDispersalRow.count({ where }),
      this.prisma.voucherDispersalRow.findMany({
        where,
        orderBy: [{ batchNumber: 'asc' }, { rowNumber: 'asc' }],
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
      batchNumber: r.batchNumber,
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
    const batchRecords = await this.prisma.voucherDispersalBatch.findMany({ where: { campaignId: id } });
    const pending = batchRecords.find((b) => b.status === BS.PREVIEWED)?.batchNumber ?? null;
    const fileOf = new Map<number, string | null>([[1, camp.sourceFileName], ...batchRecords.map((b) => [b.batchNumber, b.sourceFileName] as [number, string | null])]);
    // Every CONFIRMED batch; an unconfirmed batch is not part of the report until it is confirmed.
    const rows = await this.prisma.voucherDispersalRow.findMany({
      where: { campaignId: id, ...(pending !== null ? { batchNumber: { not: pending } } : {}) },
      orderBy: [{ batchNumber: 'asc' }, { rowNumber: 'asc' }],
    });
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
        batchNumber: r.batchNumber,
        sourceFile: fileOf.get(r.batchNumber) ?? null,
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
          await this.processor.resettle(id);
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
      // Money-audit M2: never take budget promised to queued rows (e.g. a confirmed "Add more people" batch).
      { rowId: row.id, amountPaise: BigInt(row.amountPaise ?? 0n) },
    );
    if (typeof r === 'object') {
      await audit('REFUSED_BUDGET', { needRupees: rupees(r.needPaise), leftRupees: rupees(r.leftPaise) });
      throw new ConflictException(
        `Retrying needs ${inr(r.needPaise)}; only ${inr(r.leftPaise)} is left after queued rows and purchases already made or with Hubble — raise the budget (Edit campaign), then retry.`,
      );
    }
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
   * While processing: QUEUED rows not yet sent to Hubble are cancelled — across EVERY batch; rows already
   * with Hubble (BUYING / PENDING_RECONCILE) keep being reconciled and BOUGHT rows (any batch) are untouched
   * (and still messaged). An unconfirmed batch is discarded. A finished campaign is not cancellable (nothing
   * left to stop; an unconfirmed batch on it is discarded with Discard).
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
        return { c, from, cancelledRows: r.count, inFlight: 0, bought: 0, discardedPendingBatchRows: 0 };
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
        // An unconfirmed "Add more people" batch (possible when a retry re-opened a finished campaign) is
        // discarded with the campaign — nothing of it was ever sent to Hubble.
        const pendingBatch = await tx.voucherDispersalBatch.findFirst({ where: { campaignId: id, status: BS.PREVIEWED } });
        const discardedPendingBatchRows = pendingBatch
          ? await this.discardPendingBatchTx(tx, id, pendingBatch, user.sub, 'Campaign cancelled before this batch was confirmed')
          : 0;
        const c = await tx.voucherDispersalCampaign.update({
          where: { id },
          data: { status: CS.CANCELLED, cancelledAt: new Date(), cancelledById: user.sub },
        });
        return { c, from, cancelledRows: r.count, inFlight, bought, discardedPendingBatchRows };
      }
      throw new ConflictException(`A ${from} campaign cannot be cancelled.`);
    }, CAMPAIGN_LOCK_TX);
    await this.auditCampaign(user, id, 'UPDATE', 'VOUCHER_DISPERSAL_CANCELLED', {
      fromStatus: result.from,
      cancelledRows: result.cancelledRows,
      stillWithHubble: result.inFlight,
      alreadyBought: result.bought,
      discardedPendingBatchRows: result.discardedPendingBatchRows,
    });
    return {
      campaign: await this.campaignView(result.c),
      cancelledRows: result.cancelledRows,
      stillWithHubble: result.inFlight,
      alreadyBought: result.bought,
      discardedPendingBatchRows: result.discardedPendingBatchRows,
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
      canEdit: c.status !== CS.CANCELLED,
      /** null = "Add more people" is available; otherwise the plain reason it is not (re-checked server-side). */
      addPeopleBlockedReason: addPeopleBlockedReason(c.status, settleFailing(c)),
      /** Set once the status settle has failed SETTLE_FAILURES_BEFORE_ALERT times in a row (null otherwise). */
      settleError: settleFailing(c) ? c.settleError ?? 'Unknown error' : null,
    };
  }

  private async userNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (list.length === 0) return new Map();
    const rows = await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } });
    return new Map(rows.map((u) => [u.id, u.name]));
  }

  /** Campaign audit row written INSIDE the caller's transaction (a failure aborts it — no change without history). */
  private async auditCampaignTx(
    tx: Tx,
    user: JwtPayload,
    id: string,
    action: 'CREATE' | 'UPDATE' | 'IMPORT' | 'APPROVE' | 'EXPORT',
    event: string,
    metadata: Record<string, unknown>,
    values: { oldValues?: Record<string, unknown>; newValues?: Record<string, unknown> } = {},
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: user.sub,
        action,
        entityType: 'VOUCHER_DISPERSAL_CAMPAIGN',
        entityId: id,
        metadata: { event, ...metadata } as Prisma.InputJsonValue,
        ...(values.oldValues ? { oldValues: values.oldValues as Prisma.InputJsonValue } : {}),
        ...(values.newValues ? { newValues: values.newValues as Prisma.InputJsonValue } : {}),
      },
    });
  }

  private async auditCampaign(
    user: JwtPayload,
    id: string,
    action: 'CREATE' | 'UPDATE' | 'IMPORT' | 'APPROVE' | 'EXPORT',
    event: string,
    metadata: Record<string, unknown>,
    values: { oldValues?: Record<string, unknown>; newValues?: Record<string, unknown> } = {},
  ): Promise<void> {
    await this.prisma.auditLog
      .create({
        data: {
          actorId: user.sub,
          action,
          entityType: 'VOUCHER_DISPERSAL_CAMPAIGN',
          entityId: id,
          metadata: { event, ...metadata } as Prisma.InputJsonValue,
          ...(values.oldValues ? { oldValues: values.oldValues as Prisma.InputJsonValue } : {}),
          ...(values.newValues ? { newValues: values.newValues as Prisma.InputJsonValue } : {}),
        },
      })
      .catch((e: unknown) => this.logger.error(`[dispersal] audit ${event} failed for campaign ${id}: ${e}`));
  }
}
