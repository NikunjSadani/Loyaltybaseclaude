import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, TdsMethodology, TdsSection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { WHATSAPP_KYC } from '../notifications/whatsapp-kyc.config';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { InvoicesService } from '../invoices/invoices.service';
import {
  deriveFrozenSection,
  computeDeduction,
  computeGrossUpTdsInvoiceBasePaise,
  allocateProRataRecovery,
} from '../tds/tds-methodology.helper';
import { grossUpTdsPaise, rate194C, rate194R, TdsRate } from '../tds/tds.helpers';
import { ensureOutletAccount } from '../common/reward-account.helper';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { paiseToRupees, toPaiseBigInt } from '../common/money';
import { monthYearIST, formatDateIST } from '../common/ist-date';
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
  PayoutBatch,
  PayoutBatchRow,
} from './credits.helpers';

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
  ) {}

  // ─── Visibility-payout TDS constants + helpers (Stream B) ──────────────────
  // Statutory thresholds in integer paise. These MIRROR the private constants in
  // tds.service.ts (Stream A owns that file; a single-source consolidation into
  // tds.helpers is a follow-up) — keep them in lock-step.
  private static readonly TDS_194C_SINGLE_THRESHOLD_PAISE = 3_000_000n; // ₹30,000 single payment
  private static readonly TDS_194C_FY_THRESHOLD_PAISE = 10_000_000n; // ₹1,00,000 FY aggregate
  private static readonly TDS_194R_FY_THRESHOLD_PAISE = 2_000_000n; // ₹20,000 FY aggregate
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

  /** 194C: FY-aggregate OR single-payment threshold; 194R: FY-aggregate only. */
  private tdsThresholdMet(section: TdsSection, cumulativeBasePaise: bigint, maxSinglePaise: bigint): boolean {
    if (section === TdsSection.SEC_194C) {
      return (
        cumulativeBasePaise > CreditsService.TDS_194C_FY_THRESHOLD_PAISE ||
        maxSinglePaise > CreditsService.TDS_194C_SINGLE_THRESHOLD_PAISE
      );
    }
    return cumulativeBasePaise > CreditsService.TDS_194R_FY_THRESHOLD_PAISE;
  }

  /** The {num,den} rate fraction for a frozen section (194C entity-aware; 194R PAN-aware). */
  private tdsRateFor(section: TdsSection, hasPan: boolean, entityType: string | null): TdsRate {
    return section === TdsSection.SEC_194C ? rate194C(hasPan, entityType) : rate194R(hasPan);
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
    };
    if (engineEntries.length === 0) return plan;

    const { fyLabel, startPeriod, endPeriod } = this.fyForPeriod(period);
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
      const rate = this.tdsRateFor(g.section, true, g.entityType);
      const thresholdMet = this.tdsThresholdMet(g.section, combinedCumulativeBase, combinedMaxSingle);

      if (g.methodology === TdsMethodology.DEDUCT) {
        const priorDeducted = priorDeductedByPS.get(ps) ?? 0n;
        const { tdsDueCumulativePaise, tdsDeductThisPaise, carryForwardPaise } = computeDeduction({
          cumulativeBasePaise: methodologyCumulativeBase, // FIX-D: DEDUCT-methodology base only
          priorDeductedPaise: priorDeducted,
          thisPayoutPaise: thisEventBase,
          rate,
          thresholdMetOnCumulative: thresholdMet, // FIX-D: combined per-PAN threshold
        });
        // Exact-summing split of the withheld amount across this event's entries.
        const split =
          tdsDeductThisPaise > 0n
            ? allocateProRataRecovery({
                panTdsTotalPaise: tdsDeductThisPaise,
                tenants: g.entries.map((e) => ({ clientId: e.id, basePaise: e.amountPaise })),
              })
            : [];
        const shareByEntry = new Map<string, bigint>(
          split.map((s): [string, bigint] => [s.clientId, s.tenantSharePaise]),
        );
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
      const noPanRate = rate194C(false, null);
      for (const ng of noPanGroups.values()) {
        const os = `${ng.outletCode}${SEP}${ng.section}`;
        const thisEventBase = ng.entries.reduce((s, e) => s + e.amountPaise, 0n);
        const priorBase = priorNoPanByOS.get(os) ?? 0n;
        const cumulativeBase = priorBase + thisEventBase;
        const eventMaxSingle = ng.entries.reduce((m, e) => (e.amountPaise > m ? e.amountPaise : m), 0n);
        const priorMaxSingle = priorNoPanMaxByOS.get(os) ?? 0n;
        const cumMaxSingle = eventMaxSingle > priorMaxSingle ? eventMaxSingle : priorMaxSingle;
        const nowCrossed = this.tdsThresholdMet(ng.section, cumulativeBase, cumMaxSingle);
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
   * Send the outlet OWNER a WhatsApp template on a POINTS credit (deoleo_points_credit).
   *
   * Fire-and-forget + POST-COMMIT: MUST NEVER throw into — or roll back — the credit
   * batch (the batch is CONFIRMED before this runs). Every path is wrapped in try/catch
   * and swallowed (mirrors KycService.sendKycWhatsapp). Tenant-gated via WHATSAPP_KYC:
   * a clientId with no `pointsCreditTemplate` no-ops. Skips silently if the owner has
   * no phone.
   *
   * bodyValues (in template order):
   *   {{1}} ownerName · {{2}} points credited · {{3}} redeemable balance AFTER the credit
   *   {{4}} month-year credited ("July 2026") · {{5}} date credited ("06 Jul 2026")
   */
  private async sendPointsCreditWhatsapp(
    clientId: string,
    data: {
      partnerId: string;
      ownerName?: string | null;
      phone?: string | null;
      totalPoints: number;
      period: string;
    },
  ): Promise<void> {
    try {
      const template = WHATSAPP_KYC[clientId]?.pointsCreditTemplate;
      if (!template) return; // tenant not configured for WhatsApp → no-op

      const phone = data.phone?.trim();
      if (!phone) {
        this.logger.warn(`[credit-whatsapp] points-credit skipped — no owner phone (client ${clientId})`);
        return;
      }

      // Redeemable balance AFTER the credit — read the partner's wallet. A missing
      // wallet (never credited) reads 0; never throws.
      const wallet = await this.prisma.wallet.findFirst({
        where: { partnerId: data.partnerId },
        select: { redeemablePoints: true },
      });
      const redeemableBalance = wallet?.redeemablePoints ?? 0;

      const ownerName = data.ownerName?.trim() || 'Partner';
      await this.msg91.sendWhatsappTemplate(phone, template, [
        ownerName,
        String(data.totalPoints),
        String(redeemableBalance),
        monthYearIST(data.period),
        formatDateIST(new Date()),
      ]);
    } catch (e) {
      // Non-critical: a WhatsApp delivery failure must NEVER fail the credit batch.
      this.logger.warn(`[credit-whatsapp] points-credit send failed (client ${clientId}): ${e}`);
    }
  }

  // ─── Settings-enforcement helpers (Stream MONEY-CREDITS) ──────────────────
  // The credit/payout safety caps and the month-cutoff window were previously
  // FRONTEND-ONLY (platform/src/app/admin/credits-payouts/upload/page.tsx +
  // credits-payouts-parser.ts). They are bypassable via a direct API call, so we
  // now MIRROR them server-side from the per-tenant TenantSettingsService.

  /** Current month as `YYYY-MM` on the server clock — matches the FE's `getPreviousMonth`
   *  baseline and the existing `targets.helpers.currentMonthKey` (both server-clock, no IST
   *  conversion; the FE's `isUploadWindowOpen` likewise reads a plain `new Date()`). */
  private currentPeriodKey(now: Date = new Date()): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Mirror of the FE `isUploadWindowOpen(cutoffDay)` =
   * `new Date().getDate() <= cutoffDay`. A batch for a PRIOR month (period strictly
   * before the current month, `YYYY-MM` string compare) may only be created/confirmed
   * while today's day-of-month is on/before `monthCutoffDay`. Current/future-month
   * batches are unaffected (the FE only ever uploads the previous month, so the prior-
   * month case is the one the window guards).
   */
  private assertWithinUploadWindow(period: string, monthCutoffDay: number): void {
    const now = new Date();
    const current = this.currentPeriodKey(now);
    // Only PRIOR-month batches are gated. Same string-compare as targets isMonthLocked.
    if (period < current && now.getDate() > monthCutoffDay) {
      throw new BadRequestException(
        `The upload window for prior-month period ${period} closed on day ${monthCutoffDay} ` +
          `of the current month (today is day ${now.getDate()}). Batches for past months ` +
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
  async createBatch(user: JwtPayload, dto: CreateBatchDto) {
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

    // Generate the code + create UNDER a per-(clientId, period) advisory lock so concurrent
    // createBatch calls for the same tenant/period serialize into sequential codes (batchCode is
    // now unique per tenant, not globally — a different tenant reusing CB-<period>-001 is fine).
    const batch = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`CBATCH|${user.clientId}|${dto.period}`}, 0))`;
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

    const payoutRows = rows.filter((r) => r.awardType === 'PAYOUT' && r.status === 'OK');
    // amount > 0: creditEarn rejects non-positive amounts; a 0/negative POINTS row
    // would throw inside the tx and roll back the whole confirm (incl. PAYOUT entries).
    const pointsRows = rows.filter(
      (r) => r.awardType === 'POINTS' && r.status === 'OK' && r.amount > 0,
    );

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

    // Best-effort PUSH "points earned" trigger (PWA F5). Resolve each credited
    // partner's userId AFTER commit and enqueue a PUSH row. Wrapped so push can
    // NEVER break the money path; the SMS/email below is unaffected.
    try {
      for (const [partnerId, totalPoints] of creditedByPartner) {
        // Fetch the owner identity for BOTH the PUSH (userId) and the WhatsApp
        // (ownerName + phone) in one read.
        const partner = await this.prisma.channelPartner.findFirst({
          where: { id: partnerId },
          select: { userId: true, ownerName: true, phone: true },
        });
        if (partner?.userId) {
          await this.notifications
            .enqueue({
              userId: partner.userId,
              channel: 'PUSH',
              subject: 'Points credited',
              body: `You earned ${totalPoints} points.`,
              // url = deep-link so a tapped push opens a real authenticated route (a urless push falls back to '/' → /auth/login).
              variables: { event: 'WALLET_POINTS_EARNED', points: totalPoints, batchId: id, url: '/partner/wallet' },
            })
            .catch(() => undefined);
        }

        // Owner WhatsApp on points credit (deoleo_points_credit). Tenant-gated +
        // fire-and-forget + POST-COMMIT: this MUST NEVER throw into or roll back the
        // money transaction (the batch is already CONFIRMED above). Mirrors the KYC
        // send style — resolve the template, no-op if the tenant is unconfigured or
        // the owner has no phone, and swallow any delivery failure.
        await this.sendPointsCreditWhatsapp(user.clientId, {
          partnerId,
          ownerName: partner?.ownerName ?? null,
          phone: partner?.phone ?? null,
          totalPoints,
          period: batch.period,
        });
      }
    } catch {
      // Best-effort: a push/whatsapp failure must never affect a confirmed credit batch.
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

    // Block a duplicate pending reversal for the same outlet+field in this batch.
    const existingPending = await this.prisma.creditReversal.findFirst({
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

    // The pre-check above is the fast path, but a concurrent request can slip past
    // it (read-then-write race). The DB partial-unique index
    // `credit_reversals_pending_unique` on (batchId,outletId,fieldId) WHERE
    // status='PENDING_GIFSY' is the authoritative guard — translate its P2002 into
    // the same clean 400.
    try {
      return await this.prisma.creditReversal.create({
        data: {
          clientId: user.clientId,
          batchId: id,
          outletId: dto.outletId,
          outletName: dto.outletName,
          fieldId: dto.fieldId,
          fieldName: dto.fieldName,
          period: batch.period,
          awardType: dto.awardType,
          // Store as BigInt paise (or whole points for POINTS awardType).
          originalPaise: toPaiseBigInt(dto.originalPaise),
          requestedPaise: toPaiseBigInt(dto.requestedPaise),
          requestedBy: user.sub,
        },
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
      throw e;
    }
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
        outletType: { select: { code: true } },
      },
      orderBy: { outletCode: 'asc' },
    });

    return outlets.map((o) => ({
      id: o.outletCode,
      name: o.name,
      type: o.outletType.code,
      phone: o.phone ?? undefined,
    }));
  }

  // ─── GET /v1/admin/credits/outlet-types ────────────────────────────────────
  // The award editor needs the tenant's ENABLED outlet types so an admin can set
  // POINTS/PAYOUT/NA per type without a hardcoded list. Keyed on OutletType.code —
  // the SAME value the upload parser resolves against (`outletTypeAwards[outlet.type]`,
  // where outlet.type is the OutletType.code) — so the configured map keys always
  // match the codes stored on outlets. Tenant-scoped; enabled + active only.
  async listOutletTypes(user: JwtPayload): Promise<{ code: string; label: string }[]> {
    const configs = await this.prisma.outletTypeClientConfig.findMany({
      where: {
        clientId: user.clientId,
        isEnabled: true,
        outletType: { isActive: true },
      },
      include: { outletType: { select: { code: true, name: true } } },
    });
    return configs
      .map((c) => ({ code: c.outletType.code, label: c.displayName ?? c.outletType.name }))
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

    if (entries.length === 0) {
      throw new BadRequestException(
        `No PENDING or FAILED payout entries found for period ${period}${
          fieldId ? ` / field ${fieldId}` : ''
        }.`,
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
        `No payable entries for period ${period}: all ${heldEntries.length} outlet(s) are held (KYC not approved or partner inactive/deleted).`,
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
    const { rec: download, deductionByOutlet } = await this.prisma.$transaction(
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
            data: { downloadId: rec.id, status: 'PROCESSING' },
          });
          if (claimed.count !== payableEntryIds.length) {
            throw new ConflictException(
              `Payout claim race for period ${period}: expected ${payableEntryIds.length} ` +
                `entries but claimed ${claimed.count}. Rolled back — retry the download.`,
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

        return { rec, deductionByOutlet: tdsPlan.deductionByOutlet };
      },
      { timeout: 180_000, maxWait: 20_000 },
    );

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
        phone: o?.phone ?? '',
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

    return { buffer, downloadCode: download.downloadCode, downloadId: download.id, heldEntries };
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

    // Injectable batch rows from DB.
    const batchRows = download.entries.map((e) => ({
      outletId: e.outletId,
      utrStatus: (e.status === 'PAID'
        ? 'PAID'
        : e.status === 'FAILED'
          ? 'FAILED'
          : 'PENDING') as 'PENDING' | 'PAID' | 'FAILED',
      utr: e.utr ?? undefined,
    }));

    // Known UTRs across all downloads for this client (dup detection).
    const usedUtrs = await this.prisma.creditPayoutEntry.findMany({
      where: { clientId: user.clientId, utr: { not: null } },
      select: { utr: true },
    });
    const knownUtrs = new Set<string>(
      usedUtrs.filter((e) => e.utr != null).map((e) => e.utr!.toUpperCase()),
    );

    const parseResult = parseUtrUpload(ab, {
      downloadCode: download.downloadCode,
      batchRows,
      knownUtrs,
    });

    // Preview unless apply=true.
    if (!apply) {
      return { parseResult, downloadCode: download.downloadCode };
    }

    if (!parseResult.canProceed) {
      throw new BadRequestException('Cannot apply — parse result has errors or no valid rows');
    }

    const now = new Date();
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
        },
      });
      const freshByOutlet = new Map(freshEntries.map((e) => [e.outletId, e]));

      for (const row of parseResult.rows) {
        if (row.status !== 'OK') continue;

        const entry = freshByOutlet.get(row.outletId);
        if (!entry) continue;

        // FIX-C: GUARDED flip — only an entry still PROCESSING transitions. A concurrent apply that
        // already moved it returns count 0 → we skip it (and never reverse its withholding twice).
        const flip = await tx.creditPayoutEntry.updateMany({
          where: { id: entry.id, status: 'PROCESSING' },
          data: {
            status: row.success ? 'PAID' : 'FAILED',
            utr: row.success ? row.utr || null : null,
            paidAt: row.success ? now : null,
            // FIX-3: a FAILED payout withheld nothing → clear the stamped deduction.
            ...(row.success ? {} : { tdsDeductedPaise: 0n }),
          },
        });
        if (flip.count === 0) continue; // not transitioned by THIS call → no reversal

        // FIX-3/FIX-C: collect FAILED entries THIS call transitioned that carried a DEDUCT
        // withholding, using their in-tx tdsDeductedPaise (never a stale snapshot).
        if (!row.success && entry.tdsDeductedPaise > 0n && entry.tdsSection) {
          failedWithholding.push({
            entryId: entry.id,
            outletId: entry.outletId,
            tdsDeductedPaise: entry.tdsDeductedPaise,
            tdsSection: entry.tdsSection,
            period: entry.period,
          });
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

      const stillPending = freshEntries.some((e) => {
        const row = parseResult.rows.find((r) => r.outletId === e.outletId);
        return !row || row.status === 'SKIP';
      });
      await tx.creditPayoutDownload.update({
        where: { id: download.id },
        data: { status: stillPending ? 'PARTIALLY_PAID' : 'PAID' },
      });

      // Lock the linked SERVICE invoice at UTR entry (D12): once the payout UTR/date is
      // recorded the invoice number can no longer be edited. We lock by (clientId, outletCode,
      // period, SERVICE) for the successfully-paid outlets — robust whether or not the entry's
      // autoInvoiceId was set at confirm. lockedAt=null guard keeps it idempotent (a re-apply
      // never re-stamps an already-locked invoice).
      const lockedOutletCodes = parseResult.rows
        .filter((r) => r.status === 'OK' && r.success)
        .map((r) => r.outletId);
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

    // Notify paid outlets (fire-and-forget; needs phone from outlet).
    const paidOutletIds = parseResult.rows
      .filter((r) => r.status === 'OK' && r.success)
      .map((r) => r.outletId);

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
        for (const row of parseResult.rows) {
          if (row.status !== 'OK' || !row.success) continue;
          const entry = download.entries.find((e) => e.outletId === row.outletId);
          const outlet = phoneMap.get(row.outletId);
          const phone = outlet?.partner?.phone?.trim();
          if (!entry || !phone) continue;

          // Owner WhatsApp on payout credit (deoleo_payout_credit). DIRECT send (the old
          // queued WHATSAPP notify() never delivered — the queue only drains PUSH), fire-
          // and-forget + POST-COMMIT: the money tx above is already committed, so this
          // MUST NEVER throw into it. Tenant-gated via WHATSAPP_KYC.
          //   {{1}} ownerName · {{2}} points · {{3}} UTR · {{4}} date of payment · {{5}} month
          // pointsPaid = paid amount as a whole number (Deoleo: 1 point = ₹1 → paise ÷ 100;
          // assumes a 1:1 conversion rate, which the Deoleo tenant runs).
          try {
            const template = WHATSAPP_KYC[user.clientId]?.payoutCreditTemplate;
            if (template) {
              const ownerName = outlet?.partner?.ownerName?.trim() || 'Partner';
              const pointsPaid = Math.round(Number(entry.amountPaise) / 100);
              await this.msg91.sendWhatsappTemplate(phone, template, [
                ownerName,
                String(pointsPaid),
                row.utr ?? '',
                formatDateIST(new Date()),
                monthYearIST(download.period),
              ]);
            }
          } catch (e) {
            // Non-critical: a WhatsApp delivery failure must NEVER fail the payout.
            this.logger.warn(`[credit-whatsapp] payout-credit send failed (client ${user.clientId}): ${e}`);
          }
        }
      } catch (e) {
        // Non-critical: the post-commit fetch/notify must never surface as a 500.
        this.logger.warn(`[credit-whatsapp] payout-credit notify block failed (client ${user.clientId}): ${e}`);
      }
    }

    return {
      applied: true,
      paidCount: parseResult.summary.paidCount,
      failedCount: parseResult.summary.failedCount,
      skippedCount: parseResult.summary.skipped,
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

    return { reversals, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
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

    return this.prisma.$transaction(async (tx) => {
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
        },
      });
      if (claimed.count === 0) {
        throw new BadRequestException('Reversal already processed');
      }

      // ── POINTS reversal → wallet clawback (#16 reversal) ─────────────────
      let clawbackShortfall = 0;
      if (action === ReversalAction.approve && reversal.awardType === 'POINTS') {
        // approvedPaise field holds approved whole points for POINTS-type reversals.
        const approvedPoints = Number(finalApprovedPaise ?? 0n);
        if (approvedPoints > 0) {
          // Resolve outletCode → partnerId (tenant-scoped).
          const outlet = await tx.outlet.findFirst({
            where: { outletCode: reversal.outletId, clientId: user.clientId },
            select: { partnerId: true },
          });

          if (outlet?.partnerId) {
            // Guard: check wallet existence without throwing (a throw aborts the tx).
            const wallet = await tx.wallet.findFirst({
              where: { partnerId: outlet.partnerId },
              select: { id: true },
            });

            if (wallet) {
              const cb = await this.walletService.clawbackAward(
                outlet.partnerId,
                approvedPoints,
                {
                  referenceType: 'CREDIT_REVERSAL',
                  referenceId: id,
                  sourceType: 'CREDIT_FIELD',
                  sourceId: reversal.fieldId,
                  description: `Clawback for reversal ${id} — batch POINTS reversal`,
                },
                tx,
              );
              clawbackShortfall = cb.shortfall;
            }
            // If no wallet: reversal still lands; points were never credited to
            // a wallet so there is nothing to claw back. This is a consistent no-op.
          }
        }
      }

      // ── GLM-1: PAYOUT reversal → cash clawback ────────────────────────────
      // A PAYOUT-type reversal means cash (not points) was (or will be) disbursed.
      //
      // WHY ITERATE ALL ENTRIES (not findFirst):
      //   One outlet+field can legitimately produce MULTIPLE CreditPayoutEntry rows
      //   across different batches (e.g. monthly top-ups). The old findFirst(orderBy
      //   createdAt desc) clawed back only the LATEST entry — silently missing any
      //   earlier outstanding entries for the same outlet+field+scope. We now iterate
      //   ALL matching entries and apply the correct action to each.
      //
      // ACTION PER ENTRY:
      //   PENDING / PROCESSING → status=REVERSED + downloadId=null (permanently
      //     removed from payability — GLM-2's re-download excludes REVERSED entries).
      //     IMPORTANT: must be REVERSED (not FAILED) so GLM-2 cannot resurrect them.
      //     Cash never left; no receivable.
      //   PAID → cash already disbursed; record its amount as a recoverable receivable
      //     and accumulate into clawbackShortfall.
      //   REVERSED → already clawed back (idempotent for a repeated reversal attempt);
      //     skip silently.
      //   FAILED → bank-rejected; cash never left; mark REVERSED to permanently
      //     remove from payability (GLM-2 would otherwise re-bank it, which we do NOT
      //     want after an approved reversal).
      let payoutClawbackNote: string | null = null;
      if (action === ReversalAction.approve && reversal.awardType === 'PAYOUT') {
        const approvedPaiseNum = Number(finalApprovedPaise ?? 0n);
        if (approvedPaiseNum > 0) {
          // Find ALL CreditPayoutEntry rows for this outlet+field combination
          // (tenant-scoped). outletId in the reversal is the outletCode (same as
          // CreditPayoutEntry.outletId).
          const payoutEntries = await tx.creditPayoutEntry.findMany({
            where: {
              clientId: user.clientId,
              outletId: reversal.outletId,
              fieldId: reversal.fieldId ?? undefined,
              // Only actionable statuses: REVERSED is already done (idempotent),
              // FAILED needs to be permanently removed (not re-bankable).
              status: { in: ['PENDING', 'PROCESSING', 'PAID', 'FAILED'] },
            },
            orderBy: { createdAt: 'desc' },
          });

          if (payoutEntries.length === 0) {
            // No matching payout entries found: the award may have been reversed before
            // confirmation or the entries were already deleted. Reversal lands cleanly.
            payoutClawbackNote = `No matching PAYOUT entries found for outlet ${reversal.outletId} / field ${reversal.fieldId ?? 'any'}; reversal recorded with no cash action.`;
          } else {
            let reversedCount = 0;
            let paidReceivablePaise = 0;
            const entryNotes: string[] = [];

            for (const payoutEntry of payoutEntries) {
              if (
                payoutEntry.status === 'PENDING' ||
                payoutEntry.status === 'PROCESSING' ||
                payoutEntry.status === 'FAILED'
              ) {
                // Cash not yet disbursed (PENDING/PROCESSING) OR bank-rejected (FAILED):
                // permanently remove from payability by marking REVERSED with downloadId=null.
                // REVERSED is the correct terminal status — GLM-2 excludes REVERSED from
                // re-banking, whereas FAILED is considered bank-rejected and re-bankable.
                await tx.creditPayoutEntry.update({
                  where: { id: payoutEntry.id },
                  data: { status: 'REVERSED', downloadId: null },
                });
                reversedCount++;
                entryNotes.push(
                  `entry ${payoutEntry.id} (was ${payoutEntry.status}) → REVERSED`,
                );
              } else if (payoutEntry.status === 'PAID') {
                // Cash already disbursed: record a recoverable receivable (off-platform).
                // Accumulate across all PAID entries for this outlet+field.
                paidReceivablePaise += Number(payoutEntry.amountPaise);
                entryNotes.push(
                  `entry ${payoutEntry.id} (PAID ₹${(Number(payoutEntry.amountPaise) / 100).toFixed(2)}) → recoverable receivable`,
                );
              }
            }

            // clawbackShortfall is the aggregate of all PAID entries' amounts.
            // This mirrors the POINTS-clawback shortfall pattern.
            if (paidReceivablePaise > 0) {
              clawbackShortfall = paidReceivablePaise;
            }

            payoutClawbackNote = [
              `GLM-1 clawback: ${payoutEntries.length} entries processed`,
              `(${reversedCount} reversed, ${paidReceivablePaise > 0 ? `₹${(paidReceivablePaise / 100).toFixed(2)} recoverable receivable` : 'no paid receivable'}).`,
              ...entryNotes,
            ].join(' | ');
          }
        }
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
      return { ...finalReversal, clawbackShortfall, payoutClawbackNote };
    });
  }
}
