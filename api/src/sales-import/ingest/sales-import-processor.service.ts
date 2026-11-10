import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type SalesImport } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import * as v8 from 'node:v8';
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
import { HEAP_TRIP_SHARE_OF_OLD_SPACE, heapTripBytes } from './heap-budget';
import { AggregatorLimitError, SalesAggregator, type AggregatorResult, type DecimalEvidenceSummary } from './aggregator';
import { claimNextImport } from './claim';
import { CsvLimitError, csvRows } from './csv-row-source';
import { HEADER_SCAN_ROWS, resolveHeader, type SourceRow } from './header';
import { mappingFingerprint } from './mapping-fingerprint';
import { normalizeHeader, resolveDecimalSeparator, type DecimalSeparator } from './normalize';
import { PartsFile, unmatchedCsvKey } from './parts-file';
import { loadRoster } from './roster';
import { unmatchedCsvLines } from './unmatched-csv';
import { XlsxSheetNotFoundError, xlsxRows } from './xlsx-row-source';
import { WorkerStoppingError, type RunOutcome, type WorkerStop } from './worker-stop';
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

/**
 * Memory backstop (plan §7.1 step 11; real-DB finding 1; audit M-1). The guard trips at a FIXED used-heap budget of
 * 75 % of the configured OLD-SPACE size (heap-budget.ts) — not a fraction of heap_size_limit, which is larger than the
 * old space (1700 → limit ≈ 1,892 MB on node:24). With --max-old-space-size=1700 on the 2 GiB job that is 1,275 MiB of
 * used heap vs the real file's measured ≈ 1.06 GB peak. Checked every 2,000 rows AND at least every 2 s, and only after
 * TWO consecutive over-threshold checks.
 */
export const HEAP_GUARD_FRACTION = HEAP_TRIP_SHARE_OF_OLD_SPACE; // of the OLD-SPACE size (heap-budget.ts), not heap_size_limit
export const HEAP_CHECK_ROWS = 2_000;
export const HEAP_CHECK_MS = 2_000;

/**
 * Reads V8's own heap statistics (USED heap vs the fixed trip budget) and reports "over" only
 * after TWO consecutive over-threshold checks — a transient peak that the next GC clears never fails an import.
 * `due(rows)` decides when to check: every HEAP_CHECK_ROWS rows or HEAP_CHECK_MS, whichever comes first.
 */
export class HeapGuard {
  private strikes = 0;
  private lastCheckAt = Date.now();
  private lastCheckRows = 0;
  constructor(
    /** Used-heap bytes at which to trip: 75 % of the configured old-space size (heap-budget.ts; audit M-1). */
    private readonly tripBytes = heapTripBytes(),
    private readonly everyRows = HEAP_CHECK_ROWS,
    private readonly everyMs = HEAP_CHECK_MS,
  ) {}

  /** Is a check due? Relative to the LAST check (audit L1): ≥ everyRows rows since, or ≥ everyMs elapsed. */
  due(rows: number, now = Date.now()): boolean {
    if (rows - this.lastCheckRows >= this.everyRows || now - this.lastCheckAt >= this.everyMs) {
      this.lastCheckAt = now;
      this.lastCheckRows = rows;
      return true;
    }
    return false;
  }

  /** USED heap only (audit L1: committed / available space is not a reliable signal) vs the limit. */
  overLimit(): boolean {
    const h = v8.getHeapStatistics();
    this.strikes = h.used_heap_size > this.tripBytes ? this.strikes + 1 : 0;
    return this.strikes >= 2;
  }

  /** due() && overLimit() — the one entry point for the row hook and the timer, so checks stay spaced. */
  check(rows: number, now = Date.now()): boolean {
    return this.due(rows, now) && this.overLimit();
  }
}

/** A problem with the FILE (shown to the admin verbatim). */
class FileProblem extends Error {}

const tooLarge = () => new FileProblem('The file is too large to process in one go. Split it by month and upload the parts separately.');

/** Progress / heartbeat / abort state of one run. */
interface Prog {
  bytesRead: number;
  rowsSeen: number;
  lastBeatAt: number;
  lastBeatRows: number;
  writing: boolean;
  lost: boolean;
  /** The heap backstop fired: every loop throws tooLarge() at its next check. */
  heapTripped: boolean;
  /** Destroys the current pass's input stream (set while a pass runs). */
  abortSource: ((e: Error) => void) | null;
  /** A graceful stop (SIGTERM) was requested: every loop throws WorkerStoppingError at its next check (plan §10c). */
  stopping: boolean;
  /** The READY transaction has started: a stop no longer interrupts the run (it commits whole or rolls back). */
  finalizing: boolean;
}

