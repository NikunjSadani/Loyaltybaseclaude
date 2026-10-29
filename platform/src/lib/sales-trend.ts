/**
 * Typed client for GET /v1/sales/target-trend — the dashboard "Target vs. Achievement"
 * chart's KPI + Program filters. The browser calls same-origin `/api/sales/target-trend`,
 * which the Next rewrite forwards to the backend `/v1/...`.
 */

export interface TargetTrendPoint {
  month: string;
  target: number;
  achieved: number;
}

export interface TargetTrendResult {
  kpiCode: string | null;
  kpiName: string | null;
  unit: string;
  rollup: 'SUM' | 'OUTLET_COUNT';
  trend: TargetTrendPoint[];
}

/**
 * Fetch the 6-month trend for a KPI (omit → primary). Dashboard view: restrict to a program
 * (omit → all of the caller's active outlets), roll-up aware. Outlet-detail view: pass `outlet`
 * (an outletCode) for that single outlet's raw monthly series (program ignored, always SUM).
 * Returns null on any failure so the caller can fall back.
 */
export async function fetchTargetTrend(
  kpi?: string,
  program?: string,
  outlet?: string,
  outletType?: string,
): Promise<TargetTrendResult | null> {
  const qs = new URLSearchParams();
  if (kpi) qs.set('kpi', kpi);
  if (program) qs.set('program', program);
  if (outlet) qs.set('outlet', outlet);
  if (outletType) qs.set('outletType', outletType);
  const url = `/api/sales/target-trend${qs.toString() ? `?${qs.toString()}` : ''}`;
  try {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok || !body?.success) return null;
    return body.data as TargetTrendResult;
  } catch {
    return null;
  }
}
