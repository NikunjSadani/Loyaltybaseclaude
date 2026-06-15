/// <reference types="vitest/globals" />
/**
 * TDD — outlet lifecycle routes (Task 2.5 harden):
 *   POST /api/admin/outlets/deactivate
 *   POST /api/admin/outlets/reactivate
 *   POST /api/admin/outlets/bulk-delete
 *
 * Defect found in audit (now fixed):
 *   All three scoped outlets via `partner: { user: { clientId } }`. After 2.4,
 *   Outlet carries its OWN clientId and outlets uploaded via the master file
 *   have NO partner until KYC. The partner-join therefore SILENTLY EXCLUDED
 *   every ownerless (pre-KYC) outlet — they could never be deactivated /
 *   reactivated / bulk-deleted. Fix: scope by `where: { clientId, ... }` directly.
 *
 * OL1: deactivate scopes by outlet.clientId directly (no partner join)
 * OL2: reactivate scopes by outlet.clientId directly (no partner join)
 * OL3: bulk-delete scopes by outlet.clientId directly (no partner join)
 * OL4: an ownerless outlet (partnerId null) IS matched + deactivated
 * OL5: deactivate closes open SalesUserAssignments for the matched outlets
 * OL6: auth/role gates
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { txFns, prismaMock } = vi.hoisted(() => {
  const txFns = {
    outlet:              { updateMany: vi.fn() },
    salesUserAssignment: { updateMany: vi.fn() },
    auditLog:            { create: vi.fn() },
  };
  const prismaMock = {
    outlet:              { findMany: vi.fn(), updateMany: vi.fn() },
    salesUserAssignment: { updateMany: vi.fn() },
    auditLog:            { create: vi.fn() },
    $transaction: vi.fn(async (cb: any) => cb(txFns)),
  };
  return { txFns, prismaMock };
});

vi.mock('@/lib/prisma', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ getAuthUser: vi.fn() }));
vi.mock('@/lib/tenant', () => ({ getClientIdFromRequest: vi.fn() }));
vi.mock('@/lib/rbac/require-permission', () => ({ requirePermission: vi.fn().mockResolvedValue(null) }));

import { POST as deactivate } from '../deactivate/route';
import { POST as reactivate } from '../reactivate/route';
import { POST as bulkDelete } from '../bulk-delete/route';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const TENANT_A = 'tenant-a';

function makeRequest(body: unknown, tenant = TENANT_A) {
  return {
    headers: { get: (k: string) => (k === 'x-tenant-slug' ? tenant : null) },
    json: async () => body,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DEMO_MODE;
  (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 'actor1', role: 'CLIENT_ADMIN' });
  (getClientIdFromRequest as ReturnType<typeof vi.fn>).mockReturnValue(TENANT_A);
});

describe('outlet lifecycle — direct clientId scoping (closes ownerless-outlet hole)', () => {
  it('OL1: deactivate scopes by outlet.clientId directly, never a partner join', async () => {
    prismaMock.outlet.findMany.mockResolvedValue([{ id: 'o1', outletCode: 'OUT-1' }]);
    const res = await deactivate(makeRequest({ outletCodes: ['OUT-1'] }));
    expect(res.status).toBe(200);
    const where = prismaMock.outlet.findMany.mock.calls[0][0].where;
    expect(where.clientId).toBe(TENANT_A);
    expect(where.partner).toBeUndefined();
  });

  it('OL2: reactivate scopes by outlet.clientId directly, never a partner join', async () => {
    prismaMock.outlet.findMany.mockResolvedValue([{ id: 'o1', outletCode: 'OUT-1' }]);
    const res = await reactivate(makeRequest({ outletCodes: ['OUT-1'] }));
    expect(res.status).toBe(200);
    const where = prismaMock.outlet.findMany.mock.calls[0][0].where;
    expect(where.clientId).toBe(TENANT_A);
    expect(where.partner).toBeUndefined();
  });

  it('OL3: bulk-delete scopes by outlet.clientId directly, never a partner join', async () => {
    prismaMock.outlet.findMany.mockResolvedValue([{ id: 'o1' }]);
    const res = await bulkDelete(makeRequest({ outletIds: ['o1'] }));
    expect(res.status).toBe(200);
    const where = prismaMock.outlet.findMany.mock.calls[0][0].where;
    expect(where.clientId).toBe(TENANT_A);
    expect(where.partner).toBeUndefined();
  });

  it('OL4: an ownerless outlet (partnerId null) is matched + deactivated', async () => {
    // The fixed query returns the ownerless outlet because it filters on the
    // outlet OWN clientId, not on a partner relation that does not exist yet.
    prismaMock.outlet.findMany.mockResolvedValue([{ id: 'o_ownerless', outletCode: 'OUT-PRE-KYC' }]);
    const res = await deactivate(makeRequest({ outletCodes: ['OUT-PRE-KYC'] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.deactivated).toBe(1);
    expect(txFns.outlet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['o_ownerless'] } } }),
    );
  });

  it('OL5: deactivate closes open SalesUserAssignments for the matched outlets', async () => {
    prismaMock.outlet.findMany.mockResolvedValue([{ id: 'o1', outletCode: 'OUT-1' }]);
    await deactivate(makeRequest({ outletCodes: ['OUT-1'] }));
    expect(txFns.salesUserAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ outletId: { in: ['o1'] }, unassignedAt: null }),
      }),
    );
  });
});

describe('outlet lifecycle — auth/role gates', () => {
  it('OL6a: 401 when unauthenticated', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await deactivate(makeRequest({ outletCodes: ['OUT-1'] }));
    expect(res.status).toBe(401);
  });

  it('OL6b: 403 when role is not an admin', async () => {
    (getAuthUser as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 'actor1', role: 'SSS' });
    const res = await bulkDelete(makeRequest({ outletIds: ['o1'] }));
    expect(res.status).toBe(403);
  });
});
