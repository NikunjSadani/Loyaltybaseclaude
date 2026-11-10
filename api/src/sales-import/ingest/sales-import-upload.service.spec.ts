import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';
import type { SalesImport } from '@prisma/client';
import * as XLSX from 'xlsx';
import {
  SALES_IMPORT_MAX_FILE_BYTES,
  SALES_IMPORT_MAX_INFLIGHT_UPLOADS,
  SALES_IMPORT_PART_SIZE,
  SALES_IMPORT_RETENTION_DAYS,
  SALES_IMPORT_STALE_HEARTBEAT_MINUTES,
} from '../sales-import.contract';
import { partKey } from './parts-file';
import { sheetjsWorkbook } from './test-fixtures.testspec';
import { SalesImportRetentionService } from './sales-import-retention.service';
import { SalesImportUploadService } from './sales-import-upload.service';

const USER = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 't1', phone: '', name: 'Admin' };
const OTHER = { ...USER, clientId: 't2' };
const P = SALES_IMPORT_PART_SIZE;
const MIN = 60_000;

/** In-memory SalesImport table + bucket + row locks, scoped like Prisma / Postgres would be. */
function harness() {
  const rows = new Map<string, SalesImport>();
  const objects = new Map<string, Buffer>();
  const audits: Array<Record<string, unknown>> = [];
  let applies: Array<{ importId: string }> = [];
  /** ids whose row another transaction holds (a NOWAIT lock fails with 55P03). */
  const held = new Set<string>();
  const lockModes: string[] = [];
  const cmp = (val: unknown, v: unknown): boolean => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as Record<string, unknown>;
      if ('not' in o) return val !== o.not;
      if ('notIn' in o) return !(o.notIn as unknown[]).includes(val);
      if ('in' in o) return (o.in as unknown[]).includes(val);
      if ('lt' in o) return (val as Date) < (o.lt as Date);
      if ('gte' in o) return (val as Date) >= (o.gte as Date);
    }
    return val === v;
  };
  const matches = (r: SalesImport, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => cmp((r as unknown as Record<string, unknown>)[k], v));
  const apply = (r: SalesImport, data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) {
      (r as unknown as Record<string, unknown>)[k] = v && typeof v === 'object' && (v as { constructor?: { name?: string } }).constructor?.name === 'DbNull' ? null : v;
    }
  };
  const salesImport = {
    create: jest.fn(async ({ data }: { data: Partial<SalesImport> }) => {
      const r = {
        partsReceived: 0, bytesRead: 0n, rowsRead: 0, rowsSkipped: 0, attempts: 0, error: null, duplicateOfId: null,
        detectedHeaders: null, monthSummaries: null, errorSamples: null, dimensionValues: null, dimensionCombos: null,
        claimToken: null, heartbeatAt: null, purgedAt: null, filesPurgedAt: null, queuedAt: null, processingVersion: 0,
        mappingFingerprint: null, reprocessedFromId: null,
        finishedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data,
      } as SalesImport;
      rows.set(r.id, r);
      return r;
    }),
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => [...rows.values()].find((r) => matches(r, where)) ?? null),
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...rows.values()].filter((r) => matches(r, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())),
    count: jest.fn(async ({ where }: { where: Record<string, unknown> }) => [...rows.values()].filter((r) => matches(r, where)).length),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = rows.get(where.id)!;
      apply(r, data);
      return r;
    }),
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const r of rows.values()) if (matches(r, where)) (apply(r, data), count++);
      return { count };
    }),
  };
  const order: string[] = [];
  let profile: Record<string, unknown> | null = null;
  const prisma = {
    salesImport,
    salesImportProfile: { findUnique: jest.fn(async () => (profile ? { columnMapping: profile } : null)) },
    salesImportAggregate: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    salesImportApply: {
      count: jest.fn(async ({ where }: { where: { importId: string } }) => applies.filter((a) => a.importId === where.importId).length),
      groupBy: jest.fn(async ({ where }: { where: { importId: { in: string[] } } }) =>
        [...new Set(applies.filter((a) => where.importId.in.includes(a.importId)).map((a) => a.importId))].map((importId) => ({ importId }))),
    },
    auditLog: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => (audits.push(data), data)) },
    salesMonthHistory: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    salesMonthHistorySet: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    salesMonthHistoryCombo: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1', name: 'Admin' }]) },
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn(async (q: { strings: string[]; values: unknown[] }) => {
      const sql = q.strings.join('?');
      const [id, clientId] = q.values as [string, string];
      lockModes.push(/FOR (KEY SHARE|SHARE|UPDATE NOWAIT|UPDATE)/.exec(sql)?.[1] ?? '?');
      if (held.has(id) && sql.includes('NOWAIT')) throw Object.assign(new Error('could not obtain lock on row'), { code: 'P2010', meta: { code: '55P03' } });
      const r = rows.get(id);
      return r && r.clientId === clientId ? [{ ...r }] : [];
    }),
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      order.push('tx:start');
      try {
        return await fn(prisma);
      } finally {
        order.push('tx:end');
      }
    }),
  };
  const storage = {
    uploadFile: jest.fn(async (buf: Buffer, key: string) => {
      order.push('gcs:upload');
      objects.set(key, buf);
      return key;
    }),
    deleteFile: jest.fn(async (key: string) => void objects.delete(key)),
    listPrefix: jest.fn(async (prefix: string) =>
      [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([name, b]) => ({ name, size: b.length }))),
    deletePrefix: jest.fn(async (prefix: string) => {
      order.push('gcs:deletePrefix');
      for (const k of [...objects.keys()]) if (k.startsWith(prefix)) objects.delete(k);
    }),
    copyFile: jest.fn(async (from: string, to: string) => {
      order.push('gcs:copy');
      const b = objects.get(from);
      if (!b) throw new Error(`No such object: ${from}`);
      objects.set(to, Buffer.from(b));
    }),
    openReadStream: jest.fn((key: string, range?: { start: number; end: number }) => {
      const b = objects.get(key) ?? Buffer.alloc(0);
      return Readable.from([range ? b.subarray(range.start, range.end + 1) : b]);
    }),
  };
  const runner = { kick: jest.fn().mockResolvedValue('inline') };
  const retention = new SalesImportRetentionService(prisma as never, storage as never);
  const svc = new SalesImportUploadService(prisma as never, storage as never, runner as never, retention);
  const part = (b: Buffer | string) => ({ buffer: Buffer.from(b), size: Buffer.from(b).length });
  const setApplies = (a: Array<{ importId: string }>) => (applies = a);
  const setProfile = (m: Record<string, unknown> | null) => (profile = m);
  return { svc, prisma, storage, runner, rows, objects, part, audits, held, lockModes, setApplies, retention, order, setProfile };
}

