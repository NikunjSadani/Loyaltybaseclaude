import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantService } from '../../tenant/tenant.service';
import { TenantSettingsService } from '../../tenant/tenant-settings.service';
import { PayoutsService } from '../../payouts/payouts.service';
import { TdsService } from '../../tds/tds.service';
import { JwtPayload } from '../../common/decorators/current-user.decorator';
import { platformWide } from '../../common/tenant-scope';
import { fyOfToday } from '../../tds/tds.helpers';
import { paiseToRupees } from '../../common/money';

/**
 * FinanceDashboardService — GET /v1/admin/dashboard/finance.
 *
 * A real, tenant-scoped finance health roll-up. Every number is derived from
 * live tables or reused from the existing finance services — there are NO
 * fabricated constants. Mirrors AdminCoreService.kycDashboard's tenant-scope
 * conventions (strictly by `user.clientId`).
 *
 * Four panels:
 *  - liability:  outstanding points obligation, valued in ₹ at the tenant rate.
 *  - breakage:   period-only (current calendar month) expiry vs issuance.
 *  - tds:        194R (tenant) + 194C (platform-wide by design) — reused from TdsService.
 *  - fund:       fund reconciliation — reused from PayoutsService.getFundSummary.
 *
 * Money: persisted money is BigInt paise (÷100 → ₹). Points are Int and are
 * converted to ₹ as value(₹) = points ÷ conversionRate — the SAME convention
 * the rest of the app uses for redemption value (see RewardsService /
 * WalletService: "value(₹) = points ÷ conversionRate").
 */
