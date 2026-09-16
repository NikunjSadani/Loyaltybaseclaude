import {
  isReKycPending,
  isKycInFlight,
  isReKycActionable,
  deriveKycStage,
} from './kyc-rekyc.helper';
import type { KycStatus } from '@prisma/client';

describe('isReKycPending', () => {
  it('a non-empty reKycFlags object (a field to re-capture) → true', () => {
    expect(isReKycPending({ mobileNumber: true })).toBe(true);
  });

  it('non-empty even if the flags are all-false (keys present = admin flagged it) → true', () => {
    // Matches the admin deriveKycStatus semantics: the presence of the flags map
    // (written by the re-KYC upload) is the signal, so admin + sales stay consistent.
    expect(isReKycPending({ mobileNumber: false, remarks: '' })).toBe(true);
  });

  it('an empty object → false (nothing pending)', () => {
    expect(isReKycPending({})).toBe(false);
  });

  it('null → false', () => {
    expect(isReKycPending(null)).toBe(false);
  });

  it('undefined → false', () => {
    expect(isReKycPending(undefined)).toBe(false);
  });
});

describe('isKycInFlight', () => {
  it.each(['SUBMITTED', 'UNDER_REVIEW', 'PENDING_SO_APPROVAL', 'PENDING_ASM_APPROVAL', 'PENDING_RSM_APPROVAL', 'PENDING_GIFSY'])(
    '%s → true (under review)',
    (s) => expect(isKycInFlight(s)).toBe(true),
  );
  it.each(['APPROVED', 'REJECTED', 'RE_KYC_REQUIRED', 'RE_UPLOAD_REQUIRED', 'DRAFT', 'NOT_INTERESTED', null, undefined])(
    '%s → false (not an active review state)',
    (s) => expect(isKycInFlight(s)).toBe(false),
  );
});

describe('isReKycActionable', () => {
  it('flags set + latest terminal (APPROVED bulk-flag case) → actionable', () => {
    expect(isReKycActionable({ mobileNumber: true }, 'APPROVED')).toBe(true);
  });
  it('flags set + latest UNDER REVIEW (resubmitted) → NOT actionable (show the in-flight status)', () => {
    expect(isReKycActionable({ mobileNumber: true }, 'PENDING_SO_APPROVAL')).toBe(false);
  });
  it('no flags → never actionable regardless of status', () => {
    expect(isReKycActionable(null, 'APPROVED')).toBe(false);
    expect(isReKycActionable({}, 'REJECTED')).toBe(false);
  });
});

describe('deriveKycStage', () => {
  it('null / undefined (no submission) → Not Started', () => {
    expect(deriveKycStage(null)).toBe('Not Started');
    expect(deriveKycStage(undefined)).toBe('Not Started');
  });

  it('DRAFT → In Progress', () => {
    expect(deriveKycStage('DRAFT')).toBe('In Progress');
  });

  it.each<KycStatus>([
    'SUBMITTED',
    'UNDER_REVIEW',
    'PENDING_PENNY_DROP',
    'PENDING_AGREEMENT',
    'PENDING_SO_APPROVAL',
    'PENDING_ASM_APPROVAL',
    'PENDING_RSM_APPROVAL',
  ])('%s → Submitted (field approval)', (s) => {
    expect(deriveKycStage(s)).toBe('Submitted (field approval)');
  });

  it('PENDING_GIFSY → Pending Gifsy', () => {
    expect(deriveKycStage('PENDING_GIFSY')).toBe('Pending Gifsy');
  });

  it('APPROVED → Approved', () => {
    expect(deriveKycStage('APPROVED')).toBe('Approved');
  });

  it('REJECTED → Rejected (its own label, distinct from re-upload)', () => {
    expect(deriveKycStage('REJECTED')).toBe('Rejected');
  });

  it.each<KycStatus>(['RE_UPLOAD_REQUIRED', 'RESUBMISSION_REQUIRED', 'RE_KYC_REQUIRED', 'SUSPENDED'])(
    '%s → Re-upload',
    (s) => {
      expect(deriveKycStage(s)).toBe('Re-upload');
    },
  );

  it('a bare NOT_INTERESTED submission status (outside every set) → Not Started (matches the dashboard grouping)', () => {
    expect(deriveKycStage('NOT_INTERESTED')).toBe('Not Started');
  });
});
