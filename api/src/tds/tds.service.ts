/**
 * TDS aggregation engine — P6.5a.
 *
 * Computes per-(PAN, section, FY) liability / deposited / outstanding.
 * READ-ONLY (no writes). Uploads and write-side = 6.5b.
 *
 * Money: all amounts in BigInt paise. TDS rounded to nearest rupee.
 * Null-PAN bucket: keyed as '__NO_PAN__'; always at 20% rate.
 *
 * ── 194R (per clientId, per FY) ──────────────────────────────────────────────
 * Sources summed per PAN:
 *   1. Non-visibility CreditPayoutEntry (status PAID, paidAt in FY, field NOT isSeparatePayout)
 *      → PAN via Outlet→ChannelPartner
 *   2. RedemptionOrder.valuePaise for DELIVERED/FULFILLED redemptions (deliveredAt in FY)
 *      → PAN via ChannelPartner
 *   3. TdsOffPlatformEntry (section=SEC_194R, clientId, entryDate in FY)
 *      → PAN on the row
 * Threshold: fyTotal > 2,000,000 paise (₹20,000) → liability on WHOLE fyTotal (retroactive).
 * Deposited: SUM TdsDeposit (section=SEC_194R, clientId, depositDate in FY, panNumber).
 *
 * ── 194C (platform-wide, per FY) ────────────────────────────────────────────
 * Sources summed per PAN:
 *   Visibility CreditPayoutEntry (isSeparatePayout=true field, status PAID, paidAt in FY)
 *   → PAN via Outlet→ChannelPartner; entityType too.
 * Threshold: maxSingle > 3,000,000 paise OR fyTotal > 10,000,000 paise.
 * Two columns: (a) with-threshold, (b) no-threshold (TDS on everything).
 * Deposited: SUM TdsDeposit (section=SEC_194C, panNumber, FY) — clientId null.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  fyFromLabel,
  fyLabelForPeriod,
  periodWindowForFy,
  grossUpTdsPaise,
  rate194RFrom,
  rate194CFrom,
  roundToRupeePaise,
  sectionParamToEnum,
  effectiveEntrySection,
  parseOffPlatformUpload,
  parseDepositUpload,
  buildOffPlatformTemplate,
  buildDepositTemplate,
  offPlatformFileHash,
  depositFileHash,
  cellSafe,
} from './tds.helpers';
import { TdsStatutoryConfigService } from './tds-statutory.config.service';
import { withholdingTdsPaise } from './tds-methodology.helper';
import type { UploadResult } from './dto/tds.dto';
import { buildXlsx } from '../common/xlsx';
import { paiseToRupees } from '../common/money';

// ─── Result types ─────────────────────────────────────────────────────────────

const NO_PAN_KEY = '__NO_PAN__';

export interface TdsRow194R {
  panNumber: string; // '__NO_PAN__' for the null bucket
  fyLabel: string;
  baseFyTotalPaise: bigint;
  liabilityPaise: bigint;
  depositedPaise: bigint;
  outstandingPaise: bigint;
}

/** GROSS-UP "in lieu of TDS" recovery attributed to one contributing tenant (report-only). */
export interface TdsRecoveryAttribution {
  clientId: string;
  tenantSharePaise: bigint;
}

/** Which methodology(-ies) the PAN's 194C entries were FROZEN with. */
export type TdsMethodologyLabel = 'DEDUCT' | 'GROSS_UP' | 'MIXED' | null;

export interface TdsRow194C {
  panNumber: string;
  entityType: string;
  fyLabel: string;
  baseFyTotalPaise: bigint;
  maxSinglePaise: bigint; // highest single payment (for threshold check)
  thresholdMet: boolean;
  liabilityPaise: bigint;           // (a) with-threshold
  liabilityNoThresholdPaise: bigint; // (b) no-threshold
  depositedPaise: bigint;
  outstandingPaise: bigint; // liability − (deposited + withheld); can be negative
  // ── Methodology-aware fields (reflect the DEDUCT / GROSS-UP ledgers) ──
  methodology: TdsMethodologyLabel; // frozen methodology on the PAN's entries (MIXED if both)
  withheldPaise: bigint;   // DEDUCT: sum of TdsDeductionEntry.tdsDeductedThisPaise (already collected)
  recoveredPaise: bigint;  // GROSS-UP: sum of TdsRecoveryEntry.tenantSharePaise (report-only attribution)
  recoveryByTenant: TdsRecoveryAttribution[]; // GROSS-UP per-tenant recovery split (report-only)
}

export interface TdsSummary194R {
  fyLabel: string;
  clientId: string;
  totalBasePaise: bigint;
  totalLiabilityPaise: bigint;
  totalDepositedPaise: bigint;
  totalOutstandingPaise: bigint;
  rowCount: number;
}

export interface TdsSummary194C {
  fyLabel: string;
  totalBasePaise: bigint;
  totalLiabilityPaise: bigint;
  totalLiabilityNoThresholdPaise: bigint;
  totalDepositedPaise: bigint;
  totalWithheldPaise: bigint;   // DEDUCT collected via withholding (ledger)
  totalRecoveredPaise: bigint;  // GROSS-UP recovered attribution (ledger, report-only)
  totalOutstandingPaise: bigint;
  rowCount: number;
}

// ─── Internal accumulators ───────────────────────────────────────────────────

interface PanAccum194R {
  panNumber: string;
  hasPan: boolean;
  totalPaise: bigint;
}

interface PanAccum194C {
  panNumber: string;
  hasPan: boolean;
  entityType: string;
  totalPaise: bigint;
  maxSinglePaise: bigint;
  methodologies: Set<'DEDUCT' | 'GROSS_UP'>; // frozen methodologies seen on this PAN's entries
  // FIX-2: base split by frozen methodology so liability uses the CORRECT statutory basis —
  // DEDUCT → withholding (base×rate/100); GROSS_UP (and null/legacy) → gross-up (base×rate/den).
  deductBasePaise: bigint;
  grossUpBasePaise: bigint;
}

// ─── Thresholds (paise) ──────────────────────────────────────────────────────

// Statutory rates + thresholds are resolved per financial year from the single platform-level
// source of truth (TdsStatutoryConfigService.getForFy) inside compute194R/compute194C — no local
// copies here (this used to duplicate the constants in credits.service; that drift risk is gone).

