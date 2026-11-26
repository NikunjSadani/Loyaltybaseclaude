import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { prepareHeldBeforeCredit } from '../wallet/held-opening-balances/held-balance-apply';
import { CreditEntryStatus, Prisma, TdsMethodology, TdsSection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { fullRowsEcho, problemRowsEcho } from '../common/upload-echo';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { UPLOAD_DEDUCTION_UNDO_KIND, WalletService } from '../wallet/wallet.service';
import { UPLOAD_ACK_CATEGORIES, UPLOAD_ACK_LABELS, UploadAckCategory, uploadAckScope } from './upload-ack-scope';
export { UPLOAD_ACK_CATEGORIES, UPLOAD_ACK_LABELS, type UploadAckCategory } from './upload-ack-scope';
import {
  assertPointsReversalsNotPaused,
  BACKFILL_NEXT_STEP,
  deductionWalletNotReadyMessage,
  RAISED_UNDER_OLD_ENGINE_MESSAGE,
  ReversalAttentionException,
} from '../wallet/reversal-policy';

/** Audit entityType marking a POINTS reversal created under the one engine (audit A1) — entityId = the reversal id. */
export const POINTS_REVERSAL_ENGINE_MARKER_ENTITY = 'POINTS_REVERSAL_ENGINE_MARKER';
/** One item the admin must have ticked (key = what the tick binds to; text = what the screen shows). */
export interface AckItem {
  key: string;
  text: string;
}

/** The confirm body: the ticked categories and, per category, the exact item keys ticked (U1 round 3). */
export interface UploadAck {
  acknowledged?: string[];
  ackItems?: Partial<Record<string, string[]>>;
  skippedRows?: number;
}

/** Audit row of an operator batch confirm: acknowledgements + what was not applied (owner rule 2026-11-25). */
export const CREDIT_BATCH_CONFIRM_ENTITY = 'CREDIT_BATCH_CONFIRM';
/** Marker metadata.kind of a POINTS reversal that UNDOES an upload deduction (UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md §6). */
export const DEDUCTION_UNDO_MARKER_KIND = 'UPLOAD_DEDUCTION_UNDO';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { InvoicesService } from '../invoices/invoices.service';
import {
  deriveFrozenSection,
  computeDeduction,
  computeGrossUpTdsInvoiceBasePaise,
  allocateProRataRecovery,
} from '../tds/tds-methodology.helper';
import { financialYear, grossUpTdsPaise, rate194CFrom, rate194RFrom, TdsRate, type ResolvedTdsStatutory } from '../tds/tds.helpers';
import {
  collect194RBases,
  emptyBases194R,
  deducted194RByRetailer,
  openCredits194RByRetailer,
  retailerKeyOfLedgerPan,
  isNoPanKey,
  importedPayoutsCountFromOrThrow,
  liability194R,
  isNoPanCell,
  noPanOutletKey,
  noPanPartnerKey,
  PAN_NORMALISE_SQL,
  payeeKeyFor,
} from '../tds/tds-194r.shared';

/** B-H1: a header-safe list — the first 20 items, then "+K more" (full lists stay in the JSON result). */
function boundedList(items: string[], max = 20): string {
  return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} +${items.length - max} more`;
}

// The (client, FY) 194R advisory-lock key — shared with the reversal engine's TDS-credit code.
import { r194LockKey } from './r194-lock';
import {
  deductionUndoOutcome,
  pointsOutcome,
  PointsReversalSplit,
  rejectedPointsOutcome,
  storedPointsSplit,
} from './points-reversal-outcome';
import { assertNoPaid194C, isPaid194C, visibilityFieldIdsOf } from './reversal-194c';

/**
 * A-M3: take every advisory lock in ONE round-trip — a single SELECT over the (already sorted) key
 * array, so the locks are acquired in that order (deadlock-safe) without one query per key.
 */
async function lockAdvisoryKeys(tx: Prisma.TransactionClient, sortedKeys: string[]): Promise<void> {
  if (sortedKeys.length === 0) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(k, 0)) FROM unnest(${sortedKeys}::text[]) WITH ORDINALITY AS t(k, n) ORDER BY n`;
}

/** 194R retailer key of a payout: its owner's PAN, else the no-PAN owner key (per partner / outlet). */
function r194RetailerKey(
  clientId: string,
  outletCode: string,
  info: { partnerId?: string | null; panNumber?: string | null } | undefined,
): { key: string; hasPan: boolean } {
  // L3/A-M2: the ONE payee-key rule (shared with the report and every snapshot writer).
  if (!isNoPanCell(info?.panNumber)) return { key: payeeKeyFor(clientId, outletCode, { id: info?.partnerId ?? '', panNumber: info!.panNumber! }), hasPan: true };
  return { key: info?.partnerId ? noPanPartnerKey(info.partnerId) : noPanOutletKey(clientId, outletCode), hasPan: false };
}
import { TdsStatutoryConfigService } from '../tds/tds-statutory.config.service';
import {
  deductWithCredits,
  istDate,
  loadOpenTdsCredits,
  maskPan,
  tdsAdjustmentNote,
  releaseCreditApplications,
  writeCreditApplications,
  type CreditDraw,
  type DeductWithCreditsResult,
  type OpenTdsCredit,
  type PanCreditPosition,
  type ReleasedApplication,
} from './tds-credit';
import { ensureOutletAccount } from '../common/reward-account.helper';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { formatINR, paiseToRupees, toPaiseBigInt } from '../common/money';
import { monthYearIST, formatDateIST, IST_OFFSET_MIN, istDateKey, istMonthBounds } from '../common/ist-date';
import { loadOutletTypeDisplayNames, labelFor } from '../common/outlet-type-display';
import {
  resolveEffectiveKycStatus,
  isPartnerPayable,
} from '../kyc/kyc-eligibility';
import {
  CreateBatchDto,
  CreateFieldDto,
  CreatePayoutDownloadDto,
  CreateReversalDto,
  FieldAction,
  FieldAwardValue,
  ListBatchesQueryDto,
  ListFieldsQueryDto,
  ListPayoutDownloadsQueryDto,
  ListReversalsQueryDto,
  PatchFieldDto,
  PatchReversalDto,
  PayoutGroupType,
  ReversalAction,
} from './dto/credits.dto';
import {
  generatePayoutFileBuffer,
  parseUtrUpload,
  groupUtrBatchRows,
  UTR_NOTICE_ALREADY_PAID,
  UTR_NOTICE_ALREADY_FAILED,
  FormerOutletFate,
  PayoutBatch,
  PayoutBatchRow,
} from './credits.helpers';
import {
  heldForReversal,
  reversalHeldSuffix,
  ReversalHeldEntry,
  loadPayoutReversalCandidates,
  patchPayoutReversalV2,
  reservedAmong,
  reservePayoutEntries,
  selectPayoutEntriesV2,
  approvedHeadline,
  type PayoutOutcome,
} from './payout-reversal-v2';

/**
 * Awards & Credits (§12a) — ported from platform/src/app/api/admin/credits/*
 * onto /v1/admin/credits. This is the REAL parameter-upload credit model:
 * CreditBatch (uploaded rows) → confirm → CreditPayoutEntry → payout download
 * (bank file) → UTR upload (mark paid) → reversals (maker-checker).
 *
 * Every query is tenant-scoped by `clientId` (from the session-bound JWT). The
 * source role gates (CLIENT_ADMIN + GIFSY_ADMIN, or GIFSY_ADMIN-only) are
 * enforced by @Roles on the controller and the RBAC permission keys by
 * @RequirePermission. The pure parser/generator logic lives in
 * credits.helpers.ts; notifications go through the foundation NotificationsService
 * (the source's MSG91 WhatsApp/email helpers become QUEUED notification rows).
 */
/** Frozen retailer tax/bank details needed to build a TDS invoice + resolve PAN. */
interface PartnerTaxInfo {
  partnerId: string;
  panNumber: string | null;
  entityType: string | null;
  gstNumber: string | null;
  gstRegistrationType: string | null;
  businessName: string | null;
  ownerName: string | null;
  phone: string | null;
  bankName: string | null;
  accountNumber: string | null;
  ifscCode: string | null;
  outletName: string;
  retailerState: string | null;
}

/** Policy round B: one payout entry whose TDS an earlier TDS credit (partly) covered in a bank download. */
export interface TdsCreditAppliedLine {
  entryId: string;
  outletId: string;
  outletName: string;
  /** Integer paise. TDS due on the entry = creditPaise + handBackPaise + withheldPaise. */
  duePaise: number;
  creditPaise: number;
  /** Of creditPaise: credit raised by another programme (194C — owner D4). */
  otherProgrammePaise: number;
  withheldPaise: number;
  panMasked: string;
  note: string;
}

/** Fix round B (owner D3): one payout entry whose TDS the ledger lowered after a reversal took the PAN's base down. */
export interface TdsAdjustmentLine {
  entryId: string;
  outletId: string;
  outletName: string;
  panMasked: string;
  /** Integer paise: "₹X less TDS: adjusted after a reversal brought PAN below the limit". */
  handBackPaise: number;
  note: string;
}

/** Fix round B (screens #1): what a bank file left out / adjusted — read as JSON after the download (no headers). */
export interface PayoutDownloadSummary {
  downloadId: string;
  downloadCode: string;
  period: string;
  createdAt: string;
  reversalHeld: { count: number; paise: number; entries: ReversalHeldEntry[] };
  tdsCreditApplied: { count: number; paise: number; lines: TdsCreditAppliedLine[] };
  tdsAdjustments: { count: number; paise: number; lines: TdsAdjustmentLine[] };
}

/** Paise-number view of a plan's per-entry TDS adjustment → the two call-out lists (credit / hand-back). */
function tdsAdjustmentLines(
  creditByEntry: Map<string, { duePaise: bigint; creditPaise: bigint; otherProgrammePaise: bigint; handBackPaise: bigint; panNumber: string }>,
  entryById: Map<string, { outletId: string; outletName: string }>,
): { credit: TdsCreditAppliedLine[]; adjustments: TdsAdjustmentLine[] } {
  const credit: TdsCreditAppliedLine[] = [];
  const adjustments: TdsAdjustmentLine[] = [];
  for (const [entryId, c] of creditByEntry) {
    const e = entryById.get(entryId);
    const note = tdsAdjustmentNote(c);
    const base = { entryId, outletId: e?.outletId ?? '', outletName: e?.outletName ?? '', panMasked: maskPan(c.panNumber), note };
    if (c.creditPaise > 0n) {
      credit.push({
        ...base,
        duePaise: Number(c.duePaise),
        creditPaise: Number(c.creditPaise),
        otherProgrammePaise: Number(c.otherProgrammePaise),
        withheldPaise: Number(c.duePaise - c.creditPaise - c.handBackPaise),
      });
    }
    if (c.handBackPaise > 0n) adjustments.push({ ...base, handBackPaise: Number(c.handBackPaise) });
  }
  return { credit, adjustments };
}

/** Typed reversal remarks: trimmed, blank → null (owner D5 — saved on create / approve / reject, every tenant). */
function cleanRemarks(r: string | null | undefined): string | null {
  const t = (r ?? '').trim();
  return t ? t : null;
}

/** BigInt-safe JSON for audit metadata. */
function auditJson(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))) as Prisma.InputJsonValue;
}

/** The DEDUCT/GROSS-UP write plan computed (reads-only) before the download $transaction. */
interface PayoutTdsPlan {
  /** outletCode → paise to subtract from that outlet's bank-file line (DEDUCT only). */
  deductionByOutlet: Map<string, bigint>;
  /** Per-entry withheld paise to stamp on CreditPayoutEntry.tdsDeductedPaise (DEDUCT). */
  entryDeductions: Array<{ entryId: string; tdsDeductedPaise: bigint }>;
  /**
   * Append-only DEDUCT carry-forward ledger rows. FIX-C: emitted PER-ENTRY (one row per withheld
   * CreditPayoutEntry) carrying `creditPayoutEntryId`, so a later FAILED-payout reversal resolves
   * the ORIGINALLY-deducted PAN by that id (survives a mid-flight re-KYC PAN change). The
   * cumulative/due/prior fields reflect the (PAN,section) GROUP context (identical across a group's
   * rows); carryForward is placed on the group's LAST row so Σ carryForward == the group residual.
   */
  deductionLedger: Array<{
    clientId: string;
    panNumber: string;
    section: TdsSection;
    fyLabel: string;
    creditPayoutEntryId: string;
    outletCode: string;
    eventBasePaise: bigint;
    cumulativeBasePaise: bigint;
    tdsRate: number;
    tdsDueCumulativePaise: bigint;
    tdsDeductedPriorPaise: bigint;
    tdsDeductedThisPaise: bigint;
    carryForwardPaise: bigint;
  }>;
  /**
   * Policy round B (WALLET-REVERSAL-ENGINE-DESIGN.md §8.1): TDS credits (from reversed PAID payouts) of THIS tenant
   * used against this download's DEDUCT withholding — one draw per (credit, entry); written with the download.
   * Empty for every tenant without credits (the plan is then identical to before).
   */
  creditDraws: CreditDraw[];
  /**
   * entryId → { TDS due on it, credit used for it (of which from another programme — 194C), D3 hand-back } for every
   * entry a credit or a reversal hand-back reduced (download notice / summary + audit).
   */
  creditByEntry: Map<
    string,
    { duePaise: bigint; creditPaise: bigint; otherProgrammePaise: bigint; handBackPaise: bigint; panNumber: string }
  >;
  /**
   * GROSS-UP monthly-incremental TDS TOP-UP invoices (FIX-1) + their DELTA pro-rata recovery.
   * `bodyPaise` is the DELTA (dueNow − alreadyInvoiced), NOT the cumulative — so Σ bodies over
   * a full FY == grossUp(full-FY base). `seq`/`isAnchor` disambiguate the monthly top-ups.
   */
  grossUpInvoices: Array<{
    panNumber: string;
    section: TdsSection;
    fyLabel: string;
    period: string;
    seq: number;
    isAnchor: boolean;
    bodyPaise: bigint;
    panBasePaise: bigint;
    representative: PartnerTaxInfo & { outletCode: string };
    recovery: Array<{ clientId: string; tenantBasePaise: bigint; tenantSharePaise: bigint }>;
  }>;
  /**
   * FIX-9: no-PAN visibility payouts stay paid-in-full (no deduction) but accrue a TENANT
   * recovery obligation once the outlet's cumulative no-PAN base crosses the 194C thresholds.
   * Applied PER (clientId, outletCode) since cross-tenant PAN aggregation is impossible with no
   * PAN. Written to tds_recovery_entries with panNumber='__NO_PAN__' (no AutoInvoice raised).
   */
  noPanRecovery: Array<{
    clientId: string;
    outletCode: string;
    section: TdsSection;
    fyLabel: string;
    eventBasePaise: bigint;
    cumulativeBasePaise: bigint;
    tenantSharePaise: bigint;
  }>;
}

