/**
 * Background Apply / Recalculate jobs on the page (owner 2026-11-18). The POST only records a job (202); the sales-import
 * worker runs it. This module:
 *   - makes the per-click requestId (a resend of the same click returns the same job — never a second apply),
 *   - turns the POST's answer into ONE outcome — including when no clear answer arrived: the job is then looked up by
 *     requestId (found → follow it; the server's own "nothing recorded" 404, twice 5 s apart → nothing recorded; anything
 *     else → unknown, Apply stays disabled),
 *   - follows jobs (polls them) until DONE / FAILED: once per job, paused while the tab is hidden, a 401 / 403 / 404
 *     stops with a clear message, any other failure is retried and shown per job,
 *   - remembers an UNKNOWN outcome in sessionStorage so a reload keeps Apply held until it is settled.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResponse } from '@/lib/api-client';
import { failureReason, outcomeUnknown } from '@/lib/request-outcome';
import { salesImportApi } from './api';
import type { ApplyEnqueued, ApplyMonthResult, SalesApplyJobDto } from './types';

export const JOB_POLL_MS = 2000;
/** A job still QUEUED after this long: the worker did not start; the 10-minute drain starts it. Say so (never silent). */
export const JOB_QUEUED_TOO_LONG_MS = 2 * 60 * 1000;
/** "Nothing recorded" is only said after a second lookup this much later (audit B-M9: the insert may still be landing). */
export const LOOKUP_RETRY_MS = 5000;
/** The backend's 404 text for a click that recorded nothing (api NO_JOB_FOR_REQUEST). Any other 404 = unknown (A-M4). */
export const NO_JOB_FOR_REQUEST = 'No apply was recorded for this request.';

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

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
/** The server's own "this click recorded nothing" — NOT any 404 (an API from before this release has no such route). */
const saysNothingRecorded = (f: ApiResponse<unknown>) =>
  !f.success && f.status === 404 && (f.error ?? '').trim() === NO_JOB_FOR_REQUEST;

/** Look a click up by its requestId: the job it created, "nothing recorded" (said twice, 5 s apart), or unknown. */
export async function lookUp(requestId: string, why: string, retryMs: number = LOOKUP_RETRY_MS): Promise<SubmitOutcome> {
  for (let i = 0; i < 2; i++) {
    const f = await salesImportApi.findApplyJob(requestId);
    if (f.success && f.data?.id) return { kind: 'job', job: f.data, afterNoAnswer: true };
    if (!saysNothingRecorded(f)) return { kind: 'unknown', reason: why };
    if (i === 0) await sleep(retryMs);
  }
  return { kind: 'not-recorded', reason: why };
}

export const jobEnded = (j: SalesApplyJobDto | null | undefined) => !!j && (j.status === 'DONE' || j.status === 'FAILED');

/** A month of a finished (or running) job as a result card. */
export function monthResult(job: SalesApplyJobDto, month: string): ApplyMonthResult | null {
  const m = job.months.find((x) => x.month === month);
  if (!m || (m.status !== 'DONE' && m.status !== 'FAILED')) return null;
  return m.result ?? { month, ok: m.status === 'DONE', ...(m.status === 'FAILED' ? { error: job.error ?? 'Not applied. No reason was given.' } : {}) };
}

/** Why following a job stopped for good (401 / 403 / 404), or that polls are failing and being retried. */
export type FollowProblem = { final: boolean; text: string };

