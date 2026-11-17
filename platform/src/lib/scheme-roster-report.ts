/**
 * Scheme roster-upload report (Excel).
 *
 * Turns a `RosterUploadResult` (the summary the backend returns from
 * POST /v1/schemes/:id/roster/upload) into a downloadable .xlsx so a Gifsy admin
 * can see — and fix in the source file — exactly what happened on upload:
 *
 *   • Summary       — totals (rows in file, saved, matched, standalone, duplicates
 *                     de-duplicated, tagged-employee codes not found).
 *   • Duplicates    — every de-duplicated outlet id (one per row), so the admin can
 *                     find and resolve the repeats in the source Excel.
 *   • Unmatched Employees — every tagged employee code that did not resolve to a
 *                     sales user (the row is still saved, just not tagged).
 *
 * Every sheet is built through `aoaToSheetSafe` / `jsonToSheetSafe` so a hostile
 * outlet-id / employee-code cell can never be a formula-injection sink (AF-5b).
 *
 *   • Problem Rows  — per-row disposition of the rows to look at (dropped duplicates,
 *                     standalone rows, tagged employee codes not found). The backend
 *                     echoes at most 500 of them (memory-safety); the sheet says so when
 *                     the list was cut.
 */

import * as XLSX from 'xlsx';
import { aoaToSheetSafe, jsonToSheetSafe } from '@/lib/xlsx-safe';
import { downloadBlob } from '@/lib/download';
import type { RosterUploadResult } from '@/lib/schemes';

/** Build the workbook (pure — testable without a DOM). */
export function buildRosterReportWorkbook(
  result: RosterUploadResult,
  schemeName?: string,
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  const summary: (string | number)[][] = [
    ['Metric', 'Value'],
    ...(schemeName ? [['Scheme', schemeName]] : []),
    ['Data rows read from file', result.totalRows],
    ['Rows saved', result.upserted],
    ['Matched to a tenant outlet', result.matchedCount],
    ['Standalone (no matching outlet)', result.standaloneCount],
    ['Duplicate outlet ids de-duplicated', result.duplicateRefs.length],
    ['Tagged employee codes not found', result.unmatchedEmployeeCodes.length],
    // Only shown when the backend reports it (older backends omit skippedRows).
    ...(result.skippedRows !== undefined
      ? [['Rows skipped (blank / missing outlet id)', result.skippedRows]]
      : []),
    // Only shown when the backend reports it (older backends omit blankNameCount).
    ...(result.blankNameCount !== undefined
      ? [['Saved rows with no outlet name (unmatched → blank in report)', result.blankNameCount]]
      : []),
  ];
  summary.push(
    [],
    ['This file lists only the rows that need attention. Saved rows without a problem are counted above, not listed.'],
  );
  if (result.problemRowsTruncated) {
    summary.push([`Showing the first ${(result.problemRows?.length ?? 0).toLocaleString('en-IN')} of ${(result.problemRowCount ?? result.problemRows?.length ?? 0).toLocaleString('en-IN')} problem rows (see the Problem Rows sheet).`]);
  }
  XLSX.utils.book_append_sheet(wb, aoaToSheetSafe(summary), 'Summary');

  // Per-row disposition of the PROBLEM rows only (memory-safety: the backend no longer echoes
  // every file row; at most 500 problem rows). Omitted when there are none.
  if (result.problemRows && result.problemRows.length) {
    const rows = result.problemRows.map((r) => ({
      'Row #': r.rowIndex,
      'Outlet ID': r.outletRef,
      'Outlet Name': r.outletName,
      'Tagged Employee Code': r.taggedEmployeeCode,
      Disposition: r.disposition === 'SAVED' ? 'Saved' : 'Duplicate — dropped',
      Linkage: r.linkage === 'MATCHED' ? 'Matched' : r.linkage === 'STANDALONE' ? 'Standalone' : '—',
      'Tagged Employee Found':
        r.taggedEmployeeFound === null ? '—' : r.taggedEmployeeFound ? 'Yes' : 'No (not tagged)',
    }));
    const sheet = jsonToSheetSafe(rows);
    if (result.problemRowsTruncated) {
      XLSX.utils.sheet_add_aoa(
        sheet,
        [[`Showing the first ${result.problemRows.length.toLocaleString('en-IN')} of ${(result.problemRowCount ?? result.problemRows.length).toLocaleString('en-IN')} problem rows. Fix these, then re-upload only those rows — the next upload lists any that are left.`]],
        { origin: -1 },
      );
    }
    XLSX.utils.book_append_sheet(wb, sheet, 'Problem Rows');
  }

  // Always include the issue sheets (empty-but-headed when there are none) so the
  // file's structure is predictable for whoever opens it.
  const dupes = result.duplicateRefs.map((ref) => ({ 'Duplicate Outlet ID': ref }));
  XLSX.utils.book_append_sheet(
    wb,
    dupes.length ? jsonToSheetSafe(dupes) : aoaToSheetSafe([['Duplicate Outlet ID']]),
    'Duplicates',
  );

  const unmatched = result.unmatchedEmployeeCodes.map((code) => ({ 'Unmatched Employee Code': code }));
  XLSX.utils.book_append_sheet(
    wb,
    unmatched.length ? jsonToSheetSafe(unmatched) : aoaToSheetSafe([['Unmatched Employee Code']]),
    'Unmatched Employees',
  );

  return wb;
}

/** True when the upload has anything to act on (else the "Download problem rows" button is hidden). */
export function rosterHasProblems(result: RosterUploadResult): boolean {
  return (result.problemRowCount ?? result.problemRows?.length ?? 0) > 0
    || result.duplicateRefs.length > 0
    || result.unmatchedEmployeeCodes.length > 0;
}

/** Generate + trigger the browser download of the roster-upload report. */
export function downloadRosterReport(result: RosterUploadResult, schemeName?: string): void {
  const wb = buildRosterReportWorkbook(result, schemeName);
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const slug = (schemeName ?? 'scheme').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  downloadBlob(blob, `roster-upload-problem-rows-${slug || 'scheme'}.xlsx`);
}
