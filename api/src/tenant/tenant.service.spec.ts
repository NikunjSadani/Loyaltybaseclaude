// TDD: TenantService
// Tests written first — defines expected multi-tenant behaviour

import { Test, TestingModule } from '@nestjs/testing';
import { TenantService } from './tenant.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException, ForbiddenException } from '@nestjs/common';

const mockPrisma = {
  adminConfig: {
    findMany: jest.fn(),
    upsert:   jest.fn(),
  },
};

const mockDeoleo = {
  slug:     'deoleo',
  name:     'Deoleo India',
  features: {
    loyalty:       true,
    visibility:    true,
    leaderboard:   true,
    schemes:       true,
    selfEnrollment: false,
  },
  branding: { primaryColor: '#16a34a', displayName: 'Deoleo India' },
  isActive: true,
};

describe('TenantService', () => {
  let service: TenantService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TenantService>(TenantService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('resolveClient', () => {
    it('should return client config for a valid slug', async () => {
      mockPrisma.adminConfig.findMany.mockResolvedValue([
        { key: 'client_config', value: mockDeoleo },
      ]);

      const result = await service.resolveClient('deoleo');
      expect(result.slug).toBe('deoleo');
      expect(result.isActive).toBe(true);
    });

    it('should throw NotFoundException for unknown slug', async () => {
      mockPrisma.adminConfig.findMany.mockResolvedValue([]);
      await expect(service.resolveClient('unknown-client')).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for inactive client', async () => {
      mockPrisma.adminConfig.findMany.mockResolvedValue([
        { key: 'client_config', value: { ...mockDeoleo, isActive: false } },
      ]);
      await expect(service.resolveClient('deoleo')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('isFeatureEnabled', () => {
    it('should return true for enabled feature', async () => {
      mockPrisma.adminConfig.findMany.mockResolvedValue([
        { key: 'client_config', value: mockDeoleo },
      ]);
      const result = await service.isFeatureEnabled('deoleo', 'loyalty');
      expect(result).toBe(true);
    });

    it('should return false for disabled feature', async () => {
      mockPrisma.adminConfig.findMany.mockResolvedValue([
        { key: 'client_config', value: mockDeoleo },
      ]);
      const result = await service.isFeatureEnabled('deoleo', 'selfEnrollment');
      expect(result).toBe(false);
    });

    it('should return false for unknown feature key', async () => {
      mockPrisma.adminConfig.findMany.mockResolvedValue([
        { key: 'client_config', value: mockDeoleo },
      ]);
      const result = await service.isFeatureEnabled('deoleo', 'nonExistentFeature');
      expect(result).toBe(false);
    });
  });

  describe('Multi-tenant isolation', () => {
    it('should never return data for a different clientId', async () => {
      mockPrisma.adminConfig.findMany.mockResolvedValue([]);
      await expect(service.resolveClient('competitor')).rejects.toThrow(NotFoundException);
    });
  });
});