function followProblem(r: ApiResponse<unknown>): FollowProblem {
  if (r.success) return { final: false, text: 'the server’s reply was incomplete — still trying' };
  if (r.status === 401) return { final: true, text: 'Your session has expired. Sign in again to see how the apply went.' };
  if (r.status === 403) return { final: true, text: 'You no longer have access to follow this apply. Ask an admin to check the result.' };
  if (r.status === 404) return { final: true, text: 'This apply could not be found any more. Refresh the page to see the months as they are now.' };
  return { final: false, text: `Lost contact with the server while following it (${failureReason(r)}) — still trying. The work itself carries on.` };
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * Follow jobs by id until each ends. `onEnded(job)` fires ONCE per job (B-L6). A failed poll never claims the job failed:
 * it is retried (slower) and `problems[jobId]` says so; 401 / 403 / 404 stop following with a clear message (B-M5).
 * Polling pauses while the tab is hidden and resumes when it is shown (B-L9).
 */
export function useJobFollower(onEnded: (job: SalesApplyJobDto) => void) {
  const [jobs, setJobs] = useState<Record<string, SalesApplyJobDto>>({});
  const [problems, setProblems] = useState<Record<string, FollowProblem>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const ended = useRef(new Set<string>());
  const waitingVisible = useRef(new Set<string>());
  const mounted = useRef(true);
  const endedRef = useRef(onEnded);
  useEffect(() => { endedRef.current = onEnded; }, [onEnded]);

  const finish = useCallback((job: SalesApplyJobDto) => {
    if (ended.current.has(job.id)) return;
    ended.current.add(job.id);
    endedRef.current(job);
  }, []);

  const poll = useCallback((jobId: string, delay: number) => {
    const prev = timers.current.get(jobId);
    if (prev) clearTimeout(prev);
    timers.current.set(jobId, setTimeout(async () => {
      if (!mounted.current) return;
      if (hidden()) { timers.current.delete(jobId); waitingVisible.current.add(jobId); return; }
      const r = await salesImportApi.getApplyJob(jobId);
      if (!mounted.current) return;
      if (!r.success || !r.data?.id) {
        const p = followProblem(r);
        setProblems((x) => ({ ...x, [jobId]: p }));
        if (p.final) timers.current.delete(jobId);
        else poll(jobId, JOB_POLL_MS * 3);
        return;
      }
      setProblems((x) => { if (!x[jobId]) return x; const n = { ...x }; delete n[jobId]; return n; });
      setJobs((p) => ({ ...p, [jobId]: r.data }));
      if (jobEnded(r.data)) {
        timers.current.delete(jobId);
        finish(r.data);
      } else poll(jobId, JOB_POLL_MS);
    }, delay));
  }, [finish]);

  useEffect(() => {
    mounted.current = true;
    const t = timers.current;
    const onVisible = () => {
      if (hidden()) return;
      for (const id of [...waitingVisible.current]) { waitingVisible.current.delete(id); poll(id, 0); }
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted.current = false;
      t.forEach(clearTimeout);
      t.clear();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll]);

  /** Start (or keep) following a job; with `job` already known it is shown at once. */
  const follow = useCallback((jobId: string, job?: SalesApplyJobDto) => {
    if (job) setJobs((p) => ({ ...p, [jobId]: job }));
    if (job && jobEnded(job)) { finish(job); return; }
    if (ended.current.has(jobId)) return;
    if (!timers.current.has(jobId) && !waitingVisible.current.has(jobId)) poll(jobId, job ? JOB_POLL_MS : 0);
  }, [poll, finish]);

  return { jobs, problems, follow };
}

/**
 * "10:32" in India time today, "17 Nov, 10:32" on another day (B-L11) — the admin's clock.
 */
export function whenLabel(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  const day = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const time = t.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  return day(t) === day(now) ? time : `${t.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}, ${time}`;
}

/** The job's headline (B-L1 / B-L2): queued (waiting its turn), handed back after a restart, or running. */
export function jobHeadline(job: SalesApplyJobDto): string {
  if (job.status === 'QUEUED') {
    return job.attempts > 0
      ? 'Waiting to continue — the processor was restarted; it carries on by itself'
      : 'Queued — waiting its turn for the processor';
  }
  return job.kind === 'RECALC' ? 'Recalculating in the background' : 'Applying in the background';
}

/** "Queued", "Applying since 10:32", … — one line per month for the progress panel and the live region. */
export function monthProgressText(job: SalesApplyJobDto, month: string, label: string): string {
  const m = job.months.find((x) => x.month === month);
  const verb = job.kind === 'RECALC' ? 'recalculating' : 'applying';
  if (!m) return `${label}: unknown`;
  if (m.status === 'QUEUED') return job.status === 'RUNNING' ? `${label}: waiting its turn in this ${job.kind === 'RECALC' ? 'recalculation' : 'apply'}` : `${label}: queued`;
  if (m.status === 'RUNNING') return `${label}: ${verb} (started ${whenLabel(m.startedAt ?? job.createdAt)})…`;
  if (m.status === 'DONE') return `${label}: ${job.kind === 'RECALC' ? 'recalculated' : 'applied'}`;
  return `${label}: not ${job.kind === 'RECALC' ? 'recalculated' : 'applied'}`;
}

/** Plain words of finished results, for the live region (B-M6). */
export function resultsSummary(results: ApplyMonthResult[], label: (m: string) => string, verb = 'applied'): string {
  return results.map((r) => `${label(r.month)}: ${r.ok ? verb : `not ${verb} — ${(r.error ?? 'no reason was given').replace(/\.+$/, '')}`}`).join('. ');
}

// ── B-L8: an UNKNOWN outcome survives a reload (sessionStorage; never trusted for anything but holding the button) ──

export interface UnknownLock { requestId: string; reason: string; months: string[] }

export function saveUnknown(key: string, lock: UnknownLock): void {
  try { window.sessionStorage.setItem(key, JSON.stringify(lock)); } catch { /* storage unavailable: the lock lasts this page only */ }
}
export function loadUnknown(key: string): UnknownLock | null {
  try {
    const v = JSON.parse(window.sessionStorage.getItem(key) ?? 'null') as UnknownLock | null;
    return v && typeof v.requestId === 'string' && typeof v.reason === 'string' && Array.isArray(v.months) ? v : null;
  } catch {
    return null;
  }
}
export function clearUnknown(key: string): void {
  try { window.sessionStorage.removeItem(key); } catch { /* nothing to clear */ }
}
