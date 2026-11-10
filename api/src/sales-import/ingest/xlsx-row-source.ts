/**
 * Streaming XLSX row source (plan §7.1 step 6 / task I-4). The ONLY importer of `exceljs` (D-3).
 *
 * Yields one SourceRow per non-empty sheet row of the selected sheet: `cells` is a DENSE 0-based array
 * (exceljs `row.values` is sparse and 1-based), date cells arrive as `Date` (naive UTC), rich text is
 * flattened, formulas yield their cached result, error cells are null.
 * Sheet choice: `sheetName` (case/space-insensitive) or the FIRST sheet in workbook order.
 * The zip-order memory trap is handled before streaming by xlsx-zip-layout.ts.
 */
import type { Readable } from 'node:stream';
import * as ExcelJS from 'exceljs';
import type { SourceRow } from './header';
import { normalizeHeader } from './normalize';

export class XlsxSheetNotFoundError extends Error {
  constructor(
    readonly wanted: string | null,
    readonly sheets: string[],
  ) {
    super(
      wanted
        ? `Sheet "${wanted}" was not found in the file (sheets: ${sheets.join(', ') || 'none'}).`
        : 'The file has no worksheet.',
    );
  }
}

/** One exceljs cell value → a plain value the parsers understand. */
export function plainCellValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: string }>).map((r) => r.text ?? '').join('');
  if ('result' in o) return plainCellValue(o.result);
  if ('formula' in o || 'sharedFormula' in o) return null; // formula without a cached result
  if ('error' in o) return null;
  if ('text' in o) return plainCellValue(o.text); // hyperlink cell
  return null;
}

export function denseCells(values: unknown): unknown[] {
  if (!Array.isArray(values)) return [];
  const out: unknown[] = new Array(Math.max(0, values.length - 1)).fill(null);
  for (let i = 1; i < values.length; i++) out[i - 1] = plainCellValue(values[i]);
  return out;
}

interface ReaderInternals {
  model?: { sheets?: Array<{ name?: string }> };
}

/**
 * `it.next()` raced against a failure promise: exceljs pipes the input WITHOUT an error listener and, when the input
 * fails mid-file, its iterators never settle (measured: the worker would hang until its heartbeat went stale). The
 * input's 'error' is therefore caught here and turned into a rejection of the pending `next()`.
 */
async function* racing<T>(it: AsyncIterator<T>, failed: Promise<never>): AsyncGenerator<T> {
  let finished = false;
  try {
    for (;;) {
      const r = await Promise.race([it.next(), failed]);
      if (r.done) {
        finished = true;
        return;
      }
      yield r.value;
    }
  } finally {
    // Early exit (break / error): release the underlying exceljs iterator like a plain for-await would.
    if (!finished) {
      let timer: NodeJS.Timeout | undefined;
      const giveUp = new Promise<void>((resolve) => (timer = setTimeout(resolve, 2000)));
      await Promise.race([Promise.resolve(it.return?.()), failed, giveUp]).catch(() => undefined);
      if (timer) clearTimeout(timer);
    }
  }
}

export async function* xlsxRows(stream: Readable, sheetName?: string | null): AsyncGenerator<SourceRow> {
  let fail!: (e: Error) => void;
  const failed = new Promise<never>((_, reject) => (fail = reject));
  failed.catch(() => undefined); // observed only through the race
  stream.on('error', (e: Error) => fail(e));
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(stream, {
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'cache',
    worksheets: 'emit',
    entries: 'ignore',
  });
  const wanted = sheetName && normalizeHeader(sheetName) !== '' ? normalizeHeader(sheetName) : null;
  const seen: string[] = [];
  let found = false;
  (reader as unknown as { on?: (ev: string, cb: (e: Error) => void) => void }).on?.('error', (e) => fail(e));
  for await (const ws of racing((reader as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator](), failed)) {
    const w = ws as unknown as { name?: string; id?: number } & AsyncIterable<{ number: number; values: unknown }>;
    const name = w.name ?? `Sheet${w.id ?? seen.length + 1}`;
    seen.push(name);
    if (found) continue; // later sheets are drained by exceljs
    const firstInWorkbook = (reader as unknown as ReaderInternals).model?.sheets?.[0]?.name;
    const isTarget = wanted
      ? normalizeHeader(name) === wanted
      : firstInWorkbook === undefined || w.name === undefined || name === firstInWorkbook;
    if (!isTarget) continue;
    found = true;
    let counter = 0;
    for await (const row of racing(w[Symbol.asyncIterator](), failed)) {
      counter++;
      const cells = denseCells(row.values);
      if (cells.every((c) => c === null || c === '')) continue;
      yield { rowNo: Number.isFinite(row.number) ? row.number : counter, cells };
    }
  }
  if (!found) throw new XlsxSheetNotFoundError(wanted ? sheetName! : null, seen);
}
