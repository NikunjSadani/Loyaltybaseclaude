/**
 * Run state of the Daily Operations Digest — what makes the window "since the last SUCCESSFUL send"
 * and makes the trigger idempotent. Stored WITHOUT a migration in one platform `program_settings` row
 * (clientId 'gifsy', settingKey DIGEST_RUN_STATE_KEY — the same operator row family as the recipient
 * list). The existing `ScheduledReport` model was not used: it is a per-tenant, per-user scheduled
 * export (required clientId + createdByUserId FK), not a platform run log.
 *
 * Value:
 *   lastSuccess  { windowStartMs, windowEndMs, sentAt, recipients, forced }  — the last email that went out
 *                with COMPLETE data (status 'sent'); the next window starts at its windowEndMs.
 *   lastAttempt  { at, status, windowStartMs, windowEndMs, recipients?, error? }  — every run, any outcome.
 *   running      { startedAt, token }  — a lease while a run is in flight (concurrent triggers lose).
 *
 * Window plan (`planDigestWindow`, PURE):
 *   - no lastSuccess (first run)             → the fixed rule (`digestWindow`: previous working day).
 *   - lastSuccess sent TODAY (IST), no force  → SKIP 'already-sent' (idempotent re-trigger / retry).
 *   - lastSuccess sent today, force=true      → re-cover TODAY's window: from that send's windowStartMs to now.
 *   - otherwise                               → from lastSuccess.windowEndMs to now, capped at MAX_WINDOW_MS
 *                                               (7 days); a capped window is a loud run notice naming the gap.
 */

import { formatDateIST } from '../../common/ist-date';
import { digestWindow, windowBetween } from './daily-ops-digest-report';
import type { DigestWindow } from './report.types';

export const DIGEST_RUN_STATE_KEY = 'dailyDigestRunState';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const IST_OFFSET_MS = 330 * 60 * 1000;
/** The longest window one digest covers. Older activity is named as not covered. */
export const MAX_WINDOW_MS = 7 * DAY_MS;
/** A run lease older than this is treated as dead (the scheduler attempt deadline is 600 s). */
export const RUN_LEASE_MS = 15 * 60 * 1000;

export interface DigestRunRecord {
  windowStartMs: number;
  windowEndMs: number;
  sentAt: string;
  recipients: number;
  forced?: boolean;
}

export type DigestRunStatus = 'sent' | 'degraded' | 'no-recipients' | 'error' | 'skipped' | 'in-progress';

export interface DigestRunState {
  lastSuccess?: DigestRunRecord;
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

/** Tolerant parse of the stored JSON (anything malformed is simply absent). */
export function parseRunState(raw: unknown): DigestRunState {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: DigestRunState = {};
  const ls = o.lastSuccess as Record<string, unknown> | undefined;
  if (ls && isNum(ls.windowStartMs) && isNum(ls.windowEndMs) && typeof ls.sentAt === 'string') {
    out.lastSuccess = {
      windowStartMs: ls.windowStartMs,
      windowEndMs: ls.windowEndMs,
      sentAt: ls.sentAt,
      recipients: isNum(ls.recipients) ? ls.recipients : 0,
      ...(ls.forced === true ? { forced: true } : {}),
    };
  }
  if (o.lastAttempt && typeof o.lastAttempt === 'object') out.lastAttempt = o.lastAttempt as DigestRunState['lastAttempt'];
  const r = o.running as Record<string, unknown> | null | undefined;
  if (r && typeof r.startedAt === 'string' && typeof r.token === 'string') out.running = { startedAt: r.startedAt, token: r.token };
  return out;
}

const istDay = (ms: number) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const istHm = (ms: number) => new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16);

export interface WindowPlan {
  window: DigestWindow;
  /** 'already-sent' → do nothing (return 200 skipped). */
  skip?: 'already-sent';
  /** Informational notes shown under the window (not attention). */
  notes: string[];
  /** Loud run notices (attention + "incomplete" box): the window was capped, data not covered. */
  notices: string[];
  forced: boolean;
}

/** Decide the window for a run at `nowMs` (PURE — see the module comment). */
export function planDigestWindow(nowMs: number, state: DigestRunState, force = false): WindowPlan {
  const last = state.lastSuccess;
  if (!last) {
    return {
      window: digestWindow(nowMs),
      notes: ['(first tracked run — the window is the fixed "since the previous working day" rule).'],
      notices: [],
      forced: force,
    };
  }
  const sentMs = new Date(last.sentAt).getTime();
  const sentToday = Number.isFinite(sentMs) && istDay(sentMs) === istDay(nowMs);
  if ((sentToday || last.windowEndMs >= nowMs) && !force) {
    return { window: windowBetween(last.windowStartMs, last.windowEndMs), skip: 'already-sent', notes: [], notices: [], forced: false };
  }
  if (sentToday && force) {
    const start = Math.max(Math.min(last.windowStartMs, nowMs - 1), nowMs - MAX_WINDOW_MS);
    return {
      window: windowBetween(start, nowMs),
      notes: [`(manual re-run — today's digest already went out at ${istHm(sentMs)} IST; this one re-covers its window up to now).`],
      notices: [],
      forced: true,
    };
  }
  let start = Math.min(last.windowEndMs, nowMs - 1);
  const notices: string[] = [];
  if (nowMs - start > MAX_WINDOW_MS) {
    const capped = nowMs - MAX_WINDOW_MS;
    notices.push(
      `The last successful digest was sent ${formatDateIST(new Date(sentMs))}; this one covers only the last 7 days — activity from ${formatDateIST(
        new Date(start),
      )} ${istHm(start)} to ${formatDateIST(new Date(capped))} ${istHm(capped)} IST is NOT in any digest.`,
    );
    start = capped;
  }
  return { window: windowBetween(start, nowMs), notes: [], notices, forced: force };
}
