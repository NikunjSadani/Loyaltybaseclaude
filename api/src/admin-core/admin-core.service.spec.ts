// Unit tests for AdminCoreService — ported admin sub-domains.
// Covers: user CRUD tenant-scoping, phone-change session revoke, soft delete,
// the GIFSY force-logout-all kill switch, and the bulk-resign transaction.
// Run: npx jest src/admin-core/admin-core.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { SalesNotificationsService } from '../notifications/sales-notifications.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockTx = {
  salesUser: { updateMany: jest.fn(), update: jest.fn(), upsert: jest.fn() },
  user: { updateMany: jest.fn(), upsert: jest.fn() },
  salesUserAssignment: { updateMany: jest.fn(), create: jest.fn() },
  salesHierarchyLevel: { upsert: jest.fn() },
  auditLog: { create: jest.fn() },
  programSetting: { upsert: jest.fn() },
};

const mockPrisma = {
  user: {
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  userSession: { updateMany: jest.fn() },
  salesUser: { findMany: jest.fn(), findFirst: jest.fn() },
  outlet: { findMany: jest.fn(), count: jest.fn() },
  kycSubmission: { count: jest.fn() },
  kycStatusHistory: { findMany: jest.fn() },
  programSetting: { findMany: jest.fn(), findFirst: jest.fn(), upsert: jest.fn() },
  pointExpiryConfig: {
    findFirst: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

const mockTenant = { resolveClient: jest.fn(), upsertClientConfig: jest.fn() };
const mockTenantSettings = {
  invalidate: jest.fn(),
  getVisibilityEnabledUncached: jest.fn().mockResolvedValue(true),
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
// A GIFSY_ADMIN operating from the platform (gifsy) context — NOT assumed into a tenant.
const gifsyHome: JwtPayload = { sub: 'admin0', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: '' };
const clientAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const misUser: JwtPayload  = { sub: 'mis1',  role: 'MIS_USER',     clientId: 'deoleo', phone: '', name: '' };

describe('AdminCoreService', () => {
  let service: AdminCoreService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminCoreService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        {
          provide: SalesNotificationsService,
          useValue: {
            outletsAssigned: jest.fn(),
            kycSubmittedForApproval: jest.fn(),
            kycBounced: jest.fn(),
            targetsUploaded: jest.fn(),
          },
        },
      ],
    }).compile();
    service = module.get(AdminCoreService);
  });

  describe('listUsers', () => {
    it('scopes the query to the caller clientId', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.user.count.mockResolvedValue(0);
      await service.listUsers(clientAdmin, {});
      const where = mockPrisma.user.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ clientId: 'deoleo' });
    });

    it('adds role/status/search filters when provided', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.user.count.mockResolvedValue(0);
      await service.listUsers(clientAdmin, { role: 'SALES_SO' as never, status: 'ACTIVE' as never, search: 'raj' });
      const where = mockPrisma.user.findMany.mock.calls[0][0].where;
      expect(where.clientId).toBe('deoleo');
      expect(where.role).toBe('SALES_SO');
      expect(where.status).toBe('ACTIVE');
      expect(where.OR).toHaveLength(3);
    });
  });

  describe('createUser', () => {
    it('rejects a duplicate phone within the tenant', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'dup' });
      await expect(
        service.createUser(clientAdmin, { phone: '9000000000', name: 'A', role: 'SALES_SO' as never }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates the user scoped to clientId and writes an audit log', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({ id: 'u1' });
      await service.createUser(clientAdmin, { phone: '9000000000', name: 'A', role: 'SALES_SO' as never });
      expect(mockPrisma.user.create.mock.calls[0][0].data.clientId).toBe('deoleo');
      expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    });

    // ── GLB-4 role-assignment guard ───────────────────────────────────────────
    it('GLB-4: CLIENT_ADMIN cannot create a GIFSY_ADMIN (privilege escalation)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null); // no duplicate
      await expect(
        service.createUser(clientAdmin, { phone: '9000000001', name: 'Evil', role: 'GIFSY_ADMIN' as never }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('GLB-4: CLIENT_ADMIN cannot create another CLIENT_ADMIN', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      await expect(
        service.createUser(clientAdmin, { phone: '9000000002', name: 'Evil2', role: 'CLIENT_ADMIN' as never }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('GLB-4: MIS_USER cannot create a GIFSY_ADMIN', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      await expect(
        service.createUser(misUser, { phone: '9000000003', name: 'Evil3', role: 'GIFSY_ADMIN' as never }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('GLB-4: GIFSY_ADMIN can freely create a CLIENT_ADMIN', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({ id: 'u2' });
      await expect(
        service.createUser(gifsy, { phone: '9000000004', name: 'LegitAdmin', role: 'CLIENT_ADMIN' as never }),
      ).resolves.toBeDefined();
    });

    it('GLB-4: CLIENT_ADMIN can create an in-tenant operational role (SALES_SO)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({ id: 'u3' });
      await expect(
        service.createUser(clientAdmin, { phone: '9000000005', name: 'Field', role: 'SALES_SO' as never }),
      ).resolves.toBeDefined();
    });

    // ── GIFSY-operator-in-tenant footgun: a GIFSY_ADMIN may only be MINTED from the
    //    platform (gifsy) context, never from an assumed tenant context ────────────
    it('platform GIFSY_ADMIN (clientId gifsy) CAN create a GIFSY_ADMIN', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({ id: 'u4' });
      await expect(
        service.createUser(gifsyHome, { phone: '9000000006', name: 'PlatformAdmin', role: 'GIFSY_ADMIN' as never }),
      ).resolves.toBeDefined();
    });

    it('GIFSY_ADMIN assumed into a tenant CANNOT create a GIFSY_ADMIN (mis-scoped-operator footgun)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null); // no duplicate
      await expect(
        service.createUser(gifsy, { phone: '9000000007', name: 'MisScoped', role: 'GIFSY_ADMIN' as never }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('GIFSY_ADMIN assumed into a tenant CAN still create a CLIENT_ADMIN (legit tenant-admin minting)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({ id: 'u5' });
      await expect(
        service.createUser(gifsy, { phone: '9000000008', name: 'TenantAdmin', role: 'CLIENT_ADMIN' as never }),
      ).resolves.toBeDefined();
    });
  });

  describe('getUser', () => {
    it('throws NotFound when the user is outside the tenant', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      await expect(service.getUser(clientAdmin, 'u1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('queries with the tenant clientId', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'u1' });
      await service.getUser(clientAdmin, 'u1');
      expect(mockPrisma.user.findFirst.mock.calls[0][0].where).toEqual({ id: 'u1', clientId: 'deoleo' });
    });
  });

  describe('updateUser', () => {
    it('throws NotFound for a user outside the tenant', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      await expect(service.updateUser(clientAdmin, 'u1', { name: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws Conflict when the new phone clashes with another user', async () => {
      mockPrisma.user.findFirst
        .mockResolvedValueOnce({ id: 'u1', phone: '1111111111' }) // target
        .mockResolvedValueOnce({ id: 'other' }); // clash
      await expect(
        service.updateUser(clientAdmin, 'u1', { phone: '2222222222' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('revokes all sessions for the user when the phone changes', async () => {
      mockPrisma.user.findFirst
        .mockResolvedValueOnce({ id: 'u1', phone: '1111111111' }) // target
        .mockResolvedValueOnce(null)                               // no clash
        .mockResolvedValueOnce({ id: 'u1', phone: '2222222222' }); // re-fetch after updateMany
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 2 });

      await service.updateUser(clientAdmin, 'u1', { phone: '2222222222' });

      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('does NOT revoke sessions when the phone is unchanged', async () => {
      mockPrisma.user.findFirst
        .mockResolvedValueOnce({ id: 'u1', phone: '1111111111' })  // target
        .mockResolvedValueOnce({ id: 'u1', phone: '1111111111' }); // re-fetch after updateMany
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
      await service.updateUser(clientAdmin, 'u1', { name: 'New Name' });
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });

    // ── GLB-4 role-assignment guard via updateUser ────────────────────────────
    it('GLB-4: CLIENT_ADMIN cannot escalate a user to GIFSY_ADMIN via updateUser', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'u1', phone: '1111111111' });
      await expect(
        service.updateUser(clientAdmin, 'u1', { role: 'GIFSY_ADMIN' as never }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // updateMany must NOT be called — the guard fires before any write
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('GLB-4: CLIENT_ADMIN cannot escalate a user to CLIENT_ADMIN via updateUser', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'u1', phone: '1111111111' });
      await expect(
        service.updateUser(clientAdmin, 'u1', { role: 'CLIENT_ADMIN' as never }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('GLB-4: a PLATFORM-context GIFSY_ADMIN CAN set role to GIFSY_ADMIN via updateUser', async () => {
      mockPrisma.user.findFirst
        .mockResolvedValueOnce({ id: 'u1', phone: '1111111111' })  // target
        .mockResolvedValueOnce({ id: 'u1', role: 'GIFSY_ADMIN' }); // re-fetch
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
      await expect(
        service.updateUser(gifsyHome, 'u1', { role: 'GIFSY_ADMIN' as never }),
      ).resolves.toBeDefined();
      expect(mockPrisma.user.updateMany).toHaveBeenCalled();
    });

    it('footgun: a TENANT-assumed GIFSY_ADMIN CANNOT promote a user to GIFSY_ADMIN via updateUser', async () => {
      // gifsy fixture has clientId:'deoleo' (assumed into a tenant) → the mis-scoped-operator
      // guard blocks GIFSY_ADMIN role assignment on the update path too, before any write.
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'u1', phone: '1111111111' });
      await expect(
        service.updateUser(gifsy, 'u1', { role: 'GIFSY_ADMIN' as never }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('GLB-4: GIFSY_ADMIN CAN set role to CLIENT_ADMIN via updateUser', async () => {
      mockPrisma.user.findFirst
        .mockResolvedValueOnce({ id: 'u1', phone: '1111111111' })   // target
        .mockResolvedValueOnce({ id: 'u1', role: 'CLIENT_ADMIN' }); // re-fetch
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
      await expect(
        service.updateUser(gifsy, 'u1', { role: 'CLIENT_ADMIN' as never }),
      ).resolves.toBeDefined();
      expect(mockPrisma.user.updateMany).toHaveBeenCalled();
    });

    it('GLB-4: CLIENT_ADMIN updating only non-role fields (name) still succeeds', async () => {
      mockPrisma.user.findFirst
        .mockResolvedValueOnce({ id: 'u1', phone: '1111111111' })  // target
        .mockResolvedValueOnce({ id: 'u1', name: 'New Name' });    // re-fetch
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
      const result = await service.updateUser(clientAdmin, 'u1', { name: 'New Name' });
      expect(result).toBeDefined();
      expect(mockPrisma.user.updateMany).toHaveBeenCalled();
    });

    // ── Self-deactivate + last-active-admin guards ────────────────────────────
    it('DEACT-1: deactivating your OWN account throws BadRequest (before any write)', async () => {
      // target is the caller themselves (id === user.sub)
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'ca1', phone: '1111111111', role: 'CLIENT_ADMIN' });
      await expect(
        service.updateUser(clientAdmin, 'ca1', { status: 'INACTIVE' as never }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('DEACT-2: deactivating the LAST active admin (count <= 1) throws BadRequest', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'u2', phone: '1111111111', role: 'CLIENT_ADMIN' });
      mockPrisma.user.count.mockResolvedValueOnce(1); // only one active admin remains
      await expect(
        service.updateUser(clientAdmin, 'u2', { status: 'INACTIVE' as never }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // the count must be tenant-scoped over admin roles
      const where = mockPrisma.user.count.mock.calls[0][0].where;
      expect(where).toEqual({
        clientId: 'deoleo',
        status: 'ACTIVE',
        role: { in: ['GIFSY_ADMIN', 'CLIENT_ADMIN'] },
      });
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('DEACT-3: deactivating a NON-last admin (count > 1) succeeds', async () => {
      mockPrisma.user.findFirst
        .mockResolvedValueOnce({ id: 'u2', phone: '1111111111', role: 'CLIENT_ADMIN' }) // target
        .mockResolvedValueOnce({ id: 'u2', status: 'INACTIVE' });                        // re-fetch
      mockPrisma.user.count.mockResolvedValueOnce(2); // more than one active admin
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
      await expect(
        service.updateUser(clientAdmin, 'u2', { status: 'INACTIVE' as never }),
      ).resolves.toBeDefined();
      expect(mockPrisma.user.updateMany).toHaveBeenCalled();
    });

    it('DEACT-4: deactivating a NON-admin (MIS_USER) succeeds and skips the admin count', async () => {
      mockPrisma.user.findFirst
        .mockResolvedValueOnce({ id: 'u3', phone: '1111111111', role: 'MIS_USER' }) // target
        .mockResolvedValueOnce({ id: 'u3', status: 'INACTIVE' });                    // re-fetch
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
      await expect(
        service.updateUser(clientAdmin, 'u3', { status: 'INACTIVE' as never }),
      ).resolves.toBeDefined();
      // the last-admin count must NOT run for a non-admin target
      expect(mockPrisma.user.count).not.toHaveBeenCalled();
      expect(mockPrisma.user.updateMany).toHaveBeenCalled();
    });

    it('DEACT-5: reactivating (status ACTIVE) is never blocked by the deactivation guards', async () => {
      // target is the caller AND the only admin — but status is ACTIVE, so no guard fires.
      mockPrisma.user.findFirst
        .mockResolvedValueOnce({ id: 'ca1', phone: '1111111111', role: 'CLIENT_ADMIN' }) // target (self)
        .mockResolvedValueOnce({ id: 'ca1', status: 'ACTIVE' });                          // re-fetch
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
      await expect(
        service.updateUser(clientAdmin, 'ca1', { status: 'ACTIVE' as never }),
      ).resolves.toBeDefined();
      expect(mockPrisma.user.count).not.toHaveBeenCalled();
      expect(mockPrisma.user.updateMany).toHaveBeenCalled();
    });

    it('DEACT-6: SUSPEND-ing your OWN account is ALSO blocked (guard covers non-ACTIVE, not just INACTIVE)', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'ca1', phone: '1111111111', role: 'CLIENT_ADMIN' });
      await expect(
        service.updateUser(clientAdmin, 'ca1', { status: 'SUSPENDED' as never }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('DEACT-7: SUSPEND-ing the LAST active admin is ALSO blocked (no bypass via SUSPENDED)', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'u2', phone: '1111111111', role: 'CLIENT_ADMIN' });
      mockPrisma.user.count.mockResolvedValueOnce(1);
      await expect(
        service.updateUser(clientAdmin, 'u2', { status: 'SUSPENDED' as never }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('deleteUser', () => {
    it('prevents deleting your own account', async () => {
      await expect(service.deleteUser(gifsy, 'admin1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('soft-deletes (status INACTIVE + deletedAt) and audits', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'u1' });
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
      await service.deleteUser(gifsy, 'u1');
      const call = mockPrisma.user.updateMany.mock.calls[0][0];
      expect(call.data.status).toBe('INACTIVE');
      expect(call.data.deletedAt).toBeInstanceOf(Date);
      // Confirm the write is scoped to both id AND clientId (defense-in-depth)
      expect(call.where).toEqual({ id: 'u1', clientId: 'deoleo' });
      expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    });
  });

  describe('forceLogoutAll', () => {
    it('revokes EVERY session globally (no userId/clientId filter) and audits with entityId ALL', async () => {
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 7 });
      const res = await service.forceLogoutAll(gifsy);

      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(res).toEqual({ message: 'All users logged out', revoked: 7 });

      const audit = mockPrisma.auditLog.create.mock.calls[0][0].data;
      expect(audit.action).toBe('LOGOUT');
      expect(audit.entityId).toBe('ALL');
      expect(audit.metadata).toMatchObject({ revoked: 7, reason: 'force-logout-all' });
    });
  });

  describe('bulkEditUsers (resign)', () => {
    it('rejects an empty employeeCodes list', async () => {
      await expect(
        service.bulkEditUsers(clientAdmin, { action: 'resign', employeeCodes: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('tenant-scopes the salesUser lookup via user.clientId', async () => {
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 's1', userId: 'u1', employeeCode: 'E1' }]);
      await service.bulkEditUsers(clientAdmin, { action: 'resign', employeeCodes: ['E1'] });
      const where = mockPrisma.salesUser.findMany.mock.calls[0][0].where;
      expect(where.user).toEqual({ clientId: 'deoleo' });
      expect(where.deletedAt).toBeNull();
    });

    it('runs the resign transaction (deactivate users + unassign + audit)', async () => {
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 's1', userId: 'u1', employeeCode: 'E1' }]);
      const res = await service.bulkEditUsers(clientAdmin, { action: 'resign', employeeCodes: ['E1', 'E2'] });
      expect(mockTx.salesUser.updateMany).toHaveBeenCalled();
      expect(mockTx.user.updateMany).toHaveBeenCalled();
      expect(mockTx.salesUserAssignment.updateMany).toHaveBeenCalled();
      expect(mockTx.auditLog.create).toHaveBeenCalled();
      expect(res).toEqual({ resigned: 1, notFound: 1 });
    });

    it('rejects an unknown action', async () => {
      await expect(
        service.bulkEditUsers(clientAdmin, { action: 'nope' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getTenantConfig', () => {
    it('returns only non-secret branding + features for the caller tenant', async () => {
      mockTenant.resolveClient.mockResolvedValue({
        slug: 'deoleo',
        name: 'Deoleo',
        isActive: true,
        branding: { primaryColor: '#000', displayName: 'Deoleo' },
        features: { loyalty: true },
      });
      const res = await service.getTenantConfig(clientAdmin);
      expect(mockTenant.resolveClient).toHaveBeenCalledWith('deoleo');
      expect(res).toEqual({
        slug: 'deoleo',
        internalName: 'Deoleo',
        status: 'ACTIVE',
        branding: { primaryColor: '#000', displayName: 'Deoleo' },
        features: { loyalty: true },
      });
    });
  });

  describe('getSettings', () => {
    it('merges stored rows over defaults, tenant-scoped', async () => {
      mockPrisma.programSetting.findMany.mockResolvedValue([
        { settingKey: 'conversionRate', settingValue: 5 },
      ]);
      const res = await service.getSettings(clientAdmin);
      expect(mockPrisma.programSetting.findMany.mock.calls[0][0].where).toEqual({ clientId: 'deoleo' });
      expect(res.settings.conversionRate).toBe(5);
      expect(res.settings.programName).toBe('Loyalty Program'); // default preserved
    });
  });

  describe('saveGiftConfig', () => {
    it('rejects a non-array gift body', async () => {
      await expect(service.saveGiftConfig(clientAdmin, { not: 'array' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // setVisibilityCaptureMode
  // ────────────────────────────────────────────────────────────────────────────
  describe('setVisibilityCaptureMode', () => {
    const baseConfig = {
      slug: 'deoleo',
      name: 'Deoleo',
      isActive: true,
      branding: { primaryColor: '#c00', displayName: 'Deoleo' },
      features: {
        loyalty: true,
        visibility: true,
        leaderboard: false,
        schemes: false,
        selfEnrollment: false,
        targets: true,
        rewards: true,
        tds: false,
        visibilityCaptureMode: 'PHOTO_APPROVAL' as const,
      },
    };

    beforeEach(() => {
      mockTenant.resolveClient.mockResolvedValue(structuredClone(baseConfig));
      mockTenant.upsertClientConfig.mockResolvedValue(undefined);
      mockPrisma.auditLog.create.mockResolvedValue({ id: 'al1' });
    });

    it('VCM1: sets mode to AMOUNT_UPLOAD and persists via upsertClientConfig', async () => {
      const res = await service.setVisibilityCaptureMode(gifsy, { mode: 'AMOUNT_UPLOAD' });
      expect(res).toEqual({ mode: 'AMOUNT_UPLOAD' });

      const savedConfig = mockTenant.upsertClientConfig.mock.calls[0][1];
      expect(savedConfig.features.visibilityCaptureMode).toBe('AMOUNT_UPLOAD');
    });

    it('VCM2: merges — does NOT clobber other feature flags when changing mode', async () => {
      await service.setVisibilityCaptureMode(gifsy, { mode: 'AMOUNT_UPLOAD' });

      const savedConfig = mockTenant.upsertClientConfig.mock.calls[0][1];
      // All other feature flags must remain intact
      expect(savedConfig.features.loyalty).toBe(true);
      expect(savedConfig.features.visibility).toBe(true);
      expect(savedConfig.features.rewards).toBe(true);
      expect(savedConfig.features.targets).toBe(true);
      // And branding is untouched
      expect(savedConfig.branding.primaryColor).toBe('#c00');
      expect(savedConfig.slug).toBe('deoleo');
    });

    it('VCM3: sets mode to PHOTO_APPROVAL (round-trip back)', async () => {
      // Start from AMOUNT_UPLOAD
      mockTenant.resolveClient.mockResolvedValueOnce({
        ...baseConfig,
        features: { ...baseConfig.features, visibilityCaptureMode: 'AMOUNT_UPLOAD' as const },
      });
      const res = await service.setVisibilityCaptureMode(gifsy, { mode: 'PHOTO_APPROVAL' });
      expect(res).toEqual({ mode: 'PHOTO_APPROVAL' });
      const savedConfig = mockTenant.upsertClientConfig.mock.calls[0][1];
      expect(savedConfig.features.visibilityCaptureMode).toBe('PHOTO_APPROVAL');
    });

    it('VCM4: calls upsertClientConfig with caller clientId (tenant-scoped)', async () => {
      await service.setVisibilityCaptureMode(gifsy, { mode: 'AMOUNT_UPLOAD' });
      expect(mockTenant.upsertClientConfig.mock.calls[0][0]).toBe('deoleo');
    });

    it('VCM5: writes an audit log entry with the new mode', async () => {
      await service.setVisibilityCaptureMode(gifsy, { mode: 'AMOUNT_UPLOAD' });
      const audit = mockPrisma.auditLog.create.mock.calls[0][0].data;
      expect(audit.action).toBe('UPDATE');
      expect(audit.entityType).toBe('CLIENT_CONFIG');
      expect(audit.actorId).toBe('admin1');
      expect(audit.metadata).toMatchObject({ key: 'visibilityCaptureMode', value: 'AMOUNT_UPLOAD' });
    });

    it('VCM6: propagates NotFoundException when the client config does not exist', async () => {
      mockTenant.resolveClient.mockRejectedValueOnce(new NotFoundException('Unknown client'));
      await expect(
        service.setVisibilityCaptureMode(gifsy, { mode: 'AMOUNT_UPLOAD' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // getPointsExpiry / setPointsExpiry — per-tenant default points-expiry config
  // ────────────────────────────────────────────────────────────────────────────
  describe('getPointsExpiry', () => {
    it('returns the active default config expiryDays, tenant-scoped', async () => {
      mockPrisma.pointExpiryConfig.findFirst.mockResolvedValue({ id: 'pe1', expiryDays: 90 });
      const res = await service.getPointsExpiry(clientAdmin);
      expect(mockPrisma.pointExpiryConfig.findFirst.mock.calls[0][0].where).toEqual({
        clientId: 'deoleo',
        isDefault: true,
        isActive: true,
      });
      expect(res).toEqual({ pointsExpiryDays: 90 });
    });

    it('returns null when there is no active default config (never expire)', async () => {
      mockPrisma.pointExpiryConfig.findFirst.mockResolvedValue(null);
      const res = await service.getPointsExpiry(clientAdmin);
      expect(res).toEqual({ pointsExpiryDays: null });
    });
  });

  describe('setPointsExpiry', () => {
    it('positive N + existing default → UPDATE that row to { expiryDays, isActive:true }', async () => {
      mockPrisma.pointExpiryConfig.findFirst.mockResolvedValue({ id: 'pe1', isDefault: true });
      mockPrisma.pointExpiryConfig.update.mockResolvedValue({ id: 'pe1' });
      const res = await service.setPointsExpiry(gifsy, { pointsExpiryDays: 120 });

      // find-then-update scoped to the tenant's default row (no upsert)
      expect(mockPrisma.pointExpiryConfig.findFirst.mock.calls[0][0].where).toEqual({
        clientId: 'deoleo',
        isDefault: true,
      });
      expect(mockPrisma.pointExpiryConfig.update).toHaveBeenCalledWith({
        where: { id: 'pe1' },
        data: { expiryDays: 120, isActive: true },
      });
      expect(mockPrisma.pointExpiryConfig.create).not.toHaveBeenCalled();
      expect(res).toEqual({ pointsExpiryDays: 120 });
    });

    it('positive N + no existing default → CREATE a default row', async () => {
      mockPrisma.pointExpiryConfig.findFirst.mockResolvedValue(null);
      mockPrisma.pointExpiryConfig.create.mockResolvedValue({ id: 'pe2' });
      const res = await service.setPointsExpiry(gifsy, { pointsExpiryDays: 30 });

      const data = mockPrisma.pointExpiryConfig.create.mock.calls[0][0].data;
      expect(data).toEqual({
        clientId: 'deoleo',
        schemeId: null,
        isDefault: true,
        isActive: true,
        expiryDays: 30,
        warningDaysBefore: 7,
      });
      expect(mockPrisma.pointExpiryConfig.update).not.toHaveBeenCalled();
      expect(res).toEqual({ pointsExpiryDays: 30 });
    });

    it('null → DEACTIVATE the default via updateMany (never expire; not deleted)', async () => {
      mockPrisma.pointExpiryConfig.updateMany.mockResolvedValue({ count: 1 });
      const res = await service.setPointsExpiry(gifsy, { pointsExpiryDays: null });

      expect(mockPrisma.pointExpiryConfig.updateMany).toHaveBeenCalledWith({
        where: { clientId: 'deoleo', isDefault: true },
        data: { isActive: false },
      });
      // No find/update/create on the null path
      expect(mockPrisma.pointExpiryConfig.update).not.toHaveBeenCalled();
      expect(mockPrisma.pointExpiryConfig.create).not.toHaveBeenCalled();
      expect(res).toEqual({ pointsExpiryDays: null });
    });

    it('writes a POINT_EXPIRY_CONFIG audit log entry with the new value', async () => {
      mockPrisma.pointExpiryConfig.findFirst.mockResolvedValue(null);
      mockPrisma.pointExpiryConfig.create.mockResolvedValue({ id: 'pe2' });
      await service.setPointsExpiry(gifsy, { pointsExpiryDays: 60 });
      const audit = mockPrisma.auditLog.create.mock.calls[0][0].data;
      expect(audit.action).toBe('UPDATE');
      expect(audit.entityType).toBe('POINT_EXPIRY_CONFIG');
      expect(audit.actorId).toBe('admin1');
      expect(audit.metadata).toMatchObject({ pointsExpiryDays: 60 });
    });

    it('rejects in the operator (gifsy) context — must assume a real tenant first', async () => {
      const gifsyHome = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'gifsy' } as never;
      await expect(
        service.setPointsExpiry(gifsyHome, { pointsExpiryDays: 90 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // no config write attempted for the pseudo-tenant
      expect(mockPrisma.pointExpiryConfig.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.pointExpiryConfig.create).not.toHaveBeenCalled();
      expect(mockPrisma.pointExpiryConfig.updateMany).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // kycDashboard — GET /v1/admin/dashboard/kyc (KYC program-health aggregation)
  // ────────────────────────────────────────────────────────────────────────────
  describe('kycDashboard', () => {
    const HOUR = 60 * 60 * 1000;
    const now = Date.now();

    /** Build an addressable-outlet fixture in the shape kycDashboard selects. */
    type Hist = { toStatus: string; createdAt: Date };
    const outlet = (opts: {
      status?: string | null; // null/undefined → NOT_STARTED (no submission)
      submittedAt?: Date | null;
      approvedAt?: Date | null;
      createdAt?: Date;
      history?: Hist[];
      state?: string | null;
      type?: string | null;
      program?: string | null;
    }) => {
      const sub =
        opts.status == null
          ? null
          : {
              status: opts.status,
              submittedAt: opts.submittedAt ?? null,
              approvedAt: opts.approvedAt ?? null,
              createdAt: opts.createdAt ?? new Date(now),
              statusHistory: opts.history ?? [],
            };
      return {
        id: Math.random().toString(36).slice(2),
        // Preserve an explicit null/'' the caller passes (do NOT ?? it away) so the
        // service's own null-handling (programName ?? 'Unassigned', empty→Unspecified)
        // is what's under test. Only `undefined` falls back to the default.
        state: opts.state === undefined ? 'KA' : opts.state,
        programName: opts.program === undefined ? 'P1' : opts.program,
        outletType: { code: opts.type === undefined ? 'SSS' : opts.type },
        partner: opts.status == null && !opts.history ? null : { kycSubmissions: sub ? [sub] : [] },
      };
    };

    /** Wire all the count/findMany mocks. Defaults model an empty tenant. */
    const wire = (opts: {
      outlets?: ReturnType<typeof outlet>[];
      notInterested?: number;
      inactive?: number;
      reUploadCount?: number;
      totalSubmissions?: number;
      rejectionHistory?: { notes: string | null }[];
    }) => {
      mockPrisma.outlet.findMany.mockResolvedValue(opts.outlets ?? []);
      // count is called 3× in order: notInterested, inactive, then NEVER outlet again.
      mockPrisma.outlet.count
        .mockResolvedValueOnce(opts.notInterested ?? 0)
        .mockResolvedValueOnce(opts.inactive ?? 0);
      mockPrisma.kycSubmission.count
        .mockResolvedValueOnce(opts.reUploadCount ?? 0) // RE_UPLOAD_REQUIRED
        .mockResolvedValueOnce(opts.totalSubmissions ?? 0); // total
      mockPrisma.kycStatusHistory.findMany.mockResolvedValue(opts.rejectionHistory ?? []);
      mockTenant.resolveClient.mockResolvedValue({ slug: 'deoleo' });
    };

    it('coverage formula: approved / addressable * 100, excludes NOT_INTERESTED from denom', async () => {
      wire({
        outlets: [
          outlet({ status: 'APPROVED', submittedAt: new Date(now - 10 * HOUR), approvedAt: new Date(now - 2 * HOUR) }),
          outlet({ status: 'APPROVED', submittedAt: new Date(now - 8 * HOUR), approvedAt: new Date(now - 1 * HOUR) }),
          outlet({ status: null }), // NOT_STARTED
          outlet({ status: 'PENDING_GIFSY' }),
        ],
        notInterested: 5, // must NOT enter the denominator
      });
      const res = await service.kycDashboard(clientAdmin);
      expect(res.universe.addressableOutlets).toBe(4);
      expect(res.universe.notInterested).toBe(5);
      expect(res.headline.coveragePct).toBe(50); // 2/4
      expect(res.headline.approved).toBe(2);
    });

    it('groups the FULL field-approval chain (SO/ASM/RSM) into pendingField + awaitingGifsy separately', async () => {
      wire({
        outlets: [
          outlet({ status: 'SUBMITTED' }),
          outlet({ status: 'UNDER_REVIEW' }),
          outlet({ status: 'PENDING_SO_APPROVAL' }),
          outlet({ status: 'PENDING_ASM_APPROVAL' }),
          outlet({ status: 'PENDING_RSM_APPROVAL' }),
          outlet({ status: 'PENDING_PENNY_DROP' }),
          outlet({ status: 'PENDING_AGREEMENT' }),
          outlet({ status: 'PENDING_GIFSY' }), // → awaitingGifsy, NOT pendingField
        ],
      });
      const res = await service.kycDashboard(clientAdmin);
      expect(res.headline.pendingField).toBe(7);
      expect(res.headline.awaitingGifsy).toBe(1);
      expect(res.headline.inPipeline).toBe(8);
    });

    it('folds REJECTED/RE_UPLOAD/RESUBMISSION/RE_KYC/SUSPENDED into rejectedOrReupload; DRAFT→inProgress', async () => {
      wire({
        outlets: [
          outlet({ status: 'REJECTED' }),
          outlet({ status: 'RE_UPLOAD_REQUIRED' }),
          outlet({ status: 'RESUBMISSION_REQUIRED' }),
          outlet({ status: 'RE_KYC_REQUIRED' }),
          outlet({ status: 'SUSPENDED' }),
          outlet({ status: 'DRAFT' }),
        ],
      });
      const res = await service.kycDashboard(clientAdmin);
      expect(res.headline.rejectedOrReupload).toBe(5);
      expect(res.funnel.find((s) => s.stage === 'In progress')?.count).toBe(1);
    });

    it('approvalRatePct uses approved / (approved + currently-REJECTED) — re-upload NOT in denom', async () => {
      wire({
        outlets: [
          outlet({ status: 'APPROVED' }),
          outlet({ status: 'APPROVED' }),
          outlet({ status: 'APPROVED' }),
          outlet({ status: 'REJECTED' }),
          outlet({ status: 'RE_UPLOAD_REQUIRED' }), // excluded from the rate denom
        ],
      });
      const res = await service.kycDashboard(clientAdmin);
      // 3 / (3 + 1) = 75
      expect(res.headline.approvalRatePct).toBe(75);
    });

    it('per-stage SLA: a >24h field-pending breaches; a >96h gifsy-pending breaches', async () => {
      wire({
        outlets: [
          // field-pending, submitted 30h ago → breach
          outlet({ status: 'SUBMITTED', submittedAt: new Date(now - 30 * HOUR) }),
          // field-pending, submitted 5h ago → within
          outlet({ status: 'PENDING_SO_APPROVAL', submittedAt: new Date(now - 5 * HOUR) }),
          // gifsy-pending, entered PENDING_GIFSY 100h ago → breach
          outlet({
            status: 'PENDING_GIFSY',
            history: [{ toStatus: 'PENDING_GIFSY', createdAt: new Date(now - 100 * HOUR) }],
          }),
          // gifsy-pending, entered PENDING_GIFSY 10h ago → within
          outlet({
            status: 'PENDING_GIFSY',
            history: [{ toStatus: 'PENDING_GIFSY', createdAt: new Date(now - 10 * HOUR) }],
          }),
        ],
      });
      const res = await service.kycDashboard(clientAdmin);
      expect(res.buckets.pendingFieldApproval).toMatchObject({ count: 2, withinSla: 1, breached: 1, slaHours: 24 });
      expect(res.buckets.pendingGifsyApproval).toMatchObject({ count: 2, withinSla: 1, breached: 1, slaHours: 96 });
    });

    it('sla block computes field/gifsy/end-to-end over APPROVED submissions with history', async () => {
      const submittedAt = new Date(now - 50 * HOUR);
      const enteredGifsy = new Date(now - 40 * HOUR); // fieldChain = 10h (<=24 → compliant)
      const approvedAt = new Date(now - 10 * HOUR); // gifsyReview = 30h (<=96 → compliant); e2e = 40h
      wire({
        outlets: [
          outlet({
            status: 'APPROVED',
            submittedAt,
            approvedAt,
            history: [{ toStatus: 'PENDING_GIFSY', createdAt: enteredGifsy }],
          }),
        ],
      });
      const res = await service.kycDashboard(clientAdmin);
      expect(res.sla.fieldChainAvgHours).toBe(10);
      expect(res.sla.gifsyReviewAvgHours).toBe(30);
      expect(res.sla.endToEndAvgHours).toBe(40);
      expect(res.sla.fieldCompliancePct).toBe(100);
      expect(res.sla.gifsyCompliancePct).toBe(100);
      expect(res.sla.sampleSize).toBe(1);
    });

    it('rejection reasons are tenant-filtered in the query and grouped (null→Unspecified, top 8)', async () => {
      wire({
        outlets: [],
        rejectionHistory: [
          { notes: 'Bad PAN' },
          { notes: 'Bad PAN' },
          { notes: 'Blurry cheque' },
          { notes: null },
        ],
      });
      const res = await service.kycDashboard(clientAdmin);
      // The history query MUST be tenant-scoped via kycSubmission → user.clientId
      const where = mockPrisma.kycStatusHistory.findMany.mock.calls[0][0].where;
      expect(where.toStatus).toBe('REJECTED');
      expect(where.kycSubmission).toEqual({ user: { clientId: 'deoleo' } });
      expect(res.quality.topRejectionReasons[0]).toEqual({ reason: 'Bad PAN', count: 2 });
      expect(res.quality.topRejectionReasons).toContainEqual({ reason: 'Unspecified', count: 1 });
      expect(res.quality.topRejectionReasons.length).toBeLessThanOrEqual(8);
    });

    it('reUploadRatePct = reUpload / totalSubmissions * 100', async () => {
      wire({ outlets: [], reUploadCount: 3, totalSubmissions: 12 });
      const res = await service.kycDashboard(clientAdmin);
      expect(res.quality.reUploadRatePct).toBe(25);
    });

    it('the addressable outlet query is tenant-scoped + excludes NOT_INTERESTED/deactivated/deleted but KEEPS pending', async () => {
      wire({ outlets: [] });
      await service.kycDashboard(clientAdmin);
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where.clientId).toBe('deoleo');
      expect(where.deletedAt).toBeNull();
      // Pending outlets (isActive=false, deactivatedAt=null) MUST stay in the universe;
      // only genuinely-deactivated/NI/deleted are excluded.
      expect(where.deactivatedAt).toBeNull();
      expect(where.isActive).toBeUndefined();
      // kycIntent exclusion uses an explicit OR so NULL rows (the vast majority)
      // are kept — Prisma's bare `{ not }` would drop them.
      expect(where.kycIntent).toBeUndefined();
      expect(where.OR).toEqual([{ kycIntent: null }, { kycIntent: { not: 'NOT_INTERESTED' } }]);
    });

    it('empty tenant → no NaN / divide-by-zero (coverage 0, compliance 100, rate 0)', async () => {
      wire({ outlets: [], notInterested: 0, inactive: 0, reUploadCount: 0, totalSubmissions: 0 });
      const res = await service.kycDashboard(clientAdmin);
      expect(res.universe.addressableOutlets).toBe(0);
      expect(res.headline.coveragePct).toBe(0);
      expect(res.headline.approvalRatePct).toBe(100); // denom 0 → 100
      expect(res.sla.fieldCompliancePct).toBe(100);
      expect(res.sla.gifsyCompliancePct).toBe(100);
      expect(res.sla.endToEndAvgHours).toBe(0);
      expect(res.quality.reUploadRatePct).toBe(0);
      expect(res.scope.tenant).toBe('deoleo');
      expect(typeof res.scope.generatedAt).toBe('string');
      // no NaN anywhere in the headline numbers
      for (const v of [res.headline.coveragePct, res.headline.approvalRatePct, res.headline.inPipeline]) {
        expect(Number.isNaN(v)).toBe(false);
      }
    });

    it('coverageBy groups by state/type/program with per-group coveragePct, empty key → Unspecified', async () => {
      wire({
        outlets: [
          outlet({ status: 'APPROVED', state: 'KA', type: 'SSS', program: 'P1' }),
          outlet({ status: 'PENDING_GIFSY', state: 'KA', type: 'SSS', program: 'P1' }),
          outlet({ status: 'APPROVED', state: '', type: 'WHOLESALER', program: null }),
        ],
      });
      const res = await service.kycDashboard(clientAdmin);
      const ka = res.coverageBy.state.find((e) => e.key === 'KA');
      expect(ka).toEqual({ key: 'KA', addressable: 2, approved: 1, coveragePct: 50 });
      // empty state string → 'Unspecified'
      expect(res.coverageBy.state.some((e) => e.key === 'Unspecified')).toBe(true);
      // null programName falls back to 'Unassigned' on the outlet, which is a non-empty key
      expect(res.coverageBy.program.some((e) => e.key === 'Unassigned')).toBe(true);
    });

    it('the funnel array is ordered Not started → In progress → Submitted → Pending Gifsy → Approved', async () => {
      wire({
        outlets: [
          outlet({ status: null }), // not started
          outlet({ status: 'DRAFT' }), // in progress
          outlet({ status: 'SUBMITTED' }), // field
          outlet({ status: 'PENDING_GIFSY' }),
          outlet({ status: 'APPROVED' }),
        ],
      });
      const res = await service.kycDashboard(clientAdmin);
      expect(res.funnel.map((f) => f.stage)).toEqual([
        'Not started',
        'In progress',
        'Submitted (field approval)',
        'Pending Gifsy',
        'Approved',
      ]);
      expect(res.funnel.map((f) => f.count)).toEqual([1, 1, 1, 1, 1]);
    });
  });
});
