/// <reference types="vitest/globals" />
/**
 * TDD — Hierarchy Chain Upload (denormalized 18-column format)
 *
 * HC  — Header validation
 * HP  — Happy-path parse (clean rows)
 * HB  — Missing ID errors (B-rules)
 * HA  — Cross-row conflict errors (A-rules)
 * HX  — Same-ID collision errors (C-rules)
 * HR  — Error report generation
 */

import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  getHierarchyChainHeaders,
  validateHierarchyChainHeaders,
  parseHierarchyChainRows,
  generateHierarchyChainErrorReport,
  DEOLEO_HIERARCHY,
} from '../employee-hierarchy';

const config = DEOLEO_HIERARCHY; // XSR(1) → SO(2) → ASM(3) → RSM(4) → ZNM(5) → NSM(6)

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/** Build a complete, valid raw row (all 18 fields populated) */
function makeRow(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    'XSR ID': 'XSR-001', 'XSR Name': 'Anil Sharma',   'XSR Phone': '9900000001',
    'SO ID':  'SO-001',  'SO Name':  'Rajesh Kumar',  'SO Phone':  '9900000002',
    'ASM ID': 'ASM-001', 'ASM Name': 'Priya Mehta',   'ASM Phone': '9900000003',
    'RSM ID': 'RSM-001', 'RSM Name': 'Suresh Nair',   'RSM Phone': '9900000004',
    'ZNM ID': 'ZNM-001', 'ZNM Name': 'Vikram Singh',  'ZNM Phone': '9900000005',
    'NSM ID': 'NSM-001', 'NSM Name': 'Anand Rao',     'NSM Phone': '9900000006',
    ...overrides,
  };
}

/** Second XSR in a different chain (shares upper managers) */
function makeRow2(): Record<string, string> {
  return makeRow({
    'XSR ID': 'XSR-002', 'XSR Name': 'Deepa Nair', 'XSR Phone': '9900000011',
  });
}

// ─── HC: Header validation ────────────────────────────────────────────────────

describe('HC — getHierarchyChainHeaders', () => {
  it('HC1: returns exactly 18 column names for DEOLEO_HIERARCHY', () => {
    const headers = getHierarchyChainHeaders(config);
    expect(headers).toHaveLength(18);
  });

  it('HC2: column names follow "{ROLE} ID / {ROLE} Name / {ROLE} Phone" pattern for each level', () => {
    const headers = getHierarchyChainHeaders(config);
    expect(headers).toEqual([
      'XSR ID', 'XSR Name', 'XSR Phone',
      'SO ID',  'SO Name',  'SO Phone',
      'ASM ID', 'ASM Name', 'ASM Phone',
      'RSM ID', 'RSM Name', 'RSM Phone',
      'ZNM ID', 'ZNM Name', 'ZNM Phone',
      'NSM ID', 'NSM Name', 'NSM Phone',
    ]);
  });
});

describe('HC — validateHierarchyChainHeaders', () => {
  it('HC3: returns null when all 18 expected columns are present', () => {
    const headers = getHierarchyChainHeaders(config);
    expect(validateHierarchyChainHeaders(headers, config)).toBeNull();
  });

  it('HC4: returns an error string listing missing columns when some are absent', () => {
    const err = validateHierarchyChainHeaders(['XSR ID', 'SO ID'], config);
    expect(err).toMatch(/missing/i);
    expect(err).toMatch(/XSR Name/);
  });

  it('HC5: returns an error string when the list is completely empty', () => {
    const err = validateHierarchyChainHeaders([], config);
    expect(err).not.toBeNull();
    expect(err).toMatch(/missing/i);
  });
});

// ─── HP: Happy-path parse ─────────────────────────────────────────────────────

