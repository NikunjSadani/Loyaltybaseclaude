/**
 * Unit tests for enrollment-form.helper.ts (P4.2).
 *
 * Covers:
 *   A) validateFormSchema — pure structural validator
 *      1. Valid minimal form passes
 *      2. Valid full form (DROPDOWN, CALCULATED, visibleWhen) passes
 *      3. Non-object top-level rejected
 *      4. Missing / wrong-type top-level booleans rejected
 *      5. Empty fields array rejected
 *      6. Non-object field entry rejected
 *      7. Invalid field type rejected
 *      8. Empty label rejected
 *      9. Missing required field properties rejected
 *     10. DROPDOWN without options rejected
 *     11. CALCULATED without formula rejected
 *     12. CALCULATED with formula referencing unknown field id rejected
 *     13. visibleWhen referencing unknown field id rejected
 *     14. visibleWhen self-reference rejected
 *     15. visibleWhen invalid op rejected
 *     16. Duplicate field ids rejected
 *     17. Bad campaignType rejected (via DTO constant — checked here for coverage)
 *
 * Run: npx jest src/schemes/enrollment-form.helper.spec.ts
 */

import { validateFormSchema, CAMPAIGN_TYPES } from './enrollment-form.helper';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal valid TEXT field. */
const textField = (id: string, order = 0) => ({
  id,
  type: 'TEXT',
  label: 'A label',
  required: false,
  autoFillFromExcel: false,
  autoFillEditable: false,
  order,
});

/** A valid minimal EnrollmentFormSchema. */
const validMinimalSchema = () => ({
  captureGpsOnSubmit: false,
  requireOtp: false,
  fields: [textField('f1')],
});

// ─────────────────────────────────────────────────────────────────────────────
// A) validateFormSchema
// ─────────────────────────────────────────────────────────────────────────────

