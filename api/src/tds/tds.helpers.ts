/**
 * TDS calc helpers — pure, side-effect-free, unit-tested.
 *
 * All money is in integer paise (BigInt). TDS is rounded to the nearest whole
 * rupee = nearest 100 paise. Model: grossed-up / payer-borne — the partner
 * receives the full amount; the payer bears TDS ON TOP:
 *   TDS = base × rate / (1 − rate)
 *
 * Exact factors (grossing-up denominators):
 *   194R PAN        10/90   (10 ÷ (100−10))
 *   194R no-PAN     20/80   (20 ÷ (100−20))
 *   194C indiv/HUF   1/99   ( 1 ÷ (100−1))
 *   194C others      2/98   ( 2 ÷ (100−2))
 *   194C no-PAN     20/80   (20 ÷ (100−20))
 *
 * Rounding: add half the denominator before integer division (round half-up to
 * the nearest 100 paise = 1 rupee). BigInt arithmetic only — no floating-point.
 */

/** One rate expressed as an irreducible integer fraction num/den. */
export interface TdsRate {
  num: number; // e.g. 10
  den: number; // e.g. 90
}

/**
 * Round a paise amount to the nearest whole rupee (100 paise).
 * Uses integer "round half-up": add 50 paise, then floor-divide by 100,
 * then multiply by 100.
 */
export function roundToRupeePaise(paise: bigint): bigint {
  // Handle negatives symmetrically (shouldn't occur in TDS context, but guard anyway)
  if (paise < 0n) return -roundToRupeePaise(-paise);
  return ((paise + 50n) / 100n) * 100n;
}

/**
 * Compute grossed-up TDS: TDS = base × num / den, rounded to nearest rupee.
 *
 * @param basePaise  - the benefit amount in paise (BigInt)
 * @param rate       - { num, den } where TDS rate = num/(num+den) expressed as
 *                     the over-the-full fraction: num/(100−ratePct) = num/den.
 * @returns          - TDS in paise (rounded to nearest 100 paise)
 */
export function grossUpTdsPaise(basePaise: bigint, rate: TdsRate): bigint {
  const { num, den } = rate;
  const rawPaise = basePaise * BigInt(num);
  return roundToRupeePaise(rawPaise / BigInt(den));
}

// ─── Section-specific rate factories ────────────────────────────────────────

/** 194R rate for a PAN holder (10/90) or no-PAN (20/80). */
export function rate194R(hasPan: boolean): TdsRate {
  return hasPan ? { num: 10, den: 90 } : { num: 20, den: 80 };
}

/**
 * 194C rate:
 *   - no PAN           → 20/80
 *   - INDIVIDUAL / HUF → 1/99
 *   - everything else  → 2/98
 */
export function rate194C(hasPan: boolean, entityType?: string | null): TdsRate {
  if (!hasPan) return { num: 20, den: 80 };
  if (entityType === 'INDIVIDUAL' || entityType === 'HUF') return { num: 1, den: 99 };
  return { num: 2, den: 98 };
}

// ─── Financial-year helpers ──────────────────────────────────────────────────

export interface FyInfo {
  fyLabel: string; // e.g. "2025-26"
  start: Date;     // 1 Apr of the year
  endExclusive: Date; // 1 Apr of the next year
}

/**
 * Given any Date, return the FY that contains it.
 * FY n = 1 Apr (year n) → 31 Mar (year n+1).
 * e.g. 2026-01-15 → FY 2025-26 (starts 1 Apr 2025).
 */
export function financialYear(date: Date): FyInfo {
  const month = date.getUTCMonth(); // 0-indexed; April = 3
  const year = date.getUTCFullYear();
  // If January–March (months 0-2), we're in the FY that started the prior April.
  const fyStartYear = month < 3 ? year - 1 : year;
  const start = new Date(Date.UTC(fyStartYear, 3, 1));         // 1 Apr
  const endExclusive = new Date(Date.UTC(fyStartYear + 1, 3, 1)); // 1 Apr (next year)
  const fyLabel = `${fyStartYear}-${String(fyStartYear + 1).slice(2)}`;
  return { fyLabel, start, endExclusive };
}

/** Returns FyInfo for the current system date (UTC). */
export function fyOfToday(): FyInfo {
  return financialYear(new Date());
}

/**
 * Parse a "YYYY-YY" label (e.g. "2025-26") back into FyInfo.
 * Throws if the label is malformed or the short year is inconsistent.
 */
export function fyFromLabel(label: string): FyInfo {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) throw new Error(`Invalid FY label: "${label}". Expected "YYYY-YY", e.g. "2025-26"`);
  const startYear = parseInt(m[1], 10);
  const expectedEnd = (startYear + 1) % 100;
  if (parseInt(m[2], 10) !== expectedEnd) {
    throw new Error(`Inconsistent FY label "${label}": end year should be ${String(startYear + 1).slice(2)}`);
  }
  return financialYear(new Date(Date.UTC(startYear, 3, 15))); // mid-April = safely in FY
}
