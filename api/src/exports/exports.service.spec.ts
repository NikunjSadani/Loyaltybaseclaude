import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import type { ExportRequest } from '@prisma/client';
import type { Response } from 'express';
import { EventEmitter } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import * as XLSX from 'xlsx';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { heavyOpLimiter, instantExportLimiter, INSTANT_EXPORT_MAX_CONCURRENT } from '../common/heavy-op-limiter';
import type { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from '../storage/storage.service';
import type { TenantService } from '../tenant/tenant.service';
import { ExportAccessChecker } from './export-access';
import type { AnyExportKind } from './export-kinds';
import {
  EXPORT_ALREADY_QUEUED_MESSAGE,
  EXPORT_COULD_NOT_START_MESSAGE,
  EXPORT_INSTANT_IDLE_MS,
  EXPORT_NOT_CONFIGURED_MESSAGE,
  EXPORT_QUEUED_MESSAGE,
  EXPORT_STUCK_QUEUED_MS,
  EXPORT_TOO_MANY_ACTIVE_MESSAGE,
} from './exports-engine.constants';
import type { ExportsProcessorService } from './exports-processor.service';
import type { ExportsRunnerService } from './exports-runner.service';
import { ExportsService, EXPORT_REQUEST_ORIGIN_PARAM, externalOrigin } from './exports.service';

// ─── fixtures ──────────────────────────────────────────────────────────────────────────────────
interface P {
  months: number;
  requestOrigin?: string;
}
const testKind: AnyExportKind = {
  kind: 'test-report',
  label: 'Test report',
  access: { roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'reports:export' },
  parseParams(raw: unknown): P {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (r.months !== undefined && !/^\d+$/.test(String(r.months))) throw new BadRequestException('Months must be a number.');
    return { months: Number(r.months ?? 1), requestOrigin: r[EXPORT_REQUEST_ORIGIN_PARAM] as string };
  },
  isHeavy: (p: P) => p.months > 3,
  describeParams: (p: P) => `${p.months} months`,
  fileName: () => 'test-report.xlsx',
  run: jest.fn(async (_ctx, _p, out) => {
    const s = await out.addSheet('Rows', ['Code', 'Value']);
    await s.addRow(['A1', 1]);
    await s.addRow(['=HYPERLINK("x")', 2]);
    return { rowCount: 2 };
  }),
};
const gifsyOnlyKind: AnyExportKind = { ...testKind, kind: 'gifsy-only', label: 'Gifsy only', access: { roles: ['GIFSY_ADMIN'] } };
const registry = new Map<string, AnyExportKind>([
  [testKind.kind, testKind],
  [gifsyOnlyKind.kind, gifsyOnlyKind],
]);

const user = (role: string, extra: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: `u-${role}-${extra.clientId ?? 'bajaj'}`,
  role,
  clientId: 'bajaj',
  phone: '',
  name: role,
  ...extra,
});
const admin = user('CLIENT_ADMIN');
const otherAdmin = { ...user('CLIENT_ADMIN'), sub: 'u-other-admin' };
const sales = user('SALES_USER');
const assumedOwner = user('GIFSY_ADMIN', { assumed: true, sub: 'u-owner' });
const deoleoAdmin = user('CLIENT_ADMIN', { clientId: 'deoleo' });

function row(over: Partial<ExportRequest> = {}): ExportRequest {
  const now = new Date();
  return {
    id: 'exp1',
    clientId: 'bajaj',
    requestedById: admin.sub,
    kind: 'test-report',
    params: { months: 6 },
    actor: { role: 'CLIENT_ADMIN', clientId: 'bajaj', assumed: false },
    status: 'READY',
    fileName: 'test-report.xlsx',
    storagePath: 'exports/bajaj/exp1/test-report.xlsx',
    sizeBytes: BigInt(1234),
    rowCount: 2,
    error: null,
    attempts: 1,
    claimToken: null,
    heartbeatAt: null,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
    updatedAt: now,
    ...over,
  };
}

type Where = {
  id?: { in: string[] };
  status?: string;
  requestedById?: string;
  clientId?: string;
  OR?: Array<{ status: string; createdAt?: { gte: Date } }>;
};
function matchWhere(r: ExportRequest, w: Where): boolean {
  if (w.id && !w.id.in.includes(r.id)) return false;
  if (w.status && r.status !== w.status) return false;
  if (w.requestedById && r.requestedById !== w.requestedById) return false;
  if (w.clientId && r.clientId !== w.clientId) return false;
  if (w.OR && !w.OR.some((o) => r.status === o.status && (!o.createdAt || r.createdAt >= o.createdAt.gte))) return false;
  return true;
}

