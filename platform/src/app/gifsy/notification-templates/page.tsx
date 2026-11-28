'use client';

/**
 * /gifsy/notification-templates — MOVED (owner-approved 2026-11-28).
 *
 * Notification templates are configured per client in Gifsy → Clients → <client> → Notifications
 * (/gifsy/clients/<slug>#notifications), which edits that client directly with no assume step.
 * This page keeps old bookmarks working: a short "moved" note + one link per client straight to
 * its Notifications section. Owner-only (GIFSY_ADMIN), like the editor itself.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell, Loader2, Lock } from 'lucide-react';
import { api } from '@/lib/api-client';
import { getStoredUser } from '@/lib/auth-client';

interface ClientRow {
  slug: string;
  internalName: string;
  displayName?: string;
}

export default function NotificationTemplatesMovedPage() {
  const [role, setRole] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setRole(getStoredUser()?.role ?? null);
    setReady(true);
  }, []);

  const [clients, setClients] = useState<ClientRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || role !== 'GIFSY_ADMIN') return;
    let cancelled = false;
    void api.get<{ clients: ClientRow[] }>('/api/gifsy/clients').then((res) => {
      if (cancelled) return;
      if (res.success) setClients(res.data?.clients ?? []);
      else setError(res.error);
    });
    return () => { cancelled = true; };
  }, [ready, role]);

  if (!ready) return null;
  if (role !== 'GIFSY_ADMIN') {
    return (
      <div className="max-w-lg mx-auto mt-10 border border-white/10 rounded-xl px-6 py-8 text-center" data-testid="nt-moved-owner-only">
        <Lock className="w-6 h-6 mx-auto text-white/40" />
        <h1 className="text-lg font-bold text-white mt-3">Owner-only</h1>
        <p className="text-sm text-white/50 mt-1">
          Only the platform owner (GIFSY_ADMIN) can view or edit notification templates.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-5" data-testid="nt-moved">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Bell className="w-5 h-5 text-white/60" />Notification templates moved
        </h1>
        <p className="text-sm text-white/50 mt-1">
          Notification templates are now set per client in <strong className="text-white/80">Clients → &lt;client&gt; → Notifications</strong>.
          Pick a client:
        </p>
      </div>

      {clients === null && !error && (
        <p className="text-sm text-white/40"><Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />Loading clients…</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-400" data-testid="nt-moved-error">
          Could not load clients: {error}. <Link href="/gifsy/clients" className="underline">Open Clients</Link>
        </p>
      )}
      {clients && clients.length === 0 && (
        <p className="text-sm text-white/40">No clients yet.</p>
      )}
      {clients && clients.length > 0 && (
        <ul className="border border-white/10 rounded-xl divide-y divide-white/5 overflow-hidden">
          {clients.map((c) => (
            <li key={c.slug}>
              <Link
                href={`/gifsy/clients/${encodeURIComponent(c.slug)}#notifications`}
                data-testid={`nt-moved-link-${c.slug}`}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors"
              >
                <span className="min-w-0 break-words">{c.displayName || c.internalName}</span>
                <span className="font-mono text-xs text-white/40">{c.slug}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
