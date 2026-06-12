// TDD — LeaderboardService
// RED: all tests fail until leaderboard.service.ts is implemented.
//
// Covers:
//   L1: getLeaderboard returns entries from latest published snapshot
//   L2: getLeaderboard returns empty result when no published snapshot exists
//   L3: computeSnapshot ranks partners by redeemablePoints descending
//   L4: publishSnapshot sets isPublished = true on the snapshot
//   LA1: createConfig persists config with clientId
//   LA2: listConfigs returns all configs for the clientId

import { Test, TestingModule }             from '@nestjs/testing';
import { NotFoundException }               from '@nestjs/common';
import { LeaderboardService }              from './leaderboard.service';
import { PrismaService }                   from '../prisma/prisma.service';

// ── Shared mock ───────────────────────────────────────────────────────────────

const mockPrisma = {
  leaderboardConfig:   { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
  leaderboardSnapshot: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  leaderboardEntry:    { findMany: jest.fn(), count: jest.fn(), createMany: jest.fn(),
                         deleteMany: jest.fn() },
  channelPartner:      { findMany: jest.fn() },
  wallet:              { findMany: jest.fn() },
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const config = {
  id: 'cfg_1', clientId: 'client_a',
  leaderboardType: 'POINTS_EARNED', period: 'MONTHLY', topN: 10, isActive: true,
};

const snapshot = {
  id: 'snap_1', configId: 'cfg_1', isPublished: true,
  snapshotDate: new Date(), periodStartDate: new Date(), periodEndDate: new Date(),
  config,
};

const entries = [
  { id: 'e_1', snapshotId: 'snap_1', partnerId: 'cp_1', rank: 1, score: 1000,
    rankChange: 0, partner: { id: 'cp_1', businessName: 'ABC Retailers', partnerClassId: 'pc_1' } },
  { id: 'e_2', snapshotId: 'snap_1', partnerId: 'cp_2', rank: 2, score: 800,
    rankChange: 1, partner: { id: 'cp_2', businessName: 'XYZ Traders', partnerClassId: 'pc_1' } },
];

// ─────────────────────────────────────────────────────────────────────────────

describe('LeaderboardService', () => {
  let service: LeaderboardService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LeaderboardService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<LeaderboardService>(LeaderboardService);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(service).toBeDefined());

  // ── Get leaderboard ───────────────────────────────────────────────────────

  describe('getLeaderboard', () => {
    it('L1: returns entries from the latest published snapshot', async () => {
      mockPrisma.leaderboardSnapshot.findFirst.mockResolvedValue(snapshot);
      mockPrisma.leaderboardEntry.findMany.mockResolvedValue(entries);
      mockPrisma.leaderboardEntry.count.mockResolvedValue(2);

      const result = await service.getLeaderboard('client_a', {});

      expect(result.leaderboard).toHaveLength(2);
      expect(result.leaderboard[0].rank).toBe(1);
      expect(result.leaderboard[0].partnerName).toBe('ABC Retailers');
    });

    it('L2: returns empty result when no published snapshot exists', async () => {
      mockPrisma.leaderboardSnapshot.findFirst.mockResolvedValue(null);

      const result = await service.getLeaderboard('client_a', {});

      expect(result.leaderboard).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
    });
  });

  // ── Compute snapshot ──────────────────────────────────────────────────────

  describe('computeSnapshot', () => {
    it('L3: creates snapshot entries ranked by wallet redeemablePoints desc', async () => {
      mockPrisma.leaderboardConfig.findFirst.mockResolvedValue(config);
      mockPrisma.channelPartner.findMany.mockResolvedValue([
        { id: 'cp_1', businessName: 'ABC', partnerClassId: 'pc_1',
          wallets: [{ redeemablePoints: 1000 }] },
        { id: 'cp_2', businessName: 'XYZ', partnerClassId: 'pc_1',
          wallets: [{ redeemablePoints: 800 }] },
      ]);
      // Previous snapshot for rankChange calculation
      mockPrisma.leaderboardSnapshot.findFirst.mockResolvedValue(null);
      mockPrisma.leaderboardSnapshot.create.mockResolvedValue({
        id: 'snap_new', configId: 'cfg_1', isPublished: false,
        snapshotDate: new Date(), periodStartDate: new Date(), periodEndDate: new Date(),
      });
      mockPrisma.leaderboardEntry.createMany.mockResolvedValue({ count: 2 });

      const result = await service.computeSnapshot('cfg_1', 'client_a');

      expect(result.snapshotId).toBeDefined();
      expect(result.entryCount).toBe(2);
      // Entries must be created in rank order (highest points = rank 1)
      expect(mockPrisma.leaderboardEntry.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ partnerId: 'cp_1', rank: 1 }),
            expect.objectContaining({ partnerId: 'cp_2', rank: 2 }),
          ]),
        }),
      );
    });

    it('L3b: throws NotFoundException if config not found', async () => {
      mockPrisma.leaderboardConfig.findFirst.mockResolvedValue(null);

      await expect(
        service.computeSnapshot('missing_cfg', 'client_a'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Publish snapshot ──────────────────────────────────────────────────────

  describe('publishSnapshot', () => {
    it('L4: sets isPublished = true on the snapshot', async () => {
      mockPrisma.leaderboardSnapshot.findFirst.mockResolvedValue({
        ...snapshot, isPublished: false,
      });
      mockPrisma.leaderboardSnapshot.update.mockResolvedValue({
        ...snapshot, isPublished: true, publishedAt: new Date(),
      });

      const result = await service.publishSnapshot('snap_1', 'client_a');

      expect(result.isPublished).toBe(true);
      expect(mockPrisma.leaderboardSnapshot.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isPublished: true }),
        }),
      );
    });
  });

  // ── Admin: Config management ──────────────────────────────────────────────

  describe('Admin configs', () => {
    const createDto = {
      code: 'LB_MONTHLY', name: 'Monthly Points Board',
      leaderboardType: 'POINTS_EARNED', period: 'MONTHLY', topN: 10,
    };

    it('LA1: createConfig persists config with clientId', async () => {
      mockPrisma.leaderboardConfig.create.mockResolvedValue({
        id: 'cfg_new', clientId: 'client_a', isActive: true, ...createDto,
      });

      const result = await (service as any).createConfig('client_a', createDto);

      expect(result.clientId).toBe('client_a');
      expect(mockPrisma.leaderboardConfig.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            clientId:        'client_a',
            leaderboardType: 'POINTS_EARNED',
            period:          'MONTHLY',
          }),
        }),
      );
    });

    it('LA2: listConfigs returns all configs for the clientId', async () => {
      mockPrisma.leaderboardConfig.findMany.mockResolvedValue([config, { ...config, id: 'cfg_2' }]);

      const result = await (service as any).listConfigs('client_a');

      expect(result).toHaveLength(2);
      expect(mockPrisma.leaderboardConfig.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { clientId: 'client_a' } }),
      );
    });
  });
});
