/**
 * Row locks on `sales_imports` (audit fix round H1/S1/S8/M3). The import row is the serialisation point between:
 *   - apply (FOR SHARE: many months of one import may apply concurrently; the import must stay READY);
 *   - reprocess / cancel / delete / retention purge (FOR UPDATE NOWAIT: refuse with 409 instead of waiting behind an
 *     apply or the worker's final write);
 *   - part upload (FOR KEY SHARE: concurrent parts never block each other) vs complete (FOR UPDATE: waits for the
 *     in-flight parts, after which a late part sees QUEUED → 409 and leaves the stored parts alone).
 * Every lock is tenant-scoped (`clientId` in the WHERE), so a foreign id simply finds nothing.
 */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SALES_IMPORT_STALE_HEARTBEAT_MINUTES } from '../sales-import.contract';

export type ImportLockMode = 'UPDATE' | 'UPDATE NOWAIT' | 'SHARE' | 'KEY SHARE';

/** The scalar columns lifecycle decisions need (no JSON blobs). */
export interface LockedImport {
  id: string;
  clientId: string;
  status: string;
  gcsPrefix: string;
  partCount: number;
  sizeBytes: bigint;
  fileKind: string;
  claimToken: string | null;
  heartbeatAt: Date | null;
  purgedAt: Date | null;
  finishedAt: Date | null;
  processingVersion: number;
  mappingFingerprint: string | null;
}

export async function lockImportRow(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  id: string,
  clientId: string,
  mode: ImportLockMode,
): Promise<LockedImport | null> {
  const rows = await tx.$queryRaw<LockedImport[]>(Prisma.sql`
    SELECT "id", "clientId", "status", "gcsPrefix", "partCount", "sizeBytes", "fileKind", "claimToken", "heartbeatAt",
           "purgedAt", "finishedAt", "processingVersion", "mappingFingerprint"
      FROM "sales_imports"
     WHERE "id" = ${id} AND "clientId" = ${clientId}
       FOR ${Prisma.raw(mode)}`);
  return rows[0] ?? null;
}

/** Postgres 55P03 lock_not_available (a NOWAIT lock on a row another transaction holds). */
export function isLockNotAvailable(e: unknown): boolean {
  const err = e as { code?: string; meta?: { code?: string }; message?: string } | null;
  if (!err) return false;
  if (err.meta?.code === '55P03' || err.code === '55P03') return true;
  return typeof err.message === 'string' && /55P03|could not obtain lock/i.test(err.message);
}

export const IMPORT_BUSY_MESSAGE =
  'This import is busy right now (a month is being applied from it, or processing is finishing). Try again in a minute.';

/** Map a NOWAIT lock failure to a 409; rethrow anything else. */
export function rethrowBusy(e: unknown): never {
  if (isLockNotAvailable(e)) throw new ConflictException(IMPORT_BUSY_MESSAGE);
  throw e;
}

/** PROCESSING whose worker stopped heart-beating (killed / OOM / redeployed). */
export function isStalled(row: { status: string; heartbeatAt: Date | null }, now = Date.now()): boolean {
  if (row.status !== 'PROCESSING') return false;
  return !row.heartbeatAt || row.heartbeatAt.getTime() < now - SALES_IMPORT_STALE_HEARTBEAT_MINUTES * 60_000;
}
