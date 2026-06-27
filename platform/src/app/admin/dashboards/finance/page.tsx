'use client';

/* ─── Admin Finance Dashboard (REAL data) ────────────────────────────────────────
   100% wired to GET /api/admin/dashboard/finance (proxy → backend
   /v1/admin/dashboard/finance). Every number on this page comes from that
   endpoint — there are NO hardcoded metric constants or fabricated arrays. If the
   fetch fails or returns nothing, an explicit error / empty state is shown (never a
   mock fallback). Auth follows the same authHeader() + fetch + useEffect/useState
   pattern as the KYC dashboard.

   Money: the backend already converts BigInt paise → ₹ and points → ₹ at the
   tenant conversion rate. This page only formats; it never re-derives money.
──────────────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useState } from 'react';
import {
  Coins, Lock, TrendingDown, Receipt, Wallet, AlertCircle, Loader2,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { authHeader } from '@/lib/api-client';

const DARK_NAVY = '#1A1A2E';

/* ─── API response model (precise to the endpoint contract) ─────────────────── */

interface TdsSection {
  liabilityRupees: number;
  depositedRupees: number;
  outstandingRupees: number;
}

interface FinanceDashboardData {
  scope: { tenant: string; generatedAt: string; fy: string };
  liability: {
    redeemablePoints: number;
    lockedPoints: number;
    conversionRate: number;
    redeemableRupees: number;
    lockedRupees: number;
  };
  breakage: {
    period: string;
    expiredPoints: number;
    issuedPoints: number;
    breakagePct: number;
    expiredRupees: number;
  };
  tds: {
    fy: string;
    sec194R: TdsSection;
    sec194C: TdsSection;
  };
  fund: {
    totalReceivedRupees: number;
    totalUtilisedRupees: number;
    closingBalanceRupees: number;
    pendingLiabilityRupees: number;
    availableRupees: number;
  };
}

/* ─── Formatting helpers ─────────────────────────────────────────────────────── */

const fmtInt = (n: number) => n.toLocaleString('en-IN');
const fmtPct = (n: number) => `${n.toFixed(1)}%`;
const fmtRs = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
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

