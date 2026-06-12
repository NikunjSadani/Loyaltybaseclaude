'use client';

import React from 'react';
import { FilterBar } from '@/components/admin/filter-bar';
import {
  PieChart, Pie, Cell,
  LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Gift, Coins, Package, CheckCircle, Truck, Clock, TrendingDown } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

// ── Constants ─────────────────────────────────────────────────────────────────
const PRIMARY_GREEN = 'var(--brand-primary)';
const DARK_NAVY     = '#1A1A2E';

// ── Stat cards ────────────────────────────────────────────────────────────────
const statCards = [
  { label: 'Total Redemptions', value: '1,842',       icon: Gift,        iconBg: 'bg-green-100',  iconColor: 'text-green-600',  valuColor: 'text-green-700',  borderAccent: 'border-l-green-500'  },
  { label: 'Points Consumed',   value: '42,18,500 pts',icon: Coins,       iconBg: 'bg-purple-100', iconColor: 'text-purple-600', valuColor: 'text-purple-700', borderAccent: 'border-l-purple-500' },
  { label: 'Pending Delivery',  value: '38',           icon: Package,     iconBg: 'bg-amber-100',  iconColor: 'text-amber-600',  valuColor: 'text-amber-700',  borderAccent: 'border-l-amber-500'  },
  { label: 'Completed',         value: '1,804',        icon: CheckCircle, iconBg: 'bg-blue-100',   iconColor: 'text-blue-600',   valuColor: 'text-blue-700',   borderAccent: 'border-l-blue-500'   },
];

// ── Donut chart — updated categories ─────────────────────────────────────────
const categoryData = [
  { name: 'Vouchers',             value: 60 },
  { name: 'Electronics',          value: 18 },
  { name: 'Kitchen',              value: 10 },
  { name: 'Home',                 value: 7  },
  { name: 'Personal Appliances',  value: 5  },
];

const CATEGORY_COLORS = ['var(--brand-primary)', '#6366f1', '#f59e0b', '#e91e63', '#0891b2'];

// ── Category pill styles ──────────────────────────────────────────────────────
const CATEGORY_PILL: Record<string, string> = {
  Vouchers:            'bg-green-50 text-green-700 border-green-200',
  Electronics:         'bg-indigo-50 text-indigo-700 border-indigo-200',
  Kitchen:             'bg-amber-50 text-amber-700 border-amber-200',
  Home:                'bg-pink-50 text-pink-700 border-pink-200',
  'Personal Appliances':'bg-cyan-50 text-cyan-700 border-cyan-200',
};

// ── Monthly trend ─────────────────────────────────────────────────────────────
const monthlyTrendData = [
  { month: 'Oct', redemptions: 248 },
  { month: 'Nov', redemptions: 312 },
  { month: 'Dec', redemptions: 421 },
  { month: 'Jan', redemptions: 287 },
  { month: 'Feb', redemptions: 318 },
  { month: 'Mar', redemptions: 256 },
];

// ── Top gifts ─────────────────────────────────────────────────────────────────
const topGifts = [
  { rank: 1, name: 'Amazon Voucher ₹500',    category: 'Vouchers',            redemptions: 312, pointsConsumed: '1,56,000', avgPoints: 500  },
  { rank: 2, name: 'JBL Bluetooth Speaker',  category: 'Electronics',         redemptions: 187, pointsConsumed: '4,67,500', avgPoints: 2500 },
  { rank: 3, name: 'Swiggy Voucher ₹300',    category: 'Vouchers',            redemptions: 163, pointsConsumed: '48,900',   avgPoints: 300  },
  { rank: 4, name: 'Mixer Grinder',          category: 'Kitchen',             redemptions: 124, pointsConsumed: '4,96,000', avgPoints: 4000 },
  { rank: 5, name: 'Smart Watch',            category: 'Electronics',         redemptions: 98,  pointsConsumed: '4,90,000', avgPoints: 5000 },
  { rank: 6, name: 'Petrol Card ₹500',       category: 'Vouchers',            redemptions: 87,  pointsConsumed: '52,200',   avgPoints: 600  },
];

