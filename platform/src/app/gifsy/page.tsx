'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Building2, CheckCircle, Clock, AlertCircle, TrendingUp, Loader2,
} from 'lucide-react';
import { getToken } from '@/lib/auth-client';

// B3 (#49): the gifsy Overview now reads the REAL `clients` table via
// GET /api/gifsy/overview (was the static lib/platform/client-registry mock).
interface OverviewClient {
  slug: string;
  internalName: string;
  status: 'ACTIVE' | 'ONBOARDING' | 'INACTIVE';
  onboardedAt: string | null;
  displayName: string;
  primaryColor: string;
  enabledFeatureCount: number;
  moduleCount: number;
}

interface Overview {
  totalClients: number;
  active: number;
  onboarding: number;
  inactive: number;
  clients: OverviewClient[];
}

const EMPTY: Overview = { totalClients: 0, active: 0, onboarding: 0, inactive: 0, clients: [] };

export default function GifsyOverviewPage() {
  const [overview, setOverview] = useState<Overview>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Security-breach metric — GIFSY platform home ONLY. Fail-closed: any
  // non-success / 403 / network error leaves the count at 0 and renders nothing.
  const [securityCount, setSecurityCount] = useState(0);

  useEffect(() => {
    fetch('/api/gifsy/overview', { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
      .then((r) => r.json())
      .then((j) => {
        if (j?.success) setOverview(j.data ?? EMPTY);
        else setError('Could not load platform overview');
      })
      .catch(() => setError('Could not load platform overview'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch('/api/gifsy/security-events', { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
      .then((r) => r.json())
      .then((j) => {
        if (j?.success && typeof j.data?.count === 'number') setSecurityCount(j.data.count);
      })
      .catch(() => { /* fail-closed: no error surface, count stays 0 */ });
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Platform Overview</h1>
        <p className="text-sm text-white/50 mt-0.5">All clients onboarded on Gifsy Loyalty Platform</p>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Total Clients', value: overview.totalClients, icon: Building2,   color: 'text-white/70' },
          { label: 'Active',        value: overview.active,       icon: CheckCircle, color: 'text-green-400' },
          { label: 'Onboarding',    value: overview.onboarding,   icon: Clock,       color: 'text-amber-400' },
          { label: 'Inactive',      value: overview.inactive,     icon: AlertCircle, color: 'text-red-400' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-white/5 border border-white/10 rounded-xl p-4 flex items-center gap-3">
            <Icon className={`w-5 h-5 shrink-0 ${color}`} />
            <div>
              <p className="text-xl font-bold text-white">{loading ? '—' : value}</p>
              <p className="text-xs text-white/40">{label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Security-breach alert — reuses the file's red/AlertCircle affordance.
          Rendered ONLY when count > 0; otherwise nothing (no noise). */}
      {securityCount > 0 && (
        <Link href="/gifsy/security-events"
          className="flex items-center gap-3 bg-red-500/20 border border-red-500/30 rounded-xl p-4 hover:bg-red-500/25 transition-colors">
          <AlertCircle className="w-5 h-5 shrink-0 text-red-400" />
          <p className="text-sm font-semibold text-red-400">
            Security · {securityCount} refresh-token reuse events (last 30d)
          </p>
        </Link>
      )}

      {/* Client cards */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-white/70">All Clients</h2>
          <Link href="/gifsy/clients/new"
            className="px-3 py-1.5 bg-[var(--brand-primary)] text-white text-xs font-medium rounded-lg hover:opacity-90 transition-opacity">
            + Onboard Client
          </Link>
        </div>

        {loading && (
          <div className="py-12 text-center text-white/40 text-sm">
            <Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading clients…
          </div>
        )}
        {error && !loading && (
          <div className="py-12 text-center text-red-400 text-sm">{error}</div>
        )}
        {!loading && !error && overview.clients.length === 0 && (
          <div className="py-12 text-center text-white/30 text-sm">No clients onboarded yet.</div>
        )}

        <div className="space-y-2">
          {!loading && !error && overview.clients.map((s) => (
            <Link key={s.slug} href={`/gifsy/clients/${s.slug}`}
              className="flex items-center gap-4 bg-white/5 border border-white/10 rounded-xl px-4 py-3 hover:bg-white/8 hover:border-white/20 transition-all group">

              {/* Colour dot */}
              <div className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-xs font-bold text-white"
                style={{ backgroundColor: s.primaryColor }}>
                {s.displayName[0]}
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white truncate">{s.displayName}</p>
                <p className="text-xs text-white/40">{s.slug}.gifsy.in</p>
              </div>

              <div className="flex items-center gap-4 text-xs text-white/50 shrink-0">
                <span>{s.enabledFeatureCount}/{s.moduleCount} modules on</span>
                <span className={`px-2 py-0.5 rounded-full font-medium ${
                  s.status === 'ACTIVE'      ? 'bg-green-500/20 text-green-400' :
                  s.status === 'ONBOARDING'  ? 'bg-amber-500/20 text-amber-400' :
                                               'bg-red-500/20 text-red-400'
                }`}>
                  {s.status}
                </span>
                <TrendingUp className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
