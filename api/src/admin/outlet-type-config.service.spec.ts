// TDD: OutletTypeConfigService
// Tests written BEFORE implementation — run to confirm RED, then implement GREEN.

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { OutletTypeConfigService } from './outlet-type-config.service';
import { PrismaService } from '../prisma/prisma.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

const RETAILER_TYPE  = { id: 'ot_1', code: 'RETAILER',    name: 'Retailer',     isActive: true };
const WHOLESALER_TYPE = { id: 'ot_2', code: 'WHOLESALER',  name: 'Wholesaler',   isActive: true };
const SUB_STOCKIST_TYPE = { id: 'ot_3', code: 'SUB_STOCKIST', name: 'Sub-Stockist', isActive: true };
const SSS_TOT_TYPE   = { id: 'ot_4', code: 'SSS_TOT',     name: 'SSS TOT',      isActive: true };

const ALL_TYPES = [RETAILER_TYPE, WHOLESALER_TYPE, SUB_STOCKIST_TYPE, SSS_TOT_TYPE];

const DEFAULT_FLAGS = {
  isEnabled:          true,
  displayName:        null,
  loyaltyEnabled:     true,
  schemesEnabled:     true,
  visibilityEnabled:  true,
  payoutsEnabled:     true,
  leaderboardEnabled: true,
  targetsEnabled:     true,
  kycRequired:        true,
};

function makeDbConfig(overrides: Record<string, unknown> = {}) {
  return {
    id:           'cfg_1',
    clientId:     'deoleo',
    outletTypeId: 'ot_1',
    createdAt:    new Date(),
    updatedAt:    new Date(),
    metadata:     null,
    ...DEFAULT_FLAGS,
    ...overrides,
  };
}

const mockPrisma = {
  outletType: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  outletTypeClientConfig: {
    findMany: jest.fn(),
    upsert:   jest.fn(),
    findFirst: jest.fn(),
  },
};

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('OutletTypeConfigService', () => {
  let service: OutletTypeConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutletTypeConfigService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<OutletTypeConfigService>(OutletTypeConfigService);
    jest.clearAllMocks();
  });

  // ── A. getAll ──────────────────────────────────────────────────────────────

  describe('A – getAll(clientId)', () => {
    it('A1: returns one config entry per active outlet type', async () => {
      mockPrisma.outletType.findMany.mockResolvedValue(ALL_TYPES);
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([]);

      const result = await service.getAll('deoleo');
      expect(result).toHaveLength(4);
    });

    it('A2: missing DB row is filled with all-defaults', async () => {
      mockPrisma.outletType.findMany.mockResolvedValue([RETAILER_TYPE]);
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([]);

      const [cfg] = await service.getAll('deoleo');
      expect(cfg.isEnabled).toBe(true);
      expect(cfg.loyaltyEnabled).toBe(true);
      expect(cfg.displayName).toBeNull();
      expect(cfg.outletTypeCode).toBe('RETAILER');
    });

    it('A3: existing DB row overrides the defaults', async () => {
      mockPrisma.outletType.findMany.mockResolvedValue([RETAILER_TYPE]);
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        makeDbConfig({ isEnabled: false, displayName: 'Dealer', schemesEnabled: false }),
      ]);

      const [cfg] = await service.getAll('deoleo');
      expect(cfg.isEnabled).toBe(false);
      expect(cfg.displayName).toBe('Dealer');
      expect(cfg.schemesEnabled).toBe(false);
      // Other flags still from the DB row
      expect(cfg.loyaltyEnabled).toBe(true);
    });

    it('A4: only active outlet types are returned', async () => {
      mockPrisma.outletType.findMany.mockResolvedValue([
        RETAILER_TYPE,
        { ...WHOLESALER_TYPE, isActive: false },
      ]);
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([]);

      const result = await service.getAll('deoleo');
      expect(result).toHaveLength(1);
      expect(result[0].outletTypeCode).toBe('RETAILER');
    });
  });

  // ── B. upsert ──────────────────────────────────────────────────────────────

  describe('B – upsert(clientId, code, dto)', () => {
    it('B1: throws NotFoundException when code does not exist', async () => {
      mockPrisma.outletType.findFirst.mockResolvedValue(null);

      await expect(
        service.upsert('deoleo', 'UNKNOWN_CODE', { isEnabled: false }),
      ).rejects.toThrow(NotFoundException);
    });

    it('B2: calls prisma upsert with correct clientId and outletTypeId', async () => {
      mockPrisma.outletType.findFirst.mockResolvedValue(RETAILER_TYPE);
      mockPrisma.outletTypeClientConfig.upsert.mockResolvedValue(makeDbConfig());

      await service.upsert('deoleo', 'RETAILER', { isEnabled: false });

      expect(mockPrisma.outletTypeClientConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { clientId_outletTypeId: { clientId: 'deoleo', outletTypeId: 'ot_1' } },
          create: expect.objectContaining({ clientId: 'deoleo', outletTypeId: 'ot_1', isEnabled: false }),
          update: expect.objectContaining({ isEnabled: false }),
        }),
      );
    });

    it('B3: partial update — only provided fields are applied', async () => {
      mockPrisma.outletType.findFirst.mockResolvedValue(RETAILER_TYPE);
      const saved = makeDbConfig({ schemesEnabled: false });
      mockPrisma.outletTypeClientConfig.upsert.mockResolvedValue(saved);

      const result = await service.upsert('deoleo', 'RETAILER', { schemesEnabled: false });
      expect(result.schemesEnabled).toBe(false);
    });

    it('B4: returns a normalised response with outletTypeCode', async () => {
      mockPrisma.outletType.findFirst.mockResolvedValue(RETAILER_TYPE);
      mockPrisma.outletTypeClientConfig.upsert.mockResolvedValue(makeDbConfig());

      const result = await service.upsert('deoleo', 'RETAILER', { displayName: 'Dealer' });
      expect(result.outletTypeCode).toBe('RETAILER');
      expect(result.clientId).toBe('deoleo');
    });
  });
});
