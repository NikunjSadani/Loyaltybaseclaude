// Unit tests for AdminCoreService.updateEmployee — the single-record EMPLOYEE
// edit endpoint (PATCH /v1/admin/sales-users/:id). Mirrors the sibling
// admin-core.service.spec.ts style: mocked Prisma + a mocked $transaction.
// Run: npx jest src/admin-core/update-employee.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminCoreService } from './admin-core.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { SalesNotificationsService } from '../notifications/sales-notifications.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockTx = {
  user: { update: jest.fn() },
  salesUser: { update: jest.fn() },
  auditLog: { create: jest.fn() },
};

const mockPrisma = {
  user: { findFirst: jest.fn(), update: jest.fn() },
  userSession: { updateMany: jest.fn() },
  salesUser: { findFirst: jest.fn(), findMany: jest.fn() },
  salesHierarchyLevel: { findFirst: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

const mockTenant = { resolveClient: jest.fn(), invalidateCache: jest.fn() };
const mockTenantSettings = { invalidate: jest.fn(), getVisibilityEnabledUncached: jest.fn().mockResolvedValue(true) };

const clientAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };
// A GIFSY_STAFF operator — un-assumed, so clientId 'gifsy' (shares the owner's tenant).
const gifsyStaff: JwtPayload = { sub: 'st1', role: 'GIFSY_STAFF' as never, clientId: 'gifsy', phone: '', name: '', gifsyRoleId: 'r1' } as JwtPayload;

describe('AdminCoreService.updateEmployee', () => {
  let service: AdminCoreService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Safe defaults so revokeAllSessionsForUser never NPEs on result.count.
    mockPrisma.userSession.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.user.update.mockResolvedValue({});
    mockTx.user.update.mockResolvedValue({});
    mockTx.salesUser.update.mockResolvedValue({});
    mockTx.auditLog.create.mockResolvedValue({});
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminCoreService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: SalesNotificationsService, useValue: { outletsAssigned: jest.fn() } },
      ],
    }).compile();
    service = module.get(AdminCoreService);
  });

  // ── Tenant scope ────────────────────────────────────────────────────────────
  it('404s for a foreign-tenant / unknown SalesUser id (scoped to caller clientId)', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);
    await expect(service.updateEmployee(clientAdmin, 'su-other', { name: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockPrisma.salesUser.findFirst.mock.calls[0][0].where).toEqual({ id: 'su-other', clientId: 'deoleo' });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // ── Happy path: User + SalesUser updated together ─────────────────────────────
  it('updates the User and the SalesUser together in one transaction + audits', async () => {
    mockPrisma.salesUser.findFirst
      .mockResolvedValueOnce({
        id: 'su1', clientId: 'deoleo', hierarchyLevelId: 'lvl-so', employeeCode: 'E1',
        user: { id: 'u1', role: 'SALES_SO', phone: '1111111111', email: null, status: 'ACTIVE' },
      }) // load
      .mockResolvedValueOnce({ id: 'su1', user: { id: 'u1' } }); // re-fetch

    const res = await service.updateEmployee(clientAdmin, 'su1', { name: 'New Name', email: 'new@deoleo.com' });

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: expect.objectContaining({ name: 'New Name', email: 'new@deoleo.com' }),
    });
    expect(mockTx.salesUser.update).toHaveBeenCalledWith({ where: { id: 'su1' }, data: {} });
    const audit = mockTx.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('UPDATE');
    expect(audit.entityType).toBe('SALES_USER');
    expect(audit.entityId).toBe('su1');
    expect(res).toHaveProperty('employee');
    // No phone / role change → no session revoke.
    expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
  });

  // ── Phone change: uniqueness guard + in-place update + session revoke ─────────
  it('phone change: ACTIVE-scoped clash check, IN-PLACE User update (no create), and session revoke', async () => {
    mockPrisma.salesUser.findFirst
      .mockResolvedValueOnce({
        id: 'su1', clientId: 'deoleo', hierarchyLevelId: 'lvl-so', employeeCode: 'E1',
        user: { id: 'u1', role: 'SALES_SO', phone: '1111111111', email: null, status: 'ACTIVE' },
      })
      .mockResolvedValueOnce({ id: 'su1', user: { id: 'u1' } });
    mockPrisma.user.findFirst.mockResolvedValueOnce(null); // no ACTIVE clash
    mockPrisma.userSession.updateMany.mockResolvedValue({ count: 2 });

    await service.updateEmployee(clientAdmin, 'su1', { phone: '2222222222' });

    // Clash lookup is ACTIVE-scoped, excludes self.
    expect(mockPrisma.user.findFirst.mock.calls[0][0].where).toEqual({
      phone: '2222222222', clientId: 'deoleo', status: 'ACTIVE', id: { not: 'u1' },
    });
    // In-place update of the SAME User row by id — never a create.
    expect(mockTx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' }, data: expect.objectContaining({ phone: '2222222222' }),
    });
    // Sessions revoked (stamp-before-sweep via the shared helper).
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' }, data: { sessionsInvalidBefore: expect.any(Date) },
    });
    expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', revokedAt: null }, data: { revokedAt: expect.any(Date) },
    });
  });

  it('phone change: rejects a clash with another ACTIVE user (Conflict, before any write)', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValueOnce({
      id: 'su1', clientId: 'deoleo', hierarchyLevelId: 'lvl-so', employeeCode: 'E1',
      user: { id: 'u1', role: 'SALES_SO', phone: '1111111111', email: null, status: 'ACTIVE' },
    });
    mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'other' }); // clash
    await expect(service.updateEmployee(clientAdmin, 'su1', { phone: '2222222222' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('phone change: a racing P2002 on the ACTIVE-phone index maps to a clean 400 (not a 500)', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValueOnce({
      id: 'su1', clientId: 'deoleo', hierarchyLevelId: 'lvl-so', employeeCode: 'E1',
      user: { id: 'u1', role: 'SALES_SO', phone: '1111111111', email: null, status: 'ACTIVE' },
    });
    mockPrisma.user.findFirst.mockResolvedValueOnce(null); // pre-check passes
    mockPrisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002', clientVersion: 'test', meta: { target: 'users_clientId_phone_active_key' },
      }),
    );
    await expect(service.updateEmployee(clientAdmin, 'su1', { phone: '2222222222' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  // ── Level change: BOTH SalesUser.hierarchyLevelId and User.role + revoke ──────
  it('level change: updates SalesUser.hierarchyLevelId AND User.role, validates tenant, revokes sessions', async () => {
    mockPrisma.salesUser.findFirst
      .mockResolvedValueOnce({
        id: 'su1', clientId: 'deoleo', hierarchyLevelId: 'lvl-so', employeeCode: 'E1',
        user: { id: 'u1', role: 'SALES_SO', phone: '1111111111', email: null, status: 'ACTIVE' },
      })
      .mockResolvedValueOnce({ id: 'su1', user: { id: 'u1' } });
    // New level is ASM → coarse bucket SALES_ASM (differs from SALES_SO → role change).
    mockPrisma.salesHierarchyLevel.findFirst.mockResolvedValueOnce({ id: 'lvl-asm', code: 'ASM' });
    mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });

    await service.updateEmployee(clientAdmin, 'su1', { hierarchyLevelId: 'lvl-asm' });

    // Level lookup is tenant-scoped.
    expect(mockPrisma.salesHierarchyLevel.findFirst.mock.calls[0][0].where).toEqual({
      id: 'lvl-asm', clientId: 'deoleo',
    });
    // SalesUser fine level updated.
    expect(mockTx.salesUser.update).toHaveBeenCalledWith({
      where: { id: 'su1' }, data: { hierarchyLevelId: 'lvl-asm' },
    });
    // User coarse role updated in the SAME tx (drift trap closed).
    expect(mockTx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' }, data: expect.objectContaining({ role: 'SALES_ASM' }),
    });
    // Role changed → sessions revoked.
    expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', revokedAt: null }, data: { revokedAt: expect.any(Date) },
    });
  });

  it('level change: rejects a level that is not in the caller tenant', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValueOnce({
      id: 'su1', clientId: 'deoleo', hierarchyLevelId: 'lvl-so', employeeCode: 'E1',
      user: { id: 'u1', role: 'SALES_SO', phone: '1111111111', email: null, status: 'ACTIVE' },
    });
    mockPrisma.salesHierarchyLevel.findFirst.mockResolvedValueOnce(null); // not in tenant
    await expect(
      service.updateEmployee(clientAdmin, 'su1', { hierarchyLevelId: 'lvl-foreign' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // ── Reporting-to cycle guard ──────────────────────────────────────────────────
  it('reportingTo: rejects setting the employee as their OWN manager (self-cycle)', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValueOnce({
      id: 'su1', clientId: 'deoleo', hierarchyLevelId: 'lvl-so', employeeCode: 'E1',
      user: { id: 'u1', role: 'SALES_SO', phone: '1111111111', email: null, status: 'ACTIVE' },
    });
    await expect(
      service.updateEmployee(clientAdmin, 'su1', { reportingToId: 'su1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('reportingTo: rejects a manager inside the employee OWN subtree (descendant cycle)', async () => {
    mockPrisma.salesUser.findFirst
      .mockResolvedValueOnce({
        id: 'su1', clientId: 'deoleo', hierarchyLevelId: 'lvl-asm', employeeCode: 'E1',
        user: { id: 'u1', role: 'SALES_ASM', phone: '1111111111', email: null, status: 'ACTIVE' },
      })
      .mockResolvedValueOnce({ id: 'child', clientId: 'deoleo' }); // manager exists + active
    // Edge list: su1 → child → grandchild. Setting su1.reportingTo = child would cycle.
    mockPrisma.salesUser.findMany.mockResolvedValueOnce([
      { id: 'su1', reportingToId: null },
      { id: 'child', reportingToId: 'su1' },
      { id: 'grandchild', reportingToId: 'child' },
    ]);
    await expect(
      service.updateEmployee(clientAdmin, 'su1', { reportingToId: 'child' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('reportingTo: rejects a manager that does not exist / is inactive in the tenant', async () => {
    mockPrisma.salesUser.findFirst
      .mockResolvedValueOnce({
        id: 'su1', clientId: 'deoleo', hierarchyLevelId: 'lvl-so', employeeCode: 'E1',
        user: { id: 'u1', role: 'SALES_SO', phone: '1111111111', email: null, status: 'ACTIVE' },
      })
      .mockResolvedValueOnce(null); // manager not found / inactive
    await expect(
      service.updateEmployee(clientAdmin, 'su1', { reportingToId: 'ghost' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('reportingTo: a valid manager outside the subtree is accepted and written', async () => {
    mockPrisma.salesUser.findFirst
      .mockResolvedValueOnce({
        id: 'su1', clientId: 'deoleo', hierarchyLevelId: 'lvl-so', employeeCode: 'E1',
        user: { id: 'u1', role: 'SALES_SO', phone: '1111111111', email: null, status: 'ACTIVE' },
      })
      .mockResolvedValueOnce({ id: 'boss', clientId: 'deoleo' }) // manager exists + active
      .mockResolvedValueOnce({ id: 'su1', user: { id: 'u1' } }); // re-fetch
    mockPrisma.salesUser.findMany.mockResolvedValueOnce([
      { id: 'su1', reportingToId: null },
      { id: 'boss', reportingToId: null },
    ]);
    await service.updateEmployee(clientAdmin, 'su1', { reportingToId: 'boss' });
    expect(mockTx.salesUser.update).toHaveBeenCalledWith({
      where: { id: 'su1' }, data: { reportingToId: 'boss' },
    });
  });

  // ── Operator-row guard (assertCanManageTarget) ────────────────────────────────
  it('a GIFSY_STAFF cannot edit an employee whose linked User is an operator account', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValueOnce({
      id: 'su1', clientId: 'gifsy', hierarchyLevelId: 'lvl', employeeCode: 'E1',
      user: { id: 'owner', role: 'GIFSY_ADMIN', phone: '9830011252', email: null, status: 'ACTIVE' },
    });
    await expect(
      service.updateEmployee(gifsyStaff, 'su1', { name: 'X' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
