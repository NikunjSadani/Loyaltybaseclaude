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
import { heavyOpLimiter } from '../common/heavy-op-limiter';
import type { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from '../storage/storage.service';
import type { TenantService } from '../tenant/tenant.service';
import { ExportAccessChecker } from './export-access';
import type { AnyExportKind } from './export-kinds';
import { EXPORT_NOT_CONFIGURED_MESSAGE, EXPORT_QUEUED_MESSAGE, EXPORT_TOO_MANY_ACTIVE_MESSAGE } from './exports-engine.constants';
import type { ExportsRunnerService } from './exports-runner.service';
import { ExportsService, EXPORT_REQUEST_ORIGIN_PARAM } from './exports.service';

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

function makePrisma(rows: ExportRequest[] = []) {
  const prisma = {
    rows,
    $queryRaw: jest.fn(async () => [{ '?column?': 1 }]),
    exportRequest: {
      count: jest.fn(async ({ where }: { where: { requestedById: string; status: { in: string[] } } }) =>
        prisma.rows.filter((r) => r.requestedById === where.requestedById && where.status.in.includes(r.status)).length,
      ),
      create: jest.fn(async ({ data }: { data: Partial<ExportRequest> }) => {
        const r = row({ ...data, id: `new${prisma.rows.length}`, status: 'QUEUED' } as Partial<ExportRequest>);
        prisma.rows.push(r);
        return { id: r.id };
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => prisma.rows.find((r) => r.id === where.id) ?? null),
      findMany: jest.fn(async ({ where, take }: { where: { requestedById: string; clientId: string }; take: number }) =>
        prisma.rows
          .filter((r) => r.requestedById === where.requestedById && r.clientId === where.clientId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, take),
      ),
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
  };
  return prisma;
}

function makeService(opts: { rows?: ExportRequest[]; configured?: boolean } = {}) {
  const prisma = makePrisma(opts.rows ?? []);
  const storage = { openReadStream: jest.fn(() => new PassThrough()) };
  const runner = { isConfigured: jest.fn(() => opts.configured ?? true), kick: jest.fn(async () => 'job') };
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
  );
  return { svc, prisma, storage, runner };
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
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

// ─── tests ─────────────────────────────────────────────────────────────────────────────────────
describe('ExportsService.respond', () => {
  beforeEach(() => {
    delete process.env.RBAC_ENFORCEMENT;
    (testKind.run as jest.Mock).mockClear();
  });

  it('light request → streams the xlsx instantly (cell-safe), holds then releases a heavy-op slot', async () => {
    const { svc, prisma } = makeService();
    const res = new FakeRes();
    const before = heavyOpLimiter.inUse;
    const out = await svc.respond(res as unknown as Response, admin, 'test-report', { months: '2' });
    expect(out).toBeInstanceOf(StreamableFile);
    expect(heavyOpLimiter.inUse).toBe(before + 1);
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
    expect(heavyOpLimiter.inUse).toBe(before);
  });

  it('light request on a busy instance → 503 + Retry-After, nothing run', async () => {
    const { svc } = makeService();
    const held = [heavyOpLimiter.tryAcquire('t1'), heavyOpLimiter.tryAcquire('t2')];
    try {
      const res = new FakeRes();
      await expect(svc.respond(res as unknown as Response, admin, 'test-report', {})).rejects.toBeInstanceOf(HttpException);
      expect(res.headers['Retry-After']).toBeDefined();
      expect(testKind.run).not.toHaveBeenCalled();
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
    const before = heavyOpLimiter.inUse;
    const file = (await svc.respond(res as unknown as Response, admin, 'test-report', {})) as StreamableFile;
    file.getStream().resume();
    await new Promise((r) => setTimeout(r, 50));
    expect(rowsWritten).toBeLessThan(100);
    expect(heavyOpLimiter.inUse).toBe(before);
  });

  it('heavy request → 202 + queued row (actor snapshot, server origin) + worker kicked', async () => {
    const { svc, prisma, runner } = makeService();
    const res = new FakeRes();
    const out = await svc.respond(res as unknown as Response, admin, 'test-report', { months: '6', requestOrigin: 'https://evil.example' });
    expect(res.statusCode).toBe(202);
    expect(out).toEqual({ exportRequestId: 'new0', message: EXPORT_QUEUED_MESSAGE });
    const data = prisma.exportRequest.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ clientId: 'bajaj', requestedById: admin.sub, kind: 'test-report', status: 'QUEUED' });
    expect(data.params).toEqual({ months: 6, requestOrigin: 'https://api.gifsy.in' });
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

  it('3-active cap → 409 on the 4th, under the per-user advisory lock; other users unaffected', async () => {
    const { svc, prisma } = makeService();
    for (let i = 0; i < 3; i++) await svc.request(admin, 'test-report', { months: '6' });
    const err = await svc.request(admin, 'test-report', { months: '6' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).message).toBe(EXPORT_TOO_MANY_ACTIVE_MESSAGE);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4); // lock taken on every attempt
    await expect(svc.request(otherAdmin, 'test-report', { months: '6' })).resolves.toMatchObject({ exportRequestId: expect.any(String) });
    // finished ones don't count
    prisma.rows.filter((r) => r.requestedById === admin.sub).forEach((r) => (r.status = 'READY'));
    await expect(svc.request(admin, 'test-report', { months: '6' })).resolves.toBeDefined();
  });
});

describe('ExportsService — Downloads page', () => {
  it('list: only the caller’s own rows in their tenant, newest first, mapped to the DTO', async () => {
    const t0 = Date.now();
    const rows = [
      row({ id: 'a', createdAt: new Date(t0 - 3000) }),
      row({ id: 'b', createdAt: new Date(t0 - 1000), status: 'FAILED', error: 'nope', storagePath: null }),
      row({ id: 'c', requestedById: otherAdmin.sub }),
      row({ id: 'd', clientId: 'deoleo' }),
    ];
    const { svc, prisma } = makeService({ rows });
    const list = await svc.list(admin);
    expect(prisma.exportRequest.findMany.mock.calls[0][0].where).toEqual({ requestedById: admin.sub, clientId: 'bajaj' });
    expect(list.items.map((i) => i.id)).toEqual(['b', 'a']);
    expect(list.items[0]).toMatchObject({ label: 'Test report', paramsSummary: '6 months', status: 'FAILED', error: 'nope' });
    expect(list.items[1]).toMatchObject({ status: 'READY', sizeBytes: 1234, error: null });
    expect(list.nextCursor).toBeNull();
  });

  it('list self-heals a request stuck in QUEUED (kicks the worker)', async () => {
    const { svc, runner } = makeService({ rows: [row({ status: 'QUEUED', createdAt: new Date(Date.now() - 10 * 60_000) })] });
    await svc.list(admin);
    await new Promise((r) => setImmediate(r));
    expect(runner.kick).toHaveBeenCalledTimes(1);
  });

  it('download: owner gets the stored file streamed (never buffered) with the right headers', async () => {
    const { svc, storage } = makeService({ rows: [row()] });
    const file = await svc.download(admin, 'exp1');
    expect(storage.openReadStream).toHaveBeenCalledWith('exports/bajaj/exp1/test-report.xlsx');
    expect(file.getHeaders().length).toBe(1234);
    expect(String(file.getHeaders().disposition)).toContain('test-report.xlsx');
  });

  it('download: same-tenant admin with the same access may download another user’s file', async () => {
    const { svc } = makeService({ rows: [row()] });
    await expect(svc.download(otherAdmin, 'exp1')).resolves.toBeInstanceOf(StreamableFile);
    await expect(svc.download(assumedOwner, 'exp1')).resolves.toBeInstanceOf(StreamableFile);
  });

  it('download: cross-tenant → 404; same tenant without access → 404; unknown id → 404', async () => {
    const { svc } = makeService({ rows: [row()] });
    await expect(svc.download(deoleoAdmin, 'exp1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.download(user('GIFSY_ADMIN', { sub: 'home-owner', clientId: 'gifsy' }), 'exp1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.download(sales, 'exp1')).rejects.toBeInstanceOf(NotFoundException);
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
});