describe('HP — parseHierarchyChainRows happy path', () => {
  it('HP1: a single clean row produces 6 EmployeeUploadRows (one per level)', () => {
    const result = parseHierarchyChainRows([makeRow()], config);
    expect(result.hasErrors).toBe(false);
    expect(result.chainErrors).toHaveLength(0);
    expect(result.employeeRows).toHaveLength(6);
  });

  it('HP2: NSM row has blank reportingManagerEmployeeId (root level has no parent)', () => {
    const result = parseHierarchyChainRows([makeRow()], config);
    const nsm = result.employeeRows.find(r => r.hierarchy === 'NSM');
    expect(nsm).toBeDefined();
    expect(nsm!.reportingManagerEmployeeId).toBe('');
    expect(nsm!.reportingManagerHierarchy).toBe('');
  });

  it('HP3: ISR row has reportingManagerEmployeeId = SO ID from the same row', () => {
    const result = parseHierarchyChainRows([makeRow()], config);
    const isr = result.employeeRows.find(r => r.hierarchy === 'XSR');
    expect(isr!.reportingManagerEmployeeId).toBe('SO-001');
    expect(isr!.reportingManagerHierarchy).toBe('SO');
  });

  it('HP4: two rows sharing upper managers produce 7 unique EmployeeUploadRows (not 12)', () => {
    // row1: ISR-001 under SO-001/ASM-001/...
    // row2: ISR-002 under same SO-001/ASM-001/...
    // upper managers are deduplicated → 2 ISRs + 1 each of SO/ASM/RSM/ZNM/NSM = 7
    const result = parseHierarchyChainRows([makeRow(), makeRow2()], config);
    expect(result.hasErrors).toBe(false);
    expect(result.employeeRows).toHaveLength(7);
  });

  it('HP5: a completely blank row is silently skipped', () => {
    const blankRow: Record<string, string> = {
      'XSR ID': '', 'XSR Name': '', 'XSR Phone': '',
      'SO ID':  '', 'SO Name':  '', 'SO Phone':  '',
      'ASM ID': '', 'ASM Name': '', 'ASM Phone': '',
      'RSM ID': '', 'RSM Name': '', 'RSM Phone': '',
      'ZNM ID': '', 'ZNM Name': '', 'ZNM Phone': '',
      'NSM ID': '', 'NSM Name': '', 'NSM Phone': '',
    };
    const result = parseHierarchyChainRows([blankRow], config);
    expect(result.hasErrors).toBe(false);
    expect(result.employeeRows).toHaveLength(0);
  });

  it('HP6: B4 — ID present but Name and Phone blank is acceptable (PLACEHOLDER)', () => {
    // XSR has ID but no name/phone — vacant position, valid
    const row = makeRow({ 'XSR Name': '', 'XSR Phone': '' });
    const result = parseHierarchyChainRows([row], config);
    expect(result.hasErrors).toBe(false);
    const isr = result.employeeRows.find(r => r.hierarchy === 'XSR');
    expect(isr!.employeeName).toBe('');
    expect(isr!.employeePhone).toBe('');
  });
});

// ─── HB: Missing ID errors (B-rules) ─────────────────────────────────────────

describe('HB — Missing ID errors', () => {
  it('HB1: SO ID missing in a non-blank row → MISSING_ID error on that row', () => {
    const row = makeRow({ 'SO ID': '' });
    const result = parseHierarchyChainRows([row], config);
    expect(result.hasErrors).toBe(true);
    const err = result.chainErrors.find(e => e.type === 'MISSING_ID');
    expect(err).toBeDefined();
    expect(err!.rowNums).toContain(2); // row 1 = header, row 2 = first data row
    expect(err!.message).toMatch(/SO ID/i);
  });

  it('HB2: XSR ID missing but other IDs present → MISSING_ID error', () => {
    const row = makeRow({ 'XSR ID': '' });
    const result = parseHierarchyChainRows([row], config);
    expect(result.hasErrors).toBe(true);
    const err = result.chainErrors.find(e => e.type === 'MISSING_ID');
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/XSR ID/i);
  });

  it('HB3: NSM ID missing → MISSING_ID error', () => {
    const row = makeRow({ 'NSM ID': '' });
    const result = parseHierarchyChainRows([row], config);
    expect(result.hasErrors).toBe(true);
    const err = result.chainErrors.find(e => e.type === 'MISSING_ID');
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/NSM ID/i);
  });

  it('HB4: multiple missing IDs in same row → one MISSING_ID error per missing column', () => {
    const row = makeRow({ 'SO ID': '', 'ASM ID': '' });
    const result = parseHierarchyChainRows([row], config);
    const missingErrors = result.chainErrors.filter(e => e.type === 'MISSING_ID');
    expect(missingErrors).toHaveLength(2);
  });

  it('HB5: row with missing IDs does not emit EmployeeUploadRows', () => {
    const row = makeRow({ 'SO ID': '' });
    const result = parseHierarchyChainRows([row], config);
    expect(result.employeeRows).toHaveLength(0);
  });
});

// ─── HA: Cross-row conflict errors (A-rules) ─────────────────────────────────

