/**
 * Live DB smoke — Outlet Master upsert path (Part B).
 *
 * Exercises the SAME persistence path the /api/admin/outlets/upsert route uses:
 * resolve OutletType-by-code (tenant-scoped) + XSR-by-employeeCode (per-tenant),
 * upsert the Outlet on (clientId, outletCode), tag it to the XSR via
 * SalesUserAssignment. Seeds a tiny hierarchy via the real persistHierarchy.
 *
 * Requires the Auth Proxy on 127.0.0.1:5433 (see docs/plans/DEV-DB.md).
 * Run with: npm run test:integration. Cleans up everything it creates.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';
import { persistHierarchy } from '@/lib/hierarchy-persistence';
import { mapRowToOutletData, buildOutletCreate, buildOutletUpdate } from '@/lib/outlet-persist';
import type { OutletUploadRow, HierarchyEmployee, TenantHierarchyLevel } from '@/types';

const CLIENT = '__smoke_outlets__';
const OT_CODE = '__SMOKE_SSS__';

async function upsertRow(row: OutletUploadRow): Promise<{ status: 'OK' | 'ERROR'; errors: string[] }> {
  const errors: string[] = [];
  const outletCode = row.outletId.trim();

  const cfgs = await prisma.outletTypeClientConfig.findMany({
    where: { clientId: CLIENT, isEnabled: true },
    select: { outletType: { select: { id: true, code: true, isActive: true } } },
  });
  const typeIdByCode = new Map<string, string>();
  for (const c of cfgs) if (c.outletType.isActive) typeIdByCode.set(c.outletType.code.toUpperCase(), c.outletType.id);

  const outletTypeId = typeIdByCode.get((row.outletType ?? '').trim().toUpperCase());
  if (!outletTypeId) errors.push(`Unknown outlet type: ${row.outletType}`);

  let salesUserId: string | null = null;
  const xsrId = (row.xsrId ?? '').trim();
  if (xsrId) {
    const su = await prisma.salesUser.findUnique({
      where: { clientId_employeeCode: { clientId: CLIENT, employeeCode: xsrId } },
      select: { id: true },
    });
    if (!su) errors.push(`XSR ${xsrId} not found — upload the sales hierarchy first`);
    else salesUserId = su.id;
  }

  if (errors.length > 0 || !outletTypeId) return { status: 'ERROR', errors };

  const data = mapRowToOutletData(row, outletTypeId);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const outlet = await tx.outlet.upsert({
      where: { clientId_outletCode: { clientId: CLIENT, outletCode } },
      create: buildOutletCreate(CLIENT, outletCode, data),
      update: buildOutletUpdate(data),
    });
    if (salesUserId) {
      await tx.salesUserAssignment.updateMany({ where: { outletId: outlet.id, unassignedAt: null }, data: { unassignedAt: now } });
      await tx.salesUserAssignment.create({ data: { salesUserId, outletId: outlet.id, assignedAt: now } });
    }
  });
  return { status: 'OK', errors: [] };
}

async function cleanup() {
  const outlets = await prisma.outlet.findMany({ where: { clientId: CLIENT }, select: { id: true } });
  const ids = outlets.map((o) => o.id);
  if (ids.length) await prisma.salesUserAssignment.deleteMany({ where: { outletId: { in: ids } } });
  await prisma.outlet.deleteMany({ where: { clientId: CLIENT } });
  await prisma.outletTypeClientConfig.deleteMany({ where: { clientId: CLIENT } });
  await prisma.outletType.deleteMany({ where: { code: OT_CODE } });
  await prisma.salesUserAssignment.deleteMany({ where: { salesUser: { clientId: CLIENT } } });
  const sus = await prisma.salesUser.findMany({ where: { clientId: CLIENT }, select: { userId: true } });
  await prisma.salesUser.deleteMany({ where: { clientId: CLIENT } });
  if (sus.length) await prisma.user.deleteMany({ where: { id: { in: sus.map((s) => s.userId) } } });
  await prisma.salesHierarchyLevel.deleteMany({ where: { clientId: CLIENT } });
}

beforeAll(async () => {
  await prisma.$connect();
  await cleanup();

  const config: TenantHierarchyLevel[] = [
    { tenantId: CLIENT, level: 1, roleCode: 'XSR', roleLabel: 'Field Rep', isLeaf: true, isRoot: false },
  ];
  const employees: HierarchyEmployee[] = [
    { id: 'XSR-SMOKE-1', tenantId: CLIENT, roleCode: 'XSR', roleLabel: 'Field Rep', reportsToId: null,
      hierarchyPath: '/XSR-SMOKE-1/', name: 'Smoke Rep', mobile: '9000000001', status: 'ACTIVE',
      hasOutlets: false, hasSubReports: false },
  ];
  await persistHierarchy(CLIENT, employees, config, prisma);

  const ot = await prisma.outletType.create({ data: { code: OT_CODE, name: 'Smoke SSS' } });
  await prisma.outletTypeClientConfig.create({ data: { clientId: CLIENT, outletTypeId: ot.id, isEnabled: true } });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const validRow: OutletUploadRow = {
  rowNum: 2, outletId: 'SMOKE-OUT-1', outletName: 'Smoke Mart', programName: 'Trade Loyalty',
  programCategory: 'Standard', outletType: OT_CODE, beat: 'Beat-A', distributorId: 'DIST-9',
  distributorName: 'Smoke Distributors', metro: 'Yes', city: 'Mumbai', state: 'MH', zone: 'West Zone', xsrId: 'XSR-SMOKE-1',
};
const badXsrRow: OutletUploadRow = { ...validRow, rowNum: 3, outletId: 'SMOKE-OUT-2', outletName: 'Ghost Mart', xsrId: 'XSR-NOPE' };

describe('Outlet upsert live smoke', () => {
  it('persists a valid row: clientId set, partnerId null, isActive false, reference cols mapped', async () => {
    const r = await upsertRow(validRow);
    expect(r.status).toBe('OK');

    const o = await prisma.outlet.findUnique({
      where: { clientId_outletCode: { clientId: CLIENT, outletCode: 'SMOKE-OUT-1' } },
    });
    expect(o).not.toBeNull();
    expect(o!.clientId).toBe(CLIENT);
    expect(o!.partnerId).toBeNull();        // owner attached at KYC
    expect(o!.isActive).toBe(false);        // PENDING
    expect(o!.distributorCode).toBe('DIST-9');
    expect(o!.distributorName).toBe('Smoke Distributors');
    expect(o!.beat).toBe('Beat-A');
    expect(o!.metro).toBe('Yes');
    expect(o!.zone).toBe('West Zone');
    expect(o!.programName).toBe('Trade Loyalty');
    expect(o!.programCategory).toBe('Standard');
    expect(o!.addressLine1).toBeNull();     // KYC-captured
    expect(o!.pincode).toBeNull();
  });

  it('tags the valid outlet to the resolved XSR via an active SalesUserAssignment', async () => {
    const o = await prisma.outlet.findUnique({
      where: { clientId_outletCode: { clientId: CLIENT, outletCode: 'SMOKE-OUT-1' } },
      include: { salesAssignments: { where: { unassignedAt: null }, include: { salesUser: true } } },
    });
    expect(o!.salesAssignments).toHaveLength(1);
    expect(o!.salesAssignments[0].salesUser.employeeCode).toBe('XSR-SMOKE-1');
  });

  it('rejects the bad-XSR row and does NOT create the outlet', async () => {
    const r = await upsertRow(badXsrRow);
    expect(r.status).toBe('ERROR');
    expect(r.errors[0]).toContain('XSR XSR-NOPE not found');

    const ghost = await prisma.outlet.findUnique({
      where: { clientId_outletCode: { clientId: CLIENT, outletCode: 'SMOKE-OUT-2' } },
    });
    expect(ghost).toBeNull();
  });

  it('is idempotent: re-running the valid row keeps exactly one active assignment', async () => {
    await upsertRow(validRow);
    const o = await prisma.outlet.findUnique({
      where: { clientId_outletCode: { clientId: CLIENT, outletCode: 'SMOKE-OUT-1' } },
      include: { salesAssignments: { where: { unassignedAt: null } } },
    });
    const allOutlets = await prisma.outlet.count({ where: { clientId: CLIENT } });
    expect(allOutlets).toBe(1);
    expect(o!.salesAssignments).toHaveLength(1); // prior active assignment was closed first
  });
});
