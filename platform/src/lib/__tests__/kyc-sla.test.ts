/// <reference types="vitest/globals" />
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { kycAgeHrs, KYC_SLA_DEFAULT_HOURS } from '@/lib/kyc-sla';

/**
 * kycAgeHrs now counts BUSINESS hours (Mon–Fri, excluding a holiday calendar), so "N hours
 * ago" relative to the real clock would be flaky (a 1h window could land on a weekend).
 * The clock is MOCKED to a fixed Wednesday and fixtures use fixed weekday dates within the
 * same Mon–Fri week — deterministic, and it does NOT rot because "now" is mocked too.
 *
 * Anchor: now = Wed 07 Jan 2026 12:00Z (17:30 IST). The week Mon 05 → Fri 09 Jan has no
 * weekend in the fixtures' windows, so business hours == calendar hours unless a fixture
 * deliberately spans a weekend or a holiday.
 */
const NOW = new Date('2026-01-07T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('kycAgeHrs — SLA clock stops at the decision (business hours)', () => {
  it('APPROVED freezes at approvedAt (not "now")', () => {
    // Tue 09:00Z → Tue 10:00Z = 1 business hour, regardless of how far "now" is.
    const age = kycAgeHrs('2026-01-06T09:00:00Z', 'APPROVED', {
      approvedAt: '2026-01-06T10:00:00Z',
      reviewedAt: '2026-01-06T09:30:00Z',
    });
    expect(age).toBe(1);
  });

  it('REJECTED freezes at reviewedAt when there is no approvedAt', () => {
    const age = kycAgeHrs('2026-01-06T08:00:00Z', 'REJECTED', { reviewedAt: '2026-01-06T10:00:00Z' });
    expect(age).toBe(2);
  });

  it('RE_KYC_REQUIRED (re-flagged approval) freezes at approvedAt', () => {
    const age = kycAgeHrs('2026-01-05T09:00:00Z', 'RE_KYC_REQUIRED', { approvedAt: '2026-01-05T10:00:00Z' });
    expect(age).toBe(1);
  });

  it('falls back to updatedAt for a decided row missing reviewedAt/approvedAt', () => {
    const age = kycAgeHrs('2026-01-06T08:00:00Z', 'REJECTED', { updatedAt: '2026-01-06T10:00:00Z' });
    expect(age).toBe(2);
  });

  it('a still-PENDING multi-level row with reviewedAt set runs LIVE (does NOT freeze)', () => {
    // Submitted Mon 10:00Z; a lower level reviewed it Mon 11:00Z but it is NOT decided → the
    // clock keeps running to now (Wed). Frozen would read ~1h; live spans Mon→Wed (~50 business h).
    const age = kycAgeHrs('2026-01-05T10:00:00Z', 'PENDING_GIFSY', { reviewedAt: '2026-01-05T11:00:00Z' });
    expect(age).toBeGreaterThan(40);
  });

  it('a brand-new PENDING row runs live from submission', () => {
    // Submitted Wed 07:00Z (5h before now 12:00Z, same day) → 5 business hours.
    const age = kycAgeHrs('2026-01-07T07:00:00Z', 'SUBMITTED', {});
    expect(age).toBe(5);
  });

  it('excludes weekends: Fri afternoon → Mon reads as business hours only', () => {
    // Submitted Fri 02 Jan 15:00Z, decided Mon 05 Jan 15:00Z. Sat+Sun are excluded, so the
    // three calendar days collapse to ~24 business hours, not ~72.
    const age = kycAgeHrs('2026-01-02T15:00:00Z', 'APPROVED', { approvedAt: '2026-01-05T15:00:00Z' });
    expect(age).toBe(24);
  });

  it('excludes a holiday passed in the holiday set', () => {
    // Mon 05 → Wed 07, but Tue 06 is a holiday → Mon + Wed only (Tue frozen).
    const withHoliday = kycAgeHrs(
      '2026-01-05T09:00:00Z',
      'APPROVED',
      { approvedAt: '2026-01-07T09:00:00Z' },
      new Set(['2026-01-06']),
    );
    const withoutHoliday = kycAgeHrs('2026-01-05T09:00:00Z', 'APPROVED', {
      approvedAt: '2026-01-07T09:00:00Z',
    });
    expect(withoutHoliday - withHoliday).toBe(24); // exactly one working day removed
  });

  it('never negative, and 0 when submittedAt is missing', () => {
    expect(kycAgeHrs(null, 'APPROVED', { approvedAt: '2026-01-06T10:00:00Z' })).toBe(0);
    // approvedAt BEFORE submittedAt (clock skew) clamps to 0, never negative.
    expect(kycAgeHrs('2026-01-06T10:00:00Z', 'APPROVED', { approvedAt: '2026-01-06T09:00:00Z' })).toBe(0);
  });

  it('exposes the 48h default SLA threshold', () => {
    expect(KYC_SLA_DEFAULT_HOURS).toBe(48);
  });
});
