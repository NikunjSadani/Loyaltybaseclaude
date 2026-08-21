/**
 * Per-tenant NOTIFICATION-TEMPLATES config — canonical shape, event keys, variable
 * contracts, and the DB→default merge helpers (Phase 2, config layer).
 *
 * WHAT THIS IS: a single per-tenant `program_settings` row (clientId = tenant slug,
 * settingKey = 'notificationTemplates') whose JSON value chooses, PER EVENT, whether a
 * customer notification goes out over SMS, WhatsApp, both, or neither — plus which
 * MSG91-registered template that channel uses. Two master switches gate each channel
 * tenant-wide.
 *
 * WHY the WhatsApp defaults are seeded from notifications/whatsapp-kyc.config.ts:
 * that file (WHATSAPP_KYC) is TODAY's source of truth for the per-tenant KYC/points/payout
 * WhatsApp template names. It stays untouched as the DEFAULT FALLBACK so an UNCONFIGURED
 * tenant resolves the exact same WhatsApp template names it uses today; a stored config row
 * OVERRIDES those defaults. (This module does NOT yet wire the resolver into the actual
 * senders — it is the config store + resolver only, exported for later consumers.)
 *
 * FAIL-SAFE: the read/merge path never throws. A missing/malformed row, a bad mode, or an
 * over-long string all fall back to the typed default (mode OFF + the seeded template), so a
 * poisoned config can never break a notification send. The WRITE path is strict
 * (validateNotificationTemplatesInput → BadRequest) so junk can't be persisted in the first place.
 */
import { WHATSAPP_KYC } from '../notifications/whatsapp-kyc.config';

/** The program_settings key under which the per-tenant config JSON is stored. */
export const NOTIFICATION_TEMPLATES_SETTING_KEY = 'notificationTemplates';

