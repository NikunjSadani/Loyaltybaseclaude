/// <reference types="vitest/globals" />
/**
 * TDD — GET/PATCH/DELETE /api/admin/users/[id]
 *
 * UI1: GET returns 404 when the target user belongs to a different tenant
 * UI2: GET returns 200 when the target user belongs to the same tenant
 * UI3: PATCH does NOT call prisma.user.update when target user is cross-tenant → 404
 * UI4: PATCH calls prisma.user.update when target user is in same tenant → 200
 * UI5: DELETE does NOT call prisma.user.update when target user is cross-tenant → 404
 * UI6: DELETE calls prisma.user.update (soft-delete) when target user is in same tenant → 200
 * UI7: GET returns 401 when unauthenticated
 * UI8: GET returns 403 when role is not GIFSY_ADMIN or CLIENT_ADMIN
 * UI9: DELETE returns 403 when role is CLIENT_ADMIN (Gifsy Admin only)
 * UI10: DELETE returns 400 when deleting own account
 *
 * Phone-change tests (S5b):
 * UI11: PATCH changing phone to a new value → update called with phone AND revokeAllSessionsForUser called once
 * UI12: PATCH with same phone as current → revokeAllSessionsForUser NOT called
 * UI13: PATCH with no phone field → revokeAllSessionsForUser NOT called
 * UI14: PATCH with phone already used by another user in same tenant → 409, update NOT called, no revoke
 * UI15: PATCH cross-tenant target (findFirst null) → 404, no revoke (unchanged behavior)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  default: {
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));
vi.mock('@/lib/auth', () => ({ getAuthUser: vi.fn() }));
vi.mock('@/lib/tenant', () => ({ getClientIdFromRequest: vi.fn() }));
vi.mock('@/lib/session', () => ({ revokeAllSessionsForUser: vi.fn() }));

import { GET, PATCH, DELETE } from '../[id]/route';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';
import { revokeAllSessionsForUser } from '@/lib/session';

const USER_ID = 'user_target_1';
const ACTOR_ID = 'user_actor_1';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const MOCK_USER = {
  id: USER_ID,
  clientId: TENANT_A,
  name: 'Target User',
  phone: '9876543210',
  email: 'target@example.com',
  role: 'SSS',
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01'),
  channelPartner: null,
  salesUser: null,
};

function makeRequest(tenantSlug = TENANT_A) {
  return {
    headers: { get: (key: string) => (key === 'x-tenant-slug' ? tenantSlug : null) },
    url: `http://localhost/api/admin/users/${USER_ID}`,
    json: async () => ({ name: 'Updated Name' }),
  } as unknown as Parameters<typeof GET>[0];
}

function makeParams(id = USER_ID) {
  return Promise.resolve({ id });
}

describe('GET /api/admin/users/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: ACTOR_ID, role: 'CLIENT_ADMIN' });
    (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue(TENANT_A);
    (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_USER);
  });

  it('UI7: returns 401 when unauthenticated', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(makeRequest(), { params: makeParams() });
    expect(res.status).toBe(401);
  });

  it('UI8: returns 403 when role is not GIFSY_ADMIN or CLIENT_ADMIN', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: ACTOR_ID, role: 'SSS' });
    const res = await GET(makeRequest(), { params: makeParams() });
    expect(res.status).toBe(403);
  });

  it('UI1: returns 404 when target user belongs to a different tenant', async () => {
    (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue(TENANT_B);
    (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(makeRequest(TENANT_B), { params: makeParams() });
    expect(res.status).toBe(404);
  });

  it('UI2: returns 200 when target user belongs to the same tenant', async () => {
    const res = await GET(makeRequest(), { params: makeParams() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.user.id).toBe(USER_ID);
  });

  it('UI2b: scopes the findFirst query by both id and clientId', async () => {
    await GET(makeRequest(), { params: makeParams() });
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: USER_ID, clientId: TENANT_A }),
      }),
    );
  });
});

describe('PATCH /api/admin/users/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: ACTOR_ID, role: 'CLIENT_ADMIN' });
    (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue(TENANT_A);
    (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_USER);
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...MOCK_USER, name: 'Updated Name' });
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (revokeAllSessionsForUser as ReturnType<typeof vi.fn>).mockResolvedValue(1);
  });

  it('UI3: does NOT call prisma.user.update when target user is in a different tenant → 404', async () => {
    (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue(TENANT_B);
    (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await PATCH(makeRequest(TENANT_B), { params: makeParams() });
    expect(res.status).toBe(404);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('UI4: calls prisma.user.update when target user is in same tenant → 200', async () => {
    const res = await PATCH(makeRequest(), { params: makeParams() });
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: USER_ID }) }),
    );
  });

  // ── S5b: phone-change tests ──────────────────────────────────────────────

  it('UI11: PATCH changing phone to a new value → update called with new phone AND revokeAllSessionsForUser called once', async () => {
    const NEW_PHONE = '1234567890';
    // MOCK_USER.phone is '9876543210', so NEW_PHONE is different
    // findFirst: first call returns target (tenant check), second call (clash check) returns null
    (prisma.user.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(MOCK_USER)   // tenant-scoped target lookup
      .mockResolvedValueOnce(null);        // uniqueness clash check → no clash

    const req = {
      headers: { get: (key: string) => (key === 'x-tenant-slug' ? TENANT_A : null) },
      url: `http://localhost/api/admin/users/${USER_ID}`,
      json: async () => ({ phone: NEW_PHONE }),
    } as unknown as Parameters<typeof PATCH>[0];

    const res = await PATCH(req, { params: makeParams() });
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: USER_ID }),
        data: expect.objectContaining({ phone: NEW_PHONE }),
      }),
    );
    expect(revokeAllSessionsForUser).toHaveBeenCalledTimes(1);
    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(USER_ID);
  });

  it('UI12: PATCH with same phone as current → revokeAllSessionsForUser NOT called', async () => {
    const SAME_PHONE = MOCK_USER.phone; // '9876543210'
    (prisma.user.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(MOCK_USER)  // tenant-scoped target lookup
      .mockResolvedValueOnce(null);      // clash check (shouldn't reach it, but safe)

    const req = {
      headers: { get: (key: string) => (key === 'x-tenant-slug' ? TENANT_A : null) },
      url: `http://localhost/api/admin/users/${USER_ID}`,
      json: async () => ({ phone: SAME_PHONE }),
    } as unknown as Parameters<typeof PATCH>[0];

    const res = await PATCH(req, { params: makeParams() });
    expect(res.status).toBe(200);
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it('UI13: PATCH with no phone field → revokeAllSessionsForUser NOT called', async () => {
    // makeRequest() sends { name: 'Updated Name' } — no phone field
    const res = await PATCH(makeRequest(), { params: makeParams() });
    expect(res.status).toBe(200);
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it('UI14: PATCH with phone already used by another user in same tenant → 409, update NOT called, no revoke', async () => {
    const TAKEN_PHONE = '5555555555';
    const CLASH_USER = { id: 'other-user', clientId: TENANT_A, phone: TAKEN_PHONE };

    (prisma.user.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(MOCK_USER)   // tenant-scoped target lookup
      .mockResolvedValueOnce(CLASH_USER); // clash check → phone taken

    const req = {
      headers: { get: (key: string) => (key === 'x-tenant-slug' ? TENANT_A : null) },
      url: `http://localhost/api/admin/users/${USER_ID}`,
      json: async () => ({ phone: TAKEN_PHONE }),
    } as unknown as Parameters<typeof PATCH>[0];

    const res = await PATCH(req, { params: makeParams() });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it('UI15: cross-tenant target (findFirst null) → 404, no revoke (unchanged tenant guard)', async () => {
    (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue(TENANT_B);
    (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const req = {
      headers: { get: (key: string) => (key === 'x-tenant-slug' ? TENANT_B : null) },
      url: `http://localhost/api/admin/users/${USER_ID}`,
      json: async () => ({ phone: '1234567890' }),
    } as unknown as Parameters<typeof PATCH>[0];

    const res = await PATCH(req, { params: makeParams() });
    expect(res.status).toBe(404);
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/users/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: ACTOR_ID, role: 'GIFSY_ADMIN' });
    (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue(TENANT_A);
    (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_USER);
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...MOCK_USER, status: 'INACTIVE' });
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it('UI9: returns 403 when role is CLIENT_ADMIN (Gifsy Admin only)', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: ACTOR_ID, role: 'CLIENT_ADMIN' });
    const res = await DELETE(makeRequest(), { params: makeParams() });
    expect(res.status).toBe(403);
  });

  it('UI10: returns 400 when deleting own account', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: USER_ID, role: 'GIFSY_ADMIN' });
    const res = await DELETE(makeRequest(), { params: makeParams() });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
  });

  it('UI5: does NOT call prisma.user.update when target user is in a different tenant → 404', async () => {
    (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue(TENANT_B);
    (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await DELETE(makeRequest(TENANT_B), { params: makeParams() });
    expect(res.status).toBe(404);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('UI6: calls prisma.user.update (soft-delete) when target user is in same tenant → 200', async () => {
    const res = await DELETE(makeRequest(), { params: makeParams() });
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: USER_ID }),
        data: expect.objectContaining({ status: 'INACTIVE' }),
      }),
    );
  });
});
