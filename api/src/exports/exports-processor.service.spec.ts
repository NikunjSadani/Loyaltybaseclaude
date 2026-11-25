import type { ModuleRef } from '@nestjs/core';
import type { ExportRequest } from '@prisma/client';
import type { Readable } from 'node:stream';
import * as XLSX from 'xlsx';
import type { PrismaService } from '../prisma/prisma.service';
import { WorkerStop, drainImports } from '../sales-import/ingest/worker-stop';
import type { StorageService } from '../storage/storage.service';
import { ConflictException } from '@nestjs/common';
import { ExportRefusedException, type AnyExportKind, type ExportRunContext } from './export-kinds';
import {
  EXPORT_FAILED_MESSAGE,
  EXPORT_GAVE_UP_MESSAGE,
  EXPORT_HEARTBEAT_MS,
  EXPORT_NEVER_STARTED_MESSAGE,
  EXPORT_UNKNOWN_KIND_MESSAGE,
} from './exports-engine.constants';
import { ExportsProcessorService, exportStorageKey } from './exports-processor.service';

const DAY = 86_400_000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UpdateArgs = { where: Record<string, any>; data: Record<string, any> };

function claimed(over: Partial<ExportRequest> = {}): ExportRequest {
  const t = new Date('2026-11-13T10:00:00Z');
  return {
    id: 'exp1',
    clientId: 'bajaj',
    requestedById: 'u1',
    kind: 'k',
    params: { months: 6 },
    actor: { role: 'GIFSY_ADMIN', clientId: 'bajaj', assumed: true, gifsyRoleId: null, vendorId: null, name: 'Op' },
    status: 'RUNNING',
    fileName: null,
    storagePath: null,
    sizeBytes: null,
    rowCount: null,
    error: null,
    attempts: 1,
    claimToken: 'tok-1',
    heartbeatAt: t,
    createdAt: t,
    startedAt: t,
    finishedAt: null,
    expiresAt: null,
    updatedAt: t,
    ...over,
  };
}

function makeKind(run: AnyExportKind['run']): AnyExportKind {
  return {
    kind: 'k',
    label: 'K',
    access: { roles: ['GIFSY_ADMIN'] },
    parseParams: (raw) => raw as Record<string, unknown>,
    isHeavy: () => true,
    describeParams: () => '',
    fileName: () => 'k report.xlsx',
    run,
  };
}

function setup(kind: AnyExportKind, opts: { heartbeatAlive?: () => boolean; finishCount?: number } = {}) {
  const uploads = new Map<string, Buffer>();
  const prisma = {
    $executeRaw: jest.fn(async () => ((opts.heartbeatAlive ?? (() => true))() ? 1 : 0)),
    exportRequest: {
      updateMany: jest.fn(async (_a: UpdateArgs) => ({ count: opts.finishCount ?? 1 })),
      findMany: jest.fn(async () => []),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
  };
  const storage = {
    uploadStream: jest.fn(async (key: string, source: Readable) => {
      const chunks: Buffer[] = [];
      for await (const c of source) chunks.push(c as Buffer);
      uploads.set(key, Buffer.concat(chunks));
      return `gs://${key}`;
    }),
    deleteFile: jest.fn(async () => undefined),
  };
  const proc = new ExportsProcessorService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    {} as ModuleRef,
    new Map([[kind.kind, kind]]),
  );
  return { proc, prisma, storage, uploads };
}

