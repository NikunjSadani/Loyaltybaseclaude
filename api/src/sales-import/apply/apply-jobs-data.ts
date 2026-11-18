/**
 * Read helpers for the background Apply / Recalculate jobs (owner 2026-11-18; tables from migration
 * 20261118170000_sales_apply_jobs, read with RAW SQL so the code needs no regenerated Prisma client). Shared by the jobs
 * service, the import preview (MonthPreview.activeJob) and the Months list / close / reopen (SalesMonthRow.activeJob, the
 * "being applied" 409). Plain functions, no DI, so SalesPreviewService / SalesMonthsService need no new dependency.
 */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SalesApplyJobKind, SalesMonthActiveJob } from '../sales-import.contract';
import { monthLabel } from '../months/month-state';

type Db = Pick<PrismaService, '$queryRaw'> | Prisma.TransactionClient;

interface ActiveRow {
  month: string;
  jobId: string;
  kind: SalesApplyJobKind;
  status: 'QUEUED' | 'RUNNING';
  importId: string | null;
  requestedByName: string;
  createdAt: Date;
}

/** The active (QUEUED / RUNNING) job of each given month — at most one per month (partial unique index). */
export async function activeJobsByMonth(db: Db, clientId: string, months: string[]): Promise<Map<string, SalesMonthActiveJob>> {
  if (months.length === 0) return new Map();
  const rows = await (db as Pick<PrismaService, '$queryRaw'>).$queryRaw<ActiveRow[]>(Prisma.sql`
    SELECT m."month", j."id" AS "jobId", j."kind", m."status", j."importId", j."requestedByName", j."createdAt"
      FROM "sales_apply_job_months" m
      JOIN "sales_apply_jobs" j ON j."id" = m."jobId"
     WHERE m."clientId" = ${clientId} AND m."month" = ANY(${months}::text[]) AND m."status" IN ('QUEUED', 'RUNNING')`);
  return new Map(
    rows.map((r) => [
      r.month,
      {
        jobId: r.jobId,
        kind: r.kind,
        status: r.status,
        importId: r.importId,
        requestedBy: r.requestedByName,
        createdAt: new Date(r.createdAt).toISOString(),
      },
    ]),
  );
}

/** "10:32" in India time — what the admin's clock shows. */
export function istClock(d: Date | string): string {
  return new Date(d).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "November 2026 is being applied by Asha since 10:32" (or "recalculated"). */
export function busyText(month: string, job: Pick<SalesMonthActiveJob, 'kind' | 'requestedBy' | 'createdAt'>): string {
  const what = job.kind === 'RECALC' ? 'recalculated' : 'applied';
  return `${monthLabel(month)} is being ${what} by ${job.requestedBy} since ${istClock(job.createdAt)}`;
}

/** Close / Reopen refuse (409) while an Apply / Recalculate of the month is queued or running (owner 2026-11-18). */
export async function assertNoActiveJob(db: Db, clientId: string, month: string): Promise<void> {
  const job = (await activeJobsByMonth(db, clientId, [month])).get(month);
  if (job) throw new ConflictException(`${busyText(month, job)} — try again when it finishes.`);
}
