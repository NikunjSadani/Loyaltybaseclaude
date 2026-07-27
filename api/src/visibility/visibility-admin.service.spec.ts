/**
 * Unit tests for visibility-admin.service.ts.
 *
 * Covers: config read (settings-backed) + write (whole-block upsert + audit + cache
 * bust), versioned form upsert (bump + append snapshot + helper validation), scope
 * outlet listing (outletType.code ∈ scope + addressable), and the visibilityEnabled /
 * PHOTO_APPROVAL gates. Prisma + TenantService + TenantSettingsService are mocked.
 *
 * Run: npx jest src/visibility/visibility-admin.service.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { VisibilityAdminService } from './visibility-admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  programSetting: { upsert: jest.fn() },
  auditLog: { create: jest.fn() },
  visibilityForm: { findUnique: jest.fn(), upsert: jest.fn() },
  visibilityFormVersion: { findUnique: jest.fn(), create: jest.fn() },
  outlet: { findMany: jest.fn() },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction: jest.fn((arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(mockPrisma))),
};

const mockTenant = {
  resolveVisibilityEnabled: jest.fn(),
  resolveVisibilityCaptureMode: jest.fn(),
};

const mockSettings = {
  getEffectiveSettings: jest.fn(),
  invalidate: jest.fn(),
};

const user: JwtPayload = { sub: 'u1', role: 'GIFSY_ADMIN', clientId: 't1', phone: '9', name: 'A' };

const defaultConfig = {
  outletScope: ['SSS', 'SSS_TOT'],
  frequencyPerMonth: 2,
  allowedSalesLevels: ['SO'],
  geoFence: { enabled: true, radiusMeters: 50 },
};

const validForm = {
  captureGpsOnSubmit: true,
  fields: [
    { id: 'photo', type: 'CAMERA', label: 'Shelf', required: true, order: 1, instruction: 'Head-on' },
    { id: 'geo', type: 'GPS_POINT', label: 'Location', required: false, order: 2 },
  ],
};

describe('VisibilityAdminService', () => {
  let service: VisibilityAdminService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTenant.resolveVisibilityEnabled.mockResolvedValue(true);
    mockTenant.resolveVisibilityCaptureMode.mockResolvedValue('PHOTO_APPROVAL');
    mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: defaultConfig });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VisibilityAdminService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockSettings },
      ],
    }).compile();
    service = module.get(VisibilityAdminService);
  });

  // ── Gates ──────────────────────────────────────────────────────────────────
  describe('gates', () => {
    it('403s every method when visibilityEnabled is OFF', async () => {
      mockTenant.resolveVisibilityEnabled.mockResolvedValue(false);
      await expect(service.getConfig('t1')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.getForm('t1')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.setConfig(user, defaultConfig)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.upsertForm(user, validForm)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('403s writes when capture mode is not PHOTO_APPROVAL', async () => {
      mockTenant.resolveVisibilityCaptureMode.mockResolvedValue('AMOUNT_UPLOAD');
      await expect(service.setConfig(user, defaultConfig)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.upsertForm(user, validForm)).rejects.toBeInstanceOf(ForbiddenException);
      // Reads still work in AMOUNT_UPLOAD mode.
      await expect(service.getConfig('t1')).resolves.toEqual(defaultConfig);
    });
  });

  // ── Config ─────────────────────────────────────────────────────────────────
  describe('config', () => {
    it('getConfig returns the effective settings block', async () => {
      await expect(service.getConfig('t1')).resolves.toEqual(defaultConfig);
    });

    it('setConfig upserts the whole block, audits, and busts the cache', async () => {
      mockPrisma.programSetting.upsert.mockResolvedValue({ id: 'ps1' });
      const res = await service.setConfig(user, defaultConfig);

      const upsertArg = mockPrisma.programSetting.upsert.mock.calls[0][0];
      expect(upsertArg.where).toEqual({
        clientId_settingKey: { clientId: 't1', settingKey: 'visibilityConfig' },
      });
      expect(upsertArg.create.settingValue).toEqual({
        outletScope: ['SSS', 'SSS_TOT'],
        frequencyPerMonth: 2,
        allowedSalesLevels: ['SO'],
        geoFence: { enabled: true, radiusMeters: 50 },
      });
      expect(mockPrisma.auditLog.create).toHaveBeenCalled();
      expect(mockSettings.invalidate).toHaveBeenCalledWith('t1');
      expect(res.visibilityConfig).toEqual(defaultConfig);
    });
  });

  // ── Versioned form ───────────────────────────────────────────────────────────
  describe('upsertForm', () => {
    it('bumps the version and appends a snapshot in one transaction', async () => {
      mockPrisma.visibilityForm.findUnique.mockResolvedValue({ version: 2 });
      mockPrisma.visibilityForm.upsert.mockResolvedValue({ id: 'f1', version: 3 });
      mockPrisma.visibilityFormVersion.create.mockResolvedValue({ id: 'fv3', version: 3 });

      await service.upsertForm(user, validForm);

      expect(mockPrisma.visibilityForm.upsert.mock.calls[0][0].update.version).toBe(3);
      expect(mockPrisma.visibilityForm.upsert.mock.calls[0][0].create.version).toBe(3);
      expect(mockPrisma.visibilityFormVersion.create.mock.calls[0][0].data.version).toBe(3);
      expect(mockPrisma.visibilityFormVersion.create.mock.calls[0][0].data.clientId).toBe('t1');
    });

    it('starts at version 1 when no form exists yet', async () => {
      mockPrisma.visibilityForm.findUnique.mockResolvedValue(null);
      mockPrisma.visibilityForm.upsert.mockResolvedValue({ id: 'f1', version: 1 });
      mockPrisma.visibilityFormVersion.create.mockResolvedValue({ id: 'fv1', version: 1 });

      await service.upsertForm(user, validForm);
      expect(mockPrisma.visibilityForm.upsert.mock.calls[0][0].create.version).toBe(1);
    });

    it('rejects an invalid form (no camera field) before touching the DB', async () => {
      const badForm = {
        captureGpsOnSubmit: false,
        fields: [{ id: 't', type: 'TEXT', label: 'Notes', required: false, order: 1 }],
      };
      await expect(service.upsertForm(user, badForm)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('getForm returns the current form or null', async () => {
      mockPrisma.visibilityForm.findUnique.mockResolvedValue({ id: 'f1', version: 1 });
      await expect(service.getForm('t1')).resolves.toEqual({ id: 'f1', version: 1 });
    });

    it('getFormVersion 404s a missing version', async () => {
      mockPrisma.visibilityFormVersion.findUnique.mockResolvedValue(null);
      await expect(service.getFormVersion('t1', 9)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── Scope listing ─────────────────────────────────────────────────────────────
  describe('listOutletsInScope', () => {
    it('queries addressable outlets whose type code is in scope', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', outletCode: 'X1', name: 'Store' }]);
      const res = await service.listOutletsInScope('t1', {});

      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where.clientId).toBe('t1');
      expect(where.deletedAt).toBeNull();
      expect(where.deactivatedAt).toBeNull();
      expect(where.outletType).toEqual({ code: { in: ['SSS', 'SSS_TOT'] } });
      expect(res.total).toBe(1);
      expect(res.outletScope).toEqual(['SSS', 'SSS_TOT']);
    });

    it('applies q / zone / state filters', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      await service.listOutletsInScope('t1', { q: 'shop', zone: 'West', state: 'MH' });
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where.zone).toBe('West');
      expect(where.state).toBe('MH');
      expect(where.OR).toEqual([
        { name: { contains: 'shop', mode: 'insensitive' } },
        { outletCode: { contains: 'shop', mode: 'insensitive' } },
      ]);
    });
  });
});
