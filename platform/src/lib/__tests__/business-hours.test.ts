import { describe, it, expect } from 'vitest';
import {
  businessHoursBetween,
  businessMsBetween,
  istDateKey,
  isValidIsoDate,
  parseHolidayDates,
} from '../business-hours';

/**
 * UTC-ms for a given IST wall-clock time — the helper's day/weekend/holiday boundaries are
 * IST boundaries, so fixtures must speak IST. Explicit INPUTS to a pure function → deterministic.
 * Mirrors api/src/common/business-hours.spec.ts (the two engines must agree).
 *
 * Anchor week (verified): 2026-01-26 is a Monday.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const IST = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS;

describe('business-hours', () => {
  it('counts hours within one Mon–Fri day', () => {
    expect(businessHoursBetween(IST(2026, 1, 26, 9, 0), IST(2026, 1, 26, 17, 0))).toBe(8);
  });

  it('Fri 00:00 → Mon 00:00 counts only Friday (24h)', () => {
    expect(businessHoursBetween(IST(2026, 1, 30, 0, 0), IST(2026, 2, 2, 0, 0))).toBe(24);
  });

  it('a Friday-afternoon 48h SLA is due the following Tuesday afternoon', () => {
    expect(businessHoursBetween(IST(2026, 1, 30, 15, 0), IST(2026, 2, 3, 15, 0))).toBe(48);
  });

  it('an interval that starts on a weekend ignores the weekend portion', () => {
    expect(businessHoursBetween(IST(2026, 1, 31, 10, 0), IST(2026, 2, 2, 10, 0))).toBe(10);
  });

  it('an interval fully inside a weekend is zero', () => {
    expect(businessHoursBetween(IST(2026, 1, 31, 8, 0), IST(2026, 2, 1, 20, 0))).toBe(0);
  });

  it('a holiday on a weekday freezes that day', () => {
    const holidays = new Set(['2026-01-30']);
    expect(businessHoursBetween(IST(2026, 1, 29, 0, 0), IST(2026, 2, 2, 0, 0), holidays)).toBe(24);
  });

  it('a holiday on a weekend has no extra effect', () => {
    const holidays = new Set(['2026-01-31']);
    expect(businessHoursBetween(IST(2026, 1, 30, 0, 0), IST(2026, 2, 2, 0, 0), holidays)).toBe(24);
  });

  it('two full working weeks (Mon→Mon) = 240 business hours', () => {
    expect(businessHoursBetween(IST(2026, 1, 26, 0, 0), IST(2026, 2, 9, 0, 0))).toBe(240);
  });

  it('degenerate intervals → 0', () => {
    const t = IST(2026, 1, 26, 12, 0);
    expect(businessHoursBetween(t, t)).toBe(0);
    expect(businessMsBetween(t, t)).toBe(0);
    expect(businessHoursBetween(IST(2026, 1, 27, 0, 0), IST(2026, 1, 26, 0, 0))).toBe(0);
    expect(businessHoursBetween(NaN, IST(2026, 1, 26, 0, 0))).toBe(0);
  });

  it('istDateKey reads the IST wall-clock date, not UTC', () => {
    // 02:00 IST = previous day 20:30 UTC — must still be the IST date.
    expect(istDateKey(IST(2026, 1, 26, 2, 0))).toBe('2026-01-26');
    expect(istDateKey(IST(2026, 1, 26, 23, 59))).toBe('2026-01-26');
  });

  it('isValidIsoDate accepts real dates and rejects impossible/malformed ones', () => {
    expect(isValidIsoDate('2026-01-30')).toBe(true);
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('2026-02-29')).toBe(false);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(isValidIsoDate('2026-1-1')).toBe(false);
    expect(isValidIsoDate('garbage')).toBe(false);
  });

  it('parseHolidayDates normalises objects, strings, and drops garbage', () => {
    expect([...parseHolidayDates([{ date: '2026-01-26', label: 'x' }, { date: '2026-08-15' }])].sort()).toEqual([
      '2026-01-26',
      '2026-08-15',
    ]);
    expect([...parseHolidayDates(['2026-10-02'])]).toEqual(['2026-10-02']);
    expect([...parseHolidayDates([{ date: '2026-02-30' }, 'bad', 42, null, { label: 'x' }])]).toEqual([]);
    expect(parseHolidayDates(null).size).toBe(0);
    expect(parseHolidayDates('2026-01-26').size).toBe(0);
  });
});