/* TDS three-line block (liability / deposited / outstanding) for one section. */
function TdsBlock({
  title, scopeLabel, section,
}: {
  title: string;
  scopeLabel: string;
  section: TdsSection;
}) {
  const outstandingColor =
    section.outstandingRupees > 0 ? 'text-red-600'
      : section.outstandingRupees < 0 ? 'text-green-600'
      : 'text-gray-700';
  return (
    <div className="rounded-xl border border-gray-100 bg-white px-4 py-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-semibold text-gray-700">{title}</span>
        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 uppercase tracking-wide">
          {scopeLabel}
        </span>
      </div>
      <dl className="space-y-1.5 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-gray-500">Liability</dt>
          <dd className="font-semibold text-gray-900">{fmtRs(section.liabilityRupees)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-gray-500">Deposited</dt>
          <dd className="font-semibold text-gray-900">{fmtRs(section.depositedRupees)}</dd>
        </div>
        <div className="flex items-center justify-between border-t border-gray-100 pt-1.5">
          <dt className="text-gray-500">Outstanding</dt>
          <dd className={`font-bold ${outstandingColor}`}>{fmtRs(section.outstandingRupees)}</dd>
        </div>
      </dl>
    </div>
  );
}

/* A single labelled ₹ row in the fund-reconciliation ledger. */
function FundRow({
  label, value, emphasis,
}: {
  label: string;
  value: number;
  emphasis?: 'balance' | 'available' | 'pending';
}) {
  const valCls =
    emphasis === 'available' ? 'text-green-700'
      : emphasis === 'pending' ? 'text-amber-600'
      : emphasis === 'balance' ? 'text-gray-900'
      : 'text-gray-700';
  return (
    <div className={`flex items-center justify-between py-2.5 ${emphasis ? 'border-t border-gray-100' : ''}`}>
      <span className="text-sm text-gray-500">{label}</span>
      <span className={`text-sm font-bold ${valCls}`}>{fmtRs(value)}</span>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function AdminFinanceDashboardPage() {
  const [data, setData] = useState<FinanceDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/admin/dashboard/finance', { headers: { ...authHeader() } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        const json: unknown = await r.json();
        // The endpoint may return the bare shape or wrap it as { success, data }.
        const payload = (json && typeof json === 'object' && 'data' in json)
          ? (json as { data: FinanceDashboardData }).data
          : (json as FinanceDashboardData);
        if (!payload || typeof payload !== 'object' || !('liability' in payload)) {
          throw new Error('Empty or malformed response');
        }
        if (!cancelled) setData(payload);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load finance dashboard');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  /* ── Loading state ── */
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-gray-400" data-testid="finance-dashboard-loading">
        <Loader2 className="w-8 h-8 animate-spin mb-3" />
        <p className="text-sm">Loading finance dashboard…</p>
      </div>
    );
  }

  /* ── Error / empty state — NEVER fabricated numbers ── */
  if (error || !data) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: DARK_NAVY }}>
            Finance Dashboard
          </h1>
        </div>
        <Card className="border border-red-100 shadow-sm rounded-2xl" data-testid="finance-dashboard-error">
          <CardContent className="py-12 flex flex-col items-center text-center gap-2">
            <AlertCircle className="w-8 h-8 text-red-500" />
            <p className="text-sm font-semibold text-red-600">Couldn&apos;t load the finance dashboard</p>
            <p className="text-xs text-gray-500 max-w-md">
              {error ?? 'No data was returned by the server.'} Please refresh or try again later.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { scope, liability, breakage, tds, fund } = data;

  return (
    <div className="space-y-6" data-testid="finance-dashboard">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: DARK_NAVY }}>
            Finance Dashboard
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {scope.tenant} · Points liability, breakage, TDS &amp; fund reconciliation · FY {scope.fy}
          </p>
        </div>
        <p className="text-xs text-gray-400">as of {fmtTimestamp(scope.generatedAt)}</p>
      </div>

      {/* ── Points Liability ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Redeemable Liability"
          value={fmtRs(liability.redeemableRupees)}
          sub={`${fmtInt(liability.redeemablePoints)} pts redeemable`}
          icon={Coins} iconBg="bg-emerald-100" iconColor="text-emerald-700" valColor="text-emerald-700"
        />
        <StatCard
          label="Locked Liability"
          value={fmtRs(liability.lockedRupees)}
          sub={`${fmtInt(liability.lockedPoints)} pts locked`}
          icon={Lock} iconBg="bg-indigo-100" iconColor="text-indigo-600" valColor="text-indigo-700"
        />
        <StatCard
          label="Breakage (this period)"
          value={fmtPct(breakage.breakagePct)}
          sub={`${fmtInt(breakage.expiredPoints)} expired · ${fmtRs(breakage.expiredRupees)}`}
          icon={TrendingDown} iconBg="bg-rose-100" iconColor="text-rose-600" valColor="text-rose-700"
        />
        <StatCard
          label="Fund Available"
          value={fmtRs(fund.availableRupees)}
          sub={`${fmtRs(fund.closingBalanceRupees)} closing balance`}
          icon={Wallet} iconBg="bg-sky-100" iconColor="text-sky-600" valColor="text-sky-700"
        />
      </div>

      {/* ── Points Liability detail + Breakage ── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

        {/* Points liability (3 cols) */}
        <Card className="lg:col-span-3 border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader>
            <CardTitle>Points Liability</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">
              Outstanding points obligation across all wallets · valued at {fmtInt(liability.conversionRate)} pts / ₹
            </p>
          </CardHeader>
          <CardContent className="pb-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="rounded-xl border border-gray-100 bg-emerald-50/40 px-4 py-4">
                <p className="text-xs font-semibold text-gray-600">Redeemable</p>
                <p className="text-3xl font-bold text-emerald-700 mt-1">{fmtRs(liability.redeemableRupees)}</p>
                <p className="text-[11px] text-gray-400 mt-1">{fmtInt(liability.redeemablePoints)} points</p>
              </div>
              <div className="rounded-xl border border-gray-100 bg-indigo-50/40 px-4 py-4">
                <p className="text-xs font-semibold text-gray-600">Locked</p>
                <p className="text-3xl font-bold text-indigo-700 mt-1">{fmtRs(liability.lockedRupees)}</p>
                <p className="text-[11px] text-gray-400 mt-1">{fmtInt(liability.lockedPoints)} points</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Breakage (2 cols) */}
        <Card className="lg:col-span-2 border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader>
            <CardTitle>Breakage</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">Period {breakage.period} · expired ÷ issued</p>
          </CardHeader>
          <CardContent className="pb-6 flex flex-col items-center justify-center gap-1.5 py-4">
            <TrendingDown className="w-7 h-7 text-rose-500" />
            <p className="text-4xl font-bold text-rose-600">{fmtPct(breakage.breakagePct)}</p>
            <p className="text-xs text-gray-500">
              {fmtInt(breakage.expiredPoints)} expired / {fmtInt(breakage.issuedPoints)} issued
            </p>
            <p className="text-[11px] text-gray-400">{fmtRs(breakage.expiredRupees)} value broken</p>
          </CardContent>
        </Card>
      </div>

      {/* ── TDS ── */}
      <Card className="border border-gray-100 shadow-sm rounded-2xl">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Receipt className="w-4 h-4 text-gray-400" />
            <CardTitle>TDS Position · FY {tds.fy}</CardTitle>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            194R is tenant-scoped; 194C is platform-wide (Gifsy deductor) by design
          </p>
        </CardHeader>
        <CardContent className="pb-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <TdsBlock title="Section 194R" scopeLabel="Tenant" section={tds.sec194R} />
            <TdsBlock title="Section 194C" scopeLabel="Platform" section={tds.sec194C} />
          </div>
        </CardContent>
      </Card>

      {/* ── Fund Reconciliation ── */}
      <Card className="border border-gray-100 shadow-sm rounded-2xl">
        <CardHeader>
          <CardTitle>Fund Reconciliation</CardTitle>
          <p className="text-xs text-gray-400 mt-0.5">Received vs utilised, closing balance and what remains available</p>
        </CardHeader>
        <CardContent className="pb-3">
          <FundRow label="Total Received" value={fund.totalReceivedRupees} />
          <FundRow label="Total Utilised" value={fund.totalUtilisedRupees} />
          <FundRow label="Closing Balance" value={fund.closingBalanceRupees} emphasis="balance" />
          <FundRow label="Pending Liability" value={fund.pendingLiabilityRupees} emphasis="pending" />
          <FundRow label="Available" value={fund.availableRupees} emphasis="available" />
        </CardContent>
      </Card>

    </div>
  );
}