@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly msg91: Msg91Service,
    private readonly walletService: WalletService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly invoicesService: InvoicesService,
    private readonly statutory: TdsStatutoryConfigService,
  ) {}

  // ─── Visibility-payout TDS constants + helpers (Stream B) ──────────────────
  // Statutory thresholds in integer paise. These MIRROR the private constants in
  // tds.service.ts (Stream A owns that file; a single-source consolidation into
  // tds.helpers is a follow-up) — keep them in lock-step.
  // Statutory rates + thresholds now come from the single platform-level source of truth
  // (TdsStatutoryConfigService.getForFy), resolved per the payout's financial year — see the
  // resolved `cfg` threaded through buildPayoutTdsPlan. No local copies (they used to be
  // hand-kept "in lock-step" with tds.service; that duplication is removed).
  /** Sentinel PAN PREFIX for the no-PAN recovery ledger (mirrors tds.service NO_PAN_KEY). */
  private static readonly NO_PAN_KEY = '__NO_PAN__';

  /**
   * FIX-B: the no-PAN recovery ledger key ENCODES the outletCode (`__NO_PAN__:<outletCode>`).
   * TdsRecoveryEntry has no outletCode column, so encoding it into panNumber lets the no-PAN
   * recovery TELESCOPE per (clientId, outlet, FY) off the ledger — a FAILED→re-bank of the same
   * base then yields a zero delta (self-correcting, no double-count). tds.service collapses this
   * back to NO_PAN_KEY for the platform-wide 194C recovery bucket; the reports flag it via
   * startsWith(NO_PAN_KEY).
   */
  private static noPanRecoveryKey(outletCode: string): string {
    return `${CreditsService.NO_PAN_KEY}:${outletCode}`;
  }

  /** Financial-year window for a "YYYY-MM" period (IST FY: Apr→Mar). fyLabel matches
   *  tds.helpers' "YYYY-YY" format so it reconciles with the reporting engine. */
  private fyForPeriod(period: string): { fyLabel: string; startPeriod: string; endPeriod: string } {
    const [y, m] = period.split('-').map((s) => parseInt(s, 10));
    const startYear = m >= 4 ? y : y - 1;
    const endYear = startYear + 1;
    return {
      fyLabel: `${startYear}-${String(endYear % 100).padStart(2, '0')}`,
      startPeriod: `${startYear}-04`,
      endPeriod: `${endYear}-03`,
    };
  }

  /** 194C: FY-aggregate OR single-payment threshold; 194R: FY-aggregate only. Thresholds from
   *  the FY-resolved statutory config (single source of truth). */
  private tdsThresholdMet(
    section: TdsSection,
    cumulativeBasePaise: bigint,
    maxSinglePaise: bigint,
    cfg: ResolvedTdsStatutory,
  ): boolean {
    if (section === TdsSection.SEC_194C) {
      return (
        cumulativeBasePaise > cfg.thr194cFyPaise ||
        maxSinglePaise > cfg.thr194cSinglePaise
      );
    }
    return cumulativeBasePaise > cfg.thr194rFyPaise;
  }

  /** The {num,den} rate fraction for a frozen section (194C entity-aware; 194R PAN-aware),
   *  from the FY-resolved statutory config. */
  private tdsRateFor(
    section: TdsSection,
    hasPan: boolean,
    entityType: string | null,
    cfg: ResolvedTdsStatutory,
  ): TdsRate {
    return section === TdsSection.SEC_194C
      ? rate194CFrom(cfg, hasPan, entityType)
      : rate194RFrom(cfg, hasPan);
  }

  /**
   * A-L: take the 194R retailer lock(s) for withheld 194R entries, resolved from their ORIGINAL ledger
   * rows (retailer key + the FY the withholding was booked in) — the same keys the engine takes.
   */
  private async lock194RForEntries(
    tx: Prisma.TransactionClient,
    clientId: string,
    entryIds: string[],
    /** A-M2: extra FYs whose 194R base this write changes (e.g. the bank-file FY of a FAILED 194R entry). */
    extra194RFys: string[] = [],
    /** Audit B6: entries whose LIVE TDS-credit applications this write may release — their credits' keys too. */
    creditEntryIds: string[] = [],
  ): Promise<void> {
    const keys = new Set(await this.tdsLockKeysForEntries(tx, clientId, entryIds, extra194RFys));
    if (creditEntryIds.length > 0) {
      const apps = await tx.tdsCreditApplication.findMany({
        where: { payoutEntryId: { in: creditEntryIds }, releasedAt: null },
        select: { tdsCredit: { select: { section: true, panNumber: true, fyLabel: true } } },
      });
      for (const a of apps ?? []) {
        const c = a.tdsCredit;
        if (!c?.fyLabel) continue;
        if (c.section === TdsSection.SEC_194C) {
          if (c.panNumber?.trim()) keys.add(`PAN|${c.panNumber.trim().toUpperCase()}|${c.fyLabel}`);
        } else {
          keys.add(r194LockKey(clientId, c.fyLabel));
        }
      }
    }
    if (keys.size) await lockAdvisoryKeys(tx, [...keys].sort());
  }

  /** The keys lock194RForEntries takes (sorted) — also merged into a V2 reversal approval's single lock statement. */
  private async tdsLockKeysForEntries(
    tx: Prisma.TransactionClient,
    clientId: string,
    entryIds: string[],
    extra194RFys: string[] = [],
  ): Promise<string[]> {
    const rows = entryIds.length
      ? await tx.tdsDeductionEntry.findMany({
          where: { creditPayoutEntryId: { in: entryIds } },
          select: { panNumber: true, fyLabel: true, section: true },
        })
      : [];
    const keys = new Set<string>(extra194RFys.map((fy) => r194LockKey(clientId, fy)));
    for (const r of rows ?? []) {
      if (!r.fyLabel) continue;
      // A-L4: a 194C withholding is reversed under ITS per-PAN key (the one its download took).
      if (r.section === TdsSection.SEC_194C) {
        if (r.panNumber?.trim()) keys.add(`PAN|${r.panNumber.trim().toUpperCase()}|${r.fyLabel}`);
      } else {
        keys.add(r194LockKey(clientId, r.fyLabel));
      }
    }
    return [...keys].sort();
  }

  /** WRE: keep a deductWithCredits result's credit draws + per-entry explanation (download notice / audit). */
  private recordCreditExplanation(plan: PayoutTdsPlan, d: DeductWithCreditsResult, panNumber: string): void {
    plan.creditDraws.push(...d.draws);
    for (const x of d.perEntry) {
      if (x.creditPaise > 0n || x.handBackPaise > 0n) {
        plan.creditByEntry.set(x.entryId, {
          duePaise: x.withheldPaise + x.creditPaise + x.handBackPaise,
          creditPaise: x.creditPaise,
          otherProgrammePaise: x.otherProgrammePaise,
          handBackPaise: x.handBackPaise,
          panNumber,
        });
      }
    }
  }

  /**
   * Split ONE (PAN, section) group's withholding exactly across its entries and append the per-entry
   * DEDUCT ledger rows (FIX-C). Shared by the 194C DEDUCT branch and the 194R whole-year block.
   */
  private pushDeduction(
    plan: PayoutTdsPlan,
    a: {
      clientId: string;
      panNumber: string;
      section: TdsSection;
      fyLabel: string;
      entries: Array<{ id: string; outletId: string; amountPaise: bigint }>;
      eventBasePaise: bigint;
      cumulativeBasePaise: bigint;
      rateNum: number;
      tdsDueCumulativePaise: bigint;
      priorDeductedPaise: bigint;
      tdsDeductThisPaise: bigint;
      carryForwardPaise: bigint;
      /**
       * WRE: the per-entry withholding already split by deductWithCredits (credit / hand-back follow each entry's own
       * TDS due); Σ == tdsDeductThisPaise. Absent → the exact pro-rata split below (unchanged path).
       */
      shareByEntry?: Map<string, bigint>;
    },
  ): void {
    // Exact-summing split of the withheld amount across this event's entries.
    const split =
      !a.shareByEntry && a.tdsDeductThisPaise > 0n
        ? allocateProRataRecovery({
            panTdsTotalPaise: a.tdsDeductThisPaise,
            tenants: a.entries.map((e) => ({ clientId: e.id, basePaise: e.amountPaise })),
          })
        : [];
    const shareByEntry =
      a.shareByEntry ?? new Map<string, bigint>(split.map((s): [string, bigint] => [s.clientId, s.tenantSharePaise]));
    for (const e of a.entries) {
      const share = shareByEntry.get(e.id) ?? 0n;
      if (share <= 0n) continue;
      plan.entryDeductions.push({ entryId: e.id, tdsDeductedPaise: share });
      plan.deductionByOutlet.set(e.outletId, (plan.deductionByOutlet.get(e.outletId) ?? 0n) + share);
    }
    const base = {
      clientId: a.clientId,
      panNumber: a.panNumber,
      section: a.section,
      fyLabel: a.fyLabel,
      cumulativeBasePaise: a.cumulativeBasePaise,
      tdsRate: a.rateNum,
      tdsDueCumulativePaise: a.tdsDueCumulativePaise,
      tdsDeductedPriorPaise: a.priorDeductedPaise,
    };
    // FIX-C: PER-ENTRY DEDUCT ledger rows (creditPayoutEntryId + the entry's own outletCode).
    const withheldEntries = a.entries.filter((e) => (shareByEntry.get(e.id) ?? 0n) > 0n);
    if (withheldEntries.length === 0) {
      if (a.tdsDueCumulativePaise > 0n || a.carryForwardPaise > 0n) {
        // Threshold met but nothing fit in this event's payouts (all carried forward): record a
        // representative row so the cumulative + carry-forward state persists across events.
        plan.deductionLedger.push({
          ...base,
          creditPayoutEntryId: a.entries[0].id,
          outletCode: a.entries[0].outletId,
          eventBasePaise: a.eventBasePaise,
          tdsDeductedThisPaise: 0n,
          carryForwardPaise: a.carryForwardPaise,
        });
      }
      return;
    }
    withheldEntries.forEach((e, i) => {
      plan.deductionLedger.push({
        ...base,
        creditPayoutEntryId: e.id,
        outletCode: e.outletId,
        eventBasePaise: e.amountPaise,
        tdsDeductedThisPaise: shareByEntry.get(e.id) ?? 0n,
        // carryForward on the LAST row only → Σ carryForward across the group == group residual.
        carryForwardPaise: i === withheldEntries.length - 1 ? a.carryForwardPaise : 0n,
      });
    });
  }

  /**
   * 194R WHOLE-YEAR TRUE-UP withholding (owner 2026-11-18) for this run's 194R visibility payouts on a
   * client whose CURRENT method is DEDUCT — PAN holders at 10%, no-PAN retailers (keyed per owner) at 20%. Uses the SHARED definition
   * (`collect194RBases` + `liability194R`) the 194R report uses, so the TDS due here == the report's
   * deducted part for the same data:
   *   due      = (whole-FY visibility base incl. this run) × rate%   — once ALL 194R benefits > ₹20k
   *   withhold = due − already deducted for this (client, retailer key, FY) (net of reversals),
   *              capped at this run's payout; the rest carries forward (computeDeduction).
   * FY = the run date's FY (D3: dated by when actually paid). Per client, never across clients.
   */
  private async plan194RDeductions(
    db: Prisma.TransactionClient,
    plan: PayoutTdsPlan,
    a: {
      clientId: string;
      runAt: Date;
      importedCountFrom: string | null;
      byPan: Map<string, { hasPan: boolean; partnerId: string | null; entries: Array<{ id: string; outletId: string; amountPaise: bigint }> }>;
    },
  ): Promise<void> {
    const { clientId } = a;
    const fyLabel = financialYear(a.runAt).fyLabel;
    const cfg = await this.statutory.getForFy(fyLabel);
    const keys = [...a.byPan.keys()];
    const scope = await this.scope194R(
      db,
      clientId,
      [...a.byPan.entries()].map(([key, v]) => ({ key, hasPan: v.hasPan, partnerId: v.partnerId })),
    );
    // WRE D1 (merge decision A): payouts a V2 reversal took off the base are left out by the shared definition and
    // reported here — a retailer with one gets the hand-back explanation (D3). None (every LEGACY tenant) → empty.
    const reversedKeys = new Set<string>();
    const bases = await collect194RBases(db, {
      clientId,
      fyLabel,
      importedCountFrom: a.importedCountFrom,
      scope,
      reversedSink: (key) => reversedKeys.add(key),
      // Owner 2026-11-26: off-portal payments count toward the threshold only — never withheld from this run.
      offPortalForThresholdOnly: true,
    });
    // Already deducted for this (client, PAN-or-no-PAN key, FY) — net of FAILED/reversal negative rows —
    // by the ledger row's OWN stored key (owner rule 2026-11-18: by PAN; a PAN change splits the year).
    const priorByPan = await deducted194RByRetailer(db, { clientId, fyLabel, scope: { keys } });
    // WRE: this client's OPEN 194R TDS credits for these retailers in this FY (oldest first). None → the shipped path.
    const creditsByKey = new Map<string, OpenTdsCredit[]>();
    for (const c of await loadOpenTdsCredits(db, { pans: keys, sections: [TdsSection.SEC_194R], fyLabel, clientId })) {
      if (c.clientId !== clientId) continue;
      const k = retailerKeyOfLedgerPan(c.panNumber);
      const list = creditsByKey.get(k) ?? [];
      list.push(c);
      creditsByKey.set(k, list);
    }
    for (const [pan, { hasPan, entries }] of a.byPan) {
      const rate = rate194RFrom(cfg, hasPan);
      const runBase = entries.reduce((s, e) => s + e.amountPaise, 0n);
      const prior = { ...(bases.get(pan) ?? emptyBases194R(hasPan)), hasPan };
      const b = { ...prior, visPaise: prior.visPaise + runBase }; // this run is paid now → counts in the run date's FY
      const l = liability194R(b, TdsMethodology.DEDUCT, cfg);
      const priorDeducted = priorByPan.get(pan) ?? 0n;
      const keyCredits = creditsByKey.get(pan) ?? [];
      if (keyCredits.length === 0 && !reversedKeys.has(pan)) {
        // No credit and no reversed base for this retailer — exactly the shipped computation.
        const { tdsDueCumulativePaise, tdsDeductThisPaise, carryForwardPaise } = computeDeduction({
          cumulativeBasePaise: b.visPaise,
          priorDeductedPaise: priorDeducted,
          thisPayoutPaise: runBase,
          rate,
          thresholdMetOnCumulative: l.thresholdMet,
        });
        // computeDeduction's due == liability194R's deducted part (same formula, same base).
        this.pushDeduction(plan, {
          clientId,
          panNumber: pan,
          section: TdsSection.SEC_194R,
          fyLabel,
          entries,
          eventBasePaise: runBase,
          cumulativeBasePaise: b.visPaise,
          rateNum: rate.num,
          tdsDueCumulativePaise,
          priorDeductedPaise: priorDeducted,
          tdsDeductThisPaise,
          carryForwardPaise,
        });
        continue;
      }
      // WRE (merge decision A): the withholding is STILL computeDeduction(prior = ledger) on the D1 base — a credit is
      // TDS already in the ledger; deductWithCredits only explains how much of this payout's TDS due it covers (and
      // the D3 hand-back), splits the withholding per entry and draws the credits FIFO. priorDue = the report's own
      // deduct part on the prior base (whole-year threshold on all 194R benefits, liability194R).
      const priorDue = reversedKeys.has(pan) ? liability194R(prior, TdsMethodology.DEDUCT, cfg).deductPartPaise : null;
      const d = deductWithCredits({
        clientId,
        cumulativeBasePaise: b.visPaise,
        priorDeductedPaise: priorDeducted,
        thisPayoutPaise: runBase,
        rate,
        thresholdMetOnCumulative: l.thresholdMet,
        entries: entries.map((e) => ({ id: e.id, amountPaise: e.amountPaise })),
        credits: keyCredits,
        priorDuePaise: priorDue,
      });
      this.recordCreditExplanation(plan, d, pan);
      this.pushDeduction(plan, {
        clientId,
        panNumber: pan,
        section: TdsSection.SEC_194R,
        fyLabel,
        entries,
        eventBasePaise: runBase,
        cumulativeBasePaise: b.visPaise,
        rateNum: rate.num,
        tdsDueCumulativePaise: d.tdsDueCumulativePaise,
        priorDeductedPaise: priorDeducted,
        tdsDeductThisPaise: d.withheldThisPaise,
        carryForwardPaise: d.carryForwardPaise,
        shareByEntry: new Map(d.perEntry.map((x): [string, bigint] => [x.entryId, x.withheldPaise])),
      });
    }
  }

  /**
   * The engine scope of the shared 194R read for some retailer keys: THIS client's (non-parent and group-parent)
   * partners holding these PANs + the no-PAN owners, and all their outlets.
   * B-L8 (one rule with the report): match the stored PAN normalised, and include a group PARENT sharing the PAN (its
   * redemptions count for the retailer, exactly as in the report). A-L1: ONE exact match on the normalised PAN for
   * this client (served by the clientId index).
   */
  private async scope194R(
    db: Prisma.TransactionClient,
    clientId: string,
    retailers: Array<{ key: string; hasPan: boolean; partnerId: string | null }>,
  ): Promise<{ outletCodes: string[]; partnerIds: string[]; pans: string[]; keys: string[] }> {
    const keys = retailers.map((r) => r.key);
    const pans = retailers.filter((r) => r.hasPan).map((r) => r.key);
    const scopePartners = pans.length
      ? await db.$queryRaw<Array<{ id: string; panNumber: string | null }>>(
          Prisma.sql([
            `SELECT "id", "panNumber" FROM "channel_partners" WHERE "clientId" = `,
            ` AND ${PAN_NORMALISE_SQL('"panNumber"')} = ANY(`,
            `::text[])`,
          ], clientId, pans),
        )
      : [];
    const noPanOwners = retailers.filter((r) => !r.hasPan && r.partnerId).map((r) => r.partnerId!);
    const partnerIds = [...new Set([...scopePartners.map((p) => p.id), ...noPanOwners])];
    const scopeOutlets = partnerIds.length
      ? await db.outlet.findMany({ where: { clientId, partnerId: { in: partnerIds } }, select: { outletCode: true } })
      : [];
    return { outletCodes: [...new Set(scopeOutlets.map((o) => o.outletCode))], partnerIds, pans, keys };
  }

  /**
   * Fix round B (H1 / D1 / D3) — the 194R TDS position AFTER a reversed PAID entry left the base (the caller marked it
   * `tdsBaseReversedAt` first and holds the `R194|client|FY` lock). Feeds `reversalCreditCap`:
   *   surplus = Σ ledger − Σ outstanding credits − TDS due on the remaining base.
   * Merge decision A (2026-11-19): the SHIPPED whole-year definition (panPosition194R). Owner D1 (2026-11-19): a PAID
   * 194C payout can't be reversed, so there is no 194C position (refused earlier — never reached).
   */
  private async panPositionForReversal(
    db: Prisma.TransactionClient,
    q: { pan: string; section: TdsSection; fyLabel: string; clientId: string; reversedAmountPaise: bigint },
  ): Promise<PanCreditPosition> {
    if (q.section !== TdsSection.SEC_194R) {
      throw new BadRequestException("194C payouts can't be reversed once paid");
    }
    return this.panPosition194R(db, q);
  }

  /** 194R half of panPositionForReversal — the shipped whole-year definition, one client, one retailer key, one FY. */
  private async panPosition194R(
    db: Prisma.TransactionClient,
    q: { pan: string; fyLabel: string; clientId: string; reversedAmountPaise: bigint },
  ): Promise<PanCreditPosition> {
    const key = retailerKeyOfLedgerPan(q.pan);
    const hasPan = !isNoPanKey(key.toUpperCase());
    // A no-PAN owner key carries its partner id (`__NO_PAN__:<partnerId>`); an owner-less outlet key has none.
    const partnerId = !hasPan && key.startsWith('__NO_PAN__:') && !key.startsWith('__NO_PAN__:outlet:')
      ? key.slice('__NO_PAN__:'.length)
      : null;
    const cfg = await this.statutory.getForFy(q.fyLabel);
    const { methodology } = await this.tenantSettings.resolveTdsPolicy(q.clientId);
    const importedCountFrom = await importedPayoutsCountFromOrThrow(db, q.clientId);
    const scope = await this.scope194R(db, q.clientId, [{ key, hasPan, partnerId }]);
    // The caller marked the entry first → the shared definition already leaves it (and any earlier one) out.
    // Same engine view as plan194RDeductions (off-portal = threshold only), so the cap matches what was withheld.
    const bases = await collect194RBases(db, { clientId: q.clientId, fyLabel: q.fyLabel, importedCountFrom, scope, offPortalForThresholdOnly: true });
    const after = { ...(bases.get(key) ?? emptyBases194R(hasPan)), hasPan };
    const lAfter = liability194R(after, methodology, cfg);
    // "Before" = with the payout this reversal took off — only the THRESHOLD is read from it (on the total base, so
    // the bucket it is added to does not matter).
    const lBefore = liability194R({ ...after, nonCashPaise: after.nonCashPaise + q.reversedAmountPaise }, methodology, cfg);
    // Unscoped read (whole client + FY, keyed in JS by the one normaliser): a ledger row stored with a non-normalised
    // PAN still counts under its retailer — this runs once per approved PAID reversal, never per download.
    const ledger = (await deducted194RByRetailer(db, { clientId: q.clientId, fyLabel: q.fyLabel })).get(key) ?? 0n;
    const open = (await openCredits194RByRetailer(db, { clientId: q.clientId, fyLabel: q.fyLabel, scope: { keys: [key] } })).get(key) ?? 0n;
    return {
      ledgerPaise: ledger,
      outstandingCreditsPaise: open,
      dueRemainingPaise: lAfter.deductPartPaise,
      thresholdMetBefore: lBefore.thresholdMet,
      thresholdMetAfter: lAfter.thresholdMet,
    };
  }

  /**
   * Build the DEDUCT/GROSS-UP write plan for a visibility payout download (reads only; the
   * writes happen inside the caller's download $transaction). PAN aggregation is combined
   * across ALL 194C tenants (TGSL = single deductor, D7) and across the FY. 194R is PER CLIENT
   * (owner 2026-11-18): every "cross-tenant" read below is restricted to THIS tenant for 194R
   * (prior base, max single, DEDUCT ledger); 194R raises no TDS invoice / recovery at all (D7):
   *
   *   cumulativeBase = prior committed (PAID|PROCESSING) visibility base for the PAN/section
   *                    in the FY (by period window; 194C = all tenants, 194R = this tenant only)
   *                    + this event's payable base.
   *   maxSingle      = the largest single payout entry (prior + this event) — for the 194C
   *                    single-payment threshold.
   *   priorDeducted  = Σ tdsDeductedThisPaise from the DEDUCT ledger (PAN/section/FY; 194C = all
   *                    tenants, 194R = this tenant only).
   *
   * DEDUCT (computeDeduction): once cumulativeBase crosses the threshold, TDS on the whole
   * aggregate becomes due; the catch-up owed at this event is withheld from this payout (capped
   * at the payout, remainder carried forward). We reduce the bank-file line + stamp each entry,
   * and append a ledger row. GROSS-UP (computeGrossUpTdsInvoiceBasePaise): the retailer is paid
   * full; at each crossing period we raise a TDS top-up invoice for the delta. 194C: the scope is
   * the PAN across ALL tenants (a crossing by any tenant) and the grossed-up TDS is split pro-rata
   * across the PAN's contributing tenants (D10). 194R (owner D7, 2026-11-18): NO TDS invoice and
   * NO recovery row — the retailer is paid full and the 194R report shows the client's liability.
   * No-PAN visibility payouts are paid full (no deduction, no invoice); under 194C they accrue a
   * per-(tenant, outlet) recovery (FIX-9), under 194R nothing is written (report-only).
   */
  private async buildPayoutTdsPlan(
    // FIX-8: reads run on the download WRITE $transaction client (not this.prisma) so the
    // per-PAN cumulative aggregation is serialized behind the caller's advisory lock — two
    // concurrent downloads for the same PAN can no longer both under-deduct / mis-attribute.
    db: Prisma.TransactionClient,
    params: {
      clientId: string;
      period: string;
      engineEntries: Array<{
        id: string;
        outletId: string;
        amountPaise: bigint;
        tdsSection: TdsSection;
        tdsMethodology: TdsMethodology;
      }>;
      outletTaxMap: Map<string, PartnerTaxInfo>;
      /** D3: the run date — 194R benefits are dated by when they are actually paid (this run = now). */
      runAt: Date;
      /** D6: the client's CURRENT methodology (applies to 194R visibility; 194C keeps the frozen one). */
      currentMethodology: TdsMethodology;
      /** D9: the client's imported-payouts countFrom (read once by the caller), or null. */
      importedCountFrom: string | null;
      /**
       * Owner 2026-11-25 ("TDS invoice only on success"): WHEN this plan runs.
       *  DOWNLOAD (bank file): 194R + 194C DEDUCT withholding only — no 194C gross-up TDS invoice / recovery, no 194C
       *    no-PAN recovery (those are raised when the payout is PAID).
       *  PAID (UTR success): ONLY the 194C gross-up invoice + recovery and the 194C no-PAN recovery, on a PAID-only base
       *    (the just-paid entries are this event; `excludeEntryIds` keeps them out of the "prior" set).
       */
      basis?: 'DOWNLOAD' | 'PAID';
      excludeEntryIds?: string[];
    },
  ): Promise<PayoutTdsPlan> {
    const { clientId, period, engineEntries, outletTaxMap } = params;
    const basis = params.basis ?? 'DOWNLOAD';
    // Prior committed base: at a bank file = already in a file or paid; on PAID = paid only (never FAILED / CANCELLED /
    // REVERSED / still-in-file), the event's own rows excluded (they are PAID in this same transaction).
    const priorStatuses: CreditEntryStatus[] = basis === 'PAID' ? ['PAID'] : ['PAID', 'PROCESSING'];
    const excludeIds = params.excludeEntryIds ?? [];
    const plan: PayoutTdsPlan = {
      deductionByOutlet: new Map(),
      entryDeductions: [],
      deductionLedger: [],
      grossUpInvoices: [],
      noPanRecovery: [],
      creditDraws: [],
      creditByEntry: new Map(),
    };
    if (engineEntries.length === 0) return plan;

    const { fyLabel, startPeriod, endPeriod } = this.fyForPeriod(period);
    // Statutory rates + thresholds for THIS payout's financial year (single source of truth;
    // effective-by-FY, so past FYs are unaffected by a later change). Resolved once per plan.
    const cfg = await this.statutory.getForFy(fyLabel);
    const SEP = '|';

    // Group this event by (PAN, section, methodology). Real-PAN entries only; the no-PAN
    // entries are collected separately for FIX-9 (per-outlet recovery, no deduction).
    type Grp = {
      panNumber: string;
      section: TdsSection;
      methodology: TdsMethodology;
      entityType: string | null;
      entries: typeof engineEntries;
      /** PAID basis zero-event GROSS_UP group: the outlet to name on the TDS invoice. */
      repOutletId?: string;
    };
    const groups = new Map<string, Grp>();
    const panSet = new Set<string>();
    const sectionSet = new Set<TdsSection>();
    // FIX-9: no-PAN visibility entries by (outletCode, section).
    type NoPanGrp = { outletCode: string; section: TdsSection; entries: typeof engineEntries };
    const noPanGroups = new Map<string, NoPanGrp>();
    const noPanOutletCodes = new Set<string>();
    // 194R entries by retailer key (PAN / no-PAN owner key) — this client only (one download = one tenant).
    const r194ByPan = new Map<string, { hasPan: boolean; partnerId: string | null; entries: typeof engineEntries }>();
    for (const e of engineEntries) {
      const info = outletTaxMap.get(e.outletId);
      const pan = info?.panNumber?.trim().toUpperCase();
      if (e.tdsSection === TdsSection.SEC_194R) {
        // 194R (owner 2026-11-18): handled by the whole-year block below on the SHARED definition,
        // keyed by retailer: the PAN, or — without a PAN — the owner (per partner; an owner-less outlet
        // alone), the same keys the 194R report uses. No-PAN visibility IS withheld at 20% on DEDUCT.
        const key = r194RetailerKey(clientId, e.outletId, info);
        const rg = r194ByPan.get(key.key) ?? { hasPan: key.hasPan, partnerId: info?.partnerId ?? null, entries: [] };
        rg.entries.push(e);
        r194ByPan.set(key.key, rg);
        continue;
      }
      if (!pan) {
        // no-PAN → paid full (no deduction), but accrues a tenant recovery obligation (FIX-9, 194C).
        const nk = `${e.outletId}${SEP}${e.tdsSection}`;
        let ng = noPanGroups.get(nk);
        if (!ng) {
          ng = { outletCode: e.outletId, section: e.tdsSection, entries: [] };
          noPanGroups.set(nk, ng);
        }
        ng.entries.push(e);
        noPanOutletCodes.add(e.outletId);
        continue;
      }
      panSet.add(pan);
      sectionSet.add(e.tdsSection);
      const key = `${pan}${SEP}${e.tdsSection}${SEP}${e.tdsMethodology}`;
      let g = groups.get(key);
      if (!g) {
        g = { panNumber: pan, section: e.tdsSection, methodology: e.tdsMethodology, entityType: info?.entityType ?? null, entries: [] };
        groups.set(key, g);
      }
      g.entries.push(e);
    }
    // PAID basis (audit fix 2026-11-26): a PAN whose just-paid 194C rows are all DEDUCT still gets its GROSS_UP due
    // re-evaluated — the DEDUCT base counts toward the combined threshold, which can make gross-up TDS due on the PAN's
    // earlier gross-up payouts (possibly another client's). A zero-event GROSS_UP group does that (event base 0; the
    // representative for the invoice is the paying outlet).
    if (basis === 'PAID') {
      for (const g of [...groups.values()]) {
        if (g.methodology !== TdsMethodology.DEDUCT) continue;
        const gk = `${g.panNumber}${SEP}${g.section}${SEP}${TdsMethodology.GROSS_UP}`;
        if (!groups.has(gk)) {
          groups.set(gk, { panNumber: g.panNumber, section: g.section, methodology: TdsMethodology.GROSS_UP, entityType: g.entityType, entries: [], repOutletId: g.entries[0]?.outletId } as Grp);
        }
      }
    }

    // ── 194R: WHOLE-YEAR TRUE-UP on the SHARED definition (owner 2026-11-18, D2/D3/D6/D9, Q1/Q3) ──
    // Only visibility payouts on the client's CURRENT DEDUCT method are ever withheld (10% PAN / 20% no-PAN);
    // under GROSS_UP nothing is withheld and nothing is written (D7). The threshold is tested on ALL
    // the client's 194R benefits to this retailer this FY (incentives, redemptions, off-platform,
    // counted imported payouts, visibility), dated by when actually paid (this run = runAt).
    if (basis === 'DOWNLOAD' && r194ByPan.size > 0 && params.currentMethodology === TdsMethodology.DEDUCT) {
      await this.plan194RDeductions(db, plan, {
        clientId,
        runAt: params.runAt,
        importedCountFrom: params.importedCountFrom,
        byPan: r194ByPan,
      });
    }

    if (groups.size === 0 && noPanGroups.size === 0) return plan;
    // A bank file only withholds DEDUCT; nothing else to plan when this file has no DEDUCT PAN group.
    if (basis === 'DOWNLOAD' && ![...groups.values()].some((g) => g.methodology === TdsMethodology.DEDUCT)) return plan;
    if (basis === 'PAID' && ![...groups.values()].some((g) => g.methodology !== TdsMethodology.DEDUCT) && noPanGroups.size === 0) return plan;

    // ── Prior FY aggregation per (PAN, section) — 194C only from here on: cross-tenant (D7) ──
    const priorBaseByPS = new Map<string, bigint>();
    const priorMaxSingleByPS = new Map<string, bigint>();
    // FIX-D: prior committed base partitioned by (PAN, section, methodology) — the AMOUNT basis
    // (DEDUCT withholding on the DEDUCT base only; GROSS_UP invoice/recovery on the GROSS_UP base
    // only). The THRESHOLD test stays on the COMBINED per-(PAN,section) base above (per-PAN).
    const priorBaseByPSM = new Map<string, bigint>();
    // FIX-A (D10): prior committed GROSS_UP base per (PAN, section) → per contributing tenant, for
    // pro-rata recovery by each tenant's share of the retailer's FY AGGREGATE (cross-tenant).
    const priorGuBaseByPSByTenant = new Map<string, Map<string, bigint>>();

    const partners = panSet.size
      ? await db.channelPartner.findMany({
          // isParent:false — a parent shares the group PAN but owns no outlets; excluding it avoids
          // pulling the parent id into the outlet resolution (docs/plans/PARTNER-MULTI-OUTLET.md §9).
          where: { panNumber: { in: [...panSet] }, isParent: false },
          select: { id: true, panNumber: true },
        })
      : [];
    const partnerIdToPan = new Map<string, string>(
      partners
        .filter((p) => p.panNumber)
        .map((p): [string, string] => [p.id, p.panNumber!.trim().toUpperCase()]),
    );
    const partnerIds = [...partnerIdToPan.keys()];
    const priorOutlets = partnerIds.length
      ? await db.outlet.findMany({
          where: { partnerId: { in: partnerIds } },
          select: { outletCode: true, clientId: true, partnerId: true },
        })
      : [];
    const outletKeyToPan = new Map<string, string>();
    const priorOutletCodes = new Set<string>();
    for (const po of priorOutlets) {
      const pan = po.partnerId ? partnerIdToPan.get(po.partnerId) : undefined;
      if (!pan) continue;
      outletKeyToPan.set(`${po.clientId}${SEP}${po.outletCode}`, pan);
      priorOutletCodes.add(po.outletCode);
    }
    if (priorOutletCodes.size > 0) {
      const priorEntries = await db.creditPayoutEntry.findMany({
        where: {
          tdsSection: { in: [...sectionSet] },
          // Already committed to a payout (this download's rows are still PENDING/FAILED here,
          // so they are NOT double-counted; they join the "prior" set on the next download).
          // On the PAID basis: paid only, the just-paid rows excluded (they are the event).
          status: { in: priorStatuses },
          period: { gte: startPeriod, lte: endPeriod },
          outletId: { in: [...priorOutletCodes] },
          ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
        },
        // FIX-D: tdsMethodology partitions the cumulative base for the AMOUNT math. A legacy row
        // with a null methodology only feeds the COMBINED threshold base (no such visibility rows
        // exist pre-launch; the frozen stamp is always set at confirm).
        select: { clientId: true, outletId: true, amountPaise: true, tdsSection: true, tdsMethodology: true },
      });
      for (const pe of priorEntries) {
        const pan = outletKeyToPan.get(`${pe.clientId}${SEP}${pe.outletId}`);
        if (!pan || !pe.tdsSection) continue; // outletCode belongs to a different tenant's outlet
        const ps = `${pan}${SEP}${pe.tdsSection}`;
        priorBaseByPS.set(ps, (priorBaseByPS.get(ps) ?? 0n) + pe.amountPaise);
        if (pe.amountPaise > (priorMaxSingleByPS.get(ps) ?? 0n)) priorMaxSingleByPS.set(ps, pe.amountPaise);
        if (pe.tdsMethodology) {
          const psm = `${ps}${SEP}${pe.tdsMethodology}`;
          priorBaseByPSM.set(psm, (priorBaseByPSM.get(psm) ?? 0n) + pe.amountPaise);
          if (pe.tdsMethodology === TdsMethodology.GROSS_UP) {
            let tmap = priorGuBaseByPSByTenant.get(ps);
            if (!tmap) {
              tmap = new Map<string, bigint>();
              priorGuBaseByPSByTenant.set(ps, tmap);
            }
            tmap.set(pe.clientId, (tmap.get(pe.clientId) ?? 0n) + pe.amountPaise);
          }
        }
      }
    }

    // Off-portal payments register (owner 2026-11-26): 194C payments made OUTSIDE the portal to these PANs (any tenant —
    // 194C is per PAN; FY of the payout PERIOD, the same rule as portal 194C entries) count toward the THRESHOLD only
    // (combined base + max single) — never the withholding AMOUNT base, so a later portal payout withholds only its own
    // TDS; the 194C report shows the off-portal TDS as a shortfall. Off-portal 194C rows are always DEDUCT: a gross-up
    // client's visibility payouts must go through the portal (the upload refuses them — owner 2026-11-26).
    // `offPortalPayment` is absent only on narrow unit-test fakes.
    const offPortalDb = (db as Partial<Prisma.TransactionClient>).offPortalPayment;
    if (panSet.size && sectionSet.has(TdsSection.SEC_194C) && offPortalDb) {
      const op = await offPortalDb.findMany({
        where: {
          voidedAt: null,
          tdsSection: TdsSection.SEC_194C,
          panNumber: { in: [...panSet] },
          period: { gte: startPeriod, lte: endPeriod },
        },
        select: { panNumber: true, amountPaise: true },
      });
      for (const p of op) {
        if (!p.panNumber) continue;
        const ps = `${p.panNumber}${SEP}${TdsSection.SEC_194C}`;
        priorBaseByPS.set(ps, (priorBaseByPS.get(ps) ?? 0n) + p.amountPaise);
        if (p.amountPaise > (priorMaxSingleByPS.get(ps) ?? 0n)) priorMaxSingleByPS.set(ps, p.amountPaise);
      }
    }

    // Running DEDUCT carry-forward (PAN/section/FY ledger — cross-tenant, 194C).
    const priorDeductedByPS = new Map<string, bigint>();
    if (panSet.size) {
      const ledgerRows = await db.tdsDeductionEntry.findMany({
        where: { panNumber: { in: [...panSet] }, section: { in: [...sectionSet] }, fyLabel },
        select: { clientId: true, panNumber: true, section: true, tdsDeductedThisPaise: true },
      });
      for (const lr of ledgerRows) {
        const ps = `${lr.panNumber}${SEP}${lr.section}`;
        priorDeductedByPS.set(ps, (priorDeductedByPS.get(ps) ?? 0n) + lr.tdsDeductedThisPaise);
      }
    }

    // FIX-1: already-invoiced gross-up TDS per (PAN, section, FY) = Σ recovery already recorded
    // (each monthly top-up writes DELTA recovery, so this telescopes to grossUp(priorCumulative)).
    const recoveredByPS = new Map<string, bigint>();
    // FIX-A: already-recovered per (PAN, section) → per tenant, so each tenant's recovery is a
    // true-up towards its D10 pro-rata target (cumulative == pro-rata regardless of payment order).
    const recoveredByPSByTenant = new Map<string, Map<string, bigint>>();
    if (panSet.size) {
      const recRows = await db.tdsRecoveryEntry.findMany({
        // panSet holds REAL PANs only; the no-PAN sentinel (`__NO_PAN__:<outlet>`) never matches.
        where: { panNumber: { in: [...panSet] }, section: { in: [...sectionSet] }, fyLabel },
        select: { panNumber: true, section: true, clientId: true, tenantSharePaise: true },
      });
      for (const r of recRows) {
        const ps = `${r.panNumber}${SEP}${r.section}`;
        recoveredByPS.set(ps, (recoveredByPS.get(ps) ?? 0n) + r.tenantSharePaise);
        let tmap = recoveredByPSByTenant.get(ps);
        if (!tmap) {
          tmap = new Map<string, bigint>();
          recoveredByPSByTenant.set(ps, tmap);
        }
        tmap.set(r.clientId, (tmap.get(r.clientId) ?? 0n) + r.tenantSharePaise);
      }
    }

    // FIX-D: per-(PAN,section) COMBINED event aggregates (threshold is per-PAN, methodology-
    // agnostic) + per-(PAN,section,methodology) event base (the AMOUNT basis for each method).
    const eventBaseByPS = new Map<string, bigint>();
    const eventMaxSingleByPS = new Map<string, bigint>();
    const eventBaseByPSM = new Map<string, bigint>();
    for (const g of groups.values()) {
      const ps = `${g.panNumber}${SEP}${g.section}`;
      const psm = `${ps}${SEP}${g.methodology}`;
      const gBase = g.entries.reduce((s, e) => s + e.amountPaise, 0n);
      const gMax = g.entries.reduce((m, e) => (e.amountPaise > m ? e.amountPaise : m), 0n);
      eventBaseByPS.set(ps, (eventBaseByPS.get(ps) ?? 0n) + gBase);
      if (gMax > (eventMaxSingleByPS.get(ps) ?? 0n)) eventMaxSingleByPS.set(ps, gMax);
      eventBaseByPSM.set(psm, (eventBaseByPSM.get(psm) ?? 0n) + gBase);
    }

    for (const g of groups.values()) {
      const ps = `${g.panNumber}${SEP}${g.section}`;
      const psm = `${ps}${SEP}${g.methodology}`;
      // This (PAN, section, methodology) event base (== this group's base, one group per PSM).
      const thisEventBase = eventBaseByPSM.get(psm) ?? 0n;
      // FIX-D: the THRESHOLD is per-PAN → test on the COMBINED (all-methodology) cumulative base;
      // the AMOUNT math uses the methodology-specific cumulative base.
      const combinedCumulativeBase = (priorBaseByPS.get(ps) ?? 0n) + (eventBaseByPS.get(ps) ?? 0n);
      const eventMaxSingle = eventMaxSingleByPS.get(ps) ?? 0n;
      const priorMaxSingle = priorMaxSingleByPS.get(ps) ?? 0n;
      const combinedMaxSingle = eventMaxSingle > priorMaxSingle ? eventMaxSingle : priorMaxSingle;
      const methodologyCumulativeBase = (priorBaseByPSM.get(psm) ?? 0n) + thisEventBase;
      const rate = this.tdsRateFor(g.section, true, g.entityType, cfg);
      const thresholdMet = this.tdsThresholdMet(g.section, combinedCumulativeBase, combinedMaxSingle, cfg);

      // DEDUCT withholding happens at the bank file only; the 194C gross-up invoice only once the payout is PAID.
      if (g.methodology === TdsMethodology.DEDUCT && basis === 'PAID') continue;
      if (g.methodology !== TdsMethodology.DEDUCT && basis === 'DOWNLOAD') continue;
      if (g.methodology === TdsMethodology.DEDUCT) {
        const priorDeducted = priorDeductedByPS.get(ps) ?? 0n;
        const { tdsDueCumulativePaise, tdsDeductThisPaise, carryForwardPaise } = computeDeduction({
          cumulativeBasePaise: methodologyCumulativeBase, // FIX-D: DEDUCT-methodology base only
          priorDeductedPaise: priorDeducted,
          thisPayoutPaise: thisEventBase,
          rate,
          thresholdMetOnCumulative: thresholdMet, // FIX-D: combined per-PAN threshold
        });
        this.pushDeduction(plan, {
          clientId,
          panNumber: g.panNumber,
          section: g.section,
          fyLabel,
          entries: g.entries,
          eventBasePaise: thisEventBase,
          cumulativeBasePaise: methodologyCumulativeBase,
          rateNum: rate.num,
          tdsDueCumulativePaise,
          priorDeductedPaise: priorDeducted,
          tdsDeductThisPaise,
          carryForwardPaise,
        });
      } else {
        // GROSS_UP — retailer paid full. FIX-1: at EACH crossing period, raise a monthly TOP-UP
        // TDS invoice for the DELTA = grossUp(cumulative) − Σ already-invoiced (recovery ledger),
        // so Σ over the FY == grossUp(full-FY base) instead of under-depositing after the first.
        // D7 (owner 2026-11-18): TDS INVOICING IS 194C-ONLY (Gifsy deposits the TDS and recovers it
        // from the client). A 194R GROSS_UP payout raises NO TDS invoice and NO TdsRecoveryEntry — the
        // retailer is paid in full and the client's liability is shown by the 194R report.
        if (!thresholdMet) continue;

        // Idempotency per (PAN, FY, period): a top-up already raised for THIS period must not
        // double-raise. TDS invoice numbers are TGSL-TDS-<PAN>-<FYnodash>-<seq> and carry the
        // crossing period; read them for the next seq (D8: highest + 1) + detect a same-period re-run.
        const numPrefix = `TGSL-TDS-${g.panNumber}-${fyLabel.replace(/-/g, '')}-`;
        const priorTds = await db.autoInvoice.findMany({
          where: { invoiceKind: 'TDS', invoiceNumber: { startsWith: numPrefix } },
          select: { id: true, clientId: true, period: true, invoiceNumber: true },
        });
        // Section of each prior TDS invoice, from its recovery rows (AutoInvoice has no section
        // column; every invoice is written with ≥1 non-zero recovery row carrying the section).
        const samePeriod = priorTds.filter((i) => i.period === period);
        const invSection = new Map<string, TdsSection>();
        const samePeriodIds = samePeriod.map((i) => i.id).filter((id): id is string => !!id);
        if (samePeriodIds.length > 0) {
          const secRows = await db.tdsRecoveryEntry.findMany({
            where: { tdsInvoiceId: { in: samePeriodIds } },
            select: { tdsInvoiceId: true, section: true },
          });
          for (const r of secRows) if (r.tdsInvoiceId) invSection.set(r.tdsInvoiceId, r.section);
        }
        // Idempotency (194C only — D7): one top-up per (PAN, FY, period) across tenants. A legacy 194R
        // invoice (raised before D7) never blocks. An invoice whose section can't be resolved (no
        // recovery rows — legacy) is conservatively treated as 194C (the pre-2026-11-18 behaviour).
        const alreadyThisPeriod = samePeriod.some((i) => {
          const sec = i.id ? invSection.get(i.id) : undefined;
          return !(sec && sec !== g.section);
        });
        // PAID basis: several bank results can land in one month, each paying more of the PAN's base — the DELTA below
        // (dueNow − Σ already recovered, under the per-PAN lock) is the idempotency guard, so a further top-up in the
        // same month is raised (never a double: a re-run computes delta 0). Only a LEGACY same-month invoice without
        // recovery rows (its amount is not in the ledger, so the delta can't see it) still blocks, as before.
        const legacySamePeriod = samePeriod.some((i) => !(i.id && invSection.get(i.id)));
        if (basis === 'PAID' ? legacySamePeriod : alreadyThisPeriod) continue; // already topped up this period

        // FIX-D: dueNow on the GROSS_UP-methodology cumulative base only.
        const dueNow = computeGrossUpTdsInvoiceBasePaise(methodologyCumulativeBase, rate, thresholdMet);
        const alreadyInvoiced = recoveredByPS.get(ps) ?? 0n;
        const delta = dueNow - alreadyInvoiced;
        if (delta <= 0n) continue; // fully invoiced already → nothing to top up

        // The NUMBER sequence is global per (PAN, FY) — TGSL-TDS-<PAN>-<FY>-<seq> is a globally unique
        // invoice number. Only 194C reaches here (D7) and groups are keyed (PAN, section, methodology),
        // so a plan holds at most ONE GROSS_UP invoice per PAN; plannedSamePan is a defensive guard.
        // D8 (owner 2026-11-18): the next number = the HIGHEST seq ever issued for this (PAN, FY) + 1,
        // parsed from the existing numbers — never a count, so a deleted invoice in the middle can't
        // make the next one collide with (or re-use) an existing number. Only the platform-first
        // invoice (seq 1) is the anchor; if 001 was deleted the next one is NOT re-anchored.
        const seqRe = new RegExp(`^${numPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
        const highestSeq = priorTds.reduce((m, i) => {
          const hit = i.invoiceNumber ? seqRe.exec(i.invoiceNumber) : null;
          const n = hit ? Number(hit[1]) : 0;
          return n > m ? n : m;
        }, 0);
        const plannedSamePan = plan.grossUpInvoices.filter((x) => x.panNumber === g.panNumber).length;
        const seq = highestSeq + plannedSamePan + 1;
        const isAnchor = seq === 1;

        // FIX-A (D10): recovery pro-rata by each tenant's share of the retailer's FY AGGREGATE
        // GROSS_UP base (cross-tenant, 194C). Tenant set = every tenant with prior committed GROSS_UP
        // base for this PAN + this event's tenant + any tenant already carrying recovery (so the
        // per-tenant true-up telescopes EXACTLY: Σ deltas == dueNow − alreadyInvoiced == body).
        const tenantBaseMap = new Map<string, bigint>();
        const priorGu = priorGuBaseByPSByTenant.get(ps);
        if (priorGu) for (const [cid, b] of priorGu) tenantBaseMap.set(cid, b);
        tenantBaseMap.set(clientId, (tenantBaseMap.get(clientId) ?? 0n) + thisEventBase);
        const recMap = recoveredByPSByTenant.get(ps) ?? new Map<string, bigint>();
        for (const cid of recMap.keys()) if (!tenantBaseMap.has(cid)) tenantBaseMap.set(cid, 0n);

        // Deterministic tenant order (clientId asc) so the exact-summing allocator is reproducible.
        const tenants = [...tenantBaseMap.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([cid, b]) => ({ clientId: cid, basePaise: b }));
        const targets = allocateProRataRecovery({ panTdsTotalPaise: dueNow, tenants });
        const targetByTenant = new Map<string, bigint>(
          targets.map((t): [string, bigint] => [t.clientId, t.tenantSharePaise]),
        );

        // Per-tenant true-up DELTA = pro-rata target − already recovered (keeps each tenant's
        // cumulative recovery == its D10 pro-rata share regardless of payment order). A rounding
        // wiggle can make one row a small negative true-up; that is intentional (preserves both
        // Σ deltas == body AND cumulative == target). Skip only exact zeros.
        const recovery = tenants
          .map((t) => ({
            clientId: t.clientId,
            tenantBasePaise: t.basePaise,
            tenantSharePaise: (targetByTenant.get(t.clientId) ?? 0n) - (recMap.get(t.clientId) ?? 0n),
          }))
          .filter((r) => r.tenantSharePaise !== 0n);

        const repCode = g.entries[0]?.outletId ?? g.repOutletId!;
        const rep = outletTaxMap.get(repCode)!;
        plan.grossUpInvoices.push({
          panNumber: g.panNumber,
          section: g.section,
          fyLabel,
          period,
          seq,
          isAnchor,
          bodyPaise: delta,
          panBasePaise: methodologyCumulativeBase,
          representative: { ...rep, outletCode: repCode },
          recovery,
        });
      }
    }

    // ── FIX-9: no-PAN visibility recovery (per clientId+outletCode, no deduction/invoice) ──
    // Owner 2026-11-25: recorded when the payout is PAID (PAID basis), never at the bank file.
    if (basis === 'PAID' && noPanOutletCodes.size > 0) {
      // Prior committed no-PAN visibility base for THIS tenant's outlets in the FY (no cross-
      // tenant aggregation is possible without a PAN — this is per-outlet within the tenant).
      const priorNoPan = await db.creditPayoutEntry.findMany({
        where: {
          clientId,
          outletId: { in: [...noPanOutletCodes] },
          tdsSection: { in: [...new Set([...noPanGroups.values()].map((g) => g.section))] },
          status: { in: priorStatuses },
          period: { gte: startPeriod, lte: endPeriod },
          ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
        },
        select: { outletId: true, amountPaise: true, tdsSection: true },
      });
      const priorNoPanByOS = new Map<string, bigint>();
      const priorNoPanMaxByOS = new Map<string, bigint>();
      for (const pe of priorNoPan) {
        if (!pe.tdsSection) continue;
        const os = `${pe.outletId}${SEP}${pe.tdsSection}`;
        priorNoPanByOS.set(os, (priorNoPanByOS.get(os) ?? 0n) + pe.amountPaise);
        if (pe.amountPaise > (priorNoPanMaxByOS.get(os) ?? 0n)) priorNoPanMaxByOS.set(os, pe.amountPaise);
      }

      // FIX-B: TELESCOPE the no-PAN recovery off the RECOVERY LEDGER (not off a prior-base
      // subtraction). The prior-base subtraction double-counted on FAILED→re-bank (the FAILED base
      // dropped out of the PAID/PROCESSING "prior" set, but the FAILED reversal never reverses
      // no-PAN recovery), so a re-bank re-recorded the full 20%. Reading Σ already-recorded no-PAN
      // recovery for THIS (clientId, outlet, FY) makes a re-bank of the same base yield delta 0.
      // The outlet is encoded in panNumber (`__NO_PAN__:<outlet>`) since TdsRecoveryEntry has no
      // outletCode column.
      const noPanKeys = [...noPanOutletCodes].map((oc) => CreditsService.noPanRecoveryKey(oc));
      const existingNoPanRec = await db.tdsRecoveryEntry.findMany({
        where: {
          clientId,
          panNumber: { in: noPanKeys },
          section: { in: [...new Set([...noPanGroups.values()].map((g) => g.section))] },
          fyLabel,
        },
        select: { panNumber: true, section: true, tenantSharePaise: true },
      });
      // Off-portal no-PAN 194C payments to these outlets (this client, FY of the payout period): treated like portal no-PAN
      // payouts (owner 2026-11-26) — no-PAN 194C is never withheld, only RECOVERED from the client — so they count in
      // the threshold AND the recovery base: this outlet's next portal payment records the recovery on them too (the ledger
      // telescopes, never twice). Not a TDS shortfall.
      const opNoPan = new Map<string, { total: bigint; max: bigint }>(); // `<OUTLETKEY>|<section>`
      if (offPortalDb) {
        const rows = await offPortalDb.findMany({
          where: {
            clientId,
            voidedAt: null,
            tdsSection: TdsSection.SEC_194C,
            panNumber: null,
            outletCodeKey: { in: [...noPanOutletCodes].map((c) => c.trim().toUpperCase()) },
            period: { gte: startPeriod, lte: endPeriod },
          },
          select: { outletCodeKey: true, amountPaise: true },
        });
        for (const r of rows) {
          const k = `${r.outletCodeKey}${SEP}${TdsSection.SEC_194C}`;
          const cur = opNoPan.get(k) ?? { total: 0n, max: 0n };
          cur.total += r.amountPaise;
          if (r.amountPaise > cur.max) cur.max = r.amountPaise;
          opNoPan.set(k, cur);
        }
      }
      const noPanRecByKS = new Map<string, bigint>(); // `<encodedKey>|<section>` → recovered
      for (const r of existingNoPanRec) {
        const k = `${r.panNumber}${SEP}${r.section}`;
        noPanRecByKS.set(k, (noPanRecByKS.get(k) ?? 0n) + r.tenantSharePaise);
      }

      // No-PAN rate (grossed-up) per the group's OWN section: 194C → c194cNoPan, 194R → r194rNoPan
      // (both default 20/80; previously the 194C value was used for 194R too, which diverged only if
      // the FY statutory config set them differently). Once the outlet's cumulative base crosses, the
      // TARGET recovery is grossUp(cumulative); the DELTA to record = target − already-recorded.
      for (const ng of noPanGroups.values()) {
        const noPanRate = this.tdsRateFor(ng.section, false, null, cfg);
        const os = `${ng.outletCode}${SEP}${ng.section}`;
        const thisEventBase = ng.entries.reduce((s, e) => s + e.amountPaise, 0n);
        const priorBase = priorNoPanByOS.get(os) ?? 0n;
        const op = opNoPan.get(`${ng.outletCode.trim().toUpperCase()}${SEP}${ng.section}`);
        const cumulativeBase = priorBase + thisEventBase + (op?.total ?? 0n);
        const eventMaxSingle = ng.entries.reduce((m, e) => (e.amountPaise > m ? e.amountPaise : m), 0n);
        const priorMaxSingle = priorNoPanMaxByOS.get(os) ?? 0n;
        const cumMaxSingle = [eventMaxSingle, priorMaxSingle, op?.max ?? 0n].reduce((m, x) => (x > m ? x : m), 0n);
        const nowCrossed = this.tdsThresholdMet(ng.section, cumulativeBase, cumMaxSingle, cfg);
        if (!nowCrossed) continue;
        const encodedKey = CreditsService.noPanRecoveryKey(ng.outletCode);
        const alreadyRecovered = noPanRecByKS.get(`${encodedKey}${SEP}${ng.section}`) ?? 0n;
        const recoveryDelta = grossUpTdsPaise(cumulativeBase, noPanRate) - alreadyRecovered;
        if (recoveryDelta <= 0n) continue;
        plan.noPanRecovery.push({
          clientId,
          outletCode: ng.outletCode,
          section: ng.section,
          fyLabel,
          eventBasePaise: thisEventBase,
          cumulativeBasePaise: cumulativeBase,
          tenantSharePaise: recoveryDelta,
        });
      }
    }

    return plan;
  }

  /**
   * Write a plan's 194C gross-up TDS invoices (+ their pro-rata recovery rows) and its 194C no-PAN recovery rows,
   * inside the caller's transaction. `downloadId` = the bank run the paid payouts came from (Fund Reconciliation's TDS
   * line). Every row written here is marked `raisedOn = 'PAID'` (owner 2026-11-25: raised when the payout is paid) —
   * rows without it were raised at the bank file under the old timing.
   */
  private async writeGrossUpArtefacts(
    tx: Prisma.TransactionClient,
    clientId: string,
    period: string,
    plan: PayoutTdsPlan,
    downloadId: string,
  ): Promise<{ invoices: number; recoveryRows: number }> {
    let recoveryRows = 0;
    // FIX-1: GROSS-UP monthly TOP-UP TDS invoices for the DELTA + the DELTA pro-rata recovery ledger.
    for (const gi of plan.grossUpInvoices) {
      // Audit fix 2026-11-26: the TDS invoice belongs to a client that BEARS the recovery — never to a client that owes
      // none of it (e.g. a DEDUCT payout of client B that tipped the PAN's combined base over the threshold for client A's
      // gross-up payouts must not put A's invoice in B's lists). The paying client keeps it when it bears a share.
      const { invoiceClientId, rep } = await this.tdsInvoiceOwner(tx, clientId, gi);
      const inv = await this.invoicesService.createTdsInvoice(tx, {
        clientId: invoiceClientId,
        period,
        panNumber: gi.panNumber,
        fyLabel: gi.fyLabel,
        bodyPaise: gi.bodyPaise,
        seq: gi.seq,
        isAnchor: gi.isAnchor,
        partnerId: rep.partnerId,
        outletCode: rep.outletCode,
        outletName: rep.outletName,
        retailerState: rep.retailerState,
        businessName: rep.businessName,
        ownerName: rep.ownerName,
        phone: rep.phone,
        entityType: rep.entityType,
        gstRegistrationType: rep.gstRegistrationType,
        gstNumber: rep.gstNumber,
        bankName: rep.bankName,
        accountNumber: rep.accountNumber,
        ifscCode: rep.ifscCode,
      });
      if (gi.recovery.length > 0) {
        await tx.tdsRecoveryEntry.createMany({
          data: gi.recovery.map((r) => ({
            clientId: r.clientId,
            panNumber: gi.panNumber,
            section: gi.section,
            fyLabel: gi.fyLabel,
            tdsInvoiceId: inv.invoiceId,
            downloadId,
            raisedOn: 'PAID',
            panTdsTotalPaise: gi.bodyPaise,
            tenantBasePaise: r.tenantBasePaise,
            panBasePaise: gi.panBasePaise,
            tenantSharePaise: r.tenantSharePaise,
          })),
        });
        recoveryRows += gi.recovery.length;
      }
    }
    // FIX-9: no-PAN visibility recovery — tenant obligation only (no deduction, no invoice), keyed per outlet.
    if (plan.noPanRecovery.length > 0) {
      await tx.tdsRecoveryEntry.createMany({
        data: plan.noPanRecovery.map((r) => ({
          clientId: r.clientId,
          panNumber: CreditsService.noPanRecoveryKey(r.outletCode),
          section: r.section,
          fyLabel: r.fyLabel,
          tdsInvoiceId: null,
          downloadId,
          raisedOn: 'PAID',
          panTdsTotalPaise: r.tenantSharePaise,
          tenantBasePaise: r.eventBasePaise,
          panBasePaise: r.cumulativeBasePaise,
          tenantSharePaise: r.tenantSharePaise,
        })),
      });
      recoveryRows += plan.noPanRecovery.length;
    }
    return { invoices: plan.grossUpInvoices.length, recoveryRows };
  }

  /**
   * The client a 194C gross-up TDS invoice is issued under (audit fix 2026-11-26): the paying client when it bears a
   * share of the recovery, else the client with the largest share — with one of THAT client's outlets for the PAN as
   * the invoice's representative (so no client ever sees another client's outlet / payout on its invoice).
   */
  private async tdsInvoiceOwner(
    tx: Prisma.TransactionClient,
    payingClientId: string,
    gi: PayoutTdsPlan['grossUpInvoices'][number],
  ): Promise<{ invoiceClientId: string; rep: PayoutTdsPlan['grossUpInvoices'][number]['representative'] }> {
    const bearers = gi.recovery.filter((r) => r.tenantSharePaise > 0n);
    if (bearers.length === 0 || bearers.some((r) => r.clientId === payingClientId)) {
      return { invoiceClientId: payingClientId, rep: gi.representative };
    }
    const owner = [...bearers].sort((a, b) => (b.tenantSharePaise > a.tenantSharePaise ? 1 : b.tenantSharePaise < a.tenantSharePaise ? -1 : a.clientId < b.clientId ? -1 : 1))[0].clientId;
    const o = await tx.outlet.findFirst({
      where: { clientId: owner, partner: { panNumber: { equals: gi.panNumber, mode: 'insensitive' }, isParent: false } },
      orderBy: { outletCode: 'asc' },
      select: {
        outletCode: true, name: true, state: true,
        partner: { select: { id: true, entityType: true, gstNumber: true, gstRegistrationType: true, businessName: true, ownerName: true, phone: true, bankName: true, bankAccountNumber: true, ifscCode: true } },
      },
    });
    if (!o?.partner) {
      // Never put the bearing client's invoice under the paying client: without an outlet of its own the invoice still
      // goes to the bearing client, named by PAN only (no other client's outlet / partner details).
      this.logger.warn(`[tds] no ${owner} outlet found for PAN …${gi.panNumber.slice(-4)} — TDS invoice issued without an outlet representative`);
      return {
        invoiceClientId: owner,
        rep: { ...gi.representative, partnerId: gi.representative.partnerId, outletCode: '', outletName: '', businessName: null, ownerName: null, phone: null, bankName: null, accountNumber: null, ifscCode: null, retailerState: null, gstNumber: null },
      };
    }
    const p = o.partner;
    return {
      invoiceClientId: owner,
      rep: {
        partnerId: p.id,
        panNumber: gi.panNumber,
        entityType: p.entityType ?? null,
        gstNumber: p.gstNumber ?? null,
        gstRegistrationType: p.gstRegistrationType ?? null,
        businessName: p.businessName ?? null,
        ownerName: p.ownerName ?? null,
        phone: p.phone ?? null,
        bankName: p.bankName ?? null,
        accountNumber: p.bankAccountNumber ?? null,
        ifscCode: p.ifscCode ?? null,
        outletName: o.name,
        retailerState: o.state ?? null,
        outletCode: o.outletCode,
      },
    };
  }
  /**
   * Owner 2026-11-25 ("TDS invoice only on success"): when visibility payouts become PAID, raise the 194C GROSS-UP TDS
   * invoice + recovery and the 194C no-PAN recovery for what was just paid — on a PAID-only yearly base (never FAILED,
   * CANCELLED, REVERSED or still in a bank file), the increment against everything already recovered (so a re-bank
   * then PAID, or a re-run, never counts twice). Runs INSIDE the paying transaction, behind a per-payee advisory lock
   * (`GUPAID|…`, taken only by this path — the bank file no longer writes these rows).
   *
   * The payee is the one recorded when the bank file was made (payeePan snapshot): a real PAN → the PAN's gross-up;
   * none → the outlet's no-PAN recovery.
   */
  async recordGrossUpOnPaid(
    tx: Prisma.TransactionClient,
    params: {
      clientId: string;
      period: string;
      downloadId: string;
      paidEntries: Array<{
        id: string;
        outletId: string;
        fieldId: string;
        amountPaise: bigint;
        tdsSection: TdsSection | null;
        tdsMethodology: TdsMethodology | null;
        payeePan: string | null;
      }>;
    },
  ): Promise<{ invoices: number; recoveryRows: number }> {
    const { clientId, period } = params;
    const candidates = params.paidEntries.filter((e) => e.tdsSection === TdsSection.SEC_194C && e.tdsMethodology != null);
    if (candidates.length === 0) return { invoices: 0, recoveryRows: 0 };
    const pans = new Map<string, string | null>();
    for (const e of candidates) {
      const p = (e.payeePan ?? '').trim();
      pans.set(e.outletId, p && !p.startsWith(CreditsService.NO_PAN_KEY) ? p.toUpperCase() : null);
    }
    // A DEDUCT PAN payout is withheld at the bank file and raises no gross-up of its OWN — but it still counts toward
    // the PAN's combined yearly base, so it can make the gross-up due on the PAN's OTHER (gross-up) payouts — possibly
    // another client's (audit fix 2026-11-26). Every PAID 194C event therefore re-evaluates the PAN's gross-up due.
    const raising = candidates;
    const vis = await tx.creditField.findMany({ where: { clientId, payoutStream: 'VISIBILITY' }, select: { id: true } });
    const visIds = new Set((vis ?? []).map((f) => f.id));
    const live = raising
      .filter((e) => visIds.has(e.fieldId))
      .map((e) => ({ id: e.id, outletId: e.outletId, amountPaise: e.amountPaise, tdsSection: e.tdsSection!, tdsMethodology: e.tdsMethodology! }));
    if (live.length === 0) return { invoices: 0, recoveryRows: 0 };
    const codes = [...new Set(live.map((e) => e.outletId))];
    const outlets = await tx.outlet.findMany({
      where: { clientId, outletCode: { in: codes } },
      select: {
        outletCode: true,
        name: true,
        state: true,
        partner: {
          select: {
            id: true, entityType: true, gstNumber: true, gstRegistrationType: true, businessName: true, ownerName: true,
            phone: true, bankName: true, bankAccountNumber: true, ifscCode: true,
          },
        },
      },
    });
    const outletTaxMap = new Map<string, PartnerTaxInfo>();
    for (const o of outlets ?? []) {
      const p = o.partner;
      outletTaxMap.set(o.outletCode, {
        partnerId: p?.id ?? '',
        panNumber: pans.get(o.outletCode) ?? null,
        entityType: p?.entityType ?? null,
        gstNumber: p?.gstNumber ?? null,
        gstRegistrationType: p?.gstRegistrationType ?? null,
        businessName: p?.businessName ?? null,
        ownerName: p?.ownerName ?? null,
        phone: p?.phone ?? null,
        bankName: p?.bankName ?? null,
        accountNumber: p?.bankAccountNumber ?? null,
        ifscCode: p?.ifscCode ?? null,
        outletName: o.name,
        retailerState: o.state ?? null,
      });
    }
    const { fyLabel } = this.fyForPeriod(period);
    const keys = [...new Set(live.map((e) => {
      const pan = pans.get(e.outletId);
      return pan ? `GUPAID|${pan}|${fyLabel}` : `GUPAID|NOPAN|${clientId}|${e.outletId}|${fyLabel}`;
    }))].sort();
    await lockAdvisoryKeys(tx, keys);
    const plan = await this.buildPayoutTdsPlan(tx, {
      clientId,
      period,
      engineEntries: live,
      outletTaxMap,
      runAt: new Date(),
      currentMethodology: TdsMethodology.GROSS_UP,
      importedCountFrom: null,
      basis: 'PAID',
      excludeEntryIds: params.paidEntries.map((e) => e.id),
    });
    return this.writeGrossUpArtefacts(tx, clientId, period, plan, params.downloadId);
  }

  /**
   * Full points-credit notification fan-out for ONE partner: the bell feed (IN_APP) + PUSH to the
   * partner's login user, PLUS the config-driven SMS/WhatsApp to the OUTLET OWNER — through the
   * single canonical NotificationsService.notifyUserWithChannels path (no direct MSG91 call).
   *
   * Fire-and-forget + POST-COMMIT: the batch is CONFIRMED before this runs, so it MUST NEVER throw
   * into — or roll back — the money path (wrapped + swallowed). For a WHATSAPP_KYC tenant the
   * WhatsApp default reproduces today's `deoleo_points_credit` send with the same body values:
   *   {{1}} ownerName · {{2}} points credited · {{3}} redeemable balance AFTER the credit
   *   {{4}} month-year credited ("July 2026") · {{5}} date credited ("06 Jul 2026")
   * `includeFreeChannels` follows whether the partner has a login user (no user → paid channels
   * only, matching the prior IN_APP/PUSH gate on partner.userId).
   */
  private async notifyPointsCredited(data: {
    userId: string | null;
    clientId: string;
    partnerId: string;
    ownerName?: string | null;
    phone?: string | null;
    totalPoints: number;
    period: string;
  }): Promise<void> {
    try {
      // Redeemable balance AFTER the credit — read the partner's wallet (missing → 0; never throws).
      const wallet = await this.prisma.wallet.findFirst({
        where: { partnerId: data.partnerId },
        select: { redeemablePoints: true },
      });
      const redeemableBalance = wallet?.redeemablePoints ?? 0;

      await this.notifications.notifyUserWithChannels({
        clientId: data.clientId,
        userId: data.userId ?? '',
        eventKey: 'POINTS_CREDITED',
        recipientPhone: data.phone ?? null,
        includeFreeChannels: !!data.userId,
        vars: {
          ownerName: data.ownerName?.trim() || 'Partner',
          pointsCredited: data.totalPoints,
          redeemableBalance,
          monthYear: monthYearIST(data.period),
          dateCredited: formatDateIST(new Date()),
        },
        subject: 'Points credited',
        body: `You earned ${data.totalPoints} points.`,
        url: '/partner/wallet',
        event: 'WALLET_POINTS_EARNED',
      });
    } catch (e) {
      // Non-critical: a notification failure must NEVER fail the credit batch.
      this.logger.warn(`[credit-notify] points-credit fan-out failed (client ${data.clientId}): ${e}`);
    }
  }

  // ─── Settings-enforcement helpers (Stream MONEY-CREDITS) ──────────────────
  // The credit/payout safety caps and the month-cutoff window were previously
  // FRONTEND-ONLY (platform/src/app/admin/credits-payouts/upload/page.tsx +
  // credits-payouts-parser.ts). They are bypassable via a direct API call, so we
  // now MIRROR them server-side from the per-tenant TenantSettingsService.

  /**
   * The IST wall-clock parts of an instant: `{ monthKey: "YYYY-MM", day }` (day = day-of-month).
   * Production runs UTC (no TZ in api/Dockerfile), so reading `.getMonth()/.getDate()` off a raw
   * Date reads SERVER-LOCAL (UTC) time — in the 00:00–05:30 IST window that is the WRONG IST day,
   * and at a UTC month boundary the WRONG IST month, leaving the cutoff open ~5.5h too long. We
   * shift by the fixed IST offset then read via getUTC* — the exact pattern in ist-date.ts
   * (formatDateIST/startOfIstDay) — so the result is the IST wall-clock value regardless of the
   * server's timezone. The FE's window check runs in the admin's IST browser, so this now truly
   * mirrors it (the prior "server-clock mirrors the FE" comment was wrong for a UTC server).
   */
  private istParts(now: Date = new Date()): { monthKey: string; day: number } {
    const shifted = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
    const monthKey = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
    return { monthKey, day: shifted.getUTCDate() };
  }

  /** Current month as `YYYY-MM` in IST wall-clock (see istParts for the why). Matches the FE's
   *  `getPreviousMonth` baseline (the FE runs in the admin's IST browser). */
  private currentPeriodKey(now: Date = new Date()): string {
    return this.istParts(now).monthKey;
  }

  /**
   * Mirror of the FE `isUploadWindowOpen(cutoffDay)` =
   * `new Date().getDate() <= cutoffDay`. A batch for a PRIOR month (period strictly
   * before the current month, `YYYY-MM` string compare) may only be created/confirmed
   * while today's day-of-month is on/before `monthCutoffDay`. Current/future-month
   * batches are unaffected (the FE only ever uploads the previous month, so the prior-
   * month case is the one the window guards). Both the current-month key AND the
   * day-of-month are read in IST wall-clock (see istParts) so a UTC server does not
   * hold the window open through the 00:00–05:30 IST tail of the cutoff day.
   */
  private assertWithinUploadWindow(period: string, monthCutoffDay: number): void {
    const { monthKey: current, day } = this.istParts();
    // Only PRIOR-month batches are gated. Same string-compare as targets isMonthLocked.
    if (period < current && day > monthCutoffDay) {
      throw new BadRequestException(
        `The upload window for prior-month period ${period} closed on day ${monthCutoffDay} ` +
          `of the current month (today is day ${day}). Batches for past months ` +
          `can no longer be created or confirmed.`,
      );
    }
  }

  /**
   * Mirror of the FE safety-cap rule (credits-payouts-parser.ts ~L219): a POINTS-award
   * row's whole-points value may not exceed `safetyCapPoints`; a PAYOUT-award row's
   * rupee value (row.amount is integer PAISE → ÷100 rupees) may not exceed `safetyCapInr`.
   * Only OK rows are checked (ERROR/SKIP rows carry no live award). Rejects naming the
   * offending outlet/field so the admin can locate the row.
   */
  private assertWithinSafetyCaps(
    rows: { outletId: string; outletName?: string; fieldName?: string; amount: number; awardType: string; status: string }[],
    safetyCapPoints: number,
    safetyCapInr: number,
  ): void {
    for (const r of rows) {
      if (r.status !== 'OK') continue;
      const who = `${r.outletName ?? r.outletId} (${r.outletId})${r.fieldName ? ` / field "${r.fieldName}"` : ''}`;
      if (r.awardType === 'POINTS') {
        if (r.amount > safetyCapPoints) {
          throw new BadRequestException(
            `Row for ${who} awards ${r.amount} points, exceeding the safety cap of ${safetyCapPoints} points.`,
          );
        }
      } else if (r.awardType === 'PAYOUT') {
        // row.amount is integer paise; the cap is in rupees.
        const rupees = r.amount / 100;
        if (rupees > safetyCapInr) {
          throw new BadRequestException(
            `Row for ${who} awards ₹${rupees.toFixed(2)}, exceeding the safety cap of ₹${safetyCapInr}.`,
          );
        }
      }
    }
  }

  /**
   * Whole-unit safety net (owner rule 2026-11-12): points AND ₹ payouts are credited in WHOLE
   * units only. The upload parser rounds half-up before sending; this rejects anything that
   * bypassed it (direct API call, an older client, a legacy PENDING batch). POINTS rows must
   * be integers; PAYOUT rows (integer paise) must be a multiple of 100 (= whole rupees).
   * Only OK rows are checked — ERROR/SKIP rows carry no live award.
   */
  private assertWholeUnitAmounts(
    rows: { outletId: string; outletName?: string; fieldName?: string; amount: number; awardType: string; status: string }[],
  ): void {
    for (const r of rows) {
      if (r.status !== 'OK') continue;
      const who = `${r.outletName ?? r.outletId} (${r.outletId})${r.fieldName ? ` / field "${r.fieldName}"` : ''}`;
      if (r.awardType === 'PAYOUT') {
        if (!Number.isInteger(r.amount) || r.amount % 100 !== 0) {
          throw new BadRequestException(
            `Payout amounts must be whole rupees — row for ${who} has ₹${(r.amount / 100).toFixed(2)}.`,
          );
        }
      } else if (r.awardType === 'POINTS') {
        if (!Number.isInteger(r.amount)) {
          throw new BadRequestException(`Points must be whole numbers — row for ${who} has ${r.amount}.`);
        }
      }
    }
  }

  /**
   * Upload deductions (UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md), run ONLY when the tenant's switch is ON and the batch
   * carries a negative row: a negative PAYOUT row is refused ("deduct via Reversals"); a negative POINTS row's MAGNITUDE
   * counts against the points safety cap; a negative `originalAmount` (typed value) is only valid on a deduction row;
   * and one (outlet, field) can't be both a credit and a deduction in one batch (undo is per line).
   */
  private assertDeductionRows(
    rows: { outletId: string; outletName?: string; fieldId?: string; fieldName?: string; amount: number; awardType: string; status: string; originalAmount?: number }[],
    safetyCapPoints: number,
  ): void {
    const sign = new Map<string, number>();
    for (const r of rows) {
      if (r.status !== 'OK') continue;
      const who = `${r.outletName ?? r.outletId} (${r.outletId})${r.fieldName ? ` / field "${r.fieldName}"` : ''}`;
      if (r.awardType === 'PAYOUT' && r.amount < 0) {
        throw new BadRequestException(`Payout amounts can't be negative — use Reverse on Payout Status. Row for ${who} has ₹${(r.amount / 100).toFixed(2)}.`);
      }
      if (typeof r.originalAmount === 'number' && r.originalAmount < 0 && !(r.awardType === 'POINTS' && r.amount < 0)) {
        throw new BadRequestException(`Row for ${who}: a negative typed amount is only allowed on a points deduction.`);
      }
      if (r.awardType !== 'POINTS' || r.amount === 0) continue;
      if (r.amount < 0 && -r.amount > safetyCapPoints) {
        throw new BadRequestException(
          `Row for ${who} deducts ${-r.amount} points, exceeding the safety cap of ${safetyCapPoints} points.`,
        );
      }
      const k = `${r.outletId}|${r.fieldId ?? ''}`;
      const s = Math.sign(r.amount);
      const prev = sign.get(k);
      if (prev !== undefined && prev !== s) {
        throw new BadRequestException(
          `Row for ${who} is both a credit and a deduction in this batch — put one net value per outlet and field.`,
        );
      }
      sign.set(k, s);
    }
  }

  /**
   * Owner decision D1 (2026-11-25, PLATFORM-WIDE — every tenant, create AND confirm so an older pending batch is covered
   * too): an OK row must carry a real amount. An OK PAYOUT row ≤ 0, an OK row of amount 0, and an OK POINTS row < 0 while
   * the tenant's upload-deductions switch is OFF are refused with a clear 400 (before: silently ignored, or a negative
   * payout entry). The former DTO rule `originalAmount ≥ 0` lives here too (a negative typed amount only on a deduction).
   * With the switch ON, the deduction rules follow (assertDeductionRows).
   */
  private assertRowAmounts(
    rows: { outletId: string; outletName?: string; fieldId?: string; fieldName?: string; amount: number; awardType: string; status: string; originalAmount?: number }[],
    deductionsOn: boolean,
    safetyCapPoints: number,
  ): void {
    for (const r of rows) {
      if (r.status !== 'OK') continue;
      const who = `${r.outletName ?? r.outletId} (${r.outletId})${r.fieldName ? ` / field "${r.fieldName}"` : ''}`;
      if (r.amount === 0 && uploadAckScope({ deductionsEnabled: deductionsOn }).refuseZeroRows) {
        throw new BadRequestException(`Row for ${who} is marked OK but its amount is 0 — nothing to credit. Re-upload the file.`);
      }
      if (r.awardType === 'PAYOUT' && r.amount < 0) {
        throw new BadRequestException(
          `Payout amounts can't be negative — use Reverse on Payout Status. Row for ${who} has ₹${(r.amount / 100).toFixed(2)}.`,
        );
      }
      if (r.awardType === 'POINTS' && r.amount < 0 && !deductionsOn) {
        throw new BadRequestException(
          `Deductions are switched off for this client — remove the negative rows or ask Gifsy. Row for ${who} has ${r.amount} points.`,
        );
      }
      if (typeof r.originalAmount === 'number' && r.originalAmount < 0 && !(deductionsOn && r.awardType === 'POINTS' && r.amount < 0)) {
        throw new BadRequestException('originalAmount must not be less than 0');
      }
    }
    if (deductionsOn && rows.some((r) => r.status === 'OK' && r.awardType === 'POINTS' && r.amount < 0)) {
      this.assertDeductionRows(rows, safetyCapPoints);
    }
  }

  /** The switch is read only when the batch carries a negative OK POINTS row (an ordinary batch makes no extra read). */
  private async deductionsOnFor(clientId: string, rows: { amount: number; awardType: string; status: string }[]): Promise<boolean> {
    if (!rows.some((r) => r.status === 'OK' && r.awardType === 'POINTS' && r.amount < 0)) return false;
    return this.tenantSettings.getCreditUploadNegativeDeductionsUncached(clientId);
  }

  // ─── POST /v1/admin/credits/upload-preview ─────────────────────────────────
  /**
   * The upload preview's server read (every tenant — owner rule 2026-11-25 "no silent failure"): per POINTS outlet of the
   * file whether it resolves / is linked (a row that won't be credited or deducted), its wallet (F5 — outlets of one
   * partner share a wallet), balance, PENDING held opening balance (F6) and deduction readiness; plus, when the
   * deductions switch is ON, earlier CONFIRMED deductions of the same outlet + field + period (L4 — possible repeats).
   * Read-only, tenant-scoped.
   */
  async uploadPreview(user: JwtPayload, dto: { outletCodes: string[]; period?: string; lines?: { outletCode: string; fieldId: string }[] }) {
    const deductionsEnabled = await this.tenantSettings.getCreditUploadNegativeDeductionsUncached(user.clientId);
    const outlets = await this.walletService.uploadDeductionReadiness(user.clientId, dto.outletCodes ?? []);
    const priorDeductions =
      deductionsEnabled && dto.period && (dto.lines?.length ?? 0) > 0
        ? await this.priorDeductions(this.prisma, user.clientId, dto.period, dto.lines ?? [], null)
        : [];
    // The ONE place deciding which categories this client must tick (upload-ack-scope.ts) — the screen follows it.
    const ackCategories = uploadAckScope({ deductionsEnabled }).categories;
    return { deductionsEnabled, ackCategories, outlets, priorDeductions };
  }

  /**
   * L4: confirmed upload deductions of the same outlet + field + period in OTHER batches of this tenant (possible repeat).
   * Wallet rows carry no clientId — scoped through their batch (referenceId → credit_batches.clientId).
   */
  private async priorDeductions(
    db: Prisma.TransactionClient,
    clientId: string,
    period: string,
    lines: { outletCode: string; fieldId: string }[],
    excludeBatchId: string | null,
  ): Promise<Array<{ outletCode: string; fieldId: string; batchId: string; batchCode: string; confirmedAt: Date | null; points: number; givenBack: number }>> {
    const want = new Set(lines.map((l) => `${l.outletCode}|${l.fieldId}`));
    if (want.size === 0) return [];
    const rows =
      (await db.walletTransaction.findMany({
        where: {
          transactionType: 'DEBIT_ADJUSTMENT',
          referenceType: 'CREDIT_BATCH',
          metadata: { path: ['period'], equals: period },
          ...(excludeBatchId ? { referenceId: { not: excludeBatchId } } : {}),
        },
        select: { id: true, referenceId: true, points: true, metadata: true },
      })) ?? [];
    const hits = rows.filter((r) => {
      const m = r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata) ? (r.metadata as Record<string, unknown>) : null;
      return m?.kind === 'UPLOAD_DEDUCTION' && m.period === period && want.has(`${m.outletCode}|${m.fieldId}`) && !!r.referenceId;
    });
    if (hits.length === 0) return [];
    const batches = await db.creditBatch.findMany({
      where: { clientId, id: { in: [...new Set(hits.map((h) => h.referenceId!))] } },
      select: { id: true, batchCode: true, confirmedAt: true },
    });
    const byId = new Map((batches ?? []).map((b) => [b.id, b]));
    // U5: net of give-backs — a fully undone deduction is no repeat risk; a partial one shows what is still deducted.
    const undo = (await db.walletTransaction.findMany({
      where: { reversedCreditTxId: { in: hits.map((h) => h.id) }, transactionType: 'CREDIT_REVERSAL' },
      select: { reversedCreditTxId: true, points: true },
    })) ?? [];
    const back = new Map<string, number>();
    for (const u of undo) if (u.reversedCreditTxId) back.set(u.reversedCreditTxId, (back.get(u.reversedCreditTxId) ?? 0) + u.points);
    return hits
      .filter((h) => byId.has(h.referenceId!) && Math.abs(h.points) - (back.get(h.id) ?? 0) > 0)
      .map((h) => {
        const m = h.metadata as Record<string, unknown>;
        const b = byId.get(h.referenceId!)!;
        const givenBack = back.get(h.id) ?? 0;
        return {
          outletCode: String(m.outletCode), fieldId: String(m.fieldId), batchId: b.id, batchCode: b.batchCode,
          confirmedAt: b.confirmedAt ?? null, points: Math.abs(h.points) - givenBack, givenBack,
        };
      });
  }

  /**
   * Owner rule 2026-11-25 ("no silent failure"): every category of the batch that will NOT be applied as typed must have
   * been acknowledged by the admin in the preview. The server re-derives what it can see — ROUNDED (rows carrying the
   * typed value), NOT_APPLIED (points rows whose outlet doesn't resolve / isn't linked), BELOW_ZERO (deductions taking a
   * wallet below zero), REPEAT_DEDUCTION (same outlet + field + period deducted in another confirmed batch). SKIPPED
   * (blank / zero rows) never reaches the server (only OK rows are saved), so it is recorded as reported. Refuses (400)
   * naming every missing category; nothing is credited.
   */
  private async requiredAcknowledgements(
    db: Prisma.TransactionClient,
    clientId: string,
    batchId: string,
    period: string,
    rows: { outletId: string; fieldId: string; fieldName?: string; amount: number; awardType: string; status: string; originalAmount?: number }[],
    deductRows: { outletId: string; fieldId: string; amount: number }[],
    deductionsEnabled: boolean,
  ): Promise<Partial<Record<UploadAckCategory, AckItem[]>>> {
    const all = await this.presentAckItems(db, clientId, batchId, period, rows, deductRows);
    // The ONE place deciding which categories this client must tick (upload-ack-scope.ts).
    const scope = new Set(uploadAckScope({ deductionsEnabled }).categories);
    return Object.fromEntries(Object.entries(all).filter(([c]) => scope.has(c as UploadAckCategory))) as Partial<Record<UploadAckCategory, AckItem[]>>;
  }

  /**
   * Every category the batch actually has, as the EXACT items the admin must have ticked (UI audit U1, round 3 — a tick
   * binds to these items, not to the wording). Item keys (the screen builds the same keys from the same data):
   *   ROUNDED          `${outletId}|${fieldId}|${awardType}|${amount}|${originalAmount}`
   *   NOT_APPLIED      `${outletId}|${fieldId}`
   *   BELOW_ZERO       `${partnerId}|${after}` — one wallet per partner (stable even for a wallet the confirm creates)
   *   REPEAT_DEDUCTION `${outletCode}|${fieldId}|${batchId}|${points still deducted}`
   * BELOW_ZERO after = balance + held opening balance (when it posts first) + this file's credits − min(points due to
   * expire, what the balance then backs — the deduction expires them AFTER the credits land, U5) + deductions.
   */
  private async presentAckItems(
    db: Prisma.TransactionClient,
    clientId: string,
    batchId: string,
    period: string,
    rows: { outletId: string; fieldId: string; fieldName?: string; amount: number; awardType: string; status: string; originalAmount?: number }[],
    deductRows: { outletId: string; fieldId: string; amount: number }[],
  ): Promise<Partial<Record<UploadAckCategory, AckItem[]>>> {
    const req: Partial<Record<UploadAckCategory, AckItem[]>> = {};
    const ok = rows.filter((r) => r.status === 'OK');
    // Screen format: Indian grouping and a real minus sign (−).
    const fmt = (n: number) => `${n < 0 ? '−' : ''}${new Intl.NumberFormat('en-IN').format(Math.abs(n))}`;
    const rounded = ok.filter((r) => typeof r.originalAmount === 'number');
    if (rounded.length > 0) {
      req.ROUNDED = rounded.map((r) => ({
        key: `${r.outletId}|${r.fieldId}|${r.awardType}|${r.amount}|${r.originalAmount}`,
        text: `${r.outletId} · ${r.fieldName ?? r.fieldId}: ${r.awardType === 'PAYOUT' ? `₹${fmt(r.originalAmount as number)}` : `${fmt(r.originalAmount as number)} pts`} → ${r.awardType === 'PAYOUT' ? `₹${fmt(r.amount / 100)}` : `${fmt(r.amount)} pts`}`,
      }));
    }
    const pointsRows = ok.filter((r) => r.awardType === 'POINTS' && r.amount !== 0);
    if (pointsRows.length > 0) {
      const outlets = await db.outlet.findMany({
        where: { clientId, outletCode: { in: [...new Set(pointsRows.map((r) => r.outletId))] }, deletedAt: null },
        select: { outletCode: true, partnerId: true },
      });
      const found = new Map((outlets ?? []).map((o) => [o.outletCode, o.partnerId]));
      const notApplied = pointsRows.filter((r) => !found.get(r.outletId));
      if (notApplied.length > 0) {
        req.NOT_APPLIED = notApplied.map((r) => ({
          key: `${r.outletId}|${r.fieldId}`,
          text: `${r.outletId} · ${r.fieldName ?? r.fieldId}: ${found.has(r.outletId) ? 'outlet not linked to a partner' : 'outlet not found'} — ${fmt(r.amount)} pts not ${r.amount < 0 ? 'deducted' : 'credited'}`,
        }));
      }
    }
    if (deductRows.length > 0) {
      const readiness = await this.walletService.uploadDeductionReadiness(clientId, pointsRows.map((r) => r.outletId), db);
      const walletOf = new Map(readiness.map((o) => [o.outletCode, o]));
      // One wallet per partner (wallets.partnerId is unique) — the partner id is the stable key, also for a wallet this
      // confirm creates (the preview sees no wallet yet; the in-transaction check sees the new one).
      const keyOf = (o: (typeof readiness)[number]) => String(o.partnerId);
      const w = new Map<string, { start: number; due: number; credits: number; deductions: number; outlets: string[] }>();
      for (const o of readiness) {
        if (!o.linked) continue;
        const k = keyOf(o);
        const cur = w.get(k) ?? { start: (o.balance ?? 0) + (o.heldOpeningBalance ?? 0), due: o.dueExpiry ?? 0, credits: 0, deductions: 0, outlets: [] };
        if (!cur.outlets.includes(o.outletCode)) cur.outlets.push(o.outletCode);
        w.set(k, cur);
      }
      for (const r of pointsRows) {
        const o = walletOf.get(r.outletId);
        if (!o?.linked) continue;
        const cur = w.get(keyOf(o))!;
        if (r.amount > 0) cur.credits += r.amount;
        else cur.deductions += -r.amount;
      }
      const below: AckItem[] = [];
      for (const [k, v] of w) {
        if (v.deductions === 0) continue; // only wallets this file deducts from
        const beforeDeduct = v.start + v.credits;
        const expired = Math.min(v.due, Math.max(0, beforeDeduct));
        const after = beforeDeduct - expired - v.deductions;
        if (after < 0) {
          below.push({
            key: `${k}|${after}`,
            text: `Wallet of ${v.outlets.sort().join(', ')}: ${fmt(v.start)} pts → ${fmt(after)} pts${expired > 0 ? ` (after ${fmt(expired)} points expiring now are taken off)` : ''}`,
          });
        }
      }
      if (below.length > 0) req.BELOW_ZERO = below;
      const repeats = await this.priorDeductions(
        db, clientId, period, deductRows.map((r) => ({ outletCode: r.outletId, fieldId: r.fieldId })), batchId,
      );
      if (repeats.length > 0) {
        req.REPEAT_DEDUCTION = repeats.map((x) => ({
          key: `${x.outletCode}|${x.fieldId}|${x.batchId}|${x.points}`,
          text: `${x.outletCode}: already deducted in batch ${x.batchCode} (${fmt(x.points)} pts still deducted) — check this isn't a repeat`,
        }));
      }
    }
    // Off-portal payments register (owner 2026-11-26, reverse order of the off-portal PAID_ON_PORTAL check): a PAYOUT row
    // whose outlet was already paid the SAME amount outside the portal for this month (or within 3 days of it).
    const payoutRows = ok.filter((r) => r.awardType === 'PAYOUT' && r.amount > 0);
    const offPortalDb = (db as Partial<Prisma.TransactionClient>).offPortalPayment; // absent only on narrow test fakes
    if (payoutRows.length > 0 && offPortalDb && /^\d{4}-\d{2}$/.test(period)) {
      const { start, endExclusive } = istMonthBounds(period);
      const lo = new Date(start.getTime() - 3 * 86_400_000);
      const hi = new Date(endExclusive.getTime() + 3 * 86_400_000);
      const keys = [...new Set(payoutRows.map((r) => r.outletId.trim().toUpperCase()))];
      const live = await offPortalDb.findMany({
        where: { clientId, voidedAt: null, outletCodeKey: { in: keys }, OR: [{ period }, { paymentDate: { gte: lo, lt: hi } }] },
        select: { id: true, outletCodeKey: true, amountPaise: true, paymentDate: true, utr: true },
      });
      const hits: AckItem[] = [];
      for (const r of payoutRows) {
        const m = (live ?? []).find((p) => p.outletCodeKey === r.outletId.trim().toUpperCase() && p.amountPaise === BigInt(r.amount));
        if (m) {
          hits.push({
            key: `${r.outletId}|${r.fieldId}|${m.id}`,
            text: `${r.outletId} · ${r.fieldName ?? r.fieldId}: ₹${fmt(r.amount / 100)} — possible duplicate of an off-portal payment on ${istDateKey(m.paymentDate)}${m.utr ? ` (UTR ${m.utr})` : ''}`,
          });
        }
      }
      if (hits.length > 0) req.OFF_PORTAL_DUPLICATE = hits;
    }
    return req;
  }

  // ─── Code generators ───────────────────────────────────────────────────────

  /** Batch code: CB-YYYY-MM-NNN (per client + period). */
  // Codes are per-tenant-sequential and unique PER TENANT (@@unique([clientId, code])). Both
  // generators take the tx client and MUST be called under the per-(clientId, period) advisory
  // lock below, so two concurrent creates for the same tenant/period get sequential codes (no
  // P2002 race); a different tenant reusing the same code string is fine.
  private async generateBatchCode(tx: Prisma.TransactionClient, clientId: string, period: string): Promise<string> {
    const prefix = `CB-${period}`;
    const count = await tx.creditBatch.count({
      where: { clientId, batchCode: { startsWith: prefix } },
    });
    return `${prefix}-${String(count + 1).padStart(3, '0')}`;
  }

  /** Download code: PD-YYYY-MM-NNN (per client + period). */
  private async generateDownloadCode(tx: Prisma.TransactionClient, clientId: string, period: string): Promise<string> {
    const prefix = `PD-${period}`;
    const count = await tx.creditPayoutDownload.count({
      where: { clientId, downloadCode: { startsWith: prefix } },
    });
    return `${prefix}-${String(count + 1).padStart(3, '0')}`;
  }

  /** Fire-and-forget enqueue; never fails the request (mirrors the source). */
  private async notify(params: Parameters<NotificationsService['enqueue']>[0]): Promise<void> {
    await this.notifications.enqueue(params).catch(() => {
      // Non-critical: notification failures must not fail the request.
    });
  }

  // ─── GET /v1/admin/credits/batches ─────────────────────────────────────────
  // Server-side period filter (was client-side in the status page) + pagination.
  async listBatches(user: JwtPayload, q: ListBatchesQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const skip = (page - 1) * limit;

    // Tenant scope is never widened; the optional YYYY-MM period filter is applied here.
    const where: Prisma.CreditBatchWhereInput = { clientId: user.clientId };
    if (q.period) where.period = q.period;

    const [batches, total] = await Promise.all([
      this.prisma.creditBatch.findMany({
        where,
        orderBy: { uploadedAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          batchCode: true,
          period: true,
          status: true,
          uploadedBy: true,
          uploadedAt: true,
          confirmedBy: true,
          confirmedAt: true,
          totalOutlets: true,
          totalPoints: true,
          totalPayoutPaise: true,
        },
      }),
      this.prisma.creditBatch.count({ where }),
    ]);

    return { batches, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  // ─── POST /v1/admin/credits/batches ────────────────────────────────────────
  /**
   * Create a PENDING_CONFIRM credit batch from parsed rows.
   *
   * `source` (optional) tags a programmatically-created batch (the Points Compute Engine direct-credit
   * path, Wave 2) with a provenance kind + a deterministic idempotency key. When a key is given, a batch
   * already carrying that (clientId, sourceKey) is returned UNCHANGED instead of a second batch being
   * created — so re-submitting the identical compute run (double-click, retry) cannot double-credit.
   * Ordinary operator uploads pass no source (both columns stay null; multiple uploads per period are
   * unaffected — NULL sourceKeys are distinct). Caps + the upload window are enforced for BOTH paths.
   */
  async createBatch(
    user: JwtPayload,
    dto: CreateBatchDto,
    source?: { kind: string; key: string },
  ) {
    // Load per-tenant settings and ENFORCE the safety caps + month-cutoff window
    // server-side (these were FE-only and bypassable via direct API).
    const { creditsPayouts } = await this.tenantSettings.getEffectiveSettings(user.clientId);
    // NOTE: creditsPayouts.fourEyesEnabled is intentionally NOT enforced here — the
    // maker-checker approval workflow is DEFERRED to post-go-live (no UI toggle exists yet).
    this.assertWithinUploadWindow(dto.period, creditsPayouts.monthCutoffDay);
    this.assertWithinSafetyCaps(
      dto.rows,
      creditsPayouts.safetyCapPoints,
      creditsPayouts.safetyCapInr,
    );
    this.assertWholeUnitAmounts(dto.rows);
    // D1 (every tenant) + upload deductions (switch read only when a negative POINTS row is present).
    this.assertRowAmounts(dto.rows, await this.deductionsOnFor(user.clientId, dto.rows), creditsPayouts.safetyCapPoints);

    // Generate the code + create UNDER a per-(clientId, period) advisory lock so concurrent
    // createBatch calls for the same tenant/period serialize into sequential codes (batchCode is
    // now unique per tenant, not globally — a different tenant reusing CB-<period>-001 is fine).
    // The SAME lock serializes idempotency: two concurrent commits of one run can't both pass the
    // sourceKey check-then-create (the second waits, then finds the first's batch and returns it).
    const batch = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`CBATCH|${user.clientId}|${dto.period}`}, 0))`;
      if (source?.key) {
        // Idempotent: the IDENTICAL run already has a batch → return it unchanged, so an accidental
        // re-submit of the same run (double-click / retry) never creates a second batch.
        //
        // Cross-batch / cross-path overlap is deliberately NOT blocked here (Option A — platform-consistent,
        // owner decision 2026-10-03). The credits rail has always allowed multiple batches per period
        // (corrections, a 2nd program/filter, top-ups) and relies on the maker-checker CONFIRM step +
        // operator judgement; a hard per-period block over-blocked all of those (and, since a reversal
        // never flips CreditBatch.status, permanently blocked reverse-then-recredit). Instead, the engine
        // surfaces a WARNING when the period already has credit batches (commitCompute →
        // priorBatchesThisPeriod) and confirm remains the money gate — matching how manual uploads behave.
        const sameRun = await tx.creditBatch.findFirst({
          where: { clientId: user.clientId, sourceKey: source.key },
        });
        if (sameRun) return sameRun;
      }
      const batchCode = await this.generateBatchCode(tx, user.clientId, dto.period);
      return tx.creditBatch.create({
        data: {
          clientId: user.clientId,
          batchCode,
          period: dto.period,
          uploadedBy: user.sub ?? '',
          totalOutlets: dto.totalOutlets,
          // totalPoints is whole points (a count, NOT money — no ×100).
          totalPoints: dto.totalPoints,
          // totalPayoutPaise: integer paise received from the client; stored as BigInt.
          totalPayoutPaise: toPaiseBigInt(dto.totalPayoutPaise),
          // rows JSON stores per-row `amount` in paise (PAYOUT) or whole points (POINTS).
          rows: dto.rows as unknown as Prisma.InputJsonValue,
          sourceKind: source?.kind ?? null,
          sourceKey: source?.key ?? null,
        },
      });
    });

    return batch;
  }

  // ─── GET /v1/admin/credits/batches/:id ─────────────────────────────────────
  async getBatch(user: JwtPayload, id: string) {
    const batch = await this.prisma.creditBatch.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!batch) throw new NotFoundException('Batch not found');
    // Owner rule (no silent failure) — for batches confirmed after it: what was not applied and what was acknowledged.
    const confirmRow = await this.prisma.auditLog.findFirst({
      where: { entityType: CREDIT_BATCH_CONFIRM_ENTITY, entityId: id },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    });
    const m = confirmRow?.metadata && typeof confirmRow.metadata === 'object' && !Array.isArray(confirmRow.metadata)
      ? (confirmRow.metadata as Record<string, unknown>)
      : null;
    // F3: Payout Status labels deduction rows / offers Undo from the ACTUAL wallet deduction rows, not the batch rows.
    const hasNegative = (Array.isArray(batch.rows) ? (batch.rows as Array<Record<string, unknown>>) : []).some(
      (r) => r?.awardType === 'POINTS' && r?.status === 'OK' && typeof r?.amount === 'number' && (r.amount as number) < 0,
    );
    const deductionLines = hasNegative ? await this.walletService.uploadDeductionLinesOfBatch(this.prisma, id) : null;
    return {
      ...batch,
      ...(m ? { notApplied: Array.isArray(m.notApplied) ? m.notApplied : [], acknowledged: Array.isArray(m.acknowledged) ? m.acknowledged : [] } : {}),
      ...(deductionLines ? { deductionLines } : {}),
    };
  }

  // ─── POST /v1/admin/credits/batches/:id/confirm ────────────────────────────
  async confirmBatch(user: JwtPayload, id: string, ack: UploadAck = {}) {
    try {
      return await this.confirmBatchOnce(user, id, ack);
    } catch (e) {
      // Audit #5: a REFUSED confirm leaves a record too (missing acknowledgements, the row guards, held balances, an
      // unprepared wallet, the upload window …) — written after the refused transaction rolled back. Best effort.
      const raceOrDone = e instanceof HttpException && /^Batch (is )?already /.test(e.message);
      // ReversalAttentionException (an unprepared wallet) is already audited as REVERSAL_ENGINE_REFUSAL — never twice.
      if (e instanceof HttpException && !(e instanceof NotFoundException) && !(e instanceof ReversalAttentionException) && !raceOrDone) {
        const body = e.getResponse();
        const message = typeof body === 'string' ? body : String((body as { message?: unknown }).message ?? e.message);
        const details = typeof body === 'object' && body ? (body as { details?: { missingAcknowledgements?: unknown } }).details : undefined;
        await Promise.resolve()
          .then(() => this.prisma.auditLog.create({
            data: {
              action: 'REJECT',
              entityType: 'CREDIT_BATCH',
              entityId: id,
              actorId: user.sub,
              metadata: JSON.parse(JSON.stringify({
                event: 'CREDIT_BATCH_CONFIRM_REFUSED',
                clientId: user.clientId,
                status: e.getStatus(),
                reason: message,
                missingAcknowledgements: details?.missingAcknowledgements ?? null,
                acknowledged: ack.acknowledged ?? [],
              })) as Prisma.InputJsonValue,
            },
          }))
          .catch((err: unknown) => this.logger.warn(`confirm refusal audit failed for ${id}: ${(err as Error)?.message}`));
      }
      throw e;
    }
  }

  private async confirmBatchOnce(user: JwtPayload, id: string, ack: UploadAck) {
    // Read the batch first for its data (rows, period, etc.). The status-flip below
    // uses a guarded updateMany claim so a concurrent double-confirm cannot
    // double-credit points.
    const batch = await this.prisma.creditBatch.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!batch) throw new NotFoundException('Batch not found');
    if (batch.status !== 'PENDING_CONFIRM') {
      throw new BadRequestException(`Batch is already ${batch.status}`);
    }

    // Enforce the month-cutoff window on confirm too (a PENDING batch created before
    // the cutoff must not be confirmed after it has closed). fourEyesEnabled is
    // intentionally NOT enforced (deferred to post-go-live — see createBatch note).
    const { creditsPayouts } = await this.tenantSettings.getEffectiveSettings(user.clientId);
    this.assertWithinUploadWindow(batch.period, creditsPayouts.monthCutoffDay);

    // Resolve the tenant's TDS policy ONCE (W0-B). resolveTdsPolicy is fail-closed on a
    // malformed stored value — we deliberately do NOT catch it, so a bad policy aborts the
    // confirm BEFORE any money write. The VISIBILITY field ids classify each row's stream.
    const tdsPolicy = await this.tenantSettings.resolveTdsPolicy(user.clientId);
    const visibilityFields = await this.prisma.creditField.findMany({
      where: { clientId: user.clientId, payoutStream: 'VISIBILITY' },
      select: { id: true },
    });
    const visibilityFieldIds = new Set(visibilityFields.map((f) => f.id));

    // Parse rows from JSON.
    const rows = batch.rows as unknown as {
      rowNum?: number;
      outletId: string;
      outletName: string;
      fieldId: string;
      fieldName: string;
      amount: number;
      narration: string;
      awardType: string;
      status: string;
      originalAmount?: number;
    }[];

    // Whole-unit safety net on confirm too: a PENDING batch stored before the rounding rule
    // (e.g. ₹199.5 = 19950 paise) must be re-uploaded, never credited with fractional units.
    this.assertWholeUnitAmounts(rows);

    const payoutRows = rows.filter((r) => r.awardType === 'PAYOUT' && r.status === 'OK');
    // amount > 0: creditEarn rejects non-positive amounts; a 0/negative POINTS row
    // would throw inside the tx and roll back the whole confirm (incl. PAYOUT entries).
    const pointsRows = rows.filter(
      (r) => r.awardType === 'POINTS' && r.status === 'OK' && r.amount > 0,
    );
    // D1 (every tenant, covers batches created before the guard) + upload DEDUCTIONS (UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md):
    // negative POINTS rows are deducted only when the tenant's switch is ON; with it OFF the confirm is REFUSED (F3 —
    // never silently ignored). The switch is read only when such a row exists.
    const deductionsOn = await this.deductionsOnFor(user.clientId, rows);
    this.assertRowAmounts(rows, deductionsOn, creditsPayouts.safetyCapPoints);
    const deductRows = deductionsOn ? rows.filter((r) => r.awardType === 'POINTS' && r.status === 'OK' && r.amount < 0) : [];

    // Owner rule 2026-11-25 (no silent failure): every category this batch won't apply as typed must have been
    // acknowledged in the preview. Operator uploads only — a programmatic batch (points engine, sourceKind set) has its
    // own compute preview. Recorded in the confirm audit row (same transaction as the money writes).
    const acknowledged = [...new Set((ack.acknowledged ?? []).filter((c): c is UploadAckCategory => UPLOAD_ACK_CATEGORIES.includes(c as UploadAckCategory)))];
    // Audit #5: the required set is computed INSIDE the confirm transaction, under the wallet locks (see below).
    let required: Partial<Record<UploadAckCategory, AckItem[]>> = {};
    // Rows that genuinely cannot be credited, WITH a reason surfaced to the admin
    // (never dropped silently). The only remaining skip causes are an unresolvable
    // outlet code or an outlet not linked to any partner — a missing wallet is no
    // longer a skip (we create it; see below).
    const skipped: {
      outletId: string;
      fieldName: string;
      points: number;
      reason: 'OUTLET_NOT_FOUND' | 'OUTLET_NOT_LINKED_TO_PARTNER';
      /** only on a skipped upload DEDUCTION (its points are negative) */
      kind?: 'DEDUCTION';
    }[] = [];
    // Upload deductions actually applied (confirm response + post-commit notice).
    const deductionsApplied: { outletId: string; fieldName: string; points: number; balanceBefore: number; balanceAfter: number }[] = [];
    const deductedByPartner = new Map<string, { points: number; fields: string[]; reasons: string[]; balanceAfter: number }>();
    let pointsCredited = 0; // count of credited rows
    let pointsCreditedTotal = 0; // sum of credited points
    // Collected for the best-effort PUSH "points earned" trigger AFTER commit. We
    // sum per partner so a partner credited under several fields gets one push.
    const creditedByPartner = new Map<string, number>();

    // HELD OPENING BALANCES (client migration): BEFORE this confirm's transaction, a held vendor balance for a target
    // outlet whose wallet is missing or still EMPTY is applied in its OWN transaction (the wallet is created first if
    // needed) — so the dated history always sits UNDER this credit. Audit A2: if a held balance does NOT post (it is
    // RETRYING / FAILED, or the check itself errored), the confirm is REFUSED with the outlets and reasons — nothing
    // is credited, the batch stays PENDING_CONFIRM, and the admin retries once Gifsy fixes / applies / cancels the held
    // row. A credit never lands on an empty wallet over a not-yet-posted held passbook. Dormant (one indexed count)
    // for every tenant without live held rows.
    if (pointsRows.length > 0 || deductRows.length > 0) {
      let blocking: { outletCode: string; reason: string }[] = [];
      try {
        blocking = (
          await prepareHeldBeforeCredit(this.prisma, {
            clientId: user.clientId,
            outletCodes: [...new Set([...pointsRows, ...deductRows].map((r) => r.outletId))],
            actorId: user.sub,
            ensureWallet: async (partnerId) => {
              await this.prisma.$transaction(async (tx) => {
                const accountId = await ensureOutletAccount(tx, partnerId);
                await tx.wallet.upsert({ where: { partnerId }, create: { partnerId, accountId }, update: {} });
              });
            },
          })
        ).blocking;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`[held-opening-balances] pre-confirm check failed for batch ${id}: ${msg}`);
        throw new ConflictException(
          `Held opening balance must post first — the check could not run (${msg}). Nothing was credited; retry the confirm in a minute.`,
        );
      }
      if (blocking.length > 0) {
        throw new ConflictException({
          message:
            `Held opening balance must post first — ${blocking.length} outlet(s) in this batch have a vendor opening balance that is not posted yet: ` +
            blocking.slice(0, 10).map((b) => `${b.outletCode} (${b.reason})`).join('; ') +
            (blocking.length > 10 ? `; …and ${blocking.length - 10} more` : '') +
            '. Nothing was credited and the batch is still waiting — retry after Gifsy posts or cancels them (Gifsy → Held Balances).',
          heldBlocking: blocking,
        });
      }
    }

    // Upload deductions — the WALLET_NOT_SEQUENCED gate, read-only BEFORE the transaction (UPLOAD-NEGATIVE-DEDUCTIONS
    // §3): a deduction can't land on a wallet with un-sequenced history (the pre-engine path floors at 0). Refuses the
    // WHOLE batch, naming every such outlet; audited for the attention banner. Re-checked under the wallet lock.
    if (deductRows.length > 0) {
      const readiness = await this.walletService.uploadDeductionReadiness(user.clientId, deductRows.map((r) => r.outletId));
      const notReady = readiness.filter((o) => o.found && o.linked && !o.ready);
      if (notReady.length > 0) {
        const e = new ReversalAttentionException(
          notReady.some((o) => o.code === 'WALLET_NEEDS_ATTENTION') ? 'WALLET_NEEDS_ATTENTION' : 'WALLET_NOT_SEQUENCED',
          deductionWalletNotReadyMessage(notReady.map((o) => o.outletCode)),
          {
            batchId: id,
            outlets: notReady.map((o) => ({ outletCode: o.outletCode, code: o.code, reason: o.reason })),
            // U2: the Gifsy next step lives only in the audit row / the Gifsy banner, never in the tenant's message.
            gifsyNextStep: BACKFILL_NEXT_STEP,
          },
        );
        await this.auditReversalRefusal(user, 'CONFIRM_DEDUCTION', id, e, { batchId: id });
        throw e;
      }
    }

    // Bulk money mutation over uploaded rows — raise the interactive-tx timeout (default 5s) so the ATOMIC transaction survives a full-tenant batch; must stay all-or-nothing (do NOT chunk — would risk partial/double credit).
    const updated = await this.prisma.$transaction(async (tx) => {
      // ── Concurrency guard ──────────────────────────────────────────────────
      // Replace the plain update with a conditional updateMany. Only the first
      // concurrent caller flips status PENDING_CONFIRM→CONFIRMED (count===1);
      // subsequent racing callers see count===0 and throw, preventing
      // double-crediting of wallet points.
      const claimed = await tx.creditBatch.updateMany({
        where: { id, status: 'PENDING_CONFIRM' },
        data: {
          status: 'CONFIRMED',
          confirmedBy: user.sub,
          confirmedAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        throw new BadRequestException('Batch already confirmed');
      }

      // Re-read to get the full record back (updateMany does not return the row).
      const confirmed = await tx.creditBatch.findFirst({ where: { id } });

      // ── PAYOUT rows → CreditPayoutEntry ───────────────────────────────────
      // NOTE (duplicate-outletCode safety): one CreditPayoutEntry is created per
      // PAYOUT row, so the same outletCode CAN produce multiple entries (e.g. an
      // outlet awarded under several credit fields). This does NOT double the
      // payout: createPayoutDownload groups entries by outletId and SUMS amountPaise
      // into a single bank-file line per outlet, so two entries become one payout
      // for their combined amount — the intended behaviour. No dedup needed here.
      if (payoutRows.length > 0) {
        await tx.creditPayoutEntry.createMany({
          data: payoutRows.map((r) => ({
            clientId: user.clientId,
            batchId: id,
            outletId: r.outletId,
            outletName: r.outletName,
            fieldId: r.fieldId,
            fieldName: r.fieldName,
            period: batch.period,
            // r.amount is integer paise (invariant: upload parser converts rupees→paise
            // before POSTing; the batch JSON therefore always stores paise for PAYOUT rows).
            amountPaise: toPaiseBigInt(r.amount),
            narration: r.narration ?? '',
            // FROZEN TDS treatment (W0-B): stamp BY VALUE at create; compute never re-reads
            // live config. INCENTIVE → 194R; VISIBILITY → the tenant's configured section.
            tdsSection: deriveFrozenSection(
              visibilityFieldIds.has(r.fieldId) ? 'VISIBILITY' : 'INCENTIVE',
              tdsPolicy.section,
            ),
            tdsMethodology: tdsPolicy.methodology,
          })),
        });

        // Invoice-at-CONFIRM (D12): generate the SERVICE invoice per visibility outlet + GST
        // holdback (D5), and stamp each visibility entry's autoInvoiceId — atomically in this
        // same tx. Idempotent (pre-checks the unique tuple; never a P2002-in-tx). Only
        // VISIBILITY entries are invoiced (INCENTIVE payouts are benefits-in-kind, not services).
        if (visibilityFieldIds.size > 0) {
          await this.invoicesService.generateForBatch(tx, {
            clientId: user.clientId,
            period: batch.period,
            batchId: id,
            visibilityFieldIds: [...visibilityFieldIds],
          });
        }
      }

      // Audit B9 (deadlock-free lock order, design §5): a POINTS reversal locks its wallets in ascending id order — so
      // the confirm takes every EXISTING target wallet's row lock up front in the SAME order (one statement) before
      // crediting in CSV order. The credits themselves (order, amounts) are unchanged. Every tenant (one engine since
      // 2026-11-21).
      if (pointsRows.length > 0 || deductRows.length > 0) {
        const codes = [...new Set([...pointsRows, ...deductRows].map((r) => r.outletId))];
        // B9 first: lock every EXISTING target wallet in ascending id (the reversal engine's order) — so the get-or-create
        // below never waits on an existing row.
        await tx.$queryRaw`SELECT w."id" FROM "wallets" w JOIN "outlets" o ON o."partnerId" = w."partnerId" WHERE o."clientId" = ${user.clientId} AND o."outletCode" = ANY(${codes}::text[]) ORDER BY w."id" FOR UPDATE OF w`;
        // Re-audit B8: two confirms that both create the SAME new wallets in CSV order can deadlock on the unique
        // partnerId insert. Create every missing target wallet first, in ascending partnerId order (the same
        // get-or-create the loop below does — ensureOutletAccount + upsert, a no-op for an existing wallet), so
        // concurrent confirms insert in one global order. The in-loop get-or-create then finds them.
        const owners = await tx.outlet.findMany({
          where: { clientId: user.clientId, outletCode: { in: codes } },
          select: { partnerId: true },
        });
        const partnerIdsSorted = [...new Set((owners ?? []).map((o) => o.partnerId).filter((p): p is string => !!p))].sort();
        for (const partnerId of partnerIdsSorted) {
          const accountId = await ensureOutletAccount(tx, partnerId);
          await tx.wallet.upsert({ where: { partnerId }, create: { partnerId, accountId }, update: {} });
        }
      }

      // Owner rule (no silent failure) — audit #5: the categories the admin must have ticked, derived HERE under the
      // wallet locks (balances can't move between this check and the writes). Refused (400) before any money write;
      // the claim above rolls back with it.
      required = batch.sourceKind
        ? {}
        : await this.requiredAcknowledgements(tx, user.clientId, id, batch.period, rows, deductRows, deductionsOn);
      // U1 (round 3): a tick binds to the EXACT items — refused when the items the server would apply now differ from the
      // ticked ones (a balance moved, a row changed). SKIPPED rows never reach the server: category tick only.
      const missing = (Object.keys(required) as UploadAckCategory[]).filter((c) => {
        if (!acknowledged.includes(c)) return true;
        if (c === 'SKIPPED') return false;
        const raw = ack.ackItems?.[c];
        const ticked = new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []);
        const want = (required[c] ?? []).map((x) => x.key);
        return ticked.size !== want.length || want.some((k) => !ticked.has(k));
      });
      if (missing.length > 0) {
        throw new BadRequestException({
          message:
            `Before confirming, reload the page and tick: ${missing.map((c) => `${UPLOAD_ACK_LABELS[c]} (${required[c]?.length ?? 0})`).join('; ')}. ` +
            'Nothing was credited or deducted — the batch is still waiting.',
          // U2 (round 3): the exact items to show with each box — never a box without its rows.
          details: { missingAcknowledgements: missing, items: Object.fromEntries(missing.map((c) => [c, required[c] ?? []])) },
        });
      }

      // ── POINTS rows → wallet creditEarn (gap #16) ────────────────────────
      // Each row is one ledger entry. Multiple rows for the same partner roll up
      // naturally in the wallet aggregate via successive creditEarn calls.
      // We skip rather than throw if no outlet/partner/wallet exists, so a bad row
      // cannot abort the whole confirm.
      for (const r of pointsRows) {
        // Resolve outletCode → partnerId (tenant-scoped). A row that cannot resolve
        // to a partner is skipped WITH a reason (surfaced to the admin), never dropped
        // silently.
        const outlet = await tx.outlet.findFirst({
          // deletedAt: null — a soft-deleted outlet never receives credits (same rule as the held-balance lookup).
          where: { outletCode: r.outletId, clientId: user.clientId, deletedAt: null },
          select: { partnerId: true },
        });
        if (!outlet) {
          skipped.push({
            outletId: r.outletId,
            fieldName: r.fieldName,
            points: r.amount,
            reason: 'OUTLET_NOT_FOUND',
          });
          continue;
        }
        if (!outlet.partnerId) {
          skipped.push({
            outletId: r.outletId,
            fieldName: r.fieldName,
            points: r.amount,
            reason: 'OUTLET_NOT_LINKED_TO_PARTNER',
          });
          continue;
        }

        // Get-or-create the wallet. Points ACCRUE even before KYC approval (Deoleo
        // runs non-KYC campaigns) — but a wallet is otherwise created only at KYC
        // approval, so pre-KYC credits were being silently skipped. `partnerId` is
        // @unique, so this upsert is race-safe; an existing wallet is left untouched.
        // Disbursement is still gated on KYC-APPROVED at payout time
        // (createPayoutDownload holds non-approved entries), so accruing points to a
        // not-yet-approved partner's wallet here is correct.
        // Employee Rewards Phase 1 — dual-write the unified account owner so a
        // newly-created wallet is account-linked from birth (idempotent; existing
        // wallets are back-filled separately). Outlet path otherwise unchanged.
        const walletAccountId = await ensureOutletAccount(tx, outlet.partnerId);
        await tx.wallet.upsert({
          where: { partnerId: outlet.partnerId },
          create: { partnerId: outlet.partnerId, accountId: walletAccountId },
          update: {},
        });

        // r.amount is whole points for POINTS rows.
        await this.walletService.creditEarn(
          outlet.partnerId,
          user.clientId,
          r.amount,
          {
            referenceType: 'CREDIT_BATCH',
            referenceId: id,
            sourceType: 'CREDIT_FIELD',
            sourceId: r.fieldId,
            description: r.narration ?? null,
            // Identifies this EXACT credit for a later per-(batch, outlet, field) reversal.
            metadata: { fieldId: r.fieldId, outletCode: r.outletId },
          },
          tx,
        );
        pointsCredited += 1;
        pointsCreditedTotal += r.amount;
        creditedByPartner.set(
          outlet.partnerId,
          (creditedByPartner.get(outlet.partnerId) ?? 0) + r.amount,
        );
      }

      // ── Upload DEDUCTIONS → wallet debit that may go below zero (UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md §3–4) ──
      // After every credit (the preview's "balance after" is the true end state), in CSV order, same transaction —
      // all or nothing with the credits. Skips (outlet not found / not linked) are reported like credit skips.
      for (const r of deductRows) {
        const outlet = await tx.outlet.findFirst({
          where: { outletCode: r.outletId, clientId: user.clientId, deletedAt: null },
          select: { partnerId: true },
        });
        if (!outlet || !outlet.partnerId) {
          skipped.push({
            outletId: r.outletId,
            fieldName: r.fieldName,
            points: r.amount,
            reason: !outlet ? 'OUTLET_NOT_FOUND' : 'OUTLET_NOT_LINKED_TO_PARTNER',
            kind: 'DEDUCTION',
          });
          continue;
        }
        const walletAccountId = await ensureOutletAccount(tx, outlet.partnerId);
        await tx.wallet.upsert({
          where: { partnerId: outlet.partnerId },
          create: { partnerId: outlet.partnerId, accountId: walletAccountId },
          update: {},
        });
        const moved = await this.walletService.debitUploadDeduction(tx, {
          partnerId: outlet.partnerId,
          points: -r.amount,
          batchId: id,
          outletCode: r.outletId,
          fieldId: r.fieldId,
          fieldName: r.fieldName,
          period: batch.period,
          rowNum: typeof r.rowNum === 'number' ? r.rowNum : null,
          narration: r.narration ?? null,
        });
        deductionsApplied.push({
          outletId: r.outletId,
          fieldName: r.fieldName,
          points: -r.amount,
          balanceBefore: moved.balanceBefore,
          balanceAfter: moved.balanceAfter,
        });
        const agg = deductedByPartner.get(outlet.partnerId) ?? { points: 0, fields: [], reasons: [], balanceAfter: 0 };
        agg.points += -r.amount;
        if (!agg.fields.includes(r.fieldName)) agg.fields.push(r.fieldName);
        const reason = r.narration?.trim();
        if (reason && !agg.reasons.includes(reason)) agg.reasons.push(reason);
        agg.balanceAfter = moved.balanceAfter;
        deductedByPartner.set(outlet.partnerId, agg);
      }

      // Owner rule (no silent failure): what the admin acknowledged + what was NOT applied, recorded with the money
      // writes (Payout Status reads it back — getBatch.notApplied / acknowledged).
      if (!batch.sourceKind) {
        await tx.auditLog.create({
          data: {
            action: 'APPROVE',
            entityType: CREDIT_BATCH_CONFIRM_ENTITY,
            entityId: id,
            actorId: user.sub,
            metadata: JSON.parse(JSON.stringify({
              clientId: user.clientId,
              acknowledged,
              required: Object.fromEntries(Object.entries(required).map(([c, items]) => [c, (items ?? []).length])),
              acknowledgedItems: Object.fromEntries(
                Object.entries(required).map(([c, items]) => [c, (items ?? []).slice(0, 1000).map((x) => x.key)]),
              ),
              skippedRowsReported: typeof ack.skippedRows === 'number' && ack.skippedRows >= 0 ? Math.floor(ack.skippedRows) : null,
              notApplied: skipped.slice(0, 5000),
              notAppliedCount: skipped.length,
              pointsCreditedTotal,
              pointsDeductedTotal: deductionsApplied.reduce((n, d) => n + d.points, 0),
            })) as Prisma.InputJsonValue,
          },
        });
      }

      return confirmed;
    }, { timeout: 180_000, maxWait: 20_000 }).catch(async (e: unknown) => {
      // A deduction refused under the wallet lock (un-sequenced wallet) — audited like the pre-check; nothing written.
      if (deductRows.length > 0 && e instanceof ReversalAttentionException) {
        await this.auditReversalRefusal(user, 'CONFIRM_DEDUCTION', id, e, { batchId: id });
      }
      throw e;
    });

    // Post-commit "points deducted" notice per charged partner — FREE channels only (bell + push): there is no approved
    // SMS / WhatsApp template for it (UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md §7). Never affects the confirmed batch.
    for (const [partnerId, d] of deductedByPartner) {
      try {
        const partner = await this.prisma.channelPartner.findFirst({ where: { id: partnerId }, select: { userId: true } });
        if (!partner?.userId) continue;
        const fmt = (n: number) => `${n < 0 ? '−' : ''}${new Intl.NumberFormat('en-IN').format(Math.abs(n))}`;
        await this.notifications.notifyUser({
          userId: partner.userId,
          subject: 'Points deducted',
          body:
            `${fmt(d.points)} points were deducted from your wallet — ${d.fields.join(', ')}, ${monthYearIST(batch.period)}` +
            `${d.reasons.length ? ` (${d.reasons.join('; ')})` : ''}. Your balance is now ${fmt(d.balanceAfter)} points.` +
            (d.balanceAfter < 0 ? ' You can redeem again once your balance is 0 or more.' : ''),
          url: '/partner/wallet',
          event: 'WALLET_POINTS_DEDUCTED',
          variables: { pointsDeducted: String(d.points), redeemableBalance: String(d.balanceAfter), period: batch.period },
        });
      } catch (e) {
        this.logger.warn(`[credit-notify] deduction notice failed for ${partnerId}: ${e}`);
      }
    }

    // Post-commit "points earned" notification per credited partner: IN_APP + PUSH to the
    // partner's login user, plus config-driven SMS/WhatsApp to the owner. Resolved AFTER commit
    // and wrapped so a notification failure can NEVER break the confirmed money path.
    try {
      for (const [partnerId, totalPoints] of creditedByPartner) {
        // Per-partner try/catch: the partner lookup lives OUTSIDE notifyPointsCredited's own guard,
        // so one partner's lookup (or notify) failure must skip ONLY that partner — never abort the
        // loop and silently starve every partner after it of their credit notification.
        try {
          // Owner identity for BOTH the free channels (userId) and the paid channels (ownerName + phone).
          const partner = await this.prisma.channelPartner.findFirst({
            where: { id: partnerId },
            select: { userId: true, ownerName: true, phone: true },
          });
          await this.notifyPointsCredited({
            userId: partner?.userId ?? null,
            clientId: user.clientId,
            partnerId,
            ownerName: partner?.ownerName ?? null,
            phone: partner?.phone ?? null,
            totalPoints,
            period: batch.period,
          });
        } catch (e) {
          // One partner's failure is isolated; the rest still get notified.
          this.logger.warn(`[credit-notify] per-partner fan-out failed for ${partnerId}: ${e}`);
        }
      }
    } catch {
      // Best-effort belt-and-suspenders: a notification failure must never affect a confirmed batch.
    }

    // Notify the team (fire-and-forget; don't block confirm on failure).
    // Recipients come from the tenant's creditsPayouts.notifyEmails; if that list is
    // empty we KEEP the legacy ops@gifsy.in fallback so notifications never silently stop.
    // totalPayoutPaise is a BigInt from Prisma — convert to rupees for the human-readable email.
    const recipientEmails =
      creditsPayouts.notifyEmails.length > 0
        ? creditsPayouts.notifyEmails
        : ['ops@gifsy.in'];
    for (const recipientEmail of recipientEmails) {
      await this.notify({
        userId: batch.uploadedBy,
        channel: 'EMAIL',
        recipientEmail,
        subject: `[Gifsy] New Batch Confirmed — ${user.clientId} — ${batch.period}`,
        body: `New batch ${id} confirmed for ${user.clientId} (period ${batch.period}).`,
        variables: {
          event: 'CREDITS_NEW_BATCH_CONFIRMED',
          tenantName: user.clientId,
          batchId: id,
          period: batch.period,
          totalOutlets: Number(batch.totalOutlets),
          totalPoints: Number(batch.totalPoints),
          // Express as rupees for the team email — humans read ₹, not paise.
          totalPayoutRupees: paiseToRupees(batch.totalPayoutPaise ?? 0n),
          uploadedBy: batch.uploadedBy,
          recipientEmails,
          // Upload deductions only (absent on every batch without them — the email is unchanged).
          ...(deductionsApplied.length > 0
            ? { totalPointsDeducted: deductionsApplied.reduce((n, d) => n + d.points, 0) }
            : {}),
        },
      });
    }

    return {
      batch: updated,
      payoutEntriesCreated: payoutRows.length,
      pointsCredited,
      pointsCreditedTotal,
      skipped,
      // Upload deductions (only when the batch had any — every other confirm response is unchanged).
      ...(deductRows.length > 0
        ? {
            pointsDeducted: deductionsApplied.length,
            pointsDeductedTotal: deductionsApplied.reduce((n, d) => n + d.points, 0),
            deductions: deductionsApplied,
          }
        : {}),
    };
  }

  // ─── GET /v1/admin/credits/batches/:id/reversals ───────────────────────────
  async listBatchReversals(user: JwtPayload, id: string) {
    const batch = await this.prisma.creditBatch.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!batch) throw new NotFoundException('Batch not found');

    return this.prisma.creditReversal.findMany({
      where: { batchId: id, clientId: user.clientId },
      orderBy: { requestedAt: 'desc' },
    });
  }

  // ─── POST /v1/admin/credits/batches/:id/reversals ──────────────────────────
  // Maker-checker: client requests, Gifsy approves.
  async createReversal(user: JwtPayload, id: string, dto: CreateReversalDto) {
    const batch = await this.prisma.creditBatch.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!batch) throw new NotFoundException('Batch not found');
    if (batch.status === 'PENDING_CONFIRM') {
      throw new BadRequestException('Cannot reverse a batch that has not been confirmed');
    }

    if (dto.requestedPaise > dto.originalPaise) {
      throw new BadRequestException(
        'Requested reversal amount cannot exceed original amount',
      );
    }

    // Input shape check for EVERY engine path (incl. the V2 POINTS path below): entry selection is PAYOUT-only.
    if (dto.payoutEntryIds !== undefined && dto.awardType !== 'PAYOUT') {
      throw new BadRequestException('Payout entries can only be chosen for a payout (₹) reversal');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Policy round A Q5: refused while the tenant's POINTS reversal approvals are paused (wallet backfill window).
        // One engine for every tenant (2026-11-21): a POINTS reversal is the position-based create — capped by the
        // credit positions, and REFUSED (WALLET_NOT_SEQUENCED / WALLET_NEEDS_ATTENTION) when a receiving wallet's
        // history is not sequenced. There is no other POINTS path.
        if (dto.awardType === 'POINTS') {
          await assertPointsReversalsNotPaused(tx, this.tenantSettings, user.clientId);
          // A deduction line (UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md §6): the request is an UNDO — gives the points back.
          const deductions = await this.walletService.findUploadDeductions(tx, { batchId: id, outletCode: dto.outletId, fieldId: dto.fieldId });
          if (deductions.length > 0) return this.createDeductionUndo(tx, user, id, batch.period, dto);
          return this.createPointsReversalV2(tx, user, id, batch.period, dto);
        }

        // Serialise every reversal create/approve for this batch (batch row lock) so the
        // Σ-reversed cap below can't be raced past by a concurrent create or approval.
        const credited = await this.lockBatchCreditedAmount(
          tx, id, user.clientId, dto.outletId, dto.fieldId, dto.awardType,
        );

        // Block a duplicate pending reversal for the same outlet+field in this batch.
        const existingPending = await tx.creditReversal.findFirst({
          where: {
            batchId: id,
            clientId: user.clientId,
            outletId: dto.outletId,
            fieldId: dto.fieldId,
            status: 'PENDING_GIFSY',
          },
        });
        if (existingPending) {
          throw new BadRequestException(
            'A pending reversal already exists for this outlet and field in this batch',
          );
        }

        // Σ (approved + pending) reversals for this (batch, outlet, field) + this request must
        // never exceed what the batch ACTUALLY credited for it (stored batch rows — never the
        // client-supplied originalPaise), so the same credit can't be clawed back twice.
        const alreadyReversed = await this.reversedSoFar(tx, id, dto.outletId, dto.fieldId, dto.awardType);
        const requested = toPaiseBigInt(dto.requestedPaise);
        if (credited === 0n) {
          throw new BadRequestException('Nothing was credited for this outlet and field in this batch');
        }
        if (alreadyReversed + requested > credited) {
          const f = (v: bigint) => this.fmtAward(dto.awardType, v);
          throw new BadRequestException(
            `Reversal exceeds the amount credited for this outlet and field in this batch (credited ${f(credited)}, already reversed or pending ${f(alreadyReversed)}, requested ${f(requested)})`,
          );
        }

        // WP5 (one engine for every tenant since 2026-11-21): a PAYOUT reversal names its WHOLE payout entries and
        // RESERVES them (Q9 / Q10) — the operator picks them on the screen; requested = Σ selected.
        let payoutReservation: Awaited<ReturnType<typeof selectPayoutEntriesV2>> | null = null;
        if (dto.awardType === 'PAYOUT') {
          // Through this tx (it holds the batch row lock — never a second pool connection meanwhile).
          payoutReservation = await selectPayoutEntriesV2(
            tx, { clientId: user.clientId, batchId: id, outletId: dto.outletId, fieldId: dto.fieldId },
            dto.payoutEntryIds, requested,
          );
        }

        // The DB partial-unique index `credit_reversals_pending_unique` on
        // (batchId,outletId,fieldId) WHERE status='PENDING_GIFSY' remains the authoritative
        // duplicate-pending guard — its P2002 is translated into the same clean 400 below.
        const created = await tx.creditReversal.create({
          data: {
            clientId: user.clientId,
            batchId: id,
            outletId: dto.outletId,
            outletName: dto.outletName,
            fieldId: dto.fieldId,
            fieldName: dto.fieldName,
            period: batch.period,
            awardType: dto.awardType,
            // Server-derived (BigInt paise from the stored batch rows, or whole points ACTUALLY
            // credited to wallets for POINTS) — never the client-supplied originalPaise.
            originalPaise: credited,
            requestedPaise: requested,
            requestedBy: user.sub,
            // Fix round B (owner D5, every tenant): the requester's typed remarks are kept (were dropped). Written
            // only when typed, so a request without remarks writes exactly what it did before (column default NULL).
            ...(cleanRemarks(dto.remarks) ? { requestRemarks: cleanRemarks(dto.remarks) } : {}),
          },
        });
        if (payoutReservation) {
          await reservePayoutEntries(tx, created.id, payoutReservation, {
            clientId: user.clientId, batchId: id, outletId: dto.outletId, fieldId: dto.fieldId, actorId: user.sub,
            remarks: cleanRemarks(dto.remarks),
          });
        }
        return created;
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new BadRequestException(
          'A pending reversal already exists for this outlet and field in this batch.',
        );
      }
      if (e instanceof ReversalAttentionException) {
        await this.auditReversalRefusal(user, 'CREATE', id, e, { outletId: dto.outletId, fieldId: dto.fieldId });
      }
      throw e;
    }
  }

  /**
   * Policy round A (owner rule "no silent pass-throughs"): a POINTS reversal refused because Gifsy must act
   * (wallet needs attention / credit unmapped / approvals paused) leaves an audit row — written AFTER the refused
   * transaction rolled back, on the service's own client. Best effort: an audit failure never masks the refusal.
   */
  private async auditReversalRefusal(
    user: JwtPayload,
    phase: 'CREATE' | 'APPROVE' | 'CONFIRM_DEDUCTION',
    entityId: string,
    e: ReversalAttentionException,
    extra: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'REJECT',
          entityType: 'REVERSAL_ENGINE_REFUSAL',
          entityId,
          actorId: user.sub,
          metadata: JSON.parse(
            JSON.stringify({ phase, code: e.code, message: e.message, clientId: user.clientId, ...extra, ...e.detail }),
          ) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(`reversal refusal audit failed (${e.code} on ${entityId}): ${(err as Error).message}`);
    }
  }

  // ─── Wallet Reversal Engine — POINTS reversals (the one engine for every tenant since 2026-11-21) ──────────
  // WALLET-REVERSAL-ENGINE-DESIGN.md §6.

  /**
   * POINTS create (§6 "create cap"): the reversal is capped by the credit POSITIONS of (batch, outlet, field) —
   * Σ(amount − reversedPoints) − Σ pending requested — on whichever wallet(s) received the credit (Q4: an outlet
   * relinked since is irrelevant). A receiving wallet whose history is not sequenced, no position, or an UNRESOLVED
   * credit that could be THIS outlet line's → refused with the reason (WalletService.v2PointsReversalCap). No debt
   * refusal: an over-reversal becomes debt, repaid from future earnings. Batch row lock + duplicate-pending guard.
   */
  private async createPointsReversalV2(
    tx: Prisma.TransactionClient,
    user: JwtPayload,
    batchId: string,
    period: string,
    dto: CreateReversalDto,
  ) {
    await tx.$queryRaw`SELECT id FROM credit_batches WHERE id = ${batchId} FOR UPDATE`;
    const existingPending = await tx.creditReversal.findFirst({
      where: { batchId, clientId: user.clientId, outletId: dto.outletId, fieldId: dto.fieldId, status: 'PENDING_GIFSY' },
    });
    if (existingPending) {
      throw new BadRequestException('A pending reversal already exists for this outlet and field in this batch');
    }
    const snap = await this.v2PointsCreateCapSnapshot(tx, { batchId, outletCode: dto.outletId, fieldId: dto.fieldId });
    const requested = toPaiseBigInt(dto.requestedPaise);
    if (requested <= 0n) throw new BadRequestException('Reversal amount must be a positive whole number of points');
    if (snap.pending + requested > snap.reversible) {
      throw new BadRequestException(
        `Reversal exceeds the amount still reversible for this outlet and field in this batch (credited ${snap.credited} pts, already reversed ${snap.credited - snap.reversible} pts, pending ${snap.pending} pts, requested ${requested} pts)`,
      );
    }
    const created = await tx.creditReversal.create({
      data: {
        clientId: user.clientId,
        batchId,
        outletId: dto.outletId,
        outletName: dto.outletName,
        fieldId: dto.fieldId,
        fieldName: dto.fieldName,
        period,
        awardType: dto.awardType,
        // Σ amount of the credit positions = what wallets ACTUALLY received for (batch, outlet, field).
        originalPaise: snap.credited,
        requestedPaise: requested,
        requestedBy: user.sub,
        ...(cleanRemarks(dto.remarks) ? { requestRemarks: cleanRemarks(dto.remarks) } : {}), // fix round B (D5)
      },
    });
    // Audit A1 (2026-11-21): the marker that this request was raised under the current (one) engine — in the same
    // transaction as the create. Approve refuses a POINTS reversal without it (RAISED_UNDER_OLD_ENGINE), so a request
    // raised under the retired LEGACY rules is never silently approved under the new ones. No schema change.
    await tx.auditLog.create({
      data: {
        action: 'CREATE',
        entityType: POINTS_REVERSAL_ENGINE_MARKER_ENTITY,
        entityId: created.id,
        actorId: user.sub,
        metadata: { engine: 'ONE_ENGINE_2026_11_21', clientId: user.clientId, batchId, outletId: dto.outletId, fieldId: dto.fieldId },
      },
    });
    return created;
  }

  /**
   * UNDO of an upload deduction (UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md §6) — the per-row reversal request of a deduction
   * line. Batch row lock; one pending request per line; cap = Σ deducted − Σ already given back − Σ pending; the
   * one-engine marker audit row (approve requires it), tagged kind UPLOAD_DEDUCTION_UNDO.
   */
  private async createDeductionUndo(
    tx: Prisma.TransactionClient,
    user: JwtPayload,
    batchId: string,
    period: string,
    dto: CreateReversalDto,
  ) {
    await tx.$queryRaw`SELECT id FROM credit_batches WHERE id = ${batchId} FOR UPDATE`;
    const existingPending = await tx.creditReversal.findFirst({
      where: { batchId, clientId: user.clientId, outletId: dto.outletId, fieldId: dto.fieldId, status: 'PENDING_GIFSY' },
    });
    if (existingPending) {
      throw new BadRequestException('A pending reversal already exists for this outlet and field in this batch');
    }
    const deductions = await this.walletService.findUploadDeductions(tx, { batchId, outletCode: dto.outletId, fieldId: dto.fieldId });
    // D2 (owner 2026-11-25): refused once later points repaid the deduction's debt (re-checked under the wallet lock at approve).
    const blocked = await this.walletService.uploadDeductionUndoBlocked(tx, { batchId, outletCode: dto.outletId, fieldId: dto.fieldId });
    if (blocked) throw new BadRequestException(blocked);
    const deducted = deductions.reduce((n, d) => n + d.points, 0);
    const givenBack = deductions.reduce((n, d) => n + d.givenBack, 0);
    const requested = toPaiseBigInt(dto.requestedPaise);
    if (requested <= 0n) throw new BadRequestException('Points to give back must be a positive whole number');
    if (BigInt(givenBack) + requested > BigInt(deducted)) {
      throw new BadRequestException(
        `Undo exceeds what was deducted for this outlet and field in this batch (deducted ${deducted} pts, already given back ${givenBack} pts, requested ${requested} pts)`,
      );
    }
    const created = await tx.creditReversal.create({
      data: {
        clientId: user.clientId,
        batchId,
        outletId: dto.outletId,
        outletName: dto.outletName,
        fieldId: dto.fieldId,
        fieldName: dto.fieldName,
        period,
        awardType: dto.awardType,
        // Server-derived: what the batch ACTUALLY deducted for (batch, outlet, field) — never the client's figure.
        originalPaise: BigInt(deducted),
        requestedPaise: requested,
        requestedBy: user.sub,
        ...(cleanRemarks(dto.remarks) ? { requestRemarks: cleanRemarks(dto.remarks) } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        action: 'CREATE',
        entityType: POINTS_REVERSAL_ENGINE_MARKER_ENTITY,
        entityId: created.id,
        actorId: user.sub,
        metadata: {
          engine: 'ONE_ENGINE_2026_11_21',
          kind: DEDUCTION_UNDO_MARKER_KIND,
          clientId: user.clientId,
          batchId,
          outletId: dto.outletId,
          fieldId: dto.fieldId,
        },
      },
    });
    // Round-3 #4 (no silent): how many of these points would come back already past their own expiry.
    const pastExpiryPoints = await this.walletService.uploadDeductionUndoPastExpiry(
      tx, { batchId, outletCode: dto.outletId, fieldId: dto.fieldId }, Number(requested),
    );
    return { ...created, kind: 'DEDUCTION_UNDO' as const, pastExpiryPoints };
  }

  /**
   * The create-cap figures for (batch, outlet, field), read-only: credited = Σ position amount, reversible =
   * Σ(amount − reversedPoints), pending = Σ requested of PENDING POINTS reversals. Every refusal of
   * WalletService.v2PointsReversalCap (wallet not sequenced / needing attention, no position, UNRESOLVED credit of this
   * line) propagates — nothing is created.
   */
  private async v2PointsCreateCapSnapshot(
    tx: Prisma.TransactionClient,
    key: { batchId: string; outletCode: string; fieldId: string },
  ): Promise<{ credited: bigint; reversible: bigint; pending: bigint }> {
    const cap = await this.walletService.v2PointsReversalCap(tx, key);
    const pendingRows = await tx.creditReversal.findMany({
      where: {
        batchId: key.batchId, outletId: key.outletCode, fieldId: key.fieldId, awardType: 'POINTS', status: 'PENDING_GIFSY',
      },
      select: { requestedPaise: true },
    });
    return {
      credited: BigInt(cap.positions.reduce((s, p) => s + p.amount, 0)),
      reversible: BigInt(cap.cap),
      pending: pendingRows.reduce((s, r) => s + r.requestedPaise, 0n),
    };
  }

  /**
   * V2 approve gate (before the guarded flip; the CALLER holds the batch row lock, then the reversal row lock — L3):
   * cap the approval by the positions' Σ(amount − reversedPoints) − approved reversals of the line that never got an
   * allocation (§6 approve cap + fix round A M3). No position / UNRESOLVED credit of this line → refused with the
   * reason (Q5 / policy Q1, Q3). applyCreditReversal re-checks the same cap under the wallet + position locks.
   */
  private async assertV2PointsApproval(
    tx: Prisma.TransactionClient,
    key: { batchId: string; outletCode: string; fieldId: string },
    approving: bigint,
  ): Promise<void> {
    if (approving <= 0n) return;
    const { cap, positions, unallocatedApproved } = await this.walletService.v2PointsReversalCap(tx, key);
    if (approving > BigInt(cap)) {
      const credited = positions.reduce((s, p) => s + p.amount, 0);
      throw new BadRequestException(
        `Approval exceeds the amount still reversible for this outlet and field in this batch (credited ${credited} pts, already reversed ${credited - cap} pts, approving ${approving} pts)` +
          (unallocatedApproved > 0 ? ` — incl. ${unallocatedApproved} pts of earlier approved reversals never attributed to the credit` : ''),
      );
    }
  }

  /**
   * Lock the batch row (FOR UPDATE, for the caller's tx) and return the amount the batch
   * actually credited for (outlet, field, awardType). PAYOUT (integer paise): Σ of its stored
   * `rows` that confirm turned into payout entries (status OK, amount > 0). PAYOUT only since the legacy POINTS
   * reversal path was retired (2026-11-21): a POINTS reversal is capped by its credit positions instead
   * (v2PointsReversalCap) — a POINTS call here is a programming error and refused.
   */
  private async lockBatchCreditedAmount(
    tx: Prisma.TransactionClient,
    batchId: string,
    clientId: string,
    outletId: string,
    fieldId: string,
    awardType: string,
  ): Promise<bigint> {
    await tx.$queryRaw`SELECT id FROM credit_batches WHERE id = ${batchId} FOR UPDATE`;
    const batch = await tx.creditBatch.findFirst({
      where: { id: batchId, clientId },
      select: { rows: true },
    });
    if (awardType === 'POINTS') {
      throw new Error('lockBatchCreditedAmount: POINTS reversals are capped by credit positions (v2PointsReversalCap)');
    }
    const rows = (Array.isArray(batch?.rows) ? batch!.rows : []) as Array<{
      outletId?: string; fieldId?: string; amount?: number; awardType?: string; status?: string;
    }>;
    let total = 0n;
    for (const r of rows) {
      if (
        r && r.outletId === outletId && r.fieldId === fieldId && r.awardType === awardType &&
        r.status === 'OK' && typeof r.amount === 'number' && r.amount > 0
      ) {
        total += toPaiseBigInt(r.amount);
      }
    }
    return total;
  }

  /** A reversal amount for humans: ₹ for PAYOUT (stored in paise), "pts" for POINTS. */
  private fmtAward(awardType: string, v: bigint): string {
    return awardType === 'PAYOUT' ? formatINR(v) : `${v} pts`;
  }

  /**
   * Approved PAYOUT reversal of an unpaid entry that carried a DEDUCT withholding: append the
   * compensating NEGATIVE TdsDeductionEntry (same shape as uploadUtr's FAILED path). Idempotent:
   * the offset is capped at the entry's NET ledger withholding (Σ tdsDeductedThisPaise for this
   * creditPayoutEntryId), so an entry already offset (net ≤ 0) gets nothing. The PAN is the one
   * the payout was ORIGINALLY deducted under (newest positive row). Returns the amount offset.
   */
  private async offsetWithholdingOnReversal(
    tx: Prisma.TransactionClient,
    clientId: string,
    e: { id: string; outletId: string; period: string; tdsSection: TdsSection; tdsDeductedPaise: bigint },
  ): Promise<bigint> {
    const ledger = await tx.tdsDeductionEntry.findMany({
      where: { creditPayoutEntryId: e.id },
      orderBy: { createdAt: 'desc' },
      select: { panNumber: true, tdsDeductedThisPaise: true, fyLabel: true },
    });
    const net = ledger.reduce((s, r) => s + r.tdsDeductedThisPaise, 0n);
    const orig = ledger.find((r) => r.tdsDeductedThisPaise > 0n && r.panNumber);
    const pan = orig?.panNumber ?? null;
    const amount = net < e.tdsDeductedPaise ? net : e.tdsDeductedPaise;
    if (amount <= 0n || !pan) return 0n;
    await tx.tdsDeductionEntry.createMany({
      data: [
        {
          clientId,
          panNumber: pan,
          section: e.tdsSection,
          // Offset in the SAME FY the withholding was booked in (194R = the run date's FY, D3;
          // 194C = the period FY). Falls back to the period FY only for a row without one.
          fyLabel: orig?.fyLabel ?? this.fyForPeriod(e.period).fyLabel,
          creditPayoutEntryId: e.id,
          outletCode: e.outletId,
          eventBasePaise: 0n,
          cumulativeBasePaise: 0n,
          tdsRate: new Prisma.Decimal(0),
          tdsDueCumulativePaise: 0n,
          tdsDeductedPriorPaise: 0n,
          // The ONLY load-bearing field: negative to cancel the reversed payout's withholding.
          tdsDeductedThisPaise: -amount,
          carryForwardPaise: 0n,
        },
      ],
    });
    return amount;
  }

  /**
   * Σ of live reversals for (batch, outlet, field, awardType): PENDING → requested,
   * APPROVED/PARTIAL → approved. Filtered by awardType so points and paise never mix.
   */
  private async reversedSoFar(
    tx: Prisma.TransactionClient,
    batchId: string,
    outletId: string,
    fieldId: string,
    awardType: string,
    excludeId?: string,
  ): Promise<bigint> {
    const live = await tx.creditReversal.findMany({
      where: {
        batchId,
        outletId,
        fieldId,
        awardType: awardType as Prisma.CreditReversalWhereInput['awardType'],
        status: { in: ['PENDING_GIFSY', 'APPROVED', 'PARTIAL'] },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { status: true, requestedPaise: true, approvedPaise: true },
    });
    return live.reduce(
      (s, r) => s + (r.status === 'PENDING_GIFSY' ? r.requestedPaise : (r.approvedPaise ?? 0n)),
      0n,
    );
  }

  /**
   * PAYOUT reversal interim rule (design Q9 — whole entries only, never consume an entry twice):
   * the reversal must equal an EXACT-FIT subset of this batch's payout entries for (outlet, field)
   * that no approved reversal has consumed yet. Returns the chosen entries; 400 when no subset fits
   * (listing the open entry amounts) or nothing is left to reverse.
   *
   * "Consumed" = (a) entries recorded in `consumedPayoutEntryIds` of an APPROVED/PARTIAL PAYOUT
   * reversal, and (b) for reversals approved before that column existed (null), every PAID entry
   * of the same outlet + field created on or before that approval — the old approval turned every
   * then-existing entry into REVERSED or (if PAID) a receivable. REVERSED entries never qualify.
   *
   * Choice among fitting subsets: none still with the bank (PROCESSING) if possible, then the least
   * already-PAID cash (cancelling an unpaid entry beats raising a receivable), then the fewest
   * entries, then the oldest.
   * Callers hold the batch row lock (lockBatchCreditedAmount), which serialises every reversal
   * create/approve of this batch, so two approvals can never pick the same entry.
   */
  private async selectPayoutEntriesForReversal(
    tx: Prisma.TransactionClient,
    clientId: string,
    r: { batchId: string; outletId: string; fieldId: string },
    amount: bigint,
  ) {
    const entries = await tx.creditPayoutEntry.findMany({
      where: {
        clientId,
        batchId: r.batchId,
        outletId: r.outletId,
        fieldId: r.fieldId,
        status: { in: ['PENDING', 'PROCESSING', 'PAID', 'FAILED'] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const approved = await tx.creditReversal.findMany({
      where: {
        clientId,
        outletId: r.outletId,
        fieldId: r.fieldId,
        awardType: 'PAYOUT',
        status: { in: ['APPROVED', 'PARTIAL'] },
      },
      select: { consumedPayoutEntryIds: true, approvedAt: true, approvedPaise: true },
    });
    const consumed = new Set<string>();
    let legacyCutoff: number | null = null;
    for (const a of approved) {
      if (Array.isArray(a.consumedPayoutEntryIds)) {
        for (const x of a.consumedPayoutEntryIds) if (typeof x === 'string') consumed.add(x);
      } else if (a.approvedAt instanceof Date && (a.approvedPaise ?? 0n) > 0n) {
        legacyCutoff = Math.max(legacyCutoff ?? 0, a.approvedAt.getTime());
      }
    }
    const open = entries.filter(
      (e) =>
        !consumed.has(e.id) &&
        !(
          legacyCutoff !== null &&
          e.status === 'PAID' &&
          e.createdAt instanceof Date &&
          e.createdAt.getTime() <= legacyCutoff
        ),
    );
    if (open.length === 0) {
      throw new BadRequestException(
        'No payout entries left to reverse for this outlet and field in this batch (all already reversed or recorded as a receivable)',
      );
    }
    // Owner D1 (2026-11-19): a PAID 194C payout can't be reversed — prefer a fitting subset without one; refuse below
    // when every fitting subset needs one.
    const visIds = await visibilityFieldIdsOf(tx, clientId, open.map((e) => e.fieldId));
    const MAX_ENTRIES = 16;
    if (open.length > MAX_ENTRIES) {
      throw new BadRequestException(
        `This outlet and field has ${open.length} open payout entries in this batch — too many to match a reversal automatically; contact Gifsy`,
      );
    }
    let best: { mask: number; key: number[] } | null = null;
    for (let mask = 1; mask < 1 << open.length; mask++) {
      let sum = 0n;
      let count = 0;
      let processing = 0;
      let paid = 0n;
      let paid194C = 0;
      const idx: number[] = [];
      for (let i = 0; i < open.length; i++) {
        if (!(mask & (1 << i))) continue;
        sum += open[i].amountPaise;
        count++;
        idx.push(i);
        if (open[i].status === 'PROCESSING') processing = 1;
        if (open[i].status === 'PAID') paid += open[i].amountPaise;
        if (isPaid194C(open[i], visIds)) paid194C = 1;
      }
      if (sum !== amount) continue;
      // Never a PAID 194C entry if avoidable (D1), never an entry already with the bank if avoidable, then prefer
      // cancelling unpaid entries over raising receivables, then the fewest entries, then the oldest.
      const key = [paid194C, processing, Number(paid), count, ...idx];
      const better =
        !best ||
        (() => {
          for (let k = 0; k < Math.max(key.length, best.key.length); k++) {
            const a = key[k] ?? -1;
            const b = best.key[k] ?? -1;
            if (a !== b) return a < b;
          }
          return false;
        })();
      if (better) best = { mask, key };
    }
    if (!best) {
      throw new BadRequestException(
        `A payout reversal must equal whole payout entries — open entries for this outlet and field in this batch: ${open
          .map((e) => formatINR(e.amountPaise))
          .join(', ')}. Request one of these amounts or a sum of them.`,
      );
    }
    const chosen = best.mask;
    const picked = open.filter((_e, i) => chosen & (1 << i));
    assertNoPaid194C(picked, visIds); // D1 — at create AND at approve (the entry may have been paid in between)
    return picked;
  }

  // ─── GET /v1/admin/credits/eligible-outlets ────────────────────────────────
  async eligibleOutlets(user: JwtPayload) {
    const outlets = await this.prisma.outlet.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        partner: { clientId: user.clientId, isActive: true },
      },
      include: {
        outletType: { select: { id: true, code: true } },
      },
      orderBy: { outletCode: 'asc' },
    });

    // Per-tenant outlet-type display labels (displayName ?? code), scoped to this tenant.
    const typeDisplayById = await loadOutletTypeDisplayNames(this.prisma, user.clientId);

    return outlets.map((o) => ({
      id: o.outletCode,
      name: o.name,
      // `type` MUST be the OutletType.code — the upload parser resolves awards as
      // `field.outletTypeAwards[outlet.type]`, and that map (set in Field Configuration) is
      // keyed by code. Returning the display LABEL here broke award resolution for any tenant
      // with a per-type displayName (every lookup missed → everything fell to NA), while Deoleo
      // (no displayNames → labelFor == code) stayed byte-identical, so it was never caught.
      // `typeLabel` carries the friendly display name for the parser's skip/error messages only.
      type: o.outletType.code,
      typeLabel: labelFor(typeDisplayById, o.outletType.id, o.outletType.code),
      phone: o.phone ?? undefined,
    }));
  }

  // ─── GET /v1/admin/credits/outlet-types ────────────────────────────────────
  // The award editor needs the tenant's ENABLED outlet types so an admin can set
  // POINTS/PAYOUT/NA per type without a hardcoded list. Keyed on OutletType.code —
  // the SAME value the upload parser resolves against (`outletTypeAwards[outlet.type]`,
  // where outlet.type is the OutletType.code) — so the configured map keys always
  // match the codes stored on outlets. Tenant-scoped; enabled + active only.
  // Mirrors GifsyService.getOutletTypeConfigs' DEFAULT-ON semantics EXACTLY so the
  // award editor and the operator console never disagree: start from the ACTIVE
  // outlet types, left-overlay the client's OutletTypeClientConfig rows, and treat
  // a type as enabled unless a SAVED row sets isEnabled=false (`config?.isEnabled ?? true`).
  // Previously this only listed SAVED enabled rows, so a default-on type WITHOUT a row
  // was dropped from the editor even though the console showed it enabled — the bug this fixes.
  async listOutletTypes(user: JwtPayload): Promise<{ code: string; label: string }[]> {
    const [types, rows] = await Promise.all([
      this.prisma.outletType.findMany({ where: { isActive: true } }),
      this.prisma.outletTypeClientConfig.findMany({
        where: { clientId: user.clientId },
      }),
    ]);

    const rowMap = new Map(rows.map((r) => [r.outletTypeId, r]));

    return types
      .filter((type) => (rowMap.get(type.id)?.isEnabled ?? true))
      .map((type) => ({
        code: type.code,
        label: rowMap.get(type.id)?.displayName ?? type.name,
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  // ─── GET /v1/admin/credits/fields ──────────────────────────────────────────
  async listFields(user: JwtPayload, q: ListFieldsQueryDto) {
    const activeOnly = q.active === 'true';
    return this.prisma.creditField.findMany({
      where: {
        clientId: user.clientId,
        ...(activeOnly ? { isActive: true } : {}),
      },
      orderBy: { order: 'asc' },
    });
  }

  // ─── POST /v1/admin/credits/fields ─────────────────────────────────────────
  async createField(user: JwtPayload, dto: CreateFieldDto) {
    // Duplicate-name guard (per client).
    const existing = await this.prisma.creditField.findFirst({
      where: { clientId: user.clientId, name: dto.name },
    });
    if (existing) throw new BadRequestException(`A field named "${dto.name}" already exists.`);

    // Next order value.
    const maxOrderField = await this.prisma.creditField.findFirst({
      where: { clientId: user.clientId },
      orderBy: { order: 'desc' },
    });
    const nextOrder = (maxOrderField?.order ?? 0) + 1;

    return this.prisma.creditField.create({
      data: {
        clientId: user.clientId,
        name: dto.name,
        // Keep the deprecated boolean mirror AND the explicit payoutStream classifier in sync
        // (no DTO change): isSeparatePayout=true ⇒ VISIBILITY, else INCENTIVE. isSeparatePayout
        // is dropped in W3 once all read-sites read payoutStream.
        isSeparatePayout: dto.isSeparatePayout,
        payoutStream: dto.isSeparatePayout ? 'VISIBILITY' : 'INCENTIVE',
        outletTypeAwards: dto.outletTypeAwards as unknown as Prisma.InputJsonValue,
        order: nextOrder,
      },
    });
  }

  // ─── PATCH /v1/admin/credits/fields/:id ────────────────────────────────────
  // Two independent mutations, either (or both) may be supplied:
  //   • `action`           → flip isActive (activate/deactivate)
  //   • `outletTypeAwards`  → set the per-outlet-type award map (POINTS/PAYOUT/NA)
  // The award map decides whether an uploaded row becomes wallet POINTS or a bank
  // PAYOUT, so each value is strictly validated against the POINTS/PAYOUT/NA set —
  // a malformed map must never silently misroute money.
  async patchField(user: JwtPayload, id: string, dto: PatchFieldDto) {
    const field = await this.prisma.creditField.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!field) throw new NotFoundException('Field not found');

    const data: Prisma.CreditFieldUpdateInput = {};

    if (dto.action !== undefined) {
      data.isActive = dto.action === FieldAction.activate;
    }

    if (dto.outletTypeAwards !== undefined) {
      const VALID = new Set<string>([
        FieldAwardValue.POINTS,
        FieldAwardValue.PAYOUT,
        FieldAwardValue.NA,
      ]);
      for (const [outletType, award] of Object.entries(dto.outletTypeAwards)) {
        if (!outletType || outletType.trim() === '') {
          throw new BadRequestException('Award map contains a blank outlet-type key.');
        }
        if (!VALID.has(award)) {
          throw new BadRequestException(
            `Invalid award "${award}" for outlet type "${outletType}". Must be POINTS, PAYOUT, or NA.`,
          );
        }
      }
      data.outletTypeAwards = dto.outletTypeAwards as Prisma.InputJsonValue;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException(
        'Nothing to update — provide an action (activate/deactivate) or an outletTypeAwards map.',
      );
    }

    return this.prisma.creditField.update({ where: { id }, data });
  }

  // ─── GET /v1/admin/credits/payout-downloads ────────────────────────────────
  async listPayoutDownloads(user: JwtPayload, q: ListPayoutDownloadsQueryDto) {
    return this.prisma.creditPayoutDownload.findMany({
      where: {
        clientId: user.clientId,
        ...(q.period ? { period: q.period } : {}),
      },
      orderBy: { downloadedAt: 'desc' },
      include: {
        _count: { select: { entries: true } },
      },
    });
  }

  // ─── POST /v1/admin/credits/payout-downloads ───────────────────────────────
  // Builds the bank payout file, records the download, and marks entries
  // PROCESSING. Returns the xlsx buffer + identifiers; the controller streams it.
  async createPayoutDownload(
    user: JwtPayload,
    dto: CreatePayoutDownloadDto,
  ): Promise<{
    /** null when EVERY payable payout was fully withheld as TDS (A-L3) — see noBankFileMessage. */
    buffer: Buffer | null;
    noBankFileMessage: string | null;
    downloadCode: string;
    downloadId: string;
    // GLB-1(a): entries excluded from the bank file because the partner is not
    // KYC-APPROVED or the outlet is inactive/deleted. The awards stay PENDING and
    // re-enter the next download once the gate clears.
    heldEntries: Array<{
      outletId: string;
      outletName: string;
      amountPaise: number;
      reason: string;
      entryIds: string[];
    }>;
    /**
     * A-H2: outlets whose whole payout was withheld as TDS this run — NOT sent to the bank (never a ₹0
     * line). Their entries are settled PAID here (utr `TDS-WITHHELD-<downloadCode>`, paidAt = the
     * download time) and must be surfaced to the operator (fullyWithheldNote / response headers).
     */
    fullyWithheld: Array<{
      outletId: string;
      outletName: string;
      amountPaise: number;
      tdsWithheldPaise: number;
      entryIds: string[];
    }>;
    fullyWithheldNote: string | null;
    /** Owner rule "no silent pass-through": the KYC-held entries in plain words (null when none). */
    heldNote: string | null;
    /** WP5: entries left out of this file because a pending reversal holds them (empty on LEGACY tenants). */
    reversalHeld: ReversalHeldEntry[];
    /** Policy round B: entries whose TDS was (partly) covered by an earlier TDS credit (empty without credits). */
    tdsCreditApplied: TdsCreditAppliedLine[];
    /** Fix round B (D3): entries whose TDS the ledger lowered after a reversal (empty without engine reversals). */
    tdsAdjustments: TdsAdjustmentLine[];
  }> {
    const { period, groupType, fieldId, fieldName } = dto;

    // Active separate fields (used to exclude from STANDARD). payoutStream=VISIBILITY is the
    // explicit classifier (isSeparatePayout is its deprecated boolean mirror, dropped in W3).
    const separateFields = await this.prisma.creditField.findMany({
      where: { clientId: user.clientId, payoutStream: 'VISIBILITY', isActive: true },
      select: { id: true },
    });
    const separateFieldIds = new Set(separateFields.map((f) => f.id));

    // GLM-2: include FAILED entries (bank-rejected, never paid) alongside PENDING so
    // they can be re-banked in a fresh download. A corrected re-upload then flips
    // FAILED→PAID via the existing UTR path (no double-pay: FAILED was never paid).
    // REVERSED entries are intentionally EXCLUDED: they have been clawed back and
    // must never re-enter the bank file (REVERSED ≠ bank-rejected; REVERSED = clawed back).
    const baseWhere: Prisma.CreditPayoutEntryWhereInput = {
      clientId: user.clientId,
      period,
      status: { in: ['PENDING', 'FAILED'] },
      // WP5 P3/Q10: an entry RESERVED by a pending reversal stays out of every bank file (and re-bank) until the
      // reversal is rejected. No RESERVED rows exist for a LEGACY-engine tenant → same entries as before.
      reversalAllocations: { none: { state: 'RESERVED' } },
    };

    // GLM-2: baseWhere now carries `status: { in: ['PENDING','FAILED'] }` so that
    // bank-rejected (FAILED) entries are eligible for re-banking. REVERSED entries
    // are excluded because the `in` list does not include 'REVERSED'.
    let entryWhere: Prisma.CreditPayoutEntryWhereInput = baseWhere;
    if (groupType === PayoutGroupType.SEPARATE && fieldId) {
      entryWhere = { ...baseWhere, fieldId };
    } else if (groupType === PayoutGroupType.STANDARD) {
      entryWhere = {
        ...baseWhere,
        NOT:
          separateFieldIds.size > 0
            ? { fieldId: { in: [...separateFieldIds] } }
            : undefined,
      };
    }

    const entries = await this.prisma.creditPayoutEntry.findMany({
      where: entryWhere,
      include: { batch: { select: { batchCode: true } } },
    });

    // WP5 — never a silent skip: the entries this file leaves out because a reversal holds them (same scope as
    // the file, minus the hold filter). Returned to the screen + audited; none on a LEGACY-engine tenant.
    const { reversalAllocations: _hold, ...scopeWhere } = entryWhere;
    const reversalHeld = await heldForReversal(this.prisma, scopeWhere);

    if (entries.length === 0) {
      throw new BadRequestException(
        `No PENDING or FAILED payout entries found for period ${period}${
          fieldId ? ` / field ${fieldId}` : ''
        }.` + reversalHeldSuffix(reversalHeld),
      );
    }

    // Group by outlet, sum amounts (in integer paise — no float accumulation).
    // amountPaise is a BigInt from Prisma; Number() is safe (paise « MAX_SAFE_INTEGER).
    const outletMap = new Map<
      string,
      { outletName: string; amountPaise: number; entryIds: string[] }
    >();
    for (const e of entries) {
      const cur = outletMap.get(e.outletId);
      if (cur) {
        cur.amountPaise += Number(e.amountPaise);
        cur.entryIds.push(e.id);
      } else {
        outletMap.set(e.outletId, {
          outletName: e.outletName,
          amountPaise: Number(e.amountPaise),
          entryIds: [e.id],
        });
      }
    }

    // Fetch bank details from ChannelPartner via Outlet.outletCode (tenant-scoped).
    // GLB-1(a): also fetch the partner's KycSubmission candidates and isActive/deletedAt
    // so that non-KYC-APPROVED or inactive/deleted outlets are excluded from the payable
    // rows and surfaced in a "heldEntries" list instead.
    //
    // KYC resolver note: we fetch ALL submissions for the partner (no take:1 limit)
    // and pass them to resolveEffectiveKycStatus() which applies a deterministic
    // createdAt→updatedAt→id tiebreak. This avoids the stale-APPROVED race where
    // a millisecond-tie could surface an old APPROVED after a reKyc() in-place mutation.
    //
    // Null-partnerId: a KycSubmission may have partnerId=null but a matching userId
    // (submitted before the partner record was created). Including all partner-keyed
    // submissions covers the normal path; the service will call resolveEffectiveKycStatus
    // on whatever candidates Prisma returns.
    const outletCodes = [...outletMap.keys()];
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, outletCode: { in: outletCodes } },
      include: {
        partner: {
          select: {
            id: true,
            userId: true,
            bankName: true,
            bankAccountNumber: true,
            bankAccountHolder: true,
            ifscCode: true,
            upiId: true,
            isActive: true,
            deletedAt: true,
            // Visibility-payout TDS: PAN + GST + name fields feed the DEDUCT/GROSS-UP engine
            // and the gross-up TDS invoice snapshot.
            panNumber: true,
            entityType: true,
            gstNumber: true,
            gstRegistrationType: true,
            businessName: true,
            ownerName: true,
            phone: true,
            // Fetch ALL submissions so resolveEffectiveKycStatus can apply the
            // deterministic tiebreak. The resolver selects the effective status.
            kycSubmissions: {
              orderBy: [{ createdAt: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
              select: { id: true, status: true, createdAt: true, updatedAt: true },
            },
          },
        },
      },
    });
    const outletDbMap = new Map(outlets.map((o) => [o.outletCode, o]));

    const bankSnapshots = outletCodes.map((code) => {
      const o = outletDbMap.get(code);
      return {
        outletId: code,
        bankName: o?.partner?.bankName ?? '',
        accountNumber: o?.partner?.bankAccountNumber ?? '',
        ifscCode: o?.partner?.ifscCode ?? '',
        upiId: o?.partner?.upiId ?? '',
        snapshotAt: new Date().toISOString(),
      };
    });
    const snapshotMap = new Map(bankSnapshots.map((s) => [s.outletId, s]));

    // GLB-1(a): Split codes into payable (KYC-APPROVED + active) vs held.
    // Held entries stay PENDING and re-enter the next download once the gate clears —
    // their downloadId is NOT set here and their status is NOT flipped to PROCESSING.
    const payableCodes: string[] = [];
    const heldEntries: Array<{
      outletId: string;
      outletName: string;
      amountPaise: number;
      reason: string;
      entryIds: string[];
    }> = [];

    for (const code of outletCodes) {
      const o = outletDbMap.get(code);
      const partner = o?.partner;
      const info = outletMap.get(code)!;

      // Canonical eligibility gate: inactive or soft-deleted partner → held.
      if (!partner || partner.isActive === false || partner.deletedAt != null) {
        heldEntries.push({
          outletId: code,
          outletName: info.outletName,
          amountPaise: info.amountPaise,
          reason: partner?.deletedAt != null ? 'PARTNER_DELETED' : 'PARTNER_INACTIVE',
          entryIds: info.entryIds,
        });
        continue;
      }

      // Partner KYC must be APPROVED. Use the canonical resolver (deterministic
      // createdAt→updatedAt→id tiebreak) so a stale APPROVED row cannot sneak
      // through after a reKyc() in-place mutation. Default for no submission = null
      // = NOT approved (never ?? 'APPROVED').
      const kycStatus = resolveEffectiveKycStatus(partner.kycSubmissions ?? []);
      if (kycStatus !== 'APPROVED') {
        heldEntries.push({
          outletId: code,
          outletName: info.outletName,
          amountPaise: info.amountPaise,
          reason: `KYC_NOT_APPROVED:${kycStatus ?? 'NO_SUBMISSION'}`,
          entryIds: info.entryIds,
        });
        continue;
      }

      payableCodes.push(code);
    }

    // ── Visibility-payout TDS engine (D8 DEDUCT / D9 GROSS-UP) ────────────────
    // Only VISIBILITY-stream (separate-payout) entries carry a frozen TDS treatment and are
    // processed here; STANDARD downloads exclude those field ids, so the engine is a no-op
    // there. The engine plan is computed reads-only now; its writes happen inside the download
    // $transaction below (atomic with the entry PROCESSING flip). DEDUCT reduces the outlet's
    // bank-file line; GROSS-UP leaves the line at full and raises a separate TDS invoice.
    const payableSet = new Set(payableCodes);
    const engineEntries = entries
      .filter(
        (e) =>
          payableSet.has(e.outletId) &&
          separateFieldIds.has(e.fieldId) &&
          e.tdsSection != null &&
          e.tdsMethodology != null,
      )
      .map((e) => ({
        id: e.id,
        outletId: e.outletId,
        amountPaise: e.amountPaise,
        tdsSection: e.tdsSection!,
        tdsMethodology: e.tdsMethodology!,
      }));

    const outletTaxMap = new Map<string, PartnerTaxInfo>();
    for (const code of payableCodes) {
      const o = outletDbMap.get(code);
      const p = o?.partner;
      if (!p) continue; // payable ⇒ partner present, but keep the guard for the type
      outletTaxMap.set(code, {
        partnerId: p.id,
        panNumber: p.panNumber ?? null,
        entityType: p.entityType ?? null,
        gstNumber: p.gstNumber ?? null,
        gstRegistrationType: p.gstRegistrationType ?? null,
        businessName: p.businessName ?? null,
        ownerName: p.ownerName ?? null,
        phone: p.phone ?? null,
        bankName: p.bankName ?? null,
        accountNumber: p.bankAccountNumber ?? null,
        ifscCode: p.ifscCode ?? null,
        outletName: o!.name,
        retailerState: o!.state ?? null,
      });
    }

    // Abort if every entry is held and nothing is payable.
    if (payableCodes.length === 0) {
      throw new BadRequestException(
        `No payable entries for period ${period}: all ${heldEntries.length} outlet(s) are held (KYC not approved or partner inactive/deleted).` +
          reversalHeldSuffix(reversalHeld),
      );
    }

    // GLB-1(a): held entries are excluded from the bank file and their entryIds must NOT be
    // marked PROCESSING — they stay PENDING and re-enter the next download.
    const payableEntryIds = payableCodes.flatMap((code) => outletMap.get(code)!.entryIds);

    // FIX-8: per-PAN (and per no-PAN outlet) advisory-lock keys for the visibility engine, in a
    // deterministic sorted order (deadlock-safe). Empty for STANDARD / non-visibility downloads
    // → the engine + locks are a no-op there.
    const { fyLabel: engineFyLabel } = this.fyForPeriod(period);
    // D3 (owner 2026-11-18): 194R benefits are dated by when ACTUALLY paid — this run pays now, so a
    // 194R payout counts in the run date's FY (194C keeps its period-based FY, unchanged).
    const runAt = new Date();
    const runFyLabel = financialYear(runAt).fyLabel;
    const lockKeys = new Set<string>();
    // A-M2: ANY 194R entry this download moves to PROCESSING (incentives on a STANDARD file too) changes
    // the client's 194R base for the run FY → take the per-(client, FY) 194R lock.
    if (
      entries.some(
        (e) => payableSet.has(e.outletId) && (e.tdsSection === TdsSection.SEC_194R || (!e.tdsSection && !separateFieldIds.has(e.fieldId))),
      )
    ) {
      lockKeys.add(r194LockKey(user.clientId, runFyLabel));
    }
    for (const e of engineEntries) {
      if (e.tdsSection === TdsSection.SEC_194R) {
        // A 194R entry takes the ONE per-(client, run FY) key — INSTEAD of the per-PAN key (194R state is
        // per client). The same key is taken by the UTR FAILED path and reversal approvals.
        lockKeys.add(r194LockKey(user.clientId, runFyLabel));
        continue;
      }
      const pan = outletTaxMap.get(e.outletId)?.panNumber?.trim().toUpperCase();
      lockKeys.add(
        pan
          ? `PAN|${pan}|${engineFyLabel}`
          : `NOPAN|${user.clientId}|${e.outletId}|${engineFyLabel}`,
      );
    }
    // D6/D9: only a download carrying 194R PAN entries needs the client's CURRENT method + the
    // imported-payouts countFrom (both fail CLOSED on a malformed stored value, before any write).
    // 194C-only downloads (e.g. Deoleo) issue neither read.
    const has194R = engineEntries.some((e) => e.tdsSection === TdsSection.SEC_194R);
    const currentMethodology = has194R
      ? (await this.tenantSettings.resolveTdsPolicy(user.clientId)).methodology
      : TdsMethodology.GROSS_UP;
    const importedCountFrom = has194R ? await importedPayoutsCountFromOrThrow(this.prisma, user.clientId) : null;
    // Also serialize per-(tenant, period) downloadCode generation (STANDARD downloads have no
    // engine entries, so this is the only advisory lock they take).
    lockKeys.add(`PDLOCK|${user.clientId}|${period}`);
    const sortedLockKeys = [...lockKeys].sort();

    // FIX-8: the PAN cumulative aggregation + plan + ALL money writes run INSIDE this
    // $transaction, behind the per-PAN advisory locks acquired FIRST — so two concurrent
    // downloads for the same PAN serialize and cannot both under-deduct / mis-attribute recovery.
    const entryById = new Map(entries.map((e) => [e.id, e]));
    const { rec: download, deductionByOutlet, fullyWithheldCodes, tdsCreditApplied, tdsAdjustments } = await this.prisma.$transaction(
      async (tx) => {
        // A-M3: all advisory locks in ONE round-trip (sorted → deadlock-safe ordering).
        await lockAdvisoryKeys(tx, sortedLockKeys);

        // downloadCode generated INSIDE the tx under the PDLOCK advisory lock → sequential per
        // tenant even under concurrent downloads (unique per tenant, not globally).
        const downloadCode = await this.generateDownloadCode(tx, user.clientId, period);

        // Plan built against the LOCKED cumulative state (reads via tx).
        const tdsPlan = await this.buildPayoutTdsPlan(tx, {
          clientId: user.clientId,
          period,
          engineEntries,
          outletTaxMap,
          runAt,
          currentMethodology,
          importedCountFrom,
        });

        // Net (post-DEDUCT) paise an outlet is actually paid + the file total — computed here so
        // the download record's total matches the (possibly withheld) bank lines exactly.
        const netInTx = (code: string): number =>
          outletMap.get(code)!.amountPaise - Number(tdsPlan.deductionByOutlet.get(code) ?? 0n);
        const totalAmountPaise = payableCodes.reduce((s, code) => s + netInTx(code), 0);

        const rec = await tx.creditPayoutDownload.create({
          data: {
            clientId: user.clientId,
            downloadCode,
            period,
            groupType,
            fieldId: fieldId ?? null,
            fieldName: fieldName ?? null,
            downloadedBy: user.sub,
            // A-M1: the bank-file date IS the run time the ledger FY comes from (no 31-Mar drift).
            downloadedAt: runAt,
            totalAmountPaise: toPaiseBigInt(totalAmountPaise),
            bankSnapshots: bankSnapshots as unknown as Prisma.InputJsonValue,
          },
        });

        // FIX-7: GUARDED claim — only entries still PENDING/FAILED can be flipped to PROCESSING.
        // If a concurrent download already claimed some (claimed.count < expected), abort the
        // whole tx so we never build a bank file that pays entries we did not claim (roll back →
        // clean retry). REVERSED entries are excluded by the entryWhere; GLM-2 keeps FAILED
        // re-bankable.
        if (payableEntryIds.length > 0) {
          const claimed = await tx.creditPayoutEntry.updateMany({
            where: { id: { in: payableEntryIds }, status: { in: ['PENDING', 'FAILED'] } },
            // Re-banking a previously-FAILED entry: clear the stale failure capture (reason, date,
            // AND the failed-attempt UTR reference) so the re-attempt starts fully clean — a
            // subsequent PAID shows no leftover failure info, and a re-FAIL overwrites it fresh.
            // PENDING entries already carry nulls here (harmless).
            data: {
              downloadId: rec.id,
              status: 'PROCESSING',
              failureReason: null,
              attemptedAt: null,
              utr: null,
            },
          });
          if (claimed.count !== payableEntryIds.length) {
            throw new ConflictException(
              `Payout claim race for period ${period}: expected ${payableEntryIds.length} ` +
                `entries but claimed ${claimed.count}. Rolled back — retry the download.`,
            );
          }

          // TDS payee SNAPSHOT (owner rule 2026-11-18: TDS is keyed by PAN; a PAN change splits the year at
          // the change): each payout records WHO it was paid to — the owner's normalised PAN, else the no-PAN
          // owner key — in this same tx, ONE statement for the whole file.
          const snapIds: string[] = [];
          const snapPans: string[] = [];
          const snapPartners: Array<string | null> = [];
          for (const code of payableCodes) {
            const info = outletTaxMap.get(code);
            const key = r194RetailerKey(user.clientId, code, info).key;
            for (const id of outletMap.get(code)!.entryIds) {
              snapIds.push(id);
              snapPans.push(key);
              snapPartners.push(info?.partnerId ?? null);
            }
          }
          if (snapIds.length > 0) {
            await tx.$executeRaw`UPDATE "credit_payout_entries" AS e SET "payeePan" = v.pan, "payeePartnerId" = v.pid FROM unnest(${snapIds}::text[], ${snapPans}::text[], ${snapPartners}::text[]) AS v(id, pan, pid) WHERE e."id" = v.id`;
          }
          // WP5 P3 race half: a reversal that reserved one of these entries after the read above → roll back.
          const raced = await reservedAmong(tx, payableEntryIds);
          if (raced.length > 0) {
            throw new ConflictException(
              `Payout claim race for period ${period}: ${raced.length} entr${raced.length === 1 ? 'y was' : 'ies were'} ` +
                `just reserved by a reversal request. Rolled back — retry the download.`,
            );
          }
        }

        // ── Visibility-payout TDS writes — ATOMIC with the download ─────────────
        // DEDUCT carry-forward ledger + per-entry withheld amount.
        if (tdsPlan.deductionLedger.length > 0) {
          await tx.tdsDeductionEntry.createMany({
            data: tdsPlan.deductionLedger.map((r) => ({
              clientId: r.clientId,
              panNumber: r.panNumber,
              section: r.section,
              fyLabel: r.fyLabel,
              // FIX-C: link the ledger row to its originating entry so a FAILED-payout reversal
              // resolves the originally-deducted PAN by this id (survives a mid-flight re-KYC).
              creditPayoutEntryId: r.creditPayoutEntryId,
              outletCode: r.outletCode,
              eventBasePaise: r.eventBasePaise,
              cumulativeBasePaise: r.cumulativeBasePaise,
              tdsRate: new Prisma.Decimal(r.tdsRate),
              tdsDueCumulativePaise: r.tdsDueCumulativePaise,
              tdsDeductedPriorPaise: r.tdsDeductedPriorPaise,
              tdsDeductedThisPaise: r.tdsDeductedThisPaise,
              carryForwardPaise: r.carryForwardPaise,
            })),
          });
        }
        for (const d of tdsPlan.entryDeductions) {
          await tx.creditPayoutEntry.update({
            where: { id: d.entryId },
            data: { tdsDeductedPaise: d.tdsDeductedPaise },
          });
        }
        // Policy round B: TDS credits used by this file (guarded — a credit is never used beyond its amount) + an
        // audit row naming every adjusted entry. None for a tenant without credits. Fix round B: the per-entry lines
        // (incl. "another programme" and the D3 hand-back) are stored too — the download summary endpoint reads them.
        const adj = tdsAdjustmentLines(tdsPlan.creditByEntry, entryById);
        if (tdsPlan.creditDraws.length > 0) {
          await writeCreditApplications(tx, tdsPlan.creditDraws, { clientId: user.clientId, downloadId: rec.id });
          await tx.auditLog.create({
            data: {
              action: 'EXPORT',
              entityType: 'TDS_CREDIT_APPLIED',
              entityId: rec.id,
              actorId: user.sub,
              metadata: auditJson({
                clientId: user.clientId,
                downloadCode,
                period,
                draws: tdsPlan.creditDraws,
                entries: [...tdsPlan.creditByEntry.entries()].map(([entryId, c]) => ({ entryId, ...c })),
                lines: adj.credit,
              }),
            },
          });
        }
        if (adj.adjustments.length > 0) {
          await tx.auditLog.create({
            data: {
              action: 'EXPORT',
              entityType: 'TDS_REVERSAL_ADJUSTMENT',
              entityId: rec.id,
              actorId: user.sub,
              metadata: auditJson({ clientId: user.clientId, downloadCode, period, lines: adj.adjustments }),
            },
          });
        }

        // Owner 2026-11-25 ("TDS invoice only on success"): the 194C GROSS-UP TDS invoice + recovery and the 194C
        // no-PAN recovery are NOT written at the bank file any more — they are raised when the payout is PAID
        // (uploadUtr → recordGrossUpOnPaid). The DOWNLOAD-basis plan never contains them (defensive no-op).
        await this.writeGrossUpArtefacts(tx, user.clientId, period, tdsPlan, rec.id);

        // A-H2: an outlet whose WHOLE payout was withheld as TDS is not a bank line (a ₹0 line would be
        // sent to the bank and later "credited ₹0"). Settle its entries here without the bank — guarded
        // on THIS download's PROCESSING claim — and report them loudly to the operator.
        const fullyWithheldCodes = payableCodes.filter(
          (code) => (tdsPlan.deductionByOutlet.get(code) ?? 0n) > 0n && netInTx(code) <= 0,
        );
        if (fullyWithheldCodes.length > 0) {
          const ids = fullyWithheldCodes.flatMap((code) => outletMap.get(code)!.entryIds);
          const settled = await tx.creditPayoutEntry.updateMany({
            where: { id: { in: ids }, status: 'PROCESSING', downloadId: rec.id },
            data: { status: 'PAID', utr: `TDS-WITHHELD-${downloadCode}`, paidAt: runAt },
          });
          if (settled.count !== ids.length) {
            throw new ConflictException(
              `Could not settle ${ids.length - settled.count} fully-withheld payout(s) for period ${period}. Rolled back — retry the download.`,
            );
          }
          // The other path that sets PAID (owner 2026-11-25 "TDS invoice only on success"): same hook as a UTR success.
          // A fully withheld payout is a DEDUCT payout with a PAN, so this raises nothing today — kept so the rule holds
          // on every PAID path.
          const settledSet = new Set(ids);
          await this.recordGrossUpOnPaid(tx, {
            clientId: user.clientId,
            period,
            downloadId: rec.id,
            paidEntries: entries
              .filter((e) => settledSet.has(e.id))
              .map((e) => ({
                id: e.id,
                outletId: e.outletId,
                fieldId: e.fieldId,
                amountPaise: e.amountPaise,
                tdsSection: e.tdsSection,
                tdsMethodology: e.tdsMethodology,
                payeePan: r194RetailerKey(user.clientId, e.outletId, outletTaxMap.get(e.outletId)).key,
              })),
          });
          // A-M4/B-M2: lock the self-billed SERVICE invoice of a payout settled here — the same lock a
          // UTR PAID applies (D12): it is final, its number can no longer be edited.
          await tx.autoInvoice.updateMany({
            where: { clientId: user.clientId, outletCode: { in: fullyWithheldCodes }, period, invoiceKind: 'SERVICE', lockedAt: null, voidedAt: null },
            data: { lockedAt: runAt },
          });
          // Nothing left for the bank at all → the download is already fully settled.
          if (fullyWithheldCodes.length === payableCodes.length) {
            await tx.creditPayoutDownload.update({ where: { id: rec.id }, data: { status: 'PAID' } });
          }
        }

        // WP5: the reversal hold is part of the download record's audit trail (who, which file, which entries).
        if (reversalHeld.length > 0) {
          await tx.auditLog.create({
            data: {
              action: 'EXPORT',
              entityType: 'PAYOUT_DOWNLOAD_REVERSAL_HOLD',
              entityId: rec.id,
              actorId: user.sub,
              metadata: {
                clientId: user.clientId,
                downloadCode,
                period,
                heldCount: reversalHeld.length,
                heldPaise: String(reversalHeld.reduce((n, h) => n + h.amountPaise, 0)),
                entries: reversalHeld,
              } as unknown as Prisma.InputJsonValue,
            },
          });
        }
        return {
          rec,
          deductionByOutlet: tdsPlan.deductionByOutlet,
          fullyWithheldCodes,
          tdsCreditApplied: adj.credit,
          tdsAdjustments: adj.adjustments,
        };
      },
      { timeout: 180_000, maxWait: 20_000 },
    );
    // Build the bank file AFTER the tx using the committed net (post-DEDUCT) amounts.
    const netPaiseFor = (code: string): number =>
      outletMap.get(code)!.amountPaise - Number(deductionByOutlet.get(code) ?? 0n);

    // A-H2: fully-withheld outlets are NOT bank lines (settled in the tx above).
    const fullyWithheldSet = new Set(fullyWithheldCodes);
    const bankCodes = payableCodes.filter((code) => !fullyWithheldSet.has(code));
    const fullyWithheld = fullyWithheldCodes.map((code) => {
      const info = outletMap.get(code)!;
      return {
        outletId: code,
        outletName: info.outletName,
        amountPaise: info.amountPaise,
        tdsWithheldPaise: Number(deductionByOutlet.get(code) ?? 0n),
        entryIds: info.entryIds,
      };
    });
    // B-H1: the note travels in a response header → BOUNDED (count + first 20 codes + "+K more"); the
    // full list stays in the JSON result (fullyWithheld).
    const fullyWithheldNote = fullyWithheld.length
      ? `${fullyWithheld.length} payout${fullyWithheld.length === 1 ? '' : 's'} fully withheld as TDS — not sent to the bank ` +
        `(outlet${fullyWithheld.length === 1 ? '' : 's'} ${boundedList(fullyWithheld.map((f) => f.outletId))}).`
      : null;

    const rows: PayoutBatchRow[] = bankCodes.map((code) => {
      const info = outletMap.get(code)!;
      const o = outletDbMap.get(code);
      const snapshot = snapshotMap.get(code)!;
      // Display value only — non-approved codes were already excluded into heldEntries; the gate
      // above uses ?? null (never ?? 'APPROVED'), so a no-submission partner is held, not paid.
      const kycStatus = resolveEffectiveKycStatus(o?.partner?.kycSubmissions ?? []) ?? 'APPROVED';
      return {
        outletId: code,
        outletName: info.outletName,
        // Prefer the KYC partner phone (the number that actually receives the payout WhatsApp);
        // the master-file Outlet.phone is usually null. Mirrors the payout-WhatsApp recipient pick.
        phone: o?.partner?.phone ?? o?.phone ?? '',
        bankName: snapshot.bankName,
        accountNumber: snapshot.accountNumber,
        ifscCode: snapshot.ifscCode,
        upiId: snapshot.upiId,
        kycStatus,
        // amount in the Excel file is rupees; NET of any DEDUCT-method TDS withheld this file.
        amount: paiseToRupees(netPaiseFor(code)),
        isDeactivated: !(o?.isActive ?? true),
        utrStatus: 'PENDING',
        entryIds: info.entryIds,
      };
    });
    const totalAmountPaise = bankCodes.reduce((s, code) => s + netPaiseFor(code), 0);

    const payoutBatch: PayoutBatch = {
      id: download.downloadCode,
      creditBatchId: 'MULTI',
      period,
      groupType,
      ...(fieldId ? { fieldId } : {}),
      ...(fieldName ? { fieldName } : {}),
      status: 'OPEN',
      downloadedAt: new Date().toISOString(),
      downloadedBy: user.sub,
      // PayoutBatch.totalAmount is rupees (for the Excel file header); convert.
      totalAmount: paiseToRupees(totalAmountPaise),
      bankSnapshots,
      rows,
    };

    // A-L3: nothing left for the bank → no (empty) file; say why.
    const buffer = bankCodes.length > 0 ? generatePayoutFileBuffer(payoutBatch) : null;
    const noBankFileMessage =
      buffer === null && fullyWithheld.length > 0
        ? `No bank file — every payout in this run was fully withheld as TDS (${fullyWithheld.length} payout${fullyWithheld.length === 1 ? '' : 's'}). They are settled; nothing needs to be sent to the bank.`
        : null;

    // A-M3 + A-L5/B-L4: tell each retailer whose payout was fully withheld, in plain words — ONE notice per
    // owner per download (all their fully withheld outlets added together). The wording follows the facts:
    // 194R → the CLIENT deposits it; "against your PAN" only when a PAN is on file. Free channels only (no
    // paid template says this). POST-COMMIT + fire-and-forget: never fails the download.
    const sectionsByOutlet = new Map<string, Set<string>>();
    for (const e of entries) {
      if (!e.tdsSection) continue;
      const set = sectionsByOutlet.get(e.outletId) ?? new Set<string>();
      set.add(e.tdsSection);
      sectionsByOutlet.set(e.outletId, set);
    }
    const byOwner = new Map<string, { partnerId: string; userId: string | null; hasPan: boolean; paise: bigint; outlets: number; is194R: boolean }>();
    for (const f of fullyWithheld) {
      const p = outletDbMap.get(f.outletId)?.partner;
      if (!p?.id) continue;
      const cur = byOwner.get(p.id) ?? {
        partnerId: p.id,
        userId: p.userId ?? null,
        hasPan: !isNoPanCell(p.panNumber),
        paise: 0n,
        outlets: 0,
        is194R: false,
      };
      cur.paise += BigInt(f.tdsWithheldPaise);
      cur.outlets += 1;
      if (sectionsByOutlet.get(f.outletId)?.has(TdsSection.SEC_194R)) cur.is194R = true;
      byOwner.set(p.id, cur);
    }
    for (const n of byOwner.values()) {
      try {
        let userId = n.userId;
        if (!userId) {
          const partner = await this.prisma.channelPartner.findFirst({ where: { id: n.partnerId }, select: { userId: true } });
          userId = partner?.userId ?? null;
        }
        if (!userId) continue;
        const what =
          n.outlets === 1
            ? `${formatINR(n.paise)} of this payout was taken as TDS — ₹0 paid to you.`
            : `${formatINR(n.paise)} of this payout (${n.outlets} outlets) was taken as TDS — ₹0 paid to you.`;
        const who = n.is194R ? 'The client deposits it with the Income Tax Department' : 'It is deposited with the Income Tax Department';
        const pan = n.hasPan
          ? ' against your PAN, and it will show in your TDS statement.'
          : '. You have no PAN on file, so TDS was taken at the higher no-PAN rate — add your PAN in your profile.';
        await this.notifications.notifyUser({
          userId,
          subject: 'Payout taken as TDS',
          body: `${what} ${who}${pan}`,
          url: '/partner/wallet',
          event: 'PAYOUT_TDS_WITHHELD',
        });
      } catch (e) {
        this.logger.warn(`[credit-notify] TDS-withheld note failed (client ${user.clientId}): ${e}`);
      }
    }

    // KYC-held payouts are NOT in this file — say so loudly (owner rule: no silent pass-through).
    const heldOutlets = [...new Map(heldEntries.map((h) => [h.outletId, h])).values()];
    const heldNote = heldOutlets.length
      ? `${heldOutlets.length} payout${heldOutlets.length === 1 ? '' : 's'} held — KYC not approved: ` +
        boundedList(heldOutlets.map((h) => `${h.outletId} (${h.outletName})`)) +
        '. They stay pending for the next file.'
      : null;
    return {
      buffer,
      noBankFileMessage,
      downloadCode: download.downloadCode,
      downloadId: download.id,
      heldEntries,
      fullyWithheld,
      fullyWithheldNote,
      heldNote,
      reversalHeld,
      tdsCreditApplied,
      tdsAdjustments,
    };
  }

  // ─── GET /v1/admin/credits/payout-downloads/:id/summary · …/latest-summary ──────────────────────────
  /**
   * Fix round B (screens #1): what a bank file held back / adjusted, as JSON — the payout screen reads it after
   * every download instead of depending on custom response headers through the proxy. Built from the download's
   * audit rows (written in the download tx), so it is the same for every reader and survives a page reload.
   * Tenant-scoped; `latest` = this user's most recent download for (period, groupType, fieldId).
   */
  async payoutDownloadSummary(
    user: JwtPayload,
    q: { id?: string; period?: string; groupType?: string; fieldId?: string },
  ): Promise<PayoutDownloadSummary | null> {
    const rec = q.id
      ? await this.prisma.creditPayoutDownload.findFirst({ where: { id: q.id, clientId: user.clientId } })
      : await this.prisma.creditPayoutDownload.findFirst({
          where: {
            clientId: user.clientId,
            downloadedBy: user.sub,
            ...(q.period ? { period: q.period } : {}),
            ...(q.groupType ? { groupType: q.groupType as PayoutGroupType } : {}),
            ...(q.fieldId ? { fieldId: q.fieldId } : {}),
          },
          orderBy: [{ downloadedAt: 'desc' }, { id: 'desc' }],
        });
    if (!rec) {
      if (q.id) throw new NotFoundException('Payout download not found');
      return null;
    }
    const audits = await this.prisma.auditLog.findMany({
      where: {
        entityId: rec.id,
        entityType: { in: ['PAYOUT_DOWNLOAD_REVERSAL_HOLD', 'TDS_CREDIT_APPLIED', 'TDS_REVERSAL_ADJUSTMENT'] },
      },
      select: { entityType: true, metadata: true },
    });
    const meta = (t: string) =>
      (audits.find((a) => a.entityType === t)?.metadata ?? null) as Record<string, unknown> | null;
    const held = (meta('PAYOUT_DOWNLOAD_REVERSAL_HOLD')?.entries ?? []) as ReversalHeldEntry[];
    const credit = (meta('TDS_CREDIT_APPLIED')?.lines ?? []) as TdsCreditAppliedLine[];
    const adjustments = (meta('TDS_REVERSAL_ADJUSTMENT')?.lines ?? []) as TdsAdjustmentLine[];
    return {
      downloadId: rec.id,
      downloadCode: rec.downloadCode,
      period: rec.period,
      createdAt: (rec.downloadedAt ?? rec.createdAt).toISOString(),
      reversalHeld: { count: held.length, paise: held.reduce((n, h) => n + Number(h.amountPaise), 0), entries: held },
      tdsCreditApplied: {
        count: credit.length,
        paise: credit.reduce((n, c) => n + Number(c.creditPaise), 0),
        lines: credit,
      },
      tdsAdjustments: {
        count: adjustments.length,
        paise: adjustments.reduce((n, c) => n + Number(c.handBackPaise), 0),
        lines: adjustments,
      },
    };
  }

  /**
   * Recompute a payout download's status from its entries' LIVE statuses (call inside the UTR tx,
   * after any flips, under the UTR advisory lock). Every entry settled (PAID / FAILED / REVERSED) →
   * PAID; any still awaiting a result (PROCESSING / PENDING) → PARTIALLY_PAID. Conditional write:
   * the row is untouched when the status is already correct.
   */
  private async recomputeUtrDownloadStatus(
    tx: Prisma.TransactionClient,
    downloadId: string,
    clientId: string,
  ): Promise<void> {
    const liveEntries = await tx.creditPayoutEntry.findMany({
      where: { downloadId, clientId },
      select: { id: true, status: true },
    });
    const stillPending = liveEntries.some((e) => e.status === 'PROCESSING' || e.status === 'PENDING');
    const nextStatus = stillPending ? 'PARTIALLY_PAID' : 'PAID';
    await tx.creditPayoutDownload.updateMany({
      where: { id: downloadId, clientId, status: { not: nextStatus } },
      data: { status: nextStatus },
    });
  }

  // ─── POST /v1/admin/credits/payout-downloads/:id/utr ───────────────────────
  // [id] is the CreditPayoutDownload id. Parses the UTR upload; previews unless
  // ?apply=true, then applies PAID/FAILED to entries and notifies paid outlets.
  async uploadUtr(user: JwtPayload, id: string, file: Express.Multer.File, apply: boolean) {
    const download = await this.prisma.creditPayoutDownload.findFirst({
      where: { id, clientId: user.clientId },
      include: {
        entries: {
          // FIX-3: tdsDeductedPaise/tdsSection/period feed the FAILED withholding-reversal.
          select: {
            id: true,
            outletId: true,
            status: true,
            utr: true,
            amountPaise: true,
            tdsDeductedPaise: true,
            tdsSection: true,
            period: true,
          },
        },
      },
    });
    if (!download) throw new NotFoundException('Payout download not found');

    if (!file) throw new BadRequestException('No file uploaded');

    const ab = file.buffer.buffer.slice(
      file.buffer.byteOffset,
      file.buffer.byteOffset + file.buffer.byteLength,
    );

    // Known UTRs across all downloads for this client (dup detection). We also need
    // each prior use's bank account so the same-account shared-UTR rule can allow a
    // legitimate combined transfer while still rejecting a cross-account copy-paste.
    // SCOPED TO status:'PAID' — the guard's job is to stop reusing a UTR that actually PAID
    // money. A FAILED entry now also carries a UTR (its failed-attempt reference), but that
    // reference never moved money, so it must NOT enter this set, else it would falsely block a
    // later legitimate payment that reuses the reference. (Byte-identical for old data: a FAILED
    // entry previously had a null UTR, so it was already excluded by the not-null filter.)
    const usedUtrs = await this.prisma.creditPayoutEntry.findMany({
      where: { clientId: user.clientId, utr: { not: null }, status: 'PAID' },
      select: { utr: true, outletId: true },
    });

    // Resolve the KYC-partner bank account per outlet, for BOTH this download's entries
    // (so batchRows carry accountNumber) and the prior-UTR entries (so knownUtrs carry
    // the account they were paid from). outletId on an entry is the outlet's outletCode.
    const outletCodesForAccounts = [
      ...new Set<string>([
        ...download.entries.map((e) => e.outletId),
        ...usedUtrs.map((u) => u.outletId),
      ]),
    ];
    const acctOutlets = outletCodesForAccounts.length
      ? await this.prisma.outlet.findMany({
          where: { clientId: user.clientId, outletCode: { in: outletCodesForAccounts } },
          select: { outletCode: true, partner: { select: { bankAccountNumber: true } } },
        })
      : [];
    const acctByOutlet = new Map<string, string>(
      (acctOutlets ?? []).map((o) => [
        o.outletCode,
        (o.partner?.bankAccountNumber ?? '').trim(),
      ]),
    );

    // Injectable batch rows from DB — ONE per outlet (accountNumber drives the same-account
    // shared-UTR rule). A download can hold SEVERAL entries for one outlet (one per payout row at
    // confirm), summed into ONE bank line at download; the outlet's state is the GROUP's state
    // (e.g. SKIP only when ALL its entries are already PAID) — never "last entry wins".
    const batchRows = groupUtrBatchRows(download.entries).map((g) => ({
      ...g,
      accountNumber: acctByOutlet.get(g.outletId) ?? '',
    }));

    // UTR → set of distinct non-empty bank accounts prior entries used with it.
    const knownUtrs = new Map<string, Set<string>>();
    for (const u of usedUtrs) {
      if (!u.utr) continue;
      const key = u.utr.toUpperCase();
      let set = knownUtrs.get(key);
      if (!set) {
        set = new Set<string>();
        knownUtrs.set(key, set);
      }
      const acct = acctByOutlet.get(u.outletId) ?? '';
      if (acct) set.add(acct);
    }

    // Outlets recorded in this download's bankSnapshots that no longer have an entry here. The
    // snapshot is built BEFORE the held/payable split, so it also lists outlets HELD at download
    // (never in the bank file) — each one's fate is therefore classified from the DB below.
    const currentOutletIds = new Set(download.entries.map((e) => e.outletId));
    const snapshotOutletIds = Array.isArray(download.bankSnapshots)
      ? (download.bankSnapshots as Array<{ outletId?: unknown }>)
          .map((s) => (typeof s?.outletId === 'string' ? s.outletId : ''))
          .filter((o) => !!o)
      : [];
    const formerOutletIds = [...new Set(snapshotOutletIds.filter((o) => !currentOutletIds.has(o)))];
    // Classify each former outlet from its entries for THIS period (precedence: an entry now in
    // ANOTHER download → REBANKED; else REVERSED → REVERSED; else PENDING with no download →
    // HELD). An outlet matching none stays unclassified → the parser's blocking "not found" ERROR.
    const formerOutlets = new Map<string, FormerOutletFate>();
    if (formerOutletIds.length > 0) {
      const formerEntries = await this.prisma.creditPayoutEntry.findMany({
        where: { clientId: user.clientId, outletId: { in: formerOutletIds }, period: download.period },
        select: { outletId: true, status: true, downloadId: true },
      });
      for (const outletId of formerOutletIds) {
        const mine = formerEntries.filter((e) => e.outletId === outletId);
        if (mine.some((e) => e.downloadId != null && e.downloadId !== download.id)) {
          formerOutlets.set(outletId, 'REBANKED');
        } else if (mine.some((e) => e.status === 'REVERSED')) {
          formerOutlets.set(outletId, 'REVERSED');
        } else if (mine.some((e) => e.status === 'PENDING' && e.downloadId == null)) {
          formerOutlets.set(outletId, 'HELD');
        }
      }
    }

    const parseResult = parseUtrUpload(ab, {
      downloadCode: download.downloadCode,
      batchRows,
      knownUtrs,
      formerOutlets,
    });

    // Preview unless apply=true.
    if (!apply) {
      // This preview precedes the IRREVERSIBLE "Apply UTR Results" (entries → PAID / FAILED), so the
      // operator must see EVERY row about to be applied: the full parsed `rows` (as before 2026-11-13),
      // bounded at PREVIEW_FULL_ROWS_MAX with `rowsTruncated`; plus the ERROR-row summary fields.
      const { rows, ...rest } = parseResult;
      return {
        parseResult: { ...rest, ...fullRowsEcho(rows), ...problemRowsEcho(rows, (r) => r.status === 'ERROR') },
        downloadCode: download.downloadCode,
      };
    }

    if (!parseResult.canProceed) {
      throw new BadRequestException('Cannot apply — parse result has errors or no valid rows');
    }

    // Re-apply of a fully-applied file (every row an idempotent SKIP, no errors) — common when the
    // Next proxy times out (30 s) while the apply tx (≤180 s) commits and the admin retries. Succeed
    // as a NO-OP: no entry writes, no notifications (mirrors the payouts module's all-notice file).
    // The parser only SKIPs a row that repeats the entry's recorded outcome (PAID ← Success,
    // FAILED ← Failed), so "already applied" is true for every skipped row. The ONE write allowed is
    // the conditional download-status recompute (under the same lock), which repairs a download left
    // at PARTIALLY_PAID by the old parse-row rule although every entry is settled.
    // Row notices (informational, non-blocking) echoed on every apply response. "Attention" notices
    // are the ones that do NOT mean "genuinely already applied" (paid-but-file-says-failed, a
    // different UTR) — when any is present the no-op message must not claim "Already applied".
    const notices = parseResult.rows
      .filter((r) => !!r.notice)
      .map((r) => ({ outletId: r.outletId, rowNum: r.rowNum, notice: r.notice as string }));
    const attentionCount = notices.filter(
      (n) => n.notice !== UTR_NOTICE_ALREADY_PAID && n.notice !== UTR_NOTICE_ALREADY_FAILED,
    ).length;

    if (parseResult.noop) {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`UTR|${download.id}`}, 0))`;
        await this.recomputeUtrDownloadStatus(tx, download.id, user.clientId);
      });
      return {
        applied: true,
        noop: true,
        paidCount: 0,
        failedCount: 0,
        skippedCount: parseResult.summary.skipped,
        notApplied: [],
        notices,
        message:
          attentionCount > 0
            ? `Nothing changed — ${attentionCount} row${attentionCount === 1 ? ' has a notice' : 's have notices'} to review.`
            : 'Already applied — nothing to change',
      };
    }

    const now = new Date();
    // What THIS call actually transitioned (guarded flip count === 1), aggregated PER OUTLET (= per
    // file row = per bank line; an outlet may own several entries in this download). Everything
    // post-commit — the invoice lock, the payout notification, the response counts — is driven by
    // these, NEVER by the early parse result (a retried/concurrent apply parses rows OK that a prior
    // call already flipped). amountPaise = Σ of the entries THIS call flipped to PAID.
    // notify=false when the outlet already had a PAID sibling on this bank line (a heal of a stuck
    // entry — the outlet was already told it was credited).
    // bankCreditedPaise = Σ(amountPaise − tdsDeductedPaise) of those same entries = the cash that
    // actually reached the bank (the bank-file line is built NET of DEDUCT-method TDS; GROSS-UP /
    // INCENTIVE entries carry tdsDeductedPaise=0, so for them it equals amountPaise). Floored at 0
    // per entry. This — not the gross — is what the "payout credited" message states.
    const flippedPaid: Array<{
      outletId: string;
      utr: string;
      paymentDate: Date;
      amountPaise: bigint;
      bankCreditedPaise: bigint;
      notify: boolean;
    }> = [];
    let flippedFailedCount = 0; // outlets (rows) with ≥1 entry flipped to FAILED by this call
    // OK rows whose outlet had NO entry still PROCESSING inside the tx (a concurrent/prior apply
    // already recorded it). Reported separately — never folded into "Already applied".
    const notApplied: Array<{ outletId: string; rowNum: number; reason: string }> = [];
    // FIX-3: a FAILED payout never actually withheld its DEDUCT-method TDS (the cash never left),
    // so we must REVERSE that withholding — reset the entry's tdsDeductedPaise to 0 AND append a
    // compensating negative TdsDeductionEntry — so the running priorDeducted (Σ tdsDeductedThisPaise)
    // reflects only cash withheld on NON-failed payouts. On re-bank the engine then re-withholds
    // the catch-up correctly (no free full-payment, no double-report). The failed entry's base is
    // already excluded from the cumulative aggregation (buildPayoutTdsPlan counts PAID/PROCESSING).
    const failedWithholding: Array<{
      entryId: string;
      outletId: string;
      tdsDeductedPaise: bigint;
      tdsSection: TdsSection;
      period: string;
    }> = [];
    // Policy round B: every entry this apply flips to FAILED (TDS credit applications on them are released).
    const failedEntryIdsAll: string[] = [];
    const tdsCreditReleased: ReleasedApplication[] = [];
    let grossUpOnPaid: { invoices: number; recoveryRows: number } = { invoices: 0, recoveryRows: 0 };

    // Bulk money mutation over uploaded rows — raise the interactive-tx timeout (default 5s) so the ATOMIC transaction survives a full-tenant batch; must stay all-or-nothing (do NOT chunk — would risk partial/double credit).
    await this.prisma.$transaction(async (tx) => {
      // FIX-C: serialize concurrent apply=true uploads on THIS download. Without this, two
      // concurrent applies both read the stale entry snapshot and both write a −X TDS reversal,
      // over-reducing priorDeducted (→ over-withhold on re-bank). The advisory lock + the guarded
      // PROCESSING flip below make the apply idempotent under concurrency AND retry.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`UTR|${download.id}`}, 0))`;

      // FIX-C: re-read the entries INSIDE the tx (fresh status + tdsDeductedPaise), so the reversal
      // is derived from live values a concurrent apply may already have changed.
      const freshEntries = await tx.creditPayoutEntry.findMany({
        where: { downloadId: download.id, clientId: user.clientId },
        select: {
          id: true,
          outletId: true,
          status: true,
          amountPaise: true,
          tdsDeductedPaise: true,
          tdsSection: true,
          period: true,
          paidAt: true,
          // Owner 2026-11-25: the 194C gross-up / no-PAN TDS is raised for what THIS apply pays.
          fieldId: true,
          tdsMethodology: true,
          payeePan: true,
        },
      });
      const paidNow: typeof freshEntries = [];
      // A-L: take the 194R retailer lock(s) of every withheld 194R entry in this download BEFORE any
      // flip / offset write — the same key the engine holds while it computes withholding.
      // A-M2: ANY 194R entry flipped here changes the 194R base of its bank-file FY → take that lock too.
      // Audit B6: an entry whose TDS a credit covered (tdsDeductedPaise may be 0) gets its credit back if it FAILED —
      // take that credit's lock too (194R `R194|client|FY` of the credit's FY), so a concurrent download / approval
      // never reads a half-released credit. No credit applications (every tenant without V2 credits) → same keys.
      await this.lock194RForEntries(
        tx,
        user.clientId,
        freshEntries.filter((e) => e.tdsDeductedPaise > 0n).map((e) => e.id),
        freshEntries.some((e) => e.tdsSection === TdsSection.SEC_194R)
          ? [financialYear(download.downloadedAt ?? new Date()).fyLabel]
          : [],
        freshEntries.map((e) => e.id),
      );

      // GROUP per outlet: a download can hold several entries for one outlet (one per payout row at
      // confirm), summed into ONE bank line — so a file row settles EVERY entry of that outlet.
      const freshByOutlet = new Map<string, typeof freshEntries>();
      for (const e of freshEntries) {
        const list = freshByOutlet.get(e.outletId);
        if (list) list.push(e);
        else freshByOutlet.set(e.outletId, [e]);
      }

      for (const row of parseResult.rows) {
        if (row.status !== 'OK') continue;

        const group = freshByOutlet.get(row.outletId) ?? [];
        // Settled already (in-tx read under the lock) → untouched. Only PROCESSING entries flip.
        const pending = group.filter((e) => e.status === 'PROCESSING');
        if (pending.length === 0) {
          notApplied.push({
            outletId: row.outletId,
            rowNum: row.rowNum,
            reason: 'Not applied — no entry for this outlet was still awaiting a result (another apply already recorded it). Check the payout status.',
          });
          continue;
        }
        // Healing a stuck entry whose sibling (same bank line) is already PAID: the outlet was told
        // it was credited when the sibling flipped, so NO second "credited" message; a blank
        // Payment Date defaults to the sibling's paidAt (the line's real payment date).
        const paidSibling = group.find((e) => e.status === 'PAID');
        const paidAt = row.paymentDate ?? paidSibling?.paidAt ?? now;

        // Non-success capture: the uploaded Remarks cell (bank/vendor reason) + the attempt date,
        // surfaced by the parser on row.remarks / row.paymentDate for FAILED rows too. Stored in
        // dedicated columns (failureReason / attemptedAt); OVERWRITTEN each apply (idempotent — no
        // accretion). The uploaded UTR reference is now kept on FAILED as well (it used to be
        // nulled), normalised to upper-case like the PAID path.
        const normUtr = row.utr?.trim() ? row.utr.trim().toUpperCase() : null;
        const bankReason = (row.remarks ?? '').trim() || null;

        // FIX-C: GUARDED flip, ONE round-trip per outlet (bank line): only entries still PROCESSING
        // transition. Under the UTR advisory lock no other writer can move a PROCESSING entry (a
        // download claims only PENDING/FAILED; a reversal refuses PROCESSING), so the count must
        // equal the PROCESSING ids we just read — anything else means the state moved under us →
        // roll the WHOLE apply back (all-or-nothing; the admin re-checks and retries).
        const pendingIds = pending.map((e) => e.id);
        const flip = await tx.creditPayoutEntry.updateMany({
          where: { id: { in: pendingIds }, status: 'PROCESSING' },
          data: row.success
            ? {
                status: 'PAID',
                utr: row.utr || null,
                // Operator Payment Date, else the PAID sibling's paidAt, else the apply time.
                paidAt,
              }
            : {
                status: 'FAILED',
                // paidAt MUST stay null — a non-null paidAt would leak the row into the default/
                // PAID report view (which filters paidAt IS NOT NULL).
                paidAt: null,
                // Keep the uploaded UTR reference if the operator supplied one.
                utr: normUtr,
                // FIX-3: a FAILED payout withheld nothing → clear the stamped deduction.
                tdsDeductedPaise: 0n,
                // NEW: capture the bank reason + attempt date for the admin audit report.
                failureReason: bankReason,
                attemptedAt: row.paymentDate ?? null,
              },
        });
        if (flip.count !== pendingIds.length) {
          throw new ConflictException(
            `UTR apply race on outlet ${row.outletId}: expected ${pendingIds.length} entries still ` +
              `awaiting a result but updated ${flip.count}. Nothing was applied — re-check the file and retry.`,
          );
        }

        if (row.success) {
          paidNow.push(...pending);
          // ONE paid record per outlet with the SUMMED amount actually flipped (the bank line).
          flippedPaid.push({
            outletId: row.outletId,
            utr: row.utr ?? '',
            paymentDate: paidAt,
            amountPaise: pending.reduce((s, e) => s + e.amountPaise, 0n),
            // In-tx tdsDeductedPaise (fresh read under the UTR lock) = what THIS bank line withheld.
            // Floor the OUTLET total once (not each entry) so the message mirrors the bank line exactly.
            bankCreditedPaise: (() => {
              const net = pending.reduce((s, e) => s + e.amountPaise - (e.tdsDeductedPaise ?? 0n), 0n);
              return net > 0n ? net : 0n;
            })(),
            notify: !paidSibling,
          });
        } else {
          flippedFailedCount++;
          failedEntryIdsAll.push(...pending.map((e) => e.id));
          // FIX-3/FIX-C: reverse EACH flipped FAILED entry's DEDUCT withholding, from its in-tx
          // tdsDeductedPaise (never a stale snapshot) — exactly once per entry.
          for (const entry of pending) {
            if (entry.tdsDeductedPaise > 0n && entry.tdsSection) {
              failedWithholding.push({
                entryId: entry.id,
                outletId: entry.outletId,
                tdsDeductedPaise: entry.tdsDeductedPaise,
                tdsSection: entry.tdsSection,
                period: entry.period,
              });
            }
          }
        }
      }

      // FIX-3: write the compensating negative ledger rows for the failed withholdings. FIX-C:
      // resolve each reversal's PAN from the ORIGINAL TdsDeductionEntry (by creditPayoutEntryId),
      // NOT a fresh partner lookup — so a re-KYC'd PAN change reverses against the PAN the payout
      // was ORIGINALLY deducted under. Only tdsDeductedThisPaise is load-bearing (drives the Σ
      // priorDeducted the next event reads); the base/cumulative fields document the reversal.
      if (failedWithholding.length > 0) {
        const failedEntryIds = failedWithholding.map((f) => f.entryId);
        const origDeductions = await tx.tdsDeductionEntry.findMany({
          where: { creditPayoutEntryId: { in: failedEntryIds }, tdsDeductedThisPaise: { gt: 0n } },
          // Newest first so the MOST RECENT withholding's PAN wins (a re-banked entry may have an
          // older deduction under a since-changed PAN; the current withholding is what we reverse).
          orderBy: { createdAt: 'desc' },
          select: { creditPayoutEntryId: true, panNumber: true, fyLabel: true },
        });
        const entryToPan = new Map<string, string>();
        const entryToFy = new Map<string, string>();
        for (const d of origDeductions) {
          if (d.creditPayoutEntryId && d.panNumber && !entryToPan.has(d.creditPayoutEntryId)) {
            entryToPan.set(d.creditPayoutEntryId, d.panNumber);
            if (d.fyLabel) entryToFy.set(d.creditPayoutEntryId, d.fyLabel);
          }
        }
        const reversalRows = failedWithholding
          .map((f) => ({ f, pan: entryToPan.get(f.entryId) ?? null }))
          .filter((x): x is { f: (typeof failedWithholding)[number]; pan: string } => !!x.pan)
          .map(({ f, pan }) => ({
            clientId: user.clientId,
            panNumber: pan,
            section: f.tdsSection,
            // Reverse in the FY the withholding was booked in (194R = run-date FY, D3).
            fyLabel: entryToFy.get(f.entryId) ?? this.fyForPeriod(f.period).fyLabel,
            // FIX-C: link the reversal to the originating entry (mirrors the original deduction row).
            creditPayoutEntryId: f.entryId,
            outletCode: f.outletId,
            eventBasePaise: 0n, // no new base; the failed base is excluded via PAID/PROCESSING status
            cumulativeBasePaise: 0n,
            tdsRate: new Prisma.Decimal(0),
            tdsDueCumulativePaise: 0n,
            tdsDeductedPriorPaise: 0n,
            // The ONLY load-bearing field: negative to cancel the failed payout's withholding.
            tdsDeductedThisPaise: -f.tdsDeductedPaise,
            carryForwardPaise: 0n,
          }));
        if (reversalRows.length > 0) {
          await tx.tdsDeductionEntry.createMany({ data: reversalRows });
        }
      }

      // Policy round B: a FAILED payout never paid → the TDS credit it used goes back to the credit (re-applied on
      // re-bank). No credits on the tenant → one indexed read, no writes.
      if (failedEntryIdsAll.length > 0) {
        tdsCreditReleased.push(...(await releaseCreditApplications(tx, failedEntryIdsAll, 'PAYOUT_FAILED', user.clientId)));
      }

      // Owner 2026-11-25 ("TDS invoice only on success"): the 194C gross-up TDS invoice + recovery and the 194C no-PAN
      // recovery for exactly the payouts THIS apply marked PAID (a FAILED row raises nothing; a re-bank pays once).
      if (paidNow.length > 0) {
        grossUpOnPaid = await this.recordGrossUpOnPaid(tx, {
          clientId: user.clientId,
          period: download.period,
          downloadId: download.id,
          paidEntries: paidNow.map((e) => ({
            id: e.id,
            outletId: e.outletId,
            fieldId: e.fieldId,
            amountPaise: e.amountPaise,
            tdsSection: e.tdsSection,
            tdsMethodology: e.tdsMethodology,
            payeePan: e.payeePan,
          })),
        });
      }

      // Download status from the entries' LIVE statuses, re-read in this tx AFTER the flips (never
      // from the parse rows — an already-applied SKIP row is settled, not pending). Same rule as
      // before: every entry settled (PAID / FAILED / REVERSED) → PAID; any entry still awaiting a
      // result (PROCESSING / PENDING) → PARTIALLY_PAID. The write is conditional, so a re-apply that
      // changes nothing leaves the download row untouched.
      await this.recomputeUtrDownloadStatus(tx, download.id, user.clientId);

      // Lock the linked SERVICE invoice at UTR entry (D12): once the payout UTR/date is
      // recorded the invoice number can no longer be edited. We lock by (clientId, outletCode,
      // period, SERVICE) for the outlets THIS call flipped to PAID — robust whether or not the
      // entry's autoInvoiceId was set at confirm. lockedAt=null guard keeps it idempotent.
      const lockedOutletCodes = flippedPaid.map((p) => p.outletId);
      if (lockedOutletCodes.length > 0) {
        await tx.autoInvoice.updateMany({
          where: {
            clientId: user.clientId,
            outletCode: { in: lockedOutletCodes },
            period: download.period,
            invoiceKind: 'SERVICE',
            lockedAt: null,
            // A VOID invoice (payouts cancelled) is history — never locked as if paid.
            voidedAt: null,
          },
          data: { lockedAt: now },
        });
      }
    }, { timeout: 180_000, maxWait: 20_000 });

    // Notify ONLY the outlets THIS call flipped to PAID (fire-and-forget; needs phone from outlet).
    // A retried / concurrent re-apply flips nothing → sends nothing (no duplicate payout message).
    const toNotify = flippedPaid.filter((p) => p.notify);
    const paidOutletIds = toNotify.map((p) => p.outletId);

    if (paidOutletIds.length > 0) {
      // POST-COMMIT notify block: the money tx above is already committed, so a fetch
      // OR send failure here MUST NEVER surface as a 500 — wrap the whole block in a
      // swallow (mirrors confirmBatch's outer wrap around its post-commit sends).
      try {
        const outlets = await this.prisma.outlet.findMany({
          where: { clientId: user.clientId, outletCode: { in: paidOutletIds } },
          select: {
            outletCode: true,
            name: true,
            partnerId: true,
            // The payout WhatsApp addresses the KYC-verified partner OWNER (name + phone) —
            // NOT the nullable master-file outlet.phone (matches the other two sends).
            partner: { select: { ownerName: true, phone: true } },
          },
        });
        const phoneMap = new Map(outlets.map((o) => [o.outletCode, o]));
        for (const paid of toNotify) {
          const outlet = phoneMap.get(paid.outletId);
          const phone = outlet?.partner?.phone?.trim();
          if (!phone) continue;

          // Owner payout-credit notification via the config-driven paid channels (SMS/WhatsApp),
          // POST-COMMIT + fire-and-forget: the money tx above is already committed, so this MUST
          // NEVER throw into it. includeFreeChannels:false — a payout historically sent ONLY the
          // owner WhatsApp (no bell/push row), so keep it paid-channel-only (behaviour-neutral).
          // For a WHATSAPP_KYC tenant the WhatsApp default reproduces today's `deoleo_payout_credit`:
          //   {{1}} ownerName · {{2}} points · {{3}} UTR · {{4}} date of payment · {{5}} month
          // pointsPaid = the amount ACTUALLY CREDITED TO THE BANK, in whole rupees (owner rule
          // 2026-11-15): gross minus any DEDUCT-method TDS withheld on this bank line; equals the
          // gross when nothing was withheld (GROSS-UP / INCENTIVE). The var is labelled "points"
          // in the pre-approved template; the value is rupees (Deoleo runs 1 point = ₹1).
          const ownerName = outlet?.partner?.ownerName?.trim() || 'Partner';
          const pointsPaid = Math.round(Number(paid.bankCreditedPaise) / 100);
          // Never tell a retailer "₹0 credited" (a line fully absorbed by withholding) — mirrors the
          // redemption sender's `points <= 0` skip.
          if (pointsPaid <= 0) continue;
          await this.notifications
            .notifyUserWithChannels({
              clientId: user.clientId,
              userId: '',
              eventKey: 'PAYOUT_CREDITED',
              recipientPhone: phone,
              includeFreeChannels: false,
              vars: {
                ownerName,
                points: pointsPaid,
                utr: paid.utr,
                // Reflect the actual payment date recorded on the entry (operator date or apply time).
                paymentDate: formatDateIST(paid.paymentDate),
                month: monthYearIST(download.period),
              },
              body: `Your payout of ${pointsPaid} points has been credited.`,
              event: 'PAYOUT_CREDITED',
            })
            .catch((e) =>
              // Non-critical: a delivery failure must NEVER fail the payout.
              this.logger.warn(`[credit-notify] payout-credit fan-out failed (client ${user.clientId}): ${e}`),
            );
        }
      } catch (e) {
        // Non-critical: the post-commit fetch/notify must never surface as a 500.
        this.logger.warn(`[credit-whatsapp] payout-credit notify block failed (client ${user.clientId}): ${e}`);
      }
    }

    // Counts reflect what THIS call actually wrote, PER OUTLET / FILE ROW (one bank line), the same
    // unit as the parse summary: paidCount = rows that flipped ≥1 entry to PAID, failedCount = rows
    // that flipped ≥1 entry to FAILED, skippedCount = the parser's genuine already-applied SKIP rows.
    // OK rows that flipped nothing are listed in `notApplied` (never counted as paid or skipped).
    const noop = flippedPaid.length + flippedFailedCount === 0;
    return {
      applied: true,
      noop,
      paidCount: flippedPaid.length,
      failedCount: flippedFailedCount,
      skippedCount: parseResult.summary.skipped,
      notApplied,
      notices,
      // Owner 2026-11-25: 194C TDS raised for what this apply paid (only present when any).
      ...(grossUpOnPaid.invoices + grossUpOnPaid.recoveryRows > 0 ? { tdsRaisedOnPaid: grossUpOnPaid } : {}),
      // Policy round B: TDS credit given back because the payout it covered FAILED (only present when any).
      ...(tdsCreditReleased.length > 0
        ? {
            tdsCreditReleased: tdsCreditReleased.map((r) => ({
              entryId: r.payoutEntryId,
              amountPaise: Number(r.amountPaise),
              note: `${formatINR(r.amountPaise)} TDS credit returned to the PAN's credit balance — this payout failed; it is adjusted again when the payout is re-banked`,
            })),
          }
        : {}),
      ...(noop
        ? {
            message:
              notApplied.length > 0
                ? `Nothing changed — ${notApplied.length} row${notApplied.length === 1 ? ' was' : 's were'} not applied because the payout was already recorded. Check the payout status.`
                : attentionCount > 0
                  ? `Nothing changed — ${attentionCount} row${attentionCount === 1 ? ' has a notice' : 's have notices'} to review.`
                  : 'Already applied — nothing to change',
          }
        : {}),
    };
  }

  // ─── GET /v1/admin/credits/reversals ───────────────────────────────────────
  // Existing status/period filters preserved; adds skip/take + count pagination.
  async listReversals(user: JwtPayload, q: ListReversalsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: Prisma.CreditReversalWhereInput = { clientId: user.clientId };
    if (q.status) where.status = q.status as Prisma.CreditReversalWhereInput['status'];
    if (q.period) where.period = q.period;

    const [reversals, total] = await Promise.all([
      this.prisma.creditReversal.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.creditReversal.count({ where }),
    ]);

    return {
      reversals: await this.withDeductionUndoKind(await this.withPointsOutcomes(await this.withPayoutAllocations(reversals))),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /**
   * Attach `pointsOutcome` (plain words — display only) to every APPROVED / PARTIAL POINTS reversal: what was taken from
   * the wallet, what became debt (V2, owner 2026-11-19) and what was written off (LEGACY floor 0 / approvals before that
   * rule — kept as recorded). From the allocation rows when they cover the approved amount, else approvedPaise /
   * shortfallPaise (storedPointsSplit). One query for the page; other reversals come back unchanged.
   */
  private async withPointsOutcomes<
    T extends { id: string; awardType: string; status: string; approvedPaise: bigint | null; shortfallPaise: bigint | null; requestedPaise: bigint },
  >(reversals: T[]) {
    const approved = reversals.filter((r) => r.awardType === 'POINTS' && (r.status === 'APPROVED' || r.status === 'PARTIAL'));
    if (approved.length === 0) return reversals;
    const rows = await this.prisma.creditReversalAllocation.findMany({
      where: { creditReversalId: { in: approved.map((r) => r.id) } },
      select: {
        creditReversalId: true, requested: true, debtRestored: true, recovered: true, owed: true, alreadyExpired: true,
        debtExposed: true, engineSource: true, shortfall: true,
      },
    });
    const by = new Map<string, typeof rows>();
    for (const a of rows ?? []) by.set(a.creditReversalId, [...(by.get(a.creditReversalId) ?? []), a]);
    // The V2 reversals' own wallet rows: how far below zero each took its wallet (owner D1 "points owed" — A5).
    const v2Ids = [...by.entries()].filter(([, list]) => list.every((a) => a.engineSource === 'V2')).map(([id]) => id);
    const moves = v2Ids.length
      ? await this.prisma.walletTransaction.findMany({
          where: { creditReversalId: { in: v2Ids }, referenceType: 'CREDIT_REVERSAL' },
          select: { creditReversalId: true, balanceBefore: true, balanceAfter: true },
        })
      : [];
    const movesBy = new Map<string, { balanceBefore: number; balanceAfter: number }[]>();
    for (const m of moves ?? []) if (m.creditReversalId) movesBy.set(m.creditReversalId, [...(movesBy.get(m.creditReversalId) ?? []), m]);
    // Upload-deduction UNDOs (no allocation rows; their own CREDIT_REVERSAL give-back rows) — §6 of the design note.
    const noAlloc = approved.filter((r) => !by.has(r.id)).map((r) => r.id);
    const undoRows = noAlloc.length
      ? await this.prisma.walletTransaction.findMany({
          where: {
            creditReversalId: { in: noAlloc },
            transactionType: 'CREDIT_REVERSAL',
            metadata: { path: ['kind'], equals: UPLOAD_DEDUCTION_UNDO_KIND },
          },
          select: { creditReversalId: true, points: true },
        })
      : [];
    const givenBackBy = new Map<string, number>();
    for (const u of undoRows ?? []) if (u.creditReversalId) givenBackBy.set(u.creditReversalId, (givenBackBy.get(u.creditReversalId) ?? 0) + u.points);
    const ids = new Set(approved.map((r) => r.id));
    return reversals.map((r) =>
      ids.has(r.id) && givenBackBy.has(r.id)
        ? {
            ...r,
            kind: 'DEDUCTION_UNDO' as const,
            pointsOutcome: deductionUndoOutcome(givenBackBy.get(r.id)!, { requested: Number(r.requestedPaise) }),
          }
        : ids.has(r.id)
        ? {
            ...r,
            pointsOutcome: pointsOutcome(storedPointsSplit(r, by.get(r.id) ?? [], movesBy.get(r.id) ?? []), {
              requested: Number(r.requestedPaise),
            }),
          }
        : r,
    );
  }

  /**
   * Tag every POINTS reversal that is an UNDO of an upload deduction (any status — so a PENDING request is labelled
   * before approval) with `kind: 'DEDUCTION_UNDO'`, from its create marker. Other reversals come back unchanged.
   */
  private async withDeductionUndoKind<T extends { id: string; awardType: string }>(reversals: T[]) {
    const ids = reversals.filter((r) => r.awardType === 'POINTS' && !(r as { kind?: string }).kind).map((r) => r.id);
    if (ids.length === 0) return reversals;
    const markers = await this.prisma.auditLog.findMany({
      where: {
        entityType: POINTS_REVERSAL_ENGINE_MARKER_ENTITY,
        entityId: { in: ids },
        metadata: { path: ['kind'], equals: DEDUCTION_UNDO_MARKER_KIND },
      },
      select: { entityId: true },
    });
    const undo = new Set((markers ?? []).map((m) => m.entityId));
    if (undo.size === 0) return reversals;
    // Round-3 #4 (no silent): a PENDING undo says up front how many points would come back already past their expiry.
    const past = new Map<string, number>();
    for (const r of reversals as Array<T & { status?: string; batchId?: string; outletId?: string; fieldId?: string; requestedPaise?: bigint }>) {
      if (!undo.has(r.id) || r.status !== 'PENDING_GIFSY' || !r.batchId || !r.outletId || !r.fieldId) continue;
      const n = await this.walletService.uploadDeductionUndoPastExpiry(
        this.prisma, { batchId: r.batchId, outletCode: r.outletId, fieldId: r.fieldId }, Number(r.requestedPaise ?? 0n),
      );
      if (n > 0) past.set(r.id, n);
    }
    return reversals.map((r) =>
      undo.has(r.id) ? { ...r, kind: 'DEDUCTION_UNDO' as const, ...(past.has(r.id) ? { pastExpiryPoints: past.get(r.id) } : {}) } : r,
    );
  }

  /**
   * WP5: attach `payoutEntries` (the whole entries an engine PAYOUT reversal holds / consumed) to the reversals that
   * HAVE allocation rows. Reversals without rows (every LEGACY-engine reversal) come back exactly as before.
   */
  private async withPayoutAllocations<T extends { id: string; awardType: string }>(reversals: T[]) {
    const ids = reversals.filter((r) => r.awardType === 'PAYOUT').map((r) => r.id);
    if (ids.length === 0) return reversals;
    const rows = await this.prisma.payoutReversalAllocation.findMany({
      where: { creditReversalId: { in: ids } },
      orderBy: [{ creditReversalId: 'asc' }, { payoutEntryId: 'asc' }],
      select: {
        creditReversalId: true,
        payoutEntryId: true,
        amountPaise: true,
        state: true,
        tdsOffsetPaise: true,
        receivablePaise: true,
        tdsCreditPaise: true,
        payoutEntry: { select: { status: true, period: true, createdAt: true, tdsDeductedPaise: true, utr: true } },
      },
    });
    if (rows.length === 0) return reversals;
    const by = new Map<string, Array<Record<string, unknown>>>();
    for (const r of rows) {
      const list = by.get(r.creditReversalId) ?? [];
      list.push({
        payoutEntryId: r.payoutEntryId,
        amountPaise: Number(r.amountPaise),
        allocationState: r.state,
        tdsOffsetPaise: Number(r.tdsOffsetPaise),
        receivablePaise: Number(r.receivablePaise ?? 0n),
        tdsCreditPaise: Number(r.tdsCreditPaise ?? 0n),
        entryStatus: r.payoutEntry.status,
        period: r.payoutEntry.period,
        createdAt: r.payoutEntry.createdAt,
        // Owner D2 / B4: a PAID payout FULLY withheld as TDS that the reversal marked REVERSED — not "cancelled".
        // Re-audit B5: the LEGACY / shipped rule zeroes the stamp when it reverses the withholding, so also detect it by
        // the settle reference the fully-withheld path writes (`TDS-WITHHELD-<download>`, kept by the REVERSED flip).
        ...(r.state === 'APPLIED_CANCELLED' &&
        r.amountPaise > 0n &&
        ((r.payoutEntry.tdsDeductedPaise ?? 0n) >= r.amountPaise || (r.payoutEntry.utr ?? '').startsWith('TDS-WITHHELD-'))
          ? { fullyWithheld: true }
          : {}),
      });
      by.set(r.creditReversalId, list);
    }
    return reversals.map((r) => (by.has(r.id) ? { ...r, payoutEntries: by.get(r.id)! } : r));
  }

  // ─── GET /v1/admin/credits/batches/:id/payout-reversal-entries ─────────────
  /**
   * WP5 P1: the payout entries of (batch, outlet, field) a PAYOUT reversal may select, with why the others can't
   * be. Every tenant picks entries (one engine since 2026-11-21); `mode` is always 'V2' (kept for the screen).
   */
  async listPayoutReversalEntries(user: JwtPayload, batchId: string, q: { outletId: string; fieldId: string }) {
    const batch = await this.prisma.creditBatch.findFirst({ where: { id: batchId, clientId: user.clientId } });
    if (!batch) throw new NotFoundException('Batch not found');
    const candidates = await loadPayoutReversalCandidates(this.prisma, {
      clientId: user.clientId, batchId, outletId: q.outletId, fieldId: q.fieldId,
    });
    return {
      mode: 'V2' as const,
      entries: candidates.map((c) => ({
        id: c.id,
        amountPaise: Number(c.amountPaise),
        status: c.status,
        period: c.period,
        createdAt: c.createdAt,
        selectable: c.selectable,
        blockedBy: c.blockedBy,
      })),
    };
  }

  // ─── PATCH /v1/admin/credits/reversals/:id ─────────────────────────────────
  async patchReversal(user: JwtPayload, id: string, dto: PatchReversalDto) {
    // Read the reversal first to validate state + derive amounts. The actual status
    // flip uses a guarded updateMany to prevent a double-execute from double-debiting.
    const reversal = await this.prisma.creditReversal.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!reversal) throw new NotFoundException('Reversal not found');
    if (reversal.status !== 'PENDING_GIFSY') {
      throw new BadRequestException(`Reversal is already ${reversal.status}`);
    }

    const { action, approvedPaise } = dto;
    // Fix round B (D5): the approver's typed remarks, trimmed (blank → null), saved on every path.
    const remarks = cleanRemarks(dto.remarks);

    // requestedPaise is a BigInt from Prisma; Number() is safe (paise « MAX_SAFE_INTEGER).
    const requestedPaiseNum = Number(reversal.requestedPaise);

    if (action === ReversalAction.approve && approvedPaise !== undefined) {
      if (approvedPaise > requestedPaiseNum) {
        throw new BadRequestException('Approved amount cannot exceed requested amount');
      }
      // Interim rule (design Q9): payout entries are reversed whole, and the request was matched to
      // whole entries at create — so a PAYOUT reversal is approved in full or rejected.
      if (reversal.awardType === 'PAYOUT' && approvedPaise !== requestedPaiseNum) {
        throw new BadRequestException(
          `A payout reversal is approved in full or rejected — approve ${formatINR(reversal.requestedPaise)} or reject it`,
        );
      }
    }

    const newStatus =
      action === ReversalAction.reject
        ? 'REJECTED'
        : approvedPaise !== undefined && approvedPaise < requestedPaiseNum
          ? 'PARTIAL'
          : 'APPROVED';

    const finalApprovedPaise =
      action === ReversalAction.approve
        ? toPaiseBigInt(approvedPaise ?? requestedPaiseNum)
        : null;

    const pointsKey = { batchId: reversal.batchId, outletCode: reversal.outletId, fieldId: reversal.fieldId };

    // Set inside the transaction: this POINTS reversal is the UNDO of an upload deduction (§6 of the design note).
    let isDeductionUndo = false;
    let deductionGivenBack = 0;
    let deductionPastExpiry = 0;
    return this.prisma.$transaction(async (tx) => {
      // Policy round A Q5: a POINTS approval is refused while the tenant's reversal approvals are paused (wallet
      // backfill window). Reject is never paused (it moves no points).
      // One engine for every tenant (2026-11-21): an approved POINTS reversal is the position-based approve.
      const approvingPoints = action === ReversalAction.approve && reversal.awardType === 'POINTS';
      if (approvingPoints) {
        await assertPointsReversalsNotPaused(tx, this.tenantSettings, user.clientId);
        // Fix round A, L3 — lock order: batch row → reversal row (the same order as a PAYOUT approve / every create).
        await tx.$queryRaw`SELECT id FROM credit_batches WHERE id = ${reversal.batchId} FOR UPDATE`;
        // Then THIS reversal row, re-checked still pending, so a concurrent second approval of the same reversal gets
        // the honest "already processed" — not a misleading cap message computed after the winner's reversed amount
        // landed (real-Postgres WP7 T-e3, 2026-11-16).
        const [cur] = await tx.$queryRaw<Array<{ status: string }>>(
          Prisma.sql`SELECT status FROM credit_reversals WHERE id = ${id} FOR UPDATE`,
        );
        if (!cur || cur.status !== 'PENDING_GIFSY') {
          throw new BadRequestException('Reversal already processed');
        }
        // Audit A1: a POINTS reversal requested before the old engine was retired (no marker written by
        // createPointsReversalV2) is refused — reject + re-raise, never a silent switch of rules. Reject stays allowed.
        const marker = await tx.auditLog.findFirst({
          where: { entityType: POINTS_REVERSAL_ENGINE_MARKER_ENTITY, entityId: id },
          select: { id: true },
        });
        if (!marker) {
          throw new ReversalAttentionException('RAISED_UNDER_OLD_ENGINE', RAISED_UNDER_OLD_ENGINE_MESSAGE, {
            ...pointsKey,
            requestedAt: reversal.requestedAt ?? null,
          });
        }
        // An upload-deduction line (UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md §6): the approval gives points back — capped by
        // what was deducted and not yet given back. Otherwise the position-based approve cap + the safety gate (a
        // receiving wallet with un-sequenced history → refused, WALLET_NOT_SEQUENCED) — before the guarded flip.
        const deductionLine = await this.walletService.findUploadDeductions(tx, pointsKey);
        isDeductionUndo = deductionLine.length > 0;
        if (isDeductionUndo) {
          const room = deductionLine.reduce((n, d) => n + Math.max(0, d.points - d.givenBack), 0);
          if ((finalApprovedPaise ?? 0n) > BigInt(room)) {
            throw new BadRequestException(
              `Approval exceeds what is still to give back for this deduction (deducted ${deductionLine.reduce((n, d) => n + d.points, 0)} pts, still to give back ${room} pts, approving ${finalApprovedPaise ?? 0n} pts)`,
            );
          }
        } else {
          await this.assertV2PointsApproval(tx, pointsKey, finalApprovedPaise ?? 0n);
        }
      }
      // ── Over-reversal guard (PAYOUT approve) ──────────────────────────────
      // Re-validated server-side at approval against the STORED batch rows, under the batch
      // row lock (serialises concurrent approvals/creates for this batch): Σ other live
      // reversals for (batch, outlet, field) + this approval ≤ the amount actually credited.
      if (action === ReversalAction.approve && reversal.awardType === 'PAYOUT') {
        const credited = await this.lockBatchCreditedAmount(
          tx, reversal.batchId, user.clientId, reversal.outletId, reversal.fieldId, reversal.awardType,
        );
        const others = await this.reversedSoFar(
          tx, reversal.batchId, reversal.outletId, reversal.fieldId, reversal.awardType, id,
        );
        if (others + (finalApprovedPaise ?? 0n) > credited) {
          const f = (v: bigint) => this.fmtAward(reversal.awardType, v);
          throw new BadRequestException(
            `Approval exceeds the amount credited for this outlet and field in this batch (credited ${f(credited)}, already reversed ${f(others)}, approving ${f(finalApprovedPaise ?? 0n)})`,
          );
        }
      }

      // ── WP5: a PAYOUT reversal raised under the reversal engine holds RESERVED allocations → engine path
      // (P2 release / P4). Decided by the data, not the flag; none → the interim path below, unchanged.
      if (reversal.awardType === 'PAYOUT') {
        const v2 = await patchPayoutReversalV2(
          tx,
          {
            offsetWithholding: (e) => this.offsetWithholdingOnReversal(tx, user.clientId, e),
            panPosition: (q) => this.panPositionForReversal(tx, q),
            tdsLockKeys: (ids) => this.tdsLockKeysForEntries(tx, user.clientId, ids),
            currentMethodology194R: async () => (await this.tenantSettings.resolveTdsPolicy(user.clientId)).methodology,
          },
          reversal,
          {
            action: action === ReversalAction.approve ? 'approve' : 'reject',
            newStatus, finalApprovedPaise, remarks: remarks ?? null, actorId: user.sub,
          },
        );
        if (v2) return v2;
      }

      const sentToBank = () =>
        new BadRequestException(
          'Payment already sent to the bank for this outlet and field (payout file downloaded, not yet reconciled) — record the UTR or the failure first, then approve the reversal',
        );

      // PAYOUT: the exact whole entries this reversal consumes — never one an earlier approval took.
      let payoutEntries: Awaited<ReturnType<CreditsService['selectPayoutEntriesForReversal']>> = [];
      if (action === ReversalAction.approve && reversal.awardType === 'PAYOUT' && (finalApprovedPaise ?? 0n) > 0n) {
        // Final item 5 (Deoleo path — locking only, identical outputs): the bank download serialises per (client,
        // period) on `PDLOCK|client|period` and claims entry rows only under it. Taking that SAME advisory lock here,
        // before the selection and before any row lock, means no download / re-bank of this period can claim one of
        // these entries meanwhile, and lock order is the download's: advisory first, rows after.
        await lockAdvisoryKeys(tx, [`PDLOCK|${user.clientId}|${reversal.period}`]);
        payoutEntries = await this.selectPayoutEntriesForReversal(
          tx, user.clientId,
          { batchId: reversal.batchId, outletId: reversal.outletId, fieldId: reversal.fieldId },
          finalApprovedPaise ?? 0n,
        );
        if (payoutEntries.some((e) => e.status === 'PROCESSING')) throw sentToBank();
      }

      // ── Concurrency guard ─────────────────────────────────────────────────
      // Only the first concurrent caller flips PENDING_GIFSY → newStatus (count===1).
      // A racing second call sees count===0 and throws, preventing double-debit.
      const claimed = await tx.creditReversal.updateMany({
        where: { id, status: 'PENDING_GIFSY' },
        data: {
          status: newStatus,
          approvedPaise: finalApprovedPaise,
          approvedBy: user.sub,
          approvedAt: new Date(),
          remarks: remarks ?? null,
          // Which payout entries this reversal consumed (excluded from every later reversal).
          ...(payoutEntries.length > 0 ? { consumedPayoutEntryIds: payoutEntries.map((e) => e.id) } : {}),
        },
      });
      if (claimed.count === 0) {
        throw new BadRequestException('Reversal already processed');
      }

      // ── POINTS reversal → the position engine (receiving wallet(s), allocations, own-lot-first, debt restored;
      // owner decision 2026-11-19: what the wallet no longer holds becomes debt — shortfall 0, nothing written off).
      let clawbackShortfall = 0;
      // What the POINTS reversal did, for the approver's plain-words summary (display only).
      let pointsSplit: PointsReversalSplit | null = null;
      if (approvingPoints && isDeductionUndo && (finalApprovedPaise ?? 0n) > 0n) {
        const undo = await this.walletService.undoUploadDeduction(tx, {
          ...pointsKey,
          clientId: user.clientId,
          creditReversalId: id,
          points: Number(finalApprovedPaise ?? 0n),
          passbookLabel: `${reversal.fieldName}, ${monthYearIST(reversal.period)}`,
        });
        deductionGivenBack = undo.givenBack;
        deductionPastExpiry = undo.pastExpiryPoints;
      } else if (approvingPoints && (finalApprovedPaise ?? 0n) > 0n) {
        const res = await this.walletService.reverseCreditBatchPoints(tx, {
          ...pointsKey,
          clientId: user.clientId,
          creditReversalId: id,
          points: Number(finalApprovedPaise ?? 0n),
          actorId: user.sub,
          description: `Clawback for reversal ${id} — batch POINTS reversal`,
          // Passbook row (owner decision 2, 2026-11-19): "Credit reversed (Volume · 2026-10) −10,000 · 2,986 owed, …"
          passbookLabel: `${reversal.fieldName} · ${reversal.period}`,
        });
        clawbackShortfall = res.shortfall;
        pointsSplit = {
          reversed: Number(finalApprovedPaise ?? 0n),
          recovered: res.recovered,
          debtRestored: res.debtRestored,
          owed: res.owed,
          alreadyExpired: res.alreadyExpired,
          debtExposed: res.debtExposed,
          belowZero: res.balanceBelowZero,
          shortfall: res.shortfall,
        };
      }


      // ── GLM-1: PAYOUT reversal → cash clawback ────────────────────────────
      // Acts ONLY on the whole entries selected above (this batch, this outlet + field, never one
      // an earlier reversal consumed). ACTION PER ENTRY (guarded on the status read; a concurrent
      // change is re-read):
      //   PENDING / FAILED → status=REVERSED + downloadId=null (permanently out of payability —
      //     GLM-2 re-banks FAILED, never REVERSED). Cash never left; no receivable. Any DEDUCT
      //     withholding still stamped on it is cleared + offset in the TDS ledger (uploadUtr's
      //     FAILED-path semantics).
      //   PROCESSING → the bank file is already with the bank: REFUSE the approval.
      //   PAID → cash disbursed; its amount becomes a recoverable receivable (clawbackShortfall).
      //     The entry stays PAID but is recorded in consumedPayoutEntryIds, so no later reversal
      //     can claim it again.
      let payoutClawbackNote: string | null = null;
      // Owner decision 3 (2026-11-16): the outcome summary on EVERY tenant — display only, built from what this
      // path did below; it never changes what is written.
      const legacyOutcome: PayoutOutcome | null =
        reversal.awardType === 'PAYOUT'
          ? { cancelled: [], receivable: [], receivablePaise: 0, tdsCreditPaise: 0, released: [], lines: [] }
          : null;
      if (payoutEntries.length > 0) {
        let reversedCount = 0;
        let paidReceivablePaise = 0;
        const entryNotes: string[] = [];

        // Lock order (final item 5): PDLOCK|client|period (taken before the selection, above) → the chosen entry rows
        // (ascending id) → the 194R / 194C TDS keys from a RE-READ under the row lock. The download takes PDLOCK
        // (+ its TDS keys) before claiming rows, so it can never hold one of these rows while waiting for us; a UTR
        // upload only touches PROCESSING rows, which a LEGACY approval refuses. The re-read replaces the pre-lock values.
        await tx.$queryRaw`SELECT id FROM credit_payout_entries WHERE "clientId" = ${user.clientId} AND id IN (${Prisma.join(
          [...payoutEntries.map((e) => e.id)].sort(),
        )}) ORDER BY id FOR UPDATE`;
        const lockedNow = await tx.creditPayoutEntry.findMany({
          where: { clientId: user.clientId, id: { in: payoutEntries.map((e) => e.id) } },
          select: { id: true, status: true, tdsDeductedPaise: true },
        });
        const nowById = new Map((lockedNow ?? []).map((x) => [x.id, x]));
        payoutEntries = payoutEntries.map((e) => {
          const n = nowById.get(e.id);
          return n ? { ...e, status: n.status, tdsDeductedPaise: n.tdsDeductedPaise } : e;
        });
        // A-L: the 194R retailer key(s) of withheld entries — from the re-read — BEFORE flipping / offsetting.
        await this.lock194RForEntries(
          tx,
          user.clientId,
          // A-L4: any withheld entry (194R → per-client key; 194C → its per-PAN key). A non-withheld
          // reversal never changes a 194R base (PENDING/FAILED are not counted; PAID stays PAID).
          payoutEntries.filter((e) => (e.tdsDeductedPaise ?? 0n) > 0n).map((e) => e.id),
          [],
          // B6: a cancelled entry gives back the TDS credit it used — its credit's key too (no credits → nothing extra).
          payoutEntries.map((e) => e.id),
        );
        let visIdsForD1: Set<string> | null = null;
        for (const payoutEntry of payoutEntries) {
          let cur = {
            status: payoutEntry.status as string,
            amountPaise: payoutEntry.amountPaise,
            tdsDeductedPaise: payoutEntry.tdsDeductedPaise ?? 0n,
          };
          let settled = false;
          for (let attempt = 0; attempt < 3 && !settled; attempt++) {
            if (cur.status === 'REVERSED') {
              entryNotes.push(`entry ${payoutEntry.id} already REVERSED`);
              legacyOutcome?.lines.push({
                kind: 'ALREADY_REVERSED',
                entryId: payoutEntry.id,
                text: `Entry already reversed · ${formatINR(cur.amountPaise)} · nothing more to do`,
              });
              settled = true;
              break;
            }
            if (cur.status === 'PAID') {
              // Re-audit A3: an entry that became PAID after the selection (the retry re-read) — owner D1 still holds.
              if (payoutEntry.status !== 'PAID') {
                visIdsForD1 ??= await visibilityFieldIdsOf(tx, user.clientId, payoutEntries.map((e) => e.fieldId));
                assertNoPaid194C([{ ...payoutEntry, status: 'PAID' }], visIdsForD1);
              }
              const withheld = cur.tdsDeductedPaise;
              if (withheld > 0n && withheld >= cur.amountPaise && !!payoutEntry.tdsSection) {
                // FULLY withheld as TDS (A-H2, never sent to the bank): the retailer received NOTHING, so
                // there is no receivable — reverse the withholding instead (offset row in its original FY,
                // under the 194R lock taken above) and mark the entry REVERSED. Guarded on what we read.
                const flipW = await tx.creditPayoutEntry.updateMany({
                  where: { id: payoutEntry.id, status: 'PAID', tdsDeductedPaise: withheld },
                  data: { status: 'REVERSED', tdsDeductedPaise: 0n },
                });
                if (flipW.count === 1) {
                  const offset = await this.offsetWithholdingOnReversal(tx, user.clientId, {
                    id: payoutEntry.id,
                    outletId: payoutEntry.outletId,
                    period: payoutEntry.period,
                    tdsSection: payoutEntry.tdsSection!,
                    tdsDeductedPaise: withheld,
                  });
                  // WRE policy round B: TDS credit this payout had used goes back (none on a tenant without credits).
                  const backW = await releaseCreditApplications(tx, [payoutEntry.id], 'ENTRY_CANCELLED_BY_REVERSAL', user.clientId);
                  const backWPaise = backW.reduce((s, r) => s + r.amountPaise, 0n);
                  reversedCount++;
                  entryNotes.push(
                    `entry ${payoutEntry.id} (PAID ${formatINR(cur.amountPaise)}, fully withheld as TDS — nothing reached the retailer) → REVERSED` +
                      (offset > 0n ? ` (withheld TDS ${formatINR(offset)} offset)` : ''),
                  );
                  // Owner decision 3 (outcome summary, display only) — worded on what this path did. B4: a fully
                  // withheld PAID payout is not "cancelled" — it was settled as TDS; reversed, nothing owed.
                  if (legacyOutcome) {
                    legacyOutcome.reversedWithheld = legacyOutcome.reversedWithheld ?? [];
                    legacyOutcome.reversedWithheld.push({
                      entryId: payoutEntry.id,
                      amountPaise: Number(cur.amountPaise),
                      tdsWithheldPaise: Number(withheld),
                      tdsCreditPaise: 0,
                      panMasked: null,
                      tdsOffsetPaise: Number(offset),
                      tdsNote:
                        offset > 0n
                          ? `fully withheld as TDS — withheld TDS ${formatINR(offset)} reversed in the TDS ledger`
                          : 'fully withheld as TDS — withholding already reversed earlier (no second offset)',
                    });
                  }
                  legacyOutcome?.lines.push({
                    kind: 'REVERSED_WITHHELD',
                    entryId: payoutEntry.id,
                    text:
                      `Entry reversed · ${formatINR(cur.amountPaise)} · the whole payout had been withheld as TDS, nothing reached the retailer — nothing owed` +
                      (offset > 0n ? ` · withheld TDS ${formatINR(offset)} reversed in the TDS ledger` : '') +
                      (backWPaise > 0n ? ` · ${formatINR(backWPaise)} TDS credit it had used returned to the credit balance` : ''),
                  });
                  settled = true;
                  break;
                }
              } else {
                // Receivable = only the NET amount actually released to the retailer (any withheld TDS
                // went to the government, not to the retailer).
                const net = cur.amountPaise - (withheld > 0n ? withheld : 0n);
                const netPaise = Number(net > 0n ? net : 0n);
                paidReceivablePaise += netPaise;
                entryNotes.push(
                  `entry ${payoutEntry.id} (PAID ${formatINR(cur.amountPaise)}` +
                    (withheld > 0n ? `, net released ${formatINR(net)} after TDS ${formatINR(withheld)}` : '') +
                    `) → recoverable receivable`,
                );
                const tdsNote =
                  withheld > 0n
                    ? `TDS ${formatINR(withheld)} was withheld and stays deposited — no TDS credit on this program's reversal rules`
                    : 'no TDS withheld';
                legacyOutcome?.receivable.push({
                  entryId: payoutEntry.id,
                  amountPaise: Number(cur.amountPaise),
                  receivablePaise: netPaise,
                  tdsCreditPaise: 0,
                  panMasked: null,
                  tdsNote,
                });
                legacyOutcome?.lines.push({
                  kind: 'RECEIVABLE',
                  entryId: payoutEntry.id,
                  text:
                    `Recorded as owed · ${formatINR(BigInt(netPaise))}` +
                    (withheld > 0n ? ` (paid ${formatINR(cur.amountPaise)} − TDS ${formatINR(withheld)})` : '') +
                    ` · already paid — recover it off-platform · ${tdsNote}`,
                });
                settled = true;
                break;
              }
            }
            if (cur.status === 'PAID') {
              // The fully-withheld flip lost a race — fall through to the fresh re-read below.
            } else if (cur.status === 'PROCESSING') throw sentToBank();
            else if (cur.status === 'CANCELLED') {
              // Defensive: a pending reversal blocks a cancellation, so this cannot normally happen — never re-flip it.
              throw new ConflictException(`Payout entry ${payoutEntry.id} was cancelled by Gifsy — reject this reversal instead.`);
            } else {
              // PENDING / FAILED — guarded on the status (and withholding stamp) we read, so a
              // concurrent bank-file download / UTR apply can't be overwritten.
              const offsetIt = cur.tdsDeductedPaise > 0n && !!payoutEntry.tdsSection;
              const flip = await tx.creditPayoutEntry.updateMany({
                where: {
                  id: payoutEntry.id,
                  status: cur.status as CreditEntryStatus,
                  ...(offsetIt ? { tdsDeductedPaise: cur.tdsDeductedPaise } : {}),
                },
                data: { status: 'REVERSED', downloadId: null, ...(offsetIt ? { tdsDeductedPaise: 0n } : {}) },
              });
              if (flip.count === 1) {
                const offset = offsetIt
                  ? await this.offsetWithholdingOnReversal(tx, user.clientId, {
                      id: payoutEntry.id,
                      outletId: payoutEntry.outletId,
                      period: payoutEntry.period,
                      tdsSection: payoutEntry.tdsSection!,
                      tdsDeductedPaise: cur.tdsDeductedPaise,
                    })
                  : 0n;
                reversedCount++;
                entryNotes.push(
                  `entry ${payoutEntry.id} (was ${cur.status}) → REVERSED` +
                    (offset > 0n ? ` (withheld TDS ${formatINR(offset)} offset)` : ''),
                );
                // Policy round B: TDS credit this unpaid entry had used goes back (none on a tenant without credits).
                const back = await releaseCreditApplications(tx, [payoutEntry.id], 'ENTRY_CANCELLED_BY_REVERSAL', user.clientId);
                const backPaise = back.reduce((s, r) => s + r.amountPaise, 0n);
                // B4: the same wording as the V2 path — never "no TDS withheld" when TDS was withheld but not offset.
                const legacyWithheld = cur.tdsDeductedPaise;
                legacyOutcome?.cancelled.push({
                  entryId: payoutEntry.id,
                  amountPaise: Number(cur.amountPaise),
                  wasStatus: cur.status,
                  tdsOffsetPaise: Number(offset),
                  tdsNote: !offsetIt
                    ? legacyWithheld > 0n
                      ? `TDS ${formatINR(legacyWithheld)} stamped but no TDS section on the entry — not offset; check with Gifsy`
                      : 'no TDS withheld'
                    : offset > 0n
                      ? `withheld TDS ${formatINR(offset)} offset in the TDS ledger`
                      : `withheld TDS already offset earlier (or no PAN on the deduction) — no second offset`,
                });
                legacyOutcome?.lines.push({
                  kind: 'CANCELLED',
                  entryId: payoutEntry.id,
                  text:
                    `Entry cancelled · ${formatINR(cur.amountPaise)} · will not be paid` +
                    (cur.status === 'FAILED' ? ' (the bank payment had failed)' : '') +
                    (offset > 0n ? ` · withheld TDS ${formatINR(offset)} reversed in the TDS ledger` : '') +
                    (backPaise > 0n ? ` · ${formatINR(backPaise)} TDS credit it had used returned to the credit balance` : ''),
                });
                settled = true;
                break;
              }
            }
            const fresh = await tx.creditPayoutEntry.findFirst({
              where: { id: payoutEntry.id },
              select: { status: true, amountPaise: true, tdsDeductedPaise: true },
            });
            if (!fresh) {
              settled = true;
              break;
            }
            cur = {
              status: fresh.status as string,
              amountPaise: fresh.amountPaise,
              tdsDeductedPaise: fresh.tdsDeductedPaise ?? 0n,
            };
          }
          if (!settled) {
            throw new BadRequestException('A payout entry changed while the reversal was being approved — please retry');
          }
        }

        if (paidReceivablePaise > 0) {
          clawbackShortfall = paidReceivablePaise;
        }

        payoutClawbackNote = [
          `GLM-1 clawback: ${payoutEntries.length} entries consumed`,
          `(${reversedCount} reversed, ${paidReceivablePaise > 0 ? `${formatINR(BigInt(paidReceivablePaise))} recoverable receivable` : 'no paid receivable'}).`,
          ...entryNotes,
        ].join(' | ');
      }

      // Persist the PENDING (un-reversible) portion for the reversal report:
      //   supposed = approvedPaise · reversed = approvedPaise - shortfallPaise · pending = shortfallPaise.
      // The client settles `pending` off-platform; the platform does nothing with it.
      // This applies to both POINTS shortfalls (wallet balance shortfall) and PAYOUT
      // shortfalls (already-paid cash recoverable).
      if (clawbackShortfall > 0) {
        await tx.creditReversal.update({
          where: { id },
          data: { shortfallPaise: toPaiseBigInt(clawbackShortfall) },
        });
      }

      const finalReversal = await tx.creditReversal.findFirst({ where: { id } });
      if (!legacyOutcome) {
        // POINTS (every engine — display only, built from what the path above did): "Approved · 10,000 pts reversed ·
        // 7,014 taken from the wallet · 2,986 recorded as debt, repaid from future earnings" (V2, owner 2026-11-19) or
        // "… · 2,986 not recovered — already redeemed or expired, written off" (LEGACY floor 0).
        const outcome =
          reversal.awardType !== 'POINTS'
            ? null
            : action === ReversalAction.reject
              ? rejectedPointsOutcome()
              : isDeductionUndo
                ? deductionUndoOutcome(deductionGivenBack, { requested: requestedPaiseNum, pastExpiry: deductionPastExpiry })
                : pointsOutcome(
                  pointsSplit ?? { reversed: Number(finalApprovedPaise ?? 0n), recovered: 0, debtRestored: 0, owed: 0, shortfall: 0 },
                  { requested: requestedPaiseNum },
                );
        return { ...finalReversal, clawbackShortfall, payoutClawbackNote, ...(outcome ? { pointsOutcome: outcome } : {}) };
      }
      // Owner decision 3: outcome summary (display only — everything above wrote exactly what it always wrote).
      if (action === ReversalAction.reject) {
        legacyOutcome.headline = 'Rejected · no payout entry was held or changed';
        legacyOutcome.lines.push({
          kind: 'NOTHING',
          entryId: null,
          text: 'Rejected · nothing was reversed — the payout entries stay as they were (unpaid ones go into the next bank file as usual)',
        });
      } else {
        legacyOutcome.receivablePaise = legacyOutcome.receivable.reduce((n, r) => n + r.receivablePaise, 0);
        legacyOutcome.headline = approvedHeadline(legacyOutcome);
      }
      return { ...finalReversal, clawbackShortfall, payoutClawbackNote, payoutOutcome: legacyOutcome };
    }).catch(async (e: unknown) => {
      if (e instanceof ReversalAttentionException) {
        await this.auditReversalRefusal(user, 'APPROVE', id, e, {
          batchId: reversal.batchId, outletId: reversal.outletId, fieldId: reversal.fieldId,
        });
      }
      throw e;
    });
  }
}
