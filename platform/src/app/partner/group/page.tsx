'use client';

/* ─── Group Overview (Wave 3, READ-ONLY) ──────────────────────────────────────
   A partner whose login is the group PARENT sees a consolidated, read-only roll-up
   across the group's child outlets: WALLET, TARGETS, VISIBILITY and LEADERBOARD.
   No spend / redeem / edit controls are ever rendered here — every section is a
   pure roll-up; redemption, capture and scoring all happen per outlet elsewhere.

   Each section fetches its own {success,data}-wrapped endpoint (in parallel on
   mount) and owns its loading / empty / degraded state, so one section failing
   or being unavailable never crashes the page:
     GET /api/partner/group/wallet       → shell + wallet roll-up (gates the page)
     GET /api/partner/group/targets      → per-outlet × KPI target/achieved/pace
     GET /api/partner/group/visibility   → per-outlet monthly capture status
     GET /api/partner/group/leaderboard  → the group's shops' tenant-wide ranks

   All wallet point fields are integer POINTS (never paise); conversionRate converts
   points → ₹ the same way the rewards flow does (₹ = points ÷ conversionRate).
   Targets `pace` = achieved ÷ target (a ratio → shown as a %), and may be null → "—".
─────────────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Layers, Lock, ArrowLeft, Target, Eye, Trophy, ArrowUp, ArrowDown, Minus, Star } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { formatPoints } from '@/lib/utils';
import { api } from '@/lib/api-client';

/* ─── API contracts ───────────────────────────────────────────────────────────── */

interface GroupOutlet {
  outletCode:       string;
  businessName:     string;
  ownerName:        string;
  isActive:         boolean;
  redeemablePoints: number;
  earnedPoints:     number;
  redeemedPoints:   number;
  expiredPoints:    number;
  lockedPoints:     number;
}

interface GroupTotals {
  redeemablePoints: number;
  earnedPoints:     number;
  redeemedPoints:   number;
  expiredPoints:    number;
  lockedPoints:     number;
  lifetimeEarned:   number;
  lifetimeRedeemed: number;
}

type GroupWallet =
  | { available: false }
  | {
      available: true;
      parent:         { businessName: string; ownerName: string };
      totals:         GroupTotals;
      conversionRate: number;
      outlets:        GroupOutlet[];
    };

interface KpiCell {
  code:      string;
  name:      string;
  target:    number | null;
  achieved:  number | null;
  pace:      number | null;   // ratio (achieved ÷ target); null → "—"
  unit:      string;
  isPrimary: boolean;
}

type GroupTargets =
  | { available: false }
  | {
      available: true;
      parent:    { businessName: string; ownerName: string };
      period:    string;
      kpiTotals: KpiCell[];
      outlets:   { outletCode: string; outletName: string; outletType: string; kpis: KpiCell[] }[];
    };

type VisibilityStatus = 'APPROVED' | 'UNDER_REVIEW' | 'PENDING' | null;

type GroupVisibility =
  | { available: false }
  | { available: true; visibilityEnabled: false }
  | {
      available: true;
      visibilityEnabled: true;
      month:  string;
      counts: { total: number; approved: number; underReview: number; pending: number; noRecord: number };
      outlets: { outletCode: string; outletName: string; status: VisibilityStatus; dateOfCapture: string | null; approvedBy: string | null }[];
    };

interface LeaderboardEntry {
  rank:       number;
  partnerId:  string;
  partnerName: string;
  score:      number;
  rankChange: number;
}

type GroupLeaderboard =
  | { available: false }
  | {
      available: true;
      parent:   { businessName: string | null; ownerName: string | null };
      snapshot: { snapshotDate: string; periodStartDate: string; periodEndDate: string } | null;
      entries:  LeaderboardEntry[];
    };

/** A section's async state: still fetching, or resolved to its payload. */
type Loadable<T> = 'loading' | T;

/* ─── ₹ + value helpers ───────────────────────────────────────────────────────── */

