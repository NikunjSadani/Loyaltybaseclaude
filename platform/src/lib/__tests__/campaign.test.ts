/**
 * TDD — campaign.ts pure-function tests
 *
 * All functions under test are pure (no localStorage, no fetch).
 * Tests cover:
 *   A) isAlreadyEnrolled
 *   B) canEmployeeEnroll
 *   C) computeEnrollmentStats
 *   D) reorderFields
 *   E) validateEnrollmentFormConfig
 *   F) parseOutletExcelRow
 *   G) buildExcelExportRows
 */

import { describe, it, expect } from 'vitest';
import {
  isAlreadyEnrolled,
  canEmployeeEnroll,
  computeEnrollmentStats,
  reorderFields,
  validateEnrollmentFormConfig,
  parseOutletExcelRow,
  buildExcelExportRows,
  type OutletRecord,
  type EnrollmentRecord,
  type FormField,
  type EnrollmentFormConfig,
} from '../campaign';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const outlet1: OutletRecord = {
  outletId: 'O1',
  outletName: 'Sharma Kirana',
  outletType: 'SSS',
  state: 'Maharashtra',
  city: 'Mumbai',
  assignedEmployeeId: 'EMP-001',
  isKycEnrolled: true,
  prefillValues: {},
};

const outlet2: OutletRecord = {
  outletId: 'O2',
  outletName: 'Metro Store',
  outletType: 'WHOLESALER',
  state: 'Delhi',
  city: 'New Delhi',
  assignedEmployeeId: 'EMP-002',
  isKycEnrolled: true,
  prefillValues: {},
};

const outletNoEmployee: OutletRecord = {
  ...outlet1,
  outletId: 'O3',
  assignedEmployeeId: null,
};

const makeEnrollment = (overrides: Partial<EnrollmentRecord> = {}): EnrollmentRecord => ({
  enrollmentId: 'ENR-001',
  schemeId: 'SCH-001',
  outletId: 'O1',
  outletName: 'Sharma Kirana',
  outletType: 'SSS',
  state: 'Maharashtra',
  city: 'Mumbai',
  isKycEnrolled: true,
  assignedEmployeeId: 'EMP-001',
  assignedEmployeeName: 'Ravi Kumar',
  enrolledBy: 'EMPLOYEE',
  submittedAt: '2025-07-01T10:30:00Z',
  submissionGps: { lat: 19.076, lng: 72.877, accuracy: 15, capturedAt: '2025-07-01T10:30:00Z' },
  otpVerified: true,
  otpVerifiedAt: '2025-07-01T10:29:45Z',
  otpPhone: '9876543210',
  fieldValues: {},
  photoGeoTags: [],
  auditLog: [{ event: 'ENROLLED', actorId: 'EMP-001', timestamp: '2025-07-01T10:30:00Z', detail: 'Enrolled by employee' }],
  ...overrides,
});

const textField: FormField = {
  id: 'f1',
  type: 'TEXT',
  label: 'Shop Name',
  required: true,
  placeholder: '',
  autoFillFromExcel: false,
  autoFillEditable: false,
  order: 0,
};

const dropdownField: FormField = {
  id: 'f2',
  type: 'DROPDOWN',
  label: 'Shop Type',
  required: true,
  options: ['Kirana', 'Supermarket', 'Medical'],
  autoFillFromExcel: false,
  autoFillEditable: false,
  order: 1,
};

const gpsField: FormField = {
  id: 'f3',
  type: 'GPS_POINT',
  label: 'Shop Location',
  required: false,
  autoFillFromExcel: false,
  autoFillEditable: false,
  order: 2,
};

const imageField: FormField = {
  id: 'f4',
  type: 'IMAGE',
  label: 'Shop Photo',
  required: true,
  autoFillFromExcel: false,
  autoFillEditable: false,
  order: 3,
};

// ── A) isAlreadyEnrolled ──────────────────────────────────────────────────────

describe('isAlreadyEnrolled', () => {
  it('returns false for an empty enrollment list', () => {
    expect(isAlreadyEnrolled('SCH-001', 'O1', [])).toBe(false);
  });

  it('returns true when schemeId and outletId both match', () => {
    const enr = makeEnrollment({ schemeId: 'SCH-001', outletId: 'O1' });
    expect(isAlreadyEnrolled('SCH-001', 'O1', [enr])).toBe(true);
  });

  it('returns false when only schemeId matches', () => {
    const enr = makeEnrollment({ schemeId: 'SCH-001', outletId: 'O2' });
    expect(isAlreadyEnrolled('SCH-001', 'O1', [enr])).toBe(false);
  });

  it('returns false when only outletId matches', () => {
    const enr = makeEnrollment({ schemeId: 'SCH-002', outletId: 'O1' });
    expect(isAlreadyEnrolled('SCH-001', 'O1', [enr])).toBe(false);
  });

  it('returns true regardless of enrolledBy source (SELF or EMPLOYEE)', () => {
    const selfEnr = makeEnrollment({ enrolledBy: 'SELF' });
    expect(isAlreadyEnrolled('SCH-001', 'O1', [selfEnr])).toBe(true);
  });
});

