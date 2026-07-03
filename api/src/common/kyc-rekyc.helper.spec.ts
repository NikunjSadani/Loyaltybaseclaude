import { isReKycPending } from './kyc-rekyc.helper';

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