/** Re-yields `lines`, checking `check` every 10,000 lines (the unmatched.csv build can run long without rows). */
function* guardedLines(lines: Iterable<string>, check: () => void): Generator<string> {
  let n = 0;
  for (const l of lines) {
    if (++n % 10_000 === 0) check();
    yield l;
  }
}

interface AggregatorReadOptions {
  decimal: DecimalSeparator;
  collectDecimalEvidence: boolean;
}

type ParseOutcome =
  | { kind: 'needsMapping'; reason: string; detectedHeaders: string[][] | null }
  | { kind: 'ok'; result: AggregatorResult; detectedHeaders: string[][] };

/**
 * 'auto' decimal separator (H1 re-audit), decided ONCE per file from the text measure values: unambiguous evidence for
 * exactly one separator decides; evidence for BOTH, or only ambiguous values ("2.000": 2 or 2000?) → NEEDS_MAPPING with a
 * clear reason — never a guess. No separator anywhere → the starting separator (it changes nothing).
 */
export function decideDecimal(ev: DecimalEvidenceSummary, start: DecimalSeparator): { decimal: DecimalSeparator } | { needsMapping: string } {
  if (ev.dot > 0 && ev.comma > 0) {
    return {
      needsMapping:
        `The amount / quantity values use both "." and "," as the decimal separator (e.g. "${ev.examples.dot}" and "${ev.examples.comma}"). ` +
        'Fix the file, or choose the decimal separator in Sales Import settings, then Reprocess.',
    };
  }
  if (ev.dot > 0) return { decimal: '.' };
  if (ev.comma > 0) return { decimal: ',' };
  if (ev.ambiguous > 0) {
    return {
      needsMapping:
        `Choose the decimal separator in Sales Import settings, then Reprocess: values like "${ev.examples.ambiguous}" could mean ` +
        'a whole number with a thousands separator or a decimal, and nothing else in the file tells which.',
    };
  }
  return { decimal: start };
}
/**
 * A run stopped by a signal within this long of its claim is a deploy / scale-down stop: its claim is released WITHOUT
 * counting the attempt. A later stop (e.g. the job's task timeout on a file that never finishes, or a stalled read)
 * counts it, so SALES_IMPORT_MAX_ATTEMPTS still ends such an import FAILED instead of handing it back forever (claims are
 * oldest-first across tenants, so a forever-requeued import would block every later one). Audit H1.
 */
export const STOP_RESTORES_ATTEMPT_WITHIN_MS = 10 * 60_000;

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
 * insert new ones, flip to READY) is ONE transaction holding the row lock, guarded by the token (unmatched.csv is
 * written to GCS just before it, never inside it).
 */
@Injectable()
export class SalesImportProcessorService {
  private readonly logger = new Logger(SalesImportProcessorService.name);

  /** Wall clock (ms); a seam for tests of the stop-attempt rule. */
  clock: () => number = () => Date.now();

  constructor(
    readonly prisma: PrismaService,
    readonly storage: StorageService,
  ) {}

  /** §7.1.1 claim (FOR UPDATE SKIP LOCKED) with a fresh random token. null = nothing claimable. */
  async claimNext(): Promise<SalesImport | null> {
    return claimNextImport(this.prisma, randomUUID());
  }