describe('validateFormSchema', () => {
  // ── 1. Valid minimal form ────────────────────────────────────────────────
  it('accepts a minimal valid schema (one TEXT field)', () => {
    expect(validateFormSchema(validMinimalSchema())).toEqual([]);
  });

  // ── 2. Valid full form ───────────────────────────────────────────────────
  it('accepts a full schema with DROPDOWN, CALCULATED, and visibleWhen', () => {
    const schema = {
      captureGpsOnSubmit: true,
      requireOtp: false,
      fields: [
        {
          id: 'f-name',
          type: 'TEXT',
          label: 'Outlet name',
          required: true,
          autoFillFromExcel: false,
          autoFillEditable: false,
          order: 0,
        },
        {
          id: 'f-type',
          type: 'DROPDOWN',
          label: 'Outlet type',
          required: true,
          autoFillFromExcel: false,
          autoFillEditable: false,
          options: ['SSS', 'WHOLESALER'],
          order: 1,
        },
        {
          id: 'f-score',
          type: 'CALCULATED',
          label: 'Score',
          required: false,
          autoFillFromExcel: false,
          autoFillEditable: false,
          formula: '{f-name} * 2',  // f-name resolves
          order: 2,
        },
        {
          id: 'f-gps',
          type: 'GPS_POINT',
          label: 'Location',
          required: true,
          autoFillFromExcel: false,
          autoFillEditable: false,
          visibleWhen: { fieldId: 'f-type', op: 'eq', value: 'SSS' },
          order: 3,
        },
      ],
    };
    expect(validateFormSchema(schema)).toEqual([]);
  });

  // ── 3. Non-object top-level ──────────────────────────────────────────────
  it('rejects a non-object top level (array)', () => {
    const errors = validateFormSchema([]);
    expect(errors).toContain('formSchema must be a JSON object.');
  });

  it('rejects null', () => {
    const errors = validateFormSchema(null);
    expect(errors).toContain('formSchema must be a JSON object.');
  });

  it('rejects a string', () => {
    const errors = validateFormSchema('{}');
    expect(errors).toContain('formSchema must be a JSON object.');
  });

  // ── 4. Wrong-type top-level booleans ────────────────────────────────────
  it('rejects captureGpsOnSubmit that is not a boolean', () => {
    const schema = { ...validMinimalSchema(), captureGpsOnSubmit: 'yes' };
    expect(validateFormSchema(schema)).toContain(
      'formSchema.captureGpsOnSubmit must be a boolean.',
    );
  });

  it('rejects requireOtp that is not a boolean', () => {
    const schema = { ...validMinimalSchema(), requireOtp: 1 };
    expect(validateFormSchema(schema)).toContain(
      'formSchema.requireOtp must be a boolean.',
    );
  });

  // ── 5. Empty fields array ────────────────────────────────────────────────
  it('rejects empty fields array', () => {
    const schema = { ...validMinimalSchema(), fields: [] };
    expect(validateFormSchema(schema)).toContain(
      'The enrollment form must have at least one field.',
    );
  });

  it('rejects non-array fields', () => {
    const schema = { ...validMinimalSchema(), fields: 'oops' };
    expect(validateFormSchema(schema)).toContain('formSchema.fields must be an array.');
  });

  // ── 6. Non-object field entry ────────────────────────────────────────────
  it('rejects a field entry that is not an object', () => {
    const schema = { ...validMinimalSchema(), fields: ['not-an-object'] };
    expect(validateFormSchema(schema)).toContain('Field 1: must be a JSON object.');
  });

  // ── 7. Invalid field type ────────────────────────────────────────────────
  it('rejects an unknown field type', () => {
    const schema = {
      ...validMinimalSchema(),
      fields: [{ ...textField('f1'), type: 'RICH_TEXT' }],
    };
    const errors = validateFormSchema(schema);
    expect(errors.some((e) => e.includes('type must be one of'))).toBe(true);
  });

  // ── 8. Empty label ───────────────────────────────────────────────────────
  it('rejects a field with an empty label', () => {
    const schema = {
      ...validMinimalSchema(),
      fields: [{ ...textField('f1'), label: '   ' }],
    };
    const errors = validateFormSchema(schema);
    expect(errors.some((e) => e.includes('label cannot be empty'))).toBe(true);
  });

  // ── 9. Missing required field properties (autoFillFromExcel not boolean) ─
  it('rejects a field missing autoFillFromExcel boolean', () => {
    const schema = {
      ...validMinimalSchema(),
      fields: [{ ...textField('f1'), autoFillFromExcel: 'yes' }],
    };
    const errors = validateFormSchema(schema);
    expect(errors.some((e) => e.includes('autoFillFromExcel must be a boolean'))).toBe(true);
  });

  it('rejects a field missing autoFillEditable boolean', () => {
    const schema = {
      ...validMinimalSchema(),
      fields: [{ ...textField('f1'), autoFillEditable: null }],
    };
    const errors = validateFormSchema(schema);
    expect(errors.some((e) => e.includes('autoFillEditable must be a boolean'))).toBe(true);
  });

  // ── 10. DROPDOWN without options ─────────────────────────────────────────
  it('rejects a DROPDOWN field with no options', () => {
    const schema = {
      ...validMinimalSchema(),
      fields: [{ ...textField('f1'), type: 'DROPDOWN', label: 'Pick one', options: [] }],
    };
    const errors = validateFormSchema(schema);
    expect(errors.some((e) => e.includes('DROPDOWN must have at least one option'))).toBe(true);
  });

  it('rejects a DROPDOWN field with missing options property', () => {
    const schema = {
      ...validMinimalSchema(),
      fields: [{ ...textField('f1'), type: 'DROPDOWN', label: 'Pick one' }],
    };
    const errors = validateFormSchema(schema);
    expect(errors.some((e) => e.includes('DROPDOWN must have at least one option'))).toBe(true);
  });

  // ── 11. CALCULATED without formula ───────────────────────────────────────
  it('rejects a CALCULATED field with no formula property', () => {
    const schema = {
      ...validMinimalSchema(),
      fields: [{ ...textField('f1'), type: 'CALCULATED', label: 'Calc' }],
    };
    const errors = validateFormSchema(schema);
    expect(
      errors.some((e) => e.includes('CALCULATED field must have a non-empty formula')),
    ).toBe(true);
  });

  it('rejects a CALCULATED field with empty-string formula', () => {
    const schema = {
      ...validMinimalSchema(),
      fields: [{ ...textField('f1'), type: 'CALCULATED', label: 'Calc', formula: '   ' }],
    };
    const errors = validateFormSchema(schema);
    expect(
      errors.some((e) => e.includes('CALCULATED field must have a non-empty formula')),
    ).toBe(true);
  });

  // ── 12. CALCULATED formula referencing unknown field id ──────────────────
  it('rejects a CALCULATED formula referencing an unknown field id', () => {
    const schema = {
      ...validMinimalSchema(),
      fields: [
        textField('f1'),
        { ...textField('f2', 1), type: 'CALCULATED', label: 'Calc', formula: '{f-unknown} * 2' },
      ],
    };
    const errors = validateFormSchema(schema);
    expect(
      errors.some((e) => e.includes('formula references unknown field id "f-unknown"')),
    ).toBe(true);
  });

  it('accepts a CALCULATED formula whose {ref} resolves', () => {
    const schema = {
      ...validMinimalSchema(),
      fields: [
        textField('f1'),
        { ...textField('f2', 1), type: 'CALCULATED', label: 'Calc', formula: '{f1} * 2' },
      ],
    };
    expect(validateFormSchema(schema)).toEqual([]);
  });

  // ── 13. visibleWhen referencing unknown field id ─────────────────────────
  it('rejects visibleWhen referencing an unknown field id', () => {
    const schema = {
      ...validMinimalSchema(),
      fields: [
        {
          ...textField('f1'),
          visibleWhen: { fieldId: 'ghost', op: 'eq', value: 'x' },
        },
      ],
    };
    const errors = validateFormSchema(schema);
    expect(
      errors.some((e) => e.includes('visibleWhen references unknown field id "ghost"')),
    ).toBe(true);
  });

  // ── 14. visibleWhen self-reference ───────────────────────────────────────
  it('rejects visibleWhen that references itself', () => {
    const schema = {
      ...validMinimalSchema(),
      fields: [
        {
          ...textField('f1'),
          visibleWhen: { fieldId: 'f1', op: 'eq', value: 'x' },
        },
      ],
    };
    const errors = validateFormSchema(schema);
    expect(errors.some((e) => e.includes('visibleWhen cannot depend on itself'))).toBe(true);
  });

  // ── 15. visibleWhen invalid op ───────────────────────────────────────────
  it('rejects visibleWhen with an invalid op', () => {
    const schema = {
      ...validMinimalSchema(),
      fields: [
        textField('f1'),
        {
          ...textField('f2', 1),
          visibleWhen: { fieldId: 'f1', op: 'STARTS_WITH', value: 'x' },
        },
      ],
    };
    const errors = validateFormSchema(schema);
    expect(errors.some((e) => e.includes('visibleWhen.op must be one of'))).toBe(true);
  });

  // ── 16. Duplicate field ids ───────────────────────────────────────────────
  it('rejects duplicate field ids', () => {
    const schema = {
      ...validMinimalSchema(),
      fields: [textField('f1'), textField('f1', 1)],
    };
    const errors = validateFormSchema(schema);
    expect(errors.some((e) => e.includes('duplicate field id "f1"'))).toBe(true);
  });

  // ── 17. CAMPAIGN_TYPES coverage ─────────────────────────────────────────
  it('CAMPAIGN_TYPES constant contains exactly the three valid values', () => {
    expect(CAMPAIGN_TYPES).toEqual(['LOYALTY_ONLY', 'OPEN_CAMPAIGN', 'MIXED']);
  });
});
