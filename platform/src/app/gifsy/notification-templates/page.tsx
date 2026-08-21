'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell, Loader2, Save, AlertTriangle, CheckCircle2, XCircle, Lock, Zap,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { getStoredUser } from '@/lib/auth-client';

// ── Contract (mirrors GET/PUT /api/admin/notification-templates) ────────────────────

/** The 10 trigger points, in the order they render. Kept as a const tuple so EventKey is
 *  a closed union and every row is always present even if the backend omits one. */
const EVENT_KEYS = [
  'KYC_SUBMITTED',
  'KYC_APPROVED',
  'KYC_REJECTED',
  'KYC_UNDER_REVIEW',
  'POINTS_CREDITED',
  'PAYOUT_CREDITED',
  'REDEMPTION_CONFIRMED',
  'ORDER_DISPATCHED',
  'ORDER_DELIVERED',
  'ORDER_CANCELLED',
] as const;

type EventKey = (typeof EVENT_KEYS)[number];

type Mode = 'OFF' | 'SMS' | 'WHATSAPP' | 'BOTH';

interface EventConfig {
  mode: Mode;
  whatsappTemplate: string;
  smsTemplateId: string;
}

interface EventContract {
  label: string;
  sms: string[];
  whatsapp: string[];
  /** Whether the free in-app / push channels fire for this event. Some events
   *  (e.g. KYC_SUBMITTED, PAYOUT_CREDITED) suppress the free channels, so the
   *  "Always on" chip would be a lie for them. Undefined during rollout → treat
   *  as true so the chip degrades gracefully rather than blanking. */
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

// The whole page state: two masters + a complete per-event map (all 10 keys normalized).
interface FormState {
  masterSms: boolean;
  masterWhatsapp: boolean;
  events: Record<EventKey, EventConfig>;
}

const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: 'OFF', label: 'Off' },
  { value: 'SMS', label: 'SMS only' },
  { value: 'WHATSAPP', label: 'WhatsApp only' },
  { value: 'BOTH', label: 'Both' },
];

const EMPTY_EVENT: EventConfig = { mode: 'OFF', whatsappTemplate: '', smsTemplateId: '' };

/** Normalize the (possibly partial) backend events map into a complete, ordered form. */
function toFormState(cfg: NotificationConfig): FormState {
  const events = {} as Record<EventKey, EventConfig>;
  for (const key of EVENT_KEYS) {
    const e = cfg.events?.[key];
    events[key] = {
      mode: e?.mode ?? 'OFF',
      whatsappTemplate: e?.whatsappTemplate ?? '',
      smsTemplateId: e?.smsTemplateId ?? '',
    };
  }
  return {
    masterSms: !!cfg.masterSms,
    masterWhatsapp: !!cfg.masterWhatsapp,
    events,
  };
}

/** A channel is "targeted" by a mode when the mode routes to it. */
const smsTargeted = (m: Mode) => m === 'SMS' || m === 'BOTH';
const whatsappTargeted = (m: Mode) => m === 'WHATSAPP' || m === 'BOTH';

/** Render a variable contract (['orderId','amount']) as the read-only "{1}=orderId, {2}=amount". */
function contractHint(vars: string[] | undefined): string {
  if (!vars || vars.length === 0) return 'No variables';
  return vars.map((v, i) => `{${i + 1}}=${v}`).join(', ');
}

// ── Page ─────────────────────────────────────────────────────────────────────────

