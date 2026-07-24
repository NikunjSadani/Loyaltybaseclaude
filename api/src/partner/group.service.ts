import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveGroupParentByPhone } from '../common/partner-group.helper';
import { kpiCodeKeys, NAMES_KEY } from '../targets/targets.helpers';
import { ListPartnerTargetsQueryDto } from './dto/partner.dto';
import { GroupVisibilityQueryDto } from './dto/group.dto';

/**
 * GroupService — Wave 3 read-only PARENT GROUP OVERVIEW (a consolidated wallet
 * roll-up across a group's child outlets, with per-outlet drill-down).
 *
 * MODEL (docs/plans/PARTNER-MULTI-OUTLET.md)
 *   - A PARENT = `ChannelPartner.isParent=true` — a login-less owner with NO wallet
 *     of its own. Its children = outlets where `Outlet.parentId = parent.id`; each
 *     child owner is a `ChannelPartner` whose derived `groupId = parent.id`.
 *   - The wallet balance is `Int` POINTS on `Wallet` (`partnerId @unique`; no clientId
 *     column → tenant-scoped via `partner.clientId`). This is a sum of Int POINTS —
 *     NOT the BigInt-paise payout layer (never conflate the two).
 *
 * AUTH: the overview is unlocked ONLY when the login's phone matches the group
 * parent's phone (`resolveGroupParentByPhone`, the shared contract). A login with
 * no matching parent simply gets `{ available: false }` — never a 500.
 *
 * READ-ONLY: no spend/redeem/payout is possible from here.
 */
@Injectable()
export class GroupService {
  constructor(
    private readonly prisma: PrismaService,
    // conversionRate lives on TenantSettingsService (same source WalletService reads).
    // Both TenantService + TenantSettingsService are @Global, so no module import is needed.
    private readonly tenantSettings: TenantSettingsService,
    // TenantService.resolveVisibilityEnabled gates the visibility roll-up (opt-in, fail-closed).
    private readonly tenant: TenantService,
  ) {}

  /**
   * Resolve the group parent for a login, applying BOTH gates the wallet roll-up uses
   * (kept in one place so every group-overview read enforces them identically):
   *   1. the login's phone must own a group PARENT (`resolveGroupParentByPhone`), and
   *   2. the OWN-GROUP guard — if the login has its own operating partner, that partner's
   *      derived `groupId` MUST equal the resolved parent. A free-form parent-phone typo
   *      could otherwise collide with an unrelated login's number and expose a foreign
   *      group (audit LOW-1). A parent-only phone (no own partner row) passes.
   *
   * Returns the group's `parentId`, or `null` when the overview is not available for this
   * login (the caller returns `{ available: false }` — never a 500).
   */
  private async resolveGroupParent(user: JwtPayload): Promise<string | null> {
    const parentId = await resolveGroupParentByPhone(this.prisma, {
      clientId: user.clientId,
      phone: user.phone,
    });
    if (!parentId) return null;

    const own = await this.prisma.channelPartner.findFirst({
      where: { userId: user.sub, clientId: user.clientId, deletedAt: null, isParent: false },
      select: { groupId: true },
    });
    if (own && own.groupId !== parentId) return null;

    return parentId;
  }

