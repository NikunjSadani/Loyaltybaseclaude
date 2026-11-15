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
import { istDateKey } from '@/lib/ist-date';
import { useClientConfig } from '@/lib/platform/client-config-context';
import { formatKpiAmount, formatKpiSoFar, formatInrWhole, isInrUnit } from '@/lib/format-inr';
import { useTenantFeatures } from '@/lib/tenant-features';

/* ─── Backend response types ─────────────────────────────────────────────────── */

interface KpiRow {
  code:     string;
  // Per-outlet display name from the backend: the custom "name override" if the
  // admin set one for this outlet/month, else the KPI's generic label. The API
  // already applies the "custom name if set, else label" rule (it reads
  // targetValues.__names[code]); the FE just renders `name`.
  name?:    string;
  target:   number | null;
  achieved: number | null;
  pace:     number | null;
  unit?:      string;   // KpiDef.unit (e.g. 'litre')
  isPrimary?: boolean;  // real KpiDef.isPrimary — replaces the old idx===0 guess
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
  /** partnerDashboardV2 only: sales of this KPI at the partner's OTHER outlets that have NO target for
   *  it — shown separately, never in the %. Absent with the flag OFF; 0 for single-outlet partners /
   *  when every outlet has the target. */
  untargetedAchieved?: number;
}

/** One column of the multi-outlet breakdown table (union of KPI codes across outlets, first-seen order). */
interface TableCol {
  code: string;
  name: string;
}

/** A KPI with NO target this month (summed target ≤ 0) — shown as a neutral "so far" figure. */
interface SoFarParam {
  id:       string;
  label:    string;
  unit?:    string;
  /** Summed achieved across outlets; null when NO outlet reported a value (no sales data → "—"). */
  achieved: number | null;
}

/* ─── Pace helper ─────────────────────────────────────────────────────────────── */

