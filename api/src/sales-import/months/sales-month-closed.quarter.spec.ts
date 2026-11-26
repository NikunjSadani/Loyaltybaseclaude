// D-1 guard for a points-engine QUARTER run (`YYYY-Qn`, owner-approved 2026-11-25): EVERY month of the quarter must be
// closed in Sales Import; the refusal names the open month; an export is recorded on each month. Dates are relative to
// today (an entirely past quarter), never hardcoded.
// Run: npx jest src/sales-import/months/sales-month-closed.quarter.spec.ts

import type { ExecutionContext } from '@nestjs/common';
import { SalesMonthClosedGuard } from './sales-month-closed.guard';
import { monthLabel } from './month-state';
import { parseQuarter, quarterKeyForMonth } from '../../points-engine/points-engine.quarter';

function monthsAgo(n: number): string {
  const d = new Date();
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
}
// A quarter that ended well before today (its 3 months are all OLDER → implicitly CLOSED unless reopened).
const QKEY = quarterKeyForMonth(monthsAgo(9));
const Q = parseQuarter(QKEY)!;

const user = { sub: 'ca', role: 'CLIENT_ADMIN', clientId: 't1', phone: '1', name: 'CA' };
function ctx(period: string, route = 'export') {
  const listeners: Array<() => void> = [];
  const res = { statusCode: 200, once: (_e: string, cb: () => void) => listeners.push(cb) };
  return {
    finish: () => listeners.forEach((l) => l()),
    c: {
      getHandler: () => ({ [route]: function () {} })[route],
      switchToHttp: () => ({ getRequest: () => ({ user, body: {}, query: { period } }), getResponse: () => res }),
    } as unknown as ExecutionContext,
  };
}
function guardWith(openMonth: string | null) {
  const prisma = {
    client: { findUnique: jest.fn(async () => ({ status: 'ACTIVE', features: { salesImport: true } })) },
    salesImportApply: { findFirst: jest.fn(async () => null) },
    salesMonthStatus: {
      findUnique: jest.fn(async (a: { where: { clientId_month: { month: string } } }) =>
        a.where.clientId_month.month === openMonth ? { state: 'OPEN', reopenedAt: new Date() } : null,
      ),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  return { guard: new SalesMonthClosedGuard(prisma as never), prisma };
}

describe('SalesMonthClosedGuard — quarter period', () => {
  beforeEach(() => SalesMonthClosedGuard.lastKnownFlag.clear());

  it('all 3 months closed → allowed; each month checked; the export is recorded on EACH month', async () => {
    const { guard, prisma } = guardWith(null);
    const { c, finish } = ctx(QKEY);
    await expect(guard.canActivate(c)).resolves.toBe(true);
    expect(prisma.salesMonthStatus.findUnique).toHaveBeenCalledTimes(3);
    finish();
    await new Promise((r) => setImmediate(r));
    expect(prisma.auditLog.create.mock.calls.map((x: unknown[]) => (x[0] as { data: { entityId: string } }).data.entityId)).toEqual(
      Q.months.map((m) => `t1:${m}`),
    );
  });

  it('the middle month reopened (OPEN) → 409 naming that month and the quarter', async () => {
    const { guard } = guardWith(Q.months[1]);
    await expect(guard.canActivate(ctx(QKEY).c)).rejects.toThrow(`${monthLabel(Q.months[1])} is still OPEN (part of ${Q.label})`);
  });

  it('flag OFF + no importer data in any of the 3 months → allowed (apply lookup covers all 3 months)', async () => {
    const { guard, prisma } = guardWith(null);
    prisma.client.findUnique.mockResolvedValue({ status: 'ACTIVE', features: {} } as never);
    await expect(guard.canActivate(ctx(QKEY).c)).resolves.toBe(true);
    expect(prisma.salesImportApply.findFirst).toHaveBeenCalledWith({ where: { clientId: 't1', month: { in: Q.months } }, select: { id: true } });
    expect(prisma.salesMonthStatus.findUnique).not.toHaveBeenCalled();
  });
});
