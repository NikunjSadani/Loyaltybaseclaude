import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { buildRosterReportWorkbook } from '@/lib/scheme-roster-report';
import type { RosterUploadResult } from '@/lib/schemes';

const base: RosterUploadResult = {
  totalRows: 193,
  upserted: 121,
  matchedCount: 72,
  standaloneCount: 49,
  duplicateRefs: ['DKOL0401', 'FO_DEOL_83683620', 'DKOL0403'],
  unmatchedEmployeeCodes: ['XSR-BAD1'],
};

describe('buildRosterReportWorkbook', () => {
  it('has Summary, Duplicates and Unmatched Employees sheets', () => {
    const wb = buildRosterReportWorkbook(base, 'My Scheme');
    expect(wb.SheetNames).toEqual(['Summary', 'Duplicates', 'Unmatched Employees']);
  });

  it('summary reflects the totals (incl. duplicate/unmatched counts)', () => {
    const wb = buildRosterReportWorkbook(base);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Summary'], { header: 1 }) as unknown as (string | number)[][];
    const flat = Object.fromEntries(rows.filter((r) => r.length >= 2).map((r) => [r[0], r[1]]));
    expect(flat['Data rows read from file']).toBe(193);
    expect(flat['Rows saved']).toBe(121);
    expect(flat['Matched to a tenant outlet']).toBe(72);
    expect(flat['Standalone (no matching outlet)']).toBe(49);
    expect(flat['Duplicate outlet ids de-duplicated']).toBe(3);
    expect(flat['Tagged employee codes not found']).toBe(1);
  });

  it('lists every duplicate outlet id (not truncated)', () => {
    const wb = buildRosterReportWorkbook(base);
    const dupes = XLSX.utils.sheet_to_json<{ 'Duplicate Outlet ID': string }>(wb.Sheets['Duplicates']);
    expect(dupes.map((d) => d['Duplicate Outlet ID'])).toEqual(base.duplicateRefs);
  });

  it('escapes a formula-injection outlet id (AF-5b)', () => {
    const wb = buildRosterReportWorkbook({ ...base, duplicateRefs: ['=cmd()'] });
    const dupes = XLSX.utils.sheet_to_json<{ 'Duplicate Outlet ID': string }>(wb.Sheets['Duplicates']);
    expect(dupes[0]['Duplicate Outlet ID']).toBe("'=cmd()");
  });

  it('keeps headed-but-empty issue sheets when there are no issues', () => {
    const wb = buildRosterReportWorkbook({ ...base, duplicateRefs: [], unmatchedEmployeeCodes: [] });
    expect(wb.SheetNames).toContain('Duplicates');
    expect(wb.SheetNames).toContain('Unmatched Employees');
    expect(XLSX.utils.sheet_to_json(wb.Sheets['Duplicates'])).toHaveLength(0);
  });

  it('adds a Rows sheet with per-row disposition when the backend returns `rows` (Phase 2)', () => {
    const wb = buildRosterReportWorkbook({
      ...base,
      rows: [
        { rowIndex: 2, outletRef: 'DKOL0401', outletName: 'Shop A', taggedEmployeeCode: 'XSR-M010', disposition: 'SAVED', linkage: 'MATCHED', taggedEmployeeFound: true },
        { rowIndex: 3, outletRef: 'DKOL0401', outletName: 'Shop A dup', taggedEmployeeCode: '', disposition: 'DUPLICATE_DROPPED', linkage: '', taggedEmployeeFound: null },
      ],
    });
    expect(wb.SheetNames).toContain('Rows');
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(wb.Sheets['Rows']);
    expect(rows[0]).toMatchObject({ 'Row #': 2, Disposition: 'Saved', Linkage: 'Matched', 'Tagged Employee Found': 'Yes' });
    expect(rows[1]).toMatchObject({ 'Row #': 3, Disposition: 'Duplicate — dropped', Linkage: '—' });
  });

  it('omits the Rows sheet when the backend did not return `rows` (older backend)', () => {
    const wb = buildRosterReportWorkbook(base);
    expect(wb.SheetNames).not.toContain('Rows');
  });

  it('shows the skipped-rows line only when the backend reports skippedRows', () => {
    const withSkip = buildRosterReportWorkbook({ ...base, skippedRows: 4 });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(withSkip.Sheets['Summary'], { header: 1 }) as unknown as (string | number)[][];
    const flat = Object.fromEntries(rows.filter((r) => r.length >= 2).map((r) => [r[0], r[1]]));
    expect(flat['Rows skipped (blank / missing outlet id)']).toBe(4);

    // Older backend (no skippedRows) → line absent.
    const withoutSkip = buildRosterReportWorkbook(base);
    const rows2 = XLSX.utils.sheet_to_json<Record<string, unknown>>(withoutSkip.Sheets['Summary'], { header: 1 }) as unknown as (string | number)[][];
    expect(rows2.some((r) => String(r[0]).startsWith('Rows skipped'))).toBe(false);
  });
});
