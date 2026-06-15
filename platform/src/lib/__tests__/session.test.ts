/**
 * Tests for src/lib/session.ts — session lifecycle contract.
 *
 * Strategy: mock '@/lib/prisma' (both named + default export) so no DB is
 * required. Clock is fixed via vi.useFakeTimers so 365-day math is deterministic.
 *
 * Run: npx vitest run src/lib/__tests__/session.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock prisma BEFORE importing session.ts ──────────────────────────────────
// vi.mock is hoisted to the top of the file by Vitest, so any variables it
// references must also be hoisted via vi.hoisted() — plain `const` declarations
// above the call are NOT available at hoist time.
// Must mock BOTH named export `prisma` and the default export (see 01-how-we-test.md).

const { mockCreate, mockFindUnique, mockUpdate, mockUpdateMany, fakePrisma } =
  vi.hoisted(() => {
    const mockCreate     = vi.fn();
    const mockFindUnique = vi.fn();
    const mockUpdate     = vi.fn();
    const mockUpdateMany = vi.fn();
    const fakePrisma = {
      userSession: {
        create:     mockCreate,
        findUnique: mockFindUnique,
        update:     mockUpdate,
        updateMany: mockUpdateMany,
      },
    };
    return { mockCreate, mockFindUnique, mockUpdate, mockUpdateMany, fakePrisma };
  });

vi.mock('@/lib/prisma', () => ({
  default: fakePrisma,
  prisma:  fakePrisma,
}));

// ── Now import the module under test ─────────────────────────────────────────
import {
  SESSION_IDLE_DAYS,
  slidingExpiry,
  createSession,
  validateSession,
  revokeSession,
  revokeAllSessionsForUser,
} from '../session';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Fixed "now" used across tests so date math is deterministic. */
const FIXED_NOW = new Date('2026-06-15T10:00:00.000Z');

/** Expected expiresAt when the clock is fixed to FIXED_NOW. */
function expectedExpiry(): Date {
  return slidingExpiry(FIXED_NOW);
}

function msFrom(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SESSION_IDLE_DAYS', () => {
  it('is 365', () => {
    expect(SESSION_IDLE_DAYS).toBe(365);
  });
});

describe('slidingExpiry', () => {
  it('returns a date exactly SESSION_IDLE_DAYS days after the supplied base', () => {
    const base = new Date('2026-01-01T00:00:00.000Z');
    const result = slidingExpiry(base);
    expect(result.getTime()).toBe(msFrom(base, 365).getTime());
  });

  it('defaults to "now" when no argument given', () => {
    const before = Date.now();
    const result = slidingExpiry();
    const after  = Date.now();
    const resultMs = result.getTime();
    // Must be somewhere between before+365d and after+365d
    expect(resultMs).toBeGreaterThanOrEqual(msFrom(new Date(before), 365).getTime());
    expect(resultMs).toBeLessThanOrEqual(msFrom(new Date(after), 365).getTime());
  });
});

describe('createSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    mockCreate.mockResolvedValue({
      id:          'sess-1',
      userId:      'user-abc',
      clientId:    'deoleo',
      token:       'tok-xyz',
      refreshToken: null,
      deviceId:    null,
      deviceName:  null,
      ipAddress:   null,
      userAgent:   null,
      expiresAt:   expectedExpiry(),
      lastSeenAt:  FIXED_NOW,
      revokedAt:   null,
      createdAt:   FIXED_NOW,
      updatedAt:   FIXED_NOW,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('calls prisma.userSession.create with the correct userId and clientId', async () => {
    await createSession({ userId: 'user-abc', clientId: 'deoleo', token: 'tok-xyz' });
    expect(mockCreate).toHaveBeenCalledOnce();
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.userId).toBe('user-abc');
    expect(data.clientId).toBe('deoleo');
    expect(data.token).toBe('tok-xyz');
  });

  it('sets expiresAt to now + 365 days', async () => {
    await createSession({ userId: 'user-abc', clientId: 'deoleo', token: 'tok-xyz' });
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.expiresAt.getTime()).toBe(expectedExpiry().getTime());
  });

  it('sets lastSeenAt to now', async () => {
    await createSession({ userId: 'user-abc', clientId: 'deoleo', token: 'tok-xyz' });
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.lastSeenAt.getTime()).toBe(FIXED_NOW.getTime());
  });

  it('passes through optional device/ip/userAgent fields', async () => {
    await createSession({
      userId:     'user-abc',
      clientId:   'deoleo',
      token:      'tok-xyz',
      deviceId:   'dev-1',
      deviceName: 'iPhone 15',
      ipAddress:  '1.2.3.4',
      userAgent:  'Mozilla/5.0',
    });
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.deviceId).toBe('dev-1');
    expect(data.deviceName).toBe('iPhone 15');
    expect(data.ipAddress).toBe('1.2.3.4');
    expect(data.userAgent).toBe('Mozilla/5.0');
  });

  it('sets optional fields to null when not supplied', async () => {
    await createSession({ userId: 'user-abc', clientId: 'deoleo', token: 'tok-xyz' });
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.deviceId).toBeNull();
    expect(data.deviceName).toBeNull();
    expect(data.ipAddress).toBeNull();
    expect(data.userAgent).toBeNull();
  });

  it('returns the row produced by prisma', async () => {
    const row = await createSession({ userId: 'user-abc', clientId: 'deoleo', token: 'tok-xyz' });
    expect(row.id).toBe('sess-1');
    expect(row.userId).toBe('user-abc');
    expect(row.clientId).toBe('deoleo');
  });
});

