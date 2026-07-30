/// <reference types="vitest/globals" />
/**
 * TDD — enrollment form logic (new functions in campaign.ts)
 *
 * Tests cover:
 *   H) filterFieldsByAudience
 *   I) validateFieldValues
 */

import {
  filterFieldsByAudience,
  validateFieldValues,
  type FormField,
  type FieldAudience,
} from '../campaign';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeField = (
  id: string,
  audience: FieldAudience = 'ALL',
  required = false,
  type: FormField['type'] = 'TEXT',
): FormField => ({
  id,
  type,
  label: `Field ${id}`,
  required,
  audience,
  order: 0,
});

// ── H) filterFieldsByAudience ─────────────────────────────────────────────────

describe('filterFieldsByAudience', () => {
  const allField      = makeField('f-all',       'ALL');
  const loyaltyField  = makeField('f-loyalty',   'LOYALTY_MEMBERS');
  const nonKycField   = makeField('f-non-kyc',   'NON_LOYALTY_MEMBERS');
  const fields = [allField, loyaltyField, nonKycField];

  it('returns ALL fields for a loyalty member', () => {
    const result = filterFieldsByAudience(fields, true);
    expect(result.map((f) => f.id)).toEqual(['f-all', 'f-loyalty']);
  });

  it('returns ALL fields for a non-loyalty member', () => {
    const result = filterFieldsByAudience(fields, false);
    expect(result.map((f) => f.id)).toEqual(['f-all', 'f-non-kyc']);
  });

  it('returns only ALL-audience fields when there are no specific-audience fields', () => {
    const result = filterFieldsByAudience([allField], true);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('f-all');
  });

  it('returns empty array when no fields match audience', () => {
    const result = filterFieldsByAudience([loyaltyField, loyaltyField], false);
    expect(result).toHaveLength(0);
  });

  it('preserves original order of matched fields', () => {
    const ordered = [
      makeField('a', 'ALL'),
      makeField('b', 'LOYALTY_MEMBERS'),
      makeField('c', 'ALL'),
    ];
    const result = filterFieldsByAudience(ordered, true);
    expect(result.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('handles DATA_DISPLAY fields correctly — shown to correct audience', () => {
    const displayField = makeField('disp', 'LOYALTY_MEMBERS', false, 'DATA_DISPLAY');
    expect(filterFieldsByAudience([displayField], true)).toHaveLength(1);
    expect(filterFieldsByAudience([displayField], false)).toHaveLength(0);
  });

  it('handles UPI_QR_SCAN fields correctly', () => {
    const qrField = makeField('upi', 'ALL', true, 'UPI_QR_SCAN');
    expect(filterFieldsByAudience([qrField], true)).toHaveLength(1);
    expect(filterFieldsByAudience([qrField], false)).toHaveLength(1);
  });
});

// ── I) validateFieldValues ────────────────────────────────────────────────────

describe('validateFieldValues', () => {
  const reqText     = makeField('r1', 'ALL', true,  'TEXT');
  const optText     = makeField('o1', 'ALL', false, 'TEXT');
  const reqDropdown = makeField('r2', 'ALL', true,  'DROPDOWN');
  const reqUpi      = makeField('r3', 'ALL', true,  'UPI_QR_SCAN');
  const dataDisplay = makeField('dd', 'ALL', false, 'DATA_DISPLAY');

  it('returns valid + no missing when all required fields are filled', () => {
    const result = validateFieldValues(
      [reqText, optText],
      { r1: 'Hello', o1: '' },
    );
    expect(result.valid).toBe(true);
    expect(result.missingFieldIds).toHaveLength(0);
  });

  it('returns invalid when a required TEXT field is empty string', () => {
    const result = validateFieldValues([reqText], { r1: '' });
    expect(result.valid).toBe(false);
    expect(result.missingFieldIds).toContain('r1');
  });

  it('returns invalid when a required field has no value at all', () => {
    const result = validateFieldValues([reqText], {});
    expect(result.valid).toBe(false);
    expect(result.missingFieldIds).toContain('r1');
  });

  it('does not flag optional fields when empty', () => {
    const result = validateFieldValues([optText], { o1: '' });
    expect(result.valid).toBe(true);
  });

  it('does not flag optional fields when absent', () => {
    const result = validateFieldValues([optText], {});
    expect(result.valid).toBe(true);
  });

  it('accumulates all missing required field ids', () => {
    const result = validateFieldValues([reqText, reqDropdown], {});
    expect(result.missingFieldIds).toContain('r1');
    expect(result.missingFieldIds).toContain('r2');
  });

  it('does not flag DATA_DISPLAY fields as required (they are never user-filled)', () => {
    const result = validateFieldValues([dataDisplay], {});
    expect(result.valid).toBe(true);
  });

  it('validates UPI_QR_SCAN field — required and empty fails', () => {
    const result = validateFieldValues([reqUpi], { r3: '' });
    expect(result.valid).toBe(false);
    expect(result.missingFieldIds).toContain('r3');
  });

  it('validates UPI_QR_SCAN field — required and filled passes', () => {
    const result = validateFieldValues([reqUpi], { r3: '9876543210@paytm' });
    expect(result.valid).toBe(true);
  });

  it('treats null value as missing for required fields', () => {
    const result = validateFieldValues([reqText], { r1: null });
    expect(result.valid).toBe(false);
  });

  it('treats array with items as filled for IMAGE/CAMERA fields', () => {
    const imgField = makeField('img', 'ALL', true, 'IMAGE');
    const result = validateFieldValues([imgField], { img: ['blob:http://x'] });
    expect(result.valid).toBe(true);
  });

  it('treats empty array as missing for required IMAGE field', () => {
    const imgField = makeField('img', 'ALL', true, 'IMAGE');
    const result = validateFieldValues([imgField], { img: [] });
    expect(result.valid).toBe(false);
  });

  it('treats GPS object with lat+lng as filled', () => {
    const gpsField = makeField('gps', 'ALL', true, 'GPS_POINT');
    const result = validateFieldValues([gpsField], { gps: { lat: 19.076, lng: 72.877 } });
    expect(result.valid).toBe(true);
  });
});

// NOTE: the legacy `applyPrefillValues` (autoFill-gated, keyed by field label) was
// removed with the `autoFillFromExcel`/`autoFillEditable` FormField fields — roster
// prefill now flows through `prefillKey` + `PREFILLABLE_VALUE_FIELD_TYPES` in
// scheme-types.ts / SchemeFormRenderer. Its tests were removed accordingly.
