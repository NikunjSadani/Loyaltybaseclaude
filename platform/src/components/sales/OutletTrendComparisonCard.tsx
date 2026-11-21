'use client';

/**
 * OutletTrendComparisonCard — the Bajaj single-outlet "Trend Comparison" card on the sales
 * OUTLET DETAIL page. It REPLACES the historical Target-vs-Achievement GRAPH (OutletTrendCard)
 * for the Bajaj tenant only; non-Bajaj tenants keep the graph.
 *
 * It mirrors the dashboard's TradeComparisonCard visual style (BarChart3 header, 3-bucket grid,
 * the shared formatByUnit / pctColor helpers) but is scoped to THIS ONE outlet, so it drops the
 * team-only pieces: NO team-member filter, NO program filter, and the dashboard card's team
 * "Width of achievement" row becomes a single-outlet "% achievement" row.
 *
 * Buckets — derived from the outlet's own per-month trend series (chronological) returned by
 * GET /api/sales/target-trend?outlet=:
 *   • Current      = the last month in the series
 *   • Last month   = the second-to-last month
 *   • Last 3 months = the mean of the last 3 months (mean achieved / mean target; the % is the
 *                     mean of the non-null monthly percentages)
 *
 * Gating (identical to OutletTrendCard, so this card appears/disappears together with the
 * per-month Target Achievement card): it fetches the current IST month's outlet-targets once and
 * renders nothing until the outlet has a target/achieved for some KPI this month. The KPI selector
 * (the only filter kept) drives the trend fetch, same as the graph it replaces.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { fetchTargetTrend, type TargetTrendResult, type TargetTrendPoint } from '@/lib/sales-trend';
import { istMonthKey } from '@/lib/ist-date';
import { getOutletTargets } from '@/lib/cached-reads';
import { formatInrCompact, formatCompact, isInrUnit } from '@/lib/format-inr';

/* Minimal shapes of the outlet-targets response (same fields the detail page reads) — used ONLY
 * for the show/hide gate + the KPI dropdown options. */
interface OutletKpiCol { code: string; name: string; unit: string; isPrimary: boolean; order?: number; rollup?: 'SUM' | 'OUTLET_COUNT'; }
interface OutletKpiVal { target: number | null; achieved: number | null; pace: number | null }
interface OutletTargetsResponse {
  kpiColumns: OutletKpiCol[];
  rows: { outletCode: string; kpis: Record<string, OutletKpiVal> }[];
}

/** One bucket's single-outlet figures (null when the bucket has no month). */
export interface OutletTrendBucket { achieved: number | null; target: number | null; pct: number | null }

/** Colour the % like the dashboard card: ≥100 emerald, ≥80 amber, ≥60 orange, else red; null → gray. */
function pctColor(pct: number | null): string {
  if (pct === null) return 'text-gray-400';
  if (pct >= 100) return 'text-emerald-600';
  if (pct >= 80) return 'text-amber-600';
  if (pct >= 60) return 'text-orange-500';
  return 'text-red-500';
}

/** Format a value by the KPI's unit (INR → compact ₹; other unit → compact value + suffix). */
function formatByUnit(value: number, unit?: string | null): string {
  if (isInrUnit(unit)) return formatInrCompact(value);
  return `${formatCompact(value)}${unit ? ` ${unit}` : ''}`;
}

/** This month's own achieved/target as a whole-number percent; null when there is no target. */
function monthPct(p: TargetTrendPoint): number | null {
  return p.target > 0 ? Math.round((p.achieved / p.target) * 100) : null;
}

/**
 * Derive the three comparison buckets from a chronological per-month trend series.
 * current = last month, lastMonth = second-to-last, last3Months = mean of the last ≤3 months
 * (mean achieved / mean target; pct = mean of the non-null monthly pcts). Buckets with no month
 * are all-null (rendered as "—"). PURE — exported for unit testing.
 */
export function deriveOutletTrendBuckets(trend: TargetTrendPoint[]): {
  current: OutletTrendBucket; lastMonth: OutletTrendBucket; last3Months: OutletTrendBucket;
} {
  const n = trend.length;
  const EMPTY: OutletTrendBucket = { achieved: null, target: null, pct: null };
  const bucketOf = (p?: TargetTrendPoint): OutletTrendBucket =>
    p ? { achieved: p.achieved, target: p.target, pct: monthPct(p) } : EMPTY;

  const current = bucketOf(trend[n - 1]);
  const lastMonth = bucketOf(trend[n - 2]);

  const last3 = trend.slice(-3);
  let last3Months = EMPTY;
  if (last3.length > 0) {
    const meanAchieved = last3.reduce((s, p) => s + p.achieved, 0) / last3.length;
    const meanTarget = last3.reduce((s, p) => s + p.target, 0) / last3.length;
    const pcts = last3.map(monthPct).filter((v): v is number => v !== null);
    const meanPct = pcts.length ? Math.round(pcts.reduce((s, v) => s + v, 0) / pcts.length) : null;
    last3Months = { achieved: meanAchieved, target: meanTarget, pct: meanPct };
  }
  return { current, lastMonth, last3Months };
}

