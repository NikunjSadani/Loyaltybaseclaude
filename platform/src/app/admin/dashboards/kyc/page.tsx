'use client';

import React from 'react';
import {
  PieChart, Pie, Cell,
  BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts';
import {
  Store, Clock, CheckCircle, XCircle,
  AlertTriangle, AlertCircle, TrendingUp,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { FilterBar } from '@/components/admin/filter-bar';

// ── Constants ─────────────────────────────────────────────────────────────────
const PRIMARY_GREEN = 'var(--brand-primary)';
const DARK_NAVY     = '#1A1A2E';

// ── Stat cards ────────────────────────────────────────────────────────────────
const statCards = [
  { label: 'Total Outlets',       value: 248, icon: Store,       iconBg: 'bg-gray-100',  iconColor: 'text-gray-600',  valColor: 'text-gray-900'  },
  { label: 'Pending Review',      value: 14,  icon: Clock,       iconBg: 'bg-amber-100', iconColor: 'text-amber-600', valColor: 'text-amber-700' },
  { label: 'Approved',            value: 221, icon: CheckCircle, iconBg: 'bg-green-100', iconColor: 'text-green-700', valColor: 'text-green-700' },
  { label: 'Rejected / Resubmit',value: 13,  icon: XCircle,     iconBg: 'bg-red-100',   iconColor: 'text-red-600',   valColor: 'text-red-700'   },
];

// ── Status breakdown (donut) ──────────────────────────────────────────────────
const pieData = [
  { name: 'Approved', value: 221, color: PRIMARY_GREEN },
  { name: 'Pending',  value: 14,  color: '#f59e0b'     },
  { name: 'Rejected', value: 8,   color: '#ef4444'     },
  { name: 'Resubmit', value: 5,   color: '#f97316'     },
];

// ── Monthly submissions (bar) ─────────────────────────────────────────────────
const barData = [
  { month: 'Oct', Submitted: 18, Approved: 15 },
  { month: 'Nov', Submitted: 22, Approved: 19 },
  { month: 'Dec', Submitted: 31, Approved: 26 },
  { month: 'Jan', Submitted: 28, Approved: 24 },
  { month: 'Feb', Submitted: 19, Approved: 16 },
  { month: 'Mar', Submitted: 14, Approved: 11 },
];

// ── KYC by State ──────────────────────────────────────────────────────────────
const stateData = [
  { state: 'Maharashtra', outlets: 82, approved: 76, pending: 4, rate: 92.7 },
  { state: 'Karnataka',   outlets: 54, approved: 48, pending: 3, rate: 88.9 },
  { state: 'Tamil Nadu',  outlets: 47, approved: 42, pending: 2, rate: 89.4 },
  { state: 'Gujarat',     outlets: 38, approved: 34, pending: 3, rate: 89.5 },
  { state: 'Delhi NCR',   outlets: 27, approved: 21, pending: 2, rate: 77.8 },
];

// ── Rejection reasons ─────────────────────────────────────────────────────────
const rejectionReasons = [
  { reason: 'Blurry / unreadable documents', count: 4, color: '#ef4444' },
  { reason: 'GST number mismatch',           count: 3, color: '#f97316' },
  { reason: 'Incomplete address proof',      count: 2, color: '#f59e0b' },
  { reason: 'Expired documents',             count: 2, color: '#8b5cf6' },
  { reason: 'Owner identity mismatch',       count: 2, color: '#6366f1' },
];
const totalRejections = rejectionReasons.reduce((s, r) => s + r.count, 0);

// ── SLA summary (aggregate, derived from pending-outlet data) ─────────────────
const SLA_TOTAL     = 14;
const SLA_BREACHED  = 4;
const SLA_AT_RISK   = 4;
const SLA_ON_TRACK  = 6;
const SLA_AVG_HRS   = 36.1;   // avg hours elapsed across all pending
const SLA_COMPLIANCE = 85.5;  // % of last-30-day processed KYCs within 48h SLA

// Per-state SLA breakdown (aggregated from outlet data)
const slaByState = [
  { state: 'Karnataka',   total: 4, onTrack: 1, atRisk: 1, breached: 2 },
  { state: 'Gujarat',     total: 2, onTrack: 0, atRisk: 1, breached: 1 },
  { state: 'Delhi NCR',   total: 2, onTrack: 1, atRisk: 0, breached: 1 },
  { state: 'Bihar',       total: 1, onTrack: 0, atRisk: 1, breached: 0 },
  { state: 'Tamil Nadu',  total: 2, onTrack: 1, atRisk: 1, breached: 0 },
  { state: 'Maharashtra', total: 3, onTrack: 3, atRisk: 0, breached: 0 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function rateColor(rate: number) {
  if (rate >= 90) return 'text-green-700 font-semibold';
  if (rate >= 80) return 'text-amber-600 font-semibold';
  return 'text-red-600 font-semibold';
}

function PieLegend() {
  return (
    <div className="flex flex-wrap justify-center gap-x-5 gap-y-2 mt-4">
      {pieData.map((e) => (
        <div key={e.name} className="flex items-center gap-1.5 text-sm text-gray-600">
          <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: e.color }} />
          {e.name} ({e.value})
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function AdminKycDashboardPage() {
  return (
    <div className="space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight" style={{ color: DARK_NAVY }}>
          KYC Dashboard
        </h1>
        <p className="text-sm text-gray-500 mt-1">Track outlet registration and verification status</p>
      </div>

      {/* Filters */}
      <FilterBar />

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <Card key={card.label} className="border border-gray-100 shadow-sm rounded-2xl">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-500">{card.label}</p>
                    <p className={`text-3xl font-bold mt-1 ${card.valColor}`}>{card.value}</p>
                  </div>
                  <div className={`p-3 rounded-xl ${card.iconBg}`}>
                    <Icon className={`w-6 h-6 ${card.iconColor}`} />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader><CardTitle>Status Breakdown</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={95} paddingAngle={3} dataKey="value">
                  {pieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                <Tooltip formatter={(value, name) => [value, name]} />
              </PieChart>
            </ResponsiveContainer>
            <PieLegend />
          </CardContent>
        </Card>

        <Card className="border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader><CardTitle>Monthly Submissions</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={barData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Submitted" fill="#6366f1" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Approved"  fill={PRIMARY_GREEN} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* KYC by State  +  Rejection Reasons */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

        {/* KYC by State — compact, 2 cols */}
        <Card className="lg:col-span-2 border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader><CardTitle>KYC by State</CardTitle></CardHeader>
          <CardContent className="pb-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 font-semibold text-gray-500 text-xs">State</th>
                  <th className="text-right py-2 font-semibold text-gray-500 text-xs">Outlets</th>
                  <th className="text-right py-2 font-semibold text-gray-500 text-xs">Pending</th>
                  <th className="text-right py-2 font-semibold text-gray-500 text-xs">Rate</th>
                </tr>
              </thead>
              <tbody>
                {stateData.map((row, i) => (
                  <tr key={row.state} className={`border-b border-gray-50 ${i % 2 === 0 ? '' : 'bg-gray-50/40'}`}>
                    <td className="py-2.5 font-medium text-gray-800 text-xs">{row.state}</td>
                    <td className="py-2.5 text-right text-gray-500 text-xs">{row.outlets}</td>
                    <td className="py-2.5 text-right text-xs">
                      <span className={`font-semibold ${row.pending > 2 ? 'text-amber-600' : 'text-gray-600'}`}>
                        {row.pending}
                      </span>
                    </td>
                    <td className={`py-2.5 text-right text-xs ${rateColor(row.rate)}`}>{row.rate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Rejection Reasons — 3 cols */}
        <Card className="lg:col-span-3 border border-gray-100 shadow-sm rounded-2xl">
          <CardHeader>
            <CardTitle>Rejection Reasons</CardTitle>
            <p className="text-xs text-gray-400 mt-0.5">Reasons for rejection &amp; resubmission requests · last 30 days</p>
          </CardHeader>
          <CardContent className="pb-5 space-y-4">
            {rejectionReasons.map((r) => {
              const pct = Math.round((r.count / totalRejections) * 100);
              return (
                <div key={r.reason}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-gray-700">{r.reason}</span>
                    <span className="text-xs font-bold text-gray-500 ml-3 shrink-0">
                      {r.count} <span className="font-normal text-gray-400">({pct}%)</span>
                    </span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, backgroundColor: r.color }}
                    />
                  </div>
                </div>
              );
            })}
            <p className="text-[11px] text-gray-400 pt-1">
              Based on {totalRejections} rejection / resubmission actions · May 2026
            </p>
          </CardContent>
        </Card>
      </div>

      {/* SLA Tracker — aggregate summary */}
      <Card className="border border-gray-100 shadow-sm rounded-2xl">
        <CardHeader>
          <CardTitle>SLA Tracker</CardTitle>
          <p className="text-xs text-gray-400 mt-0.5">
            KYC processing SLA · threshold 48 hrs from submission · {SLA_TOTAL} submissions currently pending
          </p>
        </CardHeader>
        <CardContent className="pb-6 space-y-6">

          {/* Top summary row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Compliance rate */}
            <div className="bg-green-50 border border-green-100 rounded-xl px-4 py-4 flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <TrendingUp className="w-4 h-4 text-green-600" />
                <span className="text-xs font-semibold text-green-700">30-day Compliance</span>
              </div>
              <p className="text-3xl font-bold text-green-700">{SLA_COMPLIANCE}%</p>
              <p className="text-[10px] text-green-600">of processed KYCs within 48 hrs</p>
            </div>

            {/* Avg processing time */}
            <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-4 flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-blue-600" />
                <span className="text-xs font-semibold text-blue-700">Avg Processing Time</span>
              </div>
              <p className="text-3xl font-bold text-blue-700">{SLA_AVG_HRS}h</p>
              <p className="text-[10px] text-blue-600">across pending submissions</p>
            </div>

            {/* At Risk */}
            <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-4 flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <span className="text-xs font-semibold text-amber-700">At Risk</span>
              </div>
              <p className="text-3xl font-bold text-amber-700">{SLA_AT_RISK}</p>
              <p className="text-[10px] text-amber-600">24–48 hrs elapsed · needs action</p>
            </div>

            {/* Breached */}
            <div className="bg-red-50 border border-red-100 rounded-xl px-4 py-4 flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 text-red-500" />
                <span className="text-xs font-semibold text-red-700">SLA Breached</span>
              </div>
              <p className="text-3xl font-bold text-red-700">{SLA_BREACHED}</p>
              <p className="text-[10px] text-red-600">over 48 hrs · escalate immediately</p>
            </div>
          </div>

          {/* Distribution bar */}
          <div>
            <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
              <span className="font-medium">Pending distribution ({SLA_TOTAL} total)</span>
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block" />On Track ({SLA_ON_TRACK})</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />At Risk ({SLA_AT_RISK})</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />Breached ({SLA_BREACHED})</span>
              </div>
            </div>
            <div className="h-3 w-full bg-gray-100 rounded-full overflow-hidden flex">
              <div className="h-full bg-green-500 transition-all" style={{ width: `${(SLA_ON_TRACK / SLA_TOTAL) * 100}%` }} />
              <div className="h-full bg-amber-400 transition-all" style={{ width: `${(SLA_AT_RISK / SLA_TOTAL) * 100}%` }} />
              <div className="h-full bg-red-500 transition-all" style={{ width: `${(SLA_BREACHED / SLA_TOTAL) * 100}%` }} />
            </div>
          </div>

          {/* SLA by State */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Breakdown by State</p>
            <div className="space-y-2.5">
              {slaByState.map((s) => (
                <div key={s.state} className="flex items-center gap-3">
                  <span className="text-xs font-medium text-gray-700 w-28 shrink-0">{s.state}</span>
                  {/* stacked bar */}
                  <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden flex">
                    <div className="h-full bg-green-500" style={{ width: `${(s.onTrack  / s.total) * 100}%` }} />
                    <div className="h-full bg-amber-400" style={{ width: `${(s.atRisk   / s.total) * 100}%` }} />
                    <div className="h-full bg-red-500"   style={{ width: `${(s.breached / s.total) * 100}%` }} />
                  </div>
                  {/* counts */}
                  <div className="flex items-center gap-2 shrink-0">
                    {s.onTrack  > 0 && <span className="text-[10px] font-bold text-green-600">{s.onTrack} ok</span>}
                    {s.atRisk   > 0 && <span className="text-[10px] font-bold text-amber-500">{s.atRisk} risk</span>}
                    {s.breached > 0 && <span className="text-[10px] font-bold text-red-500">{s.breached} breached</span>}
                  </div>
                  <span className="text-[10px] text-gray-400 w-10 text-right shrink-0">{s.total} total</span>
                </div>
              ))}
            </div>
          </div>

        </CardContent>
      </Card>

    </div>
  );
}
