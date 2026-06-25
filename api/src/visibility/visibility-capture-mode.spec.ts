/**
 * Focused tests for the per-tenant visibilityCaptureMode gate (gap #17 / task 6.6).
 *
 * Scenarios covered:
 *  1. Mode = PHOTO_APPROVAL (default / explicit):
 *     - approve() and reject() are allowed.
 *     - admin-programs bulkUpload() is blocked with a 400.
 *  2. Mode = AMOUNT_UPLOAD:
 *     - admin-programs bulkUpload() is allowed (proceeds past the gate).
 *     - approve() and reject() are blocked with a 400.
 *  3. Default behaviour (visibilityCaptureMode unset in features):
 *     - resolveVisibilityCaptureMode returns 'PHOTO_APPROVAL'.
 *     - approve() is allowed; bulkUpload() is blocked.
 *
 * Run: npx jest src/visibility/visibility-capture-mode.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';

import { VisibilityService as PhotoVisibilityService } from './visibility.service';
import { VisibilityService as AmountVisibilityService } from '../admin-programs/visibility.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockStorage = {
  generateKey: jest.fn().mockReturnValue('visibility/acme/key.png'),
  uploadFile: jest.fn().mockResolvedValue('https://storage/visibility/acme/key.png'),
};

// ── Fixtures ────────────────────────────────────────────────────────────────

const gifsy: JwtPayload = {
  sub: 'admin1',
  role: 'GIFSY_ADMIN',
  clientId: 'acme',
  phone: '',
  name: '',
};

// ── Shared mock helpers ──────────────────────────────────────────────────────

const mockTx = {
  visibilitySubmission: { update: jest.fn() },
  visibilityApproval: { create: jest.fn() },
  auditLog: { create: jest.fn() },
};

const mockPrisma = {
  visibilitySubmission: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() },
  visibilityApproval: { create: jest.fn() },
  visibilityFraudLog: { findMany: jest.fn(), count: jest.fn() },
  outletVisibilityRecord: { findMany: jest.fn(), findUnique: jest.fn() },
  outletVisibilityUploadBatch: { create: jest.fn() },
  outletVisibilityAuditLog: { createMany: jest.fn() },
  outlet: { findMany: jest.fn(), findUnique: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

/** Build a TenantService mock that returns the given capture mode. */
function makeTenant(mode: 'PHOTO_APPROVAL' | 'AMOUNT_UPLOAD' | undefined) {
  return {
    resolveVisibilityCaptureMode: jest.fn().mockResolvedValue(mode ?? 'PHOTO_APPROVAL'),
    // Master visibility switch — default ON for these mode-gate tests (the master
    // gate is exercised separately in visibility.service.spec.ts).
    resolveVisibilityEnabled: jest.fn().mockResolvedValue(true),
  };
}

/** Build the PhotoVisibilityService (src/visibility) with the given tenant mock. */
async function buildPhotoService(
  tenant: ReturnType<typeof makeTenant>,
): Promise<PhotoVisibilityService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      PhotoVisibilityService,
      { provide: PrismaService, useValue: mockPrisma },
      { provide: TenantService, useValue: tenant },
      { provide: StorageService, useValue: mockStorage },
    ],
  }).compile();
  return module.get(PhotoVisibilityService);
}

/** Build the AmountVisibilityService (src/admin-programs) with the given tenant mock. */
async function buildAmountService(
  tenant: ReturnType<typeof makeTenant>,
): Promise<AmountVisibilityService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AmountVisibilityService,
      { provide: PrismaService, useValue: mockPrisma },
      { provide: TenantService, useValue: tenant },
    ],
  }).compile();
  return module.get(AmountVisibilityService);
}

// ── Test suites ──────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('VisibilityCaptureMode gate — mode: PHOTO_APPROVAL', () => {
  describe('PhotoVisibilityService (src/visibility)', () => {
    it('approve() is allowed and proceeds to the DB lookup', async () => {
      const tenant = makeTenant('PHOTO_APPROVAL');
      const svc = await buildPhotoService(tenant);

      // The submission lookup returns null — the mode gate passes, NotFoundException thrown from DB path.
      mockPrisma.visibilitySubmission.findFirst.mockResolvedValue(null);

      // Should throw NotFoundException (not BadRequestException from the gate)
      await expect(svc.approve(gifsy, 'sub1')).rejects.toThrow('Submission not found');
      expect(tenant.resolveVisibilityCaptureMode).toHaveBeenCalledWith('acme');
    });

    it('reject() is allowed and proceeds to the DB lookup', async () => {
      const tenant = makeTenant('PHOTO_APPROVAL');
      const svc = await buildPhotoService(tenant);

      mockPrisma.visibilitySubmission.findFirst.mockResolvedValue(null);

      await expect(svc.reject(gifsy, 'sub1', { reason: 'blurry' })).rejects.toThrow(
        'Submission not found',
      );
      expect(tenant.resolveVisibilityCaptureMode).toHaveBeenCalledWith('acme');
    });
  });

  describe('AmountVisibilityService (src/admin-programs)', () => {
    it('bulkUpload() is blocked with 400 when mode is PHOTO_APPROVAL', async () => {
      const tenant = makeTenant('PHOTO_APPROVAL');
      const svc = await buildAmountService(tenant);

      const fakeFile = { originalname: 'data.xlsx', buffer: Buffer.from('') } as Express.Multer.File;

      await expect(svc.bulkUpload(gifsy, fakeFile)).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.bulkUpload(gifsy, fakeFile)).rejects.toThrow(
        'Tenant is not configured for amount-upload visibility',
      );
      expect(tenant.resolveVisibilityCaptureMode).toHaveBeenCalledWith('acme');
    });
  });
});

