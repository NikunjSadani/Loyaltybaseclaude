import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreditEntryStatus, Prisma, TdsMethodology, TdsSection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { fullRowsEcho, problemRowsEcho } from '../common/upload-echo';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { WalletService } from '../wallet/wallet.service';
import { assertPointsReversalsNotPaused, ReversalAttentionException } from '../wallet/reversal-policy';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { InvoicesService } from '../invoices/invoices.service';
import {
  deriveFrozenSection,
  computeDeduction,
  computeGrossUpTdsInvoiceBasePaise,
  allocateProRataRecovery,
} from '../tds/tds-methodology.helper';
import { grossUpTdsPaise, rate194CFrom, rate194RFrom, TdsRate, type ResolvedTdsStatutory } from '../tds/tds.helpers';
import { TdsStatutoryConfigService } from '../tds/tds-statutory.config.service';
import {
  deductWithCredits,
  loadOpenTdsCredits,
  maskPan,
  releaseCreditApplications,
  writeCreditApplications,
  type CreditDraw,
  type OpenTdsCredit,
  type ReleasedApplication,
} from './tds-credit';
import { ensureOutletAccount } from '../common/reward-account.helper';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { formatINR, paiseToRupees, toPaiseBigInt } from '../common/money';
import { monthYearIST, formatDateIST, IST_OFFSET_MIN } from '../common/ist-date';
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
  /** Integer paise. TDS due on the entry = creditPaise + withheldPaise. */
  duePaise: number;
  creditPaise: number;
  withheldPaise: number;
  panMasked: string;
  note: string;
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
  /** entryId → { TDS due on it, credit used for it } for every entry a credit reduced (download notice + audit). */
  creditByEntry: Map<string, { duePaise: bigint; creditPaise: bigint; panNumber: string }>;
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
   * Build the DEDUCT/GROSS-UP write plan for a visibility payout download (reads only; the
   * writes happen inside the caller's download $transaction). PAN aggregation is combined
   * across ALL 194C tenants (TGSL = single deductor, D7) and across the FY:
   *
   *   cumulativeBase = prior committed (PAID|PROCESSING) visibility base for the PAN/section
   *                    in the FY (cross-tenant, by period window) + this event's payable base.
   *   maxSingle      = the largest single payout entry (prior + this event) — for the 194C
   *                    single-payment threshold.
   *   priorDeducted  = Σ tdsDeductedThisPaise from the cross-tenant DEDUCT ledger (PAN/section/FY).
   *
   * DEDUCT (computeDeduction): once cumulativeBase crosses the threshold, TDS on the whole
   * aggregate becomes due; the catch-up owed at this event is withheld from this payout (capped
   * at the payout, remainder carried forward). We reduce the bank-file line + stamp each entry,
   * and append a ledger row. GROSS-UP (computeGrossUpTdsInvoiceBasePaise): the retailer is paid
   * full; at the FIRST crossing (any tenant) we raise ONE TDS invoice for the PAN/FY and split
   * the grossed-up TDS pro-rata across the PAN's contributing tenants (recovery ledger). No-PAN
   * visibility payouts are excluded from the engine (paid full; a reporting-only TDS concern).
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
    },
  ): Promise<PayoutTdsPlan> {
    const { clientId, period, engineEntries, outletTaxMap } = params;
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
    };
    const groups = new Map<string, Grp>();
    const panSet = new Set<string>();
    const sectionSet = new Set<TdsSection>();
    // FIX-9: no-PAN visibility entries by (outletCode, section).
    type NoPanGrp = { outletCode: string; section: TdsSection; entries: typeof engineEntries };
    const noPanGroups = new Map<string, NoPanGrp>();
    const noPanOutletCodes = new Set<string>();
    for (const e of engineEntries) {
      const info = outletTaxMap.get(e.outletId);
      const pan = info?.panNumber?.trim().toUpperCase();
      if (!pan) {
        // no-PAN → paid full (no deduction), but accrues a tenant recovery obligation (FIX-9).
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
    if (groups.size === 0 && noPanGroups.size === 0) return plan;

    // ── Cross-tenant prior FY aggregation per (PAN, section) ──────────────────
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
          status: { in: ['PAID', 'PROCESSING'] },
          period: { gte: startPeriod, lte: endPeriod },
          outletId: { in: [...priorOutletCodes] },
          // Policy round B: a PAID entry reversed with a TDS credit is no longer income — its base leaves the
          // cumulative (the credit carries the TDS deposited for it). No credits → no row excluded.
          tdsCredit: { is: null },
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

    // Running DEDUCT carry-forward (cross-tenant ledger, PAN/section/FY).
    const priorDeductedByPS = new Map<string, bigint>();
    if (panSet.size) {
      const ledgerRows = await db.tdsDeductionEntry.findMany({
        where: { panNumber: { in: [...panSet] }, section: { in: [...sectionSet] }, fyLabel },
        select: { panNumber: true, section: true, tdsDeductedThisPaise: true },
      });
      for (const lr of ledgerRows) {
        const ps = `${lr.panNumber}${SEP}${lr.section}`;
        priorDeductedByPS.set(ps, (priorDeductedByPS.get(ps) ?? 0n) + lr.tdsDeductedThisPaise);
      }
    }

    // Policy round B: open TDS credits on these PANs (any tenant — other tenants' are hidden from this tenant's
    // prior figure, its own are applied). None → every DEDUCT group below takes the unchanged path.
    const creditsByPS = new Map<string, OpenTdsCredit[]>();
    if (panSet.size) {
      for (const c of await loadOpenTdsCredits(db, { pans: [...panSet], sections: [...sectionSet], fyLabel })) {
        const ps = `${c.panNumber}${SEP}${c.section}`;
        const list = creditsByPS.get(ps) ?? [];
        list.push(c);
        creditsByPS.set(ps, list);
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

      if (g.methodology === TdsMethodology.DEDUCT) {
        const priorDeducted = priorDeductedByPS.get(ps) ?? 0n;
        const psCredits = creditsByPS.get(ps) ?? [];
        let tdsDueCumulativePaise: bigint;
        let carryForwardPaise: bigint;
        let shareByEntry: Map<string, bigint>;
        if (psCredits.length === 0) {
          // No TDS credit on this PAN — exactly the pre-round-B computation.
          const d = computeDeduction({
            cumulativeBasePaise: methodologyCumulativeBase, // FIX-D: DEDUCT-methodology base only
            priorDeductedPaise: priorDeducted,
            thisPayoutPaise: thisEventBase,
            rate,
            thresholdMetOnCumulative: thresholdMet, // FIX-D: combined per-PAN threshold
          });
          tdsDueCumulativePaise = d.tdsDueCumulativePaise;
          carryForwardPaise = d.carryForwardPaise;
          // Exact-summing split of the withheld amount across this event's entries.
          const split =
            d.tdsDeductThisPaise > 0n
              ? allocateProRataRecovery({
                  panTdsTotalPaise: d.tdsDeductThisPaise,
                  tenants: g.entries.map((e) => ({ clientId: e.id, basePaise: e.amountPaise })),
                })
              : [];
          shareByEntry = new Map<string, bigint>(split.map((s): [string, bigint] => [s.clientId, s.tenantSharePaise]));
        } else {
          // Policy round B: other tenants' credits hidden, this tenant's own credits applied FIFO (tds-credit.ts).
          const d = deductWithCredits({
            clientId,
            cumulativeBasePaise: methodologyCumulativeBase,
            priorDeductedPaise: priorDeducted,
            thisPayoutPaise: thisEventBase,
            rate,
            thresholdMetOnCumulative: thresholdMet,
            entries: g.entries.map((e) => ({ id: e.id, amountPaise: e.amountPaise })),
            credits: psCredits,
          });
          tdsDueCumulativePaise = d.tdsDueCumulativePaise;
          carryForwardPaise = d.carryForwardPaise;
          shareByEntry = new Map(d.perEntry.map((x): [string, bigint] => [x.entryId, x.withheldPaise]));
          plan.creditDraws.push(...d.draws);
          for (const x of d.perEntry) {
            if (x.creditPaise > 0n) {
              plan.creditByEntry.set(x.entryId, {
                duePaise: x.withheldPaise + x.creditPaise,
                creditPaise: x.creditPaise,
                panNumber: g.panNumber,
              });
            }
          }
        }
        for (const e of g.entries) {
          const share = shareByEntry.get(e.id) ?? 0n;
          if (share <= 0n) continue;
          plan.entryDeductions.push({ entryId: e.id, tdsDeductedPaise: share });
          plan.deductionByOutlet.set(e.outletId, (plan.deductionByOutlet.get(e.outletId) ?? 0n) + share);
        }
        // FIX-C: PER-ENTRY DEDUCT ledger rows (creditPayoutEntryId + the entry's own outletCode).
        const withheldEntries = g.entries.filter((e) => (shareByEntry.get(e.id) ?? 0n) > 0n);
        if (withheldEntries.length === 0) {
          if (tdsDueCumulativePaise > 0n || carryForwardPaise > 0n) {
            // Threshold met but nothing fit in this event's payouts (all carried forward): record a
            // representative row so the cumulative + carry-forward state persists across events.
            plan.deductionLedger.push({
              clientId,
              panNumber: g.panNumber,
              section: g.section,
              fyLabel,
              creditPayoutEntryId: g.entries[0].id,
              outletCode: g.entries[0].outletId,
              eventBasePaise: thisEventBase,
              cumulativeBasePaise: methodologyCumulativeBase,
              tdsRate: rate.num,
              tdsDueCumulativePaise,
              tdsDeductedPriorPaise: priorDeducted,
              tdsDeductedThisPaise: 0n,
              carryForwardPaise,
            });
          }
        } else {
          withheldEntries.forEach((e, i) => {
            const isLast = i === withheldEntries.length - 1;
            plan.deductionLedger.push({
              clientId,
              panNumber: g.panNumber,
              section: g.section,
              fyLabel,
              creditPayoutEntryId: e.id,
              outletCode: e.outletId,
              eventBasePaise: e.amountPaise,
              cumulativeBasePaise: methodologyCumulativeBase,
              tdsRate: rate.num,
              tdsDueCumulativePaise,
              tdsDeductedPriorPaise: priorDeducted,
              tdsDeductedThisPaise: shareByEntry.get(e.id) ?? 0n,
              // carryForward on the LAST row only → Σ carryForward across the group == group residual.
              carryForwardPaise: isLast ? carryForwardPaise : 0n,
            });
          });
        }
      } else {
        // GROSS_UP — retailer paid full. FIX-1: at EACH crossing period, raise a monthly TOP-UP
        // TDS invoice for the DELTA = grossUp(cumulative) − Σ already-invoiced (recovery ledger),
        // so Σ over the FY == grossUp(full-FY base) instead of under-depositing after the first.
        if (!thresholdMet) continue;

        // Idempotency per (PAN, FY, period): a top-up already raised for THIS period must not
        // double-raise. TDS invoice numbers are TGSL-TDS-<PAN>-<FYnodash>-<seq> and carry the
        // crossing period; count them for the seq + detect a same-period re-run.
        const numPrefix = `TGSL-TDS-${g.panNumber}-${fyLabel.replace(/-/g, '')}-`;
        const priorTds = await db.autoInvoice.findMany({
          where: { invoiceKind: 'TDS', invoiceNumber: { startsWith: numPrefix } },
          select: { period: true },
        });
        if (priorTds.some((i) => i.period === period)) continue; // already topped up this period

        // FIX-D: dueNow on the GROSS_UP-methodology cumulative base only.
        const dueNow = computeGrossUpTdsInvoiceBasePaise(methodologyCumulativeBase, rate, thresholdMet);
        const alreadyInvoiced = recoveredByPS.get(ps) ?? 0n;
        const delta = dueNow - alreadyInvoiced;
        if (delta <= 0n) continue; // fully invoiced already → nothing to top up

        const seq = priorTds.length + 1;
        const isAnchor = seq === 1;

        // FIX-A (D10): recovery pro-rata by each tenant's share of the retailer's FY AGGREGATE
        // GROSS_UP base (cross-tenant). Tenant set = every tenant with prior committed GROSS_UP
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

        const rep = outletTaxMap.get(g.entries[0].outletId)!;
        plan.grossUpInvoices.push({
          panNumber: g.panNumber,
          section: g.section,
          fyLabel,
          period,
          seq,
          isAnchor,
          bodyPaise: delta,
          panBasePaise: methodologyCumulativeBase,
          representative: { ...rep, outletCode: g.entries[0].outletId },
          recovery,
        });
      }
    }

    // ── FIX-9: no-PAN visibility recovery (per clientId+outletCode, no deduction/invoice) ──
    if (noPanOutletCodes.size > 0) {
      // Prior committed no-PAN visibility base for THIS tenant's outlets in the FY (no cross-
      // tenant aggregation is possible without a PAN — this is per-outlet within the tenant).
      const priorNoPan = await db.creditPayoutEntry.findMany({
        where: {
          clientId,
          outletId: { in: [...noPanOutletCodes] },
          tdsSection: { in: [...new Set([...noPanGroups.values()].map((g) => g.section))] },
          status: { in: ['PAID', 'PROCESSING'] },
          period: { gte: startPeriod, lte: endPeriod },
          tdsCredit: { is: null }, // policy round B: reversed-with-credit income is not income (no credits → no-op)
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
      const noPanRecByKS = new Map<string, bigint>(); // `<encodedKey>|<section>` → recovered
      for (const r of existingNoPanRec) {
        const k = `${r.panNumber}${SEP}${r.section}`;
        noPanRecByKS.set(k, (noPanRecByKS.get(k) ?? 0n) + r.tenantSharePaise);
      }

      // No-PAN 194C rate is 20/80 (grossed-up). Once the outlet's cumulative base crosses, the
      // TARGET recovery is grossUp20(cumulative); the DELTA to record = target − already-recorded.
      const noPanRate = rate194CFrom(cfg, false, null);
      for (const ng of noPanGroups.values()) {
        const os = `${ng.outletCode}${SEP}${ng.section}`;
        const thisEventBase = ng.entries.reduce((s, e) => s + e.amountPaise, 0n);
        const priorBase = priorNoPanByOS.get(os) ?? 0n;
        const cumulativeBase = priorBase + thisEventBase;
        const eventMaxSingle = ng.entries.reduce((m, e) => (e.amountPaise > m ? e.amountPaise : m), 0n);
        const priorMaxSingle = priorNoPanMaxByOS.get(os) ?? 0n;
        const cumMaxSingle = eventMaxSingle > priorMaxSingle ? eventMaxSingle : priorMaxSingle;
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
    return batch;
  }

  // ─── POST /v1/admin/credits/batches/:id/confirm ────────────────────────────
  async confirmBatch(user: JwtPayload, id: string) {
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
      outletId: string;
      outletName: string;
      fieldId: string;
      fieldName: string;
      amount: number;
      narration: string;
      awardType: string;
      status: string;
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
    // Wallet Reversal Engine (WP4): resolve the tenant's reversal-engine mode ONCE per batch and pass it to every
    // credit (instead of 2 reads — partner + flag — per credited row inside WalletService.movementPath). Only when
    // there is a POINTS row to credit, so a PAYOUT-only batch reads nothing new. Fail-closed exactly as before: a
    // malformed flag aborts the confirm before any write (it used to abort at the first credited row).
    const reversalEngineMode =
      pointsRows.length > 0 ? await this.tenantSettings.getReversalEngineModeUncached(user.clientId) : undefined;

    // Rows that genuinely cannot be credited, WITH a reason surfaced to the admin
    // (never dropped silently). The only remaining skip causes are an unresolvable
    // outlet code or an outlet not linked to any partner — a missing wallet is no
    // longer a skip (we create it; see below).
    const skipped: {
      outletId: string;
      fieldName: string;
      points: number;
      reason: 'OUTLET_NOT_FOUND' | 'OUTLET_NOT_LINKED_TO_PARTNER';
    }[] = [];
    let pointsCredited = 0; // count of credited rows
    let pointsCreditedTotal = 0; // sum of credited points
    // Collected for the best-effort PUSH "points earned" trigger AFTER commit. We
    // sum per partner so a partner credited under several fields gets one push.
    const creditedByPartner = new Map<string, number>();

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
          where: { outletCode: r.outletId, clientId: user.clientId },
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
            // The batch-level mode (above): the partner came from a tenant-scoped outlet lookup → same tenant.
            reversalEngineMode,
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

      return confirmed;
    }, { timeout: 180_000, maxWait: 20_000 });

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
        },
      });
    }

    return {
      batch: updated,
      payoutEntriesCreated: payoutRows.length,
      pointsCredited,
      pointsCreditedTotal,
      skipped,
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
      throw new BadRequestException('payoutEntryIds applies to PAYOUT reversals only');
    }

    // Wallet Reversal Engine (WP4): POINTS reversals follow the tenant's engine mode (LEGACY default / SHADOW /
    // V2), resolved once per request. PAYOUT reversals never read it.
    const pointsEngine =
      dto.awardType === 'POINTS' ? await this.tenantSettings.getReversalEngineModeUncached(user.clientId) : null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Policy round A Q5: refused while the tenant's POINTS reversal approvals are paused (wallet backfill window).
        if (dto.awardType === 'POINTS') await assertPointsReversalsNotPaused(tx, this.tenantSettings, user.clientId);
        if (pointsEngine === 'V2') return this.createPointsReversalV2(tx, user, id, batch.period, dto);

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

        // Interim rules (WALLET-REVERSAL-ENGINE-DESIGN.md Q14 / Q9) — refused at create AND approve:
        //  POINTS: the receiving wallet must hold the exact credit and carry no debt.
        //  PAYOUT: the amount must equal whole, not-yet-reversed payout entries of this batch.
        // WP5 (reversal engine V2 — SHADOW = LEGACY for payouts since 2026-11-16): PAYOUT reversals name their whole entries and RESERVE them.
        let payoutReservation: Awaited<ReturnType<typeof selectPayoutEntriesV2>> | null = null;
        if (dto.payoutEntryIds !== undefined && dto.awardType !== 'PAYOUT') {
          throw new BadRequestException('payoutEntryIds applies to PAYOUT reversals only');
        }
        // SHADOW (WP4): what the v2 position-based create cap would have said — read-only, computed before the
        // create (its pending sum must not include this request), recorded after it. LEGACY decides.
        const shadowCap =
          pointsEngine === 'SHADOW'
            ? await this.v2PointsCreateCapSnapshot(tx, { batchId: id, outletCode: dto.outletId, fieldId: dto.fieldId })
            : null;
        if (dto.awardType === 'POINTS') {
          await this.walletService.assertPointsReversalAllowed(tx, {
            clientId: user.clientId, batchId: id, outletCode: dto.outletId, fieldId: dto.fieldId,
          });
        } else if (dto.awardType === 'PAYOUT') {
          // Through this tx (it holds the batch row lock — never a second pool connection meanwhile).
          // Owner decision 2026-11-16: SHADOW = LEGACY for PAYOUT reversals (today's screens + rules); V2 only picks.
          if ((await this.tenantSettings.getReversalEngineModeUncached(user.clientId, tx)) === 'V2') {
            payoutReservation = await selectPayoutEntriesV2(
              tx, { clientId: user.clientId, batchId: id, outletId: dto.outletId, fieldId: dto.fieldId },
              dto.payoutEntryIds, requested,
            );
          } else {
            if (dto.payoutEntryIds !== undefined) {
              throw new BadRequestException('Selecting payout entries is not enabled for this program');
            }
            await this.selectPayoutEntriesForReversal(
              tx, user.clientId, { batchId: id, outletId: dto.outletId, fieldId: dto.fieldId }, requested,
            );
          }
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
          },
        });
        if (payoutReservation) {
          await reservePayoutEntries(tx, created.id, payoutReservation, {
            clientId: user.clientId, batchId: id, outletId: dto.outletId, fieldId: dto.fieldId, actorId: user.sub,
          });
        }
        if (shadowCap) {
          await this.recordShadowCreateCap(tx, user, created.id, shadowCap, {
            credited, alreadyReversed, requested,
            key: { batchId: id, outletCode: dto.outletId, fieldId: dto.fieldId },
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
    phase: 'CREATE' | 'APPROVE',
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

  // ─── Wallet Reversal Engine (WP4) — POINTS reversals on SHADOW / V2 tenants ──────────────────
  // WALLET-REVERSAL-ENGINE-DESIGN.md §6 / §9 step 5. LEGACY (the default for every tenant) never reaches these.

  /**
   * V2 create (§6 "create cap"): the reversal is capped by the credit POSITIONS of (batch, outlet, field) —
   * Σ(amount − reversedPoints) − Σ pending requested — on whichever wallet(s) received the credit (Q4: an outlet
   * relinked since is irrelevant). No position, or an UNRESOLVED credit that could be THIS outlet line's → refused with
   * the reason (Q5; narrowed to the line by policy Q3 2026-11-16 — WalletService.v2PointsReversalCap). No debt refusal
   * (Q1/Q14 apply to LEGACY only). Same batch row lock + duplicate-pending guard as the legacy create.
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
    const snap = await this.v2PointsCreateCapSnapshot(
      tx, { batchId, outletCode: dto.outletId, fieldId: dto.fieldId }, { raise: true },
    );
    if ('refused' in snap) throw new BadRequestException(snap.refused); // unreachable with raise: true
    const requested = toPaiseBigInt(dto.requestedPaise);
    if (requested <= 0n) throw new BadRequestException('Reversal amount must be a positive whole number of points');
    if (snap.pending + requested > snap.reversible) {
      throw new BadRequestException(
        `Reversal exceeds the amount still reversible for this outlet and field in this batch (credited ${snap.credited} pts, already reversed ${snap.credited - snap.reversible} pts, pending ${snap.pending} pts, requested ${requested} pts)`,
      );
    }
    return tx.creditReversal.create({
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
      },
    });
  }

  /**
   * The v2 create-cap figures for (batch, outlet, field), read-only: credited = Σ position amount, reversible =
   * Σ(amount − reversedPoints), pending = Σ requested of PENDING POINTS reversals. A v2 refusal (no position /
   * UNRESOLVED credit of this line / wallet needing attention — WalletService.v2PointsReversalCap) is raised when
   * `raise`, else returned (SHADOW records it).
   */
  private async v2PointsCreateCapSnapshot(
    tx: Prisma.TransactionClient,
    key: { batchId: string; outletCode: string; fieldId: string },
    opts: { raise?: boolean } = {},
  ): Promise<{ credited: bigint; reversible: bigint; pending: bigint } | { refused: string }> {
    let cap: { cap: number; positions: { amount: number }[] };
    try {
      cap = await this.walletService.v2PointsReversalCap(tx, key);
    } catch (e) {
      if (opts.raise || !(e instanceof BadRequestException || e instanceof ConflictException)) throw e;
      return { refused: e.message };
    }
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
   * SHADOW create: LEGACY decided (and created the reversal); record what the v2 cap would have said next to it
   * (audit_logs entityType REVERSAL_ENGINE_SHADOW, phase CREATE — the approve-time diff is written by
   * WalletService.reverseCreditBatchPoints). Never changes the outcome.
   */
  private async recordShadowCreateCap(
    tx: Prisma.TransactionClient,
    user: JwtPayload,
    reversalId: string,
    v2: { credited: bigint; reversible: bigint; pending: bigint } | { refused: string },
    legacy: {
      credited: bigint; alreadyReversed: bigint; requested: bigint;
      key: { batchId: string; outletCode: string; fieldId: string };
    },
  ): Promise<void> {
    // Remaining headroom BEFORE this request: LEGACY = credited − (approved + pending); v2 = reversible − pending.
    const legacyHeadroom = legacy.credited - legacy.alreadyReversed;
    const v2Headroom = 'refused' in v2 ? null : v2.reversible - v2.pending;
    const differs = 'refused' in v2 || v2.credited !== legacy.credited || v2Headroom !== legacyHeadroom;
    await tx.auditLog.create({
      data: {
        action: 'CREATE',
        entityType: 'REVERSAL_ENGINE_SHADOW',
        entityId: reversalId,
        actorId: user.sub,
        metadata: {
          phase: 'CREATE',
          ...legacy.key,
          requested: Number(legacy.requested),
          differs,
          legacy: { credited: Number(legacy.credited), headroom: Number(legacyHeadroom) },
          v2:
            'refused' in v2
              ? { refused: v2.refused }
              : { credited: Number(v2.credited), headroom: Number(v2Headroom), pending: Number(v2.pending) },
        } as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * V2 approve gate (before the guarded flip): lock the batch row (same lock as the legacy cap), then cap the
   * approval by the positions' Σ(amount − reversedPoints) (§6 approve cap). No position / UNRESOLVED credit of this
   * line → refused with the reason (Q5 / policy Q1, Q3).
   * applyCreditReversal re-checks the same cap under the wallet + position locks.
   */
  private async assertV2PointsApproval(
    tx: Prisma.TransactionClient,
    key: { batchId: string; outletCode: string; fieldId: string },
    approving: bigint,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM credit_batches WHERE id = ${key.batchId} FOR UPDATE`;
    if (approving <= 0n) return;
    const { cap, positions } = await this.walletService.v2PointsReversalCap(tx, key);
    if (approving > BigInt(cap)) {
      const credited = positions.reduce((s, p) => s + p.amount, 0);
      throw new BadRequestException(
        `Approval exceeds the amount still reversible for this outlet and field in this batch (credited ${credited} pts, already reversed ${credited - cap} pts, approving ${approving} pts)`,
      );
    }
  }

  /**
   * Lock the batch row (FOR UPDATE, for the caller's tx) and return the amount the batch
   * actually credited for (outlet, field, awardType). PAYOUT (integer paise): Σ of its stored
   * `rows` that confirm turned into payout entries (status OK, amount > 0). POINTS (whole points):
   * what wallets ACTUALLY received (WalletService.creditedPointsForBatchRow) — a row skipped at
   * confirm (outlet unknown / not linked) credited nothing and so can never be clawed back.
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
      return this.walletService.creditedPointsForBatchRow(tx, { batchId, clientId, outletCode: outletId, fieldId });
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
      select: { panNumber: true, tdsDeductedThisPaise: true },
    });
    const net = ledger.reduce((s, r) => s + r.tdsDeductedThisPaise, 0n);
    const pan = ledger.find((r) => r.tdsDeductedThisPaise > 0n && r.panNumber)?.panNumber ?? null;
    const amount = net < e.tdsDeductedPaise ? net : e.tdsDeductedPaise;
    if (amount <= 0n || !pan) return 0n;
    await tx.tdsDeductionEntry.createMany({
      data: [
        {
          clientId,
          panNumber: pan,
          section: e.tdsSection,
          fyLabel: this.fyForPeriod(e.period).fyLabel,
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
      const idx: number[] = [];
      for (let i = 0; i < open.length; i++) {
        if (!(mask & (1 << i))) continue;
        sum += open[i].amountPaise;
        count++;
        idx.push(i);
        if (open[i].status === 'PROCESSING') processing = 1;
        if (open[i].status === 'PAID') paid += open[i].amountPaise;
      }
      if (sum !== amount) continue;
      // Never pick an entry already with the bank if avoidable, then prefer cancelling unpaid
      // entries over raising receivables, then the fewest entries, then the oldest.
      const key = [processing, Number(paid), count, ...idx];
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
    return open.filter((_e, i) => chosen & (1 << i));
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
    buffer: Buffer;
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
    /** WP5: entries left out of this file because a pending reversal holds them (empty on LEGACY tenants). */
    reversalHeld: ReversalHeldEntry[];
    /** Policy round B: entries whose TDS was (partly) covered by an earlier TDS credit (empty without credits). */
    tdsCreditApplied: TdsCreditAppliedLine[];
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
    const lockKeys = new Set<string>();
    for (const e of engineEntries) {
      const pan = outletTaxMap.get(e.outletId)?.panNumber?.trim().toUpperCase();
      lockKeys.add(
        pan
          ? `PAN|${pan}|${engineFyLabel}`
          : `NOPAN|${user.clientId}|${e.outletId}|${engineFyLabel}`,
      );
    }
    // Also serialize per-(tenant, period) downloadCode generation (STANDARD downloads have no
    // engine entries, so this is the only advisory lock they take).
    lockKeys.add(`PDLOCK|${user.clientId}|${period}`);
    const sortedLockKeys = [...lockKeys].sort();

    // FIX-8: the PAN cumulative aggregation + plan + ALL money writes run INSIDE this
    // $transaction, behind the per-PAN advisory locks acquired FIRST — so two concurrent
    // downloads for the same PAN serialize and cannot both under-deduct / mis-attribute recovery.
    const { rec: download, deductionByOutlet, creditByEntry } = await this.prisma.$transaction(
      async (tx) => {
        for (const k of sortedLockKeys) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${k}, 0))`;
        }

        // downloadCode generated INSIDE the tx under the PDLOCK advisory lock → sequential per
        // tenant even under concurrent downloads (unique per tenant, not globally).
        const downloadCode = await this.generateDownloadCode(tx, user.clientId, period);

        // Plan built against the LOCKED cumulative state (reads via tx).
        const tdsPlan = await this.buildPayoutTdsPlan(tx, {
          clientId: user.clientId,
          period,
          engineEntries,
          outletTaxMap,
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
        // audit row naming every adjusted entry. None for a tenant without credits.
        if (tdsPlan.creditDraws.length > 0) {
          await writeCreditApplications(tx, tdsPlan.creditDraws, { clientId: user.clientId, downloadId: rec.id });
          await tx.auditLog.create({
            data: {
              action: 'EXPORT',
              entityType: 'TDS_CREDIT_APPLIED',
              entityId: rec.id,
              actorId: user.sub,
              metadata: JSON.parse(
                JSON.stringify(
                  {
                    clientId: user.clientId,
                    downloadCode,
                    period,
                    draws: tdsPlan.creditDraws,
                    entries: [...tdsPlan.creditByEntry.entries()].map(([entryId, c]) => ({ entryId, ...c })),
                  },
                  (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
                ),
              ) as Prisma.InputJsonValue,
            },
          });
        }

        // FIX-1: GROSS-UP monthly TOP-UP TDS invoices (one per crossing period) for the DELTA
        // + the DELTA pro-rata recovery ledger ("in lieu of TDS" — dashboard-only).
        for (const gi of tdsPlan.grossUpInvoices) {
          const rep = gi.representative;
          const inv = await this.invoicesService.createTdsInvoice(tx, {
            clientId: user.clientId,
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
                panTdsTotalPaise: gi.bodyPaise,
                tenantBasePaise: r.tenantBasePaise,
                panBasePaise: gi.panBasePaise,
                tenantSharePaise: r.tenantSharePaise,
              })),
            });
          }
        }

        // FIX-9: no-PAN visibility recovery — tenant obligation only (no deduction, no invoice).
        // panNumber sentinel '__NO_PAN__'; per (clientId, outletCode) crossing. panBase/tenantBase
        // carry the cumulative/this-event base for the report; tdsInvoiceId stays null.
        if (tdsPlan.noPanRecovery.length > 0) {
          await tx.tdsRecoveryEntry.createMany({
            data: tdsPlan.noPanRecovery.map((r) => ({
              clientId: r.clientId,
              // FIX-B: encode the outlet so the no-PAN recovery telescopes per (clientId, outlet, FY).
              panNumber: CreditsService.noPanRecoveryKey(r.outletCode),
              section: r.section,
              fyLabel: r.fyLabel,
              tdsInvoiceId: null,
              panTdsTotalPaise: r.tenantSharePaise,
              tenantBasePaise: r.eventBasePaise,
              panBasePaise: r.cumulativeBasePaise,
              tenantSharePaise: r.tenantSharePaise,
            })),
          });
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
        return { rec, deductionByOutlet: tdsPlan.deductionByOutlet, creditByEntry: tdsPlan.creditByEntry };
      },
      { timeout: 180_000, maxWait: 20_000 },
    );
    // Policy round B — never silent: every entry whose TDS a credit reduced ("₹200 adjusted from earlier TDS credit").
    const entryById = new Map(entries.map((e) => [e.id, e]));
    const tdsCreditApplied: TdsCreditAppliedLine[] = [...(creditByEntry ?? new Map()).entries()].map(([entryId, c]) => {
      const e = entryById.get(entryId);
      return {
        entryId,
        outletId: e?.outletId ?? '',
        outletName: e?.outletName ?? '',
        duePaise: Number(c.duePaise),
        creditPaise: Number(c.creditPaise),
        withheldPaise: Number(c.duePaise - c.creditPaise),
        panMasked: maskPan(c.panNumber),
        note: `TDS due ${formatINR(c.duePaise)}: ${formatINR(c.creditPaise)} adjusted from earlier TDS credit, ${formatINR(c.duePaise - c.creditPaise)} withheld from this payout`,
      };
    });

    // Build the bank file AFTER the tx using the committed net (post-DEDUCT) amounts.
    const netPaiseFor = (code: string): number =>
      outletMap.get(code)!.amountPaise - Number(deductionByOutlet.get(code) ?? 0n);

    const rows: PayoutBatchRow[] = payableCodes.map((code) => {
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
    const totalAmountPaise = payableCodes.reduce((s, code) => s + netPaiseFor(code), 0);

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

    const buffer = generatePayoutFileBuffer(payoutBatch);

    return {
      buffer,
      downloadCode: download.downloadCode,
      downloadId: download.id,
      heldEntries,
      reversalHeld,
      tdsCreditApplied,
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
        },
      });
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
          select: { creditPayoutEntryId: true, panNumber: true },
        });
        const entryToPan = new Map<string, string>();
        for (const d of origDeductions) {
          if (d.creditPayoutEntryId && d.panNumber && !entryToPan.has(d.creditPayoutEntryId)) {
            entryToPan.set(d.creditPayoutEntryId, d.panNumber);
          }
        }
        const reversalRows = failedWithholding
          .map((f) => ({ f, pan: entryToPan.get(f.entryId) ?? null }))
          .filter((x): x is { f: (typeof failedWithholding)[number]; pan: string } => !!x.pan)
          .map(({ f, pan }) => ({
            clientId: user.clientId,
            panNumber: pan,
            section: f.tdsSection,
            fyLabel: this.fyForPeriod(f.period).fyLabel,
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
        tdsCreditReleased.push(...(await releaseCreditApplications(tx, failedEntryIdsAll, 'PAYOUT_FAILED')));
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
      reversals: await this.withPayoutAllocations(reversals),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
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
        payoutEntry: { select: { status: true, period: true, createdAt: true } },
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
        entryStatus: r.payoutEntry.status,
        period: r.payoutEntry.period,
        createdAt: r.payoutEntry.createdAt,
      });
      by.set(r.creditReversalId, list);
    }
    return reversals.map((r) => (by.has(r.id) ? { ...r, payoutEntries: by.get(r.id)! } : r));
  }

  // ─── GET /v1/admin/credits/batches/:id/payout-reversal-entries ─────────────
  /**
   * WP5 P1: the payout entries of (batch, outlet, field) a PAYOUT reversal may select, with why the others can't
   * be. `mode` tells the screen which form to show: LEGACY → the amount form (entries not listed — the interim
   * rule matches them itself) — also for SHADOW (owner 2026-11-16); V2 → the entry picker.
   */
  async listPayoutReversalEntries(user: JwtPayload, batchId: string, q: { outletId: string; fieldId: string }) {
    const batch = await this.prisma.creditBatch.findFirst({ where: { id: batchId, clientId: user.clientId } });
    if (!batch) throw new NotFoundException('Batch not found');
    const engineMode = await this.tenantSettings.getReversalEngineModeUncached(user.clientId);
    // Owner decision 2026-11-16 (policy round B): SHADOW behaves exactly like LEGACY for PAYOUT reversals — only V2
    // picks entries. `mode` is the effective PAYOUT mode the screen acts on; `engineMode` the tenant flag.
    const mode = engineMode === 'V2' ? 'V2' : 'LEGACY';
    const candidates =
      mode === 'LEGACY'
        ? []
        : await loadPayoutReversalCandidates(this.prisma, {
            clientId: user.clientId, batchId, outletId: q.outletId, fieldId: q.fieldId,
          });
    return {
      mode,
      engineMode,
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

    const { action, approvedPaise, remarks } = dto;

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

    // Wallet Reversal Engine (WP4): an approved POINTS reversal follows the tenant's engine mode (LEGACY default /
    // SHADOW / V2), resolved once per request and passed down. Reject / PAYOUT never read it.
    const pointsEngine =
      action === ReversalAction.approve && reversal.awardType === 'POINTS'
        ? await this.tenantSettings.getReversalEngineModeUncached(user.clientId)
        : null;
    const pointsKey = { batchId: reversal.batchId, outletCode: reversal.outletId, fieldId: reversal.fieldId };

    return this.prisma.$transaction(async (tx) => {
      // Policy round A Q5: a POINTS approval is refused while the tenant's reversal approvals are paused (wallet
      // backfill window). Reject is never paused (it moves no points).
      if (action === ReversalAction.approve && reversal.awardType === 'POINTS') {
        await assertPointsReversalsNotPaused(tx, this.tenantSettings, user.clientId);
      }
      // V2: position-based approve cap (batch row lock, Σ(amount − reversedPoints), Q5 refusal) — replaces the
      // legacy stored-rows cap and the interim current-partner / debt gate below.
      if (pointsEngine === 'V2') {
        // Lock THIS reversal row first and re-check it is still pending, so a concurrent second approval of the
        // same reversal gets the honest "already processed" — not a misleading cap message computed after the
        // winner's reversed amount landed (real-Postgres WP7 T-e3, 2026-11-16).
        const [cur] = await tx.$queryRaw<Array<{ status: string }>>(
          Prisma.sql`SELECT status FROM credit_reversals WHERE id = ${id} FOR UPDATE`,
        );
        if (!cur || cur.status !== 'PENDING_GIFSY') {
          throw new BadRequestException('Reversal already processed');
        }
        await this.assertV2PointsApproval(tx, pointsKey, finalApprovedPaise ?? 0n);
      }
      // ── Over-reversal guard (approve) ─────────────────────────────────────
      // Re-validated server-side at approval against the STORED batch rows, under the batch
      // row lock (serialises concurrent approvals/creates for this batch): Σ other live
      // reversals for (batch, outlet, field) + this approval ≤ the amount actually credited.
      if (action === ReversalAction.approve && pointsEngine !== 'V2') {
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
          { offsetWithholding: (e) => this.offsetWithholdingOnReversal(tx, user.clientId, e) },
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

      // ── Interim rules, re-checked at approval (design Q14 / Q9) ───────────
      // POINTS: refuse unless the receiving wallet holds the exact credit and carries no debt
      // (clawbackAward re-checks under the wallet row lock).
      let pointsTarget: { partnerId: string; walletId: string } | null = null;
      if (
        action === ReversalAction.approve && reversal.awardType === 'POINTS' && (finalApprovedPaise ?? 0n) > 0n &&
        pointsEngine !== 'V2'
      ) {
        pointsTarget = await this.walletService.assertPointsReversalAllowed(tx, {
          clientId: user.clientId, batchId: reversal.batchId, outletCode: reversal.outletId, fieldId: reversal.fieldId,
        });
      }
      // PAYOUT: the exact whole entries this reversal consumes — never one an earlier approval took.
      let payoutEntries: Awaited<ReturnType<CreditsService['selectPayoutEntriesForReversal']>> = [];
      if (action === ReversalAction.approve && reversal.awardType === 'PAYOUT' && (finalApprovedPaise ?? 0n) > 0n) {
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

      // ── POINTS reversal → wallet clawback (#16 reversal) ─────────────────
      let clawbackShortfall = 0;
      if (
        (pointsEngine === 'V2' && (finalApprovedPaise ?? 0n) > 0n) ||
        (pointsEngine === 'SHADOW' && pointsTarget)
      ) {
        // WP4: V2 → the position engine (receiving wallet(s), allocations, own-lot-first, debt restored);
        // SHADOW → LEGACY applied on pointsTarget (already gated above) + the v2 diff written to audit_logs.
        const res = await this.walletService.reverseCreditBatchPoints(tx, {
          ...pointsKey,
          clientId: user.clientId,
          creditReversalId: id,
          points: Number(finalApprovedPaise ?? 0n),
          actorId: user.sub,
          description: `Clawback for reversal ${id} — batch POINTS reversal`,
          mode: pointsEngine,
          legacyTarget: pointsTarget,
        });
        clawbackShortfall = res.shortfall;
      } else if (pointsTarget) {
        // LEGACY (default): today's floor-0 clawback on the outlet's current partner's wallet — unchanged.
        // approvedPaise field holds approved whole points for POINTS-type reversals.
        const cb = await this.walletService.clawbackAward(
          pointsTarget.partnerId,
          Number(finalApprovedPaise ?? 0n),
          {
            referenceType: 'CREDIT_REVERSAL',
            referenceId: id,
            sourceType: 'CREDIT_FIELD',
            sourceId: reversal.fieldId,
            description: `Clawback for reversal ${id} — batch POINTS reversal`,
            // The EXACT credit being reversed (batch + outlet + field): refused if this wallet
            // never received it or it landed on a negative balance.
            originalCredit: { batchId: reversal.batchId, outletCode: reversal.outletId, fieldId: reversal.fieldId },
          },
          tx,
        );
        clawbackShortfall = cb.shortfall;
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
              paidReceivablePaise += Number(cur.amountPaise);
              entryNotes.push(`entry ${payoutEntry.id} (PAID ${formatINR(cur.amountPaise)}) → recoverable receivable`);
              const withheld = cur.tdsDeductedPaise;
              const tdsNote =
                withheld > 0n
                  ? `TDS ${formatINR(withheld)} withheld on this paid entry is not adjusted (this program uses the standard reversal rules) — correct it off-platform`
                  : 'no TDS withheld';
              legacyOutcome?.receivable.push({
                entryId: payoutEntry.id,
                amountPaise: Number(cur.amountPaise),
                receivablePaise: Number(cur.amountPaise),
                tdsCreditPaise: 0,
                panMasked: null,
                tdsNote,
              });
              legacyOutcome?.lines.push({
                kind: 'RECEIVABLE',
                entryId: payoutEntry.id,
                text: `Recorded as owed · ${formatINR(cur.amountPaise)} · already paid — recover it off-platform · ${tdsNote}`,
              });
              settled = true;
              break;
            }
            if (cur.status === 'PROCESSING') throw sentToBank();
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
              const back = await releaseCreditApplications(tx, [payoutEntry.id], 'ENTRY_CANCELLED_BY_REVERSAL');
              const backPaise = back.reduce((s, r) => s + r.amountPaise, 0n);
              legacyOutcome?.cancelled.push({
                entryId: payoutEntry.id,
                amountPaise: Number(cur.amountPaise),
                wasStatus: cur.status,
                tdsOffsetPaise: Number(offset),
                tdsNote: offset > 0n ? `withheld TDS ${formatINR(offset)} offset in the TDS ledger` : 'no TDS withheld',
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
      if (!legacyOutcome) return { ...finalReversal, clawbackShortfall, payoutClawbackNote };
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
