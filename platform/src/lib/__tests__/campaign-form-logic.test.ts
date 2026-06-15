/**
 * campaign-form-logic.test.ts
 *
 * Pure-function unit tests for the new CALCULATED / conditional-visibility
 * additions to src/lib/campaign.ts.
 *
 * Style: AAA (Arrange / Act / Assert), one behaviour per `it()`,
 * no network/DB/clock — mirrors docs/plans/01-how-we-test.md.
 */

import { describe, it, expect } from 'vitest';
import {
  computeFormula,
  evaluateCondition,
  isFieldVisible,
  validateEnrollmentFormConfig,
  type VisibleWhen,
  type FormField,
  type EnrollmentFormConfig,
} from '../campaign';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeField(overrides: Partial<FormField>): FormField {
  return {
    id: 'f1',
    type: 'TEXT',
    label: 'Test',
    required: false,
    autoFillFromExcel: false,
    autoFillEditable: false,
    order: 0,
    ...overrides,
  };
}

function makeConfig(fields: FormField[]): EnrollmentFormConfig {
  return { captureGpsOnSubmit: false, requireOtp: false, fields };
}

// ─────────────────────────────────────────────────────────────────────────────
// computeFormula
// ─────────────────────────────────────────────────────────────────────────────

describe('computeFormula', () => {
  it('multiplies two field values', () => {
    const result = computeFormula('{a}*{b}', { a: 4, b: 5 });
    expect(result).toBe(20);
  });

  it('respects operator precedence: {a}+{b}*2 = a + (b*2)', () => {
    // a=3, b=4 → 3 + (4*2) = 11
    const result = computeFormula('{a}+{b}*2', { a: 3, b: 4 });
    expect(result).toBe(11);
  });

  it('handles parentheses: ({a}+{b})*2 = (a+b)*2', () => {
    // a=3, b=4 → (3+4)*2 = 14
    const result = computeFormula('({a}+{b})*2', { a: 3, b: 4 });
    expect(result).toBe(14);
  });

  it('computes modulo: {a}%{b}', () => {
    const result = computeFormula('{a}%{b}', { a: 10, b: 3 });
    expect(result).toBe(1);
  });

  it('treats missing/blank field as 0', () => {
    // {a} is missing from values → treated as 0; {b}=5 → 0*5 = 0
    const result = computeFormula('{a}*{b}', { b: 5 });
    expect(result).toBe(0);
  });

  it('treats blank string value as 0', () => {
    const result = computeFormula('{a}+10', { a: '' });
    expect(result).toBe(10);
  });

  it('treats non-numeric string value as 0', () => {
    const result = computeFormula('{a}+5', { a: 'hello' });
    expect(result).toBe(5);
  });

  it('returns null when dividing by zero', () => {
    const result = computeFormula('{a}/{b}', { a: 10, b: 0 });
    expect(result).toBeNull();
  });

  it('returns null when modulo divisor is zero', () => {
    const result = computeFormula('{a}%{b}', { a: 10, b: 0 });
    expect(result).toBeNull();
  });

  it('returns null for an empty formula', () => {
    expect(computeFormula('', {})).toBeNull();
  });

  it('returns null for a whitespace-only formula', () => {
    expect(computeFormula('   ', {})).toBeNull();
  });

  it('returns null for a formula containing an invalid character (semicolon)', () => {
    expect(computeFormula('{a};{b}', { a: 1, b: 2 })).toBeNull();
  });

  it('returns null for two adjacent field tokens with no operator (no silent concat)', () => {
    // {a}{b} with a=4,b=5 must NOT produce 45 — it is malformed → null.
    expect(computeFormula('{a}{b}', { a: 4, b: 5 })).toBeNull();
  });

  it('returns null for a formula that looks like a function call', () => {
    // e.g. "sqrt(4)" — "sqrt" contains letters which are not valid tokens
    expect(computeFormula('sqrt(4)', {})).toBeNull();
  });

  it('evaluates a simple addition with literal numbers', () => {
    expect(computeFormula('1 + 2', {})).toBe(3);
  });

  it('evaluates a subtraction', () => {
    expect(computeFormula('{a} - {b}', { a: 10, b: 4 })).toBe(6);
  });

  it('handles decimal field values', () => {
    // 1.5 * 2 = 3
    expect(computeFormula('{a} * 2', { a: '1.5' })).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateCondition
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateCondition', () => {
  it('eq: returns true when values match', () => {
    const cond: VisibleWhen = { fieldId: 'f1', op: 'eq', value: 'yes' };
    expect(evaluateCondition(cond, { f1: 'yes' })).toBe(true);
  });

  it('eq: returns false when values differ', () => {
    const cond: VisibleWhen = { fieldId: 'f1', op: 'eq', value: 'yes' };
    expect(evaluateCondition(cond, { f1: 'no' })).toBe(false);
  });

  it('neq: returns true when values differ', () => {
    const cond: VisibleWhen = { fieldId: 'f1', op: 'neq', value: 'yes' };
    expect(evaluateCondition(cond, { f1: 'no' })).toBe(true);
  });

  it('neq: returns false when values match', () => {
    const cond: VisibleWhen = { fieldId: 'f1', op: 'neq', value: 'yes' };
    expect(evaluateCondition(cond, { f1: 'yes' })).toBe(false);
  });

  it('contains: returns true when left includes value', () => {
    const cond: VisibleWhen = { fieldId: 'f1', op: 'contains', value: 'foo' };
    expect(evaluateCondition(cond, { f1: 'foobar' })).toBe(true);
  });

  it('contains: returns false when left does not include value', () => {
    const cond: VisibleWhen = { fieldId: 'f1', op: 'contains', value: 'baz' };
    expect(evaluateCondition(cond, { f1: 'foobar' })).toBe(false);
  });

  it('gt: returns true when left > right numerically', () => {
    const cond: VisibleWhen = { fieldId: 'f1', op: 'gt', value: '5' };
    expect(evaluateCondition(cond, { f1: '10' })).toBe(true);
  });

  it('gt: returns false when left <= right', () => {
    const cond: VisibleWhen = { fieldId: 'f1', op: 'gt', value: '10' };
    expect(evaluateCondition(cond, { f1: '5' })).toBe(false);
  });

  it('lt: returns true when left < right numerically', () => {
    const cond: VisibleWhen = { fieldId: 'f1', op: 'lt', value: '10' };
    expect(evaluateCondition(cond, { f1: '3' })).toBe(true);
  });

  it('lt: returns false when left >= right', () => {
    const cond: VisibleWhen = { fieldId: 'f1', op: 'lt', value: '3' };
    expect(evaluateCondition(cond, { f1: '10' })).toBe(false);
  });

  it('gt: returns false when field value is non-numeric (NaN)', () => {
    const cond: VisibleWhen = { fieldId: 'f1', op: 'gt', value: '5' };
    expect(evaluateCondition(cond, { f1: 'hello' })).toBe(false);
  });

  it('gt: returns false when condition value is non-numeric (NaN)', () => {
    const cond: VisibleWhen = { fieldId: 'f1', op: 'gt', value: 'xyz' };
    expect(evaluateCondition(cond, { f1: '10' })).toBe(false);
  });

  it('eq: treats undefined field value as empty string', () => {
    const cond: VisibleWhen = { fieldId: 'f1', op: 'eq', value: '' };
    expect(evaluateCondition(cond, {})).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isFieldVisible
// ─────────────────────────────────────────────────────────────────────────────

describe('isFieldVisible', () => {
  it('returns true when field has no visibleWhen (always visible)', () => {
    const field = makeField({ id: 'f1' });
    expect(isFieldVisible(field, {})).toBe(true);
  });

  it('returns true when condition is met', () => {
    const field = makeField({
      id: 'f2',
      visibleWhen: { fieldId: 'f1', op: 'eq', value: 'yes' },
    });
    expect(isFieldVisible(field, { f1: 'yes' })).toBe(true);
  });

  it('returns false when condition is not met', () => {
    const field = makeField({
      id: 'f2',
      visibleWhen: { fieldId: 'f1', op: 'eq', value: 'yes' },
    });
    expect(isFieldVisible(field, { f1: 'no' })).toBe(false);
  });

  it('returns false when the dependency field has no value and condition is eq non-empty', () => {
    const field = makeField({
      id: 'f2',
      visibleWhen: { fieldId: 'f1', op: 'eq', value: 'yes' },
    });
    expect(isFieldVisible(field, {})).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateEnrollmentFormConfig — new rules
// ─────────────────────────────────────────────────────────────────────────────

describe('validateEnrollmentFormConfig — CALCULATED / visibleWhen', () => {
  it('reports error when CALCULATED field has an empty formula', () => {
    const fields: FormField[] = [
      makeField({ id: 'c1', type: 'CALCULATED', label: 'Margin', formula: '' }),
    ];
    const errors = validateEnrollmentFormConfig(makeConfig(fields));
    expect(errors.some((e) => e.includes('formula cannot be empty'))).toBe(true);
  });

  it('reports error when CALCULATED formula references a non-existent field id', () => {
    const fields: FormField[] = [
      makeField({ id: 'c1', type: 'CALCULATED', label: 'Margin', formula: '{nonexistent} * 0.1' }),
    ];
    const errors = validateEnrollmentFormConfig(makeConfig(fields));
    expect(errors.some((e) => e.includes('unknown field id "nonexistent"'))).toBe(true);
  });

  it('reports no error when CALCULATED formula references a valid field id', () => {
    const fields: FormField[] = [
      makeField({ id: 'n1', type: 'NUMBER', label: 'Sales' }),
      makeField({ id: 'c1', type: 'CALCULATED', label: 'Margin', formula: '{n1} * 0.05', order: 1 }),
    ];
    const errors = validateEnrollmentFormConfig(makeConfig(fields));
    expect(errors.filter((e) => e.includes('formula'))).toHaveLength(0);
  });

  it('reports error when visibleWhen references a non-existent field id', () => {
    const fields: FormField[] = [
      makeField({
        id: 'f2',
        label: 'Conditional',
        visibleWhen: { fieldId: 'ghost', op: 'eq', value: 'yes' },
      }),
    ];
    const errors = validateEnrollmentFormConfig(makeConfig(fields));
    expect(errors.some((e) => e.includes('unknown field id "ghost"'))).toBe(true);
  });

  it('reports error when visibleWhen.fieldId === field.id (self-reference)', () => {
    const fields: FormField[] = [
      makeField({
        id: 'f1',
        label: 'Self',
        visibleWhen: { fieldId: 'f1', op: 'eq', value: 'yes' },
      }),
    ];
    const errors = validateEnrollmentFormConfig(makeConfig(fields));
    expect(errors.some((e) => e.includes('cannot depend on itself'))).toBe(true);
  });

  it('returns no errors for a valid config with CALCULATED + conditional fields', () => {
    const fields: FormField[] = [
      makeField({ id: 'n1', type: 'NUMBER', label: 'Qty', order: 0 }),
      makeField({
        id: 'n2',
        type: 'NUMBER',
        label: 'Price',
        order: 1,
        visibleWhen: { fieldId: 'n1', op: 'gt', value: '0' },
      }),
      makeField({
        id: 'c1',
        type: 'CALCULATED',
        label: 'Total',
        formula: '{n1} * {n2}',
        order: 2,
      }),
    ];
    const errors = validateEnrollmentFormConfig(makeConfig(fields));
    expect(errors).toHaveLength(0);
  });
});