// ── Delivery time data ────────────────────────────────────────────────────────
// Average days from order date to delivery, per category
const deliveryByCategory = [
  { category: 'Vouchers',            avgDays: 0.3,  color: 'var(--brand-primary)', note: 'Instant / digital'      },
  { category: 'Electronics',         avgDays: 6.8,  color: '#6366f1', note: 'Courier · 5–8 days'     },
  { category: 'Kitchen',             avgDays: 5.4,  color: '#f59e0b', note: 'Courier · 4–7 days'     },
  { category: 'Home',                avgDays: 7.2,  color: '#e91e63', note: 'Courier · 6–9 days'     },
  { category: 'Personal Appliances', avgDays: 8.1,  color: '#0891b2', note: 'Courier · 7–10 days'    },
];

// Weighted avg: Vouchers 60% × 0.3d + Electronics 18% × 6.8d + ...
const OVERALL_AVG_DAYS = 3.0;
const PREV_MONTH_AVG   = 3.4; // April — for MoM comparison

// Monthly delivery trend (avg days per month)
const deliveryTrendData = [
  { month: 'Oct', avgDays: 4.8 },
  { month: 'Nov', avgDays: 4.2 },
  { month: 'Dec', avgDays: 5.1 },   // peak — holiday season volume
  { month: 'Jan', avgDays: 3.9 },
  { month: 'Feb', avgDays: 3.6 },
  { month: 'Mar', avgDays: 3.4 },
];

const MAX_DELIVERY_DAYS = Math.max(...deliveryByCategory.map((d) => d.avgDays));

