/// <reference types="vitest/globals" />
/**
 * TDD — scheme-types.ts pure form-logic helpers.
 *
 * These MUST mirror the backend (api/src/schemes/enrollment-form.helper.ts): the
 * renderer validates with the same rules the backend enforces at submit. Covers
 * visibility, conditional-required (D12b), formula, lookup (D12a), and the
 * type-aware submission validator.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateClause,
  isFieldVisible,
  isFieldRequired,
  evaluateFormula,
  resolveLookup,
  validateSchemeValues,
  orderedFields,
  type FormField,
  type EnrollmentFormSchema,
} from '../scheme-types';

const f = (o: Partial<FormField> & Pick<FormField, 'id' | 'type'>): FormField => ({
  label: `Field ${o.id}`,
  required: false,
  autoFillFromExcel: false,
  autoFillEditable: false,
  order: 0,
  ...o,
});

const schema = (fields: FormField[]): EnrollmentFormSchema => ({
  captureGpsOnSubmit: false,
  requireOtp: false,
  fields,
});

describe('evaluateClause / isFieldVisible', () => {
  it('eq / neq / contains', () => {
    expect(evaluateClause({ fieldId: 'a', op: 'eq', value: 'x' }, { a: 'x' })).toBe(true);
    expect(evaluateClause({ fieldId: 'a', op: 'neq', value: 'x' }, { a: 'y' })).toBe(true);
    expect(evaluateClause({ fieldId: 'a', op: 'contains', value: 'oo' }, { a: 'food' })).toBe(true);
  });
  it('gt / lt numeric', () => {
    expect(evaluateClause({ fieldId: 'a', op: 'gt', value: '5' }, { a: '6' })).toBe(true);
    expect(evaluateClause({ fieldId: 'a', op: 'lt', value: '5' }, { a: '6' })).toBe(false);
    expect(evaluateClause({ fieldId: 'a', op: 'gt', value: '5' }, { a: 'abc' })).toBe(false);
  });
  it('a field with no visibleWhen is always visible', () => {
    expect(isFieldVisible(f({ id: '1', type: 'TEXT' }), {})).toBe(true);
  });
  it('hidden when clause is false', () => {
    const field = f({ id: '2', type: 'TEXT', visibleWhen: { fieldId: 'a', op: 'eq', value: 'yes' } });
    expect(isFieldVisible(field, { a: 'no' })).toBe(false);
    expect(isFieldVisible(field, { a: 'yes' })).toBe(true);
  });
});

describe('isFieldRequired — conditional-required (D12b)', () => {
  it('required:true is always required', () => {
    expect(isFieldRequired(f({ id: '1', type: 'TEXT', required: true }), {})).toBe(true);
  });
  it('requiredWhen becomes required only while the clause is true', () => {
    const field = f({
      id: '2', type: 'TEXT', required: false,
      requiredWhen: { fieldId: 'a', op: 'eq', value: 'other' },
    });
    expect(isFieldRequired(field, { a: 'std' })).toBe(false);
    expect(isFieldRequired(field, { a: 'other' })).toBe(true);
  });
});

describe('evaluateFormula', () => {
  it('multiplies two field refs', () => {
    expect(evaluateFormula('{a} * {b}', { a: 3, b: 4 })).toBe(12);
  });
  it('non-numeric → null', () => {
    expect(evaluateFormula('{a} + {b}', { a: 'x', b: 4 })).toBeNull();
  });
  it('divide by zero → null', () => {
    expect(evaluateFormula('{a} / {b}', { a: 3, b: 0 })).toBeNull();
  });
  it('is N-ary, evaluated LEFT-TO-RIGHT with no operator precedence', () => {
    expect(evaluateFormula('{a} + {b} + {c}', { a: 1, b: 2, c: 3 })).toBe(6);
    expect(evaluateFormula('{a} - {b} - {c}', { a: 10, b: 3, c: 2 })).toBe(5);
    // (2 + 3) * 4 = 20 — NOT 2 + (3*4) = 14; no precedence.
    expect(evaluateFormula('{a} + {b} * {c}', { a: 2, b: 3, c: 4 })).toBe(20);
  });
  it('supports a signed operand and a bare single ref', () => {
    expect(evaluateFormula('{a}', { a: 7 })).toBe(7);
    expect(evaluateFormula('{a} * {b}', { a: -5, b: 3 })).toBe(-15);
  });
  it('a divide-by-zero anywhere in the chain → null', () => {
    expect(evaluateFormula('{a} + {b} / {c}', { a: 1, b: 4, c: 0 })).toBeNull();
  });
  it('malformed (trailing / missing operator) → null', () => {
    expect(evaluateFormula('{a} +', { a: 1 })).toBeNull();
    expect(evaluateFormula('{a} {b}', { a: 1, b: 2 })).toBeNull();
  });
});

describe('resolveLookup (D12a)', () => {
  it('maps the source field value through lookupMap', () => {
    const field = f({
      id: 'slab', type: 'LOOKUP',
      lookupSourceFieldId: 'tier',
      lookupMap: { Gold: '5% slab', Silver: '3% slab' },
    });
    expect(resolveLookup(field, { tier: 'Gold' })).toBe('5% slab');
    expect(resolveLookup(field, { tier: 'Bronze' })).toBeNull();
    expect(resolveLookup(field, {})).toBeNull();
  });
});

describe('validateSchemeValues', () => {
  it('flags a missing required field', () => {
    const errs = validateSchemeValues(schema([f({ id: 'name', type: 'TEXT', required: true })]), {});
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/required/i);
  });
  it('skips a hidden required field', () => {
    const errs = validateSchemeValues(
      schema([
        f({ id: 'gate', type: 'TEXT' }),
        f({ id: 'x', type: 'TEXT', required: true, visibleWhen: { fieldId: 'gate', op: 'eq', value: 'go' } }),
      ]),
      { gate: 'stop' },
    );
    expect(errs).toEqual([]);
  });
  it('enforces conditional-required only when the clause holds', () => {
    const s = schema([
      f({ id: 'kind', type: 'TEXT' }),
      f({ id: 'other', type: 'TEXT', requiredWhen: { fieldId: 'kind', op: 'eq', value: 'OTHER' } }),
    ]);
    expect(validateSchemeValues(s, { kind: 'A' })).toEqual([]);
    expect(validateSchemeValues(s, { kind: 'OTHER' }).length).toBe(1);
  });
  it('validates NUMBER / EMAIL / PHONE_OTP / TOGGLE shapes', () => {
    expect(validateSchemeValues(schema([f({ id: 'n', type: 'NUMBER' })]), { n: 'abc' }).length).toBe(1);
    expect(validateSchemeValues(schema([f({ id: 'e', type: 'EMAIL' })]), { e: 'bad' }).length).toBe(1);
    expect(validateSchemeValues(schema([f({ id: 'p', type: 'PHONE_OTP' })]), { p: '123' }).length).toBe(1);
    expect(validateSchemeValues(schema([f({ id: 't', type: 'TOGGLE', required: true })]), { t: false })).toEqual([]);
  });
  it('CALCULATED / LOOKUP / SECTION are server-owned or display — never blocking', () => {
    const s = schema([
      f({ id: 'c', type: 'CALCULATED', required: true, formula: '{a}' }),
      f({ id: 'l', type: 'LOOKUP', required: true, lookupSourceFieldId: 'a', lookupMap: { x: 'y' } }),
      f({ id: 'sec', type: 'SECTION', required: true }),
    ]);
    expect(validateSchemeValues(s, {})).toEqual([]);
  });
  it('MULTI_SELECT rejects an out-of-list option', () => {
    const s = schema([f({ id: 'm', type: 'MULTI_SELECT', options: ['A', 'B'] })]);
    expect(validateSchemeValues(s, { m: ['A', 'Z'] }).length).toBe(1);
    expect(validateSchemeValues(s, { m: ['A', 'B'] })).toEqual([]);
  });
  it('errors when captureGpsOnSubmit is on but the form has no GPS_POINT field', () => {
    const s: EnrollmentFormSchema = {
      captureGpsOnSubmit: true, requireOtp: false, fields: [f({ id: 't', type: 'TEXT' })],
    };
    expect(validateSchemeValues(s, { t: 'x' }).some((e) => /GPS/i.test(e))).toBe(true);
  });
  it('is clean when captureGpsOnSubmit is on AND a GPS_POINT field exists', () => {
    const s: EnrollmentFormSchema = {
      captureGpsOnSubmit: true, requireOtp: false, fields: [f({ id: 'g', type: 'GPS_POINT' })],
    };
    expect(validateSchemeValues(s, {})).toEqual([]);
  });
});

describe('orderedFields', () => {
  it('sorts by order', () => {
    const out = orderedFields(schema([f({ id: 'b', type: 'TEXT', order: 2 }), f({ id: 'a', type: 'TEXT', order: 1 })]));
    expect(out.map((x) => x.id)).toEqual(['a', 'b']);
  });
});
