import { describe, it, expect } from 'vitest';
import { kycSubmissionOrderRank } from '../kyc-order';
import { KYCStatus } from '@/types';

describe('kycSubmissionOrderRank — sales KYC-Submissions list ordering (owner 2026-07-03)', () => {
  it('ranks the five named buckets in order: re-kyc → rejected → pending → approved → not-interested', () => {
    expect(kycSubmissionOrderRank(KYCStatus.RE_KYC_REQUIRED)).toBe(0);
    expect(kycSubmissionOrderRank(KYCStatus.REJECTED)).toBe(1);
    expect(kycSubmissionOrderRank(KYCStatus.PENDING)).toBe(2);
    expect(kycSubmissionOrderRank(KYCStatus.APPROVED)).toBe(3);
    expect(kycSubmissionOrderRank(KYCStatus.NOT_INTERESTED)).toBe(4);
  });

  it('folds re-upload / resubmission into the Rejected bucket (they badge as "Rejected")', () => {
    expect(kycSubmissionOrderRank(KYCStatus.RE_UPLOAD_REQUIRED)).toBe(1);
    expect(kycSubmissionOrderRank(KYCStatus.RESUBMISSION_REQUIRED)).toBe(1);
  });

  it('folds not-started and every in-flight state into the KYC Pending bucket', () => {
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
      expect(kycSubmissionOrderRank(s)).toBe(2);
    }
  });

  it('sorts a mixed list into the owner order', () => {
    const statuses = [
      KYCStatus.NOT_INTERESTED,
      KYCStatus.APPROVED,
      KYCStatus.PENDING,
      KYCStatus.REJECTED,
      KYCStatus.RE_KYC_REQUIRED,
    ];
    const sorted = [...statuses].sort(
      (a, b) => kycSubmissionOrderRank(a) - kycSubmissionOrderRank(b),
    );
    expect(sorted).toEqual([
      KYCStatus.RE_KYC_REQUIRED,
      KYCStatus.REJECTED,
      KYCStatus.PENDING,
      KYCStatus.APPROVED,
      KYCStatus.NOT_INTERESTED,
    ]);
  });
});
