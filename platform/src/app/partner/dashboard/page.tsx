'use client';

import React, { useState, useEffect, useContext, createContext } from 'react';
import {
  TrendingUp, Gift, Trophy, Wallet, Target,
  HeadphonesIcon, CheckCircle,
  ChevronRight, X, Megaphone, ArrowRight, Sparkles, ListChecks,
} from 'lucide-react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { AchievementChart, type ChartView } from '@/components/charts/achievement-chart';
import {
  getActiveBannersFromList, saveBanners, savePopups, loadBanners, fetchBanners,
  getBgStyle, toEmbedUrl,
  getActivePopup, shouldShowPopup, markPopupSeen,
  type Banner, type Popup,
} from '@/lib/banner';
import { formatPoints } from '@/lib/utils';
import { buildCasesToGoMsg, classifyPaceGap } from '@/lib/pace';
import { getGifsySettings } from '@/lib/gifsy-settings';
import { usePartnerSession, type OutletType } from '@/lib/partner-session';
import {
  OUTLET_ACHIEVEMENTS, resolveConfig, pct,
  DEMO_BEAT, DEMO_DISTRICT, DEMO_STATE, DEMO_PERIOD,
  getPrimaryParam, currentPeriod, getPrimarySchemeTarget,
  type OutletAchievement,
} from '@/lib/targets';
import type { ApiSchemeTarget } from '@/types';
import { useClientConfig } from '@/lib/platform/client-config-context';
import {
  getPendingSchemes, acceptScheme, formatDeadline,
  hasEnrollmentForm, getEnrollmentFields,
  type Scheme,
} from '@/lib/schemes';
import { applyPrefillValues } from '@/lib/campaign';
import { seedOutletData, getOutletPrefillData } from '@/lib/outlet-data';
import { EnrollmentFormRenderer } from '@/components/partner/enrollment-form-renderer';
import { formatLastUpdated, getLastSalesUploadDate } from '@/lib/sales-upload-utils';

/* ─── Real-data context ──────────────────────────────────────────────────── */

/**
 * Leaderboard pattern for achievements: sub-components start with OUTLET_ACHIEVEMENTS
 * (mock, always present), then the page root silently replaces with real API data.
 */
type AchievementsMap = typeof OUTLET_ACHIEVEMENTS;
const DashboardAchievementsContext = createContext<AchievementsMap>(OUTLET_ACHIEVEMENTS);

