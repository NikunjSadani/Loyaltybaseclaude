import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma, type ExportRequest } from '@prisma/client';
import { PassThrough, Transform, pipeline } from 'node:stream';
import { createXlsxStreamWriter, type XlsxStreamWriter } from '../common/xlsx-stream';
import { PrismaService } from '../prisma/prisma.service';
import { SQL_NOW_UTC } from '../sales-import/sql-time';
import type { RunOutcome, WorkerStop } from '../sales-import/ingest/worker-stop';
import { StorageService } from '../storage/storage.service';
import type { AnyExportKind } from './export-kinds';
import { userFromActor } from './exports-actor';
import { claimNextExport } from './exports-claim';
import { EXPORT_RETENTION_DAYS } from './exports.contract';
import {
  EXPORT_FAILED_MESSAGE,
  EXPORT_GAVE_UP_MESSAGE,
  EXPORT_HEARTBEAT_MS,
  EXPORT_MAX_ATTEMPTS,
  EXPORT_NEVER_STARTED_MESSAGE,
  EXPORT_QUEUED_GIVE_UP_HOURS,
  EXPORT_ROW_PURGE_DAYS,
  EXPORT_STOP_RESTORES_ATTEMPT_WITHIN_MS,
  EXPORT_SWEEP_LIMIT,
  EXPORT_UNKNOWN_KIND_MESSAGE,
  XLSX_CONTENT_TYPE,
} from './exports-engine.constants';

/** DI token for the kind registry (kinds/index.ts EXPORT_KINDS in the app; a fake map in tests). */
export const EXPORT_KIND_REGISTRY = Symbol('EXPORT_KIND_REGISTRY');
export type ExportKindRegistry = ReadonlyMap<string, AnyExportKind>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Thrown inside a run when the claim was lost (superseded) or a stop was requested. */
class RunAborted extends Error {
  constructor(readonly why: 'superseded' | 'stopping') {
    super(`export run aborted: ${why}`);
  }
}

export interface ExportSweepResult {
  expired: number;
  gaveUp: number;
  purged: number;
}

/**
 * Wrap a writer so the report's next addSheet/addRow throws once the run is aborted (lost claim / SIGTERM / client
 * gone) — the report stops reading the database at its next row instead of finishing into a destroyed stream.
 */
export function abortableWriter(inner: XlsxStreamWriter, abortedBy: () => Error | null): XlsxStreamWriter {
  const check = () => {
    const err = abortedBy();
    if (err) throw err;
  };
  return {
    get rowCount() {
      return inner.rowCount;
    },
    async addSheet(name, headers, opts) {
      check();
      const sheet = await inner.addSheet(name, headers, opts);
      return {
        get rowCount() {
          return sheet.rowCount;
        },
        async addRow(cells) {
          check();
          await sheet.addRow(cells);
        },
      };
    },
    async finish() {
      check();
      await inner.finish();
    },
  };
}

/**
 * GCS key of a prepared file: one folder per request AND per attempt (the claim token is random per claim), so a
 * superseded worker that cleans up its own object can never delete the file a newer attempt wrote and marked READY.
 */
export function exportStorageKey(row: Pick<ExportRequest, 'clientId' | 'id' | 'claimToken'>, fileName: string): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'export.xlsx';
  const attempt = (row.claimToken ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || 'a';
  return `exports/${row.clientId}/${row.id}/${attempt}/${safe}`;
}

/**
 * ExportsProcessorService — the worker side of the Downloads page (runs in the gifsy-exports Cloud Run job, or
 * in-process with EXPORTS_RUNNER=inline for local dev / tests).
 *   claimNext()          — claim one QUEUED (or heartbeat-stale RUNNING) request;
 *   processClaimed(row)  — run its kind, streaming the workbook straight into GCS (never buffered), heartbeat while
 *                          running, then READY (expiresAt = +7 days) / FAILED; a stop (SIGTERM) releases it to QUEUED;
 *   sweep()              — retention: READY past expiresAt → file deleted + EXPIRED; QUEUED > 24 h → FAILED; rows
 *                          older than 30 days deleted. Bounded and never throws.
 */
@Injectable()
export class ExportsProcessorService {
  private readonly logger = new Logger(ExportsProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly moduleRef: ModuleRef,
    @Inject(EXPORT_KIND_REGISTRY) private readonly kinds: ExportKindRegistry,
  ) {}

  claimNext(): Promise<ExportRequest | null> {
    return claimNextExport(this.prisma);
  }

