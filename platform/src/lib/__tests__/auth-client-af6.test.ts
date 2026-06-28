/**
 * AF-6 client auth contract: the access token is an httpOnly cookie and is NEVER
 * readable from JS. getToken() always returns null; presence is derived from the
 * non-sensitive stored `user`. Locks the regression that re-introducing a
 * localStorage token would cause.
 *
 * Run: npx vitest run src/lib/__tests__/auth-client-af6.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getToken, isAuthenticated, getStoredUser } from '@/lib/auth-client';

describe('AF-6 — no JS-readable token', () => {
  beforeEach(() => localStorage.clear());

  it('getToken() returns null even if a stale token sits in localStorage', () => {
    localStorage.setItem('token', 'should-never-be-read');
    expect(getToken()).toBeNull();
  });

  it('isAuthenticated() is driven by the stored user, not a token', () => {
    expect(isAuthenticated()).toBe(false);
    // A leftover token alone does NOT count as authenticated.
    localStorage.setItem('token', 'x');
    expect(isAuthenticated()).toBe(false);
    // The non-sensitive user object is the client-side presence signal.
    localStorage.setItem('user', JSON.stringify({ id: '1', name: 'A', role: 'CLIENT_ADMIN', phone: '9' }));
    expect(isAuthenticated()).toBe(true);
  });

  it('getStoredUser() parses the user object and tolerates corruption', () => {
    expect(getStoredUser()).toBeNull();
    localStorage.setItem('user', 'not-json');
    expect(getStoredUser()).toBeNull();
    localStorage.setItem('user', JSON.stringify({ id: '1', name: 'A', role: 'SALES_ISR', phone: '9' }));
    expect(getStoredUser()?.role).toBe('SALES_ISR');
  });
});
