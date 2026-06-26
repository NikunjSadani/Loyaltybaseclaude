/// <reference types="vitest/globals" />
/**
 * buildRejectionReason — joins selected preset reasons (and an optional "Others"
 * free-text note) into the single string sent in the existing { reason } reject
 * payload. Shared by the sales senior-reject modal and the admin reviewer.
 */
import { describe, it, expect } from 'vitest';
import { buildRejectionReason, KYC_REJECTION_REASONS } from '../kyc-rejection-reasons';

describe('buildRejectionReason', () => {
  it('(a) joins multiple presets with "; "', () => {
    const [r1, r2] = KYC_REJECTION_REASONS;
    expect(buildRejectionReason([r1, r2], '')).toBe(`${r1}; ${r2}`);
  });

  it('(b) appends "Others: <text>" after the presets', () => {
    const [r1] = KYC_REJECTION_REASONS;
    expect(buildRejectionReason([r1], 'stamp missing')).toBe(`${r1}; Others: stamp missing`);
  });

  it('(c) builds "Others: <text>" when only otherText is given', () => {
    expect(buildRejectionReason([], 'wrong outlet')).toBe('Others: wrong outlet');
  });

  it('(d) ignores empty/whitespace otherText', () => {
    const [r1] = KYC_REJECTION_REASONS;
    expect(buildRejectionReason([r1], '')).toBe(r1);
    expect(buildRejectionReason([r1], '   ')).toBe(r1);
    expect(buildRejectionReason([], '')).toBe('');
  });

  it('(e) trims otherText before appending', () => {
    expect(buildRejectionReason([], '  padded reason  ')).toBe('Others: padded reason');
  });
});
