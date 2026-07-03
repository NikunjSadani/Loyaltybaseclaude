'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle, Clock, AlertCircle, Search, ChevronRight, Plus, Loader2, Power,
} from 'lucide-react';
import { getToken } from '@/lib/auth-client';

// B3 (#49): the gifsy console now reads the REAL `clients` table via
// GET /api/gifsy/clients (was the static lib/platform/client-registry mock).
interface ClientRow {
  slug: string;
  internalName: string;
  status: 'ACTIVE' | 'ONBOARDING' | 'INACTIVE';
  onboardedAt: string | null;
  displayName?: string;
  primaryColor?: string;
  features?: Record<string, boolean | undefined>;
}

type StatusFilter = 'ALL' | 'ACTIVE' | 'ONBOARDING' | 'INACTIVE';

const display = (c: ClientRow) => c.displayName || c.internalName;
const featureCount = (c: ClientRow) => Object.values(c.features ?? {}).filter(Boolean).length;

export default function GifsyClientsPage() {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [activating, setActivating] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  // Quick "Activate" from the list — flips an ONBOARDING tenant to ACTIVE without
  // opening detail. Same real PATCH /api/gifsy/clients/:slug the detail page uses.
  async function activate(slug: string) {
    setActivating(slug);
    setRowError(null);
    try {
      const res = await fetch(`/api/gifsy/clients/${slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}` },
        body: JSON.stringify({ status: 'ACTIVE' }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) throw new Error(j?.error || 'Activation failed');
      const newStatus = (j.data?.status ?? 'ACTIVE') as ClientRow['status'];
      setClients((prev) => prev.map((c) => (c.slug === slug ? { ...c, status: newStatus } : c)));
    } catch (e) {
      setRowError(e instanceof Error ? e.message : 'Activation failed');
    } finally {
      setActivating(null);
    }
  }

  useEffect(() => {
    fetch('/api/gifsy/clients', { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
      .then((r) => r.json())
      .then((j) => {
        if (j?.success) setClients(j.data?.clients ?? []);
        else setError('Could not load clients');
      })
      .catch(() => setError('Could not load clients'))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo((): ClientRow[] => {
    const q = search.toLowerCase();
    return clients.filter((s) => {
      const matchSearch =
        !q ||
        display(s).toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        s.internalName.toLowerCase().includes(q);
      const matchStatus = statusFilter === 'ALL' || s.status === statusFilter;
      return matchSearch && matchStatus;
    });
  }, [clients, search, statusFilter]);

  const counts = useMemo(() => ({
    ACTIVE:     clients.filter((s) => s.status === 'ACTIVE').length,
    ONBOARDING: clients.filter((s) => s.status === 'ONBOARDING').length,
    INACTIVE:   clients.filter((s) => s.status === 'INACTIVE').length,
  }), [clients]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Clients</h1>
          <p className="text-sm text-white/50 mt-0.5">
            {clients.length} clients · {counts.ACTIVE} active · {counts.ONBOARDING} onboarding
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
        <div className="flex items-center gap-0.5 bg-white/5 border border-white/10 rounded-lg p-1">
          {(['ALL', 'ACTIVE', 'ONBOARDING', 'INACTIVE'] as StatusFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                statusFilter === s ? 'bg-white/15 text-white' : 'text-white/40 hover:text-white/70'
              }`}
            >
              {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      {rowError && (
        <div data-testid="row-error" className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {rowError}
        </div>
      )}

      {/* Table */}
      <div className="border border-white/10 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/5">
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">Client</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">Slug</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-white/40">Status</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-white/40">Modules</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-white/40">Onboarded</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {!loading && !error && filtered.map((s) => (
              <tr key={s.slug} className="hover:bg-white/5 transition-colors group">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white shrink-0"
                      style={{ backgroundColor: s.primaryColor || '#6b7280' }}
                    >
                      {display(s)[0]}
                    </div>
                    <div>
                      <p className="font-semibold text-white">{display(s)}</p>
                      <p className="text-xs text-white/40">{s.internalName}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="font-mono text-xs text-white/60 bg-white/5 px-2 py-0.5 rounded">{s.slug}</span>
                </td>
                <td className="px-4 py-3 text-center"><StatusBadge status={s.status} /></td>
                <td className="px-4 py-3 text-center">
                  <span className="text-xs text-white/60">{featureCount(s)}</span>
                  <span className="text-xs text-white/25">/5</span>
                </td>
                <td className="px-4 py-3 text-white/40 text-xs">
                  {s.onboardedAt ? new Date(s.onboardedAt).toISOString().slice(0, 10) : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-3 justify-end">
                    {s.status === 'ONBOARDING' && (
                      <button
                        data-testid={`activate-${s.slug}`}
                        onClick={() => activate(s.slug)}
                        disabled={activating === s.slug}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-green-500/15 border border-green-500/30 text-green-400 text-xs font-medium hover:bg-green-500/25 transition-colors disabled:opacity-50"
                      >
                        {activating === s.slug
                          ? <Loader2 className="w-3 h-3 animate-spin" />
                          : <Power className="w-3 h-3" />}
                        Activate
                      </button>
                    )}
                    <Link
                      href={`/gifsy/clients/${s.slug}`}
                      className="inline-flex items-center gap-1 text-xs text-white/30 group-hover:text-white/70 transition-colors"
                    >
                      Manage<ChevronRight className="w-3.5 h-3.5" />
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
            {loading && (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-white/40 text-sm">
                <Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading clients…
              </td></tr>
            )}
            {error && (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-red-400 text-sm">{error}</td></tr>
            )}
            {!loading && !error && filtered.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-white/30 text-sm">
                No clients match your search.
              </td></tr>
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
