'use client';

/**
 * Partner Targets page — FE-A (Targets / Stream T).
 *
 * Data source rewire:
 *   OLD: GET /api/partner/targets → { targets: ApiSchemeTarget[] } (scheme-scoped)
 *        merged with DEMO mock data from lib/targets.ts
 *   NEW: GET /api/partner/targets?period=YYYY-MM
 *        → { period, outlets: [{outletCode, outletName, outletType,
 *             kpis: [{code, target, achieved, pace}]}] }
 *
 * Fallback: if API returns no data / fails, show empty-state (no mock data injected).
 * UI shell and styling are preserved. ParamCard and the hero scorecard are reused.
 */

import { useState, useEffect, useMemo } from 'react';
import {
  Target, TrendingUp, Award,
  AlertTriangle, AlertCircle, CheckCircle,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import {
  pct, pctColor, pctBg, pctBarColor,
  buildMonthRange, formatMonth,
} from '@/lib/targets';
import { getGifsySettings } from '@/lib/gifsy-settings';

/* ─── Backend response types ─────────────────────────────────────────────────── */

interface KpiRow {
  code:     string;
  target:   number | null;
  achieved: number | null;
  pace:     number | null;
}

interface OutletRow {
  outletCode: string;
  outletName: string;
  outletType: string;
  kpis:       KpiRow[];
}

interface TargetsResponse {
  period:  string | null;
  outlets: OutletRow[];
}

/* ─── Flat param shape for the card UI ──────────────────────────────────────── */

interface DisplayParam {
  id:        string;   // kpi.code (stable key for the UI)
  label:     string;   // kpi.code formatted for display
  unit:      string;   // 'cases' (from KpiDef, not in this response — default)
  target:    number;
  isPrimary: boolean;
}

/* ─── Pace helper ─────────────────────────────────────────────────────────────── */

function computePace(period: string): { timePct: number; daysLeft: number; elapsed: number; daysInMonth: number } | null {
  const parts = period.split('-');
  if (parts.length < 2) return null;
  const year  = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  if (isNaN(year) || isNaN(month)) return null;
  const today       = new Date();
  const daysInMonth = new Date(year, month, 0).getDate();
  const isCurrent   = today.getFullYear() === year && today.getMonth() + 1 === month;
  const elapsed     = isCurrent ? today.getDate() : daysInMonth;
  const daysLeft    = isCurrent ? daysInMonth - today.getDate() : 0;
  const timePct     = Math.round((elapsed / daysInMonth) * 100);
  return { timePct, daysLeft, elapsed, daysInMonth };
}

/* ─── Progress bar ────────────────────────────────────────────────────────────── */

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pctFill = Math.min((value / max) * 100, 100);
  return (
    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pctFill}%` }} />
    </div>
  );
}

/* ─── Parameter card ──────────────────────────────────────────────────────────── */

function ParamCard({
  param,
  achieved,
  timePct,
  daysLeft,
}: {
  param:    DisplayParam;
  achieved: number;
  timePct:  number;
  daysLeft: number;
}) {
  const p          = pct(achieved, param.target);
  const col        = pctColor(p);
  const bar        = pctBarColor(p);
  const fmt        = (n: number) => `${n} ${param.unit}`;
  const isAchieved = p >= 100;
  const isOnPace   = timePct - p <= 0;
  const remaining  = Math.max(0, param.target - achieved);
  const dayWord    = daysLeft === 1 ? 'day' : 'days';

  const unitLabel = remaining === 1 ? param.unit.replace(/s$/i, '') : param.unit;
  const paceMsg   = isOnPace
    ? `On track · ${daysLeft} ${dayWord} left`
    : `${remaining} ${unitLabel} to go · ${daysLeft} ${dayWord} left`;
  const threshold = getGifsySettings().paceAmberThreshold ?? 10;
  const nearDone  = param.target > 0 && remaining / param.target <= threshold / 100;
  const paceBg    = isOnPace ? 'bg-emerald-50 text-emerald-700' : nearDone ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-600';
  const stripCol  = isAchieved ? 'bg-emerald-400' : isOnPace ? 'bg-emerald-400' : nearDone ? 'bg-amber-400' : 'bg-red-400';

  return (
    <div className={`bg-white rounded-2xl border overflow-hidden shadow-sm ${isAchieved ? 'border-emerald-200' : 'border-gray-100'}`}>
      <div className={`h-1 ${stripCol}`} />
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900 leading-tight">{param.label}</p>
          </div>
          <span className={`text-sm font-bold px-2.5 py-1 rounded-full shrink-0 ${pctBg(p)}`}>
            {p}%
          </span>
        </div>

        <ProgressBar value={achieved} max={param.target} color={bar} />

        <div className="flex items-center justify-between text-xs">
          <div>
            <span className="text-gray-400">Achieved: </span>
            <span className={`font-bold ${col}`}>{fmt(achieved)}</span>
          </div>
          <div>
            <span className="text-gray-400">Target: </span>
            <span className="font-semibold text-gray-700">{fmt(param.target)}</span>
          </div>
        </div>

        {!isAchieved && (
          <div className={`flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-lg ${paceBg}`}>
            <TrendingUp className="h-3 w-3 shrink-0" />
            {paceMsg}
          </div>
        )}

        {isAchieved && (
          <div className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
            <Award className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
            <span className="text-xs text-emerald-700 font-semibold">Target achieved! Incentive being verified by Deoleo.</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Period dropdown options (rolling 12 months back from today) ─────────────── */

function getPeriodOptions(): Array<{ value: string; label: string }> {
  const result: Array<{ value: string; label: string }> = [];
  const base = new Date();
  base.setDate(1);
  for (let i = 0; i >= -11; i--) {
    const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    result.push({ value, label: formatMonth(value) });
  }
  return result;
}

function currentPeriodValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/* ─── Page ────────────────────────────────────────────────────────────────────── */

export default function PartnerTargetsPage() {
  const periodOptions = useMemo(() => getPeriodOptions(), []);
  const [period,  setPeriod]  = useState(currentPeriodValue);
  const [loading, setLoading] = useState(true);
  const [data,    setData]    = useState<TargetsResponse | null>(null);

  /* Fetch on period change */
  useEffect(() => {
    setLoading(true);
    setData(null);
    const controller = new AbortController();

    const token = typeof window !== 'undefined' ? localStorage.getItem('token') ?? '' : '';

    fetch(`/api/partner/targets?period=${period}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal:  controller.signal,
    })
      .then(r => r.json())
      .then((json: { success: boolean; data?: TargetsResponse }) => {
        if (json.success && json.data) {
          setData(json.data);
        } else {
          setData({ period, outlets: [] });
        }
      })
      .catch(err => {
        if ((err as Error).name === 'AbortError') return;
        setData({ period, outlets: [] });
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [period]);

  /* Flatten to params + achievements from the FIRST outlet's KPIs (partner
     typically has one outlet; if multiple outlets exist we aggregate). */
  const { params, achievementMap } = useMemo((): {
    params: DisplayParam[];
    achievementMap: Record<string, number>;
  } => {
    if (!data || data.outlets.length === 0) return { params: [], achievementMap: {} };

    // Collect the union of all KPI codes across all outlets
    const kpiCodeSet = new Set<string>();
    for (const outlet of data.outlets) {
      for (const k of outlet.kpis) kpiCodeSet.add(k.code);
    }

    // Build per-KPI aggregate sums (target sum, achieved sum)
    const targetSum:   Record<string, number>  = {};
    const achievedSum: Record<string, number>  = {};
    // isPrimary: first KPI is treated as primary if none is explicitly marked
    // Backend does not return isPrimary in this shape — use order position (first = primary)
    const kpiCodes = [...kpiCodeSet];

    for (const outlet of data.outlets) {
      for (const k of outlet.kpis) {
        targetSum[k.code]   = (targetSum[k.code]   ?? 0) + (k.target   ?? 0);
        achievedSum[k.code] = (achievedSum[k.code] ?? 0) + (k.achieved ?? 0);
      }
    }

    const displayParams: DisplayParam[] = kpiCodes
      .filter(code => (targetSum[code] ?? 0) > 0)  // only show KPIs that have a target
      .map((code, idx) => ({
        id:        code,
        label:     code.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        unit:      'cases',
        target:    targetSum[code] ?? 0,
        isPrimary: idx === 0,
      }));

    return { params: displayParams, achievementMap: achievedSum };
  }, [data]);

  const pace = useMemo(() => (data?.period ? computePace(data.period) : null), [data]);

  const primaryParam = useMemo(() => params.find(p => p.isPrimary) ?? params[0] ?? null, [params]);

  const monthlyTargetPct = useMemo(() => {
    if (!primaryParam) return 0;
    return pct(achievementMap[primaryParam.id] ?? 0, primaryParam.target);
  }, [primaryParam, achievementMap]);

  const unlockedCount = useMemo(
    () => params.filter(p => pct(achievementMap[p.id] ?? 0, p.target) >= 100).length,
    [params, achievementMap],
  );

  const periodLabel = periodOptions.find(p => p.value === period)?.label ?? period;
  const activePeriod = data?.period ?? period;

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">My Targets</h1>
          <p className="text-sm text-gray-500">Track your progress against monthly targets</p>
        </div>

        {/* Period dropdown */}
        <div className="relative shrink-0">
          <select
            value={period}
            onChange={e => setPeriod(e.target.value)}
            className="appearance-none text-[11px] font-semibold border border-gray-200 rounded-full pl-2.5 pr-6 py-1.5 bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] cursor-pointer"
          >
            {periodOptions.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <svg className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48"><Spinner size="lg" /></div>
      ) : params.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Target className="h-10 w-10 text-gray-200" />
          <p className="text-sm text-gray-400">No targets configured for {periodLabel}.</p>
          <p className="text-xs text-gray-300">Contact your sales officer for more information.</p>
        </div>
      ) : (
        <>
          {/* Overall score card */}
          {(() => {
            const notHit   = params.length - unlockedCount;
            const daysLeft = pace?.daysLeft ?? 0;
            const dWord    = daysLeft === 1 ? 'day' : 'days';
            const timePct  = pace?.timePct ?? 100;
            const paceGap  = timePct - monthlyTargetPct;

            const cardState: 'ALL_MET' | 'PARTIAL' | 'WARN' | 'CRITICAL' =
              unlockedCount === params.length            ? 'ALL_MET'  :
              paceGap > 20 || (daysLeft <= 3 && paceGap > 5) ? 'CRITICAL' :
              paceGap > 5                               ? 'WARN'     :
                                                          'PARTIAL';

            const STATE_CFG = {
              ALL_MET:  {
                bg:        'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-primary-dark) 100%)',
                Icon:      CheckCircle,
                chip:      { bg: 'bg-emerald-400/30', text: 'text-white',     label: 'All Done' },
                strip:     'bg-white/20 text-white',
                stripIcon: CheckCircle,
              },
              PARTIAL:  {
                bg:        'linear-gradient(135deg, #1d4ed8 0%, #1e3a8a 100%)',
                Icon:      TrendingUp,
                chip:      { bg: 'bg-blue-400/30',   text: 'text-blue-100',   label: 'In Progress' },
                strip:     'bg-white/15 text-white',
                stripIcon: TrendingUp,
              },
              WARN:     {
                bg:        'linear-gradient(135deg, #b45309 0%, #78350f 100%)',
                Icon:      AlertTriangle,
                chip:      { bg: 'bg-amber-400/30',  text: 'text-amber-100',  label: 'Needs Push' },
                strip:     'bg-amber-400/25 text-amber-100',
                stripIcon: AlertTriangle,
              },
              CRITICAL: {
                bg:        'linear-gradient(135deg, #dc2626 0%, #7f1d1d 100%)',
                Icon:      AlertCircle,
                chip:      { bg: 'bg-red-400/30',    text: 'text-red-100',    label: 'Urgent' },
                strip:     'bg-white text-red-700',
                stripIcon: AlertCircle,
              },
            };

            const cfg       = STATE_CFG[cardState];
            const Icon      = cfg.Icon;
            const StripIcon = cfg.stripIcon;

            return (
              <div className="rounded-2xl overflow-hidden text-white" style={{ background: cfg.bg }}>
                <div className="px-5 pt-5 pb-0 flex items-start justify-between gap-2">
                  <div>
                    <p className="text-white/70 text-[11px] font-semibold uppercase tracking-wide">{periodLabel} Performance</p>
                    {pace && (
                      <p className="text-white/50 text-[10px] mt-0.5">
                        {daysLeft > 0 ? `${daysLeft} ${dWord} left` : 'Last day of month'}
                      </p>
                    )}
                  </div>
                  <span className={`flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-full shrink-0 ${cfg.chip.bg} ${cfg.chip.text}`}>
                    <Icon className="h-3 w-3" />
                    {cfg.chip.label}
                  </span>
                </div>

                <div className="px-5 pt-4 pb-4 flex items-end justify-between gap-4">
                  <div>
                    <p className="text-5xl font-extrabold leading-none tracking-tight">
                      {unlockedCount}<span className="text-2xl font-bold text-white/50">/{params.length}</span>
                    </p>
                    <p className="text-white/60 text-xs mt-1.5 font-medium">targets hit this month</p>
                  </div>
                  <div className="text-right pb-1">
                    <p className="text-2xl font-extrabold text-white/90">{monthlyTargetPct}%</p>
                    <p className="text-white/50 text-[10px] mt-0.5">{primaryParam?.label ?? 'primary target'}</p>
                  </div>
                </div>

                <div className={`mx-3 mb-3 rounded-xl px-3 py-2.5 flex items-center gap-2 text-[11px] font-bold ${cfg.strip}`}>
                  <StripIcon className="h-3.5 w-3.5 shrink-0" />
                  {cardState === 'ALL_MET'
                    ? 'All targets achieved! Incentive being verified by Deoleo.'
                    : `${notHit} target${notHit !== 1 ? 's' : ''} still to close · ${daysLeft} ${dWord} left`}
                </div>
              </div>
            );
          })()}

          {/* Parameter cards */}
          <div className="space-y-3">
            {params.map(param => (
              <ParamCard
                key={param.id}
                param={param}
                achieved={achievementMap[param.id] ?? 0}
                timePct={pace?.timePct ?? 100}
                daysLeft={pace?.daysLeft ?? 0}
              />
            ))}
          </div>

          {/* Outlet breakdown (shown when partner has multiple outlets) */}
          {data && data.outlets.length > 1 && (
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
              <p className="px-5 py-3.5 text-xs font-semibold text-gray-600 border-b border-gray-100">
                {data.outlets.length} Outlets — {periodLabel}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide bg-gray-50">
                      <th className="py-2 pl-4 pr-2 text-left">Outlet</th>
                      <th className="py-2 px-2 text-left">Type</th>
                      {(data.outlets[0]?.kpis ?? []).map(k => (
                        <th key={k.code} className="py-2 px-2 text-right">
                          {k.code.replace(/_/g, ' ')}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {data.outlets.map(outlet => (
                      <tr key={outlet.outletCode}>
                        <td className="py-2 pl-4 pr-2 font-medium text-gray-800">{outlet.outletName}</td>
                        <td className="py-2 px-2 text-gray-400">{outlet.outletType}</td>
                        {outlet.kpis.map(k => {
                          const p = k.target && k.target > 0 ? pct(k.achieved ?? 0, k.target) : null;
                          return (
                            <td key={k.code} className="py-2 px-2 text-right">
                              <span className="text-gray-800 font-mono">{k.achieved ?? '—'}</span>
                              {p !== null && (
                                <span className={`ml-1 text-[10px] ${pctColor(p)}`}>({p}%)</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Footer */}
          <p className="text-[10px] text-gray-400 text-center pb-2">
            Data synced as of today · {periodLabel}
          </p>
        </>
      )}
    </div>
  );
}
