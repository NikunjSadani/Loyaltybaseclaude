// TDD: TargetsService
// Covers: upsert targets from Excel upload, achievement calculation, list by partner/month

import { Test, TestingModule } from '@nestjs/testing';
import { TargetsService } from './targets.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException } from '@nestjs/common';

const mockPrisma = {
  target:             { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), upsert: jest.fn(), count: jest.fn(), createMany: jest.fn() },
  targetAchievement:  { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), upsert: jest.fn() },
  channelPartner:     { findFirst: jest.fn() },
};

const TARGET = {
  id: 'tgt_1', partnerId: 'cp_1', period: 'MONTHLY',
  periodStartDate: new Date('2026-07-01'), periodEndDate: new Date('2026-07-31'),
  targetValuePaise: 1_000_000, targetQty: null, targetPoints: null,
  status: 'ACTIVE',
};

describe('TargetsService', () => {
  let service: TargetsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TargetsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<TargetsService>(TargetsService);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(service).toBeDefined());

  // ── Upsert targets from admin upload ──────────────────────────────────────

  describe('upsertTargets', () => {
    it('should create targets for each partner×month row', async () => {
      mockPrisma.target.upsert.mockResolvedValue(TARGET);

      const rows = [
        { partnerId: 'cp_1', periodStartDate: '2026-07-01', periodEndDate: '2026-07-31', targetValuePaise: 1_000_000 },
        { partnerId: 'cp_2', periodStartDate: '2026-07-01', periodEndDate: '2026-07-31', targetValuePaise: 500_000 },
      ];

      const result = await service.upsertTargets('scheme_1', rows);
      expect(result.upserted).toBe(2);
      expect(mockPrisma.target.upsert).toHaveBeenCalledTimes(2);
    });

    it('should return errors for failed rows without stopping the batch', async () => {
      mockPrisma.target.upsert
        .mockResolvedValueOnce(TARGET)
        .mockRejectedValueOnce(new Error('DB error'));

      const rows = [
        { partnerId: 'cp_1', periodStartDate: '2026-07-01', periodEndDate: '2026-07-31', targetValuePaise: 1_000_000 },
        { partnerId: 'bad_id', periodStartDate: '2026-07-01', periodEndDate: '2026-07-31', targetValuePaise: 500_000 },
      ];

      const result = await service.upsertTargets('scheme_1', rows);
      expect(result.upserted).toBe(1);
      expect(result.errors).toHaveLength(1);
    });
  });

  // ── Achievement calculation ───────────────────────────────────────────────

  describe('calculateAchievementPercent', () => {
    it('should return 100 when achieved equals target', () => {
      expect(service.calculateAchievementPercent(1_000_000, 1_000_000)).toBe(100);
    });

    it('should return 50 when achieved is half the target', () => {
      expect(service.calculateAchievementPercent(500_000, 1_000_000)).toBe(50);
    });

    it('should cap at 100 even if achieved exceeds target', () => {
      expect(service.calculateAchievementPercent(1_500_000, 1_000_000)).toBe(100);
    });

    it('should return 0 when target is 0 (avoid division by zero)', () => {
      expect(service.calculateAchievementPercent(100_000, 0)).toBe(0);
    });
  });

  // ── List targets ──────────────────────────────────────────────────────────

  describe('listTargets', () => {
    it('should return targets for a partner', async () => {
      mockPrisma.target.findMany.mockResolvedValue([TARGET]);
      mockPrisma.target.count.mockResolvedValue(1);

      const result = await service.listTargets({ partnerId: 'cp_1' });
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should filter by month when provided', async () => {
      mockPrisma.target.findMany.mockResolvedValue([TARGET]);
      mockPrisma.target.count.mockResolvedValue(1);

      await service.listTargets({ partnerId: 'cp_1', month: '2026-07' });

      expect(mockPrisma.target.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ periodStartDate: expect.any(Object) }),
        }),
      );
    });
  });
});
