/// <reference types="vitest/globals" />
/**
 * TDD — S5: logout and logout-all endpoints
 *
 * LO1: POST /api/auth/logout — authed with sid → revokeSession(sid) called → 200
 * LO2: POST /api/auth/logout — unauthed (getAuthUser returns null) → 401, revokeSession NOT called
 * LO3: POST /api/auth/logout — authed without sid (DEMO_MODE path) → 200, revokeSession NOT called
 * LO4: POST /api/auth/logout — response clears the token cookie (Set-Cookie Max-Age=0)
 *
 * LA1: POST /api/auth/logout-all — authed → revokeAllSessionsForUser(userId) called → 200 with revoked count
 * LA2: POST /api/auth/logout-all — unauthed → 401, revokeAllSessionsForUser NOT called
 * LA3: POST /api/auth/logout-all — response clears the token cookie
 * LA4: POST /api/auth/logout-all — response body contains revoked count from revokeAllSessionsForUser
 *
 * Run: npx vitest run src/app/api/auth/__tests__/logout-routes.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  getAuthUser: vi.fn(),
}));

vi.mock('@/lib/session', () => ({
  revokeSession: vi.fn(),
  revokeAllSessionsForUser: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { POST as logoutPOST } from '../logout/route';
import { POST as logoutAllPOST } from '../logout-all/route';
import { getAuthUser } from '@/lib/auth';
import { revokeSession, revokeAllSessionsForUser } from '@/lib/session';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(headers: Record<string, string | null> = {}) {
  const headerMap: Record<string, string | null> = {
    authorization: null,
    cookie: null,
    ...headers,
  };
  return {
    headers: {
      get: (key: string) => headerMap[key.toLowerCase()] ?? null,
    },
  } as unknown as Parameters<typeof logoutPOST>[0];
}

/** Returns true if the response sets a cookie that expires/clears the token. */
function clearsTokenCookie(res: Response): boolean {
  const setCookie = res.headers.get('set-cookie') ?? '';
  // Accept either Max-Age=0 or an explicit past Expires date
  return (
    setCookie.toLowerCase().includes('token=') &&
    (setCookie.toLowerCase().includes('max-age=0') ||
      setCookie.toLowerCase().includes('expires='))
  );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AUTHED_USER_WITH_SID = {
  userId: 'user-abc',
  role: 'SSS',
  clientId: 'deoleo',
  sid: 'session-sid-xyz',
};

const AUTHED_USER_WITHOUT_SID = {
  userId: 'user-demo',
  role: 'SSS',
  clientId: 'deoleo',
  // no sid — simulates DEMO_MODE path
};

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

describe('POST /api/auth/logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (revokeSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  // LO1
  describe('LO1 — authed with sid → revokeSession called → 200', () => {
    beforeEach(() => {
      (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(AUTHED_USER_WITH_SID);
    });

    it('LO1a: returns 200 for an authenticated request with a sid', async () => {
      const res = await logoutPOST(makeReq());
      expect(res.status).toBe(200);
    });

    it('LO1b: response body has success: true and a message', async () => {
      const res = await logoutPOST(makeReq());
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(typeof body.data?.message).toBe('string');
    });

    it('LO1c: revokeSession is called exactly once with the session sid', async () => {
      await logoutPOST(makeReq());
      expect(revokeSession).toHaveBeenCalledOnce();
      expect(revokeSession).toHaveBeenCalledWith(AUTHED_USER_WITH_SID.sid);
    });
  });

  // LO2
  describe('LO2 — unauthed → 401, revokeSession NOT called', () => {
    beforeEach(() => {
      (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    });

    it('LO2a: returns 401 when getAuthUser returns null', async () => {
      const res = await logoutPOST(makeReq());
      expect(res.status).toBe(401);
    });

    it('LO2b: revokeSession is NOT called on an unauthenticated request', async () => {
      await logoutPOST(makeReq());
      expect(revokeSession).not.toHaveBeenCalled();
    });
  });

  // LO3
  describe('LO3 — authed without sid (DEMO_MODE) → 200, revokeSession NOT called', () => {
    beforeEach(() => {
      (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(AUTHED_USER_WITHOUT_SID);
    });

    it('LO3a: returns 200 even when the authUser has no sid', async () => {
      const res = await logoutPOST(makeReq());
      expect(res.status).toBe(200);
    });

    it('LO3b: revokeSession is NOT called when sid is absent', async () => {
      await logoutPOST(makeReq());
      expect(revokeSession).not.toHaveBeenCalled();
    });
  });

  // LO4
  describe('LO4 — response clears the token cookie', () => {
    beforeEach(() => {
      (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(AUTHED_USER_WITH_SID);
    });

    it('LO4a: Set-Cookie header clears the token cookie on logout', async () => {
      const res = await logoutPOST(makeReq());
      expect(clearsTokenCookie(res)).toBe(true);
    });
  });
});

// ── POST /api/auth/logout-all ─────────────────────────────────────────────────

describe('POST /api/auth/logout-all', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (revokeAllSessionsForUser as ReturnType<typeof vi.fn>).mockResolvedValue(3);
  });

  // LA1
  describe('LA1 — authed → revokeAllSessionsForUser called → 200', () => {
    beforeEach(() => {
      (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(AUTHED_USER_WITH_SID);
    });

    it('LA1a: returns 200 for an authenticated request', async () => {
      const res = await logoutAllPOST(makeReq());
      expect(res.status).toBe(200);
    });

    it('LA1b: revokeAllSessionsForUser is called with the authUser userId', async () => {
      await logoutAllPOST(makeReq());
      expect(revokeAllSessionsForUser).toHaveBeenCalledOnce();
      expect(revokeAllSessionsForUser).toHaveBeenCalledWith(AUTHED_USER_WITH_SID.userId);
    });
  });

  // LA2
  describe('LA2 — unauthed → 401', () => {
    beforeEach(() => {
      (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    });

    it('LA2a: returns 401 when getAuthUser returns null', async () => {
      const res = await logoutAllPOST(makeReq());
      expect(res.status).toBe(401);
    });

    it('LA2b: revokeAllSessionsForUser is NOT called on unauthenticated request', async () => {
      await logoutAllPOST(makeReq());
      expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    });
  });

  // LA3
  describe('LA3 — response clears the token cookie', () => {
    beforeEach(() => {
      (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(AUTHED_USER_WITH_SID);
    });

    it('LA3a: Set-Cookie header clears the token cookie on logout-all', async () => {
      const res = await logoutAllPOST(makeReq());
      expect(clearsTokenCookie(res)).toBe(true);
    });
  });

  // LA4
  describe('LA4 — response body contains revoked count', () => {
    beforeEach(() => {
      (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(AUTHED_USER_WITH_SID);
    });

    it('LA4a: response data contains revoked count returned by revokeAllSessionsForUser', async () => {
      (revokeAllSessionsForUser as ReturnType<typeof vi.fn>).mockResolvedValue(5);
      const res = await logoutAllPOST(makeReq());
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data?.revoked).toBe(5);
    });

    it('LA4b: revoked count of 0 is returned correctly (no sessions were active)', async () => {
      (revokeAllSessionsForUser as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      const res = await logoutAllPOST(makeReq());
      const body = await res.json();
      expect(body.data?.revoked).toBe(0);
    });
  });
});
