'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import {
  CheckCircle, Clock, AlertCircle, Search, ChevronRight, Plus,
} from 'lucide-react';
import { CLIENT_REGISTRY } from '@/lib/platform/client-registry';
import { buildClientSummary } from '@/lib/platform/platform-admin';
import type { ClientSummary } from '@/lib/platform/platform-admin';

const ALL_SUMMARIES = Object.values(CLIENT_REGISTRY).map(buildClientSummary);

type StatusFilter = 'ALL' | 'ACTIVE' | 'ONBOARDING' | 'INACTIVE';

export default function GifsyClientsPage() {
  const [search, setSearch]           = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');

  const filtered = useMemo((): ClientSummary[] => {
    const q = search.toLowerCase();
    return ALL_SUMMARIES.filter((s) => {
      const matchSearch =
        !q ||
        s.displayName.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        s.internalName.toLowerCase().includes(q);
      const matchStatus = statusFilter === 'ALL' || s.status === statusFilter;
      return matchSearch && matchStatus;
    });
  }, [search, statusFilter]);

  const counts = useMemo(() => ({
    ACTIVE:     ALL_SUMMARIES.filter((s) => s.status === 'ACTIVE').length,
    ONBOARDING: ALL_SUMMARIES.filter((s) => s.status === 'ONBOARDING').length,
    INACTIVE:   ALL_SUMMARIES.filter((s) => s.status === 'INACTIVE').length,
  }), []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Clients</h1>
          <p className="text-sm text-white/50 mt-0.5">
            {ALL_SUMMARIES.length} clients · {counts.ACTIVE} active · {counts.ONBOARDING} onboarding
          </p>
        </div>
        <Link
          href="/gifsy/clients/new"
          className="flex items-center gap-1.5 px-3 py-2 bg-[var(--brand-primary)] text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
        >
          <Plus className="w-4 h-4" />
          Onboard Client
        </Link>
      </div>

      {/* Filters row */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-48 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
          <input
            type="text"
            placeholder="Search by name or slug…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-4 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30"
          />
        </div>

        {/* Status tabs */}
        <div className="flex items-center gap-0.5 bg-white/5 border border-white/10 rounded-lg p-1">
          {(['ALL', 'ACTIVE', 'ONBOARDING', 'INACTIVE'] as StatusFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                statusFilter === s
                  ? 'bg-white/15 text-white'
                  : 'text-white/40 hover:text-white/70'
              }`}
            >
              {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="border border-white/10 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/5">
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">Client</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">Slug</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-white/40">Status</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-white/40">Classes</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-white/40">Features</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">Onboarded</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {filtered.map((s) => (
              <tr key={s.slug} className="hover:bg-white/5 transition-colors group">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white shrink-0"
                      style={{ backgroundColor: s.primaryColor }}
                    >
                      {s.displayName[0]}
                    </div>
                    <div>
                      <p className="font-semibold text-white">{s.displayName}</p>
                      <p className="text-xs text-white/40">{s.internalName}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="font-mono text-xs text-white/60 bg-white/5 px-2 py-0.5 rounded">
                    {s.slug}
                  </span>
                </td>
                <td className="px-4 py-3 text-center">
                  <StatusBadge status={s.status} />
                </td>
                <td className="px-4 py-3 text-center text-white/60 text-xs">{s.partnerClassCount}</td>
                <td className="px-4 py-3 text-center">
                  <span className="text-xs text-white/60">{s.enabledFeatureCount}</span>
                  <span className="text-xs text-white/25">/9</span>
                </td>
                <td className="px-4 py-3 text-white/40 text-xs">{s.onboardedAt}</td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/gifsy/clients/${s.slug}`}
                    className="inline-flex items-center gap-1 text-xs text-white/30 group-hover:text-white/70 transition-colors"
                  >
                    Manage
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Link>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-white/30 text-sm">
                  No clients match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: 'ACTIVE' | 'ONBOARDING' | 'INACTIVE' }) {
  if (status === 'ACTIVE') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 text-xs font-medium">
        <CheckCircle className="w-3 h-3" />Active
      </span>
    );
  }
  if (status === 'ONBOARDING') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-xs font-medium">
        <Clock className="w-3 h-3" />Onboarding
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 text-xs font-medium">
      <AlertCircle className="w-3 h-3" />Inactive
    </span>
  );
}