  async processClaimed(row: ExportRequest, stop?: WorkerStop): Promise<RunOutcome> {
    const claimedAt = Date.now();
    if (!row.claimToken) return 'superseded';
    const def = this.kinds.get(row.kind);
    if (!def) {
      this.logger.error(`export ${row.id}: unknown kind "${row.kind}"`);
      return (await this.finish(row, { status: 'FAILED', error: EXPORT_UNKNOWN_KIND_MESSAGE })) ? 'finished' : 'superseded';
    }
    if (row.attempts > EXPORT_MAX_ATTEMPTS) {
      this.logger.error(`export ${row.id}: attempts ${row.attempts} > ${EXPORT_MAX_ATTEMPTS}; giving up`);
      return (await this.finish(row, { status: 'FAILED', error: EXPORT_GAVE_UP_MESSAGE })) ? 'finished' : 'superseded';
    }

    const user = userFromActor(row.requestedById, row.actor);
    let fileName: string;
    let params: unknown;
    try {
      // row.params holds the RAW request params (+ server-set requestOrigin) — exactly what the API validated with
      // this same parseParams when the request was made. Parsed once here (never a parse of parsed output).
      params = def.parseParams(row.params, user);
      fileName = def.fileName(params, row.createdAt);
    } catch (e) {
      this.logger.error(`export ${row.id}: params no longer valid: ${(e as Error).message}`);
      return (await this.finish(row, { status: 'FAILED', error: EXPORT_FAILED_MESSAGE })) ? 'finished' : 'superseded';
    }
    const key = exportStorageKey(row, fileName);

    // Byte counter between the writer and the upload (no 'data' listener on the upload source).
    let sizeBytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        sizeBytes += chunk.length;
        cb(null, chunk);
      },
    });
    const sink = new PassThrough();
    // pipeline (not pipe): destroying `sink` on abort/failure also destroys `counter`, which aborts the GCS upload
    // stream inside uploadStream — no half-open upload is left behind.
    pipeline(sink, counter, () => undefined);
    const upload = this.storage.uploadStream(key, counter, XLSX_CONTENT_TYPE);

    const state: { aborted: RunAborted | null; uploadFailed: Error | null } = { aborted: null, uploadFailed: null };
    const abort = (why: 'superseded' | 'stopping') => {
      if (state.aborted) return;
      state.aborted = new RunAborted(why);
      sink.destroy(state.aborted);
    };
    // The storage upload failed (GCS error, network): stop the writer NOW — destroying the sink wakes a writer waiting
    // on backpressure and the report's next row throws — so the run ends FAILED promptly instead of sitting RUNNING
    // until the job's task timeout. Also: never an unhandled rejection (the outcome is awaited or dropped below).
    upload.catch((e: unknown) => {
      if (state.aborted || state.uploadFailed) return;
      state.uploadFailed = e instanceof Error ? e : new Error(String(e));
      sink.destroy(state.uploadFailed);
    });
    const offStop = stop?.onStop(() => abort('stopping')) ?? (() => undefined);
    const beat = setInterval(() => {
      void this.heartbeat(row)
        .then((alive) => {
          if (!alive) abort('superseded');
        })
        .catch((e: unknown) => this.logger.warn(`export ${row.id} heartbeat failed: ${(e as Error).message}`));
    }, EXPORT_HEARTBEAT_MS);
    (beat as { unref?: () => void }).unref?.();

    try {
      const out = abortableWriter(createXlsxStreamWriter(sink), () => state.aborted ?? state.uploadFailed);
      const { rowCount } = await def.run(
        { prisma: this.prisma, moduleRef: this.moduleRef, clientId: row.clientId, user, now: row.createdAt },
        params,
        out,
      );
      if (state.aborted) throw state.aborted;
      await out.finish();
      await upload;
      if (state.aborted) throw state.aborted;
      const wrote = await this.finish(row, {
        status: 'READY',
        fileName,
        storagePath: key,
        sizeBytes: BigInt(sizeBytes),
        rowCount,
        error: null,
        expiresAt: new Date(Date.now() + EXPORT_RETENTION_DAYS * DAY_MS),
      });
      if (!wrote) {
        await this.deleteQuietly(key);
        return 'superseded';
      }
      this.logger.log(`export ${row.id} (${row.kind}) READY: ${rowCount} rows, ${sizeBytes} bytes`);
      return 'finished';
    } catch (e) {
      sink.destroy();
      await this.deleteQuietly(key);
      const why = state.aborted?.why ?? (stop?.requested ? 'stopping' : null);
      if (why === 'superseded') return 'superseded';
      if (why === 'stopping') {
        await this.release(row, Date.now() - claimedAt >= EXPORT_STOP_RESTORES_ATTEMPT_WITHIN_MS);
        return 'released';
      }
      this.logger.error(`export ${row.id} (${row.kind}) FAILED: ${(e as Error).stack ?? (e as Error).message}`);
      return (await this.finish(row, { status: 'FAILED', error: EXPORT_FAILED_MESSAGE })) ? 'finished' : 'superseded';
    } finally {
      clearInterval(beat);
      offStop();
    }
  }

  /** Bump the heartbeat; false when the claim is gone (reprocessed / reclaimed by another worker). */
  async heartbeat(row: ExportRequest): Promise<boolean> {
    const n = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "export_requests" SET "heartbeatAt" = ${SQL_NOW_UTC}, "updatedAt" = ${SQL_NOW_UTC}
       WHERE "id" = ${row.id} AND "status" = 'RUNNING' AND "claimToken" = ${row.claimToken}`);
    return n > 0;
  }

  /** Final write, guarded by the claim token. false = superseded (nothing written). */
  private async finish(row: ExportRequest, data: Prisma.ExportRequestUpdateManyMutationInput): Promise<boolean> {
    if (!row.claimToken) return false;
    const res = await this.prisma.exportRequest.updateMany({
      where: { id: row.id, status: 'RUNNING', claimToken: row.claimToken },
      data: { ...data, claimToken: null, heartbeatAt: null, finishedAt: new Date() },
    });
    return res.count > 0;
  }

  /** Stop (SIGTERM): back to QUEUED for the next drain; an early stop does not count as an attempt. Never throws. */
  private async release(row: ExportRequest, countAttempt: boolean): Promise<void> {
    try {
      await this.prisma.exportRequest.updateMany({
        where: { id: row.id, status: 'RUNNING', claimToken: row.claimToken },
        data: {
          status: 'QUEUED',
          claimToken: null,
          heartbeatAt: null,
          startedAt: null,
          ...(countAttempt ? {} : { attempts: Math.max(0, row.attempts - 1) }),
        },
      });
      this.logger.warn(`export ${row.id}: worker stopping; released to QUEUED (${countAttempt ? 'attempt counted' : 'attempt not counted'})`);
    } catch (e) {
      this.logger.error(`export ${row.id}: could not release on stop: ${(e as Error).message}`);
    }
  }

  private async deleteQuietly(key: string): Promise<void> {
    try {
      await this.storage.deleteFile(key);
    } catch {
      /* missing object / transient — the retention sweep never needs it */
    }
  }

  /** Retention (every worker drain, the inline drain, and the scheduler drain when idle). Never throws. */
  async sweep(opts: { limit?: number; now?: Date } = {}): Promise<ExportSweepResult> {
    const limit = opts.limit ?? EXPORT_SWEEP_LIMIT;
    const now = opts.now ?? new Date();
    const out: ExportSweepResult = { expired: 0, gaveUp: 0, purged: 0 };
    try {
      const due = await this.prisma.exportRequest.findMany({
        where: { status: 'READY', expiresAt: { lt: now } },
        select: { id: true, storagePath: true },
        orderBy: { expiresAt: 'asc' },
        take: limit,
      });
      for (const r of due) {
        // File first: if the delete throws for a reason other than "already gone", keep READY and retry next sweep.
        if (r.storagePath) {
          try {
            await this.storage.deleteFile(r.storagePath);
          } catch (e) {
            const code = (e as { code?: number }).code;
            if (code !== 404) {
              this.logger.warn(`export ${r.id}: could not delete expired file: ${(e as Error).message}`);
              continue;
            }
          }
        }
        const res = await this.prisma.exportRequest.updateMany({
          where: { id: r.id, status: 'READY' },
          data: { status: 'EXPIRED', storagePath: null },
        });
        out.expired += res.count;
      }

      const giveUpBefore = new Date(now.getTime() - EXPORT_QUEUED_GIVE_UP_HOURS * 60 * 60 * 1000);
      const gaveUp = await this.prisma.exportRequest.updateMany({
        where: { status: 'QUEUED', createdAt: { lt: giveUpBefore } },
        data: { status: 'FAILED', error: EXPORT_NEVER_STARTED_MESSAGE, finishedAt: now },
      });
      out.gaveUp = gaveUp.count;

      const purgeBefore = new Date(now.getTime() - EXPORT_ROW_PURGE_DAYS * DAY_MS);
      const old = await this.prisma.exportRequest.findMany({
        where: { createdAt: { lt: purgeBefore }, status: { in: ['EXPIRED', 'FAILED'] } },
        select: { id: true },
        take: limit,
      });
      if (old.length) {
        const res = await this.prisma.exportRequest.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
        out.purged = res.count;
      }
    } catch (e) {
      this.logger.warn(`export retention sweep stopped: ${(e as Error).message}`);
    }
    return out;
  }
}
