import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveGroupParentByPhone } from '../common/partner-group.helper';

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
  ) {}

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
}