@Injectable()
export class TdsService {
  private readonly logger = new Logger(TdsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly statutory: TdsStatutoryConfigService,
  ) {}

  // ─── 194R ───────────────────────────────────────────────────────────────────

  /**
   * Compute 194R rows for a given clientId and FY label (e.g. "2025-26").
   * Aggregates all three sources, applies the retroactive threshold, and
   * subtracts actual deposits to produce outstanding.
   */
  async compute194R(clientId: string, fyLabel: string): Promise<TdsRow194R[]> {
    const cfg = await this.statutory.getForFy(fyLabel);
    const fy = fyFromLabel(fyLabel);
    const { start, endExclusive } = fy;
    // FIX-4: VISIBILITY entries frozen 194R are anchored by their payout PERIOD's FY (matching
    // the ledger); INCENTIVE (non-visibility) 194R keeps its paidAt anchor.
    const { startPeriod, endPeriod } = periodWindowForFy(fyLabel);

    // Accumulate per PAN
    const accum = new Map<string, PanAccum194R>();

    const addToPan = (pan: string | null | undefined, amountPaise: bigint) => {
      const key = pan && pan.trim() ? pan.trim().toUpperCase() : NO_PAN_KEY;
      const hasPan = key !== NO_PAN_KEY;
      const existing = accum.get(key);
      if (existing) {
        existing.totalPaise += amountPaise;
      } else {
        accum.set(key, { panNumber: key, hasPan, totalPaise: amountPaise });
      }
    };

    // Visibility field IDs (the explicit classifier) — needed both to widen the query by
    // period and to resolve the FROZEN-null fallback classification (effectiveEntrySection).
    const visibilityFields = await this.prisma.creditField.findMany({
      where: { clientId, payoutStream: 'VISIBILITY' },
      select: { id: true },
    });
    const visibilityFieldIds = new Set(visibilityFields.map((f) => f.id));
    const visFieldIdArr = [...visibilityFieldIds];

    // ── Source 1: CreditPayoutEntry whose EFFECTIVE section is 194R ──────────────
    // Two windows, unioned by id (a visibility row can satisfy both):
    //   A) paidAt in FY  — covers INCENTIVE (paidAt anchor) + visibility paid within the FY
    //   B) period in FY  — covers VISIBILITY frozen-194R whose PERIOD (not paidAt) lands in FY
    // Each row is then re-checked with its correct anchor so a visibility row whose PERIOD is
    // in a DIFFERENT FY (but whose paidAt happened to fall in this one) is dropped.
    // NOTE: CreditPayoutEntry.outletId stores the outletCode (string code), NOT the Outlet PK.
    const paidAtEntries = await this.prisma.creditPayoutEntry.findMany({
      where: { clientId, status: 'PAID', paidAt: { gte: start, lt: endExclusive } },
      select: { id: true, amountPaise: true, fieldId: true, outletId: true, tdsSection: true, period: true },
    });
    const periodVisEntries = visFieldIdArr.length
      ? await this.prisma.creditPayoutEntry.findMany({
          where: {
            clientId,
            status: 'PAID',
            period: { gte: startPeriod, lte: endPeriod },
            fieldId: { in: visFieldIdArr },
          },
          select: { id: true, amountPaise: true, fieldId: true, outletId: true, tdsSection: true, period: true },
        })
      : [];

    const unionById = new Map<string, (typeof paidAtEntries)[number]>();
    for (const e of [...paidAtEntries, ...periodVisEntries]) unionById.set(e.id, e);

    const section194REntries = [...unionById.values()].filter((e) => {
      const isVis = visibilityFieldIds.has(e.fieldId);
      // Visibility rows belong to THIS FY only if their period's FY matches (period anchor);
      // non-visibility rows came from the paidAt window so are already in-FY.
      const inFy = isVis ? fyLabelForPeriod(e.period) === fyLabel : true;
      if (!inFy) return false;
      return effectiveEntrySection(e.tdsSection, isVis) === 'SEC_194R';
    });
    const outletCodes = [...new Set(section194REntries.map((e) => e.outletId))];

    // Resolve outletCode → partnerId → PAN
    const outlets = outletCodes.length
      ? await this.prisma.outlet.findMany({
          where: { outletCode: { in: outletCodes }, clientId },
          select: { outletCode: true, partnerId: true },
        })
      : [];
    const outletToPartnerId = new Map(outlets.map((o) => [o.outletCode, o.partnerId]));

    const partnerIds = [...new Set(outlets.map((o) => o.partnerId).filter(Boolean))] as string[];
    const partners = partnerIds.length
      ? await this.prisma.channelPartner.findMany({
          // isParent:false — parents never own outlets so are never in partnerIds; defensive
          // (docs/plans/PARTNER-MULTI-OUTLET.md §9).
          where: { id: { in: partnerIds }, isParent: false },
          select: { id: true, panNumber: true },
        })
      : [];
    const partnerToPan = new Map(partners.map((p) => [p.id, p.panNumber]));

    for (const entry of section194REntries) {
      const partnerId = outletToPartnerId.get(entry.outletId) ?? null;
      const pan = partnerId ? (partnerToPan.get(partnerId) ?? null) : null;
      addToPan(pan, entry.amountPaise);
    }

    // ── Source 2: RedemptionOrder.valuePaise for fulfilled redemptions ──
    // Fulfilled = DELIVERED status (deliveredAt in FY); PAN via partner.
    const redemptions = await this.prisma.redemptionOrder.findMany({
      where: {
        status: 'DELIVERED',
        deliveredAt: { gte: start, lt: endExclusive },
        partner: { clientId },
        valuePaise: { not: null },
      },
      select: {
        valuePaise: true,
        partner: { select: { panNumber: true } },
      },
    });

    for (const r of redemptions) {
      if (r.valuePaise != null) {
        addToPan(r.partner?.panNumber, r.valuePaise);
      }
    }

    // ── Source 3: TdsOffPlatformEntry (section=SEC_194R, clientId, entryDate in FY) ──
    const offPlatform = await this.prisma.tdsOffPlatformEntry.findMany({
      where: {
        clientId,
        section: 'SEC_194R',
        entryDate: { gte: start, lt: endExclusive },
      },
      select: { panNumber: true, amountPaise: true },
    });

    for (const e of offPlatform) {
      addToPan(e.panNumber, e.amountPaise);
    }

    // ── Deposited: SUM TdsDeposit (section=SEC_194R, clientId, depositDate in FY) ──
    const deposits = await this.prisma.tdsDeposit.findMany({
      where: {
        section: 'SEC_194R',
        clientId,
        depositDate: { gte: start, lt: endExclusive },
      },
      select: { panNumber: true, amountPaise: true },
    });

    const deposited = new Map<string, bigint>();
    for (const d of deposits) {
      const key = d.panNumber && d.panNumber.trim()
        ? d.panNumber.trim().toUpperCase()
        : NO_PAN_KEY;
      deposited.set(key, (deposited.get(key) ?? 0n) + d.amountPaise);
    }

    // ── Build result rows ──
    const rows: TdsRow194R[] = [];
    for (const [key, a] of accum) {
      const fyTotal = a.totalPaise;
      const thresholdMet = fyTotal > cfg.thr194rFyPaise;
      const liabilityPaise = thresholdMet
        ? grossUpTdsPaise(fyTotal, rate194RFrom(cfg, a.hasPan))
        : 0n;
      const depositedPaise = deposited.get(key) ?? 0n;
      const outstandingPaise = liabilityPaise - depositedPaise;

      rows.push({
        panNumber: a.panNumber,
        fyLabel,
        baseFyTotalPaise: fyTotal,
        liabilityPaise,
        depositedPaise,
        outstandingPaise,
      });
    }

    // Sort: threshold-met first (descending by base), then below-threshold
    rows.sort((a, b) => {
      const aAbove = a.baseFyTotalPaise > cfg.thr194rFyPaise;
      const bAbove = b.baseFyTotalPaise > cfg.thr194rFyPaise;
      if (aAbove !== bAbove) return aAbove ? -1 : 1;
      if (b.baseFyTotalPaise > a.baseFyTotalPaise) return 1;
      if (a.baseFyTotalPaise > b.baseFyTotalPaise) return -1;
      return 0;
    });

    return rows;
  }

