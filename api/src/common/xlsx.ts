import * as XLSX from 'xlsx';

/**
 * Shared multi-sheet xlsx builder — used by any domain that streams an xlsx
 * download (reports, payouts reconciliation, …). Ported from the inline
 * `XLSX.utils.json_to_sheet` logic in the platform's report/export routes
 * (mirrors the `@/lib/*-export.ts` helpers). The returned Buffer is handed to a
 * Nest `StreamableFile` by the controller (the global interceptor passes
 * StreamableFile through unwrapped).
 */
export interface XlsxSheet {
  /** Worksheet tab name. */
  name: string;
  /** Row objects — the header row is derived from the first object's keys. */
  rows: Record<string, unknown>[];
}

/** Build a multi-sheet xlsx workbook and return it as a Buffer. */
export function buildXlsx(sheets: XlsxSheet[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.json_to_sheet(sheet.rows);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** @deprecated alias kept for the initial port; prefer XlsxSheet. */
export type ReportSheet = XlsxSheet;