describe('VisibilityCaptureMode gate — mode: AMOUNT_UPLOAD', () => {
  describe('PhotoVisibilityService (src/visibility)', () => {
    it('approve() is blocked with 400 when mode is AMOUNT_UPLOAD', async () => {
      const tenant = makeTenant('AMOUNT_UPLOAD');
      const svc = await buildPhotoService(tenant);

      await expect(svc.approve(gifsy, 'sub1')).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.approve(gifsy, 'sub1')).rejects.toThrow(
        'Tenant is not configured for photo-approval visibility',
      );
      expect(tenant.resolveVisibilityCaptureMode).toHaveBeenCalledWith('acme');
    });

    it('reject() is blocked with 400 when mode is AMOUNT_UPLOAD', async () => {
      const tenant = makeTenant('AMOUNT_UPLOAD');
      const svc = await buildPhotoService(tenant);

      await expect(svc.reject(gifsy, 'sub1', { reason: 'blurry' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(svc.reject(gifsy, 'sub1', { reason: 'blurry' })).rejects.toThrow(
        'Tenant is not configured for photo-approval visibility',
      );
    });
  });

  describe('AmountVisibilityService (src/admin-programs)', () => {
    it('bulkUpload() passes the mode gate and proceeds (fails later on file validation)', async () => {
      const tenant = makeTenant('AMOUNT_UPLOAD');
      const svc = await buildAmountService(tenant);

      // No file — this is the NEXT guard after the mode gate.
      await expect(svc.bulkUpload(gifsy, undefined)).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.bulkUpload(gifsy, undefined)).rejects.toThrow('No file provided');
      // Critically: error is about the file, not the capture mode gate.
      expect(tenant.resolveVisibilityCaptureMode).toHaveBeenCalledWith('acme');
    });
  });
});

describe('VisibilityCaptureMode gate — default (unset = PHOTO_APPROVAL)', () => {
  it('resolveVisibilityCaptureMode returns PHOTO_APPROVAL when feature is absent', async () => {
    // Build a real TenantService with a prisma mock that returns a config WITHOUT visibilityCaptureMode.
    const prismaWithConfig = {
      adminConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            clientId: 'acme',
            key: 'client_config',
            value: {
              slug: 'acme',
              name: 'Acme Corp',
              isActive: true,
              features: {
                loyalty: true,
                visibility: true,
                leaderboard: false,
                schemes: false,
                selfEnrollment: false,
                targets: true,
                rewards: false,
                tds: false,
                // visibilityCaptureMode intentionally absent
              },
              branding: { primaryColor: '#000', displayName: 'Acme' },
            },
          },
        ]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantService,
        { provide: PrismaService, useValue: prismaWithConfig },
        // TenantService now depends on TenantSettingsService (resolveVisibilityEnabled);
        // this test only exercises resolveVisibilityCaptureMode, so a stub suffices.
        { provide: TenantSettingsService, useValue: { getEffectiveSettings: jest.fn() } },
      ],
    }).compile();

    const tenantSvc = module.get(TenantService);
    const mode = await tenantSvc.resolveVisibilityCaptureMode('acme');
    expect(mode).toBe('PHOTO_APPROVAL');
  });

  it('default (unset) behaves as PHOTO_APPROVAL — approve() passes gate', async () => {
    // The mock tenant returns undefined-field → 'PHOTO_APPROVAL' default.
    const tenant = makeTenant(undefined); // undefined → mock still returns 'PHOTO_APPROVAL'
    const svc = await buildPhotoService(tenant);

    mockPrisma.visibilitySubmission.findFirst.mockResolvedValue(null);

    // Gate passes — fails on DB NotFoundException, not BadRequestException from the gate.
    await expect(svc.approve(gifsy, 'sub1')).rejects.toThrow('Submission not found');
  });

  it('default (unset) behaves as PHOTO_APPROVAL — bulkUpload() is blocked', async () => {
    const tenant = makeTenant(undefined); // undefined → mock returns 'PHOTO_APPROVAL'
    const svc = await buildAmountService(tenant);

    const fakeFile = { originalname: 'data.xlsx', buffer: Buffer.from('') } as Express.Multer.File;

    await expect(svc.bulkUpload(gifsy, fakeFile)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.bulkUpload(gifsy, fakeFile)).rejects.toThrow(
      'Tenant is not configured for amount-upload visibility',
    );
  });
});