describe('validateSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── Null case 1: token not found ───────────────────────────────────────────
  it('returns null when the token is not found', async () => {
    mockFindUnique.mockResolvedValue(null);
    const result = await validateSession('ghost-token');
    expect(result).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // ── Null case 2: revoked ───────────────────────────────────────────────────
  it('returns null when the session has been revoked', async () => {
    mockFindUnique.mockResolvedValue({
      id:         'sess-2',
      userId:     'user-abc',
      clientId:   'deoleo',
      token:      'tok-revoked',
      revokedAt:  new Date('2026-06-10T00:00:00.000Z'),  // revoked in the past
      expiresAt:  msFrom(FIXED_NOW, 100),                // not yet idle-expired
    });
    const result = await validateSession('tok-revoked');
    expect(result).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // ── Null case 3: idle-expired (expiresAt <= now) ───────────────────────────
  it('returns null when the session is idle-expired (expiresAt in the past)', async () => {
    mockFindUnique.mockResolvedValue({
      id:         'sess-3',
      userId:     'user-abc',
      clientId:   'deoleo',
      token:      'tok-expired',
      revokedAt:  null,
      expiresAt:  new Date('2026-06-14T23:59:59.000Z'),  // 1 second before "now"
    });
    const result = await validateSession('tok-expired');
    expect(result).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns null when expiresAt exactly equals now (boundary: <= means expired)', async () => {
    mockFindUnique.mockResolvedValue({
      id:         'sess-4',
      userId:     'user-abc',
      clientId:   'deoleo',
      token:      'tok-boundary',
      revokedAt:  null,
      expiresAt:  FIXED_NOW,   // exactly now — counts as expired
    });
    const result = await validateSession('tok-boundary');
    expect(result).toBeNull();
  });

  // ── Happy path: live session ───────────────────────────────────────────────
  it('returns { userId, clientId } for a live session', async () => {
    mockFindUnique.mockResolvedValue({
      id:         'sess-5',
      userId:     'user-abc',
      clientId:   'deoleo',
      token:      'tok-live',
      revokedAt:  null,
      expiresAt:  msFrom(FIXED_NOW, 100),
    });
    mockUpdate.mockResolvedValue({});
    const result = await validateSession('tok-live');
    expect(result).toEqual({ userId: 'user-abc', clientId: 'deoleo' });
  });

  it('bumps expiresAt to now+365d on a live session (sliding window)', async () => {
    mockFindUnique.mockResolvedValue({
      id:         'sess-5',
      userId:     'user-abc',
      clientId:   'deoleo',
      token:      'tok-live',
      revokedAt:  null,
      expiresAt:  msFrom(FIXED_NOW, 100),
    });
    mockUpdate.mockResolvedValue({});
    await validateSession('tok-live');
    expect(mockUpdate).toHaveBeenCalledOnce();
    const updateData = mockUpdate.mock.calls[0][0].data;
    expect(updateData.expiresAt.getTime()).toBe(expectedExpiry().getTime());
  });

  it('bumps lastSeenAt to now on a live session', async () => {
    mockFindUnique.mockResolvedValue({
      id:         'sess-5',
      userId:     'user-abc',
      clientId:   'deoleo',
      token:      'tok-live',
      revokedAt:  null,
      expiresAt:  msFrom(FIXED_NOW, 100),
    });
    mockUpdate.mockResolvedValue({});
    await validateSession('tok-live');
    const updateData = mockUpdate.mock.calls[0][0].data;
    expect(updateData.lastSeenAt.getTime()).toBe(FIXED_NOW.getTime());
  });
});

describe('revokeSession', () => {
  afterEach(() => vi.clearAllMocks());

  it('calls updateMany with the given token and revokedAt: null filter', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });
    await revokeSession('tok-to-revoke');
    expect(mockUpdateMany).toHaveBeenCalledOnce();
    const call = mockUpdateMany.mock.calls[0][0];
    expect(call.where.token).toBe('tok-to-revoke');
    expect(call.where.revokedAt).toBeNull();
  });

  it('sets revokedAt to a Date (truthy)', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });
    await revokeSession('tok-to-revoke');
    const data = mockUpdateMany.mock.calls[0][0].data;
    expect(data.revokedAt).toBeInstanceOf(Date);
  });

  it('is idempotent — does not throw when the session is already revoked or absent (count = 0)', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    await expect(revokeSession('already-revoked')).resolves.toBeUndefined();
  });
});

describe('revokeAllSessionsForUser', () => {
  afterEach(() => vi.clearAllMocks());

  it('calls updateMany scoped to the userId with revokedAt: null', async () => {
    mockUpdateMany.mockResolvedValue({ count: 3 });
    await revokeAllSessionsForUser('user-abc');
    const call = mockUpdateMany.mock.calls[0][0];
    expect(call.where.userId).toBe('user-abc');
    expect(call.where.revokedAt).toBeNull();
  });

  it('returns the count of revoked sessions', async () => {
    mockUpdateMany.mockResolvedValue({ count: 3 });
    const count = await revokeAllSessionsForUser('user-abc');
    expect(count).toBe(3);
  });

  it('returns 0 when there are no active sessions to revoke', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    const count = await revokeAllSessionsForUser('user-no-sessions');
    expect(count).toBe(0);
  });

  it('sets revokedAt on the matching rows (data.revokedAt is a Date)', async () => {
    mockUpdateMany.mockResolvedValue({ count: 2 });
    await revokeAllSessionsForUser('user-abc');
    const data = mockUpdateMany.mock.calls[0][0].data;
    expect(data.revokedAt).toBeInstanceOf(Date);
  });
});
