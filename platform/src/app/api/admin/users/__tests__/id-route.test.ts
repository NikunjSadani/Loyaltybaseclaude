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

import { GET, PATCH, DELETE } from '../[id]/route';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

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
    vi.clearAllMocks();
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: ACTOR_ID, role: 'CLIENT_ADMIN' });
    (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue(TENANT_A);
    (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_USER);
  });

  it('UI7: returns 401 when unauthenticated', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const res = await GET(makeRequest(), { params: makeParams() });
    expect(res.status).toBe(401);
  });

  it('UI8: returns 403 when role is not GIFSY_ADMIN or CLIENT_ADMIN', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: ACTOR_ID, role: 'SSS' });
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
    vi.clearAllMocks();
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: ACTOR_ID, role: 'CLIENT_ADMIN' });
    (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue(TENANT_A);
    (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_USER);
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...MOCK_USER, name: 'Updated Name' });
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
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
});

describe('DELETE /api/admin/users/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: ACTOR_ID, role: 'GIFSY_ADMIN' });
    (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue(TENANT_A);
    (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_USER);
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...MOCK_USER, status: 'INACTIVE' });
    (prisma.auditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it('UI9: returns 403 when role is CLIENT_ADMIN (Gifsy Admin only)', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: ACTOR_ID, role: 'CLIENT_ADMIN' });
    const res = await DELETE(makeRequest(), { params: makeParams() });
    expect(res.status).toBe(403);
  });

  it('UI10: returns 400 when deleting own account', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockReturnValue({ userId: USER_ID, role: 'GIFSY_ADMIN' });
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
