import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ListLeaderboardQueryDto } from './dto/leaderboard.dto';

/**
 * Leaderboard — ported from platform/src/app/api/leaderboard/* onto /v1.
 * Tenant-scoped by clientId (from the session-bound JWT): only the latest
 * published snapshot for a config owned by the caller's tenant is returned.
 * Business logic lives here; the controller is a thin HTTP adapter.
 */
@Injectable()
export class LeaderboardService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /v1/leaderboard — the latest published leaderboard for the caller's tenant. */
  async list(user: JwtPayload, q: ListLeaderboardQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const skip = (page - 1) * limit;

    // Get the latest published snapshot for a config in the caller's tenant.
    const snapshot = await this.prisma.leaderboardSnapshot.findFirst({
      where: { isPublished: true, config: { clientId: user.clientId } },
      orderBy: { snapshotDate: 'desc' },
    });

    if (!snapshot) {
      return {
        leaderboard: [],
        currentPartnerId: null,
        snapshotDate: null,
        pagination: { page, limit, total: 0, pages: 0 },
      };
    }

    const [entries, total, currentPartner] = await Promise.all([
      this.prisma.leaderboardEntry.findMany({
        where: { snapshotId: snapshot.id },
        include: {
          partner: { select: { id: true, businessName: true } },
        },
        orderBy: { rank: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.leaderboardEntry.count({ where: { snapshotId: snapshot.id } }),
      this.prisma.channelPartner.findFirst({
        where: { userId: user.sub, clientId: user.clientId },
        select: { id: true },
      }),
    ]);

    const currentPartnerId = currentPartner?.id ?? null;

    const ranked = entries.map((e) => ({
      rank: e.rank,
      partnerId: e.partnerId,
      partnerName: e.partner?.businessName ?? 'Unknown',
      score: e.score,
      rankChange: e.rankChange,
    }));

    return {
      leaderboard: ranked,
      currentPartnerId,
      snapshotDate: snapshot.snapshotDate,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }
}
