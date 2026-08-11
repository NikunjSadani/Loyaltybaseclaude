import { kycStageSla, kycStageOf, latestGifsyEntryMs, KycSlaTargets } from './kyc-sla-stage';

// UTC-ms for an IST wall-clock time (the business-hours clock buckets by IST day).
const IST = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  Date.UTC(y, mo - 1, d, h, mi) - (5 * 60 + 30) * 60_000;

// Anchor week: 2026-01-26 Mon … 30 Fri, Feb-02 Mon. now = Wed 2026-01-28 12:00 IST.
const NOW = IST(2026, 1, 28, 12, 0);
const T: KycSlaTargets = { fieldHrs: 24, gifsyHrs: 96 };
const iso = (ms: number) => new Date(ms).toISOString();

describe('kyc-sla-stage', () => {
  describe('kycStageOf', () => {
    it('maps statuses to stages', () => {
      expect(kycStageOf('PENDING_SO_APPROVAL')).toBe('field');
      expect(kycStageOf('SUBMITTED')).toBe('field');
      expect(kycStageOf('PENDING_GIFSY')).toBe('gifsy');
      expect(kycStageOf('APPROVED')).toBe('decided');
      expect(kycStageOf('REJECTED')).toBe('decided');
      expect(kycStageOf('DRAFT')).toBe('none');
      expect(kycStageOf('NOT_INTERESTED')).toBe('none');
    });
  });

  describe('kycStageSla', () => {
    it('FIELD pending: clock=field vs fieldHrs, runs from submittedAt to now', () => {
      // submitted Mon 12:00 → now Wed 12:00 = 48 business hours > 24 → breached.
      const r = kycStageSla({ status: 'PENDING_SO_APPROVAL', submittedAt: iso(IST(2026, 1, 26, 12, 0)), nowMs: NOW }, T);
      expect(r.clock).toBe('field');
      expect(r.ageHrs).toBe(48);
      expect(r.targetHrs).toBe(24);
      expect(r.breached).toBe(true);
      expect(r.frozen).toBe(false);
    });

    it('GIFSY pending: clock=gifsy vs gifsyHrs, runs from the gifsy-entry (submittedAt ignored)', () => {
      // entered Gifsy Wed 06:00 → now Wed 12:00 = 6 business hours < 96 → within.
      const r = kycStageSla(
        {
          status: 'PENDING_GIFSY',
          submittedAt: iso(IST(2026, 1, 20, 0, 0)), // much earlier — must NOT be used
          gifsyEnteredAt: iso(IST(2026, 1, 28, 6, 0)),
          nowMs: NOW,
        },
        T,
      );
      expect(r.clock).toBe('gifsy');
      expect(r.ageHrs).toBe(6);
      expect(r.targetHrs).toBe(96);
      expect(r.breached).toBe(false);
    });

    it('GIFSY pending breached when past 96 business hours', () => {
      const r = kycStageSla(
        { status: 'PENDING_GIFSY', gifsyEnteredAt: iso(IST(2026, 1, 19, 12, 0)), nowMs: NOW },
        T,
      );
      expect(r.clock).toBe('gifsy');
      expect(r.breached).toBe(true); // Mon Jan-19 → Wed Jan-28 spans > 96 business hrs
    });

    it('DECIDED at Gifsy: frozen on the gifsy clock at the decision', () => {
      const r = kycStageSla(
        {
          status: 'APPROVED',
          submittedAt: iso(IST(2026, 1, 20, 0, 0)),
          gifsyEnteredAt: iso(IST(2026, 1, 27, 12, 0)),
          approvedAt: iso(IST(2026, 1, 28, 12, 0)),
          nowMs: IST(2026, 2, 6, 0, 0), // now is FAR later — must be ignored (frozen at approvedAt)
        },
        T,
      );
      expect(r.clock).toBe('gifsy');
      expect(r.frozen).toBe(true);
      expect(r.ageHrs).toBe(24); // Tue 12:00 → Wed 12:00
      expect(r.breached).toBe(false);
    });

    it('DECIDED at field (never reached Gifsy): frozen on the field clock', () => {
      const r = kycStageSla(
        {
          status: 'REJECTED',
          submittedAt: iso(IST(2026, 1, 26, 12, 0)),
          reviewedAt: iso(IST(2026, 1, 27, 12, 0)),
          nowMs: IST(2026, 2, 6, 0, 0),
        },
        T,
      );
      expect(r.clock).toBe('field');
      expect(r.frozen).toBe(true);
      expect(r.ageHrs).toBe(24); // Mon 12:00 → Tue 12:00
      expect(r.breached).toBe(false); // 24 > 24 is false
    });

    it('DRAFT / none → no SLA', () => {
      const r = kycStageSla({ status: 'DRAFT', submittedAt: iso(IST(2026, 1, 26, 0, 0)), nowMs: NOW }, T);
      expect(r).toEqual({ clock: 'none', ageHrs: 0, targetHrs: null, breached: false, frozen: false });
    });

    it('GIFSY row missing the entry AND submittedAt → guarded to age 0, not breached', () => {
      const r = kycStageSla({ status: 'PENDING_GIFSY', nowMs: NOW }, T);
      expect(r.clock).toBe('gifsy');
      expect(r.ageHrs).toBe(0);
      expect(r.breached).toBe(false);
    });

    it('M1: GIFSY row missing the entry timestamp falls back to submittedAt (still ages + surfaces)', () => {
      // A row sitting in PENDING_GIFSY with no PENDING_GIFSY history entry must NOT read 0h/healthy —
      // it ages from submittedAt, matching the dashboard + digest-report fallback so all agree.
      const r = kycStageSla(
        { status: 'PENDING_GIFSY', submittedAt: iso(IST(2026, 1, 19, 12, 0)), nowMs: NOW },
        T,
      );
      expect(r.clock).toBe('gifsy');
      expect(r.ageHrs).toBeGreaterThan(96); // Mon Jan-19 → Wed Jan-28 spans > 96 business hrs
      expect(r.breached).toBe(true);
    });
  });

  describe('latestGifsyEntryMs', () => {
    it('picks the LATEST PENDING_GIFSY entry (restart on re-entry)', () => {
      const first = IST(2026, 1, 20, 9, 0);
      const second = IST(2026, 1, 27, 9, 0);
      const got = latestGifsyEntryMs([
        { toStatus: 'PENDING_GIFSY', createdAt: iso(first) },
        { toStatus: 'PENDING_SO_APPROVAL', createdAt: iso(IST(2026, 1, 22, 9, 0)) },
        { toStatus: 'PENDING_GIFSY', createdAt: iso(second) },
      ]);
      expect(got).toBe(second);
    });
    it('null when no PENDING_GIFSY entry / bad input', () => {
      expect(latestGifsyEntryMs([{ toStatus: 'SUBMITTED', createdAt: iso(NOW) }])).toBeNull();
      expect(latestGifsyEntryMs(null)).toBeNull();
      expect(latestGifsyEntryMs(undefined)).toBeNull();
    });
  });
});