describe('SalesImportUploadService — upload', () => {
  it('createUpload: plans 4 MiB parts under sales-imports/<client>/<id>/, stores the basename, audits', async () => {
    const h = harness();
    const r = await h.svc.createUpload(USER, { filename: 'C:\\fakepath\\Sales Nov.XLSX', sizeBytes: 2 * P + 1 });
    expect(r).toEqual({ importId: expect.any(String), partSize: P, partCount: 3 });
    const row = h.rows.get(r.importId)!;
    expect(row).toMatchObject({ clientId: 't1', uploadedById: 'u1', originalFilename: 'Sales Nov.XLSX', fileKind: 'XLSX', status: 'UPLOADING', partCount: 3 });
    expect(row.gcsPrefix).toBe(`sales-imports/t1/${r.importId}/`);
    expect(h.audits[0]).toMatchObject({ action: 'CREATE', entityType: 'SALES_IMPORT', entityId: r.importId, newValues: expect.objectContaining({ action: 'create-upload' }) });
  });

  it.each([
    [{ filename: 'data.xls', sizeBytes: 10 }, 'Upload a .xlsx or .csv'],
    [{ filename: '.csv', sizeBytes: 10 }, 'Upload a .xlsx or .csv'],
    [{ filename: 'a.csv', sizeBytes: 0 }, 'empty'],
    [{ filename: 'a.csv', sizeBytes: SALES_IMPORT_MAX_FILE_BYTES + 1 }, 'limit'],
  ])('createUpload rejects %p', async (body, msg) => {
    await expect(harness().svc.createUpload(USER, body)).rejects.toThrow(msg);
  });

  it('S5: at most SALES_IMPORT_MAX_INFLIGHT_UPLOADS uploads in flight per tenant; abandoned (> 24 h) ones are cancelled + purged first', async () => {
    const h = harness();
    const ids: string[] = [];
    for (let i = 0; i < SALES_IMPORT_MAX_INFLIGHT_UPLOADS; i++) ids.push((await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 3 })).importId);
    await expect(h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 3 })).rejects.toBeInstanceOf(ConflictException);
    await expect(h.svc.createUpload(OTHER, { filename: 'a.csv', sizeBytes: 3 })).resolves.toBeDefined(); // per tenant
    h.rows.get(ids[0])!.createdAt = new Date(Date.now() - 25 * 3_600_000);
    h.objects.set(partKey(`sales-imports/t1/${ids[0]}/`, 0), Buffer.from('abc'));
    await expect(h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 3 })).resolves.toBeDefined();
    expect(h.rows.get(ids[0])).toMatchObject({ status: 'CANCELLED', purgedAt: expect.any(Date) });
    expect(h.objects.size).toBe(0);
  });

  async function started(h: ReturnType<typeof harness>, filename: string, content: Buffer) {
    const { importId, partCount } = await h.svc.createUpload(USER, { filename, sizeBytes: content.length });
    return { id: importId, partCount };
  }

  it('putPart: idempotent per n (a retried part overwrites, the count does not double); NO transaction around GCS (M1)', async () => {
    const h = harness();
    const { id } = await started(h, 'a.csv', Buffer.from('a,b\n1,2\n'));
    h.prisma.$transaction.mockClear();
    await expect(h.svc.putPart(USER, id, '0', h.part('a,b\n1,2\n'))).resolves.toEqual({ partsReceived: 1 });
    await expect(h.svc.putPart(USER, id, '0', h.part('a,b\n1,2\n'))).resolves.toEqual({ partsReceived: 1 });
    expect(h.storage.uploadFile).toHaveBeenCalledTimes(2);
    expect(h.objects.has(partKey(`sales-imports/t1/${id}/`, 0))).toBe(true);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.lockModes).toEqual([]);
    // the partsReceived write is guarded by the state
    expect(h.prisma.salesImport.updateMany.mock.calls.at(-1)![0].where).toEqual({ id, clientId: 't1', status: 'UPLOADING' });
  });

  it('M1/L2: a part whose import is completed / cancelled WHILE it uploads → 409, the stored object is kept', async () => {
    const h = harness();
    const content = Buffer.from('code,amt\n1,2\n');
    const { id } = await started(h, 'a.csv', content);
    h.storage.uploadFile.mockImplementationOnce(async (buf: Buffer, key: string) => {
      h.objects.set(key, buf);
      h.rows.get(id)!.status = 'QUEUED'; // complete won the race
      return key;
    });
    await expect(h.svc.putPart(USER, id, '0', h.part(content))).rejects.toThrow(/no longer accepting parts/);
    expect(h.storage.deleteFile).not.toHaveBeenCalled();
    expect(h.objects.has(partKey(`sales-imports/t1/${id}/`, 0))).toBe(true);
  });

  it('putPart: cross-tenant id → 404, bad n → 400, wrong size → 400, missing file → 400', async () => {
    const h = harness();
    const { id } = await started(h, 'a.csv', Buffer.alloc(P + 3));
    await expect(h.svc.putPart(OTHER, id, '0', h.part('x'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.svc.putPart(USER, id, '2', h.part('x'))).rejects.toThrow('between 0 and 1');
    await expect(h.svc.putPart(USER, id, '-1', h.part('x'))).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.putPart(USER, id, '1.5', h.part('x'))).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.putPart(USER, id, '1', h.part('xx'))).rejects.toThrow('exactly 3 bytes');
    await expect(h.svc.putPart(USER, id, '1', undefined)).rejects.toThrow('multipart');
    expect(h.storage.uploadFile).not.toHaveBeenCalled();
  });

  it('S8: a part arriving after complete (QUEUED) → 409 and the stored parts are NOT touched', async () => {
    const h = harness();
    const content = Buffer.from('code,amt\n1,2\n');
    const { id } = await started(h, 'a.csv', content);
    await h.svc.putPart(USER, id, '0', h.part(content));
    await h.svc.complete(USER, id);
    await expect(h.svc.putPart(USER, id, '0', h.part(content))).rejects.toBeInstanceOf(ConflictException);
    expect(h.storage.deleteFile).not.toHaveBeenCalled();
    expect(h.objects.get(partKey(`sales-imports/t1/${id}/`, 0))).toEqual(content);
  });

  it('complete: missing parts → 400 naming them; then QUEUED (+ queuedAt) via ONE guarded update, GCS checks outside any tx, audit, kick', async () => {
    const h = harness();
    const content = Buffer.from('code,amt\n1,2\n');
    const { id } = await started(h, 'a.csv', content);
    await expect(h.svc.complete(USER, id)).rejects.toThrow('missing part(s) 0');
    await h.svc.putPart(USER, id, '0', h.part(content));
    const s = await h.svc.complete(USER, id);
    expect(s).toMatchObject({ id, status: 'QUEUED', partsReceived: 1, uploadedBy: 'Admin', progressPct: null, queuedAt: expect.any(String), canCancel: true });
    expect(h.lockModes).toEqual([]);
    expect(h.prisma.$executeRaw).not.toHaveBeenCalled();
    // every GCS call of complete happened before its (only) transaction started
    const lastTx = h.order.lastIndexOf('tx:start');
    expect(h.order.slice(lastTx).filter((o) => o.startsWith('gcs:'))).toEqual([]);
    expect(h.audits.map((a) => (a.newValues as { action: string }).action)).toEqual(['create-upload', 'complete']);
    expect(h.runner.kick).toHaveBeenCalledTimes(1);
    await expect(h.svc.complete(USER, id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('complete: a stored part of the wrong size → 400', async () => {
    const h = harness();
    const { id } = await started(h, 'a.csv', Buffer.from('abcd'));
    h.objects.set(partKey(`sales-imports/t1/${id}/`, 0), Buffer.from('ab'));
    await expect(h.svc.complete(USER, id)).rejects.toThrow('wrong size');
  });

  it('complete: content checks — .xlsx must be a zip, .csv must be UTF-8 text and not a zip', async () => {
    const h = harness();
    const notZip = Buffer.from('hello,world\n');
    const x = await started(h, 'a.xlsx', notZip);
    await h.svc.putPart(USER, x.id, '0', h.part(notZip));
    await expect(h.svc.complete(USER, x.id)).rejects.toThrow('not a valid .xlsx');

    const zip = sheetjsWorkbook([['S', [['a']]]]);
    const c1 = await started(h, 'a.csv', zip);
    await h.svc.putPart(USER, c1.id, '0', h.part(zip));
    await expect(h.svc.complete(USER, c1.id)).rejects.toThrow('Excel workbook, not a CSV');

    const h2 = harness(); // a fresh tenant budget (in-flight cap)
    const utf16 = Buffer.from('\uFEFFcode,amt\n', 'utf16le');
    const c2 = await started(h2, 'b.csv', utf16);
    await h2.svc.putPart(USER, c2.id, '0', h2.part(utf16));
    await expect(h2.svc.complete(USER, c2.id)).rejects.toThrow('UTF-8');

    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x31, 0x0a]); // "café,1" in Latin-1
    const c3 = await started(h2, 'c.csv', latin1);
    await h2.svc.putPart(USER, c3.id, '0', h2.part(latin1));
    await expect(h2.svc.complete(USER, c3.id)).rejects.toThrow('UTF-8');
  });

  it('complete: a multi-byte character cut at the 4 KiB sniff boundary is still valid UTF-8', async () => {
    const h = harness();
    const content = Buffer.concat([Buffer.alloc(4095, 0x61), Buffer.from('é\n')]); // é = 2 bytes straddling 4096
    const { id } = await started(h, 'a.csv', content);
    await h.svc.putPart(USER, id, '0', h.part(content));
    await expect(h.svc.complete(USER, id)).resolves.toMatchObject({ status: 'QUEUED' });
  });
});

