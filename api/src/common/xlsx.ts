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

/**
 * Neutralise spreadsheet formula injection at the serialisation boundary. A cell
 * value beginning with `= + - @` (or a leading tab/CR) is interpreted as a live
 * formula by Excel / Google Sheets — a user-supplied value like `=WEBSERVICE("…")`
 * or `=cmd()` would execute when someone opens the export. Prefixing with an
 * apostrophe forces text. Applied to EVERY string cell of EVERY export built here
 * (outlet master, points ledger, ticket aging, reports, …) so no single export
 * column can ever be an injection sink. Idempotent: an already-escaped `'=x` does
 * not match and is left unchanged (so domains that pre-sanitise — TDS, invoices —
 * are unaffected). Mirrors the proven `cellSafe` in tds/invoice helpers.
 */
function cellSafe(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** Build a multi-sheet xlsx workbook and return it as a Buffer. */
export function buildXlsx(sheets: XlsxSheet[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const safeRows = sheet.rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(row)) {
        out[k] = typeof val === 'string' ? cellSafe(val) : val;
      }
      return out;
    });
    const ws = XLSX.utils.json_to_sheet(safeRows);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** @deprecated alias kept for the initial port; prefer XlsxSheet. */
export type ReportSheet = XlsxSheet;
