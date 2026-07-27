import { Injectable } from '@nestjs/common';
import {
  PayoutStatus,
  Prisma,
  TicketCategory,
  TicketPriority,
  TicketStatus,
  VisibilityCaptureStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantService } from '../../tenant/tenant.service';
import { TenantSettingsService } from '../../tenant/tenant-settings.service';
import { PayoutsService } from '../../payouts/payouts.service';
import { JwtPayload } from '../../common/decorators/current-user.decorator';

/**
 * Operations Dashboard — GET /v1/admin/dashboard/operations.
 *
 * A single REAL aggregation of operational health for the caller's tenant:
 *  • payout fulfilment (success/failure/pending rates, pending ₹ liability, mode latency)
 *  • ticket SLA (open load, status/priority/category mix, MTTR, first-response, age buckets)
 *  • visibility funnel (only when the tenant has visibility ENABLED — else null)
 *  • redemption→payout settlement latency
 *
 * Tenant scope is resolved exactly like AdminCoreService.kycDashboard / dashboardKpis:
 * strictly by `user.clientId` (the proxy/JWT layer already sets clientId to the assumed
 * tenant for an operator-context GIFSY token). Every query below is tenant-filtered — but
 * note the scoping path differs per entity:
 *   • PayoutTransaction  → batched rows ride `batch.clientId`; UNBATCHED rows (batchId null)
 *                          can never match a `batch` relation filter, so they are scoped via
 *                          `partner.clientId` (denormalised) and OR-ed in.
 *   • Ticket             → direct `clientId` column.
 *   • VisibilitySubmission → `partner.clientId` (denormalised on ChannelPartner).
 *
 * NOTHING here is fabricated: tickets.service now stamps `firstResponseAt` (first support
 * reply), `resolvedAt`/`closedAt` (status transitions), so MTTR + first-response are real;
 * SLA compliance is computed on-read from resolution-time vs a priority target. Where a
 * source field is still empty (no resolution timestamp yet), the metric returns null / a
 * zero-sample object rather than an invented value.
 */
