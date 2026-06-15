/// <reference types="vitest/globals" />
/**
 * TDD — POST /api/admin/force-logout-all
 *
 * FL1: GIFSY_ADMIN → revokeAllSessions called, auditLog.create called with action LOGOUT,
 *      response 200 with revoked count
 * FL2: CLIENT_ADMIN → 403, revokeAllSessions NOT called
 * FL3: unauthenticated → 401, revokeAllSessions NOT called
 * FL4: auditLog.create receives correct shape (action LOGOUT, entityType SESSION, entityId ALL,
 *      actorId from authUser, metadata.reason force-logout-all)
 * FL5: response body includes { message, revoked: count }
 *
 * Run: npx vitest run src/app/api/admin/force-logout-all/__tests__/route.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @/lib/prisma (both named + default) ─────────────────────────────────
vi.mock('@/lib/prisma', () => {
  const mockAuditLogCreate = vi.fn();
  const fake = { auditLog: { create: mockAuditLogCreate } };
  return { default: fake, prisma: fake };
});

// ── Mock @/lib/auth ───────────────────────────────────────────────────────────
vi.mock('@/lib/auth', () => ({ getAuthUser: vi.fn() }));

// ── Mock @/lib/session (revokeAllSessions — the new platform-wide function) ──
vi.mock('@/lib/session', () => ({ revokeAllSessions: vi.fn() }));

import { POST } from '../route';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { revokeAllSessions } from '@/lib/session';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest() {
  return {
    headers: { get: (_key: string) => null },
  } as unknown as Parameters<typeof POST>[0];
}

const GIFSY_ACTOR = { userId: 'gifsy-user-1', role: 'GIFSY_ADMIN', clientId: 'platform' };
const CLIENT_ACTOR = { userId: 'client-user-1', role: 'CLIENT_ADMIN', clientId: 'tenant-a' };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/admin/force-logout-all', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── FL3: unauthenticated ────────────────────────────────────────────────────
  it('FL3: returns 401 when unauthenticated', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  it('FL3: does not create an audit log when unauthenticated', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await POST(makeRequest());

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  // ── FL2: CLIENT_ADMIN rejected ──────────────────────────────────────────────
  it('FL2: returns 403 when role is CLIENT_ADMIN', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(CLIENT_ACTOR);

    const res = await POST(makeRequest());

    expect(res.status).toBe(403);
  });

  it('FL2: revokeAllSessions is NOT called when role is CLIENT_ADMIN', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(CLIENT_ACTOR);

    await POST(makeRequest());

    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  it('FL2: does not create an audit log when role is CLIENT_ADMIN', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(CLIENT_ACTOR);

    await POST(makeRequest());

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  // ── FL1: GIFSY_ADMIN happy path ─────────────────────────────────────────────
  it('FL1: returns 200 when GIFSY_ADMIN', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(GIFSY_ACTOR);
    (revokeAllSessions as ReturnType<typeof vi.fn>).mockResolvedValue(42);
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
  });

  it('FL1: calls revokeAllSessions once when GIFSY_ADMIN', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(GIFSY_ACTOR);
    (revokeAllSessions as ReturnType<typeof vi.fn>).mockResolvedValue(42);
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await POST(makeRequest());

    expect(revokeAllSessions).toHaveBeenCalledOnce();
  });

  // ── FL5: response body ──────────────────────────────────────────────────────
  it('FL5: response body includes message and revoked count', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(GIFSY_ACTOR);
    (revokeAllSessions as ReturnType<typeof vi.fn>).mockResolvedValue(17);
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.revoked).toBe(17);
    expect(typeof body.data.message).toBe('string');
  });

  // ── FL4: audit log shape ────────────────────────────────────────────────────
  it('FL4: creates an audit log with action LOGOUT and entityType SESSION', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(GIFSY_ACTOR);
    (revokeAllSessions as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await POST(makeRequest());

    expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    const callArg = (prisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.data.action).toBe('LOGOUT');
    expect(callArg.data.entityType).toBe('SESSION');
  });

  it('FL4: audit log entityId is "ALL" (platform-wide scope)', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(GIFSY_ACTOR);
    (revokeAllSessions as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await POST(makeRequest());

    const callArg = (prisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.data.entityId).toBe('ALL');
  });

  it('FL4: audit log actorId matches the authenticated user', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(GIFSY_ACTOR);
    (revokeAllSessions as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await POST(makeRequest());

    const callArg = (prisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.data.actorId).toBe(GIFSY_ACTOR.userId);
  });

  it('FL4: audit log metadata includes revoked count and reason "force-logout-all"', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(GIFSY_ACTOR);
    (revokeAllSessions as ReturnType<typeof vi.fn>).mockResolvedValue(99);
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await POST(makeRequest());

    const callArg = (prisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.data.metadata).toMatchObject({
      revoked: 99,
      reason: 'force-logout-all',
    });
  });
});