/** The exact, canonical set of notification event keys (order = display order). */
export const EVENT_KEYS = [
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

export type EventKey = (typeof EVENT_KEYS)[number];

const EVENT_KEY_SET: ReadonlySet<string> = new Set(EVENT_KEYS);

/**
 * SINGLE SOURCE OF TRUTH for whether an event actually writes the FREE channels (IN_APP feed +
 * PUSH). These are the events whose `notifyUserWithChannels` call passes `includeFreeChannels:false`
 * — historically paid-channel-only sends that never wrote a bell/push row:
 *   - KYC_SUBMITTED   (kyc.service.ts — submission only sent the owner WhatsApp)
 *   - PAYOUT_CREDITED (credits.service.ts — a payout only sent the owner WhatsApp)
 * Every OTHER event writes the free channels (POINTS_CREDITED is `includeFreeChannels:!!userId`,
 * i.e. TRUE in the normal case where the partner has a login user — treated as true here).
 * The GET /notification-templates contract exposes this as `freeChannels` per event so the FE can
 * tell the operator which events reach the bell feed vs. paid-only.
 */
export const NO_FREE_CHANNEL_EVENTS: ReadonlySet<EventKey> = new Set<EventKey>([
  'KYC_SUBMITTED',
  'PAYOUT_CREDITED',
]);

/** True iff the event writes the free channels (IN_APP + PUSH). Derived from NO_FREE_CHANNEL_EVENTS. */
export function eventWritesFreeChannels(eventKey: EventKey): boolean {
  return !NO_FREE_CHANNEL_EVENTS.has(eventKey);
}

/** The four delivery modes for a single event. */
export const NOTIFICATION_MODES = ['OFF', 'SMS', 'WHATSAPP', 'BOTH'] as const;
export type NotificationMode = (typeof NOTIFICATION_MODES)[number];

const MODE_SET: ReadonlySet<string> = new Set(NOTIFICATION_MODES);

/** Max length for a template identifier/name (MSG91 template ids + WhatsApp template names). */
export const MAX_TEMPLATE_LEN = 200;

/** Per-event channel choice + the template each channel uses. */
export interface EventChannelConfig {
  mode: NotificationMode;
  /** WhatsApp template NAME (MSG91-registered). '' → none configured (resolver falls back to seed). */
  whatsappTemplate: string;
  /** SMS DLT template id. '' → none configured. */
  smsTemplateId: string;
}

/** The full, resolved per-tenant config (every EVENT_KEY present). */
export interface NotificationTemplatesConfig {
  masterSms: boolean;
  masterWhatsapp: boolean;
  events: Record<EventKey, EventChannelConfig>;
}

/** What the resolver hands a (future) consumer for one event. */
export interface ResolvedChannelConfig {
  mode: NotificationMode;
  whatsappTemplate: string;
  smsTemplateId: string;
  masterSms: boolean;
  masterWhatsapp: boolean;
}

/** One event's variable contract — the ORDERED variable lists for each channel. */
export interface EventVariableContract {
  label: string;
  /** Ordered SMS template variables. */
  sms: string[];
  /** Ordered WhatsApp body variables ({{1}}, {{2}}, … in this order). */
  whatsapp: string[];
  /** True iff this event writes the free channels (IN_APP + PUSH). Derived from NO_FREE_CHANNEL_EVENTS. */
  freeChannels: boolean;
}

/**
 * VARIABLE_CONTRACTS — the canonical, per-event ordered variable lists.
 *
 * The KYC_SUBMITTED / KYC_APPROVED / POINTS_CREDITED / PAYOUT_CREDITED WhatsApp contracts are
 * transcribed VERBATIM from the body-variable contract documented in
 * notifications/whatsapp-kyc.config.ts (the existing source of truth) so they can never drift
 * from what those approved MSG91 templates actually expect. The remaining events (and all SMS
 * lists) are NEW canonical definitions introduced by this config layer.
 */
const RAW_VARIABLE_CONTRACTS: Record<EventKey, Omit<EventVariableContract, 'freeChannels'>> = {
  KYC_SUBMITTED: {
    label: 'KYC Submitted',
    // whatsapp contract per WHATSAPP_KYC.submissionTemplate: {{1}} owner, {{2}} date, {{3}} program
    whatsapp: ['ownerName', 'submissionDate', 'programName'],
    sms: ['ownerName', 'programName'],
  },
  KYC_APPROVED: {
    label: 'KYC Approved',
    // whatsapp contract per WHATSAPP_KYC.approvalTemplate: {{1}} owner, {{2}} program
    whatsapp: ['ownerName', 'programName'],
    sms: ['ownerName', 'programName'],
  },
  KYC_REJECTED: {
    label: 'KYC Rejected',
    whatsapp: ['ownerName', 'programName', 'reason'],
    sms: ['ownerName', 'reason'],
  },
  KYC_UNDER_REVIEW: {
    label: 'KYC Under Review',
    whatsapp: ['ownerName', 'programName'],
    sms: ['ownerName'],
  },
  POINTS_CREDITED: {
    label: 'Points Credited',
    // whatsapp contract per WHATSAPP_KYC.pointsCreditTemplate:
    // {{1}} owner, {{2}} points credited, {{3}} redeemable balance, {{4}} month-year, {{5}} date
    whatsapp: ['ownerName', 'pointsCredited', 'redeemableBalance', 'monthYear', 'dateCredited'],
    sms: ['ownerName', 'pointsCredited', 'redeemableBalance'],
  },
  PAYOUT_CREDITED: {
    label: 'Payout Credited',
    // whatsapp contract per WHATSAPP_KYC.payoutCreditTemplate:
    // {{1}} owner, {{2}} points, {{3}} UTR, {{4}} date of payment, {{5}} month
    whatsapp: ['ownerName', 'points', 'utr', 'paymentDate', 'month'],
    sms: ['ownerName', 'utr', 'paymentDate'],
  },
  REDEMPTION_CONFIRMED: {
    label: 'Redemption Confirmed',
    whatsapp: ['ownerName', 'rewardName', 'points'],
    sms: ['ownerName', 'rewardName'],
  },
  ORDER_DISPATCHED: {
    label: 'Order Dispatched',
    whatsapp: ['ownerName', 'orderId', 'trackingId'],
    sms: ['ownerName', 'orderId', 'trackingId'],
  },
  ORDER_DELIVERED: {
    label: 'Order Delivered',
    whatsapp: ['ownerName', 'orderId'],
    sms: ['ownerName', 'orderId'],
  },
  ORDER_CANCELLED: {
    label: 'Order Cancelled',
    whatsapp: ['ownerName', 'orderId', 'reason'],
    sms: ['ownerName', 'orderId'],
  },
};

/**
 * The exported per-event contracts, each carrying the derived `freeChannels` flag (the single
 * source of truth is NO_FREE_CHANNEL_EVENTS above, so this never drifts from the real call sites).
 * Same object shape as before plus `freeChannels`; the GET /notification-templates route returns it.
 */
export const VARIABLE_CONTRACTS: Record<EventKey, EventVariableContract> = Object.fromEntries(
  EVENT_KEYS.map((key) => [key, { ...RAW_VARIABLE_CONTRACTS[key], freeChannels: eventWritesFreeChannels(key) }]),
) as Record<EventKey, EventVariableContract>;

/**
 * The default WhatsApp template NAME for a (clientId, eventKey), seeded from WHATSAPP_KYC.
 * A tenant absent from WHATSAPP_KYC — or an event that map has no template for — defaults to
 * '' (nothing configured). Keeps unconfigured tenants byte-identical to today's WhatsApp names.
 */
export function whatsappTemplateDefault(clientId: string, eventKey: EventKey): string {
  const kyc = WHATSAPP_KYC[clientId];
  if (!kyc) return '';
  switch (eventKey) {
    case 'KYC_SUBMITTED':
      return kyc.submissionTemplate ?? '';
    case 'KYC_APPROVED':
      return kyc.approvalTemplate ?? '';
    case 'POINTS_CREDITED':
      return kyc.pointsCreditTemplate ?? '';
    case 'PAYOUT_CREDITED':
      return kyc.payoutCreditTemplate ?? '';
    default:
      return '';
  }
}

/**
 * The four events that send LIVE WhatsApp for a WHATSAPP_KYC tenant (historically the direct
 * WHATSAPP_KYC path — KYC submission + approval, points + payout credit — now routed through
 * NotificationsService.notifyUserWithChannels using this resolver).
 * For a tenant present in WHATSAPP_KYC (currently Deoleo) these MUST keep sending WhatsApp with
 * NO stored config — otherwise routing WhatsApp through this resolver would DARK a live prod
 * channel. So they default to mode WHATSAPP (seeded template) + masterWhatsapp ON for such a
 * tenant. Everything else (other events, SMS, and every non-WHATSAPP_KYC tenant) defaults OFF.
 */
const WHATSAPP_DEFAULT_ON_EVENTS: ReadonlySet<EventKey> = new Set<EventKey>([
  'KYC_SUBMITTED',
  'KYC_APPROVED',
  'POINTS_CREDITED',
  'PAYOUT_CREDITED',
]);

/**
 * The typed DEFAULT config for a tenant. FAIL-SAFE BASELINE = OFF everywhere, WITH ONE
 * DELIBERATE EXCEPTION so this resolver is behaviour-neutral for the currently-live WhatsApp
 * sends: for a tenant present in WHATSAPP_KYC (Deoleo), `masterWhatsapp` defaults ON and the four
 * live events (WHATSAPP_DEFAULT_ON_EVENTS) default to mode WHATSAPP with their seeded template
 * name — reproducing EXACTLY what the direct WHATSAPP_KYC path sends today with no DB row present.
 * SMS defaults OFF for every tenant (it is a brand-new channel). Any other tenant / event stays
 * OFF (a consumer that respects mode never sends until an operator turns a channel on).
 * Never shares nested references (fresh object each call).
 */
export function defaultConfig(clientId: string): NotificationTemplatesConfig {
  const kycConfigured = !!WHATSAPP_KYC[clientId];
  const events = {} as Record<EventKey, EventChannelConfig>;
  for (const key of EVENT_KEYS) {
    const whatsappTemplate = whatsappTemplateDefault(clientId, key);
    // Preserve today's live WhatsApp: a WHATSAPP_KYC tenant's four live events default to WHATSAPP
    // (only when a seeded template actually exists). All other events/tenants default OFF.
    const mode: NotificationMode =
      kycConfigured && WHATSAPP_DEFAULT_ON_EVENTS.has(key) && whatsappTemplate ? 'WHATSAPP' : 'OFF';
    events[key] = {
      mode,
      whatsappTemplate,
      smsTemplateId: '',
    };
  }
  // masterWhatsapp defaults ON for a WHATSAPP_KYC tenant (else the per-event WHATSAPP default is
  // gated off by the master and the live channel would still go dark). SMS master stays OFF.
  return { masterSms: false, masterWhatsapp: kycConfigured, events };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * LENIENT overlay of a stored settingValue onto the typed default → a complete config. NEVER
 * throws (read/resolve path). Rules:
 *   - masters: a stored boolean overrides; anything else keeps the default (false).
 *   - per event: a stored mode overrides only when it is one of the four valid modes;
 *     a stored template string overrides only when it is a NON-EMPTY string (a blank/absent
 *     value keeps the seeded default, mirroring the '' = "use the default template" convention
 *     used by tenant-settings otpTemplates). Over-long strings are ignored (kept default).
 *   - unknown event keys in the stored value are simply ignored (every EVENT_KEY is always
 *     produced from the default set).
 */
export function mergeConfig(clientId: string, stored: unknown): NotificationTemplatesConfig {
  const base = defaultConfig(clientId);
  if (!isObj(stored)) return base;

  if (typeof stored.masterSms === 'boolean') base.masterSms = stored.masterSms;
  if (typeof stored.masterWhatsapp === 'boolean') base.masterWhatsapp = stored.masterWhatsapp;

  const storedEvents = isObj(stored.events) ? stored.events : {};
  for (const key of EVENT_KEYS) {
    const s = storedEvents[key];
    if (!isObj(s)) continue;
    const cur = base.events[key];

    if (typeof s.mode === 'string' && MODE_SET.has(s.mode)) {
      cur.mode = s.mode as NotificationMode;
    }
    if (
      typeof s.whatsappTemplate === 'string' &&
      s.whatsappTemplate.trim() &&
      s.whatsappTemplate.length <= MAX_TEMPLATE_LEN
    ) {
      cur.whatsappTemplate = s.whatsappTemplate.trim();
    }
    if (
      typeof s.smsTemplateId === 'string' &&
      s.smsTemplateId.trim() &&
      s.smsTemplateId.length <= MAX_TEMPLATE_LEN
    ) {
      cur.smsTemplateId = s.smsTemplateId.trim();
    }
  }

  return base;
}

/** The strict-validated, storable shape (only the events the operator actually provided). */
export interface StoredNotificationTemplates {
  masterSms: boolean;
  masterWhatsapp: boolean;
  events: Partial<Record<EventKey, EventChannelConfig>>;
}

/**
 * STRICT validation for a config WRITE. Throws BadRequestException (message names the offending
 * field) on any violation; returns the normalised, storable value on success. Enforces:
 *   - masterSms / masterWhatsapp are booleans;
 *   - `events` (when present) is a plain object whose every key is a known EVENT_KEY
 *     (an UNKNOWN event key is REJECTED);
 *   - each event's mode is one of the four valid modes;
 *   - each event's whatsappTemplate / smsTemplateId (when present) is a string within
 *     MAX_TEMPLATE_LEN.
 *
 * This duplicates (defense-in-depth) what the class-validator DTO + global whitelist pipe already
 * enforce, so the store is protected even if this service is ever driven from a non-HTTP path.
 * Uses a Nest BadRequestException-shaped error via the injected factory to avoid importing
 * @nestjs/common types into a pure config module.
 */
export function validateNotificationTemplatesInput(
  input: unknown,
  fail: (msg: string) => Error,
): StoredNotificationTemplates {
  if (!isObj(input)) throw fail('Body must be an object { masterSms, masterWhatsapp, events }.');

  if (typeof input.masterSms !== 'boolean') throw fail('masterSms must be a boolean.');
  if (typeof input.masterWhatsapp !== 'boolean') throw fail('masterWhatsapp must be a boolean.');

  const out: StoredNotificationTemplates = {
    masterSms: input.masterSms,
    masterWhatsapp: input.masterWhatsapp,
    events: {},
  };

  if (input.events !== undefined && input.events !== null) {
    if (!isObj(input.events)) throw fail('events must be an object keyed by event.');
    for (const [key, raw] of Object.entries(input.events)) {
      if (!EVENT_KEY_SET.has(key)) {
        throw fail(`Unknown event key "${key}". Allowed: ${EVENT_KEYS.join(', ')}.`);
      }
      if (!isObj(raw)) throw fail(`events.${key} must be an object.`);

      const mode = raw.mode;
      if (typeof mode !== 'string' || !MODE_SET.has(mode)) {
        throw fail(
          `events.${key}.mode must be one of ${NOTIFICATION_MODES.join(', ')} (got ${JSON.stringify(mode)}).`,
        );
      }

      const wa = raw.whatsappTemplate;
      if (wa !== undefined && (typeof wa !== 'string' || wa.length > MAX_TEMPLATE_LEN)) {
        throw fail(`events.${key}.whatsappTemplate must be a string up to ${MAX_TEMPLATE_LEN} chars.`);
      }
      const sms = raw.smsTemplateId;
      if (sms !== undefined && (typeof sms !== 'string' || sms.length > MAX_TEMPLATE_LEN)) {
        throw fail(`events.${key}.smsTemplateId must be a string up to ${MAX_TEMPLATE_LEN} chars.`);
      }

      out.events[key as EventKey] = {
        mode: mode as NotificationMode,
        whatsappTemplate: typeof wa === 'string' ? wa.trim() : '',
        smsTemplateId: typeof sms === 'string' ? sms.trim() : '',
      };
    }
  }

  return out;
}
