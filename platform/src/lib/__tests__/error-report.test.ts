/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { buildErrorReportBuffer } from '@/lib/error-report';

describe('buildErrorReportBuffer', () => {
  const columns = ['Outlet ID', 'Outlet Name', 'Phone'];
  const rows: Record<string, unknown>[] = [
    { 'Outlet ID': 'O1', 'Outlet Name': 'Alpha', Phone: '9900000001' }, // clean
    { 'Outlet ID': '',   'Outlet Name': 'Beta',  Phone: 'abc' },        // 2 errors
    { 'Outlet ID': 'O3', 'Outlet Name': 'Gamma', Phone: '9900000003' }, // clean
  ];
  const errorsByRow = (row: Record<string, unknown>): string[] => {
    const errs: string[] = [];
    if (!row['Outlet ID']) errs.push('Outlet ID is required');
    if (!/^\d{10}$/.test(String(row.Phone))) errs.push('Phone must be 10 digits');
    return errs;
  };

  function readBack(buf: ArrayBuffer): string[][] {
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' }) as string[][];
  }

  it('header includes the source columns plus an Errors column', () => {
    const aoa = readBack(buildErrorReportBuffer(columns, rows, errorsByRow));
    expect(aoa[0]).toEqual(['Outlet ID', 'Outlet Name', 'Phone', 'Errors']);
  });

  it('preserves ALL input rows, including clean ones', () => {
    const aoa = readBack(buildErrorReportBuffer(columns, rows, errorsByRow));
    // 1 header + 3 data rows
    expect(aoa.length).toBe(4);
    expect(aoa[1][1]).toBe('Alpha');
    expect(aoa[2][1]).toBe('Beta');
    expect(aoa[3][1]).toBe('Gamma');
  });

  it('joins an error row\'s messages with " · " in the Errors cell', () => {
    const aoa = readBack(buildErrorReportBuffer(columns, rows, errorsByRow));
    const errorsCol = aoa[0].indexOf('Errors');
    expect(aoa[1][errorsCol]).toBe('');                       // clean row
    expect(aoa[2][errorsCol]).toBe('Outlet ID is required · Phone must be 10 digits');
    expect(aoa[3][errorsCol]).toBe('');                       // clean row
  });

  it('honors sheetName and errorHeader overrides', () => {
    const buf = buildErrorReportBuffer(columns, rows, errorsByRow, {
      sheetName: 'Upload Report',
      errorHeader: 'Remarks',
    });
    const wb = XLSX.read(buf, { type: 'array' });
    expect(wb.SheetNames[0]).toBe('Upload Report');
    const aoa = readBack(buf);
    expect(aoa[0][aoa[0].length - 1]).toBe('Remarks');
  });
});

describe('M4 — a capped problem list says so inside the downloaded file', () => {
  it('adds "Showing the first 500 of N problems." to the Errors header and a Note sheet', async () => {
    const { cappedListNote } = await import('@/lib/error-report');
    const note = cappedListNote(500, 1234, true);
    expect(note).toBe('Showing the first 500 of 1,234 problems.');
    expect(cappedListNote(3, 3, false)).toBeNull();
    const buf = buildErrorReportBuffer(['Row'], [{ Row: 1 }], () => ['bad'], { note: note! });
    const wb = XLSX.read(buf, { type: 'array' });
    expect(wb.SheetNames).toEqual(['Errors', 'Note']);
    const header = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Errors'], { header: 1 })[0];
    expect(header[1]).toBe('Errors (Showing the first 500 of 1,234 problems.)');
    const noteRows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Note'], { header: 1 });
    expect(noteRows[0][0]).toBe('Showing the first 500 of 1,234 problems.');
  });

  it('no note → unchanged single sheet', () => {
    const wb = XLSX.read(buildErrorReportBuffer(['Row'], [{ Row: 1 }], () => ['bad']), { type: 'array' });
    expect(wb.SheetNames).toEqual(['Errors']);
  });
});
