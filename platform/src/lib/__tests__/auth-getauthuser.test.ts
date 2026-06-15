/**
 * Tests for getAuthUser — the request→identity contract (S4: async session-validated).
 * Run: npx vitest run src/lib/__tests__/auth-getauthuser.test.ts
 *
 * New contract (see lib/auth.ts):
 *   1. DEMO_MODE=true: x-user-id + x-user-role headers → demo identity returned immediately;
 *      validateSession is NOT called (demo has no session).
 *   2. Real path (DEMO_MODE off):
 *      a. Token from Authorization: Bearer <t> OR `token` cookie (raw Cookie header).
 *      b. verifyToken → if null, or no sid → return null.
 *      c. validateSession(sid) → if null → return null.
 *      d. Return { userId, role, clientId } from session; include partnerId from JWT if present.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAuthUser, generateToken, generateAccessToken } from '../auth';

// ── Mock '@/lib/session' so no DB is touched ────────────────────────────────

vi.mock('@/lib/session', () => ({
  validateSession: vi.fn(),
}));

import { validateSession } from '@/lib/session';
const mockValidateSession = vi.mocked(validateSession);

/** Build a minimal request whose headers.get reads from a plain map. */
function makeReq(headers: Record<string, string>) {
  return {
    headers: {
      get: (key: string) => headers[key] ?? headers[key.toLowerCase()] ?? null,
    },
  };
}

// ── Helpers to build tokens ──────────────────────────────────────────────────

/** Build a session JWT (has sid) via generateAccessToken. */
function makeSessionToken(opts: {
  userId?: string;
  role?: string;
  clientId?: string;
  sid?: string;
  partnerId?: string;
}) {
  return generateAccessToken({
    userId:   opts.userId   ?? 'user-1',
    role:     opts.role     ?? 'CLIENT_ADMIN',
    clientId: opts.clientId ?? 'tenant-x',
    sid:      opts.sid      ?? 'sid-abc',
    partnerId: opts.partnerId,
  });
}

