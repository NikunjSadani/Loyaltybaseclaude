/**
 * Per-tenant payout-tracker email config — ProgramSetting(clientId, PAYOUT_TRACKER_SETTING_KEY).
 *
 *   { enabled: boolean, recipients: string[], cc?: string[], sendTimeIst?: 'HH:mm' (default '10:00'),
 *     days?: number[] (ISO 1=Mon..7=Sun, default [1..6]), sendOnHolidays?: boolean (default true) }
 *
 * INERT by default: no row / `enabled !== true` ⇒ the tenant is never touched (Deoleo has no row).
 * An ENABLED row with a bad value is NOT silently ignored — parse returns an error that the sender records as a
 * FAILED run + ops alert.
 *
 * Environment guard (copied from fundAlertTarget — client-facing email must not leave staging by accident):
 *   PAYOUT_TRACKER_EMAIL_LIVE=true            → the tenant's configured recipients (production only);
 *   else PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT  → ONE internal test address (subject names the real recipients);
 *   else                                      → nothing is sent: ops alerted once a day, the day is NOT consumed.
 */
import { allowedRecipientDomains, splitRecipientsByDomain } from '../../common/report-recipients';

export const PAYOUT_TRACKER_SETTING_KEY = 'payoutTracker';
export const PAYOUT_TRACKER_REPORT_KEY = 'payout-tracker';
/** Run rows for manual send-now (one row per send; runDate = IST timestamp so resends never collide). */
export const PAYOUT_TRACKER_MANUAL_REPORT_KEY = 'payout-tracker-manual';
/** Once-a-day "could not even try" marker (env guard off / client inactive) — dedupes the ops alert WITHOUT claiming
 *  the scheduled day, so the report still goes once the blocker is fixed. */
export const PAYOUT_TRACKER_BLOCKED_REPORT_KEY = 'payout-tracker-blocked';

export interface PayoutTrackerConfig {
  enabled: true;
  recipients: string[];
  cc: string[];
  sendTimeIst: string;
  days: number[];
  sendOnHolidays: boolean;
}

export type ParsedConfig = { kind: 'off' } | { kind: 'on'; config: PayoutTrackerConfig } | { kind: 'invalid'; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DEFAULT_SEND_TIME_IST = '10:00';
export const DEFAULT_DAYS = [1, 2, 3, 4, 5, 6];

function emails(raw: unknown, field: string, errors: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${field} must be a list of email addresses`);
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    const e = typeof item === 'string' ? item.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(e)) errors.push(`${field}: "${String(item)}" is not a valid email address`);
    else if (!out.includes(e)) out.push(e);
  }
  return out;
}

/** Parse a stored settingValue. Never throws. */
export function parsePayoutTrackerConfig(raw: unknown): ParsedConfig {
  if (raw === undefined || raw === null) return { kind: 'off' };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid', error: 'payoutTracker setting is not an object' };
  const o = raw as Record<string, unknown>;
  if (o.enabled !== true) return { kind: 'off' };

  const errors: string[] = [];
  const recipients = emails(o.recipients, 'recipients', errors);
  const cc = emails(o.cc, 'cc', errors).filter((e) => !recipients.includes(e));
  if (recipients.length === 0 && !errors.some((e) => e.startsWith('recipients'))) errors.push('recipients is empty');

  let sendTimeIst = DEFAULT_SEND_TIME_IST;
  if (o.sendTimeIst !== undefined) {
    if (typeof o.sendTimeIst === 'string' && TIME_RE.test(o.sendTimeIst.trim())) sendTimeIst = o.sendTimeIst.trim();
    else errors.push(`sendTimeIst "${String(o.sendTimeIst)}" must be HH:mm (24h, IST)`);
  }

  let days = DEFAULT_DAYS;
  if (o.days !== undefined) {
    if (Array.isArray(o.days) && o.days.length > 0 && o.days.every((d) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7)) {
      days = [...new Set(o.days as number[])].sort((a, b) => a - b);
    } else errors.push('days must be a non-empty list of ISO weekdays 1 (Mon) … 7 (Sun)');
  }

  let sendOnHolidays = true;
  if (o.sendOnHolidays !== undefined) {
    if (typeof o.sendOnHolidays === 'boolean') sendOnHolidays = o.sendOnHolidays;
    else errors.push('sendOnHolidays must be true or false');
  }

  if (errors.length) return { kind: 'invalid', error: `Invalid payoutTracker setting: ${errors.join('; ')}` };
  return { kind: 'on', config: { enabled: true, recipients, cc, sendTimeIst, days, sendOnHolidays } };
}

export type TrackerEmailTarget =
  | { mode: 'live' }
  | { mode: 'test'; to: string }
  | { mode: 'off' }
  | { mode: 'invalid-test'; value: string };

/** Where the scheduled tracker email may go in THIS environment (see the header). */
export function payoutTrackerEmailTarget(env: NodeJS.ProcessEnv = process.env): TrackerEmailTarget {
  if ((env.PAYOUT_TRACKER_EMAIL_LIVE ?? '').trim().toLowerCase() === 'true') return { mode: 'live' };
  const t = (env.PAYOUT_TRACKER_EMAIL_TEST_RECIPIENT ?? '').trim().toLowerCase();
  if (!t) return { mode: 'off' };
  const ok = EMAIL_RE.test(t) && splitRecipientsByDomain([t], allowedRecipientDomains(env.REPORTS_RECIPIENT_DOMAINS)).allowed.length === 1;
  return ok ? { mode: 'test', to: t } : { mode: 'invalid-test', value: t };
}

/** Validate an explicit manual-send recipient list (sendNow). Throws a readable error. */
export function validateRecipientList(list: unknown): string[] {
  const errors: string[] = [];
  const out = emails(list, 'recipients', errors);
  if (errors.length) throw new Error(errors.join('; '));
  if (out.length === 0) throw new Error('recipients is empty');
  return out;
}
