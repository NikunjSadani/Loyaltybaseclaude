import { Injectable } from '@nestjs/common';
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
      payoutAmountPaise: Number(t.netAmountPaise),
      uploadedAt: (t.batch?.createdAt ?? t.createdAt).toISOString(),
      utr: t.providerRefId ?? undefined,
      paidAt: t.completedAt?.toISOString() ?? undefined,
      status: this.mapPayoutStatus(t.status),
      narration: t.batch?.notes ?? undefined,
    }));

    return { payouts };
  }

  /**
   * GET /v1/partner/targets — the caller's own outlets' target + achievement +
   * pace per KPI for the requested month (or the most-recent month with data).
   *
   * Rewired from SchemeTarget (P4.1 dropped scheme-scoped targets) to the real
   * per-outlet × KPI × month model:
   *   - OutletTarget.targetValues   — target side
   *   - OutletSalesRecord.kpiValues — achievement side
   *
   * Joins on (clientId, outletCode, month).  Pace = achieved ÷ target;
   * target absent or 0 → pace null (divide-by-zero guard).
   *
   * Caller scoping: the partner's outlets are looked up via ChannelPartner
   * (userId → id → Outlet[]) so only the caller's own outlets are returned.
   * Tenant scope: every query is filtered by clientId from the JWT.
   */
  async getTargets(user: JwtPayload, q: ListPartnerTargetsQueryDto) {
    // ── Resolve the caller's ChannelPartner + their outlet codes ─────────────
    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId: user.sub, clientId: user.clientId },
      select: { id: true },
    });

    if (!partner) return { period: q.period ?? null, outlets: [] };

    const outlets = await this.prisma.outlet.findMany({
      where: {
        clientId: user.clientId,
        partnerId: partner.id,
        isActive: true,
        deletedAt: null,
      },
      select: { outletCode: true },
    });

    if (outlets.length === 0) return { period: q.period ?? null, outlets: [] };

    const outletCodes = outlets.map((o) => o.outletCode);

    // ── Determine the month to query ──────────────────────────────────────────
    // If the caller passes a period, use it.  Otherwise, find the most-recent
    // month for which this partner has any target data.
    let month: string | null = q.period ?? null;

    if (!month) {
      const latest = await this.prisma.outletTarget.findFirst({
        where: { clientId: user.clientId, outletCode: { in: outletCodes } },
        orderBy: { month: 'desc' },
        select: { month: true },
      });
      month = latest?.month ?? null;
    }

    if (!month) return { period: null, outlets: [] };

    const whereBase = {
      clientId: user.clientId,
      month,
      outletCode: { in: outletCodes },
    };

    // ── Fetch both sides in parallel ──────────────────────────────────────────
    const [targetRows, achievementRows] = await Promise.all([
      this.prisma.outletTarget.findMany({
        where: whereBase,
        select: { outletCode: true, outletName: true, outletType: true, targetValues: true },
      }),
      this.prisma.outletSalesRecord.findMany({
        where: whereBase,
        select: { outletCode: true, kpiValues: true },
      }),
    ]);

    const targetIndex      = new Map(targetRows.map((r) => [r.outletCode, r]));
    const achievementIndex = new Map(achievementRows.map((r) => [r.outletCode, r]));

    const allOutletCodes = new Set([...targetIndex.keys(), ...achievementIndex.keys()]);

    const result = [...allOutletCodes]
      .sort()
      .map((outletCode) => {
        const tRow = targetIndex.get(outletCode);
        const aRow = achievementIndex.get(outletCode);

        const targetValues  = (tRow?.targetValues  ?? {}) as Record<string, number>;
        const kpiValues     = (aRow?.kpiValues     ?? {}) as Record<string, number>;

        const allKpiCodes = new Set([
          ...Object.keys(targetValues),
          ...Object.keys(kpiValues),
        ]);

        const kpis = [...allKpiCodes].map((code) => {
          const target  = Object.prototype.hasOwnProperty.call(targetValues, code)
            ? targetValues[code]
            : null;
          const achieved = Object.prototype.hasOwnProperty.call(kpiValues, code)
            ? kpiValues[code]
            : null;

          // Divide-by-zero guard: target absent OR target===0 → pace null
          let pace: number | null = null;
          if (target !== null && target !== 0 && achieved !== null) {
            pace = achieved / target;
          }

          return { code, target, achieved, pace };
        });

        return {
          outletCode,
          outletName: tRow?.outletName ?? outletCode,
          outletType: tRow?.outletType ?? '',
          kpis,
        };
      });

    return { period: month, outlets: result };
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
