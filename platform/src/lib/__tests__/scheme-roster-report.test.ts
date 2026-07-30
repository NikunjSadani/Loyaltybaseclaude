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
    expect(flat['Total rows in file']).toBe(193);
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
});
