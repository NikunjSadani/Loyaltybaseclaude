import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type SalesImport } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform, pipeline } from 'node:stream';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { isSalesImportEnabledUncached } from '../sales-import-access';
import {
  SALES_IMPORT_MAX_ATTEMPTS,
  SALES_IMPORT_MAX_COLUMNS,
  SALES_IMPORT_SAMPLE_CELL_CHARS,
  SALES_IMPORT_SAMPLE_ROWS,
  type SalesColumnMapping,
} from '../sales-import.contract';
import { AggregatorLimitError, SalesAggregator, type AggregatorResult } from './aggregator';
import { claimNextImport } from './claim';
import { CsvLimitError, csvRows } from './csv-row-source';
import { HEADER_SCAN_ROWS, resolveHeader, type SourceRow } from './header';
import { mappingFingerprint } from './mapping-fingerprint';
import { normalizeHeader, resolveDecimalSeparator } from './normalize';
import { PartsFile, unmatchedCsvKey } from './parts-file';
import { loadRoster } from './roster';
import { unmatchedCsvLines } from './unmatched-csv';
import { XlsxSheetNotFoundError, xlsxRows } from './xlsx-row-source';
import { loadCentralDirectory, planXlsxRead, resequencedXlsxStream, XlsxFileError } from './xlsx-zip';

/** createMany batch size for SalesImportAggregate (plan §7.1 step 10). */
export const AGGREGATE_CHUNK = 5000;
/** Heartbeat / progress write cadence (plan §7.1 step 9). */
export const HEARTBEAT_MS = 5000;
export const HEARTBEAT_ROWS = 20_000;
/** A fixed header row deeper than this is treated as not found (bounds the pre-header buffer). */
const MAX_PREHEADER_ROWS = 1000;
/** The final READY write (delete + insert all aggregates) runs in ONE transaction; generous for ~2M rows. */
const FINAL_TX_TIMEOUT_MS = 30 * 60_000;

/** A problem with the FILE (shown to the admin verbatim). */
class FileProblem extends Error {}
/** This worker's claim was superseded (reprocess / cancel / reclaim): stop, write nothing. */
export class ClaimLostError extends Error {}

const GENERIC_FAILURE = 'Processing failed unexpectedly. Try Reprocess; if it fails again, contact Gifsy support.';

function cellText(v: unknown, max: number): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : '';
  return String(v).slice(0, max);
}

function isBlankRow(cells: unknown[]): boolean {
  return cells.every((c) => c === null || c === undefined || (typeof c === 'string' && c.trim() === ''));
}

/**
 * S3: what is stored as `detectedHeaders` — the header row (resolved, or the best guess) + at most
 * SALES_IMPORT_SAMPLE_ROWS following rows; ≤ SALES_IMPORT_MAX_COLUMNS cells each, every cell ≤ 50 chars.
 */
export function detectedHeadersOf(head: SourceRow[], headerIdx: number | null): string[][] {
  if (head.length === 0) return [];
  let idx = headerIdx;
  if (idx === null) {
    // Best guess: the scanned row with the most DISTINCT non-blank values (a marker row of "X"s scores 1).
    let best = -1;
    head.slice(0, HEADER_SCAN_ROWS).forEach((r, i) => {
      const n = new Set(r.cells.slice(0, SALES_IMPORT_MAX_COLUMNS).map((c) => normalizeHeader(cellText(c, 200))).filter((s) => s !== '')).size;
      if (n > best) {
        best = n;
        idx = i;
      }
    });
  }
  const start = idx ?? 0;
  return head
    .slice(start, start + 1 + SALES_IMPORT_SAMPLE_ROWS)
    .map((r) => r.cells.slice(0, SALES_IMPORT_MAX_COLUMNS).map((c) => cellText(c, SALES_IMPORT_SAMPLE_CELL_CHARS)));
}

/**
 * SalesImportProcessorService — claims QUEUED (or heartbeat-stale PROCESSING) imports and turns the
 * uploaded file into SalesImportAggregate rows + frozen month summaries (plan §7.1). Runs in the Cloud
 * Run JOB (worker.main.ts) or in-process when SALES_IMPORT_RUNNER=inline. OWNER: Lane I.
 *
 * Outcomes: READY | NEEDS_MAPPING (no profile / headers or sheet not found) | FAILED (flag off, too many attempts,
 * unreadable / oversized file, unexpected error — message, no stack).
 * M2: only the claim whose RANDOM `claimToken` is still on the row may heartbeat or finalise; a heartbeat that matches
 * nothing (reprocessed / cancelled / reclaimed) aborts the run without writing. The READY write (delete old aggregates,
 * insert new ones, flip to READY, unmatched.csv) is ONE transaction holding the row lock, guarded by the token.
 */