  /**
   * GET /v1/partner/group/wallet — consolidated wallet roll-up for the login's group.
   *
   * Resolves the parent by phone; if the login owns no parent → `{ available: false }`.
   * Otherwise returns group TOTALS (one aggregate), the per-outlet DRILL-DOWN, and the
   * tenant conversionRate so the FE can render ₹ equivalents. Point fields are numbers
   * (aggregate `_sum` nulls coerced to 0).
   */
  async getWalletRollup(user: JwtPayload) {
    const clientId = user.clientId;
    const parentId = await resolveGroupParentByPhone(this.prisma, {
      clientId,
      phone: user.phone,
    });

    // No parent for this phone → the login simply has no group overview (200, not 500).
    if (!parentId) return { available: false as const };

    // Belt-and-suspenders (audit LOW-1): the parent phone is free-form admin input with no
    // uniqueness enforcement, so a typo could collide with an unrelated login's number. Only
    // unlock the overview when the login is genuinely tied to THIS parent's group — i.e. its own
    // outlet is in the group (`own.groupId === parentId`) OR it has no operating outlet at all
    // (a parent-only phone: the person IS just the group contact — the design's row-4 case). A
    // login whose own outlet is in a DIFFERENT group never sees this group's numbers.
    const own = await this.prisma.channelPartner.findFirst({
      where: { userId: user.sub, clientId, deletedAt: null, isParent: false },
      select: { groupId: true },
    });
    if (own && own.groupId !== parentId) return { available: false as const };

    // Resolve the parent's own identity + the group TOTALS + the per-outlet drill-down +
    // the tenant conversion rate. Every query is tenant-scoped by clientId; the
    // `groupId: parentId` / `parentId` filters inherently exclude parents (no wallet)
    // and every other group.
    const [parent, totalsAgg, outlets, conversionRate] = await Promise.all([
      this.prisma.channelPartner.findFirst({
        where: { id: parentId, clientId, deletedAt: null },
        select: { businessName: true, ownerName: true },
      }),
      // ONE aggregate over every wallet whose partner is in THIS group + tenant.
      // Filter via the SOURCE-OF-TRUTH `outlet.parentId` (the same predicate the drill-down
      // uses) rather than the trigger-DERIVED `partner.groupId` — else a freshly-parented child
      // whose groupId trigger has lagged would show in the drill-down rows but be missed by the
      // totals (audit LOW-2). The `parentId` filter is also the guardrail against summing the
      // whole tenant. (Aggregates over Wallet rows, one per partner → no per-outlet double-count.)
      this.prisma.wallet.aggregate({
        where: { partner: { outlets: { some: { parentId, clientId, deletedAt: null } } } },
        _sum: {
          redeemablePoints: true,
          earnedPoints: true,
          redeemedPoints: true,
          expiredPoints: true,
          lockedPoints: true,
          lifetimeEarned: true,
          lifetimeRedeemed: true,
        },
      }),
      // Per-outlet drill-down over the group's child outlets.
      this.prisma.outlet.findMany({
        where: { parentId, clientId, deletedAt: null },
        select: {
          id: true,
          outletCode: true,
          name: true,
          isActive: true,
          partner: {
            select: {
              id: true,
              businessName: true,
              ownerName: true,
              // NB: the ChannelPartner→Wallet relation is `wallets` (array); partnerId is
              // @unique so it holds at most one row. A parent/pending child has none → zeros.
              wallets: {
                select: {
                  redeemablePoints: true,
                  earnedPoints: true,
                  redeemedPoints: true,
                  expiredPoints: true,
                  lockedPoints: true,
                },
              },
            },
          },
        },
        orderBy: [{ outletCode: 'asc' }],
      }),
      this.tenantSettings.getConversionRate(clientId),
    ]);

    const sum = totalsAgg._sum;
    const totals = {
      redeemablePoints: sum.redeemablePoints ?? 0,
      earnedPoints: sum.earnedPoints ?? 0,
      redeemedPoints: sum.redeemedPoints ?? 0,
      expiredPoints: sum.expiredPoints ?? 0,
      lockedPoints: sum.lockedPoints ?? 0,
      lifetimeEarned: sum.lifetimeEarned ?? 0,
      lifetimeRedeemed: sum.lifetimeRedeemed ?? 0,
    };

    const outletRows = outlets.map((o) => {
      // A child with no partner (partnerId null) or no wallet row → balances of 0.
      const wallet = o.partner?.wallets?.[0];
      return {
        outletCode: o.outletCode,
        businessName: o.partner?.businessName ?? o.name,
        ownerName: o.partner?.ownerName ?? null,
        isActive: o.isActive,
        redeemablePoints: wallet?.redeemablePoints ?? 0,
        earnedPoints: wallet?.earnedPoints ?? 0,
        redeemedPoints: wallet?.redeemedPoints ?? 0,
        expiredPoints: wallet?.expiredPoints ?? 0,
        lockedPoints: wallet?.lockedPoints ?? 0,
      };
    });

    return {
      available: true as const,
      parent: {
        businessName: parent?.businessName ?? null,
        ownerName: parent?.ownerName ?? null,
      },
      totals,
      conversionRate,
      outlets: outletRows,
    };
  }