describe('SalesImportUploadService — lifecycle', () => {
  async function inState(h: ReturnType<typeof harness>, status: string, over: Partial<SalesImport> = {}) {
    const { importId } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 3 });
    Object.assign(h.rows.get(importId)!, { status, error: 'old', attempts: 2, rowsRead: 9, claimToken: 'old-token', heartbeatAt: new Date(), ...over });
    return importId;
  }
  const stale = () => new Date(Date.now() - (SALES_IMPORT_STALE_HEARTBEAT_MINUTES + 1) * MIN);

  it.each(['READY', 'NEEDS_MAPPING', 'FAILED'])('reprocess from %s → QUEUED (reset, claim token cleared) under FOR UPDATE NOWAIT, audited, kick', async (st) => {
    const h = harness();
    const id = await inState(h, st);
    const s = await h.svc.reprocess(USER, id);
    expect(s).toMatchObject({ status: 'QUEUED', error: null, rowsRead: 0, queuedAt: expect.any(String) });
    expect(h.rows.get(id)).toMatchObject({ attempts: 0, claimToken: null });
    expect(h.lockModes).toContain('UPDATE NOWAIT');
    expect(h.audits.at(-1)).toMatchObject({ action: 'UPDATE', newValues: expect.objectContaining({ action: 'reprocess', fromStatus: st }) });
    expect(h.runner.kick).toHaveBeenCalled();
  });

  it.each(['UPLOADING', 'QUEUED', 'PROCESSING', 'CANCELLED'])('reprocess from %s (live) → 409', async (st) => {
    const h = harness();
    await expect(h.svc.reprocess(USER, await inState(h, st))).rejects.toBeInstanceOf(ConflictException);
  });

  it('M3: a STALLED PROCESSING import (heartbeat > 10 min) can be reprocessed; the old worker token is cleared', async () => {
    const h = harness();
    const id = await inState(h, 'PROCESSING', { heartbeatAt: stale() });
    expect((await h.svc.get(USER, id)).stalled).toBe(true);
    await expect(h.svc.reprocess(USER, id)).resolves.toMatchObject({ status: 'QUEUED', stalled: false });
    expect(h.rows.get(id)!.claimToken).toBeNull();
  });

  it('S1/S2: reprocess is refused once a month was applied, while an apply holds the row (busy), and once purged', async () => {
    const h = harness();
    const applied = await inState(h, 'READY');
    h.setApplies([{ importId: applied }]);
    await expect(h.svc.reprocess(USER, applied)).rejects.toThrow(/already applied/);
    const busy = await inState(h, 'READY');
    h.held.add(busy); // an apply transaction holds FOR SHARE
    await expect(h.svc.reprocess(USER, busy)).rejects.toThrow(/busy/);
    const purged = await inState(h, 'READY', { purgedAt: new Date() } as never);
    await expect(h.svc.reprocess(USER, purged)).rejects.toThrow(/retention/);
    expect(h.runner.kick).not.toHaveBeenCalled();
  });

  it('M3: cancel QUEUED or stalled PROCESSING → CANCELLED + purged + audited; live PROCESSING / READY → 409', async () => {
    const h = harness();
    const q = await inState(h, 'QUEUED');
    h.objects.set(partKey(`sales-imports/t1/${q}/`, 0), Buffer.from('abc'));
    await expect(h.svc.cancel(USER, q)).resolves.toMatchObject({ status: 'CANCELLED', purgedAt: expect.any(String) });
    expect(h.rows.get(q)!.claimToken).toBeNull();
    expect(h.objects.size).toBe(0);
    expect(h.audits.at(-1)).toMatchObject({ action: 'UPDATE', newValues: expect.objectContaining({ action: 'cancel' }) });
    const st = await inState(h, 'PROCESSING', { heartbeatAt: stale() });
    await expect(h.svc.cancel(USER, st)).resolves.toMatchObject({ status: 'CANCELLED' });
    const live = await inState(h, 'PROCESSING');
    await expect(h.svc.cancel(USER, live)).rejects.toThrow(/still making progress/);
    const ready = await inState(h, 'READY');
    await expect(h.svc.cancel(USER, ready)).rejects.toBeInstanceOf(ConflictException);
    const appliedQueued = await inState(h, 'QUEUED');
    h.setApplies([{ importId: appliedQueued }]);
    expect((await h.svc.get(USER, appliedQueued)).canCancel).toBe(false);
    await expect(h.svc.cancel(USER, appliedQueued)).rejects.toThrow(/already applied/);
    await expect(h.svc.cancel(OTHER, q)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['UPLOADING', 'QUEUED', 'READY', 'NEEDS_MAPPING', 'FAILED'])('DELETE from %s → CANCELLED, files + aggregates removed, audited', async (st) => {
    const h = harness();
    const id = await inState(h, st);
    h.objects.set(partKey(`sales-imports/t1/${id}/`, 0), Buffer.from('abc'));
    const s = await h.svc.remove(USER, id);
    expect(s.status).toBe('CANCELLED');
    expect(h.storage.deletePrefix).toHaveBeenCalledWith(`sales-imports/t1/${id}/`);
    expect(h.objects.size).toBe(0);
    expect(h.prisma.salesImportAggregate.deleteMany).toHaveBeenCalledWith({ where: { importId: id } });
    expect(h.audits.at(-1)).toMatchObject({ action: 'DELETE', entityId: id });
    // M1: the GCS delete runs AFTER the marking transaction committed, then filesPurgedAt is stamped
    expect(h.order.lastIndexOf('gcs:deletePrefix')).toBeGreaterThan(h.order.lastIndexOf('tx:end'));
    expect(h.rows.get(id)).toMatchObject({ purgedAt: expect.any(Date), filesPurgedAt: expect.any(Date) });
  });

  it('M1: a failed GCS delete after the purge is marked is retried by the next sweep', async () => {
    const h = harness();
    const id = await inState(h, 'FAILED');
    h.objects.set(partKey(`sales-imports/t1/${id}/`, 0), Buffer.from('abc'));
    h.storage.deletePrefix.mockRejectedValueOnce(new Error('gcs 503'));
    await expect(h.svc.remove(USER, id)).resolves.toMatchObject({ status: 'CANCELLED', purgedAt: expect.any(String) });
    expect(h.rows.get(id)!.filesPurgedAt).toBeNull();
    expect(h.objects.size).toBe(1);
    await h.retention.sweep({ clientId: 't1' });
    expect(h.objects.size).toBe(0);
    expect(h.rows.get(id)!.filesPurgedAt).toEqual(expect.any(Date));
  });

  it('DELETE is idempotent (a second call succeeds and re-runs the cleanup)', async () => {
    const h = harness();
    const id = await inState(h, 'FAILED');
    await h.svc.remove(USER, id);
    await expect(h.svc.remove(USER, id)).resolves.toMatchObject({ status: 'CANCELLED' });
    expect(h.storage.deletePrefix).toHaveBeenCalledTimes(2);
  });

  it('DELETE refuses live PROCESSING, applied imports and a busy row (409), and other tenants (404)', async () => {
    const h = harness();
    const busy = await inState(h, 'PROCESSING');
    await expect(h.svc.remove(USER, busy)).rejects.toThrow('being processed');
    const applied = await inState(h, 'READY');
    h.setApplies([{ importId: applied }]);
    await expect(h.svc.remove(USER, applied)).rejects.toThrow('applied');
    await expect(h.svc.remove(OTHER, applied)).rejects.toBeInstanceOf(NotFoundException);
    const locked = await inState(h, 'READY');
    h.held.add(locked);
    await expect(h.svc.remove(USER, locked)).rejects.toThrow(/busy/);
    expect(h.storage.deletePrefix).not.toHaveBeenCalled();
  });
});