export function OutletTrendComparisonCard({ outletCode }: { outletCode: string }) {
  // Show/hide gate + KPI options, from the current IST month's outlet-targets (same source + gate
  // as the graph card this replaces, so the two cards appear/disappear together).
  const [kpiCols, setKpiCols] = useState<OutletKpiCol[] | null>(null);
  const [hasAny, setHasAny] = useState(false);

  // KPI selection ('' = primary default) drives the trend fetch — the only filter this card keeps.
  const [kpi, setKpi] = useState('');

  // The selected KPI's per-month series for THIS outlet (backend forces SUM for a single outlet).
  const [trend, setTrend] = useState<TargetTrendResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!outletCode) { setKpiCols(null); return; }
    let cancelled = false;
    // Shared + de-duplicated with the detail page's Target Achievement card (lib/cached-reads.ts).
    getOutletTargets<OutletTargetsResponse>(istMonthKey(new Date()))
      .then((body) => {
        if (cancelled) return;
        if (!body?.success) { setKpiCols(null); return; }
        const data = body.data as OutletTargetsResponse;
        const row = (data.rows ?? []).find((x) => x.outletCode === outletCode);
        setKpiCols(data.kpiColumns ?? []);
        setHasAny(!!row && Object.values(row.kpis ?? {}).some((k) => k.target != null || k.achieved != null));
      })
      .catch(() => { if (!cancelled) setKpiCols(null); });
    return () => { cancelled = true; };
  }, [outletCode]);

  useEffect(() => {
    if (!outletCode) { setTrend(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(false);
    setTrend(null);
    fetchTargetTrend(kpi || undefined, undefined, outletCode)
      .then((r) => {
        if (cancelled) return;
        if (r) setTrend(r); else setError(true);
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [outletCode, kpi]);

  const buckets = useMemo(() => deriveOutletTrendBuckets(trend?.trend ?? []), [trend]);
  const unit = trend?.unit ?? '';

  const columns = useMemo(
    () => [
      { key: 'current' as const, label: 'Current' },
      { key: 'lastMonth' as const, label: 'Last month' },
      { key: 'last3Months' as const, label: 'Last 3 months' },
    ],
    [],
  );

  // Gate: nothing until this outlet has a target/achieved this month (matches OutletTrendCard).
  if (!kpiCols || !hasAny) return null;

  const hasTrend = !!trend && (trend.trend?.length ?? 0) > 0;

  return (
    <Card data-testid="outlet-trend-comparison-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BarChart3 className="h-4 w-4 text-[var(--brand-primary)]" /> Trend Comparison
          </CardTitle>
          {/* KPI selector — '' = the primary default (unchanged initial view). */}
          <div className="relative shrink-0">
            <select
              aria-label="KPI"
              value={kpi}
              onChange={(e) => setKpi(e.target.value)}
              className={`appearance-none text-[11px] font-semibold border rounded-full pl-2.5 pr-6 py-1 bg-white focus:outline-none transition-colors cursor-pointer ${kpi !== '' ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]' : 'border-gray-200 text-gray-600 focus:border-[var(--brand-primary)]'}`}
            >
              <option value="">Primary KPI</option>
              {kpiCols.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
            <svg className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 ${kpi !== '' ? 'text-[var(--brand-primary)]' : 'text-gray-400'}`} viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6"><Spinner size="md" /></div>
        ) : error ? (
          <p className="text-xs text-red-500 py-3 text-center">Couldn&apos;t load the trend. Pull to refresh.</p>
        ) : !hasTrend ? (
          <p className="text-xs text-gray-400 py-3 text-center">No target history yet for this outlet.</p>
        ) : (
          <div className="space-y-2">
            {/* Column header */}
            <div className="grid grid-cols-4 gap-1 items-end">
              <div />
              {columns.map((c) => (
                <div key={c.key} className="text-[10px] font-semibold text-gray-500 text-center leading-tight">{c.label}</div>
              ))}
            </div>

            {/* Row: Achievement — this outlet's achieved value, formatted by the KPI's unit. */}
            <div className="grid grid-cols-4 gap-1 items-center py-1.5 border-t border-gray-50">
              <div className="text-[11px] font-medium text-gray-600">Achievement</div>
              {columns.map((c) => {
                const v = buckets[c.key].achieved;
                return (
                  <div key={c.key} className="text-sm font-bold text-gray-800 text-center">
                    {v === null ? '—' : formatByUnit(v, unit)}
                  </div>
                );
              })}
            </div>

            {/* Row: Target — this outlet's target for the same bucket. */}
            <div className="grid grid-cols-4 gap-1 items-center py-1.5 border-t border-gray-50">
              <div className="text-[11px] font-medium text-gray-600">Target</div>
              {columns.map((c) => {
                const v = buckets[c.key].target;
                return (
                  <div key={c.key} className="text-sm font-bold text-gray-800 text-center">
                    {v === null ? '—' : formatByUnit(v, unit)}
                  </div>
                );
              })}
            </div>

            {/* Row: % achievement — the outlet's own achieved/target percent, colour-coded. Replaces
                the dashboard card's team "Width of achievement" row (meaningless for one outlet). */}
            <div className="grid grid-cols-4 gap-1 items-center py-1.5 border-t border-gray-50">
              <div className="text-[11px] font-medium text-gray-600">% achievement</div>
              {columns.map((c) => {
                const p = buckets[c.key].pct;
                return (
                  <div key={c.key} className="text-center">
                    <span className={`text-sm font-bold leading-tight ${pctColor(p)}`}>
                      {p === null ? '—' : `${p}%`}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
