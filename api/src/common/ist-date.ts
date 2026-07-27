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
