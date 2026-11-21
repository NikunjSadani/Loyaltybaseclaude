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
  getBgStyle, toEmbedUrl, safeCtaUrl,
  getActivePopup, shouldShowPopup, markPopupSeen,
  type Banner, type Popup,
} from '@/lib/banner';
import { formatPoints } from '@/lib/utils';
import { formatSignedPoints, negativeBalanceNote } from '@/lib/wallet-negative';
import { formatInrCompact, formatCompact, isInrUnit, formatKpiAmount, formatKpiSoFar } from '@/lib/format-inr';
import type { PayoutLedgerEntry } from '@/types';
import { buildCasesToGoMsg, classifyPaceGap, fmtKpiNum, fmtRemaining, remainingOf } from '@/lib/pace';
import { getGifsySettings } from '@/lib/gifsy-settings';
import type { OutletType } from '@/lib/partner-session';
import { pct, pctColor, pctBarColor, currentPeriod } from '@/lib/targets';
import { loadPortalSchemes, statusOf } from '@/app/partner/schemes/portal-api';
import { formatLastUpdated, getLastSalesUploadDate } from '@/lib/sales-upload-utils';
import { authHeader } from '@/lib/api-client';
import { istDateKey, istMonthKey } from '@/lib/ist-date';
import { usePartnerIdentity } from '@/lib/partner-identity';
import { OffersSection } from '@/components/partner/offers/offers-section';

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
  /** At least one outlet reported a (non-null) achieved value — false = no sales data yet, shown as "—". */
  hasAchieved?: boolean;
  /**
   * Sales at this partner's outlets that have NO target for this KPI, when at least one other outlet does.
   * Kept OUT of `achieved` so it can't fill another outlet's target (owner 2026-11-15); shown as "so far".
   */
  untargetedAchieved?: number;
}

/**
 * FLAG-OFF aggregation (partnerDashboardV2 OFF — Deoleo): each KPI's target + achieved summed across ALL
 * outlets (null → 0). Exactly the pre-v2-aggregation code; do not change without the owner (Deoleo is live).
 */
function aggregateKpisPlain(outlets: ReadonlyArray<{ kpis: ApiKpi[] }>): AggKpi[] {
  const order: string[] = [];
  const byCode = new Map<string, AggKpi>();
  for (const outlet of outlets) {
    for (const k of outlet.kpis) {
      const existing = byCode.get(k.code);
      if (existing) {
        existing.target   += k.target   ?? 0;
        existing.achieved += k.achieved ?? 0;
        existing.isPrimary = existing.isPrimary || k.isPrimary;
        existing.hasAchieved = existing.hasAchieved || (k.achieved !== null && k.achieved !== undefined);
      } else {
        order.push(k.code);
        byCode.set(k.code, {
          code:      k.code,
          name:      k.name,
          unit:      k.unit ?? 'cases',
          isPrimary: k.isPrimary,
          target:    k.target   ?? 0,
          achieved:  k.achieved ?? 0,
          hasAchieved: k.achieved !== null && k.achieved !== undefined,
        });
      }
    }
  }
  return order.map(c => byCode.get(c)!);
}

/**
 * partnerDashboardV2 primary KPI: the first FLAGGED-primary KPI that HAS a target (> 0), else the first KPI
 * with a target, else none (→ neutral "so far" hero). A target-less KPI is never the scored headline — a red
 * "0 of 0 · 0%" hero contradicted the card's neutral "so far" row. Same rule as the card footer + Targets page.
 */
function pickTargetedPrimary(aggKpis: AggKpi[]): AggKpi | null {
  return aggKpis.find((k) => k.isPrimary && k.target > 0) ?? aggKpis.find((k) => k.target > 0) ?? null;
}

/** v2: the "+₹2K so far at outlets without this target" figure — shown only when it is a positive amount
 *  (net returns ≤ 0 are not surfaced as a confusing negative "extra"). */
function positiveUntargeted(k: AggKpi | null | undefined): number | null {
  const u = k?.untargetedAchieved;
  return u !== undefined && u >= 0.5 ? u : null;
}

/**
 * partnerDashboardV2 aggregation. Target AND achieved come ONLY from outlets where that KPI has a
 * target (> 0): sales at an outlet without the target must not fill another outlet's target (A: ₹500 of ₹1,000
 * + B: ₹2,000 untargeted ⇒ "₹500/₹1K · 50%", not "250%"). Those untargeted sales are carried separately. A KPI no
 * outlet has a target for sums every outlet's achieved (shown as "so far"). Single-outlet partners and partners whose
 * every outlet has the target are unchanged.
 */