// ── B) canEmployeeEnroll ──────────────────────────────────────────────────────

describe('canEmployeeEnroll', () => {
  it('returns true when employee is the assigned employee for the outlet', () => {
    expect(canEmployeeEnroll('EMP-001', outlet1)).toBe(true);
  });

  it('returns false when employee is not the assigned employee', () => {
    expect(canEmployeeEnroll('EMP-999', outlet1)).toBe(false);
  });

  it('returns false when the outlet has no assigned employee', () => {
    expect(canEmployeeEnroll('EMP-001', outletNoEmployee)).toBe(false);
  });

  it('is case-sensitive on employee ID', () => {
    expect(canEmployeeEnroll('emp-001', outlet1)).toBe(false);
  });
});

// ── C) computeEnrollmentStats ─────────────────────────────────────────────────

describe('computeEnrollmentStats', () => {
  const targeted = [outlet1, outlet2];
  const enrO1Employee = makeEnrollment({ outletId: 'O1', enrolledBy: 'EMPLOYEE', state: 'Maharashtra', otpVerified: true });
  const enrO2Self     = makeEnrollment({ enrollmentId: 'ENR-002', outletId: 'O2', enrolledBy: 'SELF', state: 'Delhi', otpVerified: false });

  it('returns zero stats when no enrollments', () => {
    const stats = computeEnrollmentStats(targeted, []);
    expect(stats.totalTargeted).toBe(2);
    expect(stats.totalEnrolled).toBe(0);
    expect(stats.enrollmentPct).toBe(0);
  });

  it('counts total enrolled correctly', () => {
    const stats = computeEnrollmentStats(targeted, [enrO1Employee, enrO2Self]);
    expect(stats.totalEnrolled).toBe(2);
  });

  it('computes enrollment percentage correctly', () => {
    const stats = computeEnrollmentStats(targeted, [enrO1Employee]);
    expect(stats.enrollmentPct).toBe(50);
  });

  it('returns 0% when there are no targeted outlets', () => {
    const stats = computeEnrollmentStats([], []);
    expect(stats.enrollmentPct).toBe(0);
  });

  it('distinguishes self-enrolled vs employee-enrolled', () => {
    const stats = computeEnrollmentStats(targeted, [enrO1Employee, enrO2Self]);
    expect(stats.employeeEnrolled).toBe(1);
    expect(stats.selfEnrolled).toBe(1);
  });

  it('counts OTP verified correctly', () => {
    const stats = computeEnrollmentStats(targeted, [enrO1Employee, enrO2Self]);
    expect(stats.otpVerifiedCount).toBe(1);
  });

  it('groups by state correctly', () => {
    const stats = computeEnrollmentStats(targeted, [enrO1Employee, enrO2Self]);
    const mh = stats.byState.find((s) => s.state === 'Maharashtra');
    const dl = stats.byState.find((s) => s.state === 'Delhi');
    expect(mh).toBeDefined();
    expect(mh?.enrolled).toBe(1);
    expect(dl?.enrolled).toBe(1);
  });

  it('enrollment pct rounds to integer', () => {
    // 1 out of 3 = 33.33% → 33
    const stats = computeEnrollmentStats([outlet1, outlet2, { ...outlet1, outletId: 'O3' }], [enrO1Employee]);
    expect(stats.enrollmentPct).toBe(33);
  });
});

// ── D) reorderFields ──────────────────────────────────────────────────────────

