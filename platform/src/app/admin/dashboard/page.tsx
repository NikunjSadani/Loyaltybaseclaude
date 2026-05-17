'use client';

import { useState } from 'react';
import {
  Users,
  Clock,
  Eye,
  TrendingUp,
  Wallet,
  AlertTriangle,
  CheckCircle,
  XCircle,
  ArrowUpRight,
  ArrowDownRight,
  Activity,
} from 'lucide-react';
import { BillingTrendChart } from '@/components/charts/billing-trend';

const kpiCards = [
  {
    label: 'Total Active Partners',
    value: '4,821',
    change: '+143 this month',
    positive: true,
    icon: Users,
    color: 'bg-blue-50 text-blue-600',
    border: 'border-blue-100',
  },
  {
    label: 'Pending KYC',
    value: '214',
    change: '38 breached SLA',
    positive: false,
    icon: Clock,
    color: 'bg-amber-50 text-amber-600',
    border: 'border-amber-100',
  },
  {
    label: 'Pending Visibility Approvals',
    value: '1,092',
    change: '+312 since yesterday',
    positive: false,
    icon: Eye,
    color: 'bg-purple-50 text-purple-600',
    border: 'border-purple-100',
  },
  {
    label: 'Total Points Liability',
    value: '₹2.14 Cr',
    change: '+₹18.4L this month',
    positive: false,
    icon: TrendingUp,
    color: 'bg-red-50 text-red-600',
    border: 'border-red-100',
  },
  {
    label: 'Fund Available Balance',
    value: '₹84.3L',
    change: '↓ Below threshold',
    positive: false,
    icon: Wallet,
    color: 'bg-green-50 text-green-600',
    border: 'border-green-100',
  },
];

const kycAgingData = [
  { label: '0–24 hrs', count: 112, total: 214, color: 'bg-green-500' },
  { label: '24–48 hrs', count: 64, total: 214, color: 'bg-amber-500' },
  { label: '48 hrs+', count: 38, total: 214, color: 'bg-red-500' },
];

const territoryData = [
  { territory: 'Mumbai West', billing: '₹12.4 Cr', growth: '+18.2%', positive: true },
  { territory: 'Delhi NCR North', billing: '₹10.8 Cr', growth: '+14.7%', positive: true },
  { territory: 'Bengaluru Urban', billing: '₹9.3 Cr', growth: '+21.4%', positive: true },
  { territory: 'Pune Metro', billing: '₹7.6 Cr', growth: '+9.1%', positive: true },
  { territory: 'Hyderabad Central', billing: '₹6.9 Cr', growth: '-2.3%', positive: false },
  { territory: 'Chennai South', billing: '₹5.8 Cr', growth: '+11.8%', positive: true },
  { territory: 'Kolkata East', billing: '₹4.4 Cr', growth: '-5.1%', positive: false },
  { territory: 'Ahmedabad Metro', billing: '₹3.9 Cr', growth: '+7.6%', positive: true },
];

const auditLog = [
  { id: 1, action: 'KYC Approved', subject: 'Sharma General Store (MH-2841)', user: 'Priya M.', time: '2 min ago', type: 'success' },
  { id: 2, action: 'KYC Rejected', subject: 'Ramesh Traders (DL-1034)', user: 'Amit K.', time: '8 min ago', type: 'error' },
  { id: 3, action: 'Scheme Published', subject: 'Summer Push Q2 2025', user: 'Admin', time: '24 min ago', type: 'info' },
  { id: 4, action: 'Payout Processed', subject: 'Batch APR-2025 — ₹14.2L', user: 'System', time: '1 hr ago', type: 'success' },
  { id: 5, action: 'Visibility Approved', subject: '142 images bulk approved', user: 'Sneha R.', time: '2 hrs ago', type: 'success' },
  { id: 6, action: 'Fund Received', subject: '₹50L credited — Ref TXN240501', user: 'Admin', time: '3 hrs ago', type: 'info' },
  { id: 7, action: 'User Deactivated', subject: 'TSO Rakesh Gupta (UP-Zone)', user: 'Admin', time: '4 hrs ago', type: 'warn' },
  { id: 8, action: 'KYC Re-upload Requested', subject: 'Lalitha Stores (KA-5523)', user: 'Priya M.', time: '5 hrs ago', type: 'warn' },
  { id: 9, action: 'Duplicate Flagged', subject: 'Visibility submission #VIS-8821', user: 'System', time: '6 hrs ago', type: 'error' },
  { id: 10, action: 'Scheme Archived', subject: 'Winter 2024 Sales Incentive', user: 'Admin', time: '1 day ago', type: 'warn' },
];

