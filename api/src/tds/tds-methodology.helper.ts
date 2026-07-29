/**
 * TDS methodology helpers — PURE, side-effect-free, unit-tested. No DB access.
 *
 * These are the FROZEN Wave-0.5 contracts the parallel Wave-1 streams import
 * (config-freeze / DEDUCT engine / GROSS-UP engine / recovery reports). The math
 * lives here so it can be exhaustively unit-tested before any engine wiring.
 *
 * All money is integer paise (BigInt) — never Number-coerce paise. Rate tables +
 * the rupee rounder + the gross-up factor are reused from tds.helpers (single
 * source of truth); this file adds only the methodology-specific arithmetic:
 *
 *   - deriveFrozenSection            — which 194 section an entry is stamped with at confirm
 *   - computeDeduction               — DEDUCT (withhold-from-payout) with cumulative carry-forward
 *   - computeGrossUpTdsInvoiceBasePaise — GROSS-UP "TDS invoice" body amount
 *   - proRataRecovery                — one tenant's pro-rata recovery share (standalone)
 *   - allocateProRataRecovery        — EXACT-summing pro-rata split across tenants (largest-remainder)
 *
 * Terminology on TdsRate {num, den} (see tds.helpers): `num` is the statutory rate
 * PERCENT (194C-others 2, 194R-PAN 10, no-PAN 20); `den` = 100 − num is the gross-up
 * denominator. So:
 *   - GROSS-UP (payer-borne top-up)  TDS = base × num / den   (grossUpTdsPaise)
 *   - DEDUCT   (withheld from payout) TDS = base × num / 100   (withholdingTdsPaise, below)
 */

import { TdsSection } from '@prisma/client';
import { grossUpTdsPaise, roundToRupeePaise, TdsRate } from './tds.helpers';

/** The classifier a payout entry inherits from its CreditField (mirrors Prisma enum PayoutStream). */
export type PayoutStream = 'VISIBILITY' | 'INCENTIVE';

// ─── Section derivation (what confirm freezes onto each entry) ────────────────

/**
 * The 194 section an entry is stamped with at confirm (W0-B freeze):
 *   - INCENTIVE payouts are always benefits-in-kind → SEC_194R.
 *   - VISIBILITY payouts follow the tenant's configured section (tdsPolicy.section).
 * Pure; the caller resolves `tenantSection` once from TenantSettingsService.resolveTdsPolicy.
 */
export function deriveFrozenSection(
  payoutStream: PayoutStream,
  tenantSection: TdsSection,
): TdsSection {
  return payoutStream === 'INCENTIVE' ? TdsSection.SEC_194R : tenantSection;
}

// ─── DEDUCT (withhold-from-payout) with cumulative carry-forward ──────────────

/**
 * DEDUCT-method withholding TDS on a base = base × ratePercent / 100, rounded to the
 * nearest whole rupee (100 paise). Distinct from grossUpTdsPaise (which divides by
 * `den` = 100 − rate, the payer-borne top-up). `num` IS the statutory rate percent.
 * Mirrors the house floor-divide-then-round convention used by grossUpTdsPaise.
 */
export function withholdingTdsPaise(basePaise: bigint, rate: TdsRate): bigint {
  const rawPaise = basePaise * BigInt(rate.num);
  return roundToRupeePaise(rawPaise / 100n);
}

/**
 * DEDUCT method for a single payout event, PAN/section/FY-cumulative aware.
 *
 * Once the cumulative base crosses the threshold, TDS is due on the WHOLE cumulative
 * base (retroactive jump). The catch-up owed at this event = due − alreadyDeducted.
 * We withhold min(catchUp, thisPayout) from this payout (a payout can't yield more TDS
 * than the payout itself) and carry the un-withheld remainder forward to the next event.
 *
 * @returns tdsDueCumulativePaise — TDS due on the cumulative base (0 below threshold)
 *          tdsDeductThisPaise    — withheld from THIS payout (>= 0, <= thisPayout)
 *          carryForwardPaise     — catch-up still owed after this event (>= 0)
 */
