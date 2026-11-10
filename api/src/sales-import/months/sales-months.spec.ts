import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException, type ExecutionContext } from '@nestjs/common';
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
import { SalesMonthsService } from './sales-months.service';
import { SalesMonthClosedGuard } from './sales-month-closed.guard';
import { shiftMonthKey } from './month-state';

const CUR = currentMonthKey();
const PREV = shiftMonthKey(CUR, -1);
const OLD = shiftMonthKey(CUR, -3);
const AT = new Date();

const clientAdmin: JwtPayload = { sub: 'ca', role: 'CLIENT_ADMIN', clientId: 't1', phone: '', name: 'CA' };
const gifsyAssumed: JwtPayload = { sub: 'ga', role: 'GIFSY_ADMIN', clientId: 't1', phone: '', name: 'GA', assumed: true };

function db(rows: Array<Record<string, unknown>> = [], downstream: { batches?: Array<{ period: string; n: number }>; exports?: Array<{ month: string; n: number }>; history?: Array<Record<string, unknown>> } = {}) {
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
    creditBatch: { groupBy: jest.fn(async () => (downstream.batches ?? []).map((b) => ({ period: b.period, _count: { _all: b.n } }))) },
    salesMonthHistorySet: { findMany: jest.fn(async () => (downstream.history ?? []) as Array<Record<string, unknown>>) },
    // the LINE table must never be read for month lists (final check H1)
    salesMonthHistory: { findMany: jest.fn(() => { throw new Error('month lists must not read history lines'); }) },
    user: { findMany: jest.fn(async () => [{ id: 'ca', name: 'Client Admin' }]) },
    $executeRaw: jest.fn(async (q: Prisma.Sql) => { log.push(`lock:${q.values[0]}`); return 1; }),
  };
  d.$transaction = jest.fn(async (cb: (tx: unknown) => unknown) => cb(d));
  return d;
}

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
    expect(q).toEqual({ where: { clientId: 't1', month: { in: expect.arrayContaining([PREV, CUR]) } }, select: { month: true, sourceImportId: true, appliedAt: true } });
    expect(q.distinct).toBeUndefined();
    expect(d.salesMonthHistory.findMany).not.toHaveBeenCalled();
    await expect(new SalesMonthsService(d as never).list('t1', '2026-13')).rejects.toBeInstanceOf(BadRequestException);
  });
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
    ['apply preview', () => new SalesImportApplyController(never as never, never as never, tenant as never, prisma as never).getPreview(clientAdmin, 'x')],
    ['apply apply', () => new SalesImportApplyController(never as never, never as never, tenant as never, prisma as never).postApply(clientAdmin, 'x', {} as never)],
    ['months close', () => new SalesMonthsController(never as never, tenant as never, prisma as never, never as never).close(clientAdmin, PREV)],
    ['months recalculate preview', () => new SalesMonthsController(never as never, tenant as never, prisma as never, never as never).recalcPreview(clientAdmin, PREV)],
    ['months recalculate', () => new SalesMonthsController(never as never, tenant as never, prisma as never, never as never).recalculate(clientAdmin, PREV, {} as never)],
    ['months reopen', () => new SalesMonthsController(never as never, tenant as never, prisma as never, never as never).reopen(gifsyAssumed, OLD)],
  ])('%s → 403 for a tenant without the flag (Deoleo)', async (_n, call) => {
    await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reopen by an un-assumed GIFSY_ADMIN → 400 at the gate', async () => {
    const c = new SalesMonthsController(never as never, tenant as never, prisma as never, never as never);
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
