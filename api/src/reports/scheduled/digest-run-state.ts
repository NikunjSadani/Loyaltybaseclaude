/**
 * Run state of the Daily Operations Digest — what makes the window "since the last COMPLETE send",
 * makes the trigger idempotent per IST day, and keeps concurrent / timed-out runs from clobbering
 * each other. Stored WITHOUT a migration in one platform `program_settings` row (clientId 'gifsy',
 * settingKey DIGEST_RUN_STATE_KEY). The existing `ScheduledReport` model was not used: it is a
 * per-tenant, per-user scheduled export (required clientId + createdByUserId FK), not a platform run log.
 *
 * Value:
 *   lastSuccess    the last email that went out with COMPLETE data (status 'sent'). The next window
 *                  starts at its windowEndMs — so data an incomplete email missed is re-covered.
 *   lastAttempted  the last email that went out at all (sent OR degraded) — drives the same-day guard
 *                  and the "this email repeats …" notice.
 *   failStreaks    section key → consecutive emailed runs it failed in (reset when it loads).
 *   lastAttempt    every run, any outcome (incl. nothing sent).
 *   running        { startedAt, token } — the lease while a run is in flight.
 *
 * Every write is a compare-and-set on the row's updatedAt after a fresh read (`mutateRunState` in the
 * service), and the finishing write requires the run's own lease token — a runner whose lease expired
 * and was taken over can never overwrite the newer run's state or clear its lease.
 */

import { formatDateIST } from '../../common/ist-date';
import { digestWindow, windowBetween } from './daily-ops-digest-report';
import type { DigestWindow } from './report.types';

export const DIGEST_RUN_STATE_KEY = 'dailyDigestRunState';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const IST_OFFSET_MS = 330 * MINUTE_MS;
/** The longest window one digest covers. */
export const MAX_WINDOW_MS = 7 * DAY_MS;
/**
 * The run's own time budget. Cloud Run's request timeout is 300 s on gifsy-api and gifsy-api-staging; the
 * runner stops STARTING sections after this and sends within the request.
 */
export const RUN_BUDGET_MS = 240 * 1000;
/** Lease TTL: just over the budget. A lease older than this is dead. */
export const RUN_LEASE_MS = 6 * MINUTE_MS;
/** A section failing this many emailed runs in a row puts "INCOMPLETE N days" in the subject. */
export const PERSISTENT_FAILURE_RUNS = 3;

export interface EmailedRun {
  windowStartMs: number;
  windowEndMs: number;
  sentAt: string;
  recipients: number;
  status: 'sent' | 'degraded';
  /** Human labels of what failed (degraded only). */
  failedSections?: string[];
  forced?: boolean;
}

export type DigestRunStatus = 'sent' | 'degraded' | 'no-recipients' | 'error' | 'skipped' | 'in-progress';

export interface DigestRunState {
  lastSuccess?: EmailedRun;
  lastAttempted?: EmailedRun;
  failStreaks?: Record<string, number>;
  lastAttempt?: {
    at: string;
    status: DigestRunStatus;
    windowStartMs?: number;
    windowEndMs?: number;
    recipients?: number;
    error?: string;
  };
  running?: { startedAt: string; token: string } | null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseEmailed(raw: unknown, fallbackStatus: 'sent' | 'degraded'): EmailedRun | undefined {
  const r = raw as Record<string, unknown> | undefined;
  if (!r || !isNum(r.windowStartMs) || !isNum(r.windowEndMs) || typeof r.sentAt !== 'string') return undefined;
  return {
    windowStartMs: r.windowStartMs,
    windowEndMs: r.windowEndMs,
    sentAt: r.sentAt,
    recipients: isNum(r.recipients) ? r.recipients : 0,
    status: r.status === 'degraded' || r.status === 'sent' ? r.status : fallbackStatus,
    ...(Array.isArray(r.failedSections) ? { failedSections: r.failedSections.filter((x): x is string => typeof x === 'string') } : {}),
    ...(r.forced === true ? { forced: true } : {}),
  };
}

/** Tolerant parse of the stored JSON (anything malformed is simply absent). */
export function parseRunState(raw: unknown): DigestRunState {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: DigestRunState = {};
  const ls = parseEmailed(o.lastSuccess, 'sent');
  if (ls) out.lastSuccess = { ...ls, status: 'sent' };
  const la = parseEmailed(o.lastAttempted, 'degraded');
  if (la) out.lastAttempted = la;
  if (o.failStreaks && typeof o.failStreaks === 'object' && !Array.isArray(o.failStreaks)) {
    const fs: Record<string, number> = {};
    for (const [k, v] of Object.entries(o.failStreaks as Record<string, unknown>)) if (isNum(v) && v > 0) fs[k] = v;
    out.failStreaks = fs;
  }
  if (o.lastAttempt && typeof o.lastAttempt === 'object') out.lastAttempt = o.lastAttempt as DigestRunState['lastAttempt'];
  const r = o.running as Record<string, unknown> | null | undefined;
  if (r && typeof r.startedAt === 'string' && typeof r.token === 'string') out.running = { startedAt: r.startedAt, token: r.token };
  return out;
}

const istDay = (ms: number) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const istHm = (ms: number) => new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16);
const stamp = (ms: number) => `${formatDateIST(new Date(ms))} ${istHm(ms)}`;

