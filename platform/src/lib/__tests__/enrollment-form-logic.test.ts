/// <reference types="vitest/globals" />
/**
 * TDD — enrollment form logic (new functions in campaign.ts)
 *
 * Tests cover:
 *   H) filterFieldsByAudience
 *   I) validateFieldValues
 *   J) applyPrefillValues
 */

import {
  filterFieldsByAudience,
  validateFieldValues,
  applyPrefillValues,
  type FormField,
  type FieldAudience,
} from '../campaign';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeField = (
  id: string,
  audience: FieldAudience = 'ALL',
  required = false,
  type: FormField['type'] = 'TEXT',
  autoFillFromExcel = false,
  autoFillEditable = false,
): FormField => ({
  id,
  type,
  label: `Field ${id}`,
  required,
  audience,
  autoFillFromExcel,
  autoFillEditable,
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

// ── J) applyPrefillValues ─────────────────────────────────────────────────────

describe('applyPrefillValues', () => {
  it('returns empty record when no fields use auto-fill', () => {
    const field = makeField('f1', 'ALL', false, 'TEXT', false);
    const result = applyPrefillValues([field], { f1: 'ignored' });
    expect(result).toEqual({});
  });

  it('pre-fills auto-fill fields with values keyed by label', () => {
    const field: FormField = {
      id: 'f2',
      type: 'TEXT',
      label: 'Shop Area',
      required: false,
      audience: 'ALL',
      autoFillFromExcel: true,
      autoFillEditable: false,
      order: 0,
    };
    const result = applyPrefillValues([field], { 'Shop Area': '300 sqft' });
    expect(result['f2']).toBe('300 sqft');
  });

  it('includes editable auto-fill fields', () => {
    const field: FormField = {
      id: 'f3',
      type: 'TEXT',
      label: 'Last Month Sales',
      required: false,
      audience: 'ALL',
      autoFillFromExcel: true,
      autoFillEditable: true,
      order: 0,
    };
    const result = applyPrefillValues([field], { 'Last Month Sales': '₹1,24,500' });
    expect(result['f3']).toBe('₹1,24,500');
  });

  it('does not include non-auto-fill fields', () => {
    const regular = makeField('f4', 'ALL', false, 'TEXT', false);
    const auto: FormField = {
      id: 'f5',
      type: 'TEXT',
      label: 'GSTIN',
      required: false,
      audience: 'ALL',
      autoFillFromExcel: true,
      autoFillEditable: false,
      order: 1,
    };
    const result = applyPrefillValues([regular, auto], { GSTIN: '27AAPFU0939F1ZV' });
    expect(result['f4']).toBeUndefined();
    expect(result['f5']).toBe('27AAPFU0939F1ZV');
  });

  it('uses empty string when prefill key is missing from outlet data', () => {
    const field: FormField = {
      id: 'f6',
      type: 'TEXT',
      label: 'Missing Key',
      required: false,
      audience: 'ALL',
      autoFillFromExcel: true,
      autoFillEditable: false,
      order: 0,
    };
    const result = applyPrefillValues([field], {});
    expect(result['f6']).toBe('');
  });

  it('does not pre-fill DATA_DISPLAY fields (they are handled separately)', () => {
    const displayField: FormField = {
      id: 'dd1',
      type: 'DATA_DISPLAY',
      label: 'Outlet Score',
      required: false,
      audience: 'ALL',
      autoFillFromExcel: false,
      autoFillEditable: false,
      order: 0,
      dataDisplayKey: 'outlet_score',
    };
    // DATA_DISPLAY fields don't use autoFillFromExcel — they read directly from outlet data
    const result = applyPrefillValues([displayField], { outlet_score: '8.5' });
    expect(result['dd1']).toBeUndefined();
  });
});
