'use client';

/* ─── Admin KYC Dashboard (REAL data) ───────────────────────────────────────────
   100% wired to GET /api/admin/dashboard/kyc (proxy → backend /v1/admin/dashboard/kyc).
   Every number on this page comes from that endpoint — there are NO hardcoded metric
   constants or fabricated arrays. If the fetch fails or returns nothing, an explicit
   error / empty state is shown (never a mock fallback). Auth follows the same
   authHeader() + fetch + useEffect/useState pattern as /admin/dashboard/page.tsx.
──────────────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Store, Clock, CheckCircle, XCircle,
  AlertTriangle, AlertCircle, TrendingUp,
  Eye, Slash, Loader2,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { authHeader } from '@/lib/api-client';

// "All programs" sentinel = empty string (no filter). Real programNames are never blank, so '' is a
// safe sentinel — a program literally named "ALL" now filters correctly. The option list comes from
// the endpoint's `availablePrograms` (real distinct outlet.programName values), so every option
// matches data the filter can actually hit.
const ALL_PROGRAMS = '';

const DARK_NAVY = '#1A1A2E';

/* ─── API response model (precise to the endpoint contract) ─────────────────── */

interface CoverageRow {
  key: string;
  addressable: number;
  approved: number;
  coveragePct: number;
}

interface SlaBucket {
  count: number;
  withinSla: number;
  breached: number;
  slaHours: number;
}

interface KycDashboardData {
  scope: { tenant: string; generatedAt: string };
  availablePrograms: string[];
  universe: { addressableOutlets: number; notInterested: number; inactive: number };
  headline: {
    coveragePct: number;
    approved: number;
    inPipeline: number;
    pendingField: number;
    awaitingGifsy: number;
    rejectedOrReupload: number;
    notStarted: number;
    approvalRatePct: number;
  };
  funnel: { stage: string; count: number }[];
  buckets: {
    pendingFieldApproval: SlaBucket;
    pendingGifsyApproval: SlaBucket;
  };
  sla: {
    endToEndAvgHours: number;
    fieldChainAvgHours: number;
    gifsyReviewAvgHours: number;
    fieldCompliancePct: number;
    gifsyCompliancePct: number;
    sampleSize: number;
  };
  quality: {
    topRejectionReasons: { reason: string; count: number }[];
    reUploadRatePct: number;
  };
  coverageBy: {
    state: CoverageRow[];
    outletType: CoverageRow[];
    program: CoverageRow[];
  };
}

/* ─── Formatting helpers ─────────────────────────────────────────────────────── */

const fmtInt = (n: number) => n.toLocaleString('en-IN');
const fmtPct = (n: number) => `${n.toFixed(1)}%`;

function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// SLA health chip: green if avg <= target, amber if <= 1.5×target, red otherwise.
function slaChip(avg: number, target: number): { label: string; cls: string } {
  if (avg <= target) return { label: 'On Track', cls: 'bg-green-100 text-green-700' };
  if (avg <= target * 1.5) return { label: 'At Risk', cls: 'bg-amber-100 text-amber-700' };
  return { label: 'Breached', cls: 'bg-red-100 text-red-700' };
}

/* ─── Small presentational pieces (chrome only, fully prop-driven) ──────────── */

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
  valColor: string;
}