  /** Summary for 194R: totals across all PAN rows. */
  async summary194R(clientId: string, fyLabel: string): Promise<TdsSummary194R> {
    const rows = await this.compute194R(clientId, fyLabel);
    return {
      fyLabel,
      clientId,
      totalBasePaise: rows.reduce((s, r) => s + r.baseFyTotalPaise, 0n),
      totalLiabilityPaise: rows.reduce((s, r) => s + r.liabilityPaise, 0n),
      totalDepositedPaise: rows.reduce((s, r) => s + r.depositedPaise, 0n),
      totalOutstandingPaise: rows.reduce((s, r) => s + r.outstandingPaise, 0n),
      rowCount: rows.length,
    };
  }

  // ─── 194C ───────────────────────────────────────────────────────────────────

  /**
   * Compute 194C rows (platform-wide, no clientId scope).
   *
   * Sources: CreditPayoutEntry whose EFFECTIVE section is 194C, across ALL tenants —
   * bucketed by the FROZEN tdsSection stamp (W0-B) when present; a null stamp
   * (legacy) falls back to the live payoutStream=VISIBILITY classification. See
   * effectiveEntrySection. Frozen 194C is only ever derived for a VISIBILITY payout,
   * so we query (fieldId ∈ current visibility fields) OR (tdsSection = SEC_194C) to
   * catch both the fallback rows and any entry frozen 194C even if its field's live
   * payoutStream later changed.
   *
   * Two liability columns: (a) with-threshold, (b) no-threshold. The gross-up
   * liability number is unchanged by methodology; methodology only affects what is
   * already-COLLECTED (DEDUCT withholding) and the report-only recovery attribution
   * (GROSS-UP), both read from the typed ledgers.
   */
  async compute194C(fyLabel: string): Promise<TdsRow194C[]> {
    const cfg = await this.statutory.getForFy(fyLabel);
    // FIX-4: VISIBILITY 194C entries are anchored by their payout PERIOD's FY (matching the
    // credits ledger WRITE), NOT paidAt — so a period=2026-03 payout banked in April 2026
    // still lands in FY 2025-26 on both the base READ and the DEDUCT/recovery ledger. All
    // 194C entries are visibility-regime (INCENTIVE is always 194R), so the whole source uses
    // the period window.
    const { startPeriod, endPeriod } = periodWindowForFy(fyLabel);
    // Deposits keep their own depositDate anchor (a deposit MADE in the FY), independent of
    // the payout period anchor above.
    const { start, endExclusive } = fyFromLabel(fyLabel);

    // Accumulate per PAN (platform-wide)
    const accum = new Map<string, PanAccum194C>();

    const addToC = (
      pan: string | null | undefined,
      amountPaise: bigint,
      entityType: string | null | undefined,
      methodology: 'DEDUCT' | 'GROSS_UP' | null | undefined,
    ) => {
      const key = pan && pan.trim() ? pan.trim().toUpperCase() : NO_PAN_KEY;
      const hasPan = key !== NO_PAN_KEY;
      const effEntityType = entityType ?? 'OTHERS';
      // DEDUCT → withholding basis; GROSS_UP or null(legacy) → gross-up basis (preserves the
      // pre-FIX-2 behaviour for unstamped rows, which were always grossed up).
      const isDeduct = methodology === 'DEDUCT';
      const existing = accum.get(key);
      if (existing) {
        existing.totalPaise += amountPaise;
        if (amountPaise > existing.maxSinglePaise) {
          existing.maxSinglePaise = amountPaise;
        }
        if (methodology) existing.methodologies.add(methodology);
        if (isDeduct) existing.deductBasePaise += amountPaise;
        else existing.grossUpBasePaise += amountPaise;
      } else {
        const methodologies = new Set<'DEDUCT' | 'GROSS_UP'>();
        if (methodology) methodologies.add(methodology);
        accum.set(key, {
          panNumber: key,
          hasPan,
          entityType: effEntityType,
          totalPaise: amountPaise,
          maxSinglePaise: amountPaise,
          methodologies,
          deductBasePaise: isDeduct ? amountPaise : 0n,
          grossUpBasePaise: isDeduct ? 0n : amountPaise,
        });
      }
    };

    // ── Source: CreditPayoutEntry effective-194C (payoutStream=VISIBILITY fields), all clients ──
    // Get all visibility field IDs across all tenants (payoutStream is the explicit classifier;
    // isSeparatePayout is its deprecated boolean mirror, dropped in W3) — used both to widen the
    // query and to resolve the FROZEN-null fallback classification (effectiveEntrySection).
    const visibilityFields = await this.prisma.creditField.findMany({
      where: { payoutStream: 'VISIBILITY' },
      select: { id: true, clientId: true },
    });
    const visFieldIds = new Set(visibilityFields.map((f) => f.id));

    // Match current-visibility-field entries OR any entry FROZEN as SEC_194C (covers a field
    // whose live payoutStream changed after confirm). Each fetched row is then re-checked with
    // effectiveEntrySection so a VISIBILITY-field entry frozen SEC_194R is correctly dropped here.
    const visEntries = await this.prisma.creditPayoutEntry.findMany({
      where: {
        status: 'PAID',
        // FIX-4: bucket by payout PERIOD's FY (matches the ledger), not paidAt.
        period: { gte: startPeriod, lte: endPeriod },
        OR: [
          { fieldId: { in: [...visFieldIds] } },
          { tdsSection: 'SEC_194C' },
        ],
      },
      select: {
        amountPaise: true,
        outletId: true,
        clientId: true,
        fieldId: true,
        tdsSection: true,
        tdsMethodology: true,
      },
    });

    // Keep only rows whose EFFECTIVE section is 194C (frozen stamp wins; null falls back).
    const c194Entries = visEntries.filter(
      (e) => effectiveEntrySection(e.tdsSection, visFieldIds.has(e.fieldId)) === 'SEC_194C',
    );

    if (c194Entries.length > 0) {
      // CreditPayoutEntry.outletId stores the outletCode (NOT the Outlet PK).
      // For 194C we need to resolve across all tenants (clientId already on outlet row).
      const outletCodes194C = [...new Set(c194Entries.map((e) => e.outletId))];
      const outlets = await this.prisma.outlet.findMany({
        where: { outletCode: { in: outletCodes194C } },
        select: { outletCode: true, partnerId: true, clientId: true },
      });
      // outletCode is unique only WITHIN a tenant (@@unique([clientId, outletCode])); 194C is
      // platform-wide, so key by clientId:outletCode to avoid cross-tenant PAN misattribution.
      const outletToPartnerId = new Map(outlets.map((o) => [`${o.clientId}:${o.outletCode}`, o.partnerId]));

      const partnerIds = [...new Set(outlets.map((o) => o.partnerId).filter(Boolean))] as string[];
      const partners = partnerIds.length
        ? await this.prisma.channelPartner.findMany({
            // isParent:false — defensive (parents own no outlets → never in partnerIds).
            where: { id: { in: partnerIds }, isParent: false },
            select: { id: true, panNumber: true, entityType: true },
          })
        : [];
      const partnerMap = new Map(partners.map((p) => [p.id, p]));

      for (const entry of c194Entries) {
        const partnerId = outletToPartnerId.get(`${entry.clientId}:${entry.outletId}`) ?? null; // outletId = outletCode
        const partner = partnerId ? partnerMap.get(partnerId) : null;
        addToC(partner?.panNumber, entry.amountPaise, partner?.entityType ?? null, entry.tdsMethodology);
      }
    }

    // ── Deposited: SUM TdsDeposit (section=SEC_194C, depositDate in FY) — clientId null (platform) ──
    const deposits = await this.prisma.tdsDeposit.findMany({
      where: {
        section: 'SEC_194C',
        depositDate: { gte: start, lt: endExclusive },
      },
      select: { panNumber: true, amountPaise: true },
    });

    const deposited = new Map<string, bigint>();
    for (const d of deposits) {
      const key = d.panNumber && d.panNumber.trim()
        ? d.panNumber.trim().toUpperCase()
        : NO_PAN_KEY;
      deposited.set(key, (deposited.get(key) ?? 0n) + d.amountPaise);
    }

    // ── DEDUCT already-collected: SUM TdsDeductionEntry.tdsDeductedThisPaise (section 194C, FY) ──
    // The DEDUCT ledger is keyed by fyLabel (IST FY string) + section, platform-wide (all tenants
    // contributing to the PAN). This is TDS withheld from payouts, counted as already-collected in
    // addition to TdsDeposit. See the money-path note: Stream B must NOT ALSO upload these withheld
    // amounts as TdsDeposit rows, or deposited+withheld would double-count against the liability.
    const deductions = await this.prisma.tdsDeductionEntry.findMany({
      where: { section: 'SEC_194C', fyLabel },
      select: { panNumber: true, tdsDeductedThisPaise: true },
    });

    const withheld = new Map<string, bigint>();
    for (const d of deductions) {
      const key = d.panNumber && d.panNumber.trim()
        ? d.panNumber.trim().toUpperCase()
        : NO_PAN_KEY;
      withheld.set(key, (withheld.get(key) ?? 0n) + d.tdsDeductedThisPaise);
    }

    // ── GROSS-UP recovery attribution: SUM TdsRecoveryEntry.tenantSharePaise (section 194C, FY) ──
    // Report-only ("in lieu of TDS"): per-PAN total + a per-tenant split. Does NOT change the
    // liability or outstanding number — purely surfaces what has been recovered from each tenant.
    const recoveries = await this.prisma.tdsRecoveryEntry.findMany({
      where: { section: 'SEC_194C', fyLabel },
      select: { panNumber: true, clientId: true, tenantSharePaise: true },
    });

    const recovered = new Map<string, bigint>();
    const recoveryByTenant = new Map<string, Map<string, bigint>>();
    for (const r of recoveries) {
      // FIX-B: no-PAN recovery encodes the outlet into panNumber ('__NO_PAN__:<outlet>') so it can
      // telescope per outlet at write time. Collapse ALL such rows back to the single NO_PAN_KEY
      // bucket here so the platform-wide 194C recovery total aligns with the no-PAN base bucket.
      const raw = r.panNumber?.trim();
      const key = !raw || raw.toUpperCase().startsWith(NO_PAN_KEY)
        ? NO_PAN_KEY
        : raw.toUpperCase();
      recovered.set(key, (recovered.get(key) ?? 0n) + r.tenantSharePaise);
      let tenantMap = recoveryByTenant.get(key);
      if (!tenantMap) {
        tenantMap = new Map<string, bigint>();
        recoveryByTenant.set(key, tenantMap);
      }
      tenantMap.set(r.clientId, (tenantMap.get(r.clientId) ?? 0n) + r.tenantSharePaise);
    }

    // ── Build result rows ──
    const rows: TdsRow194C[] = [];
    for (const [key, a] of accum) {
      const fyTotal = a.totalPaise;
      const thresholdMet =
        a.maxSinglePaise > cfg.thr194cSinglePaise ||
        fyTotal > cfg.thr194cFyPaise;

      const rateForPan = rate194CFrom(cfg, a.hasPan, a.entityType);

      // FIX-2: liability is METHODOLOGY-AWARE. A DEDUCT PAN's statutory TDS is WITHHOLDING
      // (base × rate/100); a GROSS_UP (or legacy/unstamped) PAN's is the payer-borne GROSS-UP
      // (base × rate/den). A MIXED PAN sums each portion on its own basis. Using gross-up for a
      // fully-withheld DEDUCT PAN left a phantom residue (liability > withheld) — now
      // liability(DEDUCT) = withheld once fully collected ⇒ outstanding reconciles to 0.
      const withholdingPortionPaise = withholdingTdsPaise(a.deductBasePaise, rateForPan);
      const grossUpPortionPaise = grossUpTdsPaise(a.grossUpBasePaise, rateForPan);

      // (b) no-threshold: TDS on everything regardless of the ₹30k/₹1L gate.
      const liabilityNoThresholdPaise = withholdingPortionPaise + grossUpPortionPaise;

      // (a) with-threshold — only due once the cumulative crosses the threshold.
      const liabilityPaise = thresholdMet ? liabilityNoThresholdPaise : 0n;

      const depositedPaise = deposited.get(key) ?? 0n;
      const withheldPaise = withheld.get(key) ?? 0n;
      const recoveredPaise = recovered.get(key) ?? 0n;
      // Outstanding nets BOTH deposited AND DEDUCT-withheld against the liability.
      const outstandingPaise = liabilityPaise - depositedPaise - withheldPaise;

      // Which frozen methodologies did this PAN's entries carry? (null = all legacy/unstamped.)
      const methSet = a.methodologies;
      const methodology: TdsMethodologyLabel =
        methSet.size === 0 ? null : methSet.size === 1 ? [...methSet][0] : 'MIXED';

      const tenantMap = recoveryByTenant.get(key);
      const recoveryList: TdsRecoveryAttribution[] = tenantMap
        ? [...tenantMap.entries()]
            .map(([clientId, tenantSharePaise]) => ({ clientId, tenantSharePaise }))
            .sort((x, y) =>
              y.tenantSharePaise > x.tenantSharePaise ? 1 : y.tenantSharePaise < x.tenantSharePaise ? -1 : 0,
            )
        : [];

      rows.push({
        panNumber: a.panNumber,
        entityType: a.entityType,
        fyLabel,
        baseFyTotalPaise: fyTotal,
        maxSinglePaise: a.maxSinglePaise,
        thresholdMet,
        liabilityPaise,
        liabilityNoThresholdPaise,
        depositedPaise,
        outstandingPaise,
        methodology,
        withheldPaise,
        recoveredPaise,
        recoveryByTenant: recoveryList,
      });
    }

    // Sort descending by base
    rows.sort((a, b) => {
      if (b.baseFyTotalPaise > a.baseFyTotalPaise) return 1;
      if (a.baseFyTotalPaise > b.baseFyTotalPaise) return -1;
      return 0;
    });

    return rows;
  }

