// TDD: TenantService
// Tests written first — defines expected multi-tenant behaviour

import { Test, TestingModule } from '@nestjs/testing';
import { TenantService } from './tenant.service';
import { TenantSettingsService } from './tenant-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException, ForbiddenException } from '@nestjs/common';

const mockPrisma = {
  client: {
    findUnique: jest.fn(),
    findMany:   jest.fn(),
    update:     jest.fn(),
  },
};

// TenantSettingsService mock — TenantService.resolveVisibilityEnabled delegates to
// the UNCACHED read (getVisibilityEnabledUncached) for immediate cross-instance flips.
const mockSettings = {
  getEffectiveSettings: jest.fn().mockResolvedValue({ visibilityEnabled: false }),
  getVisibilityEnabledUncached: jest.fn().mockResolvedValue(false),
};

// A `clients` table row (the new source of truth) — status/internalName/JSON blobs.
const mockDeoleoRow = {
  id:           'deoleo',
  internalName: 'Deoleo India',
  status:       'ACTIVE',
  features: {
    loyalty:        true,
    visibility:     true,
    leaderboard:    true,
    schemes:        true,
    selfEnrollment: false,
    rbacEnforcement: false,
  },
  branding: { primaryColor: '#16a34a', displayName: 'Deoleo India' },
};

describe('TenantService', () => {
  let service: TenantService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantSettingsService, useValue: mockSettings },
      ],
    }).compile();

    service = module.get<TenantService>(TenantService);
    jest.clearAllMocks();
    mockSettings.getVisibilityEnabledUncached.mockResolvedValue(false);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('resolveClient', () => {
    it('should return client config for a valid slug', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(mockDeoleoRow);

      const result = await service.resolveClient('deoleo');
      expect(mockPrisma.client.findUnique).toHaveBeenCalledWith({ where: { id: 'deoleo' } });
      expect(result.slug).toBe('deoleo');
      expect(result.name).toBe('Deoleo India');
      expect(result.isActive).toBe(true);
      expect(result.branding.primaryColor).toBe('#16a34a');
    });

    it('should throw NotFoundException for a missing client row', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      await expect(service.resolveClient('unknown-client')).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for an INACTIVE client', async () => {
      mockPrisma.client.findUnique.mockResolvedValue({ ...mockDeoleoRow, status: 'INACTIVE' });
      await expect(service.resolveClient('deoleo')).rejects.toThrow(ForbiddenException);
    });

    it('should resolve an ONBOARDING client as active (only INACTIVE is blocked)', async () => {
      mockPrisma.client.findUnique.mockResolvedValue({ ...mockDeoleoRow, status: 'ONBOARDING' });
      const result = await service.resolveClient('deoleo');
      expect(result.isActive).toBe(true);
    });

    it('falls back to default branding when the branding blob is empty', async () => {
      mockPrisma.client.findUnique.mockResolvedValue({
        ...mockDeoleoRow,
        branding: {},
      });
      const result = await service.resolveClient('deoleo');
      expect(result.branding.primaryColor).toBe('#16a34a');
      expect(result.branding.displayName).toBe('Deoleo India'); // internalName fallback
    });
  });

  describe('isFeatureEnabled', () => {
    it('should return true for enabled feature', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(mockDeoleoRow);
      const result = await service.isFeatureEnabled('deoleo', 'loyalty');
      expect(result).toBe(true);
    });

    it('should return false for disabled feature', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(mockDeoleoRow);
      const result = await service.isFeatureEnabled('deoleo', 'selfEnrollment');
      expect(result).toBe(false);
    });

    it('should return false for unknown feature key', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(mockDeoleoRow);
      const result = await service.isFeatureEnabled('deoleo', 'nonExistentFeature');
      expect(result).toBe(false);
    });

    it('reads rbacEnforcement straight from clients.features', async () => {
      mockPrisma.client.findUnique.mockResolvedValue({
        ...mockDeoleoRow,
        features: { ...mockDeoleoRow.features, rbacEnforcement: true },
      });
      expect(await service.isFeatureEnabled('deoleo', 'rbacEnforcement')).toBe(true);
    });

    it('fails OPEN (rbacEnforcement=false) when the client row is missing', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      expect(await service.isFeatureEnabled('deoleo', 'rbacEnforcement')).toBe(false);
    });
  });

  describe('resolveVisibilityCaptureMode', () => {
    it('returns the clients.features.visibilityCaptureMode value', async () => {
      mockPrisma.client.findUnique.mockResolvedValue({
        ...mockDeoleoRow,
        features: { ...mockDeoleoRow.features, visibilityCaptureMode: 'AMOUNT_UPLOAD' },
      });
      expect(await service.resolveVisibilityCaptureMode('deoleo')).toBe('AMOUNT_UPLOAD');
    });

    it('defaults to PHOTO_APPROVAL when the key is absent', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(mockDeoleoRow);
      expect(await service.resolveVisibilityCaptureMode('deoleo')).toBe('PHOTO_APPROVAL');
    });

    it('defaults to PHOTO_APPROVAL when the client row is missing (safe fallback)', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      expect(await service.resolveVisibilityCaptureMode('deoleo')).toBe('PHOTO_APPROVAL');
    });
  });

  describe('resolveVisibilityEnabled', () => {
    it('returns the uncached visibilityEnabled flag from TenantSettingsService', async () => {
      mockSettings.getVisibilityEnabledUncached.mockResolvedValue(true);
      expect(await service.resolveVisibilityEnabled('deoleo')).toBe(true);
      expect(mockSettings.getVisibilityEnabledUncached).toHaveBeenCalledWith('deoleo');
    });

    it('returns false (OFF) by default — visibility is opt-in', async () => {
      mockSettings.getVisibilityEnabledUncached.mockResolvedValue(false);
      expect(await service.resolveVisibilityEnabled('deoleo')).toBe(false);
    });
  });

  describe('Multi-tenant isolation', () => {
    it('should never return data for a different clientId', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      await expect(service.resolveClient('competitor')).rejects.toThrow(NotFoundException);
    });
  });
});
