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
import { Prisma } from '@prisma/client';
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
  programSetting: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), upsert: jest.fn() },
  pointExpiryConfig: {
    findFirst: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  },
  auditLog: { create: jest.fn() },
  client: { update: jest.fn(), findUnique: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

const mockTenant = { resolveClient: jest.fn(), invalidateCache: jest.fn() };
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

    it('scopes the phone-existence check to ACTIVE holders only (a freed number is reusable)', async () => {
      // Only an ACTIVE user reserves the number, so the pre-check must carry status:'ACTIVE'.
      mockPrisma.user.findFirst.mockResolvedValue(null); // no ACTIVE holder
      mockPrisma.user.create.mockResolvedValue({ id: 'u1' });
      await service.createUser(clientAdmin, { phone: '9000000000', name: 'A', role: 'SALES_SO' as never });
      expect(mockPrisma.user.findFirst.mock.calls[0][0].where).toEqual({
        phone: '9000000000',
        clientId: 'deoleo',
        status: 'ACTIVE',
      });
    });

    it('does NOT collide when the only holder of the phone is INACTIVE (create proceeds)', async () => {
      // An INACTIVE holder no longer matches the ACTIVE-scoped pre-check → the DB returns null,
      // so the create goes through (the freed number is reused).
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({ id: 'u1' });
      await expect(
        service.createUser(clientAdmin, { phone: '9000000000', name: 'A', role: 'SALES_SO' as never }),
      ).resolves.toBeDefined();
      expect(mockPrisma.user.create).toHaveBeenCalled();
    });

    it('maps a racing active-phone P2002 on create to a clean 400 (not a 500)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null); // pre-check sees no ACTIVE holder
      mockPrisma.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: 'users_clientId_phone_active_key' },
        }),
      );
      await expect(
        service.createUser(clientAdmin, { phone: '9000000000', name: 'A', role: 'SALES_SO' as never }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a duplicate email within the tenant (clean 400, not a P2002 → 500)', async () => {
      mockPrisma.user.findFirst
        .mockResolvedValueOnce(null)          // phone free
        .mockResolvedValueOnce({ id: 'dup' }); // email taken
      await expect(
        service.createUser(clientAdmin, {
          phone: '9000000000', name: 'A', role: 'SALES_SO' as never, email: 'taken@deoleo.com',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
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

    it('throws Conflict when the new email clashes with another user (clean 409, not P2002 → 500)', async () => {
      mockPrisma.user.findFirst
        .mockResolvedValueOnce({ id: 'u1', phone: '1111111111', email: 'old@deoleo.com' }) // target
        .mockResolvedValueOnce({ id: 'other' }); // email clash
      await expect(
        service.updateUser(clientAdmin, 'u1', { email: 'taken@deoleo.com' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
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
      // target is the caller AND the only admin — but status is ACTIVE, so the self-deactivate
      // and last-admin guards never fire. The ONLY count on this path is the reactivation phone
      // re-check (see REACT-*), not the last-admin count — assert its shape to prove that.
      mockPrisma.user.findFirst
        .mockResolvedValueOnce({ id: 'ca1', phone: '1111111111', role: 'CLIENT_ADMIN', status: 'INACTIVE' }) // target (self)
        .mockResolvedValueOnce({ id: 'ca1', status: 'ACTIVE' });                                              // re-fetch
      mockPrisma.user.count.mockResolvedValueOnce(0); // no other ACTIVE holder of the phone
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
      await expect(
        service.updateUser(clientAdmin, 'ca1', { status: 'ACTIVE' as never }),
      ).resolves.toBeDefined();
      // The single count is the phone re-check (no role / in-roles filter → not the last-admin guard).
      expect(mockPrisma.user.count).toHaveBeenCalledTimes(1);
      expect(mockPrisma.user.count.mock.calls[0][0].where).toEqual({
        clientId: 'deoleo',
        phone: '1111111111',
        status: 'ACTIVE',
        id: { not: 'ca1' },
      });
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

    // ── Phone freed on deactivation: ACTIVE-scoped clash guard + reactivation re-check ──────────
    it('PHONE-1: the phone-clash guard collides only with an ACTIVE holder (freed numbers reusable)', async () => {
      mockPrisma.user.findFirst
        .mockResolvedValueOnce({ id: 'u1', phone: '1111111111', status: 'ACTIVE' }) // target
        .mockResolvedValueOnce(null)                                                 // no ACTIVE clash
        .mockResolvedValueOnce({ id: 'u1', phone: '2222222222' });                   // re-fetch
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
      await service.updateUser(clientAdmin, 'u1', { phone: '2222222222' });
      // The clash lookup (2nd findFirst) must be scoped to ACTIVE holders, excluding self.
      expect(mockPrisma.user.findFirst.mock.calls[1][0].where).toEqual({
        phone: '2222222222',
        clientId: 'deoleo',
        status: 'ACTIVE',
        id: { not: 'u1' },
      });
    });

    it('REACT-1: reactivation is BLOCKED when the phone is held by another ACTIVE user', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce({
        id: 'u1', phone: '1111111111', role: 'MIS_USER', status: 'INACTIVE',
      }); // target (currently inactive)
      mockPrisma.user.count.mockResolvedValueOnce(1); // an ACTIVE user now holds the phone
      const err = await service
        .updateUser(clientAdmin, 'u1', { status: 'ACTIVE' as never })
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe(
        'This phone number is already in use by another active user. Change the phone number before reactivating this account.',
      );
      // The re-check counts ACTIVE holders of the reclaimed phone, excluding self.
      expect(mockPrisma.user.count.mock.calls[0][0].where).toEqual({
        clientId: 'deoleo',
        phone: '1111111111',
        status: 'ACTIVE',
        id: { not: 'u1' },
      });
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('REACT-2: reactivation is ALLOWED when no other ACTIVE user holds the phone, and clears deletedAt', async () => {
      mockPrisma.user.findFirst
        .mockResolvedValueOnce({ id: 'u1', phone: '1111111111', role: 'MIS_USER', status: 'INACTIVE' }) // target
        .mockResolvedValueOnce({ id: 'u1', status: 'ACTIVE' });                                          // re-fetch
      mockPrisma.user.count.mockResolvedValueOnce(0); // no ACTIVE holder → free to reclaim
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
      await service.updateUser(clientAdmin, 'u1', { status: 'ACTIVE' as never });
      const data = mockPrisma.user.updateMany.mock.calls[0][0].data;
      expect(data.status).toBe('ACTIVE');
      // A soft-deleted account is fully restored — deletedAt cleared on reactivation.
      expect(data.deletedAt).toBeNull();
    });

    it('REACT-3: a plain deactivation (INACTIVE) never sets deletedAt and skips the reactivation count', async () => {
      mockPrisma.user.findFirst
        .mockResolvedValueOnce({ id: 'u3', phone: '1111111111', role: 'MIS_USER', status: 'ACTIVE' }) // target
        .mockResolvedValueOnce({ id: 'u3', status: 'INACTIVE' });                                      // re-fetch
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
      await service.updateUser(clientAdmin, 'u3', { status: 'INACTIVE' as never });
      const data = mockPrisma.user.updateMany.mock.calls[0][0].data;
      expect(data.status).toBe('INACTIVE');
      expect('deletedAt' in data).toBe(false); // deleteUser owns deletedAt — deactivate never touches it
      // No count call at all: non-admin target skips last-admin guard, and it's not a reactivation.
      expect(mockPrisma.user.count).not.toHaveBeenCalled();
    });

    it('REACT-4: a P2002 race on the phone index surfaces the clean reactivation error, not a 500', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce({
        id: 'u1', phone: '1111111111', role: 'MIS_USER', status: 'INACTIVE',
      }); // target
      mockPrisma.user.count.mockResolvedValueOnce(0); // pre-check passes, but a racer grabs it first
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: 'users_clientId_phone_active_key' },
      });
      mockPrisma.user.updateMany.mockRejectedValueOnce(p2002);
      const err = await service
        .updateUser(clientAdmin, 'u1', { status: 'ACTIVE' as never })
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe(
        'This phone number is already in use by another active user. Change the phone number before reactivating this account.',
      );
    });

    it('REACT-5: an unrelated P2002 (different index) is NOT swallowed — it re-throws', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce({
        id: 'u1', phone: '1111111111', role: 'MIS_USER', status: 'INACTIVE',
      }); // target
      mockPrisma.user.count.mockResolvedValueOnce(0);
      const emailClash = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: 'users_clientId_email_key' },
      });
      mockPrisma.user.updateMany.mockRejectedValueOnce(emailClash);
      const err = await service
        .updateUser(clientAdmin, 'u1', { status: 'ACTIVE' as never })
        .catch((e) => e);
      // Not remapped to the phone message — the original Prisma error propagates.
      expect(err).toBe(emailClash);
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

  // ── revokeUserSessions — admin per-user "log out of all devices" (#101 / 10-ii) ──
  describe('revokeUserSessions', () => {
    it('throws NotFound for a CROSS-TENANT target (never revokes another tenant\'s user)', async () => {
      // The tenant-scoped findFirst returns null → the target isn't in the caller's tenant.
      mockPrisma.user.findFirst.mockResolvedValue(null);
      await expect(service.revokeUserSessions(clientAdmin, 'other-tenant-user')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // The lookup MUST be scoped to the caller's clientId
      expect(mockPrisma.user.findFirst.mock.calls[0][0].where).toEqual({
        id: 'other-tenant-user',
        clientId: 'deoleo',
      });
      // No revoke on the failure path
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('revokes all sessions for a SAME-TENANT target and audits the admin_revoke_sessions event', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'u9' }); // target in-tenant
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 4 });

      const res = await service.revokeUserSessions(clientAdmin, 'u9');

      // Revoke goes through the shared helper: user-scoped + non-revoked only
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u9', revokedAt: null },
        data:  { revokedAt: expect.any(Date) },
      });
      expect(res).toEqual({ revoked: 4 });

      const audit = mockPrisma.auditLog.create.mock.calls[0][0].data;
      expect(audit.action).toBe('LOGOUT');
      expect(audit.entityId).toBe('u9');
      expect(audit.actorId).toBe('ca1');
      expect(audit.metadata).toMatchObject({ event: 'admin_revoke_sessions', targetUserId: 'u9', by: 'ca1' });
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

    it('surfaces the read-only Security & Platform Config from the enforced auth constants (#101)', async () => {
      mockPrisma.programSetting.findMany.mockResolvedValue([]);
      const res = await service.getSettings(clientAdmin);
      // Values come from auth.constants (single source of truth) + env JWT TTL.
      expect(res.settings).toMatchObject({
        refreshTtlDays: 30,
        assumedSessionTtlHours: 168,
        otpExpiryMinutes: 10,
        maxOtpAttempts: 3,
        otpResendWindowHours: 1,
        otpMaxResendsPerWindow: 5,
      });
      // jwtAccessTtl falls back to '7d' when JWT_EXPIRES_IN is unset.
      expect(typeof res.settings.jwtAccessTtl).toBe('string');
    });

    it('a stray programSetting row can NOT override the enforced otpExpiryMinutes display value', async () => {
      // A rogue/stale row must not make the DISPLAYED security value drift from what's enforced.
      mockPrisma.programSetting.findMany.mockResolvedValue([
        { settingKey: 'otpExpiryMinutes', settingValue: 999 },
      ]);
      const res = await service.getSettings(clientAdmin);
      expect(res.settings.otpExpiryMinutes).toBe(10); // constant wins (set after the DB loop)
    });

    it('returns stored fieldSlaTargetHours / gifsySlaTargetHours rows, overlaying the defaults', async () => {
      mockPrisma.programSetting.findMany.mockResolvedValue([
        { settingKey: 'fieldSlaTargetHours', settingValue: 12 },
        { settingKey: 'gifsySlaTargetHours', settingValue: 120 },
      ]);
      const res = await service.getSettings(clientAdmin);
      expect(res.settings.fieldSlaTargetHours).toBe(12);
      expect(res.settings.gifsySlaTargetHours).toBe(120);
    });

    it('falls back to the 24 / 96 SLA defaults when no rows exist', async () => {
      mockPrisma.programSetting.findMany.mockResolvedValue([]);
      const res = await service.getSettings(clientAdmin);
      expect(res.settings.fieldSlaTargetHours).toBe(24);
      expect(res.settings.gifsySlaTargetHours).toBe(96);
    });
  });

  describe('upsertSetting', () => {
    beforeEach(() => {
      mockPrisma.programSetting.upsert.mockResolvedValue({ id: 'ps1' });
      mockPrisma.auditLog.create.mockResolvedValue({ id: 'al1' });
    });

    it('persists fieldSlaTargetHours as a normalised integer, tenant-scoped', async () => {
      await service.upsertSetting(gifsy, { key: 'fieldSlaTargetHours', value: '12' });
      const call = mockPrisma.programSetting.upsert.mock.calls[0][0];
      expect(call.where).toEqual({
        clientId_settingKey: { clientId: 'deoleo', settingKey: 'fieldSlaTargetHours' },
      });
      // '12' string was normalised to the integer 12 on both update + create paths.
      expect(call.update.settingValue).toBe(12);
      expect(call.create.settingValue).toBe(12);
      // Cache bust so the new value is visible immediately.
      expect(mockTenantSettings.invalidate).toHaveBeenCalledWith('deoleo');
    });

    it('persists gifsySlaTargetHours as a normalised integer, tenant-scoped', async () => {
      await service.upsertSetting(gifsy, { key: 'gifsySlaTargetHours', value: '120' });
      const call = mockPrisma.programSetting.upsert.mock.calls[0][0];
      expect(call.where).toEqual({
        clientId_settingKey: { clientId: 'deoleo', settingKey: 'gifsySlaTargetHours' },
      });
      expect(call.update.settingValue).toBe(120);
      expect(call.create.settingValue).toBe(120);
    });

    it('accepts the SLA boundary values 1 and 168', async () => {
      await service.upsertSetting(gifsy, { key: 'fieldSlaTargetHours', value: 1 });
      await service.upsertSetting(gifsy, { key: 'gifsySlaTargetHours', value: 168 });
      const calls = mockPrisma.programSetting.upsert.mock.calls;
      expect(calls[0][0].update.settingValue).toBe(1);
      expect(calls[1][0].update.settingValue).toBe(168);
    });

    it('rejects an out-of-range fieldSlaTargetHours (169) and does not persist', async () => {
      await expect(
        service.upsertSetting(gifsy, { key: 'fieldSlaTargetHours', value: 169 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.programSetting.upsert).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range gifsySlaTargetHours (0) and does not persist', async () => {
      await expect(
        service.upsertSetting(gifsy, { key: 'gifsySlaTargetHours', value: 0 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.programSetting.upsert).not.toHaveBeenCalled();
    });

    it('rejects a non-integer gifsySlaTargetHours and does not persist', async () => {
      await expect(
        service.upsertSetting(gifsy, { key: 'gifsySlaTargetHours', value: 'abc' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.programSetting.upsert).not.toHaveBeenCalled();
    });

    it('leaves non-SLA keys untouched (no coercion)', async () => {
      await service.upsertSetting(gifsy, { key: 'programName', value: 'My Program' });
      const call = mockPrisma.programSetting.upsert.mock.calls[0][0];
      expect(call.update.settingValue).toBe('My Program');
    });

    it('appends a dedicated TdsPolicy audit (old→new, entityId=clientId) on a tdsPolicy write', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValue({
        settingValue: { section: 'SEC_194R', methodology: 'DEDUCT' },
      });
      const next = { section: 'SEC_194C', methodology: 'GROSS_UP' };
      await service.upsertSetting(gifsy, { key: 'tdsPolicy', value: next });

      // Prior value was read BEFORE the upsert (from the same clientId+key row).
      expect(mockPrisma.programSetting.findUnique).toHaveBeenCalledWith({
        where: { clientId_settingKey: { clientId: 'deoleo', settingKey: 'tdsPolicy' } },
        select: { settingValue: true },
      });
      // Two audit rows: the generic PROGRAM_SETTINGS + the dedicated TdsPolicy one.
      const tdsAudit = mockPrisma.auditLog.create.mock.calls
        .map((c) => c[0].data)
        .find((d) => d.entityType === 'TdsPolicy');
      expect(tdsAudit).toBeDefined();
      expect(tdsAudit.action).toBe('UPDATE');
      expect(tdsAudit.entityId).toBe('deoleo');
      expect(tdsAudit.actorId).toBe('admin1');
      expect(tdsAudit.oldValues).toEqual({ section: 'SEC_194R', methodology: 'DEDUCT' });
      expect(tdsAudit.newValues).toEqual(next);
      // Cache bust still fires.
      expect(mockTenantSettings.invalidate).toHaveBeenCalledWith('deoleo');
    });

    it('records oldValues=undefined when there was no prior tdsPolicy row (first write)', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValue(null);
      const next = { section: 'SEC_194C', methodology: 'DEDUCT' };
      await service.upsertSetting(gifsy, { key: 'tdsPolicy', value: next });
      const tdsAudit = mockPrisma.auditLog.create.mock.calls
        .map((c) => c[0].data)
        .find((d) => d.entityType === 'TdsPolicy');
      expect(tdsAudit).toBeDefined();
      expect(tdsAudit.oldValues).toBeUndefined();
      expect(tdsAudit.newValues).toEqual(next);
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
      // setVisibilityCaptureMode now reads the merge-base FRESH from clients.findUnique.
      mockPrisma.client.findUnique.mockResolvedValue({ features: structuredClone(baseConfig.features) });
      mockTenant.resolveClient.mockResolvedValue(structuredClone(baseConfig));
      mockPrisma.client.update.mockResolvedValue({ id: 'deoleo' });
      mockPrisma.auditLog.create.mockResolvedValue({ id: 'al1' });
    });

    it('VCM1: sets mode to AMOUNT_UPLOAD and persists to clients.features', async () => {
      const res = await service.setVisibilityCaptureMode(gifsy, { mode: 'AMOUNT_UPLOAD' });
      expect(res).toEqual({ mode: 'AMOUNT_UPLOAD' });

      const arg = mockPrisma.client.update.mock.calls[0][0];
      expect(arg.data.features.visibilityCaptureMode).toBe('AMOUNT_UPLOAD');
    });

    it('VCM2: merges — does NOT clobber other feature flags when changing mode', async () => {
      await service.setVisibilityCaptureMode(gifsy, { mode: 'AMOUNT_UPLOAD' });

      const arg = mockPrisma.client.update.mock.calls[0][0];
      // All other feature flags must remain intact in the written features blob
      expect(arg.data.features.loyalty).toBe(true);
      expect(arg.data.features.visibility).toBe(true);
      expect(arg.data.features.rewards).toBe(true);
      expect(arg.data.features.targets).toBe(true);
    });

    it('VCM3: sets mode to PHOTO_APPROVAL (round-trip back)', async () => {
      // Start from AMOUNT_UPLOAD
      mockPrisma.client.findUnique.mockResolvedValueOnce({
        features: { ...baseConfig.features, visibilityCaptureMode: 'AMOUNT_UPLOAD' as const },
      });
      const res = await service.setVisibilityCaptureMode(gifsy, { mode: 'PHOTO_APPROVAL' });
      expect(res).toEqual({ mode: 'PHOTO_APPROVAL' });
      const arg = mockPrisma.client.update.mock.calls[0][0];
      expect(arg.data.features.visibilityCaptureMode).toBe('PHOTO_APPROVAL');
    });

    it('VCM4: writes clients.update scoped to the caller clientId + busts the cache', async () => {
      await service.setVisibilityCaptureMode(gifsy, { mode: 'AMOUNT_UPLOAD' });
      expect(mockPrisma.client.update.mock.calls[0][0].where).toEqual({ id: 'deoleo' });
      expect(mockTenant.invalidateCache).toHaveBeenCalledWith('deoleo');
    });

    it('VCM5: writes an audit log entry with the new mode', async () => {
      await service.setVisibilityCaptureMode(gifsy, { mode: 'AMOUNT_UPLOAD' });
      const audit = mockPrisma.auditLog.create.mock.calls[0][0].data;
      expect(audit.action).toBe('UPDATE');
      expect(audit.entityType).toBe('CLIENT_CONFIG');
      expect(audit.actorId).toBe('admin1');
      expect(audit.metadata).toMatchObject({ key: 'visibilityCaptureMode', value: 'AMOUNT_UPLOAD' });
    });

    it('VCM6: propagates NotFoundException when the client row does not exist', async () => {
      mockPrisma.client.findUnique.mockResolvedValueOnce(null);
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
  describe('nationalHolidays (platform calendar)', () => {
    it('getNationalHolidays returns the gazetted-national defaults when no row exists', async () => {
      mockPrisma.programSetting.findFirst.mockResolvedValue(null);
      const { holidays } = await service.getNationalHolidays();
      expect(holidays).toEqual([
        { date: '2026-01-26', label: 'Republic Day' },
        { date: '2026-08-15', label: 'Independence Day' },
        { date: '2026-10-02', label: 'Gandhi Jayanti' },
      ]);
      // Read from the platform (gifsy) row, not the caller's tenant.
      expect(mockPrisma.programSetting.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { clientId: 'gifsy', settingKey: 'nationalHolidays' } }),
      );
    });

    it('getNationalHolidays normalizes, de-dups and sorts a stored override', async () => {
      mockPrisma.programSetting.findFirst.mockResolvedValue({
        settingValue: [
          { date: '2026-03-21', label: 'Holi' },
          { date: '2026-01-01', label: 'New Year' },
          { date: '2026-01-01', label: 'New Year (dupe)' }, // de-duped: last wins
          { date: 'not-a-date', label: 'junk' }, // dropped
        ],
      });
      const { holidays } = await service.getNationalHolidays();
      expect(holidays).toEqual([
        { date: '2026-01-01', label: 'New Year (dupe)' },
        { date: '2026-03-21', label: 'Holi' },
      ]);
    });

    it('setNationalHolidays (GIFSY) validates, de-dups, sorts, and upserts the platform row', async () => {
      mockPrisma.programSetting.upsert.mockResolvedValue({ id: 'ps' });
      const { holidays } = await service.setNationalHolidays(gifsy, {
        holidays: [
          { date: '2026-03-21', label: '  Holi  ' },
          { date: '2026-01-26', label: 'Republic Day' },
          { date: '2026-01-26', label: 'Republic Day (dupe)' },
        ],
      });
      expect(holidays).toEqual([
        { date: '2026-01-26', label: 'Republic Day (dupe)' },
        { date: '2026-03-21', label: 'Holi' },
      ]);
      const call = mockPrisma.programSetting.upsert.mock.calls[0][0];
      expect(call.where).toEqual({ clientId_settingKey: { clientId: 'gifsy', settingKey: 'nationalHolidays' } });
      expect(call.create.settingValue).toEqual(holidays);
      expect(call.update.settingValue).toEqual(holidays);
    });

    it('setNationalHolidays rejects an impossible calendar date', async () => {
      await expect(
        service.setNationalHolidays(gifsy, { holidays: [{ date: '2026-02-30', label: 'X' }] }),
      ).rejects.toThrow(/Invalid holiday date/);
      expect(mockPrisma.programSetting.upsert).not.toHaveBeenCalled();
    });

    it('setNationalHolidays rejects a blank label', async () => {
      await expect(
        service.setNationalHolidays(gifsy, { holidays: [{ date: '2026-01-26', label: '   ' }] }),
      ).rejects.toThrow(/missing a label/);
      expect(mockPrisma.programSetting.upsert).not.toHaveBeenCalled();
    });

    it('setNationalHolidays forbids a non-GIFSY caller', async () => {
      await expect(
        service.setNationalHolidays(clientAdmin, { holidays: [{ date: '2026-01-26', label: 'X' }] }),
      ).rejects.toThrow(/Gifsy Admin only/);
      expect(mockPrisma.programSetting.upsert).not.toHaveBeenCalled();
    });
  });

  describe('reportRecipients (platform store)', () => {
    it('getReportRecipients returns empty lists when no row exists', async () => {
      mockPrisma.programSetting.findFirst.mockResolvedValue(null);
      const { recipients } = await service.getReportRecipients();
      expect(recipients).toEqual({ creditsPayouts: [], kycActionables: [] });
      // Read from the platform (gifsy) row, not the caller's tenant.
      expect(mockPrisma.programSetting.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { clientId: 'gifsy', settingKey: 'reportRecipients' } }),
      );
    });

    it('getReportRecipients normalizes, lowercases, de-dups and drops invalid emails', async () => {
      mockPrisma.programSetting.findFirst.mockResolvedValue({
        settingValue: {
          creditsPayouts: ['Finance@Gifsy.in', 'finance@gifsy.in', 'not-an-email', ''],
          kycActionables: ['Ops@Gifsy.in'],
        },
      });
      const { recipients } = await service.getReportRecipients();
      expect(recipients).toEqual({
        creditsPayouts: ['finance@gifsy.in'],
        kycActionables: ['ops@gifsy.in'],
      });
    });

    it('setReportRecipients (GIFSY) normalizes and upserts the platform row', async () => {
      mockPrisma.programSetting.upsert.mockResolvedValue({ id: 'ps' });
      const { recipients } = await service.setReportRecipients(gifsy, {
        creditsPayouts: ['  Finance@Gifsy.in ', 'finance@gifsy.in', 'bad'],
        kycActionables: ['Ops@Gifsy.in'],
      });
      expect(recipients).toEqual({
        creditsPayouts: ['finance@gifsy.in'],
        kycActionables: ['ops@gifsy.in'],
      });
      const call = mockPrisma.programSetting.upsert.mock.calls[0][0];
      expect(call.where).toEqual({
        clientId_settingKey: { clientId: 'gifsy', settingKey: 'reportRecipients' },
      });
      expect(call.create.settingValue).toEqual(recipients);
      expect(call.create.category).toBe('reports');
      expect(call.update.settingValue).toEqual(recipients);
    });

    it('setReportRecipients forbids a non-GIFSY caller', async () => {
      await expect(
        service.setReportRecipients(clientAdmin, {
          creditsPayouts: ['finance@gifsy.in'],
          kycActionables: [],
        }),
      ).rejects.toThrow(/Gifsy Admin only/);
      expect(mockPrisma.programSetting.upsert).not.toHaveBeenCalled();
    });
  });

  describe('kycDashboard', () => {
    const HOUR = 60 * 60 * 1000;
    // Fixed Friday so the business-hours SLA clock is DETERMINISTIC: every fixture below looks
    // back at most 100h, which from Fri 09 Jan 2026 reaches only to Mon 05 Jan — no weekend or
    // national holiday in that window, so business hours == calendar hours and the within/breached
    // expectations are unchanged by the business-day switch. (Relative-to-real-now fixtures would
    // flip buckets depending on the day the suite runs.)
    const now = new Date('2026-01-09T12:00:00Z').getTime();
    let nowSpy: jest.SpyInstance;
    beforeEach(() => {
      // Mock Date.now() only (not the Date constructor) so kycDashboard's internal `now`
      // matches the fixed `now` above; businessHoursBetween still runs on real Date math.
      nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
      // resolveKycSlaTargets() reads the two SLA-target programSetting rows. No rows → the
      // 24h/96h defaults apply, which is what these fixtures expect. Individual tests may
      // override this to exercise a configured target.
      mockPrisma.programSetting.findMany.mockResolvedValue([]);
    });
    afterEach(() => {
      nowSpy.mockRestore();
    });

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

    it('uses the per-tenant configured field/gifsy SLA targets (not the defaults)', async () => {
      // field target 12h, gifsy target 48h — the bucket comparisons + echoed slaHours follow them.
      mockPrisma.programSetting.findMany.mockResolvedValue([
        { settingKey: 'fieldSlaTargetHours', settingValue: 12 },
        { settingKey: 'gifsySlaTargetHours', settingValue: 48 },
      ]);
      wire({
        outlets: [
          // field-pending 18h → within default 24 but BREACHES the configured 12
          outlet({ status: 'SUBMITTED', submittedAt: new Date(now - 18 * HOUR) }),
          // gifsy-pending 60h → within default 96 but BREACHES the configured 48
          outlet({
            status: 'PENDING_GIFSY',
            history: [{ toStatus: 'PENDING_GIFSY', createdAt: new Date(now - 60 * HOUR) }],
          }),
          // gifsy-pending 20h → within the configured 48
          outlet({
            status: 'PENDING_GIFSY',
            history: [{ toStatus: 'PENDING_GIFSY', createdAt: new Date(now - 20 * HOUR) }],
          }),
        ],
      });
      const res = await service.kycDashboard(clientAdmin);
      // resolveKycSlaTargets read the SLA rows for this tenant.
      expect(mockPrisma.programSetting.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { clientId: 'deoleo', settingKey: { in: ['fieldSlaTargetHours', 'gifsySlaTargetHours'] } },
        }),
      );
      expect(res.buckets.pendingFieldApproval).toMatchObject({ count: 1, withinSla: 0, breached: 1, slaHours: 12 });
      expect(res.buckets.pendingGifsyApproval).toMatchObject({ count: 2, withinSla: 1, breached: 1, slaHours: 48 });
    });

    it('gifsy clock RESTARTS on re-entry — timed from the LATEST PENDING_GIFSY entry, not the earliest', async () => {
      wire({
        outlets: [
          // Bounced then re-entered Gifsy: first entry 100h ago (would breach 96), re-entry 10h ago.
          // Latest-entry logic times from 10h ago → within the 96h default (would breach under earliest).
          outlet({
            status: 'PENDING_GIFSY',
            history: [
              { toStatus: 'PENDING_GIFSY', createdAt: new Date(now - 100 * HOUR) },
              { toStatus: 'PENDING_GIFSY', createdAt: new Date(now - 10 * HOUR) },
            ],
          }),
        ],
      });
      const res = await service.kycDashboard(clientAdmin);
      expect(res.buckets.pendingGifsyApproval).toMatchObject({ count: 1, withinSla: 1, breached: 0 });
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

    it('M2: bounced-then-approved — field chain = submitted→FIRST entry, gifsy review = LATEST entry→approval', async () => {
      // A KYC that reached Gifsy, was bounced back to field, reworked, re-entered Gifsy, then
      // approved. The field-chain tile must measure submitted → FIRST hand-off (pure field time),
      // NOT submitted → latest entry (which would wrongly absorb the first Gifsy review + rework).
      const submittedAt = new Date(now - 100 * HOUR);
      const firstEntry = new Date(now - 90 * HOUR); // field chain = 10h (submitted → first hand-off)
      const secondEntry = new Date(now - 30 * HOUR); // re-entry after a bounce (the LATEST)
      const approvedAt = new Date(now - 10 * HOUR); // gifsy review = 20h (latest entry → approval)
      wire({
        outlets: [
          outlet({
            status: 'APPROVED',
            submittedAt,
            approvedAt,
            history: [
              { toStatus: 'PENDING_GIFSY', createdAt: firstEntry },
              { toStatus: 'PENDING_GIFSY', createdAt: secondEntry },
            ],
          }),
        ],
      });
      const res = await service.kycDashboard(clientAdmin);
      expect(res.sla.fieldChainAvgHours).toBe(10); // submitted → FIRST entry (not 70h to latest)
      expect(res.sla.gifsyReviewAvgHours).toBe(20); // LATEST entry → approval
      expect(res.sla.endToEndAvgHours).toBe(90); // submitted → approval, unchanged
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
      expect(where.OR).toEqual([{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }]);
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