// ── Donut legend ──────────────────────────────────────────────────────────────
function DonutLegend() {
  return (
    <div className="flex flex-col gap-2 justify-center pl-2">
      {categoryData.map((entry, index) => (
        <div key={entry.name} className="flex items-center gap-2">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: CATEGORY_COLORS[index] }}
          />
          <span className="text-xs text-gray-600 flex-1">{entry.name}</span>
          <span className="text-xs font-bold text-gray-800 pl-2">{entry.value}%</span>
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function AdminRedemptionsDashboardPage() {
  const momChange = ((OVERALL_AVG_DAYS - PREV_MONTH_AVG) / PREV_MONTH_AVG * 100).toFixed(1);
  const momGood   = OVERALL_AVG_DAYS < PREV_MONTH_AVG; // lower days = better

  return (
    <div className="space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight" style={{ color: DARK_NAVY }}>
          Gift Redemption Dashboard
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Track redemption requests, fulfilment and popular gifts
        </p>
      </div>

      {/* Filters */}
      <FilterBar />

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <Card key={card.label} className={`border-l-4 ${card.borderAccent}`}>
              <CardContent className="pt-5 pb-5">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-500 font-medium">{card.label}</p>
                    <p className={`text-2xl font-bold mt-1 leading-tight ${card.valuColor}`}>{card.value}</p>
                  </div>
                  <div className={`w-10 h-10 rounded-xl ${card.iconBg} flex items-center justify-center shrink-0 ml-3`}>
                    <Icon className={`h-5 w-5 ${card.iconColor}`} />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Donut — Redemptions by Category */}
        <Card>
          <CardHeader><CardTitle>Redemptions by Category</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <ResponsiveContainer width="55%" height={220}>
                <PieChart>
                  <Pie
                    data={categoryData}
                    cx="50%" cy="50%"
                    innerRadius={58} outerRadius={88}
                    paddingAngle={3} dataKey="value" strokeWidth={0}
                  >
                    {categoryData.map((_, i) => (
                      <Cell key={i} fill={CATEGORY_COLORS[i]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: unknown) => [`${value as number}%`, 'Share']}
                    contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '12px' }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex-1">
                <DonutLegend />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Line — Monthly Redemption Trend */}
        <Card>
          <CardHeader><CardTitle>Monthly Redemption Trend</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={monthlyTrendData} margin={{ top: 4, right: 12, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '12px' }}
                  formatter={(value: unknown) => [value as number, 'Redemptions']}
                />
                <Line
                  type="monotone" dataKey="redemptions"
                  stroke={PRIMARY_GREEN} strokeWidth={2.5}
                  dot={{ fill: PRIMARY_GREEN, r: 4, strokeWidth: 0 }}
                  activeDot={{ r: 6, fill: PRIMARY_GREEN }}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Delivery Time */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Average Delivery Time</CardTitle>
              <p className="text-xs text-gray-400 mt-0.5">
                Days from order date to delivery · May 2026
              </p>
            </div>
            {/* MoM badge */}
            <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 ${
              momGood ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-600 border border-red-200'
            }`}>
              <TrendingDown className="w-3 h-3" />
              {momChange}% vs Apr 2026
            </span>
          </div>
        </CardHeader>

        <CardContent className="pb-6 space-y-6">

          {/* Summary tiles */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-green-50 border border-green-100 rounded-xl px-4 py-4">
              <div className="flex items-center gap-1.5 mb-2">
                <Truck className="w-4 h-4 text-green-600" />
                <span className="text-xs font-semibold text-green-700">Overall Average</span>
              </div>
              <p className="text-3xl font-bold text-green-700">{OVERALL_AVG_DAYS} <span className="text-base font-medium">days</span></p>
              <p className="text-[11px] text-green-600 mt-1">across all categories</p>
            </div>

            <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-4">
              <div className="flex items-center gap-1.5 mb-2">
                <Clock className="w-4 h-4 text-blue-600" />
                <span className="text-xs font-semibold text-blue-700">Fastest Category</span>
              </div>
              <p className="text-3xl font-bold text-blue-700">0.3 <span className="text-base font-medium">days</span></p>
              <p className="text-[11px] text-blue-600 mt-1">Vouchers — instant digital delivery</p>
            </div>

            <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-4">
              <div className="flex items-center gap-1.5 mb-2">
                <Package className="w-4 h-4 text-amber-600" />
                <span className="text-xs font-semibold text-amber-700">Slowest Category</span>
              </div>
              <p className="text-3xl font-bold text-amber-700">8.1 <span className="text-base font-medium">days</span></p>
              <p className="text-[11px] text-amber-600 mt-1">Personal Appliances — courier</p>
            </div>
          </div>

          {/* Per-category bars */}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Breakdown by Category</p>
            {deliveryByCategory.map((d) => {
              const barW = (d.avgDays / MAX_DELIVERY_DAYS) * 100;
              return (
                <div key={d.category} className="flex items-center gap-3">
                  <span className="text-xs font-medium text-gray-700 w-36 shrink-0">{d.category}</span>
                  <div className="flex-1 h-2.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${barW}%`, backgroundColor: d.color }}
                    />
                  </div>
                  <span className="text-xs font-bold text-gray-700 w-14 text-right shrink-0">
                    {d.avgDays === 0.3 ? '~0.3d' : `${d.avgDays}d`}
                  </span>
                  <span className="text-[10px] text-gray-400 w-36 shrink-0 hidden sm:block">{d.note}</span>
                </div>
              );
            })}
          </div>

          {/* Trend line — avg delivery days over time */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Monthly Trend — Avg Delivery Days</p>
            <ResponsiveContainer width="100%" height={140}>
              <LineChart data={deliveryTrendData} margin={{ top: 4, right: 12, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} domain={[0, 6]} />
                <Tooltip
                  contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '12px' }}
                  formatter={(value: unknown) => [`${value as number} days`, 'Avg Delivery']}
                />
                <Line
                  type="monotone" dataKey="avgDays"
                  stroke="#6366f1" strokeWidth={2}
                  dot={{ fill: '#6366f1', r: 3, strokeWidth: 0 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

        </CardContent>
      </Card>

      {/* Top Redeemed Gifts */}
      <Card>
        <CardHeader><CardTitle>Top Redeemed Gifts</CardTitle></CardHeader>
        <CardContent className="px-0 pb-2">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-6 pb-3">Rank</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 pb-3">Gift Name</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 pb-3">Category</th>
                  <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 pb-3">Redemptions</th>
                  <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 pb-3">Points Consumed</th>
                  <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wide px-6 pb-3">Avg Points</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {topGifts.map((gift) => (
                  <tr key={gift.rank} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-3.5">
                      <span
                        className="inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold text-white"
                        style={{ backgroundColor: gift.rank <= 3 ? PRIMARY_GREEN : DARK_NAVY }}
                      >
                        {gift.rank}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 font-medium text-gray-900">{gift.name}</td>
                    <td className="px-4 py-3.5">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${CATEGORY_PILL[gift.category] ?? 'bg-gray-100 text-gray-700 border-gray-200'}`}>
                        {gift.category}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-right font-semibold text-gray-800">{gift.redemptions}</td>
                    <td className="px-4 py-3.5 text-right text-gray-600">{gift.pointsConsumed}</td>
                    <td className="px-6 py-3.5 text-right font-semibold" style={{ color: PRIMARY_GREEN }}>{gift.avgPoints}</td>
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
