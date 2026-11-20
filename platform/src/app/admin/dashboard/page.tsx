'use client';

import React, { useState, useMemo, useEffect } from 'react';
import {
  Users,
  Clock,
  Eye,
  TrendingUp,
  CheckCircle2,
  AlertCircle,
  Banknote,
  Loader2,
} from 'lucide-react';
import { authHeader } from '@/lib/api-client';
import {
  useDashboardProgram, withProgramParam, isTenantWideMetric, MIN_PROGRAMS_FOR_FILTER,
} from '@/lib/dashboard-program';
import { ProgramFilter, TenantWideNote } from '@/components/admin/dashboard/ProgramFilter';
import { liabilitySplitNote } from '@/lib/wallet-negative';
import { BillingProgressCard } from '@/components/admin/dashboard/BillingProgressCard';
import { monthLabel, monthOptions } from '@/lib/visibility-report';

/* ─── KPI card data ──────────────────────────────────────────────────────────── */

// KPI card chrome (label/icon/colors). Values come from the live /admin/dashboard/kpis endpoint;
// no mock bases (the old 4821/214/… were fabricated, #40/#47). "Fund Available Balance" was dropped —
// the payout fund is GIFSY-only (Q1), not a tenant KPI. MoM/YoY trend deltas need time-series we don't
// aggregate yet, so they're omitted here rather than faked (analytics deferred to P8).
interface KpiMeta {
  /** Response key — also the `notProgramScoped` key for the "Tenant-wide" note. */
  key:   'activePartners' | 'pendingKyc' | 'pendingVisibility' | 'totalRedeemablePoints';
  label: string;
  icon:  React.ElementType;
  color: string;
  border: string;
}

const KPI_META: KpiMeta[] = [
  { key: 'activePartners',        label: 'Total Active Partners',        icon: Users,      color: 'bg-blue-50 text-blue-600',     border: 'border-blue-100'   },
  { key: 'pendingKyc',            label: 'Pending KYC',                  icon: Clock,      color: 'bg-amber-50 text-amber-600',   border: 'border-amber-100'  },
  { key: 'pendingVisibility',     label: 'Pending Visibility Approvals', icon: Eye,        color: 'bg-purple-50 text-purple-600', border: 'border-purple-100' },
  { key: 'totalRedeemablePoints', label: 'Total Points Liability',       icon: TrendingUp, color: 'bg-red-50 text-red-600',       border: 'border-red-100'    },
];