/** Build a legacy JWT (no sid) via generateToken. */
function makeLegacyToken(userId: string, role: string) {
  return generateToken(userId, role);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('getAuthUser — S4 async session-validated', () => {
  beforeEach(() => {
    // Reset env and mocks before each test.
    delete process.env.DEMO_MODE;
    mockValidateSession.mockReset();
  });

  afterEach(() => {
    delete process.env.DEMO_MODE;
  });

  // ── DEMO_MODE tests ─────────────────────────────────────────────────────────

  describe('DEMO_MODE=true', () => {
    beforeEach(() => {
      process.env.DEMO_MODE = 'true';
    });

    it('returns demo identity from x-user-id + x-user-role without calling validateSession', async () => {
      const result = await getAuthUser(makeReq({ 'x-user-id': 'demo-admin-id', 'x-user-role': 'GIFSY_ADMIN' }));
      expect(result).toMatchObject({ userId: 'demo-admin-id', role: 'GIFSY_ADMIN' });
      expect(mockValidateSession).not.toHaveBeenCalled();
    });

    it('uses x-tenant-slug as clientId when present', async () => {
      const result = await getAuthUser(
        makeReq({ 'x-user-id': 'demo-admin-id', 'x-user-role': 'GIFSY_ADMIN', 'x-tenant-slug': 'acme' }),
      );
      expect(result?.clientId).toBe('acme');
      expect(mockValidateSession).not.toHaveBeenCalled();
    });

    it('falls back to "deoleo" clientId when x-tenant-slug is absent', async () => {
      const result = await getAuthUser(makeReq({ 'x-user-id': 'demo-admin-id', 'x-user-role': 'GIFSY_ADMIN' }));
      expect(result?.clientId).toBe('deoleo');
    });

    it('returns null if DEMO_MODE but no injected headers', async () => {
      const result = await getAuthUser(makeReq({}));
      expect(result).toBeNull();
      expect(mockValidateSession).not.toHaveBeenCalled();
    });
  });

  // ── Real path: token reading ─────────────────────────────────────────────────

  describe('real path — token reading', () => {
    it('returns null when neither Authorization header nor cookie is present', async () => {
      const result = await getAuthUser(makeReq({}));
      expect(result).toBeNull();
      expect(mockValidateSession).not.toHaveBeenCalled();
    });

    it('reads token from Authorization: Bearer header (case-insensitive key)', async () => {
      const token = makeSessionToken({ sid: 'sid-1' });
      mockValidateSession.mockResolvedValue({ userId: 'u1', clientId: 'c1' });
      // lowercase header key
      const result = await getAuthUser(makeReq({ authorization: `Bearer ${token}` }));
      expect(result).toMatchObject({ userId: 'u1', role: 'CLIENT_ADMIN', clientId: 'c1' });
      expect(mockValidateSession).toHaveBeenCalledWith('sid-1');
    });

    it('reads token from Authorization: Bearer header (uppercase key)', async () => {
      const token = makeSessionToken({ sid: 'sid-2' });
      mockValidateSession.mockResolvedValue({ userId: 'u2', clientId: 'c2' });
      const result = await getAuthUser(makeReq({ Authorization: `Bearer ${token}` }));
      expect(result).toMatchObject({ userId: 'u2', clientId: 'c2' });
    });

    it('reads token from `token` cookie in raw Cookie header', async () => {
      const token = makeSessionToken({ sid: 'sid-cookie' });
      mockValidateSession.mockResolvedValue({ userId: 'u-cookie', clientId: 'tenant-cookie' });
      const result = await getAuthUser(makeReq({ cookie: `other=xyz; token=${token}; session=abc` }));
      expect(result).toMatchObject({ userId: 'u-cookie', clientId: 'tenant-cookie' });
      expect(mockValidateSession).toHaveBeenCalledWith('sid-cookie');
    });

    it('prefers Authorization header over cookie when both are present', async () => {
      const headerToken = makeSessionToken({ sid: 'sid-header', userId: 'from-header', clientId: 'hc' });
      const cookieToken = makeSessionToken({ sid: 'sid-cookie', userId: 'from-cookie', clientId: 'cc' });
      mockValidateSession.mockResolvedValue({ userId: 'from-header', clientId: 'hc' });
      const result = await getAuthUser(makeReq({
        authorization: `Bearer ${headerToken}`,
        cookie: `token=${cookieToken}`,
      }));
      expect(mockValidateSession).toHaveBeenCalledWith('sid-header');
      expect(result?.userId).toBe('from-header');
    });
  });

  // ── Real path: JWT validation ────────────────────────────────────────────────

  describe('real path — JWT and sid validation', () => {
    it('returns null for a garbage/invalid token', async () => {
      const result = await getAuthUser(makeReq({ authorization: 'Bearer not-a-jwt' }));
      expect(result).toBeNull();
      expect(mockValidateSession).not.toHaveBeenCalled();
    });

    it('returns null for a valid JWT without sid (legacy token)', async () => {
      const legacyToken = makeLegacyToken('u9', 'PARTNER');
      const result = await getAuthUser(makeReq({ authorization: `Bearer ${legacyToken}` }));
      expect(result).toBeNull();
      expect(mockValidateSession).not.toHaveBeenCalled();
    });
  });

  // ── Real path: session validation ────────────────────────────────────────────

  describe('real path — session validation', () => {
    it('returns null when validateSession returns null (revoked session)', async () => {
      const token = makeSessionToken({ sid: 'sid-revoked' });
      mockValidateSession.mockResolvedValue(null); // revoked / expired
      const result = await getAuthUser(makeReq({ authorization: `Bearer ${token}` }));
      expect(result).toBeNull();
      expect(mockValidateSession).toHaveBeenCalledWith('sid-revoked');
    });

    it('returns null when validateSession returns null (idle-expired)', async () => {
      const token = makeSessionToken({ sid: 'sid-expired' });
      mockValidateSession.mockResolvedValue(null);
      const result = await getAuthUser(makeReq({ authorization: `Bearer ${token}` }));
      expect(result).toBeNull();
    });

    it('returns merged identity for a valid live session', async () => {
      const token = makeSessionToken({ sid: 'sid-live', role: 'CLIENT_ADMIN', partnerId: undefined });
      mockValidateSession.mockResolvedValue({ userId: 'session-user', clientId: 'session-tenant' });
      const result = await getAuthUser(makeReq({ authorization: `Bearer ${token}` }));
      expect(result).toMatchObject({ userId: 'session-user', role: 'CLIENT_ADMIN', clientId: 'session-tenant' });
      // No partnerId on this token — should not appear in result
      expect(result?.partnerId).toBeUndefined();
    });

    it('includes partnerId from JWT when present', async () => {
      const token = makeSessionToken({ sid: 'sid-p', partnerId: 'partner-99' });
      mockValidateSession.mockResolvedValue({ userId: 'pu', clientId: 'pc' });
      const result = await getAuthUser(makeReq({ authorization: `Bearer ${token}` }));
      expect(result?.partnerId).toBe('partner-99');
    });

    it('userId and clientId come from the session, not the JWT', async () => {
      // JWT carries different userId/clientId than what the session returns
      const token = makeSessionToken({ sid: 'sid-mismatch', userId: 'jwt-user', clientId: 'jwt-tenant' });
      mockValidateSession.mockResolvedValue({ userId: 'session-user', clientId: 'session-tenant' });
      const result = await getAuthUser(makeReq({ authorization: `Bearer ${token}` }));
      // Session data wins
      expect(result?.userId).toBe('session-user');
      expect(result?.clientId).toBe('session-tenant');
    });
  });
});
