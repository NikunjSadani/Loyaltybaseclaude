// Unit tests for the IST-aware date formatters used by the money-notification
// (WhatsApp) bodies. The key invariant: on a UTC server these render the INDIAN
// wall-clock date, so a UTC instant in the 00:00–05:30 IST window (or on a UTC
// month boundary) still produces the correct IST day/month.
// Run: npx jest src/common/ist-date.spec.ts

import { monthYearIST, formatDateIST } from './ist-date';

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
});