describe('reorderFields', () => {
  const fields: FormField[] = [textField, dropdownField, gpsField];

  it('moves a field forward (up in position)', () => {
    const result = reorderFields(fields, 2, 0); // move gpsField to front
    expect(result[0].id).toBe('f3');
    expect(result[1].id).toBe('f1');
    expect(result[2].id).toBe('f2');
  });

  it('moves a field backward (down in position)', () => {
    const result = reorderFields(fields, 0, 2); // move textField to end
    expect(result[0].id).toBe('f2');
    expect(result[1].id).toBe('f3');
    expect(result[2].id).toBe('f1');
  });

  it('updates the order property to match the new index', () => {
    const result = reorderFields(fields, 0, 2);
    result.forEach((f, i) => {
      expect(f.order).toBe(i);
    });
  });

  it('returns the same sequence when fromIndex equals toIndex', () => {
    const result = reorderFields(fields, 1, 1);
    expect(result.map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
  });

  it('does not mutate the original array', () => {
    const original = [...fields];
    reorderFields(fields, 0, 2);
    expect(fields.map((f) => f.id)).toEqual(original.map((f) => f.id));
  });
});

// ── E) validateEnrollmentFormConfig ──────────────────────────────────────────

describe('validateEnrollmentFormConfig', () => {
  const validConfig: EnrollmentFormConfig = {
    captureGpsOnSubmit: true,
    requireOtp: true,
    fields: [textField],
  };

  it('returns no errors for a valid config', () => {
    expect(validateEnrollmentFormConfig(validConfig)).toEqual([]);
  });

  it('returns an error when fields array is empty', () => {
    const cfg: EnrollmentFormConfig = { ...validConfig, fields: [] };
    const errors = validateEnrollmentFormConfig(cfg);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/field/i);
  });

  it('returns an error when a field has an empty label', () => {
    const cfg: EnrollmentFormConfig = {
      ...validConfig,
      fields: [{ ...textField, label: '' }],
    };
    const errors = validateEnrollmentFormConfig(cfg);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/label/i);
  });

  it('returns an error when a DROPDOWN field has no options', () => {
    const cfg: EnrollmentFormConfig = {
      ...validConfig,
      fields: [{ ...dropdownField, options: [] }],
    };
    const errors = validateEnrollmentFormConfig(cfg);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/option/i);
  });

  it('returns an error when a DROPDOWN field has undefined options', () => {
    const cfg: EnrollmentFormConfig = {
      ...validConfig,
      fields: [{ ...dropdownField, options: undefined }],
    };
    const errors = validateEnrollmentFormConfig(cfg);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('returns no error when captureGpsOnSubmit is false and no GPS field exists', () => {
    const cfg: EnrollmentFormConfig = {
      ...validConfig,
      captureGpsOnSubmit: false,
      fields: [textField],
    };
    expect(validateEnrollmentFormConfig(cfg)).toEqual([]);
  });

  it('accumulates multiple errors', () => {
    const cfg: EnrollmentFormConfig = {
      ...validConfig,
      fields: [
        { ...textField, label: '' },
        { ...dropdownField, options: [] },
      ],
    };
    expect(validateEnrollmentFormConfig(cfg).length).toBeGreaterThanOrEqual(2);
  });
});

// ── F) parseOutletExcelRow ────────────────────────────────────────────────────

describe('parseOutletExcelRow', () => {
  const existingIds = new Set(['O1', 'O2', 'O3']);

  it('resolves a KYC-enrolled outlet by outletId', () => {
    const result = parseOutletExcelRow(
      { outlet_id: 'O1', assigned_employee_id: 'EMP-001' },
      existingIds,
    );
    expect(result.error).toBeNull();
    expect(result.outlet).not.toBeNull();
    expect(result.outlet?.isKycEnrolled).toBe(true);
    expect(result.outlet?.outletId).toBe('O1');
    expect(result.outlet?.assignedEmployeeId).toBe('EMP-001');
  });

  it('creates a non-KYC outlet when outletId is not in the system', () => {
    const result = parseOutletExcelRow(
      {
        outlet_id: 'NEW-01',
        outlet_name: 'New Corner Shop',
        outlet_type: 'SSS',
        state: 'Gujarat',
        city: 'Surat',
        assigned_employee_id: 'EMP-005',
      },
      existingIds,
    );
    expect(result.error).toBeNull();
    expect(result.outlet?.isKycEnrolled).toBe(false);
    expect(result.outlet?.outletName).toBe('New Corner Shop');
  });

  it('returns error when non-KYC row is missing outlet_name', () => {
    const result = parseOutletExcelRow(
      { outlet_id: 'NEW-02', outlet_type: 'SSS', state: 'Gujarat', city: 'Surat' },
      existingIds,
    );
    expect(result.error).not.toBeNull();
    expect(result.error).toMatch(/outlet_name/i);
  });

  it('returns error when non-KYC row is missing state', () => {
    const result = parseOutletExcelRow(
      { outlet_id: 'NEW-03', outlet_name: 'Shop', outlet_type: 'SSS', city: 'Surat' },
      existingIds,
    );
    expect(result.error).not.toBeNull();
    expect(result.error).toMatch(/state/i);
  });

  it('returns error for an invalid outlet_type', () => {
    const result = parseOutletExcelRow(
      { outlet_id: 'NEW-04', outlet_name: 'Shop', outlet_type: 'INVALID', state: 'Gujarat', city: 'Surat' },
      existingIds,
    );
    expect(result.error).not.toBeNull();
    expect(result.error).toMatch(/outlet_type/i);
  });

  it('removes employee tag when assigned_employee_id is blank', () => {
    const result = parseOutletExcelRow(
      { outlet_id: 'O1', assigned_employee_id: '' },
      existingIds,
    );
    expect(result.outlet?.assignedEmployeeId).toBeNull();
  });

  it('is case-insensitive for outlet_type', () => {
    const result = parseOutletExcelRow(
      { outlet_id: 'NEW-05', outlet_name: 'Shop', outlet_type: 'SSS', state: 'Gujarat', city: 'Surat' },
      existingIds,
    );
    expect(result.error).toBeNull();
    expect(result.outlet?.outletType).toBe('SSS');
  });
});

