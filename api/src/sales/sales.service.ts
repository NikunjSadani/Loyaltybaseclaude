import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isReKycActionable } from '../common/kyc-rekyc.helper';
import { istDateKey } from '../common/ist-date';
import {
  resolveGroupPan,
  resolveGroupIdentity,
  resolveGroupCarryForwardDocs,
  type GroupIdentity,
} from '../common/partner-group.helper';
import { isSelfOrDescendant, descendantSalesUserIds } from './sales-hierarchy-access.helper';
import { kpisForOutletType, primaryKpiForOutletType } from './sales-kpi-type.helper';
import { kpiCodeKeys, currentMonthKey } from '../targets/targets.helpers';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
// READ-ONLY reuse of the visibility window-key math (pure helper, no DI) — the VISIBILITY
// pseudo-KPI's "current window" MUST use the same formula the capture/notify services use.
import { currentWindowKey } from '../visibility/visibility-window.helper';
import { resolveTenantFeatures } from '../common/tenant-features.helper';

/**
 * Relation filter that FULLY hides admin-PARKED outlets from sales reps: an outlet whose
 * `kycIntent === 'PARKED'` must never appear in a rep's outlet list, any derived count, or the
 * dashboard. Applied to every `salesUserAssignment.findMany` that loads outlets for a rep.
 *
 * TRAP: Prisma `{ not: 'PARKED' }` DROPS rows whose kycIntent is NULL (SQL NULL semantics), so a
 * normal outlet (kycIntent null) or a NOT_INTERESTED outlet would vanish too. The OR-wrap with
 * `{ kycIntent: null }` KEEPS those and drops ONLY the PARKED ones.
 */
const NOT_PARKED_OUTLET = {
  OR: [{ kycIntent: null }, { kycIntent: { not: 'PARKED' as const } }],
};

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
 * One in-scope outlet, as rolled up from a sales user's assignments for the team-view /
 * trade-comparison aggregates. Lifted to module scope so the shared aggregate below and the
 * service's two consumers (getTeamView, getTradeComparison) share ONE shape.
 */
export type OutletScopeInfo = {
  id: string;
  code: string | null;
  typeCode: string;
  typeName: string;
  program: string;
  status: string;
  isActive: boolean;
};

/** KYC states that are terminal (no further rep action) — drives the kycPending count. */
const TERMINAL_KYC = ['APPROVED', 'REJECTED', 'NOT_INTERESTED'];

/**
 * THE shared "target-met" roll-up for a subtree of sales users — the SINGLE source of truth for
 * the team-view league table AND the trade-comparison card (a divergent second implementation is
 * a bug). Walks the subtree's DEDUPED, filtered (`passes`) outlets and returns:
 *   • outlets / kycDone / kycPending — KPI-independent population counts.
 *   • withTarget / achieved / pct    — among KYC-APPROVED outlets that carry a target>0 for the
 *                                      scored KPI: how many hit it ÷ how many have one (pct null
 *                                      when none have a target). This is the exact team-view ratio.
 *   • achievedSum                    — straight sum of the KPI's achievement over ALL passing
 *                                      deduped outlets (the trade-comparison "monthly sale"); the
 *                                      team-view ignores it, so its output is unchanged.
 */
