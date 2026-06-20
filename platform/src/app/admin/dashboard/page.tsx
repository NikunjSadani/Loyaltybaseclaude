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
} from 'lucide-react';
import { authHeader } from '@/lib/api-client';

/* ─── KPI card data ──────────────────────────────────────────────────────────── */

// KPI card chrome (label/icon/colors). Values come from the live /admin/dashboard/kpis endpoint;
// no mock bases (the old 4821/214/… were fabricated, #40/#47). "Fund Available Balance" was dropped —
// the payout fund is GIFSY-only (Q1), not a tenant KPI. MoM/YoY trend deltas need time-series we don't
// aggregate yet, so they're omitted here rather than faked (analytics deferred to P8).
interface KpiMeta {
  label: string;
  icon:  React.ElementType;
  color: string;
  border: string;
}

const KPI_META: KpiMeta[] = [
  { label: 'Total Active Partners',        icon: Users,      color: 'bg-blue-50 text-blue-600',     border: 'border-blue-100'   },
  { label: 'Pending KYC',                  icon: Clock,      color: 'bg-amber-50 text-amber-600',   border: 'border-amber-100'  },
  { label: 'Pending Visibility Approvals', icon: Eye,        color: 'bg-purple-50 text-purple-600', border: 'border-purple-100' },
  { label: 'Total Points Liability',       icon: TrendingUp, color: 'bg-red-50 text-red-600',       border: 'border-red-100'    },
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
  totalRedeemablePoints: number;
  payoutSummary:         Record<string, { count: number; amountPaise: number }>;
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function DashboardPage() {
  // Live KPIs from the API — the only source for the cards. No mock fallback (was 4821/214/…).
  const [liveKpis, setLiveKpis] = useState<ApiKpiData | null>(null);

  useEffect(() => {
    fetch('/api/admin/dashboard/kpis', { headers: { ...authHeader() } })
      .then(r => r.json())
      .then(json => { if (json.success && json.data) setLiveKpis(json.data); })
      .catch(() => {});
  }, []);

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
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Key Metrics</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
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
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Payout Summary (real — overlaid from the KPI endpoint) ────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 px-5 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1.5">
            <Banknote className="w-4 h-4 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-800">Payout Summary</h3>
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
    </div>
  );
}
