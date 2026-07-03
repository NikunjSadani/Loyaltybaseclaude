import { describe, it, expect } from 'vitest';
import { kycOrderRank } from '../kyc-order';
import { KYCStatus } from '@/types';

describe('kycOrderRank — sales outlet ordering (owner 2026-07-03)', () => {
  it('ranks the five named buckets in order: approved → re-kyc → rejected → pending → not-interested', () => {
    expect(kycOrderRank(KYCStatus.APPROVED)).toBe(0);
    expect(kycOrderRank(KYCStatus.RE_KYC_REQUIRED)).toBe(1);
    expect(kycOrderRank(KYCStatus.REJECTED)).toBe(2);
    expect(kycOrderRank(KYCStatus.PENDING)).toBe(3);
    expect(kycOrderRank(KYCStatus.NOT_INTERESTED)).toBe(4);
  });

  it('folds re-upload / resubmission into the Rejected bucket (they badge as "Rejected")', () => {
    expect(kycOrderRank(KYCStatus.RE_UPLOAD_REQUIRED)).toBe(2);
    expect(kycOrderRank(KYCStatus.RESUBMISSION_REQUIRED)).toBe(2);
  });

  it('folds not-started and every in-flight state into the Pending bucket', () => {
    for (const s of [
      KYCStatus.NOT_STARTED,
      KYCStatus.DRAFT,
      KYCStatus.SUBMITTED,
      KYCStatus.UNDER_REVIEW,
      KYCStatus.PENDING_SO_APPROVAL,
      KYCStatus.PENDING_ASM_APPROVAL,
      KYCStatus.PENDING_RSM_APPROVAL,
      KYCStatus.PENDING_GIFSY,
    ]) {
      expect(kycOrderRank(s)).toBe(3);
    }
  });

  it('sorts a mixed list into the owner order', () => {
    const statuses = [
      KYCStatus.NOT_INTERESTED,
      KYCStatus.PENDING,
      KYCStatus.APPROVED,
      KYCStatus.REJECTED,
      KYCStatus.RE_KYC_REQUIRED,
    ];
    const sorted = [...statuses].sort((a, b) => kycOrderRank(a) - kycOrderRank(b));
    expect(sorted).toEqual([
      KYCStatus.APPROVED,
      KYCStatus.RE_KYC_REQUIRED,
      KYCStatus.REJECTED,
      KYCStatus.PENDING,
      KYCStatus.NOT_INTERESTED,
    ]);
  });
});