describe('SalesImportUploadService — read', () => {
  it('get: summary + detail, progressPct only while PROCESSING; detectedHeaders samples only with includeSamples (S3)', async () => {
    const h = harness();
    const { importId: id } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 1000 });
    Object.assign(h.rows.get(id)!, { status: 'PROCESSING', bytesRead: 333n, heartbeatAt: new Date(), detectedHeaders: [['H1', 'H2'], ['v1', 'v2']] });
    expect(await h.svc.get(USER, id)).toMatchObject({ progressPct: 33.3, detectedHeaders: [['H1', 'H2']], monthSummaries: null, errorSamples: null, stalled: false, canDelete: false });
    expect((await h.svc.get(USER, id, { includeSamples: true })).detectedHeaders).toEqual([['H1', 'H2'], ['v1', 'v2']]);
    Object.assign(h.rows.get(id)!, { status: 'NEEDS_MAPPING' });
    expect(await h.svc.get(USER, id)).toMatchObject({ progressPct: null, canReprocess: true, canDelete: true, applied: false });
    await expect(h.svc.get(OTHER, id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list: tenant-scoped, hides CANCELLED, pages with a cursor, explicit select (no JSON blobs), applied flags', async () => {
    const h = harness();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { importId } = await h.svc.createUpload(USER, { filename: `f${i}.csv`, sizeBytes: 1 });
      Object.assign(h.rows.get(importId)!, { createdAt: new Date(Date.UTC(2026, 9, 1 + i)), status: 'READY', finishedAt: new Date() });
      ids.push(importId);
    }
    h.rows.get(ids[1])!.status = 'CANCELLED';
    h.setApplies([{ importId: ids[2] }]);
    const r = await h.svc.list(USER, { limit: 50 });
    expect(r.items.map((i) => i.id)).toEqual([ids[2], ids[0]]);
    expect(r.items.map((i) => [i.applied, i.canReprocess, i.canDelete, i.detectedHeaders])).toEqual([[true, false, false, null], [false, true, true, null]]);
    expect(r.nextCursor).toBeNull();
    const call = h.prisma.salesImport.findMany.mock.calls.find((c) => (c[0] as { take?: number }).take === 51)![0] as Record<string, any>;
    expect(call.where).toEqual({ clientId: 't1', status: { not: 'CANCELLED' } });
    for (const blob of ['detectedHeaders', 'monthSummaries', 'errorSamples', 'dimensionValues', 'dimensionCombos', 'mappingSnapshot']) {
      expect(call.select[blob]).toBeUndefined();
    }
    await expect(h.svc.list(OTHER, { cursor: ids[0] })).rejects.toThrow('Invalid cursor');
    expect((await h.svc.list(OTHER, {})).items).toEqual([]);
  });

  it('S5: list lazily purges finished imports past retention (parts, aggregates, sample rows) and marks them', async () => {
    const h = harness();
    const { importId: id } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 1 });
    Object.assign(h.rows.get(id)!, {
      status: 'READY', finishedAt: new Date(Date.now() - (SALES_IMPORT_RETENTION_DAYS + 1) * 86_400_000), detectedHeaders: [['H'], ['secret']],
    });
    h.objects.set(partKey(`sales-imports/t1/${id}/`, 0), Buffer.from('abc'));
    h.objects.set(`sales-imports/t1/${id}/unmatched.csv`, Buffer.from('x'));
    const r = await h.svc.list(USER, {});
    expect(r.items[0]).toMatchObject({ id, status: 'READY', purgedAt: expect.any(String), canReprocess: false });
    expect(h.objects.size).toBe(0);
    expect(h.rows.get(id)!.detectedHeaders).toEqual([['H']]);
    expect(h.prisma.salesImportAggregate.deleteMany).toHaveBeenCalledWith({ where: { importId: id } });
    // a fresh READY import is untouched
    const { importId: fresh } = await h.svc.createUpload(USER, { filename: 'b.csv', sizeBytes: 1 });
    Object.assign(h.rows.get(fresh)!, { status: 'READY', finishedAt: new Date() });
    await h.svc.list(USER, {});
    expect(h.rows.get(fresh)!.purgedAt).toBeNull();
  });

  it('S5: retention skips a row another transaction holds (busy) and retries on the next sweep', async () => {
    const h = harness();
    const { importId: id } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 1 });
    Object.assign(h.rows.get(id)!, { status: 'FAILED', finishedAt: new Date(Date.now() - 40 * 86_400_000) });
    h.held.add(id);
    await expect(h.retention.sweep({ clientId: 't1' })).resolves.toEqual({ abandoned: 0, purged: 0 });
    h.held.delete(id);
    await expect(h.retention.sweep({ clientId: 't1' })).resolves.toEqual({ abandoned: 0, purged: 1 });
  });

  it('combos: latest READY, 404 when the tenant has none; a specific id returns its frozen picker data', async () => {
    const h = harness();
    await expect(h.svc.combos(USER, 'latest')).rejects.toBeInstanceOf(NotFoundException);
    const { importId: id } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 1 });
    Object.assign(h.rows.get(id)!, { status: 'READY', dimensionValues: { dimA: [{ value: 'P', lines: 1, amountRupees: 1 }] }, dimensionCombos: [] });
    await expect(h.svc.combos(USER, 'latest')).resolves.toEqual({ importId: id, dimensionValues: { dimA: [{ value: 'P', lines: 1, amountRupees: 1 }] }, dimensionCombos: [] });
    await expect(h.svc.combos(OTHER, 'latest')).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.svc.combos(OTHER, id)).rejects.toBeInstanceOf(NotFoundException);
    // L5: a purged import is never the 'latest'
    (h.rows.get(id) as unknown as { purgedAt: Date }).purgedAt = new Date();
    await expect(h.svc.combos(USER, 'latest')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('unmatched.csv: READY + not purged only and must exist; streams the stored object; download audited (S6)', async () => {
    const h = harness();
    const { importId: id } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 1 });
    await expect(h.svc.unmatchedCsv(USER, id)).rejects.toBeInstanceOf(NotFoundException);
    h.rows.get(id)!.status = 'READY';
    await expect(h.svc.unmatchedCsv(USER, id)).rejects.toThrow('not available');
    // re-check M1: only the key the READY run stored is served (a stray file from another run is never picked up)
    h.objects.set(`sales-imports/t1/${id}/unmatched-old.csv`, Buffer.from('stale'));
    await expect(h.svc.unmatchedCsv(USER, id)).rejects.toThrow('not available');
    (h.rows.get(id) as unknown as { unmatchedCsvKey: string }).unmatchedCsvKey = `sales-imports/t1/${id}/unmatched-r1.csv`;
    h.objects.set(`sales-imports/t1/${id}/unmatched-r1.csv`, Buffer.from('h\r\n'));
    const r = await h.svc.unmatchedCsv(USER, id);
    expect(r.filename).toBe(`sales-import-${id}-unmatched.csv`);
    const chunks: Buffer[] = [];
    for await (const c of r.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('h\r\n');
    expect(h.audits.at(-1)).toMatchObject({ action: 'EXPORT', entityType: 'SALES_IMPORT', entityId: id });
    (h.rows.get(id) as unknown as { purgedAt: Date }).purgedAt = new Date();
    await expect(h.svc.unmatchedCsv(USER, id)).rejects.toThrow(/retention/);
  });

  it('errors.xlsx: one row per sample (or a "none" row)', async () => {
    const h = harness();
    const { importId: id } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 1 });
    h.rows.get(id)!.errorSamples = [{ row: 4, column: 'DATE', reason: 'invalid date' }] as never;
    const { buffer } = await h.svc.errorsXlsx(USER, id);
    const ws = XLSX.read(buffer).Sheets['Skipped rows'];
    expect(XLSX.utils.sheet_to_json(ws)).toEqual([{ Row: 4, Column: 'DATE', Reason: 'invalid date' }]);
  });
});