@Injectable()
export class FinanceDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly payouts: PayoutsService,
    private readonly tds: TdsService,
  ) {}

  /** round to 2 decimals (₹). */
  private static round2(n: number): number {
    return Math.round(n * 100) / 100;
  }

  /** round to 1 decimal (%). */
  private static round1(n: number): number {
    return Math.round(n * 10) / 10;
  }

  /**
   * Points → ₹ using the per-tenant conversion rate, matching the rest of the
   * app: value(₹) = points ÷ conversionRate. conversionRate can theoretically be
   * 0/misconfigured — guard /0 → 0 rather than emit Infinity.
   */
  private static pointsToRupees(points: number, conversionRate: number): number {
    if (!conversionRate || conversionRate <= 0) return 0;
    return FinanceDashboardService.round2(points / conversionRate);
  }

  async finance(user: JwtPayload, fy?: string) {
    const clientId = user.clientId;

    // ── Resolve the tenant slug for the scope echo (mirrors kycDashboard). ──
    let tenantSlug = 'ALL';
    if (clientId) {
      try {
        tenantSlug = (await this.tenant.resolveClient(clientId)).slug;
      } catch {
        tenantSlug = clientId;
      }
    }

    // Per-tenant points→₹ rate (the resolver used on the redeem money path).
    const conversionRate = await this.tenantSettings.getConversionRate(clientId);

    // FY label: caller-supplied `fy` overrides; otherwise the current IST FY.
    const fyLabel = fy && fy.trim() ? fy.trim() : fyOfToday().fyLabel;

    // ── Liability: outstanding points obligation across tenant wallets ──────────
    // Wallet has no clientId; it is tenant-scoped via partner.clientId (denormalised
    // on ChannelPartner — the same denormalised filter TDS/redemptions use).
    const walletAgg = await this.prisma.wallet.aggregate({
      where: { partner: { clientId } },
      _sum: { redeemablePoints: true, lockedPoints: true },
    });
    // Wallet point columns are Int → _sum returns `number | null`.
    const redeemablePoints = walletAgg._sum.redeemablePoints ?? 0;
    const lockedPoints = walletAgg._sum.lockedPoints ?? 0;

    // ── Breakage: PERIOD-ONLY (current calendar month) ──────────────────────────
    // expiredPoints = Σ PointsLedger.points (transactionType=EXPIRE) in the period;
    // issuedPoints = Σ EARN in the period. Tenant-scoped via wallet.partner.clientId.
    // Local-time month boundaries to match the Program Health dashboard (and the
    // app-wide monthRange convention) so the two breakage cards use an identical period.
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEndExclusive = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const periodLabel = `${periodStart.getFullYear()}-${String(periodStart.getMonth() + 1).padStart(2, '0')}`;

    const [expiredAgg, issuedAgg] = await Promise.all([
      this.prisma.pointsLedger.aggregate({
        where: {
          transactionType: 'EXPIRE',
          createdAt: { gte: periodStart, lt: periodEndExclusive },
          wallet: { partner: { clientId } },
        },
        _sum: { points: true },
      }),
      this.prisma.pointsLedger.aggregate({
        where: {
          transactionType: 'EARN',
          createdAt: { gte: periodStart, lt: periodEndExclusive },
          wallet: { partner: { clientId } },
        },
        _sum: { points: true },
      }),
    ]);
    // EXPIRE rows may carry negative points (a debit); the breakage metric is the
    // MAGNITUDE of points broken, so take the absolute value.
    const expiredPoints = Math.abs(expiredAgg._sum.points ?? 0);
    const issuedPoints = issuedAgg._sum.points ?? 0;
    const breakagePct =
      issuedPoints > 0
        ? FinanceDashboardService.round1((expiredPoints / issuedPoints) * 100)
        : 0;

    // ── TDS: reuse TdsService summaries (BigInt paise totals → ₹) ────────────────
    // 194R is tenant-scoped (clientId). 194C is a PLATFORM-WIDE cross-tenant total
    // (Gifsy deductor) — it must be surfaced ONLY to an un-assumed GIFSY operator. A
    // tenant admin (CLIENT_ADMIN/MIS_USER) OR an ASSUMED operator must NOT see the
    // cross-tenant figure, so we skip the aggregate entirely and emit a zeroed block
    // (keeps the DTO shape → FE renders ₹0.00 instead of crashing on a null section).
    const isPlatform = platformWide(user);
    const [summary194R, summary194C] = await Promise.all([
      this.tds.summary194R(clientId, fyLabel),
      isPlatform ? this.tds.summary194C(fyLabel) : Promise.resolve(null),
    ]);
    const sec194C = isPlatform && summary194C
      ? {
          liabilityRupees: FinanceDashboardService.round2(paiseToRupees(summary194C.totalLiabilityPaise)),
          depositedRupees: FinanceDashboardService.round2(paiseToRupees(summary194C.totalDepositedPaise)),
          outstandingRupees: FinanceDashboardService.round2(paiseToRupees(summary194C.totalOutstandingPaise)),
        }
      : { liabilityRupees: 0, depositedRupees: 0, outstandingRupees: 0 };

    // ── Fund: reuse PayoutsService.getFundSummary (already paise→₹ mapped) ───────
    const fundSummary = await this.payouts.getFundSummary(user);

    return {
      scope: { tenant: tenantSlug, generatedAt: new Date().toISOString(), fy: fyLabel },
      liability: {
        redeemablePoints,
        lockedPoints,
        conversionRate,
        redeemableRupees: FinanceDashboardService.pointsToRupees(redeemablePoints, conversionRate),
        lockedRupees: FinanceDashboardService.pointsToRupees(lockedPoints, conversionRate),
      },
      breakage: {
        period: periodLabel,
        expiredPoints,
        issuedPoints,
        breakagePct,
        expiredRupees: FinanceDashboardService.pointsToRupees(expiredPoints, conversionRate),
      },
      tds: {
        fy: fyLabel,
        sec194R: {
          liabilityRupees: FinanceDashboardService.round2(paiseToRupees(summary194R.totalLiabilityPaise)),
          depositedRupees: FinanceDashboardService.round2(paiseToRupees(summary194R.totalDepositedPaise)),
          outstandingRupees: FinanceDashboardService.round2(paiseToRupees(summary194R.totalOutstandingPaise)),
        },
        sec194C,
      },
      fund: {
        totalReceivedRupees: FinanceDashboardService.round2(fundSummary.totalReceived),
        totalUtilisedRupees: FinanceDashboardService.round2(fundSummary.totalUtilised),
        closingBalanceRupees: FinanceDashboardService.round2(fundSummary.closingBalance),
        pendingLiabilityRupees: FinanceDashboardService.round2(fundSummary.pendingLiability),
        availableRupees: FinanceDashboardService.round2(fundSummary.available),
      },
    };
  }
}