const logTypeStyles: Record<string, string> = {
  success: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
  info: 'bg-blue-100 text-blue-700',
  warn: 'bg-amber-100 text-amber-700',
};

const logTypeIcons: Record<string, React.ReactNode> = {
  success: <CheckCircle className="w-3.5 h-3.5" />,
  error: <XCircle className="w-3.5 h-3.5" />,
  info: <Activity className="w-3.5 h-3.5" />,
  warn: <AlertTriangle className="w-3.5 h-3.5" />,
};

export default function DashboardPage() {
  const [billingView, setBillingView] = useState<'all' | string>('all');

  return (
    <div className="space-y-6 fade-in">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        {kpiCards.map((card) => {
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
                {card.positive ? (
                  <ArrowUpRight className="w-4 h-4 text-green-500" />
                ) : (
                  <ArrowDownRight className="w-4 h-4 text-red-400" />
                )}
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{card.value}</p>
                <p className="text-xs text-gray-500 mt-0.5">{card.label}</p>
              </div>
              <p className={`text-xs font-medium ${card.positive ? 'text-green-600' : 'text-amber-600'}`}>
                {card.change}
              </p>
            </div>
          );
        })}
      </div>

      {/* Middle row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* KYC SLA Metrics */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-800 mb-1">KYC SLA Metrics</h2>
          <p className="text-xs text-gray-500 mb-4">Last 30 days performance</p>

          <div className="grid grid-cols-3 gap-3 mb-5">
            <div className="text-center">
              <p className="text-xl font-bold text-gray-900">31.2</p>
              <p className="text-xs text-gray-500 mt-0.5">Avg. Time (hrs)</p>
            </div>
            <div className="text-center">
              <p className="text-xl font-bold text-green-600">82.2%</p>
              <p className="text-xs text-gray-500 mt-0.5">SLA Compliance</p>
            </div>
            <div className="text-center">
              <p className="text-xl font-bold text-red-600">38</p>
              <p className="text-xs text-gray-500 mt-0.5">Breach Count</p>
            </div>
          </div>

          <h3 className="text-xs font-semibold text-gray-600 mb-3">Aging Distribution</h3>
          <div className="space-y-3">
            {kycAgingData.map((item) => {
              const pct = Math.round((item.count / item.total) * 100);
              return (
                <div key={item.label}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-600">{item.label}</span>
                    <span className="font-semibold text-gray-800">
                      {item.count} <span className="text-gray-400 font-normal">({pct}%)</span>
                    </span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-2">
                    <div
                      className={`${item.color} h-2 rounded-full transition-all`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
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
              className="text-xs border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[#C8102E]"
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

      {/* Bottom row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Territories Table */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-800">Top Performing Territories</h2>
              <p className="text-xs text-gray-500">April 2025</p>
            </div>
            <a href="/reports" className="text-xs text-[#C8102E] hover:text-[#a00d25] font-medium">
              View Report →
            </a>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">#</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Territory</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">Billing</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">Growth</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {territoryData.map((row, i) => (
                  <tr key={row.territory} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-2.5 text-xs text-gray-400 font-medium">{i + 1}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-800 font-medium">{row.territory}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-800 font-semibold text-right">{row.billing}</td>
                    <td className="px-4 py-2.5 text-right">
                      <span
                        className={`inline-flex items-center gap-0.5 text-xs font-semibold ${
                          row.positive ? 'text-green-600' : 'text-red-500'
                        }`}
                      >
                        {row.positive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                        {row.growth}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Activity Feed */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-800">Recent Activity</h2>
              <p className="text-xs text-gray-500">Last 10 audit log entries</p>
            </div>
            <a href="/reports" className="text-xs text-[#C8102E] hover:text-[#a00d25] font-medium">
              Full Log →
            </a>
          </div>
          <div className="divide-y divide-gray-50 overflow-y-auto max-h-80">
            {auditLog.map((entry) => (
              <div key={entry.id} className="px-4 py-3 hover:bg-gray-50 transition-colors flex items-start gap-3">
                <span
                  className={`flex-shrink-0 mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${
                    logTypeStyles[entry.type]
                  }`}
                >
                  {logTypeIcons[entry.type]}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-gray-800">{entry.action}</p>
                  <p className="text-xs text-gray-500 truncate">{entry.subject}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-xs text-gray-400">{entry.time}</p>
                  <p className="text-xs text-gray-500">{entry.user}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
