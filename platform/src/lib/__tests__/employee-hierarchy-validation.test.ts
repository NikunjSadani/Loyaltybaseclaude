/// <reference types="vitest/globals" />
/**
 * TDD — Employee Hierarchy Validation (pure logic, no DOM)
 *
 * H1–H5:   Header validation (Pass 1)
 * H6–H13:  Valid row scenarios (new employee, update, placeholder, NSM)
 * H14–H25: Row error cases
 * H26–H28: Edge cases (manager in same file, blank rows, circular deps)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateHeaders,
  validateEmployeeUpload,
  validatePhone,
  validateEmployeeId,
  resolveRole,
  parseUploadRows,
  REQUIRED_HEADERS,
  DEOLEO_HIERARCHY,
  type HierarchyEmployee,
  type EmployeeUploadRow,
} from '../employee-hierarchy';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const config = DEOLEO_HIERARCHY;

/** Minimal existing employee set for most tests */
const BASE_EMPLOYEES: HierarchyEmployee[] = [
  {
    id: 'NSM-01',   tenantId: 'deoleo', roleCode: 'NSM', roleLabel: 'NSM',
    reportsToId: null,       hierarchyPath: '/NSM-01/',
    name: 'Anand Rao',       mobile: '9900000001', status: 'ACTIVE',
    hasOutlets: false,       hasSubReports: true,
  },
  {
    id: 'ZNM-W1',   tenantId: 'deoleo', roleCode: 'ZNM', roleLabel: 'ZNM',
    reportsToId: 'NSM-01',   hierarchyPath: '/NSM-01/ZNM-W1/',
    name: 'Vikram Singh',    mobile: '9900000002', status: 'ACTIVE',
    hasOutlets: false,       hasSubReports: true,
  },
  {
    id: 'RSM-MH',   tenantId: 'deoleo', roleCode: 'RSM', roleLabel: 'RSM',
    reportsToId: 'ZNM-W1',  hierarchyPath: '/NSM-01/ZNM-W1/RSM-MH/',
    name: 'Suresh Nair',     mobile: '9900000003', status: 'ACTIVE',
    hasOutlets: false,       hasSubReports: true,
  },
  {
    id: 'ASM-MUM',  tenantId: 'deoleo', roleCode: 'ASM', roleLabel: 'ASM',
    reportsToId: 'RSM-MH',  hierarchyPath: '/NSM-01/ZNM-W1/RSM-MH/ASM-MUM/',
    name: 'Priya Mehta',     mobile: '9900000007', status: 'ACTIVE',
    hasOutlets: false,       hasSubReports: true,
  },
  {
    id: 'SO-MUM1',  tenantId: 'deoleo', roleCode: 'SO',  roleLabel: 'SO',
    reportsToId: 'ASM-MUM', hierarchyPath: '/NSM-01/ZNM-W1/RSM-MH/ASM-MUM/SO-MUM1/',
    name: 'Rajesh Kumar',    mobile: '9900000028', status: 'ACTIVE',
    hasOutlets: false,       hasSubReports: true,
  },
  {
    id: 'ISR-M001', tenantId: 'deoleo', roleCode: 'ISR', roleLabel: 'ISR',
    reportsToId: 'SO-MUM1', hierarchyPath: '/NSM-01/ZNM-W1/RSM-MH/ASM-MUM/SO-MUM1/ISR-M001/',
    name: 'Anil Sharma',     mobile: '9900000041', status: 'ACTIVE',
    hasOutlets: true,        hasSubReports: false,
  },
  {
    id: 'ISR-M002', tenantId: 'deoleo', roleCode: 'ISR', roleLabel: 'ISR',
    reportsToId: 'SO-MUM1', hierarchyPath: '/NSM-01/ZNM-W1/RSM-MH/ASM-MUM/SO-MUM1/ISR-M002/',
    name: null,              mobile: null,         status: 'PLACEHOLDER',
    hasOutlets: false,       hasSubReports: false,
  },
];

/** Helper: build a single valid upload row */
function makeRow(overrides: Partial<EmployeeUploadRow> = {}): EmployeeUploadRow {
  return {
    rowNum: 2,
    hierarchy: 'ISR',
    employeeId: 'ISR-P999',
    employeeName: 'Test Person',
    employeePhone: '9876500000',
    reportingManagerHierarchy: 'SO',
    reportingManagerEmployeeId: 'SO-MUM1',
    ...overrides,
  };
}

// L6 fix: clear localStorage before each test to prevent pollution between runs
beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

// ─── H1–H5: Header validation ─────────────────────────────────────────────────