describe('ExportsProcessorService.processClaimed', () => {
  afterEach(() => jest.useRealTimers());

  it('runs the kind straight into storage → READY with size, rows, 7-day expiry; ctx = actor snapshot at request time', async () => {
    let seen: ExportRunContext | undefined;
    const kind = makeKind(async (ctx, _p, out) => {
      seen = ctx;
      const s = await out.addSheet('Data', ['Code', 'Note']);
      for (let i = 0; i < 2500; i++) await s.addRow([`C${i}`, i === 7 ? '=cmd()' : 'ok']);
      return { rowCount: 2500 };
    });
    const { proc, prisma, uploads } = setup(kind);
    const before = Date.now();
    expect(await proc.processClaimed(claimed())).toBe('finished');

    const key = exportStorageKey(claimed(), 'k report.xlsx');
    expect(key).toBe('exports/bajaj/exp1/tok-1/k_report.xlsx');
    const buf = uploads.get(key)!;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(XLSX.read(buf, { type: 'buffer' }).Sheets.Data, { header: 1 });
    expect(rows.length).toBe(2501);
    expect(rows[8]).toEqual(['C7', "'=cmd()"]);

    const finish = prisma.exportRequest.updateMany.mock.calls.at(-1)![0];
    expect(finish.where).toEqual({ id: 'exp1', status: 'RUNNING', claimToken: 'tok-1' });
    expect(finish.data).toMatchObject({ status: 'READY', storagePath: key, rowCount: 2500, sizeBytes: BigInt(buf.length), claimToken: null });
    const exp = (finish.data.expiresAt as Date).getTime();
    expect(exp).toBeGreaterThanOrEqual(before + 7 * DAY - 1000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 7 * DAY);

    expect(seen!.clientId).toBe('bajaj');
    expect(seen!.user).toMatchObject({ sub: 'u1', role: 'GIFSY_ADMIN', clientId: 'bajaj', assumed: true });
    expect(seen!.now).toEqual(claimed().createdAt);
    // Real exceljs stream → upload → SheetJS read-back of 2,500 rows: explicit headroom for a loaded full-suite run.
  }, 30_000);

  it('a failing report → FAILED with a plain message; partial file deleted', async () => {
    const { proc, prisma, storage } = setup(makeKind(async () => { throw new Error('relation "x" does not exist'); }));
    expect(await proc.processClaimed(claimed())).toBe('finished');
    expect(prisma.exportRequest.updateMany.mock.calls.at(-1)![0].data).toMatchObject({ status: 'FAILED', error: EXPORT_FAILED_MESSAGE });
    expect(storage.deleteFile).toHaveBeenCalledWith('exports/bajaj/exp1/tok-1/k_report.xlsx');
  });

  it('a DELIBERATE refusal (ExportRefusedException) → FAILED with ITS message for the Downloads page; ctx carries the request id', async () => {
    let seenId: string | undefined;
    const msg = '3 outlets will read visibility = NOT approved for 2026-10 … Tick "I accept" on the preview to continue.';
    const { proc, prisma, storage } = setup(
      makeKind(async (ctx) => {
        seenId = ctx.requestId;
        throw new ExportRefusedException(msg);
      }),
    );
    expect(await proc.processClaimed(claimed())).toBe('finished');
    expect(seenId).toBe('exp1');
    expect(prisma.exportRequest.updateMany.mock.calls.at(-1)![0].data).toMatchObject({ status: 'FAILED', error: msg });
    expect(storage.deleteFile).toHaveBeenCalled();
    // Any OTHER HttpException keeps the generic message (opt-in only).
    const other = setup(makeKind(async () => { throw new ConflictException('internal detail'); }));
    await other.proc.processClaimed(claimed());
    expect(other.prisma.exportRequest.updateMany.mock.calls.at(-1)![0].data).toMatchObject({ status: 'FAILED', error: EXPORT_FAILED_MESSAGE });
  });

  it('unknown kind → FAILED; attempts over the limit → FAILED (gave up), report never run', async () => {
    const run = jest.fn();
    const a = setup(makeKind(run));
    expect(await a.proc.processClaimed(claimed({ kind: 'gone' }))).toBe('finished');
    expect(a.prisma.exportRequest.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'FAILED', error: EXPORT_UNKNOWN_KIND_MESSAGE });
    expect(await a.proc.processClaimed(claimed({ attempts: 4 }))).toBe('finished');
    expect(a.prisma.exportRequest.updateMany.mock.calls[1][0].data).toMatchObject({ status: 'FAILED', error: EXPORT_GAVE_UP_MESSAGE });
    expect(run).not.toHaveBeenCalled();
  });

  it('heartbeats while running; a lost claim (heartbeat matches no row) stops the run → superseded, nothing written', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    let alive = true;
    let rowsAfterLoss = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const kind = makeKind(async (_c, _p, out) => {
      const s = await out.addSheet('S', ['A']);
      await gate;
      for (let i = 0; i < 1000; i++) {
        await s.addRow([i]);
        rowsAfterLoss++;
      }
      return { rowCount: 1000 };
    });
    const { proc, prisma, storage } = setup(kind, { heartbeatAlive: () => alive });
    const p = proc.processClaimed(claimed());
    await new Promise((r) => setImmediate(r));
    jest.advanceTimersByTime(EXPORT_HEARTBEAT_MS);
    await new Promise((r) => setImmediate(r));
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    alive = false;
    jest.advanceTimersByTime(EXPORT_HEARTBEAT_MS);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    release();
    expect(await p).toBe('superseded');
    expect(rowsAfterLoss).toBe(0);
    expect(prisma.exportRequest.updateMany).not.toHaveBeenCalled();
    expect(storage.deleteFile).toHaveBeenCalled();
  });

  it('SIGTERM mid-run → claim released to QUEUED; an early stop does not count the attempt; drain claims nothing more', async () => {
    const stop = new WorkerStop();
    const kind = makeKind(async (_c, _p, out) => {
      const s = await out.addSheet('S', ['A']);
      for (let i = 0; i < 5000; i++) {
        if (i === 100) stop.request('SIGTERM');
        await s.addRow([i]);
      }
      return { rowCount: 5000 };
    });
    const { proc, prisma } = setup(kind);
    const rows = [claimed({ attempts: 2 }), claimed({ id: 'exp2' })];
    const claimNext = jest.spyOn(proc, 'claimNext').mockImplementation(async () => rows.shift() ?? null);
    const result = await drainImports(proc, stop);
    expect(result).toEqual({ finished: 0, released: 1, superseded: 0 });
    expect(claimNext).toHaveBeenCalledTimes(1);
    const rel = prisma.exportRequest.updateMany.mock.calls.at(-1)![0];
    expect(rel.where).toEqual({ id: 'exp1', status: 'RUNNING', claimToken: 'tok-1' });
    expect(rel.data).toMatchObject({ status: 'QUEUED', claimToken: null, attempts: 1 });
  });

  it('claim superseded at the final write → the uploaded file is deleted', async () => {
    const kind = makeKind(async (_c, _p, out) => {
      await (await out.addSheet('S', ['A'])).addRow([1]);
      return { rowCount: 1 };
    });
    const { proc, storage } = setup(kind, { finishCount: 0 });
    expect(await proc.processClaimed(claimed())).toBe('superseded');
    expect(storage.deleteFile).toHaveBeenCalledWith('exports/bajaj/exp1/tok-1/k_report.xlsx');
  });

  it('a superseded attempt deletes ONLY its own object — never the file a newer attempt wrote and marked READY', async () => {
    const kind = makeKind(async (_c, _p, out) => {
      await (await out.addSheet('S', ['A'])).addRow([1]);
      return { rowCount: 1 };
    });
    // Attempt B (newer claim) finishes READY first.
    const b = setup(kind);
    expect(await b.proc.processClaimed(claimed({ claimToken: 'tok-B', attempts: 2 }))).toBe('finished');
    const readyKey = b.prisma.exportRequest.updateMany.mock.calls.at(-1)![0].data.storagePath as string;
    // Attempt A (old, stale claim) reaches its final write → superseded → cleans up.
    const a = setup(kind, { finishCount: 0 });
    expect(await a.proc.processClaimed(claimed({ claimToken: 'tok-A' }))).toBe('superseded');
    const deleted = a.storage.deleteFile.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(readyKey).toBe('exports/bajaj/exp1/tok-B/k_report.xlsx');
    expect(deleted).toEqual(['exports/bajaj/exp1/tok-A/k_report.xlsx']);
    expect(deleted).not.toContain(readyKey);
  });

  it('the storage upload fails mid-run → the writer stops at once and the request is FAILED promptly (not RUNNING until timeout)', async () => {
    let rows = 0;
    const kind = makeKind(async (_c, _p, out) => {
      const s = await out.addSheet('S', ['A', 'B']);
      for (let i = 0; i < 200_000; i++) {
        await s.addRow([i, 'x'.repeat(50)]);
        rows++;
      }
      return { rowCount: rows };
    });
    const { proc, prisma, storage } = setup(kind);
    storage.uploadStream.mockImplementation(async (_key: string, source: Readable) => {
      await new Promise((r) => source.once('data', r)); // GCS accepted the first bytes…
      throw new Error('GCS 503 backend error'); // …then the upload broke
    });
    const t0 = Date.now();
    expect(await proc.processClaimed(claimed())).toBe('finished');
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(rows).toBeLessThan(200_000);
    expect(prisma.exportRequest.updateMany.mock.calls.at(-1)![0].data).toMatchObject({ status: 'FAILED', error: EXPORT_FAILED_MESSAGE });
    expect(storage.deleteFile).toHaveBeenCalledWith('exports/bajaj/exp1/tok-1/k_report.xlsx');
  }, 30_000);

  it('parses the STORED RAW params exactly once (a strict kind that refuses its own parsed output still runs)', async () => {
    const seen: unknown[] = [];
    const strict: AnyExportKind = {
      ...makeKind(async (_c, p, out) => {
        seen.push(p);
        await out.addSheet('S', ['A']);
        return { rowCount: 0 };
      }),
      // Accepts only the raw input shape; its output carries a key it would itself refuse.
      parseParams: (raw) => {
        const r = raw as Record<string, unknown>;
        if ('platformWide' in r) throw new Error('unknown field platformWide');
        return { months: Number(r.months), platformWide: true };
      },
    };
    const { proc, prisma } = setup(strict);
    expect(await proc.processClaimed(claimed({ params: { months: '6', requestOrigin: 'https://api.gifsy.in' } }))).toBe('finished');
    expect(seen).toEqual([{ months: 6, platformWide: true }]);
    expect(prisma.exportRequest.updateMany.mock.calls.at(-1)![0].data.status).toBe('READY');
  });
});

