import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ListPartnerTargetsQueryDto } from './dto/partner.dto';

/**
 * Partner self-service — ported from platform/src/app/api/partner/* onto /v1.
 * Every query is tenant-scoped by clientId (from the session-bound JWT) and
 * additionally scoped to the caller's own partner/user (user.sub), preserving
 * the source routes' ownership scoping. Business logic lives here; the
 * controller is a thin HTTP adapter.
 *
 * NOTE: the source PATCH /partner/invoices/[id] route was NOT ported — it reads
 * an in-memory MOCK_VISIBILITY_INVOICES array (lib/invoice.ts), not a Prisma
 * model, so there is no real table to back it.
 */
@Injectable()
export class PartnerService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly bannerSettingKey = 'banner_config';

  /**
   * GET /v1/partner/banners — active banner + popup config for the caller's
   * tenant. All authenticated roles may read. Reads the real ProgramSetting
   * row (banner_config); the source route's dev-only mock fallback is dropped.
   */
  async getBanners(user: JwtPayload) {
    const setting = await this.prisma.programSetting.findFirst({
      where: { clientId: user.clientId, settingKey: this.bannerSettingKey },
    });

    const config = (setting?.settingValue as {
      banners?: unknown[];
      popups?: unknown[];
    } | null) ?? { banners: [], popups: [] };

    return {
      banners: config.banners ?? [],
      popups: config.popups ?? [],
    };
  }

  /**
   * GET /v1/partner/payouts — the caller's own payout history (most recent 100).
   * Scoped to the caller's channel partner within the tenant; returns an empty
   * list when the caller has no channel partner.
   */
  async getPayouts(user: JwtPayload) {
    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId: user.sub, clientId: user.clientId },
      select: { id: true },
    });
    if (!partner) return { payouts: [] };

    const transactions = await this.prisma.payoutTransaction.findMany({
      where: { partnerId: partner.id },
      include: {
        batch: {
          select: { batchCode: true, notes: true, createdAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const payouts = transactions.map((t) => ({
      id: t.id,
      period: this.toPeriod(t.completedAt ?? t.createdAt),
      kpiLabel: t.batch?.notes ?? 'Incentive Payout',
      achievedPct: 100,
      payoutAmountInr: Math.round(t.netAmountPaise / 100),
      uploadedAt: (t.batch?.createdAt ?? t.createdAt).toISOString(),
      utr: t.providerRefId ?? undefined,
      paidAt: t.completedAt?.toISOString() ?? undefined,
      status: this.mapPayoutStatus(t.status),
      narration: t.batch?.notes ?? undefined,
    }));

    return { payouts };
  }

  /**
   * GET /v1/partner/targets — the caller's active scheme targets for the tenant.
   * Optional `period` ("YYYY-MM") filters to schemes overlapping that month.
   */
  async getTargets(user: JwtPayload, q: ListPartnerTargetsQueryDto) {
    const period = q.period ?? null; // e.g. "2026-05"; null = all active

    // Build period date bounds once — used in the Prisma scheme where filter.
    let periodStart: Date | null = null;
    let periodEnd: Date | null = null;
    if (period) {
      const [y, m] = period.split('-').map(Number);
      if (!isNaN(y) && !isNaN(m)) {
        periodStart = new Date(y, m - 1, 1);
        periodEnd = new Date(y, m, 0);
      }
    }

    // Period filter pushed into the scheme where so take:20 applies after filtering.
    const schemeWhere: Prisma.SchemeWhereInput = { clientId: user.clientId };
    if (periodStart && periodEnd) {
      schemeWhere.AND = [
        { OR: [{ startDate: { lte: periodEnd } }] },
        { OR: [{ endDate: { gte: periodStart } }] },
      ];
    }

    const schemeTargets = await this.prisma.schemeTarget.findMany({
      where: {
        userId: user.sub,
        status: 'ACTIVE',
        scheme: schemeWhere,
      },
      include: {
        scheme: {
          select: {
            id: true,
            name: true,
            endDate: true,
            startDate: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const targets = schemeTargets.map((t) => ({
      id: t.id,
      schemeId: t.schemeId,
      schemeName: t.scheme?.name ?? '',
      period: period ?? '',
      targetValue: t.targetValue,
      achievedValue: t.achievedValue,
      percentage:
        t.targetValue > 0
          ? Math.min(100, Math.round((t.achievedValue / t.targetValue) * 100))
          : 0,
      status: t.status,
      incentiveEarnable: t.projectedIncentive ?? 0,
    }));

    return { targets };
  }

  private toPeriod(d: Date): string {
    const yr = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    return `${yr}-${mo}`;
  }

  private mapPayoutStatus(s: string): 'PAID' | 'PENDING' | 'PROCESSING' | 'FAILED' {
    if (s === 'PAID' || s === 'COMPLETED') return 'PAID';
    if (s === 'FAILED' || s === 'REVERSED') return 'FAILED';
    if (s === 'INITIATED' || s === 'PROCESSING') return 'PROCESSING';
    return 'PENDING';
  }
}