/** Is the run lease live? A forced run may break a lease older than the run budget. */
export function leaseIsLive(state: DigestRunState, nowMs: number, force = false): boolean {
  if (!state.running) return false;
  const age = nowMs - new Date(state.running.startedAt).getTime();
  if (!Number.isFinite(age)) return false;
  return age < (force ? RUN_BUDGET_MS : RUN_LEASE_MS);
}

export interface WindowPlan {
  window: DigestWindow;
  /** 'already-sent' → do nothing (return 200 skipped). */
  skip?: 'already-sent';
  /** Informational notes shown with the window line (not attention). */
  notes: string[];
  /** "This email repeats …" — shown plainly at the top (not attention: it is not a new problem). */
  repeatNotice?: string;
  /** Loud run notices (red box + attention): spans outside the 7-day cap. */
  notices: string[];
  forced: boolean;
}

/**
 * Decide the window for a run at `nowMs` (PURE).
 *   - nothing ever emailed            → the fixed rule (`digestWindow`).
 *   - an email already went out TODAY (IST; complete or not) and no force → SKIP 'already-sent'.
 *   - otherwise the window starts at lastSuccess.windowEndMs (force on a day whose complete send already
 *     went out → re-cover that send's window); with no complete send ever → the first emailed window's start.
 *   - when the last EMAILED run was incomplete and overlaps the new window → `repeatNotice`.
 *   - capped at MAX_WINDOW_MS: the dropped span is split into "only in incomplete digests" (emailed) and
 *     "NOT in any digest" (never emailed at all) — each named only when non-empty.
 */
export function planDigestWindow(nowMs: number, state: DigestRunState, force = false): WindowPlan {
  const ok = state.lastSuccess;
  const att = state.lastAttempted;
  const emailed = [ok, att].filter((x): x is EmailedRun => !!x);
  if (emailed.length === 0) {
    return {
      window: digestWindow(nowMs),
      notes: ['(first tracked run — the window is the fixed "since the previous working day" rule).'],
      notices: [],
      forced: force,
    };
  }
  const latestEmail = emailed.reduce((a, b) => (new Date(b.sentAt).getTime() > new Date(a.sentAt).getTime() ? b : a));
  const latestSentMs = new Date(latestEmail.sentAt).getTime();
  const emailedThroughMs = Math.max(...emailed.map((e) => e.windowEndMs));
  const sentToday = (Number.isFinite(latestSentMs) && istDay(latestSentMs) === istDay(nowMs)) || emailedThroughMs >= nowMs;
  if (sentToday && !force) {
    return {
      window: windowBetween(latestEmail.windowStartMs, latestEmail.windowEndMs),
      skip: 'already-sent',
      notes: [],
      notices: [],
      forced: false,
    };
  }

  const notes: string[] = [];
  let start: number;
  if (ok) {
    const okSentMs = new Date(ok.sentAt).getTime();
    const okToday = Number.isFinite(okSentMs) && istDay(okSentMs) === istDay(nowMs);
    start = force && okToday ? ok.windowStartMs : ok.windowEndMs;
  } else {
    start = Math.min(...emailed.map((e) => e.windowStartMs));
  }
  start = Math.min(start, nowMs - 1);
  if (force && sentToday) {
    notes.push(`(manual re-run — today's digest already went out at ${istHm(latestSentMs)} IST; this one re-covers its window up to now).`);
  }

  const notices: string[] = [];
  if (nowMs - start > MAX_WINDOW_MS) {
    const capped = nowMs - MAX_WINDOW_MS;
    const onlyIncompleteTo = Math.min(capped, emailedThroughMs);
    if (start < onlyIncompleteTo) {
      notices.push(
        `Activity from ${stamp(start)} to ${stamp(onlyIncompleteTo)} IST appeared only in INCOMPLETE digests and is outside this 7-day window — it was never reported complete.`,
      );
    }
    const neverFrom = Math.max(start, emailedThroughMs);
    if (neverFrom < capped) {
      notices.push(`Activity from ${stamp(neverFrom)} to ${stamp(capped)} IST is NOT in any digest (outside the 7-day window).`);
    }
    start = capped;
  }

  let repeatNotice: string | undefined;
  if (att && att.status === 'degraded' && att.windowEndMs > start) {
    const to = Math.min(att.windowEndMs, nowMs);
    const what = att.failedSections && att.failedSections.length > 0 ? ` (${att.failedSections.join('; ')})` : '';
    repeatNotice = `This email repeats ${windowBetween(start, to).label} because the ${formatDateIST(
      new Date(att.sentAt),
    )} digest was incomplete${what}. Don't add these figures to that day's.`;
  }

  return { window: windowBetween(start, nowMs), notes, notices, repeatNotice, forced: force };
}

/** The fail streaks after an emailed run that failed `failedKeys` (others reset). */
export function nextFailStreaks(prev: Record<string, number> | undefined, failedKeys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set(failedKeys)) out[k] = (prev?.[k] ?? 0) + 1;
  return out;
}
