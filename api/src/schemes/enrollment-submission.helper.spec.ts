/**
 * enrollment-submission.helper.spec.ts — P4.3
 *
 * Unit tests for the pure submission-time helpers added to enrollment-form.helper.ts:
 *   evaluateVisibleWhen  — field visibility predicate
 *   evaluateFormula      — CALCULATED field server-side evaluator
 *   validateSubmittedValues — full submission validator
 *
 * No DB calls; no NestJS test harness needed.
 *
 * Run: npx jest src/schemes/enrollment-submission.helper.spec.ts
 */

import {
  evaluateVisibleWhen,
  evaluateFormula,
  validateSubmittedValues,
  FormField,
  EnrollmentFormSchema,
} from './enrollment-form.helper';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function textField(id: string, required = false, order = 0): FormField {
  return {
    id,
    type: 'TEXT',
    label: `Label ${id}`,
    required,
    autoFillFromExcel: false,
    autoFillEditable: false,
    order,
  };
}

function numberField(id: string, required = false, order = 0): FormField {
  return { ...textField(id, required, order), type: 'NUMBER' };
}

function calcField(id: string, formula: string, order = 0): FormField {
  return {
    id,
    type: 'CALCULATED',
    label: `Calc ${id}`,
    required: false,
    autoFillFromExcel: false,
    autoFillEditable: false,
    formula,
    order,
  };
}

