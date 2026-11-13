/**
 * Claim one export request for the worker (same model as sales-import/ingest/claim.ts). A single UPDATE with a
 * `FOR UPDATE SKIP LOCKED` subquery is atomic, so two job executions (or inline + job) never claim the same row.
 * A RUNNING row whose heartbeat is older than EXPORT_STALE_HEARTBEAT_MINUTES is reclaimable (killed / OOM'd worker).
 * Every claim stamps a fresh RANDOM `claimToken`; heartbeat / finish / release match `WHERE "claimToken" = <token>`,
 * so a superseded worker can never write the row again. Time is SQL_NOW_UTC (never a bare now()) — see sql-time.ts.
 */
import { Prisma, type ExportRequest } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import { SQL_NOW_UTC } from '../sales-import/sql-time';
import { EXPORT_STALE_HEARTBEAT_MINUTES } from './exports-engine.constants';

/** The "worker died" predicate, shared by the claim and the drain / self-heal checks. */
export const EXPORT_CLAIMABLE = Prisma.sql`"status" = 'QUEUED'
  OR ("status" = 'RUNNING' AND ("heartbeatAt" IS NULL
      OR "heartbeatAt" < ${SQL_NOW_UTC} - make_interval(mins => ${EXPORT_STALE_HEARTBEAT_MINUTES}::int)))`;

export async function claimNextExport(
  prisma: Pick<PrismaService, '$queryRaw'>,
  token: string = randomUUID(),
): Promise<ExportRequest | null> {
  const rows = await prisma.$queryRaw<ExportRequest[]>(Prisma.sql`
    UPDATE "export_requests"
       SET "status" = 'RUNNING',
           "startedAt" = ${SQL_NOW_UTC},
           "attempts" = "attempts" + 1,
           "claimToken" = ${token},
           "heartbeatAt" = ${SQL_NOW_UTC},
           "updatedAt" = ${SQL_NOW_UTC}
     WHERE "id" = (
       SELECT "id" FROM "export_requests"
        WHERE ${EXPORT_CLAIMABLE}
        ORDER BY "createdAt"
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING *`);
  return rows[0] ?? null;
}

/** Is there anything a worker would claim right now? (drain endpoint / self-heal) */
export async function hasClaimableExports(prisma: Pick<PrismaService, '$queryRaw'>): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ n: bigint | number }>>(
    Prisma.sql`SELECT count(*)::int AS n FROM "export_requests" WHERE ${EXPORT_CLAIMABLE}`,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}