function StatCard({ label, value, sub, icon: Icon, iconBg, iconColor, valColor }: StatCardProps) {
  return (
    <Card className="border border-gray-100 shadow-sm rounded-2xl">
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-sm text-gray-500">{label}</p>
            <p className={`text-3xl font-bold mt-1 ${valColor}`}>{value}</p>
            {sub && <p className="text-[11px] text-gray-400 mt-1">{sub}</p>}
          </div>
          <div className={`p-3 rounded-xl ${iconBg} shrink-0`}>
            <Icon className={`w-6 h-6 ${iconColor}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const REASON_PALETTE = ['#ef4444', '#f97316', '#f59e0b', '#8b5cf6', '#6366f1', '#0891b2'];

const COVERAGE_TABS: { key: keyof KycDashboardData['coverageBy']; label: string }[] = [
  { key: 'state',      label: 'By State' },
  { key: 'outletType', label: 'By Outlet Type' },
  { key: 'program',    label: 'By Program' },
];

function coverageColor(pct: number): string {
  if (pct >= 90) return '#16a34a';
  if (pct >= 70) return '#f59e0b';
  return '#ef4444';
}

/* ─── Bottleneck bucket card ─────────────────────────────────────────────────── */

function BucketCard({ title, bucket }: { title: string; bucket: SlaBucket }) {
  const total = bucket.count || 1;
  const withinW = (bucket.withinSla / total) * 100;
  const breachedW = (bucket.breached / total) * 100;
  return (
    <div className="rounded-xl border border-gray-100 bg-white px-4 py-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-gray-700">{title}</span>
        <span className="text-[11px] font-semibold text-gray-400">SLA: {bucket.slaHours}h</span>
      </div>
      <p className="text-3xl font-bold text-gray-900">{fmtInt(bucket.count)}</p>
      <p className="text-[11px] text-gray-400 mt-0.5">awaiting action</p>

      {/* stacked bar: within-SLA (green) vs breached (red) */}
      <div className="h-2.5 w-full bg-gray-100 rounded-full overflow-hidden flex mt-3">
        <div className="h-full bg-green-500" style={{ width: `${withinW}%` }} />
        <div className="h-full bg-red-500" style={{ width: `${breachedW}%` }} />
      </div>
      <div className="flex items-center justify-between mt-2 text-[11px]">
        <span className="font-semibold text-green-600">{fmtInt(bucket.withinSla)} within SLA</span>
        <span className="font-semibold text-red-500">{fmtInt(bucket.breached)} breached</span>
      </div>
    </div>
  );
}

/* ─── SLA tile ───────────────────────────────────────────────────────────────── */

function SlaTile({
  label, avg, target, compliancePct, footer,
}: {
  label: string;
  avg: number;
  target: number | null;
  compliancePct: number | null;
  footer: string;
}) {
  const chip = target !== null ? slaChip(avg, target) : null;
  return (
    <div className="bg-gray-50 border border-gray-100 rounded-xl px-4 py-4 flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-600">{label}</span>
        {chip && (
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${chip.cls}`}>
            {chip.label}
          </span>
        )}
      </div>
      <p className="text-3xl font-bold text-gray-900">{avg.toFixed(1)}h</p>
      {compliancePct !== null && (
        <p className="text-[11px] text-gray-500">{fmtPct(compliancePct)} within SLA</p>
      )}
      <p className="text-[10px] text-gray-400">{footer}</p>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function AdminKycDashboardPage() {
  const [data, setData] = useState<KycDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<keyof KycDashboardData['coverageBy']>('state');

  // Program filter (default = all programs). Options come from the endpoint's availablePrograms
  // (real distinct outlet.programName values), so every option matches data the filter can hit.
  const [programName, setProgramName] = useState<string>(ALL_PROGRAMS);
  const programOptions = data?.availablePrograms ?? [];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Only append the param for a real selection ('' = All programs = no filter).
    const url = programName
      ? `/api/admin/dashboard/kyc?programName=${encodeURIComponent(programName)}`
      : '/api/admin/dashboard/kyc';
    fetch(url, { headers: { ...authHeader() } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        const json: unknown = await r.json();
        // The endpoint may return the bare shape or wrap it as { success, data }.
        const payload = (json && typeof json === 'object' && 'data' in json)
          ? (json as { data: KycDashboardData }).data
          : (json as KycDashboardData);
        if (!payload || typeof payload !== 'object' || !('headline' in payload)) {
          throw new Error('Empty or malformed response');
        }
        if (!cancelled) setData(payload);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load KYC dashboard');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [programName]);

  const funnelMax = useMemo(
    () => (data && data.funnel.length ? Math.max(...data.funnel.map((s) => s.count), 1) : 1),
    [data],
  );

  const coverageRows = data ? data.coverageBy[activeTab] : [];

  // A refetch is in flight while the dashboard is already showing (program switch) → keep the
  // dashboard rendered and show a small inline indicator, instead of blanking to a full-page spinner.
  const refetching = loading && !!data;

  /* ── Program filter — shared across loading / error / content so it stays usable
        (the selected program scopes the ENTIRE dashboard; default = All programs). ── */
  const programFilter = (
    <div className="flex items-center gap-2">
      {refetching && (
        <span className="flex items-center gap-1 text-[11px] text-gray-400" data-testid="kyc-dashboard-refetching">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Updating…
        </span>
      )}
      <label htmlFor="kyc-program-filter" className="text-xs font-medium text-gray-500">
        Program
      </label>
      <select
        id="kyc-program-filter"
        data-testid="kyc-program-filter"
        aria-label="Program"
        value={programName}
        onChange={(e) => setProgramName(e.target.value)}
        className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-800 bg-white focus:outline-none focus:border-[var(--brand-primary)]"
      >
        <option value={ALL_PROGRAMS}>All programs</option>
        {programOptions.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>
    </div>
  );

  /* ── Initial loading state (full-page spinner ONLY before the first payload). A refetch on a
        program switch keeps the current dashboard visible with the inline "Updating…" indicator. ── */
  if (loading && !data) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: DARK_NAVY }}>
            KYC Dashboard
          </h1>
          {programFilter}
        </div>
        <div className="flex flex-col items-center justify-center py-32 text-gray-400" data-testid="kyc-dashboard-loading">
          <Loader2 className="w-8 h-8 animate-spin mb-3" />
          <p className="text-sm">Loading KYC dashboard…</p>
        </div>
      </div>
    );
  }

  /* ── Error / empty state — NEVER fabricated numbers ── */
  if (error || !data) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: DARK_NAVY }}>
            KYC Dashboard
          </h1>
          {programFilter}
        </div>
        <Card className="border border-red-100 shadow-sm rounded-2xl" data-testid="kyc-dashboard-error">
          <CardContent className="py-12 flex flex-col items-center text-center gap-2">
            <AlertCircle className="w-8 h-8 text-red-500" />
            <p className="text-sm font-semibold text-red-600">Couldn&apos;t load the KYC dashboard</p>
            <p className="text-xs text-gray-500 max-w-md">
              {error ?? 'No data was returned by the server.'} Please refresh or try again later.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { scope, universe, headline, funnel, buckets, sla, quality, coverageBy } = data;
  const reasonMax = quality.topRejectionReasons.length
    ? Math.max(...quality.topRejectionReasons.map((r) => r.count), 1)
    : 1;

  /* ── Empty state: a specific program is selected but it has no addressable outlets. Show a light
        note (header + Program filter stay visible so the user can switch back) rather than a whole
        dashboard of zeros. Not shown for "All programs" (a genuinely empty tenant renders normally). ── */
  if (programName && universe.addressableOutlets === 0) {
    return (
      <div className="space-y-6" data-testid="kyc-dashboard">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: DARK_NAVY }}>
              KYC Dashboard
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              {scope.tenant} · Outlet onboarding &amp; verification coverage
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            {programFilter}
            <p className="text-xs text-gray-400">as of {fmtTimestamp(scope.generatedAt)}</p>
          </div>
        </div>
        <Card className="border border-gray-100 shadow-sm rounded-2xl" data-testid="kyc-dashboard-empty">
          <CardContent className="py-12 flex flex-col items-center text-center gap-2">
            <Store className="w-8 h-8 text-gray-300" />
            <p className="text-sm font-semibold text-gray-600">No outlets found for this program.</p>
            <p className="text-xs text-gray-400 max-w-md">
              No addressable outlets are tagged to “{programName}”. Pick another program or switch back to All programs.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="kyc-dashboard">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: DARK_NAVY }}>
            KYC Dashboard
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {scope.tenant} · Outlet onboarding &amp; verification coverage
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {programFilter}
          <p className="text-xs text-gray-400">as of {fmtTimestamp(scope.generatedAt)}</p>
        </div>
      </div>

      {/* ── Headline stat cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard
          label="KYC Coverage"
          value={fmtPct(headline.coveragePct)}
          sub={`${fmtInt(headline.approved)} / ${fmtInt(universe.addressableOutlets)} approved`}
          icon={CheckCircle} iconBg="bg-green-100" iconColor="text-green-700" valColor="text-green-700"
        />
        <StatCard
          label="In Pipeline"
          value={fmtInt(headline.inPipeline)}
          sub="submitted, not yet approved"
          icon={Clock} iconBg="bg-blue-100" iconColor="text-blue-600" valColor="text-blue-700"
        />
        <StatCard
          label="Awaiting Gifsy"
          value={fmtInt(headline.awaitingGifsy)}
          sub="pending Gifsy approval"
          icon={Eye} iconBg="bg-purple-100" iconColor="text-purple-600" valColor="text-purple-700"
        />
        <StatCard
          label="Pending Field"
          value={fmtInt(headline.pendingField)}
          sub="pending field approval"
          icon={AlertTriangle} iconBg="bg-amber-100" iconColor="text-amber-600" valColor="text-amber-700"
        />
        <StatCard
          label="Rejected / Re-upload"
          value={fmtInt(headline.rejectedOrReupload)}
          sub="needs correction"
          icon={XCircle} iconBg="bg-red-100" iconColor="text-red-600" valColor="text-red-700"
        />
        <StatCard
          label="Not Interested"
          value={fmtInt(universe.notInterested)}
          sub={`${fmtInt(universe.inactive)} inactive in universe`}
          icon={Slash} iconBg="bg-gray-100" iconColor="text-gray-500" valColor="text-gray-700"
        />
      </div>

      {/* ── Approval Funnel ── */}
      <Card className="border border-gray-100 shadow-sm rounded-2xl">
        <CardHeader>
          <CardTitle>KYC Pipeline</CardTitle>
          <p className="text-xs text-gray-400 mt-0.5">
            Where every addressable outlet stands today (% of {fmtInt(universe.addressableOutlets)} addressable) · {fmtPct(headline.approvalRatePct)} approval rate
          </p>
        </CardHeader>
        <CardContent className="pb-5 space-y-3">
          {funnel.length === 0 && (
            <p className="text-xs text-gray-400">No funnel data available.</p>
          )}
          {funnel.map((step) => {
            const barW = (step.count / funnelMax) * 100;
            const share = universe.addressableOutlets > 0
              ? (step.count / universe.addressableOutlets) * 100
              : 0;
            return (
              <div key={step.stage} className="flex items-center gap-3">
                <span className="text-xs font-medium text-gray-600 w-44 shrink-0">{step.stage}</span>
                <div className="flex-1 h-6 bg-gray-100 rounded-lg overflow-hidden flex items-center">
                  <div
                    className="h-full rounded-lg flex items-center justify-end pr-2 transition-all min-w-[2.5rem]"
                    style={{ width: `${barW}%`, backgroundColor: 'var(--brand-primary)' }}
                  >
                    <span className="text-[10px] font-bold text-white whitespace-nowrap">
                      {fmtInt(step.count)}
                    </span>
                  </div>
                </div>
                <span className="text-[10px] text-gray-400 w-12 shrink-0 text-right">{fmtPct(share)}</span>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* ── Bottleneck buckets + SLA ── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

        {/* Bottlenecks (2 cols) */}
        <Card className="lg:col-span-2 border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader>
            <CardTitle>Approval Bottlenecks</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">Within-SLA vs breached, per approval stage · business hours (Mon–Fri)</p>
          </CardHeader>
          <CardContent className="pb-5 space-y-4">
            <BucketCard title="Pending Field Approval" bucket={buckets.pendingFieldApproval} />
            <BucketCard title="Pending Gifsy Approval" bucket={buckets.pendingGifsyApproval} />
          </CardContent>
        </Card>

        {/* SLA panel (3 cols) */}
        <Card className="lg:col-span-3 border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader>
            <CardTitle>Processing SLA</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">
              Average turnaround across {fmtInt(sla.sampleSize)} processed submissions · field target 24h · Gifsy target 96h · business hours (Mon–Fri)
            </p>
          </CardHeader>
          <CardContent className="pb-6">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <SlaTile
                label="End-to-end avg"
                avg={sla.endToEndAvgHours}
                target={null}
                compliancePct={null}
                footer={`n = ${fmtInt(sla.sampleSize)} processed`}
              />
              <SlaTile
                label="Field-chain avg"
                avg={sla.fieldChainAvgHours}
                target={24}
                compliancePct={sla.fieldCompliancePct}
                footer="target 24 business hrs"
              />
              <SlaTile
                label="Gifsy-review avg"
                avg={sla.gifsyReviewAvgHours}
                target={96}
                compliancePct={sla.gifsyCompliancePct}
                footer="target 96 business hrs"
              />
            </div>
            <div className="flex items-center gap-1.5 mt-4 text-[11px] text-gray-400">
              <TrendingUp className="w-3.5 h-3.5" />
              Green ≤ target · amber ≤ 1.5× target · red otherwise · targets are business hours (Mon–Fri, excl. national holidays)
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Quality: rejection reasons + re-upload rate ── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

        {/* Rejection reasons (3 cols) */}
        <Card className="lg:col-span-3 border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader>
            <CardTitle>Top Rejection Reasons</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">Why outlets get rejected or asked to re-upload</p>
          </CardHeader>
          <CardContent className="pb-5 space-y-4">
            {quality.topRejectionReasons.length === 0 && (
              <p className="text-xs text-gray-400">No rejections recorded.</p>
            )}
            {quality.topRejectionReasons.map((r, i) => {
              const barW = (r.count / reasonMax) * 100;
              return (
                <div key={r.reason}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-gray-700">{r.reason}</span>
                    <span className="text-xs font-bold text-gray-500 ml-3 shrink-0">{fmtInt(r.count)}</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${barW}%`, backgroundColor: REASON_PALETTE[i % REASON_PALETTE.length] }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* Re-upload rate (2 cols) */}
        <Card className="lg:col-span-2 border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader>
            <CardTitle>Re-upload Rate</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">Share of submissions sent back for re-upload</p>
          </CardHeader>
          <CardContent className="pb-6 flex flex-col items-center justify-center gap-2 py-6">
            <Store className="w-7 h-7 text-amber-500" />
            <p className="text-4xl font-bold text-amber-600">{fmtPct(quality.reUploadRatePct)}</p>
            <p className="text-xs text-gray-500">of submissions required a re-upload</p>
          </CardContent>
        </Card>
      </div>

      {/* ── Coverage breakdown (tabbed table) ── */}
      <Card className="border border-gray-100 shadow-sm rounded-2xl">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Coverage Breakdown</CardTitle>
              <p className="text-xs text-gray-400 mt-0.5">Approved vs addressable outlets, by dimension</p>
            </div>
            <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1" role="tablist">
              {COVERAGE_TABS.map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={activeTab === t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-md transition-colors ${
                    activeTab === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="pb-5">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 font-semibold text-gray-500 text-xs">
                    {COVERAGE_TABS.find((t) => t.key === activeTab)?.label.replace('By ', '')}
                  </th>
                  <th className="text-right py-2 font-semibold text-gray-500 text-xs">Approved / Addressable</th>
                  <th className="py-2 font-semibold text-gray-500 text-xs w-48">Coverage</th>
                </tr>
              </thead>
              <tbody>
                {coverageRows.length === 0 && (
                  <tr>
                    <td colSpan={3} className="py-6 text-center text-xs text-gray-400">
                      No coverage data for this dimension.
                    </td>
                  </tr>
                )}
                {coverageRows.map((row, i) => (
                  <tr key={row.key} className={`border-b border-gray-50 ${i % 2 === 0 ? '' : 'bg-gray-50/40'}`}>
                    <td className="py-2.5 font-medium text-gray-800 text-xs">{row.key}</td>
                    <td className="py-2.5 text-right text-gray-500 text-xs">
                      {fmtInt(row.approved)} / {fmtInt(row.addressable)}
                    </td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${Math.min(row.coveragePct, 100)}%`, backgroundColor: coverageColor(row.coveragePct) }}
                          />
                        </div>
                        <span
                          className="text-xs font-bold w-12 text-right shrink-0"
                          style={{ color: coverageColor(row.coveragePct) }}
                        >
                          {fmtPct(row.coveragePct)}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
