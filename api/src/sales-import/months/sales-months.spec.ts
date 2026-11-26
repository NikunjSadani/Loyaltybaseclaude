import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';
import { currentMonthKey } from '../../targets/targets.helpers';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PointsComputeController } from '../../points-engine/points-compute.controller';
import { SalesMonthsController } from '../sales-months.controller';
import { SalesImportConfigController } from '../sales-import-config.controller';
import { SalesImportApplyController } from '../sales-import-apply.controller';
import { REBUILD_PRODUCT_LIST_STATEMENT_TIMEOUT_MS, REBUILD_PRODUCT_LIST_TX_TIMEOUT_MS, SalesMonthsService } from './sales-months.service';
import { SalesMonthClosedGuard } from './sales-month-closed.guard';
import { parseQuarter, quarterKeyForMonth } from '../../points-engine/points-engine.quarter';
import { monthLabel, shiftMonthKey } from './month-state';
import { historyCutoffMonth } from '../retention-window';
import { withRetentionV2 } from '../retention-env.testspec';

const CUR = currentMonthKey();
const PREV = shiftMonthKey(CUR, -1);
const OLD = shiftMonthKey(CUR, -3);
const AT = new Date();

const clientAdmin: JwtPayload = { sub: 'ca', role: 'CLIENT_ADMIN', clientId: 't1', phone: '', name: 'CA' };
const gifsyAssumed: JwtPayload = { sub: 'ga', role: 'GIFSY_ADMIN', clientId: 't1', phone: '', name: 'GA', assumed: true };

function db(
  rows: Array<Record<string, unknown>> = [],
  downstream: {
    batches?: Array<{ period: string; n: number }>;
    exports?: Array<{ month: string; n: number }>;
    history?: Array<Record<string, unknown>>;
    /** FOCUS-FROM-TARGETS: OutletTarget rows (month, when last written, optional targetValues with __names). */
    targets?: Array<{ month: string; updatedAt?: Date; clientId?: string; targetValues?: Record<string, unknown> }>;
    acceptances?: Array<Record<string, unknown>>;
    focusDefs?: Array<Record<string, unknown>>;
    /** Background jobs: active job rows (activeJobsByMonth shape). */
    activeJobs?: Array<Record<string, unknown>>;
    lastJobs?: Array<Record<string, unknown>>;
    /** Points-engine QUARTER credit batches (sourceKind POINTS_ENGINE_QUARTER:<key>). */
    quarterBatches?: Array<{ batchCode: string; sourceKind: string }>;
  } = {},
) {
  const log: string[] = [];
  const d: Record<string, any> = {
    log,
    salesMonthStatus: {
      findMany: jest.fn(async () => rows),
      findUnique: jest.fn(async ({ where }: { where: { clientId_month: { month: string } } }) => rows.find((r) => r.month === where.clientId_month.month) ?? null),
      upsert: jest.fn(async ({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
        log.push('upsert');
        return { ...create, ...update, lastAppliedAt: null, lastAppliedImportId: null };
      }),
    },
    auditLog: {
      create: jest.fn(async () => { log.push('audit'); return {}; }),
      groupBy: jest.fn(async () => (downstream.exports ?? []).map((e) => ({ entityId: `t1:${e.month}`, _count: { _all: e.n } }))),
    },
    creditBatch: {
      groupBy: jest.fn(async () => (downstream.batches ?? []).map((b) => ({ period: b.period, _count: { _all: b.n } }))),
      findMany: jest.fn(async () => (downstream.quarterBatches ?? []) as Array<{ batchCode: string; sourceKind: string }>),
    },
    salesMonthHistorySet: { findMany: jest.fn(async () => (downstream.history ?? []) as Array<Record<string, unknown>>) },
    // the LINE table must never be read for month lists (final check H1)
    salesMonthHistory: { findMany: jest.fn(() => { throw new Error('month lists must not read history lines'); }) },
    user: { findMany: jest.fn(async () => [{ id: 'ca', name: 'Client Admin' }]) },
    outletTarget: {
      // GROUP BY month, MAX(updatedAt)
      groupBy: jest.fn(async ({ where }: { where: { clientId: string; month: { in: string[] } } }) => {
        const max = new Map<string, Date>();
        for (const t of downstream.targets ?? []) {
          if ((t.clientId ?? 't1') !== where.clientId || !where.month.in.includes(t.month) || !t.updatedAt) continue;
          const cur = max.get(t.month);
          if (!cur || t.updatedAt > cur) max.set(t.month, t.updatedAt);
        }
        return [...max.entries()].map(([month, updatedAt]) => ({ month, _max: { updatedAt } }));
      }),
      findMany: jest.fn(async ({ where }: { where: { clientId: string; month: string } }) =>
        (downstream.targets ?? [])
          .filter((t) => (t.clientId ?? 't1') === where.clientId && t.month === where.month)
          .map((t) => ({ targetValues: t.targetValues ?? {} }))),
    },
    kpiDef: { findMany: jest.fn(async () => [{ code: 'FB1', label: 'Focus Brand 1' }]) },
    salesKpiDefinition: {
      count: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        (downstream.focusDefs ?? []).filter((f) => Object.entries(where).every(([k, v]) => f[k] === v)).length),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        (downstream.focusDefs ?? []).find((f) => Object.entries(where).every(([k, v]) => f[k] === v)) ?? null),
    },
    salesFocusAcceptance: acceptanceTable(downstream.acceptances ?? [], log),
    $executeRaw: jest.fn(async (q: Prisma.Sql) => { log.push(`lock:${q.values[0]}`); return 1; }),
    $queryRaw: jest.fn(async (q: Prisma.Sql) => {
      if (q.strings.join('?').includes('DISTINCT ON (m."month")')) return downstream.lastJobs ?? [];
      if (q.strings.join('?').includes('FROM "sales_apply_job_months"')) {
        const months = q.values[1] as string[];
        return (downstream.activeJobs ?? []).filter((j) => months.includes(j.month as string));
      }
      return [];
    }),
  };
  d.$transaction = jest.fn(async (cb: (tx: unknown) => unknown) => cb(d));
  return d;
}

/** In-memory sales_focus_acceptances (FOCUS-FROM-TARGETS accept / undo). */
function acceptanceTable(rows: Array<Record<string, unknown>>, log: string[]) {
  let n = rows.length;
  const match = (r: Record<string, unknown>, w: Record<string, unknown>) => Object.entries(w).every(([k, v]) => r[k] === v);
  return {
    rows,
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.filter((r) => match(r, where)).sort((a, b) => `${a.kpiCode}|${a.key}`.localeCompare(`${b.kpiCode}|${b.key}`))),
    findUnique: jest.fn(async ({ where }: { where: { clientId_month_kpiCode_key: Record<string, unknown> } }) =>
      rows.find((r) => match(r, where.clientId_month_kpiCode_key)) ?? null),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      log.push('acceptance.create');
      const row = { id: `fa${++n}`, acceptedAt: AT, ...data };
      rows.push(row);
      return row;
    }),
    delete: jest.fn(async ({ where }: { where: { id: string } }) => {
      log.push('acceptance.delete');
      const i = rows.findIndex((r) => r.id === where.id);
      return rows.splice(i, 1)[0];
    }),
  };
}