  /** Summary for 194C: totals across all PAN rows. */
  async summary194C(fyLabel: string): Promise<TdsSummary194C> {
    const rows = await this.compute194C(fyLabel);
    return {
      fyLabel,
      totalBasePaise: rows.reduce((s, r) => s + r.baseFyTotalPaise, 0n),
      totalLiabilityPaise: rows.reduce((s, r) => s + r.liabilityPaise, 0n),
      totalLiabilityNoThresholdPaise: rows.reduce((s, r) => s + r.liabilityNoThresholdPaise, 0n),
      totalDepositedPaise: rows.reduce((s, r) => s + r.depositedPaise, 0n),
      totalWithheldPaise: rows.reduce((s, r) => s + r.withheldPaise, 0n),
      totalRecoveredPaise: rows.reduce((s, r) => s + r.recoveredPaise, 0n),
      totalOutstandingPaise: rows.reduce((s, r) => s + r.outstandingPaise, 0n),
      rowCount: rows.length,
    };
  }

  // ─── 6.5b: Template builders ─────────────────────────────────────────────────

  /** Return a blank xlsx Buffer for the off-platform 194R upload template. */
  offPlatformTemplate(): Buffer {
    return buildOffPlatformTemplate();
  }

  /** Return a blank xlsx Buffer for the TDS deposit upload template. */
  depositTemplate(): Buffer {
    return buildDepositTemplate();
  }

