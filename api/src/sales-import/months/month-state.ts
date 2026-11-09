/**
 * Sales month state (plan §7.3). PURE — no DB, no clock: the caller injects the current IST month
 * (`currentMonthKey()` from targets.helpers, IST) so every rule here is table-testable.
 *
 *   month >  current → FUTURE   : resolves OPEN (nothing can close it) but is NOT appliable / closable.
 *   month == current → CURRENT  : OPEN, always (an override row is ignored). Close not allowed.
 *   month == previous→ PREVIOUS : override?.state ?? 'OPEN'
 *   month <  previous→ OLDER    : override?.state ?? 'CLOSED'
 *
 * `YYYY-MM` strings sort chronologically, so plain string comparison is the month comparison.
 */
import type { SalesMonthState } from '../sales-import.contract';

export const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export type MonthRelation = 'FUTURE' | 'CURRENT' | 'PREVIOUS' | 'OLDER';

/**
 * A SalesMonthStatus row. It is an EXPLICIT override only when it records an admin action: CLOSED with `closedAt`,
 * or OPEN with `reopenedAt`. A row created by an apply (only to hold the last-applied pointer) has neither, so it
 * never changes the implicit rule (otherwise a month applied while current would stay OPEN forever).
 */
export interface MonthOverrideLike {
  state: string; // 'OPEN' | 'CLOSED' (free String column)
  closedAt?: Date | string | null;
  reopenedAt?: Date | string | null;
}

export function explicitOverrideState(override?: MonthOverrideLike | null): SalesMonthState | null {
  if (!override) return null;
  if (override.state === 'CLOSED' && override.closedAt) return 'CLOSED';
  if (override.state === 'OPEN' && override.reopenedAt) return 'OPEN';
  return null;
}

export interface ResolvedMonthState {
  state: SalesMonthState;
  relation: MonthRelation;
  /** true when no override row decided the state. */
  implicit: boolean;
  /** Importer data may be (re)written: resolved OPEN and not a future month. */
  appliable: boolean;
  canClose: boolean;
  canReopen: boolean;
}

export function isMonthKey(v: unknown): v is string {
  return typeof v === 'string' && MONTH_KEY_RE.test(v);
}

/** The month before `month` ('2026-01' → '2025-12'). */
export function previousMonthKey(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `n` months back from `month` (n=0 → month). */
export function shiftMonthKey(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Last calendar day of a month as 'YYYY-MM-DD'. */
export function lastDayOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return `${month}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Human label for messages: '2026-05' → 'May 2026'. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[m - 1] ?? month} ${y}`;
}

export function resolveMonthState(
  month: string,
  current: string,
  override?: MonthOverrideLike | null,
): ResolvedMonthState {
  const prev = previousMonthKey(current);
  const relation: MonthRelation =
    month > current ? 'FUTURE' : month === current ? 'CURRENT' : month === prev ? 'PREVIOUS' : 'OLDER';

  const ov = explicitOverrideState(override);

  let state: SalesMonthState;
  let implicit: boolean;
  if (relation === 'FUTURE' || relation === 'CURRENT') {
    state = 'OPEN';
    implicit = relation === 'FUTURE' || ov === null; // a stray override on the current month is ignored
  } else if (relation === 'PREVIOUS') {
    state = ov ?? 'OPEN';
    implicit = ov === null;
  } else {
    state = ov ?? 'CLOSED';
    implicit = ov === null;
  }

  const pastMonth = relation === 'PREVIOUS' || relation === 'OLDER';
  return {
    state,
    relation,
    implicit,
    appliable: state === 'OPEN' && relation !== 'FUTURE',
    canClose: pastMonth && state === 'OPEN',
    canReopen: pastMonth && state === 'CLOSED',
  };
}
