import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isSelfOrDescendant, descendantSalesUserIds } from './sales-hierarchy-access.helper';
import { kpiCodeKeys } from '../targets/targets.helpers';

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
                    id: true,
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

    // partnerId is nullable — an outlet uploaded via the master file has NO
    // partner until KYC. INCLUDE those partner-less outlets (mirroring the
    // just-fixed buildOutlets): they are exactly the un-KYC'd outlets the rep
    // must act on, so the member-detail counts reconcile with the dedicated
    // /sales/team/:id/outlets list. Previously they were filtered out, so the
    // counts under-reported and disagreed with that list.
    const outletAssignments = salesUser.assignments.filter((a) => a.outlet !== null);

    // A partner-less outlet has no KYC submission → NOT_STARTED (pending action).
    const latestStatusOf = (a: (typeof outletAssignments)[number]): string =>
      a.outlet!.partner?.kycSubmissions[0]?.status ?? 'NOT_STARTED';

    const kycDone = outletAssignments.filter((a) => latestStatusOf(a) === 'APPROVED').length;

    // kycPending = outlets still awaiting KYC action: anything not in a terminal
    // state. NOT_STARTED (partner-less / un-KYC'd) counts here — those are the
    // outlets the rep must enrol.
    const kycPending = outletAssignments.filter(
      (a) => !['APPROVED', 'REJECTED', 'NOT_INTERESTED'].includes(latestStatusOf(a)),
    ).length;

    // Target/TargetAchievement dropped — no achievement aggregate available.
    const targetPct = 0;

    const outlets = outletAssignments.map((a) => {
      const outlet = a.outlet!;
      const partner = outlet.partner; // null until the outlet is KYC'd
      const latestKyc = partner?.kycSubmissions[0] ?? null;
      return {
        id: outlet.id,
        partnerId: partner?.id ?? null,
        name: outlet.name,
        location: outlet.city,
        outletCode: outlet.outletCode,
        mobile: outlet.phone ?? '',
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
   * The outlets assigned to the calling sales user AND their whole reporting
   * downline (Q4 + owner 2026-06-24: "an SO has access to all outlets tagged to the
   * XSRs mapped to him" — so a manager can do KYC for any outlet under them). A leaf
   * rep (no subordinates) gets just their own assignments.
   * Source: platform sales/outlets GET.
   */
  async getMyOutlets(user: JwtPayload) {
    const salesUser = await this.prisma.salesUser.findFirst({
      where: { userId: user.sub, user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true },
    });

    if (!salesUser) return { outlets: [] };

    const edges = await this.prisma.salesUser.findMany({
      where: { user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true, reportingToId: true },
    });
    const subtreeIds = [...descendantSalesUserIds(salesUser.id, edges)];

    return { outlets: await this.buildOutlets(subtreeIds) };
  }

  /**
   * GET /v1/sales/me — the caller's own sales-org identity (real, JWT-scoped).
   * Feeds the sales shell header (employee ID) + profile page, replacing the
   * demo personas in lib/sales-role.ts (ROLE_EMP_IDS / ROLE_TERRITORY). Returns
   * nulls when the caller is not a sales user so the FE can fall back to the JWT.
   */
  async getMe(user: JwtPayload) {
    const su = await this.prisma.salesUser.findFirst({
      where: { userId: user.sub, user: { clientId: user.clientId }, deletedAt: null },
      select: {
        employeeCode: true,
        region: true,
        zone: true,
        user: { select: { name: true, phone: true } },
        hierarchyLevel: { select: { code: true, name: true, level: true } },
      },
    });
    return {
      employeeCode: su?.employeeCode ?? null,
      role:         su?.hierarchyLevel?.code ?? null,
      roleLabel:    su?.hierarchyLevel?.name ?? null,
      level:        su?.hierarchyLevel?.level ?? null,
      region:       su?.region ?? null,
      zone:         su?.zone ?? null,
      name:         su?.user?.name ?? user.name ?? null,
      phone:        su?.user?.phone ?? user.phone ?? null,
    };
  }

  /**
   * Outlet codes assigned to the caller AND their whole reporting downline (Q4 +
   * owner 2026-06-24: a manager's targets/achievements roll up the team). A leaf rep
   * gets just their own. Returns [] when the caller is not a sales user. Tenant-scoped.
   * Shared by the dashboard (getTargets) and outlets-list (getOutletTargets) reads so
   * managers see their team's numbers, not an empty page.
   */
  private async subtreeOutletCodes(user: JwtPayload): Promise<string[]> {
    const su = await this.prisma.salesUser.findFirst({
      where: { userId: user.sub, user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true },
    });
    if (!su) return [];
    const edges = await this.prisma.salesUser.findMany({
      where: { user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true, reportingToId: true },
    });
    const subtreeIds = [...descendantSalesUserIds(su.id, edges)];
    const assignments = await this.prisma.salesUserAssignment.findMany({
      where: { salesUserId: { in: subtreeIds }, unassignedAt: null, outletId: { not: null } },
      select: { outlet: { select: { outletCode: true } } },
    });
    return [...new Set(
      assignments.map((a) => a.outlet?.outletCode).filter((c): c is string => !!c),
    )];
  }

  /**
   * GET /v1/sales/targets — REAL target vs achievement for the caller's whole
   * DOWNLINE's outlets, summed per KPI for a month (replaces the FE OUTLET_ACHIEVEMENTS /
   * resolveConfig(DEMO_*) mock on the sales dashboard). Mirrors the partner
   * getTargets join (OutletTarget ⋈ OutletSalesRecord on clientId+outletCode+month)
   * but scopes by the rep's + downline's active outlet assignments instead of partner
   * ownership. Also returns a 6-month trend on the PRIMARY KPI for the dashboard chart.
   */
  async getTargets(user: JwtPayload, period?: string) {
    const outletCodes = await this.subtreeOutletCodes(user);
    if (outletCodes.length === 0) return { period: null, outletCount: 0, kpis: [], trend: [] };

    // Month to report: the caller's period, else the most recent month with target data.
    let month: string | null = period ?? null;
    if (!month) {
      const latest = await this.prisma.outletTarget.findFirst({
        where: { clientId: user.clientId, outletCode: { in: outletCodes } },
        orderBy: { month: 'desc' },
        select: { month: true },
      });
      month = latest?.month ?? null;
    }
    if (!month) return { period: null, outletCount: outletCodes.length, kpis: [], trend: [] };

    const whereBase = { clientId: user.clientId, outletCode: { in: outletCodes } };
    const [targetRows, achRows, kpiRows] = await Promise.all([
      this.prisma.outletTarget.findMany({ where: { ...whereBase, month }, select: { targetValues: true } }),
      this.prisma.outletSalesRecord.findMany({ where: { ...whereBase, month }, select: { kpiValues: true } }),
      this.prisma.kpiDef.findMany({
        where: { clientId: user.clientId },
        select: { code: true, label: true, unit: true, isPrimary: true },
      }),
    ]);

    // Sum each KPI's target + achieved across all the rep's outlets for the month.
    const sumByCode = (rows: { v: unknown }[]) => {
      const acc: Record<string, number> = {};
      for (const { v } of rows) {
        const obj = (v ?? {}) as Record<string, number>;
        for (const code of kpiCodeKeys(obj)) acc[code] = (acc[code] ?? 0) + (Number(obj[code]) || 0);
      }
      return acc;
    };
    const targetSum = sumByCode(targetRows.map((r) => ({ v: r.targetValues })));
    const achSum    = sumByCode(achRows.map((r) => ({ v: r.kpiValues })));

    const kpiMeta = new Map(kpiRows.map((k) => [k.code, k]));
    const codes = [...new Set([...Object.keys(targetSum), ...Object.keys(achSum)])];
    const kpis = codes.map((code) => {
      const target = targetSum[code] ?? 0;
      const achieved = achSum[code] ?? 0;
      const meta = kpiMeta.get(code);
      return {
        code,
        name: meta?.label ?? code,
        unit: meta?.unit ?? '',
        isPrimary: meta?.isPrimary ?? false,
        target,
        achieved,
        pace: target > 0 ? achieved / target : null,
      };
    }).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name));

    // 6-month trend on the primary KPI (else the first KPI) for the chart.
    const primaryCode = kpis.find((k) => k.isPrimary)?.code ?? kpis[0]?.code ?? null;
    const trend = primaryCode
      ? await this.buildTargetTrend(user.clientId, outletCodes, month, primaryCode)
      : [];

    return { period: month, outletCount: outletCodes.length, kpis, trend };
  }

  /**
   * GET /v1/sales/outlet-targets?period= — REAL per-outlet × per-KPI target vs
   * achievement for the caller's + DOWNLINE's outlets (the sales Outlets list page),
   * replacing the FE `resolveConfig(DEMO_*)` fake params + `targetPct:0`
   * back-computed numbers. Returns the KPI column set (KpiDef, primary-first) +
   * a per-outlet map keyed by outletCode. Downline- + tenant-scoped.
   */
  async getOutletTargets(user: JwtPayload, period?: string) {
    const outletCodes = await this.subtreeOutletCodes(user);
    return this.readOutletTargets(user.clientId, outletCodes, period);
  }

  /**
   * GET /v1/sales/team/:memberId/outlet-targets?period= — REAL per-outlet × per-KPI
   * target vs achievement for ONE team member's assigned outlets (the manager's
   * team-member drill-down), replacing the FE resolveConfig(DEMO_*) mock. Same shape
   * as getOutletTargets but scoped to the member's outlets, guarded by the hierarchy
   * IDOR check (the caller must be the member or an ancestor).
   */
  async getMemberOutletTargets(user: JwtPayload, memberId: string, period?: string) {
    await this.assertCanViewMember(user, memberId);
    const assignments = await this.prisma.salesUserAssignment.findMany({
      where: { salesUserId: memberId, unassignedAt: null, outletId: { not: null } },
      select: { outlet: { select: { outletCode: true } } },
    });
    const outletCodes = [...new Set(
      assignments.map((a) => a.outlet?.outletCode).filter((c): c is string => !!c),
    )];
    return this.readOutletTargets(user.clientId, outletCodes, period);
  }

  /**
   * Shared per-outlet target/achievement read for a fixed set of outlet codes.
   * Resolves the month (caller's period, else the latest month with target data),
   * joins OutletTarget.targetValues ⋈ OutletSalesRecord.kpiValues ⋈ KpiDef, and
   * returns { period, kpiColumns (primary-first), rows keyed by outletCode }.
   */
  private async readOutletTargets(clientId: string, outletCodes: string[], period?: string) {
    if (outletCodes.length === 0) return { period: null, kpiColumns: [], rows: [] };

    let month: string | null = period ?? null;
    if (!month) {
      const latest = await this.prisma.outletTarget.findFirst({
        where: { clientId, outletCode: { in: outletCodes } },
        orderBy: { month: 'desc' },
        select: { month: true },
      });
      month = latest?.month ?? null;
    }
    if (!month) return { period: null, kpiColumns: [], rows: [] };

    const whereBase = { clientId, outletCode: { in: outletCodes }, month };
    const [targetRows, achRows, kpiRows] = await Promise.all([
      this.prisma.outletTarget.findMany({ where: whereBase, select: { outletCode: true, targetValues: true } }),
      this.prisma.outletSalesRecord.findMany({ where: whereBase, select: { outletCode: true, kpiValues: true } }),
      this.prisma.kpiDef.findMany({
        where: { clientId },
        select: { code: true, label: true, unit: true, isPrimary: true },
      }),
    ]);

    const tIdx = new Map(targetRows.map((r) => [r.outletCode, (r.targetValues ?? {}) as Record<string, number>]));
    const aIdx = new Map(achRows.map((r) => [r.outletCode, (r.kpiValues ?? {}) as Record<string, number>]));

    const kpiColumns = kpiRows
      .map((k) => ({ code: k.code, name: k.label, unit: k.unit, isPrimary: k.isPrimary }))
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name));

    const rows = outletCodes.map((code) => {
      const tv = tIdx.get(code) ?? {};
      const kv = aIdx.get(code) ?? {};
      const kpis: Record<string, { target: number | null; achieved: number | null; pace: number | null }> = {};
      for (const c of new Set([...kpiCodeKeys(tv), ...kpiCodeKeys(kv)])) {
        const target = Object.prototype.hasOwnProperty.call(tv, c) ? (Number(tv[c]) || 0) : null;
        const achieved = Object.prototype.hasOwnProperty.call(kv, c) ? (Number(kv[c]) || 0) : null;
        const pace = target !== null && target !== 0 && achieved !== null ? achieved / target : null;
        kpis[c] = { target, achieved, pace };
      }
      return { outletCode: code, kpis };
    });

    return { period: month, kpiColumns, rows };
  }

  /** Last-6-months target vs achieved totals for one KPI code (chart series). */
  private async buildTargetTrend(
    clientId: string, outletCodes: string[], latestMonth: string, kpiCode: string,
  ) {
    // Build the 6 month keys ending at latestMonth (YYYY-MM), oldest first.
    const [y, m] = latestMonth.split('-').map(Number);
    const months: string[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(y, (m - 1) - i, 1));
      months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    const where = { clientId, outletCode: { in: outletCodes }, month: { in: months } };
    const [tRows, aRows] = await Promise.all([
      this.prisma.outletTarget.findMany({ where, select: { month: true, targetValues: true } }),
      this.prisma.outletSalesRecord.findMany({ where, select: { month: true, kpiValues: true } }),
    ]);
    const sumFor = (rows: { month: string; v: unknown }[], mo: string) =>
      rows.filter((r) => r.month === mo)
        .reduce((s, r) => s + (Number(((r.v ?? {}) as Record<string, number>)[kpiCode]) || 0), 0);
    return months.map((mo) => ({
      month: mo,
      target:   sumFor(tRows.map((r) => ({ month: r.month, v: r.targetValues })), mo),
      achieved: sumFor(aRows.map((r) => ({ month: r.month, v: r.kpiValues })), mo),
    }));
  }

  /**
   * Shared outlet projection for a sales user's active outlet assignments.
   * Ported from the source's buildOutlets() (sales/outlets) and the inline copy
   * in sales/team/[memberId]/outlets — single consistent shape across both.
   *
   * Target/TargetAchievement are dropped, so the partner-target read and the
   * achievement-derived targetPct are removed; targetPct is reported as 0.
   */
  private async buildOutlets(salesUserId: string | string[]) {
    const ids = Array.isArray(salesUserId) ? salesUserId : [salesUserId];
    const assignments = await this.prisma.salesUserAssignment.findMany({
      where: {
        salesUserId: { in: ids },
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
                // Prior-KYC fields — surfaced so the new-KYC wizard can pre-fill
                // when a senior/admin rejected the submission and the rep re-enters.
                businessName: true,
                gstNumber: true,
                panNumber: true,
                bankName: true,
                bankAccountNumber: true,
                ifscCode: true,
                upiId: true,
                // Sales-assisted redeem (B1) drives off the outlet's partnerId +
                // its real redeemable balance, so the FE can offer "redeem for
                // this outlet" with the points headroom shown.
                wallets: { select: { redeemablePoints: true } },
                kycSubmissions: {
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                  select: { id: true, status: true, createdAt: true, rejectionReason: true },
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
          // Re-entry statuses: the rep re-opens the SAME outlet's KYC wizard
          // pre-filled. Only build existingKyc for these (else null).
          const RE_ENTRY = ['REJECTED', 'RESUBMISSION_REQUIRED', 'RE_KYC_REQUIRED'];
          const isReEntry = !!latestKyc && RE_ENTRY.includes(latestKyc.status);
          // Address lives on the Outlet (ChannelPartner has no address columns).
          const fullAddress = [outlet.addressLine1, outlet.addressLine2]
            .filter(Boolean)
            .join(', ');
          const existingKyc =
            partner && isReEntry
              ? {
                  partnerName: partner.businessName,
                  mobile: outlet.phone ?? partner.phone ?? '',
                  gstNumber: partner.gstNumber ?? '',
                  panNumber: partner.panNumber ?? '',
                  address: fullAddress,
                  city: outlet.city ?? '',
                  state: outlet.state ?? '',
                  pincode: outlet.pincode ?? '',
                  bankName: partner.bankName ?? '',
                  accountNumber: partner.bankAccountNumber ?? '',
                  ifscCode: partner.ifscCode ?? '',
                  upiId: partner.upiId ?? '',
                }
              : null;

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
            kycRejectionReason: latestKyc?.rejectionReason ?? null,
            reKycFlags: outlet.reKycFlags ?? null,
            existingKyc,
            targetPct: 0,
          };
        })
    );
  }
}
