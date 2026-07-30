/**
 * Unit tests for scheme-roster.helper.ts (Wave-0 scheme data-collection).
 *
 * Covers:
 *   A) buildOutletWhereFromFilter — filter facets → Prisma where, inclusions only,
 *      kycApprovedOnly → isActive, empty facets omitted.
 *   B) parseRosterUploadBuffer — fixed-column recognition, prefill capture, blank
 *      handling, header overrides, missing-id rejection.
 *   C) matchRosterRows — outlet/employee matching, standalone, dedup.
 *
 * Run: npx jest src/schemes/scheme-roster.helper.spec.ts
 */

import * as XLSX from 'xlsx';
import {
  buildOutletWhereFromFilter,
  parseRosterUploadBuffer,
  matchRosterRows,
  OutletMatch,
  RawRosterRow,
} from './scheme-roster.helper';

// ── Fixture: build an .xlsx buffer from an array-of-arrays ────────────────────
function xlsxBuffer(aoa: (string | number | null)[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Roster');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ─────────────────────────────────────────────────────────────────────────────
// A) buildOutletWhereFromFilter
// ─────────────────────────────────────────────────────────────────────────────
describe('buildOutletWhereFromFilter', () => {
  it('always tenant-scopes + excludes soft-deleted, with no filter', () => {
    expect(buildOutletWhereFromFilter('t1', undefined)).toEqual({
      clientId: 't1',
      deletedAt: null,
    });
  });

  it('maps each facet to an `in` inclusion', () => {
    const where = buildOutletWhereFromFilter('t1', {
      outletTypeIds: ['ot1', 'ot2'],
      programNames: ['Gold'],
      programCategories: ['A'],
      zones: ['North'],
      states: ['MH', 'KA'],
      kycApprovedOnly: false,
    });
    expect(where).toEqual({
      clientId: 't1',
      deletedAt: null,
      outletTypeId: { in: ['ot1', 'ot2'] },
      programName: { in: ['Gold'] },
      programCategory: { in: ['A'] },
      zone: { in: ['North'] },
      state: { in: ['MH', 'KA'] },
    });
  });

  it('kycApprovedOnly → isActive:true (trap #1)', () => {
    const where = buildOutletWhereFromFilter('t1', { kycApprovedOnly: true });
    expect(where.isActive).toBe(true);
  });

  it('omits empty / blank-only facets and de-dups + trims values', () => {
    const where = buildOutletWhereFromFilter('t1', {
      outletTypeIds: [],
      programNames: ['  ', ''],
      states: ['MH', ' MH ', 'KA'],
      kycApprovedOnly: false,
    });
    expect(where.outletTypeId).toBeUndefined();
    expect(where.programName).toBeUndefined();
    expect(where.state).toEqual({ in: ['MH', 'KA'] });
    expect(where.isActive).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) parseRosterUploadBuffer
// ─────────────────────────────────────────────────────────────────────────────
describe('parseRosterUploadBuffer', () => {
  it('parses fixed columns + arbitrary prefill variables', () => {
    const buf = xlsxBuffer([
      ['Outlet ID', 'Outlet Name', 'Tagged Employee', 'Slab', 'Target'],
      ['OUT001', 'Shop One', 'EMP01', 'Gold', '100'],
      ['OUT002', 'Shop Two', 'EMP02', 'Silver', '50'],
    ]);
    const { rows } = parseRosterUploadBuffer(buf);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      rowIndex: 2,
      outletRef: 'OUT001',
      outletName: 'Shop One',
      taggedEmployeeCode: 'EMP01',
      prefillValues: { Slab: 'Gold', Target: '100' },
    });
    expect(rows[1].outletRef).toBe('OUT002');
    expect(rows[1].prefillValues).toEqual({ Slab: 'Silver', Target: '50' });
  });

  it('omits blank cells from prefillValues and nulls a blank tagged-employee', () => {
    const buf = xlsxBuffer([
      ['Outlet ID', 'Outlet Name', 'Tagged Employee', 'Slab'],
      ['OUT001', 'Shop One', '', ''],
    ]);
    const { rows } = parseRosterUploadBuffer(buf);
    expect(rows[0].taggedEmployeeCode).toBeNull();
    expect(rows[0].prefillValues).toEqual({});
  });

  it('skips fully-blank rows and rows with no outlet id', () => {
    const buf = xlsxBuffer([
      ['Outlet ID', 'Outlet Name'],
      ['OUT001', 'Shop One'],
      [null, null],
      ['', 'Orphan name'],
      ['OUT002', 'Shop Two'],
    ]);
    const { rows, skippedRows } = parseRosterUploadBuffer(buf);
    expect(rows.map((r) => r.outletRef)).toEqual(['OUT001', 'OUT002']);
    // The fully-blank [null,null] row is ignored; the data-but-no-id 'Orphan name'
    // row is counted as skipped (so a reconciliation report can account for it).
    expect(skippedRows).toBe(1);
  });

  it('recognises alternate default header spellings (Outlet Code / Employee Code)', () => {
    const buf = xlsxBuffer([
      ['Outlet Code', 'Name', 'Employee Code'],
      ['OUT001', 'Shop One', 'EMP01'],
    ]);
    const { rows } = parseRosterUploadBuffer(buf);
    expect(rows[0].outletRef).toBe('OUT001');
    expect(rows[0].outletName).toBe('Shop One');
    expect(rows[0].taggedEmployeeCode).toBe('EMP01');
    expect(rows[0].prefillValues).toEqual({});
  });

  it('honours header-name overrides', () => {
    const buf = xlsxBuffer([
      ['Shop Ref', 'Shop', 'Rep', 'Extra'],
      ['OUT001', 'Shop One', 'EMP01', 'x'],
    ]);
    const { rows } = parseRosterUploadBuffer(buf, {
      idColumn: 'Shop Ref',
      nameColumn: 'Shop',
      taggedEmployeeColumn: 'Rep',
    });
    expect(rows[0].outletRef).toBe('OUT001');
    expect(rows[0].outletName).toBe('Shop One');
    expect(rows[0].taggedEmployeeCode).toBe('EMP01');
    expect(rows[0].prefillValues).toEqual({ Extra: 'x' });
  });

  it('throws when the id column is absent', () => {
    const buf = xlsxBuffer([
      ['Name', 'Tagged Employee'],
      ['Shop One', 'EMP01'],
    ]);
    expect(() => parseRosterUploadBuffer(buf)).toThrow(/outlet id/i);
  });

  it('coerces numeric-looking ids to trimmed strings', () => {
    const buf = xlsxBuffer([
      ['Outlet ID', 'Outlet Name'],
      [12345, 'Shop One'],
    ]);
    const { rows } = parseRosterUploadBuffer(buf);
    expect(rows[0].outletRef).toBe('12345');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C) matchRosterRows
// ─────────────────────────────────────────────────────────────────────────────
describe('matchRosterRows', () => {
  const raw = (
    outletRef: string,
    taggedEmployeeCode: string | null = null,
    prefillValues: Record<string, string> = {},
  ): RawRosterRow => ({ rowIndex: 2, outletRef, outletName: `${outletRef} name`, taggedEmployeeCode, prefillValues });

  const outlets = new Map<string, OutletMatch>([
    ['OUT001', { id: 'o1', partnerId: 'p1' }],
    ['OUT002', { id: 'o2', partnerId: null }],
  ]);
  const salesUsers = new Map<string, string>([['EMP01', 'su1']]);

  it('links matched outlets + resolves tagged employees', () => {
    const res = matchRosterRows([raw('OUT001', 'EMP01', { Slab: 'Gold' })], outlets, salesUsers);
    expect(res.rows[0]).toEqual({
      outletRef: 'OUT001',
      outletName: 'OUT001 name',
      matchedOutletId: 'o1',
      matchedPartnerId: 'p1',
      taggedSalesUserId: 'su1',
      prefillValues: { Slab: 'Gold' },
    });
    expect(res.matchedCount).toBe(1);
    expect(res.standaloneCount).toBe(0);
  });

  it('keeps unmatched outletRefs as standalone (null ids)', () => {
    const res = matchRosterRows([raw('OUT999')], outlets, salesUsers);
    expect(res.rows[0].matchedOutletId).toBeNull();
    expect(res.rows[0].matchedPartnerId).toBeNull();
    expect(res.standaloneCount).toBe(1);
    expect(res.matchedCount).toBe(0);
  });

  it('reports unmatched tagged-employee codes but keeps the row', () => {
    const res = matchRosterRows([raw('OUT001', 'EMP_X')], outlets, salesUsers);
    expect(res.rows[0].taggedSalesUserId).toBeNull();
    expect(res.unmatchedEmployeeCodes).toEqual(['EMP_X']);
  });

  it('normalizes empty prefill to null (never {})', () => {
    const res = matchRosterRows([raw('OUT002')], outlets, salesUsers);
    expect(res.rows[0].prefillValues).toBeNull();
  });

  it('dedups on outletRef — first occurrence wins (D8)', () => {
    const res = matchRosterRows(
      [raw('OUT001', 'EMP01'), raw('OUT001', null), raw('OUT002')],
      outlets,
      salesUsers,
    );
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0].taggedSalesUserId).toBe('su1'); // kept the first
    expect(res.duplicateRefs).toEqual(['OUT001']);
  });

  it('produces a per-input-row report (SAVED matched/standalone + DUPLICATE_DROPPED)', () => {
    const res = matchRosterRows(
      [
        { rowIndex: 2, outletRef: 'OUT001', outletName: 'A', taggedEmployeeCode: 'EMP01', prefillValues: {} },
        { rowIndex: 3, outletRef: 'OUT999', outletName: 'B', taggedEmployeeCode: 'EMP_X', prefillValues: {} },
        { rowIndex: 4, outletRef: 'OUT001', outletName: 'A-dup', taggedEmployeeCode: null, prefillValues: {} },
      ],
      outlets,
      salesUsers,
    );
    expect(res.rowReport).toEqual([
      { rowIndex: 2, outletRef: 'OUT001', outletName: 'A', taggedEmployeeCode: 'EMP01', disposition: 'SAVED', linkage: 'MATCHED', taggedEmployeeFound: true },
      { rowIndex: 3, outletRef: 'OUT999', outletName: 'B', taggedEmployeeCode: 'EMP_X', disposition: 'SAVED', linkage: 'STANDALONE', taggedEmployeeFound: false },
      { rowIndex: 4, outletRef: 'OUT001', outletName: 'A-dup', taggedEmployeeCode: '', disposition: 'DUPLICATE_DROPPED', linkage: '', taggedEmployeeFound: null },
    ]);
  });
});
