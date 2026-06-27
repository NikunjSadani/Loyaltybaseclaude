'use client';

/* ─── Admin Program Health Dashboard (REAL data) ─────────────────────────────────
   100% wired to GET /api/admin/dashboard/program-health (proxy → backend
   /v1/admin/dashboard/program-health). Every number on this page comes from that
   endpoint — there are NO hardcoded metric constants or fabricated arrays. If the
   fetch fails or returns nothing, an explicit error / empty state is shown (never a
   mock fallback). Auth follows the same authHeader() + fetch + useEffect/useState
   pattern as /admin/dashboards/kyc/page.tsx.
──────────────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Coins, Gift, TrendingUp, Target,
  AlertCircle, Loader2, Activity, Hourglass, ArrowDownCircle,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { authHeader } from '@/lib/api-client';

const DARK_NAVY = '#1A1A2E';

/* ─── API response model (precise to the endpoint contract — no `any`) ───────── */

interface TrendPoint { month: string; activeEarners: number; }

interface KpiRow {
  kpiCode: string;
  kpiName: string;
  unit: string;
  target: number;
  achieved: number;
  pct: number | null;
  isPrimary: boolean;
}

interface ByModeRow { mode: string; count: number; points: number; valueRupees: number; }
interface FulfilmentRow { status: string; count: number; }

interface ProgramHealthData {
  scope: { tenant: string; generatedAt: string; period: string };
  activation: {
    registered: number;
    kycApproved: number;
    firstEarn: number;
    firstRedeem: number;
    medianTimeToActivateDays: number;
  };
  participation: {
    addressable: number;
    activeEarnersThisMonth: number;
    activeRatePct: number;
    trend: TrendPoint[];
  };
  pointsEconomy: {
    issued: number;
    redeemed: number;
    outstandingLiabilityPoints: number;
    outstandingLiabilityRupees: number;
    breakagePct: number;
    expiringIn30dPoints: number;
  };
  targetAchievement: {
    period: string;
    primary: KpiRow | null;
    kpis: KpiRow[];
  };
  redemptions: {
    period: string;
    byMode: ByModeRow[];
    fulfilment: FulfilmentRow[];
  };
}

/* ─── Formatting helpers ─────────────────────────────────────────────────────── */

const fmtInt = (n: number) => n.toLocaleString('en-IN');
const fmtPct = (n: number) => `${n.toFixed(1)}%`;
const fmtRupees = (n: number) =>
  `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** "2026-06" → "Jun '26" for compact chart/axis labels. */
function monthLabel(m: string): string {
  const [y, mm] = m.split('-');
  const abbr = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    Number(mm) - 1
  ] ?? mm;
  return `${abbr} '${(y ?? '').slice(2)}`;
}

function pctColor(pct: number): string {
  if (pct >= 90) return '#16a34a';
  if (pct >= 60) return '#f59e0b';
  return '#ef4444';
}

const MODE_LABEL: Record<string, string> = {
  GIFT_CARD: 'Gift Card',
  UPI: 'UPI',
  BANK_TRANSFER: 'Bank Transfer',
  PHYSICAL_GIFT: 'Physical Gift',
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  PROCESSING: 'Processing',
  DISPATCHED: 'Dispatched',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  RETURNED: 'Returned',
  FAILED: 'Failed',
};

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

/* ─── Activation funnel row ──────────────────────────────────────────────────── */

