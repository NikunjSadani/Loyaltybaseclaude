/// <reference types="vitest/globals" />
/**
 * TDD — S3: login creates a session and issues a JWT with sid + clientId
 *
 * VS1: Successful login → createSession called once with { userId, clientId, token: <sid> }
 * VS2: Successful login → returned JWT decodes (via verifyToken) to payload with
 *      sid + clientId + userId + role all present and matching.
 * VS3: Wrong OTP → createSession NOT called.
 * VS4: Non-ACTIVE user → createSession NOT called.
 * VS5: DEMO_MODE → createSession NOT called.
 *
 * Also unit-tests generateAccessToken independently (GA1–GA2).
 *
 * Run: npx vitest run src/app/api/auth/__tests__/verify-otp-s3-session.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock('@/lib/prisma', () => {
  const fake = {
    otpCode: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    loginLog: {
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  return { default: fake, prisma: fake };
});

vi.mock('@/lib/session', () => ({
  createSession: vi.fn(),
}));

// We mock generateToken (old) to ensure it's NOT called in the success path,
// but we do NOT mock generateAccessToken — we want the real implementation.
// We also need verifyToken to be the real one for assertion.
// So we partially mock @/lib/auth: keep verifyToken + generateAccessToken real,
// replace only generateToken so we can detect if the old path fires by mistake.
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    // Shadow the old helper so callers of the old path get a detectable value
    generateToken: vi.fn().mockReturnValue('OLD-GENERATE-TOKEN-SHOULD-NOT-BE-USED'),
  };
});

vi.mock('@/lib/tenant', () => ({
  getClientIdFromRequest: vi.fn().mockReturnValue('deoleo'),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import { POST } from '../verify-otp/route';
import prisma from '@/lib/prisma';
import { createSession } from '@/lib/session';
import { verifyToken, generateAccessToken } from '@/lib/auth';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_OTP_CODE = '123456';
const USER_ID = 'user-active-s3';
const CLIENT_ID = 'deoleo';

const MOCK_OTP_RECORD = {
  id: 'otp-s3',
  phone: '9876543210',
  code: VALID_OTP_CODE,
  attempts: 0,
  maxAttempts: 3,
  verifiedAt: null,
  expiresAt: new Date(Date.now() + 60_000),
};

const MOCK_ACTIVE_USER = {
  id: USER_ID,
  phone: '9876543210',
  clientId: CLIENT_ID,
  name: 'S3 Test User',
  role: 'SSS' as const,
  status: 'ACTIVE',
};

const MOCK_PENDING_USER = {
  ...MOCK_ACTIVE_USER,
  status: 'PENDING_VERIFICATION',
};

function makeRequest(
  body: Record<string, unknown> = {},
  headers: Record<string, string | null> = {},
) {
  const headerMap: Record<string, string | null> = {
    'x-forwarded-for': null,
    'x-real-ip': null,
    'user-agent': null,
    ...headers,
  };
  return {
    headers: {
      get: (key: string) => headerMap[key.toLowerCase()] ?? null,
    },
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

const VALID_BODY = { mobile: '9876543210', otp: VALID_OTP_CODE };

function setupTransactionMock() {
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
    async (callbackOrOperations: unknown) => {
      if (typeof callbackOrOperations === 'function') {
        return (callbackOrOperations as (tx: typeof prisma) => Promise<unknown>)(prisma);
      }
      return Promise.all(callbackOrOperations as Promise<unknown>[]);
    },
  );
}

// ── generateAccessToken unit tests (GA) ───────────────────────────────────────

describe('generateAccessToken — unit', () => {
  it('GA1: round-trips through verifyToken with all four claims intact', () => {
    const token = generateAccessToken({
      userId: 'u-1',
      role: 'SSS',
      clientId: 'tenant-abc',
      sid: 'session-uuid-1',
    });
    const payload = verifyToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe('u-1');
    expect(payload!.role).toBe('SSS');
    expect(payload!.clientId).toBe('tenant-abc');
    expect(payload!.sid).toBe('session-uuid-1');
  });

  it('GA2: round-trips with optional partnerId when provided', () => {
    const token = generateAccessToken({
      userId: 'u-2',
      role: 'PARTNER',
      clientId: 'tenant-xyz',
      sid: 'session-uuid-2',
      partnerId: 'partner-99',
    });
    const payload = verifyToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.partnerId).toBe('partner-99');
  });

  it('GA3: token is a valid JWT string (three dot-separated parts)', () => {
    const token = generateAccessToken({
      userId: 'u-3',
      role: 'SSS',
      clientId: 'c',
      sid: 's',
    });
    expect(token.split('.').length).toBe(3);
  });
});

// ── Route integration tests (VS) ─────────────────────────────────────────────

describe('POST /api/auth/verify-otp — S3: session creation', () => {
  const originalDemoMode = process.env.DEMO_MODE;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DEMO_MODE = 'false';

    (prisma.otpCode.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_OTP_RECORD);
    (prisma.otpCode.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ACTIVE_USER);
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ACTIVE_USER);
    (prisma.loginLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'log-s3' });
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'audit-s3' });
    (createSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sess-s3' });
    setupTransactionMock();
  });

  afterEach(() => {
    process.env.DEMO_MODE = originalDemoMode;
  });

  // ── VS1: createSession is called with correct args on success ────────────

  describe('VS1 — createSession called on successful login', () => {
    it('VS1a: createSession is called exactly once', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(createSession).toHaveBeenCalledOnce();
    });

    it('VS1b: createSession receives the correct userId and clientId', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          clientId: CLIENT_ID,
        }),
      );
    });

    it('VS1c: createSession receives a non-empty string as token (the sid)', async () => {
      await POST(makeRequest(VALID_BODY));
      const call = (createSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(typeof call.token).toBe('string');
      expect(call.token.length).toBeGreaterThan(0);
    });

    it('VS1d: the sid passed to createSession matches the sid inside the returned JWT', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      const body = await res.json();
      const payload = verifyToken(body.data.token);

      const call = (createSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(payload).not.toBeNull();
      expect(payload!.sid).toBe(call.token); // JWT sid === sid stored in session row
    });
  });

  // ── VS2: returned JWT payload contains all required claims ───────────────

  describe('VS2 — JWT payload contains sid + clientId + userId + role', () => {
    it('VS2a: JWT decodes successfully via verifyToken', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      const body = await res.json();
      expect(verifyToken(body.data.token)).not.toBeNull();
    });

    it('VS2b: JWT payload contains userId matching the logged-in user', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      const body = await res.json();
      const payload = verifyToken(body.data.token);
      expect(payload!.userId).toBe(USER_ID);
    });

    it('VS2c: JWT payload contains role matching the user', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      const body = await res.json();
      const payload = verifyToken(body.data.token);
      expect(payload!.role).toBe(MOCK_ACTIVE_USER.role);
    });

    it('VS2d: JWT payload contains clientId from the tenant resolver', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      const body = await res.json();
      const payload = verifyToken(body.data.token);
      expect(payload!.clientId).toBe(CLIENT_ID);
    });

    it('VS2e: JWT payload contains a non-empty sid', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      const body = await res.json();
      const payload = verifyToken(body.data.token);
      expect(typeof payload!.sid).toBe('string');
      expect(payload!.sid!.length).toBeGreaterThan(0);
    });
  });

  // ── VS3: Wrong OTP — createSession NOT called ────────────────────────────

  describe('VS3 — wrong OTP: createSession not called', () => {
    it('VS3a: returns 401 for wrong OTP', async () => {
      const res = await POST(makeRequest({ mobile: '9876543210', otp: '999999' }));
      expect(res.status).toBe(401);
    });

    it('VS3b: createSession is NOT called on wrong OTP', async () => {
      await POST(makeRequest({ mobile: '9876543210', otp: '999999' }));
      expect(createSession).not.toHaveBeenCalled();
    });
  });

  // ── VS4: Non-ACTIVE user — createSession NOT called ──────────────────────

  describe('VS4 — non-ACTIVE user: createSession not called', () => {
    beforeEach(() => {
      (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PENDING_USER);
    });

    it('VS4a: returns 403 for non-ACTIVE user', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(403);
    });

    it('VS4b: createSession is NOT called for non-ACTIVE user', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(createSession).not.toHaveBeenCalled();
    });
  });

  // ── VS5: DEMO_MODE — createSession NOT called ─────────────────────────────

  describe('VS5 — DEMO_MODE: createSession not called', () => {
    beforeEach(() => {
      process.env.DEMO_MODE = 'true';
    });

    it('VS5a: returns 200 in DEMO_MODE', async () => {
      const res = await POST(makeRequest({ mobile: '9876543210', otp: '000000' }));
      expect(res.status).toBe(200);
    });

    it('VS5b: createSession is NOT called in DEMO_MODE', async () => {
      await POST(makeRequest({ mobile: '9876543210', otp: '000000' }));
      expect(createSession).not.toHaveBeenCalled();
    });
  });

  // ── VS6: Response shape is unchanged ─────────────────────────────────────

  describe('VS6 — response shape preserved', () => {
    it('VS6a: returns { token, user: { id, role, name } } in data', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({
        token: expect.any(String),
        user: {
          id: USER_ID,
          role: MOCK_ACTIVE_USER.role,
          name: MOCK_ACTIVE_USER.name,
        },
      });
    });
  });
});
