import { ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { can } from '../../common/rbac/can';
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
import { isSalesImportEnabledUncached } from '../sales-import-access';
import {
  ApplyStopError, SalesApplyService, TransientApplyError, isTransientDbError, type MonthWriteHooks,
} from './sales-apply.service';
import { activeJobsByMonth, busyText } from './apply-jobs-data';

/** How often a running job refreshes its heartbeat (well inside SALES_APPLY_STALE_HEARTBEAT_MINUTES). */
export const SALES_APPLY_HEARTBEAT_MS = 30_000;

/** The 404 text of GET apply-jobs?requestId= — the page treats ONLY this 404 as "that click recorded nothing" (A-M4). */
export const NO_JOB_FOR_REQUEST = 'No apply was recorded for this request.';

export interface JobRow {
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
  focusBasis: unknown;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}
interface MonthRow {
  month: string;
  status: SalesApplyJobStatus;
  result: ApplyMonthResult | null;
  lastError: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** What one worker run of a claimed job ended with. */
export type JobRunOutcome = 'finished' | 'released';

/** Something the worker can be told to stop with (WorkerStop satisfies it). */
export interface StopToken {
  readonly requested: boolean;
  /** Called on a stop signal (immediately when already requested); returns an unsubscribe. */
  onStop?(cb: (reason: string) => void): () => void;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const RECALC_GENERIC_FAIL = 'Recalculate failed for this month. Nothing was changed for it.';
const sameMonths = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((m, i) => m === [...b].sort()[i]);

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
 *   - enqueue*: the request is CHECKED (every 4xx as before, incl. a CLOSED month), recorded as a job (QUEUED) and
 *     answered 202 at once;
 *   - the sales-import worker (Cloud Run Job, full CPU — started by the runner's kick, recovered by the 10-min drain)
 *     claims jobs (`FOR UPDATE SKIP LOCKED`, stale heartbeat → reclaimed) and runs them one month per transaction;
 *   - a month row becomes DONE INSIDE that month's transaction (MonthWriteHooks.inTx, guarded by the claim token), so a
 *     crash rolls the write and the DONE back together: a reclaimed job re-runs only months not yet written — never twice;
 *   - before each job the worker re-checks the tenant flag and the requester (still active, still allowed) (A-L4);
 *   - a stop signal hands the job straight back (A-M2); a transient DB error hands it back for a retry (A-L2); neither a
 *     stop nor a lost claim counts as an attempt; after SALES_APPLY_MAX_ATTEMPTS the months fail with the last error (A-L3);
 *   - one active job per tenant × month (partial unique index) → a second Apply / Recalculate of that month gets 409, and
 *     Close / Reopen / Reprocess / Cancel / Delete get 409 (assertNoActiveJob*) until it ends.
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
    if (again) {
      this.assertSameRequest(again, 'APPLY', importId, Array.isArray(body?.months) ? body.months : []);
      return this.enqueued(again);
    }
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
    if (again) {
      this.assertSameRequest(again, 'RECALC', null, [month]);
      return this.enqueued(again);
    }
    await this.apply.precheckRecalculate(user, month, body);
    const request: SalesMonthRecalcRequest = {
      expectedDefinitionsHash: body.expectedDefinitionsHash,
      expectedHistoryAppliedAt: body.expectedHistoryAppliedAt,
      ...(body.expectedFocusFingerprint !== undefined ? { expectedFocusFingerprint: body.expectedFocusFingerprint } : {}),
    };
    return this.enqueued(await this.insert(user, 'RECALC', null, requestId, request, [month]));
  }

  /** A-L5: a requestId resent for a DIFFERENT apply (other import / kind / months) is refused, never mapped to the old job. */
  private assertSameRequest(job: SalesApplyJobDto, kind: SalesApplyJobKind, importId: string | null, months: string[]): void {
    if (job.kind === kind && job.importId === importId && sameMonths(job.months.map((m) => m.month), months)) return;
    throw new ConflictException('This request id was already used for a different apply. Refresh the page and try again.');
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
        if (again) {
          this.assertSameRequest(again, kind, importId, months);
          return again;
        }
      }
      throw e;
    }
    return this.getJob(user.clientId, jobId);
  }

  private enqueued(job: SalesApplyJobDto): ApplyEnqueued {
    const verb = job.kind === 'RECALC' ? 'recalculated' : 'applied';
    const text = (month: string) =>
      `Not finished yet: ${monthLabel(month)} is being ${verb} in the background — refresh this page to follow it. Don't ${job.kind === 'RECALC' ? 'recalculate' : 'apply'} it again.`;
    return {
      job,
      // Old pages (loaded before this release) read `results` (Apply) or a top-level month result (Recalculate, B-H2):
      // an honest line instead of a crash or a false "recalculated".
      results: job.months.map((m) => ({ month: m.month, ok: false, error: text(m.month) })),
      ...(job.kind === 'RECALC' && job.months[0] ? { month: job.months[0].month, ok: false as const, error: text(job.months[0].month) } : {}),
    };
  }

  private async toDto(j: JobRow): Promise<SalesApplyJobDto> {
    const months = await this.prisma.$queryRaw<MonthRow[]>(Prisma.sql`
      SELECT "month","status","result","lastError","startedAt","finishedAt" FROM "sales_apply_job_months"
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
      attempts: Number(j.attempts ?? 0),
      months: months.map((m) => ({
        month: m.month,
        status: m.status,
        startedAt: iso(m.startedAt),
        finishedAt: iso(m.finishedAt),
        result: (m.result as ApplyMonthResult | null) ?? null,
        lastError: m.lastError ?? null,
      })),
    };
  }

  // ─── Worker side ───────────────────────────────────────────────────────────────────────────

  /** Claim one QUEUED (or heartbeat-stale RUNNING) job; concurrent workers never claim the same one. */
  async claimNext(token: string = randomUUID(), exclude: string[] = []): Promise<JobRow | null> {
    const rows = await this.prisma.$queryRaw<JobRow[]>(Prisma.sql`
      UPDATE "sales_apply_jobs"
         SET "status" = 'RUNNING', "claimToken" = ${token}, "heartbeatAt" = ${SQL_NOW_UTC},
             "attempts" = "attempts" + 1, "startedAt" = COALESCE("startedAt", ${SQL_NOW_UTC})
       WHERE "id" = (
         SELECT "id" FROM "sales_apply_jobs" WHERE ${CLAIMABLE} AND NOT ("id" = ANY(${exclude}::text[]))
          ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
       )
      RETURNING *`);
    return rows[0] ?? null;
  }

  /** Claim → run until nothing is claimable or a stop is requested. Returns how many jobs were finished / released. */
  async drain(stop: StopToken = { requested: false }): Promise<{ finished: number; released: number }> {
    const out = { finished: 0, released: 0 };
    // A job handed back in THIS drain (transient error / lost claim) is not claimed again by it: the next run (kick or
    // the 10-minute drain) retries it — a natural back-off instead of a hot retry loop.
    const handedBack: string[] = [];
    while (!stop.requested) {
      const job = await this.claimNext(randomUUID(), handedBack);
      if (!job) break;
      const r = await this.runClaimed(job, stop);
      out[r]++;
      if (r === 'released') handedBack.push(job.id);
      // A-M2: a stop that arrived during the job ends the loop (checked after each job and each month).
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
    // A-M2: on SIGTERM hand the job back AT ONCE (QUEUED, no heartbeat), so Cloud Run's retry / the next run picks it up
    // instead of waiting 10 min for the heartbeat to go stale. A month still writing cannot commit DONE any more (its
    // inTx is guarded by the cleared claim token), so it rolls back whole and is simply run again.
    let released = false;
    const off = stop.onStop?.(() => { released = true; void this.release(job, token, { countAttempt: false }); });
    try {
      // Months left RUNNING by a dead run were never written (DONE is set in the write's own transaction) → run again.
      await this.resetRunningMonths(job.id, token);
      if (job.attempts > SALES_APPLY_MAX_ATTEMPTS) {
        await this.failRemaining(job, token, (last) =>
          `Stopped after ${SALES_APPLY_MAX_ATTEMPTS} attempts without finishing${last ? `: ${last}` : ''}. Nothing more was written for this month — check it and apply again.`);
        return 'finished';
      }
      const refusal = await this.requesterRefusal(job);
      if (refusal) {
        await this.failRemaining(job, token, () => refusal, refusal);
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
            if (!released) await this.release(job, token, { countAttempt: false });
            return 'released';
          }
          if (e instanceof TransientApplyError) {
            // A-L2: the month rolled back; retry later, remembering the reason in case the attempts run out (A-L3).
            this.log.warn(`apply job ${job.id}: ${e.message} — handed back for a retry`);
            await this.release(job, token, { countAttempt: true, lastError: e.message, month: e.month });
            return 'released';
          }
          if (e instanceof HttpException) {
            // Refused as a whole before any write (e.g. focus products / definitions changed since the preview).
            await this.failRemaining(job, token, () => e.message, e.message);
            return 'finished';
          }
          // Unexpected (DB unreachable before the first month…): hand it back; SALES_APPLY_MAX_ATTEMPTS bounds it.
          this.log.error(`apply job ${job.id} run failed: ${(e as Error)?.message}`);
          await this.release(job, token, { countAttempt: true, lastError: (e as Error)?.message ?? 'unknown error' });
          return 'released';
        }
      }
      if (released || stop.requested) {
        if (!released) await this.release(job, token, { countAttempt: false });
        return 'released';
      }
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "sales_apply_jobs" SET "status" = 'DONE', "finishedAt" = ${SQL_NOW_UTC}, "claimToken" = NULL
         WHERE "id" = ${job.id} AND "claimToken" = ${token}`);
      return 'finished';
    } finally {
      clearInterval(beat);
      off?.();
    }
  }

  /**
   * A-L4: the worker runs as the requester, so re-check what the API checked at enqueue — the tenant's Sales Import flag
   * (uncached), the requester still ACTIVE and still allowed to apply. A reason (never silent) when not.
   */
  private async requesterRefusal(job: JobRow): Promise<string | null> {
    const what = job.kind === 'RECALC' ? 'recalculation' : 'apply';
    if (!(await isSalesImportEnabledUncached(this.prisma, job.clientId))) {
      return `Sales Import was turned off for this client before this ${what} ran. Nothing was written.`;
    }
    const u = await this.prisma.user.findUnique({
      where: { id: job.requestedById },
      select: { status: true, deletedAt: true, role: true, gifsyRoleId: true },
    });
    if (!u || u.deletedAt || u.status !== 'ACTIVE') {
      return `${job.requestedByName}'s account is no longer active, so this ${what} was not run. Nothing was written — someone with access can do it again.`;
    }
    if (!(await this.mayUpload(u.role, u.gifsyRoleId, job.clientId))) {
      return `${job.requestedByName} is no longer allowed to apply sales files, so this ${what} was not run. Nothing was written.`;
    }
    return null;
  }

  /** targets:upload for the requester, mirroring PermissionGuard (GIFSY_STAFF: its GifsyRole; others: RBAC if enforced). */
  private async mayUpload(role: string, gifsyRoleId: string | null, clientId: string): Promise<boolean> {
    if (!['CLIENT_ADMIN', 'GIFSY_ADMIN', 'GIFSY_STAFF'].includes(role)) return false;
    if (role === 'GIFSY_STAFF') {
      if (!gifsyRoleId) return false;
      const r = await this.prisma.gifsyRole.findFirst({ where: { id: gifsyRoleId, deletedAt: null }, select: { permissions: true } });
      return !!r?.permissions.includes('targets:upload');
    }
    if (process.env.RBAC_ENFORCEMENT !== 'true') return true;
    const c = await this.prisma.client.findUnique({ where: { id: clientId }, select: { features: true } });
    const enforced = (c?.features as Record<string, unknown> | null)?.rbacEnforcement === true;
    return !enforced || can(role, 'targets:upload');
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
    const basis = Array.isArray(job.focusBasis) ? (job.focusBasis as Array<{ dims: unknown }>) : undefined;
    const { results } = await this.apply.apply(user, job.importId!, req, hooks, {
      focusHistory: basis,
      // A-M1: the first run snapshots the stored product lists (before any month is written); retries reuse them.
      onFocusHistory: async (history) => {
        await this.prisma.$executeRaw(Prisma.sql`
          UPDATE "sales_apply_jobs" SET "focusBasis" = ${JSON.stringify(history)}::jsonb
           WHERE "id" = ${job.id} AND "claimToken" = ${token} AND "focusBasis" IS NULL`);
      },
    });
    for (const r of results) if (!r.ok) await this.failMonth(job, token, r);
  }

  private async runRecalc(job: JobRow, user: JwtPayload, month: string, hooks: MonthWriteHooks, token: string): Promise<void> {
    await hooks.beforeMonth!(month);
    try {
      await this.apply.recalculate(user, month, job.request as SalesMonthRecalcRequest, hooks);
    } catch (e) {
      if (e instanceof ApplyStopError) throw e;
      if (!(e instanceof HttpException) && isTransientDbError(e)) {
        throw new TransientApplyError(month, `${monthLabel(month)}: a temporary database problem (${(e as Error)?.message ?? 'unknown'})`);
      }
      const msg = e instanceof HttpException ? e.message : RECALC_GENERIC_FAIL;
      if (!(e instanceof HttpException)) this.log.error(`recalculate job ${job.id} ${month} failed: ${(e as Error)?.message}`);
      await this.failMonth(job, token, { month, ok: false, error: msg });
    }
  }

  /** A month that was not written: FAILED with its reason (only while this run still holds the claim). */
  private async failMonth(job: JobRow, token: string, r: ApplyMonthResult): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "sales_apply_job_months" m SET "status" = 'FAILED', "result" = ${JSON.stringify({ ...r, error: r.error || 'Not applied. No reason was given.' })}::jsonb,
             "finishedAt" = ${SQL_NOW_UTC}
        FROM "sales_apply_jobs" j
       WHERE m."jobId" = j."id" AND j."id" = ${job.id} AND j."claimToken" = ${token}
         AND m."month" = ${r.month} AND m."status" IN ('QUEUED','RUNNING')`);
  }

  /** Every month not yet written → FAILED with `reason(lastError)`; the job ends (FAILED when refused as a whole, else DONE). */
  private async failRemaining(job: JobRow, token: string, reason: (lastError: string | null) => string, jobError?: string): Promise<void> {
    const pending = await this.prisma.$queryRaw<Array<{ month: string; lastError: string | null }>>(Prisma.sql`
      SELECT "month", "lastError" FROM "sales_apply_job_months" WHERE "jobId" = ${job.id} AND "status" IN ('QUEUED','RUNNING')`);
    for (const p of pending) await this.failMonth(job, token, { month: p.month, ok: false, error: reason(p.lastError ?? null) });
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "sales_apply_jobs" SET "status" = ${jobError ? 'FAILED' : 'DONE'}, "error" = ${jobError ?? null},
             "finishedAt" = ${SQL_NOW_UTC}, "claimToken" = NULL
       WHERE "id" = ${job.id} AND "claimToken" = ${token}`);
  }

  /** RUNNING months of a job THIS run holds → QUEUED (A-M3: never touches a month of a run that took the job over). */
  private async resetRunningMonths(jobId: string, token: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "sales_apply_job_months" m SET "status" = 'QUEUED', "startedAt" = NULL
        FROM "sales_apply_jobs" j
       WHERE m."jobId" = j."id" AND j."id" = ${jobId} AND j."claimToken" = ${token} AND m."status" = 'RUNNING'`);
  }

  /**
   * Hand the job back: QUEUED, heartbeat cleared (claimable at once), months not written QUEUED again — all guarded by
   * this run's claim token (A-M3). A stop / lost claim does not use up an attempt; a retryable error does and is kept as
   * the month's lastError (A-L3).
   */
  private async release(job: JobRow, token: string, o: { countAttempt: boolean; lastError?: string; month?: string }): Promise<void> {
    if (o.lastError) {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "sales_apply_job_months" m SET "lastError" = ${o.lastError}
          FROM "sales_apply_jobs" j
         WHERE m."jobId" = j."id" AND j."id" = ${job.id} AND j."claimToken" = ${token}
           AND m."status" IN ('QUEUED','RUNNING') AND (${o.month ?? null}::text IS NULL OR m."month" = ${o.month ?? null})`);
    }
    await this.resetRunningMonths(job.id, token);
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "sales_apply_jobs"
         SET "status" = 'QUEUED', "claimToken" = NULL, "heartbeatAt" = NULL,
             "attempts" = GREATEST(0, "attempts" - ${o.countAttempt ? 0 : 1})
       WHERE "id" = ${job.id} AND "claimToken" = ${token}`);
  }
}

/** QUEUED, or RUNNING with a heartbeat older than SALES_APPLY_STALE_HEARTBEAT_MINUTES (its worker died). */
const CLAIMABLE = Prisma.sql`("status" = 'QUEUED'
  OR ("status" = 'RUNNING' AND ("heartbeatAt" IS NULL
      OR "heartbeatAt" < ${SQL_NOW_UTC} - make_interval(mins => ${SALES_APPLY_STALE_HEARTBEAT_MINUTES}::int))))`;