function schema(...fields: FormField[]): EnrollmentFormSchema {
  return { captureGpsOnSubmit: false, requireOtp: false, fields };
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateVisibleWhen
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateVisibleWhen', () => {
  it('returns true when there is no visibleWhen clause', () => {
    const f = textField('f1');
    expect(evaluateVisibleWhen(f, {})).toBe(true);
  });

  it('eq — returns true when the referenced field matches', () => {
    const f: FormField = {
      ...textField('f2'),
      visibleWhen: { fieldId: 'f1', op: 'eq', value: 'yes' },
    };
    expect(evaluateVisibleWhen(f, { f1: 'yes' })).toBe(true);
    expect(evaluateVisibleWhen(f, { f1: 'no' })).toBe(false);
  });

  it('neq — true when values differ', () => {
    const f: FormField = {
      ...textField('f2'),
      visibleWhen: { fieldId: 'f1', op: 'neq', value: 'hidden' },
    };
    expect(evaluateVisibleWhen(f, { f1: 'visible' })).toBe(true);
    expect(evaluateVisibleWhen(f, { f1: 'hidden' })).toBe(false);
  });

  it('gt — numeric greater-than', () => {
    const f: FormField = {
      ...textField('f2'),
      visibleWhen: { fieldId: 'qty', op: 'gt', value: '5' },
    };
    expect(evaluateVisibleWhen(f, { qty: '10' })).toBe(true);
    expect(evaluateVisibleWhen(f, { qty: '5' })).toBe(false);
    expect(evaluateVisibleWhen(f, { qty: '3' })).toBe(false);
  });

  it('lt — numeric less-than', () => {
    const f: FormField = {
      ...textField('f2'),
      visibleWhen: { fieldId: 'qty', op: 'lt', value: '10' },
    };
    expect(evaluateVisibleWhen(f, { qty: '5' })).toBe(true);
    expect(evaluateVisibleWhen(f, { qty: '10' })).toBe(false);
  });

  it('contains — substring match', () => {
    const f: FormField = {
      ...textField('f2'),
      visibleWhen: { fieldId: 'name', op: 'contains', value: 'shop' },
    };
    expect(evaluateVisibleWhen(f, { name: 'big shop' })).toBe(true);
    expect(evaluateVisibleWhen(f, { name: 'office' })).toBe(false);
  });

  it('returns false for gt/lt when referenced value is non-numeric', () => {
    const f: FormField = {
      ...textField('f2'),
      visibleWhen: { fieldId: 'qty', op: 'gt', value: '5' },
    };
    expect(evaluateVisibleWhen(f, { qty: 'abc' })).toBe(false);
  });

  it('treats a missing referenced field as empty string (eq "empty" → true)', () => {
    const f: FormField = {
      ...textField('f2'),
      visibleWhen: { fieldId: 'f1', op: 'eq', value: '' },
    };
    // f1 is absent → rawStr = '' → eq '' → true
    expect(evaluateVisibleWhen(f, {})).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateFormula
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateFormula', () => {
  it('evaluates a simple multiplication', () => {
    expect(evaluateFormula('{qty} * 2', { qty: '5' })).toBe(10);
  });

  it('evaluates addition of two field refs', () => {
    expect(evaluateFormula('{a} + {b}', { a: '3', b: '7' })).toBe(10);
  });

  it('evaluates subtraction', () => {
    expect(evaluateFormula('{a} - {b}', { a: '10', b: '4' })).toBe(6);
  });

  it('evaluates division', () => {
    expect(evaluateFormula('{a} / {b}', { a: '10', b: '4' })).toBeCloseTo(2.5);
  });

  it('returns null on division by zero', () => {
    expect(evaluateFormula('{a} / {b}', { a: '10', b: '0' })).toBeNull();
  });

  it('returns null when a referenced field is missing', () => {
    expect(evaluateFormula('{missing} * 2', {})).toBeNull();
  });

  it('returns null when a referenced field is non-numeric', () => {
    expect(evaluateFormula('{qty} * 2', { qty: 'abc' })).toBeNull();
  });

  it('handles a bare field reference (no operator)', () => {
    // {qty} alone → just its numeric value
    expect(evaluateFormula('{qty}', { qty: '42' })).toBe(42);
  });

  it('returns null for an empty field value', () => {
    expect(evaluateFormula('{qty} * 2', { qty: '' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateSubmittedValues
// ─────────────────────────────────────────────────────────────────────────────

describe('validateSubmittedValues', () => {
  // ── Required field present ─────────────────────────────────────────────
  it('accepts a required TEXT field with a non-empty value', () => {
    const s = schema(textField('name', true));
    const { errors } = validateSubmittedValues(s, { name: 'My Shop' });
    expect(errors).toHaveLength(0);
  });

  it('rejects a missing required TEXT field', () => {
    const s = schema(textField('name', true));
    const { errors } = validateSubmittedValues(s, {});
    expect(errors.some((e) => e.includes('name') && e.includes('required'))).toBe(true);
  });

  it('rejects an empty-string required field', () => {
    const s = schema(textField('name', true));
    const { errors } = validateSubmittedValues(s, { name: '   ' });
    expect(errors.some((e) => e.includes('required'))).toBe(true);
  });

  it('accepts an optional field that is absent', () => {
    const s = schema(textField('notes', false));
    const { errors } = validateSubmittedValues(s, {});
    expect(errors).toHaveLength(0);
  });

  // ── NUMBER type validation ─────────────────────────────────────────────
  it('accepts a valid number string', () => {
    const s = schema(numberField('qty', true));
    const { errors } = validateSubmittedValues(s, { qty: '42' });
    expect(errors).toHaveLength(0);
  });

  it('rejects a non-numeric value in a NUMBER field', () => {
    const s = schema(numberField('qty', false));
    const { errors } = validateSubmittedValues(s, { qty: 'abc' });
    expect(errors.some((e) => e.includes('valid number'))).toBe(true);
  });

  // ── DATE type validation ───────────────────────────────────────────────
  it('accepts a valid date string', () => {
    const dateF: FormField = { ...textField('dob', false), type: 'DATE' };
    const s = schema(dateF);
    const { errors } = validateSubmittedValues(s, { dob: '2025-06-01' });
    expect(errors).toHaveLength(0);
  });

  it('rejects an invalid date string', () => {
    const dateF: FormField = { ...textField('dob', false), type: 'DATE' };
    const s = schema(dateF);
    const { errors } = validateSubmittedValues(s, { dob: 'not-a-date' });
    expect(errors.some((e) => e.includes('valid date'))).toBe(true);
  });

  // ── visibleWhen-hidden fields not required ─────────────────────────────
  it('skips a required field that is hidden by visibleWhen', () => {
    const triggerField = textField('trigger', false);
    const hiddenRequired: FormField = {
      ...textField('hidden', true),
      visibleWhen: { fieldId: 'trigger', op: 'eq', value: 'show' },
    };
    const s = schema(triggerField, hiddenRequired);
    // trigger is absent/empty → hidden field's visibleWhen is false → not required
    const { errors } = validateSubmittedValues(s, { trigger: 'hide' });
    expect(errors).toHaveLength(0);
  });

  it('requires a field when its visibleWhen condition IS met', () => {
    const triggerField = textField('trigger', false);
    const conditionalRequired: FormField = {
      ...textField('shown', true),
      visibleWhen: { fieldId: 'trigger', op: 'eq', value: 'show' },
    };
    const s = schema(triggerField, conditionalRequired);
    const { errors } = validateSubmittedValues(s, { trigger: 'show' }); // shown but missing
    expect(errors.some((e) => e.includes('required'))).toBe(true);
  });

  // ── CALCULATED: server recompute, client value discarded ──────────────
  it('ignores the client-sent CALCULATED value and returns the server result', () => {
    const qty = numberField('qty', true);
    const scoreCalc = calcField('score', '{qty} * 3');
    const s = schema(qty, scoreCalc);

    const { errors, recomputedValues } = validateSubmittedValues(s, {
      qty: '4',
      score: '9999', // tampered
    });

    expect(errors).toHaveLength(0);
    expect(recomputedValues.score).toBe(12); // 4 * 3
  });

  it('sets recomputedValues to null when the formula cannot be evaluated', () => {
    const qty = numberField('qty', true);
    const scoreCalc = calcField('score', '{qty} * 3');
    const s = schema(qty, scoreCalc);

    const { recomputedValues } = validateSubmittedValues(s, {
      qty: 'not-a-number',
      score: '0',
    });

    expect(recomputedValues.score).toBeNull();
  });

  // ── DATA_DISPLAY skipped entirely ─────────────────────────────────────
  it('skips DATA_DISPLAY fields (not required, not validated)', () => {
    const displayF: FormField = {
      ...textField('info', true), // even if marked required, should be skipped
      type: 'DATA_DISPLAY',
    };
    const s = schema(displayF);
    const { errors } = validateSubmittedValues(s, {});
    expect(errors).toHaveLength(0);
  });

  // ── null / undefined submitted ─────────────────────────────────────────
  it('treats null submitted as an empty object', () => {
    const s = schema(textField('x', false));
    const { errors } = validateSubmittedValues(s, null);
    expect(errors).toHaveLength(0);
  });

  it('treats undefined submitted as an empty object', () => {
    const s = schema(textField('x', false));
    const { errors } = validateSubmittedValues(s, undefined);
    expect(errors).toHaveLength(0);
  });

  // ── autoFillFromExcel: pre-filled values accepted ─────────────────────
  it('accepts a required autoFillFromExcel field that arrives pre-filled', () => {
    const prefilled: FormField = {
      ...textField('shopCode', true),
      autoFillFromExcel: true,
    };
    const s = schema(prefilled);
    const { errors } = validateSubmittedValues(s, { shopCode: 'SH001' });
    expect(errors).toHaveLength(0);
  });

  it('still requires a required autoFillFromExcel field if not provided', () => {
    // autoFillFromExcel means "allowed to be pre-filled", not "optional".
    const prefilled: FormField = {
      ...textField('shopCode', true),
      autoFillFromExcel: true,
    };
    const s = schema(prefilled);
    const { errors } = validateSubmittedValues(s, {});
    expect(errors.some((e) => e.includes('required'))).toBe(true);
  });
});
