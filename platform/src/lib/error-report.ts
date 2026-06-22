import * as XLSX from 'xlsx';

// ─── Shared bulk-upload error report ──────────────────────────────────────────
//
// Generalization of `generateHierarchyChainErrorReport` (employee-hierarchy.ts)
// and `buildErrorReportBuffer` (target-excel-upload.ts): given the parsed input
// rows and a per-row error resolver, emit a single-sheet .xlsx with one row per
// input row plus an "Errors" column. Clean rows are preserved with an empty
// Errors cell so the file is re-uploadable after the client fixes the flagged
// rows.

/**
 * Build a downloadable error report buffer.
 *
 * @param columns      Source column headers, in order.
 * @param rows         One record per input row (keyed by the column names, but
 *                     any extra keys are ignored). ALL rows are preserved.
 * @param errorsByRow  Resolver returning the error messages for a given row.
 *                     Joined with " · " into the Errors cell.
 * @param opts.sheetName    Sheet name (default 'Errors').
 * @param opts.errorHeader  Errors column header (default 'Errors').
 */
export function buildErrorReportBuffer(
  columns: string[],
  rows: Record<string, unknown>[],
  errorsByRow: (row: Record<string, unknown>, idx: number) => string[],
  opts?: { sheetName?: string; errorHeader?: string },
): ArrayBuffer {
  const errorHeader = opts?.errorHeader ?? 'Errors';
  const sheetName   = opts?.sheetName ?? 'Errors';
  const header      = [...columns, errorHeader];

  const dataRows = rows.map((row, idx) => {
    const values = columns.map(c => {
      const v = row[c];
      return v === null || v === undefined ? '' : String(v);
    });
    const errors = errorsByRow(row, idx).join(' · ');
    return [...values, errors];
  });

  const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
  ws['!cols'] = header.map(h => ({ wch: h === errorHeader ? 80 : 20 }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  // `type:'array'` may yield an ArrayBuffer OR a Uint8Array depending on the SheetJS
  // build (0.18.5 returns an ArrayBuffer here). Normalize to a standalone ArrayBuffer
  // so consumers (Blob, XLSX.read) get exactly these bytes.
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer | Uint8Array;
  if (out instanceof ArrayBuffer) return out;
  const ab = new ArrayBuffer(out.byteLength);
  new Uint8Array(ab).set(out);
  return ab;
}

/**
 * Trigger a browser download of an error report buffer.
 * Mirrors the existing `downloadXlsx` pattern in outlets/page.tsx.
 */
export function downloadErrorReport(buf: ArrayBuffer, filename: string): void {
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
