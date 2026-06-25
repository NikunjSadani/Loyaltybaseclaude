/// <reference types="vitest/globals" />
/**
 * The row-level (Phase-3) hierarchy upload must produce ONE downloadable .xlsx
 * with every row error (owner: "merge the error finding into 1 file so the user
 * can resolve it at once"). The 18-column format is denormalized, so several
 * employees can share one Excel row — each error is tagged with its employee and
 * all errors for a row land in that row's Remarks cell.
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  generateHierarchyRowErrorReport,
  getHierarchyChainHeaders,
  DEOLEO_HIERARCHY,
} from '../employee-hierarchy';
import type { EmployeeUploadValidationResult } from '../../types';

const config  = DEOLEO_HIERARCHY;
const headers = getHierarchyChainHeaders(config);
const blankRow = () => Object.fromEntries(headers.map((h) => [h, '']));

function readBack(bytes: Uint8Array): Record<string, string>[] {
  const wb = XLSX.read(bytes, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: '' });
}

describe('generateHierarchyRowErrorReport — one file, all row errors', () => {
  it('aggregates every employee error for an Excel row into its Remarks, tagged by employee', () => {
    const rawRows = [blankRow(), blankRow()]; // idx 0 → rowNum 2, idx 1 → rowNum 3

    const validation: EmployeeUploadValidationResult = {
      headerError: null,
      hasErrors: true,
      canProceed: false,
      summary: { total: 3, creates: 0, updates: 0, errors: 2 },
      rows: [
        // two employees from the SAME denormalized Excel row (rowNum 2)
        { rowNum: 2, employeeId: 'Brahma:DSR Bangalore 1', status: 'ERROR', errors: ['Phone must be 10 digits'], warnings: [], action: 'CREATE' },
        { rowNum: 2, employeeId: 'SO:Bangalore 2',        status: 'ERROR', errors: ['Manager not found'],      warnings: [], action: 'CREATE' },
        // a clean employee on row 3
        { rowNum: 3, employeeId: 'ASM-OK',                 status: 'OK',    errors: [],                          warnings: [], action: 'CREATE' },
      ],
    };

    const out = readBack(generateHierarchyRowErrorReport(rawRows, validation, config));
    expect(out).toHaveLength(2);                    // one row per input row
    expect(out[0].Remarks).toContain('[Brahma:DSR Bangalore 1] Phone must be 10 digits');
    expect(out[0].Remarks).toContain('[SO:Bangalore 2] Manager not found');
    expect(out[1].Remarks).toBe('');                // the clean row carries no remarks → re-uploadable
  });
});
