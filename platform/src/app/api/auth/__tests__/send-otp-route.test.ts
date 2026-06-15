/// <reference types="vitest/globals" />
/**
 * TDD — send-otp POST handler behavioral tests (Task 1.1a — F7 fix)
 *
 * F7: send-otp silently returned 200 success even when:
 *   a) the tenant's templateId is not configured (empty/missing from CLIENT_REGISTRY)
 *   b) sendOtp from msg91 returns { success: false }
 *
 * S1: Unconfigured tenant → 503 before any DB writes (fail-fast)
 * S2: Configured tenant, sendOtp fails → 502 (not success)
 * S3: Happy path (configured tenant, sendOtp success) → 200 success
 *
 * Run: npx vitest run src/app/api/auth/__tests__/send-otp-route.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock calls are hoisted — factory must not reference outer variables.
// Use inline vi.fn() and retrieve via import after the mock is set up.
vi.mock('@/lib/msg91', () => ({
  sendOtp: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const fake = {
    user: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    otpCode: {
      create: vi.fn(),
    },
  };
  return { default: fake, prisma: fake };
});

vi.mock('@/lib/tenant', () => ({
  getClientIdFromRequest: vi.fn(),
}));

// ── Import handler and mocked modules ────────────────────────────────────────
import { POST } from '../send-otp/route';
import * as msg91 from '@/lib/msg91';
import prisma from '@/lib/prisma';
import { getClientIdFromRequest } from '@/lib/tenant';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown> = {}) {
  return {
    headers: { get: (_key: string) => null },
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

const VALID_BODY = { mobile: '9876543210', channel: 'SMS' };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/auth/send-otp — F7 fail-fast and result-check', () => {
  const originalDemoMode = process.env.DEMO_MODE;

  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure we are NOT in demo mode for all these tests
    process.env.DEMO_MODE = 'false';
    // Default: user does not exist (new phone — triggers provisional user creation)
    (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.user.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'provisional-user-1' });
    (prisma.otpCode.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (msg91.sendOtp as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, requestId: 'req_123' });
  });

  afterEach(() => {
    process.env.DEMO_MODE = originalDemoMode;
  });

  // ── S1: unconfigured tenant — fail-fast before any DB writes ─────────────

  describe('S1 — unconfigured tenant (no templateId in CLIENT_REGISTRY)', () => {
    beforeEach(() => {
      // 'unknown-tenant' is not in CLIENT_REGISTRY so templateId resolves to ''
      (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue('unknown-tenant');
    });

    it('S1a: returns 503 (not 200) for an unconfigured tenant', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(503);
    });

    it('S1b: response body indicates failure (success: false)', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      const body = await res.json();
      expect(body.success).toBe(false);
    });

    it('S1c: sendOtp is NOT called for an unconfigured tenant (fail before msg91)', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(msg91.sendOtp).not.toHaveBeenCalled();
    });

    it('S1d: prisma.otpCode.create is NOT called for an unconfigured tenant (fail before writes)', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(prisma.otpCode.create).not.toHaveBeenCalled();
    });

    it('S1e: prisma.user.create is NOT called for an unconfigured tenant (fail before writes)', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  // ── S2: configured tenant but sendOtp returns { success: false } ──────────

  describe('S2 — configured tenant, sendOtp fails', () => {
    beforeEach(() => {
      // 'deoleo' is in CLIENT_REGISTRY with a valid templateId ('deoleo_otp')
      (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue('deoleo');
      (msg91.sendOtp as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false, error: 'MSG91 API error' });
    });

    it('S2a: returns 502 (not 200) when sendOtp fails', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(502);
    });

    it('S2b: response body indicates failure (success: false)', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      const body = await res.json();
      expect(body.success).toBe(false);
    });

    it('S2c: sendOtp was called (attempt was made before detecting failure)', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(msg91.sendOtp).toHaveBeenCalledOnce();
    });
  });

  // ── S3: happy path — configured tenant + sendOtp succeeds → 200 ──────────

  describe('S3 — happy path (configured tenant, sendOtp succeeds)', () => {
    beforeEach(() => {
      (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue('deoleo');
      (msg91.sendOtp as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, requestId: 'req_abc' });
    });

    it('S3a: returns 200 when tenant is configured and sendOtp succeeds', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(200);
    });

    it('S3b: response body indicates success (success: true)', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('S3c: sendOtp was called with the correct phone and templateId', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(msg91.sendOtp).toHaveBeenCalledWith(
        expect.objectContaining({
          phone: '9876543210',
          templateId: 'deoleo_otp',
        }),
      );
    });

    it('S3d: OTP row was created in the DB', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(prisma.otpCode.create).toHaveBeenCalledOnce();
    });
  });

  // ── DEMO_MODE branch must remain untouched ────────────────────────────────

  describe('DEMO_MODE branch (must remain unchanged)', () => {
    beforeEach(() => {
      process.env.DEMO_MODE = 'true';
      (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue('unknown-tenant');
    });

    it('DM1: DEMO_MODE returns 200 even for an unconfigured tenant', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(200);
    });

    it('DM2: DEMO_MODE does not call sendOtp', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(msg91.sendOtp).not.toHaveBeenCalled();
    });
  });
});