  /**
   * GET /v1/partner/group/targets — consolidated per-outlet × KPI target/achievement/pace
   * roll-up for the login's group, PLUS a group total per KPI.
   *
   * Reuses the exact per-outlet × KPI × month algorithm from PartnerService.getTargets
   * (OutletTarget.targetValues = target side, OutletSalesRecord.kpiValues = achievement
   * side, joined on clientId+month+outletCode; pace = achieved ÷ target with the
   * divide-by-zero guard), but sources the outlet set from the GROUP
   * (`outlet.parentId = parentId`) rather than a single partner. The group total per KPI
   * sums each outlet's target + achieved (in-JS reduce over the JSON blobs — never
   * prisma.aggregate, which cannot reach into JSON) → group pace, null when the summed
   * target is absent/0.
   *
   * Month: `q.period` ("YYYY-MM") when supplied, else the most-recent OutletTarget month
   * for the group (same default as getTargets). Every query is tenant-scoped by clientId.
   */
  async getTargetsRollup(user: JwtPayload, q?: ListPartnerTargetsQueryDto) {
    const clientId = user.clientId;
    const parentId = await this.resolveGroupParent(user);
    if (!parentId) return { available: false as const };

    const [parent, outlets] = await Promise.all([
      this.prisma.channelPartner.findFirst({
        where: { id: parentId, clientId, deletedAt: null },
        select: { businessName: true, ownerName: true },
      }),
      // SOURCE-OF-TRUTH group scoping: child outlet codes via `outlet.parentId` (never the
      // trigger-derived partner.groupId). Tenant-scoped by clientId, non-deleted only.
      this.prisma.outlet.findMany({
        where: { parentId, clientId, deletedAt: null },
        select: { outletCode: true },
      }),
    ]);

    const parentInfo = {
      businessName: parent?.businessName ?? null,
      ownerName: parent?.ownerName ?? null,
    };
    const outletCodes = outlets.map((o) => o.outletCode);

    if (outletCodes.length === 0) {
      return { available: true as const, parent: parentInfo, period: q?.period ?? null, kpiTotals: [], outlets: [] };
    }

    // Determine the month: caller's period, else the most-recent month the group has targets for.
    let month: string | null = q?.period ?? null;
    if (!month) {
      const latest = await this.prisma.outletTarget.findFirst({
        where: { clientId, outletCode: { in: outletCodes } },
        orderBy: { month: 'desc' },
        select: { month: true },
      });
      month = latest?.month ?? null;
    }
    if (!month) {
      return { available: true as const, parent: parentInfo, period: null, kpiTotals: [], outlets: [] };
    }

    const whereBase = { clientId, month, outletCode: { in: outletCodes } };

    const [targetRows, achievementRows, kpiRows] = await Promise.all([
      this.prisma.outletTarget.findMany({
        where: whereBase,
        select: { outletCode: true, outletName: true, outletType: true, targetValues: true },
      }),
      this.prisma.outletSalesRecord.findMany({
        where: whereBase,
        select: { outletCode: true, kpiValues: true },
      }),
      this.prisma.kpiDef.findMany({
        where: { clientId },
        select: { code: true, label: true, unit: true, isPrimary: true },
      }),
    ]);

    const kpiLabel = new Map(kpiRows.map((k) => [k.code, k.label]));
    const kpiUnit = new Map(kpiRows.map((k) => [k.code, k.unit]));
    const kpiPrimary = new Map(kpiRows.map((k) => [k.code, k.isPrimary]));

    const targetIndex = new Map(targetRows.map((r) => [r.outletCode, r]));
    const achievementIndex = new Map(achievementRows.map((r) => [r.outletCode, r]));

    const allOutletCodes = new Set([...targetIndex.keys(), ...achievementIndex.keys()]);

    // Group total accumulator per KPI code — sum of each outlet's target/achieved. `hasTarget`/
    // `hasAchieved` distinguish a genuine 0 sum from "no rows on that side" (→ null, not a fake 0).
    const groupAccum = new Map<
      string,
      { target: number; achieved: number; hasTarget: boolean; hasAchieved: boolean }
    >();

    const outletResults = [...allOutletCodes].sort().map((outletCode) => {
      const tRow = targetIndex.get(outletCode);
      const aRow = achievementIndex.get(outletCode);

      const targetValues = (tRow?.targetValues ?? {}) as Record<string, number>;
      const kpiValues = (aRow?.kpiValues ?? {}) as Record<string, number>;

      const names = ((targetValues as Record<string, unknown>)[NAMES_KEY] ?? {}) as Record<string, string>;

      const allKpiCodes = new Set([...kpiCodeKeys(targetValues), ...kpiCodeKeys(kpiValues)]);

      const kpis = [...allKpiCodes].map((code) => {
        const target = Object.prototype.hasOwnProperty.call(targetValues, code) ? targetValues[code] : null;
        const achieved = Object.prototype.hasOwnProperty.call(kpiValues, code) ? kpiValues[code] : null;

        let pace: number | null = null;
        if (target !== null && target !== 0 && achieved !== null) pace = achieved / target;

        // Accumulate group totals (only numeric values count — a missing side stays "absent").
        const acc = groupAccum.get(code) ?? { target: 0, achieved: 0, hasTarget: false, hasAchieved: false };
        if (typeof target === 'number') {
          acc.target += target;
          acc.hasTarget = true;
        }
        if (typeof achieved === 'number') {
          acc.achieved += achieved;
          acc.hasAchieved = true;
        }
        groupAccum.set(code, acc);

        const name = names[code] || kpiLabel.get(code) || code;
        const unit = kpiUnit.get(code) ?? '';
        const isPrimary = kpiPrimary.get(code) ?? false;

        return { code, name, target, achieved, pace, unit, isPrimary };
      });

      return {
        outletCode,
        outletName: tRow?.outletName ?? outletCode,
        outletType: tRow?.outletType ?? '',
        kpis,
      };
    });

    // Group total per KPI (code-sorted for a stable order). Group pace uses the SUMMED
    // target/achieved with the same divide-by-zero guard.
    const kpiTotals = [...groupAccum.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, acc]) => {
        const target = acc.hasTarget ? acc.target : null;
        const achieved = acc.hasAchieved ? acc.achieved : null;
        let pace: number | null = null;
        if (target !== null && target !== 0 && achieved !== null) pace = achieved / target;
        return {
          code,
          name: kpiLabel.get(code) || code,
          target,
          achieved,
          pace,
          unit: kpiUnit.get(code) ?? '',
          isPrimary: kpiPrimary.get(code) ?? false,
        };
      });

    return { available: true as const, parent: parentInfo, period: month, kpiTotals, outlets: outletResults };
  }

  /**
   * GET /v1/partner/group/visibility — per-outlet branding-visibility status + roll-up
   * counts for the login's group, for one month.
   *
   * OPT-IN + FAIL-CLOSED: visibility is a per-tenant master switch. When the tenant's
   * `visibilityEnabled` is false (the default), this returns `{ visibilityEnabled: false }`
   * (200 — the FE hides the section) rather than a 403; the whole point is a soft, hideable
   * surface for a parent login. When ON, reads OutletVisibilityRecord for the group's outlet
   * codes. NB: unlike VisibilityService's internal list, this endpoint deliberately does NOT
   * apply the partner-role deny-list — a partner-PARENT login is the intended audience.
   *
   * Month: `q.month` ("YYYY-MM") when supplied, else the current month. Tenant-scoped by clientId.
   */
  async getVisibilityRollup(user: JwtPayload, q?: GroupVisibilityQueryDto) {
    const clientId = user.clientId;
    const parentId = await this.resolveGroupParent(user);
    if (!parentId) return { available: false as const };

    // Fail-closed opt-in gate. Read UNCACHED (resolveVisibilityEnabled) so an OFF→ON flip is
    // honoured immediately; a read error / missing row / non-boolean → OFF.
    const visibilityEnabled = await this.tenant.resolveVisibilityEnabled(clientId);

    const [parent, outlets] = await Promise.all([
      this.prisma.channelPartner.findFirst({
        where: { id: parentId, clientId, deletedAt: null },
        select: { businessName: true, ownerName: true },
      }),
      this.prisma.outlet.findMany({
        where: { parentId, clientId, deletedAt: null },
        select: { outletCode: true, name: true },
      }),
    ]);

    const parentInfo = {
      businessName: parent?.businessName ?? null,
      ownerName: parent?.ownerName ?? null,
    };

    // OFF → section hidden by the FE. Still 200 + parent identity so the shell can render.
    if (!visibilityEnabled) {
      return { available: true as const, visibilityEnabled: false as const, parent: parentInfo };
    }

    const month = q?.month ?? new Date().toISOString().slice(0, 7);
    const outletCodes = outlets.map((o) => o.outletCode);
    const nameByCode = new Map(outlets.map((o) => [o.outletCode, o.name]));

    const records = outletCodes.length
      ? await this.prisma.outletVisibilityRecord.findMany({
          where: { clientId, month, outletCode: { in: outletCodes } },
          select: { outletCode: true, status: true, dateOfCapture: true, approvedBy: true },
        })
      : [];

    const recByCode = new Map(records.map((r) => [r.outletCode, r]));

    // One row per GROUP outlet (an outlet with no record for the month shows status null →
    // counted under noRecord), so the parent sees a complete picture, not just captured ones.
    const outletRows = [...outletCodes].sort().map((code) => {
      const rec = recByCode.get(code);
      return {
        outletCode: code,
        outletName: nameByCode.get(code) ?? code,
        status: rec?.status ?? null,
        dateOfCapture: rec?.dateOfCapture ? rec.dateOfCapture.toISOString().slice(0, 10) : null,
        approvedBy: rec?.approvedBy ?? null,
      };
    });

    const counts = { total: outletCodes.length, approved: 0, underReview: 0, pending: 0, noRecord: 0 };
    for (const row of outletRows) {
      if (row.status === 'APPROVED') counts.approved++;
      else if (row.status === 'UNDER_REVIEW') counts.underReview++;
      else if (row.status === 'PENDING') counts.pending++;
      else counts.noRecord++;
    }

    return {
      available: true as const,
      visibilityEnabled: true as const,
      parent: parentInfo,
      month,
      counts,
      outlets: outletRows,
    };
  }

  /**
   * GET /v1/partner/group/leaderboard — the group's partners' rows in the tenant's latest
   * published leaderboard snapshot. Each row's `rank` is its TENANT-WIDE rank (the intended
   * "how do my shops rank among ALL partners" semantic) — we filter the published snapshot's
   * entries down to the group's partner ids, we do NOT re-rank within the group.
   *
   * Reuses LeaderboardService's snapshot selection (latest isPublished snapshot for a config
   * in the caller's tenant); no feature-flag gate (matches the single-partner leaderboard).
   * `groupPartnerIds` = every partner owning an outlet in the group (`outlet.parentId`).
   * No published snapshot → `{ snapshot: null, entries: [] }`. Tenant-scoped by clientId.
   */
  async getLeaderboardRollup(user: JwtPayload) {
    const clientId = user.clientId;
    const parentId = await this.resolveGroupParent(user);
    if (!parentId) return { available: false as const };

    const [parent, groupPartners] = await Promise.all([
      this.prisma.channelPartner.findFirst({
        where: { id: parentId, clientId, deletedAt: null },
        select: { businessName: true, ownerName: true },
      }),
      // The group's partner ids = partners owning at least one outlet in the group. Scoped
      // both on the partner (clientId, non-deleted) and via the source-of-truth outlet.parentId.
      this.prisma.channelPartner.findMany({
        where: {
          clientId,
          deletedAt: null,
          outlets: { some: { parentId, clientId, deletedAt: null } },
        },
        select: { id: true },
      }),
    ]);

    const parentInfo = {
      businessName: parent?.businessName ?? null,
      ownerName: parent?.ownerName ?? null,
    };
    const groupPartnerIds = groupPartners.map((p) => p.id);

    // Latest published snapshot for a config in the caller's tenant (same query as LeaderboardService).
    const snapshot = await this.prisma.leaderboardSnapshot.findFirst({
      where: { isPublished: true, config: { clientId } },
      orderBy: { snapshotDate: 'desc' },
    });

    if (!snapshot) {
      return { available: true as const, parent: parentInfo, snapshot: null, entries: [] };
    }

    const entries = groupPartnerIds.length
      ? await this.prisma.leaderboardEntry.findMany({
          where: { snapshotId: snapshot.id, partnerId: { in: groupPartnerIds } },
          include: { partner: { select: { id: true, businessName: true } } },
          orderBy: { rank: 'asc' },
        })
      : [];

    const rankedEntries = entries.map((e) => ({
      rank: e.rank, // tenant-wide rank
      partnerId: e.partnerId,
      partnerName: e.partner?.businessName ?? 'Unknown',
      score: e.score,
      rankChange: e.rankChange,
    }));

    return {
      available: true as const,
      parent: parentInfo,
      snapshot: {
        snapshotDate: snapshot.snapshotDate,
        periodStartDate: snapshot.periodStartDate,
        periodEndDate: snapshot.periodEndDate,
      },
      entries: rankedEntries,
    };
  }
}
