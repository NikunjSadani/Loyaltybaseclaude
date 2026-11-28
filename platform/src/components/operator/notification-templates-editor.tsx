'use client';

/**
 * Gifsy console → Clients → <client> → Notifications → "Notification templates" (owner-approved move
 * 2026-11-28; was the standalone /gifsy/notification-templates page, which edited the operator's
 * ASSUMED tenant and so could not be found from the client page).
 *
 * Edits the client being VIEWED (`slug`) — no assume step:
 *   GET/PUT /api/gifsy/clients/:slug/notification-templates  → { config, contracts }
 * Per client: the two master switches (SMS / WhatsApp), and per trigger point the channel mode, the
 * WhatsApp template name, the optional WhatsApp variable-order override (a stored invalid override is
 * shown as BLOCKED, never silently dropped) and the SMS (DLT / MSG91) template id.
 *
 * GIFSY_ADMIN only — API-enforced (GIFSY_STAFF / tenant roles get 403); the client page renders this
 * only for the owner, and the component guards itself too (defence in depth).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2, Save, AlertTriangle, CheckCircle2, XCircle, Lock, Zap,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { getStoredUser } from '@/lib/auth-client';
import { useUnsavedChangesGuard } from '@/lib/use-unsaved-changes-guard';

export const UNSAVED_NOTIFICATIONS_MESSAGE =
  'You have unsaved notification changes — leave without saving?';

// ── Contract (mirrors GET/PUT /api/gifsy/clients/:slug/notification-templates) ───────────────────

/** The trigger points, in the order they render. Kept as a const tuple so EventKey is a closed
 *  union and every row is always present even if the backend omits one. */
export const NOTIFICATION_EVENT_KEYS = [
  'KYC_SUBMITTED',
  'KYC_APPROVED',
  'KYC_REJECTED',
  'KYC_UNDER_REVIEW',
  'POINTS_CREDITED',
  'PAYOUT_CREDITED',
  'REDEMPTION_CONFIRMED',
  'VOUCHER_ISSUED',
  'ORDER_DISPATCHED',
  'ORDER_DELIVERED',
  'ORDER_CANCELLED',
] as const;

type EventKey = (typeof NOTIFICATION_EVENT_KEYS)[number];

type Mode = 'OFF' | 'SMS' | 'WHATSAPP' | 'BOTH';

interface EventConfig {
  mode: Mode;
  whatsappTemplate: string;
  smsTemplateId: string;
  /** Optional per-tenant WhatsApp body-variable order override (absent ⇒ the contract order). */
  whatsappVariables?: string[];
  /** Read-only from GET: the STORED override is invalid (WhatsApp for this event is blocked). */
  whatsappVariablesError?: string;
}

/** Form-side row: the override is edited as comma-separated text and parsed on save. */
interface FormEvent extends Omit<EventConfig, 'whatsappVariables' | 'whatsappVariablesError'> {
  waVarsText: string;
  /** Server-reported error for the stored override; never sent back on save. */
  waVarsError?: string;
}

/** Parse "a, b ,c" → ['a','b','c']; blank → undefined (no override). */
function parseVarsText(text: string): string[] | undefined {
  const list = text.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

interface EventContract {
  label: string;
  sms: string[];
  whatsapp: string[];
  /** Whether the free in-app / push channels fire for this event. Some events (e.g. KYC_SUBMITTED)
   *  suppress them, so the "Always on" chip would be a lie for them. Undefined → treat as true. */
  freeChannels?: boolean;
}

interface NotificationConfig {
  masterSms: boolean;
  masterWhatsapp: boolean;
  events: Partial<Record<EventKey, EventConfig>>;
}

interface NotificationPayload {
  config: NotificationConfig;
  contracts: Partial<Record<EventKey, EventContract>>;
}

interface FormState {
  masterSms: boolean;
  masterWhatsapp: boolean;
  events: Record<EventKey, FormEvent>;
}

const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: 'OFF', label: 'Off' },
  { value: 'SMS', label: 'SMS only' },
  { value: 'WHATSAPP', label: 'WhatsApp only' },
  { value: 'BOTH', label: 'Both' },
];

