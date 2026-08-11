import { describe, it, expect } from 'vitest';
import { kycStageSla, kycStageOf, latestGifsyEntryMs, type KycSlaTargets } from '../kyc-sla-stage';

// Mirror of api/src/common/kyc-sla-stage.spec.ts. IST-anchored fixtures → deterministic.
const IST = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  Date.UTC(y, mo - 1, d, h, mi) - (5 * 60 + 30) * 60_000;
const NOW = IST(2026, 1, 28, 12, 0); // Wed
const T: KycSlaTargets = { fieldHrs: 24, gifsyHrs: 96 };
const iso = (ms: number) => new Date(ms).toISOString();

describe('kyc-sla-stage (FE)', () => {
  it('kycStageOf maps statuses', () => {
    expect(kycStageOf('PENDING_SO_APPROVAL')).toBe('field');
    expect(kycStageOf('PENDING_GIFSY')).toBe('gifsy');
    expect(kycStageOf('APPROVED')).toBe('decided');
    expect(kycStageOf('DRAFT')).toBe('none');
  });

  it('FIELD pending: field clock from submittedAt, breach vs fieldHrs', () => {
    const r = kycStageSla({ status: 'PENDING_SO_APPROVAL', submittedAt: iso(IST(2026, 1, 26, 12, 0)), nowMs: NOW }, T);
    expect(r).toMatchObject({ clock: 'field', ageHrs: 48, targetHrs: 24, breached: true, frozen: false });
  });

  it('GIFSY pending: gifsy clock from the entry, submittedAt ignored', () => {
    const r = kycStageSla(
      { status: 'PENDING_GIFSY', submittedAt: iso(IST(2026, 1, 20, 0, 0)), gifsyEnteredAt: iso(IST(2026, 1, 28, 6, 0)), nowMs: NOW },
      T,
    );
    expect(r).toMatchObject({ clock: 'gifsy', ageHrs: 6, targetHrs: 96, breached: false });
  });

  it('DECIDED at Gifsy freezes on the gifsy clock', () => {
    const r = kycStageSla(
      {
        status: 'APPROVED',
        gifsyEnteredAt: iso(IST(2026, 1, 27, 12, 0)),
        approvedAt: iso(IST(2026, 1, 28, 12, 0)),
        nowMs: IST(2026, 2, 6, 0, 0),
      },
      T,
    );
    expect(r).toMatchObject({ clock: 'gifsy', ageHrs: 24, frozen: true, breached: false });
  });

  it('DECIDED at field freezes on the field clock', () => {
    const r = kycStageSla(
      { status: 'REJECTED', submittedAt: iso(IST(2026, 1, 26, 12, 0)), reviewedAt: iso(IST(2026, 1, 27, 12, 0)), nowMs: IST(2026, 2, 6, 0, 0) },
      T,
    );
    expect(r).toMatchObject({ clock: 'field', ageHrs: 24, frozen: true });
  });

  it('M1: GIFSY row with no entry timestamp falls back to submittedAt (ages + surfaces)', () => {
    const r = kycStageSla(
      { status: 'PENDING_GIFSY', submittedAt: iso(IST(2026, 1, 19, 12, 0)), nowMs: NOW },
      T,
    );
    expect(r.clock).toBe('gifsy');
    expect(r.ageHrs).toBeGreaterThan(96);
    expect(r.breached).toBe(true);
  });

  it('DRAFT → none', () => {
    expect(kycStageSla({ status: 'DRAFT', nowMs: NOW }, T)).toEqual({
      clock: 'none',
      ageHrs: 0,
      targetHrs: null,
      breached: false,
      frozen: false,
    });
  });

  it('latestGifsyEntryMs picks the latest entry', () => {
    const second = IST(2026, 1, 27, 9, 0);
    expect(
      latestGifsyEntryMs([
        { toStatus: 'PENDING_GIFSY', createdAt: iso(IST(2026, 1, 20, 9, 0)) },
        { toStatus: 'PENDING_GIFSY', createdAt: iso(second) },
      ]),
    ).toBe(second);
    expect(latestGifsyEntryMs(null)).toBeNull();
  });
});
