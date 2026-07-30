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
 * This is the "quick summary" report (Phase 1). A per-row disposition report
 * (Phase 2) needs the backend to return each input row's outcome.
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
    ['Total rows in file', result.totalRows],
    ['Rows saved', result.upserted],
    ['Matched to a tenant outlet', result.matchedCount],
    ['Standalone (no matching outlet)', result.standaloneCount],
    ['Duplicate outlet ids de-duplicated', result.duplicateRefs.length],
    ['Tagged employee codes not found', result.unmatchedEmployeeCodes.length],
  ];
  XLSX.utils.book_append_sheet(wb, aoaToSheetSafe(summary), 'Summary');

  // Full per-row disposition (Phase 2) — every input row with its outcome. Present
  // only when the backend returned `rows`; older backends omit it (Summary-only file).
  if (result.rows && result.rows.length) {
    const rows = result.rows.map((r) => ({
      'Row #': r.rowIndex,
      'Outlet ID': r.outletRef,
      'Outlet Name': r.outletName,
      'Tagged Employee Code': r.taggedEmployeeCode,
      Disposition: r.disposition === 'SAVED' ? 'Saved' : 'Duplicate — dropped',
      Linkage: r.linkage === 'MATCHED' ? 'Matched' : r.linkage === 'STANDALONE' ? 'Standalone' : '—',
      'Tagged Employee Found':
        r.taggedEmployeeFound === null ? '—' : r.taggedEmployeeFound ? 'Yes' : 'No (not tagged)',
    }));
    XLSX.utils.book_append_sheet(wb, jsonToSheetSafe(rows), 'Rows');
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

/** Generate + trigger the browser download of the roster-upload report. */
export function downloadRosterReport(result: RosterUploadResult, schemeName?: string): void {
  const wb = buildRosterReportWorkbook(result, schemeName);
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const slug = (schemeName ?? 'scheme').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  downloadBlob(blob, `roster-upload-report-${slug || 'scheme'}.xlsx`);
}
