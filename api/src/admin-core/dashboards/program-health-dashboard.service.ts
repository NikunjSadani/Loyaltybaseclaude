import { Injectable } from '@nestjs/common';
import { Prisma, KycStatus, PointsLedgerType, PayoutMode, RedemptionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantService } from '../../tenant/tenant.service';
import { TenantSettingsService } from '../../tenant/tenant-settings.service';
import { JwtPayload } from '../../common/decorators/current-user.decorator';
import { kpiCodeKeys, lastNMonths, currentMonthKey } from '../../targets/targets.helpers';

/**
 * ProgramHealthDashboardService — REAL, tenant-scoped "program health" aggregation
 * for the admin Program Health dashboard (GET /v1/admin/dashboard/program-health).
 *
 * Tenant scope is resolved identically to AdminCoreService.kycDashboard(): strictly by
 * `user.clientId`. The proxy/JWT layer sets `clientId` to the assumed tenant for an
 * operator-context GIFSY token, so GIFSY-native / assumed-tenant / CLIENT_ADMIN all behave
 * the same. EVERY query below is tenant-filtered — there is no cross-tenant leak.
 *
 * Two traps that bit the KYC dashboard at runtime (carried over here):
 *   1. The outlet "addressable universe" must NOT filter `isActive:true` — new outlets are
 *      created PENDING (isActive=false) until KYC approval, so that filter would erase the
 *      entire in-flight population. Universe = live, non-deleted, non-deactivated, not
 *      NOT_INTERESTED.
 *   2. Prisma `{ not: X }` EXCLUDES NULL rows. Any `not` on a nullable column is wrapped
 *      `OR: [{ col: null }, { col: { not: X } }]` so NULL rows survive.
 *
 * No-compute model: targets/achievement are verbatim numbers stored as JSON
 * (OutletTarget.targetValues / OutletSalesRecord.kpiValues), summed per KpiDef code.
 *
 * Single return shape: returns the `data` payload directly; the global TransformInterceptor
 * envelopes it (so the FE handles both `{success,data}` and bare-object responses).
 */