/** ₹ equivalent of a points figure, mirroring the rewards flow: ₹ = points ÷ rate.
    Guards a zero/invalid rate so we never divide by zero (returns null → shown as —). */
function inrEquivalent(points: number, conversionRate: number): number | null {
  const hasRate = Number.isFinite(conversionRate) && conversionRate > 0;
  return hasRate ? points / conversionRate : null;
}

function fmtInr(n: number | null): string {
  if (n == null) return '—';
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/** A numeric KPI value (target / achieved). null / non-finite → "—". */
function fmtKpi(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** pace is a ratio (achieved ÷ target). Render as a whole-number %; null → "—". */
function fmtPace(pace: number | null | undefined): string {
  if (pace == null || !Number.isFinite(pace)) return '—';
  return `${Math.round(pace * 100)}%`;
}

/* ─── Wallet: consolidated totals card ──────────────────────────────────────────
   Reuses the wallet balance-card visual language (dark gradient, rounded-2xl,
   white text, shadow) but rolls the whole group together and adds the ₹ equivalent
   of the redeemable balance via conversionRate. */

function GroupTotalsCard({ totals, conversionRate }: { totals: GroupTotals; conversionRate: number }) {
  const redeemableInr = inrEquivalent(totals.redeemablePoints, conversionRate);
  return (
    <div
      data-testid="group-totals-card"
      className="bg-gradient-to-br from-[#1A1A2E] to-[#16213E] rounded-2xl px-5 py-4 text-white shadow-xl"
    >
      {/* Redeemable — primary, with ₹ equivalent */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-white/50 text-[11px] font-medium uppercase tracking-widest shrink-0">
          Group Redeemable
        </p>
        <div className="text-right">
          <p className="text-3xl font-extrabold tracking-tight leading-none">
            {formatPoints(totals.redeemablePoints)}
            <span className="text-base font-normal text-white/40 ml-1.5">pts</span>
          </p>
          <p data-testid="group-redeemable-inr" className="text-white/50 text-xs mt-1">
            ≈ {fmtInr(redeemableInr)}
          </p>
        </div>
      </div>

      {/* Secondary roll-ups */}
      <div className="grid grid-cols-2 gap-2.5 mt-4">
        <div>
          <p className="text-white/40 text-[10px] uppercase tracking-wide">Lifetime Earned</p>
          <p className="text-white/80 font-semibold text-sm">{formatPoints(totals.lifetimeEarned)} pts</p>
        </div>
        <div>
          <p className="text-white/40 text-[10px] uppercase tracking-wide">Lifetime Redeemed</p>
          <p className="text-white/80 font-semibold text-sm">{formatPoints(totals.lifetimeRedeemed)} pts</p>
        </div>
        <div>
          <p className="text-white/40 text-[10px] uppercase tracking-wide">Earned</p>
          <p className="text-white/80 font-semibold text-sm">{formatPoints(totals.earnedPoints)} pts</p>
        </div>
        <div>
          <p className="text-white/40 text-[10px] uppercase tracking-wide">On Hold</p>
          <p className="text-white/80 font-semibold text-sm">{formatPoints(totals.lockedPoints)} pts</p>
        </div>
      </div>
    </div>
  );
}

/* ─── Wallet: per-outlet roll-up ──────────────────────────────────────────────── */

function OutletRow({ outlet, conversionRate }: { outlet: GroupOutlet; conversionRate: number }) {
  const redeemableInr = inrEquivalent(outlet.redeemablePoints, conversionRate);
  return (
    <div data-testid="group-outlet-row" className="px-4 py-3">
      {/* Header row: name + code + active badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate">{outlet.businessName}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">
            {outlet.outletCode}
            {outlet.ownerName ? ` · ${outlet.ownerName}` : ''}
          </p>
        </div>
        <span
          className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
            outlet.isActive
              ? 'bg-emerald-50 text-emerald-600'
              : 'bg-gray-100 text-gray-400'
          }`}
        >
          {outlet.isActive ? 'Active' : 'Inactive'}
        </span>
      </div>

      {/* Points figures */}
      <div className="grid grid-cols-3 gap-2 mt-2.5">
        <div>
          <p className="text-[10px] text-gray-400 uppercase tracking-wide">Redeemable</p>
          <p className="text-sm font-bold text-gray-900">{formatPoints(outlet.redeemablePoints)}</p>
          <p className="text-[10px] text-gray-400 mt-0.5">≈ {fmtInr(redeemableInr)}</p>
        </div>
        <div>
          <p className="text-[10px] text-gray-400 uppercase tracking-wide">Earned</p>
          <p className="text-sm font-semibold text-gray-700">{formatPoints(outlet.earnedPoints)}</p>
        </div>
        <div>
          <p className="text-[10px] text-gray-400 uppercase tracking-wide">Redeemed</p>
          <p className="text-sm font-semibold text-gray-700">{formatPoints(outlet.redeemedPoints)}</p>
        </div>
      </div>
    </div>
  );
}

/* ─── Shared section shell ──────────────────────────────────────────────────────
   Matches the wallet per-outlet card (white rounded-2xl border, uppercase header
   label + optional trailing meta). Sections that hide themselves simply return null
   from their own wrapper before rendering this. */

function SectionShell({
  icon,
  title,
  meta,
  testId,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  meta?: React.ReactNode;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId} className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <div className="px-4 pt-3 pb-2 border-b border-gray-50 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide inline-flex items-center gap-1.5">
          {icon}
          {title}
        </p>
        {meta != null && <span className="text-[10px] text-gray-400 shrink-0">{meta}</span>}
      </div>
      {children}
    </div>
  );
}

/** A tiny in-section loading placeholder (keeps the page height stable per section). */
function SectionLoading() {
  return (
    <div className="flex items-center justify-center py-10">
      <Spinner size="md" />
    </div>
  );
}

/* ─── Targets section ───────────────────────────────────────────────────────────
   A group KPI-totals card (one chip per KPI, primary starred) + per-outlet rows
   each listing that outlet's KPI target / achieved / pace. READ-ONLY. */

function KpiTotalChip({ kpi }: { kpi: KpiCell }) {
  return (
    <div
      data-testid="group-kpi-total"
      className={`rounded-xl px-3 py-2.5 border ${
        kpi.isPrimary ? 'border-[var(--brand-primary)]/30 bg-[var(--brand-primary)]/[0.04]' : 'border-gray-100 bg-gray-50/60'
      }`}
    >
      <p className="text-[10px] text-gray-500 uppercase tracking-wide inline-flex items-center gap-1 truncate">
        {kpi.isPrimary && <Star className="h-2.5 w-2.5 fill-[var(--brand-primary)] text-[var(--brand-primary)]" />}
        {kpi.name}
        {kpi.unit ? ` (${kpi.unit})` : ''}
      </p>
      <div className="flex items-baseline gap-2 mt-1">
        <p className="text-lg font-extrabold text-gray-900 leading-none">{fmtPace(kpi.pace)}</p>
        <p className="text-[11px] text-gray-400">
          {fmtKpi(kpi.achieved)} / {fmtKpi(kpi.target)}
        </p>
      </div>
    </div>
  );
}

function TargetOutletRow({ outlet }: { outlet: { outletCode: string; outletName: string; kpis: KpiCell[] } }) {
  return (
    <div data-testid="group-target-outlet-row" className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900 truncate">{outlet.outletName}</p>
        <p className="text-[11px] text-gray-400 shrink-0">{outlet.outletCode}</p>
      </div>
      {outlet.kpis.length === 0 ? (
        <p className="text-[11px] text-gray-400 mt-2">No targets for this period.</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {outlet.kpis.map((k) => (
            <div key={k.code} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-gray-600 truncate inline-flex items-center gap-1 min-w-0">
                {k.isPrimary && <Star className="h-2.5 w-2.5 shrink-0 fill-amber-400 text-amber-400" />}
                <span className="truncate">{k.name}{k.unit ? ` (${k.unit})` : ''}</span>
              </span>
              <span className="shrink-0 text-gray-500 tabular-nums">
                {fmtKpi(k.achieved)} / {fmtKpi(k.target)}
                <span className="ml-2 font-semibold text-gray-900">{fmtPace(k.pace)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TargetsSection({ state }: { state: Loadable<GroupTargets> }) {
  if (state === 'loading') {
    return (
      <SectionShell icon={<Target className="h-3 w-3" />} title="Targets" testId="group-targets-section">
        <SectionLoading />
      </SectionShell>
    );
  }
  // Unavailable (or a malformed / degraded payload) → hide the section entirely.
  if (!state.available || !Array.isArray(state.kpiTotals)) return null;

  const { period, kpiTotals, outlets } = state;
  return (
    <SectionShell
      icon={<Target className="h-3 w-3" />}
      title="Targets"
      meta={period || undefined}
      testId="group-targets-section"
    >
      {kpiTotals.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10">
          <Target className="h-7 w-7 text-gray-200" />
          <p className="text-sm text-gray-400">No targets set for this period</p>
        </div>
      ) : (
        <>
          {/* Group KPI totals */}
          <div className="p-3 grid grid-cols-2 gap-2 border-b border-gray-50">
            {kpiTotals.map((k) => (
              <KpiTotalChip key={k.code} kpi={k} />
            ))}
          </div>
          {/* Per-outlet target rows */}
          <div className="divide-y divide-gray-50">
            {(outlets ?? []).map((o) => (
              <TargetOutletRow key={o.outletCode} outlet={o} />
            ))}
          </div>
        </>
      )}
    </SectionShell>
  );
}

/* ─── Visibility section ────────────────────────────────────────────────────────
   Only rendered when the tenant's visibility master is ON (visibilityEnabled).
   A counts summary + per-outlet monthly capture status. READ-ONLY. */

const VIS_LABEL: Record<Exclude<VisibilityStatus, null>, string> = {
  APPROVED: 'Approved',
  UNDER_REVIEW: 'Under review',
  PENDING: 'Pending',
};

function VisibilityStatusBadge({ status }: { status: VisibilityStatus }) {
  const cls =
    status === 'APPROVED'
      ? 'bg-emerald-50 text-emerald-600'
      : status === 'UNDER_REVIEW'
        ? 'bg-amber-50 text-amber-600'
        : status === 'PENDING'
          ? 'bg-blue-50 text-blue-600'
          : 'bg-gray-100 text-gray-400';
  const label = status ? VIS_LABEL[status] : 'No record';
  return (
    <span className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold ${cls}`}>
      {label}
    </span>
  );
}

function VisibilityCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <p className="text-lg font-extrabold text-gray-900 leading-none">{value}</p>
      <p className="text-[10px] text-gray-400 uppercase tracking-wide mt-1">{label}</p>
    </div>
  );
}

function VisibilitySection({ state }: { state: Loadable<GroupVisibility> }) {
  if (state === 'loading') {
    return (
      <SectionShell icon={<Eye className="h-3 w-3" />} title="Visibility" testId="group-visibility-section">
        <SectionLoading />
      </SectionShell>
    );
  }
  // Unavailable OR master toggle OFF → hide the section entirely.
  if (!state.available || state.visibilityEnabled !== true) return null;

  const { month, counts, outlets } = state;
  return (
    <SectionShell
      icon={<Eye className="h-3 w-3" />}
      title="Visibility"
      meta={month || undefined}
      testId="group-visibility-section"
    >
      {/* Counts summary */}
      <div className="grid grid-cols-4 gap-2 p-3 border-b border-gray-50">
        <VisibilityCount label="Approved" value={counts?.approved ?? 0} />
        <VisibilityCount label="Review" value={counts?.underReview ?? 0} />
        <VisibilityCount label="Pending" value={counts?.pending ?? 0} />
        <VisibilityCount label="No rec." value={counts?.noRecord ?? 0} />
      </div>

      {/* Per-outlet status rows */}
      {(outlets?.length ?? 0) === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10">
          <Eye className="h-7 w-7 text-gray-200" />
          <p className="text-sm text-gray-400">No outlets to show</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-50">
          {outlets.map((o) => (
            <div key={o.outletCode} data-testid="group-visibility-row" className="px-4 py-2.5 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900 truncate">{o.outletName}</p>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  {o.outletCode}
                  {o.dateOfCapture ? ` · captured ${o.dateOfCapture}` : ''}
                </p>
              </div>
              <VisibilityStatusBadge status={o.status} />
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

/* ─── Leaderboard section ───────────────────────────────────────────────────────
   The group's shops with their TENANT-WIDE rank + score from the latest published
   snapshot. Shows a friendly empty state (never hidden) when nothing's published
   yet or none of the group's shops placed. READ-ONLY. */

function RankChange({ change }: { change: number }) {
  if (!Number.isFinite(change) || change === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] text-gray-400">
        <Minus className="h-3 w-3" />
      </span>
    );
  }
  const up = change > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold ${up ? 'text-emerald-600' : 'text-red-500'}`}>
      {up ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
      {Math.abs(change)}
    </span>
  );
}

function LeaderboardEmpty() {
  return (
    <div data-testid="group-leaderboard-empty" className="flex flex-col items-center gap-2 py-10 px-6 text-center">
      <Trophy className="h-7 w-7 text-gray-200" />
      <p className="text-sm font-semibold text-gray-500">No published leaderboard yet</p>
      <p className="text-xs text-gray-400 max-w-xs">
        Once a leaderboard is published, your group&apos;s shops and their ranks will appear here.
      </p>
    </div>
  );
}

function LeaderboardSection({ state }: { state: Loadable<GroupLeaderboard> }) {
  if (state === 'loading') {
    return (
      <SectionShell icon={<Trophy className="h-3 w-3" />} title="Leaderboard" testId="group-leaderboard-section">
        <SectionLoading />
      </SectionShell>
    );
  }
  // Unavailable → hide entirely; otherwise always render (empty state, never hidden).
  if (!state.available) return null;

  const entries = Array.isArray(state.entries) ? state.entries : [];
  const noData = !state.snapshot || entries.length === 0;
  const period = state.snapshot
    ? `${state.snapshot.periodStartDate} → ${state.snapshot.periodEndDate}`
    : undefined;

  return (
    <SectionShell
      icon={<Trophy className="h-3 w-3" />}
      title="Leaderboard"
      meta={period}
      testId="group-leaderboard-section"
    >
      {noData ? (
        <LeaderboardEmpty />
      ) : (
        <div className="divide-y divide-gray-50">
          {entries.map((e) => (
            <div key={e.partnerId} data-testid="group-leaderboard-row" className="px-4 py-2.5 flex items-center gap-3">
              <span className="shrink-0 w-9 text-center">
                <span className="text-sm font-extrabold text-gray-900 tabular-nums">#{e.rank}</span>
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900 truncate">{e.partnerName}</p>
                <p className="text-[11px] text-gray-400 mt-0.5">Score {e.score?.toLocaleString('en-IN')}</p>
              </div>
              <RankChange change={e.rankChange} />
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

/* ─── Empty / no-group state ──────────────────────────────────────────────────── */

function NoGroupState() {
  return (
    <div
      data-testid="group-empty-state"
      className="bg-white rounded-2xl border border-gray-100 flex flex-col items-center gap-3 py-14 px-6 text-center"
    >
      <Layers className="h-9 w-9 text-gray-200" />
      <p className="text-sm font-semibold text-gray-700">No group overview available</p>
      <p className="text-xs text-gray-400 max-w-xs">
        This login isn&apos;t the parent of an outlet group, so there&apos;s no consolidated view to show.
      </p>
      <Link
        href="/partner/dashboard"
        className="mt-1 inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--brand-primary)] hover:underline"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to dashboard
      </Link>
    </div>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────────── */

export default function GroupOverviewPage() {
  const [data,    setData]    = useState<GroupWallet | null>(null);
  const [loading, setLoading] = useState(true);

  // Each additional section starts 'loading' and resolves independently, so a slow
  // or failed section never blocks the wallet-gated page shell.
  const [targets,     setTargets]     = useState<Loadable<GroupTargets>>('loading');
  const [visibility,  setVisibility]  = useState<Loadable<GroupVisibility>>('loading');
  const [leaderboard, setLeaderboard] = useState<Loadable<GroupLeaderboard>>('loading');

  useEffect(() => {
    let cancelled = false;

    // Wallet governs the page shell (loading / no-group empty state).
    api.get<GroupWallet>('/api/partner/group/wallet')
      .then((res) => {
        if (cancelled) return;
        // Only a successful envelope carrying a usable shape becomes state; anything
        // else (network error, non-envelope) falls through to the no-group empty state.
        setData(res.success ? res.data : { available: false });
      })
      .catch(() => {
        if (!cancelled) setData({ available: false });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // The three roll-up sections fetch in parallel; each degrades to an unavailable
    // shape on any error so it simply hides / shows its own empty state (never a crash).
    api.get<GroupTargets>('/api/partner/group/targets')
      .then((res) => { if (!cancelled) setTargets(res.success ? res.data : { available: false }); })
      .catch(() => { if (!cancelled) setTargets({ available: false }); });

    api.get<GroupVisibility>('/api/partner/group/visibility')
      .then((res) => { if (!cancelled) setVisibility(res.success ? res.data : { available: false }); })
      .catch(() => { if (!cancelled) setVisibility({ available: false }); });

    api.get<GroupLeaderboard>('/api/partner/group/leaderboard')
      .then((res) => { if (!cancelled) setLeaderboard(res.success ? res.data : { available: false }); })
      .catch(() => { if (!cancelled) setLeaderboard({ available: false }); });

    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-48">
        <Spinner size="lg" />
      </div>
    );
  }

  // No group → friendly empty state (never a crash, never redeem controls).
  if (!data || data.available === false) {
    return (
      <div className="space-y-5 fade-in">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Group Overview</h1>
        </div>
        <NoGroupState />
      </div>
    );
  }

  const { parent, totals, conversionRate, outlets } = data;

  return (
    <div className="space-y-5 fade-in">
      {/* Header + read-only badge */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-gray-900 truncate">
            Group Overview — {parent.businessName}
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">{parent.ownerName}</p>
        </div>
        <span
          data-testid="read-only-badge"
          className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-500"
        >
          <Lock className="h-3 w-3" />
          Read-only
        </span>
      </div>

      {/* Consolidated wallet totals */}
      <GroupTotalsCard totals={totals} conversionRate={conversionRate} />

      {/* Wallet: per-outlet roll-up */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-4 pt-3 pb-2 border-b border-gray-50 flex items-center justify-between">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
            Outlets in group
          </p>
          <span className="text-[10px] text-gray-400">{outlets.length} outlets</span>
        </div>

        {outlets.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12">
            <Layers className="h-8 w-8 text-gray-200" />
            <p className="text-sm text-gray-400">No outlets in this group yet</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {outlets.map((o) => (
              <OutletRow key={o.outletCode} outlet={o} conversionRate={conversionRate} />
            ))}
          </div>
        )}
      </div>

      {/* Additional read-only roll-ups. Each owns its loading / empty / hidden state. */}
      <TargetsSection state={targets} />
      <VisibilitySection state={visibility} />
      <LeaderboardSection state={leaderboard} />

      {/* Read-only helper note */}
      <p className="text-[11px] text-gray-400 text-center px-6">
        Read-only consolidated view — redemption, capture &amp; scoring happen per outlet.
      </p>
    </div>
  );
}
