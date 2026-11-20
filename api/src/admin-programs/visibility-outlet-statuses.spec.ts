// GET /v1/visibility/outlet-statuses (AMOUNT_UPLOAD Excel-record status per outlet + month).
// Before this route existed the sales outlets/tasks/dashboard calls 404'd and silently showed
// every outlet as "not captured". Covers: mode gate, month validation, partner refusal,
// sales-downline scoping (never another team's outlet), tenant scoping, comma-safe decoding.
//
// Run: npx jest src/admin-programs/visibility-outlet-statuses.spec.ts

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { VisibilityService, OUTLET_STATUS_MAX_CODES } from './visibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

jest.mock('../sales/sales-hierarchy.loader', () => ({
  loadSalesHierarchy: jest.fn().mockResolvedValue([
    { id: 'su-mgr', reportingToId: null, isActive: true },
    { id: 'su-rep', reportingToId: 'su-mgr', isActive: true },
  ]),
}));

const mockPrisma = {
  salesUser: { findFirst: jest.fn() },
  salesUserAssignment: { findMany: jest.fn() },
  outletVisibilityRecord: { findMany: jest.fn() },
};
const mockTenant = { resolveVisibilityEnabled: jest.fn(), resolveVisibilityCaptureMode: jest.fn() };

const svc = () => new VisibilityService(mockPrisma as unknown as PrismaService, mockTenant as unknown as TenantService);
const admin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 't1', phone: '0', name: 'CA' };
const rep: JwtPayload = { sub: 'u-mgr', role: 'SALES_ASM', clientId: 't1', phone: '0', name: 'ASM' };
const partner: JwtPayload = { sub: 'p1', role: 'WHOLESALER', clientId: 't1', phone: '0', name: 'P' };

const rec = (outletCode: string, status: string) => ({
  outletCode, status, dateOfCapture: new Date(Date.now() - 86_400_000), approvedBy: 'ops', capturedByEmployeeName: 'Rep A',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockTenant.resolveVisibilityEnabled.mockResolvedValue(true);
  mockTenant.resolveVisibilityCaptureMode.mockResolvedValue('AMOUNT_UPLOAD');
  mockPrisma.outletVisibilityRecord.findMany.mockResolvedValue([]);
});

const MONTH = new Date().toISOString().slice(0, 7);

describe('VisibilityService.getOutletStatuses', () => {
  it('returns outletCode → status for a tenant admin (tenant-scoped, month-scoped)', async () => {
    mockPrisma.outletVisibilityRecord.findMany.mockResolvedValue([rec('OC1', 'APPROVED'), rec('OC2', 'UNDER_REVIEW')]);
    const res = await svc().getOutletStatuses(admin, 'OC1,OC2,OC3', MONTH);
    expect(mockPrisma.outletVisibilityRecord.findMany.mock.calls[0][0].where).toEqual({
      clientId: 't1', month: MONTH, outletCode: { in: ['OC1', 'OC2', 'OC3'] },
    });
    expect(Object.keys(res)).toEqual(['OC1', 'OC2']);
    expect(res.OC1).toMatchObject({ status: 'APPROVED', approvedBy: 'ops', capturedByEmployeeName: 'Rep A' });
    expect(typeof res.OC1.dateOfCapture).toBe('string');
  });

  it('decodes each comma-separated segment (a code may itself contain a comma)', async () => {
    await svc().getOutletStatuses(admin, `${encodeURIComponent('A,1')},B`, MONTH);
    expect(mockPrisma.outletVisibilityRecord.findMany.mock.calls[0][0].where.outletCode.in).toEqual(['A,1', 'B']);
  });

  it('400s for a PHOTO_APPROVAL tenant (status lives in photo captures) — never a silent empty map', async () => {
    mockTenant.resolveVisibilityCaptureMode.mockResolvedValue('PHOTO_APPROVAL');
    await expect(svc().getOutletStatuses(admin, 'OC1', MONTH)).rejects.toThrow(BadRequestException);
    expect(mockPrisma.outletVisibilityRecord.findMany).not.toHaveBeenCalled();
  });

  it('403s when visibility is OFF for the tenant, and for a partner login', async () => {
    mockTenant.resolveVisibilityEnabled.mockResolvedValueOnce(false);
    await expect(svc().getOutletStatuses(admin, 'OC1', MONTH)).rejects.toThrow(ForbiddenException);
    await expect(svc().getOutletStatuses(partner, 'OC1', MONTH)).rejects.toThrow(ForbiddenException);
  });

  it('validates month and the code cap', async () => {
    await expect(svc().getOutletStatuses(admin, 'OC1', '2026-13')).rejects.toThrow(BadRequestException);
    await expect(svc().getOutletStatuses(admin, 'OC1', undefined)).rejects.toThrow(BadRequestException);
    const many = Array.from({ length: OUTLET_STATUS_MAX_CODES + 1 }, (_, i) => `C${i}`).join(',');
    await expect(svc().getOutletStatuses(admin, many, MONTH)).rejects.toThrow(BadRequestException);
    expect(await svc().getOutletStatuses(admin, '', MONTH)).toEqual({});
  });

  it('a SALES caller only gets outlets assigned in their downline (another team’s code is dropped)', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su-mgr' });
    mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
      { outlet: { outletCode: 'MINE1', clientId: 't1' } },
      { outlet: { outletCode: 'MINE2', clientId: 't1' } },
    ]);
    mockPrisma.outletVisibilityRecord.findMany.mockResolvedValue([rec('MINE1', 'PENDING')]);
    const res = await svc().getOutletStatuses(rep, 'MINE1,MINE2,OTHER_TEAM', MONTH);
    // Reach = the manager + their report (descendant walk).
    expect(mockPrisma.salesUserAssignment.findMany.mock.calls[0][0].where.salesUserId.in.sort()).toEqual(['su-mgr', 'su-rep']);
    expect(mockPrisma.outletVisibilityRecord.findMany.mock.calls[0][0].where.outletCode.in).toEqual(['MINE1', 'MINE2']);
    expect(Object.keys(res)).toEqual(['MINE1']);
  });

  it('a SALES caller with no reach in the requested codes gets {} without a record read', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su-mgr' });
    mockPrisma.salesUserAssignment.findMany.mockResolvedValue([]);
    expect(await svc().getOutletStatuses(rep, 'OTHER_TEAM', MONTH)).toEqual({});
    expect(mockPrisma.outletVisibilityRecord.findMany).not.toHaveBeenCalled();
  });
});
