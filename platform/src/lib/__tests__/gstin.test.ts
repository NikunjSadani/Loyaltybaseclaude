/**
 * TDD tests for GSTIN helpers (frontend GST format validation).
 *
 * Pure functions — no DOM, no browser APIs.
 *
 *   A) isValidGstin   — a 15-char structurally-valid GSTIN → true; blank/short/malformed → false
 *   B) panFromGstin   — extracts the embedded PAN (chars [2..11]) once length >= 12
 */

import { describe, it, expect } from 'vitest';
import { isValidGstin, panFromGstin, GSTIN_LENGTH } from '../gstin';

describe('isValidGstin', () => {
  it.each([
    ['27AAPFU0939F1Z5', true],  // canonical 15-char GSTIN
    ['29ABCDE1234F2Z6', true],
    ['07AAACR5055K1Z5', true],
  ])('accepts a valid 15-char GSTIN "%s"', (input, expected) => {
    expect(isValidGstin(input)).toBe(expected);
    expect(input.length).toBe(GSTIN_LENGTH);
  });

  it.each([
    ['',                false],  // blank → not valid (treated as "optional" by callers, no error)
    ['27AAPFU0939F',    false],  // 12 chars — too short
    ['27AAPFU0939F1',   false],  // 13 chars — too short
    ['27AAPFU0939F1Z',  false],  // 14 chars — too short
    ['27AAPFU0939F1Z55',false],  // 16 chars — too long
    ['AAPFU0939F1Z5XX',  false], // wrong shape (no leading 2 digits)
    ['27aapfu0939f1z5', false],  // lowercase — fails (input is upper-cased by the form before validation)
    ['271APFU0939F1Z5', false],  // digit where an entity letter must be
  ])('rejects an invalid GSTIN "%s"', (input, expected) => {
    expect(isValidGstin(input)).toBe(expected);
  });

  it('treats null/undefined as not valid', () => {
    expect(isValidGstin(null)).toBe(false);
    expect(isValidGstin(undefined)).toBe(false);
  });
});

describe('panFromGstin', () => {
  it('extracts the embedded PAN from a full GSTIN', () => {
    expect(panFromGstin('27AAPFU0939F1Z5')).toBe('AAPFU0939F');
  });

  it('extracts the PAN as soon as 12 characters are present', () => {
    expect(panFromGstin('27AAPFU0939F')).toBe('AAPFU0939F');
  });

  it('returns "" when fewer than 12 characters are present', () => {
    expect(panFromGstin('27AAPFU0939')).toBe('');
    expect(panFromGstin('27')).toBe('');
    expect(panFromGstin('')).toBe('');
  });

  it('handles null/undefined safely', () => {
    expect(panFromGstin(null)).toBe('');
    expect(panFromGstin(undefined)).toBe('');
  });
});
