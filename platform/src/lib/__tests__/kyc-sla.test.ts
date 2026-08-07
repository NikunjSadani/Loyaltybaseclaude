/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest';
import { kycAgeHrs, KYC_SLA_DEFAULT_HOURS } from '@/lib/kyc-sla';

// Dates computed relative to now (never hardcode a fixed date — it would rot).
const H = 3600 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe('kycAgeHrs — SLA clock stops at the decision', () => {
  it('APPROVED freezes at approvedAt (not "now")', () => {
    // submitted 100h ago, approved 99h ago → age must be ~1h, NOT ~100h.
    const age = kycAgeHrs(iso(100 * H), 'APPROVED', { approvedAt: iso(99 * H), reviewedAt: iso(99.5 * H) });
    expect(age).toBe(1);
  });

  it('REJECTED freezes at reviewedAt when there is no approvedAt', () => {
    const age = kycAgeHrs(iso(50 * H), 'REJECTED', { reviewedAt: iso(48 * H) });
    expect(age).toBe(2);
  });

  it('RE_KYC_REQUIRED (re-flagged approval) freezes at approvedAt', () => {
    const age = kycAgeHrs(iso(200 * H), 'RE_KYC_REQUIRED', { approvedAt: iso(199 * H) });
    expect(age).toBe(1);
  });

  it('a still-PENDING multi-level row with reviewedAt set runs LIVE (does NOT freeze)', () => {
    // A lower level forwarded it (reviewedAt set) but it is NOT decided → clock keeps running.
    // submitted 100h ago, reviewedAt 99h ago: a frozen clock would read ~1h; live reads ~100h.
    const age = kycAgeHrs(iso(100 * H), 'PENDING_GIFSY', { reviewedAt: iso(99 * H) });
    expect(age).toBeGreaterThan(90);
  });

  it('a brand-new PENDING row runs live from submission', () => {
    const age = kycAgeHrs(iso(5 * H), 'SUBMITTED', {});
    expect(age).toBe(5);
  });

  it('falls back to updatedAt for a decided row missing reviewedAt/approvedAt', () => {
    const age = kycAgeHrs(iso(30 * H), 'REJECTED', { updatedAt: iso(28 * H) });
    expect(age).toBe(2);
  });

  it('never negative, and 0 when submittedAt is missing', () => {
    expect(kycAgeHrs(null, 'APPROVED', { approvedAt: iso(10 * H) })).toBe(0);
    // approvedAt BEFORE submittedAt (clock skew) clamps to 0, never negative.
    expect(kycAgeHrs(iso(1 * H), 'APPROVED', { approvedAt: iso(2 * H) })).toBe(0);
  });

  it('exposes the 48h default SLA threshold', () => {
    expect(KYC_SLA_DEFAULT_HOURS).toBe(48);
  });
});
