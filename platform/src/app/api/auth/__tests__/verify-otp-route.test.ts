/// <reference types="vitest/globals" />
/**
 * TDD — verify-otp POST handler — Task 1.9: login + audit record writes
 *
 * VL1: Successful login (valid OTP, ACTIVE user) → LoginLog created, User.lastLoginAt/loginCount
 *      updated, AuditLog created with action LOGIN — all inside a single $transaction.
 * VL2: Wrong OTP (code mismatch) → no LoginLog, no AuditLog, no lastLoginAt update.
 * VL3: Non-ACTIVE user (e.g. PENDING_VERIFICATION) → no LoginLog, no AuditLog, no lastLoginAt update.
 * VL4: DEMO_MODE=true → no LoginLog, no AuditLog writes.
 * VL5: ipAddress is derived from x-forwarded-for (first value), fallback x-real-ip, else null.
 * VL6: deviceInfo is derived from user-agent header, else null.
 *
 * Run: npx vitest run src/app/api/auth/__tests__/verify-otp-route.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Prisma mock ───────────────────────────────────────────────────────────────
// vi.mock factories are hoisted — NO top-level variable references allowed.
// Use inline vi.fn() inside the factory, and retrieve the mock via import after.
// See docs/plans/01-how-we-test.md §B: mock BOTH default and named exports.
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
    // $transaction: invoke callback with the mock prisma object so route code works
    $transaction: vi.fn(),
  };
  return { default: fake, prisma: fake };
});

vi.mock('@/lib/auth', () => ({
  generateToken: vi.fn().mockReturnValue('mock-jwt-token'),
  // S3: generateAccessToken added — return the same stub so 1.9 assertions on token still pass.
  generateAccessToken: vi.fn().mockReturnValue('mock-jwt-token'),
}));

vi.mock('@/lib/tenant', () => ({
  getClientIdFromRequest: vi.fn().mockReturnValue('deoleo'),
}));

// S3: route now calls createSession — stub it out so 1.9 tests are not affected.
vi.mock('@/lib/session', () => ({
  createSession: vi.fn().mockResolvedValue({ id: 'sess-stub' }),
}));

// ── Import handler and mocked modules ────────────────────────────────────────
import { POST } from '../verify-otp/route';
import prisma from '@/lib/prisma';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_OTP_CODE = '123456';
const USER_ID = 'user-active-1';

const MOCK_OTP_RECORD = {
  id: 'otp-1',
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
  clientId: 'deoleo',
  name: 'Test User',
  role: 'SSS' as const,
  status: 'ACTIVE',
};

const MOCK_PENDING_USER = {
  ...MOCK_ACTIVE_USER,
  id: 'user-pending-1',
  status: 'PENDING_VERIFICATION',
};

// Build a minimal NextRequest-shaped object with controllable headers
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

// ── $transaction helper ───────────────────────────────────────────────────────
// Configure $transaction to invoke its callback with the mocked prisma object.
// This enables `await prisma.$transaction(async tx => { tx.loginLog.create(...) })`
// to call our vi.fn()s in tests.
function setupTransactionMock() {
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
    async (callbackOrOperations: unknown) => {
      if (typeof callbackOrOperations === 'function') {
        return (callbackOrOperations as (tx: typeof prisma) => Promise<unknown>)(prisma);
      }
      // Array form: resolve all
      return Promise.all(callbackOrOperations as Promise<unknown>[]);
    },
  );
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('POST /api/auth/verify-otp — Task 1.9: login audit writes', () => {
  const originalDemoMode = process.env.DEMO_MODE;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DEMO_MODE = 'false';

    // Default happy-path setup
    (prisma.otpCode.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_OTP_RECORD);
    (prisma.otpCode.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ACTIVE_USER);
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ACTIVE_USER);
    (prisma.loginLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'log-1' });
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'audit-1' });
    setupTransactionMock();
  });

  afterEach(() => {
    process.env.DEMO_MODE = originalDemoMode;
  });

  // ── VL1: Happy path — successful login writes all three records ───────────

  describe('VL1 — successful login (valid OTP, ACTIVE user)', () => {
    it('VL1a: returns 200 with a token', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.token).toBeTruthy();
    });

    it('VL1b: calls prisma.$transaction once for the audit writes', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(prisma.$transaction).toHaveBeenCalledOnce();
    });

    it('VL1c: creates a LoginLog row with the correct userId', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(prisma.loginLog.create).toHaveBeenCalledOnce();
      expect(prisma.loginLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: USER_ID }),
        }),
      );
    });

    it('VL1d: updates User with lastLoginAt and increments loginCount', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(prisma.user.update).toHaveBeenCalledOnce();
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: USER_ID }),
          data: expect.objectContaining({
            lastLoginAt: expect.any(Date),
            loginCount: { increment: 1 },
          }),
        }),
      );
    });

    it('VL1e: creates an AuditLog row with action LOGIN and entityType USER', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(prisma.auditLog.create).toHaveBeenCalledOnce();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'LOGIN',
            entityType: 'USER',
            entityId: USER_ID,
            actorId: USER_ID,
          }),
        }),
      );
    });
  });

  // ── VL2: Wrong OTP — no audit writes ─────────────────────────────────────

  describe('VL2 — wrong OTP code (code mismatch)', () => {
    const WRONG_BODY = { mobile: '9876543210', otp: '999999' };

    it('VL2a: returns 401', async () => {
      const res = await POST(makeRequest(WRONG_BODY));
      expect(res.status).toBe(401);
    });

    it('VL2b: does NOT call loginLog.create', async () => {
      await POST(makeRequest(WRONG_BODY));
      expect(prisma.loginLog.create).not.toHaveBeenCalled();
    });

    it('VL2c: does NOT call auditLog.create', async () => {
      await POST(makeRequest(WRONG_BODY));
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('VL2d: does NOT call user.update with lastLoginAt', async () => {
      await POST(makeRequest(WRONG_BODY));
      const calls = (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls;
      const lastLoginAtCall = calls.find((args: unknown[]) => {
        const arg = args[0] as { data?: { lastLoginAt?: unknown } } | undefined;
        return arg?.data?.lastLoginAt !== undefined;
      });
      expect(lastLoginAtCall).toBeUndefined();
    });
  });

  // ── VL3: Non-ACTIVE user — no audit writes ────────────────────────────────

  describe('VL3 — non-ACTIVE user (PENDING_VERIFICATION)', () => {
    beforeEach(() => {
      (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PENDING_USER);
    });

    it('VL3a: returns 403', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(403);
    });

    it('VL3b: does NOT call loginLog.create', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(prisma.loginLog.create).not.toHaveBeenCalled();
    });

    it('VL3c: does NOT call auditLog.create', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('VL3d: does NOT call user.update with lastLoginAt', async () => {
      await POST(makeRequest(VALID_BODY));
      const calls = (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls;
      const lastLoginAtCall = calls.find((args: unknown[]) => {
        const arg = args[0] as { data?: { lastLoginAt?: unknown } } | undefined;
        return arg?.data?.lastLoginAt !== undefined;
      });
      expect(lastLoginAtCall).toBeUndefined();
    });
  });

  // ── VL4: DEMO_MODE — no audit writes ─────────────────────────────────────

  describe('VL4 — DEMO_MODE=true', () => {
    beforeEach(() => {
      process.env.DEMO_MODE = 'true';
    });

    it('VL4a: returns 200 with demo token for otp 000000', async () => {
      const res = await POST(makeRequest({ mobile: '9876543210', otp: '000000' }));
      expect(res.status).toBe(200);
    });

    it('VL4b: does NOT call loginLog.create in DEMO_MODE', async () => {
      await POST(makeRequest({ mobile: '9876543210', otp: '000000' }));
      expect(prisma.loginLog.create).not.toHaveBeenCalled();
    });

    it('VL4c: does NOT call auditLog.create in DEMO_MODE', async () => {
      await POST(makeRequest({ mobile: '9876543210', otp: '000000' }));
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('VL4d: does NOT call prisma.$transaction in DEMO_MODE', async () => {
      await POST(makeRequest({ mobile: '9876543210', otp: '000000' }));
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ── VL5: ipAddress derivation ─────────────────────────────────────────────

  describe('VL5 — ipAddress derivation', () => {
    it('VL5a: uses first value of x-forwarded-for when present', async () => {
      await POST(makeRequest(VALID_BODY, { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }));
      expect(prisma.loginLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ipAddress: '1.2.3.4' }),
        }),
      );
    });

    it('VL5b: falls back to x-real-ip when x-forwarded-for is absent', async () => {
      await POST(makeRequest(VALID_BODY, { 'x-real-ip': '9.10.11.12' }));
      expect(prisma.loginLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ipAddress: '9.10.11.12' }),
        }),
      );
    });

    it('VL5c: ipAddress is null when neither header is present', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(prisma.loginLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ipAddress: null }),
        }),
      );
    });
  });

  // ── VL6: deviceInfo derivation ────────────────────────────────────────────

  describe('VL6 — deviceInfo derivation', () => {
    it('VL6a: sets deviceInfo from user-agent header', async () => {
      const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)';
      await POST(makeRequest(VALID_BODY, { 'user-agent': ua }));
      expect(prisma.loginLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deviceInfo: ua }),
        }),
      );
    });

    it('VL6b: deviceInfo is null when user-agent is absent', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(prisma.loginLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deviceInfo: null }),
        }),
      );
    });
  });
});