function makePrisma(rows: ExportRequest[] = []) {
  const prisma = {
    rows,
    $queryRaw: jest.fn(async () => [{ '?column?': 1 }]),
    exportRequest: {
      create: jest.fn(async ({ data }: { data: Partial<ExportRequest> }) => {
        const r = row({ ...data, id: `new${prisma.rows.length}`, status: 'QUEUED', createdAt: new Date() } as Partial<ExportRequest>);
        prisma.rows.push(r);
        return { id: r.id };
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => prisma.rows.find((r) => r.id === where.id) ?? null),
      findMany: jest.fn(async ({ where, take }: { where: Where; take?: number }) =>
        prisma.rows
          .filter((r) => matchWhere(r, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, take ?? undefined),
      ),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Partial<ExportRequest> }) => {
        const hit = prisma.rows.filter((r) => matchWhere(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
  };
  return prisma;
}

function makeService(opts: { rows?: ExportRequest[]; configured?: boolean; kick?: string } = {}) {
  const prisma = makePrisma(opts.rows ?? []);
  const storage = { openReadStream: jest.fn(() => new PassThrough()) };
  const runner = { isConfigured: jest.fn(() => opts.configured ?? true), kick: jest.fn(async () => opts.kick ?? 'job') };
  const processor = { sweep: jest.fn(async () => ({ expired: 0, gaveUp: 0, purged: 0 })) };
  const access = new ExportAccessChecker(
    { getPermissions: async () => new Set() } as unknown as GifsyRoleService,
    { isFeatureEnabled: async () => false } as unknown as TenantService,
  );
  const svc = new ExportsService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    {} as ModuleRef,
    access,
    runner as unknown as ExportsRunnerService,
    registry,
    processor as unknown as ExportsProcessorService,
  );
  return { svc, prisma, storage, runner, processor };
}

class FakeRes extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  writableFinished = false;
  req = { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'api.gifsy.in' } };
  status(c: number) {
    this.statusCode = c;
    return this;
  }
  setHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  destroyed = false;
  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

// ─── tests ─────────────────────────────────────────────────────────────────────────────────────
const tick = () => new Promise((r) => setImmediate(r));

describe('ExportsService.respond', () => {
  beforeEach(() => {
    delete process.env.RBAC_ENFORCEMENT;
    (testKind.run as jest.Mock).mockClear();
  });

  it('light request → streams the xlsx instantly (cell-safe) in an INSTANT-export slot (never a heavy-op slot)', async () => {
    const { svc, prisma } = makeService();
    const res = new FakeRes();
    const before = instantExportLimiter.inUse;
    const heavyBefore = heavyOpLimiter.inUse;
    const out = await svc.respond(res as unknown as Response, admin, 'test-report', { months: '2' });
    expect(out).toBeInstanceOf(StreamableFile);
    expect(instantExportLimiter.inUse).toBe(before + 1);
    expect(heavyOpLimiter.inUse).toBe(heavyBefore); // slow light clients can never block heavy routes
    const file = out as StreamableFile;
    expect(file.getHeaders().type).toContain('spreadsheetml');
    expect(String(file.getHeaders().disposition)).toContain('test-report.xlsx');
    const buf = await readAll(file.getStream());
    const sheet = XLSX.read(buf, { type: 'buffer' }).Sheets.Rows;
    expect(XLSX.utils.sheet_to_json(sheet, { header: 1 })).toEqual([['Code', 'Value'], ['A1', 1], ["'=HYPERLINK(\"x\")", 2]]);
    // server-set origin reached the kind; nothing was queued
    const runArgs = (testKind.run as jest.Mock).mock.calls[0];
    expect(runArgs[1].requestOrigin).toBe('https://api.gifsy.in');
    expect(runArgs[0].clientId).toBe('bajaj');
    expect(prisma.exportRequest.create).not.toHaveBeenCalled();
    res.writableFinished = true;
    res.emit('close');
    expect(instantExportLimiter.inUse).toBe(before);
  });

  it('light request with every instant slot taken → 503 + Retry-After, nothing run; heavy-op slots stay free', async () => {
    const { svc } = makeService();
    const held = Array.from({ length: INSTANT_EXPORT_MAX_CONCURRENT }, (_, i) => instantExportLimiter.tryAcquire(`t${i}`));
    try {
      const res = new FakeRes();
      await expect(svc.respond(res as unknown as Response, admin, 'test-report', {})).rejects.toBeInstanceOf(HttpException);
      expect(res.headers['Retry-After']).toBeDefined();
      expect(testKind.run).not.toHaveBeenCalled();
      expect(heavyOpLimiter.inUse).toBe(0);
    } finally {
      held.forEach((r) => r?.());
    }
  });

  it('client abort mid-stream stops the run at its next row and frees the slot', async () => {
    const { svc } = makeService();
    let rowsWritten = 0;
    (testKind.run as jest.Mock).mockImplementationOnce(async (_c, _p, out) => {
      const s = await out.addSheet('Rows', ['A']);
      for (let i = 0; i < 100_000; i++) {
        await s.addRow([i]);
        rowsWritten++;
        if (i === 10) res.emit('close'); // browser went away
      }
      return { rowCount: rowsWritten };
    });
    const res = new FakeRes();
    const before = instantExportLimiter.inUse;
    const file = (await svc.respond(res as unknown as Response, admin, 'test-report', {})) as StreamableFile;
    file.getStream().resume();
    await new Promise((r) => setTimeout(r, 50));
    expect(rowsWritten).toBeLessThan(100);
    expect(instantExportLimiter.inUse).toBe(before);
  });

  it('client abort while the writer is BLOCKED on backpressure (nobody reading) → the data stream is destroyed and the run ends', async () => {
    const { svc } = makeService();
    let settled: 'ok' | 'error' | null = null;
    let rowsWritten = 0;
    (testKind.run as jest.Mock).mockImplementationOnce(async (_c, _p, out) => {
      try {
        const s = await out.addSheet('Rows', ['A', 'B']);
        for (let i = 0; i < 500_000; i++) {
          await s.addRow([i, 'x'.repeat(200)]);
          rowsWritten++;
        }
        settled = 'ok';
        return { rowCount: rowsWritten };
      } catch (e) {
        settled = 'error';
        throw e;
      }
    });
    const res = new FakeRes();
    const before = instantExportLimiter.inUse;
    const file = (await svc.respond(res as unknown as Response, admin, 'test-report', {})) as StreamableFile;
    // Never read the stream → the writer blocks waiting for 'drain'.
    await new Promise((r) => setTimeout(r, 200));
    const stalledAt = rowsWritten;
    expect(stalledAt).toBeLessThan(500_000);
    res.emit('close');
    for (let i = 0; i < 50 && settled === null; i++) await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe('error');
    expect(file.getStream().destroyed).toBe(true);
    expect(instantExportLimiter.inUse).toBe(before);
  }, 20_000);

  it('a stalled instant download (no progress for the idle limit) is aborted: slot freed, response destroyed', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const { svc } = makeService();
      (testKind.run as jest.Mock).mockImplementationOnce(async (_c, _p, out) => {
        await out.addSheet('Rows', ['A']);
        await new Promise(() => undefined); // a query / client that never moves again
        return { rowCount: 0 };
      });
      const res = new FakeRes();
      const before = instantExportLimiter.inUse;
      await svc.respond(res as unknown as Response, admin, 'test-report', {});
      await tick();
      expect(instantExportLimiter.inUse).toBe(before + 1);
      jest.advanceTimersByTime(EXPORT_INSTANT_IDLE_MS + 60_000);
      await tick();
      expect(instantExportLimiter.inUse).toBe(before);
      expect(res.destroyed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('heavy request → 202 + queued row storing the RAW params (+ server origin) + actor snapshot + worker kicked', async () => {
    const { svc, prisma, runner } = makeService();
    const res = new FakeRes();
    const out = await svc.respond(res as unknown as Response, admin, 'test-report', { months: '6', requestOrigin: 'https://evil.example' });
    expect(res.statusCode).toBe(202);
    expect(out).toEqual({ exportRequestId: 'new0', message: EXPORT_QUEUED_MESSAGE });
    const data = prisma.exportRequest.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ clientId: 'bajaj', requestedById: admin.sub, kind: 'test-report', status: 'QUEUED' });
    // RAW (string '6', not the parsed number) — the worker parses this exact input once.
    expect(data.params).toEqual({ months: '6', requestOrigin: 'https://api.gifsy.in' });
    expect(data.actor).toEqual({ role: 'CLIENT_ADMIN', clientId: 'bajaj', assumed: false, gifsyRoleId: null, vendorId: null, name: 'CLIENT_ADMIN' });
    expect(runner.kick).toHaveBeenCalled();
    expect(testKind.run).not.toHaveBeenCalled();
  });

  it('assumed operator queues in the ASSUMED tenant with assumed=true on the actor', async () => {
    const { svc, prisma } = makeService();
    await svc.respond(new FakeRes() as unknown as Response, assumedOwner, 'test-report', { months: '12' });
    const data = prisma.exportRequest.create.mock.calls[0][0].data;
    expect(data.clientId).toBe('bajaj');
    expect((data.actor as { assumed: boolean }).assumed).toBe(true);
  });

  it('rejects: unknown kind 400, bad params 400, wrong role 403', async () => {
    const { svc } = makeService();
    const res = new FakeRes() as unknown as Response;
    await expect(svc.respond(res, admin, 'nope', {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.respond(res, admin, 'test-report', { months: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.respond(res, sales, 'test-report', {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.request(admin, 'gifsy-only', {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('heavy request with no runner configured → 503 plain message, nothing queued or built', async () => {
    const { svc, prisma } = makeService({ configured: false });
    const err = await svc.respond(new FakeRes() as unknown as Response, admin, 'test-report', { months: '6' }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(503);
    expect((err as HttpException).message).toBe(EXPORT_NOT_CONFIGURED_MESSAGE);
    expect(prisma.exportRequest.create).not.toHaveBeenCalled();
    expect(testKind.run).not.toHaveBeenCalled();
  });

  it('the worker cannot be started (IAM 403 / job missing / network) → that request is FAILED at once + 503 plain message', async () => {
    const { svc, prisma } = makeService({ kick: 'none' });
    const err = await svc.respond(new FakeRes() as unknown as Response, admin, 'test-report', { months: '6' }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(503);
    expect((err as HttpException).message).toBe(EXPORT_COULD_NOT_START_MESSAGE);
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]).toMatchObject({ status: 'FAILED', error: EXPORT_COULD_NOT_START_MESSAGE });
    expect(prisma.exportRequest.updateMany.mock.calls[0][0].where).toMatchObject({ status: 'QUEUED' }); // a claimed row is left alone
  });

  it('3-active cap → 409 on the 4th, under the per-user advisory lock; other users unaffected; finished ones don’t count', async () => {
    const { svc, prisma } = makeService();
    for (let i = 0; i < 3; i++) await svc.request(admin, 'test-report', { months: String(6 + i) });
    const err = await svc.request(admin, 'test-report', { months: '9' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).message).toBe(EXPORT_TOO_MANY_ACTIVE_MESSAGE);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4); // lock taken on every attempt
    await expect(svc.request(otherAdmin, 'test-report', { months: '6' })).resolves.toMatchObject({ exportRequestId: expect.any(String) });
    prisma.rows.filter((r) => r.requestedById === admin.sub).forEach((r) => (r.status = 'READY'));
    await expect(svc.request(admin, 'test-report', { months: '9' })).resolves.toBeDefined();
  });

  it('the cap is PER TENANT: an operator with 3 active in one tenant can still queue in another', async () => {
    const { svc } = makeService();
    const opBajaj = user('GIFSY_ADMIN', { assumed: true, sub: 'u-op' });
    const opDeoleo = user('GIFSY_ADMIN', { assumed: true, sub: 'u-op', clientId: 'deoleo' });
    for (let i = 0; i < 3; i++) await svc.request(opBajaj, 'test-report', { months: String(6 + i) });
    await expect(svc.request(opBajaj, 'test-report', { months: '9' })).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.request(opDeoleo, 'test-report', { months: '6' })).resolves.toMatchObject({ exportRequestId: expect.any(String) });
  });

  it('a request QUEUED longer than the stuck threshold does not count toward the cap', async () => {
    const old = new Date(Date.now() - EXPORT_STUCK_QUEUED_MS - 60_000);
    const rows = [0, 1, 2].map((i) =>
      row({ id: `stuck${i}`, status: 'QUEUED', createdAt: old, params: { months: String(20 + i) }, storagePath: null }),
    );
    const { svc } = makeService({ rows });
    await expect(svc.request(admin, 'test-report', { months: '6' })).resolves.toMatchObject({ message: EXPORT_QUEUED_MESSAGE });
  });

  it('de-duplicates: the same user + tenant + report + filters already QUEUED/RUNNING → that request’s id (same 202 shape), nothing new', async () => {
    const { svc, prisma, runner } = makeService();
    const first = await svc.request(admin, 'test-report', { months: '6' });
    runner.kick.mockClear();
    // Same filters, different spelling (number vs string) and a forged origin → still the same file.
    const again = await svc.respond(new FakeRes() as unknown as Response, admin, 'test-report', { months: 6, requestOrigin: 'https://x.example' });
    expect(again).toEqual({ exportRequestId: first.exportRequestId, message: EXPORT_ALREADY_QUEUED_MESSAGE });
    expect(prisma.exportRequest.create).toHaveBeenCalledTimes(1);
    expect(runner.kick).not.toHaveBeenCalled();
    // Different filters → a new request; another user / tenant → never de-duplicated against this one.
    await expect(svc.request(admin, 'test-report', { months: '7' })).resolves.not.toMatchObject({ exportRequestId: first.exportRequestId });
    await expect(svc.request(otherAdmin, 'test-report', { months: '6' })).resolves.not.toMatchObject({ exportRequestId: first.exportRequestId });
    // Once it is READY a fresh request is created.
    prisma.rows.find((r) => r.id === first.exportRequestId)!.status = 'READY';
    await expect(svc.request(admin, 'test-report', { months: '6' })).resolves.toMatchObject({ message: EXPORT_QUEUED_MESSAGE });
  });

  it('requestOrigin: a forwarded host outside the platform domain is ignored (falls back to the real host)', () => {
    expect(externalOrigin({ headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'bajajloyalty.gifsy.in' } })).toBe('https://bajajloyalty.gifsy.in');
    expect(externalOrigin({ headers: { 'x-forwarded-host': 'gifsy.in' } })).toBe('https://gifsy.in');
    expect(externalOrigin({ headers: { 'x-forwarded-host': 'evil.example', host: 'gifsy-api-xyz.a.run.app' } })).toBe('https://gifsy-api-xyz.a.run.app');
    expect(externalOrigin({ headers: { 'x-forwarded-host': 'gifsy.in.evil.example', host: 'api.gifsy.in' } })).toBe('https://api.gifsy.in');
    expect(externalOrigin({ headers: { 'x-forwarded-proto': 'javascript', 'x-forwarded-host': 'a"b.gifsy.in', host: 'localhost:4000' } })).toBe('https://localhost:4000');
    const prev = process.env.PLATFORM_DOMAIN;
    process.env.PLATFORM_DOMAIN = 'example.org';
    try {
      expect(externalOrigin({ headers: { 'x-forwarded-host': 'api.gifsy.in', host: 'api.example.org' } })).toBe('https://api.example.org');
    } finally {
      if (prev === undefined) delete process.env.PLATFORM_DOMAIN;
      else process.env.PLATFORM_DOMAIN = prev;
    }
  });
});

describe('ExportsService — Downloads page', () => {
  it('list: only the caller’s own rows in their tenant, newest first; summary parsed from the stored RAW params', async () => {
    const t0 = Date.now();
    const rows = [
      row({ id: 'a', createdAt: new Date(t0 - 3000), params: { months: '6', requestOrigin: 'https://api.gifsy.in' } }),
      row({ id: 'b', createdAt: new Date(t0 - 1000), status: 'FAILED', error: 'nope', storagePath: null }),
      row({ id: 'c', requestedById: otherAdmin.sub }),
      row({ id: 'd', clientId: 'deoleo' }),
    ];
    const { svc, prisma } = makeService({ rows });
    const list = await svc.list(admin);
    expect(prisma.exportRequest.findMany.mock.calls[0][0].where).toEqual({ requestedById: admin.sub, clientId: 'bajaj' });
    expect(list.items.map((i) => i.id)).toEqual(['b', 'a']);
    expect(list.items[0]).toMatchObject({ label: 'Test report', paramsSummary: '6 months', status: 'FAILED', error: 'nope' });
    expect(list.items[1]).toMatchObject({ status: 'READY', sizeBytes: 1234, error: null, paramsSummary: '6 months' });
    expect(list.nextCursor).toBeNull();
  });

  it('list runs the retention sweep from the API (even when the worker can never start) — at most once per interval', async () => {
    const { svc, processor } = makeService();
    await svc.list(admin);
    await svc.list(admin);
    await tick();
    expect(processor.sweep).toHaveBeenCalledTimes(1);
  });

  it('list self-heals a request stuck in QUEUED (kicks the worker)', async () => {
    const { svc, runner, prisma } = makeService({ rows: [row({ status: 'QUEUED', createdAt: new Date(Date.now() - 10 * 60_000) })] });
    await svc.list(admin);
    await tick();
    expect(runner.kick).toHaveBeenCalledTimes(1);
    expect(prisma.rows[0].status).toBe('QUEUED');
  });

  it('self-heal kick fails → the caller’s waiting requests are FAILED with the plain message (never stuck "Waiting to start")', async () => {
    const waiting = row({ id: 'w', status: 'QUEUED', createdAt: new Date(Date.now() - 10 * 60_000), storagePath: null });
    const fresh = row({ id: 'f', status: 'QUEUED', createdAt: new Date(), storagePath: null });
    const { svc, prisma } = makeService({ rows: [waiting, fresh], kick: 'none' });
    await svc.list(admin);
    await tick();
    await tick();
    expect(prisma.rows.find((r) => r.id === 'w')).toMatchObject({ status: 'FAILED', error: EXPORT_COULD_NOT_START_MESSAGE });
    expect(prisma.rows.find((r) => r.id === 'f')!.status).toBe('QUEUED'); // only the ones that triggered the heal
  });

  it('download: the requester gets the stored file streamed (never buffered) with the right headers', async () => {
    const { svc, storage } = makeService({ rows: [row()] });
    const file = await svc.download(admin, 'exp1');
    expect(storage.openReadStream).toHaveBeenCalledWith('exports/bajaj/exp1/test-report.xlsx');
    expect(file.getHeaders().length).toBe(1234);
    expect(String(file.getHeaders().disposition)).toContain('test-report.xlsx');
  });

  it('download / get: ONLY the requester — another same-tenant admin or an operator gets 404 (never revealing it exists)', async () => {
    const { svc } = makeService({ rows: [row()] });
    await expect(svc.download(otherAdmin, 'exp1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.download(assumedOwner, 'exp1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.get(otherAdmin, 'exp1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('an un-assumed owner’s ALL-TENANT file (clientId gifsy) is not downloadable by un-assumed GIFSY_STAFF in the same "gifsy" tenant', async () => {
    const owner = user('GIFSY_ADMIN', { sub: 'u-owner-home', clientId: 'gifsy' });
    const staff = user('GIFSY_STAFF', { sub: 'u-staff', clientId: 'gifsy', gifsyRoleId: 'r1' });
    const allTenants = row({ id: 'all', clientId: 'gifsy', requestedById: owner.sub, kind: 'gifsy-only' });
    const { svc } = makeService({ rows: [allTenants] });
    await expect(svc.download(staff, 'all')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.download(owner, 'all')).resolves.toBeInstanceOf(StreamableFile);
  });

  it('download: cross-tenant → 404; the requester whose access was revoked → 403; unknown id → 404', async () => {
    const { svc } = makeService({ rows: [row(), row({ id: 's', requestedById: sales.sub })] });
    await expect(svc.download(deoleoAdmin, 'exp1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.download(user('GIFSY_ADMIN', { sub: admin.sub, clientId: 'gifsy' }), 'exp1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.download(sales, 's')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.download(admin, 'missing')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.get(deoleoAdmin, 'exp1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('download: not ready → 409, failed → 409 with its reason, expired → 410', async () => {
    const { svc } = makeService({
      rows: [
        row({ id: 'q', status: 'QUEUED', storagePath: null }),
        row({ id: 'f', status: 'FAILED', error: 'We could not prepare this file.', storagePath: null }),
        row({ id: 'e', status: 'EXPIRED', storagePath: null }),
        row({ id: 'late', expiresAt: new Date(Date.now() - 1000) }),
      ],
    });
    await expect(svc.download(admin, 'q')).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.download(admin, 'f')).rejects.toThrow('We could not prepare this file.');
    await expect(svc.download(admin, 'e')).rejects.toBeInstanceOf(GoneException);
    await expect(svc.download(admin, 'late')).rejects.toBeInstanceOf(GoneException);
  });

  it('download: the storage stream breaks mid-file → the response is DESTROYED (never ended normally as a complete file)', async () => {
    const { svc } = makeService({ rows: [row()] });
    const file = await svc.download(admin, 'exp1');
    const response = { destroyed: false, headersSent: true, end: jest.fn(), destroy: jest.fn(), send: jest.fn(), statusCode: 200 };
    file.errorHandler(new Error('socket hang up'), response as unknown as Response);
    expect(response.destroy).toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
  });
});
