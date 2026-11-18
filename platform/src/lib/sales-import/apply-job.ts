/**
 * Background Apply / Recalculate jobs on the page (owner 2026-11-18). The POST only records a job (202); the sales-import
 * worker runs it. This module:
 *   - makes the per-click requestId (a resend of the same click returns the same job — never a second apply),
 *   - turns the POST's answer into ONE outcome — including when no clear answer arrived: the job is then looked up by
 *     requestId (found → follow it; 404 → that click recorded nothing; lookup fails too → unknown, Apply stays disabled),
 *   - follows a job (polls it) until it is DONE / FAILED, surviving transient errors.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResponse } from '@/lib/api-client';
import { failureReason, outcomeUnknown } from '@/lib/request-outcome';
import { salesImportApi } from './api';
import type { ApplyEnqueued, ApplyMonthResult, SalesApplyJobDto } from './types';

export const JOB_POLL_MS = 2000;
/** A job still QUEUED after this long: the worker did not start; the 10-minute drain starts it. Say so (never silent). */
export const JOB_QUEUED_TOO_LONG_MS = 2 * 60 * 1000;

/** A per-click id the server accepts (8–64 of [A-Za-z0-9_-]). */
export function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export type SubmitOutcome =
  | { kind: 'job'; job: SalesApplyJobDto; afterNoAnswer: boolean }
  | { kind: 'legacy'; results: ApplyMonthResult[] }
  | { kind: 'refused'; status?: number; reason: string }
  | { kind: 'not-recorded'; reason: string }
  | { kind: 'unknown'; reason: string };

const isJob = (d: unknown): d is ApplyEnqueued =>
  !!d && typeof d === 'object' && !!(d as ApplyEnqueued).job && typeof (d as ApplyEnqueued).job.id === 'string';

/**
 * What a submit led to. A 2xx with a job → follow it; the pre-release synchronous shape → legacy results; a definite
 * refusal → refused; no clear answer (or a 2xx without a usable body, L10) → look the click up by requestId.
 */
export async function resolveSubmit(
  r: ApiResponse<unknown>,
  requestId: string,
  legacy: (data: unknown) => ApplyMonthResult[] | null,
): Promise<SubmitOutcome> {
  if (r.success) {
    if (isJob(r.data)) return { kind: 'job', job: r.data.job, afterNoAnswer: false };
    const old = legacy(r.data);
    if (old) return { kind: 'legacy', results: old };
    // A 2xx without a usable body: the reply was damaged — treat it as no clear answer.
    return lookUp(requestId, 'the server’s reply was incomplete');
  }
  if (!outcomeUnknown(r)) return { kind: 'refused', status: r.status, reason: failureReason(r) };
  return lookUp(requestId, failureReason(r));
}

/** Look a click up by its requestId: the job it created, "nothing recorded" (404), or unknown. */
export async function lookUp(requestId: string, why: string): Promise<SubmitOutcome> {
  const f = await salesImportApi.findApplyJob(requestId);
  if (f.success && f.data?.id) return { kind: 'job', job: f.data, afterNoAnswer: true };
  if (!f.success && f.status === 404) return { kind: 'not-recorded', reason: why };
  return { kind: 'unknown', reason: why };
}

export const jobEnded = (j: SalesApplyJobDto | null) => !!j && (j.status === 'DONE' || j.status === 'FAILED');

/** A month of a finished (or running) job as a result card. */
export function monthResult(job: SalesApplyJobDto, month: string): ApplyMonthResult | null {
  const m = job.months.find((x) => x.month === month);
  if (!m || (m.status !== 'DONE' && m.status !== 'FAILED')) return null;
  return m.result ?? { month, ok: m.status === 'DONE', ...(m.status === 'FAILED' ? { error: job.error ?? 'Not applied.' } : {}) };
}

/**
 * Follow jobs by id until each ends. `onEnded(job)` fires once per job. A failed poll never claims the job failed: it is
 * retried (slower) and `lostContact` says so.
 */
export function useJobFollower(onEnded: (job: SalesApplyJobDto) => void) {
  const [jobs, setJobs] = useState<Record<string, SalesApplyJobDto>>({});
  const [lostContact, setLostContact] = useState(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const mounted = useRef(true);
  const endedRef = useRef(onEnded);
  useEffect(() => { endedRef.current = onEnded; }, [onEnded]);
  useEffect(() => {
    mounted.current = true;
    const t = timers.current;
    return () => { mounted.current = false; t.forEach(clearTimeout); t.clear(); };
  }, []);

  const poll = useCallback((jobId: string, delay: number) => {
    const prev = timers.current.get(jobId);
    if (prev) clearTimeout(prev);
    timers.current.set(jobId, setTimeout(async () => {
      const r = await salesImportApi.getApplyJob(jobId);
      if (!mounted.current) return;
      if (!r.success || !r.data?.id) {
        setLostContact(true);
        poll(jobId, JOB_POLL_MS * 3);
        return;
      }
      setLostContact(false);
      setJobs((p) => ({ ...p, [jobId]: r.data }));
      if (jobEnded(r.data)) {
        timers.current.delete(jobId);
        endedRef.current(r.data);
      } else poll(jobId, JOB_POLL_MS);
    }, delay));
  }, []);

  /** Start (or keep) following a job; with `job` already known it is shown at once. */
  const follow = useCallback((jobId: string, job?: SalesApplyJobDto) => {
    if (job) setJobs((p) => ({ ...p, [jobId]: job }));
    if (job && jobEnded(job)) { endedRef.current(job); return; }
    if (!timers.current.has(jobId)) poll(jobId, job ? JOB_POLL_MS : 0);
  }, [poll]);

  const forget = useCallback((jobId: string) => {
    const t = timers.current.get(jobId);
    if (t) clearTimeout(t);
    timers.current.delete(jobId);
    setJobs((p) => { const n = { ...p }; delete n[jobId]; return n; });
  }, []);

  return { jobs, lostContact, follow, forget };
}

/** "Queued", "Applying since 10:32", … — one line per month for the progress panel and the live region. */
export function monthProgressText(job: SalesApplyJobDto, month: string, label: string, clock: (iso: string) => string): string {
  const m = job.months.find((x) => x.month === month);
  const verb = job.kind === 'RECALC' ? 'Recalculating' : 'Applying';
  if (!m) return `${label}: unknown`;
  if (m.status === 'QUEUED') return `${label}: queued — waiting for the processor`;
  if (m.status === 'RUNNING') return `${label}: ${verb.toLowerCase()} (started ${clock(m.startedAt ?? job.createdAt)})…`;
  if (m.status === 'DONE') return `${label}: ${job.kind === 'RECALC' ? 'recalculated' : 'applied'}`;
  return `${label}: not ${job.kind === 'RECALC' ? 'recalculated' : 'applied'}`;
}
