/**
 * IST-aware date formatting for the money-notification (WhatsApp) bodies.
 *
 * WHY: production runs UTC (there is no TZ set in api/Dockerfile), but the money
 * notices ("points credited on DD Mon YYYY", "for Month YYYY") must render the
 * INDIAN wall-clock date the partner experiences. Reading `.getDate()/.getMonth()`
 * off a Date reads SERVER-LOCAL time → in the 00:00–05:30 IST window the day is
 * off by one, and at a month boundary the MONTH is wrong. These helpers shift the
 * instant by the fixed IST offset and then read via `getUTC*` — mirroring
 * ActivityTrackingService.istDateKey — so the result is the IST wall-clock value
 * regardless of the server's timezone.
 *
 * A `YYYY-MM` period LABEL (e.g. "2026-07") is already timezone-independent, so
 * the string branch of monthYearIST does NOT shift — it formats the label as-is.
 */

/** IST is a fixed UTC+5:30 offset (India observes no DST). */
export const IST_OFFSET_MIN = 5 * 60 + 30;

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format a `YYYY-MM` period (or a Date) as "Month YYYY" (e.g. "July 2026") for the
 * WhatsApp money-notification bodies.
 *   - string: a `YYYY-MM` label is already TZ-independent → NOT shifted; formatted as-is.
 *     A malformed period falls back to the raw string.
 *   - Date: shifted by the IST offset, then read via getUTCMonth/getUTCFullYear so the
 *     month is the IST wall-clock month (correct at a UTC month boundary).
 */
export function monthYearIST(periodOrDate: string | Date): string {
  if (periodOrDate instanceof Date) {
    const shifted = new Date(periodOrDate.getTime() + IST_OFFSET_MIN * 60_000);
    return `${MONTHS_LONG[shifted.getUTCMonth()]} ${shifted.getUTCFullYear()}`;
  }
  const m = /^(\d{4})-(\d{2})$/.exec(periodOrDate);
  if (!m) return periodOrDate;
  const monthIdx = Number(m[2]) - 1;
  return monthIdx >= 0 && monthIdx < 12 ? `${MONTHS_LONG[monthIdx]} ${m[1]}` : periodOrDate;
}

/**
 * Format a date as "DD Mon YYYY" (e.g. "06 Jul 2026") for the WhatsApp money-notification
 * bodies. The instant is shifted by the IST offset then read via getUTC* so the day and
 * month are the IST wall-clock values (correct in the 00:00–05:30 IST window).
 */