/** Normalize the (possibly partial) backend events map into a complete, ordered form. */
function toFormState(cfg: NotificationConfig): FormState {
  const events = {} as Record<EventKey, FormEvent>;
  for (const key of NOTIFICATION_EVENT_KEYS) {
    const e = cfg.events?.[key];
    events[key] = {
      mode: e?.mode ?? 'OFF',
      whatsappTemplate: e?.whatsappTemplate ?? '',
      smsTemplateId: e?.smsTemplateId ?? '',
      // Round-trip the override so a later save never silently drops it.
      waVarsText: (e?.whatsappVariables ?? []).join(', '),
      ...(e?.whatsappVariablesError ? { waVarsError: e.whatsappVariablesError } : {}),
    };
  }
  return { masterSms: !!cfg.masterSms, masterWhatsapp: !!cfg.masterWhatsapp, events };
}

const smsTargeted = (m: Mode) => m === 'SMS' || m === 'BOTH';
const whatsappTargeted = (m: Mode) => m === 'WHATSAPP' || m === 'BOTH';

/** Render a variable contract (['orderId','amount']) as the read-only "{1}=orderId, {2}=amount". */
function contractHint(vars: string[] | undefined): string {
  if (!vars || vars.length === 0) return 'No variables';
  return vars.map((v, i) => `{${i + 1}}=${v}`).join(', ');
}

export function notificationTemplatesPath(slug: string): string {
  return `/api/gifsy/clients/${encodeURIComponent(slug)}/notification-templates`;
}

// ── Editor ─────────────────────────────────────────────────────────────────────────────────

