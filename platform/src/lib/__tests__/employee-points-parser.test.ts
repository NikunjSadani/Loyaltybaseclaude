import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  parseEmployeePointsUpload,
  toEmployeeUploadRows,
  type EmployeePointsRow,
} from '../employee-points-parser';
import { EMPLOYEE_POINTS_HEADERS } from '../employee-points-template';

// Build an .xlsx ArrayBuffer with the template layout: row0 title, row1 headers, row2+ data.
function sheetBuf(dataRows: (string | number)[][], headers: readonly string[] = EMPLOYEE_POINTS_HEADERS): ArrayBuffer {
  const aoa = [['Employee Points — title'], [...headers], ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Employee Points');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

const CAP = 50000;
const roster = (...codes: string[]) => new Set(codes);

describe('parseEmployeePointsUpload — header validation', () => {
  it('errors on a missing Employee Code column', () => {
    const buf = sheetBuf([], ['Nope', 'Employee Name', 'Points', 'Narration']);
    const r = parseEmployeePointsUpload(buf, { knownCodes: null, safetyCapPoints: CAP });
    expect(r.headerError).toMatch(/Employee Code/);
    expect(r.canProceed).toBe(false);
  });

  it('errors on a missing Points column', () => {
    const buf = sheetBuf([], ['Employee Code', 'Employee Name', 'Nope', 'Narration']);
    const r = parseEmployeePointsUpload(buf, { knownCodes: null, safetyCapPoints: CAP });
    expect(r.headerError).toMatch(/Points/);
  });

  it('errors on an unreadable buffer', () => {
    const r = parseEmployeePointsUpload(new ArrayBuffer(4), { knownCodes: null, safetyCapPoints: CAP });
    expect(r.headerError).toBeTruthy();
    expect(r.rows).toEqual([]);
  });
});

describe('parseEmployeePointsUpload — row validation', () => {
  it('credits a clean row and totals points (canProceed)', () => {
    const buf = sheetBuf([['EMP001', 'Alice', 100, 'Q4 bonus'], ['EMP002', 'Bob', 50, '']]);
    const r = parseEmployeePointsUpload(buf, { knownCodes: roster('EMP001', 'EMP002'), safetyCapPoints: CAP });
    expect(r.summary.ok).toBe(2);
    expect(r.summary.totalPoints).toBe(150);
    expect(r.hasErrors).toBe(false);
    expect(r.canProceed).toBe(true);
  });

  it('ignores a fully blank Employee Code row (no result row)', () => {
    const buf = sheetBuf([['', '', '', ''], ['EMP001', 'Alice', 10, '']]);
    const r = parseEmployeePointsUpload(buf, { knownCodes: roster('EMP001'), safetyCapPoints: CAP });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].employeeCode).toBe('EMP001');
  });

  it('SKIPs blank or zero points (nothing to credit, not an error)', () => {
    const buf = sheetBuf([['EMP001', 'Alice', '', ''], ['EMP002', 'Bob', 0, '']]);
    const r = parseEmployeePointsUpload(buf, { knownCodes: roster('EMP001', 'EMP002'), safetyCapPoints: CAP });
    expect(r.summary.skipped).toBe(2);
    expect(r.summary.ok).toBe(0);
    expect(r.canProceed).toBe(false); // no OK rows
    expect(r.rows.every((x) => x.status === 'SKIP')).toBe(true);
  });

  it('ERRORs an unknown code WHEN a roster is supplied', () => {
    const buf = sheetBuf([['GHOST', 'Nobody', 10, '']]);
    const r = parseEmployeePointsUpload(buf, { knownCodes: roster('EMP001'), safetyCapPoints: CAP });
    expect(r.summary.errors).toBe(1);
    expect(r.rows[0].errors[0]).toMatch(/not in the active roster/);
  });

  it('does NOT error an unknown code when the roster is unavailable (knownCodes=null → server validates)', () => {
    const buf = sheetBuf([['GHOST', 'Nobody', 10, '']]);
    const r = parseEmployeePointsUpload(buf, { knownCodes: null, safetyCapPoints: CAP });
    expect(r.summary.errors).toBe(0);
    expect(r.summary.ok).toBe(1);
    expect(r.canProceed).toBe(true);
  });

  it('ERRORs negative, non-integer, NaN, and over-cap points', () => {
    const buf = sheetBuf([
      ['EMP001', 'A', -5, ''],
      ['EMP002', 'B', 10.5, ''],
      ['EMP003', 'C', 'abc', ''],
      ['EMP004', 'D', CAP + 1, ''],
    ]);
    const r = parseEmployeePointsUpload(buf, { knownCodes: roster('EMP001', 'EMP002', 'EMP003', 'EMP004'), safetyCapPoints: CAP });
    expect(r.summary.errors).toBe(4);
    expect(r.rows[0].errors.join()).toMatch(/negative/);
    expect(r.rows[1].errors.join()).toMatch(/whole number/);
    expect(r.rows[2].errors.join()).toMatch(/valid number/);
    expect(r.rows[3].errors.join()).toMatch(/safety cap/);
    expect(r.canProceed).toBe(false);
  });

  it('ERRORs a SAME-CASE duplicate employee code on the second occurrence', () => {
    const buf = sheetBuf([['EMP001', 'A', 10, ''], ['EMP001', 'A dup', 20, '']]);
    const r = parseEmployeePointsUpload(buf, { knownCodes: roster('EMP001'), safetyCapPoints: CAP });
    expect(r.rows[0].status).toBe('OK');
    expect(r.rows[1].status).toBe('ERROR');
    expect(r.rows[1].errors.join()).toMatch(/Duplicate/);
  });

  it('does NOT flag codes differing only by case as duplicates (case-sensitive, matches the resolver)', () => {
    const buf = sheetBuf([['EMP001', 'A', 10, ''], ['emp001', 'B', 20, '']]);
    const r = parseEmployeePointsUpload(buf, { knownCodes: roster('EMP001', 'emp001'), safetyCapPoints: CAP });
    expect(r.rows[0].status).toBe('OK');
    expect(r.rows[1].status).toBe('OK'); // distinct employees — neither is a duplicate
    expect(r.summary.errors).toBe(0);
  });

  it('SKIPs a parsed zero expressed as "0.0"/"0.00" (not a silent OK-0 row — FE audit #4)', () => {
    const buf = sheetBuf([['EMP001', 'A', '0.0', ''], ['EMP002', 'B', '0.00', '']]);
    const r = parseEmployeePointsUpload(buf, { knownCodes: roster('EMP001', 'EMP002'), safetyCapPoints: CAP });
    expect(r.summary.skipped).toBe(2);
    expect(r.summary.ok).toBe(0);
    expect(r.rows.every((x) => x.status === 'SKIP')).toBe(true);
  });

  it('accepts comma-grouped numbers', () => {
    const buf = sheetBuf([['EMP001', 'A', '1,250', '']]);
    const r = parseEmployeePointsUpload(buf, { knownCodes: roster('EMP001'), safetyCapPoints: CAP });
    expect(r.rows[0].status).toBe('OK');
    expect(r.rows[0].points).toBe(1250);
  });
});