export function computeDeduction(input: {
  cumulativeBasePaise: bigint;
  priorDeductedPaise: bigint;
  thisPayoutPaise: bigint;
  rate: TdsRate;
  thresholdMetOnCumulative: boolean;
}): {
  tdsDueCumulativePaise: bigint;
  tdsDeductThisPaise: bigint;
  carryForwardPaise: bigint;
} {
  const {
    cumulativeBasePaise,
    priorDeductedPaise,
    thisPayoutPaise,
    rate,
    thresholdMetOnCumulative,
  } = input;

  const tdsDueCumulativePaise = thresholdMetOnCumulative
    ? withholdingTdsPaise(cumulativeBasePaise, rate)
    : 0n;

  // Catch-up owed at this event; never negative (a prior over-deduct never claws back here).
  const rawCatchUp = tdsDueCumulativePaise - priorDeductedPaise;
  const catchUp = rawCatchUp > 0n ? rawCatchUp : 0n;

  // Can't withhold more than the payout pays out; never negative.
  const payout = thisPayoutPaise > 0n ? thisPayoutPaise : 0n;
  const tdsDeductThisPaise = catchUp < payout ? catchUp : payout;

  const carryForwardPaise = catchUp - tdsDeductThisPaise;

  return { tdsDueCumulativePaise, tdsDeductThisPaise, carryForwardPaise };
}

// ─── GROSS-UP "TDS invoice" body amount ───────────────────────────────────────

/**
 * The body amount of the gross-up "TDS invoice" = the grossed-up TDS on the cumulative
 * base once the threshold is met (0 otherwise). Reuses grossUpTdsPaise (base × num / den).
 * One such invoice per (clientId, PAN, FY) — see W0-D; this is only the amount math.
 */
export function computeGrossUpTdsInvoiceBasePaise(
  cumulativeBasePaise: bigint,
  rate: TdsRate,
  thresholdMet: boolean,
): bigint {
  return thresholdMet ? grossUpTdsPaise(cumulativeBasePaise, rate) : 0n;
}

// ─── Pro-rata recovery (GROSS-UP: attribute deposited TDS back to tenants) ────

/**
 * One tenant's STANDALONE pro-rata recovery share = round(panTdsTotal × tenantBase / panBase),
 * round-half-up. Guard panBase <= 0 → 0. Use this for a single dashboard line where an exact
 * cross-tenant reconciliation is NOT required. When you need the shares to sum EXACTLY to the
 * deposited total, use allocateProRataRecovery (rounding here can drift by ±1 paise/tenant).
 */
export function proRataRecovery(input: {
  panTdsTotalPaise: bigint;
  tenantBasePaise: bigint;
  panBasePaise: bigint;
}): bigint {
  const { panTdsTotalPaise, tenantBasePaise, panBasePaise } = input;
  if (panBasePaise <= 0n) return 0n;
  const half = panBasePaise / 2n;
  return (panTdsTotalPaise * tenantBasePaise + half) / panBasePaise;
}

/**
 * EXACT-summing pro-rata split of a PAN's deposited TDS across its contributing tenants,
 * by base contribution. Uses the largest-remainder (Hamilton) method so the shares sum
 * EXACTLY to panTdsTotalPaise (no rounding drift):
 *   1. floor share  = panTdsTotal × base ÷ panBase (integer, truncated)
 *   2. remainder    = (panTdsTotal × base) mod panBase
 *   3. distribute the leftover paise (= total − Σ floors, always < tenant count) one each to
 *      the tenants with the largest remainders (tie-break: larger base, then input order).
 * panBase <= 0 → every share 0. Order of the returned array follows the input order.
 */
export function allocateProRataRecovery(input: {
  panTdsTotalPaise: bigint;
  tenants: { clientId: string; basePaise: bigint }[];
}): { clientId: string; tenantSharePaise: bigint }[] {
  const { panTdsTotalPaise, tenants } = input;
  const panBasePaise = tenants.reduce((s, t) => s + t.basePaise, 0n);

  if (panBasePaise <= 0n || panTdsTotalPaise <= 0n) {
    return tenants.map((t) => ({ clientId: t.clientId, tenantSharePaise: 0n }));
  }

  const rows = tenants.map((t, index) => {
    const product = panTdsTotalPaise * t.basePaise;
    return {
      index,
      clientId: t.clientId,
      basePaise: t.basePaise,
      floorShare: product / panBasePaise,
      remainder: product % panBasePaise,
    };
  });

  const allocated = rows.reduce((s, r) => s + r.floorShare, 0n);
  let leftover = panTdsTotalPaise - allocated; // in [0, tenants.length)

  // Rank by remainder desc, then larger base, then input order — deterministic.
  const ranked = [...rows].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    if (a.basePaise !== b.basePaise) return a.basePaise > b.basePaise ? -1 : 1;
    return a.index - b.index;
  });

  const bump = new Set<number>();
  for (const r of ranked) {
    if (leftover <= 0n) break;
    bump.add(r.index);
    leftover -= 1n;
  }

  return rows.map((r) => ({
    clientId: r.clientId,
    tenantSharePaise: r.floorShare + (bump.has(r.index) ? 1n : 0n),
  }));
}