describe('SalesImportUploadService — reprocess as a new import (re-audit M3)', () => {
  const MAP_A = { headerRow: 'auto', outletCode: 'CODE', invoiceDate: 'DATE', amount: 'AMT', quantity: null, dimensions: [], dateOrder: 'DMY' };
  const MAP_B = { ...MAP_A, amount: 'NET AMT' };

  async function appliedImport(h: ReturnType<typeof harness>) {
    const content = Buffer.alloc(SALES_IMPORT_PART_SIZE + 5, 0x61);
    const { importId } = await h.svc.createUpload(USER, { filename: 'big.csv', sizeBytes: content.length });
    h.objects.set(partKey(`sales-imports/t1/${importId}/`, 0), content.subarray(0, SALES_IMPORT_PART_SIZE));
    h.objects.set(partKey(`sales-imports/t1/${importId}/`, 1), content.subarray(SALES_IMPORT_PART_SIZE));
    const { mappingFingerprint } = jest.requireActual('./mapping-fingerprint') as typeof import('./mapping-fingerprint');
    Object.assign(h.rows.get(importId)!, { status: 'READY', finishedAt: new Date(), mappingFingerprint: mappingFingerprint(MAP_A as never) });
    h.setApplies([{ importId }]);
    return importId;
  }

  it('flag: only for an applied, READY, unpurged import whose mapping changed; never once a live re-import exists', async () => {
    const h = harness();
    const id = await appliedImport(h);
    h.setProfile(MAP_A);
    expect((await h.svc.get(USER, id)).canReprocessAsNew).toBe(false); // mapping unchanged
    h.setProfile(MAP_B);
    expect(await h.svc.get(USER, id)).toMatchObject({ canReprocessAsNew: true, canReprocess: false, canCancel: false, canDelete: false });
    await h.svc.reprocessAsNew(USER, id);
    expect((await h.svc.get(USER, id)).canReprocessAsNew).toBe(false); // the live child exists now
  });

  it('copies the stored parts server-side to a NEW import (outside any tx), queues it, audits; the old import is untouched', async () => {
    const h = harness();
    const id = await appliedImport(h);
    h.setProfile(MAP_B);
    const before = { ...h.rows.get(id)! };
    const s = await h.svc.reprocessAsNew(USER, id);
    expect(s).toMatchObject({ status: 'QUEUED', reprocessedFromId: id, originalFilename: 'big.csv', partCount: 2, queuedAt: expect.any(String) });
    expect(s.id).not.toBe(id);
    expect(h.objects.get(partKey(`sales-imports/t1/${s.id}/`, 1))).toEqual(h.objects.get(partKey(`sales-imports/t1/${id}/`, 1)));
    expect(h.rows.get(id)).toEqual(before);
    // no GCS copy inside a transaction
    let inTx = false;
    for (const o of h.order) {
      if (o === 'tx:start') inTx = true;
      else if (o === 'tx:end') inTx = false;
      else if (o === 'gcs:copy') expect(inTx).toBe(false);
    }
    expect(h.audits.filter((a) => a.entityId === s.id).map((a) => (a.newValues as { action: string }).action)).toEqual(['reprocess-as-new', 'complete']);
    expect(h.runner.kick).toHaveBeenCalled();
    await expect(h.svc.reprocessAsNew(USER, id)).rejects.toThrow(/already being re-imported/);
  });

  it('409 when never applied (use Reprocess), mapping unchanged, purged, or cross-tenant 404', async () => {
    const h = harness();
    const id = await appliedImport(h);
    h.setProfile(MAP_A);
    await expect(h.svc.reprocessAsNew(USER, id)).rejects.toThrow(/has not changed/);
    h.setProfile(MAP_B);
    await expect(h.svc.reprocessAsNew(OTHER, id)).rejects.toBeInstanceOf(NotFoundException);
    h.setApplies([]);
    await expect(h.svc.reprocessAsNew(USER, id)).rejects.toThrow(/use Reprocess/);
    h.setApplies([{ importId: id }]);
    (h.rows.get(id) as unknown as { purgedAt: Date }).purgedAt = new Date();
    await expect(h.svc.reprocessAsNew(USER, id)).rejects.toThrow(/retention/);
  });

  it('a failed copy leaves no half-made import behind (cancelled + purged) and reports 409', async () => {
    const h = harness();
    const id = await appliedImport(h);
    h.setProfile(MAP_B);
    h.objects.delete(partKey(`sales-imports/t1/${id}/`, 1));
    await expect(h.svc.reprocessAsNew(USER, id)).rejects.toThrow(/could not be copied/);
    const child = [...h.rows.values()].find((r) => (r as unknown as { reprocessedFromId: string }).reprocessedFromId === id)!;
    expect(child).toMatchObject({ status: 'CANCELLED', purgedAt: expect.any(Date) });
    expect([...h.objects.keys()].some((k) => k.includes(child.id))).toBe(false);
  });
});

