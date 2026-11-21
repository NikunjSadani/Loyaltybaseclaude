'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { MAX_CC, MAX_TO, checkRemarksEmail } from '@/lib/ticket-remarks-email-rule';

/**
 * Gifsy console → Clients → <client> → "Support tickets" card (owner-approved 2026-11-20, tenant-scoped;
 * To + CC lists 2026-11-21). The client's "Ticket remarks email" recipients for "Ask client admin for
 * remarks":
 *   - To set   → the email goes to every To address (the admin asked is named in the email), Cc the CC list.
 *   - To blank → the email goes to the admin chosen on each ticket (as before), Cc the CC list if any.
 * GIFSY_ADMIN only (API-enforced; the page renders this card only for the owner).
 * GET/PUT /api/gifsy/clients/:slug/ticket-remarks-email  ({ to: string[], cc: string[] }).
 */

interface View {
  to?: string[];
  cc?: string[];
  /** Legacy single-address field (= first To). */
  email?: string | null;
  lastChange: { byName: string; at: string } | null;
}

const toList = (v: View | null): string[] => v?.to ?? (v?.email ? [v.email] : []);
const ccList = (v: View | null): string[] => v?.cc ?? [];
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

type ListName = 'To' | 'CC';

/**
 * Adds the typed text (one or more addresses split on , ; whitespace) to `list`.
 *   - invalid / already-in-the-other-list entry → stops there; that entry and the rest stay in the
 *     (editable) draft with an error, so nothing is lost.
 *   - over the cap → truncated at the cap; the extra addresses are NOT kept in the draft but named in
 *     the message ("Only 5 To addresses allowed — 1 not added: x@y"), so Save is never blocked by them.
 * Duplicates collapse silently (already a chip).
 */
function addEntries(
  raw: string, list: string[], other: string[], name: ListName, max: number,
): { list: string[]; error: string | null; rest: string } {
  const parts = raw.split(/[,;\s]+/).map((p) => p.trim()).filter(Boolean);
  const next = [...list];
  const overflow: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rest = parts.slice(i).join(', ');
    const r = checkRemarksEmail(parts[i]);
    if ('error' in r) return { list: next, error: r.error, rest };
    const email = r.email;
    if (next.includes(email) || overflow.includes(email)) continue;
    if (other.includes(email)) {
      return { list: next, error: `${email} is already in ${name === 'To' ? 'CC' : 'To'} — an address can be in only one list.`, rest };
    }
    if (next.length >= max) { overflow.push(email); continue; }
    next.push(email);
  }
  const error = overflow.length
    ? `Only ${max} ${name} addresses allowed — ${overflow.length} not added: ${overflow.join(', ')}`
    : null;
  return { list: next, error, rest: '' };
}