function FunnelRow({ stage, count, max, registered }: {
  stage: string; count: number; max: number; registered: number;
}) {
  const barW = max > 0 ? (count / max) * 100 : 0;
  const share = registered > 0 ? (count / registered) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-medium text-gray-600 w-40 shrink-0">{stage}</span>
      <div className="flex-1 h-6 bg-gray-100 rounded-lg overflow-hidden flex items-center">
        <div
          className="h-full rounded-lg flex items-center justify-end pr-2 transition-all min-w-[2.5rem]"
          style={{ width: `${barW}%`, backgroundColor: 'var(--brand-primary)' }}
        >
          <span className="text-[10px] font-bold text-white whitespace-nowrap">{fmtInt(count)}</span>
        </div>
      </div>
      <span className="text-[10px] text-gray-400 w-12 shrink-0 text-right">{fmtPct(share)}</span>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function AdminProgramHealthDashboardPage() {
  const [data, setData] = useState<ProgramHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/admin/dashboard/program-health', { headers: { ...authHeader() } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        const json: unknown = await r.json();
        // The endpoint may return the bare shape or wrap it as { success, data }.
        const payload = (json && typeof json === 'object' && 'data' in json)
          ? (json as { data: ProgramHealthData }).data
          : (json as ProgramHealthData);
        if (!payload || typeof payload !== 'object' || !('targetAchievement' in payload)) {
          throw new Error('Empty or malformed response');
        }
        if (!cancelled) setData(payload);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load program health');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const funnelMax = useMemo(
    () => (data ? Math.max(data.activation.registered, 1) : 1),
    [data],
  );
  const kpiBarMax = useMemo(
    () => (data
      ? Math.max(1, ...data.targetAchievement.kpis.map((k) => Math.max(k.target, k.achieved)))
      : 1),
    [data],
  );

  /* ── Loading state ── */
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-gray-400" data-testid="program-health-loading">
        <Loader2 className="w-8 h-8 animate-spin mb-3" />
        <p className="text-sm">Loading program health…</p>
      </div>
    );
  }

  /* ── Error / empty state — NEVER fabricated numbers ── */
  if (error || !data) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: DARK_NAVY }}>
            Program Health
          </h1>
        </div>
        <Card className="border border-red-100 shadow-sm rounded-2xl" data-testid="program-health-error">
          <CardContent className="py-12 flex flex-col items-center text-center gap-2">
            <AlertCircle className="w-8 h-8 text-red-500" />
            <p className="text-sm font-semibold text-red-600">Couldn&apos;t load program health</p>
            <p className="text-xs text-gray-500 max-w-md">
              {error ?? 'No data was returned by the server.'} Please refresh or try again later.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { scope, activation, participation, pointsEconomy, targetAchievement, redemptions } = data;
  const funnelStages = [
    { stage: 'Registered', count: activation.registered },
    { stage: 'KYC Approved', count: activation.kycApproved },
    { stage: 'First Earn', count: activation.firstEarn },
    { stage: 'First Redeem', count: activation.firstRedeem },
  ];
  const trendData = participation.trend.map((t) => ({ ...t, label: monthLabel(t.month) }));
  const redemptionModeMax = Math.max(1, ...redemptions.byMode.map((m) => m.count));
  const fulfilmentTotal = redemptions.fulfilment.reduce((s, f) => s + f.count, 0);

  return (
    <div className="space-y-6" data-testid="program-health-dashboard">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: DARK_NAVY }}>
            Program Health
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {scope.tenant} · Activation, participation, points economy &amp; target achievement · {monthLabel(scope.period)}
          </p>
        </div>
        <p className="text-xs text-gray-400">as of {fmtTimestamp(scope.generatedAt)}</p>
      </div>

      {/* ══ HERO: TARGET ACHIEVEMENT ══ */}
      <Card className="border-2 shadow-sm rounded-2xl" style={{ borderColor: 'var(--brand-primary)' }} data-testid="target-achievement">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Target className="w-5 h-5" style={{ color: 'var(--brand-primary)' }} />
            <CardTitle>Target Achievement</CardTitle>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            Achieved vs target across all addressable outlets for {monthLabel(targetAchievement.period)}
          </p>
        </CardHeader>
        <CardContent className="pb-6 space-y-6">

          {/* Primary KPI — big achieved-vs-target */}
          {targetAchievement.primary ? (
            <div className="rounded-xl bg-gray-50 border border-gray-100 px-5 py-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                    Primary KPI · {targetAchievement.primary.kpiName}
                  </p>
                  <p className="text-4xl font-bold mt-1 text-gray-900" data-testid="primary-kpi-achieved">
                    {fmtInt(targetAchievement.primary.achieved)}
                    <span className="text-lg font-medium text-gray-400">
                      {' '}/ {fmtInt(targetAchievement.primary.target)} {targetAchievement.primary.unit}
                    </span>
                  </p>
                </div>
                <div className="text-right">
                  <p
                    className="text-4xl font-bold"
                    style={{ color: targetAchievement.primary.pct !== null ? pctColor(targetAchievement.primary.pct) : '#9ca3af' }}
                    data-testid="primary-kpi-pct"
                  >
                    {targetAchievement.primary.pct !== null ? fmtPct(targetAchievement.primary.pct) : '—'}
                  </p>
                  <p className="text-[11px] text-gray-400">of target</p>
                </div>
              </div>
              <div className="h-3 w-full bg-gray-200 rounded-full overflow-hidden mt-4">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(targetAchievement.primary.pct ?? 0, 100)}%`,
                    backgroundColor: targetAchievement.primary.pct !== null ? pctColor(targetAchievement.primary.pct) : '#9ca3af',
                  }}
                />
              </div>
            </div>
          ) : (
            <p className="text-xs text-gray-400">No primary KPI configured for this tenant.</p>
          )}

          {/* All KPIs table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 font-semibold text-gray-500 text-xs">KPI</th>
                  <th className="text-right py-2 font-semibold text-gray-500 text-xs">Target</th>
                  <th className="text-right py-2 font-semibold text-gray-500 text-xs">Achieved</th>
                  <th className="py-2 font-semibold text-gray-500 text-xs w-56">Achievement</th>
                </tr>
              </thead>
              <tbody>
                {targetAchievement.kpis.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-xs text-gray-400">
                      No KPIs configured for this tenant.
                    </td>
                  </tr>
                )}
                {targetAchievement.kpis.map((k, i) => {
                  const barW = (k.achieved / kpiBarMax) * 100;
                  const targetTick = (k.target / kpiBarMax) * 100;
                  const color = k.pct !== null ? pctColor(k.pct) : '#9ca3af';
                  return (
                    <tr key={k.kpiCode} className={`border-b border-gray-50 ${i % 2 === 0 ? '' : 'bg-gray-50/40'}`}>
                      <td className="py-2.5 font-medium text-gray-800 text-xs">
                        {k.kpiName}
                        {k.isPrimary && (
                          <span className="ml-2 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">PRIMARY</span>
                        )}
                        {k.unit && <span className="ml-1 text-[10px] text-gray-400">({k.unit})</span>}
                      </td>
                      <td className="py-2.5 text-right text-gray-500 text-xs">{fmtInt(k.target)}</td>
                      <td className="py-2.5 text-right text-gray-700 text-xs font-semibold">{fmtInt(k.achieved)}</td>
                      <td className="py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="relative flex-1 h-2 bg-gray-100 rounded-full overflow-visible">
                            <div className="h-full rounded-full" style={{ width: `${Math.min(barW, 100)}%`, backgroundColor: color }} />
                            {/* target tick marker */}
                            {k.target > 0 && (
                              <div
                                className="absolute top-[-2px] h-[12px] w-[2px] bg-gray-400"
                                style={{ left: `${Math.min(targetTick, 100)}%` }}
                                title={`Target: ${fmtInt(k.target)}`}
                              />
                            )}
                          </div>
                          <span className="text-xs font-bold w-14 text-right shrink-0" style={{ color }}>
                            {k.pct !== null ? fmtPct(k.pct) : '—'}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ── Participation rate ⭐ + trend ── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <Card className="lg:col-span-2 border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-emerald-600" />
              <CardTitle>Participation Rate</CardTitle>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">Addressable outlets earning this month</p>
          </CardHeader>
          <CardContent className="pb-6 flex flex-col items-center justify-center gap-1 py-6">
            <p className="text-5xl font-bold text-emerald-600" data-testid="participation-rate">
              {fmtPct(participation.activeRatePct)}
            </p>
            <p className="text-xs text-gray-500">
              {fmtInt(participation.activeEarnersThisMonth)} / {fmtInt(participation.addressable)} active earners
            </p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3 border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader>
            <CardTitle>Active Earners — 6-Month Trend</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">Distinct addressable outlets earning each month</p>
          </CardHeader>
          <CardContent className="pb-6">
            <div style={{ width: '100%', height: 220 }}>
              <ResponsiveContainer>
                <LineChart data={trendData} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f1f4" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip
                    formatter={(v) => [fmtInt(Number(v)), 'Active earners']}
                    labelStyle={{ fontSize: 12 }}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="activeEarners"
                    stroke="var(--brand-primary)"
                    strokeWidth={2.5}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Activation funnel + time-to-activate ── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <Card className="lg:col-span-3 border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader>
            <CardTitle>Activation Funnel</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">
              From registration through first redemption (% of {fmtInt(activation.registered)} registered)
            </p>
          </CardHeader>
          <CardContent className="pb-5 space-y-3">
            {funnelStages.map((s) => (
              <FunnelRow key={s.stage} stage={s.stage} count={s.count} max={funnelMax} registered={activation.registered} />
            ))}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2 border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Hourglass className="w-5 h-5 text-indigo-500" />
              <CardTitle>Time to Activate</CardTitle>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">Median days from outlet creation to KYC approval</p>
          </CardHeader>
          <CardContent className="pb-6 flex flex-col items-center justify-center gap-1 py-8">
            <p className="text-5xl font-bold text-indigo-600">
              {activation.medianTimeToActivateDays.toFixed(1)}
            </p>
            <p className="text-xs text-gray-500">median days to KYC approval</p>
          </CardContent>
        </Card>
      </div>

      {/* ── Points economy ── */}
      <Card className="border border-gray-100 shadow-sm rounded-2xl">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Coins className="w-5 h-5 text-amber-500" />
            <CardTitle>Points Economy</CardTitle>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">Issued, redeemed, outstanding liability &amp; breakage for {monthLabel(scope.period)}</p>
        </CardHeader>
        <CardContent className="pb-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
            <StatCard label="Issued (period)" value={fmtInt(pointsEconomy.issued)} sub="EARN points"
              icon={TrendingUp} iconBg="bg-green-100" iconColor="text-green-700" valColor="text-green-700" />
            <StatCard label="Redeemed (period)" value={fmtInt(pointsEconomy.redeemed)} sub="REDEEM points"
              icon={Gift} iconBg="bg-purple-100" iconColor="text-purple-600" valColor="text-purple-700" />
            <StatCard label="Outstanding Liability" value={fmtInt(pointsEconomy.outstandingLiabilityPoints)}
              sub={`${fmtRupees(pointsEconomy.outstandingLiabilityRupees)} redeemable`}
              icon={Coins} iconBg="bg-blue-100" iconColor="text-blue-600" valColor="text-blue-700" />
            <StatCard label="Liability (₹)" value={fmtRupees(pointsEconomy.outstandingLiabilityRupees)} sub="at tenant rate"
              icon={Coins} iconBg="bg-sky-100" iconColor="text-sky-600" valColor="text-sky-700" />
            <StatCard label="Breakage (period)" value={fmtPct(pointsEconomy.breakagePct)} sub="expired ÷ issued"
              icon={ArrowDownCircle} iconBg="bg-red-100" iconColor="text-red-600" valColor="text-red-700" />
            <StatCard label="Expiring ≤ 30d" value={fmtInt(pointsEconomy.expiringIn30dPoints)} sub="points at risk"
              icon={Hourglass} iconBg="bg-amber-100" iconColor="text-amber-600" valColor="text-amber-700" />
          </div>
        </CardContent>
      </Card>

      {/* ── Redemptions: by mode + fulfilment ── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <Card className="lg:col-span-3 border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader>
            <CardTitle>Redemptions by Mode</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">Completed redemptions for {monthLabel(redemptions.period)} (excludes pending/failed/cancelled/returned)</p>
          </CardHeader>
          <CardContent className="pb-5 space-y-4">
            {redemptions.byMode.length === 0 && (
              <p className="text-xs text-gray-400">No completed redemptions this period.</p>
            )}
            {redemptions.byMode.map((m) => {
              const barW = (m.count / redemptionModeMax) * 100;
              return (
                <div key={m.mode}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-gray-700">{MODE_LABEL[m.mode] ?? m.mode}</span>
                    <span className="text-xs text-gray-500 ml-3 shrink-0">
                      <span className="font-bold text-gray-700">{fmtInt(m.count)}</span> orders ·{' '}
                      {fmtInt(m.points)} pts · {fmtRupees(m.valueRupees)}
                    </span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${barW}%`, backgroundColor: 'var(--brand-primary)' }} />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2 border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader>
            <CardTitle>Fulfilment Status</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">Order status distribution this period</p>
          </CardHeader>
          <CardContent className="pb-5">
            <table className="w-full text-sm">
              <tbody>
                {redemptions.fulfilment.length === 0 && (
                  <tr><td className="py-6 text-center text-xs text-gray-400">No redemption orders this period.</td></tr>
                )}
                {redemptions.fulfilment.map((f) => {
                  const share = fulfilmentTotal > 0 ? (f.count / fulfilmentTotal) * 100 : 0;
                  return (
                    <tr key={f.status} className="border-b border-gray-50">
                      <td className="py-2.5 text-xs font-medium text-gray-700">{STATUS_LABEL[f.status] ?? f.status}</td>
                      <td className="py-2.5 text-right text-xs font-bold text-gray-700 w-16">{fmtInt(f.count)}</td>
                      <td className="py-2.5 pl-3 w-28">
                        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${share}%`, backgroundColor: 'var(--brand-primary)' }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

    </div>
  );
}