describe('H1–H5 — Header validation (Pass 1)', () => {
  it('H1: all required headers present → no error', () => {
    expect(validateHeaders([...REQUIRED_HEADERS])).toBeNull();
  });

  it('H2: missing "Employee ID" → error names the missing column', () => {
    const headers = REQUIRED_HEADERS.filter(h => h !== 'Employee ID');
    const result = validateHeaders([...headers]);
    expect(result).not.toBeNull();
    expect(result).toContain('Employee ID');
  });

  it('H3: extra columns beyond required → accepted (no error)', () => {
    expect(validateHeaders([...REQUIRED_HEADERS, 'Extra Column', 'Notes'])).toBeNull();
  });

  it('H4: empty header array → error mentions first missing column', () => {
    const result = validateHeaders([]);
    expect(result).not.toBeNull();
    expect(result).toContain(REQUIRED_HEADERS[0]);
  });

  it('H5: headers with leading/trailing spaces → still accepted', () => {
    const padded = REQUIRED_HEADERS.map(h => `  ${h}  `);
    expect(validateHeaders([...padded])).toBeNull();
  });

  it('H29: multiple missing columns → ALL missing columns reported at once (not just first)', () => {
    // Remove two distinct required headers
    const headers = REQUIRED_HEADERS.filter(h => h !== 'Employee ID' && h !== 'Employee Phone Number');
    const result = validateHeaders([...headers]);
    expect(result).not.toBeNull();
    expect(result).toContain('Employee ID');
    expect(result).toContain('Employee Phone Number');
  });
});

// ─── H6–H13: Valid row scenarios ──────────────────────────────────────────────

describe('H6–H13 — Valid row scenarios', () => {
  it('H6: new employee with all fields → action CREATE, status OK', () => {
    const row = makeRow({ employeeId: 'ISR-NEW1', employeeName: 'New Person', employeePhone: '9876500001' });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.hasErrors).toBe(false);
    expect(result.rows[0].action).toBe('CREATE');
    expect(result.rows[0].status).toBe('OK');
  });

  it('H7: existing employee, same role and manager → action UPDATE_INFO', () => {
    const row = makeRow({
      employeeId: 'ISR-M001',
      hierarchy: 'ISR',
      employeeName: 'Anil Sharma Updated',
      employeePhone: '9900000041',   // same phone
      reportingManagerHierarchy: 'SO',
      reportingManagerEmployeeId: 'SO-MUM1',
    });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.hasErrors).toBe(false);
    expect(result.rows[0].action).toBe('UPDATE_INFO');
  });

  it('H8: blank name and phone → CREATE with PLACEHOLDER warning', () => {
    const row = makeRow({ employeeId: 'ISR-VACANT1', employeeName: '', employeePhone: '' });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.hasErrors).toBe(false);
    expect(result.rows[0].action).toBe('CREATE');
    expect(result.rows[0].status).toBe('WARNING');
    expect(result.rows[0].warnings.some(w => /placeholder/i.test(w))).toBe(true);
  });

  it('H9: NSM row with no manager columns → OK', () => {
    const row: EmployeeUploadRow = {
      rowNum: 2,
      hierarchy: 'NSM',
      employeeId: 'NSM-02',
      employeeName: 'New NSM',
      employeePhone: '9800000099',
      reportingManagerHierarchy: '',
      reportingManagerEmployeeId: '',
    };
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.hasErrors).toBe(false);
    expect(result.rows[0].action).toBe('CREATE');
  });

  it('H10: role names are case-insensitive ("isr" → valid ISR)', () => {
    const row = makeRow({ hierarchy: 'isr', employeeId: 'ISR-CASE1' });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.hasErrors).toBe(false);
  });

  it('H11: updating name on existing placeholder (ISR-M002) → UPDATE_INFO, no errors', () => {
    const row = makeRow({
      employeeId: 'ISR-M002',
      hierarchy: 'ISR',
      employeeName: 'Now Has Person',
      employeePhone: '9876500099',
      reportingManagerHierarchy: 'SO',
      reportingManagerEmployeeId: 'SO-MUM1',
    });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.hasErrors).toBe(false);
    expect(result.rows[0].action).toBe('UPDATE_INFO');
  });

  it('H12: multiple valid rows → summary totals correct', () => {
    const rows = [
      makeRow({ employeeId: 'ISR-N1', employeeName: 'Person A', employeePhone: '9111111111' }),
      makeRow({ employeeId: 'ISR-N2', employeeName: 'Person B', employeePhone: '9111111112' }),
      makeRow({ employeeId: 'ISR-M002', employeeName: 'Filled Placeholder', employeePhone: '9111111113',
                reportingManagerHierarchy: 'SO', reportingManagerEmployeeId: 'SO-MUM1' }),
    ];
    const result = validateEmployeeUpload(rows, BASE_EMPLOYEES, config);
    expect(result.hasErrors).toBe(false);
    expect(result.summary.creates).toBe(2);
    expect(result.summary.updates).toBe(1);
  });

  it('H13: canProceed is true when no errors exist', () => {
    const row = makeRow({ employeeId: 'ISR-OK', employeeName: 'Good Row', employeePhone: '9111222333' });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.canProceed).toBe(true);
  });
});