export default function GifsyNotificationTemplatesPage() {
  // Owner-only, mirroring /gifsy/tds-statutory: the /gifsy shell already routes
  // GIFSY_STAFF to a launchpad, but guard the page itself as defence-in-depth.
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
  const [contracts, setContracts] = useState<Partial<Record<EventKey, EventContract>>>({});

  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  // Clear a pending toast timer on unmount so it can't fire setState after teardown.
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const res = await api.get<NotificationPayload>('/api/admin/notification-templates');
    if (res.success) {
      setForm(toFormState(res.data.config));
      setContracts(res.data.contracts ?? {});
    } else {
      setLoadError(res.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (ready && role === 'GIFSY_ADMIN') void load(); }, [ready, role, load]);

  function setMaster(channel: 'masterSms' | 'masterWhatsapp', value: boolean) {
    setForm((prev) => (prev ? { ...prev, [channel]: value } : prev));
  }
  function updateEvent(key: EventKey, patch: Partial<EventConfig>) {
    setForm((prev) =>
      prev ? { ...prev, events: { ...prev.events, [key]: { ...prev.events[key], ...patch } } } : prev,
    );
  }

  async function handleSave() {
    if (!form) return;
    setSaving(true);
    const res = await api.put<NotificationPayload>('/api/admin/notification-templates', {
      masterSms: form.masterSms,
      masterWhatsapp: form.masterWhatsapp,
      events: form.events,
    });
    setSaving(false);
    if (res.success) {
      // Re-hydrate from the server's echoed config so the view matches persisted state.
      if (res.data?.config) {
        setForm(toFormState(res.data.config));
        if (res.data.contracts) setContracts(res.data.contracts);
      }
      showToast('Notification templates saved.');
    } else {
      showToast(res.error, 'error');
    }
  }

  // ── Render: not-ready / owner-only guard ──
  if (!ready) return null;
  if (role !== 'GIFSY_ADMIN') {
    return (
      <div className="max-w-lg mx-auto mt-10 border border-white/10 rounded-xl px-6 py-8 text-center">
        <Lock className="w-6 h-6 mx-auto text-white/40" />
        <h1 className="text-lg font-bold text-white mt-3">Owner-only</h1>
        <p className="text-sm text-white/50 mt-1">
          Only the platform owner (GIFSY_ADMIN) can view or edit notification templates.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Bell className="w-5 h-5 text-white/60" />Notification Templates
          </h1>
          <p className="text-sm text-white/50 mt-0.5">
            Choose which channels each trigger point sends on, and the message template to use.
            In-app / push is always delivered for free; SMS and WhatsApp are paid channels you opt in
            to per trigger.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => { void handleSave(); }}
          loading={saving}
          disabled={loading || !form || !!loadError}
          data-testid="save-btn"
        >
          <Save className="w-4 h-4" />Save changes
        </Button>
      </div>

      {/* Master toggles */}
      {!loading && !loadError && form && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <MasterToggle
            testId="master-sms-toggle"
            label="SMS enabled"
            hint="Platform-wide switch for the SMS channel. When off, no trigger sends SMS."
            checked={form.masterSms}
            onChange={(v) => setMaster('masterSms', v)}
          />
          <MasterToggle
            testId="master-wa-toggle"
            label="WhatsApp enabled"
            hint="Platform-wide switch for the WhatsApp channel. When off, no trigger sends WhatsApp."
            checked={form.masterWhatsapp}
            onChange={(v) => setMaster('masterWhatsapp', v)}
          />
        </div>
      )}

      {/* Load states */}
      {loading && (
        <div className="border border-white/10 rounded-xl px-4 py-12 text-center text-white/40 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />Loading notification templates…
        </div>
      )}
      {!loading && loadError && (
        <div className="border border-white/10 rounded-xl px-4 py-12 text-center text-sm">
          <p className="text-red-400">{loadError}</p>
          <button
            onClick={() => { void load(); }}
            className="mt-3 px-4 py-1.5 text-xs font-medium border border-white/15 text-white/70 rounded-lg hover:bg-white/5 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Grid of trigger points */}
      {!loading && !loadError && form && (
        <div className="space-y-4">
          {EVENT_KEYS.map((key) => (
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

      {/* Toast */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-6 right-6 z-[70] flex items-center gap-2 bg-gray-900 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg"
        >
          {toast.type === 'error'
            ? <XCircle className="w-4 h-4 text-red-400" />
            : <CheckCircle2 className="w-4 h-4 text-green-400" />}
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Master toggle ──────────────────────────────────────────────────────────────────

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

// ── One trigger-point row ────────────────────────────────────────────────────────

const INPUT_CLS =
  'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30';
const INPUT_DISABLED_CLS =
  'w-full bg-white/5 border border-white/5 rounded-lg px-3 py-2 text-sm text-white/40 placeholder:text-white/20 cursor-not-allowed';

function EventRow({
  eventKey, config, contract, masterSms, masterWhatsapp, onChange,
}: {
  eventKey: EventKey;
  config: EventConfig;
  contract?: EventContract;
  masterSms: boolean;
  masterWhatsapp: boolean;
  onChange: (patch: Partial<EventConfig>) => void;
}) {
  const label = contract?.label ?? eventKey;

  // The free in-app/push channels are on for most events, but some (KYC_SUBMITTED,
  // PAYOUT_CREDITED) suppress them. Undefined (pre-rollout) → assume on so the row
  // never blanks; prefer the real per-event value once the backend supplies it.
  const freeChannels = contract?.freeChannels ?? true;

  const smsOn = smsTargeted(config.mode);
  const waOn = whatsappTargeted(config.mode);

  // Inputs are greyed when their channel master is off (can't edit a channel you've turned off).
  const smsDisabled = !masterSms;
  const waDisabled = !masterWhatsapp;

  // Fail-safe warnings (warn, never block a save):
  //  - channel targeted but its master is off → it silently won't send.
  //  - channel targeted, master on, but the template is blank → it will be skipped.
  const warnings: string[] = [];
  if (smsOn && !masterSms) warnings.push('SMS master is off — this trigger will not send SMS.');
  else if (smsOn && !config.smsTemplateId.trim()) warnings.push('SMS template ID is blank — SMS will be skipped.');
  if (waOn && !masterWhatsapp) warnings.push('WhatsApp master is off — this trigger will not send WhatsApp.');
  else if (waOn && !config.whatsappTemplate.trim()) warnings.push('WhatsApp template is blank — WhatsApp will be skipped.');

  return (
    <div className="border border-white/10 rounded-xl overflow-hidden" data-testid={`row-${eventKey}`}>
      <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-white">{label}</p>
          <p className="text-[11px] font-mono text-white/30 mt-0.5">{eventKey}</p>
        </div>
        {/* In-app / Push — free channels; honest per-event (some events suppress them) */}
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

      <div className="px-5 py-5 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Channel mode */}
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
              // Don't offer a mode that routes to a platform-disabled channel
              // (picking "SMS only" then finding the field greyed is friction).
              // The current value stays selectable so a saved config still shows.
              const needsSms = smsTargeted(o.value);
              const needsWa = whatsappTargeted(o.value);
              const unavailable =
                o.value !== config.mode &&
                ((needsSms && !masterSms) || (needsWa && !masterWhatsapp));
              return (
                <option
                  key={o.value}
                  value={o.value}
                  disabled={unavailable}
                  className="bg-gray-900 text-white"
                >
                  {o.label}
                </option>
              );
            })}
          </select>
        </div>

        {/* WhatsApp template */}
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
              ? 'WhatsApp is disabled platform-wide — turn on the WhatsApp master toggle to edit.'
              : `Variables: ${contractHint(contract?.whatsapp)}`}
          </p>
        </div>

        {/* SMS template id */}
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
              ? 'SMS is disabled platform-wide — turn on the SMS master toggle to edit.'
              : `Variables: ${contractHint(contract?.sms)}`}
          </p>
        </div>
      </div>

      {/* Fail-safe warnings (do not block save) */}
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
