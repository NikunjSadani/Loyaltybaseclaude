/**
 * GET /v1/reports/redemptions — the cheap on-screen summary for the Reports hub card: totals + per-status counts for
 * the chosen filters (the SAME WHERE as the Excel), whether the download will be prepared in the background, and the
 * client's Zone / State values for the filter pickers. Three queries, no per-row work.
 */
import type { RedemptionStatus } from '@prisma/client';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RedemptionReportQueryDto } from '../dto/redemption-report.dto';
import { REDEMPTION_LIGHT_MAX_DAYS, rangeDays, redemptionWhere, resolveRedemptionParams } from './redemption-report.query';
import { STATUS_LABEL } from './redemption-report.rows';

export interface RedemptionScreenSummary {
  clientId: string;
  from: string;
  to: string;
  orders: number;
  points: number;
  valueInr: number;
  /** true → the Excel will be prepared in the background (Downloads page). */
  preparedInBackground: boolean;
  byStatus: Array<{ status: RedemptionStatus; label: string; orders: number; points: number; valueInr: number }>;
  zones: string[];
  states: string[];
}

export async function redemptionScreenSummary(
  prisma: Pick<PrismaService, 'redemptionOrder' | 'outlet'>,
  user: JwtPayload,
  q: RedemptionReportQueryDto,
  now: Date,
): Promise<RedemptionScreenSummary> {
  const p = resolveRedemptionParams(q, user, now);
  const where = redemptionWhere(p);
  const [groups, zones, states] = await Promise.all([
    prisma.redemptionOrder.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
      _sum: { totalPointsCost: true, valuePaise: true },
    }),
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
  ]);
  const byStatus = (Object.keys(STATUS_LABEL) as RedemptionStatus[])
    .map((status) => {
      const g = groups.find((x) => x.status === status);
      return {
        status,
        label: STATUS_LABEL[status],
        orders: g?._count._all ?? 0,
        points: g?._sum.totalPointsCost ?? 0,
        valueInr: Number(g?._sum.valuePaise ?? 0n) / 100,
      };
    })
    .filter((s) => s.orders > 0);
  const uniq = (xs: Array<string | null>) =>
    [...new Set(xs.map((x) => (x ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    clientId: p.clientId,
    from: p.from,
    to: p.to,
    orders: byStatus.reduce((s, x) => s + x.orders, 0),
    points: byStatus.reduce((s, x) => s + x.points, 0),
    valueInr: Math.round(byStatus.reduce((s, x) => s + x.valueInr, 0) * 100) / 100,
    preparedInBackground: rangeDays(p) > REDEMPTION_LIGHT_MAX_DAYS,
    byStatus,
    zones: uniq(zones.map((z) => z.zone)),
    states: uniq(states.map((s) => s.state)),
  };
}
