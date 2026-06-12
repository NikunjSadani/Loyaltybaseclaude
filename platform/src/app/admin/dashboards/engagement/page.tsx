'use client';

import React from 'react';
import {
  LineChart, Line,
  BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts';
import {
  Users, Activity, Clock, AlertTriangle,
  Wallet, Target, Gift, HeadphonesIcon, User, Megaphone,
  TrendingUp, TrendingDown, ArrowRight,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { FilterBar } from '@/components/admin/filter-bar';

// ── Constants ─────────────────────────────────────────────────────────────────
const DARK_NAVY     = '#1A1A2E';
const PRIMARY_GREEN = 'var(--brand-primary)';

// ── Summary KPIs ──────────────────────────────────────────────────────────────
const summaryKpis = [
  {
    label:     'Monthly Active Partners',
    value:     '3,842',
    sub:       '79.7% of registered base',
    mom:       '+3.8%',
    momGood:   true,
    icon:      Users,
    bg:        'bg-green-50',
    border:    'border-green-200',
    iconColor: 'text-green-600',
    valColor:  'text-green-700',
  },
  {
    label:     'DAU : MAU Ratio',
    value:     '20.0%',
    sub:       '~768 partners active daily',
    mom:       '+1.2pp',
    momGood:   true,
    icon:      Activity,
    bg:        'bg-blue-50',
    border:    'border-blue-200',
    iconColor: 'text-blue-600',
    valColor:  'text-blue-700',
  },
  {
    label:     'Avg Session Duration',
    value:     '4m 32s',
    sub:       'per login session',
    mom:       '+18s',
    momGood:   true,
    icon:      Clock,
    bg:        'bg-purple-50',
    border:    'border-purple-200',
    iconColor: 'text-purple-600',
    valColor:  'text-purple-700',
  },
  {
    label:     'Inactive 30d+',
    value:     '624',
    sub:       '12.9% of registered base',
    mom:       '-4.1%',
    momGood:   true,   // lower is better
    icon:      AlertTriangle,
    bg:        'bg-amber-50',
    border:    'border-amber-200',
    iconColor: 'text-amber-600',
    valColor:  'text-amber-700',
  },
];

// ── Active user trend ─────────────────────────────────────────────────────────
const userTrendData = [
  { month: 'Oct', DAU: 580,  WAU: 1820, MAU: 3210 },
  { month: 'Nov', DAU: 612,  WAU: 1940, MAU: 3380 },
  { month: 'Dec', DAU: 698,  WAU: 2180, MAU: 3620 },
  { month: 'Jan', DAU: 724,  WAU: 2290, MAU: 3720 },
  { month: 'Feb', DAU: 748,  WAU: 2380, MAU: 3810 },
  { month: 'Mar', DAU: 768,  WAU: 2440, MAU: 3842 },
];

// ── Login frequency distribution ──────────────────────────────────────────────
const loginFreqData = [
  { label: 'Daily\n(20+ / mo)',     count: 307,  pct: 8,  color: 'var(--brand-primary)' },
  { label: 'Weekly\n(5–20 / mo)',   count: 1191, pct: 31, color: '#6366f1' },
  { label: 'Occasional\n(1–4 / mo)',count: 1575, pct: 41, color: '#f59e0b' },
  { label: 'Inactive\n(0 / mo)',    count: 769,  pct: 20, color: '#d1d5db' },
];

// ── Feature adoption ──────────────────────────────────────────────────────────
const featureAdoption = [
  { label: 'Wallet & Points',  pct: 94, icon: Wallet,          color: 'var(--brand-primary)' },
  { label: 'Targets',          pct: 78, icon: Target,          color: '#6366f1' },
  { label: 'Offers & Banners', pct: 44, icon: Megaphone,       color: '#f59e0b' },
  { label: 'Gift Catalogue',   pct: 61, icon: Gift,            color: '#e91e63' },
  { label: 'Support',          pct: 23, icon: HeadphonesIcon,  color: '#0891b2' },
  { label: 'Profile / KYC',   pct: 18, icon: User,            color: '#8b5cf6' },
];

// ── Catalogue redemption funnel ───────────────────────────────────────────────
const funnelSteps = [
  { label: 'Catalogue Viewed',    count: 2342, color: '#6366f1' },
  { label: 'Gift Page Opened',    count: 1580, color: '#8b5cf6' },
  { label: 'Redemption Initiated',count: 687,  color: '#f59e0b' },
  { label: 'Redemption Completed',count: 562,  color: 'var(--brand-primary)' },
];
const FUNNEL_MAX = funnelSteps[0].count;

// ── At-risk partners ──────────────────────────────────────────────────────────
const atRiskBuckets = [
  { label: '30–60 days',  count: 312, color: 'bg-amber-400',  text: 'text-amber-700',  bg: 'bg-amber-50',  border: 'border-amber-200' },
  { label: '60–90 days',  count: 198, color: 'bg-orange-500', text: 'text-orange-700', bg: 'bg-orange-50', border: 'border-orange-200' },
  { label: '90+ days',    count: 114, color: 'bg-red-500',    text: 'text-red-700',    bg: 'bg-red-50',    border: 'border-red-200'    },
];
const ATRISK_TOTAL = atRiskBuckets.reduce((s, b) => s + b.count, 0);

const atRiskByTier = [
  { tier: 'Platinum', total: 312,  inactive: 19,  pct: 6.1  },
  { tier: 'Gold',     total: 1842, inactive: 221, pct: 12.0 },
  { tier: 'Silver',   total: 2667, inactive: 384, pct: 14.4 },
];

const atRiskByState = [
  { state: 'Maharashtra', count: 142 },
  { state: 'Delhi NCR',   count: 98  },
  { state: 'Karnataka',   count: 87  },
  { state: 'Tamil Nadu',  count: 76  },
  { state: 'Gujarat',     count: 61  },
  { state: 'Others',      count: 160 },
];
const STATE_MAX = atRiskByState[0].count;

// ── Sales team engagement ─────────────────────────────────────────────────────
const salesEngagement = [
  { label: 'Active Reps (this month)', value: '48 / 52', sub: '92% of field force',         good: true  },
  { label: 'Avg Logins / Rep / Month', value: '18',      sub: 'vs 14 last month',           good: true  },
  { label: 'Outlets Visited via App',  value: '1,242',   sub: 'across all territories',     good: true  },
  { label: 'KYC Submitted This Month', value: '89',      sub: '6 pending submission',        good: false },
];

// ── Notification engagement ───────────────────────────────────────────────────
const notifTypes = [
  { type: 'Points Credited',    sent: 3842, opened: 3265, rate: 85 },
  { type: 'Rank Improved',      sent: 1240, opened:  918, rate: 74 },
  { type: 'Target Reminder',    sent: 2800, opened: 1596, rate: 57 },
  { type: 'Scheme Launched',    sent: 4821, opened: 2314, rate: 48 },
  { type: 'Redemption Ready',   sent:  562, opened:  489, rate: 87 },
  { type: 'Inactivity Nudge',   sent:  624, opened:  281, rate: 45 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function rateBarColor(rate: number) {
  if (rate >= 75) return 'bg-green-500';
  if (rate >= 50) return 'bg-amber-400';
  return 'bg-red-400';
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function EngagementDashboardPage() {
  return (
    <div className="space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight" style={{ color: DARK_NAVY }}>
          Engagement Dashboard
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Portal usage, feature adoption and at-risk partner signals
        </p>
      </div>

      {/* Filters */}
      <FilterBar showOutletType />

      {/* ── Summary KPIs ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {summaryKpis.map((k) => {
          const Icon = k.icon;
          return (
            <div key={k.label} className={`rounded-xl border ${k.border} ${k.bg} p-4 flex flex-col gap-3`}>
              <div className="flex items-center justify-between">
                <div className={`p-2 rounded-lg bg-white/60`}>
                  <Icon className={`w-4 h-4 ${k.iconColor}`} />
                </div>
                <span className={`inline-flex items-center gap-0.5 text-[11px] font-bold px-1.5 py-0.5 rounded-full ${
                  k.momGood ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-600'
                }`}>
                  {k.momGood ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {k.mom} MoM
                </span>
              </div>
              <div>
                <p className={`text-2xl font-bold ${k.valColor}`}>{k.value}</p>
                <p className="text-xs text-gray-500 mt-0.5">{k.label}</p>
              </div>
              <p className="text-[11px] text-gray-400">{k.sub}</p>
            </div>
          );
        })}
      </div>

      {/* ── Active User Trend + Login Frequency ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Active user trend — line chart (2/3 width) */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Active User Trend</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">DAU / WAU / MAU over last 6 months</p>
          </CardHeader>
          <CardContent className="pb-4">
            <ResponsiveContainer width="100%" height={230}>
              <LineChart data={userTrendData} margin={{ top: 4, right: 12, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="MAU" stroke={PRIMARY_GREEN} strokeWidth={2.5} dot={{ r: 3, strokeWidth: 0, fill: PRIMARY_GREEN }} />
                <Line type="monotone" dataKey="WAU" stroke="#6366f1"      strokeWidth={2}   dot={{ r: 3, strokeWidth: 0, fill: '#6366f1' }} />
                <Line type="monotone" dataKey="DAU" stroke="#f59e0b"      strokeWidth={2}   dot={{ r: 3, strokeWidth: 0, fill: '#f59e0b' }} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Login frequency distribution (1/3 width) */}
        <Card>
          <CardHeader>
            <CardTitle>Login Frequency</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">Partner logins per month</p>
          </CardHeader>
          <CardContent className="pb-4 space-y-3">
            {loginFreqData.map((f) => (
              <div key={f.label}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-gray-700 whitespace-pre-line leading-tight">
                    {f.label}
                  </span>
                  <span className="text-xs font-bold text-gray-600 ml-2 shrink-0">
                    {f.pct}% <span className="font-normal text-gray-400">({f.count.toLocaleString('en-IN')})</span>
                  </span>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${f.pct}%`, backgroundColor: f.color }} />
                </div>
              </div>
            ))}
            <p className="text-[10px] text-gray-400 pt-1">Based on 4,821 registered partners · May 2026</p>
          </CardContent>
        </Card>
      </div>

      {/* ── Feature Adoption + Catalogue Funnel ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Feature adoption */}
        <Card>
          <CardHeader>
            <CardTitle>Feature Adoption</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">% of MAU who visited each section this month</p>
          </CardHeader>
          <CardContent className="pb-5 space-y-3.5">
            {featureAdoption
              .slice()
              .sort((a, b) => b.pct - a.pct)
              .map((f) => {
                const Icon = f.icon;
                return (
                  <div key={f.label}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <div className="w-5 h-5 rounded flex items-center justify-center shrink-0" style={{ backgroundColor: `${f.color}18` }}>
                        <Icon className="w-3 h-3" style={{ color: f.color }} />
                      </div>
                      <span className="text-xs font-medium text-gray-700 flex-1">{f.label}</span>
                      <span className="text-xs font-bold shrink-0" style={{ color: f.color }}>{f.pct}%</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${f.pct}%`, backgroundColor: f.color }} />
                    </div>
                  </div>
                );
              })}
          </CardContent>
        </Card>

        {/* Catalogue redemption funnel */}
        <Card>
          <CardHeader>
            <CardTitle>Gift Catalogue Funnel</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">From catalogue view to completed redemption · May 2026</p>
          </CardHeader>
          <CardContent className="pb-5 space-y-3">
            {funnelSteps.map((step, i) => {
              const barW     = (step.count / FUNNEL_MAX) * 100;
              const dropPct  = i > 0
                ? Math.round((1 - step.count / funnelSteps[i - 1].count) * 100)
                : null;
              return (
                <div key={step.label}>
                  {dropPct !== null && (
                    <div className="flex items-center gap-1.5 py-0.5 pl-1">
                      <ArrowRight className="w-3 h-3 text-gray-300" />
                      <span className="text-[10px] text-red-400 font-semibold">−{dropPct}% drop-off</span>
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-medium text-gray-600 w-40 shrink-0">{step.label}</span>
                    <div className="flex-1 h-6 bg-gray-100 rounded-lg overflow-hidden flex items-center">
                      <div
                        className="h-full rounded-lg flex items-center justify-end pr-2 transition-all"
                        style={{ width: `${barW}%`, backgroundColor: step.color }}
                      >
                        <span className="text-[10px] font-bold text-white whitespace-nowrap">
                          {step.count.toLocaleString('en-IN')}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="pt-2 border-t border-gray-100 flex items-center justify-between">
              <span className="text-xs text-gray-500">Overall conversion</span>
              <span className="text-sm font-bold text-green-600">
                {Math.round((funnelSteps[3].count / funnelSteps[0].count) * 100)}%
                <span className="text-xs font-normal text-gray-400 ml-1">catalogue view → redeemed</span>
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Notification Engagement ── */}
      <Card>
        <CardHeader>
          <CardTitle>Notification Engagement</CardTitle>
          <p className="text-xs text-gray-400 mt-0.5">In-app &amp; push notification open rates by type · May 2026</p>
        </CardHeader>
        <CardContent className="pb-5">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2.5 px-4 text-xs font-semibold text-gray-500">Notification Type</th>
                  <th className="text-right py-2.5 px-4 text-xs font-semibold text-gray-500">Sent</th>
                  <th className="text-right py-2.5 px-4 text-xs font-semibold text-gray-500">Opened</th>
                  <th className="py-2.5 px-4 text-xs font-semibold text-gray-500 w-48">Open Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {notifTypes
                  .slice()
                  .sort((a, b) => b.rate - a.rate)
                  .map((n) => (
                    <tr key={n.type} className="hover:bg-gray-50 transition-colors">
                      <td className="py-3 px-4 font-medium text-gray-800">{n.type}</td>
                      <td className="py-3 px-4 text-right text-gray-500 text-xs">{n.sent.toLocaleString('en-IN')}</td>
                      <td className="py-3 px-4 text-right text-gray-700 font-medium text-xs">{n.opened.toLocaleString('en-IN')}</td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${rateBarColor(n.rate)}`} style={{ width: `${n.rate}%` }} />
                          </div>
                          <span className={`text-xs font-bold w-8 text-right shrink-0 ${
                            n.rate >= 75 ? 'text-green-600' : n.rate >= 50 ? 'text-amber-600' : 'text-red-500'
                          }`}>{n.rate}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ── At-Risk Partners ── */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>At-Risk Partners</CardTitle>
              <p className="text-xs text-gray-400 mt-0.5">
                Partners with no login activity · {ATRISK_TOTAL.toLocaleString('en-IN')} total at risk
              </p>
            </div>
            <span className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-full shrink-0">
              {((ATRISK_TOTAL / 4821) * 100).toFixed(1)}% of base
            </span>
          </div>
        </CardHeader>
        <CardContent className="pb-6 space-y-6">

          {/* Inactivity buckets */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {atRiskBuckets.map((b) => (
              <div key={b.label} className={`rounded-xl border ${b.border} ${b.bg} px-4 py-4`}>
                <p className={`text-3xl font-bold ${b.text}`}>{b.count.toLocaleString('en-IN')}</p>
                <p className={`text-sm font-semibold ${b.text} mt-0.5`}>{b.label} inactive</p>
                <p className="text-[11px] text-gray-500 mt-1">
                  {((b.count / ATRISK_TOTAL) * 100).toFixed(0)}% of at-risk partners
                </p>
              </div>
            ))}
          </div>

          {/* By tier + by state side by side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* By tier */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">By Partner Tier</p>
              <div className="space-y-3">
                {atRiskByTier.map((t) => (
                  <div key={t.tier}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-gray-700">{t.tier}</span>
                      <span className={`text-xs font-bold ${t.pct >= 13 ? 'text-red-500' : t.pct >= 8 ? 'text-amber-600' : 'text-green-600'}`}>
                        {t.inactive} inactive ({t.pct}%)
                      </span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${t.pct >= 13 ? 'bg-red-400' : t.pct >= 8 ? 'bg-amber-400' : 'bg-green-500'}`}
                        style={{ width: `${t.pct}%` }}
                      />
                    </div>
                    <p className="text-[10px] text-gray-400 mt-0.5">{t.total.toLocaleString('en-IN')} total partners in tier</p>
                  </div>
                ))}
              </div>
            </div>

            {/* By state */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">By State</p>
              <div className="space-y-2.5">
                {atRiskByState.map((s) => (
                  <div key={s.state} className="flex items-center gap-3">
                    <span className="text-xs font-medium text-gray-700 w-28 shrink-0">{s.state}</span>
                    <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-amber-400" style={{ width: `${(s.count / STATE_MAX) * 100}%` }} />
                    </div>
                    <span className="text-xs font-bold text-gray-600 w-8 text-right shrink-0">{s.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Sales Team Engagement ── */}
      <Card>
        <CardHeader>
          <CardTitle>Sales Team Engagement</CardTitle>
          <p className="text-xs text-gray-400 mt-0.5">Field force portal activity · May 2026</p>
        </CardHeader>
        <CardContent className="pb-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {salesEngagement.map((s) => (
              <div key={s.label} className={`rounded-xl border p-4 ${s.good ? 'bg-green-50 border-green-100' : 'bg-amber-50 border-amber-100'}`}>
                <p className={`text-2xl font-bold ${s.good ? 'text-green-700' : 'text-amber-700'}`}>{s.value}</p>
                <p className={`text-xs font-semibold mt-0.5 ${s.good ? 'text-green-700' : 'text-amber-700'}`}>{s.label}</p>
                <p className="text-[11px] text-gray-500 mt-1">{s.sub}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
