/**
 * Shapes the partner dashboard "Target vs. Achievement" chart series from the
 * REAL primary-KPI trend returned by GET /api/partner/targets/trend.
 *
 * The backend returns the trailing N calendar months (oldest first) of the
 * partner's primary KPI: { month: 'YYYY-MM', target, achieved } (null = no data
 * that month — an honest gap, never a fabricated 0).
 */

export interface TrendPoint {
  month: string;            // 'YYYY-MM'
  target: number | null;
  achieved: number | null;
}

export interface MonthlyPoint {
  month: string;            // short label, e.g. 'Jun'
  target: number | null;
  achieved: number | null;
}

export interface YoYPoint {
  month: string;            // short label, FY order (Apr→Mar)
  target: number | null;
  fy25: number | null;      // achieved, previous FY
  fy26: number | null;      // achieved, current FY
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthNum(ym: string): number {
  return Number(ym.slice(5, 7));
}
function yearNum(ym: string): number {
  return Number(ym.slice(0, 4));
}
function label(ym: string): string {
  const m = monthNum(ym);
  return MONTH_LABELS[m - 1] ?? ym;
}

/** Indian financial year start-year for a month: Apr–Dec → this year; Jan–Mar → previous year. */
function fyStartYear(ym: string): number {
  return monthNum(ym) >= 4 ? yearNum(ym) : yearNum(ym) - 1;
}

/** 'FY 25-26' for start year 2025. */
function fyLabel(startYear: number): string {
  const a = String(startYear % 100).padStart(2, '0');
  const b = String((startYear + 1) % 100).padStart(2, '0');
  return `FY ${a}-${b}`;
}

/** Whether a series has any real value to plot (else the chart shows an empty state). */
export function hasData(points: Array<{ target: number | null; achieved?: number | null; fy25?: number | null; fy26?: number | null }>): boolean {
  return points.some(
    (p) => p.target != null || p.achieved != null || p.fy25 != null || p.fy26 != null,
  );
}

export function buildChartSeries(trend: TrendPoint[]): {
  monthly: MonthlyPoint[];
  yoy: YoYPoint[];
  yoyLabels: { prev: string; cur: string };
} {
  // ── Monthly: the last 6 months, as-is ──
  const monthly: MonthlyPoint[] = trend.slice(-6).map((p) => ({
    month: label(p.month),
    target: p.target,
    achieved: p.achieved,
  }));

  // ── Year-on-year: the two most-recent FYs present in the data ──
  const fyYears = [...new Set(trend.map((p) => fyStartYear(p.month)))].sort((a, b) => a - b);
  const curFY = fyYears.length ? fyYears[fyYears.length - 1] : null;
  const prevFY = curFY != null ? curFY - 1 : null;

  const byKey = new Map(trend.map((p) => [p.month, p]));
  const ymOf = (fyStart: number, m: number) =>
    `${m >= 4 ? fyStart : fyStart + 1}-${String(m).padStart(2, '0')}`;

  const fyMonthOrder = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
  const yoy: YoYPoint[] = fyMonthOrder.map((m) => {
    const cur = curFY != null ? byKey.get(ymOf(curFY, m)) : undefined;
    const prev = prevFY != null ? byKey.get(ymOf(prevFY, m)) : undefined;
    return {
      month: MONTH_LABELS[m - 1],
      target: cur?.target ?? null,
      fy26: cur?.achieved ?? null,
      fy25: prev?.achieved ?? null,
    };
  });

  return {
    monthly,
    yoy,
    yoyLabels: {
      prev: prevFY != null ? fyLabel(prevFY) : 'Prev FY',
      cur: curFY != null ? fyLabel(curFY) : 'This FY',
    },
  };
}
