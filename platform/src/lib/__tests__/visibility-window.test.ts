/// <reference types="vitest/globals" />
/**
 * FE mirror tests for visibility-window.ts — MUST stay in lockstep with the
 * backend api/src/visibility/visibility-window.helper.spec.ts. Covers the D6
 * day-buckets (remainder in the last window), month-length edges (Feb 28/29, 30,
 * 31), the IST boundary case, isWindowClosed, and the windowOptions dropdown
 * shape (matching targets.ts PERIODS { value, label }).
 */

import { describe, it, expect } from 'vitest';
import {
  WINDOW_STARTS,
  daysInMonth,
  windowsForMonth,
  windowBoundsForKey,
  windowKeyForDate,
  currentWindowKey,
  isWindowClosed,
  windowOptions,
} from '../visibility-window';

describe('visibility-window (FE mirror)', () => {
  it('WINDOW_STARTS matches the locked D6 cutoffs', () => {
    expect(WINDOW_STARTS).toEqual({
      1: [1],
      2: [1, 16],
      3: [1, 11, 21],
      4: [1, 9, 16, 24],
    });
  });

  describe('windowsForMonth', () => {
    it('returns n ordered keys per frequency', () => {
      expect(windowsForMonth('2026-07', 1)).toEqual(['2026-07-P1']);
      expect(windowsForMonth('2026-07', 2)).toEqual(['2026-07-P1', '2026-07-P2']);
      expect(windowsForMonth('2026-07', 4)).toEqual([
        '2026-07-P1', '2026-07-P2', '2026-07-P3', '2026-07-P4',
      ]);
    });

    it('throws on invalid month / freq', () => {
      expect(() => windowsForMonth('2026-13', 2)).toThrow(/Invalid month/);
      expect(() => windowsForMonth('2026-07', 5)).toThrow(/Invalid visibility frequency/);
    });
  });

  describe('daysInMonth', () => {
    it('handles 28/29/30/31 incl. leap years', () => {
      expect(daysInMonth(2026, 2)).toBe(28);
      expect(daysInMonth(2024, 2)).toBe(29);
      expect(daysInMonth(2000, 2)).toBe(29);
      expect(daysInMonth(1900, 2)).toBe(28);
      expect(daysInMonth(2026, 4)).toBe(30);
      expect(daysInMonth(2026, 7)).toBe(31);
    });
  });

  describe('windowBoundsForKey', () => {
    it('freq 2/3/4 bounds on a 31-day month', () => {
      expect(windowBoundsForKey('2026-07-P1', 2)).toEqual({ startDay: 1, endDay: 15 });
      expect(windowBoundsForKey('2026-07-P2', 2)).toEqual({ startDay: 16, endDay: 31 });
      expect(windowBoundsForKey('2026-07-P3', 3)).toEqual({ startDay: 21, endDay: 31 });
      expect(windowBoundsForKey('2026-07-P1', 4)).toEqual({ startDay: 1, endDay: 8 });
      expect(windowBoundsForKey('2026-07-P4', 4)).toEqual({ startDay: 24, endDay: 31 });
    });

    it('remainder lands in the LAST window across month lengths', () => {
      expect(windowBoundsForKey('2026-02-P2', 2)).toEqual({ startDay: 16, endDay: 28 });
      expect(windowBoundsForKey('2024-02-P2', 2)).toEqual({ startDay: 16, endDay: 29 });
      expect(windowBoundsForKey('2026-04-P4', 4)).toEqual({ startDay: 24, endDay: 30 });
    });

    it('throws on malformed key / bad freq / out-of-range period', () => {
      expect(() => windowBoundsForKey('2026-07', 2)).toThrow(/Invalid window key/);
      expect(() => windowBoundsForKey('2026-07-P3', 2)).toThrow(/out of range/);
    });
  });

  describe('windowKeyForDate — IST', () => {
    it('the locked boundary case: 20:00Z on the 15th → 2026-07-P2', () => {
      expect(windowKeyForDate(new Date('2026-07-15T20:00:00.000Z'), 2)).toBe('2026-07-P2');
    });

    it('15:30 IST on the 15th stays P1', () => {
      expect(windowKeyForDate(new Date('2026-07-15T10:00:00.000Z'), 2)).toBe('2026-07-P1');
    });

    it('crosses the IST month boundary', () => {
      expect(windowKeyForDate(new Date('2026-07-31T20:30:00.000Z'), 3)).toBe('2026-08-P1');
    });

    it('currentWindowKey delegates', () => {
      const now = new Date('2026-07-15T20:00:00.000Z');
      expect(currentWindowKey(now, 2)).toBe('2026-07-P2');
    });
  });

  describe('isWindowClosed', () => {
    it('false on the endDay, true strictly after (IST)', () => {
      expect(isWindowClosed('2026-07-P1', new Date('2026-07-15T10:00:00.000Z'), 2)).toBe(false);
      expect(isWindowClosed('2026-07-P1', new Date('2026-07-15T20:00:00.000Z'), 2)).toBe(true);
    });

    it('Feb leap last-window boundary', () => {
      expect(isWindowClosed('2024-02-P2', new Date('2024-02-29T06:00:00.000Z'), 2)).toBe(false);
      expect(isWindowClosed('2024-02-P2', new Date('2024-03-01T06:00:00.000Z'), 2)).toBe(true);
    });
  });

  describe('windowOptions — dropdown { value, label }', () => {
    it('builds value=windowKey, label="start–end Mon" (matching PERIODS shape)', () => {
      expect(windowOptions('2026-07', 2)).toEqual([
        { value: '2026-07-P1', label: '1–15 Jul' },
        { value: '2026-07-P2', label: '16–31 Jul' },
      ]);
      expect(windowOptions('2026-02', 4)).toEqual([
        { value: '2026-02-P1', label: '1–8 Feb' },
        { value: '2026-02-P2', label: '9–15 Feb' },
        { value: '2026-02-P3', label: '16–23 Feb' },
        { value: '2026-02-P4', label: '24–28 Feb' },
      ]);
    });

    it('freq 1 → a single whole-month option', () => {
      expect(windowOptions('2026-04', 1)).toEqual([
        { value: '2026-04-P1', label: '1–30 Apr' },
      ]);
    });
  });
});
