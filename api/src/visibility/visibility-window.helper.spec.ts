// Unit tests for the IST-safe frequency-window helper (Visibility / POSM).
// Key invariants: fixed D6 day-buckets with the remainder in the LAST window;
// month-length edges (Feb 28/29, 30, 31); and — critically — the window key is
// the INDIAN wall-clock window, so a UTC instant in the 00:00–05:30 IST window
// still lands in the correct IST day's bucket.
// Run: npx jest src/visibility/visibility-window.helper.spec.ts

import {
  WINDOW_STARTS,
  daysInMonth,
  windowsForMonth,
  windowBoundsForKey,
  windowKeyForDate,
  currentWindowKey,
  isWindowClosed,
} from './visibility-window.helper';

describe('visibility-window.helper', () => {
  describe('WINDOW_STARTS (D6 cutoffs)', () => {
    it('matches the locked frequency → start-day map', () => {
      expect(WINDOW_STARTS).toEqual({
        1: [1],
        2: [1, 16],
        3: [1, 11, 21],
        4: [1, 9, 16, 24],
      });
    });
  });

  describe('windowsForMonth', () => {
    it('returns n keys in order for each frequency', () => {
      expect(windowsForMonth('2026-07', 1)).toEqual(['2026-07-P1']);
      expect(windowsForMonth('2026-07', 2)).toEqual(['2026-07-P1', '2026-07-P2']);
      expect(windowsForMonth('2026-07', 3)).toEqual([
        '2026-07-P1', '2026-07-P2', '2026-07-P3',
      ]);
      expect(windowsForMonth('2026-07', 4)).toEqual([
        '2026-07-P1', '2026-07-P2', '2026-07-P3', '2026-07-P4',
      ]);
    });

    it('throws on a malformed month', () => {
      expect(() => windowsForMonth('2026-7', 2)).toThrow(/Invalid month/);
      expect(() => windowsForMonth('2026-13', 2)).toThrow(/Invalid month/);
      expect(() => windowsForMonth('bad', 2)).toThrow(/Invalid month/);
    });

    it('throws on an out-of-range frequency', () => {
      expect(() => windowsForMonth('2026-07', 0)).toThrow(/Invalid visibility frequency/);
      expect(() => windowsForMonth('2026-07', 5)).toThrow(/Invalid visibility frequency/);
      expect(() => windowsForMonth('2026-07', 2.5)).toThrow(/Invalid visibility frequency/);
    });
  });

  describe('daysInMonth', () => {
    it('handles 28/29/30/31 incl. Feb leap years', () => {
      expect(daysInMonth(2026, 2)).toBe(28); // non-leap
      expect(daysInMonth(2024, 2)).toBe(29); // leap (div by 4)
      expect(daysInMonth(2000, 2)).toBe(29); // leap (div by 400)
      expect(daysInMonth(1900, 2)).toBe(28); // NOT leap (div by 100, not 400)
      expect(daysInMonth(2026, 4)).toBe(30);
      expect(daysInMonth(2026, 7)).toBe(31);
    });
  });

  describe('windowBoundsForKey — bounds per frequency', () => {
    it('freq 1 → single window covers the whole (31-day) month', () => {
      expect(windowBoundsForKey('2026-07-P1', 1)).toEqual({ startDay: 1, endDay: 31 });
    });

    it('freq 2 → [1–15][16–end]', () => {
      expect(windowBoundsForKey('2026-07-P1', 2)).toEqual({ startDay: 1, endDay: 15 });
      expect(windowBoundsForKey('2026-07-P2', 2)).toEqual({ startDay: 16, endDay: 31 });
    });

    it('freq 3 → [1–10][11–20][21–end]', () => {
      expect(windowBoundsForKey('2026-07-P1', 3)).toEqual({ startDay: 1, endDay: 10 });
      expect(windowBoundsForKey('2026-07-P2', 3)).toEqual({ startDay: 11, endDay: 20 });
      expect(windowBoundsForKey('2026-07-P3', 3)).toEqual({ startDay: 21, endDay: 31 });
    });

    it('freq 4 → [1–8][9–15][16–23][24–end]', () => {
      expect(windowBoundsForKey('2026-07-P1', 4)).toEqual({ startDay: 1, endDay: 8 });
      expect(windowBoundsForKey('2026-07-P2', 4)).toEqual({ startDay: 9, endDay: 15 });
      expect(windowBoundsForKey('2026-07-P3', 4)).toEqual({ startDay: 16, endDay: 23 });
      expect(windowBoundsForKey('2026-07-P4', 4)).toEqual({ startDay: 24, endDay: 31 });
    });

    it('remainder always lands in the LAST window (month-length edges)', () => {
      // Feb non-leap (28)
      expect(windowBoundsForKey('2026-02-P2', 2)).toEqual({ startDay: 16, endDay: 28 });
      expect(windowBoundsForKey('2026-02-P4', 4)).toEqual({ startDay: 24, endDay: 28 });
      // Feb leap (29)
      expect(windowBoundsForKey('2024-02-P2', 2)).toEqual({ startDay: 16, endDay: 29 });
      expect(windowBoundsForKey('2024-02-P3', 3)).toEqual({ startDay: 21, endDay: 29 });
      // 30-day month (April)
      expect(windowBoundsForKey('2026-04-P2', 2)).toEqual({ startDay: 16, endDay: 30 });
      expect(windowBoundsForKey('2026-04-P4', 4)).toEqual({ startDay: 24, endDay: 30 });
      // 31-day month (July)
      expect(windowBoundsForKey('2026-07-P4', 4)).toEqual({ startDay: 24, endDay: 31 });
    });

    it('throws on a malformed key, bad freq, or out-of-range period', () => {
      expect(() => windowBoundsForKey('2026-07', 2)).toThrow(/Invalid window key/);
      expect(() => windowBoundsForKey('2026-07-P1', 5)).toThrow(/Invalid visibility frequency/);
      // P3 does not exist at freq 2
      expect(() => windowBoundsForKey('2026-07-P3', 2)).toThrow(/out of range/);
    });
  });

  describe('windowKeyForDate — IST boundary correctness', () => {
    it('the locked IST-boundary case: 20:00Z on the 15th → next IST day → P2', () => {
      // 2026-07-15T20:00:00Z = 2026-07-16 01:30 IST → day 16 → P2 (freq 2).
      expect(windowKeyForDate(new Date('2026-07-15T20:00:00.000Z'), 2)).toBe('2026-07-P2');
    });

    it('same calendar date earlier in UTC stays in P1', () => {
      // 2026-07-15T10:00:00Z = 2026-07-15 15:30 IST → day 15 → P1 (freq 2).
      expect(windowKeyForDate(new Date('2026-07-15T10:00:00.000Z'), 2)).toBe('2026-07-P1');
    });

    it('crosses the IST month boundary (late-UTC last day → next month P1)', () => {
      // 2026-07-31T20:30:00Z = 2026-08-01 02:00 IST → Aug day 1 → P1.
      expect(windowKeyForDate(new Date('2026-07-31T20:30:00.000Z'), 3)).toBe('2026-08-P1');
    });

    it('buckets a mid-month day correctly at each frequency', () => {
      // 2026-07-11T06:00:00Z = 11:30 IST → day 11.
      const d = new Date('2026-07-11T06:00:00.000Z');
      expect(windowKeyForDate(d, 1)).toBe('2026-07-P1');
      expect(windowKeyForDate(d, 2)).toBe('2026-07-P1'); // 11 ∈ [1,15]
      expect(windowKeyForDate(d, 3)).toBe('2026-07-P2'); // 11 ∈ [11,20]
      expect(windowKeyForDate(d, 4)).toBe('2026-07-P2'); // 11 ∈ [9,15]
    });

    it('day 1 always maps to P1; a late day maps to the last window', () => {
      // 2026-07-24 09:00 IST → day 24.
      expect(windowKeyForDate(new Date('2026-07-24T03:30:00.000Z'), 4)).toBe('2026-07-P4');
      // 2026-07-01 09:00 IST → day 1.
      expect(windowKeyForDate(new Date('2026-07-01T03:30:00.000Z'), 4)).toBe('2026-07-P1');
    });

    it('throws on a bad frequency', () => {
      expect(() => windowKeyForDate(new Date('2026-07-01T00:00:00.000Z'), 0)).toThrow(
        /Invalid visibility frequency/,
      );
    });

    it('currentWindowKey delegates to windowKeyForDate', () => {
      const now = new Date('2026-07-15T20:00:00.000Z');
      expect(currentWindowKey(now, 2)).toBe(windowKeyForDate(now, 2));
    });
  });

  describe('isWindowClosed', () => {
    it('false while today is still inside the window', () => {
      // Window P1 (freq 2) = [1–15]. Now = 2026-07-10 (IST). endDay 15 not < 10.
      const now = new Date('2026-07-10T06:00:00.000Z'); // 11:30 IST → day 10
      expect(isWindowClosed('2026-07-P1', now, 2)).toBe(false);
    });

    it('false on the last day of the window (not yet strictly past)', () => {
      // endDay 15, today IST = 15 → 15 < 15 is false.
      const now = new Date('2026-07-15T10:00:00.000Z'); // 15:30 IST → day 15
      expect(isWindowClosed('2026-07-P1', now, 2)).toBe(false);
    });

    it('true once today is strictly past the window endDay', () => {
      // endDay 15, today IST = 16 → closed.
      const now = new Date('2026-07-15T20:00:00.000Z'); // 01:30 IST next day → day 16
      expect(isWindowClosed('2026-07-P1', now, 2)).toBe(true);
    });

    it('true for a window in an earlier month', () => {
      const now = new Date('2026-07-05T06:00:00.000Z');
      expect(isWindowClosed('2026-06-P2', now, 2)).toBe(true);
    });

    it('false for a window in a later month', () => {
      const now = new Date('2026-07-05T06:00:00.000Z');
      expect(isWindowClosed('2026-08-P1', now, 2)).toBe(false);
    });

    it('respects Feb month-length at the last window boundary', () => {
      // 2024-02-P2 (freq 2) endDay = 29 (leap). Today = 2024-02-29 → not closed;
      // 2024-03-01 → closed.
      expect(
        isWindowClosed('2024-02-P2', new Date('2024-02-29T06:00:00.000Z'), 2),
      ).toBe(false);
      expect(
        isWindowClosed('2024-02-P2', new Date('2024-03-01T06:00:00.000Z'), 2),
      ).toBe(true);
    });

    it('throws on a malformed key', () => {
      expect(() => isWindowClosed('2026-07', new Date(), 2)).toThrow(/Invalid window key/);
    });
  });
});
