// Unit tests for the IST-aware date formatters used by the money-notification
// (WhatsApp) bodies. The key invariant: on a UTC server these render the INDIAN
// wall-clock date, so a UTC instant in the 00:00–05:30 IST window (or on a UTC
// month boundary) still produces the correct IST day/month.
// Run: npx jest src/common/ist-date.spec.ts

import {
  monthYearIST,
  formatDateIST,
  startOfIstDay,
  endOfIstDay,
  istDayRangeFilter,
  istMonthKey,
  istDateKey,
  istDateTimeCell,
  istMonthBounds,
} from './ist-date';

describe('ist-date', () => {
  describe('monthYearIST', () => {
    it('formats a YYYY-MM string label as "Month YYYY" without shifting (label is TZ-independent)', () => {
      expect(monthYearIST('2026-07')).toBe('July 2026');
    });

    it('falls back to the raw string when the period is malformed', () => {
      expect(monthYearIST('bad')).toBe('bad');
    });

    it('shifts a Date by IST → correct month at a UTC month boundary', () => {
      // 2026-07-31T20:30:00Z = 2026-08-01T02:00 IST → the IST month is August.
      expect(monthYearIST(new Date('2026-07-31T20:30:00.000Z'))).toBe('August 2026');
    });
  });

  describe('formatDateIST', () => {
    it('shifts a Date by IST → correct day at a UTC month boundary', () => {
      // 2026-07-31T20:30:00Z = 2026-08-01T02:00 IST → 01 Aug 2026.
      expect(formatDateIST(new Date('2026-07-31T20:30:00.000Z'))).toBe('01 Aug 2026');
    });

    it('shifts a Date by IST → correct day in the 00:00–05:30 IST window', () => {
      // 2026-07-06T23:00:00Z = 2026-07-07T04:30 IST → 07 Jul 2026 (next day in IST).
      expect(formatDateIST(new Date('2026-07-06T23:00:00.000Z'))).toBe('07 Jul 2026');
    });

    it('zero-pads the day to 2 digits', () => {
      // 2026-07-06T04:00:00Z = 2026-07-06T09:30 IST → 06 Jul 2026.
      expect(formatDateIST(new Date('2026-07-06T04:00:00.000Z'))).toBe('06 Jul 2026');
    });
  });

  // IST-day bounds for the scheme enrollment-window fix. A date-only value stored as
  // 00:00 UTC (= 05:30 IST) must be normalised to the full IST calendar day it names.
  describe('startOfIstDay', () => {
    it('maps a date-only 00:00 UTC value to 00:00 IST of the SAME calendar day (18:30Z prev day)', () => {
      // stored "2026-08-01" → 2026-08-01T00:00Z (05:30 IST on Aug 1) → IST-day start is
      // 2026-08-01 00:00 IST = 2026-07-31T18:30:00Z.
      expect(startOfIstDay(new Date('2026-08-01T00:00:00.000Z')).toISOString()).toBe('2026-07-31T18:30:00.000Z');
    });

    it('is stable for any instant on that IST day (mid-day UTC → same IST-day start)', () => {
      // 2026-08-01T10:00Z = 2026-08-01T15:30 IST → still IST Aug 1.
      expect(startOfIstDay(new Date('2026-08-01T10:00:00.000Z')).toISOString()).toBe('2026-07-31T18:30:00.000Z');
    });
  });

  describe('endOfIstDay', () => {
    it('maps a date-only 00:00 UTC value to 23:59:59.999 IST of the SAME calendar day', () => {
      // stored "2026-08-31" → 2026-08-31T00:00Z → IST-day end is 2026-08-31 23:59:59.999 IST
      // = 2026-08-31T18:29:59.999Z.
      expect(endOfIstDay(new Date('2026-08-31T00:00:00.000Z')).toISOString()).toBe('2026-08-31T18:29:59.999Z');
    });

    it('an instant just before IST midnight still belongs to that IST day', () => {
      // 2026-08-31T18:00:00Z = 2026-08-31T23:30 IST → IST Aug 31.
      expect(endOfIstDay(new Date('2026-08-31T18:00:00.000Z')).toISOString()).toBe('2026-08-31T18:29:59.999Z');
    });
  });

  // The shared Prisma-filter builder used by every list/report date-range filter
  // (reports, schemes roster, gift orders, payouts, …). A date-only bound becomes a
  // FULL INCLUSIVE IST day; a full ISO datetime is used as-is; empty → undefined.
  describe('istDayRangeFilter', () => {
    it('expands a date-only `from` to 00:00 IST of that day (gte = 18:30Z prev day)', () => {
      // "2026-08-01" → 2026-08-01 00:00 IST = 2026-07-31T18:30:00Z.
      const range = istDayRangeFilter('2026-08-01', undefined);
      expect(range?.gte?.toISOString()).toBe('2026-07-31T18:30:00.000Z');
      expect(range?.lte).toBeUndefined();
    });

    it('expands a date-only `to` to 23:59:59.999 IST of that day (lte = 18:29:59.999Z)', () => {
      // "2026-08-31" → 2026-08-31 23:59:59.999 IST = 2026-08-31T18:29:59.999Z.
      const range = istDayRangeFilter(undefined, '2026-08-31');
      expect(range?.lte?.toISOString()).toBe('2026-08-31T18:29:59.999Z');
      expect(range?.gte).toBeUndefined();
    });

    it('expands both date-only bounds to the inclusive IST-day span', () => {
      const range = istDayRangeFilter('2026-08-01', '2026-08-31');
      expect(range?.gte?.toISOString()).toBe('2026-07-31T18:30:00.000Z');
      expect(range?.lte?.toISOString()).toBe('2026-08-31T18:29:59.999Z');
    });

    it('passes a full ISO datetime through AS-IS (explicit instant, not expanded)', () => {
      const iso = '2026-08-15T09:45:30.000Z';
      const range = istDayRangeFilter(iso, iso);
      expect(range?.gte?.toISOString()).toBe(iso);
      expect(range?.lte?.toISOString()).toBe(iso);
    });

    it('returns undefined when neither bound is supplied', () => {
      expect(istDayRangeFilter(undefined, undefined)).toBeUndefined();
      expect(istDayRangeFilter('', '')).toBeUndefined();
    });

    it('ignores an invalid bound (returns undefined when nothing parses)', () => {
      expect(istDayRangeFilter('not-a-date', undefined)).toBeUndefined();
    });
  });

  describe('istMonthKey', () => {
    it('returns the IST month, not the UTC month, in the early-IST window of the 1st', () => {
      // 2026-08-01T02:00:00Z = 2026-08-01 07:30 IST → August (UTC also August here).
      expect(istMonthKey(new Date('2026-08-01T02:00:00Z'))).toBe('2026-08');
    });
    it('rolls to the next IST month for a late-UTC instant that is already next-day IST', () => {
      // 2026-07-31T20:00:00Z = 2026-08-01 01:30 IST → August (UTC would say July).
      expect(istMonthKey(new Date('2026-07-31T20:00:00Z'))).toBe('2026-08');
    });
    it('stays in the prior IST month for an instant still on the last IST day', () => {
      // 2026-07-31T17:00:00Z = 2026-07-31 22:30 IST → July.
      expect(istMonthKey(new Date('2026-07-31T17:00:00Z'))).toBe('2026-07');
    });
  });

  describe('istDateKey', () => {
    it('returns the IST calendar day (YYYY-MM-DD), correct in the 00:00–05:30 IST window', () => {
      // 2026-06-30T20:00:00Z = 2026-07-01 01:30 IST → 2026-07-01 (toISOString would say 2026-06-30).
      expect(istDateKey(new Date('2026-06-30T20:00:00Z'))).toBe('2026-07-01');
    });
    it('agrees with UTC when the instant is mid-IST-day', () => {
      expect(istDateKey(new Date('2026-07-15T06:00:00Z'))).toBe('2026-07-15');
    });
  });

  describe('istDateTimeCell', () => {
    it('renders IST wall-clock YYYY-MM-DD HH:mm (24h)', () => {
      // 2026-07-15T06:00:00Z = 2026-07-15 11:30 IST.
      expect(istDateTimeCell(new Date('2026-07-15T06:00:00Z'))).toBe('2026-07-15 11:30');
    });
    it('crosses the IST day boundary correctly', () => {
      // 2026-06-30T20:15:00Z = 2026-07-01 01:45 IST.
      expect(istDateTimeCell(new Date('2026-06-30T20:15:00Z'))).toBe('2026-07-01 01:45');
    });
  });

  describe('istMonthBounds', () => {
    it('bounds the IST month as [00:00 IST of the 1st, 00:00 IST of next 1st)', () => {
      const { start, endExclusive } = istMonthBounds('2026-08');
      // 00:00 IST = 18:30 UTC the previous day.
      expect(start.toISOString()).toBe('2026-07-31T18:30:00.000Z');
      expect(endExclusive.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    });
    it('round-trips: an instant just inside the IST month is >= start and < endExclusive', () => {
      const { start, endExclusive } = istMonthBounds('2026-08');
      const firstMomentIst = new Date('2026-07-31T18:30:00.000Z'); // 2026-08-01 00:00 IST
      const lastMomentIst = new Date('2026-08-31T18:29:59.999Z'); // 2026-08-31 23:59:59.999 IST
      expect(firstMomentIst.getTime()).toBeGreaterThanOrEqual(start.getTime());
      expect(lastMomentIst.getTime()).toBeLessThan(endExclusive.getTime());
    });
    it('throws on a malformed month key', () => {
      expect(() => istMonthBounds('2026-13')).toThrow();
      expect(() => istMonthBounds('nope')).toThrow();
    });
  });
});
