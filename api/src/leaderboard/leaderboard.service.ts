import {
  Injectable, NotFoundException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLeaderboardConfigDto } from './dto/leaderboard-admin.dto';

interface GetLeaderboardOpts {
  configId?: string;
  page?:     number;
  limit?:    number;
}

@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Admin: Config management ───────────────────────────────────────────────

  async listConfigs(clientId: string) {
    return this.prisma.leaderboardConfig.findMany({
      where:   { clientId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createConfig(clientId: string, dto: CreateLeaderboardConfigDto) {
    return this.prisma.leaderboardConfig.create({
      data: {
        clientId,
        code:            dto.code,
        name:            dto.name,
        description:     dto.description   ?? null,
        leaderboardType: dto.leaderboardType as any,
        period:          dto.period          as any,
        topN:            dto.topN,
        rewardPoints:    dto.rewardPoints   ?? null,
        eligibleClasses: (dto.eligibleClasses ?? []) as any,
      },
    });
  }

  // ── Get leaderboard ────────────────────────────────────────────────────────

  async getLeaderboard(clientId: string, opts: GetLeaderboardOpts) {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 50;
    const skip  = (page - 1) * limit;

    const snapshotWhere: any = { isPublished: true, config: { clientId } };
    if (opts.configId) snapshotWhere.configId = opts.configId;

    const snapshot = await this.prisma.leaderboardSnapshot.findFirst({
      where:   snapshotWhere,
      orderBy: { snapshotDate: 'desc' },
    });

    if (!snapshot) {
      return {
        leaderboard:  [],
        snapshotDate: null,
        pagination:   { page, limit, total: 0, pages: 0 },
      };
    }

    const [entries, total] = await Promise.all([
      this.prisma.leaderboardEntry.findMany({
        where:   { snapshotId: snapshot.id },
        include: { partner: { select: { id: true, businessName: true, partnerClassId: true } } },
        orderBy: { rank: 'asc' },
        skip,
        take:    limit,
      }),
      this.prisma.leaderboardEntry.count({ where: { snapshotId: snapshot.id } }),
    ]);

    const leaderboard = entries.map((e) => ({
      rank:        e.rank,
      partnerId:   e.partnerId,
      partnerName: e.partner?.businessName ?? 'Unknown',
      score:       e.score,
      rankChange:  e.rankChange,
    }));

    return {
      leaderboard,
      snapshotDate: snapshot.snapshotDate,
      pagination:   { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  // ── Compute snapshot ───────────────────────────────────────────────────────

  async computeSnapshot(configId: string, clientId: string) {
    const config = await this.prisma.leaderboardConfig.findFirst({
      where: { id: configId, clientId },
    });
    if (!config) throw new NotFoundException('Leaderboard config not found');

    // Get all active partners with their wallets
    const partners = await this.prisma.channelPartner.findMany({
      where:   { clientId, isActive: true },
      include: { wallets: { select: { redeemablePoints: true } } },
    });

    // Sort by redeemablePoints descending (can extend to other leaderboard types)
    const sorted = [...partners].sort((a, b) => {
      const aPoints = a.wallets[0]?.redeemablePoints ?? 0;
      const bPoints = b.wallets[0]?.redeemablePoints ?? 0;
      return bPoints - aPoints;
    });

    // Apply topN cap
    const topN    = config.topN ?? 10;
    const ranked  = sorted.slice(0, topN);

    // Previous snapshot for rankChange calculation
    const prevSnapshot = await this.prisma.leaderboardSnapshot.findFirst({
      where:   { configId, isPublished: true },
      orderBy: { snapshotDate: 'desc' },
      include: { entries: { select: { partnerId: true, rank: true } } },
    });
    const prevRankMap = new Map<string, number>();
    prevSnapshot?.entries.forEach((e) => prevRankMap.set(e.partnerId, e.rank));

    // Create snapshot record
    const now = new Date();
    const snapshot = await this.prisma.leaderboardSnapshot.create({
      data: {
        configId,
        snapshotDate:    now,
        periodStartDate: now,
        periodEndDate:   now,
        isPublished:     false,
      },
    });

    // Build entry data
    const entryData = ranked.map((p, idx) => {
      const rank       = idx + 1;
      const prevRank   = prevRankMap.get(p.id);
      const rankChange = prevRank !== undefined ? prevRank - rank : null;
      const score      = p.wallets[0]?.redeemablePoints ?? 0;

      return {
        snapshotId:   snapshot.id,
        partnerId:    p.id,
        rank,
        score,
        previousRank: prevRank ?? null,
        rankChange,
      };
    });

    await this.prisma.leaderboardEntry.createMany({ data: entryData });

    this.logger.log(`Leaderboard snapshot computed: ${snapshot.id} (${entryData.length} entries)`);

    return { snapshotId: snapshot.id, entryCount: entryData.length };
  }

  // ── Publish snapshot ───────────────────────────────────────────────────────

  async publishSnapshot(snapshotId: string, clientId: string) {
    const snapshot = await this.prisma.leaderboardSnapshot.findFirst({
      where: { id: snapshotId, config: { clientId } },
    });
    if (!snapshot) throw new NotFoundException('Snapshot not found');

    return this.prisma.leaderboardSnapshot.update({
      where: { id: snapshotId },
      data:  { isPublished: true, publishedAt: new Date() },
    });
  }
}
