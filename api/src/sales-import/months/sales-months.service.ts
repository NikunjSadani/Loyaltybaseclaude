import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma, SalesMonthStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { lockSalesMonth } from '../../common/sales-kpi-ownership';
import { currentMonthKey } from '../../targets/targets.helpers';
import type { SalesMonthReopenRequest, SalesMonthReopenResult, SalesMonthRow } from '../sales-import.contract';
import { isMonthKey, monthLabel, resolveMonthState, shiftMonthKey } from './month-state';

/** Max months one list call returns. */
export const MAX_MONTH_RANGE = 36;

type Downstream = SalesMonthRow['downstream'];
const NO_DOWNSTREAM: Downstream = { creditBatches: 0, exports: 0 };

/** AuditLog entity of a sales month (apply / close / reopen / D-1 export records all use it). */
export const salesMonthEntityId = (clientId: string, month: string) => `${clientId}:${month}`;

/**
 * M5: points artefacts already produced for each month — credit batches (any status) for the period, and the
 * points-compute export / report downloads the D-1 guard records as AuditLog EXPORT rows on the month entity.
 */
export async function downstreamArtifacts(
  db: Pick<Prisma.TransactionClient, 'creditBatch' | 'auditLog'>,
  clientId: string,
  months: string[],
): Promise<Map<string, Downstream>> {
  const out = new Map<string, Downstream>(months.map((m) => [m, { ...NO_DOWNSTREAM }]));
  if (months.length === 0) return out;
  const [batches, exportRows] = await Promise.all([
    db.creditBatch.groupBy({ by: ['period'], where: { clientId, period: { in: months } }, _count: { _all: true } }),
    db.auditLog.groupBy({
      by: ['entityId'],
      where: { entityType: 'SALES_MONTH', action: 'EXPORT', entityId: { in: months.map((m) => salesMonthEntityId(clientId, m)) } },
      _count: { _all: true },
    }),
  ]);
  for (const b of batches) out.get(b.period)!.creditBatches = b._count._all;
  for (const e of exportRows) {
    const month = e.entityId.slice(clientId.length + 1);
    if (out.has(month)) out.get(month)!.exports = e._count._all;
  }
  return out;
}

type HistoryMeta = { sourceImportId: string; appliedAt: Date };

/**
 * The stored month history per month: which import it holds and when it was applied. Reads the small per-month HEADER
 * table (sales_month_history_sets, unique (clientId, month)) — never the line rows (final check H1: Prisma's `distinct`
 * is applied in Node, so a `distinct` over sales_month_histories fetched every line of every month).
 */
export async function historyMetaByMonth(
  db: Pick<Prisma.TransactionClient, 'salesMonthHistorySet'>,
  clientId: string,
  months: string[],
): Promise<Map<string, HistoryMeta>> {
  if (months.length === 0) return new Map();
  const rows = await db.salesMonthHistorySet.findMany({
    where: { clientId, month: { in: months } },
    select: { month: true, sourceImportId: true, appliedAt: true },
  });
  return new Map(rows.map((r) => [r.month, { sourceImportId: r.sourceImportId, appliedAt: r.appliedAt }]));
}

export function downstreamWarnings(month: string, d: Downstream): string[] {
  const w: string[] = [];
  if (d.creditBatches > 0) {
    w.push(`${d.creditBatches} credit batch(es) already exist for ${monthLabel(month)}; points credited from them will not change automatically. Use the reversal process if the new numbers differ.`);
  }
  if (d.exports > 0) {
    w.push(`Points reports / exports for ${monthLabel(month)} were downloaded ${d.exports} time(s); anything already sent to the client may no longer match.`);
  }
  return w;
}

/**
 * Month state list / close / reopen with the per-(client, month) advisory lock + audit (plan §7.3; task K-4).
 * OWNER: Lane K. Close and reopen take the SAME lock as apply, so they serialise against an in-flight apply.
 */
@Injectable()
export class SalesMonthsService {
  constructor(readonly prisma: PrismaService) {}

  async list(clientId: string, from?: string, to?: string): Promise<SalesMonthRow[]> {
    const current = currentMonthKey();
    const end = to ?? current;
    const start = from ?? shiftMonthKey(end, -5);
    if (!isMonthKey(start) || !isMonthKey(end)) throw new BadRequestException('from/to must be YYYY-MM.');
    if (start > end) throw new BadRequestException('from must not be after to.');
    const months: string[] = [];
    for (let m = start; m <= end && months.length < MAX_MONTH_RANGE; m = shiftMonthKey(m, 1)) months.push(m);

    const rows = await this.prisma.salesMonthStatus.findMany({ where: { clientId, month: { in: months } } });
    const byMonth = new Map(rows.map((r) => [r.month, r]));
    const names = await this.userNames(rows.map((r) => r.closedById));
    const [downstream, history] = await Promise.all([
      downstreamArtifacts(this.prisma, clientId, months),
      historyMetaByMonth(this.prisma, clientId, months),
    ]);
    return months.reverse().map((m) => this.toRow(m, current, byMonth.get(m) ?? null, names, downstream.get(m), history.get(m)));
  }

