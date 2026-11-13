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
  outlet: { findMany: jest.fn(), groupBy: jest.fn() },
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

  // ── APPLIES-TO: programs / subPrograms (D12, plan §4) ─────────────────────────────────────
  describe('APPLIES-TO programs / subPrograms', () => {
    const settingsWith = (vc: Record<string, unknown>) => ({
      visibilityConfig: { ...defaultConfig, programs: [], subPrograms: [], ...vc },
      outletPrograms: ['RLP', 'BSC'],
      outletCategories: ['Urban'],
    });
    const stored = () => mockPrisma.programSetting.upsert.mock.calls[0][0].update.settingValue;
    beforeEach(() => {
      mockPrisma.programSetting.upsert.mockResolvedValue({ id: 'ps1' });
      mockPrisma.outlet.groupBy.mockResolvedValue([]);
    });

    it('ABSENT keys carry over the stored lists (stale tab never wipes them), without re-validation', async () => {
      mockSettings.getEffectiveSettings.mockResolvedValue(settingsWith({ programs: ['Legacy Prog'], subPrograms: ['Urban'] }));
      await service.setConfig(user, defaultConfig as never);
      expect(stored().programs).toEqual(['Legacy Prog']);
      expect(stored().subPrograms).toEqual(['Urban']);
      expect(mockPrisma.outlet.groupBy).not.toHaveBeenCalled();
      expect(mockSettings.invalidate).toHaveBeenCalledWith('t1'); // fresh read before carry-over
    });

    it('an explicit [] clears the facet (key omitted from the stored JSON = all)', async () => {
      mockSettings.getEffectiveSettings.mockResolvedValue(settingsWith({ programs: ['RLP'] }));
      await service.setConfig(user, { ...defaultConfig, programs: [] } as never);
      expect(stored()).not.toHaveProperty('programs');
    });

    it('canonicalises to the settings spelling (ci) and falls back to the most common live spelling', async () => {
      mockSettings.getEffectiveSettings.mockResolvedValue(settingsWith({}));
      mockPrisma.outlet.groupBy.mockResolvedValue([
        { programCategory: 'rural', _count: { _all: 2 } },
        { programCategory: 'Rural', _count: { _all: 9 } },
      ]);
      await service.setConfig(user, { ...defaultConfig, programs: [' rlp '], subPrograms: ['RURAL', 'urban'] } as never);
      expect(stored().programs).toEqual(['RLP']);
      expect(stored().subPrograms).toEqual(['Rural', 'Urban']);
      expect(mockPrisma.outlet.groupBy.mock.calls[0][0].where).toEqual({ clientId: 't1', deletedAt: null, programCategory: { not: null } });
    });

    it('an unknown value → 400 listing the allowed values; nothing persisted', async () => {
      mockSettings.getEffectiveSettings.mockResolvedValue(settingsWith({}));
      await expect(service.setConfig(user, { ...defaultConfig, programs: ['Nope'] } as never))
        .rejects.toThrow(/Unknown program: Nope\. Allowed: BSC, RLP/);
      expect(mockPrisma.programSetting.upsert).not.toHaveBeenCalled();
    });

    it('a STALE stored value resent unchanged is NOT re-validated (no 400); a NEW stale value still 400s', async () => {
      // 'Old Prog' was valid when saved but is now in neither the settings list nor any live outlet.
      mockSettings.getEffectiveSettings.mockResolvedValue(settingsWith({ programs: ['Old Prog'], subPrograms: [] }));
      await service.setConfig(user, { ...defaultConfig, frequencyPerMonth: 3, programs: ['Old Prog', 'bsc'] } as never);
      expect(stored().programs).toEqual(['Old Prog', 'BSC']); // stale value accepted as sent; new value canonicalised
      mockPrisma.programSetting.upsert.mockClear();
      await expect(service.setConfig(user, { ...defaultConfig, subPrograms: ['Gone'] } as never))
        .rejects.toThrow(/Unknown sub-program: Gone\. Allowed: Urban\./);
      expect(mockPrisma.programSetting.upsert).not.toHaveBeenCalled();
    });

    describe('audit #7: case-only edits are deterministic, never a silent no-op', () => {
      it('a STORED value is re-canonicalised to the settings-list spelling on a case-only edit (rlp → Rlp stores "RLP")', async () => {
        // Stored in a non-canonical spelling (e.g. saved before the settings list was edited).
        mockSettings.getEffectiveSettings.mockResolvedValue(settingsWith({ programs: ['rlp'] }));
        await service.setConfig(user, { ...defaultConfig, programs: ['Rlp'] } as never);
        expect(stored().programs).toEqual(['RLP']); // canonical spelling, regardless of the submitted case
        expect(mockPrisma.outlet.groupBy).not.toHaveBeenCalled(); // settings list already canonical → no live read
      });

      it('a stored value outside the settings list takes the most common LIVE spelling', async () => {
        mockSettings.getEffectiveSettings.mockResolvedValue(settingsWith({ subPrograms: ['rural'] }));
        mockPrisma.outlet.groupBy.mockResolvedValue([
          { programCategory: 'rural', _count: { _all: 1 } },
          { programCategory: 'Rural', _count: { _all: 9 } },
        ]);
        await service.setConfig(user, { ...defaultConfig, subPrograms: ['RURAL'] } as never);
        expect(stored().subPrograms).toEqual(['Rural']);
      });

      it('a STALE stored value (no canonical anywhere) takes the SUBMITTED spelling — the edit applies', async () => {
        mockSettings.getEffectiveSettings.mockResolvedValue(settingsWith({ programs: ['gold'] }));
        await service.setConfig(user, { ...defaultConfig, programs: ['Gold'] } as never);
        expect(stored().programs).toEqual(['Gold']);
      });

      it('the response returns the stored (canonical) config so the editor shows what was saved', async () => {
        mockSettings.getEffectiveSettings
          .mockResolvedValueOnce(settingsWith({ programs: ['rlp'] }))
          .mockResolvedValueOnce(settingsWith({ programs: ['RLP'] }));
        const res = await service.setConfig(user, { ...defaultConfig, programs: ['Rlp'] } as never);
        expect((res.visibilityConfig as { programs: string[] }).programs).toEqual(['RLP']);
      });
    });

    it('UNSCOPED tenant (no lists anywhere) stores exactly the pre-scope JSON', async () => {
      mockSettings.getEffectiveSettings.mockResolvedValue(settingsWith({}));
      await service.setConfig(user, defaultConfig as never);
      expect(stored()).toEqual({
        outletScope: ['SSS', 'SSS_TOT'], frequencyPerMonth: 2, allowedSalesLevels: ['SO'],
        geoFence: { enabled: true, radiusMeters: 50 },
      });
    });

    it('listOutletsInScope: programs narrow via AND (base where intact); empty lists → where unchanged', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      mockSettings.getEffectiveSettings.mockResolvedValue(settingsWith({ programs: ['RLP'] }));
      await service.listOutletsInScope('t1', {});
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where.AND[0].outletType).toEqual({ code: { in: ['SSS', 'SSS_TOT'] } });
      expect(where.AND[1]).toEqual({ AND: [{ OR: [{ programName: { equals: 'RLP', mode: 'insensitive' } }] }] });

      mockPrisma.outlet.findMany.mockClear();
      mockSettings.getEffectiveSettings.mockResolvedValue(settingsWith({}));
      await service.listOutletsInScope('t1', {});
      expect(mockPrisma.outlet.findMany.mock.calls[0][0].where).not.toHaveProperty('AND');
    });
  });
});