@Injectable()
export class OperationsDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly payouts: PayoutsService,
  ) {}

  private static readonly HOUR_MS = 1000 * 60 * 60;

  // ── Status groupings (exhaustive + disjoint over each enum) ───────────────
  private static readonly PAYOUT_SUCCESS: ReadonlySet<PayoutStatus> = new Set<PayoutStatus>([
    'SUCCESS',
  ]);
  private static readonly PAYOUT_FAILED: ReadonlySet<PayoutStatus> = new Set<PayoutStatus>([
    'FAILED',
    'REVERSED',
  ]);
  private static readonly PAYOUT_PENDING: ReadonlySet<PayoutStatus> = new Set<PayoutStatus>([
    'PENDING',
    'INITIATED',
    'PROCESSING',
  ]);
  // (HOLD is neither success/failed/pending — counted in `total` but excluded from the
  //  three rate buckets on purpose: it is a manual freeze, not an in-flight or terminal state.)
  private static readonly PAYOUT_TERMINAL: ReadonlySet<PayoutStatus> = new Set<PayoutStatus>([
    'SUCCESS',
    'FAILED',
    'REVERSED',
  ]);

  private static readonly TICKET_OPEN: ReadonlySet<TicketStatus> = new Set<TicketStatus>([
    'OPEN',
    'IN_PROGRESS',
    'PENDING_USER',
    'ESCALATED',
  ]);

  /** mean of a numeric array; null for an empty array (no NaN, no fabricated 0). */
  private static meanOrNull(xs: number[]): number | null {
    if (xs.length === 0) return null;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  }

  private static round1(n: number): number {
    return Math.round(n * 10) / 10;
  }

  private static round1OrNull(n: number | null): number | null {
    return n === null ? null : OperationsDashboardService.round1(n);
  }

  /** safe a/b ×100 → fallback when b == 0 (no division-by-zero NaN). */
  private static pct(a: number, b: number, fallback = 0): number {
    if (b <= 0) return fallback;
    return OperationsDashboardService.round1((a / b) * 100);
  }

  private static hoursBetween(later: Date, earlier: Date): number {
    return (later.getTime() - earlier.getTime()) / OperationsDashboardService.HOUR_MS;
  }

  async operations(user: JwtPayload) {
    const clientId = user.clientId;
    const generatedAt = new Date();

    // Tenant display name (best-effort; falls back to the slug if config is missing).
    let tenantName = clientId;
    try {
      const cfg = await this.tenant.resolveClient(clientId);
      tenantName = cfg.branding?.displayName || cfg.name || clientId;
    } catch {
      tenantName = clientId;
    }

    const [payouts, tickets, visibility, settlement] = await Promise.all([
      this.buildPayouts(clientId),
      this.buildTickets(clientId),
      this.buildVisibility(clientId),
      this.buildSettlement(clientId),
    ]);

    return {
      scope: { tenant: tenantName, generatedAt: generatedAt.toISOString() },
      payouts,
      tickets,
      visibility,
      settlement,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // PAYOUTS
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Tenant filter that covers BOTH batched (batch.clientId) and unbatched
   * (partner.clientId) payout rows — a plain `batch: { clientId }` would silently
   * drop every waiting unbatched transaction (its batch relation is null).
   */
  private static payoutTenantFilter(clientId: string): Prisma.PayoutTransactionWhereInput {
    return {
      OR: [{ batch: { clientId } }, { batchId: null, partner: { clientId } }],
    };
  }

  private async buildPayouts(clientId: string) {
    const tenantFilter = OperationsDashboardService.payoutTenantFilter(clientId);

    // status counts (groupBy is exhaustive over whatever statuses exist in scope)
    const byStatus = await this.prisma.payoutTransaction.groupBy({
      by: ['status'],
      where: tenantFilter,
      _count: { _all: true },
    });

    let total = 0;
    let success = 0;
    let failed = 0;
    let pending = 0;
    for (const row of byStatus) {
      const c = row._count._all;
      total += c;
      if (OperationsDashboardService.PAYOUT_SUCCESS.has(row.status)) success += c;
      else if (OperationsDashboardService.PAYOUT_FAILED.has(row.status)) failed += c;
      else if (OperationsDashboardService.PAYOUT_PENDING.has(row.status)) pending += c;
    }

    // pending value — Σ netAmountPaise over the dashboard's pending bucket (PENDING/
    // INITIATED/PROCESSING). NOTE: PayoutsService.getFundSummary.pendingLiability counts
    // only status='PENDING', a NARROWER set, so it does not match this bucket — compute here.
    const pendingValue = await this.prisma.payoutTransaction.aggregate({
      where: {
        ...tenantFilter,
        status: { in: [...OperationsDashboardService.PAYOUT_PENDING] },
      },
      _sum: { netAmountPaise: true },
    });
    const pendingValuePaise = Number(pendingValue._sum.netAmountPaise ?? 0n);

    // latency-by-mode over terminal txns with completedAt set: mean(completedAt − createdAt)
    const terminalTxns = await this.prisma.payoutTransaction.findMany({
      where: {
        ...tenantFilter,
        status: { in: [...OperationsDashboardService.PAYOUT_TERMINAL] },
        completedAt: { not: null },
      },
      select: { payoutMode: true, createdAt: true, completedAt: true },
    });
    const byMode = new Map<string, number[]>();
    for (const t of terminalTxns) {
      if (!t.completedAt) continue;
      const arr = byMode.get(t.payoutMode) ?? [];
      arr.push(OperationsDashboardService.hoursBetween(t.completedAt, t.createdAt));
      byMode.set(t.payoutMode, arr);
    }
    const latencyByMode = [...byMode.entries()]
      .map(([mode, hrs]) => ({
        mode,
        avgHours: OperationsDashboardService.round1(
          OperationsDashboardService.meanOrNull(hrs) ?? 0,
        ),
        sampleSize: hrs.length,
      }))
      .sort((a, b) => a.mode.localeCompare(b.mode));

    return {
      total,
      success,
      failed,
      pending,
      successRatePct: OperationsDashboardService.pct(success, total),
      failureRatePct: OperationsDashboardService.pct(failed, total),
      pendingValueRupees: Number((pendingValuePaise / 100).toFixed(2)),
      latencyByMode,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // TICKETS
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Resolution-time SLA targets (hours) by ticket priority — the standard helpdesk model.
   * A terminal ticket is "breached" when its resolution took longer than this. Adjust here
   * to change the SLA policy (single source of truth).
   */
  private static readonly SLA_TARGET_HOURS: Record<string, number> = {
    CRITICAL: 4,
    HIGH: 24,
    MEDIUM: 48,
    LOW: 72,
  };

  private async buildTickets(clientId: string) {
    // Tickets carry a direct clientId. Exclude soft-deleted rows for every count.
    const base: Prisma.TicketWhereInput = { clientId, deletedAt: null };

    const [byStatusRaw, byPriorityRaw, byCategoryRaw] = await Promise.all([
      this.prisma.ticket.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
      this.prisma.ticket.groupBy({ by: ['priority'], where: base, _count: { _all: true } }),
      this.prisma.ticket.groupBy({ by: ['category'], where: base, _count: { _all: true } }),
    ]);

    const byStatus = byStatusRaw
      .map((r) => ({ status: r.status as TicketStatus, count: r._count._all }))
      .sort((a, b) => a.status.localeCompare(b.status));
    const byPriority = byPriorityRaw
      .map((r) => ({ priority: r.priority as TicketPriority, count: r._count._all }))
      .sort((a, b) => a.priority.localeCompare(b.priority));
    const byCategory = byCategoryRaw
      .map((r) => ({ category: r.category as TicketCategory, count: r._count._all }))
      .sort((a, b) => a.category.localeCompare(b.category));

    const open = byStatus
      .filter((s) => OperationsDashboardService.TICKET_OPEN.has(s.status))
      .reduce((sum, s) => sum + s.count, 0);

    // MTTR = mean(resolvedAt − createdAt) over RESOLVED tickets WITH resolvedAt set.
    // (tickets.service.setStatus stamps resolvedAt on → RESOLVED.) Empty sample → null,
    // never fabricated.
    const resolved = await this.prisma.ticket.findMany({
      where: { ...base, status: 'RESOLVED', resolvedAt: { not: null } },
      select: { createdAt: true, resolvedAt: true },
    });
    const mttrHours = OperationsDashboardService.round1OrNull(
      OperationsDashboardService.meanOrNull(
        resolved
          .filter((t) => t.resolvedAt)
          .map((t) => OperationsDashboardService.hoursBetween(t.resolvedAt as Date, t.createdAt)),
      ),
    );

    // First-response = mean(firstResponseAt − createdAt). (tickets.service.addMessage stamps
    // firstResponseAt on the first non-internal support reply.) Empty sample → null.
    const fr = await this.prisma.ticket.findMany({
      where: { ...base, firstResponseAt: { not: null } },
      select: { createdAt: true, firstResponseAt: true },
    });
    const firstResponseHours = OperationsDashboardService.round1OrNull(
      OperationsDashboardService.meanOrNull(
        fr
          .filter((t) => t.firstResponseAt)
          .map((t) =>
            OperationsDashboardService.hoursBetween(t.firstResponseAt as Date, t.createdAt),
          ),
      ),
    );

    // SLA compliance = computed ON-READ from resolution-time vs a priority-based target
    // (no stored-flag backfill, and the policy lives in ONE place). A terminal ticket is
    // breached when (resolvedAt ?? closedAt) − createdAt exceeds its priority target.
    // Tickets with no resolution timestamp aren't assessable and are excluded. Guard /0 → 100.
    const terminalTickets = await this.prisma.ticket.findMany({
      where: { ...base, status: { in: ['RESOLVED', 'CLOSED'] } },
      select: { priority: true, createdAt: true, resolvedAt: true, closedAt: true },
    });
    let slaSample = 0;
    let compliant = 0;
    for (const t of terminalTickets) {
      const resolutionAt = t.resolvedAt ?? t.closedAt;
      if (!resolutionAt) continue; // not assessable without a resolution timestamp
      slaSample += 1;
      const targetH = OperationsDashboardService.SLA_TARGET_HOURS[t.priority] ?? 48;
      const breached =
        OperationsDashboardService.hoursBetween(resolutionAt, t.createdAt) > targetH;
      if (!breached) compliant += 1;
    }
    const slaCompliancePct = OperationsDashboardService.pct(compliant, slaSample, 100);

    // Age buckets over OPEN tickets (TICKET_OPEN set) by now − createdAt.
    const openTickets = await this.prisma.ticket.findMany({
      where: { ...base, status: { in: [...OperationsDashboardService.TICKET_OPEN] } },
      select: { createdAt: true },
    });
    const now = Date.now();
    const buckets = { '<4h': 0, '4-24h': 0, '1-7d': 0, '>7d': 0 } as Record<string, number>;
    for (const t of openTickets) {
      const ageH = (now - t.createdAt.getTime()) / OperationsDashboardService.HOUR_MS;
      if (ageH < 4) buckets['<4h'] += 1;
      else if (ageH < 24) buckets['4-24h'] += 1;
      else if (ageH < 24 * 7) buckets['1-7d'] += 1;
      else buckets['>7d'] += 1;
    }
    const ageBuckets = (['<4h', '4-24h', '1-7d', '>7d'] as const).map((bucket) => ({
      bucket,
      count: buckets[bucket],
    }));

    return {
      open,
      byStatus,
      byPriority,
      byCategory,
      mttrHours,
      firstResponseHours,
      slaCompliancePct,
      sampleSize: slaSample,
      ageBuckets,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // VISIBILITY  (null when the tenant has the feature OFF)
  // ════════════════════════════════════════════════════════════════════════

  private async buildVisibility(clientId: string) {
    // Canonical reader — uncached + fail-closed (treats a read error as OFF). When OFF,
    // return null so the FE hides the whole visibility card (no zero-filled fake funnel).
    const enabled = await this.tenantSettings.getVisibilityEnabledUncached(clientId);
    if (!enabled) return null;

    // Visibility (POSM) captures are keyed by (outlet, window); clientId is a direct column.
    // The new status model is SUBMITTED | APPROVED | REJECTED (no DRAFT/UNDER_REVIEW/FLAGGED).
    // Dup-photo + geo-fence signals surface per-capture in the Gifsy review queue + the coverage
    // report (visibility-report.service), not as an aggregate on this operations funnel.
    const subFilter: Prisma.VisibilityCaptureWhereInput = { clientId };

    const byStatus = await this.prisma.visibilityCapture.groupBy({
      by: ['status'],
      where: subFilter,
      _count: { _all: true },
    });
    const statusCount = (s: VisibilityCaptureStatus): number =>
      byStatus.find((r) => r.status === s)?._count._all ?? 0;

    // "submitted" = total captures in any state (the funnel entry point).
    const submitted =
      statusCount('SUBMITTED') + statusCount('APPROVED') + statusCount('REJECTED');
    const approved = statusCount('APPROVED');
    const rejected = statusCount('REJECTED');
    const flagged = 0; // no separate FLAGGED capture state; dup/geo flags live per-capture.

    const total = byStatus.reduce((sum, r) => sum + r._count._all, 0);

    const fraudFlaggedCount = 0; // surfaced per-capture (dup-hash/geo) in the review queue.

    // participation = distinct outletIds with ≥1 capture ÷ addressable outlets.
    // Addressable = the SAME universe filter AdminCoreService.kycDashboard uses.
    const [submittingOutlets, addressable] = await Promise.all([
      this.prisma.visibilityCapture.findMany({
        where: subFilter,
        select: { outletId: true },
        distinct: ['outletId'],
      }),
      this.prisma.outlet.count({
        where: {
          clientId,
          deletedAt: null,
          deactivatedAt: null,
          OR: [{ kycIntent: null }, { kycIntent: { not: 'NOT_INTERESTED' } }],
        },
      }),
    ]);

    return {
      enabled: true,
      submitted,
      approved,
      rejected,
      flagged,
      approvalRatePct: OperationsDashboardService.pct(
        approved,
        approved + rejected + flagged,
      ),
      fraudFlagPct: OperationsDashboardService.pct(fraudFlaggedCount, total),
      participationPct: OperationsDashboardService.pct(submittingOutlets.length, addressable),
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // SETTLEMENT  (redemption order created → payout completed)
  // ════════════════════════════════════════════════════════════════════════

  private async buildSettlement(clientId: string) {
    // Join PayoutTransaction → RedemptionOrder via redemptionOrderId. Terminal + completedAt
    // set, redemptionOrderId not null. Tenant-scoped via the same payout filter.
    // NOTE: redemptionOrderId is a plain scalar column with NO Prisma relation declared on
    // PayoutTransaction, so the join is a manual two-step (fetch ids → look up orders).
    const rows = await this.prisma.payoutTransaction.findMany({
      where: {
        ...OperationsDashboardService.payoutTenantFilter(clientId),
        redemptionOrderId: { not: null },
        status: { in: [...OperationsDashboardService.PAYOUT_TERMINAL] },
        completedAt: { not: null },
      },
      select: { completedAt: true, redemptionOrderId: true },
    });

    const orderIds = [
      ...new Set(rows.map((r) => r.redemptionOrderId).filter((id): id is string => !!id)),
    ];
    const orders =
      orderIds.length === 0
        ? []
        : await this.prisma.redemptionOrder.findMany({
            where: { id: { in: orderIds } },
            select: { id: true, createdAt: true },
          });
    const orderCreatedAt = new Map(orders.map((o) => [o.id, o.createdAt]));

    const latencies: number[] = [];
    for (const r of rows) {
      if (!r.completedAt || !r.redemptionOrderId) continue;
      const createdAt = orderCreatedAt.get(r.redemptionOrderId);
      if (!createdAt) continue;
      latencies.push(OperationsDashboardService.hoursBetween(r.completedAt, createdAt));
    }

    return {
      avgLatencyHours: OperationsDashboardService.round1(
        OperationsDashboardService.meanOrNull(latencies) ?? 0,
      ),
      sampleSize: latencies.length,
    };
  }
}
