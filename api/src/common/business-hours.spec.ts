import {
  businessHoursBetween,
  businessMsBetween,
  istDateKey,
  isValidIsoDate,
  parseHolidayDates,
} from './business-hours';

/**
 * UTC-ms for a given IST wall-clock time. Building fixtures in IST (not UTC) is the point:
 * the helper's day/weekend/holiday boundaries are IST boundaries, so the tests must speak IST.
 * These are explicit INPUTS to a pure function, so they are deterministic and never rot.
 *
 * Anchor week (verified): 2026-01-26 is a Monday →
 *   Mon 26, Tue 27, Wed 28, Thu 29, Fri 30, Sat 31, Sun Feb-01, Mon Feb-02, Tue Feb-03.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const IST = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS;

describe('business-hours', () => {
  describe('businessHoursBetween — same working day', () => {
    it('counts hours within one Mon–Fri day', () => {
      expect(businessHoursBetween(IST(2026, 1, 26, 9, 0), IST(2026, 1, 26, 17, 0))).toBe(8);
    });
  });

  describe('businessHoursBetween — weekends excluded', () => {
    it('Fri 00:00 → Mon 00:00 counts only Friday (24h), Sat+Sun frozen', () => {
      expect(businessHoursBetween(IST(2026, 1, 30, 0, 0), IST(2026, 2, 2, 0, 0))).toBe(24);
    });

    it('a Friday-afternoon 48h SLA is due the following Tuesday afternoon', () => {
      // Fri 30 15:00 → Sat 00:00 = 9h; Sat/Sun = 0; Mon 02 = 24h; Tue 03 00:00→15:00 = 15h → 48.
      expect(businessHoursBetween(IST(2026, 1, 30, 15, 0), IST(2026, 2, 3, 15, 0))).toBe(48);
    });

    it('an interval that STARTS on a weekend ignores the weekend portion', () => {
      // Sat 31 10:00 → Mon 02 10:00: Sat/Sun frozen, Mon 00:00→10:00 = 10h.
      expect(businessHoursBetween(IST(2026, 1, 31, 10, 0), IST(2026, 2, 2, 10, 0))).toBe(10);
    });

    it('an interval fully inside a weekend is zero', () => {
      expect(businessHoursBetween(IST(2026, 1, 31, 8, 0), IST(2026, 2, 1, 20, 0))).toBe(0);
    });
  });

  describe('businessHoursBetween — holidays excluded', () => {
    it('a holiday on a weekday freezes that day', () => {
      // Thu 29 00:00 → Mon 02 00:00 with Fri 30 a holiday: Thu 24h, Fri(hol) 0, Sat 0, Sun 0 = 24h.
      const holidays = new Set(['2026-01-30']);
      expect(
        businessHoursBetween(IST(2026, 1, 29, 0, 0), IST(2026, 2, 2, 0, 0), holidays),
      ).toBe(24);
    });

    it('a holiday that falls on a weekend has no extra effect', () => {
      const holidays = new Set(['2026-01-31']); // Saturday, already excluded
      expect(
        businessHoursBetween(IST(2026, 1, 30, 0, 0), IST(2026, 2, 2, 0, 0), holidays),
      ).toBe(24);
    });

    it('back-to-back holidays over a whole working week yield zero', () => {
      const holidays = new Set([
        '2026-01-26',
        '2026-01-27',
        '2026-01-28',
        '2026-01-29',
        '2026-01-30',
      ]);
      expect(
        businessHoursBetween(IST(2026, 1, 26, 0, 0), IST(2026, 1, 31, 0, 0), holidays),
      ).toBe(0);
    });
  });

  describe('businessHoursBetween — multi-week span', () => {
    it('two full working weeks (Mon→Mon, two weekends) = 5 business days × 24h × 2 = 240h', () => {
      // Mon 26 00:00 → Mon Feb-09 00:00: two Mon–Fri blocks (5 days each) at 24h = 240h.
      expect(businessHoursBetween(IST(2026, 1, 26, 0, 0), IST(2026, 2, 9, 0, 0))).toBe(240);
    });
  });

  describe('businessHoursBetween / businessMsBetween — degenerate intervals', () => {
    it('zero-length interval → 0', () => {
      const t = IST(2026, 1, 26, 12, 0);
      expect(businessHoursBetween(t, t)).toBe(0);
      expect(businessMsBetween(t, t)).toBe(0);
    });
    it('reversed interval (end before start) → 0', () => {
      expect(businessHoursBetween(IST(2026, 1, 27, 0, 0), IST(2026, 1, 26, 0, 0))).toBe(0);
    });
    it('non-finite inputs → 0 (never NaN)', () => {
      expect(businessHoursBetween(NaN, IST(2026, 1, 26, 0, 0))).toBe(0);
      expect(businessHoursBetween(IST(2026, 1, 26, 0, 0), Infinity)).toBe(0);
    });
  });

  describe('istDateKey — IST wall-clock date, not UTC', () => {
    it('02:00 IST maps to the IST date even though UTC is still the previous day', () => {
      // 2026-01-26 02:00 IST = 2026-01-25 20:30 UTC. Must read as the IST date.
      expect(istDateKey(IST(2026, 1, 26, 2, 0))).toBe('2026-01-26');
    });
    it('just before IST midnight stays on the same IST date', () => {
      expect(istDateKey(IST(2026, 1, 26, 23, 59))).toBe('2026-01-26');
    });
  });

  describe('isValidIsoDate', () => {
    it('accepts a real date', () => {
      expect(isValidIsoDate('2026-01-30')).toBe(true);
    });
    it('accepts a leap day', () => {
      expect(isValidIsoDate('2024-02-29')).toBe(true);
    });
    it('rejects an impossible day', () => {
      expect(isValidIsoDate('2026-02-30')).toBe(false);
      expect(isValidIsoDate('2026-02-29')).toBe(false); // 2026 is not a leap year
    });
    it('rejects a bad month and malformed strings', () => {
      expect(isValidIsoDate('2026-13-01')).toBe(false);
      expect(isValidIsoDate('2026-1-1')).toBe(false);
      expect(isValidIsoDate('30-01-2026')).toBe(false);
      expect(isValidIsoDate('garbage')).toBe(false);
    });
  });

  describe('parseHolidayDates', () => {
    it('extracts dates from an array of {date,label} objects', () => {
      const set = parseHolidayDates([
        { date: '2026-01-26', label: 'Republic Day' },
        { date: '2026-08-15', label: 'Independence Day' },
      ]);
      expect([...set].sort()).toEqual(['2026-01-26', '2026-08-15']);
    });
    it('accepts an array of bare date strings', () => {
      expect([...parseHolidayDates(['2026-10-02'])]).toEqual(['2026-10-02']);
    });
    it('drops invalid/garbage entries without throwing', () => {
      const set = parseHolidayDates([
        { date: '2026-01-26' },
        { date: '2026-02-30' }, // impossible
        { label: 'no date' },
        'bad',
        42,
        null,
      ]);
      expect([...set]).toEqual(['2026-01-26']);
    });
    it('returns an empty set for a non-array', () => {
      expect(parseHolidayDates(null).size).toBe(0);
      expect(parseHolidayDates({}).size).toBe(0);
      expect(parseHolidayDates('2026-01-26').size).toBe(0);
    });
  });
});
