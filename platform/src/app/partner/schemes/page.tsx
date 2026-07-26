'use client';

/**
 * Partner-portal scheme LIST (D27) — replaces the old single dashboard banner (which
 * only ever surfaced the FIRST pending scheme and could not render a required form).
 *
 * Two views:
 *   - "Available"  — eligible ACTIVE schemes this outlet has NOT yet enrolled in.
 *   - "My schemes" — schemes this outlet has an enrollment for (SUBMITTED or REJECTED),
 *                    with the current status; a REJECTED one is flagged action-needed.
 *
 * Eligibility is audience-governed + group-aware server-side (the active-partner cookie);
 * tapping a card opens the detail/enroll page. The MT/`SSS_TOT` hardcoded exclusion is
 * gone (D22) — MT outlets see the schemes they're targeted for like everyone else.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles, ChevronRight, ClipboardList, AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { usePartnerIdentity } from '@/lib/partner-identity';
import {
  loadPortalSchemes,
  statusOf,
  type PortalScheme,
  type PortalStatus,
} from '@/app/partner/schemes/portal-api';

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function period(start: string, end: string): string {
  const s = fmt(start);
  const e = fmt(end);
  return s && e ? `${s} – ${e}` : s || e;
}

function StatusBadge({ status }: { status: PortalStatus }) {
  if (status === 'REJECTED') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-600">
        <AlertCircle className="h-3 w-3" /> Action needed
      </span>
    );
  }
  if (status === 'SUBMITTED') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
        <CheckCircle2 className="h-3 w-3" /> Enrolled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
      <Clock className="h-3 w-3" /> Open
    </span>
  );
}

function SchemeCard({ item }: { item: PortalScheme }) {
  const s = item.scheme;
  const status = statusOf(item);
  return (
    <Link
      href={`/partner/schemes/${s.id}`}
      className="flex items-center gap-3 bg-white rounded-2xl border border-gray-200 px-4 py-3.5 hover:border-gray-300 hover:shadow-sm active:scale-[0.99] transition-all"
    >
      <div className="w-10 h-10 rounded-xl bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
        <Sparkles className="h-5 w-5 text-[var(--brand-primary)]" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <p className="text-sm font-bold text-gray-900 leading-tight truncate">{s.name}</p>
          <StatusBadge status={status} />
        </div>
        {s.description && (
          <p className="text-[11px] text-gray-500 leading-snug line-clamp-1">{s.description}</p>
        )}
        <p className="text-[10px] text-gray-400 mt-0.5">{period(s.startDate, s.endDate)}</p>
      </div>
      <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
    </Link>
  );
}

type Tab = 'available' | 'enrolled';

export default function PartnerSchemesPage() {
  const identity = usePartnerIdentity();
  const activePartnerId = identity.activePartnerId;
  const [items, setItems] = useState<PortalScheme[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('available');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadPortalSchemes()
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load schemes');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch when the active outlet changes (login-picker sibling switch).
  }, [activePartnerId]);

  const available = items.filter((i) => statusOf(i) === 'NOT_ENROLLED');
  const enrolled = items.filter((i) => statusOf(i) !== 'NOT_ENROLLED');
  const shown = tab === 'available' ? available : enrolled;

  return (
    <div className="space-y-4 fade-in">
      <div>
        <h1 className="text-lg font-bold text-gray-900">Activations</h1>
        <p className="text-xs text-gray-400 mt-0.5">Enrol your outlet in the schemes you&apos;re eligible for.</p>
      </div>

      {/* Tabs */}
      <div className="flex bg-gray-100 rounded-xl p-0.5 gap-0.5">
        {([
          ['available', `Available${available.length ? ` (${available.length})` : ''}`],
          ['enrolled', `My schemes${enrolled.length ? ` (${enrolled.length})` : ''}`],
        ] as [Tab, string][]).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
              tab === key ? 'bg-white text-[var(--brand-primary)] shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48">
          <Spinner size="lg" />
        </div>
      ) : error ? (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
          <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
          <p className="text-xs text-red-700">{error}</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-3">
          <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center">
            <ClipboardList className="h-6 w-6 text-gray-400" />
          </div>
          <p className="text-sm font-semibold text-gray-700">
            {tab === 'available' ? 'No activations to enrol in right now' : 'You have no enrolled activations yet'}
          </p>
          <p className="text-xs text-gray-400 max-w-xs">
            {tab === 'available'
              ? 'New activations you’re eligible for will appear here.'
              : 'Enrol from the Available tab to see your submissions here.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {shown.map((item) => (
            <SchemeCard key={item.scheme.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
