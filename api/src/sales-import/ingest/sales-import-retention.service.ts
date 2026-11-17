import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { SALES_IMPORT_ABANDONED_UPLOAD_HOURS } from '../sales-import.contract';
import { currentMonthKey } from '../../targets/targets.helpers';
import { dayDataCutoffMonth, historyCutoffMonth, importRetentionDays } from '../retention-window';
import { isLockNotAvailable, lockImportRow, type LockedImport } from './import-lock';

/** Statuses after which the raw file is no longer needed (retention clock = finishedAt). */
export const RETENTION_STATUSES = ['READY', 'NEEDS_MAPPING', 'FAILED', 'CANCELLED'];

/** 'busy' = another transaction holds the row (NOWAIT); `refused` = the check said no (message for a 409). */
export type PurgeOutcome = 'purged' | 'busy' | 'notFound' | { refused: string };

export interface PurgeOptions {
  /** Also set status CANCELLED (and clear the claim token, so a live worker stops). */
  cancel?: boolean;
  /** Re-checked UNDER the row lock: a refusal message, or null to proceed. */
  check?: (row: LockedImport, tx: Prisma.TransactionClient) => Promise<string | null> | string | null;
  /** Runs inside the same transaction after the purge (e.g. the audit row). */
  onPurged?: (tx: Prisma.TransactionClient, row: LockedImport) => Promise<unknown>;
}

/**
 * Data retention for Sales Import (audit S5). Purging an import is two steps (re-audit M1: no GCS I/O inside a DB
 * transaction — the API shares a small connection pool with live tenants):
 *   1. under `FOR UPDATE NOWAIT` on the import row, in ONE short transaction: delete its aggregates (every customer's
 *      per-month sales), keep only the header row of `detectedHeaders`, stamp `purgedAt` (+ CANCELLED when asked);
 *   2. after the commit: delete its GCS prefix (raw parts + unmatched.csv) and stamp `filesPurgedAt`. A failure here is
 *      logged and retried by the next sweep (rows with purgedAt set and filesPurgedAt null). Idempotent.
 * SalesImportApply history is untouched.
 *
 *   - finished imports (READY / NEEDS_MAPPING / FAILED / CANCELLED): purged importRetentionDays() after finishedAt
 *     (retention-window.ts: 30 days while SALES_RETENTION_V2 is off — the default — 7 with it on);
 *   - abandoned uploads (UPLOADING older than SALES_IMPORT_ABANDONED_UPLOAD_HOURS): CANCELLED + purged.
 * The sweep runs lazily on the tenant's list call and on every worker drain (all tenants), a few rows at a time.
 * Each purge holds `FOR UPDATE NOWAIT` on the import row, so it never races an apply / the worker's final write
 * (a busy row is simply retried by the next sweep).
 */
/**
 * Bounds of every retention step (re-check M2 / L1), so a sweep with a deadline can tell what still fits:
 * one purge = pool wait + its transaction (each statement ≤ PURGE_STATEMENT_TIMEOUT_MS) + the GCS prefix delete after it.
 */
export const PURGE_STATEMENT_TIMEOUT_MS = 100_000;
export const PURGE_TX_TIMEOUT_MS = 120_000;
export const PURGE_MAX_WAIT_MS = 10_000;
/** The GCS prefix delete is abandoned (and retried by the next sweep) after this long. */
export const GCS_DELETE_TIMEOUT_MS = 15_000;
export const PURGE_STEP_MS = PURGE_TX_TIMEOUT_MS + PURGE_MAX_WAIT_MS + GCS_DELETE_TIMEOUT_MS;
/** A GCS-only step (retrying a failed file delete). */
export const SWEEP_SMALL_STEP_MS = GCS_DELETE_TIMEOUT_MS + 5_000;
/**
 * The month-window delete (history lines / summary / headers before historyCutoffMonth() + day data before
 * dayDataCutoffMonth()): at most this many rows PER TABLE per sweep, each statement bounded.
 */
