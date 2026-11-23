import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantService } from '../../tenant/tenant.service';
import { TenantSettingsService } from '../../tenant/tenant-settings.service';
import { loadFundInputs } from '../../fund/fund-sources.loader';
import { statementOf } from '../../fund/fund-statement-of';
import { GifsyRoleService } from '../../common/rbac/gifsy-role.service';
import { TdsService } from '../../tds/tds.service';
import { JwtPayload } from '../../common/decorators/current-user.decorator';
import { platformWide } from '../../common/tenant-scope';
import { REPORTS_CLIENT_ID } from '../../common/report-recipients';
import { fyOfToday } from '../../tds/tds.helpers';
import { paiseToRupees } from '../../common/money';
import { istMonthKey, istMonthBounds, monthYearIST } from '../../common/ist-date';

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
 *  - fund:       the client fund (advance) balance — reused from FundService (the SAME loader + engine as /admin/fund).
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
    private readonly tds: TdsService,
    private readonly gifsyRoles: GifsyRoleService,
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
      _sum: { lockedPoints: true },
    });
    // Audit item 1 (2026-11-19): liability = Σ POSITIVE balances only — a negative wallet's debt never nets against what
    // the other wallets can redeem; it is reported separately as "points owed" (Σ |negative balances|). Unchanged for a tenant
    // with no negative wallet (every Deoleo wallet).
    const positiveAgg = await this.prisma.wallet.aggregate({
      where: { partner: { clientId }, redeemablePoints: { gt: 0 } },
      _sum: { redeemablePoints: true },
    });
    // Wallet point columns are Int → _sum returns `number | null`.
    const redeemablePoints = positiveAgg._sum.redeemablePoints ?? 0;
    const lockedPoints = walletAgg._sum.lockedPoints ?? 0;
    // Owner decisions D1/D2 (2026-11-19, every tenant): "points owed" = Σ |negative balances| (how far below zero), with
    // how many wallets — never netted into the liability. One more aggregate; 0 / 0 for a tenant with no negative wallet.
    const owedAgg = await this.prisma.wallet.aggregate({
      where: { partner: { clientId }, redeemablePoints: { lt: 0 } },
      _sum: { redeemablePoints: true },
      _count: { _all: true },
    });
    const negSum = owedAgg?._sum?.redeemablePoints ?? 0;
    const owedPoints = Math.max(0, -negSum);
    const owedWallets = owedPoints > 0 ? owedAgg?._count?._all ?? 0 : 0;

    // ── Breakage: PERIOD-ONLY (current calendar month) ──────────────────────────
    // expiredPoints = Σ PointsLedger.points (transactionType=EXPIRE) in the period;
    // issuedPoints = Σ EARN in the period. Tenant-scoped via wallet.partner.clientId.
    // IST month boundaries to match the Program Health dashboard (and the app-wide
    // monthRange convention) so the two breakage cards use an identical period. Prod
    // runs UTC, so local-time boundaries would land on the wrong IST month at a boundary.
    const now = new Date();
    const monthKey = istMonthKey(now);
    const { start: periodStart, endExclusive: periodEndExclusive } = istMonthBounds(monthKey);
    const periodLabel = monthYearIST(now);

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
    const [report194R, summary194C] = await Promise.all([
      this.tds.report194R(clientId, fyLabel),
      isPlatform ? this.tds.summary194C(fyLabel) : Promise.resolve(null),
    ]);
    const summary194R = report194R.summary;
    const sec194C = isPlatform && summary194C
      ? {
          liabilityRupees: FinanceDashboardService.round2(paiseToRupees(summary194C.totalLiabilityPaise)),
          depositedRupees: FinanceDashboardService.round2(paiseToRupees(summary194C.totalDepositedPaise)),
          outstandingRupees: FinanceDashboardService.round2(paiseToRupees(summary194C.totalOutstandingPaise)),
        }
      : { liabilityRupees: 0, depositedRupees: 0, outstandingRupees: 0 };

    // ── Fund: the client advance (fund reconciliation) — the SAME loader + engine as /admin/fund, so the two can
    // never disagree. null (the card is hidden) unless the caller may see the fund (B1): CLIENT_ADMIN of its own
    // tenant or a Gifsy operator holding payouts:read — never MIS_USER. An un-assumed Gifsy owner has no client
    // context → an all-zero block with hasSettings=false (the screen says "Open a client first").
    const fund = await this.fundBlock(user);

    return {
      scope: { tenant: tenantSlug, generatedAt: new Date().toISOString(), fy: fyLabel },
      liability: {
        redeemablePoints,
        lockedPoints,
        conversionRate,
        redeemableRupees: FinanceDashboardService.pointsToRupees(redeemablePoints, conversionRate),
        lockedRupees: FinanceDashboardService.pointsToRupees(lockedPoints, conversionRate),
        // "Points owed (debt)" — owed back by negative wallets, repaid from future earnings; never netted above.
        owedPoints,
        owedWallets,
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
          // Disclosure — only when imported (vendor) payouts are counted in THIS FY.
          ...(report194R.importedPayoutsNote ? { importedPayoutsNote: report194R.importedPayoutsNote } : {}),
        },
        sec194C,
      },
      fund,
    };
  }

  private async fundBlock(user: JwtPayload) {
    const allowed =
      user.role === 'CLIENT_ADMIN' ||
      user.role === 'GIFSY_ADMIN' ||
      (user.role === 'GIFSY_STAFF' && (await this.gifsyRoles.getPermissions(user.gifsyRoleId)).has('payouts:read'));
    if (!allowed) return null;
    const zero = {
      receivedRupees: 0,
      adjustmentsRupees: 0,
      committedRupees: 0,
      paidRupees: 0,
      returnedRupees: 0,
      balanceRupees: 0,
      lowBalance: false,
      thresholdRupees: null as number | null,
      hasSettings: false,
      noClientContext: true,
    };
    if (platformWide(user) || !user.clientId || user.clientId === REPORTS_CLIENT_ID) return zero;
    const [inputs, settings] = await Promise.all([
      loadFundInputs(this.prisma, user.clientId),
      this.prisma.fundSettings.findUnique({ where: { clientId: user.clientId } }),
    ]);
    const stmt = statementOf(inputs);
    const t = stmt.totals;
    const r = (p: bigint) => FinanceDashboardService.round2(paiseToRupees(p));
    const threshold = settings?.lowBalanceThresholdPaise ?? null;
    return {
      // Advance received = the opening balance + every receipt.
      receivedRupees: r(t.openingPaise + t.receiptsPaise),
      adjustmentsRupees: r(t.adjustmentsPaise),
      committedRupees: r(t.committedPaise),
      paidRupees: r(t.paidPaise),
      returnedRupees: r(t.returnedPaise),
      balanceRupees: r(t.balancePaise),
      lowBalance: threshold != null && t.balancePaise < threshold,
      thresholdRupees: threshold == null ? null : r(threshold),
      hasSettings: !!settings || stmt.lines.length > 0,
      noClientContext: false,
    };
  }
}
