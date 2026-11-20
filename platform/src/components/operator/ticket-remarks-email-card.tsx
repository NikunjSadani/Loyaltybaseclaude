'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';

/**
 * Gifsy console → Clients → <client> → "Support tickets" card (owner-approved 2026-11-20, tenant-scoped).
 * The client's shared "Ticket remarks email": when set, "Ask client admin for remarks" emails go ONLY
 * to this address (the admin asked is named in the email); empty → the chosen admin is emailed
 * directly. GIFSY_ADMIN only (API-enforced; the page renders this card only for the owner).
 * GET/PUT /api/gifsy/clients/:slug/ticket-remarks-email.
 */

interface View {
  email: string | null;
  lastChange: { byName: string; at: string } | null;
}

/** One address only — mirrors the API rule so the error shows before the round-trip. */
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

export function TicketRemarksEmailCard({ slug }: { slug: string }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [server, setServer] = useState<View | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The "Saved." flash timer — cleared on unmount (and before re-arming) so it never fires late.
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    const res = await api.get<View>(`/api/gifsy/clients/${encodeURIComponent(slug)}/ticket-remarks-email`);
    if (res.success) { setServer(res.data); setDraft(res.data.email ?? ''); }
    else setLoadError(res.error);
    setLoading(false);
  }, [slug]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaveError(null); setSaved(false);
    const value = draft.trim();
    if (value && (/[,;\s]/.test(value) || !EMAIL_RE.test(value))) {
      setSaveError('Enter ONE valid email address (or leave it empty).');
      return;
    }
    setSaving(true);
    const res = await api.put<View>(`/api/gifsy/clients/${encodeURIComponent(slug)}/ticket-remarks-email`, { email: value || null });
    setSaving(false);
    if (res.success) {
      setServer(res.data); setDraft(res.data.email ?? ''); setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2500);
    } else {
      setSaveError(res.error);
    }
  };

  const dirty = (server?.email ?? '') !== draft.trim().toLowerCase();

  if (loading) {
    return <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>;
  }
  if (loadError) {
    return (
      <div role="alert" className="text-sm text-red-600 flex items-center gap-3">
        Could not load the ticket remarks email: {loadError}
        <Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>
      </div>
    );
  }
  return (
    <div className="space-y-2 max-w-xl" data-testid="ticket-remarks-email-card">
      <label htmlFor="ticket-remarks-email" className="text-sm font-medium text-gray-800">Ticket remarks email</label>
      <p id="ticket-remarks-email-help" className="text-xs text-gray-500">
        When set, &apos;Ask client admin for remarks&apos; emails go only to this address (the admin asked is named in the
        email). Leave empty to email the chosen admin directly.
      </p>
      <div className="flex gap-2">
        <input
          id="ticket-remarks-email"
          type="email"
          aria-describedby="ticket-remarks-email-help"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setSaveError(null); }}
          placeholder="e.g. support@client.com"
          className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20"
        />
        <Button size="sm" loading={saving} disabled={!dirty || saving} onClick={save}>Save</Button>
      </div>
      {saveError && <p role="alert" className="text-xs text-red-600">{saveError}</p>}
      {saved && <p role="status" className="text-xs text-emerald-700">Saved.</p>}
      <p className="text-xs text-gray-400" data-testid="ticket-remarks-email-last-change">
        {server?.lastChange
          ? `Last changed by ${server.lastChange.byName} on ${new Date(server.lastChange.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`
          : 'Never changed — remarks emails go to the chosen admin.'}
      </p>
    </div>
  );
}
