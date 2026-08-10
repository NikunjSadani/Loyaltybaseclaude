/**
 * Business-hours elapsed-time engine — the shared clock behind every KYC review-SLA
 * number rendered in the admin UI (the KYC list age badge / breach chip).
 *
 * WHY: the KYC SLA counts only WORKING time — Monday–Friday, excluding weekends AND a
 * configurable national-holiday calendar (owner decision 2026-08-10). Naive
 * `(end - start) / 3_600_000` counts calendar hours and false-breaches over a weekend.
 *
 * "Which day" is an INDIAN wall-clock question, so we bucket time by IST calendar day via
 * the fixed +5:30 offset (mirrors api/src/common/ist-date.ts). The clock FREEZES across
 * excluded days: time on a Sat/Sun/holiday contributes zero.
 *
 * This is the byte-for-byte mirror of api/src/common/business-hours.ts (separate build
 * root — the two MUST stay logically identical; their test suites assert the same fixtures).
 */

/** IST is a fixed UTC+5:30 offset (India observes no DST). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

/** Matches a strict `YYYY-MM-DD` calendar date. */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The IST calendar date (`YYYY-MM-DD`) an instant falls on. Shift by the IST offset,
 * then read via getUTC* so the result is the Indian wall-clock date regardless of the
 * browser/server timezone (correct in the 00:00–05:30 IST window).
 */
export function istDateKey(ms: number): string {
  const s = new Date(ms + IST_OFFSET_MS);
  const y = s.getUTCFullYear();
  const m = String(s.getUTCMonth() + 1).padStart(2, '0');
  const d = String(s.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** IST weekday of the instant: 0 = Sunday … 6 = Saturday. */
function istWeekday(ms: number): number {
  return new Date(ms + IST_OFFSET_MS).getUTCDay();
}

/** UTC-milliseconds of IST midnight (00:00 IST) of the IST-day containing `ms`. */
function istStartOfDay(ms: number): number {
  const shifted = ms + IST_OFFSET_MS;
  const midnightShifted = Math.floor(shifted / DAY_MS) * DAY_MS;
  return midnightShifted - IST_OFFSET_MS;
}

/**
 * Is the IST day that STARTS at `dayStartMs` a working day — a Mon–Fri that is not in
 * the holiday set? `dayStartMs` must be an IST-midnight instant (from istStartOfDay).
 */
function isBusinessDay(dayStartMs: number, holidays: Set<string>): boolean {
  const wd = istWeekday(dayStartMs);
  if (wd === 0 || wd === 6) return false; // Sunday / Saturday
  return !holidays.has(istDateKey(dayStartMs));
}

/**
 * Elapsed BUSINESS milliseconds between two instants — summing only the time that falls
 * on IST Mon–Fri days that are not holidays. Weekends and holidays contribute zero.
 * Returns 0 for a non-positive interval.
 */
export function businessMsBetween(
  startMs: number,
  endMs: number,
  holidays: Set<string> = new Set(),
): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  let total = 0;
  let cursor = startMs;
  while (cursor < endMs) {
    const dayStart = istStartOfDay(cursor);
    const nextDay = dayStart + DAY_MS;
    const segEnd = Math.min(endMs, nextDay);
    if (isBusinessDay(dayStart, holidays)) total += segEnd - cursor;
    cursor = segEnd;
  }
  return total;
}

/** Elapsed business HOURS between two instants (business ms ÷ 3.6e6). Unrounded. */
export function businessHoursBetween(
  startMs: number,
  endMs: number,
  holidays: Set<string> = new Set(),
): number {
  return businessMsBetween(startMs, endMs, holidays) / HOUR_MS;
}

/** True iff `s` is a strict `YYYY-MM-DD` that denotes a REAL calendar date (rejects 2026-02-30). */
export function isValidIsoDate(s: string): boolean {
  const m = ISO_DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * Normalise the `nationalHolidays` payload returned by the settings API into a Set of
 * `YYYY-MM-DD` strings for the SLA clock. Accepts `{ date }[]` or bare `string[]`; drops
 * anything that is not a real calendar date. Non-arrays → empty set.
 */
export function parseHolidayDates(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const candidate =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object' && typeof (item as { date?: unknown }).date === 'string'
          ? (item as { date: string }).date
          : null;
    if (candidate && isValidIsoDate(candidate)) out.add(candidate);
  }
  return out;
}