// ── G) buildExcelExportRows ───────────────────────────────────────────────────

describe('buildExcelExportRows', () => {
  const enr = makeEnrollment({
    fieldValues: {
      f1: 'Sharma Kirana',          // TEXT
      f2: 'Kirana',                  // DROPDOWN
      f3: { lat: 19.076, lng: 72.877 }, // GPS_POINT
      f4: ['https://cdn/img1.jpg'],  // IMAGE
    },
    photoGeoTags: [{ fieldId: 'f4', photoIndex: 0, lat: 19.076, lng: 72.877, capturedAt: '2025-07-01T10:30:00Z' }],
    auditLog: [
      { event: 'ENROLLED', actorId: 'EMP-001', timestamp: '2025-07-01T10:30:00Z', detail: 'Enrolled by employee' },
      { event: 'OTP_VERIFIED', actorId: 'SYSTEM', timestamp: '2025-07-01T10:29:45Z', detail: 'OTP verified' },
    ],
  });

  const fields: FormField[] = [textField, dropdownField, gpsField, imageField];

  it('includes standard columns', () => {
    const rows = buildExcelExportRows([enr], fields);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row['Enrollment ID']).toBe('ENR-001');
    expect(row['Outlet ID']).toBe('O1');
    expect(row['Outlet Name']).toBe('Sharma Kirana');
    expect(row['OTP Verified']).toBe('Yes');
    expect(row['Enrolled By']).toBe('EMPLOYEE');
    expect(row['Submitted At']).toBe('2025-07-01T10:30:00Z');
  });

  it('includes GPS submission columns when GPS was captured', () => {
    const rows = buildExcelExportRows([enr], fields);
    expect(rows[0]['Submission GPS — Latitude']).toBe(19.076);
    expect(rows[0]['Submission GPS — Longitude']).toBe(72.877);
  });

  it('uses field label as column header for TEXT fields', () => {
    const rows = buildExcelExportRows([enr], fields);
    expect(rows[0]['Shop Name']).toBe('Sharma Kirana');
  });

  it('uses field label as column header for DROPDOWN fields', () => {
    const rows = buildExcelExportRows([enr], fields);
    expect(rows[0]['Shop Type']).toBe('Kirana');
  });

  it('splits GPS_POINT field into two columns (label_Lat, label_Lng)', () => {
    const rows = buildExcelExportRows([enr], fields);
    expect(rows[0]['Shop Location — Latitude']).toBe(19.076);
    expect(rows[0]['Shop Location — Longitude']).toBe(72.877);
  });

  it('includes image count and URLs for IMAGE fields', () => {
    const rows = buildExcelExportRows([enr], fields);
    expect(rows[0]['Shop Photo — Count']).toBe(1);
    expect(rows[0]['Shop Photo — URLs']).toContain('img1.jpg');
  });

  it('formats audit log as pipe-separated string', () => {
    const rows = buildExcelExportRows([enr], fields);
    const log = rows[0]['Audit Log'] as string;
    expect(log).toContain('ENROLLED');
    expect(log).toContain('OTP_VERIFIED');
    expect(log).toContain('|');
  });

  it('handles enrollments with missing field values gracefully', () => {
    const sparse = makeEnrollment({ fieldValues: {} });
    const rows = buildExcelExportRows([sparse], [textField]);
    expect(rows[0]['Shop Name']).toBe('');
  });
});
