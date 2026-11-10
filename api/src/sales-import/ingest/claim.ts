/**
 * Claim one import for processing (plan §7.1.1). A single UPDATE with a `FOR UPDATE SKIP LOCKED` subquery
 * is atomic, so concurrent workers (two job executions, inline + job) never claim the same row. A
 * PROCESSING row whose heartbeat is older than SALES_IMPORT_STALE_HEARTBEAT_MINUTES is reclaimable (a
 * killed/OOM'd execution). `attempts` counts claims (> SALES_IMPORT_MAX_ATTEMPTS → FAILED).
 *
 * M2: every claim stamps a fresh RANDOM `claimToken`; the processor heartbeats and finalises only
 * `WHERE "claimToken" = <its token>`. A reprocess / cancel clears the token, and a reclaim replaces it, so a superseded
 * worker can never match the row again (unlike the old `attempts` token, which a reset to 0 could make reusable).
 */
import type { SalesImport } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../prisma/prisma.service';
import { SALES_IMPORT_STALE_HEARTBEAT_MINUTES } from '../sales-import.contract';

export async function claimNextImport(
  prisma: Pick<PrismaService, '$queryRaw'>,
  token: string = randomUUID(),
): Promise<SalesImport | null> {
  const rows = await prisma.$queryRaw<SalesImport[]>`
    UPDATE "sales_imports"
       SET "status" = 'PROCESSING',
           "startedAt" = now(),
           "attempts" = "attempts" + 1,
           "claimToken" = ${token},
           "heartbeatAt" = now(),
           "updatedAt" = now()
     WHERE "id" = (
       SELECT "id" FROM "sales_imports"
        WHERE "status" = 'QUEUED'
           OR ("status" = 'PROCESSING' AND ("heartbeatAt" IS NULL OR "heartbeatAt" < now() - make_interval(mins => ${SALES_IMPORT_STALE_HEARTBEAT_MINUTES}::int)))
        ORDER BY "createdAt"
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING *`;
  return rows[0] ?? null;
}

/** Is there anything a worker would claim right now? (drain endpoint) */
export async function hasClaimableImports(prisma: Pick<PrismaService, '$queryRaw'>): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ n: bigint | number }>>`
    SELECT count(*)::int AS n FROM "sales_imports"
     WHERE "status" = 'QUEUED'
        OR ("status" = 'PROCESSING' AND ("heartbeatAt" IS NULL OR "heartbeatAt" < now() - make_interval(mins => ${SALES_IMPORT_STALE_HEARTBEAT_MINUTES}::int)))`;
  return Number(rows[0]?.n ?? 0) > 0;
}