  // ─── 6.5b: Off-platform 194R upload ─────────────────────────────────────────

  /**
   * Parse (and optionally apply) an off-platform 194R upload.
   *
   * @param clientId  - tenant (from JWT)
   * @param uploadedBy - user.sub from JWT
   * @param file      - multipart xlsx file (Express.Multer.File)
   * @param apply     - if false → preview only; if true → createMany to DB
   *
   * Validation: PAN non-empty, amount > 0, date parseable.
   *
   * On apply: the uploadBatchId is a DETERMINISTIC sha256 of the file's parsed
   * rows (offPlatformFileHash), NOT a random uuid. Re-uploading the SAME file
   * therefore produces the SAME uploadBatchId, so every row collides on the
   * tds_off_platform_entries_dedup_unique partial index and is skipped (no
   * double-count). A DIFFERENT file gets a different hash → its rows insert,
   * preserving a genuine repeat 194R entry. We query the rows already present
   * for this (clientId, section, uploadBatchId) BEFORE the createMany so each
   * skipped row is surfaced in the result as "skipped — duplicate entry"
   * (createMany({skipDuplicates}) otherwise drops collisions silently); skipDuplicates
   * is kept as the race safety-net.
   */
  async uploadOffPlatform(
    clientId: string,
    uploadedBy: string,
    file: Express.Multer.File,
    apply: boolean,
  ): Promise<UploadResult> {
    const ab = file.buffer.buffer.slice(
      file.buffer.byteOffset,
      file.buffer.byteOffset + file.buffer.byteLength,
    );

    const { result, rows } = parseOffPlatformUpload(ab);

    if (!apply || rows.length === 0) {
      return result;
    }

    // Deterministic file-level batch id → same file re-upload = same id = full collision.
    const uploadBatchId = offPlatformFileHash(rows);

    // Which of these natural-keys are ALREADY present for this file's batch id?
    // (Re-upload of the identical file → all of them.) Build the dedup tuple set.
    const existing = await this.prisma.tdsOffPlatformEntry.findMany({
      where: {
        clientId,
        section: 'SEC_194R',
        uploadBatchId,
      },
      select: {
        panNumber: true,
        entryDate: true,
        amountPaise: true,
        outletCode: true,
      },
    });
    const existingKeys = new Set(
      existing.map((e) =>
        this.offPlatformDedupKey(
          e.panNumber,
          e.entryDate,
          e.amountPaise,
          e.outletCode ?? null,
        ),
      ),
    );

    const toInsert: typeof rows = [];
    rows.forEach((r, idx) => {
      const key = this.offPlatformDedupKey(
        r.panNumber,
        r.entryDate,
        r.amountPaise,
        r.outletCode ?? null,
      );
      if (existingKeys.has(key)) {
        result.skipped += 1;
        result.succeeded -= 1;
        result.errors.push({
          row: idx + 2, // 1-based + header row
          message: `Row ${idx + 2}: skipped — duplicate entry (already uploaded in this file)`,
        });
      } else {
        toInsert.push(r);
      }
    });

    if (toInsert.length > 0) {
      await this.prisma.tdsOffPlatformEntry.createMany({
        data: toInsert.map((r) => ({
          clientId,
          section: 'SEC_194R' as const,
          entryDate: r.entryDate,
          panNumber: r.panNumber,
          outletCode: r.outletCode ?? undefined,
          amountPaise: r.amountPaise,
          uploadBatchId,
          uploadedBy,
        })),
        skipDuplicates: true, // DB partial-unique catches true dups; this is a race safety net
      });
    }

    return result;
  }

