/// <reference types="vitest/globals" />
/**
 * TDD — SchemeSheet enrollment form wiring (pure logic layer)
 *
 * A: AdminPublishedScheme carries enrollmentFormConfig
 * B: getEnrollmentFields() — extracts fields safely
 * C: hasEnrollmentForm() — boolean gate
 */

import { describe, it, expect } from 'vitest';
import { type EnrollmentFormConfig, type FormField } from '@/lib/campaign';
import {
  hasEnrollmentForm,
  getEnrollmentFields,
  type AdminPublishedScheme,
} from '@/lib/schemes';

function makeField(overrides: Partial<FormField> = {}): FormField {
  return {
    id:               'f1',
    type:             'TEXT',
    label:            'Shop Name',
    required:         true,
    autoFillFromExcel: false,
    autoFillEditable: true,
    order:            0,
    ...overrides,
  };
}

function makeScheme(overrides: Partial<AdminPublishedScheme> = {}): AdminPublishedScheme {
  return {
    id:                       'sch_test',
    name:                     'Test Scheme',
    description:              'desc',
    period:                   "Jun '26",
    startDate:                '2026-06-01',
    endDate:                  '2026-06-30',
    acceptDeadline:           '2026-06-30T23:59:59',
    outletTargeting:          'ALL',
    targetedOutletIds:        [],
    requiresSelfRegistration: true,
    publishedAt:              '2026-06-01T00:00:00',
    status:                   'ACTIVE',
    ...overrides,
  };
}

describe('A — enrollmentFormConfig on AdminPublishedScheme', () => {
  it('A1: scheme without enrollmentFormConfig is valid', () => {
    const s = makeScheme();
    expect(s.enrollmentFormConfig).toBeUndefined();
  });

  it('A2: scheme accepts enrollmentFormConfig with fields', () => {
    const config: EnrollmentFormConfig = {
      captureGpsOnSubmit: false,
      requireOtp: false,
      fields: [makeField()],
    };
    const s = makeScheme({ enrollmentFormConfig: config });
    expect(s.enrollmentFormConfig?.fields).toHaveLength(1);
  });
});

describe('B — getEnrollmentFields()', () => {
  it('B1: returns empty array when no enrollmentFormConfig', () => {
    expect(getEnrollmentFields(makeScheme())).toEqual([]);
  });

  it('B2: returns empty array when fields is empty', () => {
    const s = makeScheme({
      enrollmentFormConfig: { captureGpsOnSubmit: false, requireOtp: false, fields: [] },
    });
    expect(getEnrollmentFields(s)).toEqual([]);
  });

  it('B3: returns fields sorted by order', () => {
    const f1 = makeField({ id: 'f1', order: 1, label: 'Second' });
    const f2 = makeField({ id: 'f2', order: 0, label: 'First'  });
    const s = makeScheme({
      enrollmentFormConfig: { captureGpsOnSubmit: false, requireOtp: false, fields: [f1, f2] },
    });
    const result = getEnrollmentFields(s);
    expect(result[0].label).toBe('First');
    expect(result[1].label).toBe('Second');
  });

  it('B4: returns all fields regardless of type', () => {
    const fields: FormField[] = [
      makeField({ id: 'f1', type: 'TEXT'        }),
      makeField({ id: 'f2', type: 'IMAGE'       }),
      makeField({ id: 'f3', type: 'GPS_POINT'   }),
      makeField({ id: 'f4', type: 'UPI_QR_SCAN' }),
      makeField({ id: 'f5', type: 'DATA_DISPLAY'}),
    ];
    const s = makeScheme({
      enrollmentFormConfig: { captureGpsOnSubmit: false, requireOtp: false, fields },
    });
    expect(getEnrollmentFields(s)).toHaveLength(5);
  });
});

describe('C — hasEnrollmentForm()', () => {
  it('C1: false when no enrollmentFormConfig', () => {
    expect(hasEnrollmentForm(makeScheme())).toBe(false);
  });

  it('C2: false when enrollmentFormConfig has empty fields', () => {
    const s = makeScheme({
      enrollmentFormConfig: { captureGpsOnSubmit: false, requireOtp: false, fields: [] },
    });
    expect(hasEnrollmentForm(s)).toBe(false);
  });

  it('C3: true when enrollmentFormConfig has at least one field', () => {
    const s = makeScheme({
      enrollmentFormConfig: {
        captureGpsOnSubmit: false,
        requireOtp: false,
        fields: [makeField()],
      },
    });
    expect(hasEnrollmentForm(s)).toBe(true);
  });
});