@Injectable()
export class SalesImportProcessorService {
  private readonly logger = new Logger(SalesImportProcessorService.name);

  constructor(
    readonly prisma: PrismaService,
    readonly storage: StorageService,
  ) {}

  /** §7.1.1 claim (FOR UPDATE SKIP LOCKED) with a fresh random token. null = nothing claimable. */
  async claimNext(): Promise<SalesImport | null> {
    return claimNextImport(this.prisma, randomUUID());
  }

  /** §7.1 steps 2–10 for one claimed import. Never throws for a per-import problem. */
  async processClaimed(row: SalesImport): Promise<void> {
    try {
      await this.run(row);
    } catch (e) {
      if (e instanceof ClaimLostError) {
        this.logger.warn(`sales-import ${row.id}: claim superseded (reprocessed / cancelled); stopped without writing`);
        return;
      }
      const readable = e instanceof FileProblem || e instanceof XlsxFileError || e instanceof AggregatorLimitError;
      const message = readable ? e.message : GENERIC_FAILURE;
      if (!readable) {
        this.logger.error(`sales-import ${row.id} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      }
      await this.finish(row, { status: 'FAILED', error: message }).catch((err: unknown) =>
        this.logger.error(`sales-import ${row.id}: could not record FAILED: ${(err as Error).message}`),
      );
    }
  }

  private ownWhere(row: SalesImport): Prisma.SalesImportWhereInput {
    return { id: row.id, status: 'PROCESSING', claimToken: row.claimToken };
  }

  /**
   * Terminal NON-READY write, guarded by the claim token. Aggregates of an earlier READY run are dropped in the same
   * transaction (they no longer describe the file under the current mapping).
   */
  private async finish(row: SalesImport, data: Prisma.SalesImportUpdateManyMutationInput): Promise<boolean> {
    if (!row.claimToken) return false;
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.salesImport.updateMany({
        where: this.ownWhere(row),
        data: { finishedAt: new Date(), heartbeatAt: new Date(), ...data },
      });
      if (r.count === 0) {
        this.logger.warn(`sales-import ${row.id}: claim superseded or row changed; result not written`);
        return false;
      }
      await tx.salesImportAggregate.deleteMany({ where: { importId: row.id } });
      return true;
    });
  }

  private async run(row: SalesImport): Promise<void> {
    if (!row.claimToken) throw new ClaimLostError();
    if (row.attempts > SALES_IMPORT_MAX_ATTEMPTS) {
      throw new FileProblem(`Processing was attempted ${row.attempts - 1} times without finishing. Try Reprocess, or contact Gifsy support.`);
    }
    if (!(await isSalesImportEnabledUncached(this.prisma, row.clientId))) {
      throw new FileProblem('Sales Import is not enabled for this tenant.');
    }
    const profile = await this.prisma.salesImportProfile.findUnique({ where: { clientId: row.clientId } });
    const mapping = (profile?.columnMapping ?? null) as SalesColumnMapping | null;
    const roster = await loadRoster(this.prisma, row.clientId);
    const size = Number(row.sizeBytes);
    const parts = new PartsFile(this.storage, row.gcsPrefix, size);

    // Progress + heartbeat (single in-flight write; never blocks the parse). A heartbeat that matches no row means the
    // claim is gone (reprocess / cancel / reclaim): the parse loop stops at the next row.
    let bytesRead = 0;
    let rowsSeen = 0;
    let lastBeatAt = Date.now();
    let lastBeatRows = 0;
    let inflight: Promise<unknown> = Promise.resolve();
    let writing = false;
    let lost = false;
    const beat = (force = false) => {
      const now = Date.now();
      if (!force && (writing || (now - lastBeatAt < HEARTBEAT_MS && rowsSeen - lastBeatRows < HEARTBEAT_ROWS))) return;
      lastBeatAt = now;
      lastBeatRows = rowsSeen;
      writing = true;
      inflight = this.prisma.salesImport
        .updateMany({
          where: this.ownWhere(row),
          data: { rowsRead: rowsSeen, bytesRead: BigInt(Math.min(size, bytesRead)), heartbeatAt: new Date() },
        })
        .then((r) => {
          if (r.count === 0) lost = true;
        })
        .catch((e: unknown) => this.logger.warn(`sales-import ${row.id} heartbeat failed: ${(e as Error).message}`))
        .finally(() => (writing = false));
    };
    const checkClaim = () => {
      if (lost) throw new ClaimLostError();
    };

    // ── Source rows + sha256 of the whole upload ──
    const hash = createHash('sha256');
    let hashedBytes = 0;
    let csvDelimiter: string | null = null;
    let source: Readable;
    let rows: AsyncGenerator<SourceRow>;
    if (row.fileKind === 'XLSX') {
      // Sequential hash pass (cheap; the parse below reads only the needed zip entries, by range).
      for await (const c of parts.stream()) {
        hash.update(c as Buffer);
        hashedBytes += (c as Buffer).length;
        beat();
        checkClaim();
      }
      const plan = planXlsxRead(await loadCentralDirectory(parts, size));
      const scale = plan.totalCompressedBytes > 0 ? size / plan.totalCompressedBytes : 1;
      let copied = 0;
      source = resequencedXlsxStream(parts, plan, (n) => {
        copied += n;
        bytesRead = Math.round(copied * scale);
        beat();
      });
      rows = xlsxRows(source, mapping?.sheetName ?? null);
    } else {
      const tee = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          hashedBytes += chunk.length;
          bytesRead = hashedBytes;
          beat();
          cb(null, chunk);
        },
      });
      // M1: pipeline (not .pipe) — a GCS read error destroys the tee WITH the error, so the CSV iterator throws and the
      // import fails cleanly instead of hanging or finishing on a truncated stream.
      source = pipeline(parts.stream(), tee, () => undefined);
      rows = csvRows(source, undefined, { onDelimiter: (d) => (csvDelimiter = d) });
    }

    try {
      const outcome = await this.parse(row, mapping, roster.byNormalizedCode, rows, () => csvDelimiter, () => {
        rowsSeen++;
        beat();
        checkClaim();
      });
      await inflight;
      checkClaim();
      if (outcome.kind === 'needsMapping') {
        await this.finish(row, {
          status: 'NEEDS_MAPPING',
          error: outcome.reason,
          detectedHeaders: (outcome.detectedHeaders ?? Prisma.DbNull) as Prisma.InputJsonValue,
          rowsRead: 0,
          rowsSkipped: 0,
        });
        return;
      }
      if (hashedBytes !== size) {
        throw new FileProblem(`The uploaded file is incomplete (${hashedBytes} of ${size} bytes stored). Upload it again.`);
      }
      await this.writeReady(row, mapping!, outcome.result, outcome.detectedHeaders, hash.digest('hex'), size);
    } finally {
      if (!source.destroyed) source.destroy();
      await inflight;
    }
  }

  private async parse(
    row: SalesImport,
    mapping: SalesColumnMapping | null,
    roster: Map<string, string>,
    rows: AsyncGenerator<SourceRow>,
    delimiter: () => string | null,
    onRow: () => void,
  ): Promise<
    | { kind: 'needsMapping'; reason: string; detectedHeaders: string[][] | null }
    | { kind: 'ok'; result: AggregatorResult; detectedHeaders: string[][] }
  > {
    const head: SourceRow[] = [];
    let aggregator: SalesAggregator | null = null;
    let detectedHeaders: string[][] = [];
    const want = mapping && typeof mapping.headerRow === 'number' ? mapping.headerRow : null;
    try {
      for await (const r of rows) {
        onRow();
        if (isBlankRow(r.cells)) continue;
        if (aggregator) {
          aggregator.push(r.cells, r.rowNo);
          continue;
        }
        // S3: header detection never looks past SALES_IMPORT_MAX_COLUMNS columns (bounds the pre-header buffer too).
        head.push(r.cells.length > SALES_IMPORT_MAX_COLUMNS ? { rowNo: r.rowNo, cells: r.cells.slice(0, SALES_IMPORT_MAX_COLUMNS) } : r);
        const enough = want === null ? head.length >= HEADER_SCAN_ROWS : r.rowNo >= want || head.length >= MAX_PREHEADER_ROWS;
        if (!enough) continue;
        const decided = this.decideHeader(mapping, head, roster, delimiter());
        detectedHeaders = decided.detectedHeaders;
        if (decided.kind === 'needsMapping') return decided;
        aggregator = decided.aggregator;
      }
    } catch (e) {
      if (e instanceof XlsxSheetNotFoundError) return { kind: 'needsMapping', reason: e.message, detectedHeaders: null };
      if (e instanceof XlsxFileError || e instanceof FileProblem || e instanceof AggregatorLimitError || e instanceof ClaimLostError) throw e;
      if (e instanceof CsvLimitError) throw new FileProblem(`The CSV file could not be read: ${e.message}`);
      const detail = e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e);
      throw new FileProblem(
        row.fileKind === 'XLSX'
          ? `The .xlsx file could not be read (it may be damaged): ${detail}`
          : `The CSV file could not be read: ${detail}`,
      );
    }
    if (!aggregator) {
      // The file ended inside the header-scan window.
      const decided = this.decideHeader(mapping, head, roster, delimiter());
      if (decided.kind === 'needsMapping') return decided;
      aggregator = decided.aggregator;
      detectedHeaders = decided.detectedHeaders;
    }
    return { kind: 'ok', result: aggregator.result(), detectedHeaders };
  }

  private decideHeader(
    mapping: SalesColumnMapping | null,
    head: SourceRow[],
    roster: Map<string, string>,
    csvDelimiter: string | null,
  ):
    | { kind: 'needsMapping'; reason: string; detectedHeaders: string[][] }
    | { kind: 'ok'; aggregator: SalesAggregator; detectedHeaders: string[][] } {
    if (!mapping) {
      return {
        kind: 'needsMapping',
        reason: 'No column mapping is saved for this tenant yet. Set it up in Sales Import settings, then Reprocess.',
        detectedHeaders: detectedHeadersOf(head, null),
      };
    }
    if (head.length === 0) return { kind: 'needsMapping', reason: 'The file has no rows.', detectedHeaders: [] };
    const res = resolveHeader(head, mapping);
    if (res.needsMapping) return { kind: 'needsMapping', reason: res.reason, detectedHeaders: detectedHeadersOf(head, null) };
    const decimal = resolveDecimalSeparator(mapping.decimalSeparator, csvDelimiter);
    const agg = new SalesAggregator(mapping, res.colIdx, roster, undefined, decimal);
    for (const r of head.slice(res.headerRowIdx + 1)) agg.push(r.cells, r.rowNo);
    return { kind: 'ok', aggregator: agg, detectedHeaders: detectedHeadersOf(head, res.headerRowIdx) };
  }

  /**
   * The READY write (M2): ONE transaction that first re-locks the row by its claim token (a superseded worker finds
   * nothing → ClaimLostError, nothing written), then replaces the aggregates, stores unmatched.csv and flips the row to
   * READY with a new processingVersion (M7) and the mapping fingerprint (H2). A preview/apply can never observe a
   * half-written aggregate set, and a reprocess/cancel arriving meanwhile gets 409 busy (its NOWAIT lock fails).
   */
  private async writeReady(
    row: SalesImport,
    mapping: SalesColumnMapping,
    result: AggregatorResult,
    detectedHeaders: string[][],
    sha256: string,
    size: number,
  ): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        const own = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "sales_imports"
           WHERE "id" = ${row.id} AND "status" = 'PROCESSING' AND "claimToken" = ${row.claimToken}
             FOR UPDATE`);
        if (own.length === 0) throw new ClaimLostError();

        await tx.salesImportAggregate.deleteMany({ where: { importId: row.id } });
        let batch: Prisma.SalesImportAggregateCreateManyInput[] = [];
        for (const a of result.aggregates()) {
          batch.push({
            importId: row.id,
            month: a.month,
            outletCode: a.outletCode,
            dims: a.dims,
            dimKey: a.dimKey,
            amountPaise: a.amountPaise,
            qtyPico: a.qtyPico,
            lines: a.lines,
          });
          if (batch.length >= AGGREGATE_CHUNK) {
            await tx.salesImportAggregate.createMany({ data: batch });
            batch = [];
            await tx.salesImport.update({ where: { id: row.id }, data: { heartbeatAt: new Date() } });
          }
        }
        if (batch.length) await tx.salesImportAggregate.createMany({ data: batch });

        await this.storage.uploadStream(unmatchedCsvKey(row.gcsPrefix), Readable.from(unmatchedCsvLines(result.unmatched())), 'text/csv; charset=utf-8');

        const duplicate = await tx.salesImport.findFirst({
          where: { clientId: row.clientId, contentSha256: sha256, status: 'READY', id: { not: row.id }, createdAt: { lte: row.createdAt } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });

        const now = new Date();
        await tx.salesImport.update({
          where: { id: row.id },
          data: {
            status: 'READY',
            finishedAt: now,
            heartbeatAt: now,
            error: null,
            contentSha256: sha256,
            duplicateOfId: duplicate?.id ?? null,
            mappingSnapshot: mapping as unknown as Prisma.InputJsonValue,
            mappingFingerprint: mappingFingerprint(mapping),
            processingVersion: { increment: 1 },
            detectedHeaders: detectedHeaders as Prisma.InputJsonValue,
            bytesRead: BigInt(size),
            rowsRead: result.rowsRead,
            rowsSkipped: result.rowsSkipped,
            errorSamples: result.errorSamples as unknown as Prisma.InputJsonValue,
            monthSummaries: result.monthSummaries as unknown as Prisma.InputJsonValue,
            dimensionValues: result.dimensionValues as unknown as Prisma.InputJsonValue,
            dimensionCombos: result.dimensionCombos as unknown as Prisma.InputJsonValue,
          },
        });
      },
      { timeout: FINAL_TX_TIMEOUT_MS, maxWait: 30_000 },
    );
  }
}
