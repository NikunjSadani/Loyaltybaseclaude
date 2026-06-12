/**
 * TDD tests for UPI utility functions.
 *
 * Pure functions — no DOM, no browser APIs.
 *
 * Covers:
 *   A) isValidUpiId  — validates a UPI Virtual Payment Address
 *   B) parseUpiFromQr — extracts a UPI VPA from QR code content
 */

import { describe, it, expect } from 'vitest';
import { isValidUpiId, parseUpiFromQr } from '../upi-utils';

/* ─── A: isValidUpiId ────────────────────────────────────────────────────────── */

describe('isValidUpiId', () => {
  it.each([
    ['9876543210@paytm',  true],
    ['user@okicici',      true],
    ['name.surname@ybl',  true],
    ['user-name@oksbi',   true],
    ['user_id@upi',       true],
    ['ab@cd',             true],  // minimal valid (2 + @ + 2)
  ])('accepts valid UPI "%s"', (input, expected) => {
    expect(isValidUpiId(input)).toBe(expected);
  });

  it.each([
    ['',                false],  // empty
    ['notaupi',         false],  // no @
    ['@provider',       false],  // empty localpart
    ['user@',           false],  // empty provider
    ['a@cd',            false],  // localpart too short (1 char)
    ['user@c',          false],  // provider only 1 char after first letter (needs 1+ more)
    ['user@@double',    false],  // double @
    ['https://example', false],  // URL
  ])('rejects invalid UPI "%s"', (input, expected) => {
    expect(isValidUpiId(input)).toBe(expected);
  });
});

/* ─── B: parseUpiFromQr ──────────────────────────────────────────────────────── */

describe('parseUpiFromQr', () => {
  describe('upi:// deep link', () => {
    it('extracts pa param from a standard UPI deep link', () => {
      expect(
        parseUpiFromQr('upi://pay?pa=9876543210@paytm&pn=Merchant&mc=0000'),
      ).toBe('9876543210@paytm');
    });

    it('extracts pa param when it appears after other params', () => {
      expect(
        parseUpiFromQr('upi://pay?pn=Name&mc=1234&pa=user@okicici'),
      ).toBe('user@okicici');
    });

    it('returns null for upi:// link with no pa param', () => {
      expect(parseUpiFromQr('upi://pay?pn=Name&mc=0000')).toBeNull();
    });

    it('returns null for upi:// link with invalid pa value', () => {
      expect(parseUpiFromQr('upi://pay?pa=notavalid')).toBeNull();
    });

    it('returns null for upi:// link with no query string', () => {
      expect(parseUpiFromQr('upi://pay')).toBeNull();
    });
  });

  describe('raw VPA string', () => {
    it('returns the VPA as-is for a valid raw UPI ID', () => {
      expect(parseUpiFromQr('user@ybl')).toBe('user@ybl');
    });

    it('trims whitespace from raw VPA', () => {
      expect(parseUpiFromQr('  user@paytm  ')).toBe('user@paytm');
    });

    it('returns null for a plain URL (not UPI)', () => {
      expect(parseUpiFromQr('https://example.com')).toBeNull();
    });

    it('returns null for an arbitrary non-UPI string', () => {
      expect(parseUpiFromQr('hello world')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseUpiFromQr('')).toBeNull();
    });
  });
});
