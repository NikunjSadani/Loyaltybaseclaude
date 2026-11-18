import { ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import {
  SALES_APPLY_MAX_ATTEMPTS,
  SALES_APPLY_STALE_HEARTBEAT_MINUTES,
  type ApplyEnqueued,
  type ApplyMonthResult,
  type ApplyRequest,
  type SalesApplyJobDto,
  type SalesApplyJobKind,
  type SalesApplyJobStatus,
  type SalesMonthRecalcRequest,
} from '../sales-import.contract';
import { SQL_NOW_UTC } from '../sql-time';
import { monthLabel } from '../months/month-state';
import { ApplyStopError, SalesApplyService, type MonthWriteHooks } from './sales-apply.service';
import { activeJobsByMonth, busyText } from './apply-jobs-data';

/** How often a running job refreshes its heartbeat (well inside SALES_APPLY_STALE_HEARTBEAT_MINUTES). */
export const SALES_APPLY_HEARTBEAT_MS = 30_000;

interface JobRow {
  id: string;
  clientId: string;
  kind: SalesApplyJobKind;
  importId: string | null;
  requestId: string;
  request: unknown;
  requestedById: string;
  requestedByName: string;
  requestedByRole: string;
  status: SalesApplyJobStatus;
  claimToken: string | null;
  attempts: number;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}
interface MonthRow {
  month: string;
  status: SalesApplyJobStatus;
  result: ApplyMonthResult | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** What one worker run of a claimed job ended with. */
export type JobRunOutcome = 'finished' | 'released';

/** Something the worker can be told to stop with (WorkerStop satisfies it). */
export interface StopToken {
  readonly requested: boolean;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const MONTH_GENERIC_FAIL = 'Apply failed for this month. Nothing was changed for it.';
const RECALC_GENERIC_FAIL = 'Recalculate failed for this month. Nothing was changed for it.';

/** A page-made request id: short printable text only (anything else → a server-made one). */
function cleanRequestId(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
}

/** Postgres unique violation (Prisma raw: P2010 with meta.code 23505; typed: P2002), optionally of one index. */
export function isUniqueViolation(e: unknown, index?: string): boolean {
  const err = e as { code?: string; meta?: { code?: string; message?: string; target?: unknown }; message?: string };
  const unique = err?.code === 'P2002' || (err?.code === 'P2010' && String(err?.meta?.code) === '23505') || /23505|unique constraint/i.test(String(err?.message ?? ''));
  if (!unique) return false;
  if (!index) return true;
  return `${err?.message ?? ''} ${err?.meta?.message ?? ''} ${JSON.stringify(err?.meta?.target ?? '')}`.includes(index);
}

/**
 * Background Apply / Recalculate (owner 2026-11-18). Files reach 300–350 MB; one month takes 30–90 s; the Cloudflare
 * Worker cuts tenant-host requests at ~100 s and the API runs CPU-throttled once a response is sent. So:
 *   - enqueue*: the request is CHECKED (every 4xx as before), recorded as a job (QUEUED) and answered 202 at once;
 *   - the sales-import worker (Cloud Run Job, full CPU — started by the runner's kick, recovered by the 10-min drain)
 *     claims jobs (`FOR UPDATE SKIP LOCKED`, stale heartbeat → reclaimed) and runs them one month per transaction;
 *   - a month row becomes DONE INSIDE that month's transaction (MonthWriteHooks.inTx, guarded by the claim token), so a
 *     crash rolls the write and the DONE back together: a reclaimed job re-runs only months not yet written — never twice;
 *   - one active job per tenant × month (partial unique index) → a second Apply / Recalculate of that month gets 409, and
 *     Close / Reopen get 409 (assertNoActiveJob) until it ends.
 * Tables are read / written with raw SQL (migration 20261118170000_sales_apply_jobs).
 */
@Injectable()
export class SalesApplyJobsService {
  private readonly log = new Logger(SalesApplyJobsService.name);

  constructor(
    readonly prisma: PrismaService,
    private readonly apply: SalesApplyService,
  ) {}

  // ─── API side ──────────────────────────────────────────────────────────────────────────────

  async enqueueApply(user: JwtPayload, importId: string, body: ApplyRequest): Promise<ApplyEnqueued> {
    const requestId = cleanRequestId(body?.requestId) ?? randomUUID();
    const again = await this.findByRequestId(user.clientId, requestId);
    if (again) return this.enqueued(again);
    const months = await this.apply.precheckApply(user, importId, body); // 4xx here, nothing recorded
    const request: ApplyRequest = {
      months,
      expectedDefinitionsHash: body.expectedDefinitionsHash,
      processingVersion: body.processingVersion,
      acknowledgePartialMonths: body.acknowledgePartialMonths ?? [],
      acknowledgeOlderThanLastApplied: body.acknowledgeOlderThanLastApplied === true,
      expectedFocusFingerprints: body.expectedFocusFingerprints ?? {},
    };
    return this.enqueued(await this.insert(user, 'APPLY', importId, requestId, request, months));
  }

  async enqueueRecalculate(user: JwtPayload, month: string, body: SalesMonthRecalcRequest): Promise<ApplyEnqueued> {
    const requestId = cleanRequestId(body?.requestId) ?? randomUUID();
    const again = await this.findByRequestId(user.clientId, requestId);
    if (again) return this.enqueued(again);
    await this.apply.precheckRecalculate(user, month, body);
    const request: SalesMonthRecalcRequest = {
      expectedDefinitionsHash: body.expectedDefinitionsHash,
      expectedHistoryAppliedAt: body.expectedHistoryAppliedAt,
      ...(body.expectedFocusFingerprint !== undefined ? { expectedFocusFingerprint: body.expectedFocusFingerprint } : {}),
    };
    return this.enqueued(await this.insert(user, 'RECALC', null, requestId, request, [month]));
  }

  async getJob(clientId: string, jobId: string): Promise<SalesApplyJobDto> {
    const rows = await this.prisma.$queryRaw<JobRow[]>(Prisma.sql`
      SELECT * FROM "sales_apply_jobs" WHERE "id" = ${jobId} AND "clientId" = ${clientId}`);
    if (!rows[0]) throw new NotFoundException('This apply job was not found.');
    return this.toDto(rows[0]);
  }

  async findByRequestId(clientId: string, requestId: string): Promise<SalesApplyJobDto | null> {
    const rows = await this.prisma.$queryRaw<JobRow[]>(Prisma.sql`
      SELECT * FROM "sales_apply_jobs" WHERE "clientId" = ${clientId} AND "requestId" = ${requestId}`);
    return rows[0] ? this.toDto(rows[0]) : null;
  }

  /** Anything a worker would claim now (drain endpoint: kick the job runner). */
  async hasClaimable(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ n: number | bigint }>>(Prisma.sql`
      SELECT count(*)::int AS n FROM "sales_apply_jobs" WHERE ${CLAIMABLE}`);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  private async insert(
    user: JwtPayload, kind: SalesApplyJobKind, importId: string | null, requestId: string, request: unknown, months: string[],
  ): Promise<SalesApplyJobDto> {
    const jobId = randomUUID();
    const ids = months.map(() => randomUUID());
    try {
      // ONE statement: the job and its months are recorded together or not at all.
      await this.prisma.$executeRaw(Prisma.sql`
        WITH j AS (
          INSERT INTO "sales_apply_jobs"
            ("id","clientId","kind","importId","requestId","request","requestedById","requestedByName","requestedByRole","status","createdAt")
          VALUES (${jobId}, ${user.clientId}, ${kind}, ${importId}, ${requestId}, ${JSON.stringify(request)}::jsonb,
                  ${user.sub}, ${user.name || 'Unknown'}, ${user.role}, 'QUEUED', ${SQL_NOW_UTC})
          RETURNING "id"
        )
        INSERT INTO "sales_apply_job_months" ("id","jobId","clientId","month","status")
        SELECT u.id, j."id", ${user.clientId}, u.month, 'QUEUED'
          FROM j, unnest(${ids}::text[], ${months}::text[]) AS u(id, month)`);
    } catch (e) {
      if (isUniqueViolation(e, 'sales_apply_job_months_active_month_key')) {
        const active = await activeJobsByMonth(this.prisma, user.clientId, months);
        const busy = months.filter((m) => active.has(m)).map((m) => busyText(m, active.get(m)!));
        throw new ConflictException(
          busy.length ? `${busy.join('; ')}. Wait for it to finish, then check the result before applying again.`
            : 'Another apply of these months has just started. Refresh to see it.',
        );
      }
      if (isUniqueViolation(e, 'sales_apply_jobs_clientId_requestId_key')) {
        const again = await this.findByRequestId(user.clientId, requestId);
        if (again) return again;
      }
      throw e;
    }
    return this.getJob(user.clientId, jobId);
  }

  private enqueued(job: SalesApplyJobDto): ApplyEnqueued {
    return {
      job,
      // Old pages (loaded before this release) read `results`: one honest line per month instead of a crash.
      results: job.months.map((m) => ({
        month: m.month,
        ok: false,
        error: `${monthLabel(m.month)} is being ${job.kind === 'RECALC' ? 'recalculated' : 'applied'} in the background — refresh this page to follow it. Don't apply it again.`,
      })),
    };
  }

  private async toDto(j: JobRow): Promise<SalesApplyJobDto> {
    const months = await this.prisma.$queryRaw<MonthRow[]>(Prisma.sql`
      SELECT "month","status","result","startedAt","finishedAt" FROM "sales_apply_job_months"
       WHERE "jobId" = ${j.id} ORDER BY "month"`);
    return {
      id: j.id,
      kind: j.kind,
      importId: j.importId,
      requestId: j.requestId,
      status: j.status,
      requestedBy: j.requestedByName,
      createdAt: iso(j.createdAt)!,
      startedAt: iso(j.startedAt),
      finishedAt: iso(j.finishedAt),
      error: j.error,
      months: months.map((m) => ({
        month: m.month,
        status: m.status,
        startedAt: iso(m.startedAt),
        finishedAt: iso(m.finishedAt),
        result: (m.result as ApplyMonthResult | null) ?? null,
      })),
    };
  }

  // ─── Worker side ───────────────────────────────────────────────────────────────────────────

  /** Claim one QUEUED (or heartbeat-stale RUNNING) job; concurrent workers never claim the same one. */
  async claimNext(token: string = randomUUID()): Promise<JobRow | null> {
    const rows = await this.prisma.$queryRaw<JobRow[]>(Prisma.sql`
      UPDATE "sales_apply_jobs"
         SET "status" = 'RUNNING', "claimToken" = ${token}, "heartbeatAt" = ${SQL_NOW_UTC},
             "attempts" = "attempts" + 1, "startedAt" = COALESCE("startedAt", ${SQL_NOW_UTC})
       WHERE "id" = (
         SELECT "id" FROM "sales_apply_jobs" WHERE ${CLAIMABLE}
          ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
       )
      RETURNING *`);
    return rows[0] ?? null;
  }

  /** Claim → run until nothing is claimable or a stop is requested. Returns how many jobs were finished / released. */
  async drain(stop: StopToken = { requested: false }): Promise<{ finished: number; released: number }> {
    const out = { finished: 0, released: 0 };
    while (!stop.requested) {
      const job = await this.claimNext();
      if (!job) break;
      out[await this.runClaimed(job, stop)]++;
    }
    return out;
  }

  async runClaimed(job: JobRow, stop: StopToken = { requested: false }): Promise<JobRunOutcome> {
    const token = job.claimToken!;
    const beat = setInterval(() => {
      void this.prisma.$executeRaw(Prisma.sql`
        UPDATE "sales_apply_jobs" SET "heartbeatAt" = ${SQL_NOW_UTC} WHERE "id" = ${job.id} AND "claimToken" = ${token}`)
        .catch(() => undefined);
    }, SALES_APPLY_HEARTBEAT_MS);
    (beat as { unref?: () => void }).unref?.();
    try {
      // Months left RUNNING by a dead run were never written (DONE is set in the write's own transaction) → run again.
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "sales_apply_job_months" SET "status" = 'QUEUED', "startedAt" = NULL
         WHERE "jobId" = ${job.id} AND "status" = 'RUNNING'`);
      if (job.attempts > SALES_APPLY_MAX_ATTEMPTS) {
        await this.failRemaining(job, token,
          `Stopped after ${SALES_APPLY_MAX_ATTEMPTS} attempts without finishing. Nothing more was written for this month — check it and apply again.`);
        return 'finished';
      }
      const pending = (await this.prisma.$queryRaw<Array<{ month: string }>>(Prisma.sql`
        SELECT "month" FROM "sales_apply_job_months" WHERE "jobId" = ${job.id} AND "status" = 'QUEUED' ORDER BY "month"`))
        .map((r) => r.month);
      if (pending.length > 0) {
        const user: JwtPayload = { sub: job.requestedById, role: job.requestedByRole, clientId: job.clientId, phone: '', name: job.requestedByName };
        const hooks = this.hooks(job, token, stop);
        try {
          if (job.kind === 'APPLY') await this.runApply(job, user, pending, hooks, token);
          else await this.runRecalc(job, user, pending[0], hooks, token);
        } catch (e) {
          if (e instanceof ApplyStopError) {
            await this.release(job, token);
            return 'released';
          }
          if (e instanceof HttpException) {
            // Refused as a whole before any write (e.g. focus products / definitions changed since the preview).
            await this.failRemaining(job, token, e.message, e.message);
            return 'finished';
          }
          // Unexpected (DB unreachable…): hand it back; the next run retries, SALES_APPLY_MAX_ATTEMPTS bounds it.
          this.log.error(`apply job ${job.id} run failed: ${(e as Error)?.message}`);
          await this.release(job, token);
          return 'released';
        }
      }
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "sales_apply_jobs" SET "status" = 'DONE', "finishedAt" = ${SQL_NOW_UTC}, "claimToken" = NULL
         WHERE "id" = ${job.id} AND "claimToken" = ${token}`);
      return 'finished';
    } finally {
      clearInterval(beat);
    }
  }

  private hooks(job: JobRow, token: string, stop: StopToken): MonthWriteHooks {
    return {
      beforeMonth: async (month) => {
        if (stop.requested) throw new ApplyStopError('worker stopping');
        const n = await this.prisma.$executeRaw(Prisma.sql`
          UPDATE "sales_apply_job_months" m SET "status" = 'RUNNING', "startedAt" = ${SQL_NOW_UTC}
            FROM "sales_apply_jobs" j
           WHERE m."jobId" = j."id" AND j."id" = ${job.id} AND j."claimToken" = ${token}
             AND m."month" = ${month} AND m."status" = 'QUEUED'`);
        if (Number(n) !== 1) throw new ApplyStopError('claim lost');
      },
      // INSIDE the month's write transaction: DONE commits with the write, or neither does.
      inTx: async (tx, res) => {
        const n = await tx.$executeRaw(Prisma.sql`
          UPDATE "sales_apply_job_months" m SET "status" = 'DONE', "result" = ${JSON.stringify(res)}::jsonb, "finishedAt" = ${SQL_NOW_UTC}
            FROM "sales_apply_jobs" j
           WHERE m."jobId" = j."id" AND j."id" = ${job.id} AND j."claimToken" = ${token}
             AND m."month" = ${res.month} AND m."status" = 'RUNNING'`);
        if (Number(n) !== 1) throw new Error('apply job claim lost — this month is rolled back');
      },
    };
  }

  private async runApply(job: JobRow, user: JwtPayload, pending: string[], hooks: MonthWriteHooks, token: string): Promise<void> {
    const req = { ...(job.request as ApplyRequest), months: pending };
    const { results } = await this.apply.apply(user, job.importId!, req, hooks);
    for (const r of results) if (!r.ok) await this.failMonth(job, token, r);
  }

  private async runRecalc(job: JobRow, user: JwtPayload, month: string, hooks: MonthWriteHooks, token: string): Promise<void> {
    await hooks.beforeMonth!(month);
    try {
      await this.apply.recalculate(user, month, job.request as SalesMonthRecalcRequest, hooks);
    } catch (e) {
      if (e instanceof ApplyStopError) throw e;
      const msg = e instanceof HttpException ? e.message : RECALC_GENERIC_FAIL;
      if (!(e instanceof HttpException)) this.log.error(`recalculate job ${job.id} ${month} failed: ${(e as Error)?.message}`);
      await this.failMonth(job, token, { month, ok: false, error: msg });
    }
  }

  /** A month that was not written: FAILED with its reason (only while this run still holds the claim). */
  private async failMonth(job: JobRow, token: string, r: ApplyMonthResult): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "sales_apply_job_months" m SET "status" = 'FAILED', "result" = ${JSON.stringify({ ...r, error: r.error || MONTH_GENERIC_FAIL })}::jsonb,
             "finishedAt" = ${SQL_NOW_UTC}
        FROM "sales_apply_jobs" j
       WHERE m."jobId" = j."id" AND j."id" = ${job.id} AND j."claimToken" = ${token}
         AND m."month" = ${r.month} AND m."status" IN ('QUEUED','RUNNING')`);
  }

  /** Every month not yet written → FAILED with `reason`; the job ends (FAILED when refused as a whole, else DONE). */
  private async failRemaining(job: JobRow, token: string, reason: string, jobError?: string): Promise<void> {
    const pending = await this.prisma.$queryRaw<Array<{ month: string }>>(Prisma.sql`
      SELECT "month" FROM "sales_apply_job_months" WHERE "jobId" = ${job.id} AND "status" IN ('QUEUED','RUNNING')`);
    for (const p of pending) await this.failMonth(job, token, { month: p.month, ok: false, error: reason });
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "sales_apply_jobs" SET "status" = ${jobError ? 'FAILED' : 'DONE'}, "error" = ${jobError ?? null},
             "finishedAt" = ${SQL_NOW_UTC}, "claimToken" = NULL
       WHERE "id" = ${job.id} AND "claimToken" = ${token}`);
  }

  /** Hand the job back (stop / unexpected error): QUEUED again, months not written stay QUEUED. */
  private async release(job: JobRow, token: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "sales_apply_job_months" SET "status" = 'QUEUED', "startedAt" = NULL
       WHERE "jobId" = ${job.id} AND "status" = 'RUNNING'`);
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "sales_apply_jobs" SET "status" = 'QUEUED', "claimToken" = NULL
       WHERE "id" = ${job.id} AND "claimToken" = ${token}`);
  }
}

/** QUEUED, or RUNNING with a heartbeat older than SALES_APPLY_STALE_HEARTBEAT_MINUTES (its worker died). */
const CLAIMABLE = Prisma.sql`("status" = 'QUEUED'
  OR ("status" = 'RUNNING' AND ("heartbeatAt" IS NULL
      OR "heartbeatAt" < ${SQL_NOW_UTC} - make_interval(mins => ${SALES_APPLY_STALE_HEARTBEAT_MINUTES}::int))))`;
