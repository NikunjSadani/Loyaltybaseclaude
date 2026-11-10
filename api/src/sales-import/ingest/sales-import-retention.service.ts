import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import {
  SALES_IMPORT_ABANDONED_UPLOAD_HOURS,
  SALES_IMPORT_RETENTION_DAYS,
} from '../sales-import.contract';
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
 * Data retention for Sales Import (audit S5). Purging an import deletes its GCS prefix (raw parts + unmatched.csv),
 * its aggregates (they hold every customer's per-month sales, matched or not) and the sample data rows of
 * `detectedHeaders` (the header row is kept), then stamps `purgedAt`. SalesImportApply history is untouched.
 *
 *   - finished imports (READY / NEEDS_MAPPING / FAILED / CANCELLED): purged SALES_IMPORT_RETENTION_DAYS after finishedAt;
 *   - abandoned uploads (UPLOADING older than SALES_IMPORT_ABANDONED_UPLOAD_HOURS): CANCELLED + purged.
 * The sweep runs lazily on the tenant's list call and on every worker drain (all tenants), a few rows at a time.
 * Each purge holds `FOR UPDATE NOWAIT` on the import row, so it never races an apply / the worker's final write
 * (a busy row is simply retried by the next sweep).
 */
@Injectable()
export class SalesImportRetentionService {
  private readonly logger = new Logger(SalesImportRetentionService.name);

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
      return await this.prisma.$transaction(
        async (tx): Promise<PurgeOutcome> => {
          const row = await lockImportRow(tx, id, clientId, 'UPDATE NOWAIT');
          if (!row) return 'notFound';
          const refusal = opts.check ? await opts.check(row, tx) : null;
          if (refusal) return { refused: refusal };
          const prefix = `sales-imports/${clientId}/${id}/`;
          if (row.gcsPrefix === prefix) await this.storage.deletePrefix(prefix);
          else this.logger.error(`sales-import ${id}: unexpected gcsPrefix "${row.gcsPrefix}", storage cleanup skipped`);
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
              detectedHeaders: header ? (header as Prisma.InputJsonValue) : Prisma.DbNull,
              ...(opts.cancel ? { status: 'CANCELLED', finishedAt: row.finishedAt ?? now, claimToken: null } : {}),
            },
          });
          if (opts.onPurged) await opts.onPurged(tx, row);
          return 'purged';
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
    } catch (e) {
      if (isLockNotAvailable(e)) return 'busy';
      throw e;
    }
  }

  /** One bounded sweep (never throws: retention must not break the list call or the worker). */
  async sweep(opts: { clientId?: string; limit?: number; now?: Date } = {}): Promise<{ abandoned: number; purged: number }> {
    const now = opts.now ?? new Date();
    const limit = opts.limit ?? 5;
    const tenant = opts.clientId ? { clientId: opts.clientId } : {};
    const out = { abandoned: 0, purged: 0 };
    try {
      const abandonedBefore = new Date(now.getTime() - SALES_IMPORT_ABANDONED_UPLOAD_HOURS * 3_600_000);
      const abandoned = await this.prisma.salesImport.findMany({
        where: { ...tenant, status: 'UPLOADING', createdAt: { lt: abandonedBefore } },
        select: { id: true, clientId: true },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
      for (const a of abandoned) {
        const r = await this.purgeImport(a.id, a.clientId, {
          cancel: true,
          check: (row) => (row.status === 'UPLOADING' ? null : 'no longer uploading'),
        });
        if (r === 'purged') out.abandoned++;
      }
      const expiredBefore = new Date(now.getTime() - SALES_IMPORT_RETENTION_DAYS * 86_400_000);
      const expired = await this.prisma.salesImport.findMany({
        where: { ...tenant, status: { in: RETENTION_STATUSES }, purgedAt: null, finishedAt: { lt: expiredBefore } },
        select: { id: true, clientId: true },
        orderBy: { finishedAt: 'asc' },
        take: limit,
      });
      for (const e of expired) {
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
    return out;
  }
}