export function formatDateIST(d: Date): string {
  const shifted = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${day} ${MONTHS_SHORT[shifted.getUTCMonth()]} ${shifted.getUTCFullYear()}`;
}

/**
 * The UTC instant of 00:00:00.000 of the IST calendar day that `d` falls on.
 *
 * WHY: a date-only `<input type="date">` value (e.g. "2026-08-31") is stored as
 * `new Date("2026-08-31")` = 2026-08-31T00:00:00.000Z = 05:30 IST — NOT the start
 * of the IST day. Comparing `now` against that raw instant skews the window by the
 * fixed +5:30 offset. To recover the true IST-day start we read the IST wall-clock
 * Y-M-D (shift then read getUTC*, mirroring formatDateIST) and rebuild that day's
 * 00:00 IST as a UTC instant. Robust whether the stored value is 00:00 UTC or any
 * other time on that IST day.
 */
export function startOfIstDay(d: Date): Date {
  const shifted = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  return new Date(Date.UTC(y, m, day, 0, 0, 0, 0) - IST_OFFSET_MIN * 60_000);
}

/**
 * The UTC instant of 23:59:59.999 of the IST calendar day that `d` falls on — the
 * INCLUSIVE end of that IST day (see startOfIstDay for the why).
 */
export function endOfIstDay(d: Date): Date {
  const shifted = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  return new Date(Date.UTC(y, m, day, 23, 59, 59, 999) - IST_OFFSET_MIN * 60_000);
}

/**
 * Build a Prisma `{ gte?, lte? }` date-range filter from operator-supplied `from`/`to` bounds,
 * interpreting a DATE-ONLY value (`YYYY-MM-DD`, from a `<input type="date">`) as a FULL INCLUSIVE
 * IST day: `from` → 00:00:00.000 IST of that day, `to` → 23:59:59.999 IST of that day.
 *
 * WHY: a raw `new Date("2026-08-31")` is 05:30 IST, so a naive `{ gte: from, lte: to }` skips the
 * first 5.5h of the start day AND truncates almost the whole end day (closes ~05:30 IST). This is
 * the single fix for every list/report date-range filter (schemes roster, gift orders, gift
 * disbursal, reports, payouts, …). A FULL ISO datetime (contains a `T`) is used as-given (an
 * explicit instant the caller already chose), so this is safe to apply uniformly.
 *
 * Returns `undefined` when neither bound is a valid date, so callers can `if (range) where.x = range`.
 */
export function istDayRangeFilter(
  from?: string | null,
  to?: string | null,
): { gte?: Date; lte?: Date } | undefined {
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  const range: { gte?: Date; lte?: Date } = {};
  if (from) {
    const d = new Date(from);
    if (!Number.isNaN(d.getTime())) range.gte = DATE_ONLY.test(from) ? startOfIstDay(d) : d;
  }
  if (to) {
    const d = new Date(to);
    if (!Number.isNaN(d.getTime())) range.lte = DATE_ONLY.test(to) ? endOfIstDay(d) : d;
  }
  return range.gte !== undefined || range.lte !== undefined ? range : undefined;
}

/**
 * The IST calendar month of an instant, as a `YYYY-MM` key. Shift-then-read-UTC, so an instant
 * in the 00:00–05:30 IST window of the 1st resolves to the correct IST month (not the UTC month,
 * which would be the previous one). Use everywhere a month bucket/key/lock is derived from a Date
 * — replaces the `new Date(y, m, 1)` / `getFullYear()/getMonth()` idiom that reads UTC in prod.
 */
export function istMonthKey(d: Date): string {
  const shifted = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The IST calendar day of an instant, as a `YYYY-MM-DD` key (sortable). Shift-then-read-UTC so it
 * is the IST wall-clock day (correct in the 00:00–05:30 IST window). This is the IST-correct
 * replacement for `d.toISOString().slice(0,10)` / `.split('T')[0]` in export/report DATE cells.
 * (The ad-hoc `istDateKey` copies in activity-tracking / business-hours are equivalent and could
 * later be consolidated onto this one — left in place for now to keep this change scoped.)
 */
export function istDateKey(d: Date): string {
  const shifted = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${m}-${day}`;
}

/**
 * An instant as an IST `YYYY-MM-DD HH:mm` string (24h, sortable). The IST-correct replacement for a
 * bare `d.toISOString()` in export/report DATETIME cells (which prints UTC with a `Z`, 5.5h off).
 */
export function istDateTimeCell(d: Date): string {
  const shifted = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${m}-${day} ${hh}:${mm}`;
}

/**
 * The UTC instants bounding an IST calendar month, from a `YYYY-MM` key: `start` = 00:00 IST of the
 * 1st, `endExclusive` = 00:00 IST of the 1st of the NEXT month. Use for monthly aggregation windows
 * (`{ gte: start, lt: endExclusive }`) instead of the local-time `new Date(y, m, 1)` constructor,
 * which yields UTC month boundaries (05:30 IST) on a UTC server. Throws on a malformed key.
 */
export function istMonthBounds(monthKey: string): { start: Date; endExclusive: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) throw new Error(`istMonthBounds: invalid monthKey "${monthKey}"`);
  const y = Number(m[1]);
  const moIdx = Number(m[2]) - 1; // 0-based month
  if (moIdx < 0 || moIdx > 11) throw new Error(`istMonthBounds: invalid month in "${monthKey}"`);
  const start = new Date(Date.UTC(y, moIdx, 1, 0, 0, 0, 0) - IST_OFFSET_MIN * 60_000);
  const endExclusive = new Date(Date.UTC(y, moIdx + 1, 1, 0, 0, 0, 0) - IST_OFFSET_MIN * 60_000);
  return { start, endExclusive };
}