  /** Natural-key string mirroring the tds_off_platform_entries_dedup_unique index. */
  private offPlatformDedupKey(
    panNumber: string,
    entryDate: Date,
    amountPaise: bigint,
    outletCode: string | null,
  ): string {
    return [
      panNumber,
      entryDate.toISOString(),
      amountPaise.toString(),
      outletCode ?? '',
    ].join('|');
  }

  // ─── 6.5b: Deposit upload ────────────────────────────────────────────────────

  /**
   * Parse (and optionally apply) a TDS deposit upload.
   *
   * section=194R → depositorType=CLIENT, clientId set from JWT.
   * section=194C → depositorType=GIFSY, clientId=null (platform).
   *
   * uploadBatchId is a DETERMINISTIC sha256 of the file's parsed rows
   * (depositFileHash) → re-uploading the SAME file produces the SAME id, every
   * row collides on tds_deposits_dedup_unique and is skipped + reported as
   * "skipped — duplicate entry"; a DIFFERENT file inserts. skipDuplicates kept
   * as the race safety-net.
   */
  async uploadDeposit(
    section: '194R' | '194C',
    clientId: string | null,
    uploadedBy: string,
    file: Express.Multer.File,
    apply: boolean,
  ): Promise<UploadResult> {
    const ab = file.buffer.buffer.slice(
      file.buffer.byteOffset,
      file.buffer.byteOffset + file.buffer.byteLength,
    );

    const { result, rows } = parseDepositUpload(ab);

    if (!apply || rows.length === 0) {
      return result;
    }

    const prismaSection = sectionParamToEnum(section);
    const depositorType = section === '194R' ? 'CLIENT' : 'GIFSY';
    const uploadBatchId = depositFileHash(rows);

    // Rows already present for this file's batch id (same file re-upload → all).
    const existing = await this.prisma.tdsDeposit.findMany({
      where: {
        section: prismaSection,
        clientId: clientId ?? null,
        uploadBatchId,
      },
      select: {
        panNumber: true,
        depositDate: true,
        amountPaise: true,
        outletCode: true,
      },
    });
    const existingKeys = new Set(
      existing.map((e) =>
        this.depositDedupKey(
          e.panNumber,
          e.depositDate,
          e.amountPaise,
          e.outletCode ?? null,
        ),
      ),
    );

    const toInsert: typeof rows = [];
    rows.forEach((r, idx) => {
      const key = this.depositDedupKey(
        r.panNumber,
        r.depositDate,
        r.amountPaise,
        r.outletCode ?? null,
      );
      if (existingKeys.has(key)) {
        result.skipped += 1;
        result.succeeded -= 1;
        result.errors.push({
          row: idx + 2,
          message: `Row ${idx + 2}: skipped — duplicate entry (already uploaded in this file)`,
        });
      } else {
        toInsert.push(r);
      }
    });

    if (toInsert.length > 0) {
      await this.prisma.tdsDeposit.createMany({
        data: toInsert.map((r) => ({
          section: prismaSection,
          depositorType: depositorType as 'CLIENT' | 'GIFSY',
          clientId: clientId ?? undefined,
          depositDate: r.depositDate,
          panNumber: r.panNumber,
          outletCode: r.outletCode ?? undefined,
          amountPaise: r.amountPaise,
          uploadBatchId,
          uploadedBy,
        })),
        skipDuplicates: true,
      });
    }

    return result;
  }

  /** Natural-key string mirroring the tds_deposits_dedup_unique index. */
  private depositDedupKey(
    panNumber: string,
    depositDate: Date,
    amountPaise: bigint,
    outletCode: string | null,
  ): string {
    return [
      panNumber,
      depositDate.toISOString(),
      amountPaise.toString(),
      outletCode ?? '',
    ].join('|');
  }

  // ─── 6.5c: Excel reference exports ──────────────────────────────────────────

