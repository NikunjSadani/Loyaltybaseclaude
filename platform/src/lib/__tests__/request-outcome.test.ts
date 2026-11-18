/// <reference types="vitest/globals" />
/**
 * request-outcome — telling "the server said no" apart from "no answer arrived" (proxy timeout, gateway error,
 * network drop), where the action may have happened anyway.
 * Run: npx vitest run src/lib/__tests__/request-outcome.test.ts
 */
import { describe, it, expect } from 'vitest';
import { NO_REPLY, outcomeUnknown, reasonOr } from '@/lib/request-outcome';

describe('outcomeUnknown', () => {
  it('no status (network error / fetch threw) → unknown', () => {
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

describe('reasonOr', () => {
  it('trims and drops trailing full stops', () => {
    expect(reasonOr('  October is closed.. ', 'fallback')).toBe('October is closed');
  });
  it('an empty / blank / missing error uses the fallback — never an empty reason', () => {
    expect(reasonOr('', 'fallback')).toBe('fallback');
    expect(reasonOr('   ', 'fallback')).toBe('fallback');
    expect(reasonOr(undefined, 'fallback')).toBe('fallback');
    expect(reasonOr(null, 'fallback')).toBe('fallback');
  });
  it('NO_REPLY is a plain-words reason', () => {
    expect(NO_REPLY).toMatch(/didn.t reply/);
  });
});
