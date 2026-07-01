import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isSelfOrDescendant, descendantSalesUserIds } from './sales-hierarchy-access.helper';
import { kpiCodeKeys, currentMonthKey } from '../targets/targets.helpers';

/**
 * One row of the sales team leaderboard — the exact shape the FE
 * (platform/src/app/sales/leaderboard/page.tsx) consumes. Entries are returned
 * already sorted best-first; the FE assigns rank by array order.
 */
export interface SalesEntry {
  name: string;
  territory: string;
  achievementPct: number;
  activeOutlets: number;
  /** previous-month rank − current-month rank (+ve = moved up vs last month). */
  change: number;
  isMe?: boolean;
}

/** Scopes that widen the same-level peer net for the leaderboard. */
type LeaderboardScope = 'rm' | 'state' | 'national';

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
   *
   * Each direct subordinate row is enriched with that member's WHOLE-SUBTREE
   * rollup (self + their entire downline): outlets / kycDone / kycPending /
   * targetValue / targetPct. Summing the direct members in the FE then yields the
   * viewer's full downline (the My-Team summary tiles). The rollup is done in
   * memory off a SINGLE batch of queries spanning the viewer's whole subtree —
   * NO per-member queries (no N+1). Everything is tenant-scoped by clientId.
   */
  async getTeam(user: JwtPayload) {
    const salesUser = await this.prisma.salesUser.findFirst({
      where: { userId: user.sub, user: { clientId: user.clientId }, deletedAt: null },
      include: {
        hierarchyLevel: { select: { code: true, name: true, level: true } },
        subordinates: {
          where: { isActive: true, deletedAt: null },
          include: {
            user: { select: { name: true, phone: true } },
            hierarchyLevel: { select: { code: true, name: true, level: true } },
            _count: { select: { subordinates: true } },
          },
        },
      },
    });

    if (!salesUser) return { salesUser: null, members: [] };

    const rollups = await this.buildTeamRollups(
      user.clientId,
      salesUser.id,
      salesUser.subordinates.map((s) => s.id),
    );

    const members = salesUser.subordinates.map((sub) => {
      const roll = rollups.get(sub.id) ?? { outlets: 0, kycDone: 0, kycPending: 0, targetValue: 0, targetPct: 0 };
      return {
        id: sub.id,
        employeeCode: sub.employeeCode,
        name: sub.user.name,
        mobile: sub.user.phone ?? '',
        role: sub.hierarchyLevel.code,
        roleLabel: sub.hierarchyLevel.name,
        territory: sub.region ?? sub.zone ?? '',
        teamSize: sub._count.subordinates,
        joinedAt: sub.joinedAt.toISOString(),
        // Whole-subtree rollup (self + downline) — drives the FE My-Team tiles.
        outlets: roll.outlets,
        kycDone: roll.kycDone,
        kycPending: roll.kycPending,
        targetValue: roll.targetValue,
        targetPct: roll.targetPct,
      };
    });

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
   * Per-direct-member WHOLE-SUBTREE rollup for the My-Team summary tiles.
   *
   * Returns a map directMemberId → { outlets, kycDone, kycPending, targetValue,
   * targetPct } where each metric is rolled up over THAT member's own subtree
   * (the member + their entire downline). The FE sums these direct-member rows to
   * get the viewer's full downline totals.
   *
   * Efficiency: loads the tenant's reporting edges, the viewer-subtree's active
   * outlet assignments (+ each outlet's latest KYC status), the primary KpiDef and
   * the current-month primary target/achievement maps ONCE, then rolls up every
   * direct member's subtree IN MEMORY. No per-member queries (no N+1).
   *
   * Definitions mirror the rest of the file so the tiles reconcile:
   *  • outlets   — active assignment (unassignedAt null) to any assigned outlet,
   *                counted distinct per subtree — EXACT same outlet-scoping as
   *                buildOutlets / /sales/outlets (incl. PENDING / un-KYC'd outlets).
   *  • kycDone   — of those outlets, latest KYC status === 'APPROVED'.
   *  • kycPending— of those outlets, latest status NOT in the terminal set
   *                ['APPROVED','REJECTED','NOT_INTERESTED'] (incl. NOT_STARTED /
   *                partner-less). EXACT same definitions as getMember.
   *  • targetValue/targetPct — the subtree's PRIMARY-KPI current-month target sum
   *                and round(100 * achieved / target) (0 when target is 0), using
   *                the SAME period/primary-KPI selection as getLeaderboard.
   *
   * Tenant-scoped throughout (edges + assignments + targets all filter clientId).
   */
  private async buildTeamRollups(
    clientId: string,
    viewerSalesUserId: string,
    directMemberIds: string[],
  ): Promise<Map<string, { outlets: number; kycDone: number; kycPending: number; targetValue: number; targetPct: number }>> {
    const empty = new Map<string, { outlets: number; kycDone: number; kycPending: number; targetValue: number; targetPct: number }>();
    if (directMemberIds.length === 0) return empty;

    // ── 1. Tenant edge list → each direct member's subtree ids (in memory). ────
    const edges = await this.prisma.salesUser.findMany({
      where: { user: { clientId }, deletedAt: null },
      select: { id: true, reportingToId: true },
    });

    // The viewer subtree bounds the single assignment query; each direct member's
    // own subtree is a slice of it. (descendantSalesUserIds is cycle-safe.)
    const viewerSubtree = descendantSalesUserIds(viewerSalesUserId, edges);
    const memberSubtrees = new Map<string, Set<string>>(
      directMemberIds.map((mid) => [mid, descendantSalesUserIds(mid, edges)]),
    );

    // ── 2. Active assignments → active outlets, with latest KYC status, ONCE. ──
    // Mirrors buildOutlets' outlet-scoping (active assignment to a live outlet),
    // PLUS the latest KYC submission so we can classify done/pending in memory.
    const assignments = await this.prisma.salesUserAssignment.findMany({
      where: {
        // EXACT same outlet-scoping as buildOutlets / getMember: an active
        // assignment (unassignedAt null) to any assigned outlet. Do NOT add an
        // `outlet: { isActive: true }` filter — outlets are created isActive:false
        // (PENDING) and only flip to true on KYC approval, so filtering on it would
        // (a) under-count "Outlets" vs the /sales/outlets list and (b) drop every
        // pending/un-KYC'd outlet BEFORE classification → "KYC Pending" always 0.
        salesUserId: { in: [...viewerSubtree] },
        unassignedAt: null,
        outletId: { not: null },
      },
      select: {
        salesUserId: true,
        outlet: {
          select: {
            id: true,
            outletCode: true,
            partner: {
              select: {
                kycSubmissions: {
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                  select: { status: true },
                },
              },
            },
          },
        },
      },
    });

    // salesUserId → list of its assigned active outlets (id, code, latest status).
    // A partner-less outlet has no KYC submission → NOT_STARTED (pending action).
    type OutletInfo = { id: string; outletCode: string | null; status: string };
    const outletsByUser = new Map<string, OutletInfo[]>();
    for (const a of assignments) {
      if (!a.outlet) continue;
      const status = a.outlet.partner?.kycSubmissions[0]?.status ?? 'NOT_STARTED';
      const arr = outletsByUser.get(a.salesUserId) ?? [];
      arr.push({ id: a.outlet.id, outletCode: a.outlet.outletCode, status });
      outletsByUser.set(a.salesUserId, arr);
    }

    // ── 3. Primary KPI + current-month target/achieved maps, ONCE. ────────────
    // Same DETERMINISTIC primary pick (isPrimary, else first by code) and current
    // month as getLeaderboard, so team targets reconcile with the leaderboard.
    const kpiDefs = await this.prisma.kpiDef.findMany({
      where: { clientId },
      select: { code: true, isPrimary: true },
      orderBy: { code: 'asc' },
    });
    const primaryCode = (kpiDefs.find((k) => k.isPrimary) ?? kpiDefs[0])?.code ?? null;
    const month = this.reportMonth();
    const [targetMap, achMap] = await this.primaryMapsForMonth(clientId, month, primaryCode);

    // ── 4. Roll up each direct member's subtree IN MEMORY (no per-member query). ─
    const TERMINAL = ['APPROVED', 'REJECTED', 'NOT_INTERESTED'];
    const result = new Map<string, { outlets: number; kycDone: number; kycPending: number; targetValue: number; targetPct: number }>();
    for (const [memberId, subtree] of memberSubtrees) {
      // Distinct active outlets across the member's subtree.
      const outletIds = new Set<string>();
      const outletCodes = new Set<string>();
      let kycDone = 0;
      let kycPending = 0;
      for (const sid of subtree) {
        for (const o of outletsByUser.get(sid) ?? []) {
          if (outletIds.has(o.id)) continue; // dedupe across multiple assignees
          outletIds.add(o.id);
          if (o.outletCode) outletCodes.add(o.outletCode);
          if (o.status === 'APPROVED') kycDone++;
          if (!TERMINAL.includes(o.status)) kycPending++;
        }
      }

      // Primary-KPI target/achieved summed over the subtree's outlet codes.
      let targetValue = 0;
      let achieved = 0;
      for (const code of outletCodes) {
        targetValue += targetMap.get(code) ?? 0;
        achieved += achMap.get(code) ?? 0;
      }
      const targetPct = targetValue > 0 ? Math.round((100 * achieved) / targetValue) : 0;

      result.set(memberId, { outlets: outletIds.size, kycDone, kycPending, targetValue, targetPct });
    }
    return result;
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

    // Month to report: the caller's period, else the CURRENT calendar month (owner
    // decision) — not the latest target month, which may be a future month with no
    // achievement yet (that left the card showing 0 achievement).
    const month = this.reportMonth(period);

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
   * The reporting month a target/achievement view defaults to when the caller names
   * none: the CURRENT calendar month (server-clock `YYYY-MM`, same basis as the FE's
   * CURRENT_MONTH and the upload month-lock `currentMonthKey`). Owner decision
   * 2026-06-25: the dashboard "Target Achievement" card always reflects the current
   * month — NOT whatever month happens to have the most/least data. (A target uploaded
   * for a future month no longer hijacks the card and shows 0 achievement.)
   */
  private reportMonth(period?: string): string {
    return period ?? currentMonthKey();
  }

  /**
   * The calendar month immediately before `month` (YYYY-MM) as a YYYY-MM string.
   * Pure string math — parses the YYYY-MM and subtracts one, rolling Jan→Dec of
   * the prior year. Deliberately does NOT call `new Date()` argless so the result
   * is a pure function of its input (used for the leaderboard's prev-month diff).
   * e.g. '2026-01' → '2025-12', '2026-06' → '2026-05'.
   */
  private previousMonthKey(month: string): string {
    const [y, m] = month.split('-').map(Number);
    const prevM = m === 1 ? 12 : m - 1;
    const prevY = m === 1 ? y - 1 : y;
    return `${prevY}-${String(prevM).padStart(2, '0')}`;
  }

  /**
   * Shared per-outlet target/achievement read for a fixed set of outlet codes.
   * Resolves the month (caller's period, else the current calendar month), joins
   * OutletTarget.targetValues ⋈ OutletSalesRecord.kpiValues ⋈ KpiDef, and returns
   * { period, kpiColumns (primary-first), rows keyed by outletCode }.
   */
  private async readOutletTargets(clientId: string, outletCodes: string[], period?: string) {
    if (outletCodes.length === 0) return { period: null, kpiColumns: [], rows: [] };

    const month = this.reportMonth(period);

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
   * GET /v1/sales/leaderboard?scope=&period= — ranks the CALLER against their
   * same-level peers (same hierarchyLevelId), each scored by their OWN team
   * (subtree) PRIMARY-KPI achievement. Scope widens the peer net:
   *   rm       = peers under the caller's reporting manager (same reportingToId).
   *   state    = same level AND same region as the caller.
   *   national = same level, whole tenant.
   * Population is restricted to active (isActive, deletedAt null) sales users at
   * the caller's level. Entries are returned sorted best-first (achievementPct
   * desc, tie-break activeOutlets desc then name asc); the FE ranks by order.
   * `change` = prevRank − currRank (+ve = moved up); 0 when the candidate had no
   * prior-month target data. EVERYTHING is tenant-scoped by user.clientId.
   */
  async getLeaderboard(
    user: JwtPayload,
    scope: string = 'rm',
    period?: string,
  ): Promise<{ entries: SalesEntry[] }> {
    // ── 1. Resolve the caller's own SalesUser (tenant-scoped). ─────────────────
    const caller = await this.prisma.salesUser.findFirst({
      where: { userId: user.sub, user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true, userId: true, reportingToId: true, hierarchyLevelId: true, region: true },
    });
    if (!caller) return { entries: [] };

    // ── 2. Validate scope; default 'rm' on anything else. ─────────────────────
    const validScope: LeaderboardScope =
      scope === 'state' || scope === 'national' || scope === 'rm' ? scope : 'rm';

    // Sanitise the user-supplied period: only a well-formed YYYY-MM (months 01-12)
    // is honoured; anything else falls back to the current month. Prevents a garbage
    // ?period= from flowing into the month math and silently zeroing the whole board.
    const safePeriod =
      period && /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? period : undefined;

    // ── 3. Load the tenant's sales users once (id,userId,reportingToId,level,
    //       region,zone,isActive,deletedAt,name). The EDGE set (subtree roll-up)
    //       spans ALL non-deleted users so a subtree rolls up correctly even
    //       through inactive intermediate nodes; the POPULATION is the active
    //       same-level peers per scope. ───────────────────────────────────────
    const allUsers = await this.prisma.salesUser.findMany({
      where: { user: { clientId: user.clientId }, deletedAt: null },
      select: {
        id: true,
        userId: true,
        reportingToId: true,
        hierarchyLevelId: true,
        region: true,
        zone: true,
        isActive: true,
        user: { select: { name: true } },
      },
    });

    const edges = allUsers.map((u) => ({ id: u.id, reportingToId: u.reportingToId }));
    const usersById = new Map(allUsers.map((u) => [u.id, u]));

    // Territory proxy = the name of a candidate's nearest ancestor (inclusive) at the
    // ZNM (Zonal Manager) level — owner decision: ZNM stands in for "zone" (SalesUser has
    // no zone of its own). Walk up the reporting chain to the first ZNM-level node. Returns
    // '' when there is no ZNM ancestor (e.g. an NSM above ZNM, or a tenant with no ZNM level);
    // the caller then falls back to the rep's own region/zone. Iteration is capped at the
    // user count to defend against a cyclic reporting chain.
    const znmLevel = await this.prisma.salesHierarchyLevel.findFirst({
      where: { clientId: user.clientId, code: 'ZNM' },
      select: { id: true },
    });
    const znmTerritory = (startId: string): string => {
      if (!znmLevel) return '';
      let curId: string | null = startId;
      for (let hops = 0; curId && hops <= allUsers.length; hops++) {
        const u = usersById.get(curId);
        if (!u) break;
        if (u.hierarchyLevelId === znmLevel.id) return u.user.name ?? '';
        curId = u.reportingToId;
      }
      return '';
    };

    // Population: active, at the caller's level, narrowed by scope.
    const population = allUsers.filter((u) => {
      if (!u.isActive) return false;
      if (u.hierarchyLevelId !== caller.hierarchyLevelId) return false;
      if (validScope === 'rm') return u.reportingToId === caller.reportingToId;
      if (validScope === 'state') return u.region === caller.region;
      return true; // national — same level, whole tenant
    });
    if (population.length === 0) return { entries: [] };

    // ── 4. Load active assignments once → salesUserId → [outletCode]. ─────────
    const assignments = await this.prisma.salesUserAssignment.findMany({
      where: {
        salesUserId: { in: allUsers.map((u) => u.id) },
        unassignedAt: null,
        outletId: { not: null },
      },
      select: { salesUserId: true, outlet: { select: { outletCode: true } } },
    });
    const outletCodesByUser = new Map<string, string[]>();
    for (const a of assignments) {
      const code = a.outlet?.outletCode;
      if (!code) continue;
      const arr = outletCodesByUser.get(a.salesUserId) ?? [];
      arr.push(code);
      outletCodesByUser.set(a.salesUserId, arr);
    }

    // ── 5. The primary KPI (isPrimary, else the first KpiDef). ────────────────
    // orderBy code so the pick is DETERMINISTIC even if a tenant mis-configures
    // more than one isPrimary KpiDef (otherwise `find` would depend on row order).
    const kpiDefs = await this.prisma.kpiDef.findMany({
      where: { clientId: user.clientId },
      select: { code: true, isPrimary: true },
      orderBy: { code: 'asc' },
    });
    const primaryCode = (kpiDefs.find((k) => k.isPrimary) ?? kpiDefs[0])?.code ?? null;

    // ── 6. Both months' primary target/achieved per outletCode. ───────────────
    const currMonth = this.reportMonth(safePeriod);
    const prevMonth = this.previousMonthKey(currMonth);
    const [currTargets, currAch] = await this.primaryMapsForMonth(user.clientId, currMonth, primaryCode);
    const [prevTargets, prevAch] = await this.primaryMapsForMonth(user.clientId, prevMonth, primaryCode);

    // Subtree sum of a per-outletCode map for one candidate.
    const sumSubtree = (candidateId: string, map: Map<string, number>): number => {
      const subtreeIds = descendantSalesUserIds(candidateId, edges);
      let total = 0;
      for (const sid of subtreeIds) {
        for (const code of outletCodesByUser.get(sid) ?? []) total += map.get(code) ?? 0;
      }
      return total;
    };

    // Distinct active-assignment outletCodes in a candidate's subtree.
    const subtreeOutletCount = (candidateId: string): number => {
      const subtreeIds = descendantSalesUserIds(candidateId, edges);
      const codes = new Set<string>();
      for (const sid of subtreeIds) {
        for (const code of outletCodesByUser.get(sid) ?? []) codes.add(code);
      }
      return codes.size;
    };

    // round(100 * achieved / target), or 0 when target sum is 0 (never /0).
    const pctFor = (
      candidateId: string,
      targets: Map<string, number>,
      ach: Map<string, number>,
    ): { pct: number; hasTarget: boolean } => {
      const sumTarget = sumSubtree(candidateId, targets);
      if (sumTarget === 0) return { pct: 0, hasTarget: false };
      const sumAchieved = sumSubtree(candidateId, ach);
      return { pct: Math.round((100 * sumAchieved) / sumTarget), hasTarget: true };
    };

    // ── 7. Build current + previous rankings over the SAME population. ────────
    type Computed = {
      userId: string;
      name: string;
      territory: string;
      achievementPct: number;
      activeOutlets: number;
      hadPrevTarget: boolean;
      prevPct: number;
      isMe: boolean;
    };

    const computed: Computed[] = population.map((c) => {
      const curr = pctFor(c.id, currTargets, currAch);
      const prev = pctFor(c.id, prevTargets, prevAch);
      return {
        userId: c.userId,
        name: c.user.name,
        // ZNM ancestor name (owner's zone proxy); fall back to the rep's own region/zone.
        territory: znmTerritory(c.id) || c.region || c.zone || '',
        achievementPct: curr.pct,
        activeOutlets: subtreeOutletCount(c.id),
        hadPrevTarget: prev.hasTarget,
        prevPct: prev.pct,
        isMe: c.userId === user.sub,
      };
    });

    // Ranking comparator (shared by both months): achievementPct desc,
    // tie-break activeOutlets desc, then name asc.
    const byScore = (a: { pct: number; activeOutlets: number; name: string }, b: typeof a) =>
      b.pct - a.pct || b.activeOutlets - a.activeOutlets || a.name.localeCompare(b.name);

    // Current-month rank: 1-based position in the sorted population.
    const currentSorted = [...computed].sort((a, b) =>
      byScore(
        { pct: a.achievementPct, activeOutlets: a.activeOutlets, name: a.name },
        { pct: b.achievementPct, activeOutlets: b.activeOutlets, name: b.name },
      ),
    );
    const currRankByUser = new Map<string, number>();
    currentSorted.forEach((c, i) => currRankByUser.set(c.userId, i + 1));

    // Previous-month rank: SAME population, ranked on each candidate's prev-month
    // achievement (and the SAME current activeOutlets tie-break — population is
    // identical, only the score changes).
    const previousSorted = [...computed].sort((a, b) =>
      byScore(
        { pct: a.prevPct, activeOutlets: a.activeOutlets, name: a.name },
        { pct: b.prevPct, activeOutlets: b.activeOutlets, name: b.name },
      ),
    );
    const prevRankByUser = new Map<string, number>();
    previousSorted.forEach((c, i) => prevRankByUser.set(c.userId, i + 1));

    // ── 8. Map to SalesEntry[], already sorted best-first, with `change`. ─────
    const entries: SalesEntry[] = currentSorted.map((c) => {
      const currRank = currRankByUser.get(c.userId)!;
      // No prior-month target data in the subtree → change = 0.
      const change = c.hadPrevTarget ? prevRankByUser.get(c.userId)! - currRank : 0;
      return {
        name: c.name,
        territory: c.territory,
        achievementPct: c.achievementPct,
        activeOutlets: c.activeOutlets,
        change,
        isMe: c.isMe,
      };
    });

    return { entries };
  }

  /**
   * For one month, returns [targetByOutletCode, achievedByOutletCode] maps for
   * the PRIMARY KPI only, tenant-scoped. Mirrors the getTargets join
   * (OutletTarget.targetValues ⋈ OutletSalesRecord.kpiValues, summed per
   * outletCode for the primary code via kpiCodeKeys). Returns empty maps when
   * there is no primary KPI configured.
   */
  private async primaryMapsForMonth(
    clientId: string,
    month: string,
    primaryCode: string | null,
  ): Promise<[Map<string, number>, Map<string, number>]> {
    if (!primaryCode) return [new Map(), new Map()];
    const [targetRows, achRows] = await Promise.all([
      this.prisma.outletTarget.findMany({
        where: { clientId, month },
        select: { outletCode: true, targetValues: true },
      }),
      this.prisma.outletSalesRecord.findMany({
        where: { clientId, month },
        select: { outletCode: true, kpiValues: true },
      }),
    ]);

    // Sum the primary KPI per outletCode (kpiCodeKeys filters the reserved
    // __names key; only count the primary code present on the row).
    const primaryOf = (v: unknown): number => {
      const obj = (v ?? {}) as Record<string, number>;
      if (!kpiCodeKeys(obj).includes(primaryCode)) return 0;
      return Number(obj[primaryCode]) || 0;
    };
    const accumulate = (rows: { outletCode: string; v: unknown }[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const r of rows) m.set(r.outletCode, (m.get(r.outletCode) ?? 0) + primaryOf(r.v));
      return m;
    };
    return [
      accumulate(targetRows.map((r) => ({ outletCode: r.outletCode, v: r.targetValues }))),
      accumulate(achRows.map((r) => ({ outletCode: r.outletCode, v: r.kpiValues }))),
    ];
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
                bankAccountHolder: true,
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
          const RE_ENTRY = ['REJECTED', 'RE_UPLOAD_REQUIRED', 'RESUBMISSION_REQUIRED', 'RE_KYC_REQUIRED'];
          const isReEntry = !!latestKyc && RE_ENTRY.includes(latestKyc.status);
          // Address lives on the Outlet (ChannelPartner has no address columns).
          // These are the canonical "last submitted" values: on every KYC submission
          // kyc.service writes dto.address→outlet.addressLine1, dto.pincode→outlet.pincode
          // and dto.accountHolderName→partner.bankAccountHolder. KycSubmission stores no
          // address/bank snapshot, so the Outlet/ChannelPartner columns ARE the snapshot.
          // (Re-KYC bug: accountHolderName was dropped — never selected, never set here.)
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
                  accountHolderName: partner.bankAccountHolder ?? '',
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
            programName: outlet.programName ?? '',
            programCategory: outlet.programCategory ?? '',
            kycStatus: outlet.kycIntent === 'NOT_INTERESTED'
              ? 'NOT_INTERESTED'
              : (latestKyc?.status ?? 'NOT_STARTED'),
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
