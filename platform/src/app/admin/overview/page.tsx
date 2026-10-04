'use client';

/**
 * Employee Rewards — Overview (Phase A cockpit landing).
 *
 * The employee cockpit's home. KPI cards + a per-level breakdown come from the real,
 * tenant-scoped /api/admin/people/overview endpoint — never fabricated (cards show '—'
 * until the fetch resolves, mirroring the trade dashboard's no-mock discipline). A few
 * muted "Coming soon" tiles reserve space for the Phase B/C modules (Points / Rewards /
 * Contests / Fulfilment) so the layout has room to grow without faking numbers.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Users, UserCheck, UserX, Layers, Wallet,
  Coins, Gift, Trophy, Truck, Settings2, ArrowRight,
} from 'lucide-react';
import Link from 'next/link';
import { authHeader } from '@/lib/api-client';

/* ─── API types ──────────────────────────────────────────────────────────────── */

interface PerLevelRow {
  levelId: string;
  code: string;
  name: string;
  level: number;
  employeeCount: number;
}

interface PeopleOverview {
  totalEmployees: number;
  activeEmployees: number;
  placeholders: number;
  levelCount: number;
  rewardAccounts: number;
  perLevel: PerLevelRow[];
}

/* ─── KPI card chrome (values come from the live endpoint; '—' until then) ─────── */

interface KpiMeta {
  key: keyof Omit<PeopleOverview, 'perLevel'>;
  label: string;
  icon: React.ElementType;
  color: string;
  border: string;
}

const KPI_META: KpiMeta[] = [
  { key: 'totalEmployees',  label: 'Total Employees',  icon: Users,     color: 'bg-blue-50 text-blue-600',       border: 'border-blue-100'    },
  { key: 'activeEmployees', label: 'Active',           icon: UserCheck, color: 'bg-emerald-50 text-emerald-600', border: 'border-emerald-100' },
  { key: 'placeholders',    label: 'Vacant Positions', icon: UserX,     color: 'bg-amber-50 text-amber-600',     border: 'border-amber-100'   },
  { key: 'levelCount',      label: 'Hierarchy Levels', icon: Layers,    color: 'bg-purple-50 text-purple-600',   border: 'border-purple-100'  },
  { key: 'rewardAccounts',  label: 'Reward Accounts',  icon: Wallet,    color: 'bg-red-50 text-red-600',         border: 'border-red-100'     },
];

/* ─── Phase B/C placeholders — reserve layout, never fabricate counts. ─────────── */

const COMING_SOON = [
  { label: 'Points',     icon: Coins,  phase: 'Phase C' },
  { label: 'Rewards',    icon: Gift,   phase: 'Phase B' },
  { label: 'Contests',   icon: Trophy, phase: 'Phase C' },
  { label: 'Fulfilment', icon: Truck,  phase: 'Phase B' },
];

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function OverviewPage() {
  // Live, tenant-scoped people overview — the only source for the cards. No mock fallback.
  const [overview, setOverview] = useState<PeopleOverview | null>(null);

  useEffect(() => {
    fetch('/api/admin/people/overview', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json) => { if (json.success && json.data) setOverview(json.data as PeopleOverview); })
      .catch(() => {});
  }, []);

  // Build the cards from real data; '—' until the endpoint responds.
  const cards = useMemo(() => {
    const fmt = (n: number) => n.toLocaleString('en-IN');
    return KPI_META.map((meta) => ({
      ...meta,
      value: overview ? fmt(overview[meta.key]) : '—',
    }));
  }, [overview]);

  const perLevel = overview?.perLevel ?? [];

  return (
    <div className="space-y-5 fade-in">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Overview</h1>
          <p className="text-xs text-gray-500">Employee rewards cockpit · people &amp; hierarchy at a glance</p>
        </div>
        <Link
          href="/admin/hierarchy-levels"
          data-testid="configure-hierarchy-levels"
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 bg-white text-gray-700 text-xs font-semibold hover:bg-gray-50 transition-colors"
        >
          <Settings2 className="h-3.5 w-3.5" />
          Configure hierarchy levels
        </Link>
      </div>

      {/* KPI Cards (real — /admin/people/overview) */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Key Metrics</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-4">
          {cards.map((card) => {
            const Icon = card.icon;
            return (
              <div
                key={card.key}
                className={`bg-white rounded-xl border ${card.border} p-4 flex flex-col gap-3 hover:shadow-md transition-shadow`}
              >
                <div className={`p-2 rounded-lg w-fit ${card.color}`}>
                  <Icon className="w-4 h-4" />
                </div>
                <div>
                  <p data-testid={`kpi-${card.key}`} className="text-2xl font-bold text-gray-900">{card.value}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{card.label}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Per-level breakdown (real — custom level names) */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Layers className="w-4 h-4 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-800">Employees by Level</h3>
          </div>
          <Link href="/admin/people" className="text-xs text-[var(--brand-primary)] hover:opacity-80 font-medium flex items-center gap-1">
            Manage people <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100">
              <th className="text-left px-5 py-2 text-xs font-semibold text-gray-500">Level</th>
              <th className="text-left px-5 py-2 text-xs font-semibold text-gray-500">Role</th>
              <th className="text-right px-5 py-2 text-xs font-semibold text-gray-500">Employees</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {perLevel.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-5 py-8 text-center text-sm text-gray-400">
                  {overview ? 'No hierarchy levels configured yet.' : '—'}
                </td>
              </tr>
            ) : (
              [...perLevel]
                .sort((a, b) => b.level - a.level)
                .map((row) => (
                  <tr key={row.levelId} data-testid="per-level-row" className="hover:bg-gray-50">
                    <td className="px-5 py-2.5 text-gray-500 text-xs">L{row.level}</td>
                    <td className="px-5 py-2.5">
                      <span className="font-semibold text-gray-900">{row.name}</span>
                      {row.name !== row.code && (
                        <span className="ml-2 text-[10px] font-mono text-gray-400">{row.code}</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-right font-semibold text-gray-900">
                      {row.employeeCount.toLocaleString('en-IN')}
                    </td>
                  </tr>
                ))
            )}
          </tbody>
        </table>
      </div>

      {/* Phase B/C placeholders — room to grow, no fabricated numbers */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Coming soon</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {COMING_SOON.map((tile) => {
            const Icon = tile.icon;
            return (
              <div
                key={tile.label}
                className="rounded-xl border border-dashed border-gray-200 bg-gray-50/60 p-4 flex flex-col gap-3"
              >
                <div className="p-2 rounded-lg w-fit bg-gray-100 text-gray-400">
                  <Icon className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-500">{tile.label}</p>
                  <p className="text-[10px] text-gray-400 mt-0.5 uppercase tracking-wide">{tile.phase}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
