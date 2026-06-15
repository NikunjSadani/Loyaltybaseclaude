/**
 * Unit tests for revokeAllSessions — platform-wide session kill switch.
 *
 * Distinct from revokeAllSessionsForUser (scoped to one user).
 * revokeAllSessions has NO userId filter — it hits every non-revoked session
 * across all users and all tenants.
 *
 * Run: npx vitest run src/lib/__tests__/session-revoke-all.test.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ── Mock prisma BEFORE importing session.ts ──────────────────────────────────
// vi.mock is hoisted; variables must come from vi.hoisted().

const { mockUpdateMany, fakePrisma } = vi.hoisted(() => {
  const mockUpdateMany = vi.fn();
  const fakePrisma = {
    userSession: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: mockUpdateMany,
    },
  };
  return { mockUpdateMany, fakePrisma };
});

vi.mock('@/lib/prisma', () => ({
  default: fakePrisma,
  prisma: fakePrisma,
}));

import { revokeAllSessions } from '../session';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('revokeAllSessions (platform-wide kill switch)', () => {
  afterEach(() => vi.clearAllMocks());

  it('calls prisma.userSession.updateMany with revokedAt: null filter only — NO userId filter', async () => {
    mockUpdateMany.mockResolvedValue({ count: 100 });

    await revokeAllSessions();

    expect(mockUpdateMany).toHaveBeenCalledOnce();
    const call = mockUpdateMany.mock.calls[0][0];
    // Must filter revokedAt: null (skip already-revoked rows)
    expect(call.where.revokedAt).toBeNull();
    // Must NOT scope by userId — this is the global kill switch
    expect(call.where).not.toHaveProperty('userId');
  });

  it('does not scope by clientId (cross-tenant operation)', async () => {
    mockUpdateMany.mockResolvedValue({ count: 50 });

    await revokeAllSessions();

    const call = mockUpdateMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty('clientId');
  });

  it('sets revokedAt to a Date instance on matching rows', async () => {
    mockUpdateMany.mockResolvedValue({ count: 10 });

    await revokeAllSessions();

    const data = mockUpdateMany.mock.calls[0][0].data;
    expect(data.revokedAt).toBeInstanceOf(Date);
  });

  it('returns the count of sessions revoked', async () => {
    mockUpdateMany.mockResolvedValue({ count: 42 });

    const result = await revokeAllSessions();

    expect(result).toBe(42);
  });

  it('returns 0 when there are no active sessions to revoke', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    const result = await revokeAllSessions();

    expect(result).toBe(0);
  });

  it('revokes a large number of sessions — returns the count faithfully', async () => {
    mockUpdateMany.mockResolvedValue({ count: 99999 });

    const result = await revokeAllSessions();

    expect(result).toBe(99999);
  });
});
