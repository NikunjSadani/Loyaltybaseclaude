// Unit tests for LeaderboardService — mirrors the S4 tickets/wallet template.
// Covers tenant scoping, the latest-published-snapshot selection, the
// empty-snapshot shape, and the paginated ranking ported from the Next route.
// Run: npx jest src/leaderboard/leaderboard.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { LeaderboardService } from './leaderboard.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  leaderboardSnapshot: { findFirst: jest.fn() },
  leaderboardEntry: { findMany: jest.fn(), count: jest.fn() },
  channelPartner: { findFirst: jest.fn() },
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' };
// A partner login carrying a real phone (needed for Wave-3 sibling resolution).
const partnerWithPhone: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '9990000001', name: '' };

describe('LeaderboardService', () => {
  let service: LeaderboardService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [LeaderboardService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(LeaderboardService);
  });

  describe('list', () => {
    it('scopes the snapshot lookup to the caller’s tenant and latest published', async () => {
      mockPrisma.leaderboardSnapshot.findFirst.mockResolvedValue(null);
      await service.list(partner, {});
      expect(mockPrisma.leaderboardSnapshot.findFirst).toHaveBeenCalledWith({
        where: { isPublished: true, config: { clientId: 'deoleo' } },
        orderBy: { snapshotDate: 'desc' },
      });
    });

    it('returns the empty shape when there is no published snapshot', async () => {
      mockPrisma.leaderboardSnapshot.findFirst.mockResolvedValue(null);
      const res = await service.list(partner, {});
      expect(res).toEqual({
        leaderboard: [],
        currentPartnerId: null,
        snapshotDate: null,
        pagination: { page: 1, limit: 50, total: 0, pages: 0 },
      });
    });

    it('returns a paginated, ranked leaderboard scoped to the snapshot', async () => {
      const snapshotDate = new Date('2026-01-01');
      mockPrisma.leaderboardSnapshot.findFirst.mockResolvedValue({ id: 's1', snapshotDate });
      mockPrisma.leaderboardEntry.findMany.mockResolvedValue([
        { rank: 1, partnerId: 'cp1', score: 100, rankChange: 2, partner: { id: 'cp1', businessName: 'Acme' } },
      ]);
      mockPrisma.leaderboardEntry.count.mockResolvedValue(1);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });

      const res = await service.list(partner, { page: 1, limit: 50 });

      expect(mockPrisma.leaderboardEntry.findMany).toHaveBeenCalledWith({
        where: { snapshotId: 's1' },
        include: { partner: { select: { id: true, businessName: true } } },
        orderBy: { rank: 'asc' },
        skip: 0,
        take: 50,
      });
      // "Which row is ME" now resolves through the shared active-partner boundary
      // (deletedAt-guarded + groupId for the switch check).
      expect(mockPrisma.channelPartner.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user1', clientId: 'deoleo', deletedAt: null, isParent: false },
        select: { id: true, groupId: true },
      });
      expect(res).toEqual({
        leaderboard: [{ rank: 1, partnerId: 'cp1', partnerName: 'Acme', score: 100, rankChange: 2 }],
        currentPartnerId: 'cp1',
        snapshotDate,
        pagination: { page: 1, limit: 50, total: 1, pages: 1 },
      });
    });

    it('falls back to "Unknown" when the entry has no partner and null currentPartnerId', async () => {
      mockPrisma.leaderboardSnapshot.findFirst.mockResolvedValue({ id: 's1', snapshotDate: new Date('2026-01-01') });
      mockPrisma.leaderboardEntry.findMany.mockResolvedValue([
        { rank: 1, partnerId: 'cp9', score: 50, rankChange: null, partner: null },
      ]);
      mockPrisma.leaderboardEntry.count.mockResolvedValue(1);
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);

      const res = await service.list(gifsy, {});
      expect(res.leaderboard[0].partnerName).toBe('Unknown');
      expect(res.currentPartnerId).toBeNull();
    });

    // ── Wave 3: x-active-partner-id selector (login picker) ────────────────────
    const snapshotFixture = () => {
      mockPrisma.leaderboardSnapshot.findFirst.mockResolvedValue({ id: 's1', snapshotDate: new Date('2026-01-01') });
      mockPrisma.leaderboardEntry.findMany.mockResolvedValue([]);
      mockPrisma.leaderboardEntry.count.mockResolvedValue(0);
    };

    it('no selector → the login’s own partner is "ME"', async () => {
      snapshotFixture();
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', groupId: 'g1' });

      const res = await service.list(partnerWithPhone, {});
      expect(res.currentPartnerId).toBe('cp1');
      // Absent-header hot path: only the own lookup runs (no sibling query).
      expect(mockPrisma.channelPartner.findFirst).toHaveBeenCalledTimes(1);
    });

    it('valid sibling selector → the sibling is "ME"', async () => {
      snapshotFixture();
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', groupId: 'g1' }) // own
        .mockResolvedValueOnce({ id: 'cp2' }); // resolved sibling

      const res = await service.list(partnerWithPhone, {}, 'cp2');
      expect(res.currentPartnerId).toBe('cp2');
    });

    it('forbidden selector → ForbiddenException', async () => {
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', groupId: 'g1' }) // own
        .mockResolvedValueOnce(null); // not an operable sibling
      await expect(
        service.list(partnerWithPhone, {}, 'cp-OTHER'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
