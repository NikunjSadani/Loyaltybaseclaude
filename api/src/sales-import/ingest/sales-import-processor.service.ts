import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type SalesImport } from '@prisma/client';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { isSalesImportEnabledUncached } from '../sales-import-access';
import { SALES_IMPORT_MAX_ATTEMPTS, type SalesColumnMapping } from '../sales-import.contract';
import { SalesAggregator, type AggregatorResult } from './aggregator';
import { claimNextImport } from './claim';
import { csvRows } from './csv-row-source';
import { HEADER_SCAN_ROWS, resolveHeader, type SourceRow } from './header';
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

/** A problem with the FILE (shown to the admin verbatim). */
class FileProblem extends Error {}

const GENERIC_FAILURE = 'Processing failed unexpectedly. Try Reprocess; if it fails again, contact Gifsy support.';

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : '';
  return String(v).slice(0, 200);
}

/**
 * SalesImportProcessorService — claims QUEUED (or heartbeat-stale PROCESSING) imports and turns the
 * uploaded file into SalesImportAggregate rows + frozen month summaries (plan §7.1). Runs in the Cloud
 * Run JOB (worker.main.ts) or in-process when SALES_IMPORT_RUNNER=inline. OWNER: Lane I.
 *
 * Outcomes: READY | NEEDS_MAPPING (no profile / headers or sheet not found; `detectedHeaders` = first 10
 * rows) | FAILED (flag off, too many attempts, unreadable file, unexpected error — message, no stack).
 * Only the claim that is still current (same `attempts`) may finalise the row.
 */
@Injectable()
export class SalesImportProcessorService {
  private readonly logger = new Logger(SalesImportProcessorService.name);

  constructor(
    readonly prisma: PrismaService,
    readonly storage: StorageService,
  ) {}

  /** §7.1.1 claim (FOR UPDATE SKIP LOCKED). null = nothing claimable. */
  async claimNext(): Promise<SalesImport | null> {
    return claimNextImport(this.prisma);
  }

