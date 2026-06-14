/**
 * Tests for getAuthUser — the request→identity contract.
 * Run: npx vitest run src/lib/__tests__/auth-getauthuser.test.ts
 *
 * Contract (see lib/auth.ts):
 *   1. Proxy-injected x-user-id + x-user-role win (set by the Edge proxy after
 *      JWT verification, and in DEMO_MODE). Only the proxy can set these.
 *   2. Otherwise fall back to a verified `Authorization: Bearer <jwt>`.
 *   3. Neither → null.
 * Note: clientId is NOT carried in the token — tenant scoping is separate
 * (getClientIdFromRequest / x-tenant-slug).
 */

import { describe, it, expect } from 'vitest';
import { getAuthUser, generateToken } from '../auth';

/** Build a minimal request whose headers.get reads from a plain map (case-sensitive keys as the code uses them). */
function makeReq(headers: Record<string, string>) {
  return {
    headers: {
      get: (key: string) => headers[key] ?? null,
    },
  };
}

describe('getAuthUser', () => {
  it('uses proxy headers x-user-id / x-user-role when present', () => {
    const user = getAuthUser(makeReq({ 'x-user-id': 'u1', 'x-user-role': 'GIFSY_ADMIN' }));
    expect(user).toMatchObject({ userId: 'u1', role: 'GIFSY_ADMIN' });
  });

  it('falls back to a valid Bearer token when no proxy headers', () => {
    const token = generateToken('u2', 'PARTNER', 'p2');
    const user = getAuthUser(makeReq({ Authorization: `Bearer ${token}` }));
    expect(user).toMatchObject({ userId: 'u2', role: 'PARTNER', partnerId: 'p2' });
  });

  it('accepts a lowercase "authorization" header too', () => {
    const token = generateToken('u3', 'SALES_EXECUTIVE');
    const user = getAuthUser(makeReq({ authorization: `Bearer ${token}` }));
    expect(user).toMatchObject({ userId: 'u3', role: 'SALES_EXECUTIVE' });
  });

  it('proxy headers take priority over a (different) Bearer token', () => {
    const token = generateToken('bearer-user', 'PARTNER');
    const user = getAuthUser(
      makeReq({ 'x-user-id': 'proxy-user', 'x-user-role': 'GIFSY_ADMIN', Authorization: `Bearer ${token}` }),
    );
    expect(user).toMatchObject({ userId: 'proxy-user', role: 'GIFSY_ADMIN' });
  });

  it('returns null for an invalid/garbage Bearer token', () => {
    expect(getAuthUser(makeReq({ Authorization: 'Bearer not-a-real-jwt' }))).toBeNull();
  });

  it('returns null when neither proxy headers nor Bearer are present', () => {
    expect(getAuthUser(makeReq({}))).toBeNull();
  });

  it('returns null when only one of the two proxy headers is present', () => {
    expect(getAuthUser(makeReq({ 'x-user-id': 'u9' }))).toBeNull();
  });
});
