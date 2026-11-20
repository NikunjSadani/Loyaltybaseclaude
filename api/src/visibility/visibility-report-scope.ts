/**
 * Scope rules for the Visibility Excel report (export kind `visibility-captures`) — pure, shared by the endpoint
 * (400 before any file) and the export run (worker re-check).
 */
import { IST_OFFSET_MIN, istMonthKey } from '../common/ist-date';
import { windowBoundsForKey } from './visibility-window.helper';

const WINDOW_RE = /^(\d{4})-(\d{2})-P([1-9]\d*)$/;

/** The period number of a `YYYY-MM-Pn` key (NaN when malformed). */
export function windowPeriod(windowKey: string): number {
  const m = WINDOW_RE.exec(windowKey);
  return m ? Number(m[3]) : NaN;
}

/**
 * The frequency to read a window's day bounds with: the tenant's frequency when the window exists under it, else the
 * smallest frequency that has that period (a window captured under an older, higher frequency still has real bounds).
 */
function boundsFreq(windowKey: string, freq: number): number {
  const p = windowPeriod(windowKey);
  if (!Number.isFinite(p)) return freq;
  return p <= freq ? freq : Math.min(Math.max(p, 1), 4);
}

/** The window's [start, end) as UTC instants of its IST calendar days. */
export function windowRangeUtc(windowKey: string, freq: number): { start: Date; end: Date } {
  const m = WINDOW_RE.exec(windowKey);
  if (!m) throw new Error(`Invalid window key "${windowKey}"`);
  const { startDay, endDay } = windowBoundsForKey(windowKey, boundsFreq(windowKey, freq));
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const off = IST_OFFSET_MIN * 60_000;
  return { start: new Date(Date.UTC(y, mo, startDay) - off), end: new Date(Date.UTC(y, mo, endDay + 1) - off) };
}

/** Open / not started / closed relative to `now` (IST calendar days). */
export function windowPhase(windowKey: string, freq: number, now: Date): 'not-started' | 'open' | 'closed' {
  const { start, end } = windowRangeUtc(windowKey, freq);
  if (now.getTime() < start.getTime()) return 'not-started';
  if (now.getTime() >= end.getTime()) return 'closed';
  return 'open';
}

/**
 * Why a report scope is refused (→ 400), or null. `windowHasCaptures` = the tenant has captures for that window key
 * (a window from an older frequency is still a real window).
 */
export function visibilityReportScopeError(
  params: { month?: string; windowKey?: string },
  freq: number,
  now: Date,
  windowHasCaptures: boolean,
): string | null {
  const current = istMonthKey(now);
  const month = params.windowKey ? params.windowKey.slice(0, 7) : params.month;
  if (month && month > current) return 'The report cannot be prepared for a future month.';
  if (params.windowKey) {
    const p = windowPeriod(params.windowKey);
    if (!(p >= 1 && p <= freq) && !windowHasCaptures) {
      return `This programme captures visibility ${freq === 1 ? 'once' : `${freq} times`} a month, so there is no window P${p}.`;
    }
  }
  return null;
}
