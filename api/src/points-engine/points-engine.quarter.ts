/**
 * points-engine.quarter.ts — FINANCIAL-YEAR QUARTER periods for the points engine (owner-approved 2026-11-25).
 *
 * A quarter run is keyed `YYYY-Qn`, where YYYY is the FY START year (Indian FY, April → March):
 *   Q1 = Apr–Jun YYYY · Q2 = Jul–Sep YYYY · Q3 = Oct–Dec YYYY · Q4 = Jan–Mar YYYY+1.
 * So `2026-Q3` = Oct–Dec 2026 and `2026-Q4` = Jan–Mar 2027 (FY 2026-27). Every label the engine shows names the
 * actual months, never just "Q4", so the FY-year convention can't be misread.
 *
 * PURE — no DB / clock. Used by the evaluator (month labels in reasons), the compute service (which months to load)
 * and the D-1 month-closed guard (every month of the quarter must be closed).
 */

const QUARTER_KEY_RE = /^(\d{4})-Q([1-4])$/;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface QuarterInfo {
  /** The run key, e.g. "2026-Q3". */
  key: string;
  /** FY start year (2026 for FY 2026-27). */
  fyStartYear: number;
  quarter: 1 | 2 | 3 | 4;
  /** The 3 months in order, "YYYY-MM". */
  months: [string, string, string];
  /** Per-month labels, e.g. ["Oct 2026", "Nov 2026", "Dec 2026"]. */
  monthLabels: [string, string, string];
  /** "Oct–Dec 2026" (a Q4 reads "Jan–Mar 2027"). */
  label: string;
  /** "Q3 FY2026-27". */
  fyLabel: string;
  /** The quarter's LAST month — the CreditBatch period a direct credit is filed under (credits are month-keyed). */
  creditPeriod: string;
}

/** True for a QUARTERLY rule row (evaluationBasis 'QUARTER'); every other / missing value is monthly. */
export function isQuarterBasis(basis: string | null | undefined): boolean {
  return basis === 'QUARTER';
}

export function isQuarterKey(v: unknown): v is string {
  return typeof v === 'string' && QUARTER_KEY_RE.test(v);
}

/** "2026-11" → "Nov 2026". */
export function shortMonthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return MONTH_SHORT[m - 1] ? `${MONTH_SHORT[m - 1]} ${y}` : ym;
}

/** Parse a `YYYY-Qn` key; null when it is not one. */
export function parseQuarter(key: string): QuarterInfo | null {
  const m = QUARTER_KEY_RE.exec(key);
  if (!m) return null;
  const fy = Number(m[1]);
  const q = Number(m[2]) as 1 | 2 | 3 | 4;
  // FY months: Q1 → 4,5,6 · Q2 → 7,8,9 · Q3 → 10,11,12 (same calendar year) · Q4 → 1,2,3 (next calendar year).
  const firstMonth = q === 4 ? 1 : 1 + q * 3;
  const year = q === 4 ? fy + 1 : fy;
  const months = [0, 1, 2].map((i) => `${year}-${String(firstMonth + i).padStart(2, '0')}`) as [string, string, string];
  const monthLabels = months.map(shortMonthLabel) as [string, string, string];
  return {
    key,
    fyStartYear: fy,
    quarter: q,
    months,
    monthLabels,
    label: `${MONTH_SHORT[firstMonth - 1]}–${MONTH_SHORT[firstMonth + 1]} ${year}`,
    fyLabel: `Q${q} FY${fy}-${String((fy + 1) % 100).padStart(2, '0')}`,
    creditPeriod: months[2],
  };
}

/** The FY quarter key a "YYYY-MM" month belongs to ("2026-11" → "2026-Q3", "2027-02" → "2026-Q4"). */
export function quarterKeyForMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m >= 4 ? `${y}-Q${Math.floor((m - 4) / 3) + 1}` : `${y - 1}-Q4`;
}

/** The first calendar day of the quarter (UTC midnight) — the rule effective-window test date for a quarter run. */
export function quarterStartDate(info: QuarterInfo): Date {
  return new Date(`${info.months[0]}-01T00:00:00.000Z`);
}