describe('HA — Cross-row conflicts', () => {
  it('HA1: same NSM ID with different names in two rows → NAME_CONFLICT', () => {
    const row1 = makeRow({ 'NSM Name': 'Anand Rao' });
    // row2 has a different XSR but same NSM-001 with a typo in the name
    const row2 = makeRow({
      'XSR ID': 'XSR-002', 'XSR Name': 'Deepa Nair', 'XSR Phone': '9900000011',
      'NSM Name': 'Anand Rau', // ← typo — triggers NAME_CONFLICT
    });
    const result = parseHierarchyChainRows([row1, row2], config);
    const err = result.chainErrors.find(e => e.type === 'NAME_CONFLICT');
    expect(err).toBeDefined();
    expect(err!.employeeId).toBe('NSM-001');
    expect(err!.rowNums).toEqual(expect.arrayContaining([2, 3]));
    expect(err!.message).toMatch(/different name/i);
  });

  it('HA2: same SO ID with different phones in two rows → PHONE_CONFLICT', () => {
    const row1 = makeRow({ 'SO Phone': '9900000002' });
    const row2 = { ...makeRow2(), 'SO Phone': '9900000099' };
    const result = parseHierarchyChainRows([row1, row2], config);
    const err = result.chainErrors.find(e => e.type === 'PHONE_CONFLICT');
    expect(err).toBeDefined();
    expect(err!.employeeId).toBe('SO-001');
    expect(err!.message).toMatch(/different phone/i);
  });

  it('HA3: same ID appearing as different roles in two rows → LEVEL_CONFLICT', () => {
    // Row 1: SO-001 is SO; Row 2: SO-001 appears in ASM column
    const row1 = makeRow();
    const row2 = makeRow({
      'XSR ID': 'XSR-002',
      'SO ID': 'SO-002',
      'ASM ID': 'SO-001', // ← same ID as SO in row1, but now in ASM column
    });
    const result = parseHierarchyChainRows([row1, row2], config);
    const err = result.chainErrors.find(e => e.type === 'LEVEL_CONFLICT');
    expect(err).toBeDefined();
    expect(err!.employeeId).toBe('SO-001');
    expect(err!.message).toMatch(/different role/i);
  });

  it('HA4: same SO ID reporting to different ASMs in two rows → PARENT_CONFLICT', () => {
    const row1 = makeRow({ 'ASM ID': 'ASM-001' });
    const row2 = { ...makeRow2(), 'ASM ID': 'ASM-002' }; // SO-001 now under ASM-002
    const result = parseHierarchyChainRows([row1, row2], config);
    const err = result.chainErrors.find(e => e.type === 'PARENT_CONFLICT');
    expect(err).toBeDefined();
    expect(err!.employeeId).toBe('SO-001');
    expect(err!.message).toMatch(/different.*manager/i);
  });
});

// ─── HX: Same-ID collision errors (C-rules) ──────────────────────────────────

describe('HX — Same-ID collisions', () => {
  it('HX1: same XSR ID in two rows → DUPLICATE_XSR error', () => {
    const row1 = makeRow();
    const row2 = makeRow(); // identical XSR ID
    const result = parseHierarchyChainRows([row1, row2], config);
    const err = result.chainErrors.find(e => e.type === 'DUPLICATE_XSR');
    expect(err).toBeDefined();
    expect(err!.employeeId).toBe('XSR-001');
    expect(err!.rowNums).toEqual(expect.arrayContaining([2, 3]));
    expect(err!.message).toMatch(/appears in more than one row/i);
  });

  it('HX2: same ID in XSR and SO columns of the same row → SELF_REFERENCE error', () => {
    const row = makeRow({ 'SO ID': 'XSR-001' }); // XSR-001 = SO-001 same row
    const result = parseHierarchyChainRows([row], config);
    const err = result.chainErrors.find(e => e.type === 'SELF_REFERENCE');
    expect(err).toBeDefined();
    expect(err!.employeeId).toBe('XSR-001');
    expect(err!.message).toMatch(/same ID.*more than one level/i);
  });
});

// ─── HB-phone: Phone format validation (Fix #3) ──────────────────────────────