  /**
   * §7.1 steps 2–10 for one claimed import. Never throws for a per-import problem.
   * `stop` (the job worker; plan §10c): once requested, the read is aborted and — unless the READY transaction already
   * committed — the claim is RELEASED (QUEUED again, never FAILED here) for the next drain. Whatever error the abort
   * produced, a run that ends after a stop request is released, not failed. The attempt is NOT counted only when the stop
   * came within STOP_RESTORES_ATTEMPT_WITHIN_MS of the start (audit H1).
   * Returns the outcome: 'finished' (READY / NEEDS_MAPPING / FAILED written), 'released', or 'superseded'.
   */
  async processClaimed(row: SalesImport, stop?: WorkerStop): Promise<RunOutcome> {
    const startedAt = this.clock();
    try {
      await this.run(row, stop);
      return 'finished';
    } catch (e) {
      if (e instanceof ClaimLostError) {
        this.logger.warn(`sales-import ${row.id}: claim superseded (reprocessed / cancelled); stopped without writing`);
        return 'superseded';
      }
      if (stop?.requested) {
        const elapsedMs = this.clock() - startedAt;
        await this.release(row, stop.reason, elapsedMs >= STOP_RESTORES_ATTEMPT_WITHIN_MS, elapsedMs);
        return 'released';
      }
      const readable = e instanceof FileProblem || e instanceof XlsxFileError || e instanceof AggregatorLimitError;
      const message = readable ? e.message : GENERIC_FAILURE;
      if (!readable) {
        this.logger.error(`sales-import ${row.id} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      }
      await this.finish(row, { status: 'FAILED', error: message }).catch((err: unknown) =>
        this.logger.error(`sales-import ${row.id}: could not record FAILED: ${(err as Error).message}`),
      );
      return 'finished';
    }
  }

  private ownWhere(row: SalesImport): Prisma.SalesImportWhereInput {
    return { id: row.id, status: 'PROCESSING', claimToken: row.claimToken };
  }

  /**
   * Graceful stop (plan §10c): hand the claim back so the next drain picks the import up at once — QUEUED, token and
   * heartbeat cleared, progress reset. `attempts`: back to its value before this claim (the claim added 1) for an early
   * stop; kept (= counted) when `countAttempt` (audit H1). Guarded by the claim token: a superseded claim matches nothing.
   * `queuedAt` is kept (claims are ordered by createdAt). Never throws: if it fails, the stale-heartbeat reclaim
   * recovers the row later.
   */
  private async release(row: SalesImport, reason: string | null, countAttempt: boolean, elapsedMs: number): Promise<void> {
    if (!row.claimToken) return;
    try {
      const r = await this.prisma.salesImport.updateMany({
        where: this.ownWhere(row),
        data: {
          status: 'QUEUED',
          claimToken: null,
          heartbeatAt: null,
          startedAt: null,
          attempts: countAttempt ? row.attempts : Math.max(0, row.attempts - 1),
          bytesRead: 0n,
          rowsRead: 0,
        },
      });
      this.logger.warn(
        r.count > 0
          ? `sales-import ${row.id}: worker stopping (${reason ?? 'signal'}) after ${Math.round(elapsedMs / 1000)} s; claim released, back to QUEUED (${countAttempt ? `attempt ${row.attempts} counted` : 'attempt not counted'})`
          : `sales-import ${row.id}: worker stopping (${reason ?? 'signal'}); claim already gone, nothing released`,
      );
    } catch (err) {
      this.logger.error(`sales-import ${row.id}: could not release the claim on stop: ${(err as Error).message}`);
    }
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

  private async run(row: SalesImport, stop?: WorkerStop): Promise<void> {
    if (!row.claimToken) throw new ClaimLostError();
    if (stop?.requested) throw new WorkerStoppingError();
    if (row.attempts > SALES_IMPORT_MAX_ATTEMPTS) {
      throw new FileProblem(
        `Processing was attempted ${row.attempts - 1} times without finishing (it took too long or was stopped repeatedly). ` +
          'Try Reprocess (splitting the file by month helps), or contact Gifsy support.',
      );
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
    const prog: Prog = {
      bytesRead: 0, rowsSeen: 0, lastBeatAt: Date.now(), lastBeatRows: 0, writing: false, lost: false,
      heapTripped: false, abortSource: null, stopping: false, finalizing: false,
    };
    let inflight: Promise<unknown> = Promise.resolve();
    const beat = () => {
      const now = Date.now();
      if (prog.writing || (now - prog.lastBeatAt < HEARTBEAT_MS && prog.rowsSeen - prog.lastBeatRows < HEARTBEAT_ROWS)) return;
      prog.lastBeatAt = now;
      prog.lastBeatRows = prog.rowsSeen;
      prog.writing = true;
      inflight = this.prisma.salesImport
        .updateMany({
          where: this.ownWhere(row),
          data: { rowsRead: prog.rowsSeen, bytesRead: BigInt(Math.min(size, prog.bytesRead)), heartbeatAt: new Date() },
        })
        .then((r) => {
          if (r.count === 0) prog.lost = true;
        })
        .catch((e: unknown) => this.logger.warn(`sales-import ${row.id} heartbeat failed: ${(e as Error).message}`))
        .finally(() => (prog.writing = false));
    };
    const checkClaim = () => {
      if (prog.lost) throw new ClaimLostError();
      if (prog.stopping && !prog.finalizing) throw new WorkerStoppingError();
    };
    // Graceful stop: flag it and destroy the current input stream (the read loop then throws WorkerStoppingError).
    const offStop = stop?.onStop(() => {
      if (prog.finalizing) return;
      prog.stopping = true;
      prog.abortSource?.(new WorkerStoppingError());
    });
    // Memory backstop (plan §7.1 step 11). Checked from every row AND from an unref'd timer (audit M2), so phases with
    // no rows — exceljs building its shared-strings table, the aggregate write loop, the unmatched.csv build — are
    // guarded too. A trip sets a flag (row / write loops throw on it) and destroys the current input stream.
    const heapGuard = new HeapGuard();
    const trip = () => {
      if (prog.heapTripped) return;
      prog.heapTripped = true;
      prog.abortSource?.(tooLarge());
    };
    const heapTimer = setInterval(() => {
      if (!prog.heapTripped && heapGuard.check(prog.rowsSeen)) trip();
    }, HEAP_CHECK_MS);
    heapTimer.unref();
    const checkHeap = () => {
      if (prog.heapTripped) throw tooLarge();
    };
    const onRow = () => {
      prog.rowsSeen++;
      beat();
      checkClaim();
      if (heapGuard.check(prog.rowsSeen)) trip();
      checkHeap();
    };
    try {
      await this.runPasses(row, mapping, roster, parts, size, prog, beat, checkClaim, onRow, checkHeap, () => inflight, stop);
    } finally {
      clearInterval(heapTimer);
      offStop?.();
    }
  }

  private async runPasses(
    row: SalesImport,
    mapping: SalesColumnMapping | null,
    roster: { byNormalizedCode: Map<string, string> },
    parts: PartsFile,
    size: number,
    prog: Prog,
    beat: () => void,
    checkClaim: () => void,
    onRow: () => void,
    checkHeap: () => void,
    inflightNow: () => Promise<unknown>,
    stop?: WorkerStop,
  ): Promise<void> {
    // ── Pass 1: sha256 of the whole upload + parse (+ decimal-separator evidence when the mapping says 'auto') ──
    const setting = mapping?.decimalSeparator ?? 'auto';
    const hash = createHash('sha256');
    const pass1 = await this.parsePass(row, mapping, roster.byNormalizedCode, parts, size, prog, beat, checkClaim, onRow, {
      hash,
      collectDecimalEvidence: setting === 'auto',
    });
    await inflightNow();
    checkClaim();
    const startDecimal = pass1.decimal;
    let outcome: ParseOutcome | null = pass1.outcome;
    if (outcome.kind === 'ok' && pass1.hashedBytes !== size) {
      throw new FileProblem(`The uploaded file is incomplete (${pass1.hashedBytes} of ${size} bytes stored). Upload it again.`);
    }
    (pass1 as { outcome: ParseOutcome | null }).outcome = null; // only `outcome` holds pass 1's aggregates from here on

    // ── 'auto' decimal separator: decided ONCE per file from the evidence; never guessed (H1 re-audit) ──
    if (outcome.kind === 'ok' && setting === 'auto') {
      const decision = decideDecimal(outcome.result.decimalEvidence, startDecimal);
      if ('needsMapping' in decision) {
        outcome = { kind: 'needsMapping', reason: decision.needsMapping, detectedHeaders: outcome.detectedHeaders };
      } else if (decision.decimal !== startDecimal) {
        // Pass 1 read text numbers with the other separator: read the file again with the decided one. Pass 1's
        // aggregates are released FIRST (re-check H2) so the two passes never hold the file's maps at the same time.
        outcome = null;
        prog.rowsSeen = 0;
        prog.lastBeatRows = 0;
        prog.bytesRead = 0;
        const pass2 = await this.parsePass(row, mapping, roster.byNormalizedCode, parts, size, prog, beat, checkClaim, onRow, {
          decimal: decision.decimal,
        });
        await inflightNow();
        checkClaim();
        outcome = pass2.outcome;
      }
    }

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
    checkHeap();
    await this.writeReady(row, mapping!, outcome.result, outcome.detectedHeaders, hash.digest('hex'), size, checkHeap, {
      checkStop: checkClaim,
      beginFinal: () => {
        prog.finalizing = true;
        stop?.enterCritical();
      },
      endFinal: () => stop?.exitCritical(),
    });
  }

  /** One streaming read of the stored file (pass 1 also hashes it). Always releases its streams. */
  private async parsePass(
    row: SalesImport,
    mapping: SalesColumnMapping | null,
    roster: Map<string, string>,
    parts: PartsFile,
    size: number,
    prog: Prog,
    beat: () => void,
    checkClaim: () => void,
    onRow: () => void,
    opts: { hash?: ReturnType<typeof createHash>; decimal?: DecimalSeparator; collectDecimalEvidence?: boolean },
  ): Promise<{ outcome: ParseOutcome; hashedBytes: number; decimal: DecimalSeparator }> {
    let hashedBytes = 0;
    let streamedBytes = 0; // progress for every pass (pass 2 does not hash)
    let csvDelimiter: string | null = null;
    let source: Readable;
    let rows: AsyncGenerator<SourceRow>;
    const xlsxFailure: { error: Error | null } = { error: null };
    if (row.fileKind === 'XLSX') {
      if (opts.hash) {
        // Sequential hash pass (cheap; the parse below reads only the needed zip entries, by range). Abortable by the
        // heap timer like the parse itself.
        const hs = parts.stream();
        prog.abortSource = (e: Error) => {
          if (!hs.destroyed) hs.destroy(e);
        };
        try {
          for await (const c of hs) {
            opts.hash.update(c as Buffer);
            hashedBytes += (c as Buffer).length;
            beat();
            checkClaim();
            if (prog.heapTripped) throw tooLarge();
          }
        } catch (e) {
          if (prog.stopping) throw new WorkerStoppingError();
          if (prog.heapTripped) throw tooLarge();
          throw e;
        } finally {
          prog.abortSource = null;
        }
      }
      const plan = planXlsxRead(await loadCentralDirectory(parts, size));
      const scale = plan.totalCompressedBytes > 0 ? size / plan.totalCompressedBytes : 1;
      let copied = 0;
      source = resequencedXlsxStream(
        parts,
        plan,
        (n) => {
          copied += n;
          prog.bytesRead = Math.round(copied * scale);
          beat();
        },
        (e) => (xlsxFailure.error = e),
      );
      rows = xlsxRows(source, mapping?.sheetName ?? null);
    } else {
      const hash = opts.hash;
      const tee = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          if (hash) {
            hash.update(chunk);
            hashedBytes += chunk.length;
          }
          streamedBytes += chunk.length;
          prog.bytesRead = streamedBytes;
          beat();
          cb(null, chunk);
        },
      });
      // M1: pipeline (not .pipe) — a GCS read error destroys the tee WITH the error, so the CSV iterator throws and the
      // import fails cleanly instead of hanging or finishing on a truncated stream.
      source = pipeline(parts.stream(), tee, () => undefined);
      rows = csvRows(source, undefined, { onDelimiter: (d) => (csvDelimiter = d) });
    }
    let decimal: DecimalSeparator = opts.decimal ?? '.';
    // The heap timer aborts the read by destroying the input stream with the readable error (audit M2).
    prog.abortSource = (e: Error) => {
      if (!source.destroyed) source.destroy(e);
    };
    if (prog.heapTripped) prog.abortSource(tooLarge());
    if (prog.stopping) prog.abortSource(new WorkerStoppingError());
    try {
      // Called when the header is resolved (the CSV delimiter is known by then): how the aggregator reads text numbers.
      const aggOpts = () => {
        decimal = opts.decimal ?? resolveDecimalSeparator(mapping?.decimalSeparator, csvDelimiter);
        return { decimal, collectDecimalEvidence: opts.collectDecimalEvidence === true };
      };
      let outcome: ParseOutcome;
      try {
        outcome = await this.parse(row, mapping, roster, rows, onRow, aggOpts, xlsxFailure);
      } catch (e) {
        // A graceful stop aborted the read (plan §10c): whatever the reader reported while its input was torn down is a
        // consequence — the run is released, never failed.
        if (prog.stopping) throw new WorkerStoppingError();
        // Audit M-2: when the heap backstop aborted the read, THAT is the reason — whatever the reader reported while
        // its input was being torn down (e.g. "re-sequenced stream closed" / a "corrupt" wrap) is a consequence.
        if (prog.heapTripped) throw tooLarge();
        throw e;
      }
      if (prog.stopping) throw new WorkerStoppingError();
      if (prog.heapTripped) throw tooLarge();
      return { outcome, hashedBytes, decimal };
    } finally {
      prog.abortSource = null;
      if (!source.destroyed) source.destroy();
    }
  }

  private async parse(
    row: SalesImport,
    mapping: SalesColumnMapping | null,
    roster: Map<string, string>,
    rows: AsyncGenerator<SourceRow>,
    onRow: () => void,
    aggOpts: () => AggregatorReadOptions,
    xlsxFailure: { error: Error | null },
  ): Promise<ParseOutcome> {
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
        const decided = this.decideHeader(mapping, head, roster, aggOpts);
        detectedHeaders = decided.detectedHeaders;
        if (decided.kind === 'needsMapping') return decided;
        aggregator = decided.aggregator;
      }
    } catch (err) {
      // M2: a size violation detected by the xlsx re-sequencer is the root cause, whatever exceljs wrapped it in.
      const e = xlsxFailure.error ?? err;
      if (e instanceof XlsxSheetNotFoundError) return { kind: 'needsMapping', reason: e.message, detectedHeaders: null };
      if (
        e instanceof XlsxFileError || e instanceof FileProblem || e instanceof AggregatorLimitError || e instanceof ClaimLostError ||
        e instanceof WorkerStoppingError
      ) throw e;
      if (e instanceof CsvLimitError) throw new FileProblem(`The CSV file could not be read: ${e.message}`);
      const detail = e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e);
      throw new FileProblem(
        row.fileKind === 'XLSX'
          ? `The .xlsx file could not be read (it may be damaged): ${detail}`
          : `The CSV file could not be read: ${detail}`,
      );
    }
    if (xlsxFailure.error) throw xlsxFailure.error;
    if (!aggregator) {
      // The file ended inside the header-scan window.
      const decided = this.decideHeader(mapping, head, roster, aggOpts);
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
    aggOpts: () => AggregatorReadOptions,
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
    const { decimal, collectDecimalEvidence } = aggOpts();
    const agg = new SalesAggregator(mapping, res.colIdx, roster, undefined, decimal, {}, { collectDecimalEvidence });
    for (const r of head.slice(res.headerRowIdx + 1)) agg.push(r.cells, r.rowNo);
    return { kind: 'ok', aggregator: agg, detectedHeaders: detectedHeadersOf(head, res.headerRowIdx) };
  }

  /**
   * The READY write (M2): ONE transaction that first re-locks the row by its claim token (a superseded worker finds
   * nothing → ClaimLostError, nothing written), then replaces the aggregates and flips the row to
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
    checkHeap: () => void = () => undefined,
    final: { checkStop: () => void; beginFinal: () => void; endFinal: () => void } = {
      checkStop: () => undefined, beginFinal: () => undefined, endFinal: () => undefined,
    },
  ): Promise<void> {
    // GCS I/O never runs inside a DB transaction (re-audit M1). Written first: if the claim turns out to be lost below,
    // the object is an orphan under this import's own prefix and goes with its delete / retention purge. A graceful stop
    // during the upload aborts it (plan §10c); the orphan goes the same way.
    const csvKey = unmatchedCsvKey(row.gcsPrefix, row.claimToken!);
    const check = () => {
      checkHeap();
      final.checkStop();
    };
    await this.storage.uploadStream(csvKey, Readable.from(guardedLines(unmatchedCsvLines(result.unmatched()), check)), 'text/csv; charset=utf-8');
    // Last point a stop is honoured. From here the READY transaction runs to its end (commit, or a whole rollback if the
    // process is killed first) — never half-written.
    final.checkStop();
    final.beginFinal();
    try {
      await this.writeReadyTx(row, mapping, result, detectedHeaders, sha256, size, csvKey, checkHeap);
    } finally {
      final.endFinal();
    }
  }

  private async writeReadyTx(
    row: SalesImport,
    mapping: SalesColumnMapping,
    result: AggregatorResult,
    detectedHeaders: string[][],
    sha256: string,
    size: number,
    csvKey: string,
    checkHeap: () => void,
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
            checkHeap();
            await tx.salesImportAggregate.createMany({ data: batch });
            batch = [];
            await tx.salesImport.update({ where: { id: row.id }, data: { heartbeatAt: new Date() } });
          }
        }
        if (batch.length) await tx.salesImportAggregate.createMany({ data: batch });

        const duplicate = await tx.salesImport.findFirst({
          // L2: a "reprocess as new" import is never flagged as a duplicate of its own parent.
          where: {
            clientId: row.clientId,
            contentSha256: sha256,
            status: 'READY',
            id: { notIn: [row.id, ...(row.reprocessedFromId ? [row.reprocessedFromId] : [])] },
            createdAt: { lte: row.createdAt },
          },
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
            unmatchedCsvKey: csvKey,
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
