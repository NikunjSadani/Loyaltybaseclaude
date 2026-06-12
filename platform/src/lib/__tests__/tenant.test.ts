/**
 * TDD tests for the per-request tenant helper.
 * Run: npx vitest run src/lib/__tests__/tenant.test.ts
 */

import { describe, it, expect } from 'vitest';
import { getClientIdFromRequest, DEFAULT_CLIENT_ID } from '../tenant';

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeReq(slug: string | null) {
  return {
    headers: {
      get: (key: string) =>
        key === 'x-tenant-slug' ? slug : null,
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getClientIdFromRequest', () => {
  it('returns the x-tenant-slug header when present', () => {
    expect(getClientIdFromRequest(makeReq('deoleo'))).toBe('deoleo');
  });

  it('returns a different client slug correctly', () => {
    expect(getClientIdFromRequest(makeReq('clientb'))).toBe('clientb');
  });

  it('defaults to DEFAULT_CLIENT_ID when header is null', () => {
    expect(getClientIdFromRequest(makeReq(null))).toBe(DEFAULT_CLIENT_ID);
  });

  it('defaults to DEFAULT_CLIENT_ID when header is empty string', () => {
    expect(getClientIdFromRequest(makeReq(''))).toBe(DEFAULT_CLIENT_ID);
  });

  it('lowercases the header value', () => {
    expect(getClientIdFromRequest(makeReq('DEOLEO'))).toBe('deoleo');
  });

  it('trims whitespace from the header value', () => {
    expect(getClientIdFromRequest(makeReq('  clientb  '))).toBe('clientb');
  });

  it('DEFAULT_CLIENT_ID is "deoleo"', () => {
    expect(DEFAULT_CLIENT_ID).toBe('deoleo');
  });
});

describe('getClientIdFromRequest — header absence', () => {
  it('handles a request with no headers at all gracefully', () => {
    const req = { headers: { get: () => null } };
    expect(getClientIdFromRequest(req)).toBe(DEFAULT_CLIENT_ID);
  });
});
