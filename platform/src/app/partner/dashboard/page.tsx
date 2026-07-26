'use client';

import React, { useState, useEffect } from 'react';
import {
  TrendingUp, Gift, Wallet, Target,
  HeadphonesIcon,
  ChevronRight, X, Megaphone, ArrowRight, Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { AchievementChart, type ChartView } from '@/components/charts/achievement-chart';
import { buildChartSeries, type TrendPoint } from '@/lib/target-trend';
import {
  getActiveBannersFromList, saveBanners, savePopups, loadBanners, fetchBanners,
  getBgStyle, toEmbedUrl,
  getActivePopup, shouldShowPopup, markPopupSeen,
  type Banner, type Popup,
} from '@/lib/banner';
import { formatPoints } from '@/lib/utils';
import { buildCasesToGoMsg, classifyPaceGap } from '@/lib/pace';
import { getGifsySettings } from '@/lib/gifsy-settings';
import type { OutletType } from '@/lib/partner-session';
import { pct, currentPeriod } from '@/lib/targets';
import { loadPortalSchemes, statusOf } from '@/app/partner/schemes/portal-api';
import { formatLastUpdated, getLastSalesUploadDate } from '@/lib/sales-upload-utils';
import { authHeader } from '@/lib/api-client';

/* ─── Real-data model ────────────────────────────────────────────────────────
   The dashboard hero consumes the SAME endpoints as the Targets page
   (GET /api/partner/targets) and the wallet (GET /api/auth/me). No demo data.
─────────────────────────────────────────────────────────────────────────────── */

/** A KPI row from GET /api/partner/targets (per outlet). */
interface ApiKpi {
  code:      string;
  name:      string;
  target:    number | null;
  achieved:  number | null;
  pace:      number | null;
  unit:      string;
  isPrimary: boolean;
}

interface ApiOutlet {
  outletCode: string;
  outletName: string;
  outletType: string;
  kpis:       ApiKpi[];
}

interface ApiTargetsResponse {
  period:  string | null;
  outlets: ApiOutlet[];
}

/** Aggregated KPI across ALL of the partner's outlets (target/achieved summed). */
interface AggKpi {
  code:      string;
  name:      string;
  unit:      string;
  isPrimary: boolean;
  target:    number;
  achieved:  number;
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function computePace() {
  const today      = new Date();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const elapsed    = today.getDate();
  return { timePct: Math.round((elapsed / daysInMonth) * 100), daysLeft: daysInMonth - elapsed };
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

/* ─── Shared: Sales vs Target chart section ──────────────────────────────── */

interface TrendResponse { kpiName: string | null; unit: string | null; trend: TrendPoint[]; }

function PerformanceChart({ primary }: { primary: AggKpi | null }) {
  const [chartView, setChartView] = useState<ChartView>('monthly');
  const [trend, setTrend]         = useState<TrendResponse | null>(null);
  const { timePct, daysLeft } = computePace();

  // Real primary-KPI target-vs-achieved history (was hardcoded ₹-lakh mock).
  // Trend the SAME KPI the hero headline resolved (passed as ?kpi=) so the chart
  // and the hero number never disagree; refetch once the hero's primary loads.
  const primaryCode = primary?.code;
  useEffect(() => {
    let cancelled = false;
    const kpiParam = primaryCode ? `&kpi=${encodeURIComponent(primaryCode)}` : '';
    fetch(`/api/partner/targets/trend?months=24${kpiParam}`, { headers: { ...authHeader() } })
      .then(r => r.json())
      .then((json: { success: boolean; data?: TrendResponse }) => {
        if (!cancelled && json.success && json.data) setTrend(json.data);
      })
      .catch(() => {}); // honest empty state — the chart shows "No target data yet"
    return () => { cancelled = true; };
  }, [primaryCode]);

  const series    = buildChartSeries(trend?.trend ?? []);
  const chartUnit = trend?.unit ?? primary?.unit ?? '';

  // Cases-to-go badge derived from the REAL primary KPI (achieved/target/unit).
  const achieved    = primary?.achieved ?? 0;
  const target      = primary?.target   ?? 0;
  const remaining   = Math.max(0, target - achieved);
  const unit        = primary?.unit ?? 'cases';
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
        <AchievementChart
          view={chartView}
          unit={chartUnit}
          monthly={series.monthly}
          yoy={series.yoy}
          yoyLabels={series.yoyLabels}
        />
        {chartView === 'monthly' && primary && (
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

/* ─── Shared single-KPI computation (pace-gap status from real data) ──────── */

function kpiView(primary: AggKpi | null, daysLeft: number, timePct: number) {
  const achieved    = primary?.achieved ?? 0;
  const target      = primary?.target   ?? 0;
  const achievedPct = pct(achieved, target);
  const remaining   = Math.max(0, target - achieved);
  const unit        = primary?.unit ?? 'cases';

  const paceGap    = timePct - achievedPct;
  const isMet      = target > 0 && achievedPct >= 100;
  const isCritical = !isMet && (paceGap > 20 || (daysLeft <= 3 && paceGap > 5));
  const isAtRisk   = !isMet && !isCritical && paceGap > 5;

  const urgencyBadge = isCritical
    ? 'bg-red-400/25 text-red-200'
    : isAtRisk
    ? 'bg-amber-400/25 text-amber-200'
    : 'bg-white/15 text-white/80';

  const status: KpiStatus = isMet ? 'MET' : isCritical ? 'FAILED' : isAtRisk ? 'AT_RISK' : 'ON_TRACK';

  return { achieved, target, achievedPct, remaining, unit, isMet, urgencyBadge, status };
}

/* ══════════════════════════════════════════════════════════════════════════
   WHOLESALER HERO — primary KPI + real wallet balance
══════════════════════════════════════════════════════════════════════════ */

function WholesalerHero({
  primary, walletPoints, lastUpdatedLabel,
}: { primary: AggKpi | null; walletPoints: number | null; lastUpdatedLabel?: string }) {
  const { daysLeft, timePct } = computePace();
  const v = kpiView(primary, daysLeft, timePct);
  const label = primary?.name ?? 'Monthly Volume';

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
            <p className="text-3xl font-extrabold text-white leading-none">{v.achieved} <span className="text-lg font-bold text-white/70">{v.unit}</span></p>
            <p className="text-[11px] text-white/50 mt-1">of {v.target} {v.unit}</p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-extrabold text-white/90 leading-none">{v.achievedPct}%</p>
            {!v.isMet && (
              <span className={`inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${v.urgencyBadge}`}>
                {daysLeft === 0 ? 'Last day' : `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`}
              </span>
            )}
          </div>
        </div>

        <ProgressBar pct={v.achievedPct} status={v.status} />

        {v.isMet ? (
          <p className="text-[11px] text-emerald-300 font-semibold mt-2">Target achieved 🎉</p>
        ) : v.target === 0 ? (
          <p className="text-[11px] text-white/40 mt-2">No targets yet</p>
        ) : null}
      </Link>

      {/* ── Zone 2: Wallet ──────────────────────────────────────────────── */}
      <div className="border-t border-white/10 bg-black/25 px-4 py-3 flex items-center justify-between">
        <div>
          <p className="text-[10px] text-white/40 font-medium mb-0.5">Available</p>
          <p className="text-base font-extrabold text-white">
            {walletPoints === null ? '—' : formatPoints(walletPoints)}
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
   SSS / SUB-STOCKIST HERO — primary KPI (no wallet zone)
══════════════════════════════════════════════════════════════════════════ */

function RetailerHero({
  primary, lastUpdatedLabel,
}: { primary: AggKpi | null; lastUpdatedLabel?: string }) {
  const { daysLeft, timePct } = computePace();
  const v = kpiView(primary, daysLeft, timePct);
  const label = primary?.name ?? 'Monthly Target';

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
              {v.achieved} <span className="text-lg font-bold text-white/70">{v.unit}</span>
            </p>
            <p className="text-[11px] text-white/50 mt-1">of {v.target} {v.unit}</p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-extrabold text-white/90 leading-none">{v.achievedPct}%</p>
            {!v.isMet && (
              <span className={`inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${v.urgencyBadge}`}>
                {daysLeft === 0 ? 'Last day' : `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`}
              </span>
            )}
          </div>
        </div>

        <ProgressBar pct={v.achievedPct} status={v.status} />

        {v.isMet ? (
          <p className="text-[11px] text-emerald-300 font-semibold mt-2">Target achieved 🎉</p>
        ) : v.target === 0 ? (
          <p className="text-[11px] text-white/40 mt-2">No targets yet</p>
        ) : v.remaining > 0 ? (
          <p className="text-[11px] text-white/50 mt-2">{v.remaining} {v.unit} remaining</p>
        ) : null}
      </Link>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   MT HERO (SSS_TOT) — multi-KPI breakdown across all aggregated KPIs
══════════════════════════════════════════════════════════════════════════ */

function MTHero({
  aggKpis, lastUpdatedLabel,
}: { aggKpis: AggKpi[]; lastUpdatedLabel?: string }) {
  const { daysLeft, timePct } = computePace();

  const kpiRows = aggKpis.map((k) => {
    const achievedPct = pct(k.achieved, k.target);
    const gap         = timePct - achievedPct;
    const isMet       = k.target > 0 && achievedPct >= 100;
    const isCritical  = !isMet && (gap > 20 || (daysLeft <= 3 && gap > 5));
    const isAtRisk    = !isMet && !isCritical && gap > 5;
    return { kpi: k, achievedPct, isMet, isCritical, isAtRisk };
  });

  const metCount = kpiRows.filter(r => r.isMet).length;
  const allMet   = kpiRows.length > 0 && metCount === kpiRows.length;

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

        {/* Per-KPI rows — sourced from the same aggregated API data */}
        {kpiRows.length === 0 ? (
          <p className="text-sm font-semibold text-white/70">No targets yet</p>
        ) : (
          <div className="space-y-3">
            {kpiRows.map(({ kpi, achievedPct, isMet, isCritical, isAtRisk }) => {
              const badge = isCritical
                ? 'bg-red-400/25 text-red-200'
                : isAtRisk
                ? 'bg-amber-400/25 text-amber-200'
                : isMet ? 'bg-emerald-400/20 text-emerald-200'
                : 'bg-white/15 text-white/80';
              const status: KpiStatus = isMet ? 'MET' : isCritical ? 'FAILED' : isAtRisk ? 'AT_RISK' : 'ON_TRACK';

              return (
                <div key={kpi.code} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-white/90">{kpi.name}</p>
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-bold text-white">{achievedPct}%</p>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badge}`}>
                        {isMet ? '✓ Met' : daysLeft === 0 ? 'Last day' : `${daysLeft}d left`}
                      </span>
                    </div>
                  </div>
                  <ProgressBar pct={achievedPct} status={status} />
                  <p className="text-[10px] text-white/50">{kpi.achieved} of {kpi.target} {kpi.unit}</p>
                </div>
              );
            })}
          </div>
        )}

        {allMet && (
          <p className="text-[11px] text-emerald-300 font-semibold mt-3">All targets achieved 🎉</p>
        )}
      </Link>

    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   ACTIVATIONS (SCHEMES) — dashboard entry card
   Replaces the old single-scheme acceptance banner + bottom-sheet. The full
   list + form-rendering self-enrol flow now lives at /partner/schemes (D27);
   this card is just the home-screen entry point, shown for EVERY outlet type
   (the MT/SSS_TOT exclusion is removed — D22). It surfaces the count of eligible
   activations this outlet has NOT yet enrolled in.
══════════════════════════════════════════════════════════════════════════ */

function SchemesCard() {
  const [availableCount, setAvailableCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadPortalSchemes()
      .then((list) => {
        if (cancelled) return;
        setAvailableCount(list.filter((i) => statusOf(i) === 'NOT_ENROLLED').length);
      })
      .catch(() => {
        // Non-critical home-screen widget — stay hidden on error.
        if (!cancelled) setAvailableCount(0);
      });
    return () => { cancelled = true; };
  }, []);

  // Only surface the card when there is at least one activation to enrol in.
  if (!availableCount) return null;

  return (
    <Link
      href="/partner/schemes"
      className="relative overflow-hidden rounded-2xl block active:scale-[0.98] transition-transform"
      style={{ background: 'linear-gradient(135deg, #064e3b 0%, #065f46 50%, #047857 100%)' }}
    >
      <div className="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-white/5" />
      <div className="absolute -bottom-4 -left-4 w-16 h-16 rounded-full bg-white/5" />

      <div className="relative px-4 py-4 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center shrink-0">
          <Sparkles className="h-5 w-5 text-emerald-300" />
        </div>

        <div className="flex-1 min-w-0">
          <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-300">
            New Activation
          </span>
          <p className="text-sm font-bold text-white leading-tight mt-0.5">
            {availableCount} activation{availableCount !== 1 ? 's' : ''} available to enrol
          </p>
          <p className="text-[11px] text-white/60 mt-0.5">Tap to view &amp; enrol your outlet</p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0 bg-white text-[#065f46] text-xs font-bold px-3 py-1.5 rounded-lg">
          View <ChevronRight className="h-3 w-3" />
        </div>
      </div>
    </Link>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   PAGE
══════════════════════════════════════════════════════════════════════════ */

export default function PartnerDashboard() {
  const [loading,           setLoading]           = useState(true);
  const [banners,           setBanners]           = useState<Banner[]>([]);
  const [bannerIndex,       setBannerIndex]       = useState(0);
  const [popup,             setPopup]             = useState<Popup | null>(null);
  const [lastUpdatedLabel,  setLastUpdatedLabel]  = useState<string>('');

  // ── Real data: aggregated targets + wallet ──────────────────────────────
  const [aggKpis,      setAggKpis]      = useState<AggKpi[]>([]);
  const [outletType,   setOutletType]   = useState<OutletType>('SSS');
  const [walletPoints, setWalletPoints] = useState<number | null>(null);

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

    // Read last sales-data upload date from localStorage (set by admin on each upload)
    const storedDate = getLastSalesUploadDate();
    if (storedDate) setLastUpdatedLabel(formatLastUpdated(storedDate));
  }, []);

  // ── Real data hydration: targets (per-outlet KPIs) + wallet (auth/me) ────
  useEffect(() => {
    let cancelled = false;
    const period = currentPeriod();

    const targetsP = fetch(`/api/partner/targets?period=${period}`, { headers: { ...authHeader() } })
      .then(r => r.json())
      .then((json: { success: boolean; data?: ApiTargetsResponse }) => {
        if (cancelled || !json.success || !json.data) return;
        const outlets = json.data.outlets ?? [];

        // Aggregate each KPI across ALL outlets: sum target + achieved (null → 0).
        const order: string[] = [];
        const byCode = new Map<string, AggKpi>();
        for (const outlet of outlets) {
          for (const k of outlet.kpis) {
            const existing = byCode.get(k.code);
            if (existing) {
              existing.target   += k.target   ?? 0;
              existing.achieved += k.achieved ?? 0;
              existing.isPrimary = existing.isPrimary || k.isPrimary;
            } else {
              order.push(k.code);
              byCode.set(k.code, {
                code:      k.code,
                name:      k.name,
                unit:      k.unit ?? 'cases',
                isPrimary: k.isPrimary,
                target:    k.target   ?? 0,
                achieved:  k.achieved ?? 0,
              });
            }
          }
        }
        setAggKpis(order.map(c => byCode.get(c)!));
        setOutletType((outlets[0]?.outletType as OutletType) ?? 'SSS');
      })
      .catch(() => {}); // honest empty state — heroes render "No targets yet"

    const walletP = fetch('/api/auth/me', { headers: { ...authHeader() } })
      .then(r => r.json())
      .then((json: {
        success: boolean;
        data?: { user?: { channelPartner?: { wallets?: Array<{ redeemablePoints?: number }> } | null } };
      }) => {
        if (cancelled || !json.success) return;
        const pts = json.data?.user?.channelPartner?.wallets?.[0]?.redeemablePoints;
        setWalletPoints(typeof pts === 'number' ? pts : null);
      })
      .catch(() => {}); // wallet zone falls back to "—"

    Promise.allSettled([targetsP, walletP]).then(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, []);

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

  const primary = aggKpis.find(k => k.isPrimary) ?? aggKpis[0] ?? null;
  const isMT         = outletType === 'SSS_TOT';
  const isWholesaler = outletType === 'WHOLESALER';

  return (
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
      {isWholesaler && <WholesalerHero primary={primary} walletPoints={walletPoints} lastUpdatedLabel={lastUpdatedLabel} />}
      {isMT         && <MTHero aggKpis={aggKpis} lastUpdatedLabel={lastUpdatedLabel} />}
      {!isWholesaler && !isMT && <RetailerHero primary={primary} lastUpdatedLabel={lastUpdatedLabel} />}

      {/* ── 1b. ACTIVATIONS (SCHEMES) ENTRY — all outlet types (D22) ── */}
      <SchemesCard />

      {/* ── 2. SALES vs TARGET CHART ── */}
      <PerformanceChart primary={primary} />

      {/* ── 3. QUICK ACTIONS ── */}
      <QuickActions outletType={outletType} />

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
  );
}
