/**
 * Re-read an import's STORED file (its GCS parts) into a SalesAggregator result, outside the claim / heartbeat machinery
 * of the processor — for the one-off day-data rebuild (oneoff/sales-day-rebuild.ts) of a month applied before day-level
 * storage. Reads exactly like the processor (parsePass / decideHeader): the same row sources, the same header rule, the
 * same column mapping (the import's own mappingSnapshot), the same 'auto' decimal decision. The caller VERIFIES the
 * result against the month's stored lines before using it (a re-read that does not reproduce them exactly is refused),
 * so any drift between this reader and the processor can never write wrong day data.
 * Memory: the same as processing the file (run it in the 2 GiB job with --max-old-space-size=1700).
 */
import type { Readable } from 'node:stream';
import type { StorageService } from '../../storage/storage.service';
import { SALES_IMPORT_MAX_COLUMNS, type SalesColumnMapping } from '../sales-import.contract';
import { SalesAggregator, type AggregatorResult } from './aggregator';
import { csvRows } from './csv-row-source';
import { HEADER_SCAN_ROWS, resolveHeader, type SourceRow } from './header';
import { resolveDecimalSeparator, type DecimalSeparator } from './normalize';
import { PartsFile } from './parts-file';
import { decideDecimal } from './sales-import-processor.service';
import { xlsxRows } from './xlsx-row-source';
import { loadCentralDirectory, planXlsxRead, resequencedXlsxStream } from './xlsx-zip';

const MAX_PREHEADER_ROWS = 1000; // = the processor's bound

export type StoredParse = { ok: true; result: AggregatorResult } | { ok: false; problem: string };

function isBlankRow(cells: unknown[]): boolean {
  return cells.every((c) => c === null || c === undefined || (typeof c === 'string' && c.trim() === ''));
}

export async function parseStoredFile(
  storage: Pick<StorageService, 'openReadStream'>,
  imp: { gcsPrefix: string; sizeBytes: bigint | number; fileKind: string },
  mapping: SalesColumnMapping,
  roster: ReadonlyMap<string, string>,
): Promise<StoredParse> {
  const size = Number(imp.sizeBytes);
  const parts = new PartsFile(storage, imp.gcsPrefix, size);
  const setting = mapping.decimalSeparator ?? 'auto';
  const first = await pass(parts, size, imp.fileKind, mapping, roster, { collectDecimalEvidence: setting === 'auto' });
  if (!first.ok || setting !== 'auto') return first.ok ? { ok: true, result: first.result } : first;
  const decision = decideDecimal(first.result.decimalEvidence, first.decimal);
  if ('needsMapping' in decision) return { ok: false, problem: decision.needsMapping };
  if (decision.decimal === first.decimal) return { ok: true, result: first.result };
  const second = await pass(parts, size, imp.fileKind, mapping, roster, { decimal: decision.decimal });
  return second.ok ? { ok: true, result: second.result } : second;
}

async function pass(
  parts: PartsFile,
  size: number,
  fileKind: string,
  mapping: SalesColumnMapping,
  roster: ReadonlyMap<string, string>,
  opts: { decimal?: DecimalSeparator; collectDecimalEvidence?: boolean },
): Promise<{ ok: true; result: AggregatorResult; decimal: DecimalSeparator } | { ok: false; problem: string }> {
  let source: Readable;
  let rows: AsyncGenerator<SourceRow>;
  let csvDelimiter: string | null = null;
  const failure: { error: Error | null } = { error: null };
  if (fileKind === 'XLSX') {
    const plan = planXlsxRead(await loadCentralDirectory(parts, size));
    source = resequencedXlsxStream(parts, plan, undefined, (e) => (failure.error = e));
    rows = xlsxRows(source, mapping.sheetName ?? null);
  } else {
    source = parts.stream();
    rows = csvRows(source, undefined, { onDelimiter: (d) => (csvDelimiter = d) });
  }
  let decimal: DecimalSeparator = opts.decimal ?? '.';
  const head: SourceRow[] = [];
  let agg: SalesAggregator | null = null;
  const want = typeof mapping.headerRow === 'number' ? mapping.headerRow : null;
  const decide = (): string | null => {
    const res = resolveHeader(head, mapping);
    if (res.needsMapping) return res.reason;
    decimal = opts.decimal ?? resolveDecimalSeparator(mapping.decimalSeparator, csvDelimiter);
    agg = new SalesAggregator(mapping, res.colIdx, roster, undefined, decimal, {}, { collectDecimalEvidence: opts.collectDecimalEvidence === true });
    for (const r of head.slice(res.headerRowIdx + 1)) agg.push(r.cells, r.rowNo);
    return null;
  };
  try {
    for await (const r of rows) {
      if (isBlankRow(r.cells)) continue;
      if (agg) {
        (agg as SalesAggregator).push(r.cells, r.rowNo);
        continue;
      }
      head.push(r.cells.length > SALES_IMPORT_MAX_COLUMNS ? { rowNo: r.rowNo, cells: r.cells.slice(0, SALES_IMPORT_MAX_COLUMNS) } : r);
      const enough = want === null ? head.length >= HEADER_SCAN_ROWS : r.rowNo >= want || head.length >= MAX_PREHEADER_ROWS;
      if (!enough) continue;
      const problem = decide();
      if (problem) return { ok: false, problem };
    }
  } catch (e) {
    const err = failure.error ?? e;
    return { ok: false, problem: `The stored file could not be read: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` };
  } finally {
    if (!source.destroyed) source.destroy();
  }
  if (failure.error) return { ok: false, problem: `The stored file could not be read: ${failure.error.message}` };
  if (!agg) {
    if (head.length === 0) return { ok: false, problem: 'The stored file has no rows.' };
    const problem = decide();
    if (problem) return { ok: false, problem };
  }
  return { ok: true, result: (agg as unknown as SalesAggregator).result(), decimal };
}
