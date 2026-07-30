/**
 * Unit tests for validateSchemeFormSchema — the client-side mirror of the backend
 * form-schema validation used by the full-palette SchemeFormBuilder.
 */

import { describe, it, expect } from 'vitest';
import { validateSchemeFormSchema } from '../SchemeFormBuilder';
import type { EnrollmentFormSchema, FormField, FormFieldType } from '@/lib/scheme-types';

function field(type: FormFieldType, over: Partial<FormField> = {}): FormField {
  return {
    id: over.id ?? `f_${type}`,
    type,
    label: over.label ?? 'Label',
    required: over.required ?? false,
    order: over.order ?? 0,
    ...over,
  };
}

function schema(fields: FormField[], extra: Partial<EnrollmentFormSchema> = {}): EnrollmentFormSchema {
  return { captureGpsOnSubmit: false, requireOtp: false, fields, ...extra };
}

describe('validateSchemeFormSchema', () => {
  it('flags an empty form', () => {
    expect(validateSchemeFormSchema(schema([]))).toContain('Add at least one field.');
  });

  it('flags a blank field label', () => {
    const errs = validateSchemeFormSchema(schema([field('TEXT', { id: 'a', label: '' })]));
    expect(errs.some((e) => /label cannot be empty/i.test(e))).toBe(true);
  });

  it('requires options for choice fields', () => {
    const errs = validateSchemeFormSchema(schema([field('DROPDOWN', { id: 'a', options: [''] })]));
    expect(errs.some((e) => /add at least one option/i.test(e))).toBe(true);
  });

  it('accepts a valid dropdown', () => {
    const errs = validateSchemeFormSchema(schema([field('DROPDOWN', { id: 'a', options: ['Gold'] })]));
    expect(errs).toEqual([]);
  });

  it('requires a source for LOOKUP', () => {
    const errs = validateSchemeFormSchema(schema([
      field('DROPDOWN', { id: 'src', options: ['Gold'] }),
      field('LOOKUP', { id: 'lk', label: 'Slab' }),
    ]));
    expect(errs.some((e) => /pick a source dropdown/i.test(e))).toBe(true);
  });

  it('flags a CALCULATED formula referencing an unknown field', () => {
    const errs = validateSchemeFormSchema(schema([field('CALCULATED', { id: 'c', label: 'Total', formula: '{missing} * 2' })]));
    expect(errs.some((e) => /unknown field/i.test(e))).toBe(true);
  });

  it('requires a PHONE_OTP field when requireOtp is on', () => {
    const errs = validateSchemeFormSchema(schema([field('TEXT', { id: 'a' })], { requireOtp: true }));
    expect(errs.some((e) => /no Phone \(OTP\) field/i.test(e))).toBe(true);
  });

  it('is clean for a valid schema with PHONE_OTP + requireOtp', () => {
    const errs = validateSchemeFormSchema(schema([
      field('TEXT', { id: 'a', label: 'Owner name' }),
      field('PHONE_OTP', { id: 'p', label: 'Mobile', otpRequired: true }),
    ], { requireOtp: true }));
    expect(errs).toEqual([]);
  });

  it('flags captureGpsOnSubmit on with no GPS Location field', () => {
    const errs = validateSchemeFormSchema(schema([field('TEXT', { id: 'a' })], { captureGpsOnSubmit: true }));
    expect(errs.some((e) => /GPS/i.test(e))).toBe(true);
  });

  it('is clean when captureGpsOnSubmit is on AND a GPS field exists', () => {
    const errs = validateSchemeFormSchema(schema([
      field('TEXT', { id: 'a', label: 'Owner name' }),
      field('GPS_POINT', { id: 'g', label: 'Location' }),
    ], { captureGpsOnSubmit: true }));
    expect(errs).toEqual([]);
  });
});
