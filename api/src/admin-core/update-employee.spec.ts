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
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateEmployeeDto } from './dto/sales-users.dto';

const mockTx = {
  user: { update: jest.fn() },
  salesUser: { update: jest.fn() },
  auditLog: { create: jest.fn() },
};

const mockPrisma = {
  user: { findFirst: jest.fn(), update: jest.fn() },
  userSession: { updateMany: jest.fn() },
  salesUser: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  salesUserAssignment: { count: jest.fn() },
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
    // Role-change outlet/team guard (Option A): default to "no outlets, no team" so the
    // existing level-change tests pass through it; guard-specific tests override these.
    mockPrisma.salesUserAssignment.count.mockResolvedValue(0);
    mockPrisma.salesUser.count.mockResolvedValue(0);
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

  // ── Vacate a position (employee left): clear BOTH name and phone ─────────────
  describe('vacate / fill a position', () => {
    const active = () => ({
      id: 'su1', clientId: 'deoleo', hierarchyLevelId: 'lvl-so', employeeCode: 'Pune101', isActive: true,
      reportingToId: 'boss',
      user: { id: 'u1', role: 'SALES_SO', name: 'Ravi Kumar', phone: '9811111111', email: null, status: 'ACTIVE' },
    });
    const vacant = () => ({
      id: 'su1', clientId: 'deoleo', hierarchyLevelId: 'lvl-so', employeeCode: 'Pune101', isActive: false,
      reportingToId: 'boss',
      user: { id: 'u1', role: 'SALES_SO', name: '(vacant) Pune101', phone: '__vacant__:Pune101', email: null, status: 'INACTIVE' },
    });

    it('both blank → the SAME placeholder state the bulk upload writes + sessions revoked + phone freed + audit', async () => {
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce(active())
        .mockResolvedValueOnce({ id: 'su1', user: { id: 'u1' } });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 3 });

      const res = await service.updateEmployee(clientAdmin, 'su1', { name: '', phone: '' });

      // Login row: synthetic phone (frees the real number — only ACTIVE reserves it), placeholder
      // name, INACTIVE — values produced by the same helpers persistHierarchy uses.
      const userData = mockTx.user.update.mock.calls[0][0];
      expect(userData.where).toEqual({ id: 'u1' });
      expect(userData.data).toMatchObject({
        name: '(vacant) Pune101', phone: '__vacant__:Pune101', status: 'INACTIVE',
      });
      // Position: inactive, but code / level / reporting line untouched (no hierarchyLevelId /
      // reportingToId written) — and no outlet-assignment writes at all.
      expect(mockTx.salesUser.update).toHaveBeenCalledWith({ where: { id: 'su1' }, data: { isActive: false } });
      // No phone-clash lookup for a blank phone.
      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
      // K3: sessions revoked after commit (stamp-before-sweep).
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' }, data: { sessionsInvalidBefore: expect.any(Date) },
      });
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null }, data: { revokedAt: expect.any(Date) },
      });
      // Audit records who left.
      const audit = mockTx.auditLog.create.mock.calls[0][0].data;
      expect(audit).toMatchObject({ action: 'UPDATE', entityType: 'SALES_USER', entityId: 'su1', actorId: 'ca1' });
      expect(audit.metadata).toMatchObject({
        event: 'admin_edit_employee', employeeCode: 'Pune101', vacated: true,
        previous: { name: 'Ravi Kumar', phone: '9811111111' },
        changes: { name: '(vacant) Pune101', phone: '__vacant__:Pune101', status: 'INACTIVE' },
      });
      expect(res).toMatchObject({ vacated: true });
      expect(res).not.toHaveProperty('sessionRevokeFailures');
    });

    it('both blank (whitespace) is treated as blank too', async () => {
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce(active())
        .mockResolvedValueOnce({ id: 'su1', user: { id: 'u1' } });
      await service.updateEmployee(clientAdmin, 'su1', { name: '   ', phone: '' });
      expect(mockTx.user.update.mock.calls[0][0].data).toMatchObject({ status: 'INACTIVE' });
    });

    it('a revoke failure after the commit is reported loudly, not a 500', async () => {
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce(active())
        .mockResolvedValueOnce({ id: 'su1', user: { id: 'u1' } });
      mockPrisma.user.update.mockRejectedValueOnce(new Error('db down'));
      const res = await service.updateEmployee(clientAdmin, 'su1', { name: '', phone: '' });
      expect(res).toMatchObject({ vacated: true, sessionRevokeFailures: [{ userId: 'u1' }] });
      expect((res as { message?: string }).message).toMatch(/could not be signed out/);
    });

    it.each([
      ['name blank, phone missing', { name: '' }],
      ['phone blank, name missing', { phone: '' }],
      ['name blank, phone filled', { name: '', phone: '9822222222' }],
      ['phone blank, name filled', { name: 'Someone', phone: '' }],
    ])('only ONE cleared (%s) → 400 with plain words, nothing written', async (_l, dto) => {
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(active());
      const err = await service.updateEmployee(clientAdmin, 'su1', dto).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe(
        'To mark this position vacant, clear both the name and the phone. Otherwise enter a 10-digit phone.',
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('refill: a new name + phone on a vacant position → ACTIVE again, phone-uniqueness checked', async () => {
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce(vacant())
        .mockResolvedValueOnce({ id: 'su1', user: { id: 'u1' } });
      mockPrisma.user.findFirst.mockResolvedValueOnce(null); // no ACTIVE holder of the new phone

      await service.updateEmployee(clientAdmin, 'su1', { name: 'Asha New', phone: '9833333333' });

      expect(mockPrisma.user.findFirst.mock.calls[0][0].where).toEqual({
        phone: '9833333333', clientId: 'deoleo', status: 'ACTIVE', id: { not: 'u1' },
      });
      expect(mockTx.user.update.mock.calls[0][0].data).toMatchObject({
        name: 'Asha New', phone: '9833333333', status: 'ACTIVE',
      });
      expect(mockTx.salesUser.update).toHaveBeenCalledWith({ where: { id: 'su1' }, data: { isActive: true } });
      expect(mockTx.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({ filledVacantPosition: true });
    });

    it('refill: a phone already held by another ACTIVE user → Conflict, nothing written', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(vacant());
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'other' });
      await expect(
        service.updateEmployee(clientAdmin, 'su1', { name: 'Asha New', phone: '9833333333' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('refill: only a name (or only a phone) on a vacant position → 400', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(vacant());
      await expect(service.updateEmployee(clientAdmin, 'su1', { name: 'Asha New' })).rejects.toThrow(
        /fill this vacant position/,
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('a vacant position can still have its reporting line edited without being filled', async () => {
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce(vacant())
        .mockResolvedValueOnce({ id: 'boss2', clientId: 'deoleo' })
        .mockResolvedValueOnce({ id: 'su1', user: { id: 'u1' } });
      mockPrisma.salesUser.findMany.mockResolvedValueOnce([{ id: 'su1', reportingToId: 'boss' }, { id: 'boss2', reportingToId: null }]);
      await service.updateEmployee(clientAdmin, 'su1', { reportingToId: 'boss2' });
      expect(mockTx.salesUser.update).toHaveBeenCalledWith({ where: { id: 'su1' }, data: { reportingToId: 'boss2' } });
      expect(mockTx.user.update.mock.calls[0][0].data).not.toHaveProperty('status');
    });

    it('tenant scope: vacating an employee of another tenant 404s (no write, no revoke)', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);
      await expect(service.updateEmployee(clientAdmin, 'su-x', { name: '', phone: '' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockPrisma.salesUser.findFirst.mock.calls[0][0].where).toEqual({ id: 'su-x', clientId: 'deoleo' });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
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

describe('UpdateEmployeeDto validation (blank allowed for vacate)', () => {
  const errs = (body: object) => validateSync(plainToInstance(UpdateEmployeeDto, body)).map((e) => e.property);
  it('accepts blank name + blank phone (vacate)', () => {
    expect(errs({ name: '', phone: '' })).toEqual([]);
  });
  it('accepts a 10-digit phone and an omitted phone', () => {
    expect(errs({ phone: '9811111111' })).toEqual([]);
    expect(errs({ name: 'X' })).toEqual([]);
  });
  it('still rejects a malformed non-blank phone', () => {
    expect(errs({ phone: '12345' })).toEqual(['phone']);
    expect(errs({ phone: '   ' })).toEqual(['phone']);
  });
});