  /**
   * Build the 194R reference Excel for a given clientId + FY.
   *
   * One row per PAN. Name resolution (CA-ready, mirroring 26Q deductee sheet):
   *   - On-platform PAN → ChannelPartner (clientId-scoped) → ownerName or businessName
   *   - __NO_PAN__ bucket → "NO PAN ON FILE"
   *   - Unknown / off-platform PAN → blank name
   *
   * Columns: S.No · Deductee Name · PAN · Section · Amount Paid (₹) · TDS Rate %
   *          · TDS Amount (₹) · Already Deposited (₹) · Outstanding (₹) · FY
   *
   * A second "Summary" sheet provides totals.
   *
   * @returns { buffer: Buffer, filename: string }
   */
  async export194R(
    clientId: string,
    fyLabel: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const rows = await this.compute194R(clientId, fyLabel);

    // Resolve PAN → name from ChannelPartner (tenant-scoped)
    const onPlatformPans = rows
      .map((r) => r.panNumber)
      .filter((p) => p !== '__NO_PAN__');

    const partners = onPlatformPans.length
      ? await this.prisma.channelPartner.findMany({
          where: {
            clientId,
            panNumber: { in: onPlatformPans },
            // isParent:false — REAL: a parent SHARES the group PAN with its children, so
            // without this it could win the PAN→name lookup and misattribute the payee name
            // (docs/plans/PARTNER-MULTI-OUTLET.md §9).
            isParent: false,
          },
          select: { panNumber: true, ownerName: true, businessName: true },
        })
      : [];

    // Use first match per PAN (panNumber is not unique-constrained across tenants,
    // but within a single clientId scope duplicates should not arise in practice).
    const panToName = new Map<string, string>();
    for (const p of partners) {
      if (p.panNumber && !panToName.has(p.panNumber)) {
        panToName.set(p.panNumber, p.ownerName || p.businessName || '');
      }
    }

    const detailRows = rows.map((r, i) => {
      const hasPan = r.panNumber !== '__NO_PAN__';
      const tdsRatePct = hasPan ? 10 : 20;
      const deducteeName = hasPan
        ? (panToName.get(r.panNumber) ?? '')
        : 'NO PAN ON FILE';

      return {
        'S.No': i + 1,
        'Deductee Name': cellSafe(deducteeName),
        PAN: cellSafe(hasPan ? r.panNumber : ''),
        Section: '194R',
        'Amount Paid (₹)': paiseToRupees(r.baseFyTotalPaise).toFixed(2),
        'TDS Rate %': tdsRatePct,
        'TDS Amount (₹)': paiseToRupees(r.liabilityPaise).toFixed(2),
        'Already Deposited (₹)': paiseToRupees(r.depositedPaise).toFixed(2),
        'Outstanding (₹)': paiseToRupees(r.outstandingPaise).toFixed(2),
        FY: fyLabel,
      };
    });

    // Summary sheet
    const totalBase = rows.reduce((s, r) => s + r.baseFyTotalPaise, 0n);
    const totalLiability = rows.reduce((s, r) => s + r.liabilityPaise, 0n);
    const totalDeposited = rows.reduce((s, r) => s + r.depositedPaise, 0n);
    const totalOutstanding = rows.reduce((s, r) => s + r.outstandingPaise, 0n);

    const summaryRows = [
      {
        'Field': 'Total Deductees',
        'Value': rows.length,
      },
      {
        'Field': 'Total Amount Paid (₹)',
        'Value': paiseToRupees(totalBase).toFixed(2),
      },
      {
        'Field': 'Total TDS Amount (₹)',
        'Value': paiseToRupees(totalLiability).toFixed(2),
      },
      {
        'Field': 'Total Already Deposited (₹)',
        'Value': paiseToRupees(totalDeposited).toFixed(2),
      },
      {
        'Field': 'Total Outstanding (₹)',
        'Value': paiseToRupees(totalOutstanding).toFixed(2),
      },
      {
        'Field': 'FY',
        'Value': fyLabel,
      },
    ];

    const buffer = buildXlsx([
      { name: 'TDS 194R Details', rows: detailRows },
      { name: 'Summary', rows: summaryRows },
    ]);

    return { buffer, filename: `tds-194r-${fyLabel}.xlsx` };
  }