@Injectable()
export class ProgramHealthDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  // ── safe-math helpers (mirror AdminCoreService) ─────────────────────────────
  private static round1(n: number): number {
    return Math.round(n * 10) / 10;
  }
  /** a/b as a %, guarding /0 → 0. */
  private static pctOf(a: number, b: number): number {
    return b > 0 ? (a / b) * 100 : 0;
  }
  private static median(xs: number[]): number {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
  }

  /** Month boundaries [start, nextMonthStart) for a YYYY-MM key. */
  private static monthRange(month: string): { start: Date; end: Date } {
    const [y, m] = month.split('-').map((x) => parseInt(x, 10));
    // Local-time month boundaries (matches the server clock used everywhere else).
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 1);
    return { start, end };
  }

  /**
   * The addressable-universe `where` clause — the SINGLE source of truth for which outlets
   * "count" for this tenant. NEVER add isActive:true here (trap 1). The kycIntent `not` is
   * wrapped in OR so the (vast majority) NULL-intent outlets survive (trap 2).
   */
  private static addressableWhere(clientId: string): Prisma.OutletWhereInput {
    return {
      clientId,
      deletedAt: null,
      deactivatedAt: null,
      // Exclude BOTH NOT_INTERESTED (sales-declined) and PARKED (admin-removed from the
      // pipeline) from the addressable universe. notIn drops NULL rows, so the {null} OR
      // branch keeps the common null-intent pending outlets.
      OR: [{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }],
    };
  }

  /**
   * GET /v1/admin/dashboard/program-health.
   *
   * @param user   JWT — only user.clientId is used for tenant scope.
   * @param period YYYY-MM; defaults to the current month (server clock).
   */
  async programHealth(user: JwtPayload, period?: string) {
    const clientId = user.clientId;
    const now = new Date();
    const periodKey =
      period && /^\d{4}-\d{2}$/.test(period) ? period : currentMonthKey(now);
    const { start: periodStart, end: periodEnd } = ProgramHealthDashboardService.monthRange(periodKey);

    // PointsLedger has no clientId column; it joins to the tenant via
    // wallet → partner → user.clientId (the canonical tenant tag for a partner).
    const ledgerTenant: Prisma.PointsLedgerWhereInput = {
      wallet: { partner: { user: { clientId } } },
    };

    const addressableWhere = ProgramHealthDashboardService.addressableWhere(clientId);

    // ── Pull every addressable outlet ONCE with its owner + latest KYC submission ──
    // (mirrors buildOutlets/kycDashboard: latest submission = orderBy createdAt desc take 1).
    const outlets = await this.prisma.outlet.findMany({
      where: addressableWhere,
      select: {
        id: true,
        createdAt: true,
        partnerId: true,
        partner: {
          select: {
            id: true,
            kycSubmissions: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { status: true, approvedAt: true },
            },
            // Has the partner EVER earned? (≥1 EARN ledger row — any period.)
            wallets: {
              select: {
                pointsLedger: {
                  where: { transactionType: 'EARN' },
                  take: 1,
                  select: { id: true },
                },
              },
            },
            // Has the partner EVER redeemed past PENDING? (≥1 non-PENDING order.)
            redemptionOrders: {
              where: { status: { not: 'PENDING' } },
              take: 1,
              select: { id: true },
            },
          },
        },
      },
    });

    // ── ACTIVATION funnel ───────────────────────────────────────────────────────
    const registered = outlets.length;
    let kycApproved = 0;
    let firstEarn = 0;
    let firstRedeem = 0;
    const activateDays: number[] = []; // (approvedAt − outlet.createdAt) in days, approved only

    for (const o of outlets) {
      const sub = o.partner?.kycSubmissions[0] ?? null;
      const approved = sub?.status === ('APPROVED' as KycStatus);
      if (approved) {
        kycApproved += 1;
        if (sub?.approvedAt) {
          const days = (sub.approvedAt.getTime() - o.createdAt.getTime()) / 86_400_000;
          if (Number.isFinite(days) && days >= 0) activateDays.push(days);
        }
      }
      const hasEarn = (o.partner?.wallets ?? []).some((w) => w.pointsLedger.length > 0);
      if (hasEarn) firstEarn += 1;
      if ((o.partner?.redemptionOrders ?? []).length > 0) firstRedeem += 1;
    }

    // ── PARTICIPATION (active earners this period + 6-month trend) ───────────────
    // An outlet is an "active earner" in a month if its partner has an EARN ledger row
    // created in that month. We compute per partner once, then map back to addressable
    // outlets (an outlet without a partner can never be an active earner).
    const trendMonths = lastNMonths(6, now); // oldest→newest, includes current
    // Ensure the requested period is covered for the headline even if it is not in the
    // trailing-6 window (e.g. a back-dated period query).
    const allMonths = Array.from(new Set([...trendMonths, periodKey]));
    const monthRanges = new Map<string, { start: Date; end: Date }>();
    for (const m of allMonths) monthRanges.set(m, ProgramHealthDashboardService.monthRange(m));

    const earliest = allMonths
      .map((m) => monthRanges.get(m)!.start.getTime())
      .reduce((a, b) => Math.min(a, b), Infinity);
    const latest = allMonths
      .map((m) => monthRanges.get(m)!.end.getTime())
      .reduce((a, b) => Math.max(a, b), -Infinity);

    // Distinct partners with EARN rows across the union window, with the row's createdAt,
    // so we can bucket per month in memory (one grouped query, no per-month N+1).
    const earnRows = await this.prisma.pointsLedger.findMany({
      where: {
        ...ledgerTenant,
        transactionType: 'EARN',
        createdAt: { gte: new Date(earliest), lt: new Date(latest) },
      },
      select: { createdAt: true, wallet: { select: { partnerId: true } } },
    });

    // addressable partnerIds — only these count toward participation.
    const addressablePartnerIds = new Set<string>();
    for (const o of outlets) if (o.partnerId) addressablePartnerIds.add(o.partnerId);

    const activeByMonth = new Map<string, Set<string>>();
    for (const m of allMonths) activeByMonth.set(m, new Set<string>());
    for (const row of earnRows) {
      const pid = row.wallet?.partnerId;
      if (!pid || !addressablePartnerIds.has(pid)) continue;
      const t = row.createdAt.getTime();
      for (const m of allMonths) {
        const r = monthRanges.get(m)!;
        if (t >= r.start.getTime() && t < r.end.getTime()) activeByMonth.get(m)!.add(pid);
      }
    }

    const addressable = registered;
    const activeEarnersThisMonth = activeByMonth.get(periodKey)?.size ?? 0;
    const activeRatePct = ProgramHealthDashboardService.round1(
      ProgramHealthDashboardService.pctOf(activeEarnersThisMonth, addressable),
    );
    const trend = trendMonths.map((m) => ({
      month: m,
      activeEarners: activeByMonth.get(m)?.size ?? 0,
    }));

    // ── POINTS ECONOMY ──────────────────────────────────────────────────────────
    const conversionRate = await this.tenantSettings.getConversionRate(clientId);

    const [issuedAgg, redeemAgg, expireAgg, liabilityAgg, expiringAgg] = await Promise.all([
      // issued = Σ EARN points in period
      this.prisma.pointsLedger.aggregate({
        _sum: { points: true },
        where: { ...ledgerTenant, transactionType: 'EARN', createdAt: { gte: periodStart, lt: periodEnd } },
      }),
      // redeemed = Σ |REDEEM points| in period (REDEEM rows are stored negative)
      this.prisma.pointsLedger.aggregate({
        _sum: { points: true },
        where: { ...ledgerTenant, transactionType: 'REDEEM', createdAt: { gte: periodStart, lt: periodEnd } },
      }),
      // expired = Σ EXPIRE points in period (for the period-only breakage formula)
      this.prisma.pointsLedger.aggregate({
        _sum: { points: true },
        where: { ...ledgerTenant, transactionType: 'EXPIRE', createdAt: { gte: periodStart, lt: periodEnd } },
      }),
      // outstanding liability = Σ Wallet.redeemablePoints for this tenant's partners
      this.prisma.wallet.aggregate({
        _sum: { redeemablePoints: true },
        where: { partner: { user: { clientId } } },
      }),
      // expiring in 30d = Σ EARN points not yet expired whose expiresAt ∈ [now, now+30d]
      this.prisma.pointsLedger.aggregate({
        _sum: { points: true },
        where: {
          ...ledgerTenant,
          transactionType: 'EARN',
          isExpired: false,
          expiresAt: { gte: now, lt: new Date(now.getTime() + 30 * 86_400_000) },
        },
      }),
    ]);

    const issued = issuedAgg._sum.points ?? 0;
    const redeemed = Math.abs(redeemAgg._sum.points ?? 0);
    const expiredInPeriod = Math.abs(expireAgg._sum.points ?? 0);
    const outstandingLiabilityPoints = liabilityAgg._sum.redeemablePoints ?? 0;
    const outstandingLiabilityRupees =
      conversionRate > 0
        ? ProgramHealthDashboardService.round1(outstandingLiabilityPoints / conversionRate)
        : 0;
    // PERIOD-ONLY breakage = EXPIRE ÷ EARN in the period (guard /0 → 0).
    const breakagePct = ProgramHealthDashboardService.round1(
      ProgramHealthDashboardService.pctOf(expiredInPeriod, issued),
    );
    const expiringIn30dPoints = expiringAgg._sum.points ?? 0;

    // ── TARGET ACHIEVEMENT (no-compute rollup across addressable outlets) ────────
    // KpiDefs for the tenant (enabled, ordered). Sum targetValues[code] and kpiValues[code]
    // across ALL addressable outlets for the period, keyed by outletCode. We restrict the
    // target/achievement rows to addressable outletCodes so a deactivated/NOT_INTERESTED
    // outlet's stale numbers never inflate the rollup.
    const [kpiDefs, addressableOutletRows] = await Promise.all([
      this.prisma.kpiDef.findMany({
        where: { clientId, enabled: true },
        orderBy: { order: 'asc' },
        select: { code: true, label: true, unit: true, isPrimary: true },
      }),
      this.prisma.outlet.findMany({ where: addressableWhere, select: { outletCode: true } }),
    ]);

    const addressableCodes = new Set(addressableOutletRows.map((o) => o.outletCode));

    const [targetRows, salesRows] = await Promise.all([
      this.prisma.outletTarget.findMany({
        where: { clientId, month: periodKey },
        select: { outletCode: true, targetValues: true },
      }),
      this.prisma.outletSalesRecord.findMany({
        where: { clientId, month: periodKey },
        select: { outletCode: true, kpiValues: true },
      }),
    ]);

    const targetSum = new Map<string, number>(); // kpiCode → Σ target
    const achievedSum = new Map<string, number>(); // kpiCode → Σ achieved

    const accumulate = (
      rows: { outletCode: string; values: unknown }[],
      into: Map<string, number>,
    ) => {
      for (const r of rows) {
        if (!addressableCodes.has(r.outletCode)) continue; // only addressable outlets
        const vals = (r.values ?? {}) as Record<string, unknown>;
        for (const code of kpiCodeKeys(vals)) {
          const v = vals[code];
          if (typeof v === 'number' && Number.isFinite(v)) {
            into.set(code, (into.get(code) ?? 0) + v);
          }
        }
      }
    };
    accumulate(
      targetRows.map((r) => ({ outletCode: r.outletCode, values: r.targetValues })),
      targetSum,
    );
    accumulate(
      salesRows.map((r) => ({ outletCode: r.outletCode, values: r.kpiValues })),
      achievedSum,
    );

    const kpis = kpiDefs.map((k) => {
      const target = targetSum.get(k.code) ?? 0;
      const achieved = achievedSum.get(k.code) ?? 0;
      // pct is null when there is no positive target (can't divide by ≤0).
      const pct = target > 0 ? ProgramHealthDashboardService.round1((achieved / target) * 100) : null;
      return {
        kpiCode: k.code,
        kpiName: k.label,
        unit: k.unit ?? '',
        target,
        achieved,
        pct,
        isPrimary: k.isPrimary,
      };
    });
    const primary = kpis.find((k) => k.isPrimary) ?? null;

    // ── REDEMPTIONS (by mode + fulfilment status), period-scoped ────────────────
    // "Completed" excludes PENDING + failed/cancelled/returned (owner decision).
    const EXCLUDED_REDEMPTION_STATUSES: RedemptionStatus[] = [
      'PENDING',
      'FAILED',
      'CANCELLED',
      'RETURNED',
    ];
    const redemptionTenant = { partner: { user: { clientId } } };

    // byMode: per redemptionMode, count + Σ pointsDeducted + Σ valueRupees over COMPLETED
    // orders created in the period. valuePaise is nullable → fall back to
    // pointsDeducted ÷ conversionRate (rupees) per order.
    const completedOrders = await this.prisma.redemptionOrder.findMany({
      where: {
        ...redemptionTenant,
        createdAt: { gte: periodStart, lt: periodEnd },
        status: { notIn: EXCLUDED_REDEMPTION_STATUSES },
      },
      select: { redemptionMode: true, pointsDeducted: true, valuePaise: true },
    });

    const ALL_MODES: PayoutMode[] = ['GIFT_CARD', 'UPI', 'BANK_TRANSFER', 'PHYSICAL_GIFT'];
    const modeAgg = new Map<PayoutMode, { count: number; points: number; rupees: number }>();
    for (const m of ALL_MODES) modeAgg.set(m, { count: 0, points: 0, rupees: 0 });
    for (const o of completedOrders) {
      const e = modeAgg.get(o.redemptionMode) ?? { count: 0, points: 0, rupees: 0 };
      e.count += 1;
      e.points += o.pointsDeducted;
      const rupees =
        o.valuePaise != null
          ? Number(o.valuePaise) / 100
          : conversionRate > 0
            ? o.pointsDeducted / conversionRate
            : 0;
      e.rupees += rupees;
      modeAgg.set(o.redemptionMode, e);
    }
    const byMode = ALL_MODES.map((mode) => {
      const e = modeAgg.get(mode)!;
      return {
        mode,
        count: e.count,
        points: e.points,
        valueRupees: ProgramHealthDashboardService.round1(e.rupees),
      };
    }).filter((m) => m.count > 0);

    // fulfilment = current status distribution for orders created in the period
    // (all statuses, so PENDING/FAILED/etc. are visible as operational state).
    const fulfilmentGroups = await this.prisma.redemptionOrder.groupBy({
      by: ['status'],
      where: { ...redemptionTenant, createdAt: { gte: periodStart, lt: periodEnd } },
      _count: { _all: true },
    });
    const fulfilment = fulfilmentGroups
      .map((g) => ({ status: g.status, count: g._count._all }))
      .sort((a, b) => b.count - a.count);

    // ── Resolve tenant slug for the scope echo (mirrors kycDashboard). ──────────
    let tenantSlug = 'ALL';
    if (clientId) {
      try {
        const cfg = await this.tenant.resolveClient(clientId);
        tenantSlug = cfg.slug;
      } catch {
        tenantSlug = clientId;
      }
    }

    return {
      scope: {
        tenant: tenantSlug,
        generatedAt: now.toISOString(),
        period: periodKey,
      },
      activation: {
        registered,
        kycApproved,
        firstEarn,
        firstRedeem,
        medianTimeToActivateDays: ProgramHealthDashboardService.round1(
          ProgramHealthDashboardService.median(activateDays),
        ),
      },
      participation: {
        addressable,
        activeEarnersThisMonth,
        activeRatePct,
        trend,
      },
      pointsEconomy: {
        issued,
        redeemed,
        outstandingLiabilityPoints,
        outstandingLiabilityRupees,
        breakagePct,
        expiringIn30dPoints,
      },
      targetAchievement: {
        period: periodKey,
        primary,
        kpis,
      },
      redemptions: {
        period: periodKey,
        byMode,
        fulfilment,
      },
    };
  }
}