  async close(user: JwtPayload, month: string): Promise<SalesMonthRow> {
    if (!isMonthKey(month)) throw new BadRequestException('month must be YYYY-MM.');
    const clientId = user.clientId;
    const row = await this.prisma.$transaction(
      async (tx) => {
        await lockSalesMonth(tx, clientId, month);
        const current = currentMonthKey();
        const existing = await tx.salesMonthStatus.findUnique({ where: { clientId_month: { clientId, month } } });
        const st = resolveMonthState(month, current, existing);
        if (st.relation === 'CURRENT') throw new ConflictException(`${monthLabel(month)} is the current month and cannot be closed yet.`);
        if (st.relation === 'FUTURE') throw new ConflictException(`${monthLabel(month)} has not started yet.`);
        if (st.state === 'CLOSED') throw new ConflictException(`${monthLabel(month)} is already closed.`);
        const now = new Date();
        const saved = await tx.salesMonthStatus.upsert({
          where: { clientId_month: { clientId, month } },
          create: { clientId, month, state: 'CLOSED', closedAt: now, closedById: user.sub },
          update: { state: 'CLOSED', closedAt: now, closedById: user.sub },
        });
        await tx.auditLog.create({
          data: {
            action: 'UPDATE',
            entityType: 'SALES_MONTH',
            entityId: `${clientId}:${month}`,
            actorId: user.sub,
            oldValues: { state: st.state, implicit: st.implicit },
            newValues: { state: 'CLOSED', action: 'close' },
            metadata: { clientId, month, action: 'close', lastAppliedAt: saved.lastAppliedAt?.toISOString() ?? null },
          },
        });
        return saved;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    const downstream = (await downstreamArtifacts(this.prisma, clientId, [month])).get(month);
    const history = (await historyMetaByMonth(this.prisma, clientId, [month])).get(month);
    return this.toRow(month, currentMonthKey(), row, await this.userNames([row.closedById]), downstream, history);
  }

  /**
   * GIFSY_ADMIN working inside the tenant (assumed) only — the controller's @Roles is the first gate.
   * M5: when credit batches / points exports already exist for the month, reopening needs
   * `acknowledgeDownstream: true` (409 otherwise, listing them); the response carries the same warnings.
   */
  async reopen(user: JwtPayload, month: string, body: SalesMonthReopenRequest = {}): Promise<SalesMonthReopenResult> {
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Only Gifsy can reopen a month.');
    if (!user.assumed) throw new BadRequestException('Assume the tenant to reopen a month.');
    if (!isMonthKey(month)) throw new BadRequestException('month must be YYYY-MM.');
    const clientId = user.clientId;
    const ack = body?.acknowledgeDownstream === true;
    let warnings: string[] = [];
    let downstream: Downstream = { ...NO_DOWNSTREAM };
    const row = await this.prisma.$transaction(
      async (tx) => {
        await lockSalesMonth(tx, clientId, month);
        const existing = await tx.salesMonthStatus.findUnique({ where: { clientId_month: { clientId, month } } });
        const st = resolveMonthState(month, currentMonthKey(), existing);
        if (st.relation === 'CURRENT' || st.relation === 'FUTURE') {
          throw new ConflictException(`${monthLabel(month)} is not closed (it is the current or a future month).`);
        }
        if (st.state === 'OPEN') throw new ConflictException(`${monthLabel(month)} is already open.`);
        downstream = (await downstreamArtifacts(tx, clientId, [month])).get(month)!;
        warnings = downstreamWarnings(month, downstream);
        if (warnings.length > 0 && !ack) {
          throw new ConflictException(`Reopening ${monthLabel(month)} needs confirmation: ${warnings.join(' ')}`);
        }
        const now = new Date();
        const saved = await tx.salesMonthStatus.upsert({
          where: { clientId_month: { clientId, month } },
          create: { clientId, month, state: 'OPEN', reopenedAt: now, reopenedById: user.sub },
          update: { state: 'OPEN', reopenedAt: now, reopenedById: user.sub },
        });
        await tx.auditLog.create({
          data: {
            action: 'UPDATE',
            entityType: 'SALES_MONTH',
            entityId: `${clientId}:${month}`,
            actorId: user.sub,
            oldValues: { state: st.state, implicit: st.implicit },
            newValues: { state: 'OPEN', action: 'reopen' },
            metadata: { clientId, month, action: 'reopen', acknowledgedDownstream: warnings.length > 0, downstream },
          },
        });
        return saved;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    const history = (await historyMetaByMonth(this.prisma, clientId, [month])).get(month);
    return { ...this.toRow(month, currentMonthKey(), row, await this.userNames([row.closedById]), downstream, history), warnings };
  }

  private toRow(
    month: string,
    current: string,
    row: SalesMonthStatus | null,
    names: Map<string, string>,
    downstream: Downstream = NO_DOWNSTREAM,
    history?: HistoryMeta,
  ): SalesMonthRow {
    const st = resolveMonthState(month, current, row);
    const closedExplicit = st.state === 'CLOSED' && !st.implicit;
    return {
      month,
      state: st.state,
      implicit: st.implicit,
      closedAt: closedExplicit && row?.closedAt ? row.closedAt.toISOString() : null,
      closedBy: closedExplicit && row?.closedById ? (names.get(row.closedById) ?? null) : null,
      lastAppliedAt: row?.lastAppliedAt ? row.lastAppliedAt.toISOString() : null,
      lastAppliedImportId: row?.lastAppliedImportId ?? null,
      canClose: st.canClose,
      canReopen: st.canReopen,
      downstream: { ...downstream },
      hasHistory: !!history,
      historySourceImportId: history?.sourceImportId ?? null,
      historyAppliedAt: history ? history.appliedAt.toISOString() : null,
    };
  }

  private async userNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (list.length === 0) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}