/* ─── Payout summary chrome ──────────────────────────────────────────────────── */
// Counts/amounts are overlaid from the live KPI endpoint (payoutSummary). The chrome
// below is label/icon/colour only — never a fabricated count.
const payoutSummary = [
  { label: 'Completed', count: 0, amount: '₹0.0L', icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200' },
  { label: 'Pending',   count: 0, amount: '₹0.0L', icon: Clock,        color: 'text-amber-600',   bg: 'bg-amber-50',   border: 'border-amber-200'   },
  { label: 'Failed',    count: 0, amount: '₹0.0L', icon: AlertCircle,  color: 'text-red-500',     bg: 'bg-red-50',     border: 'border-red-200'     },
];

/* ─── API types ──────────────────────────────────────────────────────────────── */

interface ApiKpiData {
  activePartners:        number;
  pendingKyc:            number;
  pendingVisibility:     number;
  /**
   * PHOTO_APPROVAL tenants with visibility ON (else null / absent). pendingVisibility = EVERY capture still waiting
   * for review, any month (Gifsy's whole queue). This block: the picked month (default current IST month) and its
   * share of that queue, the part from earlier months, what waits on reps (open windows only) and the re-takes left
   * when the window closed ("Not approved — window closed").
   */
  visibility?: {
    month: string;
    waiting: number;
    waitingAllMonths?: number;
    waitingEarlierMonths?: number;
    needsRetake: number;
    rejected?: number;
    waitingOnReps?: number;
    closedNotApproved?: number;
  } | null;
  totalRedeemablePoints: number;
  /** Owner D1/D2 (2026-11-19): Σ |negative balances| + how many wallets — reported apart from the liability. */
  totalOwedPoints?:      number;
  owedWallets?:          number;
  payoutSummary:         Record<string, { count: number; amountPaise: number }>;
  /** Real distinct Outlet.programName values (dropdown source). Older API: absent → []. */
  availablePrograms?:    string[];
  /** Metric keys that stay tenant-wide when a program is selected. Older API: absent → []. */
  notProgramScoped?:     string[];
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function DashboardPage() {
  // Live KPIs from the API — the only source for the cards. No mock fallback (was 4821/214/…).
  const [liveKpis, setLiveKpis] = useState<ApiKpiData | null>(null);
  const [kpiLoading, setKpiLoading] = useState(true);
  const [kpiError, setKpiError] = useState<string | null>(null);
  // Shared dashboard program ('' = All programs → the request is byte-identical to before).
  const programState = useDashboardProgram();
  const { program, ready: programReady, setProgram, reconcile } = programState;
  // Last-known program list — kept across a failed refetch so the person can still switch back.
  const [programOptions, setProgramOptions] = useState<string[]>([]);
  // Pending Visibility Approvals month ('' = the server default, the current IST month → URL unchanged).
  const [visMonth, setVisMonth] = useState('');
  const visMonths = useMemo(() => monthOptions(), []);

  useEffect(() => {
    if (!programReady) return;
    let cancelled = false;
    let dropped = false; // response discarded because its program isn't usable → a fresh fetch follows
    setKpiLoading(true);
    setKpiError(null);
    const kpisUrl = withProgramParam('/api/admin/dashboard/kpis', program);
    const url = visMonth ? `${kpisUrl}${kpisUrl.includes('?') ? '&' : '?'}visibilityMonth=${encodeURIComponent(visMonth)}` : kpisUrl;
    fetch(url, { headers: { ...authHeader() } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json();
      })
      .then((json) => {
        if (cancelled) return;
        if (!json?.success || !json.data) throw new Error('No data was returned by the server.');
        const data = json.data as ApiKpiData;
        const available = Array.isArray(data.availablePrograms) ? data.availablePrograms : [];
        setProgramOptions(available);
        if (!reconcile(program, available)) { dropped = true; return; }
        setLiveKpis(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Never leave another program's numbers on screen under the new selection.
        setLiveKpis(null);
        setKpiError(err instanceof Error && err.message ? err.message : 'Failed to load key metrics.');
      })
      .finally(() => { if (!cancelled && !dropped) setKpiLoading(false); });
    return () => { cancelled = true; };
  }, [program, programReady, reconcile, visMonth]);

  const kpiRefetching = kpiLoading && !!liveKpis;
  const tenantWide = (key: string) => isTenantWideMetric(program, liveKpis?.notProgramScoped, key);
  // A program that is ACTIVE keeps the filter on screen even if /kpis failed (never a hidden filter).
  const showProgramUi = programOptions.length >= MIN_PROGRAMS_FOR_FILTER || !!programState.droppedProgram || !!program;

  // Build the cards from real data; '—' until the endpoint responds (never a fabricated number).
  const displayedKpiCards = useMemo(() => {
    const fmt = (n: number) => n.toLocaleString('en-IN');
    return KPI_META.map((meta, i) => {
      let value = '—';
      if (liveKpis) {
        if (i === 0) value = fmt(liveKpis.activePartners);
        else if (i === 1) value = fmt(liveKpis.pendingKyc);
        else if (i === 2) value = fmt(liveKpis.pendingVisibility);
        else if (i === 3) value = `₹${(liveKpis.totalRedeemablePoints / 10_000_000).toFixed(2)} Cr`;
      }
      return { ...meta, value };
    });
  }, [liveKpis]);

  // Overlay real payout counts/amounts (groups by raw DB status)
  const displayedPayoutSummary = useMemo(() => {
    if (!liveKpis?.payoutSummary) return payoutSummary;
    const ps = liveKpis.payoutSummary;
    const sum = (keys: string[], field: 'count' | 'amountPaise') =>
      keys.reduce((acc, k) => acc + (ps[k]?.[field] ?? 0), 0);
    const fmtL = (p: number) => `₹${(p / 10_000_000).toFixed(1)}L`;
    return [
      { ...payoutSummary[0], count: sum(['PAID', 'COMPLETED'], 'count'),                        amount: fmtL(sum(['PAID', 'COMPLETED'], 'amountPaise'))                        },
      { ...payoutSummary[1], count: sum(['PENDING', 'INITIATED', 'PROCESSING'], 'count'),        amount: fmtL(sum(['PENDING', 'INITIATED', 'PROCESSING'], 'amountPaise'))        },
      { ...payoutSummary[2], count: sum(['FAILED', 'REVERSED'], 'count'),                        amount: fmtL(sum(['FAILED', 'REVERSED'], 'amountPaise'))                        },
    ];
  }, [liveKpis]);

  return (
    <div className="space-y-5 fade-in">

      {/* ── KPI Cards (real — /admin/dashboard/kpis, #47) ─────────────────────── */}
      <div className="space-y-3">
        {showProgramUi ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Key Metrics</p>
            <div className="flex items-center gap-2 flex-wrap justify-end min-w-0">
              {kpiRefetching && (
                <span className="flex items-center gap-1 text-[11px] text-gray-400" data-testid="overview-refetching">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Updating…
                </span>
              )}
              <ProgramFilter
                id="overview-program-filter"
                testId="overview-program-filter"
                programs={programOptions}
                value={program}
                onChange={setProgram}
                droppedProgram={programState.droppedProgram}
                onDismissDropped={programState.dismissDropped}
              />
            </div>
          </div>
        ) : (
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Key Metrics</p>
        )}

        {kpiError && (
          <div
            role="alert"
            data-testid="overview-kpis-error"
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
          >
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            <span>Couldn&apos;t load key metrics — {kpiError} Please refresh or try again later.</span>
          </div>
        )}

        <div
          className={`grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 transition-opacity ${kpiRefetching ? 'opacity-60' : ''}`}
          aria-busy={kpiRefetching || undefined}
        >
          {displayedKpiCards.map((card) => {
            const Icon = card.icon;
            return (
              <div
                key={card.label}
                className={`bg-white rounded-xl border ${card.border} p-4 flex flex-col gap-3 hover:shadow-md transition-shadow`}
              >
                <div className="flex items-center justify-between">
                  <div className={`p-2 rounded-lg ${card.color}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                </div>
                <div>
                  <p className="text-2xl font-bold text-gray-900">{card.value}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{card.label}</p>
                  {card.key === 'pendingVisibility' && liveKpis?.visibility && (
                    <div className="mt-1 space-y-1" data-testid="kpi-visibility-month">
                      <p className="text-[11px] text-gray-600" data-testid="kpi-visibility-waiting">
                        Waiting for review, all months
                        {(liveKpis.visibility.waitingEarlierMonths ?? 0) > 0
                          ? ` · ${liveKpis.visibility.waitingEarlierMonths!.toLocaleString('en-IN')} from earlier months`
                          : ''}
                        {` · ${liveKpis.visibility.waiting.toLocaleString('en-IN')} from ${monthLabel(liveKpis.visibility.month)}`}
                      </p>
                      <p className="text-[11px] text-orange-700" data-testid="kpi-visibility-retake">
                        Waiting on reps (window still open), {monthLabel(liveKpis.visibility.month)}:{' '}
                        {(liveKpis.visibility.waitingOnReps ?? liveKpis.visibility.needsRetake).toLocaleString('en-IN')}
                      </p>
                      {(liveKpis.visibility.closedNotApproved ?? 0) > 0 && (
                        <p className="text-[11px] text-red-700" data-testid="kpi-visibility-closed">
                          Not approved — window closed: {liveKpis.visibility.closedNotApproved!.toLocaleString('en-IN')}
                        </p>
                      )}
                      <select
                        aria-label="Visibility approvals month"
                        value={visMonth || liveKpis.visibility.month}
                        onChange={(e) => setVisMonth(e.target.value)}
                        className="border border-gray-200 rounded-md px-2 py-0.5 text-[11px] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
                      >
                        {visMonths.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                    </div>
                  )}
                  {tenantWide(card.key) && <TenantWideNote className="mt-1" />}
                  {card.key === 'totalRedeemablePoints' && liveKpis && liabilitySplitNote(liveKpis.totalOwedPoints, liveKpis.owedWallets) && (
                    <p data-testid="kpi-liability-split" className="text-[11px] text-amber-700 mt-1">
                      {liabilitySplitNote(liveKpis.totalOwedPoints, liveKpis.owedWallets)}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Payout Summary (real — overlaid from the KPI endpoint) ────────────── */}
      <div className={`bg-white rounded-xl border border-gray-200 px-5 py-4 transition-opacity ${kpiRefetching ? 'opacity-60' : ''}`}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1.5">
            <Banknote className="w-4 h-4 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-800">Payout Summary</h3>
            {tenantWide('payoutSummary') && <TenantWideNote className="ml-1" />}
          </div>
          <a href="/admin/payouts" className="text-xs text-[var(--brand-primary)] hover:text-[var(--brand-primary-dark)] font-medium">
            Manage →
          </a>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {displayedPayoutSummary.map((p) => {
            const Icon = p.icon;
            return (
              <div key={p.label} className={`rounded-lg border ${p.border} ${p.bg} px-3 py-2.5`}>
                <div className="flex items-center gap-1 mb-1">
                  <Icon className={`w-3 h-3 ${p.color}`} />
                  <span className={`text-[10px] font-semibold ${p.color}`}>{p.label}</span>
                </div>
                <p className="text-sm font-bold text-gray-900">{p.amount}</p>
                <p className="text-[10px] text-gray-400 mt-0.5">{p.count.toLocaleString('en-IN')} txns</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Monthly billing progress (real — /admin/dashboard/billing-progress) ── */}
      <BillingProgressCard programState={programState} />
    </div>
  );
}