  /** §7.1 steps 2–10 for one claimed import. Never throws for a per-import problem. */
  async processClaimed(row: SalesImport): Promise<void> {
    try {
      await this.run(row);
    } catch (e) {
      const message = e instanceof FileProblem || e instanceof XlsxFileError ? e.message : GENERIC_FAILURE;
      if (!(e instanceof FileProblem || e instanceof XlsxFileError)) {
        this.logger.error(`sales-import ${row.id} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      }
      await this.finish(row, { status: 'FAILED', error: message });
    }
  }

  /** Terminal write, guarded by the claim token so a superseded worker can't overwrite a newer claim. */
  private async finish(row: SalesImport, data: Prisma.SalesImportUpdateManyMutationInput): Promise<boolean> {
    const r = await this.prisma.salesImport.updateMany({
      where: { id: row.id, status: 'PROCESSING', attempts: row.attempts },
      data: { finishedAt: new Date(), heartbeatAt: new Date(), ...data },
    });
    if (r.count === 0) this.logger.warn(`sales-import ${row.id}: claim superseded or row changed; result not written`);
    return r.count > 0;
  }

  private async run(row: SalesImport): Promise<void> {
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

    // Progress + heartbeat (single in-flight write; never blocks the parse).
    let bytesRead = 0;
    let rowsSeen = 0;
    let lastBeatAt = Date.now();
    let lastBeatRows = 0;
    let inflight: Promise<unknown> = Promise.resolve();
    let writing = false;
    const beat = (force = false) => {
      const now = Date.now();
      if (!force && (writing || (now - lastBeatAt < HEARTBEAT_MS && rowsSeen - lastBeatRows < HEARTBEAT_ROWS))) return;
      lastBeatAt = now;
      lastBeatRows = rowsSeen;
      writing = true;
      inflight = this.prisma.salesImport
        .updateMany({
          where: { id: row.id, status: 'PROCESSING', attempts: row.attempts },
          data: { rowsRead: rowsSeen, bytesRead: BigInt(Math.min(size, bytesRead)), heartbeatAt: new Date() },
        })
        .catch((e: unknown) => this.logger.warn(`sales-import ${row.id} heartbeat failed: ${(e as Error).message}`))
        .finally(() => (writing = false));
    };

    // ── Source rows + sha256 of the whole upload ──
    const hash = createHash('sha256');
    let hashedBytes = 0;
    let source: Readable;
    let rows: AsyncGenerator<SourceRow>;
    if (row.fileKind === 'XLSX') {
      // Sequential hash pass (cheap; the parse below reads only the needed zip entries, by range).
      for await (const c of parts.stream()) {
        hash.update(c as Buffer);
        hashedBytes += (c as Buffer).length;
        beat();
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
      source = parts.stream().pipe(tee);
      rows = csvRows(source);
    }

    try {
      const outcome = await this.parse(row, mapping, roster.byNormalizedCode, rows, () => {
        rowsSeen++;
        beat();
      });
      await inflight;
      if (outcome.kind === 'needsMapping') {
        await this.finish(row, {
          status: 'NEEDS_MAPPING',
          error: outcome.reason,
          detectedHeaders: outcome.detectedHeaders as Prisma.InputJsonValue,
          rowsRead: 0,
          rowsSkipped: 0,
        });
        return;
      }
      if (hashedBytes !== size) {
        throw new FileProblem(`The uploaded file is incomplete (${hashedBytes} of ${size} bytes stored). Upload it again.`);
      }
      await this.writeReady(row, mapping!, outcome.result, outcome.detectedHeaders, hash.digest('hex'), roster.rosterHash, size);
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
        if (r.cells.every((c) => c === null || c === undefined || (typeof c === 'string' && c.trim() === ''))) continue;
        if (aggregator) {
          aggregator.push(r.cells, r.rowNo);
          continue;
        }
        head.push(r);
        const enough = want === null ? head.length >= HEADER_SCAN_ROWS : r.rowNo >= want || head.length >= MAX_PREHEADER_ROWS;
        if (!enough) continue;
        const decided = this.decideHeader(mapping, head, roster);
        detectedHeaders = decided.detectedHeaders;
        if (decided.kind === 'needsMapping') return decided;
        aggregator = decided.aggregator;
      }
    } catch (e) {
      if (e instanceof XlsxSheetNotFoundError) return { kind: 'needsMapping', reason: e.message, detectedHeaders: null };
      if (e instanceof XlsxFileError || e instanceof FileProblem) throw e;
      const detail = e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e);
      throw new FileProblem(
        row.fileKind === 'XLSX'
          ? `The .xlsx file could not be read (it may be damaged): ${detail}`
          : `The CSV file could not be read: ${detail}`,
      );
    }
    if (!aggregator) {
      // The file ended inside the header-scan window.
      const decided = this.decideHeader(mapping, head, roster);
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
  ):
    | { kind: 'needsMapping'; reason: string; detectedHeaders: string[][] }
    | { kind: 'ok'; aggregator: SalesAggregator; detectedHeaders: string[][] } {
    const detectedHeaders = head.slice(0, HEADER_SCAN_ROWS).map((r) => r.cells.map(cellText));
    if (!mapping) {
      return { kind: 'needsMapping', reason: 'No column mapping is saved for this tenant yet. Set it up in Sales Import settings, then Reprocess.', detectedHeaders };
    }
    if (head.length === 0) return { kind: 'needsMapping', reason: 'The file has no rows.', detectedHeaders };
    const res = resolveHeader(head, mapping);
    if (res.needsMapping) return { kind: 'needsMapping', reason: res.reason, detectedHeaders };
    const agg = new SalesAggregator(mapping, res.colIdx, roster);
    for (const r of head.slice(res.headerRowIdx + 1)) agg.push(r.cells, r.rowNo);
    return { kind: 'ok', aggregator: agg, detectedHeaders };
  }

  private async writeReady(
    row: SalesImport,
    mapping: SalesColumnMapping,
    result: AggregatorResult,
    detectedHeaders: string[][],
    sha256: string,
    rosterHash: string,
    size: number,
  ): Promise<void> {
    // Idempotent re-run: drop any aggregates of an earlier (crashed / reprocessed) attempt first.
    await this.prisma.salesImportAggregate.deleteMany({ where: { importId: row.id } });
    let batch: Prisma.SalesImportAggregateCreateManyInput[] = [];
    for (const a of result.aggregates()) {
      batch.push({
        importId: row.id,
        month: a.month,
        outletCode: a.outletCode,
        dims: a.dims,
        dimKey: a.dimKey,
        amountPaise: a.amountPaise,
        qtyMicro: a.qtyMicro,
        lines: a.lines,
      });
      if (batch.length >= AGGREGATE_CHUNK) {
        await this.prisma.salesImportAggregate.createMany({ data: batch });
        batch = [];
        await this.heartbeatOnly(row);
      }
    }
    if (batch.length) await this.prisma.salesImportAggregate.createMany({ data: batch });

    await this.storage.uploadStream(unmatchedCsvKey(row.gcsPrefix), Readable.from(unmatchedCsvLines(result.unmatched())), 'text/csv; charset=utf-8');

    const duplicate = await this.prisma.salesImport.findFirst({
      where: { clientId: row.clientId, contentSha256: sha256, status: 'READY', id: { not: row.id }, createdAt: { lte: row.createdAt } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    await this.finish(row, {
      status: 'READY',
      error: null,
      contentSha256: sha256,
      duplicateOfId: duplicate?.id ?? null,
      mappingSnapshot: mapping as unknown as Prisma.InputJsonValue,
      detectedHeaders: detectedHeaders as Prisma.InputJsonValue,
      rosterHash,
      bytesRead: BigInt(size),
      rowsRead: result.rowsRead,
      rowsSkipped: result.rowsSkipped,
      errorSamples: result.errorSamples as unknown as Prisma.InputJsonValue,
      monthSummaries: result.monthSummaries as unknown as Prisma.InputJsonValue,
      dimensionValues: result.dimensionValues as unknown as Prisma.InputJsonValue,
      dimensionCombos: result.dimensionCombos as unknown as Prisma.InputJsonValue,
    });
  }

  private async heartbeatOnly(row: SalesImport): Promise<void> {
    await this.prisma.salesImport.updateMany({
      where: { id: row.id, status: 'PROCESSING', attempts: row.attempts },
      data: { heartbeatAt: new Date() },
    });
  }
}
