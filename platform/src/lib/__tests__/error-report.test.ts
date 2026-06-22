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
