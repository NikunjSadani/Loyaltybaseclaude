/**
 * Frontend IST date formatting — the single place the UI turns an instant into a date/time string.
 *
 * WHY: every timestamp the UI shows must render in India Standard Time (Asia/Kolkata) regardless of
 * the viewer's browser timezone or where Next SSR runs (the standalone server runs UTC). The pitfall
 * this replaces: `new Date(iso).toLocaleDateString('en-IN', …)` sets only the LOCALE (DD/MM order, ₹),
 * NOT the timezone — so it silently renders in the runtime zone. That is correct today only because
 * operators are in IST; it breaks for the 3P vendor portal, any user abroad, and SSR. These helpers
 * pin `timeZone: 'Asia/Kolkata'`. Mirrors the backend api/src/common/ist-date.ts intent.
 *
 * All helpers accept a Date or an ISO string (or null/undefined) and return '' for an invalid/absent
 * value, so a missing timestamp renders blank rather than "Invalid Date".
 */
export const IST_TIME_ZONE = 'Asia/Kolkata';

function toDate(date: string | Date | null | undefined): Date | null {
  if (date == null) return null;
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "DD Mon YYYY" (e.g. "01 Jul 2026") in IST. */
export function formatISTDate(date: string | Date | null | undefined): string {
  const d = toDate(date);
  if (!d) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

/** "DD Mon YYYY, hh:mm am/pm" in IST. */
export function formatISTDateTime(date: string | Date | null | undefined): string {
  const d = toDate(date);
  if (!d) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

/** "hh:mm am/pm" in IST (time only). */
export function formatISTTime(date: string | Date | null | undefined): string {
  const d = toDate(date);
  if (!d) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

/** "DD-MM-YYYY" (numeric) in IST — matches the legacy utils.formatDate output exactly. */
export function formatISTDateNumeric(date: string | Date | null | undefined): string {
  const d = toDate(date);
  if (!d) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}-${get('month')}-${get('year')}`;
}

/** The IST calendar day of an instant as a sortable "YYYY-MM-DD" key. */
export function istDateKey(date: string | Date | null | undefined): string {
  const d = toDate(date);
  if (!d) return '';
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** The IST calendar month of an instant as a "YYYY-MM" key (month grouping/labels). */
export function istMonthKey(date: string | Date | null | undefined): string {
  const key = istDateKey(date);
  return key ? key.slice(0, 7) : '';
}