export function NotificationTemplatesEditor({
  slug, onDirtyChange,
}: {
  slug: string;
  /** Called with true/false whenever the form starts/stops differing from the last loaded/saved state. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [role, setRole] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setRole(getStoredUser()?.role ?? null);
    setReady(true);
  }, []);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  // Snapshot of the last loaded / saved form — "dirty" = the form differs from it.
  const [baseline, setBaseline] = useState<string | null>(null);
  const [contracts, setContracts] = useState<Partial<Record<EventKey, EventContract>>>({});
  const [status, setStatus] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a slow response for a PREVIOUS slug landing on the current client's form.
  const slugRef = useRef(slug);
  useEffect(() => { slugRef.current = slug; }, [slug]);

  useEffect(() => () => { if (statusTimer.current) clearTimeout(statusTimer.current); }, []);

  const showStatus = useCallback((msg: string, type: 'success' | 'error') => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatus({ msg, type });
    // Errors stay until the next action; a success note fades.
    if (type === 'success') statusTimer.current = setTimeout(() => setStatus(null), 4000);
  }, []);

  const load = useCallback(async () => {
    const forSlug = slug;
    setLoading(true);
    setLoadError(null);
    setForm(null);
    setStatus(null);
    setSaving(false); // a save in flight for a previous slug never leaves this client's button stuck
    const res = await api.get<NotificationPayload>(notificationTemplatesPath(forSlug));
    if (slugRef.current !== forSlug) return;
    if (res.success) {
      const next = toFormState(res.data.config);
      setForm(next);
      setBaseline(JSON.stringify(next));
      setContracts(res.data.contracts ?? {});
    } else {
      setLoadError(res.error);
    }
    setLoading(false);
  }, [slug]);

  useEffect(() => { if (ready && role === 'GIFSY_ADMIN') void load(); }, [ready, role, load]);

  const dirty = !!form && baseline !== null && JSON.stringify(form) !== baseline;

  // Tell the parent (section-header "Unsaved changes" marker); clear it on unmount.
  const onDirtyRef = useRef(onDirtyChange);
  useEffect(() => { onDirtyRef.current = onDirtyChange; }, [onDirtyChange]);
  useEffect(() => { onDirtyRef.current?.(dirty); }, [dirty]);
  useEffect(() => () => { onDirtyRef.current?.(false); }, []);

  // Leave-page guard (unload, in-app links, Back). When a parent takes `onDirtyChange` it OWNS the
  // guard (so the client page can combine this with its sender-ID edits into ONE prompt); standalone,
  // the editor guards itself.
  useUnsavedChangesGuard(!onDirtyChange && dirty, UNSAVED_NOTIFICATIONS_MESSAGE);

  function setMaster(channel: 'masterSms' | 'masterWhatsapp', value: boolean) {
    setForm((prev) => (prev ? { ...prev, [channel]: value } : prev));
  }
  function updateEvent(key: EventKey, patch: Partial<FormEvent>) {
    setForm((prev) =>
      prev ? { ...prev, events: { ...prev.events, [key]: { ...prev.events[key], ...patch } } } : prev,
    );
  }

  async function handleSave() {
    if (!form || saving) return;
    const forSlug = slug;
    setSaving(true);
    setStatus(null);
    const res = await api.put<NotificationPayload>(notificationTemplatesPath(forSlug), {
      masterSms: form.masterSms,
      masterWhatsapp: form.masterWhatsapp,
      events: Object.fromEntries(
        NOTIFICATION_EVENT_KEYS.map((k) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { waVarsText, waVarsError, ...rest } = form.events[k];
          const wv = parseVarsText(waVarsText);
          // Omit the key entirely when blank → the backend keeps the canonical contract order.
          return [k, wv ? { ...rest, whatsappVariables: wv } : rest];
        }),
      ),
    });
    if (slugRef.current !== forSlug) return;
    setSaving(false);
    if (res.success) {
      // Re-hydrate from the server's echoed config so the view matches persisted state.
      if (res.data?.config) {
        const next = toFormState(res.data.config);
        setForm(next);
        setBaseline(JSON.stringify(next));
        if (res.data.contracts) setContracts(res.data.contracts);
      } else {
        // No echo — what we sent is now the persisted state.
        setBaseline(JSON.stringify(form));
      }
      showStatus('Notification templates saved.', 'success');
    } else {
      showStatus(`Not saved — ${res.error}`, 'error');
    }
  }

  if (!ready) return null;
  if (role !== 'GIFSY_ADMIN') {
    return (
      <div className="border border-white/10 rounded-xl px-4 py-6 text-center" data-testid="nt-owner-only">
        <Lock className="w-5 h-5 mx-auto text-white/40" />
        <p className="text-sm font-semibold text-white mt-2">Owner-only</p>
        <p className="text-xs text-white/50 mt-1">
          Only the platform owner (GIFSY_ADMIN) can view or edit notification templates.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="notification-templates-editor">
      <div className="flex flex-wrap items-start justify-between gap-3" data-testid="nt-top-row">
        <p className="text-xs text-white/50 min-w-0 flex-1 basis-60">
          Choose which channels each trigger point sends on for this client, and the message template
          to use. In-app / push is free; SMS and WhatsApp are paid channels you opt in to per trigger.
        </p>
        <Button
          variant="primary"
          onClick={() => { void handleSave(); }}
          loading={saving}
          disabled={loading || !form || !!loadError || saving}
          data-testid="save-btn"
        >
          <Save className="w-4 h-4" />Save templates
        </Button>
      </div>

      {status && (
        <p
          role={status.type === 'error' ? 'alert' : 'status'}
          data-testid="nt-save-status"
          className={`flex items-center gap-1.5 text-xs ${status.type === 'error' ? 'text-red-400' : 'text-green-400'}`}
        >
          {status.type === 'error'
            ? <XCircle className="w-3.5 h-3.5 shrink-0" />
            : <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />}
          {status.msg}
        </p>
      )}

      {/* Every control is LOCKED while a save is in flight (native fieldset disable), so nothing
          typed during the save can be overwritten by the server echo. */}
      <fieldset disabled={saving} data-testid="nt-fields" className="space-y-4 min-w-0 border-0 p-0 m-0">
      {!loading && !loadError && form && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <MasterToggle
            testId="master-sms-toggle"
            label="SMS enabled"
            hint="Master switch for this client's SMS channel. When off, no trigger sends SMS."
            checked={form.masterSms}
            onChange={(v) => setMaster('masterSms', v)}
          />
          <MasterToggle
            testId="master-wa-toggle"
            label="WhatsApp enabled"
            hint="Master switch for this client's WhatsApp channel. When off, no trigger sends WhatsApp."
            checked={form.masterWhatsapp}
            onChange={(v) => setMaster('masterWhatsapp', v)}
          />
        </div>
      )}

      {loading && (
        <div className="border border-white/10 rounded-xl px-4 py-8 text-center text-white/40 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />Loading notification templates…
        </div>
      )}
      {!loading && loadError && (
        <div className="border border-white/10 rounded-xl px-4 py-8 text-center text-sm" data-testid="nt-load-error">
          <p className="text-red-400">{loadError}</p>
          <button
            onClick={() => { void load(); }}
            className="mt-3 px-4 py-1.5 text-xs font-medium border border-white/15 text-white/70 rounded-lg hover:bg-white/5 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !loadError && form && (
        <div className="space-y-4">
          {NOTIFICATION_EVENT_KEYS.map((key) => (
            <EventRow
              key={key}
              eventKey={key}
              config={form.events[key]}
              contract={contracts[key]}
              masterSms={form.masterSms}
              masterWhatsapp={form.masterWhatsapp}
              onChange={(patch) => updateEvent(key, patch)}
            />
          ))}
        </div>
      )}
      </fieldset>
    </div>
  );
}