describe('ExportsProcessorService.sweep (retention)', () => {
  function sweepSetup(due: Array<{ id: string; storagePath: string | null }>, deleteErr?: (key: string) => Error | null) {
    const prisma = {
      exportRequest: {
        findMany: jest.fn(async (args: { where: { status?: string } }) => (args.where.status === 'READY' ? due : [{ id: 'old1' }, { id: 'old2' }])),
        updateMany: jest.fn(async () => ({ count: 1 })),
        deleteMany: jest.fn(async () => ({ count: 2 })),
      },
    };
    const storage = {
      deleteFile: jest.fn(async (key: string) => {
        const e = deleteErr?.(key);
        if (e) throw e;
      }),
    };
    const proc = new ExportsProcessorService(prisma as unknown as PrismaService, storage as unknown as StorageService, {} as ModuleRef, new Map());
    return { proc, prisma, storage };
  }

  it('READY past expiry → file deleted then EXPIRED; already-gone file still expires; other delete errors retry later', async () => {
    const { proc, prisma, storage } = sweepSetup(
      [
        { id: 'r1', storagePath: 'exports/a/r1/x.xlsx' },
        { id: 'r2', storagePath: 'exports/a/r2/x.xlsx' },
        { id: 'r3', storagePath: 'exports/a/r3/x.xlsx' },
      ],
      (key) => (key.includes('r2') ? Object.assign(new Error('Not found'), { code: 404 }) : key.includes('r3') ? new Error('timeout') : null),
    );
    const now = new Date('2026-11-20T00:00:00Z');
    const out = await proc.sweep({ now });
    expect(storage.deleteFile).toHaveBeenCalledTimes(3);
    const expiredIds = prisma.exportRequest.updateMany.mock.calls
      .map((c) => (c as unknown as [{ where: { id?: string }; data: { status: string } }])[0])
      .filter((a) => a.data.status === 'EXPIRED')
      .map((a) => a.where.id);
    expect(expiredIds).toEqual(['r1', 'r2']);
    expect(out.expired).toBe(2);
    expect(prisma.exportRequest.findMany.mock.calls[0][0]).toMatchObject({ where: { status: 'READY', expiresAt: { lt: now } } });
  });

  it('QUEUED for over 24 h → FAILED (never started); rows over 30 days (EXPIRED/FAILED) purged', async () => {
    const { proc, prisma } = sweepSetup([]);
    const now = new Date('2026-11-20T00:00:00Z');
    const out = await proc.sweep({ now });
    const gaveUp = prisma.exportRequest.updateMany.mock.calls
      .map((c) => (c as unknown as [{ where: { status: string; createdAt: { lt: Date } }; data: { error?: string } }])[0])
      .find((a) => a.where.status === 'QUEUED')!;
    expect(gaveUp.where.createdAt.lt).toEqual(new Date(now.getTime() - DAY));
    expect(gaveUp.data.error).toBe(EXPORT_NEVER_STARTED_MESSAGE);
    const purgeQuery = prisma.exportRequest.findMany.mock.calls[1][0] as unknown as { where: { createdAt: { lt: Date }; status: { in: string[] } } };
    expect(purgeQuery.where.createdAt.lt).toEqual(new Date(now.getTime() - 30 * DAY));
    expect(purgeQuery.where.status.in).toEqual(['EXPIRED', 'FAILED']);
    expect(prisma.exportRequest.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['old1', 'old2'] } } });
    expect(out).toEqual({ expired: 0, gaveUp: 1, purged: 2 });
  });

  it('never throws (DB down)', async () => {
    const prisma = { exportRequest: { findMany: jest.fn(async () => { throw new Error('db down'); }) } };
    const proc = new ExportsProcessorService(prisma as unknown as PrismaService, {} as StorageService, {} as ModuleRef, new Map());
    await expect(proc.sweep()).resolves.toEqual({ expired: 0, gaveUp: 0, purged: 0 });
  });
});