// ─── H14–H25: Error cases ─────────────────────────────────────────────────────

describe('H14–H25 — Row error cases', () => {
  it('H14: blank Employee ID → row error', () => {
    const row = makeRow({ employeeId: '' });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.rows[0].errors.some(e => /employee id is required/i.test(e))).toBe(true);
  });

  it('H15: Employee ID with spaces → row error (invalid characters)', () => {
    const row = makeRow({ employeeId: 'ISR M001' });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.rows[0].errors.some(e => /invalid characters/i.test(e))).toBe(true);
  });

  it('H16: duplicate Employee ID within upload → error on second row', () => {
    const row1 = makeRow({ rowNum: 2, employeeId: 'ISR-DUP', employeePhone: '9100000001' });
    const row2 = makeRow({ rowNum: 3, employeeId: 'ISR-DUP', employeePhone: '9100000002' });
    const result = validateEmployeeUpload([row1, row2], BASE_EMPLOYEES, config);
    // Second row should have the duplicate error
    const r2 = result.rows.find(r => r.rowNum === 3)!;
    expect(r2.errors.some(e => /duplicate employee id/i.test(e))).toBe(true);
    // First row should be fine (it's the first occurrence)
    const r1 = result.rows.find(r => r.rowNum === 2)!;
    expect(r1.errors.some(e => /duplicate employee id/i.test(e))).toBe(false);
  });

  it('H17: phone with 7 digits → row error', () => {
    const row = makeRow({ employeeId: 'ISR-X1', employeePhone: '1234567' });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.rows[0].errors.some(e => /10 digits/i.test(e))).toBe(true);
  });

  it('H18: phone with +91 prefix → row error (not 10 digits)', () => {
    const row = makeRow({ employeeId: 'ISR-X2', employeePhone: '+919876543210' });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.rows[0].errors.some(e => /10 digits/i.test(e))).toBe(true);
  });

  it('H19: duplicate phone across upload rows → error on second row', () => {
    const row1 = makeRow({ rowNum: 2, employeeId: 'ISR-PA', employeePhone: '9555000001' });
    const row2 = makeRow({ rowNum: 3, employeeId: 'ISR-PB', employeePhone: '9555000001' });
    const result = validateEmployeeUpload([row1, row2], BASE_EMPLOYEES, config);
    const r2 = result.rows.find(r => r.rowNum === 3)!;
    expect(r2.errors.some(e => /duplicated/i.test(e))).toBe(true);
  });

  it('H20: phone already registered to a different existing employee → error', () => {
    const row = makeRow({ employeeId: 'ISR-NEW99', employeePhone: '9900000041' }); // same as ISR-M001
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.rows[0].errors.some(e => /already registered/i.test(e))).toBe(true);
  });

  it('H21: invalid Hierarchy value → error listing valid options', () => {
    const row = makeRow({ hierarchy: 'MANAGER' });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.rows[0].errors.some(e => /not a valid hierarchy level/i.test(e))).toBe(true);
    // Error should list valid roles
    expect(result.rows[0].errors.some(e => /ISR/i.test(e))).toBe(true);
  });

  it('H22: manager Employee ID not in system or upload → error', () => {
    const row = makeRow({ reportingManagerEmployeeId: 'SO-GHOST' });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.rows[0].errors.some(e => /not found/i.test(e))).toBe(true);
  });

  it('H23: manager is correct ID but wrong level (ISR reporting to RSM, skipping SO and ASM) → error', () => {
    const row = makeRow({
      hierarchy: 'ISR',
      reportingManagerHierarchy: 'RSM',
      reportingManagerEmployeeId: 'RSM-MH',
    });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.rows[0].errors.some(e => /expected level/i.test(e))).toBe(true);
  });

  it('H24: Reporting Manager Hierarchy column contradicts manager\'s actual role → error', () => {
    // SO-MUM1 is actually a SO, but we claim it's an ASM
    const row = makeRow({
      hierarchy: 'ISR',
      reportingManagerHierarchy: 'ASM',    // wrong — SO-MUM1 is SO
      reportingManagerEmployeeId: 'SO-MUM1',
    });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.rows[0].errors.some(e => /actually/i.test(e))).toBe(true);
  });

  it('H25: NSM with a reporting manager specified → error', () => {
    const row: EmployeeUploadRow = {
      rowNum: 2,
      hierarchy: 'NSM',
      employeeId: 'NSM-02',
      employeeName: 'Second NSM',
      employeePhone: '9800000099',
      reportingManagerHierarchy: 'ZNM',
      reportingManagerEmployeeId: 'ZNM-W1',
    };
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.rows[0].errors.some(e => /root level/i.test(e))).toBe(true);
  });

  it('H25b: non-root employee with no reporting manager → error', () => {
    const row = makeRow({
      hierarchy: 'ISR',
      reportingManagerHierarchy: '',
      reportingManagerEmployeeId: '',
    });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.rows[0].errors.some(e => /required for ISR/i.test(e))).toBe(true);
  });
});

