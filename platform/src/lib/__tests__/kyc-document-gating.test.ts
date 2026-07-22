import { describe, it, expect } from 'vitest';
import { isAddressProofRequired, isSelfDeclarationRequired } from '../kyc-document-gating';

describe('kyc-document-gating', () => {
  describe('isAddressProofRequired', () => {
    // The waiver must NEVER make the address proof optional — this is the whole point
    // of the corrected semantics (it only drops the self-declaration).
    it('is always required, regardless of waiver or mismatch', () => {
      expect(isAddressProofRequired()).toBe(true);
    });

    // Regression guard: catch a reintroduction of the old parameterized bug
    // `isAddressProofRequired(waiverEnabled, nameMismatch) => !(waiverEnabled && nameMismatch)`,
    // which a no-arg `.toBe(true)` alone would not detect.
    it('takes no parameters and ignores any args (never becomes conditional)', () => {
      expect(isAddressProofRequired.length).toBe(0);
      // @ts-expect-error — deliberately over-applying args to prove they have no effect.
      expect(isAddressProofRequired(true, true)).toBe(true);
    });
  });

  describe('isSelfDeclarationRequired', () => {
    it('is NOT required when no mismatch is declared (waiver off)', () => {
      expect(isSelfDeclarationRequired(false, false)).toBe(false);
    });

    it('is NOT required when no mismatch is declared (waiver on)', () => {
      expect(isSelfDeclarationRequired(true, false)).toBe(false);
    });

    it('IS required when a mismatch is declared and the waiver is OFF', () => {
      expect(isSelfDeclarationRequired(false, true)).toBe(true);
    });

    it('is WAIVED when a mismatch is declared and the waiver is ON', () => {
      expect(isSelfDeclarationRequired(true, true)).toBe(false);
    });

    it('treats an undefined waiver flag (features still loading) as OFF → self-declaration required on mismatch', () => {
      expect(isSelfDeclarationRequired(undefined, true)).toBe(true);
    });
  });
});