function useDashboardAchievements(): AchievementsMap {
  return useContext(DashboardAchievementsContext);
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function computePace() {
  const today      = new Date();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const elapsed    = today.getDate();
  return { timePct: Math.round((elapsed / daysInMonth) * 100), daysLeft: daysInMonth - elapsed };
}

function fmtInr(n: number) {
  return `₹${n.toLocaleString('en-IN')}`;
}

function fmtInrShort(n: number) {
  if (n >= 1_00_000) return `₹${(n / 1_00_000).toFixed(1)}L`;
  if (n >= 1_000)    return `₹${(n / 1_000).toFixed(1)}K`;
  return `₹${n}`;
}


/* ─── Progress bar ────────────────────────────────────────────────────────── */

type KpiStatus = 'MET' | 'ON_TRACK' | 'AT_RISK' | 'FAILED' | 'MISSED';

function ProgressBar({ pct, status }: { pct: number; status: KpiStatus }) {
  const clampedPct = Math.min(pct, 100);
  const barColor =
    status === 'MET'      ? 'bg-emerald-400' :
    status === 'ON_TRACK' ? 'bg-blue-400'    :
    status === 'AT_RISK'  ? 'bg-amber-400'   : 'bg-red-400';

  return (
    <div className="w-full bg-white/20 rounded-full h-2 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${barColor}`}
        style={{ width: `${clampedPct}%` }}
      />
    </div>
  );
}

function ProgressBarLight({ pct, status }: { pct: number; status: string }) {
  const clampedPct = Math.min(pct, 100);
  const barColor =
    status === 'MET'      ? 'bg-emerald-500' :
    status === 'ON_TRACK' ? 'bg-blue-500'    :
    status === 'AT_RISK'  ? 'bg-amber-500'   : 'bg-red-400';
  const trackColor =
    status === 'MET'      ? 'bg-emerald-100' :
    status === 'ON_TRACK' ? 'bg-blue-100'    :
    status === 'AT_RISK'  ? 'bg-amber-100'   : 'bg-red-100';

  return (
    <div className={`w-full ${trackColor} rounded-full h-2 overflow-hidden`}>
      <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${clampedPct}%` }} />
    </div>
  );
}

/* ─── Status chip ─────────────────────────────────────────────────────────── */

function StatusChip({ status }: { status: KpiStatus }) {
  const cfg = {
    MET:      { label: 'Target Met ✓',  cls: 'bg-emerald-400/20 text-emerald-100' },
    ON_TRACK: { label: 'On Track',      cls: 'bg-blue-400/20 text-blue-100'       },
    AT_RISK:  { label: 'At Risk',       cls: 'bg-amber-400/20 text-amber-200'     },
    FAILED:   { label: 'Not Eligible',  cls: 'bg-red-400/20 text-red-200'         },
    MISSED:   { label: 'Missed',        cls: 'bg-red-400/20 text-red-200'         },
  }[status] ?? { label: status, cls: 'bg-white/10 text-white/60' };

  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

/* ─── Shared: Sales vs Target chart section ──────────────────────────────── */

function PerformanceChart({ outletId }: { outletId: string }) {
  const [chartView, setChartView] = useState<ChartView>('monthly');
  const { timePct, daysLeft } = computePace();

  // Resolve real target data — reads from context (updated by API via PartnerDashboard)
  const config      = resolveConfig(DEMO_BEAT, DEMO_DISTRICT, DEMO_STATE, DEMO_PERIOD);
  const achievement = useDashboardAchievements()[outletId];
  const svParam     = config ? getPrimaryParam(config.params) : null;
  const achieved    = svParam ? (achievement?.achievements[svParam.id] ?? 0) : 0;
  const target      = svParam?.target ?? 0;
  const remaining   = Math.max(0, target - achieved);
  const unit        = svParam?.unit ?? 'cases';
  const achievePct  = pct(achieved, target);
  const gap         = timePct - achievePct;

  // Badge colour: green when target met or on-pace; amber/red via configurable threshold
  const paceStatus  = remaining === 0 ? 'green' : classifyPaceGap(gap, timePct, getGifsySettings().paceAmberThreshold ?? 10);
  const badgeClass  = paceStatus === 'green' ? 'bg-emerald-50 text-emerald-700'
                    : paceStatus === 'amber' ? 'bg-amber-50 text-amber-700'
                    : 'bg-red-50 text-red-600';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <TrendingUp className="h-4 w-4 text-[var(--brand-primary)]" />
            Target vs. Achievement
          </CardTitle>
          <div className="flex bg-gray-100 rounded-lg p-0.5 gap-0.5">
            {(['monthly', 'yoy'] as ChartView[]).map(v => (
              <button key={v} onClick={() => setChartView(v)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all ${
                  chartView === v ? 'bg-white text-[var(--brand-primary)] shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}>
                {v === 'monthly' ? 'Monthly' : 'Year on Year'}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-0.5">
          {chartView === 'monthly' ? 'Last 6 months' : 'FY 24–25 vs FY 25–26 · Full year'}
        </p>
      </CardHeader>
      <CardContent className="px-2 pb-2">
        <AchievementChart view={chartView} />
        {chartView === 'monthly' && (
          <div className={`mx-2 mb-1 mt-2 rounded-lg px-3 py-1.5 flex items-center gap-2 text-[10px] font-semibold ${badgeClass}`}>
            <TrendingUp className="h-3 w-3 shrink-0" />
            {buildCasesToGoMsg(remaining, unit, daysLeft)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Quick actions (outlet-specific) ────────────────────────────────────── */

function QuickActions({ outletType }: { outletType: OutletType }) {
  const actions =
    outletType === 'WHOLESALER'
      ? [
          { href: '/partner/rewards', label: 'Redeem Points', icon: Gift,            color: 'var(--brand-primary)' },
          { href: '/partner/targets', label: 'My Targets',    icon: Target,          color: '#1d4ed8' },
          { href: '/partner/support', label: 'Support',       icon: HeadphonesIcon,  color: '#7c3aed' },
        ]
      : [
          { href: '/partner/targets', label: 'My Targets', icon: Target,         color: '#1d4ed8' },
          { href: '/partner/wallet',  label: 'Wallet',     icon: Wallet,         color: 'var(--brand-primary)' },
          { href: '/partner/support', label: 'Support',    icon: HeadphonesIcon, color: '#7c3aed' },
        ];

  return (
    <div className="grid grid-cols-3 gap-2">
      {actions.map(a => (
        <Link key={a.label} href={a.href}
          className="flex flex-col items-center gap-1.5 p-3 bg-white rounded-xl border border-gray-200 hover:border-gray-300 hover:shadow-sm active:scale-95 transition-all text-center">
          <div className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{ backgroundColor: `${a.color}15` }}>
            <a.icon className="h-4 w-4" style={{ color: a.color }} />
          </div>
          <span className="text-[11px] font-medium text-gray-700 leading-tight">{a.label}</span>
        </Link>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   WHOLESALER HERO — current cycle pts earned + available balance
══════════════════════════════════════════════════════════════════════════ */

function WholesalerHero({ session, lastUpdatedLabel }: { session: ReturnType<typeof usePartnerSession>; lastUpdatedLabel?: string }) {
  const { daysLeft, timePct } = computePace();

  // ── Single source of truth: same data as the Targets page ──────────────
  // Reads from context — PartnerDashboard updates context with real API data
  const config      = resolveConfig(DEMO_BEAT, DEMO_DISTRICT, DEMO_STATE, DEMO_PERIOD);
  const achievement = useDashboardAchievements()[session.outletId];
  const svParam     = config ? getPrimaryParam(config.params) : null;
  const achieved    = svParam ? (achievement?.achievements[svParam.id] ?? 0) : 0;
  const target      = svParam?.target ?? 0;
  const achievedPct = pct(achieved, target);
  const remaining   = Math.max(0, target - achieved);
  const label       = svParam?.label ?? 'Monthly Volume';
  const unit        = svParam?.unit  ?? 'cases';

  // ── Pace-gap status (time-correlated) ───────────────────────────────────
  const paceGap = timePct - achievedPct;
  const isMet      = achievedPct >= 100;
  const isCritical = !isMet && (paceGap > 20 || (daysLeft <= 3 && paceGap > 5));
  const isAtRisk   = !isMet && !isCritical && paceGap > 5;

  // Urgency colour for the days-left badge
  const urgencyBadge = isCritical
    ? 'bg-red-400/25 text-red-200'
    : isAtRisk
    ? 'bg-amber-400/25 text-amber-200'
    : 'bg-white/15 text-white/80';

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: 'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-primary-dark) 50%, var(--brand-primary-dark) 100%)' }}>

      {/* ── Zone 1: KPI (entire zone tappable → targets page) ──────────── */}
      <Link href="/partner/targets" className="block px-4 pt-4 pb-4 active:opacity-80 transition-opacity">

        {/* Header row: label + chevron hint */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-xs font-semibold text-white/70">{label}</p>
            {lastUpdatedLabel && (
              <p className="text-[10px] text-white/40 mt-0.5">{lastUpdatedLabel}</p>
            )}
          </div>
          <span className="flex items-center gap-1 text-[10px] font-semibold text-white/50">
            All targets <ChevronRight className="h-3 w-3" />
          </span>
        </div>

        {/* Hero row: achieved (left) + % and days left (right) */}
        <div className="flex items-end justify-between mb-2.5">
          <div>
            <p className="text-3xl font-extrabold text-white leading-none">{achieved} <span className="text-lg font-bold text-white/70">{unit}</span></p>
            <p className="text-[11px] text-white/50 mt-1">of {target} {unit}</p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-extrabold text-white/90 leading-none">{achievedPct}%</p>
            {!isMet && (
              <span className={`inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${urgencyBadge}`}>
                {daysLeft === 0 ? 'Last day' : `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`}
              </span>
            )}
          </div>
        </div>

        <ProgressBar pct={achievedPct} status={isMet ? 'MET' : isCritical ? 'FAILED' : isAtRisk ? 'AT_RISK' : 'ON_TRACK'} />

        {isMet && (
          <p className="text-[11px] text-emerald-300 font-semibold mt-2">Target achieved 🎉</p>
        )}
      </Link>

      {/* ── Zone 2: Wallet ──────────────────────────────────────────────── */}
      <div className="border-t border-white/10 bg-black/25 px-4 py-3 flex items-center justify-between">
        <div>
          <p className="text-[10px] text-white/40 font-medium mb-0.5">Available</p>
          <p className="text-base font-extrabold text-white">
            {formatPoints(session.pointsBalance)}
            <span className="text-sm font-medium text-white/50 ml-1">pts</span>
          </p>
        </div>
        <Link href="/partner/rewards"
          className="flex items-center gap-1.5 px-3 py-1.5 bg-white rounded-lg text-xs font-bold text-[var(--brand-primary)] hover:bg-white/90 active:scale-95 transition-all">
          Redeem <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   WHOLESALER LOWER — rank card
══════════════════════════════════════════════════════════════════════════ */

function WholesalerLower({ session }: { session: ReturnType<typeof usePartnerSession> }) {
  const { features } = useClientConfig();
  const inner = (
    <>
      <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
        <Trophy className="h-4 w-4 text-amber-500" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-gray-500 font-medium">Your Rank This Month</p>
        <p className="text-sm font-bold text-gray-900">
          #{session.leaderboardRank} <span className="text-gray-400 font-normal">of {session.leaderboardTotal} partners</span>
        </p>
      </div>
      <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
    </>
  );
  const cls = 'bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center gap-3';
  return features.partnerApp.showLeaderboard
    ? <Link href="/partner/leaderboard" className={`${cls} hover:border-gray-300 hover:shadow-sm active:scale-95 transition-all`}>{inner}</Link>
    : <div className={cls}>{inner}</div>;
}

/* ══════════════════════════════════════════════════════════════════════════
   RETAILER / SUB-STOCKIST HERO — cycle achievement
══════════════════════════════════════════════════════════════════════════ */

function RetailerHero({ outletId, lastUpdatedLabel }: { outletId: string; lastUpdatedLabel?: string }) {
  const { daysLeft, timePct } = computePace();

  // ── Same data source as targets page (from context) ───────────────────────
  const config      = resolveConfig(DEMO_BEAT, DEMO_DISTRICT, DEMO_STATE, DEMO_PERIOD);
  const achievement = useDashboardAchievements()[outletId];
  const svParam     = config ? getPrimaryParam(config.params) : null;
  const achieved    = svParam ? (achievement?.achievements[svParam.id] ?? 0) : 0;
  const target      = svParam?.target ?? 0;
  const achievedPct = pct(achieved, target);
  const remaining   = Math.max(0, target - achieved);
  const label       = svParam?.label ?? 'Monthly Target';
  const unit        = svParam?.unit  ?? 'cases';

  const paceGap    = timePct - achievedPct;
  const isMet      = achievedPct >= 100;
  const isCritical = !isMet && (paceGap > 20 || (daysLeft <= 3 && paceGap > 5));
  const isAtRisk   = !isMet && !isCritical && paceGap > 5;

  const urgencyBadge = isCritical
    ? 'bg-red-400/25 text-red-200'
    : isAtRisk
    ? 'bg-amber-400/25 text-amber-200'
    : 'bg-white/15 text-white/80';

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: 'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-primary-dark) 50%, var(--brand-primary-dark) 100%)' }}>

      {/* ── Zone 1: KPI (entire zone tappable → targets page) ──────────── */}
      <Link href="/partner/targets" className="block px-4 pt-4 pb-4 active:opacity-80 transition-opacity">

        {/* Header row: label + "All targets ›" */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-xs font-semibold text-white/70">{label}</p>
            {lastUpdatedLabel && (
              <p className="text-[10px] text-white/40 mt-0.5">{lastUpdatedLabel}</p>
            )}
          </div>
          <span className="flex items-center gap-1 text-[10px] font-semibold text-white/50">
            All targets <ChevronRight className="h-3 w-3" />
          </span>
        </div>

        {/* Hero row: achieved (left) + % with urgency badge (right) */}
        <div className="flex items-end justify-between mb-2.5">
          <div>
            <p className="text-3xl font-extrabold text-white leading-none">
              {achieved} <span className="text-lg font-bold text-white/70">{unit}</span>
            </p>
            <p className="text-[11px] text-white/50 mt-1">of {target} {unit}</p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-extrabold text-white/90 leading-none">{achievedPct}%</p>
            {!isMet && (
              <span className={`inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${urgencyBadge}`}>
                {daysLeft === 0 ? 'Last day' : `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`}
              </span>
            )}
          </div>
        </div>

        <ProgressBar pct={achievedPct} status={isMet ? 'MET' : isCritical ? 'FAILED' : isAtRisk ? 'AT_RISK' : 'ON_TRACK'} />

        {isMet ? (
          <p className="text-[11px] text-emerald-300 font-semibold mt-2">Target achieved 🎉</p>
        ) : remaining > 0 ? (
          <p className="text-[11px] text-white/50 mt-2">{remaining} {unit} remaining</p>
        ) : null}
      </Link>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   MT HERO — dual-KPI breakdown
══════════════════════════════════════════════════════════════════════════ */

function MTHero({ outletId, lastUpdatedLabel }: { outletId: string; lastUpdatedLabel?: string }) {
  const { daysLeft, timePct } = computePace();

  // ── Same data source as targets page (from context) ───────────────────────
  const config      = resolveConfig(DEMO_BEAT, DEMO_DISTRICT, DEMO_STATE, DEMO_PERIOD);
  const achievement = useDashboardAchievements()[outletId];
  const params      = config?.params ?? [];

  // Build per-KPI rows from config (same params as targets page)
  const kpiRows = params.map((p) => {
    const achieved    = achievement?.achievements[p.id] ?? 0;
    const achievedPct = pct(achieved, p.target);
    const gap         = timePct - achievedPct;
    const isMet       = achievedPct >= 100;
    const isCritical  = !isMet && (gap > 20 || (daysLeft <= 3 && gap > 5));
    const isAtRisk    = !isMet && !isCritical && gap > 5;
    return { param: p, achieved, achievedPct, isMet, isCritical, isAtRisk };
  });

  const metCount = kpiRows.filter(r => r.isMet).length;
  const allMet   = metCount === kpiRows.length;

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: 'linear-gradient(135deg, #0f766e 0%, #0d9488 50%, #134e4a 100%)' }}>

      {/* ── Zone 1: KPI (entire zone tappable → targets page) ──────────── */}
      <Link href="/partner/targets" className="block px-4 pt-4 pb-4 active:opacity-80 transition-opacity">

        {/* Header row */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-xs font-semibold text-white/70">SSS TOT · KPI Tracker</p>
            {lastUpdatedLabel && (
              <p className="text-[10px] text-white/40 mt-0.5">{lastUpdatedLabel}</p>
            )}
          </div>
          <span className="flex items-center gap-1 text-[10px] font-semibold text-white/50">
            All targets <ChevronRight className="h-3 w-3" />
          </span>
        </div>

        {/* Per-KPI rows — sourced from same config as targets page */}
        <div className="space-y-3">
          {kpiRows.map(({ param, achieved, achievedPct, isMet, isCritical, isAtRisk }) => {
            const badge = isCritical
              ? 'bg-red-400/25 text-red-200'
              : isAtRisk
              ? 'bg-amber-400/25 text-amber-200'
              : isMet ? 'bg-emerald-400/20 text-emerald-200'
              : 'bg-white/15 text-white/80';

            return (
              <div key={param.id} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-white/90">{param.label}</p>
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-bold text-white">{achievedPct}%</p>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badge}`}>
                      {isMet ? '✓ Met' : daysLeft === 0 ? 'Last day' : `${daysLeft}d left`}
                    </span>
                  </div>
                </div>
                <ProgressBar pct={achievedPct} status={isMet ? 'MET' : isCritical ? 'FAILED' : isAtRisk ? 'AT_RISK' : 'ON_TRACK'} />
                <p className="text-[10px] text-white/50">{achieved} of {param.target} {param.unit}</p>
              </div>
            );
          })}
        </div>

        {allMet && (
          <p className="text-[11px] text-emerald-300 font-semibold mt-3">All targets achieved 🎉</p>
        )}
      </Link>

    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   SCHEME ACCEPTANCE
