/**
 * outlet-upload-error-report.test.ts
 *
 * Unit tests for the bulk-upload error-report builders. They must reproduce the
 * FULL uploaded file (every original column + ALL rows, OK rows NOT filtered)
 * with an appended annotation column carrying each row's validation errors.
 */

import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  buildOutletUploadErrorReport,
  buildReKYCErrorReport,
  buildDeactivateErrorReport,
  OUTLET_UPLOAD_HEADERS,
  REKYC_FLAG_HEADERS,
} from '@/lib/outlet-upload';
import { buildErrorReportBuffer } from '@/lib/error-report';
import type {
  OutletUploadRow,
  OutletUploadValidationResult,
  ReKYCFlagRow,
  ReKYCFlagValidationResult,
  OutletDeactivateValidationResult,
} from '@/types';

describe('buildOutletUploadErrorReport', () => {
  const parsed: OutletUploadRow[] = [
    {
      rowNum: 2, outletId: 'OUT-1', outletName: 'Alpha Store', programName: 'Prog A',
      programCategory: 'Cat A', outletType: 'SSS', beat: 'Beat 1', distributorId: 'D1',
      distributorName: 'Dist One', metro: 'Yes', city: 'Mumbai', state: 'MH',
      zone: 'West Zone', xsrId: 'XSR-9', payoutMethod: 'BANK', parentId: 'CPP01',
    },
    {
      rowNum: 3, outletId: 'OUT-2', outletName: 'Beta Store', programName: 'Prog B',
      programCategory: 'Cat B', outletType: 'SSS', beat: 'Beat 2', distributorId: 'D2',
      distributorName: 'Dist Two', metro: 'No', city: 'Pune', state: 'MH',
      zone: 'West Zone', xsrId: 'XSR-9', payoutMethod: 'UPI', parentId: '',
    },
  ];
  const result: OutletUploadValidationResult = {
    headerError: null,
    rows: [
      { rowNum: 2, outletId: 'OUT-1', status: 'ERROR', errors: ['Invalid XSR ID', 'Bad state'], action: 'CREATE' },
      { rowNum: 3, outletId: 'OUT-2', status: 'OK', errors: [], action: 'CREATE' },
    ],
    hasErrors: true,
    canProceed: true,
    summary: { total: 2, creates: 1, updates: 0, reactivates: 0, errors: 1 },
  };

  it('uses the full Outlet Master columns and a Remarks annotation header', () => {
    const report = buildOutletUploadErrorReport(result, parsed);
    expect(report.columns).toEqual(['Row', ...OUTLET_UPLOAD_HEADERS]);
    expect(report.errorHeader).toBe('Remarks');
  });

  it('reproduces every uploaded row (OK rows NOT filtered out)', () => {
    const report = buildOutletUploadErrorReport(result, parsed);
    expect(report.rows).toHaveLength(2);
    expect(report.rows.map(r => r['Row'])).toEqual([2, 3]);
  });

  it('reproduces the original column values from the parsed row', () => {
    const report = buildOutletUploadErrorReport(result, parsed);
    const errRow = report.rows[0];
    expect(errRow['Outlet ID']).toBe('OUT-1');
    expect(errRow['Outlet Name']).toBe('Alpha Store');
    expect(errRow['City']).toBe('Mumbai');
    expect(errRow['XSR ID']).toBe('XSR-9');
    expect(errRow['Payout Method']).toBe('BANK');
    expect(errRow['Parent ID']).toBe('CPP01');
  });

  it('carries the ERROR row errors and leaves the OK row errors empty', () => {
    const report = buildOutletUploadErrorReport(result, parsed);
    expect(report.rows[0].__errors).toEqual(['Invalid XSR ID', 'Bad state']);
    expect(report.rows[1].__errors).toEqual([]);
  });

  // End-to-end: the actual downloaded .xlsx artifact the admin opens. Builder
  // output → real buildErrorReportBuffer (xlsx writer) → read the bytes back.
  it('produces a downloadable sheet with the full file + Remarks column populated', () => {
    const report = buildOutletUploadErrorReport(result, parsed);
    const buf = buildErrorReportBuffer(report.columns, report.rows, (row) => (row.__errors as string[]) ?? [], {
      sheetName: 'Errors',
      errorHeader: report.errorHeader,
    });
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
    // Header row: Row + all 13 original columns + the Remarks annotation column.
    expect(aoa[0]).toEqual(['Row', ...OUTLET_UPLOAD_HEADERS, 'Remarks']);
    // Data row 1 (the ERROR row) reproduces original values AND notes the errors in Remarks.
    const headerIdx = (h: string) => aoa[0].indexOf(h);
    expect(aoa[1][headerIdx('Outlet Name')]).toBe('Alpha Store');
    expect(aoa[1][headerIdx('City')]).toBe('Mumbai');
    expect(aoa[1][headerIdx('Remarks')]).toBe('Invalid XSR ID · Bad state');
    // Data row 2 (the OK row) is present with an empty Remarks cell (re-uploadable).
    expect(aoa[2][headerIdx('Outlet Name')]).toBe('Beta Store');
    expect(aoa[2][headerIdx('Remarks')]).toBe('');
  });
});