function computePace(period: string): { timePct: number; daysLeft: number; elapsed: number; daysInMonth: number } | null {
  const parts = period.split('-');
  if (parts.length < 2) return null;
  const year  = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  if (isNaN(year) || isNaN(month)) return null;
  // Compare "today" in IST (prod/SSR runs UTC; an off-IST clock skews pacing by a day at boundaries).
  const key         = istDateKey(new Date()); // "YYYY-MM-DD" in Asia/Kolkata
  const istYear     = Number(key.slice(0, 4));
  const istMonth    = Number(key.slice(5, 7)); // 1-based
  const istDay      = Number(key.slice(8, 10));
  const daysInMonth = new Date(year, month, 0).getDate();
  const isCurrent   = istYear === year && istMonth === month;
  const elapsed     = isCurrent ? istDay : daysInMonth;
  const daysLeft    = isCurrent ? daysInMonth - istDay : 0;
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
  isCurrentPeriod = true,
}: {
  param:    DisplayParam;
  achieved: number;
  timePct:  number;
  daysLeft: number;
  /** False for a past (closed) month — the untargeted-sales line then drops "so far". */
  isCurrentPeriod?: boolean;
}) {
  const clientName = useClientConfig().branding.displayName;
  const p          = pct(achieved, param.target);
  const col        = pctColor(p);
  const bar        = pctBarColor(p);
  // INR-unit KPIs read as money — "₹10,414" (whole rupees, Indian grouping); every other unit
  // (SKU, cases, Litre…) keeps the raw "<n> <unit>" exactly as before (owner-approved, all tenants).
  const fmt        = (n: number) => (isInrUnit(param.unit) ? formatInrWhole(n) : `${n} ${param.unit}`);
  const isAchieved = p >= 100;
  const isOnPace   = timePct - p <= 0;
  const remaining  = Math.max(0, param.target - achieved);
  const dayWord    = daysLeft === 1 ? 'day' : 'days';

  const unitLabel = remaining === 1 ? param.unit.replace(/s$/i, '') : param.unit;
  const paceMsg   = isOnPace
    ? `On track · ${daysLeft} ${dayWord} left`
    : `${isInrUnit(param.unit) ? formatInrWhole(remaining > 0 ? Math.max(1, Math.ceil(remaining)) : 0) : `${remaining} ${unitLabel}`} to go · ${daysLeft} ${dayWord} left`;
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

        {/* partnerDashboardV2: sales at the partner's outlets WITHOUT this target — neutral, never part
            of the % above. Absent (byte-identical card) with the flag OFF, for single-outlet partners,
            when every outlet has the target, and when the amount is ≤ 0 (net returns). */}
        {(param.untargetedAchieved ?? 0) >= 0.5 && (
          <p className="text-[10px] text-gray-500" data-testid={`kpi-untargeted-extra-${param.id}`}>
            +{formatKpiAmount(param.untargetedAchieved ?? 0, param.unit)}{isCurrentPeriod ? ' so far' : ''} at outlets without this target
          </p>
        )}

        {!isAchieved && (
          <div className={`flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-lg ${paceBg}`}>
            <TrendingUp className="h-3 w-3 shrink-0" />
            {paceMsg}
          </div>
        )}

        {isAchieved && (
          <div className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
            <Award className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
            <span className="text-xs text-emerald-700 font-semibold">Target achieved! Incentive being verified by {clientName}.</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── No-target ("so far") card ───────────────────────────────────────────────── */

/**
 * A KPI with sales but NO target this month (e.g. Bajaj SAMT's NON ADHO eligibility-gate KPI): a
 * neutral grey "so far" figure — no %, no bar, no pace/achieved status, never counted in
 * "targets hit". A red 0% read as "you have done nothing" even when the outlet had sales.
 */
function SoFarCard({
  param, isCurrentPeriod, periodLabel,
}: { param: SoFarParam; isCurrentPeriod: boolean; periodLabel: string }) {
  // A closed (past) month is final — no "this month" / "so far" wording there.
  const value = isCurrentPeriod
    ? formatKpiSoFar(param.achieved, param.unit)
    : param.achieved === null || !Number.isFinite(param.achieved) ? '—' : formatKpiAmount(param.achieved, param.unit);
  return (
    <div
      className="bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm"
      data-testid={`kpi-no-target-${param.id}`}
    >
      <div className="p-4 flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900 leading-tight">{param.label}</p>
          <p className="text-[10px] text-gray-500 mt-0.5">
            {isCurrentPeriod ? 'No target this month' : `No target for ${periodLabel}`}
          </p>
        </div>
        <span className="text-sm font-semibold text-gray-500 shrink-0">
          {value}
        </span>
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
  const clientName = useClientConfig().branding.displayName;
  const periodOptions = useMemo(() => getPeriodOptions(), []);
  const [period,  setPeriod]  = useState(currentPeriodValue);
  const [loading, setLoading] = useState(true);
  const [data,    setData]    = useState<TargetsResponse | null>(null);
  // partnerDashboardV2 (Bajaj, tenant-scoped) — the SAME DB-backed flag the dashboard reads, from the
  // same authenticated /partner/me features (normalized). It gates the target-less "so far" cards and
  // the targeted-outlets-only multi-outlet aggregation; OFF (Deoleo) → today's page. The page waits for
  // it (spinner) so a v2 tenant never flashes the flag-OFF layout first.
  const { features, loading: featuresLoading } = useTenantFeatures('/api/partner/me');
  const v2 = features.partnerDashboardV2;

  /* Fetch on period change */
  useEffect(() => {
    setLoading(true);
    setData(null);
    const controller = new AbortController();

    fetch(`/api/partner/targets?period=${period}`, {
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
  const { params, soFarParams, achievementMap, tableCols } = useMemo((): {
    params: DisplayParam[];
    soFarParams: SoFarParam[];
    achievementMap: Record<string, number>;
    tableCols: TableCol[];
  } => {
    if (!data || data.outlets.length === 0) return { params: [], soFarParams: [], achievementMap: {}, tableCols: [] };

    // Collect the union of all KPI codes across all outlets
    const kpiCodeSet = new Set<string>();
    for (const outlet of data.outlets) {
      for (const k of outlet.kpis) kpiCodeSet.add(k.code);
    }

    // Build per-KPI aggregate sums (target sum, achieved sum)
    const targetSum:   Record<string, number>  = {};
    const achievedSum: Record<string, number>  = {};
    // Display name per KPI code. The override name is per-outlet, but the param
    // cards aggregate across outlets — take the FIRST non-empty backend `name`
    // seen for the code (custom name if set, else the KPI's generic label).
    const nameByCode:  Record<string, string>  = {};
    // Real primary flag + unit from the backend (KpiDef). Aggregate across outlets:
    // OR the primary flag, take the first non-empty unit. This matches the dashboard
    // hero (find(isPrimary) ?? first), so the two partner screens never disagree on
    // which KPI is primary (the old code guessed "first by position").
    const primaryByCode: Record<string, boolean> = {};
    const unitByCode:    Record<string, string>  = {};
    // At least one outlet reported a non-null achieved — false = no sales data yet ("—" on a no-target card).
    const hasAchieved:   Record<string, boolean> = {};
    const kpiCodes = [...kpiCodeSet];

    // partnerDashboardV2 ONLY — a partner can own several outlets. A KPI's scored figure (target AND
    // achieved) counts ONLY the outlets where that KPI has a target (> 0): sales at an outlet WITHOUT
    // that target must not inflate the % (owner 2026-11-15). Those sales are kept apart in
    // `untargetedSum` and shown as a neutral "+₹2K so far at outlets without this target" line.
    // Flag OFF → the plain target/achieved sums across every outlet, exactly as before.
    const targetedAchieved: Record<string, number> = {};
    const untargetedSum:    Record<string, number> = {};

    for (const outlet of data.outlets) {
      for (const k of outlet.kpis) {
        if (!v2) {
          targetSum[k.code]        = (targetSum[k.code]        ?? 0) + (k.target   ?? 0);
        } else if ((k.target ?? 0) > 0) {
          targetSum[k.code]        = (targetSum[k.code]        ?? 0) + (k.target as number);
          targetedAchieved[k.code] = (targetedAchieved[k.code] ?? 0) + (k.achieved ?? 0);
        } else {
          untargetedSum[k.code]    = (untargetedSum[k.code]    ?? 0) + (k.achieved ?? 0);
        }
        achievedSum[k.code] = (achievedSum[k.code] ?? 0) + (k.achieved ?? 0);
        hasAchieved[k.code] = (hasAchieved[k.code] ?? false) || (k.achieved !== null && k.achieved !== undefined);
        if (!nameByCode[k.code] && k.name) nameByCode[k.code] = k.name;
        primaryByCode[k.code] = (primaryByCode[k.code] ?? false) || (k.isPrimary ?? false);
        if (!unitByCode[k.code] && k.unit) unitByCode[k.code] = k.unit;
      }
    }

    // Custom name if set, else label (from backend); else format the code.
    const labelOf = (code: string) => nameByCode[code]
      ?? code.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    const displayParams: DisplayParam[] = kpiCodes
      .filter(code => (targetSum[code] ?? 0) > 0)  // targeted KPIs → the scored ParamCards
      .map((code) => ({
        id:        code,
        label:     labelOf(code),
        unit:      unitByCode[code] ?? 'cases',
        target:    targetSum[code] ?? 0,
        isPrimary: primaryByCode[code] ?? false, // real flag; primaryParam falls back to first
        ...(v2 ? { untargetedAchieved: untargetedSum[code] ?? 0 } : {}),
      }));

    // Flag OFF → achievement = the plain sum (as before). v2 → scored achievement per targeted KPI =
    // targeted outlets only (drives %, bar, pace, "targets hit").
    const scoredAchieved: Record<string, number> = { ...achievedSum };
    if (v2) for (const p of displayParams) scoredAchieved[p.id] = targetedAchieved[p.id] ?? 0;

    // v2: KPIs with NO target (summed target ≤ 0) → neutral "so far" cards: never scored, never counted
    // in "X/Y targets hit", never the hero's primary (owner 2026-11-15). Flag OFF → hidden, as before.
    const soFar: SoFarParam[] = !v2 ? [] : kpiCodes
      .filter(code => !((targetSum[code] ?? 0) > 0))
      .map((code) => ({
        id:       code,
        label:    labelOf(code),
        unit:     unitByCode[code],
        achieved: hasAchieved[code] ? (achievedSum[code] ?? 0) : null,
      }));

    // Outlet-breakdown table columns = the UNION of KPI codes across ALL outlets (first-seen order),
    // each cell looked up BY CODE. (The header used to come from outlets[0] while each row rendered
    // its own kpis in its own order → misaligned columns whenever outlets differed. All tenants.)
    const cols: TableCol[] = kpiCodes.map((code) => ({
      code,
      // custom name if set, else label (backend `name`), else code — as the header always did
      name: nameByCode[code] ?? code.replace(/_/g, ' '),
    }));

    return { params: displayParams, soFarParams: soFar, achievementMap: scoredAchieved, tableCols: cols };
  }, [data, v2]);

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
  // The current IST month is live ("so far"); any other (past) month is closed/final.
  const isCurrentPeriod = activePeriod === istDateKey(new Date()).slice(0, 7);

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

      {loading || featuresLoading ? (
        <div className="flex items-center justify-center min-h-48"><Spinner size="lg" /></div>
      ) : params.length === 0 && soFarParams.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Target className="h-10 w-10 text-gray-200" />
          <p className="text-sm text-gray-400">No targets configured for {periodLabel}.</p>
          <p className="text-xs text-gray-300">Contact your sales officer for more information.</p>
        </div>
      ) : (
        <>
          {/* Only target-less KPIs this month → no scored hero (there is nothing to be behind on). */}
          {params.length === 0 && (
            <div className="flex items-center gap-2 rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3" data-testid="no-targets-note">
              <Target className="h-4 w-4 text-gray-300 shrink-0" />
              <p className="text-xs text-gray-500">
                No targets set for {periodLabel}. {isCurrentPeriod ? 'Your sales so far are shown below.' : 'Your sales are shown below.'}
              </p>
            </div>
          )}

          {/* Overall score card */}
          {params.length > 0 && (() => {
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
                    ? `All targets achieved! Incentive being verified by ${clientName}.`
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
                isCurrentPeriod={isCurrentPeriod}
              />
            ))}
            {soFarParams.map(param => (
              <SoFarCard key={param.id} param={param} isCurrentPeriod={isCurrentPeriod} periodLabel={periodLabel} />
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
                      {tableCols.map(c => (
                        <th key={c.code} className="py-2 px-2 text-right">
                          {/* custom name if set, else label (backend `name`), else code */}
                          {c.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {data.outlets.map(outlet => (
                      <tr key={outlet.outletCode}>
                        <td className="py-2 pl-4 pr-2 font-medium text-gray-800">{outlet.outletName}</td>
                        <td className="py-2 px-2 text-gray-400">{outlet.outletType}</td>
                        {tableCols.map(c => {
                          // Cell looked up BY CODE under its header; KPI absent at this outlet → "—".
                          const k = outlet.kpis.find(x => x.code === c.code);
                          if (!k) {
                            return (
                              <td key={c.code} className="py-2 px-2 text-right">
                                <span className="text-gray-800 font-mono">—</span>
                              </td>
                            );
                          }
                          const p = k.target && k.target > 0 ? pct(k.achieved ?? 0, k.target) : null;
                          // v2: no target for this outlet → the same neutral formatting as the "so far" cards
                          // (₹2.8K / 2,755.1 cases). Targeted cells, and every cell with the flag OFF, keep
                          // the raw value + (%) as before.
                          const shown = v2 && p === null && k.achieved !== null && k.achieved !== undefined
                            ? formatKpiAmount(k.achieved, k.unit)
                            : (k.achieved ?? '—');
                          return (
                            <td key={c.code} className="py-2 px-2 text-right">
                              <span className="text-gray-800 font-mono">{shown}</span>
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
