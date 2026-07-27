/**
 * visibility-window.ts — FE mirror of the backend
 * api/src/visibility/visibility-window.helper.ts. Pure frequency-window helpers
 * for the Visibility (POSM) feature (VISIBILITY-POSM-DESIGN.md §1 D6 + §3).
 *
 * Self-contained (no cross-package import): the IST offset is inlined as a
 * constant here (the api helper reuses ist-date.ts's IST_OFFSET_MIN). Both sides
 * MUST stay in lockstep — the FE previews the same window key the backend
 * computes at capture time.
 *
 * A tenant configures a per-month capture frequency (1–4×). Each month is split
 * into `freq` day-of-month windows by fixed start-day cutoffs (equal-ish buckets,
 * remainder always in the LAST window). A window is keyed `YYYY-MM-Pn`.
 *
 *   1× → [1–end]
 *   2× → [1–15][16–end]
 *   3× → [1–10][11–20][21–end]
 *   4× → [1–8][9–15][16–23][24–end]
 */

/** IST is a fixed UTC+5:30 offset (India observes no DST). */
const IST_OFFSET_MIN = 330;

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Fixed day-of-month start cutoffs per frequency (D6). windowKey `Pn` covers
 * `[WINDOW_STARTS[freq][n-1], nextStart-1]`; the last window runs to month-end.
 */
export const WINDOW_STARTS: Record<1 | 2 | 3 | 4, number[]> = {
  1: [1],
  2: [1, 16],
  3: [1, 11, 21],
  4: [1, 9, 16, 24],
};

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const WINDOW_KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])-P([1-9]\d*)$/;

function assertFreq(freq: number): 1 | 2 | 3 | 4 {
  if (freq !== 1 && freq !== 2 && freq !== 3 && freq !== 4) {
    throw new Error(`Invalid visibility frequency "${freq}" — must be 1, 2, 3 or 4`);
  }
  return freq;
}

function parseMonth(month: string): { year: number; monthNum: number } {
  const m = MONTH_RE.exec(month);
  if (!m) {
    throw new Error(`Invalid month "${month}" — expected YYYY-MM`);
  }
  return { year: Number(m[1]), monthNum: Number(m[2]) };
}

/**
 * Actual number of days in a given year+month (1-based month). Handles 28/29/30/31,
 * incl. Feb leap years. UTC arithmetic (day 0 of next month = last day of this).
 */
export function daysInMonth(year: number, monthNum: number): number {
  return new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
}

/**
 * All window keys for a month at a given frequency, in order:
 *   ['YYYY-MM-P1', …, 'YYYY-MM-Pn'] (n = freq). Throws on invalid month/freq.
 */
export function windowsForMonth(month: string, freq: number): string[] {
  parseMonth(month);
  const f = assertFreq(freq);
  return WINDOW_STARTS[f].map((_, i) => `${month}-P${i + 1}`);
}

/**
 * The inclusive day-of-month bounds { startDay, endDay } for a window key at a
 * given frequency. Last window's endDay = actual days-in-month; a non-last
 * window's endDay = next window's start − 1. Throws on invalid key/freq/range.
 */
export function windowBoundsForKey(
  windowKey: string,
  freq: number,
): { startDay: number; endDay: number } {
  const m = WINDOW_KEY_RE.exec(windowKey);
  if (!m) {
    throw new Error(`Invalid window key "${windowKey}" — expected YYYY-MM-Pn`);
  }
  const f = assertFreq(freq);
  const year = Number(m[1]);
  const monthNum = Number(m[2]);
  const periodIdx = Number(m[3]);
  const starts = WINDOW_STARTS[f];
  if (periodIdx < 1 || periodIdx > starts.length) {
    throw new Error(
      `Window "${windowKey}" period P${periodIdx} out of range for frequency ${f} (1..${starts.length})`,
    );
  }
  const startDay = starts[periodIdx - 1];
  const isLast = periodIdx === starts.length;
  const endDay = isLast ? daysInMonth(year, monthNum) : starts[periodIdx] - 1;
  return { startDay, endDay };
}

function istParts(dateUtc: Date): { year: number; monthNum: number; day: number } {
  const shifted = new Date(dateUtc.getTime() + IST_OFFSET_MIN * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    monthNum: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * The window key ('YYYY-MM-Pn') that contains a UTC instant, in IST.
 * Throws on a frequency outside 1..4.
 */
export function windowKeyForDate(dateUtc: Date, freq: number): string {
  const f = assertFreq(freq);
  const { year, monthNum, day } = istParts(dateUtc);
  const starts = WINDOW_STARTS[f];
  let periodIdx = 1;
  for (let i = 0; i < starts.length; i++) {
    if (day >= starts[i]) periodIdx = i + 1;
  }
  const mm = String(monthNum).padStart(2, '0');
  return `${year}-${mm}-P${periodIdx}`;
}

/** The current window key for a clock instant. Pass the clock in (no Date.now()). */
export function currentWindowKey(nowUtc: Date, freq: number): string {
  return windowKeyForDate(nowUtc, freq);
}

function compareYmd(
  a: { year: number; monthNum: number; day: number },
  b: { year: number; monthNum: number; day: number },
): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.monthNum !== b.monthNum) return a.monthNum - b.monthNum;
  return a.day - b.day;
}

/**
 * True iff the window has FULLY elapsed — its endDay (in that window's own month)
 * is strictly before today's IST calendar date. Throws on invalid key/freq.
 */
export function isWindowClosed(windowKey: string, nowUtc: Date, freq: number): boolean {
  const m = WINDOW_KEY_RE.exec(windowKey);
  if (!m) {
    throw new Error(`Invalid window key "${windowKey}" — expected YYYY-MM-Pn`);
  }
  const year = Number(m[1]);
  const monthNum = Number(m[2]);
  const { endDay } = windowBoundsForKey(windowKey, freq);
  const today = istParts(nowUtc);
  return compareYmd({ year, monthNum, day: endDay }, today) < 0;
}

/**
 * Period-dropdown options for a month at a given frequency, matching the
 * { value, label } shape used by targets.ts PERIODS. `value` is the window key
 * ('YYYY-MM-Pn'); `label` is a human range like "1–15 Jul".
 */
export function windowOptions(
  month: string,
  freq: number,
): { value: string; label: string }[] {
  const { monthNum } = parseMonth(month);
  const abbr = MONTH_ABBR[monthNum - 1];
  return windowsForMonth(month, freq).map((value) => {
    const { startDay, endDay } = windowBoundsForKey(value, freq);
    return { value, label: `${startDay}–${endDay} ${abbr}` };
  });
}
