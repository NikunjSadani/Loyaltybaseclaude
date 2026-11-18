import {
  leaseIsLive,
  MAX_WINDOW_MS,
  nextFailStreaks,
  parseRunState,
  planDigestWindow,
  RUN_BUDGET_MS,
  RUN_LEASE_MS,
  type DigestRunState,
  type EmailedRun,
} from './digest-run-state';
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
const run = (endMs: number, status: 'sent' | 'degraded' = 'sent', startMs = endMs - DAY, failed?: string[]): EmailedRun => ({
  windowStartMs: startMs,
  windowEndMs: endMs,
  sentAt: new Date(endMs).toISOString(),
  recipients: 2,
  status,
  ...(failed ? { failedSections: failed } : {}),
});
const ok = (r: EmailedRun): DigestRunState => ({ lastSuccess: r, lastAttempted: r });

describe('planDigestWindow', () => {
  it('first run → the fixed "previous working day" rule, with an informational note', () => {
    const p = planDigestWindow(NOW, {});
    expect(p.window).toEqual(digestWindow(NOW));
    expect(p.skip).toBeUndefined();
    expect(p.notices).toEqual([]);
    expect(p.notes[0]).toContain('first tracked run');
  });

  it('starts at the last COMPLETE window end (a missed day is covered)', () => {
    const lastEnd = NOW - 3 * DAY;
    const p = planDigestWindow(NOW, ok(run(lastEnd)));
    expect(p.window.startMs).toBe(lastEnd);
    expect(p.notices).toEqual([]);
    expect(p.repeatNotice).toBeUndefined();
  });

  it('D2a: after a DEGRADED email the window re-covers from the last complete send and says it repeats', () => {
    const good = run(NOW - 2 * DAY);
    const bad = run(NOW - DAY, 'degraded', NOW - 2 * DAY, ['Bajaj: Points']);
    const p = planDigestWindow(NOW, { lastSuccess: good, lastAttempted: bad });
    expect(p.window.startMs).toBe(good.windowEndMs);
    expect(p.repeatNotice).toMatch(/^This email repeats .+ because the .+ digest was incomplete \(Bajaj: Points\)\. Don't add these figures to that day's\.$/);
    expect(p.notices).toEqual([]);
  });

  it('D2a: never a complete send → re-cover from the first emailed (incomplete) window', () => {
    const bad = run(NOW - DAY, 'degraded', NOW - 2 * DAY, ['tenant list']);
    const p = planDigestWindow(NOW, { lastAttempted: bad });
    expect(p.window.startMs).toBe(bad.windowStartMs);
    expect(p.repeatNotice).toContain('(tenant list)');
  });

  it('D2b: an email already went out today (even a degraded one) → skip; force re-runs', () => {
    const sent = NOW - 2 * HOUR;
    const good = run(NOW - DAY);
    const badToday = run(sent, 'degraded', good.windowEndMs, ['x']);
    expect(planDigestWindow(NOW, { lastSuccess: good, lastAttempted: badToday }).skip).toBe('already-sent');
    const f = planDigestWindow(NOW, { lastSuccess: good, lastAttempted: badToday }, true);
    expect(f.skip).toBeUndefined();
    expect(f.window.startMs).toBe(good.windowEndMs);
    expect(f.notes[0]).toContain('manual re-run');
    expect(f.repeatNotice).toBeDefined();
  });

  it('force on a day whose COMPLETE send already went out re-covers that window', () => {
    const sent = NOW - 2 * HOUR;
    const p = planDigestWindow(NOW, ok(run(sent, 'sent', sent - DAY)), true);
    expect(p.window.startMs).toBe(sent - DAY);
    expect(p.forced).toBe(true);
  });

  it('a send at 23:00 IST yesterday is NOT "today" (IST day, not UTC day)', () => {
    const sent = NOW - (10 * HOUR + 30 * 60_000);
    expect(planDigestWindow(NOW, ok(run(sent))).skip).toBeUndefined();
  });

  it('cap 7 days: "NOT in any digest" only for a span never emailed at all', () => {
    const lastEnd = NOW - 12 * DAY;
    const p = planDigestWindow(NOW, ok(run(lastEnd)));
    expect(p.window.startMs).toBe(NOW - MAX_WINDOW_MS);
    expect(p.notices).toHaveLength(1);
    expect(p.notices[0]).toContain('is NOT in any digest');
  });

  it('cap 7 days after days of DEGRADED emails: the dropped span was emailed (incomplete) — no false "NOT in any digest"', () => {
    const good = run(NOW - 12 * DAY);
    const bad = run(NOW - DAY, 'degraded', good.windowEndMs, ['Bajaj: KYC']); // emailed through yesterday
    const p = planDigestWindow(NOW, { lastSuccess: good, lastAttempted: bad });
    expect(p.window.startMs).toBe(NOW - MAX_WINDOW_MS);
    expect(p.notices).toHaveLength(1);
    expect(p.notices[0]).toContain('appeared only in INCOMPLETE digests');
    expect(p.notices.join(' ')).not.toContain('NOT in any digest');
  });
});

describe('leaseIsLive (D3)', () => {
  const at = (ageMs: number): DigestRunState => ({ running: { startedAt: new Date(NOW - ageMs).toISOString(), token: 't' } });
  it('live until the 6-min TTL; a forced run may break one older than the 240 s budget', () => {
    expect(RUN_LEASE_MS).toBe(6 * 60_000);
    expect(RUN_BUDGET_MS).toBe(240_000);
    expect(leaseIsLive(at(5 * 60_000), NOW)).toBe(true);
    expect(leaseIsLive(at(7 * 60_000), NOW)).toBe(false);
    expect(leaseIsLive(at(5 * 60_000), NOW, true)).toBe(false);
    expect(leaseIsLive(at(60_000), NOW, true)).toBe(true);
    expect(leaseIsLive({}, NOW)).toBe(false);
  });
});

describe('nextFailStreaks (D2c)', () => {
  it('counts consecutive failures per key and resets keys that loaded', () => {
    let s = nextFailStreaks(undefined, ['a', 'b']);
    s = nextFailStreaks(s, ['a']);
    s = nextFailStreaks(s, ['a', 'c']);
    expect(s).toEqual({ a: 3, c: 1 });
    expect(nextFailStreaks(s, [])).toEqual({});
  });
});

describe('parseRunState', () => {
  it('tolerates junk and keeps only well-formed parts', () => {
    expect(parseRunState(null)).toEqual({});
    expect(parseRunState({ lastSuccess: { windowEndMs: 'x' } })).toEqual({});
    expect(parseRunState({ running: { startedAt: 'a', token: 't' } })).toEqual({ running: { startedAt: 'a', token: 't' } });
    expect(parseRunState({ failStreaks: { a: 2, b: 'x', c: 0 } })).toEqual({ failStreaks: { a: 2 } });
  });
});