describe('toEmployeeUploadRows', () => {
  const base: EmployeePointsRow = {
    rowNum: 3, employeeCode: 'EMP001', employeeName: 'Alice', points: 100, narration: 'x', status: 'OK', errors: [],
  };

  it('maps to the UploadRowDto shape: outletId=employeeCode, POINTS field, whole-point amount', () => {
    const [row] = toEmployeeUploadRows([base]);
    expect(row).toMatchObject({
      rowNum: 3,
      outletId: 'EMP001',
      outletName: 'Alice',
      employeeCode: 'EMP001',
      fieldId: 'POINTS',
      fieldName: 'Points',
      amount: 100,
      awardType: 'POINTS',
      status: 'OK',
    });
  });

  it('carries a SKIP row with amount 0 and its skipReason (server filters amount>0)', () => {
    const skip: EmployeePointsRow = { ...base, points: 0, status: 'SKIP', skipReason: 'blank' };
    const [row] = toEmployeeUploadRows([skip]);
    expect(row.amount).toBe(0);
    expect(row.status).toBe('SKIP');
    expect((row as { skipReason?: string }).skipReason).toBe('blank');
  });

  it('falls back outletName to the code when the name is blank', () => {
    const [row] = toEmployeeUploadRows([{ ...base, employeeName: '' }]);
    expect(row.outletName).toBe('EMP001');
  });
});
