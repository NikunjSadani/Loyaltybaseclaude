/// <reference types="vitest/globals" />
/**
 * request-outcome — telling "the server said no" apart from "no clear answer arrived" (proxy timeout, gateway error,
 * network drop, cut-off reply), where the action may have happened anyway.
 * Run: npx vitest run src/lib/__tests__/request-outcome.test.ts
 */
import { describe, it, expect } from 'vitest';
import { failureReason, noAnswerReason, outcomeUnknown, reasonOr } from '@/lib/request-outcome';

describe('outcomeUnknown', () => {
  it('no status (network error / fetch threw / cut-off reply) → unknown', () => {
    expect(outcomeUnknown({ success: false, error: 'Failed to fetch' })).toBe(true);
    expect(outcomeUnknown({ success: false, error: '', status: 0 })).toBe(true);
  });
  it('408 and every 5xx (500 from a cut proxy, 502, 503, 504, Cloudflare 524) → unknown', () => {
    for (const status of [408, 500, 502, 503, 504, 524]) expect(outcomeUnknown({ success: false, error: '', status })).toBe(true);
  });
  it('a definite refusal (400, 401, 403, 404, 409, 422, 429) → known', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) expect(outcomeUnknown({ success: false, error: 'x', status })).toBe(false);
  });
});

describe('noAnswerReason (M5: "didn’t reply in time" only for real timeouts)', () => {
  it('408 / 504 / 524 → didn’t reply in time', () => {
    for (const status of [408, 504, 524]) expect(noAnswerReason({ status })).toBe('the server didn’t reply in time');
  });
  it('an immediate 500 / 502 / 503 → no clear answer (with the code), never "in time"', () => {
    expect(noAnswerReason({ status: 503 })).toBe('the server didn’t give a clear answer (error 503)');
    expect(noAnswerReason({ status: 500 })).not.toMatch(/in time/);
  });
  it('offline / fetch threw → could not be reached; a cut-off reply says so', () => {
    expect(noAnswerReason({ error: 'Failed to fetch' })).toBe('the server could not be reached');
    expect(noAnswerReason({ error: 'The server’s reply was cut off, so its result is not known' })).toBe('The server’s reply was cut off, so its result is not known');
  });
});

describe('failureReason / reasonOr', () => {
  it('a definite refusal keeps the server’s words; an EMPTY one gets neutral words (never the timeout wording)', () => {
    expect(failureReason({ status: 409, error: 'October 2026 is closed.' })).toBe('October 2026 is closed');
    expect(failureReason({ status: 409, error: '' })).toBe('the server refused it without giving a reason');
    expect(failureReason({ status: 504, error: '' })).toBe('the server didn’t reply in time');
  });
  it('reasonOr trims, drops trailing full stops, and falls back on empty / blank / missing', () => {
    expect(reasonOr('  October is closed.. ', 'fallback')).toBe('October is closed');
    for (const e of ['', '   ', undefined, null]) expect(reasonOr(e, 'fallback')).toBe('fallback');
  });
});
