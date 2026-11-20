/**
 * GET /v1/reports/redemptions — the cheap on-screen summary for the Reports hub card: orders · points DEDUCTED · ₹ of
 * the points deducted (the same rule and WHERE as the Excel's rows / Summary sheet), points requested, per-status
 * counts, whether the download will be prepared in the background, the client's Zone / State values for the pickers,
 * and the client's ASM-level label (for an honest card description). A fixed handful of queries, no per-row work.
 */
import type { RedemptionStatus } from '@prisma/client';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RedemptionReportQueryDto } from '../dto/redemption-report.dto';
import {
  REDEMPTION_LIGHT_MAX_DAYS,
  REDEMPTION_LIGHT_MAX_ROWS,
  assertRedemptionClientKnown,
  rangeDays,
  resolveRedemptionParams,
  resolveRedemptionWhere,
} from './redemption-report.query';
import { STATUS_LABEL, levelHeader } from './redemption-report.rows';

export interface RedemptionScreenSummary {
  clientId: string;
  from: string;
  to: string;
  orders: number;
  /** Σ pointsDeducted — what actually left wallets (= the Excel's "Points deducted" total). */
  pointsDeducted: number;
  /** Σ value of orders that took points (= the Excel's "Value (₹)" total). */
  valueInr: number;
  /** Σ totalPointsCost — includes orders that never took points. */
  pointsRequested: number;
  /** true → the Excel will be prepared in the background (Downloads page). */
  preparedInBackground: boolean;
  byStatus: Array<{ status: RedemptionStatus; label: string; orders: number; pointsDeducted: number }>;
  zones: string[];
  states: string[];
  /** The client's ASM-level header (the Summary sheet's "By <label>" section), or null when it has no such level. */
  asmLevelLabel: string | null;
}

type Db = Pick<PrismaService, 'redemptionOrder' | 'outlet' | 'client' | 'salesHierarchyLevel'>;

/** Count of matching orders (the controller's "queue big files" decision). */
export async function redemptionOrderCount(prisma: Db, user: JwtPayload, q: RedemptionReportQueryDto, now: Date): Promise<number> {
  const p = resolveRedemptionParams(q, user, now);
  await assertRedemptionClientKnown(prisma, user, p.clientId);
  return prisma.redemptionOrder.count({ where: await resolveRedemptionWhere(prisma, p) });
}

export async function redemptionScreenSummary(
  prisma: Db,
  user: JwtPayload,
  q: RedemptionReportQueryDto,
  now: Date,
): Promise<RedemptionScreenSummary> {
  const p = resolveRedemptionParams(q, user, now);
  await assertRedemptionClientKnown(prisma, user, p.clientId);
  const where = await resolveRedemptionWhere(prisma, p);
  const [groups, valueAgg, zones, states, levels] = await Promise.all([
    prisma.redemptionOrder.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
      _sum: { pointsDeducted: true, totalPointsCost: true },
    }),
    // Value only where points were deducted — the row rule (rowValuePaise).
    prisma.redemptionOrder.aggregate({ where: { ...where, pointsDeducted: { gt: 0 } }, _sum: { valuePaise: true } }),
    prisma.outlet.findMany({
      where: { clientId: p.clientId, deletedAt: null, zone: { not: null } },
      distinct: ['zone'],
      orderBy: { zone: 'asc' },
      select: { zone: true },
    }),
    prisma.outlet.findMany({
      where: { clientId: p.clientId, deletedAt: null },
      distinct: ['state'],
      orderBy: { state: 'asc' },
      select: { state: true },
    }),
    prisma.salesHierarchyLevel.findMany({
      where: { clientId: p.clientId, level: { gte: 0 } },
      orderBy: { level: 'asc' },
      select: { id: true, code: true, name: true, level: true },
    }),
  ]);
  const byStatus = (Object.keys(STATUS_LABEL) as RedemptionStatus[])
    .map((status) => {
      const g = groups.find((x) => x.status === status);
      return { status, label: STATUS_LABEL[status], orders: g?._count._all ?? 0, pointsDeducted: g?._sum.pointsDeducted ?? 0 };
    })
    .filter((s) => s.orders > 0);
  const uniq = (xs: Array<string | null>) =>
    [...new Set(xs.map((x) => (x ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const asm = levels.find((l) => l.code.toUpperCase() === 'ASM') ?? levels.find((l) => l.level === 3) ?? null;
  const orders = byStatus.reduce((s, x) => s + x.orders, 0);
  return {
    clientId: p.clientId,
    from: p.from,
    to: p.to,
    orders,
    pointsDeducted: byStatus.reduce((s, x) => s + x.pointsDeducted, 0),
    valueInr: Number(valueAgg._sum.valuePaise ?? 0n) / 100,
    pointsRequested: groups.reduce((s, g) => s + (g._sum.totalPointsCost ?? 0), 0),
    preparedInBackground: rangeDays(p) > REDEMPTION_LIGHT_MAX_DAYS || orders > REDEMPTION_LIGHT_MAX_ROWS,
    byStatus,
    zones: uniq(zones.map((z) => z.zone)),
    states: uniq(states.map((s) => s.state)),
    asmLevelLabel: asm ? levelHeader(p.clientId, asm) : null,
  };
}
