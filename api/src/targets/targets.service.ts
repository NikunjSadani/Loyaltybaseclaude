import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface TargetRow {
  partnerId:        string;
  periodStartDate:  string;
  periodEndDate:    string;
  targetValuePaise?: number;
  targetQty?:       number;
  targetPoints?:    number;
  schemeId?:        string;
  salesUserId?:     string;
}

export interface UpsertResult {
  upserted: number;
  errors:   string[];
}

@Injectable()
export class TargetsService {
  private readonly logger = new Logger(TargetsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Upsert targets (from admin Excel upload) ──────────────────────────────

  async upsertTargets(schemeId: string | null, rows: TargetRow[]): Promise<UpsertResult> {
    const result: UpsertResult = { upserted: 0, errors: [] };

    for (const row of rows) {
      try {
        const start = new Date(row.periodStartDate);
        const end   = new Date(row.periodEndDate);

        // Find existing target for this partner×scheme×period
        const existing = await this.prisma.target.findFirst({
          where: { partnerId: row.partnerId, schemeId: schemeId ?? null, periodStartDate: start },
        });

        await this.prisma.target.upsert({
          where: { id: existing?.id ?? 'new' },
          create: {
            partnerId:        row.partnerId,
            schemeId:         schemeId ?? null,
            salesUserId:      row.salesUserId ?? null,
            period:           'MONTHLY' as any,
            periodStartDate:  start,
            periodEndDate:    end,
            targetValuePaise: row.targetValuePaise ?? null,
            targetQty:        row.targetQty ?? null,
            targetPoints:     row.targetPoints ?? null,
            status:           'ACTIVE' as any,
          },
          update: {
            targetValuePaise: row.targetValuePaise ?? null,
            targetQty:        row.targetQty ?? null,
            targetPoints:     row.targetPoints ?? null,
            periodEndDate:    end,
          },
        });
        result.upserted++;
      } catch (e) {
        result.errors.push(`${row.partnerId}@${row.periodStartDate}: ${(e as Error).message}`);
      }
    }

    this.logger.log(`Upserted ${result.upserted} targets, ${result.errors.length} errors`);
    return result;
  }

  // ── Achievement calculation (pure) ───────────────────────────────────────

  /** Returns achievement % capped at 100. Returns 0 if target is 0. */
  calculateAchievementPercent(achievedPaise: number, targetPaise: number): number {
    if (!targetPaise) return 0;
    return Math.min(100, Math.round((achievedPaise / targetPaise) * 100));
  }

  // ── List targets ──────────────────────────────────────────────────────────

  async listTargets(opts: {
    partnerId?:  string;
    schemeId?:   string;
    month?:      string;   // 'YYYY-MM' — filters by periodStartDate
    status?:     string;
    page?:       number;
    limit?:      number;
  } = {}) {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 50;
    const skip  = (page - 1) * limit;
    const where: any = {};

    if (opts.partnerId) where.partnerId = opts.partnerId;
    if (opts.schemeId)  where.schemeId  = opts.schemeId;
    if (opts.status)    where.status    = opts.status;

    if (opts.month) {
      const [year, mon] = opts.month.split('-').map(Number);
      const start = new Date(year, mon - 1, 1);
      const end   = new Date(year, mon, 0, 23, 59, 59);
      where.periodStartDate = { gte: start, lte: end };
    }

    const [data, total] = await Promise.all([
      this.prisma.target.findMany({
        where, skip, take: limit,
        orderBy: { periodStartDate: 'desc' },
        include: { achievements: true },
      }),
      this.prisma.target.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }
}
