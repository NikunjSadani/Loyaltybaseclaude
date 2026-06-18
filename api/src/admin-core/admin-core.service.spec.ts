// Unit tests for AdminCoreService — ported admin sub-domains.
// Covers: user CRUD tenant-scoping, phone-change session revoke, soft delete,
// the GIFSY force-logout-all kill switch, and the bulk-resign transaction.
// Run: npx jest src/admin-core/admin-core.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
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
  outlet: { findMany: jest.fn() },
  programSetting: { findMany: jest.fn(), findFirst: jest.fn(), upsert: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

const mockTenant = { resolveClient: jest.fn(), upsertClientConfig: jest.fn() };

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const clientAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };

describe('AdminCoreService', () => {
  let service: AdminCoreService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminCoreService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
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
        .mockResolvedValueOnce(null); // no clash
      mockPrisma.user.update.mockResolvedValue({ id: 'u1' });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 2 });

      await service.updateUser(clientAdmin, 'u1', { phone: '2222222222' });

      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('does NOT revoke sessions when the phone is unchanged', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'u1', phone: '1111111111' });
      mockPrisma.user.update.mockResolvedValue({ id: 'u1' });
      await service.updateUser(clientAdmin, 'u1', { name: 'New Name' });
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('deleteUser', () => {
    it('prevents deleting your own account', async () => {
      await expect(service.deleteUser(gifsy, 'admin1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('soft-deletes (status INACTIVE + deletedAt) and audits', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'u1' });
      mockPrisma.user.update.mockResolvedValue({ id: 'u1' });
      await service.deleteUser(gifsy, 'u1');
      const data = mockPrisma.user.update.mock.calls[0][0].data;
      expect(data.status).toBe('INACTIVE');
      expect(data.deletedAt).toBeInstanceOf(Date);
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

  describe('saveKpiConfig / saveGiftConfig', () => {
    it('rejects a non-array KPI body', async () => {
      await expect(service.saveKpiConfig(clientAdmin, { not: 'array' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a non-array gift body', async () => {
      await expect(service.saveGiftConfig(clientAdmin, { not: 'array' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('upserts the KPI array scoped to clientId', async () => {
      mockPrisma.programSetting.upsert.mockResolvedValue({ id: 'p1' });
      await service.saveKpiConfig(clientAdmin, [{ id: 'k1' }]);
      const args = mockPrisma.programSetting.upsert.mock.calls[0][0];
      expect(args.where.clientId_settingKey).toEqual({ clientId: 'deoleo', settingKey: 'kpi_defs' });
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
});
