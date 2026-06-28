/**
 * Operator assume-tenant banner (AF-6 model).
 *
 * The access token is now an httpOnly cookie — NOT readable by JS — so the old
 * "decode the active token's `assumed` claim to self-heal a stale banner" trick is
 * gone. Staleness is instead prevented at the source: the token swap is atomic and
 * server-side (assumeTenantAction/exitTenantAction set/clear the `assumedBrand`
 * companion), a fresh login calls clearAssumedContext(), and if an assumed token
 * expires the next /api 401 bounces to login (which clears it). getAssumedBrand()
 * therefore just reflects the non-sensitive `assumedBrand` display key.
 *
 * Run: npx vitest run src/lib/__tests__/operator-context.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getAssumedBrand, clearAssumedContext } from '@/lib/auth-client';

describe('operator assumed-tenant banner (AF-6 cookie model)', () => {
  beforeEach(() => localStorage.clear());

  it('returns the brand when assumedBrand is set (operator is in a tenant context)', () => {
    localStorage.setItem('assumedBrand', 'Deoleo (Demo)');
    expect(getAssumedBrand()).toBe('Deoleo (Demo)');
  });

  it('returns null when no brand is set (platform level — no banner)', () => {
    expect(getAssumedBrand()).toBeNull();
  });

  it('clearAssumedContext removes the brand key (called on a fresh login)', () => {
    localStorage.setItem('assumedBrand', 'B');
    clearAssumedContext();
    expect(localStorage.getItem('assumedBrand')).toBeNull();
  });
});
