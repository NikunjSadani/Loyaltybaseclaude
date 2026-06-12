'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Target, TrendingUp, Calendar, Award, AlertTriangle, AlertCircle, CheckCircle } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import {
  type GeoTargetConfig,
  PERIODS, PARAM_TYPE_LABELS,
  resolveConfig, OUTLET_ACHIEVEMENTS,
  pct, pctColor, pctBg, pctBarColor,
  DEMO_BEAT, DEMO_DISTRICT, DEMO_STATE,
  getPrimaryParam,
} from '@/lib/targets';
import { usePartnerSession } from '@/lib/partner-session';
import { getGifsySettings } from '@/lib/gifsy-settings';

/* NOTE: Reward points / INR amounts are NOT shown here.
   The incentive for each KPI is decided by Deoleo internally and only
   becomes visible after the admin uploads the confirmed payout to the ledger.
   Outlets see the reward in their wallet/payout history, not on this screen. */

/* ─── Pace helper ───────────────────────────────────────────────────────────────── */

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

/* ─── Progress bar ───────────────────────────────────────────────────────────── */

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pctFill = Math.min((value / max) * 100, 100);
  return (
    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pctFill}%` }} />
    </div>
  );
}

/* ─── Parameter card (mobile) ────────────────────────────────────────────────── */

function ParamCard({
  param, achieved, timePct, daysLeft,
}: {
  param: { id: string; label: string; unit: string; target: number };
  achieved: number;
  timePct: number;
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

  /* Human-readable pace message — no % math, unit-specific */
  /* Singularise unit when remaining === 1 (e.g. "1 SKU" not "1 SKUs") */
  const unitLabel = remaining === 1 ? param.unit.replace(/s$/i, '') : param.unit;
  const paceMsg   = isOnPace
    ? `On track · ${daysLeft} ${dayWord} left`
    : `${remaining} ${unitLabel} to go · ${daysLeft} ${dayWord} left`;
  const threshold = getGifsySettings().paceAmberThreshold ?? 10;
  const nearDone  = remaining / param.target <= threshold / 100;  // ≤threshold% of target still to go
  const paceBg    = isOnPace ? 'bg-emerald-50 text-emerald-700' : nearDone ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-600';
  const stripCol  = isAchieved ? 'bg-emerald-400' : isOnPace ? 'bg-emerald-400' : nearDone ? 'bg-amber-400' : 'bg-red-400';

  return (
    <div className={`bg-white rounded-2xl border overflow-hidden shadow-sm ${isAchieved ? 'border-emerald-200' : 'border-gray-100'}`}>
      {/* Status strip at top */}
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

        {/* Pace message — shown when target not yet hit */}
        {!isAchieved && (
          <div className={`flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-lg ${paceBg}`}>
            <TrendingUp className="h-3 w-3 shrink-0" />
            {paceMsg}
          </div>
        )}

        {isAchieved && (
          <div className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
            <Award className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
            <span className="text-xs text-emerald-700 font-semibold">Target achieved! 🎉 Incentive being verified by Deoleo.</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function PartnerTargetsPage() {
  const session = usePartnerSession();
  const [period,  setPeriod]  = useState('2026-05');
  const [loading, setLoading] = useState(true);
  const [config,  setConfig]  = useState<GeoTargetConfig | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setConfig(resolveConfig(DEMO_BEAT, DEMO_DISTRICT, DEMO_STATE, period));
      setLoading(false);
    }, 350);
    return () => clearTimeout(t);
  }, []);

  // Reload when period changes
  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => {
      setConfig(resolveConfig(DEMO_BEAT, DEMO_DISTRICT, DEMO_STATE, period));
      setLoading(false);
    }, 250);
    return () => clearTimeout(t);
  }, [period]);

  const achievement = OUTLET_ACHIEVEMENTS[session.outletId];

  const pace = useMemo(() => computePace(period), [period]);

  const overallPct = useMemo(() => {
    if (!config || !achievement) return 0;
    const pcts = config.params.map((p) => pct(achievement.achievements[p.id] ?? 0, p.target));
    return Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
  }, [config, achievement]);

  /* Primary KPI % — whichever param the admin has marked isPrimary (falls back to first) */
  const primaryParam = useMemo(() => config ? getPrimaryParam(config.params) : null, [config]);

  const monthlyTargetPct = useMemo(() => {
    if (!primaryParam || !achievement) return overallPct;
    return pct(achievement.achievements[primaryParam.id] ?? 0, primaryParam.target);
  }, [primaryParam, achievement, overallPct]);

  const unlockedCount = useMemo(() => {
    if (!config || !achievement) return 0;
    return config.params
      .filter((p) => pct(achievement.achievements[p.id] ?? 0, p.target) >= 100).length;
  }, [config, achievement]);

  const monthlyPeriods = PERIODS.filter((p) => !p.value.includes('Q'));
  const periodLabel    = PERIODS.find((p) => p.value === period)?.label ?? period;

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
            onChange={(e) => setPeriod(e.target.value)}
            className="appearance-none text-[11px] font-semibold border border-gray-200 rounded-full pl-2.5 pr-6 py-1.5 bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] cursor-pointer"
          >
            {monthlyPeriods.map((p) => (
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
      ) : !config ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Target className="h-10 w-10 text-gray-200" />
          <p className="text-sm text-gray-400">No targets configured for this period.</p>
          <p className="text-xs text-gray-300">Contact your sales officer for more information.</p>
        </div>
      ) : (
        <>
          {/* Overall score card — state-aware */}
          {(() => {
            const notHit   = config.params.length - unlockedCount;
            const daysLeft = pace?.daysLeft ?? 0;
            const dWord    = daysLeft === 1 ? 'day' : 'days';

            // Pace-gap state: compares achievement % to time elapsed %
            // so the threshold tightens automatically as the month progresses.
            //   gap  ≤ 5  → on pace   (PARTIAL — blue)
            //   gap   5–20 → behind    (WARN    — amber)
            //   gap  > 20  → critical  (CRITICAL — red)
            // Override: daysLeft ≤ 3 with any gap > 5 also triggers CRITICAL.
            const timePct   = pace?.timePct ?? 100;
            const paceGap   = timePct - monthlyTargetPct;   // +ve = behind, –ve = ahead
            const cardState: 'ALL_MET' | 'PARTIAL' | 'WARN' | 'CRITICAL' =
              unlockedCount === config.params.length        ? 'ALL_MET'  :
              paceGap > 20 || (daysLeft <= 3 && paceGap > 5) ? 'CRITICAL' :
              paceGap > 5                                   ? 'WARN'     :
                                                              'PARTIAL';

            const STATE_CFG = {
              ALL_MET:  {
                bg:     'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-primary-dark) 100%)',
                Icon:   CheckCircle,
                chip:   { bg: 'bg-emerald-400/30', text: 'text-white',        label: 'All Done 🎉' },
                strip:  'bg-white/20 text-white',
                stripIcon: CheckCircle,
              },
              PARTIAL:  {
                bg:     'linear-gradient(135deg, #1d4ed8 0%, #1e3a8a 100%)',
                Icon:   TrendingUp,
                chip:   { bg: 'bg-blue-400/30',    text: 'text-blue-100',     label: 'In Progress' },
                strip:  'bg-white/15 text-white',
                stripIcon: TrendingUp,
              },
              WARN:     {
                bg:     'linear-gradient(135deg, #b45309 0%, #78350f 100%)',
                Icon:   AlertTriangle,
                chip:   { bg: 'bg-amber-400/30',   text: 'text-amber-100',    label: 'Needs Push' },
                strip:  'bg-amber-400/25 text-amber-100',
                stripIcon: AlertTriangle,
              },
              CRITICAL: {
                bg:     'linear-gradient(135deg, #dc2626 0%, #7f1d1d 100%)',
                Icon:   AlertCircle,
                chip:   { bg: 'bg-red-400/30',     text: 'text-red-100',      label: 'Urgent' },
                strip:  'bg-white text-red-700',
                stripIcon: AlertCircle,
              },
            };

            const cfg  = STATE_CFG[cardState];
            const Icon = cfg.Icon;
            const StripIcon = cfg.stripIcon;

            return (
              <div className="rounded-2xl overflow-hidden text-white" style={{ background: cfg.bg }}>
                {/* Header row */}
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

                {/* Hero: targets hit count (primary) + avg % (secondary) */}
                <div className="px-5 pt-4 pb-4 flex items-end justify-between gap-4">
                  <div>
                    <p className="text-5xl font-extrabold leading-none tracking-tight">
                      {unlockedCount}<span className="text-2xl font-bold text-white/50">/{config.params.length}</span>
                    </p>
                    <p className="text-white/60 text-xs mt-1.5 font-medium">targets hit this month</p>
                  </div>
                  <div className="text-right pb-1">
                    <p className="text-2xl font-extrabold text-white/90">{monthlyTargetPct}%</p>
                    <p className="text-white/50 text-[10px] mt-0.5">{primaryParam?.label ?? 'primary target'}</p>
                  </div>
                </div>


                {/* Bottom action strip */}
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
            {config.params.map((param) => (
              <ParamCard
                key={param.id}
                param={param}
                achieved={achievement?.achievements[param.id] ?? 0}
                timePct={pace?.timePct ?? 100}
                daysLeft={pace?.daysLeft ?? 0}
              />
            ))}
          </div>

          {/* Footer note */}
          <p className="text-[10px] text-gray-400 text-center pb-2">
            Data synced as of today · {periodLabel}
          </p>
        </>
      )}
    </div>
  );
}