function aggregateKpisAcrossOutlets(outlets: ReadonlyArray<{ kpis: ApiKpi[] }>): AggKpi[] {
  const order: string[] = [];
  const acc = new Map<string, AggKpi & { tT: number; tA: number; uA: number; uHas: boolean }>();
  for (const outlet of outlets) {
    for (const k of outlet.kpis) {
      let a = acc.get(k.code);
      if (!a) {
        order.push(k.code);
        a = { code: k.code, name: k.name, unit: k.unit ?? 'cases', isPrimary: k.isPrimary, target: 0, achieved: 0,
              hasAchieved: false, tT: 0, tA: 0, uA: 0, uHas: false };
        acc.set(k.code, a);
      }
      a.isPrimary = a.isPrimary || k.isPrimary;
      const has = k.achieved !== null && k.achieved !== undefined;
      if ((k.target ?? 0) > 0) {
        a.tT += k.target ?? 0;
        a.tA += k.achieved ?? 0;
        a.hasAchieved = a.hasAchieved || has;
      } else {
        a.uA += k.achieved ?? 0;
        a.uHas = a.uHas || has;
      }
    }
  }
  return order.map((c) => {
    const { tT, tA, uA, uHas, ...k } = acc.get(c)!;
    if (tT > 0) return { ...k, target: tT, achieved: tA, ...(uHas && uA !== 0 ? { untargetedAchieved: uA } : {}) };
    return { ...k, target: 0, achieved: uA, hasAchieved: uHas };
  });
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function computePace() {
  // IST calendar day-of-month (prod/SSR runs UTC; an off-IST clock skews the pacing % by a day).
  const key         = istDateKey(new Date()); // "YYYY-MM-DD" in Asia/Kolkata
  const istYear     = Number(key.slice(0, 4));
  const istMonth    = Number(key.slice(5, 7)); // 1-based
  const elapsed     = Number(key.slice(8, 10));
  const daysInMonth = new Date(istYear, istMonth, 0).getDate();
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
  const remaining   = remainingOf(target, achieved);
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

/* ─── This-month vs last-month comparison (partnerDashboardV2) ────────────────
   Current vs previous calendar month for the PRIMARY KPI, derived from the SAME
   trend series the chart uses (GET /api/partner/targets/trend — oldest-first
   { month, target, achieved }). PURE + exported for unit testing. Returns nulls
   where a month is missing so the card renders "—"/"n/a" — never NaN/Infinity.
─────────────────────────────────────────────────────────────────────────────── */

export interface MonthComparison {
  current: number | null;      // latest month's achieved (null = no current month row)
  previous: number | null;     // prior month's achieved (null = no previous month)
  delta: number | null;        // current − previous (null when either is absent)
  pctChange: number | null;    // round((delta/previous)*100); null when previous is 0/absent
}

export function computeMonthComparison(
  trend: TrendPoint[],
  pick: (p: TrendPoint) => number | null | undefined = (p) => p.achieved,
): MonthComparison {
  const n = trend.length;
  const cur  = n >= 1 ? trend[n - 1] : null;
  const prev = n >= 2 ? trend[n - 2] : null;
  const current  = cur  ? (pick(cur)  ?? 0) : null;
  const previous = prev ? (pick(prev) ?? 0) : null;
  const delta = current !== null && previous !== null ? current - previous : null;
  const pctChange =
    delta !== null && previous !== null && previous > 0
      ? Math.round((delta / previous) * 100)
      : null;
  return { current, previous, delta, pctChange };
}

/** The Performance card's "Change vs last month" — a TRUE SALES comparison. When the trend
 *  carries `achievedAll` (partnerDashboardV2: the all-outlet total) on the months compared, the
 *  delta uses it, so a change in WHICH outlets are targeted can't masquerade as a sales swing
 *  (owner 2026-11-15). Otherwise (flag OFF / older payload) it is exactly computeMonthComparison.
 *  `totalSalesLabel` is true when the compared totals differ from the targeted-only "so far"
 *  figures shown above it in either month, so the label must say "total sales". Same month
 *  positions (latest vs prior row) as computeMonthComparison — month-to-date logic unchanged. PURE. */
export function computeSalesChange(trend: TrendPoint[]): MonthComparison & { totalSalesLabel: boolean } {
  const n = trend.length;
  const compared = trend.slice(Math.max(0, n - 2));
  const hasAll = compared.length > 0 && compared.every((p) => p.achievedAll !== undefined);
  if (!hasAll) return { ...computeMonthComparison(trend), totalSalesLabel: false };
  const totalSalesLabel = compared.some((p) => (p.achievedAll ?? 0) !== (p.achieved ?? 0));
  return { ...computeMonthComparison(trend, (p) => p.achievedAll), totalSalesLabel };
}

/** Format a KPI value the way the hero does: compact ₹ for INR units, else points + unit suffix. */
function fmtKpiValue(value: number, unit: string): string {
  return isInrUnit(unit) ? formatInrCompact(value) : `${formatPoints(value)} ${unit}`;
}

/* ─── Performance card (partnerDashboardV2) ───────────────────────────────────
   ONE merged card replacing the former "Achievement · This month vs last" +
   "Last Month" cards (the client found two last-month-centric cards redundant). A
   two-column split, NO charts:

     • THIS MONTH · so far — current calendar-month achieved (₹/unit) + "% of target"
       (or "No target"), from the trend row for the current month.
     • LAST MONTH · <Mon>  — previous calendar-month achieved + a target verdict
       (✓ target met / below target / No target set) + the reward CREDITED last month:
       "+N pts credited" for a points outlet, "₹N payout" for a payout outlet (BOTH
       lines when the outlet has both). Points come from a SCALE-SAFE server aggregate
       (GET /api/wallet/points-credited?month=…) — NOT the paginated passbook, so an
       active wholesaler's last-month earn is never missed past page 1. Payout is summed
       from the (≤100-per-partner) credit-payout statement by paidAt.
     • Change vs last month — current − previous TOTAL SALES across ALL the partner's outlets
       (the trend's v2 `achievedAll`, via computeSalesChange), so a change in which outlets are
       targeted can't fake a swing; labelled "Change in total sales vs last month" whenever those
       totals differ from the targeted-only figures shown above. No achievedAll → the old delta.

   All of it reuses the SAME GET /api/partner/targets/trend series (computeMonthComparison
   for achieved + delta; lastMonthFromTrend matched by month KEY for the per-month targets)
   and the EXACT points-vs-payout presence signals that drive the wallet page
   (identity.hasPointsActivity / hasPayoutActivity, from GET /partner/me). v2-only, so
   Deoleo (flag OFF) renders neither this nor the old cards — byte-identical.

   "Last month" = the previous calendar month (IST, previousMonthKey). "Credited" = what
   LANDED during that calendar month (points aggregate for the month / payout by paidAt).
─────────────────────────────────────────────────────────────────────────────── */

/** Last calendar month's { target, achieved } for `monthKey`, matched by the row's month KEY
 *  (not array position) so a UTC/IST month-rollover can't skew the heading vs the number.
 *  Returns nulls when the trend has no row for that month (new outlet). PURE. */
export function lastMonthFromTrend(
  trend: TrendPoint[],
  monthKey: string,
): { target: number | null; achieved: number | null } {
  const row = trend.find((p) => p.month === monthKey) ?? null;
  return { target: row?.target ?? null, achieved: row?.achieved ?? null };
}

/** The previous calendar month as a 'YYYY-MM' IST key (prod/SSR run UTC). Derived from
 *  `now` so it is always relative to today — never a hardcoded month. PURE. */
export function previousMonthKey(now: Date = new Date()): string {
  const [y, m] = istMonthKey(now).split('-').map(Number); // m is 1-based
  const d = new Date(Date.UTC(y, m - 2, 1));              // step back one calendar month
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Payout (₹, from integer paise) CREDITED during `monthKey` (IST) — PAID entries whose
 *  paidAt falls in that calendar month. PURE. */
export function sumPayoutCreditedInMonth(payouts: PayoutLedgerEntry[], monthKey: string): number {
  return payouts
    .filter((p) => p.status === 'PAID' && p.paidAt && istMonthKey(p.paidAt) === monthKey)
    .reduce((s, p) => s + p.payoutAmountPaise, 0) / 100;
}

const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Short month-year header label for a 'YYYY-MM' key, e.g. 'Oct 2026' — compact enough for
 *  the "LAST MONTH · <Mon>" column heading at 380px. */
function monthKeyShort(key: string): string {
  const [y, m] = key.split('-');
  return `${(MONTH_FULL[Number(m) - 1] ?? '').slice(0, 3)} ${y}`.trim();
}

function PerformanceCard({
  primary, hasPointsActivity, hasPayoutActivity,
}: { primary: AggKpi | null; hasPointsActivity: boolean; hasPayoutActivity: boolean }) {
  const [trend,    setTrend]    = useState<TrendResponse | null>(null);
  const [pointsCr, setPointsCr] = useState<number | null>(null);
  const [payoutCr, setPayoutCr] = useState<number | null>(null);
  const primaryCode = primary?.code;
  const thisKey = istMonthKey(new Date()); // current IST calendar month
  const lastKey = previousMonthKey();       // previous IST calendar month

  // Target vs achieved trend — the SAME endpoint/series that fed both former cards.
  useEffect(() => {
    let cancelled = false;
    const kpiParam = primaryCode ? `&kpi=${encodeURIComponent(primaryCode)}` : '';
    fetch(`/api/partner/targets/trend?months=24${kpiParam}`, { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success: boolean; data?: TrendResponse }) => {
        if (!cancelled && json.success && json.data) setTrend(json.data);
      })
      .catch(() => { if (!cancelled) setTrend({ kpiName: null, unit: null, trend: [] }); }); // honest empty state
    return () => { cancelled = true; };
  }, [primaryCode]);

  // Points credited last month — a SCALE-SAFE server aggregate for the exact month (NOT the
  // paginated /wallet/transactions passbook, whose page 1 would miss an active wholesaler's
  // last-month earn). Fetched ONLY for a points outlet.
  useEffect(() => {
    if (!hasPointsActivity) return;
    let cancelled = false;
    fetch(`/api/wallet/points-credited?month=${lastKey}`, { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success: boolean; data?: { points?: number } }) => {
        if (cancelled) return;
        setPointsCr(json.success && typeof json.data?.points === 'number' ? json.data.points : 0);
      })
      .catch(() => { if (!cancelled) setPointsCr(0); }); // honest zero
    return () => { cancelled = true; };
  }, [hasPointsActivity, lastKey]);

  // Payout credited last month — fetched ONLY for a payout outlet.
  useEffect(() => {
    if (!hasPayoutActivity) return;
    let cancelled = false;
    fetch('/api/partner/payouts', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success: boolean; data?: { payouts?: PayoutLedgerEntry[] } }) => {
        if (cancelled) return;
        const payouts = json.success && Array.isArray(json.data?.payouts) ? json.data!.payouts! : [];
        setPayoutCr(sumPayoutCreditedInMonth(payouts, lastKey));
      })
      .catch(() => { if (!cancelled) setPayoutCr(0); }); // honest zero
    return () => { cancelled = true; };
  }, [hasPayoutActivity, lastKey]);

  const unit = trend?.unit ?? primary?.unit ?? 'cases';
  const rows = trend?.trend ?? [];
  // Achieved (both months) + the change delta — the exact figures the old comparison card showed.
  const cmp  = computeMonthComparison(rows);
  // "Change vs last month" — total sales across ALL outlets when the v2 payload carries it.
  const chg  = computeSalesChange(rows);
  // Per-month TARGETS matched by month KEY (rollover-safe); the backend series is contiguous and
  // ends at the current month, so these rows line up with cmp's current/previous.
  const thisRow = lastMonthFromTrend(rows, thisKey);
  const lastRow = lastMonthFromTrend(rows, lastKey);

  // Empty state: a brand-new outlet with no trend history AND no reward reality at all.
  const noData   = cmp.current === null && cmp.previous === null;
  const noReward = !hasPointsActivity && !hasPayoutActivity;
  if (noData && noReward) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <TrendingUp className="h-4 w-4 text-[var(--brand-primary)]" />
            Performance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-400">No activity last month</p>
        </CardContent>
      </Card>
    );
  }

  const deltaUp = chg.delta !== null && chg.delta >= 0;

  const thisHasTarget = thisRow.target !== null && thisRow.target > 0;
  const thisPct       = thisHasTarget ? pct(cmp.current ?? 0, thisRow.target ?? 0) : null;

  const lastHasTarget = lastRow.target !== null && lastRow.target > 0;
  const lastPct       = lastHasTarget ? pct(cmp.previous ?? 0, lastRow.target ?? 0) : null;
  const lastMet       = lastHasTarget && (lastPct ?? 0) >= 100;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <TrendingUp className="h-4 w-4 text-[var(--brand-primary)]" />
          Performance
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-stretch gap-3">
          {/* THIS MONTH · so far — the live (highlighted) column */}
          <div className="flex-1 min-w-0 rounded-xl px-3 py-2.5" style={{ backgroundColor: 'var(--brand-primary-light)' }}>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">This month · so far</p>
            <p className="text-lg font-extrabold text-[var(--brand-primary-dark)] mt-0.5 truncate">
              {cmp.current === null ? '—' : fmtKpiValue(cmp.current, unit)}
            </p>
            <p className="text-[11px] text-gray-500 mt-0.5">
              {thisHasTarget ? `${thisPct}% of ${fmtKpiValue(thisRow.target ?? 0, unit)} target` : 'No target'}
            </p>
          </div>

          {/* LAST MONTH · <Mon> — achieved + target verdict + reward credited */}
          <div className="flex-1 min-w-0 rounded-xl bg-gray-50 px-3 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Last month · {monthKeyShort(lastKey)}</p>
            <p className="text-lg font-extrabold text-gray-700 mt-0.5 truncate">
              {cmp.previous === null ? '—' : fmtKpiValue(cmp.previous, unit)}
            </p>
            <p className={`text-[11px] mt-0.5 font-semibold ${lastHasTarget ? (lastMet ? 'text-emerald-600' : 'text-amber-600') : 'text-gray-400'}`}>
              {lastHasTarget ? (lastMet ? '✓ target met' : 'below target') : 'No target set'}
            </p>
            {(hasPointsActivity || hasPayoutActivity) && (
              <div className="mt-1.5 space-y-0.5">
                {hasPointsActivity && (
                  <p className="text-[11px] font-semibold text-[var(--brand-primary-dark)] truncate">
                    {(pointsCr ?? 0) > 0 ? '+' : ''}{formatPoints(pointsCr ?? 0)} pts credited
                  </p>
                )}
                {hasPayoutActivity && (
                  <p className="text-[11px] font-semibold text-[var(--brand-primary-dark)] truncate">
                    {formatInrCompact(payoutCr ?? 0)} payout
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Change vs last month — a sales comparison (all-outlet totals when v2 provides them) */}
        <div className="mt-2.5 flex items-center justify-between text-xs">
          <span className="text-gray-400">
            {chg.totalSalesLabel ? 'Change in total sales vs last month' : 'Change vs last month'}
          </span>
          {chg.delta === null ? (
            <span className="font-semibold text-gray-400">n/a</span>
          ) : (
            <span className={`font-bold ${deltaUp ? 'text-emerald-600' : 'text-red-600'}`}>
              {deltaUp ? '+' : '-'}{fmtKpiValue(Math.abs(chg.delta), unit)}
              {chg.pctChange !== null && (
                <span className="ml-1 text-[11px] font-semibold">
                  ({deltaUp ? '+' : '-'}{Math.abs(chg.pctChange)}%)
                </span>
              )}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Target Achievement card (multi-KPI breakdown for THIS outlet) ───────────
   Mirrors the SALES dashboard's "Target Achievement" card, but scoped to the single
   partner/outlet (aggKpis = this partner's KPIs, already loaded by the page — NO extra
   fetch). One row per KPI (name + "achieved/target unit · pct%" coloured by pace, with a
   thin progress bar), and a footer that REUSES the SAME remaining/days-left values the hero
   computes (primary KPI remaining via kpiView's math + computePace().daysLeft) so the two
   never disagree. No "PRIMARY" badge (intentionally dropped — see the sales card). Renders
   nothing when there are no KPIs so it never shows a broken empty card.
─────────────────────────────────────────────────────────────────────────────── */

function TargetAchievementCard({ aggKpis }: { aggKpis: AggKpi[] }) {
  // No targets at all → render nothing (the hero already carries the empty state).
  if (aggKpis.length === 0) return null;

  const { daysLeft, timePct } = computePace();
  // Current IST month label for the muted header (matches how the dashboard labels periods).
  const periodLabel = new Date().toLocaleDateString('en-IN', {
    month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata',
  });

  // Footer derives from the PRIMARY KPI — the SAME remaining/unit the hero's "to go" banner
  // uses (kpiView: remaining = max(0, target − achieved)); daysLeft is the shared computePace().
  // A KPI WITHOUT a target can never be "met" (max(0, 0 − achieved) = 0 would falsely read "target met 🎉"):
  // fall back to the first KPI that HAS a target; with none at all, the footer is a neutral note.
  // Same pick as the page's hero (pickTargetedPrimary) so the footer and the hero name the same KPI.
  const primary       = pickTargetedPrimary(aggKpis);
  const primaryPct    = primary ? pct(primary.achieved, primary.target) : 0;
  const primaryLeft   = primary ? remainingOf(primary.target, primary.achieved) : 0;
  const paceStatus    = !primary
    ? 'neutral'
    : primaryLeft === 0
      ? 'green'
      : classifyPaceGap(timePct - primaryPct, timePct, getGifsySettings().paceAmberThreshold ?? 10);
  const paceBg        = paceStatus === 'neutral' ? 'bg-gray-50' : paceStatus === 'green' ? 'bg-emerald-50' : paceStatus === 'amber' ? 'bg-amber-50' : 'bg-red-50';
  const paceTextColor = paceStatus === 'neutral' ? 'text-gray-600' : paceStatus === 'green' ? 'text-emerald-700' : paceStatus === 'amber' ? 'text-amber-700' : 'text-red-600';
  const footerText    = !primary
    ? 'No targets set this month'
    : primaryLeft === 0
      ? `${primary.name} target met 🎉`
      : buildCasesToGoMsg(primaryLeft, primary.unit, daysLeft);

  return (
    <Card data-testid="target-achievement-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Target className="h-4 w-4 text-[var(--brand-primary)]" /> Target Achievement
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-gray-400 font-medium">{periodLabel}</span>
            {daysLeft > 0 && (
              <span className={`text-[11px] font-semibold ${daysLeft <= 7 ? 'text-red-500' : daysLeft <= 14 ? 'text-amber-600' : 'text-gray-400'}`}>
                · {daysLeft}d left
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {aggKpis.map((k) => {
          const hasTarget = k.target > 0;
          const isInrKpi  = isInrUnit(k.unit);
          // A KPI with sales but NO target this month (e.g. Bajaj SAMT's NON ADHO gate KPI) is shown as a
          // neutral "so far" figure — no %, no bar, no red: there is nothing to be behind on. A red "— · 0%"
          // read as "you have done nothing" even when the outlet had sales (owner 2026-11-15).
          if (!hasTarget) {
            // No sales data yet (every outlet's achieved was null) → "—", never a stated zero (shared helper:
            // compact ₹ / en-IN + unit; tiny |v| < 0.5 → 0, never "-₹0").
            const soFar = formatKpiSoFar(k.hasAchieved === false ? null : k.achieved, k.unit);
            return (
              <div key={k.code} className="flex items-center gap-2" data-testid={`kpi-no-target-${k.code}`}>
                <p className="text-xs font-medium text-gray-700 flex-1 truncate">{k.name}</p>
                <span className="text-[11px] font-semibold shrink-0 text-gray-500">{soFar}</span>
              </div>
            );
          }
          // pct() already guards target===0 → 0 (never NaN/Infinity).
          const p         = pct(k.achieved, k.target);
          // Paired achieved/target: compact ₹ for INR units; en-IN grouped with the unit suffix otherwise
          // (same rules as the sales card).
          const paired = isInrKpi
            ? `${formatCompact(k.achieved)}/${formatCompact(k.target)}`
            : `${fmtKpiNum(k.achieved, k.unit)}/${fmtKpiNum(k.target, k.unit)}${k.unit ? ` ${k.unit}` : ''}`;
          return (
            <div key={k.code} className="space-y-1">
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium text-gray-700 flex-1 truncate">{k.name}</p>
                <span className={`text-[11px] font-bold shrink-0 ${pctColor(p)}`}>
                  {paired} · {p}%
                </span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all ${pctBarColor(p)}`} style={{ width: `${Math.min(p, 100)}%` }} />
              </div>
              {positiveUntargeted(k) !== null && (
                <p className="text-[10px] text-gray-500" data-testid={`kpi-untargeted-${k.code}`}>
                  +{formatKpiAmount(positiveUntargeted(k)!, k.unit)} so far at outlets without this target
                </p>
              )}
            </div>
          );
        })}

        <div className={`flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1.5 rounded-lg mt-1 ${paceBg} ${paceTextColor}`}>
          <TrendingUp className="h-3 w-3 shrink-0" />
          {footerText}
        </div>
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
  const remaining   = remainingOf(target, achieved);
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

/* ─── v2 hero pieces (partnerDashboardV2 only) ───────────────────────────── */

/**
 * v2 hero zone when NO KPI has a target this month but the partner has KPIs (e.g. only the NON ADHO
 * eligibility-gate KPI): a neutral "₹2.8K so far" + "No targets set this month" — no %, bar, urgency badge
 * or "to go". Agrees with the Target Achievement card's neutral footer.
 */
function NeutralSoFarZone({ kpi, lastUpdatedLabel }: { kpi: AggKpi; lastUpdatedLabel?: string }) {
  return (
    <Link href="/partner/targets" className="block px-4 pt-4 pb-4 active:opacity-80 transition-opacity" data-testid="hero-no-target">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-xs font-semibold text-white/70">{kpi.name}</p>
          {lastUpdatedLabel && (
            <p className="text-[10px] text-white/40 mt-0.5">{lastUpdatedLabel}</p>
          )}
        </div>
        <span className="flex items-center gap-1 text-[10px] font-semibold text-white/50">
          All targets <ChevronRight className="h-3 w-3" />
        </span>
      </div>
      <p className="text-3xl font-extrabold text-white leading-none">
        {formatKpiSoFar(kpi.hasAchieved === false ? null : kpi.achieved, kpi.unit)}
      </p>
      <p className="text-[11px] text-white/60 mt-2">No targets set this month</p>
    </Link>
  );
}

/** v2: the primary's sales at outlets WITHOUT its target — shown apart, never in the hero's % (agrees with the card). */
function HeroUntargetedLine({ kpi }: { kpi: AggKpi | null }) {
  const u = positiveUntargeted(kpi);
  if (u === null || !kpi) return null;
  return (
    <p className="text-[11px] text-white/60 mt-2" data-testid={`hero-untargeted-${kpi.code}`}>
      +{formatKpiAmount(u, kpi.unit)} so far at outlets without this target
    </p>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   WHOLESALER HERO — primary KPI + real wallet balance
══════════════════════════════════════════════════════════════════════════ */

function WholesalerHero({
  primary, walletPoints, lastUpdatedLabel, v2 = false, soFarKpi = null, owedFromReversal = false,
}: {
  primary: AggKpi | null; walletPoints: number | null; lastUpdatedLabel?: string; v2?: boolean;
  /** Negative wallets only (fix round 4, item 6): the debt comes from a reversed credit — same signal as the wallet page. */
  owedFromReversal?: boolean;
  /** v2 only: set when no KPI has a target → the neutral "so far" zone replaces the scored KPI zone. */
  soFarKpi?: AggKpi | null;
}) {
  const { daysLeft, timePct } = computePace();
  const v = kpiView(primary, daysLeft, timePct);
  const label = primary?.name ?? 'Monthly Volume';

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: 'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-primary-dark) 50%, var(--brand-primary-dark) 100%)' }}>

      {v2 && soFarKpi ? <NeutralSoFarZone kpi={soFarKpi} lastUpdatedLabel={lastUpdatedLabel} /> : (
      /* ── Zone 1: KPI (entire zone tappable → targets page) ──────────── */
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
            <p className="text-3xl font-extrabold text-white leading-none">{fmtKpiNum(v.achieved, v.unit)} <span className="text-lg font-bold text-white/70">{v.unit}</span></p>
            <p className="text-[11px] text-white/50 mt-1">of {fmtKpiNum(v.target, v.unit)} {v.unit}</p>
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

        {v2 && v.remaining > 0 && (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-xs font-bold text-white">
            <Target className="h-3.5 w-3.5" /> {fmtRemaining(v.remaining)} {v.unit} to go
          </div>
        )}

        {v.isMet ? (
          <p className="text-[11px] text-emerald-300 font-semibold mt-2">Target achieved 🎉</p>
        ) : v.target === 0 ? (
          <p className="text-[11px] text-white/40 mt-2">No targets yet</p>
        ) : null}

        {v2 && <HeroUntargetedLine kpi={primary} />}
      </Link>
      )}

      {/* ── Zone 2: Wallet ──────────────────────────────────────────────── */}
      <div className={`border-t border-white/10 bg-black/25 px-4 flex items-center justify-between ${v2 ? 'py-4' : 'py-3'}`}>
        <div>
          <p className="text-[10px] text-white/40 font-medium mb-0.5">Available</p>
          <p
            data-testid="hero-available"
            className={`font-extrabold ${walletPoints !== null && walletPoints < 0 ? 'text-amber-300' : 'text-white'} ${v2 ? 'text-3xl leading-none' : 'text-base'}`}
          >
            {walletPoints === null ? '—' : formatSignedPoints(walletPoints)}
            <span className={`font-medium text-white/50 ml-1 ${v2 ? 'text-base' : 'text-sm'}`}>pts</span>
          </p>
          {/* Owner decision 2 (2026-11-19): a negative balance is shown as it is, with what it means */}
          {walletPoints !== null && walletPoints < 0 && (
            <p data-testid="hero-negative-note" className="text-[10px] text-amber-200 mt-1 max-w-[14rem] leading-snug">
              {negativeBalanceNote({ redeemable: walletPoints, owedFromReversal })}
            </p>
          )}
        </div>
        <Link href="/partner/rewards"
          className={`flex items-center gap-1.5 bg-white rounded-lg font-bold text-[var(--brand-primary)] hover:bg-white/90 active:scale-95 transition-all ${v2 ? 'px-5 py-3 text-base' : 'px-3 py-1.5 text-xs'}`}>
          Redeem <ArrowRight className={v2 ? 'h-5 w-5' : 'h-3.5 w-3.5'} />
        </Link>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   SSS / SUB-STOCKIST HERO — primary KPI (no wallet zone)
══════════════════════════════════════════════════════════════════════════ */

function RetailerHero({
  primary, lastUpdatedLabel, v2 = false, soFarKpi = null,
}: {
  primary: AggKpi | null; lastUpdatedLabel?: string; v2?: boolean;
  /** v2 only: set when no KPI has a target → the neutral "so far" zone replaces the scored KPI zone. */
  soFarKpi?: AggKpi | null;
}) {
  const { daysLeft, timePct } = computePace();
  const v = kpiView(primary, daysLeft, timePct);
  const label = primary?.name ?? 'Monthly Target';

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: 'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-primary-dark) 50%, var(--brand-primary-dark) 100%)' }}>

      {v2 && soFarKpi ? <NeutralSoFarZone kpi={soFarKpi} lastUpdatedLabel={lastUpdatedLabel} /> : (
      /* ── Zone 1: KPI (entire zone tappable → targets page) ──────────── */
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
              {fmtKpiNum(v.achieved, v.unit)} <span className="text-lg font-bold text-white/70">{v.unit}</span>
            </p>
            <p className="text-[11px] text-white/50 mt-1">of {fmtKpiNum(v.target, v.unit)} {v.unit}</p>
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

        {v2 && v.remaining > 0 && (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-xs font-bold text-white">
            <Target className="h-3.5 w-3.5" /> {fmtRemaining(v.remaining)} {v.unit} to go
          </div>
        )}

        {v.isMet ? (
          <p className="text-[11px] text-emerald-300 font-semibold mt-2">Target achieved 🎉</p>
        ) : v.target === 0 ? (
          <p className="text-[11px] text-white/40 mt-2">No targets yet</p>
        ) : v.remaining > 0 ? (
          <p className="text-[11px] text-white/50 mt-2">{fmtRemaining(v.remaining)} {v.unit} remaining</p>
        ) : null}

        {v2 && <HeroUntargetedLine kpi={primary} />}
      </Link>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   MT HERO (SSS_TOT) — multi-KPI breakdown across all aggregated KPIs
══════════════════════════════════════════════════════════════════════════ */

function MTHero({
  aggKpis, lastUpdatedLabel, v2 = false,
}: { aggKpis: AggKpi[]; lastUpdatedLabel?: string; v2?: boolean }) {
  const { daysLeft, timePct } = computePace();
  // v2: a target-less KPI is never scored — it is a neutral "so far" row, excluded from metCount/allMet, and
  // never the "to go" primary. Flag OFF → every KPI scored exactly as before.
  const scored      = v2 ? aggKpis.filter(k => k.target > 0) : aggKpis;
  const soFarKpis   = v2 ? aggKpis.filter(k => !(k.target > 0)) : [];
  const mtPrimary   = v2 ? pickTargetedPrimary(aggKpis) : (aggKpis.find(k => k.isPrimary) ?? aggKpis[0] ?? null);
  const mtRemaining = mtPrimary ? remainingOf(mtPrimary.target, mtPrimary.achieved) : 0;

  const kpiRows = scored.map((k) => {
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
        {kpiRows.length === 0 && soFarKpis.length > 0 ? (
          <p className="text-sm font-semibold text-white/70">No targets set this month</p>
        ) : kpiRows.length === 0 ? (
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
                  <p className="text-[10px] text-white/50">{fmtKpiNum(kpi.achieved, kpi.unit)} of {fmtKpiNum(kpi.target, kpi.unit)} {kpi.unit}</p>
                  {v2 && positiveUntargeted(kpi) !== null && (
                    <p className="text-[10px] text-white/60" data-testid={`mt-untargeted-${kpi.code}`}>
                      +{formatKpiAmount(positiveUntargeted(kpi)!, kpi.unit)} so far at outlets without this target
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* v2: target-less KPIs — neutral "so far" rows (no %, bar, badge); never counted as met/missed. */}
        {soFarKpis.length > 0 && (
          <div className={`space-y-1.5 ${kpiRows.length > 0 ? 'mt-3 pt-3 border-t border-white/10' : 'mt-3'}`}>
            {soFarKpis.map((kpi) => (
              <div key={kpi.code} className="flex items-center justify-between" data-testid={`mt-no-target-${kpi.code}`}>
                <p className="text-xs font-semibold text-white/80">{kpi.name}</p>
                <p className="text-xs font-semibold text-white/70">
                  {formatKpiSoFar(kpi.hasAchieved === false ? null : kpi.achieved, kpi.unit)}
                </p>
              </div>
            ))}
          </div>
        )}

        {v2 && mtPrimary && mtRemaining > 0 && (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-xs font-bold text-white">
            <Target className="h-3.5 w-3.5" /> {fmtRemaining(mtRemaining)} {mtPrimary.unit} to go
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
  // Raw per-outlet KPIs — aggregated below once the tenant flag is known (identity.features).
  const [targetOutlets, setTargetOutlets] = useState<ApiOutlet[]>([]);
  const [walletPoints, setWalletPoints] = useState<number | null>(null);
  // Fix round 4 (item 6): for a NEGATIVE balance only, the wallet page's own signal (GET /api/wallet owedFromReversal).
  const [owedFromReversal, setOwedFromReversal] = useState(false);

  // Outlet type is sourced from the AUTHORITATIVE /partner/me identity hook (NOT the
  // unreliable denormalized target-upload string) — see the hero selection below.
  const identity = usePartnerIdentity();

  // partnerDashboardV2 (Bajaj trade) — hides the trend chart, enlarges the wallet
  // points + Redeem, surfaces a "to go" banner in the hero, and adds a
  // this-month-vs-last-month card. Default OFF → Deoleo renders byte-identically.
  // Read from the EXISTING identity (/partner/me) result — normalized features from the
  // same fetch — so there is no duplicate request and no v2=false→true flash (the page's
  // loading gate already waits on identity.loading).
  const v2 = !!identity.features?.partnerDashboardV2;
  // offerTiles — the tenant switch for the WHOLE "This month's offers" feature (admin page AND
  // partner tiles). Read from the SAME identity features as v2 (no localStorage, no extra request);
  // OFF ⇒ OffersSection is never mounted, so a flag-off tenant (Deoleo) makes ZERO offers requests.
  const offersOn = !!identity.features?.offerTiles;

  // Aggregate each KPI across the partner's outlets. v2 (Bajaj): targeted-outlets-only target + achieved,
  // untargeted sales carried apart. Flag OFF (Deoleo): the plain sums across every outlet, exactly as before.
  const aggKpis = React.useMemo(
    () => (v2 ? aggregateKpisAcrossOutlets(targetOutlets) : aggregateKpisPlain(targetOutlets)),
    [v2, targetOutlets],
  );

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

        setTargetOutlets(outlets);
        // NOTE: outletType is NOT taken from targets here — the target-upload row's
        // denormalized string is unreliable. It comes from /partner/me (identity).
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
        if (typeof pts === 'number' && pts < 0) {
          return fetch('/api/wallet', { headers: { ...authHeader() } })
            .then((r) => r.json())
            .then((w: { success?: boolean; data?: { owedFromReversal?: boolean } }) => {
              if (!cancelled && w?.success) setOwedFromReversal(w.data?.owedFromReversal === true);
            })
            .catch(() => {}); // the generic note stays
        }
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

  // Gate on BOTH the targets/wallet load AND partner identity so the hero never
  // flashes the wrong variant before the authoritative outlet type resolves.
  if (loading || identity.loading) {
    return <div className="flex items-center justify-center min-h-64"><Spinner size="lg" /></div>;
  }

  // Flag OFF: the flagged-primary KPI, else the first (as before). v2: the first primary/KPI that HAS a
  // target; none → the hero shows a neutral "so far" for the would-be primary (soFarKpi) instead of a red 0%.
  const primary  = v2
    ? pickTargetedPrimary(aggKpis)
    : (aggKpis.find(k => k.isPrimary) ?? aggKpis[0] ?? null);
  const soFarKpi = v2 && !primary ? (aggKpis.find(k => k.isPrimary) ?? aggKpis[0] ?? null) : null;

  // AUTHORITATIVE outlet type from /partner/me (identity). Fall back to 'SSS' only
  // once identity has genuinely resolved with no outlet type. This is the fix: a
  // wholesaler whose target-upload row disagreed (e.g. said "SSS") now still gets the
  // WholesalerHero — and its Available-points wallet zone — keyed off /partner/me.
  const outletType: OutletType = (identity.outletType as OutletType | null) ?? 'SSS';
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
                    href={safeCtaUrl(banner.ctaUrl) ?? '#'}
                    target={safeCtaUrl(banner.ctaUrl) ? '_blank' : undefined}
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
      {isWholesaler && <WholesalerHero primary={primary} walletPoints={walletPoints} lastUpdatedLabel={lastUpdatedLabel} v2={v2} soFarKpi={soFarKpi} owedFromReversal={owedFromReversal} />}
      {isMT         && <MTHero aggKpis={aggKpis} lastUpdatedLabel={lastUpdatedLabel} v2={v2} />}
      {!isWholesaler && !isMT && <RetailerHero primary={primary} lastUpdatedLabel={lastUpdatedLabel} v2={v2} soFarKpi={soFarKpi} />}

      {/* ── 1b. ACTIVATIONS (SCHEMES) ENTRY — all outlet types (D22) ── */}
      <SchemesCard />

      {/* ── 2. PERFORMANCE (V2) / SALES-vs-TARGET CHART (non-V2) ──
             V2 replaces the chart with ONE merged Performance card: this-month vs
             last-month achievement + last-month reward credited (points or payout).
             Deoleo (flag OFF) keeps the chart → byte-identical. ── */}
      {v2
        ? <PerformanceCard
            // No targeted KPI → trend the SAME KPI the neutral hero shows (else the server picks its own default).
            primary={primary ?? soFarKpi}
            hasPointsActivity={identity.hasPointsActivity}
            hasPayoutActivity={identity.hasPayoutActivity}
          />
        : <PerformanceChart primary={primary} />}

      {/* ── 2b. TARGET ACHIEVEMENT — full multi-KPI breakdown for THIS outlet, directly below
             the Performance card. v2 ONLY: the non-v2 (Deoleo) dashboard already renders a
             Target-vs-Achievement chart above, so the card would duplicate it there. Reuses the
             aggKpis the page already loaded (no extra fetch); self-hides when the outlet has no KPIs. ── */}
      {v2 && <TargetAchievementCard aggKpis={aggKpis} />}

      {/* ── 2c. THIS MONTH'S OFFERS — BOTH variants, ONLY when the tenant's offerTiles flag is ON
             (flag OFF ⇒ not mounted, no request ⇒ Deoleo byte-identical). Self-fetching and
             self-hiding when no active tile matches this outlet. Below Target Achievement (v2) /
             the Target-vs-Achievement chart (non-v2). ── */}
      {offersOn && <OffersSection />}

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
                <a href={safeCtaUrl(popup.ctaUrl) ?? '#'} target={safeCtaUrl(popup.ctaUrl) ? '_blank' : undefined}
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
