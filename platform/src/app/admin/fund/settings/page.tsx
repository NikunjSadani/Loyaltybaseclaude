'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getStoredUser } from '@/lib/auth-client';
import { FundConsoleSection } from '@/components/operator/fund-console-section';

/**
 * /admin/fund/settings — the client's Fund settings (agency fee, voucher item discounts, low-balance alerts) for a Gifsy
 * operator WORKING IN the client (assumed): the owner, or a GIFSY_STAFF holding payouts:read (+ payouts:manage_fund to
 * edit) and a grant for this client (re-audit B1 — a staff member never sees the /gifsy console client page, so the
 * "Managed by Gifsy" link must land here). Same section + API as the console client page
 * (/api/gifsy/clients/:slug/fund — the backend enforces the role, the permission and the tenant grant). A client admin
 * is pointed back to the read-only view. The client slug comes from GET /api/fund/settings (the session's tenant).
 */
export default function FundSettingsPage() {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; slug: string } | { kind: 'client' }>({
    kind: 'loading',
  });

  useEffect(() => {
    const role = getStoredUser()?.role;
    if (role !== 'GIFSY_ADMIN' && role !== 'GIFSY_STAFF') {
      setState({ kind: 'client' });
      return;
    }
    let live = true;
    void (async () => {
      try {
        const res = await fetch('/api/fund/settings');
        const body = (await res.json().catch(() => null)) as { data?: { clientId?: string }; error?: string; message?: string } | null;
        if (!live) return;
        const slug = body?.data?.clientId;
        if (!res.ok || !slug) {
          setState({ kind: 'error', message: body?.error ?? body?.message ?? 'Could not load the fund settings.' });
          return;
        }
        setState({ kind: 'ready', slug });
      } catch {
        if (live) setState({ kind: 'error', message: "Couldn't reach the server. Check your connection and try again." });
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Fund settings</h1>
          <p className="text-sm text-gray-500 mt-1">Agency fee, voucher item discounts and low-balance alerts for this client.</p>
        </div>
        <Link href="/admin/fund" className="text-sm font-medium text-[var(--brand-primary)] underline">
          Back to Fund Reconciliation
        </Link>
      </div>
      {state.kind === 'loading' && <p className="text-sm text-gray-500">Loading…</p>}
      {state.kind === 'error' && (
        <p role="alert" className="text-sm text-red-700">
          {state.message}
        </p>
      )}
      {state.kind === 'client' && (
        <p className="text-sm text-gray-700">
          These settings are managed by Gifsy. You can see the current rates on the{' '}
          <Link href="/admin/fund" className="underline">
            Fund Reconciliation
          </Link>{' '}
          page (Rates &amp; alerts).
        </p>
      )}
      {state.kind === 'ready' && (
        // The section is the console's (dark) component — shown on its own dark panel here.
        <div className="rounded-xl bg-gray-950 text-white px-5 py-4">
          <FundConsoleSection slug={state.slug} />
        </div>
      )}
    </div>
  );
}
