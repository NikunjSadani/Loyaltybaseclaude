/**
 * visibility-window.helper.ts — pure, unit-testable frequency-window helpers for
 * the Visibility (POSM) feature. NO Nest/Prisma imports so it can be tested
 * directly without bootstrapping the DI container (mirrors targets.helpers.ts).
 *
 * Design: VISIBILITY-POSM-DESIGN.md §1 (D6) + §3.
 *
 * A tenant configures a per-month capture frequency (1–4×). Each month is split
 * into `freq` day-of-month "windows" by fixed start-day cutoffs (equal-ish day
 * buckets, remainder always in the LAST window). A window is keyed `YYYY-MM-Pn`.
 *
 *   1× → [1–end]
 *   2× → [1–15][16–end]
 *   3× → [1–10][11–20][21–end]
 *   4× → [1–8][9–15][16–23][24–end]
 *
 * WHY IST-shift: production runs UTC (no TZ set in api/Dockerfile). The window
 * key must reflect the INDIAN wall-clock date the rep experiences at capture
 * time — otherwise a capture between 00:00–05:30 IST reads the wrong day (and at
 * a month boundary the wrong month), landing in the wrong window. We shift the
 * instant by the fixed IST offset then read via getUTC* (the shift-then-read-UTC
 * pattern, mirroring istDateKey / ist-date.ts).
 *
 * The offset itself is REUSED from ist-date.ts — never reimplemented here.
 */

import { IST_OFFSET_MIN } from '../common/ist-date';

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

/** Narrow an arbitrary number to a valid frequency (1..4), throwing otherwise. */
function assertFreq(freq: number): 1 | 2 | 3 | 4 {
  if (freq !== 1 && freq !== 2 && freq !== 3 && freq !== 4) {
    throw new Error(`Invalid visibility frequency "${freq}" — must be 1, 2, 3 or 4`);
  }
  return freq;
}

/** Assert a `YYYY-MM` month string (real month 01..12), returning [year, month]. */
function parseMonth(month: string): { year: number; monthNum: number } {
  const m = MONTH_RE.exec(month);
  if (!m) {
    throw new Error(`Invalid month "${month}" — expected YYYY-MM`);
  }
  return { year: Number(m[1]), monthNum: Number(m[2]) };
}

/**
 * Actual number of days in a given year+month (1-based month). Handles 28/29/30/31,
 * incl. Feb leap years. Uses UTC Date arithmetic (day 0 of the NEXT month = last
 * day of this month) so it is timezone-independent.
 */
export function daysInMonth(year: number, monthNum: number): number {
  // Date.UTC(year, monthNum /* 0-based next month */, 0) → last day of monthNum.
  return new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
}

/**
 * All window keys for a month at a given frequency, in order:
 *   ['YYYY-MM-P1', …, 'YYYY-MM-Pn'] (n = freq).
 * Throws on a malformed month or a frequency outside 1..4.
 */
export function windowsForMonth(month: string, freq: number): string[] {
  parseMonth(month); // validate shape
  const f = assertFreq(freq);
  return WINDOW_STARTS[f].map((_, i) => `${month}-P${i + 1}`);
}

/**
 * The inclusive day-of-month bounds for a window key at a given frequency:
 *   { startDay, endDay }.
 * The LAST window's endDay is the actual days-in-that-month (28/29/30/31); a
 * non-last window's endDay is the next window's start − 1.
 * Throws on a malformed key, a frequency outside 1..4, or a period index that is
 * out of range for that frequency.
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
  const periodIdx = Number(m[3]); // 1-based
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

/**
 * Shift a UTC instant to IST wall-clock and return its { year, monthNum (1-based),
 * day }. Shift-then-read-UTC (never server-local Date, which is UTC in prod).
 */
function istParts(dateUtc: Date): { year: number; monthNum: number; day: number } {
  const shifted = new Date(dateUtc.getTime() + IST_OFFSET_MIN * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    monthNum: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * The window key ('YYYY-MM-Pn') that contains a UTC instant, in IST. The IST
 * year-month + IST day-of-month pick the bucket whose [startDay, endDay] range
 * contains that day. Computed once at write time.
 * Throws on a frequency outside 1..4.
 */
export function windowKeyForDate(dateUtc: Date, freq: number): string {
  const f = assertFreq(freq);
  const { year, monthNum, day } = istParts(dateUtc);
  const starts = WINDOW_STARTS[f];
  // Find the last bucket whose start day is <= today's day-of-month. Since starts
  // is ascending and starts[0] === 1, day (1..31) always matches at least P1.
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

/**
 * True iff the window has FULLY elapsed — its endDay (in that window's own month)
 * is strictly before today's IST calendar date. Compared by IST calendar date
 * (year, month, day) so a UTC server still uses the Indian wall-clock day.
 * Throws on a malformed key or a frequency outside 1..4.
 */
export function isWindowClosed(windowKey: string, nowUtc: Date, freq: number): boolean {
  const m = WINDOW_KEY_RE.exec(windowKey);
  if (!m) {
    throw new Error(`Invalid window key "${windowKey}" — expected YYYY-MM-Pn`);
  }
  const year = Number(m[1]);
  const monthNum = Number(m[2]);
  const { endDay } = windowBoundsForKey(windowKey, freq);
  // The last instant of the window in IST = year-monthNum-endDay. Compare that
  // calendar date against today's IST calendar date; closed iff strictly before.
  const today = istParts(nowUtc);
  const windowEnd = { year, monthNum, day: endDay };
  return compareYmd(windowEnd, today) < 0;
}

/** Compare two {year, monthNum, day} calendar dates: <0, 0, or >0. */
function compareYmd(
  a: { year: number; monthNum: number; day: number },
  b: { year: number; monthNum: number; day: number },
): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.monthNum !== b.monthNum) return a.monthNum - b.monthNum;
  return a.day - b.day;
}
