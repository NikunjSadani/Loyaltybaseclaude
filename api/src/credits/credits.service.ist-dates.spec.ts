import { BadRequestException } from '@nestjs/common';
import { CreditsService } from './credits.service';

/**
 * FIX 2 — the prior-month upload/confirm cutoff + the current-period key must be computed from
 * IST wall-clock, not the server-local (UTC in prod) clock. In the 00:00–05:30 IST window the
 * UTC day/month is the WRONG IST day/month, which held the window open ~5.5h too long and
 * mis-labelled the current month at a UTC↔IST month boundary. Money math is untouched.
 *
 * The tested methods are pure (no DI), so the service is built with undefined dependencies.
 */
describe('CreditsService — IST cutoff window + period key (FIX 2)', () => {
  const service = new CreditsService(
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
  );

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('currentPeriodKey — IST month', () => {
    it('returns the IST month at a UTC↔IST month boundary (2026-08-31T23:00Z = 2026-09-01 04:30 IST → "2026-09")', () => {
      const key = (service as any).currentPeriodKey(new Date('2026-08-31T23:00:00.000Z'));
      expect(key).toBe('2026-09');
    });

    it('returns the plain IST month mid-day (2026-08-15T06:00Z = 11:30 IST → "2026-08")', () => {
      const key = (service as any).currentPeriodKey(new Date('2026-08-15T06:00:00.000Z'));
      expect(key).toBe('2026-08');
    });
  });

  describe('assertWithinUploadWindow — IST day-of-month cutoff', () => {
    const cutoffDay = 5;

    it('treats a UTC instant that is 02:00 IST on (cutoffDay+1) as PAST the cutoff (IST), not open', () => {
      // 02:00 IST on 2026-09-06 = 2026-09-05T20:30:00.000Z. IST day = 6 (> cutoff 5) → CLOSED.
      // (Under the old UTC logic, getDate() = 5 → 5 > 5 false → the window would wrongly stay OPEN.)
      jest.useFakeTimers().setSystemTime(new Date('2026-09-05T20:30:00.000Z'));
      expect(() =>
        (service as any).assertWithinUploadWindow('2026-08', cutoffDay),
      ).toThrow(BadRequestException);
    });

    it('stays OPEN when the IST day-of-month is still on/before the cutoff', () => {
      // 02:00 IST on 2026-09-05 (the cutoff day itself) = 2026-09-04T20:30:00.000Z. IST day = 5 → OPEN.
      jest.useFakeTimers().setSystemTime(new Date('2026-09-04T20:30:00.000Z'));
      expect(() =>
        (service as any).assertWithinUploadWindow('2026-08', cutoffDay),
      ).not.toThrow();
    });

    it('never gates a current/future-month batch regardless of the cutoff day', () => {
      // Well past the cutoff in IST, but the period IS the current IST month → not gated.
      jest.useFakeTimers().setSystemTime(new Date('2026-09-20T12:00:00.000Z'));
      expect(() =>
        (service as any).assertWithinUploadWindow('2026-09', cutoffDay),
      ).not.toThrow();
    });
  });
});
