import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isSelfOrDescendant } from './sales-hierarchy-access.helper';

/**
 * Sales Organization — ported from platform/src/app/api/sales/* onto /v1.
 *
 * Scope: the REAL sales-org routes only (team / member detail / member outlets /
 * my-outlets). The World-A invoice/SKU/target routes (upload, returns, invoices,
 * last-upload, leaderboard) are intentionally NOT ported — they depend on dropped
 * models (Sku, SalesInvoice, SalesUpload, InvoiceLineItem, InvoiceReturn, Target,
 * TargetAchievement). Where the source enriched outlet/member rows from the now
 * dropped Target/TargetAchievement models, those reads are removed and the derived
 * `targetPct` is surfaced as 0 — the rest of the shape is preserved exactly.
 *
 * Every query is tenant-scoped by `clientId` (from the session-bound JWT). The
 * member-detail and member-outlets routes additionally enforce the hierarchy
 * ownership / cross-tenant IDOR guard via isSelfOrDescendant().
 */
@Injectable()
export class SalesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /v1/sales/team
   * The caller's own SalesUser record plus their direct subordinates.
   * Source: platform sales/team GET.
   */
  async getTeam(user: JwtPayload) {
    const salesUser = await this.prisma.salesUser.findFirst({
      where: { userId: user.sub, user: { clientId: user.clientId }, deletedAt: null },
      include: {
        hierarchyLevel: { select: { code: true, name: true, level: true } },
        subordinates: {
          where: { isActive: true, deletedAt: null },
          include: {
            user: { select: { name: true } },
            hierarchyLevel: { select: { code: true, name: true, level: true } },
            _count: { select: { subordinates: true } },
          },
        },
      },
    });

    if (!salesUser) return { salesUser: null, members: [] };

    const members = salesUser.subordinates.map((sub) => ({
      id: sub.id,
      employeeCode: sub.employeeCode,
      name: sub.user.name,
      role: sub.hierarchyLevel.code,
      roleLabel: sub.hierarchyLevel.name,
      territory: sub.region ?? sub.zone ?? '',
      teamSize: sub._count.subordinates,
      joinedAt: sub.joinedAt.toISOString(),
    }));

    return {
      salesUser: {
        id: salesUser.id,
        employeeCode: salesUser.employeeCode,
        role: salesUser.hierarchyLevel.code,
        roleLabel: salesUser.hierarchyLevel.name,
        level: salesUser.hierarchyLevel.level,
        region: salesUser.region,
        zone: salesUser.zone,
      },
      members,
    };
  }

  /**
   * Resolves the caller's own SalesUser within the tenant, loads the tenant's
   * reporting edges, and verifies the target member is the caller or a descendant
   * of the caller in their reporting subtree. Throws Forbidden otherwise.
   *
   * This is the cross-tenant IDOR guard ported from the source: the edge list is
   * tenant-scoped, so a target outside the tenant can never be in the caller's
   * subtree.
   */
  private async assertCanViewMember(user: JwtPayload, memberId: string): Promise<void> {
    const callerSalesUser = await this.prisma.salesUser.findFirst({
      where: { userId: user.sub, user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true },
    });
    if (!callerSalesUser) throw new ForbiddenException('Forbidden');

    const edges = await this.prisma.salesUser.findMany({
      where: { user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true, reportingToId: true },
    });

    if (!isSelfOrDescendant(memberId, callerSalesUser.id, edges)) {
      throw new ForbiddenException('Forbidden');
    }
  }

  /**
   * GET /v1/sales/team/:memberId
   * Detail card for a single team member the caller is allowed to view.
   * Source: platform sales/team/[memberId] GET.
   *
   * Target/TargetAchievement are dropped models, so the partner-target reads and
   * the achievement-percent aggregate are removed; targetPct is reported as 0.
   */
  async getMember(user: JwtPayload, memberId: string) {
    await this.assertCanViewMember(user, memberId);

    const salesUser = await this.prisma.salesUser.findFirst({
      where: { id: memberId, deletedAt: null, user: { clientId: user.clientId } },
      include: {
        user: { select: { name: true, phone: true } },
        hierarchyLevel: { select: { code: true, name: true, level: true } },
        _count: { select: { subordinates: true } },
        assignments: {
          where: { outletId: { not: null }, unassignedAt: null },
          include: {
            outlet: {
              include: {
                partner: {
                  select: {
                    kycSubmissions: {
                      orderBy: { createdAt: 'desc' },
                      take: 1,
                      select: { id: true, status: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!salesUser) throw new NotFoundException('Member not found');

    // partnerId is nullable — an uploaded outlet has no partner until KYC.
    // Restrict the partner-derived metrics to assignments that have a partner.
    const outletAssignments = salesUser.assignments.filter((a) => a.outlet && a.outlet.partner);

    const kycDone = outletAssignments.filter(
      (a) => a.outlet!.partner!.kycSubmissions[0]?.status === 'APPROVED',
    ).length;

    const kycPending = outletAssignments.filter((a) => {
      const s = a.outlet!.partner!.kycSubmissions[0]?.status;
      return !s || !['APPROVED', 'REJECTED', 'NOT_INTERESTED'].includes(s);
    }).length;

    // Target/TargetAchievement dropped — no achievement aggregate available.
    const targetPct = 0;

    const outlets = outletAssignments.map((a) => {
      const outlet = a.outlet!;
      const latestKyc = outlet.partner!.kycSubmissions[0] ?? null;
      return {
        id: outlet.id,
        name: outlet.name,
        location: outlet.city,
        outletCode: outlet.outletCode,
        kycId: latestKyc?.id ?? '',
        kycStatus: latestKyc?.status ?? 'NOT_STARTED',
        targetPct: 0,
      };
    });

    return {
      member: {
        id: salesUser.id,
        name: salesUser.user.name,
        role: salesUser.hierarchyLevel.code as string,
        roleLabel: salesUser.hierarchyLevel.name,
        territory: salesUser.region ?? salesUser.zone ?? '',
        employeeId: salesUser.employeeCode,
        mobile: salesUser.user.phone ?? '',
        targetPct,
        kycDone,
        kycPending,
        visibilityPending: 0,
        teamSize: salesUser._count.subordinates,
        activity: [],
        outlets,
      },
    };
  }

  /**
   * GET /v1/sales/team/:memberId/outlets
   * The outlets assigned to a given team member the caller is allowed to view.
   * Source: platform sales/team/[memberId]/outlets GET.
   */
  async getMemberOutlets(user: JwtPayload, memberId: string) {
    await this.assertCanViewMember(user, memberId);

    const member = await this.prisma.salesUser.findFirst({
      where: { id: memberId, deletedAt: null, user: { clientId: user.clientId } },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Member not found');

    const outlets = await this.buildOutlets(memberId);
    return { outlets };
  }

  /**
   * GET /v1/sales/outlets
   * The outlets assigned to the calling sales user.
   * Source: platform sales/outlets GET.
   */
  async getMyOutlets(user: JwtPayload) {
    const salesUser = await this.prisma.salesUser.findFirst({
      where: { userId: user.sub, user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true },
    });

    if (!salesUser) return { outlets: [] };

    return { outlets: await this.buildOutlets(salesUser.id) };
  }

  /**
   * Shared outlet projection for a sales user's active outlet assignments.
   * Ported from the source's buildOutlets() (sales/outlets) and the inline copy
   * in sales/team/[memberId]/outlets — single consistent shape across both.
   *
   * Target/TargetAchievement are dropped, so the partner-target read and the
   * achievement-derived targetPct are removed; targetPct is reported as 0.
   */
  private async buildOutlets(salesUserId: string) {
    const assignments = await this.prisma.salesUserAssignment.findMany({
      where: {
        salesUserId,
        outletId: { not: null },
        unassignedAt: null,
      },
      include: {
        outlet: {
          include: {
            outletType: { select: { code: true } },
            partner: {
              select: {
                id: true,
                phone: true,
                // Sales-assisted redeem (B1) drives off the outlet's partnerId +
                // its real redeemable balance, so the FE can offer "redeem for
                // this outlet" with the points headroom shown.
                wallets: { select: { redeemablePoints: true } },
                kycSubmissions: {
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                  select: { id: true, status: true, createdAt: true },
                },
              },
            },
          },
        },
      },
    });

    return (
      assignments
        // An outlet uploaded via the master file has NO owner/partner until KYC.
        // INCLUDE those — a sales rep must see the outlets they're assigned that
        // still need NEW enrollment/KYC. (Previously these were filtered out, so a
        // rep whose assigned outlets were all un-KYC'd saw an EMPTY list and could
        // not start enrollment.) Partner-derived fields are null/0 for partner-less
        // outlets; sales-assisted redeem (B1) is gated on an APPROVED partner FE-side.
        .filter((a) => a.outlet !== null)
        .map((a) => {
          const outlet = a.outlet!;
          const partner = outlet.partner; // null until the outlet is KYC'd
          const latestKyc = partner?.kycSubmissions[0] ?? null;

          return {
            id: outlet.id,
            partnerId: partner?.id ?? null,
            balance: partner?.wallets[0]?.redeemablePoints ?? 0,
            kycId: latestKyc?.id ?? '',
            outletCode: outlet.outletCode,
            name: outlet.name,
            mobile: outlet.phone ?? partner?.phone ?? '',
            location: outlet.city,
            beat: outlet.district ?? '',
            district: outlet.district ?? '',
            state: outlet.state,
            type: outlet.outletType.code,
            kycStatus: latestKyc?.status ?? 'NOT_STARTED',
            kycSubmittedAt: latestKyc?.createdAt?.toISOString().split('T')[0],
            targetPct: 0,
          };
        })
    );
  }
}