describe('SalesImportRetentionService — month history (10 years)', () => {
  it('deletes history months older than 10 years (vs the current month), tenant-scoped when asked; never throws', async () => {
    const h = harness();
    await h.retention.purgeOldHistory({ clientId: 't1', currentMonth: '2036-11' });
    expect(h.prisma.salesMonthHistory.deleteMany).toHaveBeenCalledWith({ where: { clientId: 't1', month: { lt: '2026-11' } } });
    expect(h.prisma.salesMonthHistorySet.deleteMany).toHaveBeenCalledWith({ where: { clientId: 't1', month: { lt: '2026-11' } } });
    expect(h.prisma.salesMonthHistoryCombo.deleteMany).toHaveBeenCalledWith({ where: { clientId: 't1', month: { lt: '2026-11' } } }); // audit M1
    h.prisma.salesMonthHistory.deleteMany.mockRejectedValueOnce(new Error('db'));
    await expect(h.retention.purgeOldHistory()).resolves.toBe(0);
    // the regular sweep runs it too
    h.prisma.salesMonthHistory.deleteMany.mockClear();
    await h.retention.sweep({ clientId: 't1' });
    expect(h.prisma.salesMonthHistory.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe('SalesImportUploadService — final re-check fixes', () => {
  it('M2: a part landing after a CANCEL re-deletes its object; after a COMPLETE the object is kept', async () => {
    const h = harness();
    const content = Buffer.from('code,amt\n1,2\n');
    const { importId: id } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: content.length });
    h.storage.uploadFile.mockImplementationOnce(async (buf: Buffer, key: string) => {
      h.objects.set(key, buf);
      Object.assign(h.rows.get(id)!, { status: 'CANCELLED', purgedAt: new Date() }); // cancelled + purged meanwhile
      return key;
    });
    await expect(h.svc.putPart(USER, id, '0', h.part(content))).rejects.toBeInstanceOf(ConflictException);
    expect(h.storage.deleteFile).toHaveBeenCalledWith(partKey(`sales-imports/t1/${id}/`, 0));
    expect(h.objects.size).toBe(0);
  });

  const MAP_A = { headerRow: 'auto', outletCode: 'CODE', invoiceDate: 'DATE', amount: 'AMT', quantity: null, dimensions: [], dateOrder: 'DMY' };
  async function appliedParent(h: ReturnType<typeof harness>) {
    const { importId } = await h.svc.createUpload(USER, { filename: 'f.csv', sizeBytes: 3 });
    h.objects.set(partKey(`sales-imports/t1/${importId}/`, 0), Buffer.from('abc'));
    Object.assign(h.rows.get(importId)!, { status: 'READY', finishedAt: new Date(), mappingFingerprint: 'old-fp' });
    h.setApplies([{ importId }]);
    h.setProfile(MAP_A);
    return importId;
  }

  it('M3: the parent is locked FOR UPDATE NOWAIT in the create tx (busy → 409), and a unique violation maps to 409', async () => {
    const h = harness();
    const id = await appliedParent(h);
    h.held.add(id);
    await expect(h.svc.reprocessAsNew(USER, id)).rejects.toThrow(/busy/);
    h.held.delete(id);
    h.prisma.salesImport.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    await expect(h.svc.reprocessAsNew(USER, id)).rejects.toThrow(/already being re-imported/);
    await expect(h.svc.reprocessAsNew(USER, id)).resolves.toMatchObject({ status: 'QUEUED', reprocessedFromId: id });
    expect(h.lockModes).toContain('UPDATE NOWAIT');
  });

  it('L4: reprocess-as-new respects the in-flight upload cap', async () => {
    const h = harness();
    const id = await appliedParent(h);
    for (let i = 0; i < SALES_IMPORT_MAX_INFLIGHT_UPLOADS; i++) await h.svc.createUpload(USER, { filename: `u${i}.csv`, sizeBytes: 3 });
    await expect(h.svc.reprocessAsNew(USER, id)).rejects.toThrow(/uploads are already in progress/);
  });

  it('L4: parent purged during the copy → child cancelled + purged; a busy cleanup still marks the child CANCELLED', async () => {
    const h = harness();
    const id = await appliedParent(h);
    h.storage.copyFile.mockImplementationOnce(async (from: string, to: string) => {
      h.objects.set(to, Buffer.from(h.objects.get(from)!));
      (h.rows.get(id) as unknown as { purgedAt: Date }).purgedAt = new Date(); // retention purged the parent meanwhile
    });
    await expect(h.svc.reprocessAsNew(USER, id)).rejects.toThrow(/could not be copied/);
    const child = [...h.rows.values()].find((r) => (r as unknown as { reprocessedFromId: string }).reprocessedFromId === id)!;
    expect(child).toMatchObject({ status: 'CANCELLED', purgedAt: expect.any(Date) });

    const h2 = harness();
    const id2 = await appliedParent(h2);
    h2.storage.copyFile.mockRejectedValueOnce(new Error('gcs down'));
    jest.spyOn(h2.retention, 'purgeImport').mockImplementationOnce(async () => 'busy');
    await expect(h2.svc.reprocessAsNew(USER, id2)).rejects.toThrow(/could not be copied/);
    const child2 = [...h2.rows.values()].find((r) => (r as unknown as { reprocessedFromId: string }).reprocessedFromId === id2)!;
    expect(child2.status).toBe('CANCELLED'); // never left as a live child blocking a retry
  });
});
