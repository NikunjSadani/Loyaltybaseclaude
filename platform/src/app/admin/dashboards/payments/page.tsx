'use client';

import React from 'react';
import { FilterBar } from '@/components/admin/filter-bar';
import {
  TrendingUp,
  ArrowDownRight,
  Coins,
  Wallet,
  CheckCircle2,
  Clock,
  AlertCircle,
} from 'lucide-react';
import {
  ComposedChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

// ── Constants ────────────────────────────────────────────────────────────────

const PRIMARY = 'var(--brand-primary)';
const DARK_NAVY = '#1A1A2E';

// ── Data ─────────────────────────────────────────────────────────────────────

const monthlyData = [
  { month: 'Oct', issued: 285000, redeemed: 82000 },
  { month: 'Nov', issued: 312000, redeemed: 95000 },
  { month: 'Dec', issued: 398000, redeemed: 142000 },
  { month: 'Jan', issued: 275000, redeemed: 88000 },
  { month: 'Feb', issued: 318000, redeemed: 103000 },
  { month: 'Mar', issued: 241000, redeemed: 76000 },
];

const fundTrendData = [
  { month: 'Oct', balance: 32.1 },
  { month: 'Nov', balance: 28.4 },
  { month: 'Dec', balance: 24.8 },
  { month: 'Jan', balance: 31.2 },
  { month: 'Feb', balance: 27.9 },
  { month: 'Mar', balance: 24.6 },
];

const payoutBatches = [
  {
    id: 'BATCH-2024-031',
    period: 'Mar 1–15, 2024',
    outlets: 148,
    totalPoints: '2,41,000',
    status: 'Completed' as const,
    date: '15 Mar 2024',
  },
  {
    id: 'BATCH-2024-030',
    period: 'Feb 16–28, 2024',
    outlets: 162,
    totalPoints: '3,18,000',
    status: 'Completed' as const,
    date: '28 Feb 2024',
  },
  {
    id: 'BATCH-2024-029',
    period: 'Feb 1–15, 2024',
    outlets: 155,
    totalPoints: '2,75,000',
    status: 'Processing' as const,
    date: '15 Feb 2024',
  },
  {
    id: 'BATCH-2024-028',
    period: 'Jan 16–31, 2024',
    outlets: 171,
    totalPoints: '3,98,000',
    status: 'Completed' as const,
    date: '31 Jan 2024',
  },
  {
    id: 'BATCH-2024-027',
    period: 'Jan 1–15, 2024',
    outlets: 139,
    totalPoints: '3,12,000',
    status: 'Pending' as const,
    date: '15 Jan 2024',
  },
  {
    id: 'BATCH-2024-026',
    period: 'Dec 16–31, 2023',
    outlets: 158,
    totalPoints: '2,85,000',
    status: 'Completed' as const,
    date: '31 Dec 2023',
  },
];

const topOutlets = [
  { rank: 1, name: 'Kumar General Store', points: 28400 },
  { rank: 2, name: 'Singh Supermart', points: 24100 },
  { rank: 3, name: 'Patel Grocery', points: 19800 },
  { rank: 4, name: 'Sharma Kirana', points: 16500 },
  { rank: 5, name: 'Mehta Provisions', points: 12300 },
];

const MAX_OUTLET_POINTS = 28400;

// ── Payout SLA data ───────────────────────────────────────────────────────────
// SLA threshold: payouts should be processed within 3 business days of batch creation

const PAYOUT_SLA_THRESHOLD_DAYS = 3;

const payoutSlaCards = [
  {
    label:      'Completed On Time',
    count:      1842,
    amount:     '₹38.4L',
    sublabel:   'processed within SLA',
    icon:       CheckCircle2,
    color:      'text-emerald-700',
    bg:         'bg-emerald-50',
    border:     'border-emerald-200',
    iconColor:  'text-emerald-600',
    barColor:   'bg-emerald-500',
    share:      84,   // % of total
  },
  {
    label:      'Pending / In Progress',
    count:      214,
    amount:     '₹8.2L',
    sublabel:   'awaiting processing',
    icon:       Clock,
    color:      'text-amber-700',
    bg:         'bg-amber-50',
    border:     'border-amber-200',
    iconColor:  'text-amber-600',
    barColor:   'bg-amber-400',
    share:      10,
  },
  {
    label:      'Failed / Rejected',
    count:      23,
    amount:     '₹1.1L',
    sublabel:   'require manual intervention',
    icon:       AlertCircle,
    color:      'text-red-700',
    bg:         'bg-red-50',
    border:     'border-red-200',
    iconColor:  'text-red-500',
    barColor:   'bg-red-500',
    share:      1,
  },
];

const PAYOUT_TOTAL_TXN = payoutSlaCards.reduce((s, c) => s + c.count, 0);


// ── Helpers ──────────────────────────────────────────────────────────────────

function formatLakh(value: number): string {
  const lakh = value / 100000;
  return `${lakh % 1 === 0 ? lakh.toFixed(0) : lakh.toFixed(1)}L`;
}

function pointsTickFormatter(value: number): string {
  return formatLakh(value);
}

function balanceTickFormatter(value: number): string {
  return `₹${value}L`;
}

type BatchStatus = 'Completed' | 'Processing' | 'Pending';

function statusVariant(
  status: BatchStatus,
): 'success' | 'info' | 'warning' {
  if (status === 'Completed') return 'success';
  if (status === 'Processing') return 'info';
  return 'warning';
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string;
  icon: React.ReactNode;
  iconBg: string;
  valueColor: string;
}

function StatCard({ label, value, icon, iconBg, valueColor }: StatCardProps) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-gray-500 font-medium truncate">{label}</p>
            <p
              className="mt-1 text-2xl font-bold tracking-tight truncate"
              style={{ color: valueColor }}
            >
              {value}
            </p>
          </div>
          <div
            className="flex-shrink-0 w-11 h-11 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: iconBg }}
          >
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminPaymentsDashboardPage() {
  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight" style={{ color: DARK_NAVY }}>
          Payments Dashboard
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Monitor points issuance, redemptions and fund health
        </p>
      </div>

      {/* ── Filters ── */}
      <FilterBar />

      {/* ── Stat Cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          label="Total Points Issued"
          value="18,42,500 pts"
          icon={<TrendingUp size={20} color={PRIMARY} />}
          iconBg="#dcfce7"
          valueColor={PRIMARY}
        />
        <StatCard
          label="Points Redeemed"
          value="6,31,200 pts"
          icon={<ArrowDownRight size={20} color="#2563eb" />}
          iconBg="#dbeafe"
          valueColor="#2563eb"
        />
        <StatCard
          label="Points Outstanding"
          value="11,11,300 pts"
          icon={<Coins size={20} color="#7c3aed" />}
          iconBg="#ede9fe"
          valueColor="#7c3aed"
        />
        <StatCard
          label="Fund Balance"
          value="₹24.6L"
          icon={<Wallet size={20} color="#d97706" />}
          iconBg="#fef3c7"
          valueColor="#d97706"
        />
      </div>

      {/* ── Charts Row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Points Issued vs Redeemed */}
        <Card>
          <CardHeader>
            <CardTitle>Points Issued vs Redeemed</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">Last 6 months</p>
          </CardHeader>
          <CardContent className="pb-6">
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart
                data={monthlyData}
                margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 12, fill: '#6b7280' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={pointsTickFormatter}
                  tick={{ fontSize: 12, fill: '#6b7280' }}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                />
                <Tooltip
                  formatter={(value, name) => [
                    typeof value === 'number' ? `${value.toLocaleString('en-IN')} pts` : value,
                    name === 'issued' ? 'Issued' : 'Redeemed',
                  ]}
                  contentStyle={{
                    borderRadius: 8,
                    border: '1px solid #e5e7eb',
                    fontSize: 12,
                  }}
                />
                <Legend
                  formatter={(value) =>
                    value === 'issued' ? 'Issued' : 'Redeemed'
                  }
                  iconType="square"
                  wrapperStyle={{ fontSize: 12 }}
                />
                <Bar
                  dataKey="issued"
                  fill={PRIMARY}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={32}
                />
                <Bar
                  dataKey="redeemed"
                  fill="#6366f1"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={32}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Fund Balance Trend */}
        <Card>
          <CardHeader>
            <CardTitle>Fund Balance Trend</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">Last 6 months</p>
          </CardHeader>
          <CardContent className="pb-6">
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart
                data={fundTrendData}
                margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="fundGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={PRIMARY} stopOpacity={0.2} />
                    <stop offset="95%" stopColor={PRIMARY} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 12, fill: '#6b7280' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={balanceTickFormatter}
                  tick={{ fontSize: 12, fill: '#6b7280' }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  formatter={(value) => [`₹${value}L`, 'Fund Balance']}
                  contentStyle={{
                    borderRadius: 8,
                    border: '1px solid #e5e7eb',
                    fontSize: 12,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="balance"
                  stroke={PRIMARY}
                  strokeWidth={2}
                  fill="url(#fundGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* ── Payout SLA ── */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Payout SLA</CardTitle>
              <p className="text-xs text-gray-400 mt-0.5">
                Processing SLA threshold: {PAYOUT_SLA_THRESHOLD_DAYS} business days · {PAYOUT_TOTAL_TXN.toLocaleString('en-IN')} total transactions
              </p>
            </div>
            {/* Overall SLA compliance badge */}
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 shrink-0">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              <span className="text-xs font-semibold text-emerald-700">84% SLA compliance</span>
            </div>
          </div>
        </CardHeader>

        <CardContent className="pb-6 space-y-6">

          {/* Status tiles */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {payoutSlaCards.map((c) => {
              const Icon = c.icon;
              return (
                <div key={c.label} className={`rounded-xl border ${c.border} ${c.bg} px-4 py-4`}>
                  <div className="flex items-center justify-between mb-3">
                    <Icon className={`w-5 h-5 ${c.iconColor}`} />
                    <span className={`text-xs font-bold ${c.color}`}>
                      {c.share}% of total
                    </span>
                  </div>
                  <p className={`text-2xl font-bold ${c.color}`}>{c.amount}</p>
                  <p className={`text-sm font-semibold ${c.color} mt-0.5`}>
                    {c.count.toLocaleString('en-IN')} txns
                  </p>
                  <p className="text-xs text-gray-500 mt-1">{c.sublabel}</p>
                </div>
              );
            })}
          </div>

          {/* Distribution bar */}
          <div>
            <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
              <span className="font-medium">Transaction distribution</span>
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"/>Completed</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block"/>Pending</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block"/>Failed</span>
              </div>
            </div>
            <div className="h-3 w-full bg-gray-100 rounded-full overflow-hidden flex">
              {payoutSlaCards.map((c) => (
                <div
                  key={c.label}
                  className={`h-full ${c.barColor} transition-all`}
                  style={{ width: `${(c.count / PAYOUT_TOTAL_TXN) * 100}%` }}
                />
              ))}
            </div>
          </div>

        </CardContent>
      </Card>

      {/* ── Bottom Row ── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Payout Batches table — takes 2 cols */}
        <div className="xl:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Payout Batches</CardTitle>
              <p className="text-xs text-gray-400 mt-0.5">
                Recent batch processing history
              </p>
            </CardHeader>
            <CardContent className="pb-2">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      {[
                        'Batch ID',
                        'Period',
                        'Outlets',
                        'Total Points',
                        'Status',
                        'Date',
                      ].map((col) => (
                        <th
                          key={col}
                          className="py-3 px-2 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide whitespace-nowrap first:pl-0 last:pr-0"
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {payoutBatches.map((batch) => (
                      <tr
                        key={batch.id}
                        className="hover:bg-gray-50 transition-colors"
                      >
                        <td className="py-3 px-2 first:pl-0 font-mono text-xs text-gray-700 whitespace-nowrap">
                          {batch.id}
                        </td>
                        <td className="py-3 px-2 text-gray-600 whitespace-nowrap">
                          {batch.period}
                        </td>
                        <td className="py-3 px-2 text-gray-700 text-center">
                          {batch.outlets}
                        </td>
                        <td className="py-3 px-2 text-gray-700 whitespace-nowrap font-medium">
                          {batch.totalPoints} pts
                        </td>
                        <td className="py-3 px-2">
                          <Badge variant={statusVariant(batch.status)}>
                            {batch.status}
                          </Badge>
                        </td>
                        <td className="py-3 px-2 text-gray-500 whitespace-nowrap last:pr-0">
                          {batch.date}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Top 5 Earning Outlets */}
        <div className="xl:col-span-1">
          <Card className="h-full">
            <CardHeader>
              <CardTitle>Top 5 Earning Outlets</CardTitle>
              <p className="text-xs text-gray-400 mt-0.5">
                By points earned this month
              </p>
            </CardHeader>
            <CardContent className="pb-6">
              <ul className="space-y-4">
                {topOutlets.map((outlet) => {
                  const pct = Math.round(
                    (outlet.points / MAX_OUTLET_POINTS) * 100,
                  );
                  return (
                    <li key={outlet.rank} className="flex items-center gap-3">
                      {/* Rank bubble */}
                      <span
                        className="flex-shrink-0 w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center"
                        style={{
                          backgroundColor:
                            outlet.rank === 1 ? '#fef9c3' : '#f3f4f6',
                          color:
                            outlet.rank === 1 ? '#854d0e' : '#6b7280',
                        }}
                      >
                        {outlet.rank}
                      </span>

                      {/* Name + bar + pts */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-gray-800 truncate">
                            {outlet.name}
                          </span>
                          <span className="ml-2 flex-shrink-0 text-xs font-semibold text-gray-500">
                            {outlet.points.toLocaleString('en-IN')} pts
                          </span>
                        </div>
                        {/* Progress bar */}
                        <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: PRIMARY,
                            }}
                          />
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