describe('buildReKYCErrorReport', () => {
  const blankFlags = {
    outletName: '', ownerName: '', mobileNumber: '', gstNumber: '', panNumber: '',
    streetAddress: '', city: '', pincode: '', state: '', bankName: '',
    accountHolderName: '', accountNumber: '', ifscCode: '', upiId: '',
    gstCertificate: '', ownerPhoto: '', addressProof: '', storeBoardPhoto: '',
    cancelledCheque: '', selfDeclaration: '',
  };
  const parsed: ReKYCFlagRow[] = [
    {
      rowNum: 2, outletId: 'OUT-1', ...blankFlags,
      ownerName: 'Yes', remarks: 'Please recapture owner name',
    },
  ];
  const result: ReKYCFlagValidationResult = {
    headerError: null,
    rows: [
      { rowNum: 2, outletId: 'OUT-1', status: 'ERROR', errors: ['Outlet not found'], flagCount: 1 },
    ],
    hasErrors: true,
    canProceed: false,
    summary: { total: 1, flagged: 1, errors: 1 },
  };

  it('uses the full Re-KYC columns and a distinct "Validation Errors" header', () => {
    const report = buildReKYCErrorReport(result, parsed);
    expect(report.columns).toEqual(['Row', ...REKYC_FLAG_HEADERS]);
    expect(report.errorHeader).toBe('Validation Errors');
    expect(report.errorHeader).not.toBe('Remarks');
  });

  it('preserves the admin Remarks cell distinct from __errors and maps a flagged field through', () => {
    const report = buildReKYCErrorReport(result, parsed);
    const row = report.rows[0];
    expect(row['Remarks']).toBe('Please recapture owner name');
    expect(row.__errors).toEqual(['Outlet not found']);
    expect(row['Owner / Contact Name']).toBe('Yes');
  });
});

describe('buildDeactivateErrorReport', () => {
  const result: OutletDeactivateValidationResult = {
    headerError: null,
    rows: [
      { rowNum: 2, outletId: 'OUT-1', status: 'ERROR', errors: ['Already inactive'] },
    ],
    hasErrors: true,
    canProceed: false,
    summary: { total: 1, deactivates: 0, errors: 1 },
  };

  it('uses the Outlet ID column with a Remarks header and maps errors through', () => {
    const report = buildDeactivateErrorReport(result);
    expect(report.columns).toEqual(['Row', 'Outlet ID']);
    expect(report.errorHeader).toBe('Remarks');
    expect(report.rows[0]['Outlet ID']).toBe('OUT-1');
    expect(report.rows[0].__errors).toEqual(['Already inactive']);
  });
});