// Timed out at jest's 5 s default under full-suite CPU load (2026-11-10; passes alone in ~13 s for the file).
// A red suite skips the staging deploy, so give real headroom.
jest.setTimeout(30_000);

describe('SalesMonthsService (K-4)', () => {
  it('close current month → 409; future → 409', async () => {
    const s = new SalesMonthsService(db() as never);
    await expect(s.close(clientAdmin, CUR)).rejects.toBeInstanceOf(ConflictException);
    await expect(s.close(clientAdmin, shiftMonthKey(CUR, 1))).rejects.toBeInstanceOf(ConflictException);
  });

  it('close previous → CLOSED, lock taken FIRST, audit written', async () => {
    const d = db();
    const row = await new SalesMonthsService(d as never).close(clientAdmin, PREV);
    expect(row).toEqual(expect.objectContaining({ month: PREV, state: 'CLOSED', implicit: false, canClose: false, canReopen: true, closedBy: 'Client Admin' }));
    expect(d.log).toEqual([`lock:sales-month:t1:${PREV}`, 'upsert', 'audit']);
    expect(d.auditLog.create.mock.calls[0][0].data).toEqual(expect.objectContaining({
      action: 'UPDATE', entityType: 'SALES_MONTH', entityId: `t1:${PREV}`, actorId: 'ca',
      metadata: expect.objectContaining({ clientId: 't1', action: 'close' }),
    }));
  });

  it('close an already (implicitly) closed older month → 409', async () => {
    await expect(new SalesMonthsService(db() as never).close(clientAdmin, OLD)).rejects.toThrow(/already closed/);
  });

  it('reopen: CLIENT_ADMIN → 403; un-assumed GIFSY_ADMIN → 400 (server-side, not just the UI)', async () => {
    const s = new SalesMonthsService(db() as never);
    await expect(s.reopen(clientAdmin, OLD)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.reopen({ ...gifsyAssumed, assumed: false }, OLD)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reopen: staff with targets:upload passes BOTH guards (real route metadata) yet the service refuses → 403, nothing written', async () => {
    const { Reflector } = await import('@nestjs/core');
    const { PermissionGuard } = await import('../../common/guards/permission.guard');
    const reflector = new Reflector();
    const staff: JwtPayload = { ...gifsyAssumed, sub: 'st', role: 'GIFSY_STAFF', gifsyRoleId: 'pm' };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ user: staff }) }),
      getHandler: () => SalesMonthsController.prototype.reopen,
      getClass: () => SalesMonthsController,
    } as unknown as ExecutionContext;
    // The guards do NOT keep this staff member out — which is why the service role check is the real gate.
    expect(new RolesGuard(reflector).canActivate(ctx)).toBe(true);
    const gifsyRoles = { getPermissions: jest.fn().mockResolvedValue(new Set(['targets:read', 'targets:upload'])) };
    expect(await new PermissionGuard(reflector, {} as never, gifsyRoles as never).canActivate(ctx)).toBe(true);
    const d = db([{ month: OLD, state: 'CLOSED', closedAt: AT }]);
    await expect(new SalesMonthsService(d as never).reopen(staff, OLD)).rejects.toThrow(ForbiddenException);
    expect(d.$transaction).not.toHaveBeenCalled();
    expect(d.auditLog.create).not.toHaveBeenCalled();
  });

  it('reopen: an assumed GIFSY_STAFF (whose RolesGuard check DEFERS to targets:upload) is still refused → 403', async () => {
    await expect(new SalesMonthsService(db() as never).reopen({ ...gifsyAssumed, role: 'GIFSY_STAFF' }, OLD)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reopen an older (implicitly closed) month → OPEN + audit; reopen current/open → 409', async () => {
    const d = db();
    const s = new SalesMonthsService(d as never);
    const row = await s.reopen(gifsyAssumed, OLD);
    expect(row).toEqual(expect.objectContaining({ month: OLD, state: 'OPEN', implicit: false, canClose: true }));
    expect(d.upsertArgs ?? d.salesMonthStatus.upsert.mock.calls[0][0].update).toEqual(expect.objectContaining({ state: 'OPEN', reopenedById: 'ga' }));
    expect(d.auditLog.create.mock.calls[0][0].data.metadata.action).toBe('reopen');
    await expect(s.reopen(gifsyAssumed, CUR)).rejects.toBeInstanceOf(ConflictException);
    await expect(s.reopen(gifsyAssumed, PREV)).rejects.toThrow(/already open/);
  });

  it('M5: reopen with credit batches / points exports for the month → 409 listing them unless acknowledged; ack → OPEN + warnings + audited', async () => {
    const d = db([], { batches: [{ period: OLD, n: 2 }], exports: [{ month: OLD, n: 3 }] });
    const s = new SalesMonthsService(d as never);
    await expect(s.reopen(gifsyAssumed, OLD)).rejects.toThrow(/needs confirmation: 2 credit batch\(es\).*downloaded 3 time/);
    expect(d.salesMonthStatus.upsert).not.toHaveBeenCalled();
    const r = await s.reopen(gifsyAssumed, OLD, { acknowledgeDownstream: true });
    expect(r).toEqual(expect.objectContaining({ state: 'OPEN', downstream: { creditBatches: 2, exports: 3 } }));
    expect(r.warnings).toHaveLength(2);
    expect(d.auditLog.create.mock.calls[0][0].data.metadata).toEqual(expect.objectContaining({ acknowledgedDownstream: true, downstream: { creditBatches: 2, exports: 3 } }));
    // the downstream lookup is tenant-scoped
    expect(d.creditBatch.groupBy.mock.calls[0][0].where).toEqual({ clientId: 't1', period: { in: [OLD] } });
    expect(d.auditLog.groupBy.mock.calls[0][0].where).toEqual({ entityType: 'SALES_MONTH', action: 'EXPORT', entityId: { in: [`t1:${OLD}`] } });
  });

  it('quarter credit: reopening ANY month of a quarter that was credited quarterly warns, naming the batch (needs ack)', async () => {
    const qKey = quarterKeyForMonth(OLD);
    const q = parseQuarter(qKey)!;
    const d = db([], { quarterBatches: [{ batchCode: 'CB-QX-001', sourceKind: `POINTS_ENGINE_QUARTER:${qKey}` }] });
    const s = new SalesMonthsService(d as never);
    await expect(s.reopen(gifsyAssumed, OLD)).rejects.toThrow(new RegExp(`QUARTERLY credit batch CB-QX-001 \\(${q.label}\\)`));
    expect(d.creditBatch.findMany.mock.calls[0][0].where).toEqual({ clientId: 't1', sourceKind: { in: [`POINTS_ENGINE_QUARTER:${qKey}`] } });
    const r = await s.reopen(gifsyAssumed, OLD, { acknowledgeDownstream: true });
    expect(r.downstream.quarterCreditBatches).toEqual([{ batchCode: 'CB-QX-001', quarter: qKey, label: q.label }]);
    expect(r.warnings.join(' ')).toMatch(/QUARTERLY credit batch CB-QX-001/);
  });

  it('M5: no downstream artefacts → reopen needs no ack and returns no warnings', async () => {
    const r = await new SalesMonthsService(db() as never).reopen(gifsyAssumed, OLD);
    expect(r.warnings).toEqual([]);
    expect(r.downstream).toEqual({ creditBatches: 0, exports: 0 });
  });

  it('list: default last 6 months newest first, with resolved states', async () => {
    const d = db([{ month: PREV, state: 'CLOSED', closedAt: AT, closedById: 'ca', lastAppliedAt: AT, lastAppliedImportId: 'imp1' }]);
    const rows = await new SalesMonthsService(d as never).list('t1');
    expect(rows.map((r) => r.month)).toEqual([0, -1, -2, -3, -4, -5].map((n) => shiftMonthKey(CUR, n)));
    expect(rows[0]).toEqual(expect.objectContaining({ state: 'OPEN', canClose: false }));
    expect(rows[1]).toEqual(expect.objectContaining({ state: 'CLOSED', closedBy: 'Client Admin', lastAppliedImportId: 'imp1', canReopen: true }));
    expect(rows[2]).toEqual(expect.objectContaining({ state: 'CLOSED', implicit: true }));
    expect(rows[0].downstream).toEqual({ creditBatches: 0, exports: 0 });
    expect(rows[1]).toEqual(expect.objectContaining({ hasHistory: false, historySourceImportId: null, historyAppliedAt: null }));
  });

  it('month history: list exposes hasHistory / historySourceImportId / historyAppliedAt per month (tenant-scoped)', async () => {
    const d = db([], { history: [{ month: PREV, sourceImportId: 'imp9', appliedAt: AT }] });
    const rows = await new SalesMonthsService(d as never).list('t1');
    expect(rows[1]).toEqual(expect.objectContaining({ month: PREV, hasHistory: true, historySourceImportId: 'imp9', historyAppliedAt: AT.toISOString() }));
    expect(rows[0].hasHistory).toBe(false);
    // H1 (final check): ONE query on the per-month HEADER table — no Prisma `distinct` (it dedupes in Node after
    // fetching every row) and no read of the line table at all.
    expect(d.salesMonthHistorySet.findMany).toHaveBeenCalledTimes(1);
    const q = d.salesMonthHistorySet.findMany.mock.calls[0][0];
    expect(q).toEqual({ where: { clientId: 't1', month: { in: expect.arrayContaining([PREV, CUR]) } }, select: { month: true, sourceImportId: true, appliedAt: true, lineRows: true, combosSourceImportId: true, combosAppliedAt: true } });
    expect(q.distinct).toBeUndefined();
    expect(d.salesMonthHistory.findMany).not.toHaveBeenCalled();
    await expect(new SalesMonthsService(d as never).list('t1', '2026-13')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('S1 switch OFF (default): a month 4 months back still shows its history (10-year retention, as before)', () => withRetentionV2(undefined, async () => {
    const OUT = shiftMonthKey(CUR, -4);
    const d = db([], { history: [{ month: OUT, sourceImportId: 'old', appliedAt: AT }] });
    d.salesMonthHistorySet.findMany.mockImplementation(async ({ where }: { where: { month: { in: string[] } } }) =>
      [{ month: OUT, sourceImportId: 'old', appliedAt: AT }].filter((h) => where.month.in.includes(h.month)));
    const rows = await new SalesMonthsService(d as never).list('t1');
    expect(Object.fromEntries(rows.map((r) => [r.month, r]))[OUT]).toEqual(expect.objectContaining({ hasHistory: true, historySourceImportId: 'old' }));
  }));

  it('S1 switch ON — retention window: a month older than current + 3 previous shows NO history (no recalculate) even while the sweep still holds its header', () => withRetentionV2('on', async () => {
    const OUT = shiftMonthKey(CUR, -4);
    const IN = shiftMonthKey(CUR, -3);
    const d = db([], { history: [{ month: OUT, sourceImportId: 'old', appliedAt: AT }, { month: IN, sourceImportId: 'imp9', appliedAt: AT }] });
    d.salesMonthHistorySet.findMany.mockImplementation(async ({ where }: { where: { month: { in: string[] } } }) =>
      [{ month: OUT, sourceImportId: 'old', appliedAt: AT }, { month: IN, sourceImportId: 'imp9', appliedAt: AT }].filter((h) => where.month.in.includes(h.month)));
    const rows = await new SalesMonthsService(d as never).list('t1'); // default range: the last 6 months
    const by = Object.fromEntries(rows.map((r) => [r.month, r]));
    expect(by[OUT]).toEqual(expect.objectContaining({ hasHistory: false, historySourceImportId: null }));
    expect(by[IN]).toEqual(expect.objectContaining({ hasHistory: true, historySourceImportId: 'imp9' }));
    expect(d.salesMonthHistorySet.findMany.mock.calls[0][0].where.month.in).not.toContain(OUT);
  }));
});

describe('route metadata (roles / permissions)', () => {
  const meta = (key: string, cls: { prototype: object }, m: string) => Reflect.getMetadata(key, (cls.prototype as Record<string, object>)[m]);

  it('reopen is GIFSY_ADMIN-only at the method level; RolesGuard rejects a CLIENT_ADMIN', () => {
    expect(meta(ROLES_KEY, SalesMonthsController, 'reopen')).toEqual(['GIFSY_ADMIN']);
    const guard = new RolesGuard({
      getAllAndOverride: (k: string, targets: unknown[]) =>
        Reflect.getMetadata(k, targets[0] as object) ?? Reflect.getMetadata(k, targets[1] as object),
    } as never);
    const ctx = (user: JwtPayload) => ({
      getHandler: () => (SalesMonthsController.prototype as unknown as Record<string, unknown>).reopen,
      getClass: () => SalesMonthsController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;
    expect(() => guard.canActivate(ctx(clientAdmin))).toThrow();
    expect(guard.canActivate(ctx(gifsyAssumed))).toBe(true);
  });

  it.each([
    [SalesMonthsController, 'list', 'targets:read'],
    [SalesMonthsController, 'close', 'targets:upload'],
    [SalesMonthsController, 'recalcPreview', 'targets:read'],
    [SalesMonthsController, 'recalculate', 'targets:upload'],
    [SalesImportApplyController, 'getPreview', 'targets:read'],
    [SalesImportApplyController, 'postApply', 'targets:upload'],
    [SalesImportConfigController, 'getProfile', 'targets:read'],
    [SalesImportConfigController, 'putProfile', 'targets:manage_config'],
    [SalesImportConfigController, 'listKpis', 'targets:read'],
    [SalesImportConfigController, 'createKpi', 'targets:manage_config'],
    [SalesImportConfigController, 'patchKpi', 'targets:manage_config'],
    [SalesImportConfigController, 'deleteKpi', 'targets:manage_config'],
    [SalesImportConfigController, 'testKpi', 'targets:read'],
    [SalesImportConfigController, 'segmentOptions', 'targets:read'],
    [SalesImportConfigController, 'historyCombos', 'targets:read'],
  ])('%p.%s requires %s (D-5)', (cls, m, perm) => expect(meta(PERMISSION_KEY, cls as never, m as string)).toBe(perm));
});

describe('controllers call the access gate FIRST (flag off → 403, nothing else runs)', () => {
  const tenant = { resolveClient: jest.fn(async () => ({ features: {} })) };
  const prisma = { client: { findUnique: jest.fn(async () => ({ status: 'ACTIVE', features: {} })) } };
  const never = new Proxy({}, { get: () => () => { throw new Error('service must not be reached'); } });

  it.each([
    ['config getProfile', () => new SalesImportConfigController(never as never, never as never, tenant as never, prisma as never, never as never).getProfile(clientAdmin)],
    ['config createKpi', () => new SalesImportConfigController(never as never, never as never, tenant as never, prisma as never, never as never).createKpi(clientAdmin, {} as never)],
    ['config historyCombos', () => new SalesImportConfigController(never as never, never as never, tenant as never, prisma as never, never as never).historyCombos(clientAdmin, {})],
    ['apply preview', () => new SalesImportApplyController(never as never, never as never, tenant as never, prisma as never, never as never, never as never).getPreview(clientAdmin, 'x')],
    ['apply apply', () => new SalesImportApplyController(never as never, never as never, tenant as never, prisma as never, never as never, never as never).postApply(clientAdmin, 'x', {} as never)],
    ['months close', () => new SalesMonthsController(never as never, tenant as never, prisma as never, never as never, never as never, never as never).close(clientAdmin, PREV)],
    ['months recalculate preview', () => new SalesMonthsController(never as never, tenant as never, prisma as never, never as never, never as never, never as never).recalcPreview(clientAdmin, PREV)],
    ['months recalculate', () => new SalesMonthsController(never as never, tenant as never, prisma as never, never as never, never as never, never as never).recalculate(clientAdmin, PREV, {} as never)],
    ['months reopen', () => new SalesMonthsController(never as never, tenant as never, prisma as never, never as never, never as never, never as never).reopen(gifsyAssumed, OLD)],
  ])('%s → 403 for a tenant without the flag (Deoleo)', async (_n, call) => {
    await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reopen by an un-assumed GIFSY_ADMIN → 400 at the gate', async () => {
    const c = new SalesMonthsController(never as never, tenant as never, prisma as never, never as never, never as never, never as never);
    await expect(c.reopen({ ...gifsyAssumed, clientId: 'gifsy', assumed: false }, OLD)).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── D-1 guard (K-8) ─────────────────────────────────────────────────────────

describe('SalesMonthClosedGuard (D-1)', () => {
  beforeEach(() => SalesMonthClosedGuard.lastKnownFlag.clear());
  function guardWith(features: Record<string, unknown> | null, override: Record<string, unknown> | null = null, applied = false) {
    const prisma = {
      client: { findUnique: jest.fn(async () => (features === null ? null : { status: 'ACTIVE', features })) },
      salesImportApply: { findFirst: jest.fn(async () => (applied ? { id: 'a1' } : null)) },
      salesMonthStatus: { findUnique: jest.fn(async () => override) },
      auditLog: { create: jest.fn(async (_a: { data: Record<string, unknown> }) => ({})) },
    };
    return { guard: new SalesMonthClosedGuard(prisma as never), prisma };
  }
  const handler = (name: string) => ({ [name]: function () {} })[name];
  /** A fake response: `finish(status)` simulates the handler having sent its response. */
  const makeRes = () => {
    const listeners: Array<() => void> = [];
    const res = { statusCode: 200, once: (_ev: string, cb: () => void) => listeners.push(cb), finish: (status = 200) => { res.statusCode = status; listeners.forEach((l) => l()); } };
    return res;
  };
  let lastRes = makeRes();
  const ctx = (period: unknown, where: 'body' | 'query' = 'query', user: JwtPayload = clientAdmin, route = 'export') => {
    lastRes = makeRes();
    const res = lastRes;
    return {
      getHandler: () => handler(route),
      switchToHttp: () => ({
        getRequest: () => ({ user, body: where === 'body' ? { period } : {}, query: where === 'query' ? { period } : {} }),
        getResponse: () => res,
      }),
    } as unknown as ExecutionContext;
  };

  it('flag OFF and no importer data for the month (Deoleo) → allow; month table never read, nothing recorded', async () => {
    const { guard, prisma } = guardWith({ walletModule: true });
    await expect(guard.canActivate(ctx(CUR))).resolves.toBe(true);
    expect(prisma.salesMonthStatus.findUnique).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.salesImportApply.findFirst).toHaveBeenCalledWith({ where: { clientId: 't1', month: CUR }, select: { id: true } });
  });

  it('M5: flag OFF but the month holds importer-written data → still guarded (OPEN → 409)', async () => {
    await expect(guardWith({}, null, true).guard.canActivate(ctx(PREV))).rejects.toThrow(/still OPEN/);
    await expect(guardWith({}, { state: 'CLOSED', closedAt: AT }, true).guard.canActivate(ctx(PREV))).resolves.toBe(true);
  });

  it('M5/L4: a SUCCESSFUL export / report is recorded as an EXPORT after the response finishes; a failed one and commit are not', async () => {
    const { guard, prisma } = guardWith({ salesImport: true });
    await guard.canActivate(ctx(OLD, 'query', clientAdmin, 'previewReport'));
    expect(prisma.auditLog.create).not.toHaveBeenCalled(); // nothing before the handler ran
    lastRes.finish(500);
    expect(prisma.auditLog.create).not.toHaveBeenCalled(); // the export failed → not recorded
    await guard.canActivate(ctx(OLD, 'query', clientAdmin, 'previewReport'));
    lastRes.finish(200);
    await new Promise((r) => setImmediate(r));
    expect(prisma.auditLog.create.mock.calls[0][0].data).toEqual(expect.objectContaining({
      action: 'EXPORT', entityType: 'SALES_MONTH', entityId: `t1:${OLD}`, actorId: 'ca', metadata: expect.objectContaining({ route: 'previewReport' }),
    }));
    await guard.canActivate(ctx(OLD, 'body', clientAdmin, 'commit'));
    lastRes.finish(201);
    await new Promise((r) => setImmediate(r));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('Downloads: a 202 (file only QUEUED) is NOT recorded by the guard — the export kind records it once when built', async () => {
    const { guard, prisma } = guardWith({ salesImport: true });
    await guard.canActivate(ctx(OLD, 'query', clientAdmin, 'payoutReport'));
    lastRes.finish(202);
    await new Promise((r) => setImmediate(r));
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    // The kind's build-time record (what points-compute.kinds.ts calls after writing the file) → exactly one row.
    await guard.recordExport('t1', OLD, 'ca', 'payoutReport');
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    // An instant 200 download is still recorded by the guard.
    await guard.canActivate(ctx(OLD, 'query', clientAdmin, 'previewReport'));
    lastRes.finish(200);
    await new Promise((r) => setImmediate(r));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
  });

  it('flag ON + OPEN month (current / previous) → 409 with the month name', async () => {
    const { guard } = guardWith({ salesImport: true });
    await expect(guard.canActivate(ctx(CUR))).rejects.toBeInstanceOf(ConflictException);
    await expect(guard.canActivate(ctx(PREV, 'body'))).rejects.toThrow(/is still OPEN\. Close it in Sales Import first\./);
  });

  it('flag ON + CLOSED month (explicit, or implicit older) → allow', async () => {
    await expect(guardWith({ salesImport: true }, { state: 'CLOSED', closedAt: AT }).guard.canActivate(ctx(PREV))).resolves.toBe(true);
    await expect(guardWith({ salesImport: true }).guard.canActivate(ctx(OLD))).resolves.toBe(true);
  });

  const failing = () => jest.fn(async () => { throw new Error('db'); });

  it('L3: a tenant that never used Sales Import is NEVER blocked by a failed read (fails OPEN — Deoleo)', async () => {
    // flag read fails, no apply for the month
    const a = { client: { findUnique: failing() }, salesImportApply: { findFirst: jest.fn(async () => null) }, salesMonthStatus: { findUnique: failing() } };
    await expect(new SalesMonthClosedGuard(a as never).canActivate(ctx(CUR))).resolves.toBe(true);
    // flag OFF and the apply lookup fails
    const b = { client: { findUnique: jest.fn(async () => ({ status: 'ACTIVE', features: {} })) }, salesImportApply: { findFirst: failing() }, salesMonthStatus: { findUnique: failing() } };
    await expect(new SalesMonthClosedGuard(b as never).canActivate(ctx(CUR))).resolves.toBe(true);
    // both reads fail
    const c = { client: { findUnique: failing() }, salesImportApply: { findFirst: failing() }, salesMonthStatus: { findUnique: failing() } };
    await expect(new SalesMonthClosedGuard(c as never).canActivate(ctx(CUR))).resolves.toBe(true);
    // flag OFF: the apply lookup comes AFTER the flag read and the month table is never touched
    expect(b.client.findUnique.mock.invocationCallOrder[0]).toBeLessThan(b.salesImportApply.findFirst.mock.invocationCallOrder[0]);
    expect(b.salesMonthStatus.findUnique).not.toHaveBeenCalled();
  });

  it('L5: a failed flag read is retried once; a transient failure is invisible', async () => {
    let n = 0;
    const prisma = {
      client: { findUnique: jest.fn(async () => { if (n++ === 0) throw new Error('blip'); return { status: 'ACTIVE', features: { salesImport: true } }; }) },
      salesImportApply: { findFirst: jest.fn(async () => null) },
      salesMonthStatus: { findUnique: jest.fn(async () => null) },
    };
    await expect(new SalesMonthClosedGuard(prisma as never).canActivate(ctx(PREV))).rejects.toThrow(/still OPEN/);
    expect(prisma.client.findUnique).toHaveBeenCalledTimes(2);
  });

  it('L5: both reads failing → the last-known flag decides: ON → guarded (month-read failure → 503); OFF/unknown → open', async () => {
    const ok = { client: { findUnique: jest.fn(async () => ({ status: 'ACTIVE', features: { salesImport: true } })) }, salesImportApply: { findFirst: jest.fn() }, salesMonthStatus: { findUnique: jest.fn(async () => null) } };
    await expect(new SalesMonthClosedGuard(ok as never).canActivate(ctx(OLD))).resolves.toBe(true); // learns ON for t1
    const down = { client: { findUnique: failing() }, salesImportApply: { findFirst: jest.fn(async () => null) }, salesMonthStatus: { findUnique: failing() } };
    await expect(new SalesMonthClosedGuard(down as never).canActivate(ctx(PREV))).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(down.salesImportApply.findFirst).not.toHaveBeenCalled();
    // a tenant last seen with the flag OFF (Deoleo) is never blocked
    const deoleo: JwtPayload = { ...clientAdmin, clientId: 'deoleo' };
    const off = { client: { findUnique: jest.fn(async () => ({ status: 'ACTIVE', features: {} })) }, salesImportApply: { findFirst: jest.fn(async () => null) }, salesMonthStatus: { findUnique: jest.fn() } };
    await new SalesMonthClosedGuard(off as never).canActivate(ctx(PREV, 'query', deoleo));
    const deoleoDown = { client: { findUnique: failing() }, salesImportApply: { findFirst: failing() }, salesMonthStatus: { findUnique: failing() } };
    await expect(new SalesMonthClosedGuard(deoleoDown as never).canActivate(ctx(PREV, 'query', deoleo))).resolves.toBe(true);
  });

  it('L3: once Sales Import is involved (flag ON, or importer data for the month), a failed month read fails CLOSED (503)', async () => {
    const on = { client: { findUnique: jest.fn(async () => ({ status: 'ACTIVE', features: { salesImport: true } })) }, salesImportApply: { findFirst: jest.fn() }, salesMonthStatus: { findUnique: failing() } };
    await expect(new SalesMonthClosedGuard(on as never).canActivate(ctx(PREV))).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(on.salesImportApply.findFirst).not.toHaveBeenCalled(); // flag ON → no need to look for applies
    const data = { client: { findUnique: failing() }, salesImportApply: { findFirst: jest.fn(async () => ({ id: 'a1' })) }, salesMonthStatus: { findUnique: failing() } };
    await expect(new SalesMonthClosedGuard(data as never).canActivate(ctx(PREV))).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('malformed period → allow (the route pipe rejects it)', async () => {
    await expect(guardWith({ salesImport: true }).guard.canActivate(ctx('2026-13'))).resolves.toBe(true);
  });

  it('is on export / commit / preview-report / payout-report and NOT on preview / simulate', () => {
    const guardsOf = (m: string) => Reflect.getMetadata(GUARDS_METADATA, (PointsComputeController.prototype as unknown as Record<string, object>)[m]) ?? [];
    for (const m of ['export', 'commit', 'previewReport', 'payoutReport']) expect(guardsOf(m)).toEqual([SalesMonthClosedGuard]);
    for (const m of ['preview', 'simulate']) expect(guardsOf(m)).toEqual([]);
  });
});

describe('Rebuild product list (§10c) + productListCurrent', () => {
  const HIST = (over: Record<string, unknown> = {}) => ({
    month: PREV, sourceImportId: 'imp9', appliedAt: AT, lineRows: 10, combosSourceImportId: 'imp9', combosAppliedAt: AT, ...over,
  });

  it('list: productListCurrent is false only for a month with history whose product list is not from that history', async () => {
    const current = await new SalesMonthsService(db([], { history: [HIST()] }) as never).list('t1');
    expect(current[1]).toEqual(expect.objectContaining({ hasHistory: true, productListCurrent: true }));
    expect(current[0]).toEqual(expect.objectContaining({ hasHistory: false, productListCurrent: true }));
    const stale = await new SalesMonthsService(db([], { history: [HIST({ combosSourceImportId: 'imp-OLD' })] }) as never).list('t1');
    expect(stale[1].productListCurrent).toBe(false);
    const missing = await new SalesMonthsService(db([], { history: [HIST({ combosSourceImportId: null, combosAppliedAt: null })] }) as never).list('t1');
    expect(missing[1].productListCurrent).toBe(false);
  });

  function rebuildDb(header: Record<string, unknown> | null, opts: { closed?: boolean; fail?: Error; purgedMeanwhile?: boolean } = {}) {
    const d = db(opts.closed ? [{ month: OLD, state: 'CLOSED', closedAt: AT, closedById: 'ca', lastAppliedAt: AT, lastAppliedImportId: 'imp9' }] : []);
    const order: string[] = [];
    d.$executeRawUnsafe = jest.fn(async (s: string) => { order.push(s); return 0; });
    d.$executeRaw = jest.fn(async (q: Prisma.Sql) => {
      if (opts.fail) throw opts.fail;
      const sql = q.strings.join('?');
      order.push(/pg_advisory_xact_lock/.test(sql) ? `lock:${q.values[0]}` : /^\s*DELETE/.test(sql) ? 'delete' : 'insert');
      return 42;
    });
    d.salesMonthHistorySet.findUnique = jest.fn(async () => header);
    d.salesMonthHistorySet.updateMany = jest.fn(async () => { order.push('stamp'); return { count: opts.purgedMeanwhile ? 0 : 1 }; });
    // the row is re-read AFTER the rebuild: the header then carries the stamp written by update()
    d.salesMonthHistorySet.findMany = jest.fn(async () => (header ? [HIST({ month: OLD })] : []));
    d.auditLog.create = jest.fn(async () => { order.push('audit'); return {}; });
    return { d, order };
  }

  it('rebuilds a CLOSED month too: timeout → month lock → DELETE + INSERT … SELECT from history → stamp → audit; no figures touched', async () => {
    const { d, order } = rebuildDb({ sourceImportId: 'imp9', appliedAt: AT, combosSourceImportId: 'imp-OLD', combosAppliedAt: AT }, { closed: true });
    const row = await new SalesMonthsService(d as never).rebuildProductList(clientAdmin, OLD);
    expect(order).toEqual([
      `SET LOCAL statement_timeout = ${REBUILD_PRODUCT_LIST_STATEMENT_TIMEOUT_MS}`,
      `lock:sales-month:t1:${OLD}`, 'delete', 'insert', 'stamp', 'audit',
    ]);
    const insert = d.$executeRaw.mock.calls.map((c: unknown[]) => c[0] as Prisma.Sql).find((q: Prisma.Sql) => /INSERT INTO "sales_month_history_combos"/.test(q.sql))!;
    expect(insert.sql).toMatch(/FROM "sales_month_histories" h/);
    expect(insert.values).toEqual(['imp9', AT.toISOString(), 't1', OLD]);
    expect(d.salesMonthHistorySet.updateMany).toHaveBeenCalledWith({
      where: { clientId: 't1', month: OLD }, data: { combosSourceImportId: 'imp9', combosAppliedAt: AT },
    });
    expect(d.auditLog.create.mock.calls[0][0].data).toEqual(expect.objectContaining({
      entityType: 'SALES_MONTH', entityId: `t1:${OLD}`, actorId: 'ca',
      newValues: expect.objectContaining({ action: 'rebuild-product-list', combos: 42, sourceImportId: 'imp9' }),
    }));
    expect(d.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: REBUILD_PRODUCT_LIST_TX_TIMEOUT_MS, maxWait: 10_000 });
    expect(REBUILD_PRODUCT_LIST_STATEMENT_TIMEOUT_MS).toBe(240_000);
    expect(REBUILD_PRODUCT_LIST_TX_TIMEOUT_MS).toBe(280_000);
    // side-effect-free on figures: no month state / achievement write
    expect(d.salesMonthStatus.upsert).not.toHaveBeenCalled();
    expect(row).toEqual(expect.objectContaining({ month: OLD, state: 'CLOSED', productListCurrent: true }));
  });

  it('no stored history → 404 (nothing deleted); a bad month → 400; the month busy past the wait → 409', async () => {
    const none = rebuildDb(null);
    await expect(new SalesMonthsService(none.d as never).rebuildProductList(clientAdmin, PREV)).rejects.toBeInstanceOf(NotFoundException);
    expect(none.order).not.toContain('delete');
    await expect(new SalesMonthsService(rebuildDb(null).d as never).rebuildProductList(clientAdmin, '2026-13')).rejects.toBeInstanceOf(BadRequestException);
    const busy = rebuildDb({ sourceImportId: 'imp9', appliedAt: AT }, { fail: new Error('canceling statement due to statement timeout') });
    await expect(new SalesMonthsService(busy.d as never).rebuildProductList(clientAdmin, PREV)).rejects.toBeInstanceOf(ConflictException);
  });

  it('L1 (switch ON): a month outside the retention window (current + 3 previous) → 404 with the reason, before any lock; a header purged meanwhile → 404 (rolled back)', () => withRetentionV2('on', async () => {
    const cutoff = historyCutoffMonth();
    expect(cutoff).toBe(shiftMonthKey(CUR, -3)); // computed from now: current month + the 3 before it are kept
    const old = rebuildDb({ sourceImportId: 'imp9', appliedAt: AT });
    await expect(new SalesMonthsService(old.d as never).rebuildProductList(clientAdmin, shiftMonthKey(cutoff, -1)))
      .rejects.toThrow(/kept only for the current month and the 3 months before it/);
    expect(old.d.$transaction).not.toHaveBeenCalled();
    const raced = rebuildDb({ sourceImportId: 'imp9', appliedAt: AT }, { purgedMeanwhile: true });
    await expect(new SalesMonthsService(raced.d as never).rebuildProductList(clientAdmin, PREV)).rejects.toBeInstanceOf(NotFoundException);
    expect(raced.order).toContain('stamp');
    expect(raced.order).not.toContain('audit'); // thrown before the audit → the whole tx rolls back
  }));

  it('controller: targets:upload, gate first (flag off → 403)', async () => {
    expect(Reflect.getMetadata(PERMISSION_KEY, SalesMonthsController.prototype.rebuildProductList)).toBe('targets:upload');
    const tenant = { resolveClient: jest.fn(async () => ({ features: {} })) };
    const prisma = { client: { findUnique: jest.fn(async () => ({ status: 'ACTIVE', features: {} })) } };
    const never = new Proxy({}, { get: () => () => { throw new Error('service must not be reached'); } });
    await expect(new SalesMonthsController(never as never, tenant as never, prisma as never, never as never, never as never, never as never).rebuildProductList(clientAdmin, PREV))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ─── FOCUS-FROM-TARGETS: targetsChangedSinceApply + "Accept — not sold yet" ─────────────────────────────────────

describe('FOCUS-FROM-TARGETS: months list flag + focus acceptances', () => {
  const BEFORE = new Date(AT.getTime() - 3_600_000);
  const AFTER = new Date(AT.getTime() + 3_600_000);
  const FOCUS_DEF = { clientId: 't1', kpiCode: 'FB1', enabled: true, productSource: 'TARGET_NAMES' };

  const NAMES = (name: string) => ({ FB1: 1000, __names: { FB1: name } });

  it('targetsChangedSinceApply: target ROWS written after the last apply → true; older → false; never applied → false (ONE GROUP BY, no N+1)', async () => {
    const OLDER = shiftMonthKey(CUR, -2);
    const d = db(
      [
        { month: PREV, state: 'OPEN', lastAppliedAt: AT, lastAppliedImportId: 'i1' },
        { month: OLDER, state: 'OPEN', lastAppliedAt: AT, lastAppliedImportId: 'i1' },
      ],
      {
        focusDefs: [FOCUS_DEF],
        targets: [
          { month: PREV, updatedAt: BEFORE }, { month: PREV, updatedAt: AFTER }, // the LATEST row write counts
          { month: OLDER, updatedAt: BEFORE },
          { month: CUR, updatedAt: AFTER }, // never applied
          { month: OLDER, updatedAt: AFTER, clientId: 't2' }, // another tenant's rows never count
        ],
      },
    );
    const rows = await new SalesMonthsService(d as never).list('t1', OLDER, CUR);
    const by = Object.fromEntries(rows.map((r) => [r.month, r.targetsChangedSinceApply]));
    expect(by).toEqual({ [CUR]: false, [PREV]: true, [OLDER]: false });
    expect(d.outletTarget.groupBy).toHaveBeenCalledTimes(1);
    expect(d.outletTarget.groupBy.mock.calls[0][0]).toEqual({
      by: ['month'], where: { clientId: 't1', month: { in: [OLDER, PREV, CUR] } }, _max: { updatedAt: true },
    });
  });

  it('audit follow-up (timing race): a chunk committed AFTER the apply is flagged even though its upload BATCH predates the apply', async () => {
    // The upload stamps its batch at BEFORE, the apply ran at AT reading the first chunk only, the last chunk's rows
    // were written at AFTER. Only the row times can tell.
    const d = db([{ month: PREV, state: 'OPEN', lastAppliedAt: AT, lastAppliedImportId: 'i1' }], {
      focusDefs: [FOCUS_DEF],
      targets: [{ month: PREV, updatedAt: BEFORE }, { month: PREV, updatedAt: AFTER }],
    });
    const rows = await new SalesMonthsService(d as never).list('t1', PREV, PREV);
    expect(rows[0].targetsChangedSinceApply).toBe(true);
  });

  it('audit follow-up (B-M1): without an enabled TARGET_NAMES KPI the flag is never set and the target table is not read', async () => {
    const d = db([{ month: PREV, state: 'OPEN', lastAppliedAt: AT, lastAppliedImportId: 'i1' }], {
      focusDefs: [{ clientId: 't1', kpiCode: 'TOTAL', enabled: true, productSource: 'FILTER' }, { ...FOCUS_DEF, enabled: false }, { ...FOCUS_DEF, clientId: 't2' }],
      targets: [{ month: PREV, updatedAt: AFTER }],
    });
    const rows = await new SalesMonthsService(d as never).list('t1', PREV, PREV);
    expect(rows[0].targetsChangedSinceApply).toBe(false);
    expect(d.outletTarget.groupBy).not.toHaveBeenCalled();
  });

  it('accept: OPEN month, enabled TARGET_NAMES KPI, key normalized; month lock; audited once (idempotent); returns the list', async () => {
    const d = db([], { focusDefs: [FOCUS_DEF], targets: [{ month: PREV, targetValues: NAMES('CNO & adho500') }] });
    const s = new SalesMonthsService(d as never);
    const out = await s.accept(clientAdmin, PREV, { kpiCode: 'FB1', key: ' adho 500 ' });
    expect(out).toEqual({ month: PREV, acceptances: [{ kpiCode: 'FB1', key: 'ADHO500', byName: 'Client Admin', at: AT.toISOString() }] });
    expect(d.log).toEqual([`lock:sales-month:t1:${PREV}`, 'acceptance.create', 'audit']);
    expect(d.salesFocusAcceptance.create.mock.calls[0][0].data).toEqual({ clientId: 't1', month: PREV, kpiCode: 'FB1', key: 'ADHO500', acceptedById: 'ca' });
    expect(d.auditLog.create.mock.calls[0][0].data).toEqual(expect.objectContaining({
      action: 'CREATE', entityType: 'SALES_FOCUS_ACCEPTANCE', actorId: 'ca', newValues: expect.objectContaining({ month: PREV, kpiCode: 'FB1', key: 'ADHO500' }),
    }));
    await s.accept(clientAdmin, PREV, { kpiCode: 'FB1', key: 'ADHO500' }); // again → no second row / audit
    expect(d.salesFocusAcceptance.create).toHaveBeenCalledTimes(1);
    expect(d.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('audit follow-up: accept refuses a key that is not a product name in THAT month’s target file for THAT KPI (400)', async () => {
    const d = db([], {
      focusDefs: [FOCUS_DEF],
      targets: [
        { month: PREV, targetValues: { ...NAMES('CNO & ADHO500'), __names: { FB1: 'CNO & ADHO500', FB2: 'NEWBRAND' } } },
        { month: CUR, targetValues: NAMES('NEWBRAND') }, // another month
        { month: PREV, targetValues: NAMES('NEWBRAND'), clientId: 't2' }, // another tenant
      ],
    });
    const s = new SalesMonthsService(d as never);
    await expect(s.accept(clientAdmin, PREV, { kpiCode: 'FB1', key: 'newbrand' })).rejects.toThrow(
      `"NEWBRAND" is not a product name in the ${monthLabel(PREV)} target file for Focus Brand 1.`,
    );
    await expect(s.accept(clientAdmin, PREV, { kpiCode: 'FB1', key: 'ADHO' })).rejects.toBeInstanceOf(BadRequestException); // a prefix is not a token
    expect(d.salesFocusAcceptance.create).not.toHaveBeenCalled();
    await expect(s.accept(clientAdmin, PREV, { kpiCode: 'FB1', key: 'adho 500' })).resolves.toEqual(
      expect.objectContaining({ acceptances: [expect.objectContaining({ key: 'ADHO500' })] }),
    );
  });

  it('accept refuses: CLOSED month (409), not a TARGET_NAMES KPI (400), bad key / month (400)', async () => {
    const closed = db([], { focusDefs: [FOCUS_DEF] });
    await expect(new SalesMonthsService(closed as never).accept(clientAdmin, OLD, { kpiCode: 'FB1', key: 'X' })).rejects.toBeInstanceOf(ConflictException);
    expect(closed.salesFocusAcceptance.create).not.toHaveBeenCalled();
    const s = new SalesMonthsService(db([], { focusDefs: [FOCUS_DEF, { clientId: 't1', kpiCode: 'TOTAL', enabled: true, productSource: 'FILTER' }] }) as never);
    await expect(s.accept(clientAdmin, PREV, { kpiCode: 'TOTAL', key: 'X' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.accept(clientAdmin, PREV, { kpiCode: 'NOPE', key: 'X' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.accept(clientAdmin, PREV, { kpiCode: 'FB1', key: '  ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.accept(clientAdmin, PREV, { kpiCode: 'FB1', key: 'CNO & ADHO500' })).rejects.toThrow(/ONE focus product/);
    await expect(s.accept(clientAdmin, 'bad', { kpiCode: 'FB1', key: 'X' })).rejects.toBeInstanceOf(BadRequestException);
    // another tenant's definition does not make the KPI acceptable here
    const foreign = new SalesMonthsService(db([], { focusDefs: [{ ...FOCUS_DEF, clientId: 't2' }] }) as never);
    await expect(foreign.accept(clientAdmin, PREV, { kpiCode: 'FB1', key: 'X' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('undo: removes only THIS tenant row, audited with the old values; idempotent; CLOSED month → 409', async () => {
    const rows = [
      { id: 'fa1', clientId: 't1', month: PREV, kpiCode: 'FB1', key: 'ZZZ', acceptedById: 'ca', acceptedAt: AT },
      { id: 'fa2', clientId: 't2', month: PREV, kpiCode: 'FB1', key: 'ZZZ', acceptedById: 'x', acceptedAt: AT },
    ];
    const d = db([], { focusDefs: [FOCUS_DEF], acceptances: rows });
    const s = new SalesMonthsService(d as never);
    expect((await s.listAcceptances('t1', PREV)).acceptances).toHaveLength(1);
    const out = await s.unaccept(clientAdmin, PREV, 'FB1', 'zzz');
    expect(out).toEqual({ month: PREV, acceptances: [] });
    expect(d.salesFocusAcceptance.rows.map((r: { id: string }) => r.id)).toEqual(['fa2']); // the other tenant's row stays
    expect(d.auditLog.create.mock.calls[0][0].data).toEqual(expect.objectContaining({
      action: 'DELETE', entityType: 'SALES_FOCUS_ACCEPTANCE', entityId: 'fa1', actorId: 'ca', oldValues: expect.objectContaining({ key: 'ZZZ', acceptedById: 'ca' }),
    }));
    await s.unaccept(clientAdmin, PREV, 'FB1', 'ZZZ');
    expect(d.auditLog.create).toHaveBeenCalledTimes(1);
    await expect(s.unaccept(clientAdmin, OLD, 'FB1', 'ZZZ')).rejects.toBeInstanceOf(ConflictException);
  });

  it('routes: POST / DELETE :month/focus-acceptances need targets:upload and pass the access gate first', async () => {
    const meta = (m: string) => Reflect.getMetadata(PERMISSION_KEY, (SalesMonthsController.prototype as unknown as Record<string, object>)[m]);
    expect(meta('acceptFocus')).toBe('targets:upload');
    expect(meta('unacceptFocus')).toBe('targets:upload');
    const tenant = { resolveClient: jest.fn(async () => ({ features: {} })) };
    const prisma = { client: { findUnique: jest.fn(async () => ({ status: 'ACTIVE', features: {} })) } };
    const never = new Proxy({}, { get: () => () => { throw new Error('service must not be reached'); } });
    const c = new SalesMonthsController(never as never, tenant as never, prisma as never, never as never, never as never, never as never);
    await expect(c.acceptFocus(clientAdmin, PREV, { kpiCode: 'FB1', key: 'X' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(c.unacceptFocus(clientAdmin, PREV, 'FB1', 'X')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('background jobs: Close / Reopen refused while an Apply / Recalculate of the month is active (owner 2026-11-18)', () => {
  const busy = { month: PREV, jobId: 'j1', kind: 'APPLY', status: 'RUNNING', importId: 'imp1', requestedByName: 'Ravi', createdAt: new Date('2026-11-18T05:02:00.000Z') };

  it('close → 409 "… is being applied by Ravi since 10:32 — try again when it finishes." and nothing is locked or written', async () => {
    const d = db([], { activeJobs: [busy] });
    const svc = new SalesMonthsService(d as never);
    await expect(svc.close(clientAdmin, PREV)).rejects.toThrow(new RegExp(`^${monthLabel(PREV)} is being applied by Ravi since (\\d+ \\w+, )?10:32 — try again when it finishes\\.$`));
    // final review L4: checked UNDER the month lock, in the transaction of the state change — and nothing is written
    expect(d.log).toEqual([`lock:sales-month:t1:${PREV}`]);
    expect(d.salesMonthStatus.upsert).not.toHaveBeenCalled();
  });

  it('reopen → the same 409 (recalculate wording for a RECALC job)', async () => {
    const d = db([{ clientId: 't1', month: OLD, state: 'CLOSED' }], { activeJobs: [{ ...busy, month: OLD, kind: 'RECALC' }] });
    const svc = new SalesMonthsService(d as never);
    await expect(svc.reopen(gifsyAssumed, OLD, { acknowledgeDownstream: true })).rejects.toThrow(new RegExp(`^${monthLabel(OLD)} is being recalculated by Ravi since (\\d+ \\w+, )?10:32 — try again when it finishes\\.$`));
  });

  it('the months list carries each month activeJob (null when none)', async () => {
    const d = db([], { activeJobs: [busy] });
    const rows = await new SalesMonthsService(d as never).list('t1', PREV, PREV);
    expect(rows[0].activeJob).toEqual({ jobId: 'j1', kind: 'APPLY', status: 'RUNNING', importId: 'imp1', requestedBy: 'Ravi', createdAt: '2026-11-18T05:02:00.000Z' });
    const none = await new SalesMonthsService(db() as never).list('t1', PREV, PREV);
    expect(none[0].activeJob).toBeNull();
    expect(none[0].lastJob).toBeNull();
  });

  it('B-H1: the months list carries each month latest FINISHED job (who / when / result) so a result never disappears', async () => {
    const fin = { month: PREV, jobId: 'j0', kind: 'APPLY', status: 'FAILED', importId: 'imp1', requestedByName: 'Ravi',
      createdAt: new Date('2026-11-18T05:02:00.000Z'), finishedAt: new Date('2026-11-18T05:04:00.000Z'), result: { month: PREV, ok: false, error: 'closed' } };
    const rows = await new SalesMonthsService(db([], { lastJobs: [fin] }) as never).list('t1', PREV, PREV);
    expect(rows[0].lastJob).toEqual({ jobId: 'j0', kind: 'APPLY', status: 'FAILED', importId: 'imp1', requestedBy: 'Ravi',
      createdAt: '2026-11-18T05:02:00.000Z', finishedAt: '2026-11-18T05:04:00.000Z', result: { month: PREV, ok: false, error: 'closed' } });
  });
});