  /**
   * Build the 194C two-column report Excel (platform-wide, Gifsy deductor).
   *
   * One row per PAN. Name resolution: look up ChannelPartner by PAN across
   * all tenants (first match wins).
   *
   * Columns: S.No · Deductee Name · PAN · Entity Type · Section · Methodology
   *          · Amount Paid (₹) · TDS Rate % · TDS — With Threshold (₹)
   *          · TDS — No Threshold (₹) · Threshold Met (Y/N) · Already Deposited (₹)
   *          · TDS Withheld (Deduct) (₹) · TDS Recovered (Gross-Up) (₹)
   *          · Outstanding (₹) · FY
   *
   * The Methodology + Withheld/Recovered columns make the DEDUCT-vs-GROSS_UP split
   * CA-visible: DEDUCT PANs show withholding already collected (folded into
   * Outstanding); GROSS_UP PANs show the "in lieu of TDS" recovery (report-only,
   * NOT netted against liability). A second "Gross-Up Recovery by Tenant" sheet
   * carries the per-tenant recovery attribution.
   *
   * @returns { buffer: Buffer, filename: string }
   */
  async export194C(
    fyLabel: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const rows = await this.compute194C(fyLabel);

    // Resolve PAN → name platform-wide (first match across any tenant)
    const onPlatformPans = rows
      .map((r) => r.panNumber)
      .filter((p) => p !== '__NO_PAN__');

    const partners = onPlatformPans.length
      ? await this.prisma.channelPartner.findMany({
          // isParent:false — REAL: a parent shares the group PAN, so exclude it from the
          // PAN→name lookup to avoid misattributing the payee name (§9).
          where: { panNumber: { in: onPlatformPans }, isParent: false },
          select: { panNumber: true, ownerName: true, businessName: true },
        })
      : [];

    const panToName = new Map<string, string>();
    for (const p of partners) {
      if (p.panNumber && !panToName.has(p.panNumber)) {
        panToName.set(p.panNumber, p.ownerName || p.businessName || '');
      }
    }

    const detailRows = rows.map((r, i) => {
      const hasPan = r.panNumber !== '__NO_PAN__';

      // Rate display: 1 for INDIVIDUAL/HUF, 2 for others, 20 for no-PAN
      let tdsRatePct: number;
      if (!hasPan) {
        tdsRatePct = 20;
      } else if (r.entityType === 'INDIVIDUAL' || r.entityType === 'HUF') {
        tdsRatePct = 1;
      } else {
        tdsRatePct = 2;
      }

      const deducteeName = hasPan
        ? (panToName.get(r.panNumber) ?? '')
        : 'NO PAN ON FILE';

      return {
        'S.No': i + 1,
        'Deductee Name': cellSafe(deducteeName),
        PAN: cellSafe(hasPan ? r.panNumber : ''),
        'Entity Type': cellSafe(r.entityType),
        Section: '194C',
        Methodology: cellSafe(r.methodology ?? ''),
        'Amount Paid (₹)': paiseToRupees(r.baseFyTotalPaise).toFixed(2),
        'TDS Rate %': tdsRatePct,
        'TDS — With Threshold (₹)': paiseToRupees(r.liabilityPaise).toFixed(2),
        'TDS — No Threshold (₹)': paiseToRupees(r.liabilityNoThresholdPaise).toFixed(2),
        'Threshold Met (Y/N)': r.thresholdMet ? 'Y' : 'N',
        'Already Deposited (₹)': paiseToRupees(r.depositedPaise).toFixed(2),
        'TDS Withheld (Deduct) (₹)': paiseToRupees(r.withheldPaise).toFixed(2),
        'TDS Recovered (Gross-Up) (₹)': paiseToRupees(r.recoveredPaise).toFixed(2),
        'Outstanding (₹)': paiseToRupees(r.outstandingPaise).toFixed(2),
        FY: fyLabel,
      };
    });

    // Second sheet: the GROSS-UP per-tenant recovery attribution ("in lieu of TDS"),
    // flattened one row per (PAN, tenant). Report-only — never netted against liability.
    const recoveryRows = rows.flatMap((r) => {
      const hasPan = r.panNumber !== '__NO_PAN__';
      const deducteeName = hasPan ? (panToName.get(r.panNumber) ?? '') : 'NO PAN ON FILE';
      return r.recoveryByTenant.map((rec) => ({
        PAN: cellSafe(hasPan ? r.panNumber : ''),
        'Deductee Name': cellSafe(deducteeName),
        'Recovered From (Client)': cellSafe(rec.clientId),
        'Recovery Amount (₹)': paiseToRupees(rec.tenantSharePaise).toFixed(2),
        FY: fyLabel,
      }));
    });

    const buffer = buildXlsx([
      { name: 'TDS 194C Details', rows: detailRows },
      { name: 'Gross-Up Recovery by Tenant', rows: recoveryRows },
    ]);

    return { buffer, filename: `tds-194c-${fyLabel}.xlsx` };
  }

  // ─── 6.5b: Liability tracker ─────────────────────────────────────────────────

  /**
   * Return per-PAN liability/deposited/outstanding rows for a section + FY.
   *
   * 194R: tenant-scoped (requires clientId).
   * 194C: platform-wide (GIFSY only; clientId ignored).
   *
   * Outstanding can be negative (over-deposit) — passed through as-is.
   */
  async getLiability(
    section: '194R' | '194C',
    fyLabel: string,
    clientId: string,
  ): Promise<{
    section: string;
    fyLabel: string;
    rows: Array<{
      panNumber: string;
      liabilityPaise: string;
      depositedPaise: string;
      outstandingPaise: string;
      // 194C only — methodology-aware split (undefined for 194R):
      methodology?: TdsMethodologyLabel;
      withheldPaise?: string;
      recoveredPaise?: string;
      recoveryByTenant?: Array<{ clientId: string; tenantSharePaise: string }>;
    }>;
    totals: {
      liabilityPaise: string;
      depositedPaise: string;
      outstandingPaise: string;
      // 194C only:
      withheldPaise?: string;
      recoveredPaise?: string;
    };
  }> {
    if (section === '194R') {
      const rows = await this.compute194R(clientId, fyLabel);
      const totalLiability = rows.reduce((s, r) => s + r.liabilityPaise, 0n);
      const totalDeposited = rows.reduce((s, r) => s + r.depositedPaise, 0n);
      const totalOutstanding = rows.reduce((s, r) => s + r.outstandingPaise, 0n);

      return {
        section: '194R',
        fyLabel,
        rows: rows.map((r) => ({
          panNumber: r.panNumber,
          liabilityPaise: r.liabilityPaise.toString(),
          depositedPaise: r.depositedPaise.toString(),
          outstandingPaise: r.outstandingPaise.toString(),
        })),
        totals: {
          liabilityPaise: totalLiability.toString(),
          depositedPaise: totalDeposited.toString(),
          outstandingPaise: totalOutstanding.toString(),
        },
      };
    }

    // 194C — platform-wide
    const rows = await this.compute194C(fyLabel);
    const totalLiability = rows.reduce((s, r) => s + r.liabilityPaise, 0n);
    const totalDeposited = rows.reduce((s, r) => s + r.depositedPaise, 0n);
    const totalWithheld = rows.reduce((s, r) => s + r.withheldPaise, 0n);
    const totalRecovered = rows.reduce((s, r) => s + r.recoveredPaise, 0n);
    const totalOutstanding = rows.reduce((s, r) => s + r.outstandingPaise, 0n);

    return {
      section: '194C',
      fyLabel,
      rows: rows.map((r) => ({
        panNumber: r.panNumber,
        liabilityPaise: r.liabilityPaise.toString(),
        depositedPaise: r.depositedPaise.toString(),
        outstandingPaise: r.outstandingPaise.toString(),
        methodology: r.methodology,
        withheldPaise: r.withheldPaise.toString(),
        recoveredPaise: r.recoveredPaise.toString(),
        recoveryByTenant: r.recoveryByTenant.map((rec) => ({
          clientId: rec.clientId,
          tenantSharePaise: rec.tenantSharePaise.toString(),
        })),
      })),
      totals: {
        liabilityPaise: totalLiability.toString(),
        depositedPaise: totalDeposited.toString(),
        outstandingPaise: totalOutstanding.toString(),
        withheldPaise: totalWithheld.toString(),
        recoveredPaise: totalRecovered.toString(),
      },
    };
  }
}