// ─── H26–H28: Business rules ──────────────────────────────────────────────────

describe('H26–H28 — Business rules', () => {
  it('H26: employee with outlets cannot change reporting manager → error', () => {
    // ISR-M001 has hasOutlets: true; try to move to a different SO
    const differentSO: HierarchyEmployee = {
      id: 'SO-MUM3', tenantId: 'deoleo', roleCode: 'SO', roleLabel: 'SO',
      reportsToId: 'ASM-MUM', hierarchyPath: '/NSM-01/ZNM-W1/RSM-MH/ASM-MUM/SO-MUM3/',
      name: 'New SO', mobile: '9900009999', status: 'ACTIVE',
      hasOutlets: false, hasSubReports: false,
    };
    const employees = [...BASE_EMPLOYEES, differentSO];

    const row = makeRow({
      employeeId: 'ISR-M001',
      hierarchy: 'ISR',
      employeeName: 'Anil Sharma',
      employeePhone: '9900000041',
      reportingManagerHierarchy: 'SO',
      reportingManagerEmployeeId: 'SO-MUM3', // changed manager
    });
    const result = validateEmployeeUpload([row], employees, config);
    expect(result.rows[0].errors.some(e => /has outlets assigned/i.test(e))).toBe(true);
  });

  it('H27: employee with sub-reports cannot change hierarchy → error (create replacement first)', () => {
    // SO-MUM1 has hasSubReports: true; try to move to different ASM
    const row: EmployeeUploadRow = {
      rowNum: 2,
      hierarchy: 'SO',
      employeeId: 'SO-MUM1',
      employeeName: 'Rajesh Kumar',
      employeePhone: '9900000028',
      reportingManagerHierarchy: 'ASM',
      reportingManagerEmployeeId: 'ASM-PUN', // changed from ASM-MUM
    };
    const asmPun: HierarchyEmployee = {
      id: 'ASM-PUN', tenantId: 'deoleo', roleCode: 'ASM', roleLabel: 'ASM',
      reportsToId: 'RSM-MH', hierarchyPath: '/NSM-01/ZNM-W1/RSM-MH/ASM-PUN/',
      name: 'Anita Desai', mobile: '9900000088', status: 'ACTIVE',
      hasOutlets: false, hasSubReports: true,
    };
    const employees = [...BASE_EMPLOYEES, asmPun];
    const result = validateEmployeeUpload([row], employees, config);
    expect(result.rows[0].errors.some(e => /replacement/i.test(e))).toBe(true);
  });

  it('H28: name/phone update on employee WITH outlets — hierarchy unchanged → OK', () => {
    // ISR-M001 has hasOutlets: true, but we're only updating phone
    const row = makeRow({
      employeeId: 'ISR-M001',
      hierarchy: 'ISR',
      employeeName: 'Anil Sharma Renamed',
      employeePhone: '9900000041',       // same phone, same manager
      reportingManagerHierarchy: 'SO',
      reportingManagerEmployeeId: 'SO-MUM1',
    });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.hasErrors).toBe(false);
    expect(result.rows[0].action).toBe('UPDATE_INFO');
  });
});

// ─── H29–H32: Edge cases ──────────────────────────────────────────────────────