export const HISTORY_PURGE_CHUNK_ROWS = 50_000;
export const HISTORY_PURGE_STATEMENT_TIMEOUT_MS = 12_000;
export const HISTORY_PURGE_TX_TIMEOUT_MS = 40_000;
export const HISTORY_PURGE_STEP_MS = HISTORY_PURGE_TX_TIMEOUT_MS + 5_000;

/** Rejects after `ms` (the GCS client takes no abort signal, so the request itself is not cancelled; the sweep moves on). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

@Injectable()
export class SalesImportRetentionService {
  private readonly logger = new Logger(SalesImportRetentionService.name);
  /** Wall clock (epoch ms); a seam for the deadline tests. */
  clock: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Purge one import (optionally cancelling it) iff `check` passes under the row lock.
   * NOWAIT: returns 'busy' when another transaction holds the row (callers that must report it map it to a 409).
   */
  async purgeImport(id: string, clientId: string, opts: PurgeOptions = {}): Promise<PurgeOutcome> {
    try {
      const outcome = await this.prisma.$transaction(
        async (tx): Promise<PurgeOutcome> => {
          // Every statement of the purge is bounded (re-check L1); a timeout rolls the purge back for the next sweep.
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${PURGE_STATEMENT_TIMEOUT_MS}`);
          const row = await lockImportRow(tx, id, clientId, 'UPDATE NOWAIT');
          if (!row) return 'notFound';
          const refusal = opts.check ? await opts.check(row, tx) : null;
          if (refusal) return { refused: refusal };
          await tx.salesImportAggregate.deleteMany({ where: { importId: id } });
          const cur = await tx.salesImport.findUnique({ where: { id }, select: { detectedHeaders: true } });
          const header = Array.isArray(cur?.detectedHeaders) && Array.isArray((cur!.detectedHeaders as unknown[])[0])
            ? [(cur!.detectedHeaders as unknown[])[0]]
            : null;
          const now = new Date();
          await tx.salesImport.update({
            where: { id },
            data: {
              purgedAt: now,
              filesPurgedAt: null,
              detectedHeaders: header ? (header as Prisma.InputJsonValue) : Prisma.DbNull,
              ...(opts.cancel ? { status: 'CANCELLED', finishedAt: row.finishedAt ?? now, claimToken: null } : {}),
            },
          });
          if (opts.onPurged) await opts.onPurged(tx, row);
          return 'purged';
        },
        { timeout: PURGE_TX_TIMEOUT_MS, maxWait: PURGE_MAX_WAIT_MS },
      );
      if (outcome === 'purged') await this.deleteFiles(id, clientId);
      return outcome;
    } catch (e) {
      if (isLockNotAvailable(e)) return 'busy';
      throw e;
    }
  }

  /** GCS prefixes whose delete is still running (a timed-out one keeps going in the client): never start a second. */
  private readonly deletingPrefixes = new Set<string>();

  /** Step 2 (outside any transaction): delete the import's GCS prefix, then stamp filesPurgedAt. Never throws. */
  async deleteFiles(id: string, clientId: string): Promise<boolean> {
    try {
      const row = await this.prisma.salesImport.findFirst({ where: { id, clientId }, select: { gcsPrefix: true } });
      if (!row) return false;
      const prefix = `sales-imports/${clientId}/${id}/`;
      if (row.gcsPrefix === prefix) {
        if (this.deletingPrefixes.has(prefix)) {
          this.logger.warn(`sales-import ${id}: a delete of its files is still running; skipped (the next sweep checks again)`);
          return false;
        }
        this.deletingPrefixes.add(prefix);
        const del = this.storage.deletePrefix(prefix);
        // The prefix is "in flight" until the CLIENT call settles — not when our timeout gives up on it.
        void del.then(() => undefined, () => undefined).finally(() => this.deletingPrefixes.delete(prefix));
        await withTimeout(del, GCS_DELETE_TIMEOUT_MS, 'GCS delete');
      }
      else this.logger.error(`sales-import ${id}: unexpected gcsPrefix "${row.gcsPrefix}", storage cleanup skipped`);
      await this.prisma.salesImport.updateMany({ where: { id, clientId, purgedAt: { not: null } }, data: { filesPurgedAt: new Date() } });
      return true;
    } catch (e) {
      this.logger.warn(`sales-import ${id}: file cleanup failed (the next sweep retries): ${(e as Error)?.message}`);
      return false;
    }
  }

  /**
   * The month windows (retention-window.ts): SalesMonthHistory (+ its combos summary and set headers) of months before
   * historyCutoffMonth() — 10 years while SALES_RETENTION_V2 is off (the default; exactly as before), the current IST
   * month + 3 previous with it on — and the day-level data (outlet_sales_days + sales_day_sets) of months before
   * dayDataCutoffMonth() (always current + 3 previous: new tables) are deleted — BOUNDED (re-check L1): one transaction,
   * every statement under HISTORY_PURGE_STATEMENT_TIMEOUT_MS, at most HISTORY_PURGE_CHUNK_ROWS rows per table per call.
   * A month's sales_day_sets row goes FIRST (so it never claims complete day data for a half-deleted month), then its day
   * rows; a history set header goes once its lines and summary are gone. Readers treat every month before the cutoff as
   * absent anyway. `historyCutoff` = an EXPLICIT history cutoff (the one-off trim applies the V2 window with it,
   * whatever the switch). Never throws. Returns the history line rows deleted.
   */
  async purgeOldHistory(opts: { clientId?: string; currentMonth?: string; historyCutoff?: string } = {}): Promise<number> {
    try {
      const current = opts.currentMonth ?? currentMonthKey();
      const cutoff = opts.historyCutoff ?? historyCutoffMonth(current);
      const dayCutoff = dayDataCutoffMonth(current);
      const tenant = (alias: string) =>
        opts.clientId ? Prisma.sql`AND ${Prisma.raw(alias)}."clientId" = ${opts.clientId}` : Prisma.empty;
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${HISTORY_PURGE_STATEMENT_TIMEOUT_MS}`);
          const lines = await tx.$executeRaw(Prisma.sql`
            DELETE FROM "sales_month_histories" WHERE "id" IN (
              SELECT h."id" FROM "sales_month_histories" h
               WHERE h."month" < ${cutoff} ${tenant('h')} LIMIT ${HISTORY_PURGE_CHUNK_ROWS})`);
          await tx.$executeRaw(Prisma.sql`
            DELETE FROM "sales_month_history_combos" WHERE "id" IN (
              SELECT c."id" FROM "sales_month_history_combos" c
               WHERE c."month" < ${cutoff} ${tenant('c')} LIMIT ${HISTORY_PURGE_CHUNK_ROWS})`);
          await tx.$executeRaw(Prisma.sql`
            DELETE FROM "sales_month_history_sets" s
             WHERE s."month" < ${cutoff} ${tenant('s')}
               AND NOT EXISTS (SELECT 1 FROM "sales_month_histories" h WHERE h."clientId" = s."clientId" AND h."month" = s."month")
               AND NOT EXISTS (SELECT 1 FROM "sales_month_history_combos" c WHERE c."clientId" = s."clientId" AND c."month" = s."month")`);
          // Day-level data, in step with the same window: the set first, then a bounded chunk of its rows.
          await tx.$executeRaw(Prisma.sql`
            DELETE FROM "sales_day_sets" d WHERE d."month" < ${dayCutoff} ${tenant('d')}`);
          await tx.$executeRaw(Prisma.sql`
            DELETE FROM "outlet_sales_days" WHERE "id" IN (
              SELECT o."id" FROM "outlet_sales_days" o
               WHERE o."month" < ${dayCutoff} ${tenant('o')} LIMIT ${HISTORY_PURGE_CHUNK_ROWS})`);
          return Number(lines);
        },
        { timeout: HISTORY_PURGE_TX_TIMEOUT_MS, maxWait: 5_000 },
      );
    } catch (e) {
      this.logger.warn(`sales-import history retention failed (the next sweep retries): ${(e as Error).message}`);
      return 0;
    }
  }

  /**
   * One bounded sweep (never throws: retention must not break the list call or the worker). `deadline` (epoch ms; the
   * Cloud Scheduler drain passes start + 150 s): no step is STARTED unless its worst case still ends by the deadline
   * (re-check M2) — the rest waits for the next sweep.
   */
  async sweep(opts: {
    clientId?: string;
    limit?: number;
    now?: Date;
    /** Hard: no step starts unless its WORST case ends by then (the Cloud Scheduler drain). */
    deadline?: number;
    /** Soft: no NEW step starts after this time (the import-list GET keeps its inline sweep short). */
    stopStartingAfter?: number;
    /** Run the month-window delete (history + day data; default true; the import-list GET passes false — drains / worker do it). */
    history?: boolean;
    /** EXPLICIT import retention in days (the one-off trim applies the V2 7 days with it); default importRetentionDays(). */
    retentionDays?: number;
  } = {}): Promise<{ abandoned: number; purged: number }> {
    const now = opts.now ?? new Date();
    const limit = opts.limit ?? 5;
    const tenant = opts.clientId ? { clientId: opts.clientId } : {};
    const out = { abandoned: 0, purged: 0 };
    const fits = (stepMs: number) =>
      (opts.deadline === undefined || this.clock() + stepMs <= opts.deadline) &&
      (opts.stopStartingAfter === undefined || this.clock() < opts.stopStartingAfter);
    try {
      // Retry file deletions that failed after an earlier purge was marked.
      const pendingFiles = await this.prisma.salesImport.findMany({
        where: { ...tenant, purgedAt: { not: null }, filesPurgedAt: null },
        select: { id: true, clientId: true },
        take: limit,
      });
      for (const p of pendingFiles) {
        if (!fits(SWEEP_SMALL_STEP_MS)) break;
        await this.deleteFiles(p.id, p.clientId);
      }
      const abandonedBefore = new Date(now.getTime() - SALES_IMPORT_ABANDONED_UPLOAD_HOURS * 3_600_000);
      const abandoned = await this.prisma.salesImport.findMany({
        where: { ...tenant, status: 'UPLOADING', createdAt: { lt: abandonedBefore } },
        select: { id: true, clientId: true },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
      for (const a of abandoned) {
        if (!fits(PURGE_STEP_MS)) break;
        const r = await this.purgeImport(a.id, a.clientId, {
          cancel: true,
          check: (row) => (row.status === 'UPLOADING' ? null : 'no longer uploading'),
        });
        if (r === 'purged') out.abandoned++;
      }
      const expiredBefore = new Date(now.getTime() - (opts.retentionDays ?? importRetentionDays()) * 86_400_000);
      const expired = await this.prisma.salesImport.findMany({
        where: { ...tenant, status: { in: RETENTION_STATUSES }, purgedAt: null, finishedAt: { lt: expiredBefore } },
        select: { id: true, clientId: true },
        orderBy: { finishedAt: 'asc' },
        take: limit,
      });
      for (const e of expired) {
        if (!fits(PURGE_STEP_MS)) break;
        const r = await this.purgeImport(e.id, e.clientId, {
          check: (row) =>
            RETENTION_STATUSES.includes(row.status) && !row.purgedAt && !!row.finishedAt && row.finishedAt < expiredBefore
              ? null
              : 'not expired',
        });
        if (r === 'purged') out.purged++;
      }
    } catch (e) {
      this.logger.warn(`sales-import retention sweep failed: ${(e as Error).message}`);
    }
    // Month windows: history before historyCutoffMonth() + day data before dayDataCutoffMonth() (bounded; usually nothing).
    if (opts.history !== false && fits(HISTORY_PURGE_STEP_MS)) await this.purgeOldHistory({ clientId: opts.clientId });
    return out;
  }
}