function ChipInput({
  id, label, name, max, list, other, draft, error, disabled, onChange, onDraft, onError,
}: {
  id: string; label: string; name: ListName; max: number; list: string[]; other: string[];
  draft: string; error: string | null; disabled: boolean;
  onChange: (l: string[]) => void; onDraft: (d: string) => void; onError: (e: string | null) => void;
}) {
  const commit = (text: string) => {
    if (!text.trim()) return;
    const r = addEntries(text, list, other, name, max);
    onChange(r.list); onDraft(r.rest); onError(r.error);
  };
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium text-gray-700">
        {label} <span className="font-normal text-gray-400">({list.length}/{max})</span>
      </label>
      <div
        className={`flex flex-wrap items-center gap-1.5 rounded-lg border px-2 py-1.5 min-h-[40px] focus-within:ring-2 focus-within:ring-[var(--brand-primary)]/20 ${error ? 'border-red-300' : 'border-gray-200'}`}
        data-testid={`${id}-chips`}
      >
        {list.map((e) => (
          <span key={e} className="inline-flex max-w-full items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-800">
            <span className="truncate">{e}</span>
            <button
              type="button"
              aria-label={`Remove ${e} from ${name}`}
              disabled={disabled}
              onClick={() => { onChange(list.filter((x) => x !== e)); onError(null); }}
              className="rounded-full p-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-800 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          id={id}
          // text (not email): an email input sanitises whitespace, which would swallow the separator.
          type="text"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby={`ticket-remarks-email-help${error ? ` ${id}-error` : ''}`}
          aria-invalid={!!error}
          // Never disabled while a draft exists — it must stay editable/clearable.
          disabled={disabled || (list.length >= max && !draft)}
          value={draft}
          placeholder={list.length >= max ? `Limit of ${max} reached` : 'name@client.com, then Enter'}
          onChange={(e) => {
            const v = e.target.value;
            // Typing a separator commits what came before it (paste of a list is split too).
            if (/[,;\s]/.test(v)) commit(v); else { onDraft(v); onError(null); }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(draft); }
            else if (e.key === 'Backspace' && !draft && list.length) { onChange(list.slice(0, -1)); }
          }}
          onBlur={() => commit(draft)}
          className="min-w-[10rem] flex-1 bg-transparent py-1 text-sm focus:outline-none disabled:cursor-not-allowed"
        />
      </div>
      {error && <p id={`${id}-error`} role="alert" className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

export function TicketRemarksEmailCard({ slug }: { slug: string }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [server, setServer] = useState<View | null>(null);
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [toDraft, setToDraft] = useState('');
  const [ccDraft, setCcDraft] = useState('');
  const [toError, setToError] = useState<string | null>(null);
  const [ccError, setCcError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The "Saved." flash timer — cleared on unmount (and before re-arming) so it never fires late.
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  const apply = (v: View) => {
    setServer(v); setTo(toList(v)); setCc(ccList(v));
    setToDraft(''); setCcDraft(''); setToError(null); setCcError(null);
  };

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    const res = await api.get<View>(`/api/gifsy/clients/${encodeURIComponent(slug)}/ticket-remarks-email`);
    if (res.success) apply(res.data);
    else setLoadError(res.error);
    setLoading(false);
  }, [slug]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaveError(null); setSaved(false);
    // Fold any half-typed address in before saving — never drop it silently.
    const t = toDraft.trim() ? addEntries(toDraft, to, cc, 'To', MAX_TO) : { list: to, error: null, rest: '' };
    const c = ccDraft.trim() ? addEntries(ccDraft, cc, t.list, 'CC', MAX_CC) : { list: cc, error: null, rest: '' };
    setTo(t.list); setCc(c.list); setToDraft(t.rest); setCcDraft(c.rest);
    setToError(t.error); setCcError(c.error);
    if (t.error || c.error) return;
    setSaving(true);
    const res = await api.put<View>(
      `/api/gifsy/clients/${encodeURIComponent(slug)}/ticket-remarks-email`, { to: t.list, cc: c.list },
    );
    setSaving(false);
    if (res.success) {
      apply(res.data); setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2500);
    } else {
      setSaveError(res.error);
    }
  };

  const dirty = !sameList(toList(server), to) || !sameList(ccList(server), cc) || !!toDraft.trim() || !!ccDraft.trim();
  // An entry still in a draft with an error can't be saved — say why next to the disabled button.
  const blockedReason = (toError && toDraft.trim()) || (ccError && ccDraft.trim())
    ? 'Fix or remove the highlighted address to save.'
    : null;

  if (loading) {
    return <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>;
  }
  if (loadError) {
    return (
      <div role="alert" className="text-sm text-red-600 flex flex-wrap items-center gap-3">
        Could not load the ticket remarks email: {loadError}
        <Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>
      </div>
    );
  }
  const savedTo = toList(server);
  const savedCc = ccList(server);
  return (
    <div className="space-y-3 w-full max-w-xl" data-testid="ticket-remarks-email-card">
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-gray-800">Ticket remarks email</h3>
        <p id="ticket-remarks-email-help" className="text-xs text-gray-500">
          Who gets the &apos;Ask client admin for remarks&apos; email. <strong className="font-medium">To</strong>: when
          set, the email goes to these addresses (the admin asked is named in the email); leave it blank and the email
          goes to the admin chosen on each ticket. <strong className="font-medium">CC</strong>: copied on every remarks
          email either way — and if To is blank and the chosen admin has no email address, the CC list receives it
          instead. Press Enter or comma after each address.
        </p>
      </div>
      <ChipInput
        id="ticket-remarks-to" label="To" name="To" max={MAX_TO} list={to} other={cc}
        draft={toDraft} error={toError} disabled={saving}
        onChange={(l) => { setTo(l); setSaveError(null); }} onDraft={setToDraft} onError={setToError}
      />
      <ChipInput
        id="ticket-remarks-cc" label="CC" name="CC" max={MAX_CC} list={cc} other={to}
        draft={ccDraft} error={ccError} disabled={saving}
        onChange={(l) => { setCc(l); setSaveError(null); }} onDraft={setCcDraft} onError={setCcError}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm" loading={saving} disabled={!dirty || saving || !!blockedReason} onClick={save}
          aria-describedby={blockedReason ? 'ticket-remarks-save-blocked' : undefined}
        >Save</Button>
        {blockedReason && <p id="ticket-remarks-save-blocked" className="text-xs text-amber-700">{blockedReason}</p>}
        {saved && <p role="status" className="text-xs text-emerald-700">Saved.</p>}
      </div>
      {saveError && <p role="alert" className="text-xs text-red-600">{saveError}</p>}
      <p className="text-xs text-gray-500" data-testid="ticket-remarks-email-summary">
        {savedTo.length
          ? `Currently: To ${savedTo.join(', ')}${savedCc.length ? `; CC ${savedCc.join(', ')}` : ''}.`
          : savedCc.length
            ? `Currently: To the admin chosen on each ticket; CC ${savedCc.join(', ')}.`
            : 'Currently: the admin chosen on each ticket only.'}
      </p>
      <p className="text-xs text-gray-400" data-testid="ticket-remarks-email-last-change">
        {server?.lastChange
          ? `Last changed by ${server.lastChange.byName} on ${new Date(server.lastChange.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`
          : 'Never changed — remarks emails go to the chosen admin.'}
      </p>
    </div>
  );
}