export function aggregateTargetMet(
  subtree: Set<string>,
  tMap: Map<string, number>,
  aMap: Map<string, number>,
  outletsByUser: Map<string, OutletScopeInfo[]>,
  passes: (o: OutletScopeInfo) => boolean,
) {
  const seen = new Set<string>();
  let outlets = 0,
    kycDone = 0,
    kycPending = 0,
    withTarget = 0,
    achieved = 0,
    achievedSum = 0;
  for (const sid of subtree) {
    for (const o of outletsByUser.get(sid) ?? []) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      if (!passes(o)) continue;
      outlets++;
      const approved = o.status === 'APPROVED';
      if (approved) kycDone++;
      if (!TERMINAL_KYC.includes(o.status)) kycPending++;
      // monthly-sale sum: the KPI's achievement over every passing outlet (trade-comparison only).
      if (o.code) achievedSum += aMap.get(o.code) ?? 0;
      if (approved && o.code) {
        const t = tMap.get(o.code) ?? 0;
        if (t > 0) {
          withTarget++;
          if ((aMap.get(o.code) ?? 0) >= t) achieved++;
        }
      }
    }
  }
  const pct = withTarget > 0 ? Math.round((100 * achieved) / withTarget) : null;
  return { outlets, kycDone, kycPending, withTarget, achieved, pct, achievedSum };
}

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

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

    // Branch submitters: for each DIRECT report, the login-User ids of that report
    // PLUS their entire downline. The FE KYC-list member filter keys on a submission's
    // submitter userId, so filtering by a manager must return the whole branch (owner
    // 2026-07-03), not just that person's own submissions. Reuses the hierarchy walk.
    const allSalesUsers = await this.prisma.salesUser.findMany({
      where: { user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true, reportingToId: true, userId: true },
    });
    const edges = allSalesUsers.map((s) => ({ id: s.id, reportingToId: s.reportingToId }));
    const userIdBySalesUserId = new Map(allSalesUsers.map((s) => [s.id, s.userId]));

    const members = salesUser.subordinates.map((sub) => {
      const roll = rollups.get(sub.id) ?? { outlets: 0, kycDone: 0, kycPending: 0, targetValue: 0, targetPct: 0 };
      const submitterUserIds = [...descendantSalesUserIds(sub.id, edges)]
        .map((id) => userIdBySalesUserId.get(id))
        .filter((v): v is string => !!v);
      return {
        id: sub.id,
        employeeCode: sub.employeeCode,
        name: sub.user.name,
        mobile: sub.user.phone ?? '',
        role: sub.hierarchyLevel.code,
        roleLabel: sub.hierarchyLevel.name,
        territory: sub.region ?? sub.zone ?? '',
        teamSize: sub._count.subordinates,
        // Login-User ids of this report + their whole downline (KYC-list branch filter).
        submitterUserIds,
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
   *                the SAME period/primary-KPI selection as getLeaderboard. Restricted
   *                to APPROVED + ACTIVE outlets (outlet.isActive:true) — non-approved
   *                outlets now carry target/achievement rows but must not inflate the
   *                headline %. NOTE: only the target-% aggregation is active-only; the
   *                outlets/kycDone/kycPending counts above stay all-inclusive.
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
        // Exclude admin-PARKED outlets so manager "KYC Pending" / "Outlets" counts never
        // include a parked outlet (same null-safe OR-wrap as buildOutlets/getMember).
        outlet: NOT_PARKED_OUTLET,
      },
      select: {
        salesUserId: true,
        outlet: {
          select: {
            id: true,
            outletCode: true,
            // isActive drives ONLY the target-% aggregation (approved+active outlets).
            // The outlet COUNTS + KYC done/pending classification below deliberately
            // include ALL assigned outlets (see the where-clause comment) — do NOT let
            // isActive leak into those.
            isActive: true,
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

    // salesUserId → list of its assigned active outlets (id, code, isActive, latest
    // status). A partner-less outlet has no KYC submission → NOT_STARTED (pending
    // action). `isActive` is carried so the target-% aggregation can restrict to
    // approved+active outlets WITHOUT disturbing the all-inclusive counts.
    type OutletInfo = { id: string; outletCode: string | null; isActive: boolean; status: string };
    const outletsByUser = new Map<string, OutletInfo[]>();
    for (const a of assignments) {
      if (!a.outlet) continue;
      const status = a.outlet.partner?.kycSubmissions[0]?.status ?? 'NOT_STARTED';
      const arr = outletsByUser.get(a.salesUserId) ?? [];
      arr.push({ id: a.outlet.id, outletCode: a.outlet.outletCode, isActive: !!a.outlet.isActive, status });
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
      // Distinct outlets across the member's subtree. COUNTS + KYC classification
      // include ALL assigned outlets (incl. PENDING / un-KYC'd) — same scoping as
      // /sales/outlets. Only the target-% code set (`activeCodes`) restricts to
      // approved+active outlets so the % excludes non-approved outlets, which now
      // carry target/achievement rows (sibling upload-relaxation).
      const outletIds = new Set<string>();
      const activeCodes = new Set<string>();
      let kycDone = 0;
      let kycPending = 0;
      for (const sid of subtree) {
        for (const o of outletsByUser.get(sid) ?? []) {
          if (outletIds.has(o.id)) continue; // dedupe across multiple assignees
          outletIds.add(o.id);
          if (o.isActive && o.outletCode) activeCodes.add(o.outletCode); // KPI set only
          if (o.status === 'APPROVED') kycDone++;
          if (!TERMINAL.includes(o.status)) kycPending++;
        }
      }

      // Primary-KPI target/achieved summed over the subtree's APPROVED+ACTIVE outlet
      // codes (the counts above stay all-inclusive).
      let targetValue = 0;
      let achieved = 0;
      for (const code of activeCodes) {
        targetValue += targetMap.get(code) ?? 0;
        achieved += achMap.get(code) ?? 0;
      }
      const targetPct = targetValue > 0 ? Math.round((100 * achieved) / targetValue) : 0;

      result.set(memberId, { outlets: outletIds.size, kycDone, kycPending, targetValue, targetPct });
    }
    return result;
  }

  /**
   * GET /v1/sales/team-view — the redesigned Team screen (filters + KPI league table).
   *
   * Root = the caller, or `memberId` (auth-scoped to the caller's subtree via assertCanViewMember)
   * for recursive drill-down. Filters: `outletType` + `program` narrow the outlet population;
   * `kpi` (default = primary) selects the achievement metric.
   *
   * Returns the team SUMMARY (filtered, over the root's whole subtree) + each DIRECT report scored
   * by `outletsAchieved / outletsWithTarget` — KYC-approved outlets in that report's WHOLE downline
   * (type/program-filtered) that have a target for the KPI and hit it ÷ those that have a target
   * (an outlet with NO target for the KPI is excluded from BOTH). Members sorted ASCENDING by that
   * % (worst first); members with no targeted outlets (null %) sort last. Plus the filter options.
   *
   * One assignment batch over the root subtree + one target/achievement map pair; everything else
   * rolls up in memory (no per-member query, mirrors buildTeamRollups).
   */
  async getTeamView(
    user: JwtPayload,
    opts: { memberId?: string; outletType?: string; program?: string; kpi?: string } = {},
  ) {
    if (opts.memberId) await this.assertCanViewMember(user, opts.memberId);

    const root = await this.prisma.salesUser.findFirst({
      where: opts.memberId
        ? { id: opts.memberId, deletedAt: null, user: { clientId: user.clientId } }
        : { userId: user.sub, user: { clientId: user.clientId }, deletedAt: null },
      include: {
        user: { select: { name: true, phone: true } },
        hierarchyLevel: { select: { code: true, name: true, level: true } },
        subordinates: {
          where: { isActive: true, deletedAt: null },
          include: {
            user: { select: { name: true, phone: true } },
            hierarchyLevel: { select: { code: true, name: true } },
            // ACTIVE direct-report count only — this drives the FE drill-down route
            // (teamSize>0 → team view, else → outlets). An unfiltered count would still
            // show teamSize=1 for a manager whose only subordinate is soft-deleted and
            // route to an empty team view instead of their outlets.
            _count: { select: { subordinates: { where: { isActive: true, deletedAt: null } } } },
          },
        },
      },
    });

    // KPI catalogue → the KPI filter options + the metric. Enabled only, configured order.
    const kpiDefs = await this.prisma.kpiDef.findMany({
      where: { clientId: user.clientId, enabled: true },
      select: { code: true, label: true, isPrimary: true, order: true },
      orderBy: [{ order: 'asc' }, { code: 'asc' }],
    });
    const primaryCode = (kpiDefs.find((k) => k.isPrimary) ?? kpiDefs[0])?.code ?? null;
    const kpiCode = opts.kpi && kpiDefs.some((k) => k.code === opts.kpi) ? opts.kpi : primaryCode;

    // VISIBILITY pseudo-KPI gate — resolved ONCE, up front. When the tenant has visibility OFF,
    // NOTHING below adds a VISIBILITY code/label/column/score anywhere, so a visibility-disabled
    // tenant (e.g. Deoleo) is byte-identical to the pre-visibility behaviour. Uncached (kill-switch).
    const visibilityEnabled = await this.tenant.resolveVisibilityEnabled(user.clientId);

    // OVERVIEW is the new DEFAULT: single-KPI mode runs ONLY when the caller passes a real,
    // enabled KPI code — OR the VISIBILITY pseudo-KPI on a visibility-enabled tenant. Anything
    // else — empty, absent, 'OVERVIEW', an unknown code, or 'VISIBILITY' on a disabled tenant —
    // is overview. This keeps a real-kpi-code request byte-identical to the pre-overview behaviour
    // and makes `kpi=VISIBILITY` on a disabled tenant fall through to OVERVIEW (safe default).
    const requestedVisibilitySingle = opts.kpi === 'VISIBILITY' && visibilityEnabled;
    const requestedSingle =
      requestedVisibilitySingle ||
      (!!opts.kpi && opts.kpi !== 'OVERVIEW' && kpiDefs.some((k) => k.code === opts.kpi));
    const overview = !requestedSingle;
    const codes = kpiDefs.map((k) => k.code); // all enabled real KPI codes, in KpiDef.order
    const kpiList = kpiDefs.map((k) => ({ code: k.code, label: k.label }));

    const filterOptions = {
      outletTypes: [] as { code: string; name: string }[],
      programs: [] as string[],
      kpis: kpiDefs.map((k) => ({ code: k.code, label: k.label })),
    };

    // Visibility is a pseudo-KPI appended AFTER the real KpiDefs in both the KPI list and the
    // filter options (enabled tenants only). The OVERVIEW `score` then averages it in naturally.
    if (visibilityEnabled) {
      kpiList.push({ code: 'VISIBILITY', label: 'Visibility' });
      filterOptions.kpis.push({ code: 'VISIBILITY', label: 'Visibility' });
    }
    const emptySummary = { outlets: 0, kycDone: 0, kycPending: 0, avgTargetPct: null as number | null };
    if (!root) {
      if (overview) {
        return {
          mode: 'OVERVIEW',
          kpis: kpiList,
          summary: { outlets: 0, kycDone: 0, kycPending: 0, avgScore: null as number | null },
          members: [],
          filterOptions,
        };
      }
      return { mode: 'SINGLE', member: null, summary: emptySummary, members: [], filterOptions, kpiCode };
    }

    const month = this.reportMonth();
    // Single mode: the selected/primary-KPI maps (byte-identical). Overview: per-KPI maps for
    // every enabled code, each scored with the SAME outlets-achieved formula as single mode.
    const [targetMap, achMap] = overview || requestedVisibilitySingle
      ? [new Map<string, number>(), new Map<string, number>()]
      : await this.primaryMapsForMonth(user.clientId, month, kpiCode);
    const kpiMaps = overview ? await this.allKpiMapsForMonth(user.clientId, month, codes) : null;

    // Shared scope: tenant edges + the root's subtree outlets (deduped, typed, KYC-tagged).
    // The SAME builder feeds getTradeComparison, so the two screens never drift on scoping.
    const { edges, rootSubtree, outletsByUser, typeSet, programSet } =
      await this.buildOutletScope(user.clientId, root.id);
    const directReports = root.subordinates;
    const memberSubtrees = new Map<string, Set<string>>(
      directReports.map((m) => [m.id, descendantSalesUserIds(m.id, edges)]),
    );
    filterOptions.outletTypes = [...typeSet.entries()]
      .map(([code, name]) => ({ code, name }))
      .sort((x, y) => x.name.localeCompare(y.name));
    filterOptions.programs = [...programSet].sort();

    const typeF = opts.outletType && opts.outletType !== 'ALL' ? opts.outletType : null;
    const progF = opts.program && opts.program !== 'ALL' ? opts.program : null;
    const passes = (o: OutletScopeInfo) =>
      (!typeF || o.typeCode === typeF) && (!progF || o.program === progF);

    // Roll up one subtree's (deduped, filtered) outlets into counts + the outlets-achieved metric,
    // scored against the supplied target/achievement maps (the single KPI, or one KPI in overview).
    // Thin wrapper over the module-level aggregate so the ratio can NEVER diverge from trade-comparison.
    const aggregate = (
      subtree: Set<string>,
      tMap: Map<string, number>,
      aMap: Map<string, number>,
    ) => aggregateTargetMet(subtree, tMap, aMap, outletsByUser, passes);

    // ── VISIBILITY pseudo-KPI data (enabled tenants only; READ-ONLY from visibility) ──────────
    // Denominator (per subtree): in-scope (outletType ∈ visibilityConfig.outletScope), KYC-APPROVED
    // and active outlets — AFTER the same type/program filters the other KPIs apply (`passes`).
    // Numerator: of those, outlets with an APPROVED VisibilityCapture in the CURRENT window.
    // One findMany over the root subtree's outlet ids (windowKey + status filtered) — no N+1.
    let visScope: string[] = [];
    const approvedVisOutletIds = new Set<string>();
    if (visibilityEnabled) {
      const cfg = (await this.tenantSettings.getEffectiveSettings(user.clientId)).visibilityConfig;
      visScope = cfg.outletScope ?? [];
      // REUSE the capture/notify services' exact window-key math (frequency-driven IST windows).
      const windowKey = currentWindowKey(new Date(), cfg.frequencyPerMonth);
      const allOutletIds = new Set<string>();
      for (const arr of outletsByUser.values()) for (const o of arr) allOutletIds.add(o.id);
      if (visScope.length > 0 && allOutletIds.size > 0) {
        const caps = await this.prisma.visibilityCapture.findMany({
          where: {
            clientId: user.clientId,
            windowKey,
            status: 'APPROVED',
            outletId: { in: [...allOutletIds] },
          },
          select: { outletId: true },
        });
        for (const c of caps) approvedVisOutletIds.add(c.outletId);
      }
    }

    // Roll one subtree's (deduped, type/program-filtered) outlets into the VISIBILITY num/den/pct.
    const visAggregate = (subtree: Set<string>) => {
      const seen = new Set<string>();
      let den = 0;
      let num = 0;
      for (const sid of subtree) {
        for (const o of outletsByUser.get(sid) ?? []) {
          if (seen.has(o.id)) continue;
          seen.add(o.id);
          if (!passes(o)) continue; // same outletType/program filter as the other KPIs
          if (o.status !== 'APPROVED') continue; // KYC-approved
          if (!o.isActive) continue; // active
          if (!visScope.includes(o.typeCode)) continue; // in visibility scope
          den++;
          if (approvedVisOutletIds.has(o.id)) num++; // current-window APPROVED capture
        }
      }
      const pct = den > 0 ? Math.round((100 * num) / den) : null;
      return { num, den, pct };
    };

    // ── OVERVIEW mode ────────────────────────────────────────────────────────────────────
    // Every enabled KPI is scored as outlets-achieved % (its configured rollup is IGNORED here);
    // a member's `score` is the simple unweighted average of that member's NON-NULL KPI percents.
    if (overview) {
      const EMPTY = new Map<string, number>(); // counts are KPI-independent; aggregate only reads maps
      const rootAgg = aggregate(rootSubtree, EMPTY, EMPTY);

      const ovMembers = directReports.map((m) => {
        const subtree = memberSubtrees.get(m.id) ?? new Set<string>();
        const kpiPercents: Record<string, number | null> = {};
        let counts: ReturnType<typeof aggregate> | null = null;
        for (const code of codes) {
          const [tMap, aMap] = kpiMaps!.get(code) ?? [EMPTY, EMPTY];
          const agg = aggregate(subtree, tMap, aMap);
          kpiPercents[code] = agg.pct;
          if (!counts) counts = agg; // outlets/kyc counts are identical across KPIs
        }
        if (!counts) counts = aggregate(subtree, EMPTY, EMPTY); // zero-KPI tenant
        // VISIBILITY pseudo-KPI column (enabled tenants only) — appended AFTER the real KPIs so it
        // folds into the simple-average score below like any other non-null percent.
        if (visibilityEnabled) kpiPercents['VISIBILITY'] = visAggregate(subtree).pct;
        const scoreCodes = visibilityEnabled ? [...codes, 'VISIBILITY'] : codes;
        const nonNull = scoreCodes
          .map((c) => kpiPercents[c])
          .filter((v): v is number => v !== null);
        const score = nonNull.length
          ? Math.round(nonNull.reduce((a, b) => a + b, 0) / nonNull.length)
          : null;
        return {
          id: m.id,
          name: m.user.name,
          roleLabel: m.hierarchyLevel.name,
          employeeCode: m.employeeCode,
          mobile: m.user.phone ?? '',
          outlets: counts.outlets,
          teamSize: m._count.subordinates,
          kycPending: counts.kycPending,
          kycDone: counts.kycDone,
          kpiPercents,
          score,
        };
      });

      // Ascending by score (worst first); no-targeted-outlet-for-any-KPI (null) sorts last; tie-break name.
      ovMembers.sort((a, b) => {
        if (a.score === null && b.score === null) return a.name.localeCompare(b.name);
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        if (a.score !== b.score) return a.score - b.score;
        return a.name.localeCompare(b.name);
      });

      const memberScores = ovMembers
        .map((m) => m.score)
        .filter((v): v is number => v !== null);
      const avgScore = memberScores.length
        ? Math.round(memberScores.reduce((a, b) => a + b, 0) / memberScores.length)
        : null;

      return {
        mode: 'OVERVIEW',
        // `member` is present only on the drill-down (memberId) call, per the FE contract.
        ...(opts.memberId
          ? { member: { id: root.id, name: root.user.name, roleLabel: root.hierarchyLevel.name } }
          : {}),
        kpis: kpiList,
        summary: {
          outlets: rootAgg.outlets,
          kycDone: rootAgg.kycDone,
          kycPending: rootAgg.kycPending,
          avgScore,
        },
        members: ovMembers,
        filterOptions,
      };
    }

    // ── SINGLE VISIBILITY pseudo-KPI mode (enabled tenants only) ─────────────────────────────
    // Same SINGLE shape, but scored by the visibility pct: achievedPct = pct, outletsAchieved =
    // num (current-window approved), outletsWithTarget = den (in-scope approved+active). Counts
    // (outlets/kyc) are KPI-independent (empty maps). Members sorted ascending, null last.
    if (requestedVisibilitySingle) {
      const EMPTY = new Map<string, number>();
      const rootCounts = aggregate(rootSubtree, EMPTY, EMPTY);
      const rootVis = visAggregate(rootSubtree);
      const visSummary = {
        outlets: rootCounts.outlets,
        kycDone: rootCounts.kycDone,
        kycPending: rootCounts.kycPending,
        avgTargetPct: rootVis.pct,
      };

      const visMembers = directReports.map((m) => {
        const subtree = memberSubtrees.get(m.id) ?? new Set<string>();
        const counts = aggregate(subtree, EMPTY, EMPTY);
        const vis = visAggregate(subtree);
        return {
          id: m.id,
          name: m.user.name,
          employeeCode: m.employeeCode,
          mobile: m.user.phone ?? '',
          role: m.hierarchyLevel.code,
          roleLabel: m.hierarchyLevel.name,
          teamSize: m._count.subordinates,
          outlets: counts.outlets,
          kycDone: counts.kycDone,
          kycPending: counts.kycPending,
          outletsAchieved: vis.num,
          outletsWithTarget: vis.den,
          achievedPct: vis.pct,
        };
      });

      // Ascending by visibility % (worst first); no-in-scope-outlets (null) sorts last.
      visMembers.sort((a, b) => {
        if (a.achievedPct === null && b.achievedPct === null) return a.name.localeCompare(b.name);
        if (a.achievedPct === null) return 1;
        if (b.achievedPct === null) return -1;
        if (a.achievedPct !== b.achievedPct) return a.achievedPct - b.achievedPct;
        return a.name.localeCompare(b.name);
      });

      return {
        mode: 'SINGLE',
        member: {
          id: root.id,
          name: root.user.name,
          roleLabel: root.hierarchyLevel.name,
          role: root.hierarchyLevel.code,
          level: root.hierarchyLevel.level,
        },
        summary: visSummary,
        members: visMembers,
        filterOptions,
        kpiCode: 'VISIBILITY',
      };
    }

    // ── SINGLE-KPI mode (shape unchanged; only `mode` is added for clean FE branching). ──────
    const sum = aggregate(rootSubtree, targetMap, achMap);
    const summary = { outlets: sum.outlets, kycDone: sum.kycDone, kycPending: sum.kycPending, avgTargetPct: sum.pct };

    const members = directReports.map((m) => {
      const agg = aggregate(memberSubtrees.get(m.id) ?? new Set<string>(), targetMap, achMap);
      return {
        id: m.id,
        name: m.user.name,
        employeeCode: m.employeeCode,
        mobile: m.user.phone ?? '',
        role: m.hierarchyLevel.code,
        roleLabel: m.hierarchyLevel.name,
        teamSize: m._count.subordinates,
        outlets: agg.outlets,
        kycDone: agg.kycDone,
        kycPending: agg.kycPending,
        outletsAchieved: agg.achieved,
        outletsWithTarget: agg.withTarget,
        achievedPct: agg.pct,
      };
    });

    // Ascending by the KPI-achievement % (worst first); no-targeted-outlets (null) sorts last.
    members.sort((a, b) => {
      if (a.achievedPct === null && b.achievedPct === null) return a.name.localeCompare(b.name);
      if (a.achievedPct === null) return 1;
      if (b.achievedPct === null) return -1;
      if (a.achievedPct !== b.achievedPct) return a.achievedPct - b.achievedPct;
      return a.name.localeCompare(b.name);
    });

    return {
      mode: 'SINGLE',
      member: {
        id: root.id,
        name: root.user.name,
        roleLabel: root.hierarchyLevel.name,
        role: root.hierarchyLevel.code,
        level: root.hierarchyLevel.level,
      },
      summary,
      members,
      filterOptions,
      kpiCode,
    };
  }

  /**
   * Shared subtree-scope builder for the team-view + trade-comparison screens: loads the tenant's
   * reporting edges, the root's whole subtree (descendantSalesUserIds) and ONE assignment batch over
   * that subtree, projected to OutletScopeInfo (id/code/type/program/latest-KYC/isActive) and grouped
   * per sales user. Also returns the distinct outlet-type + program sets for the filter dropdowns.
   * Extracted VERBATIM from getTeamView so both consumers scope identically (no divergence).
   */
  private async buildOutletScope(
    clientId: string,
    rootId: string,
  ): Promise<{
    edges: { id: string; reportingToId: string | null }[];
    rootSubtree: Set<string>;
    outletsByUser: Map<string, OutletScopeInfo[]>;
    typeSet: Map<string, string>;
    programSet: Set<string>;
  }> {
    const edges = await this.prisma.salesUser.findMany({
      where: { user: { clientId }, deletedAt: null },
      select: { id: true, reportingToId: true },
    });
    const rootSubtree = descendantSalesUserIds(rootId, edges);

    // One assignment batch over the root subtree, with each outlet's type + program + latest KYC.
    const assignments = await this.prisma.salesUserAssignment.findMany({
      where: {
        salesUserId: { in: [...rootSubtree] },
        unassignedAt: null,
        outletId: { not: null },
        outlet: NOT_PARKED_OUTLET,
      },
      select: {
        salesUserId: true,
        outlet: {
          select: {
            id: true,
            outletCode: true,
            // isActive drives ONLY the VISIBILITY pseudo-KPI denominator (approved+active+in-scope).
            // It is read unconditionally but used only when visibility is enabled — the other KPI
            // counts/metrics never read it, so a visibility-disabled tenant stays byte-identical.
            isActive: true,
            programName: true,
            outletType: { select: { code: true, name: true } },
            partner: {
              select: { kycSubmissions: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } } },
            },
          },
        },
      },
    });

    const outletsByUser = new Map<string, OutletScopeInfo[]>();
    const typeSet = new Map<string, string>();
    const programSet = new Set<string>();
    for (const a of assignments) {
      const o = a.outlet;
      if (!o) continue;
      const info: OutletScopeInfo = {
        id: o.id,
        code: o.outletCode,
        typeCode: o.outletType?.code ?? '',
        typeName: o.outletType?.name ?? o.outletType?.code ?? '',
        program: o.programName ?? '',
        status: o.partner?.kycSubmissions[0]?.status ?? 'NOT_STARTED',
        isActive: !!o.isActive,
      };
      if (info.typeCode) typeSet.set(info.typeCode, info.typeName);
      if (info.program) programSet.add(info.program);
      const arr = outletsByUser.get(a.salesUserId) ?? [];
      arr.push(info);
      outletsByUser.set(a.salesUserId, arr);
    }
    return { edges, rootSubtree, outletsByUser, typeSet, programSet };
  }

  /**
   * GET /v1/sales/trade-comparison?outletType=&program=&memberId= — the sales "Trade Comparison"
   * card (RLP vs BSC at the UI; Bajaj-only there, but this backend is tenant-neutral + additive).
   *
   * For the caller's subtree (optionally drilled to `memberId`), narrowed by `outletType`/`program`,
   * returns three month buckets — `current`, `lastMonth`, and `last3Months` — each carrying:
   *   • monthlySale: the PRIMARY KPI's achievement (₹) SUMMED over the in-scope outlets. The
   *     last3Months value is the AVERAGE of the three individual months' sums.
   *   • targetMet { achieved, withTarget, pct }: computed with the SAME aggregateTargetMet ratio the
   *     team-view league table uses (KYC-approved outlets with a target>0 that hit it ÷ those with a
   *     target). last3Months.pct is the AVERAGE of the three months' pcts (null months skipped, null
   *     when all three are null); achieved/withTarget are the three-month averages (rounded detail).
   *
   * The PRIMARY KPI is resolved PER outlet type (shared KPIs + that type's KPIs). With no outletType
   * it falls back to the tenant primary, so a tenant with only shared (null-outletType) KPIs — e.g.
   * live Deoleo — resolves exactly the primary it does today.
   *
   * Gated SO-and-above (the controller's @Roles drops SALES_ISR). Tenant- + subtree-scoped.
   */
  async getTradeComparison(
    user: JwtPayload,
    opts: { memberId?: string; outletType?: string; program?: string } = {},
  ) {
    if (opts.memberId) await this.assertCanViewMember(user, opts.memberId);

    const root = await this.prisma.salesUser.findFirst({
      where: opts.memberId
        ? { id: opts.memberId, deletedAt: null, user: { clientId: user.clientId } }
        : { userId: user.sub, user: { clientId: user.clientId }, deletedAt: null },
      select: {
        id: true,
        user: { select: { name: true } },
        hierarchyLevel: { select: { code: true, name: true, level: true } },
      },
    });

    // Primary KPI for the requested outlet type (shared + type-specific); null type → tenant primary.
    const kpiDefs = await this.prisma.kpiDef.findMany({
      where: { clientId: user.clientId, enabled: true },
      select: { code: true, label: true, isPrimary: true, order: true, outletType: true },
      orderBy: [{ order: 'asc' }, { code: 'asc' }],
    });
    const typeF = opts.outletType && opts.outletType !== 'ALL' ? opts.outletType : null;
    const progF = opts.program && opts.program !== 'ALL' ? opts.program : null;
    const primary = primaryKpiForOutletType(kpiDefs, typeF);

    const emptyBucket = () => ({
      monthlySale: 0,
      targetMet: { achieved: 0 as number | null, withTarget: 0 as number | null, pct: null as number | null },
    });
    // last3Months mirrors the populated path: only the averaged ratio, so achieved/withTarget = null.
    const emptyLast3 = () => ({
      monthlySale: 0,
      targetMet: { achieved: null as number | null, withTarget: null as number | null, pct: null as number | null },
    });
    const base = {
      outletType: typeF,
      program: progF,
      kpiCode: primary?.code ?? null,
      kpiName: primary?.label ?? null,
      ...(opts.memberId && root
        ? { member: { id: root.id, name: root.user.name, roleLabel: root.hierarchyLevel.name } }
        : {}),
    };

    // Not a sales user, or no KPI applies to this type → stable all-zero buckets.
    if (!root || !primary) {
      return {
        ...base,
        buckets: { current: emptyBucket(), lastMonth: emptyBucket(), last3Months: emptyLast3() },
      };
    }

    const { rootSubtree, outletsByUser } = await this.buildOutletScope(user.clientId, root.id);
    const passes = (o: OutletScopeInfo) =>
      (!typeF || o.typeCode === typeF) && (!progF || o.program === progF);

    // Three consecutive months ending at the current reporting month: [m-2, m-1, m].
    const current = this.reportMonth();
    const prev1 = this.previousMonthKey(current);
    const prev2 = this.previousMonthKey(prev1);
    const months = [prev2, prev1, current];

    // One primary-KPI target/achievement map pair per month, rolled up over the subtree with the
    // SHARED aggregate (so the ratio is identical to team-view).
    const perMonth = await Promise.all(
      months.map(async (m) => {
        const [tMap, aMap] = await this.primaryMapsForMonth(user.clientId, m, primary.code);
        const agg = aggregateTargetMet(rootSubtree, tMap, aMap, outletsByUser, passes);
        return {
          month: m,
          monthlySale: agg.achievedSum,
          targetMet: { achieved: agg.achieved, withTarget: agg.withTarget, pct: agg.pct },
        };
      }),
    );
    const byMonth = new Map(perMonth.map((p) => [p.month, p]));
    const bucketOf = (m: string) => {
      const p = byMonth.get(m)!;
      return { monthlySale: p.monthlySale, targetMet: p.targetMet };
    };

    // last3Months: monthlySale = mean of the 3 monthly sums; targetMet.pct = mean of the NON-NULL
    // monthly pcts (null when all three are null). achieved/withTarget are DELIBERATELY null here —
    // the 3-month bucket exposes ONLY the averaged ratio (per spec); a mean of counts would not
    // reconcile with the averaged pct, so there is no honest single count to show for the window.
    const avg = (ns: number[]) => (ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0);
    const nonNullPcts = perMonth
      .map((p) => p.targetMet.pct)
      .filter((v): v is number => v !== null);
    const last3Months = {
      monthlySale: Math.round(avg(perMonth.map((p) => p.monthlySale))),
      targetMet: {
        achieved: null as number | null,
        withTarget: null as number | null,
        pct: nonNullPcts.length ? Math.round(avg(nonNullPcts)) : null,
      },
    };

    return {
      ...base,
      buckets: { current: bucketOf(current), lastMonth: bucketOf(prev1), last3Months },
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
          // Exclude admin-PARKED outlets from the member-detail counts + list (same null-safe
          // OR-wrap as buildOutlets), so a parked outlet is invisible in the team drill-in too.
          where: { outletId: { not: null }, unassignedAt: null, outlet: NOT_PARKED_OUTLET },
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

    const outlets = await this.buildOutlets(memberId, user.clientId);
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

    return { outlets: await this.buildOutlets(subtreeIds, user.clientId) };
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
    // Per-tenant feature blob (DB-backed via TenantService.resolveClient — D-1), so a
    // sales-shell feature gate reads from THIS authenticated response rather than the
    // in-code CLIENT_REGISTRY. Parallel to /partner/me and /admin/settings/config.
    const features = await resolveTenantFeatures(this.tenant, user.clientId);

    return {
      employeeCode: su?.employeeCode ?? null,
      role:         su?.hierarchyLevel?.code ?? null,
      roleLabel:    su?.hierarchyLevel?.name ?? null,
      level:        su?.hierarchyLevel?.level ?? null,
      region:       su?.region ?? null,
      zone:         su?.zone ?? null,
      name:         su?.user?.name ?? user.name ?? null,
      phone:        su?.user?.phone ?? user.phone ?? null,
      features,
    };
  }

  /**
   * Outlet codes assigned to the caller AND their whole reporting downline (Q4 +
   * owner 2026-06-24: a manager's targets/achievements roll up the team). A leaf rep
   * gets just their own. Returns { all, active } (both []) when the caller is not a
   * sales user. Tenant-scoped. Shared by the dashboard (getTargets) and outlets-list
   * (getOutletTargets) reads so managers see their team's numbers, not an empty page.
   *
   * Returns BOTH sets so callers can pick the right one:
   *  • all    — every assigned outlet's code (incl. PENDING / not-interested). Used by
   *             the per-outlet DETAIL views (getOutletTargets) which must list all
   *             assigned outlets, even non-approved ones.
   *  • active — codes of outlets with `isActive === true` only (approved + active:
   *             isActive flips true only on KYC approval). Used by the KPI surfaces
   *             (getTargets hero card + trend) so the headline % excludes non-approved
   *             outlets, which now carry target/achievement rows after the sibling
   *             upload-relaxation change.
   *
   * `outletType` (optional) scopes BOTH sets to outlets of that `Outlet.outletType.code` — the
   * hook for the RLP/BSC toggle on the Target Achievement card + trend. When OMITTED (the default)
   * NO type filter is applied and the result is byte-identical to the pre-toggle behaviour, so
   * tenants that never pass a type (e.g. live Deoleo) are unchanged. The extra `outletType` select
   * is inert when no type is requested.
   */
  private async subtreeOutletCodes(
    user: JwtPayload,
    outletType?: string,
  ): Promise<{ all: string[]; active: string[] }> {
    const su = await this.prisma.salesUser.findFirst({
      where: { userId: user.sub, user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true },
    });
    if (!su) return { all: [], active: [] };
    const edges = await this.prisma.salesUser.findMany({
      where: { user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true, reportingToId: true },
    });
    const subtreeIds = [...descendantSalesUserIds(su.id, edges)];
    const assignments = await this.prisma.salesUserAssignment.findMany({
      where: { salesUserId: { in: subtreeIds }, unassignedAt: null, outletId: { not: null } },
      select: { outlet: { select: { outletCode: true, isActive: true, outletType: { select: { code: true } } } } },
    });
    // Only filter when a concrete type is requested; absent / 'ALL' → no filter (byte-identical).
    const typeF = outletType && outletType !== 'ALL' ? outletType : null;
    const all = new Set<string>();
    const active = new Set<string>();
    for (const a of assignments) {
      const code = a.outlet?.outletCode;
      if (!code) continue;
      if (typeF && a.outlet?.outletType?.code !== typeF) continue;
      all.add(code);
      if (a.outlet?.isActive) active.add(code);
    }
    return { all: [...all], active: [...active] };
  }

  /**
   * GET /v1/sales/targets — REAL target vs achievement for the caller's whole
   * DOWNLINE's outlets, summed per KPI for a month (replaces the FE OUTLET_ACHIEVEMENTS /
   * resolveConfig(DEMO_*) mock on the sales dashboard). Mirrors the partner
   * getTargets join (OutletTarget ⋈ OutletSalesRecord on clientId+outletCode+month)
   * but scopes by the rep's + downline's active outlet assignments instead of partner
   * ownership. Also returns a 6-month trend on the PRIMARY KPI for the dashboard chart.
   */
  async getTargets(user: JwtPayload, period?: string, outletType?: string) {
    // Hero-card KPI = APPROVED + ACTIVE outlets only (isActive:true). Non-approved
    // outlets now carry target/achievement rows (sibling upload-relaxation), but the
    // headline achievement % must reflect only the outlets that have actually come
    // live — so aggregate + count over the ACTIVE set, not every assigned outlet.
    // `outletType` (optional) scopes the subtree to one Outlet.outletType.code for the RLP/BSC
    // toggle; omitted → no type filter → byte-identical to today (Deoleo unchanged).
    const { active: outletCodes } = await this.subtreeOutletCodes(user, outletType);
    if (outletCodes.length === 0) return { period: null, outletCount: 0, kpis: [], trend: [] };

    // Month to report: the caller's period, else the CURRENT calendar month (owner
    // decision) — not the latest target month, which may be a future month with no
    // achievement yet (that left the card showing 0 achievement).
    const month = this.reportMonth(period);

    const whereBase = { clientId: user.clientId, outletCode: { in: outletCodes } };
    const [targetRows, achRows, kpiRows] = await Promise.all([
      this.prisma.outletTarget.findMany({ where: { ...whereBase, month }, select: { outletCode: true, targetValues: true } }),
      this.prisma.outletSalesRecord.findMany({ where: { ...whereBase, month }, select: { outletCode: true, kpiValues: true } }),
      this.prisma.kpiDef.findMany({
        where: { clientId: user.clientId },
        select: { code: true, label: true, unit: true, isPrimary: true, order: true, rollup: true, outletType: true },
      }),
    ]);

    // Per-outlet target/achieved maps — needed because the OUTLET_COUNT roll-up compares each
    // outlet's own target vs achieved, not just the tenant-wide sum.
    const targetByOutlet = new Map(targetRows.map((r) => [r.outletCode, (r.targetValues ?? {}) as Record<string, number>]));
    const achByOutlet    = new Map(achRows.map((r) => [r.outletCode, (r.kpiValues ?? {}) as Record<string, number>]));
    const allOutletCodes = new Set([...targetByOutlet.keys(), ...achByOutlet.keys()]);

    // Per-type KPI SET: when a concrete outletType is requested, the card shows only that type's KPI
    // set (shared/null KPIs + that-type KPIs) — else RLP's KPIs would render over BSC outlets. When
    // omitted / 'ALL', `kpisForOutletType` is a no-op (all KpiDefs) → Deoleo byte-identical.
    const typeF = outletType && outletType !== 'ALL' ? outletType : null;
    const scopedKpis = kpisForOutletType(kpiRows, typeF);
    const kpiMeta = new Map(scopedKpis.map((k) => [k.code, k]));
    const allowedCodes = new Set(scopedKpis.map((k) => k.code));
    const codes = new Set<string>();
    // Restrict the KPI columns to the type's set ONLY when a type filter is active; with no filter,
    // keep the prior behaviour (any code present in the data surfaces, even one with no KpiDef).
    for (const tv of targetByOutlet.values()) for (const c of kpiCodeKeys(tv)) if (!typeF || allowedCodes.has(c)) codes.add(c);
    for (const kv of achByOutlet.values()) for (const c of kpiCodeKeys(kv)) if (!typeF || allowedCodes.has(c)) codes.add(c);

    const kpis = [...codes].map((code) => {
      const meta = kpiMeta.get(code);
      const rollup = meta?.rollup === 'OUTLET_COUNT' ? 'OUTLET_COUNT' : 'SUM';
      let target = 0;
      let achieved = 0;
      if (rollup === 'OUTLET_COUNT') {
        // Denominator = outlets that have a target for this KPI; numerator = those whose
        // achieved met/exceeded it. (The card then reads "X / Y outlets · Z%".)
        for (const oc of allOutletCodes) {
          const t = Number(targetByOutlet.get(oc)?.[code]) || 0;
          if (t <= 0) continue;
          target += 1;
          if ((Number(achByOutlet.get(oc)?.[code]) || 0) >= t) achieved += 1;
        }
      } else {
        // SUM — numerically identical to the prior sum-across-outlets behavior.
        for (const oc of allOutletCodes) {
          target += Number(targetByOutlet.get(oc)?.[code]) || 0;
          achieved += Number(achByOutlet.get(oc)?.[code]) || 0;
        }
      }
      return {
        code,
        name: meta?.label ?? code,
        unit: meta?.unit ?? '',
        isPrimary: meta?.isPrimary ?? false,
        order: meta?.order ?? 0,
        rollup,
        target,
        achieved,
        pace: target > 0 ? achieved / target : null,
      };
      // Configured KpiDef.order first; isPrimary + name as tiebreakers so tenants that never
      // set an order (all 0 — e.g. Deoleo) keep the prior primary-then-name order byte-identical.
    }).sort((a, b) => a.order - b.order || Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name));

    // 6-month trend on the primary KPI (else the first KPI) for the chart — roll-up-aware so an
    // OUTLET_COUNT primary KPI trends as "outlets achieved" (consistent with the hero card and the
    // KPI/Program trend filter), not a mislabeled cumulative sum. SUM primaries are byte-identical.
    const primaryKpi = kpis.find((k) => k.isPrimary) ?? kpis[0] ?? null;
    const trend = primaryKpi
      ? await this.buildKpiTrend(user.clientId, outletCodes, month, primaryKpi.code,
          primaryKpi.rollup === 'OUTLET_COUNT' ? 'OUTLET_COUNT' : 'SUM')
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
    // DETAIL view — must list ALL assigned outlets (incl. PENDING / not-interested),
    // not just approved+active. Use the `all` code set (contrast getTargets, which
    // aggregates the hero-card KPI over the `active` set only).
    const { all: outletCodes } = await this.subtreeOutletCodes(user);
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
        select: { code: true, label: true, unit: true, isPrimary: true, order: true, rollup: true },
      }),
    ]);

    const tIdx = new Map(targetRows.map((r) => [r.outletCode, (r.targetValues ?? {}) as Record<string, number>]));
    const aIdx = new Map(achRows.map((r) => [r.outletCode, (r.kpiValues ?? {}) as Record<string, number>]));

    const kpiColumns = kpiRows
      .map((k) => ({ code: k.code, name: k.label, unit: k.unit, isPrimary: k.isPrimary, order: k.order, rollup: k.rollup }))
      // Configured order first; isPrimary + name as tiebreakers (unset order 0 → prior behavior).
      .sort((a, b) => a.order - b.order || Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name));

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

  /** The 6 month keys ending at `latestMonth` (YYYY-MM), oldest first. */
  private monthsEndingAt(latestMonth: string): string[] {
    const [y, m] = latestMonth.split('-').map(Number);
    const months: string[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(y, (m - 1) - i, 1));
      months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    return months;
  }

  /** An all-zero 6-month trend (no outlets in scope / no program match). */
  private emptyTrend(latestMonth: string) {
    return this.monthsEndingAt(latestMonth).map((month) => ({ month, target: 0, achieved: 0 }));
  }

  /**
   * Roll-up-aware 6-month trend for ONE KPI over a fixed outlet set:
   *   SUM          → sum of target/achieved across the outlets per month.
   *   OUTLET_COUNT → per month, target = # outlets with a target>0 for the KPI, achieved = # of
   *                  those whose achieved met/exceeded it ("outlets achieved" series).
   * getTargets' primary-KPI trend routes through this too; the SUM path is numerically identical
   * to the previous sum-only helper, so SUM-primary tenants are byte-identical.
   */
  private async buildKpiTrend(
    clientId: string, outletCodes: string[], latestMonth: string,
    kpiCode: string, rollup: 'SUM' | 'OUTLET_COUNT',
  ) {
    const months = this.monthsEndingAt(latestMonth);
    const where = { clientId, outletCode: { in: outletCodes }, month: { in: months } };
    const [tRows, aRows] = await Promise.all([
      this.prisma.outletTarget.findMany({ where, select: { outletCode: true, month: true, targetValues: true } }),
      this.prisma.outletSalesRecord.findMany({ where, select: { outletCode: true, month: true, kpiValues: true } }),
    ]);
    const valOf = (obj: unknown, code: string) => Number(((obj ?? {}) as Record<string, number>)[code]) || 0;

    if (rollup === 'OUTLET_COUNT') {
      return months.map((mo) => {
        const tByOutlet = new Map<string, number>();
        for (const r of tRows) {
          if (r.month !== mo) continue;
          const t = valOf(r.targetValues, kpiCode);
          if (t > 0) tByOutlet.set(r.outletCode, t);
        }
        const aByOutlet = new Map<string, number>();
        for (const r of aRows) if (r.month === mo) aByOutlet.set(r.outletCode, valOf(r.kpiValues, kpiCode));
        let target = 0;
        let achieved = 0;
        for (const [oc, t] of tByOutlet) {
          target += 1;
          if ((aByOutlet.get(oc) ?? 0) >= t) achieved += 1;
        }
        return { month: mo, target, achieved };
      });
    }

    return months.map((mo) => ({
      month: mo,
      target:   tRows.filter((r) => r.month === mo).reduce((s, r) => s + valOf(r.targetValues, kpiCode), 0),
      achieved: aRows.filter((r) => r.month === mo).reduce((s, r) => s + valOf(r.kpiValues, kpiCode), 0),
    }));
  }

  /**
   * GET /v1/sales/target-trend?kpi=&program=&outlet= — the "Target vs. Achievement" chart
   * series for a chosen KPI (default = primary).
   *   • No `outlet`  → dashboard view: the caller's ACTIVE subtree outlets, optionally restricted
   *     to a `program`, ROLL-UP aware (OUTLET_COUNT → # outlets that met target per month).
   *   • With `outlet` → outlet-detail view: a SINGLE outlet's RAW monthly target vs achieved
   *     (always SUM — a one-outlet "0/1" count is meaningless and must match the detail card's
   *     raw cells); `program` is ignored, and the outlet must be within the caller's reach.
   * `outletType` (optional) scopes the DASHBOARD (aggregate) view to one Outlet.outletType.code for
   * the RLP/BSC toggle; it is IGNORED in the single-outlet view (like `program`). Omitted → no type
   * filter → byte-identical to today (Deoleo unchanged). Tenant-scoped.
   */
  async getTargetTrend(
    user: JwtPayload,
    kpi?: string,
    program?: string,
    outlet?: string,
    outletType?: string,
  ) {
    const month = this.reportMonth();
    const kpiRows = await this.prisma.kpiDef.findMany({
      where: { clientId: user.clientId },
      select: { code: true, label: true, unit: true, isPrimary: true, order: true, rollup: true, outletType: true },
    });
    // A single-outlet view is a RAW per-outlet series → force SUM (and ignore program + outletType).
    const singleOutlet = !!outlet;
    // Per-type KPI SET for the DASHBOARD view: trend only a KPI from the requested type's set (shared
    // + that-type KPIs). Single-outlet ignores the toggle; omitted/'ALL' → all KpiDefs (byte-identical).
    const typeF = !singleOutlet && outletType && outletType !== 'ALL' ? outletType : null;
    const scopedKpis = kpisForOutletType(kpiRows, typeF);
    const byCode = new Map(scopedKpis.map((k) => [k.code, k]));
    // Default KPI = primary, else the first by configured order — same basis as getTargets.
    const ordered = [...scopedKpis].sort(
      (a, b) => a.order - b.order || Number(b.isPrimary) - Number(a.isPrimary) || a.label.localeCompare(b.label),
    );
    const meta = (kpi && byCode.get(kpi)) || ordered.find((k) => k.isPrimary) || ordered[0] || null;
    const rollup: 'SUM' | 'OUTLET_COUNT' =
      singleOutlet ? 'SUM' : meta?.rollup === 'OUTLET_COUNT' ? 'OUTLET_COUNT' : 'SUM';
    const base = { kpiCode: meta?.code ?? null, kpiName: meta?.label ?? null, unit: meta?.unit ?? '', rollup };

    if (!meta) return { ...base, trend: this.emptyTrend(month) };
    // Apply the outletType filter to the aggregate (dashboard) scope only; a single-outlet view
    // authorizes against the FULL subtree, so leave it unfiltered there (byte-identical to today).
    const { all, active } = await this.subtreeOutletCodes(user, singleOutlet ? undefined : outletType);

    let outletCodes: string[];
    if (singleOutlet) {
      // Authorize a single outlet against the caller's FULL assigned subtree (incl. pending /
      // non-approved outlets). The detail-page Target Achievement card shows targets for those
      // outlets too (it reads the all-scope outlet-targets), so the trend beneath it must use the
      // SAME scope — else an under-review outlet shows an empty trend under a card of real numbers.
      if (!all.includes(outlet!)) return { ...base, trend: this.emptyTrend(month) };
      outletCodes = [outlet!];
    } else {
      // Aggregate (dashboard): approved + active outlets only — matches the hero card.
      if (active.length === 0) return { ...base, trend: this.emptyTrend(month) };
      outletCodes = active;
      if (program) {
        // Restrict to a program when one is named (empty match → all-zero trend).
        const outlets = await this.prisma.outlet.findMany({
          where: { clientId: user.clientId, outletCode: { in: active }, programName: program, deletedAt: null },
          select: { outletCode: true },
        });
        outletCodes = outlets.map((o) => o.outletCode);
        if (outletCodes.length === 0) return { ...base, trend: this.emptyTrend(month) };
      }
    }

    const trend = await this.buildKpiTrend(user.clientId, outletCodes, month, meta.code, rollup);
    return { ...base, trend };
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
    // KPI ranking counts APPROVED + ACTIVE outlets only (outlet.isActive:true —
    // flips true on KYC approval). Non-approved outlets now carry target/achievement
    // rows (sibling upload-relaxation), but the leaderboard's achievementPct / rank /
    // activeOutlets must exclude them, so DROP non-active outlets from the per-user
    // code map that feeds sumSubtree / pctFor / subtreeOutletCount.
    const assignments = await this.prisma.salesUserAssignment.findMany({
      where: {
        salesUserId: { in: allUsers.map((u) => u.id) },
        unassignedAt: null,
        outletId: { not: null },
      },
      select: { salesUserId: true, outlet: { select: { outletCode: true, isActive: true } } },
    });
    const outletCodesByUser = new Map<string, string[]>();
    for (const a of assignments) {
      const code = a.outlet?.outletCode;
      if (!code) continue;
      if (!a.outlet?.isActive) continue; // KPI set = approved+active only
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
   * Overview counterpart of primaryMapsForMonth: for one month, returns a
   * code → [targetByOutletCode, achievedByOutletCode] map for EVERY requested KPI
   * code, tenant-scoped, in a single target/achievement query pair. Same per-code
   * accumulation semantics as primaryMapsForMonth (kpiCodeKeys filters the reserved
   * __names key; sum each code per outletCode). Returns a map with an empty pair for
   * each code (and skips the query entirely) when no codes are requested.
   */
  private async allKpiMapsForMonth(
    clientId: string,
    month: string,
    codes: string[],
  ): Promise<Map<string, [Map<string, number>, Map<string, number>]>> {
    const result = new Map<string, [Map<string, number>, Map<string, number>]>();
    for (const c of codes) result.set(c, [new Map(), new Map()]);
    if (codes.length === 0) return result;

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

    const codeSet = new Set(codes);
    const accumulateInto = (rows: { outletCode: string; v: unknown }[], slot: 0 | 1) => {
      for (const r of rows) {
        const obj = (r.v ?? {}) as Record<string, number>;
        for (const key of kpiCodeKeys(obj)) {
          if (!codeSet.has(key)) continue;
          const m = result.get(key)![slot];
          m.set(r.outletCode, (m.get(r.outletCode) ?? 0) + (Number(obj[key]) || 0));
        }
      }
    };
    accumulateInto(targetRows.map((r) => ({ outletCode: r.outletCode, v: r.targetValues })), 0);
    accumulateInto(achRows.map((r) => ({ outletCode: r.outletCode, v: r.kpiValues })), 1);
    return result;
  }

  /**
   * Shared outlet projection for a sales user's active outlet assignments.
   * Ported from the source's buildOutlets() (sales/outlets) and the inline copy
   * in sales/team/[memberId]/outlets — single consistent shape across both.
   *
   * Target/TargetAchievement are dropped, so the partner-target read and the
   * achievement-derived targetPct are removed; targetPct is reported as 0.
   */
  private async buildOutlets(salesUserId: string | string[], clientId: string) {
    const ids = Array.isArray(salesUserId) ? salesUserId : [salesUserId];
    const assignments = await this.prisma.salesUserAssignment.findMany({
      where: {
        salesUserId: { in: ids },
        outletId: { not: null },
        unassignedAt: null,
        // FULLY hide admin-PARKED outlets from the rep (list, counts, dashboard). Null-safe
        // OR-wrap keeps normal + NOT_INTERESTED outlets; drops only PARKED.
        outlet: NOT_PARKED_OUTLET,
      },
      include: {
        // The assigned rep's login-User id — lets the FE KYC-list member filter match
        // a NOT-STARTED / not-interested outlet (which has no submission, so no submitter)
        // to the rep it belongs to, so "filter by member" returns ALL their outlets.
        salesUser: { select: { userId: true } },
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

    // An outlet uploaded via the master file has NO owner/partner until KYC.
    // INCLUDE those — a sales rep must see the outlets they're assigned that
    // still need NEW enrollment/KYC. (Previously these were filtered out, so a
    // rep whose assigned outlets were all un-KYC'd saw an EMPTY list and could
    // not start enrollment.) Partner-derived fields are null/0 for partner-less
    // outlets; sales-assisted redeem (B1) is gated on an APPROVED partner FE-side.
    const filtered = assignments.filter((a) => a.outlet !== null);

    // Resolve each group's canonical identity + PAN once (dedupe by parentId). A grouped child's
    // KYC pre-fills the shared owner-identity (business/owner name, GST, bank, UPI — EDITABLE) and
    // LOCKS its PAN to the group PAN. Source (resolveGroupIdentity) = the APPROVED parent's own
    // details, else the most-recently-APPROVED grouped SIBLING — so the first child establishes the
    // shared identity and the rest inherit it. Photos/address/location are NEVER inherited (captured
    // per store). A group with nothing verified yet → no pre-fill (the child enters its own details).
    const groupParentIds = [
      ...new Set(filtered.filter((a) => a.outlet!.parentId).map((a) => a.outlet!.parentId!)),
    ];
    // Also resolve, once per group, whether the group SOURCE has an approved GST certificate /
    // cancelled cheque available to carry forward (resolveGroupCarryForwardDocs, same
    // sourcePartnerId as the identity). The FE surfaces these booleans so a child that keeps the
    // group's UNCHANGED GST/bank can skip re-uploading (the backend authoritatively attaches the
    // inherited doc). Batched into this per-group map → one resolve per group, not per outlet.
    const groupInfoByParent = new Map<
      string,
      { identity: GroupIdentity; groupPan: string | null; gstCertInheritable: boolean; chequeInheritable: boolean } | null
    >(
      await Promise.all(
        groupParentIds.map(async (pid) => {
          const identity = await resolveGroupIdentity(this.prisma, clientId, pid);
          if (!identity) return [pid, null] as const;
          const groupPan = await resolveGroupPan(this.prisma, clientId, pid);
          // Only source docs when we have an approved source partner (else both false).
          const carryDocs = identity.sourcePartnerId
            ? await resolveGroupCarryForwardDocs(this.prisma, clientId, identity.sourcePartnerId)
            : { gstCertificate: null, cancelledCheque: null };
          return [
            pid,
            {
              identity,
              groupPan,
              gstCertInheritable: !!carryDocs.gstCertificate,
              chequeInheritable: !!carryDocs.cancelledCheque,
            },
          ] as const;
        }),
      ),
    );

    return (
      filtered
        .map((a) => {
          const outlet = a.outlet!;
          const partner = outlet.partner; // null until the outlet is KYC'd
          const latestKyc = partner?.kycSubmissions[0] ?? null;
          // Re-entry statuses: the rep re-opens the SAME outlet's KYC wizard
          // pre-filled. Only build existingKyc for these (else null). DRAFT = an
          // un-confirmed KYC (saved at submit, awaiting the outlet-owner OTP) — the rep
          // re-opens it pre-filled to re-send the OTP + submit (or edit first).
          const RE_ENTRY = ['DRAFT', 'REJECTED', 'RE_UPLOAD_REQUIRED', 'RESUBMISSION_REQUIRED', 'RE_KYC_REQUIRED'];
          // An admin re-KYC upload sets Outlet.reKycFlags WITHOUT flipping the (APPROVED)
          // submission status, so re-entry must also trigger on pending re-KYC flags —
          // else the rep can't re-open the pre-filled wizard for a re-KYC'd outlet.
          // Re-KYC is "actionable" (rep re-opens the wizard / shows RE_KYC_REQUIRED) only
          // when the admin flags are set AND no fresh submission is under review — else a
          // just-resubmitted outlet (flags still set, new submission routed) would wrongly
          // read as Re-KYC Required instead of Under Review.
          const reKycActionable = isReKycActionable(outlet.reKycFlags, latestKyc?.status);
          const isReEntry = reKycActionable || (!!latestKyc && RE_ENTRY.includes(latestKyc.status));
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

          // Owner-group PRE-FILL: when this child outlet's group has a canonical identity (the
          // approved parent's own details, else an approved grouped sibling — resolveGroupIdentity),
          // the KYC form pre-fills the shared owner-identity/payout values (EDITABLE) and LOCKS the
          // child PAN to the group's canonical PAN (`groupPan`). Omitted (undefined) when the outlet
          // is ungrouped or the group has nothing verified yet. Photos, address and location are
          // NEVER inherited — each store captures its own (the FE resets them per outlet change).
          const groupInfo = outlet.parentId ? groupInfoByParent.get(outlet.parentId) ?? null : null;
          const parentPrefill = groupInfo
            ? {
                businessName: groupInfo.identity.businessName ?? '',
                ownerName: groupInfo.identity.ownerName ?? '',
                gstNumber: groupInfo.identity.gstNumber ?? '',
                bankName: groupInfo.identity.bankName ?? '',
                bankAccountNumber: groupInfo.identity.bankAccountNumber ?? '',
                bankAccountHolder: groupInfo.identity.bankAccountHolder ?? '',
                ifscCode: groupInfo.identity.ifscCode ?? '',
                upiId: groupInfo.identity.upiId ?? '',
                // PAN = the authoritative group PAN (what the child's PAN is locked to + the backend
                // enforces via checkPanMatchesGroup). Aligning the displayed PAN with the lock avoids a
                // self-contradictory payload when the identity source carries no PAN but a sibling does.
                panNumber: groupInfo.groupPan ?? groupInfo.identity.panNumber ?? '',
                // The value the child PAN must equal (parent's PAN, else a grouped sibling's).
                groupPan: groupInfo.groupPan,
                // Whether the group source has an approved GST cert / cancelled cheque the child can
                // INHERIT when it keeps the group's UNCHANGED GST / bank (the FE compares the current
                // form values to the prefill above to decide "unchanged" and hides the upload).
                gstCertInheritable: groupInfo.gstCertInheritable,
                chequeInheritable: groupInfo.chequeInheritable,
              }
            : undefined;

          return {
            id: outlet.id,
            // The owner-group key (Outlet.parentId) — null when ungrouped. The KYC form uses it to
            // make the client-side phone-conflict check GROUP-AWARE: a phone shared with a SAME-GROUP
            // sibling must NOT be flagged as a conflict (a group shares one owner phone / one login),
            // exactly as the backend assertPhoneAvailable already allows. Without it the FE re-flagged
            // the shared owner phone and hard-disabled the wizard for every 2nd+ outlet in a group.
            parentId: outlet.parentId ?? null,
            partnerId: partner?.id ?? null,
            // The rep this outlet is assigned to (login-User id) — the KYC-list member
            // filter keys on this for outlets with no submission yet.
            assignedUserId: a.salesUser?.userId ?? null,
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
            // Distributor (from the outlet master) — surfaced so the SO Declaration wizard's
            // on-screen declaration preview matches the saved PDF (both fill distributor from master).
            distributorName: outlet.distributorName ?? '',
            distributorCode: outlet.distributorCode ?? '',
            // Re-KYC (admin-flagged fields to re-capture) takes priority — mirror the
            // admin deriveKycStatus so a re-KYC'd outlet reads RE_KYC_REQUIRED (under the
            // rep's Re-KYC filter/tasks), not Approved — UNLESS a fresh resubmission is now
            // under review, in which case the in-flight status shows through (reKycActionable).
            kycStatus: reKycActionable
              ? 'RE_KYC_REQUIRED'
              : outlet.kycIntent === 'NOT_INTERESTED'
                ? 'NOT_INTERESTED'
                : (latestKyc?.status ?? 'NOT_STARTED'),
            kycSubmittedAt: latestKyc?.createdAt ? istDateKey(latestKyc.createdAt) : undefined,
            kycRejectionReason: latestKyc?.rejectionReason ?? null,
            reKycFlags: outlet.reKycFlags ?? null,
            // Per-outlet payout MANDATE (BANK|UPI|ANY) — the KYC wizard reads this to pin/lock
            // the paymentMode toggle + required fields. Default BANK; UPI only if tenant upiEnabled.
            requiredPaymentType: outlet.requiredPaymentType,
            existingKyc,
            // Owner-group pre-fill (approved parent only) — undefined when ungrouped/unapproved.
            parentPrefill,
            targetPct: 0,
          };
        })
    );
  }
}
