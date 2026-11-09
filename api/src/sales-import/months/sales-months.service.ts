import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type { SalesMonthStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { lockSalesMonth } from '../../common/sales-kpi-ownership';
import { currentMonthKey } from '../../targets/targets.helpers';
import type { SalesMonthRow } from '../sales-import.contract';
import { isMonthKey, monthLabel, resolveMonthState, shiftMonthKey } from './month-state';

/** Max months one list call returns. */
export const MAX_MONTH_RANGE = 36;

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
    return months.reverse().map((m) => this.toRow(m, current, byMonth.get(m) ?? null, names));
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
    return this.toRow(month, currentMonthKey(), row, await this.userNames([row.closedById]));
  }

  /** GIFSY_ADMIN working inside the tenant (assumed) only — the controller's @Roles is the first gate. */
  async reopen(user: JwtPayload, month: string): Promise<SalesMonthRow> {
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Only Gifsy can reopen a month.');
    if (!user.assumed) throw new BadRequestException('Assume the tenant to reopen a month.');
    if (!isMonthKey(month)) throw new BadRequestException('month must be YYYY-MM.');
    const clientId = user.clientId;
    const row = await this.prisma.$transaction(
      async (tx) => {
        await lockSalesMonth(tx, clientId, month);
        const existing = await tx.salesMonthStatus.findUnique({ where: { clientId_month: { clientId, month } } });
        const st = resolveMonthState(month, currentMonthKey(), existing);
        if (st.relation === 'CURRENT' || st.relation === 'FUTURE') {
          throw new ConflictException(`${monthLabel(month)} is not closed (it is the current or a future month).`);
        }
        if (st.state === 'OPEN') throw new ConflictException(`${monthLabel(month)} is already open.`);
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
            metadata: { clientId, month, action: 'reopen' },
          },
        });
        return saved;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    return this.toRow(month, currentMonthKey(), row, await this.userNames([row.closedById]));
  }

  private toRow(month: string, current: string, row: SalesMonthStatus | null, names: Map<string, string>): SalesMonthRow {
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
    };
  }

  private async userNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (list.length === 0) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}