describe('H29–H32 — Edge cases', () => {
  it('H29: manager defined later in same upload file → valid (two-pass safe)', () => {
    // SO-NEW1 appears in row 3; ISR references it in row 2
    const rows: EmployeeUploadRow[] = [
      {
        rowNum: 2,
        hierarchy: 'ISR',
        employeeId: 'ISR-LATEMGR',
        employeeName: 'Field Person',
        employeePhone: '9700000001',
        reportingManagerHierarchy: 'SO',
        reportingManagerEmployeeId: 'SO-NEW1',  // defined in row 3 below
      },
      {
        rowNum: 3,
        hierarchy: 'SO',
        employeeId: 'SO-NEW1',
        employeeName: 'New SO',
        employeePhone: '9700000002',
        reportingManagerHierarchy: 'ASM',
        reportingManagerEmployeeId: 'ASM-MUM',
      },
    ];
    const result = validateEmployeeUpload(rows, BASE_EMPLOYEES, config);
    expect(result.hasErrors).toBe(false);
  });

  it('H30: completely blank row is silently skipped', () => {
    const blankRow: EmployeeUploadRow = {
      rowNum: 3,
      hierarchy: '', employeeId: '', employeeName: '',
      employeePhone: '', reportingManagerHierarchy: '',
      reportingManagerEmployeeId: '',
    };
    const validRow = makeRow({ rowNum: 2, employeeId: 'ISR-VALID1', employeePhone: '9600000001' });
    const result = validateEmployeeUpload([validRow, blankRow], BASE_EMPLOYEES, config);
    expect(result.summary.total).toBe(1); // blank row not counted
    expect(result.hasErrors).toBe(false);
  });

  it('H31: circular dependency A→B, B→A → error on the row that creates the loop', () => {
    // Employee A reports to B; B reports to A  (circular)
    // Neither A nor B exist yet; both in this upload
    const rows: EmployeeUploadRow[] = [
      {
        rowNum: 2, hierarchy: 'ISR', employeeId: 'ISR-AA',
        employeeName: 'A', employeePhone: '9500000001',
        reportingManagerHierarchy: 'SO',
        reportingManagerEmployeeId: 'SO-BB',  // A reports to B
      },
      {
        rowNum: 3, hierarchy: 'SO', employeeId: 'SO-BB',
        employeeName: 'B', employeePhone: '9500000002',
        reportingManagerHierarchy: 'ASM',
        reportingManagerEmployeeId: 'ISR-AA', // B reports to A — loop!
      },
    ];
    const result = validateEmployeeUpload(rows, BASE_EMPLOYEES, config);
    // At least one of the rows should have a circular dependency error
    const hasCircularError = result.rows.some(r =>
      r.errors.some(e => /circular/i.test(e)),
    );
    expect(hasCircularError).toBe(true);
  });

  it('H32: canProceed is false when any row has errors', () => {
    const row = makeRow({ hierarchy: 'INVALID_ROLE' });
    const result = validateEmployeeUpload([row], BASE_EMPLOYEES, config);
    expect(result.canProceed).toBe(false);
  });
});

// ─── Utility function tests ───────────────────────────────────────────────────

describe('Utility functions', () => {
  it('validatePhone: 10-digit string → true', () => {
    expect(validatePhone('9876543210')).toBe(true);
  });
  it('validatePhone: blank → true (optional)', () => {
    expect(validatePhone('')).toBe(true);
    expect(validatePhone('  ')).toBe(true);
  });
  it('validatePhone: 9 digits → false', () => {
    expect(validatePhone('123456789')).toBe(false);
  });
  it('validatePhone: +91 prefix → false', () => {
    expect(validatePhone('+919876543210')).toBe(false);
  });

  it('validateEmployeeId: alphanumeric → true', () => {
    expect(validateEmployeeId('Pune101')).toBe(true);
    expect(validateEmployeeId('ISR-M001')).toBe(true);
    expect(validateEmployeeId('SO_PUN1')).toBe(true);
  });
  it('validateEmployeeId: spaces → false', () => {
    expect(validateEmployeeId('ISR M001')).toBe(false);
  });
  it('validateEmployeeId: comma → false', () => {
    expect(validateEmployeeId('ISR,M001')).toBe(false);
  });

  it('resolveRole: case-insensitive match', () => {
    expect(resolveRole('isr', DEOLEO_HIERARCHY)).not.toBeNull();
    expect(resolveRole('NSM', DEOLEO_HIERARCHY)).not.toBeNull();
    expect(resolveRole('GHOST', DEOLEO_HIERARCHY)).toBeNull();
  });

  it('parseUploadRows: maps raw objects to EmployeeUploadRow[]', () => {
    const raw = [
      {
        'Hierarchy': 'ISR', 'Employee ID': 'ISR-001', 'Employee Name': 'Test',
        'Employee Phone Number': '9876543210',
        'Reporting Manager Hierarchy': 'SO',
        'Reporting Manager Employee ID': 'SO-001',
      },
    ];
    const rows = parseUploadRows(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].employeeId).toBe('ISR-001');
    expect(rows[0].rowNum).toBe(2);
    expect(rows[0].hierarchy).toBe('ISR');
  });
});
