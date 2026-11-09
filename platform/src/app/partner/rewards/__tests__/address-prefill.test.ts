/**
 * applyAddressPrefill — the "pre-fill NEVER overwrites what the partner typed" rule, in one pure
 * function (PLATFORM-WIDE, outlet address only).
 */
import { describe, it, expect } from 'vitest';
import { applyAddressPrefill, type AddressForm } from '@/lib/address-prefill';

const EMPTY: AddressForm = { line1: '', city: '', state: '', pincode: '' };
const FULL = { line1: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' };

describe('applyAddressPrefill', () => {
  it('fills every empty field from a full outlet address', () => {
    expect(applyAddressPrefill(EMPTY, {}, FULL)).toEqual(FULL);
  });

  it('returns the same object when there are no defaults (nothing on file)', () => {
    expect(applyAddressPrefill(EMPTY, {}, null)).toBe(EMPTY);
    expect(applyAddressPrefill(EMPTY, {}, undefined)).toBe(EMPTY);
  });

  it('leaves a field empty when its default is not on file (partial address)', () => {
    expect(applyAddressPrefill(EMPTY, {}, { ...FULL, pincode: null })).toEqual({
      line1: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '',
    });
  });

  it('never overwrites a field the partner already typed in', () => {
    const form = { ...EMPTY, city: 'Mumbai' };
    expect(applyAddressPrefill(form, { city: true }, FULL)).toEqual({
      line1: '12 MG Road', city: 'Mumbai', state: 'Maharashtra', pincode: '411001',
    });
  });

  it('respects a field the partner deliberately cleared', () => {
    expect(applyAddressPrefill(EMPTY, { line1: true }, FULL).line1).toBe('');
  });

  it('never replaces a non-empty field even if it is untouched', () => {
    const form = { ...EMPTY, pincode: '400001' };
    expect(applyAddressPrefill(form, {}, FULL).pincode).toBe('400001');
  });

  it('is idempotent: re-applying the same defaults returns the same object', () => {
    const once = applyAddressPrefill(EMPTY, {}, FULL);
    expect(applyAddressPrefill(once, {}, FULL)).toBe(once);
  });
});
