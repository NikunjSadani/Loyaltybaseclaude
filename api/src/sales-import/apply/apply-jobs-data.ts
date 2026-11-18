/**
 * Read helpers for the background Apply / Recalculate jobs (owner 2026-11-18; tables from migration
 * 20261118170000_sales_apply_jobs, read with RAW SQL so the code needs no regenerated Prisma client). Shared by the jobs
 * service, the import preview (MonthPreview.activeJob / lastJob), the Months list / close / reopen (SalesMonthRow, the
 * "being applied" 409) and the import's reprocess / cancel / delete (409 while a job of that import is active). Plain
 * functions, no DI, so SalesPreviewService / SalesMonthsService / the controllers need no new dependency.
 */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ApplyMonthResult, SalesApplyJobKind, SalesMonthActiveJob, SalesMonthLastJob } from '../sales-import.contract';
import { monthLabel } from '../months/month-state';

type Db = Pick<PrismaService, '$queryRaw'> | Prisma.TransactionClient;
const q = (db: Db) => db as Pick<PrismaService, '$queryRaw'>;
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : []);

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
  const rows = rowsOf<ActiveRow>(await q(db).$queryRaw(Prisma.sql`
    SELECT m."month", j."id" AS "jobId", j."kind", m."status", j."importId", j."requestedByName", j."createdAt"
      FROM "sales_apply_job_months" m
      JOIN "sales_apply_jobs" j ON j."id" = m."jobId"
     WHERE m."clientId" = ${clientId} AND m."month" = ANY(${months}::text[]) AND m."status" IN ('QUEUED', 'RUNNING')`));
  return new Map(
    rows.map((r) => [
      r.month,
      { jobId: r.jobId, kind: r.kind, status: r.status, importId: r.importId, requestedBy: r.requestedByName, createdAt: new Date(r.createdAt).toISOString() },
    ]),
  );
}

interface LastRow {
  month: string;
  jobId: string;
  kind: SalesApplyJobKind;
  status: 'DONE' | 'FAILED';
  importId: string | null;
  requestedByName: string;
  createdAt: Date;
  finishedAt: Date | null;
  result: ApplyMonthResult | null;
}

/** The latest FINISHED (DONE / FAILED) job month of each given month (audit B-H1: a result never disappears). */
export async function lastJobsByMonth(db: Db, clientId: string, months: string[]): Promise<Map<string, SalesMonthLastJob>> {
  if (months.length === 0) return new Map();
  const rows = rowsOf<LastRow>(await q(db).$queryRaw(Prisma.sql`
    SELECT DISTINCT ON (m."month") m."month", j."id" AS "jobId", j."kind", m."status", j."importId", j."requestedByName",
           j."createdAt", m."finishedAt", m."result"
      FROM "sales_apply_job_months" m
      JOIN "sales_apply_jobs" j ON j."id" = m."jobId"
     WHERE m."clientId" = ${clientId} AND m."month" = ANY(${months}::text[]) AND m."status" IN ('DONE', 'FAILED')
     ORDER BY m."month", m."finishedAt" DESC NULLS LAST`));
  return new Map(
    rows.map((r) => [
      r.month,
      {
        jobId: r.jobId, kind: r.kind, status: r.status, importId: r.importId, requestedBy: r.requestedByName,
        createdAt: new Date(r.createdAt).toISOString(), finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
        result: (r.result as ApplyMonthResult | null) ?? null,
      },
    ]),
  );
}

/** "10:32" in India time today, "17 Nov, 10:32" on another day (audit B-L11). */
export function istClock(d: Date | string, now: Date = new Date()): string {
  const t = new Date(d);
  const day = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const time = t.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  if (day(t) === day(now)) return time;
  return `${t.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}, ${time}`;
}

/** "November 2026 is being applied by Asha since 10:32" (or "recalculated"). */
export function busyText(month: string, job: Pick<SalesMonthActiveJob, 'kind' | 'requestedBy' | 'createdAt'>, now?: Date): string {
  const what = job.kind === 'RECALC' ? 'recalculated' : 'applied';
  return `${monthLabel(month)} is being ${what} by ${job.requestedBy} since ${istClock(job.createdAt, now)}`;
}

/** Close / Reopen refuse (409) while an Apply / Recalculate of the month is queued or running (owner 2026-11-18). */
export async function assertNoActiveJob(db: Db, clientId: string, month: string): Promise<void> {
  const job = (await activeJobsByMonth(db, clientId, [month])).get(month);
  if (job) throw new ConflictException(`${busyText(month, job)} — try again when it finishes.`);
}

/**
 * Reprocess / Read again / Cancel / Delete of an import refuse (409) while an Apply of THAT import is queued or running
 * (audit A-L6): the job would otherwise fail half-way or apply data that no longer matches the import.
 */
export async function assertNoActiveJobForImport(db: Db, clientId: string, importId: string): Promise<void> {
  const rows = rowsOf<ActiveRow>(await q(db).$queryRaw(Prisma.sql`
    SELECT m."month", j."id" AS "jobId", j."kind", m."status", j."importId", j."requestedByName", j."createdAt"
      FROM "sales_apply_job_months" m
      JOIN "sales_apply_jobs" j ON j."id" = m."jobId"
     WHERE m."clientId" = ${clientId} AND j."importId" = ${importId} AND m."status" IN ('QUEUED', 'RUNNING')
     ORDER BY m."month" LIMIT 1`));
  const r = rows[0];
  if (!r) return;
  throw new ConflictException(
    `${busyText(r.month, { kind: r.kind, requestedBy: r.requestedByName, createdAt: new Date(r.createdAt).toISOString() })} from this file — try again when it finishes.`,
  );
}
