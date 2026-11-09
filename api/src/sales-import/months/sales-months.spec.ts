import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, type ExecutionContext } from '@nestjs/common';
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

function db(rows: Array<Record<string, unknown>> = []) {
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
    auditLog: { create: jest.fn(async () => { log.push('audit'); return {}; }) },
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

  it('list: default last 6 months newest first, with resolved states', async () => {
    const d = db([{ month: PREV, state: 'CLOSED', closedAt: AT, closedById: 'ca', lastAppliedAt: AT, lastAppliedImportId: 'imp1' }]);
    const rows = await new SalesMonthsService(d as never).list('t1');
    expect(rows.map((r) => r.month)).toEqual([0, -1, -2, -3, -4, -5].map((n) => shiftMonthKey(CUR, n)));
    expect(rows[0]).toEqual(expect.objectContaining({ state: 'OPEN', canClose: false }));
    expect(rows[1]).toEqual(expect.objectContaining({ state: 'CLOSED', closedBy: 'Client Admin', lastAppliedImportId: 'imp1', canReopen: true }));
    expect(rows[2]).toEqual(expect.objectContaining({ state: 'CLOSED', implicit: true }));
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
  ])('%p.%s requires %s (D-5)', (cls, m, perm) => expect(meta(PERMISSION_KEY, cls as never, m as string)).toBe(perm));
});

describe('controllers call the access gate FIRST (flag off → 403, nothing else runs)', () => {
  const tenant = { resolveClient: jest.fn(async () => ({ features: {} })) };
  const prisma = { client: { findUnique: jest.fn(async () => ({ status: 'ACTIVE', features: {} })) } };
  const never = new Proxy({}, { get: () => () => { throw new Error('service must not be reached'); } });

  it.each([
    ['config getProfile', () => new SalesImportConfigController(never as never, never as never, tenant as never, prisma as never).getProfile(clientAdmin)],
    ['config createKpi', () => new SalesImportConfigController(never as never, never as never, tenant as never, prisma as never).createKpi(clientAdmin, {} as never)],
    ['apply preview', () => new SalesImportApplyController(never as never, never as never, tenant as never, prisma as never).getPreview(clientAdmin, 'x')],
    ['apply apply', () => new SalesImportApplyController(never as never, never as never, tenant as never, prisma as never).postApply(clientAdmin, 'x', {} as never)],
    ['months close', () => new SalesMonthsController(never as never, tenant as never, prisma as never).close(clientAdmin, PREV)],
    ['months reopen', () => new SalesMonthsController(never as never, tenant as never, prisma as never).reopen(gifsyAssumed, OLD)],
  ])('%s → 403 for a tenant without the flag (Deoleo)', async (_n, call) => {
    await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reopen by an un-assumed GIFSY_ADMIN → 400 at the gate', async () => {
    const c = new SalesMonthsController(never as never, tenant as never, prisma as never);
    await expect(c.reopen({ ...gifsyAssumed, clientId: 'gifsy', assumed: false }, OLD)).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── D-1 guard (K-8) ─────────────────────────────────────────────────────────

describe('SalesMonthClosedGuard (D-1)', () => {
  function guardWith(features: Record<string, unknown> | null, override: Record<string, unknown> | null = null) {
    const prisma = {
      client: { findUnique: jest.fn(async () => (features === null ? null : { status: 'ACTIVE', features })) },
      salesMonthStatus: { findUnique: jest.fn(async () => override) },
    };
    return { guard: new SalesMonthClosedGuard(prisma as never), prisma };
  }
  const ctx = (period: unknown, where: 'body' | 'query' = 'query', user: JwtPayload = clientAdmin) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user, body: where === 'body' ? { period } : {}, query: where === 'query' ? { period } : {} }) }) }) as unknown as ExecutionContext;

  it('flag OFF (Deoleo) → allow, and the month table is never read', async () => {
    const { guard, prisma } = guardWith({ walletModule: true });
    await expect(guard.canActivate(ctx(CUR))).resolves.toBe(true);
    expect(prisma.salesMonthStatus.findUnique).not.toHaveBeenCalled();
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

  it('flag read failure fails CLOSED to "flag off" → allow (never blocks Deoleo on a DB hiccup)', async () => {
    const prisma = { client: { findUnique: jest.fn(async () => { throw new Error('db'); }) }, salesMonthStatus: { findUnique: jest.fn() } };
    await expect(new SalesMonthClosedGuard(prisma as never).canActivate(ctx(CUR))).resolves.toBe(true);
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
