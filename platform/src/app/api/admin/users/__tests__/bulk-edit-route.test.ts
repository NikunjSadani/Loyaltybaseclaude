/// <reference types="vitest/globals" />
/**
 * TDD — POST /api/admin/users/bulk-edit  (Task 2.2 harden)
 *
 * Focus: tenant isolation on the `reassign_outlet` action.
 *
 * Defect found in audit (now fixed):
 *   The new-XSR lookup was `findFirst({ employeeCode, deletedAt:null, isActive:true })`
 *   with NO clientId — so an admin of tenant A could reassign their outlets to a
 *   sales user belonging to tenant B (a cross-tenant SalesUserAssignment).
 *   The outlet lookup also used `partner:{user:{clientId}}` which silently misses
 *   ownerless (uploaded, pre-KYC) outlets.
 *
 * BE1: resign  — salesUser.findMany is scoped by user.clientId
 * BE2: reassign — the new-XSR lookup is scoped by clientId (closes the cross-tenant hole)
 * BE3: reassign — the outlet lookup is scoped by the outlet's OWN clientId (not partner join)
 * BE4: reassign — when the XSR is cross-tenant (lookup returns null) the route 400s
 *                 and creates NO SalesUserAssignment
 * BE5: reassign — happy path creates an assignment to the resolved (same-tenant) XSR
 * BE6: auth/role gates (401 unauth, 403 non-admin)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { txFns, prismaMock } = vi.hoisted(() => {
  const txFns = {
    salesUser:           { updateMany: vi.fn() },
    user:                { updateMany: vi.fn() },
    salesUserAssignment: { updateMany: vi.fn(), create: vi.fn() },
    auditLog:            { create: vi.fn() },
  };
  const prismaMock = {
    salesUser:           { findMany: vi.fn(), findFirst: vi.fn() },
    outlet:              { findMany: vi.fn() },
    salesUserAssignment: { updateMany: vi.fn(), create: vi.fn() },
    auditLog:            { create: vi.fn() },
    $transaction: vi.fn(async (cb: any) => cb(txFns)),
  };
  return { txFns, prismaMock };
});

vi.mock('@/lib/prisma', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ getAuthUser: vi.fn() }));
vi.mock('@/lib/tenant', () => ({ getClientIdFromRequest: vi.fn() }));
vi.mock('@/lib/rbac/require-permission', () => ({ requirePermission: vi.fn().mockResolvedValue(null) }));

import { POST } from '../bulk-edit/route';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const TENANT_A = 'tenant-a';

function makeRequest(body: unknown, tenant = TENANT_A) {
  return {
    headers: { get: (k: string) => (k === 'x-tenant-slug' ? tenant : null) },
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DEMO_MODE;
  (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 'actor1', role: 'CLIENT_ADMIN' });
  (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue(TENANT_A);
});

describe('bulk-edit auth/role gates', () => {
  it('BE6a: 401 when unauthenticated', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST(makeRequest({ action: 'resign', employeeCodes: ['E1'] }));
    expect(res.status).toBe(401);
  });

  it('BE6b: 403 when role is not an admin', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 'actor1', role: 'SSS' });
    const res = await POST(makeRequest({ action: 'resign', employeeCodes: ['E1'] }));
    expect(res.status).toBe(403);
  });
});

describe('bulk-edit resign — tenant scope', () => {
  it('BE1: scopes the salesUser lookup by user.clientId', async () => {
    prismaMock.salesUser.findMany.mockResolvedValue([{ id: 's1', userId: 'u1', employeeCode: 'E1' }]);
    const res = await POST(makeRequest({ action: 'resign', employeeCodes: ['E1'] }));
    expect(res.status).toBe(200);
    expect(prismaMock.salesUser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ user: { clientId: TENANT_A } }),
      }),
    );
  });
});

describe('bulk-edit reassign_outlet — tenant scope', () => {
  it('BE2: scopes the new-XSR lookup by clientId (closes cross-tenant hole)', async () => {
    prismaMock.salesUser.findFirst.mockResolvedValue({ id: 'xsr1' });
    prismaMock.outlet.findMany.mockResolvedValue([{ id: 'o1', partnerId: 'p1' }]);

    await POST(makeRequest({ action: 'reassign_outlet', outletIds: ['o1'], newXsrEmployeeCode: 'X1' }));

    expect(prismaMock.salesUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ employeeCode: 'X1', clientId: TENANT_A }),
      }),
    );
  });

  it('BE3: scopes the outlet lookup by the outlet OWN clientId (not a partner join)', async () => {
    prismaMock.salesUser.findFirst.mockResolvedValue({ id: 'xsr1' });
    prismaMock.outlet.findMany.mockResolvedValue([{ id: 'o1', partnerId: null }]);

    await POST(makeRequest({ action: 'reassign_outlet', outletIds: ['o1'], newXsrEmployeeCode: 'X1' }));

    const call = prismaMock.outlet.findMany.mock.calls[0][0];
    expect(call.where.clientId).toBe(TENANT_A);
    // must NOT use the partner→user join that misses ownerless outlets
    expect(call.where.partner).toBeUndefined();
  });

  it('BE4: cross-tenant XSR (lookup returns null) → 400, no assignment created', async () => {
    prismaMock.salesUser.findFirst.mockResolvedValue(null); // tenant scope excluded the foreign XSR
    const res = await POST(makeRequest({ action: 'reassign_outlet', outletIds: ['o1'], newXsrEmployeeCode: 'X1' }));
    expect(res.status).toBe(400);
    expect(prismaMock.outlet.findMany).not.toHaveBeenCalled();
    expect(txFns.salesUserAssignment.create).not.toHaveBeenCalled();
  });

  it('BE5: happy path creates an assignment to the resolved same-tenant XSR', async () => {
    prismaMock.salesUser.findFirst.mockResolvedValue({ id: 'xsr1' });
    prismaMock.outlet.findMany.mockResolvedValue([{ id: 'o1', partnerId: 'p1' }]);

    const res = await POST(makeRequest({ action: 'reassign_outlet', outletIds: ['o1'], newXsrEmployeeCode: 'X1' }));
    expect(res.status).toBe(200);
    expect(txFns.salesUserAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ salesUserId: 'xsr1', outletId: 'o1' }),
      }),
    );
  });
});