══════════════════════════════════════════════════════════════════════════ */

/* ─── Scheme detail + acceptance bottom sheet ────────────────────────────── */

function SchemeSheet({
  scheme,
  outletId,
  isLoyaltyMember,
  onAccept,
  onClose,
}: {
  scheme: Scheme;
  outletId: string;
  isLoyaltyMember: boolean;
  onAccept: (id: string) => void;
  onClose: () => void;
}) {
  const [agreed,      setAgreed]      = useState(false);
  const [submitting,  setSubmitting]  = useState(false);
  const [success,     setSuccess]     = useState(false);
  const [formValues,  setFormValues]  = useState<Record<string, unknown>>({});
  const [prefillData, setPrefillData] = useState<Record<string, string>>({});

  // Determine if this scheme has an enrollment form
  // (Scheme type doesn't carry enrollmentFormConfig directly — we pull from the
  //  admin-published scheme. For now we check the fields cast via the extended type.)
  const schemeAsAdmin = scheme as unknown as import('@/lib/schemes').AdminPublishedScheme;
  const enrollFields  = getEnrollmentFields(schemeAsAdmin);
  const needsForm     = hasEnrollmentForm(schemeAsAdmin);

  // On mount: seed outlet data, load prefill, compute initial form values
  useEffect(() => {
    seedOutletData();
    const prefill = getOutletPrefillData(outletId);
    setPrefillData(prefill);
    if (enrollFields.length > 0) {
      setFormValues(applyPrefillValues(enrollFields, prefill));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outletId]);

  const handleAccept = async (submittedValues?: Record<string, unknown>) => {
    setSubmitting(true);
    await new Promise((r) => setTimeout(r, 700));
    acceptScheme(scheme.id, outletId);
    onAccept(scheme.id);
    setSubmitting(false);
    setSuccess(true);
    // submittedValues carries form data when the enrollment form is used
    void submittedValues;
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={!success ? onClose : undefined} />
      <div className="relative bg-white rounded-t-2xl max-h-[88vh] flex flex-col shadow-2xl">
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-0 shrink-0">
          <div className="w-10 h-1 bg-gray-200 rounded-full" />
        </div>
        <button onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 bg-gray-100 hover:bg-gray-200 rounded-full flex items-center justify-center transition-colors">
          <X className="h-4 w-4 text-gray-600" />
        </button>

        {success ? (
          /* ── Success state ── */
          <div className="flex flex-col items-center justify-center py-12 px-6 gap-4 text-center">
            <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center">
              <CheckCircle className="h-8 w-8 text-emerald-600" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-gray-900">You're enrolled!</h3>
              <p className="text-sm text-gray-500 mt-1">
                You have successfully joined <span className="font-semibold text-gray-800">{scheme.name}</span>.
              </p>
              <p className="text-xs text-gray-400 mt-1">
                Targets will be visible on your Targets page once the scheme begins on {new Date(scheme.startDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.
              </p>
            </div>
            <button onClick={onClose}
              className="w-full py-3 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-bold hover:bg-[var(--brand-primary-dark)] transition-colors">
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="overflow-y-auto flex-1 px-5 pt-4 pb-2 space-y-5">
              {/* Header */}
              <div className="flex items-start gap-3">
                <div className="w-11 h-11 rounded-2xl bg-emerald-100 flex items-center justify-center shrink-0">
                  <Sparkles className="h-5 w-5 text-emerald-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-400 font-medium">New Activation · {scheme.period}</p>
                  <h2 className="text-base font-bold text-gray-900 leading-snug mt-0.5">{scheme.name}</h2>
                </div>
              </div>

              {/* Description */}
              <p className="text-sm text-gray-600 leading-relaxed">{scheme.description}</p>

              {/* KPIs tracked */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Parameters tracked
                </p>
                <div className="space-y-2">
                  {scheme.kpis.map((kpi, i) => (
                    <div key={i} className="flex items-center gap-2.5 bg-gray-50 rounded-xl px-3 py-2.5">
                      <ListChecks className="h-3.5 w-3.5 text-[var(--brand-primary)] shrink-0" />
                      <p className="text-sm text-gray-800 font-medium">{kpi.label}</p>
                      <span className="ml-auto text-xs text-gray-400">{kpi.unit}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Reward note */}
              <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3">
                <p className="text-xs text-amber-800 font-semibold">About rewards</p>
                <p className="text-xs text-amber-700 mt-0.5 leading-relaxed">
                  Incentive amounts are determined by Deoleo internally and will reflect in your wallet after the cycle ends and achievements are verified.
                </p>
              </div>

              {/* Deadline */}
              <p className="text-xs text-gray-400 text-center">
                Accept by <span className="font-semibold text-gray-600">{formatDeadline(scheme.acceptDeadline)}</span> to participate
              </p>

              {/* ── Enrollment form (when admin has configured fields) ── */}
              {needsForm && (
                <div className="border-t border-gray-100 pt-4">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                    Enrollment Details
                  </p>
                  <EnrollmentFormRenderer
                    fields={enrollFields}
                    isLoyaltyMember={isLoyaltyMember}
                    prefillData={prefillData}
                    values={formValues}
                    onChange={(fieldId, value) =>
                      setFormValues((prev) => ({ ...prev, [fieldId]: value }))
                    }
                    onSubmit={(vals) => handleAccept(vals)}
                    submitLabel="Accept & Enrol"
                  />
                </div>
              )}
            </div>

            {/* Footer — only for simple (no-form) flow */}
            {!needsForm && (
              <div className="px-5 pb-6 pt-3 border-t border-gray-100 space-y-3 shrink-0">
                <label className="flex items-start gap-3 cursor-pointer">
                  <div className="mt-0.5 shrink-0">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded accent-[var(--brand-primary)] cursor-pointer"
                      checked={agreed}
                      onChange={(e) => setAgreed(e.target.checked)}
                    />
                  </div>
                  <p className="text-xs text-gray-600 leading-relaxed">
                    I confirm that I have read the scheme details and agree to participate in{' '}
                    <span className="font-semibold">{scheme.name}</span>.
                  </p>
                </label>

                <button
                  onClick={() => handleAccept()}
                  disabled={!agreed || submitting}
                  className="w-full py-3 rounded-xl text-sm font-bold transition-all
                    disabled:opacity-40 disabled:cursor-not-allowed
                    bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-dark)] active:scale-[0.98]
                    flex items-center justify-center gap-2"
                >
                  {submitting ? (
                    <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  ) : (
                    <CheckCircle className="h-4 w-4" />
                  )}
                  {submitting ? 'Enrolling…' : 'Accept & Enrol'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Scheme acceptance banner (home screen) ─────────────────────────────── */

function SchemeAcceptanceBanner({
  outletType,
  outletId,
  isLoyaltyMember,
}: {
  outletType: string;
  outletId: string;
  isLoyaltyMember: boolean;
}) {
  const [pending,  setPending]  = useState<Scheme[]>([]);
  const [active,   setActive]   = useState<Scheme | null>(null);

  useEffect(() => {
    setPending(getPendingSchemes(outletType, outletId));
  }, [outletType, outletId]);

  const handleAccepted = (id: string) => {
    setPending((prev) => prev.filter((s) => s.id !== id));
  };

  if (pending.length === 0) return null;

  const first = pending[0];

  return (
    <>
      <div
        onClick={() => setActive(first)}
        className="relative overflow-hidden rounded-2xl cursor-pointer active:scale-[0.98] transition-transform"
        style={{ background: 'linear-gradient(135deg, #064e3b 0%, #065f46 50%, #047857 100%)' }}
      >
        {/* Decorative glow */}
        <div className="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-white/5" />
        <div className="absolute -bottom-4 -left-4 w-16 h-16 rounded-full bg-white/5" />

        <div className="relative px-4 py-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center shrink-0">
            <Sparkles className="h-5 w-5 text-emerald-300" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-300">
                New Activation
              </span>
              {pending.length > 1 && (
                <span className="text-[9px] font-bold bg-white/20 text-white px-1.5 py-0.5 rounded-full">
                  +{pending.length - 1} more
                </span>
              )}
            </div>
            <p className="text-sm font-bold text-white leading-tight truncate">{first.name}</p>
            <p className="text-[11px] text-white/60 mt-0.5">
              {first.period} · Accept by {formatDeadline(first.acceptDeadline)}
            </p>
          </div>

          <div className="flex items-center gap-1.5 shrink-0 bg-white text-[#065f46] text-xs font-bold px-3 py-1.5 rounded-lg">
            View <ChevronRight className="h-3 w-3" />
          </div>
        </div>
      </div>

      {active && (
        <SchemeSheet
          scheme={active}
          outletId={outletId}
          isLoyaltyMember={isLoyaltyMember}
          onAccept={handleAccepted}
          onClose={() => setActive(null)}
        />
      )}
    </>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   PAGE
══════════════════════════════════════════════════════════════════════════ */

export default function PartnerDashboard() {
  const session = usePartnerSession();
  const [loading,           setLoading]           = useState(true);
  const [banners,           setBanners]           = useState<Banner[]>([]);
  const [bannerIndex,       setBannerIndex]       = useState(0);
  const [popup,             setPopup]             = useState<Popup | null>(null);
  const [lastUpdatedLabel,  setLastUpdatedLabel]  = useState<string>('');
  // Achievements state — starts with mock data, silently updated by API (leaderboard pattern)
  const [achievements, setAchievements]           = useState<AchievementsMap>(OUTLET_ACHIEVEMENTS);

  // Touch / swipe state
  const touchStartX = React.useRef<number | null>(null);

  useEffect(() => {
    // Fetch banners + popups from the server (admin writes to DB; we sync to
    // localStorage first so the existing active/schedule filter logic reuses them).
    fetchBanners().then(({ banners: b, popups: p }) => {
      saveBanners(b);
      savePopups(p);
      setBanners(getActiveBannersFromList(b));
      const activePopup = getActivePopup();
      if (activePopup && shouldShowPopup(activePopup)) setPopup(activePopup);
    }).catch(() => {
      // Network error or DEMO_MODE — fall back to whatever is in localStorage
      setBanners(getActiveBannersFromList(loadBanners()));
      const activePopup = getActivePopup();
      if (activePopup && shouldShowPopup(activePopup)) setPopup(activePopup);
    });
    const t = setTimeout(() => setLoading(false), 400);

    // Read last sales-data upload date from localStorage (set by admin on each upload)
    const storedDate = getLastSalesUploadDate();
    if (storedDate) setLastUpdatedLabel(formatLastUpdated(storedDate));

    return () => clearTimeout(t);
  }, []);

  // API hydration — leaderboard pattern: mock shown first, API updates silently
  useEffect(() => {
    const period = currentPeriod();
    fetch(`/api/partner/targets?period=${period}`)
      .then(r => r.json())
      .then((json: { success: boolean; data?: { targets: ApiSchemeTarget[] } }) => {
        if (json.success && json.data?.targets && json.data.targets.length > 0) {
          const primary = getPrimarySchemeTarget(json.data.targets);
          if (!primary) return;
          setAchievements(prev => {
            const existing = prev[session.outletId];
            const next: OutletAchievement = existing
              ? { ...existing, achievements: { ...existing.achievements, p_sv: primary.achievedValue } }
              : { outletId: session.outletId, period, achievements: { p_sv: primary.achievedValue, p_fp1: 0, p_fp2: 0, p_fc: 0, p_ln: 0 } };
            return { ...prev, [session.outletId]: next };
          });
        }
      })
      .catch(() => {}); // silent — mock data already shown
  }, [session.outletId]);

  // Auto-advance carousel every 5 s when multiple banners exist
  useEffect(() => {
    if (banners.length <= 1) return;
    const id = setInterval(() => {
      setBannerIndex((i) => (i + 1) % banners.length);
    }, 5000);
    return () => clearInterval(id);
  }, [banners.length]);

  const handleBannerTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };
  const handleBannerTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 40) return; // too small — ignore
    setBannerIndex((i) =>
      dx < 0
        ? (i + 1) % banners.length                       // swipe left → next
        : (i - 1 + banners.length) % banners.length,     // swipe right → prev
    );
  };

  const banner = banners[bannerIndex] ?? null;

  if (loading) {
    return <div className="flex items-center justify-center min-h-64"><Spinner size="lg" /></div>;
  }

  const isMT         = session.outletType === 'SSS_TOT';
  const isWholesaler = session.outletType === 'WHOLESALER';

  return (
    <DashboardAchievementsContext.Provider value={achievements}>

    <div className="space-y-4 fade-in">

      {/* ── Admin announcement carousel (stays at top) ── */}
      {banners.length > 0 && banner && (
        <div
          onTouchStart={handleBannerTouchStart}
          onTouchEnd={handleBannerTouchEnd}
          className="select-none"
        >
          {banner.type === 'video' && banner.videoUrl ? (
            <div className="rounded-2xl overflow-hidden aspect-video bg-black w-full">
              <iframe src={toEmbedUrl(banner.videoUrl)} className="w-full h-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope" allowFullScreen />
            </div>
          ) : (
            <div className="relative overflow-hidden rounded-2xl text-white" style={getBgStyle(banner.bgColor)}>
              {/* Top shimmer */}
              <div className="absolute top-0 left-0 right-0 h-px pointer-events-none"
                style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.40), transparent)' }} />
              {/* Watermark icon */}
              <Megaphone className="absolute -right-3 -top-2 h-24 w-24 text-white/[0.07] pointer-events-none rotate-[-12deg]" />

              <div className="relative px-4 py-4 space-y-2">
                {/* Category label + dot indicators */}
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <Megaphone className="h-3 w-3 text-white/50 shrink-0" />
                    <span className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-white/55">
                      Announcement
                    </span>
                  </div>
                  {banners.length > 1 && (
                    <div className="flex items-center gap-1">
                      {banners.map((_, i) => (
                        <button
                          key={i}
                          onClick={() => setBannerIndex(i)}
                          aria-label={`Go to announcement ${i + 1}`}
                          className={`rounded-full transition-all ${
                            i === bannerIndex
                              ? 'w-4 h-1.5 bg-white'
                              : 'w-1.5 h-1.5 bg-white/40 hover:bg-white/60'
                          }`}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {banner.title && (
                  <p className="text-[14px] font-bold text-white leading-snug">{banner.title}</p>
                )}
                {banner.body && (
                  <p className="text-[12px] text-white/70 leading-relaxed">{banner.body}</p>
                )}
                {banner.ctaLabel && (
                  <a
                    href={banner.ctaUrl || '#'}
                    target={banner.ctaUrl ? '_blank' : undefined}
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 !mt-3 text-[12px] font-semibold bg-white text-gray-900 rounded-full px-4 py-1.5 hover:bg-white/90 active:scale-[0.97] transition-all shadow-sm"
                  >
                    {banner.ctaLabel}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 1. CURRENT CYCLE KPI HERO (outlet-specific) ── */}
      {isWholesaler && <WholesalerHero session={session} lastUpdatedLabel={lastUpdatedLabel} />}
      {isMT         && <MTHero outletId={session.outletId} lastUpdatedLabel={lastUpdatedLabel} />}
      {!isWholesaler && !isMT && <RetailerHero outletId={session.outletId} lastUpdatedLabel={lastUpdatedLabel} />}

      {/* ── 1b. SCHEME ACCEPTANCE BANNER (non-MT only) ── */}
      {!isMT && (
        <SchemeAcceptanceBanner
          outletType={session.outletType}
          outletId={session.outletId}
          isLoyaltyMember={session.outletType !== 'WHOLESALER'}
        />
      )}

      {/* ── 2. SALES vs TARGET CHART ── */}
      <PerformanceChart outletId={session.outletId} />

      {/* ── 4. WHOLESALER LOWER: rank + bonus offer ── */}
      {isWholesaler && <WholesalerLower session={session} />}

      {/* ── 5. QUICK ACTIONS ── */}
      <QuickActions outletType={session.outletType} />

      {/* ── POPUP ── */}
      {popup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="relative w-full max-w-sm bg-white rounded-2xl overflow-hidden shadow-2xl">
            <button onClick={() => { markPopupSeen(popup.id); setPopup(null); }}
              className="absolute top-3 right-3 z-10 w-8 h-8 bg-black/30 hover:bg-black/50 rounded-full flex items-center justify-center text-white transition-colors">
              <X className="h-4 w-4" />
            </button>
            {popup.type === 'video' && popup.videoUrl ? (
              <div className="aspect-video bg-black">
                <iframe src={toEmbedUrl(popup.videoUrl)} className="w-full h-full" allowFullScreen />
              </div>
            ) : popup.type === 'image' && popup.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={popup.imageUrl} alt="Promotional poster" className="w-full object-cover" />
            ) : (
              <div className="p-6 text-white" style={getBgStyle(popup.bgColor)}>
                {popup.title && <p className="text-lg font-bold leading-snug">{popup.title}</p>}
                {popup.body  && <p className="text-sm text-white/85 mt-2 leading-relaxed">{popup.body}</p>}
              </div>
            )}
            <div className="p-4 flex flex-col gap-2">
              {popup.ctaLabel && (
                <a href={popup.ctaUrl || '#'} target={popup.ctaUrl ? '_blank' : undefined}
                  rel="noopener noreferrer"
                  onClick={() => { markPopupSeen(popup.id); setPopup(null); }}
                  className="block w-full py-2.5 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold text-center hover:bg-[var(--brand-primary-dark)] transition-colors">
                  {popup.ctaLabel}
                </a>
              )}
              <button onClick={() => { markPopupSeen(popup.id); setPopup(null); }}
                className="w-full py-2 text-xs text-gray-400 hover:text-gray-600 transition-colors">
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </DashboardAchievementsContext.Provider>
  );
}