// ── Master toggle ──────────────────────────────────────────────────────────────────────────

function MasterToggle({
  testId, label, hint, checked, onChange,
}: {
  testId: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="border border-white/10 rounded-xl px-4 py-3 flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-semibold text-white">{label}</p>
        <p className="text-xs text-white/40 mt-0.5">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        data-testid={testId}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          checked ? 'bg-green-500/80' : 'bg-white/15'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}

// ── One trigger-point row ──────────────────────────────────────────────────────────────────

const INPUT_CLS =
  'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30';
const INPUT_DISABLED_CLS =
  'w-full bg-white/5 border border-white/5 rounded-lg px-3 py-2 text-sm text-white/40 placeholder:text-white/20 cursor-not-allowed';

function EventRow({
  eventKey, config, contract, masterSms, masterWhatsapp, onChange,
}: {
  eventKey: EventKey;
  config: FormEvent;
  contract?: EventContract;
  masterSms: boolean;
  masterWhatsapp: boolean;
  onChange: (patch: Partial<FormEvent>) => void;
}) {
  const label = contract?.label ?? eventKey;
  const freeChannels = contract?.freeChannels ?? true;

  const smsOn = smsTargeted(config.mode);
  const waOn = whatsappTargeted(config.mode);

  // Inputs are greyed when their channel master is off (can't edit a channel you've turned off).
  const smsDisabled = !masterSms;
  const waDisabled = !masterWhatsapp;

  // Fail-safe warnings (warn, never block a save).
  const warnings: string[] = [];
  if (smsOn && !masterSms) warnings.push('SMS master is off — this trigger will not send SMS.');
  else if (smsOn && !config.smsTemplateId.trim()) warnings.push('SMS template ID is blank — SMS will be skipped.');
  if (waOn && !masterWhatsapp) warnings.push('WhatsApp master is off — this trigger will not send WhatsApp.');
  else if (waOn && !config.whatsappTemplate.trim()) warnings.push('WhatsApp template is blank — WhatsApp will be skipped.');

  return (
    <div className="border border-white/10 rounded-xl overflow-hidden" data-testid={`row-${eventKey}`}>
      <div className="px-4 sm:px-5 py-4 border-b border-white/5 flex flex-wrap items-center justify-between gap-2 sm:gap-4" data-testid={`row-header-${eventKey}`}>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white break-words">{label}</p>
          <p className="text-[11px] font-mono text-white/30 mt-0.5 break-all">{eventKey}</p>
        </div>
        {freeChannels ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-green-500/10 border border-green-500/20 px-2.5 py-1 text-[11px] font-medium text-green-300"
            title="In-app and push notifications are free and always delivered for this event."
            data-testid={`free-chip-${eventKey}`}
          >
            <Zap className="w-3 h-3" />In-app / Push: Always on
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-white/5 border border-white/10 px-2.5 py-1 text-[11px] font-medium text-white/40"
            title="This event does not send in-app or push notifications."
            data-testid={`free-chip-${eventKey}`}
          >
            <Zap className="w-3 h-3" />In-app / Push: not sent for this event
          </span>
        )}
      </div>

      <div className="px-4 sm:px-5 py-5 grid grid-cols-1 lg:grid-cols-3 gap-4 min-w-0">
        <div>
          <label className="block text-xs font-medium text-white/50 mb-1.5" htmlFor={`mode-${eventKey}`}>
            Channels
          </label>
          <select
            id={`mode-${eventKey}`}
            data-testid={`mode-${eventKey}`}
            value={config.mode}
            aria-label={`Channels for ${label}`}
            onChange={(e) => onChange({ mode: e.target.value as Mode })}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-white/30"
          >
            {MODE_OPTIONS.map((o) => {
              // Don't offer a mode that routes to a master-disabled channel; the current value stays
              // selectable so a saved config still shows.
              const unavailable =
                o.value !== config.mode &&
                ((smsTargeted(o.value) && !masterSms) || (whatsappTargeted(o.value) && !masterWhatsapp));
              return (
                <option key={o.value} value={o.value} disabled={unavailable} className="bg-gray-900 text-white">
                  {o.label}
                </option>
              );
            })}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-white/50 mb-1.5" htmlFor={`wa-${eventKey}`}>
            WhatsApp template name
          </label>
          <input
            id={`wa-${eventKey}`}
            type="text"
            data-testid={`wa-${eventKey}`}
            value={config.whatsappTemplate}
            disabled={waDisabled}
            aria-label={`WhatsApp template for ${label}`}
            placeholder="e.g. order_dispatched_v2"
            onChange={(e) => onChange({ whatsappTemplate: e.target.value })}
            className={waDisabled ? INPUT_DISABLED_CLS : INPUT_CLS}
          />
          <p className="text-[11px] text-white/30 mt-1">
            {waDisabled
              ? 'WhatsApp is off for this client — turn on the WhatsApp master switch to edit.'
              : `Variables: ${contractHint(parseVarsText(config.waVarsText) ?? contract?.whatsapp)}`}
          </p>
          <label className="block text-[11px] font-medium text-white/40 mt-2 mb-1" htmlFor={`wavars-${eventKey}`}>
            Variable order override (optional, comma-separated)
          </label>
          <input
            id={`wavars-${eventKey}`}
            type="text"
            data-testid={`wavars-${eventKey}`}
            value={config.waVarsText}
            // Deliberately editable even while WhatsApp is off: a stored invalid list (BLOCKED
            // message below) must always be fixable / clearable without turning WhatsApp on first.
            aria-label={`WhatsApp variable order for ${label}`}
            // Never put variable names in the placeholder: grey names looked like a filled-in value and
            // an owner saved an empty box believing the override was set (prod, 2026-11-28).
            placeholder="Leave blank for the default order"
            onChange={(e) => onChange({ waVarsText: e.target.value })}
            className={INPUT_CLS}
          />
          {(() => {
            const n = parseVarsText(config.waVarsText)?.length ?? 0;
            return n > 0 ? (
              <span
                data-testid={`wavars-set-${eventKey}`}
                className="inline-flex items-center mt-1 rounded-full bg-sky-500/10 border border-sky-500/30 px-2 py-0.5 text-[11px] font-medium text-sky-300"
              >
                Override set: {n} variable{n === 1 ? '' : 's'}
              </span>
            ) : (
              <span data-testid={`wavars-none-${eventKey}`} className="block text-[11px] text-white/40 mt-1">
                No override — the default order is used.
              </span>
            );
          })()}
          <p className="text-[11px] text-white/30 mt-1 break-words" data-testid={`wavars-default-${eventKey}`}>
            Default: {contract?.whatsapp?.length ? contract.whatsapp.join(', ') : 'no variables'}
          </p>
          {config.waVarsError && (
            <p role="alert" data-testid={`wavars-error-${eventKey}`} className="flex items-start gap-1.5 text-[11px] text-red-400 mt-1">
              <XCircle className="w-3 h-3 mt-0.5 shrink-0" />
              WhatsApp for this trigger is BLOCKED: {config.waVarsError} Fix or clear the list, then save.
            </p>
          )}
          <p className="text-[11px] text-white/30 mt-1">
            Leave blank to use the default order. Only use when the approved template has different variables.
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-white/50 mb-1.5" htmlFor={`sms-${eventKey}`}>
            SMS template ID (DLT / MSG91)
          </label>
          <input
            id={`sms-${eventKey}`}
            type="text"
            data-testid={`sms-${eventKey}`}
            value={config.smsTemplateId}
            disabled={smsDisabled}
            aria-label={`SMS template ID for ${label}`}
            placeholder="e.g. 1707160000000000000"
            onChange={(e) => onChange({ smsTemplateId: e.target.value })}
            className={smsDisabled ? INPUT_DISABLED_CLS : INPUT_CLS}
          />
          <p className="text-[11px] text-white/30 mt-1">
            {smsDisabled
              ? 'SMS is off for this client — turn on the SMS master switch to edit.'
              : `Variables: ${contractHint(contract?.sms)}`}
          </p>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="px-5 pb-4 space-y-1.5" data-testid={`warnings-${eventKey}`}>
          {warnings.map((w, i) => (
            <p key={i} className="flex items-start gap-1.5 text-[11px] text-amber-300">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