describe('HB — Invalid phone errors (INVALID_PHONE)', () => {
  it('HBP1: phone with fewer than 10 digits → INVALID_PHONE', () => {
    const row = makeRow({ 'XSR Phone': '12345' });
    const result = parseHierarchyChainRows([row], config);
    expect(result.hasErrors).toBe(true);
    const err = result.chainErrors.find(e => e.type === 'INVALID_PHONE');
    expect(err).toBeDefined();
    expect(err!.employeeId).toBe('XSR-001');
    expect(err!.rowNums).toContain(2);
    expect(err!.message).toMatch(/invalid/i);
  });

  it('HBP2: phone with +91 prefix → INVALID_PHONE', () => {
    const row = makeRow({ 'SO Phone': '+919900000002' });
    const result = parseHierarchyChainRows([row], config);
    const err = result.chainErrors.find(e => e.type === 'INVALID_PHONE');
    expect(err).toBeDefined();
    expect(err!.employeeId).toBe('SO-001');
  });

  it('HBP3: blank phone is valid — no INVALID_PHONE error', () => {
    const row = makeRow({ 'XSR Phone': '' });
    const result = parseHierarchyChainRows([row], config);
    expect(result.chainErrors.filter(e => e.type === 'INVALID_PHONE')).toHaveLength(0);
  });

  it('HBP4: exactly 10-digit phone is valid — no INVALID_PHONE error', () => {
    const row = makeRow({ 'XSR Phone': '9900000099' });
    const result = parseHierarchyChainRows([row], config);
    expect(result.chainErrors.filter(e => e.type === 'INVALID_PHONE')).toHaveLength(0);
    expect(result.hasErrors).toBe(false);
  });

  it('HBP5: invalid phones on multiple levels in the same row → one INVALID_PHONE per bad phone', () => {
    const row = makeRow({ 'XSR Phone': 'abc', 'SO Phone': '123' });
    const result = parseHierarchyChainRows([row], config);
    const phoneErrors = result.chainErrors.filter(e => e.type === 'INVALID_PHONE');
    expect(phoneErrors).toHaveLength(2);
  });
});

// ─── HA-dedup: rowNums deduplication in conflict errors (Fix #2) ──────────────

describe('HA — rowNums deduplication in conflict errors', () => {
  it('HA-D1: 3 rows sharing the same NSM with a name conflict → rowNums has no duplicates', () => {
    // Row 1 + 2: NSM-001 with name "Anand Rao"
    // Row 3: NSM-001 with a different name — triggers NAME_CONFLICT
    // The NSM appears in rows 2, 3, 4 — rowNums should be [2, 3, 4], not have repeats
    const row1 = makeRow({ 'XSR ID': 'XSR-001' });
    const row2 = makeRow({ 'XSR ID': 'XSR-002' });
    const row3 = makeRow({ 'XSR ID': 'XSR-003', 'NSM Name': 'Anand Rau' }); // typo → conflict
    const result = parseHierarchyChainRows([row1, row2, row3], config);
    const err = result.chainErrors.find(e => e.type === 'NAME_CONFLICT' && e.employeeId === 'NSM-001');
    expect(err).toBeDefined();
    // Deduplicated: NSM appears in rows 2, 3, 4 — no duplicates
    const nums = err!.rowNums;
    expect(nums.length).toBe(new Set(nums).size);
    expect(nums).toEqual(expect.arrayContaining([2, 3, 4]));
  });
});

// ─── HR: Error report generation ─────────────────────────────────────────────

describe('HR — Error report', () => {
  it('HR1: generateHierarchyChainErrorReport returns a non-empty Uint8Array', () => {
    const row = makeRow({ 'SO ID': '' }); // has a MISSING_ID error
    const result = parseHierarchyChainRows([row], config);
    const bytes = generateHierarchyChainErrorReport([row], result, config);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('HR2: the generated Excel has exactly 19 columns (18 chain columns + Remarks)', () => {
    const row = makeRow({ 'SO ID': '' });
    const result = parseHierarchyChainRows([row], config);
    const bytes = generateHierarchyChainErrorReport([row], result, config);

    // Parse the generated Excel to inspect column count
    const wb = XLSX.read(bytes, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][];
    const headerRow = rows[0];
    expect(headerRow).toHaveLength(19);
    expect(headerRow[18]).toBe('Remarks');
  });

  it('HR3: error rows have plain-English text in the Remarks column; clean rows are empty', () => {
    // row1 = clean, row2 = missing SO ID
    const row1 = makeRow();
    const row2 = { ...makeRow2(), 'SO ID': '' };
    // We need unique XSR IDs to avoid DUPLICATE_XSR masking the MISSING_ID
    const result = parseHierarchyChainRows([row1, row2], config);
    const bytes = generateHierarchyChainErrorReport([row1, row2], result, config);

    const wb = XLSX.read(bytes, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][];

    // rows[0] = header; rows[1] = row1 (clean); rows[2] = row2 (error)
    const row1Remarks = rows[1][18];
    const row2Remarks = rows[2][18];

    expect(row1Remarks ?? '').toBe('');           // clean row — no remarks
    expect(row2Remarks).toBeTruthy();             // error row — has remarks
    expect(String(row2Remarks)).toMatch(/SO ID/i); // message mentions the missing column
  });
});
