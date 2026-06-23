/**
 * Operator assume-tenant banner must follow the ACTIVE token, never a stale localStorage key.
 * Regression for the "banner says Deoleo but the data is gifsy's (0 rows)" desync: the operator
 * saw an empty tenant because the fetch used the gifsy token while a leftover `assumedBrand`
 * kept the "working in Deoleo" banner showing. getAssumedBrand() now self-heals.
 *
 * Run: npx vitest run src/lib/__tests__/operator-context.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getAssumedBrand, clearAssumedContext } from '@/lib/auth-client';

/** Build a minimal JWT (header.payload.sig); only the base64url payload is read. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(payload))}.sig`;
}

describe('operator assumed-tenant banner — follows the token, self-heals', () => {
  beforeEach(() => localStorage.clear());

  it('shows the brand when the active token IS an assumed-tenant token', () => {
    localStorage.setItem('assumedBrand', 'Deoleo (Demo)');
    localStorage.setItem('token', jwt({ assumed: true, clientId: 'deoleo' }));
    expect(getAssumedBrand()).toBe('Deoleo (Demo)');
  });

  it('drops a STALE brand when the active token is NOT assumed (the reported desync)', () => {
    localStorage.setItem('assumedBrand', 'Deoleo (Demo)');
    localStorage.setItem('homeToken', 'x');
    localStorage.setItem('homeUser', '{}');
    localStorage.setItem('token', jwt({ assumed: false, clientId: 'gifsy' })); // plain gifsy login
    expect(getAssumedBrand()).toBeNull();
    // self-heal cleared the whole stale operator context
    expect(localStorage.getItem('assumedBrand')).toBeNull();
    expect(localStorage.getItem('homeToken')).toBeNull();
    expect(localStorage.getItem('homeUser')).toBeNull();
  });

  it('treats a token with no `assumed` claim as not-assumed', () => {
    localStorage.setItem('assumedBrand', 'Deoleo (Demo)');
    localStorage.setItem('token', jwt({ clientId: 'gifsy' }));
    expect(getAssumedBrand()).toBeNull();
  });

  it('returns null when no brand is set (no banner)', () => {
    localStorage.setItem('token', jwt({ assumed: true }));
    expect(getAssumedBrand()).toBeNull();
  });

  it('clearAssumedContext removes the home + brand keys', () => {
    localStorage.setItem('homeToken', 'x');
    localStorage.setItem('homeUser', '{}');
    localStorage.setItem('assumedBrand', 'B');
    clearAssumedContext();
    expect(localStorage.getItem('homeToken')).toBeNull();
    expect(localStorage.getItem('homeUser')).toBeNull();
    expect(localStorage.getItem('assumedBrand')).toBeNull();
  });
});
