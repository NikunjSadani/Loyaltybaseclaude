'use client';

import React, { useState, useMemo, useEffect } from 'react';
import Link from 'next/link';
import {
  Users,
  Clock,
  Eye,
  TrendingUp,
  Wallet,
  ArrowUpRight,
  ArrowDownRight,
  Target,
  Filter,
  Layers,
  CheckCircle2,
  AlertCircle,
  Banknote,
  AlertTriangle,
} from 'lucide-react';
import { BillingTrendChart } from '@/components/charts/billing-trend';
import { authHeader } from '@/lib/api-client';
import {
  getAllConfigs,
  OUTLET_ACHIEVEMENTS,
  pct,
  pctBarColor,
  pctColor,
  getPrimaryParam,
  type GeoTargetConfig,
} from '@/lib/targets';

/* ─── Filter options ─────────────────────────────────────────────────────────── */

const PERIOD_OPTIONS = [
  { value: '2026-05', label: 'May 2026 (Current)' },
  { value: '2026-04', label: 'Apr 2026' },
  { value: '2026-03', label: 'Mar 2026' },
  { value: '2026-Q2', label: 'Q2 FY26 (Apr–Jun)' },
  { value: 'ytd',     label: 'YTD FY26' },
];

const STATE_OPTIONS = [
  { value: 'all',           label: 'All States' },
  { value: 'Maharashtra',   label: 'Maharashtra' },
  { value: 'Delhi',         label: 'Delhi' },
  { value: 'Karnataka',     label: 'Karnataka' },
  { value: 'Tamil Nadu',    label: 'Tamil Nadu' },
  { value: 'Telangana',     label: 'Telangana' },
  { value: 'West Bengal',   label: 'West Bengal' },
];

const REGION_OPTIONS: Record<string, { value: string; label: string }[]> = {
  all:         [{ value: 'all', label: 'All Regions' }],
  Maharashtra: [
    { value: 'all',         label: 'All Regions'     },
    { value: 'Mumbai West', label: 'Mumbai West'     },
    { value: 'Mumbai East', label: 'Mumbai East'     },
    { value: 'Pune Metro',  label: 'Pune Metro'      },
    { value: 'Nashik',      label: 'Nashik'          },
  ],
  Delhi: [
    { value: 'all',              label: 'All Regions'       },
    { value: 'Delhi NCR North',  label: 'Delhi NCR North'   },
    { value: 'Delhi NCR South',  label: 'Delhi NCR South'   },
    { value: 'Noida / Gurgaon',  label: 'Noida / Gurgaon'  },
  ],
  Karnataka: [
    { value: 'all',              label: 'All Regions'       },
    { value: 'Bengaluru Urban',  label: 'Bengaluru Urban'   },
    { value: 'Bengaluru Rural',  label: 'Bengaluru Rural'   },
    { value: 'Mysuru',           label: 'Mysuru'            },
  ],
};

const PARTNER_CLASS = ['All', 'Gold', 'Silver', 'Platinum'] as const;
type PartnerClass = (typeof PARTNER_CLASS)[number];

type OutletTypeFilter = 'ALL' | 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST';

/* ─── KPI card data (varies by filter for realism) ──────────────────────────── */

// KPI card chrome (label/icon/colors). Values come from the live /admin/dashboard/kpis endpoint;
// no mock bases (the old 4821/214/… were fabricated, #40/#47). "Fund Available Balance" was dropped —
// the payout fund is GIFSY-only (Q1), not a tenant KPI. MoM/YoY trend deltas need time-series we don't
// aggregate yet, so they're omitted here rather than faked (tracked residual — see gap-register).
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

/* ─── Growth strip data ──────────────────────────────────────────────────────── */

const growthMetrics = [
  { label: 'Partner Enrollment',  mom: +3.1,  yoy: +18.4, unit: '%', goodWhenPositive: true  },
  { label: 'Billing Volume',      mom: +11.2, yoy: +24.7, unit: '%', goodWhenPositive: true  },
  { label: 'Points Issued',       mom: +9.4,  yoy: +28.6, unit: '%', goodWhenPositive: true  },
  { label: 'Gift Redemptions',    mom: +14.8, yoy: +41.2, unit: '%', goodWhenPositive: true  },
  { label: 'KYC Approvals',       mom: +6.3,  yoy: +15.9, unit: '%', goodWhenPositive: true  },
  { label: 'Visibility Submissions', mom: +22.8, yoy: +34.1, unit: '%', goodWhenPositive: true },
];

/* ─── Scheme activity data ───────────────────────────────────────────────────── */

