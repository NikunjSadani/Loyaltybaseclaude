/**
 * Streaming .xlsx writer (Downloads page design, platform/docs/plans/DOWNLOADS-PAGE.md).
 *
 * Writes rows straight into a Writable (an HTTP response, or a storage upload stream) with exceljs'
 * streaming WorkbookWriter: each row is committed as it is added, so memory stays flat whatever the row
 * count — unlike `buildXlsx` (common/xlsx.ts), which holds the whole workbook (≈ 4 copies of the data).
 *
 * Cell safety is identical to `buildXlsx`: every string cell AND header goes through `cellSafe` (spreadsheet
 * formula-injection guard); a `HyperlinkCell` renders a real link whose DISPLAY text is cellSafe'd.
 * No shared-strings table and no styles (both would be held in memory until the end).
 */
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import { cellSafe, isHyperlinkCell, type HyperlinkCell } from './xlsx';

export type XlsxCell = string | number | boolean | Date | null | undefined | HyperlinkCell;

export interface XlsxStreamSheet {
  /** Append one data row (cells in header order). Await it: it yields to backpressure. */
  addRow(cells: readonly XlsxCell[]): Promise<void>;
  /** Data rows written to this sheet so far. */
  readonly rowCount: number;
}

/** A merged cell range, 0-based sheet coordinates (row 0 = the header row) — SheetJS `!merges` shape. */
export interface XlsxMergeRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

export interface XlsxStreamSheetOptions {
  widths?: readonly number[];
  /** Merged ranges on the HEADER row only (s.r = e.r = 0), e.g. a month-group header spanning its KPI columns. */
  merges?: readonly XlsxMergeRange[];
}

export interface XlsxStreamWriter {
  /** Start a new sheet with a header row. The previous sheet is committed first. */
  addSheet(name: string, headers: readonly string[], opts?: XlsxStreamSheetOptions): Promise<XlsxStreamSheet>;
  /** Commit everything and end the destination stream. Call exactly once. */
  finish(): Promise<void>;
  /** Data rows written across all sheets. */
  readonly rowCount: number;
}

/** Excel's sheet-name rules: ≤ 31 chars, none of : \ / ? * [ ]. */
function safeSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, ' ').trim() || 'Sheet';
  return cleaned.slice(0, 31);
}

function toCellValue(v: XlsxCell): ExcelJS.CellValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return cellSafe(v);
  if (isHyperlinkCell(v)) return { text: cellSafe(v.text), hyperlink: v.target };
  return v as ExcelJS.CellValue;
}

/** Yield to the event loop every this many rows so a long export never starves other requests. */
const YIELD_EVERY = 500;

export function createXlsxStreamWriter(dest: Writable): XlsxStreamWriter {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: dest, useSharedStrings: false, useStyles: false });
  let current: ExcelJS.Worksheet | null = null;
  let total = 0;
  let finished = false;
  const usedNames = new Set<string>();

  // Wait for backpressure to clear — but never forever: a destination that is destroyed / closed / errors while we
  // wait (client went away, upload failed) rejects instead of leaving the export hanging on a 'drain' that never comes.
  const waitForDrain = async () => {
    const d = dest as Writable & { writableNeedDrain?: boolean };
    if (d.destroyed || d.closed) throw new Error('xlsx-stream: destination closed');
    if (!d.writableNeedDrain) return;
    const ac = new AbortController();
    try {
      await Promise.race([
        once(d, 'drain', { signal: ac.signal }),
        once(d, 'close', { signal: ac.signal }).then(() => {
          throw new Error('xlsx-stream: destination closed');
        }),
        // once() rejects with the 'error' payload.
        once(d, 'error', { signal: ac.signal }),
      ]);
    } finally {
      ac.abort(); // detach the losing listeners (their AbortError rejections are already settled by the race)
    }
  };

  return {
    get rowCount() {
      return total;
    },
    async addSheet(name, headers, opts) {
      if (finished) throw new Error('xlsx-stream: addSheet after finish');
      if (current) current.commit();
      let sheetName = safeSheetName(name);
      for (let i = 2; usedNames.has(sheetName.toLowerCase()); i++) sheetName = safeSheetName(`${name.slice(0, 27)} (${i})`);
      usedNames.add(sheetName.toLowerCase());
      const ws = wb.addWorksheet(sheetName);
      if (opts?.widths) ws.columns = headers.map((_, i) => ({ width: opts.widths?.[i] ?? 14 }));
      const headerRow = ws.addRow(headers.map((h) => cellSafe(String(h))));
      // Merges are applied while the header row is still open: exceljs' mergeCells touches every cell of the
      // range, so a merge below the header would create rows ahead of addRow (shifting the data) — header only.
      for (const m of opts?.merges ?? []) {
        if (m.s.r !== 0 || m.e.r !== 0) throw new Error('xlsx-stream: merges are supported on the header row only');
        ws.mergeCells(1, m.s.c + 1, 1, m.e.c + 1);
      }
      headerRow.commit();
      current = ws;
      let sheetRows = 0;
      return {
        get rowCount() {
          return sheetRows;
        },
        async addRow(cells) {
          if (current !== ws) throw new Error('xlsx-stream: addRow on a sheet that is no longer current');
          ws.addRow(cells.map(toCellValue)).commit();
          sheetRows++;
          total++;
          if (total % YIELD_EVERY === 0) {
            await waitForDrain();
            await new Promise<void>((r) => setImmediate(r));
          }
        },
      };
    },
    async finish() {
      if (finished) return;
      finished = true;
      if (current) current.commit();
      await wb.commit(); // ends `dest`
    },
  };
}
