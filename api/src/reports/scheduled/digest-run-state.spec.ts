import { MAX_WINDOW_MS, parseRunState, planDigestWindow } from './digest-run-state';
import { digestWindow } from './daily-ops-digest-report';

const IST = 330 * 60 * 1000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
/** Relative to real "now" (never a hardcoded future date): the next Tuesday 09:30 IST from today. */
function tuesday0930(): number {
  const d = new Date(Date.now() + IST);
  d.setUTCHours(9, 30, 0, 0);
  const add = (2 - d.getUTCDay() + 7) % 7 || 7;
  return d.getTime() + add * DAY - IST;
}
const NOW = tuesday0930();
const success = (endMs: number, sentMs = endMs, startMs = endMs - DAY) => ({
  lastSuccess: { windowStartMs: startMs, windowEndMs: endMs, sentAt: new Date(sentMs).toISOString(), recipients: 2 },
});

describe('planDigestWindow', () => {
  it('first run → the fixed "previous working day" rule, with an informational note', () => {
    const p = planDigestWindow(NOW, {});
    expect(p.window).toEqual(digestWindow(NOW));
    expect(p.skip).toBeUndefined();
    expect(p.notices).toEqual([]);
    expect(p.notes[0]).toContain('first tracked run');
  });

  it('starts at the last successful window end (a missed day is covered, Monday covers Sat→Mon naturally)', () => {
    const lastEnd = NOW - 3 * DAY;
    const p = planDigestWindow(NOW, success(lastEnd));
    expect(p.window.startMs).toBe(lastEnd);
    expect(p.window.endMs).toBe(NOW);
    expect(p.notices).toEqual([]);
  });

  it('already sent today (IST) → skip; force → re-cover today\'s window to now', () => {
    const sent = NOW - 2 * HOUR;
    expect(planDigestWindow(NOW, success(sent)).skip).toBe('already-sent');
    const f = planDigestWindow(NOW, success(sent, sent, sent - DAY), true);
    expect(f.skip).toBeUndefined();
    expect(f.window.startMs).toBe(sent - DAY);
    expect(f.forced).toBe(true);
    expect(f.notes[0]).toContain('manual re-run');
  });

  it('a send at 23:00 IST yesterday is NOT "today" (IST day, not UTC day)', () => {
    const sent = NOW - (10 * HOUR + 30 * 60_000); // 23:00 IST the previous day
    expect(planDigestWindow(NOW, success(sent)).skip).toBeUndefined();
  });

  it('caps at 7 days and names the uncovered gap loudly', () => {
    const lastEnd = NOW - 12 * DAY;
    const p = planDigestWindow(NOW, success(lastEnd));
    expect(p.window.startMs).toBe(NOW - MAX_WINDOW_MS);
    expect(p.notices).toHaveLength(1);
    expect(p.notices[0]).toContain('is NOT in any digest');
  });
});

describe('parseRunState', () => {
  it('tolerates junk and keeps only well-formed parts', () => {
    expect(parseRunState(null)).toEqual({});
    expect(parseRunState({ lastSuccess: { windowEndMs: 'x' } })).toEqual({});
    expect(parseRunState({ running: { startedAt: 'a', token: 't' } })).toEqual({ running: { startedAt: 'a', token: 't' } });
  });
});