const schemeData = [
  { name: 'Summer Push Q2',   category: 'Volume',    enrolled: 1842, total: 2200, endDate: '30 Jun', barColor: 'bg-emerald-500' },
  { name: 'Retailer Boost',   category: 'Frequency', enrolled: 1124, total: 1400, endDate: '31 May', barColor: 'bg-amber-400'   },
  { name: 'Wholesale Drive',  category: 'Value',     enrolled:  438, total:  600, endDate: '15 Jun', barColor: 'bg-blue-500'    },
  { name: 'Focus SKU May',    category: 'SKU',       enrolled:  312, total:  500, endDate: '31 May', barColor: 'bg-purple-500'  },
];

/* ─── Payout summary data ────────────────────────────────────────────────────── */

const payoutSummary = [
  { label: 'Completed', count: 1842, amount: '₹38.4L', icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200' },
  { label: 'Pending',   count:  214, amount: '₹8.2L',  icon: Clock,        color: 'text-amber-600',   bg: 'bg-amber-50',   border: 'border-amber-200'   },
  { label: 'Failed',    count:   23, amount: '₹1.1L',  icon: AlertCircle,  color: 'text-red-500',     bg: 'bg-red-50',     border: 'border-red-200'     },
];

/* ─── Territory table ────────────────────────────────────────────────────────── */

const territoryData = [
  { territory: 'Mumbai West',       billing: '₹12.4 Cr', growth: '+18.2%', positive: true  },
  { territory: 'Delhi NCR North',   billing: '₹10.8 Cr', growth: '+14.7%', positive: true  },
  { territory: 'Bengaluru Urban',   billing: '₹9.3 Cr',  growth: '+21.4%', positive: true  },
  { territory: 'Pune Metro',        billing: '₹7.6 Cr',  growth: '+9.1%',  positive: true  },
  { territory: 'Hyderabad Central', billing: '₹6.9 Cr',  growth: '-2.3%',  positive: false },
  { territory: 'Chennai South',     billing: '₹5.8 Cr',  growth: '+11.8%', positive: true  },
  { territory: 'Kolkata East',      billing: '₹4.4 Cr',  growth: '-5.1%',  positive: false },
  { territory: 'Ahmedabad Metro',   billing: '₹3.9 Cr',  growth: '+7.6%',  positive: true  },
];

/* ─── Needs Attention items ──────────────────────────────────────────────────── */

const ATTENTION_ITEMS = [
  { id: 'sla',       icon: AlertCircle,   text: 'KYC SLA breaches',         count: 38,  severity: 'high'   as const, href: '/admin/kyc'     },
  { id: 'payouts',   icon: AlertCircle,   text: 'Failed payouts',            count: 23,  severity: 'high'   as const, href: '/admin/payouts' },
  { id: 'fund',      icon: Wallet,        text: 'Fund below threshold',      count: null, severity: 'medium' as const, href: '/admin/funds'  },
  { id: 'territory', icon: ArrowDownRight, text: 'Territories in decline',   count: 2,   severity: 'medium' as const, href: '/admin/reports' },
  { id: 'vis',       icon: Eye,           text: 'Visibility pending >3 days', count: 147, severity: 'medium' as const, href: '/admin/visibility' },
];

/* ─── Outlet type filter options ─────────────────────────────────────────────── */

const OUTLET_FILTERS: { value: OutletTypeFilter; label: string }[] = [
  { value: 'ALL',          label: 'All'          },
  { value: 'SSS',     label: 'SSS'     },
  { value: 'WHOLESALER',   label: 'Wholesaler'   },
  { value: 'SUB_STOCKIST', label: 'Sub-Stockist' },
];

/* ─── Target achievement section ─────────────────────────────────────────────── */

// Extended mock achievements for admin (aggregated across more outlets)
const ADMIN_ACHIEVEMENTS = {
  ...OUTLET_ACHIEVEMENTS,
  k6:  { outletId: 'k6',  period: '2026-05', achievements: { p_sv: 7.2, p_fp1: 44, p_fp2: 28, p_fc: 92,  p_ln: 5 } },
  k7:  { outletId: 'k7',  period: '2026-05', achievements: { p_sv: 6.8, p_fp1: 58, p_fp2: 35, p_fc: 105, p_ln: 6 } },
  k8:  { outletId: 'k8',  period: '2026-05', achievements: { p_sv: 3.1, p_fp1: 18, p_fp2: 10, p_fc: 38,  p_ln: 2 } },
  k9:  { outletId: 'k9',  period: '2026-05', achievements: { p_sv: 9.8, p_fp1: 63, p_fp2: 42, p_fc: 122, p_ln: 7 } },
  k10: { outletId: 'k10', period: '2026-05', achievements: { p_sv: 5.1, p_fp1: 29, p_fp2: 20, p_fc: 71,  p_ln: 4 } },
};

const ALL_KYC_IDS = Object.keys(ADMIN_ACHIEVEMENTS);

function TargetAchievementCard({ config }: { config: GeoTargetConfig }) {
  const [typeFilter, setTypeFilter] = useState<OutletTypeFilter>('ALL');

  // For admin: filter by outlet type changes which outlet IDs are included
  // (mock: ALL / RETAILER uses k1-k5, WHOLESALER adds k4 weighted, SUB_STOCKIST k5)
  const filteredIds = useMemo(() => {
    if (typeFilter === 'ALL')          return ALL_KYC_IDS;
    if (typeFilter === 'SSS')     return ['k1', 'k2', 'k3', 'k6', 'k7', 'k8'];
    if (typeFilter === 'WHOLESALER')   return ['k4', 'k9'];
    return ['k5', 'k10']; // SUB_STOCKIST
  }, [typeFilter]);

  return (
    <div className="bg-white rounded-xl border border-[var(--brand-primary)]/20 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-[var(--brand-primary)]" />
            <h2 className="text-sm font-semibold text-gray-800">Target Achievement</h2>
          </div>
          <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">
            {config.geoName} · May 2026
          </span>
        </div>

        {/* Outlet type filter pills */}
        <div className="flex gap-1.5 flex-wrap">
          {OUTLET_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setTypeFilter(f.value)}
              className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-all ${
                typeFilter === f.value
                  ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                  : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Sort: primary KPI first, then the rest in their original order */}
        {[...config.params].sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0)).map((param) => {
          const isPrimary = param.isPrimary ?? (getPrimaryParam(config.params)?.id === param.id);
          const perOutlet = filteredIds.map((id) => {
            const ach = ADMIN_ACHIEVEMENTS[id as keyof typeof ADMIN_ACHIEVEMENTS];
            return pct(ach?.achievements[param.id] ?? 0, param.target);
          });
          const total  = perOutlet.length;
          const avgPct = total > 0 ? Math.round(perOutlet.reduce((s, v) => s + v, 0) / total) : 0;
          const bar    = pctBarColor(avgPct);
          const txt    = pctColor(avgPct);

          return (
            <div key={param.id} className={`space-y-1.5 ${isPrimary ? 'pb-3 border-b border-[var(--brand-primary)]/10' : ''}`}>
              <div className="flex items-center gap-2">
                <p className={`text-xs font-medium flex-1 truncate ${isPrimary ? 'text-[var(--brand-primary)] font-semibold' : 'text-gray-700'}`}>
                  {param.label}
                  {isPrimary && (
                    <span className="ml-1.5 text-[9px] font-bold uppercase tracking-wide bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] px-1.5 py-0.5 rounded-full">
                      Primary
                    </span>
                  )}
                </p>
                <span className={`text-[10px] font-bold shrink-0 ${txt}`}>
                  avg {avgPct}%
                </span>
              </div>
              <div className={`rounded-full overflow-hidden ${isPrimary ? 'h-2.5 bg-[var(--brand-primary)]/10' : 'h-1.5 bg-gray-100'}`}>
                <div
                  className={`h-full rounded-full transition-all ${bar}`}
                  style={{ width: `${Math.min(avgPct, 100)}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-gray-400">
                <span>{filteredIds.length} outlets</span>
                <span>Target {param.target} {param.unit} / outlet</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
  const [period,       setPeriod]       = useState('2026-05');
  const [state,        setState]        = useState('all');
  const [region,       setRegion]       = useState('all');
  const [partnerClass, setPartnerClass] = useState<PartnerClass>('All');
  const [billingView,  setBillingView]  = useState<'all' | string>('all');
  const [growthView,   setGrowthView]   = useState<'mom' | 'yoy'>('mom');

  // Reset region when state changes
  const handleStateChange = (s: string) => {
    setState(s);
    setRegion('all');
  };

  const regionOptions = REGION_OPTIONS[state] ?? REGION_OPTIONS.all;

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

  // Resolve target config based on region/state
  const targetConfig: GeoTargetConfig | null = useMemo(() => {
    const all = getAllConfigs().filter((c) => c.period === '2026-05' || c.period === period);
    if (region !== 'all') return all.find((c) => c.geoName === region) ?? all[0] ?? null;
    if (state  !== 'all') return all.find((c) => c.geoName === state)  ?? all[0] ?? null;
    return all[0] ?? null;
  }, [period, state, region]);

  return (
    <div className="space-y-5 fade-in">

      {/* ── Needs Attention strip (12) ────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-amber-200 overflow-hidden">
        {/* Strip header */}
        <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-50 border-b border-amber-100">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
          <p className="text-[11px] font-bold text-amber-800 uppercase tracking-wide flex-1">Needs Attention</p>
          <span className="text-[10px] font-bold bg-amber-200 text-amber-800 px-1.5 py-0.5 rounded-full">
            {ATTENTION_ITEMS.reduce((n, i) => n + (i.count ?? 1), 0)} items
          </span>
        </div>
        {/* Horizontal scroll of action chips */}
        <div className="flex gap-2 px-4 py-3 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {ATTENTION_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.id}
                href={item.href}
                className={`flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                  item.severity === 'high'
                    ? 'bg-red-50 border-red-200 text-red-700 hover:bg-red-100'
                    : 'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100'
                }`}
              >
                <Icon className="h-3 w-3 shrink-0" />
                {item.count !== null && (
                  <span className={`font-bold ${item.severity === 'high' ? 'text-red-600' : 'text-amber-600'}`}>
                    {item.count}
                  </span>
                )}
                {item.text}
                <ArrowUpRight className="h-3 w-3 opacity-60" />
              </Link>
            );
          })}
        </div>
      </div>

      {/* ── Global filter bar ─────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 mr-1">
            <Filter className="w-3.5 h-3.5" />
            Filters
          </div>

          {/* Time period */}
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] bg-white text-gray-700"
          >
            {PERIOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          {/* State */}
          <select
            value={state}
            onChange={(e) => handleStateChange(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] bg-white text-gray-700"
          >
            {STATE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          {/* Region — only shown when a state is selected */}
          {state !== 'all' && (
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] bg-white text-gray-700"
            >
              {regionOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          )}

          {/* Separator */}
          <div className="h-4 w-px bg-gray-200 mx-1" />

          {/* Partner class pills */}
          <div className="flex gap-1">
            {PARTNER_CLASS.map((cls) => (
              <button
                key={cls}
                onClick={() => setPartnerClass(cls)}
                className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-all ${
                  partnerClass === cls
                    ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                    : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                }`}
              >
                {cls}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── KPI Cards ─────────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        {/* Section header with MoM / YoY toggle */}
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Key Metrics</p>
          <div className="flex bg-gray-100 rounded-lg p-0.5 gap-0.5">
            {(['mom', 'yoy'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setGrowthView(v)}
                className={`px-2.5 py-1 rounded-md text-[10px] font-bold transition-all ${
                  growthView === v ? 'bg-white text-[var(--brand-primary)] shadow-sm' : 'text-gray-500'
                }`}
              >
                {v === 'mom' ? 'MoM' : 'YoY'}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
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
                  {/* MoM/YoY trend badge omitted — needs real time-series (tracked residual). */}
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

      {/* ── Growth Strip ──────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 px-5 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm font-semibold text-gray-800">Growth Trends</p>
            <p className="text-xs text-gray-400 mt-0.5">
              {growthView === 'mom' ? 'Month-over-Month vs Apr 2026' : 'Year-over-Year vs May 2025'}
            </p>
          </div>
          <div className="flex bg-gray-100 rounded-lg p-0.5 gap-0.5">
            {(['mom', 'yoy'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setGrowthView(v)}
                className={`px-2.5 py-1 rounded-md text-[10px] font-bold transition-all ${
                  growthView === v ? 'bg-white text-[var(--brand-primary)] shadow-sm' : 'text-gray-500'
                }`}
              >
                {v === 'mom' ? 'MoM' : 'YoY'}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          {growthMetrics.map((m) => {
            const val  = growthView === 'mom' ? m.mom : m.yoy;
            const good = m.goodWhenPositive ? val >= 0 : val <= 0;
            const label = `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`;

            return (
              <div key={m.label} className="flex flex-col gap-1">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide leading-tight">
                  {m.label}
                </p>
                <div className="flex items-center gap-1">
                  <span className={`text-xl font-bold ${good ? 'text-emerald-600' : 'text-red-500'}`}>
                    {label}
                  </span>
                  {val >= 0
                    ? <ArrowUpRight className={`w-4 h-4 ${good ? 'text-emerald-500' : 'text-red-400'}`} />
                    : <ArrowDownRight className={`w-4 h-4 ${good ? 'text-emerald-500' : 'text-red-400'}`} />}
                </div>
                {/* Mini bar showing magnitude */}
                <div className="h-1 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${good ? 'bg-emerald-400' : 'bg-red-400'}`}
                    style={{ width: `${Math.min(Math.abs(val) * 2.5, 100)}%` }}
                  />
                </div>
                <p className="text-[10px] text-gray-400">vs {growthView === 'mom' ? 'Apr 2026' : 'May 2025'}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Middle row: Scheme Activity + Billing Trends ─────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Scheme Activity */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-800">Scheme Activity</h2>
              <p className="text-xs text-gray-500">Active schemes · May 2026</p>
            </div>
            <Layers className="w-4 h-4 text-[var(--brand-primary)]" />
          </div>

          {/* Summary stats */}
          <div className="grid grid-cols-2 gap-2 mb-5">
            {[
              { label: 'Active Schemes',   value: '4',      color: 'text-gray-900'   },
              { label: 'Enrolled Outlets', value: '3,716',  color: 'text-gray-900'   },
              { label: 'Avg Participation',value: '79.6%',  color: 'text-emerald-600'},
              { label: 'Expiring in May',  value: '2',      color: 'text-amber-600'  },
            ].map((s) => (
              <div key={s.label} className="bg-gray-50 rounded-lg px-3 py-2.5">
                <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
                <p className="text-[10px] text-gray-500 leading-tight mt-0.5">{s.label}</p>
              </div>
            ))}
          </div>

          {/* Per-scheme participation bars */}
          <div className="space-y-3">
            {schemeData.map((s) => {
              const p = Math.round((s.enrolled / s.total) * 100);
              return (
                <div key={s.name}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[10px] font-medium bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded shrink-0">{s.category}</span>
                      <span className="text-xs font-medium text-gray-700 truncate">{s.name}</span>
                    </div>
                    <span className="text-[10px] font-bold text-gray-500 shrink-0 ml-2">{p}%</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-1.5">
                    <div className={`${s.barColor} h-1.5 rounded-full transition-all`} style={{ width: `${p}%` }} />
                  </div>
                  <p className="text-[10px] text-gray-400 mt-0.5 text-right">ends {s.endDate}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Billing Trend Chart */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-800">Billing Trends</h2>
              <p className="text-xs text-gray-500">Last 12 months by partner class</p>
            </div>
            <select
              value={billingView}
              onChange={(e) => setBillingView(e.target.value)}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
            >
              <option value="all">All Classes</option>
              <option value="GOLD">Gold Only</option>
              <option value="SILVER">Silver Only</option>
              <option value="PLATINUM">Platinum Only</option>
            </select>
          </div>
          <BillingTrendChart />
        </div>
      </div>

      {/* ── Bottom row: Top Territories + Target Achievement ──────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Territories + Payout Summary */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden flex flex-col">
          {/* Top Territories — compact */}
          <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-800">Top Territories</h2>
            <a href="/admin/reports" className="text-xs text-[var(--brand-primary)] hover:text-[var(--brand-primary-dark)] font-medium">
              Full Report →
            </a>
          </div>
          <div className="divide-y divide-gray-50">
            {territoryData.slice(0, 5).map((row, i) => (
              <div key={row.territory} className="flex items-center gap-3 px-5 py-2.5 hover:bg-gray-50 transition-colors">
                <span className="text-[11px] font-bold text-gray-300 w-4 shrink-0">{i + 1}</span>
                <p className="text-xs font-medium text-gray-800 flex-1 truncate">{row.territory}</p>
                <span className="text-xs font-semibold text-gray-700 shrink-0">{row.billing}</span>
                <span className={`inline-flex items-center gap-0.5 text-[11px] font-bold shrink-0 ${row.positive ? 'text-emerald-600' : 'text-red-500'}`}>
                  {row.positive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                  {row.growth}
                </span>
              </div>
            ))}
          </div>

          {/* Payout Summary */}
          <div className="px-5 py-3.5 border-t border-gray-100 mt-auto">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-1.5">
                <Banknote className="w-4 h-4 text-gray-400" />
                <h3 className="text-sm font-semibold text-gray-800">Payout Summary</h3>
              </div>
              <a href="/admin/payouts" className="text-xs text-[var(--brand-primary)] hover:text-[var(--brand-primary-dark)] font-medium">
                Manage →
              </a>
            </div>
            <div className="grid grid-cols-3 gap-2">
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

        {/* Target vs Achievement */}
        {targetConfig
          ? <TargetAchievementCard config={targetConfig} />
          : (
            <div className="bg-white rounded-xl border border-gray-200 flex items-center justify-center p-10 text-sm text-gray-400">
              No target config found for the selected period / geography.
            </div>
          )
        }
      </div>
    </div>
  );
}
