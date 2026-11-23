import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';
import type { SalesImport } from '@prisma/client';
import * as XLSX from 'xlsx';
import {
  SALES_IMPORT_MAX_FILE_BYTES,
  SALES_IMPORT_MAX_INFLIGHT_UPLOADS,
  SALES_IMPORT_PART_SIZE,
  SALES_IMPORT_RETENTION_DAYS,
  SALES_IMPORT_RETENTION_DAYS_V2,
  SALES_IMPORT_STALE_HEARTBEAT_MINUTES,
} from '../sales-import.contract';
import { withRetentionV2 } from '../retention-env.testspec';
import { partKey } from './parts-file';
import { currentMonthKey } from '../../targets/targets.helpers';
import { shiftMonthKey } from '../months/month-state';
import { sheetjsWorkbook } from './test-fixtures.testspec';
import {
  GCS_DELETE_TIMEOUT_MS, HISTORY_PURGE_CHUNK_ROWS, HISTORY_PURGE_STATEMENT_TIMEOUT_MS, HISTORY_PURGE_TX_TIMEOUT_MS, PURGE_STATEMENT_TIMEOUT_MS, PURGE_STEP_MS,
  SalesImportRetentionService,
} from './sales-import-retention.service';
import { LIST_SWEEP_START_WINDOW_MS, SalesImportUploadService } from './sales-import-upload.service';

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
    $executeRawUnsafe: jest.fn(async (s: string) => { order.push(`set:${s}`); return 0; }),
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
  const runner = { kick: jest.fn().mockResolvedValue('inline'), isConfigured: jest.fn().mockReturnValue(true) };
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
    // no raw write of its own (the only raw statements are the retention sweep's bounded month-window deletes: history + day data)
    const raw = h.prisma.$executeRaw.mock.calls.map((c) => (c[0] as unknown as { strings: string[] }).strings.join('?'));
    expect(raw.filter((s) => !/"(sales_month_histor(ies|y_combos|y_sets)|outlet_sales_days|sales_day_sets)"/.test(s))).toEqual([]);
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

  it('roster-only: a reprocess (re-queue) clears processedRosterCodes — the next READY run records its own roster', async () => {
    const h = harness();
    const id = await inState(h, 'READY');
    (h.rows.get(id) as unknown as { processedRosterCodes: unknown }).processedRosterCodes = ['O1'];
    await h.svc.reprocess(USER, id);
    expect((h.rows.get(id) as unknown as { processedRosterCodes: unknown }).processedRosterCodes).toBeNull();
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

  it('S1 switch OFF (default): per-import data is kept 30 days after the import finished, exactly as before — an 8-day-old import is NOT purged', async () => {
    expect(SALES_IMPORT_RETENTION_DAYS).toBe(30);
    for (const off of [undefined, '', 'off', 'true', '1']) {
      await withRetentionV2(off, async () => {
        const h = harness();
        const at = (days: number) => new Date(Date.now() - days * 86_400_000);
        const { importId: eight } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 1 });
        const { importId: old } = await h.svc.createUpload(USER, { filename: 'b.csv', sizeBytes: 1 });
        Object.assign(h.rows.get(eight)!, { status: 'READY', finishedAt: at(8) });
        Object.assign(h.rows.get(old)!, { status: 'READY', finishedAt: at(31) });
        h.objects.set(partKey(`sales-imports/t1/${eight}/`, 0), Buffer.from('abc'));
        await h.retention.sweep({ clientId: 't1', history: false });
        expect(h.rows.get(eight)!.purgedAt).toBeNull();
        expect([...h.objects.keys()].some((k) => k.includes(eight))).toBe(true);
        expect(h.rows.get(old)!.purgedAt).toBeTruthy();
      });
    }
  });

  it('S1 switch ON (SALES_RETENTION_V2=on): per-import data (aggregates, raw parts, unmatched.csv) is kept 7 days after the import finished, not 30', () => withRetentionV2('on', async () => {
    expect(SALES_IMPORT_RETENTION_DAYS_V2).toBe(7);
    const h = harness();
    const at = (days: number) => new Date(Date.now() - days * 86_400_000);
    const { importId: eight } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 1 });
    const { importId: six } = await h.svc.createUpload(USER, { filename: 'b.csv', sizeBytes: 1 });
    Object.assign(h.rows.get(eight)!, { status: 'READY', finishedAt: at(8) });
    Object.assign(h.rows.get(six)!, { status: 'READY', finishedAt: at(6) });
    h.objects.set(partKey(`sales-imports/t1/${eight}/`, 0), Buffer.from('abc'));
    h.objects.set(partKey(`sales-imports/t1/${six}/`, 0), Buffer.from('abc'));
    await h.retention.sweep({ clientId: 't1', history: false });
    expect(h.rows.get(eight)!.purgedAt).toBeTruthy();
    expect([...h.objects.keys()].some((k) => k.includes(eight))).toBe(false);
    expect(h.rows.get(six)!.purgedAt).toBeNull();
    expect([...h.objects.keys()].some((k) => k.includes(six))).toBe(true);
  }));

  it('S1: an EXPLICIT retentionDays (the one-off trim) applies 7 days even with the switch OFF', () => withRetentionV2(undefined, async () => {
    const h = harness();
    const { importId: eight } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 1 });
    Object.assign(h.rows.get(eight)!, { status: 'READY', finishedAt: new Date(Date.now() - 8 * 86_400_000) });
    await h.retention.sweep({ clientId: 't1', history: false });
    expect(h.rows.get(eight)!.purgedAt).toBeNull();
    await h.retention.sweep({ clientId: 't1', history: false, retentionDays: SALES_IMPORT_RETENTION_DAYS_V2 });
    expect(h.rows.get(eight)!.purgedAt).toBeTruthy();
  }));

  it('re-check M2: with a deadline, the sweep starts no purge whose worst case (lock wait + tx + GCS) could pass it', async () => {
    const h = harness();
    const ids: string[] = [];
    for (const name of ['a.csv', 'b.csv']) ids.push((await h.svc.createUpload(USER, { filename: name, sizeBytes: 1 })).importId);
    for (const id of ids) Object.assign(h.rows.get(id)!, { status: 'FAILED', finishedAt: new Date(Date.now() - 40 * 86_400_000) });
    let clock = 0;
    h.retention.clock = () => clock;
    // window too short for even one purge → nothing purged, history purge skipped too unless a small step fits
    await expect(h.retention.sweep({ clientId: 't1', deadline: PURGE_STEP_MS - 1 })).resolves.toEqual({ abandoned: 0, purged: 0 });
    expect(ids.every((id) => !h.rows.get(id)!.purgedAt)).toBe(true);
    // room for exactly one: each purge "takes" 60 s → the second would start at 60 s and could end after the deadline
    const realPurge = h.retention.purgeImport.bind(h.retention);
    h.retention.purgeImport = async (...a: Parameters<typeof realPurge>) => { clock += 60_000; return realPurge(...a); };
    clock = 0;
    await expect(h.retention.sweep({ clientId: 't1', deadline: PURGE_STEP_MS + 30_000 })).resolves.toEqual({ abandoned: 0, purged: 1 });
    expect(PURGE_STEP_MS).toBe(145_000); // 120 s tx + 10 s lock wait + 15 s GCS
    // no deadline (list route / worker): unchanged
    await expect(h.retention.sweep({ clientId: 't1' })).resolves.toEqual({ abandoned: 0, purged: 1 });
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

  // Roster-only aggregates (2026-11-23): the only recovery once a month was applied is a re-import read with today's
  // roster, so it is ALSO allowed when the roster now has outlets missing from the processing-time roster.
  it('roster-only: allowed when the roster gained outlets since processing (mapping unchanged); refused when nothing changed; legacy NULL never counts', async () => {
    const h = harness();
    const id = await appliedImport(h);
    h.setProfile(MAP_A); // mapping unchanged
    let roster = ['O1', 'O2'];
    (h.prisma as unknown as { outlet: unknown }).outlet = { findMany: jest.fn(async () => roster.map((outletCode) => ({ outletCode }))) };
    // legacy import (processedRosterCodes NULL): nothing to re-import
    expect((await h.svc.get(USER, id)).canReprocessAsNew).toBe(false);
    await expect(h.svc.reprocessAsNew(USER, id)).rejects.toThrow(/Neither the column mapping nor the programme outlets changed/);
    // roster-only import, roster unchanged since processing: still refused
    (h.rows.get(id) as unknown as { processedRosterCodes: string[] }).processedRosterCodes = ['O1', 'O2'];
    expect((await h.svc.get(USER, id)).canReprocessAsNew).toBe(false);
    expect((await h.svc.list(USER, { limit: 50 })).items.find((i) => i.id === id)!.canReprocessAsNew).toBe(false);
    await expect(h.svc.reprocessAsNew(USER, id)).rejects.toThrow(/Neither the column mapping nor the programme outlets changed/);
    // O3 joined the programme after processing → allowed (flag on detail AND list), same guards, audited
    roster = ['O1', 'O2', 'O3'];
    expect((await h.svc.get(USER, id)).canReprocessAsNew).toBe(true);
    expect((await h.svc.list(USER, { limit: 50 })).items.find((i) => i.id === id)!.canReprocessAsNew).toBe(true);
    const s2 = await h.svc.reprocessAsNew(USER, id);
    expect(s2).toMatchObject({ status: 'QUEUED', reprocessedFromId: id });
    expect(h.audits.filter((a) => a.entityId === s2.id).map((a) => (a.newValues as { action: string }).action)).toEqual(['reprocess-as-new', 'complete']);
    expect((await h.svc.get(USER, id)).canReprocessAsNew).toBe(false); // one live child at a time
    await expect(h.svc.reprocessAsNew(USER, id)).rejects.toThrow(/already being re-imported/);
    await expect(h.svc.reprocessAsNew(OTHER, id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409 when never applied (use Reprocess), mapping unchanged, purged, or cross-tenant 404', async () => {
    const h = harness();
    const id = await appliedImport(h);
    h.setProfile(MAP_A);
    await expect(h.svc.reprocessAsNew(USER, id)).rejects.toThrow(/Neither the column mapping nor the programme outlets changed/);
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

describe('SalesImportRetentionService — month windows (S1: history 10 years while SALES_RETENTION_V2 is off; day data always current + 3 previous)', () => {
  const sqlOf = (h: ReturnType<typeof harness>) => () => h.prisma.$executeRaw.mock.calls.map((c) => c[0] as unknown as { strings: string[]; values: unknown[] });

  it('S1 switch OFF (default): the Cloud Scheduler drain sweep deletes history only before the 10-year cutoff (as before) and purges no import younger than 30 days', () => withRetentionV2(undefined, async () => {
    const h = harness();
    const sql = sqlOf(h);
    const cur = currentMonthKey();
    const { importId: eight } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 1 });
    Object.assign(h.rows.get(eight)!, { status: 'READY', finishedAt: new Date(Date.now() - 8 * 86_400_000) });
    h.prisma.$executeRaw.mockClear(); // (createUpload ran its own tenant sweep)
    // exactly the drain controller's call
    await h.retention.sweep({ limit: 50, deadline: Date.now() + 150_000 });
    expect(h.rows.get(eight)!.purgedAt).toBeNull();
    const del = (table: string) => sql().find((q) => q.strings.join('?').includes(`DELETE FROM "${table}"`))!;
    const [lines, combos, sets, daySets, dayRows] = ['sales_month_histories', 'sales_month_history_combos', 'sales_month_history_sets', 'sales_day_sets', 'outlet_sales_days'].map(del);
    const legacy = shiftMonthKey(cur, -12 * 10); // origin/develop: shiftMonthKey(current, -12 * SALES_MONTH_HISTORY_RETENTION_YEARS)
    expect(lines.values).toEqual([legacy, HISTORY_PURGE_CHUNK_ROWS]);
    expect(combos.values).toEqual([legacy, HISTORY_PURGE_CHUNK_ROWS]);
    expect(sets.values).toEqual([legacy]);
    // the day tables are NEW (no row predates this release): they follow the 4-month window from day one
    expect(daySets.values).toEqual([shiftMonthKey(cur, -3)]);
    expect(dayRows.values).toEqual([shiftMonthKey(cur, -3), HISTORY_PURGE_CHUNK_ROWS]);
    // an EXPLICIT history cutoff (the one-off trim) wins over the switch
    h.prisma.$executeRaw.mockClear();
    await h.retention.purgeOldHistory({ historyCutoff: shiftMonthKey(cur, -3) });
    expect(sql()[0].values).toEqual([shiftMonthKey(cur, -3), HISTORY_PURGE_CHUNK_ROWS]);
  }));

  it('S1 switch ON: deletes history AND day data of months before the window — bounded: one tx, statement_timeout, chunked deletes, headers / day sets in step', () => withRetentionV2('on', async () => {
    const h = harness();
    const sql = () => h.prisma.$executeRaw.mock.calls.map((c) => c[0] as unknown as { strings: string[]; values: unknown[] });
    const cur = currentMonthKey();
    const keepFrom = shiftMonthKey(cur, -3); // computed from now, never a fixed date
    h.prisma.$executeRaw.mockResolvedValueOnce(7); // the line rows deleted
    await expect(h.retention.purgeOldHistory({ clientId: 't1' })).resolves.toBe(7);
    expect(h.prisma.$executeRawUnsafe).toHaveBeenCalledWith(`SET LOCAL statement_timeout = ${HISTORY_PURGE_STATEMENT_TIMEOUT_MS}`);
    const [lines, combos, sets, daySets, dayRows] = sql();
    expect(lines.strings.join('?')).toMatch(/DELETE FROM "sales_month_histories" WHERE "id" IN \(\s*SELECT h\."id" FROM "sales_month_histories" h\s+WHERE h\."month" < \? AND h\."clientId" = \? LIMIT \?\)/);
    expect(lines.values).toEqual([keepFrom, 't1', HISTORY_PURGE_CHUNK_ROWS]);
    expect(combos.strings.join('?')).toMatch(/DELETE FROM "sales_month_history_combos" WHERE "id" IN/);
    expect(combos.values).toEqual([keepFrom, 't1', HISTORY_PURGE_CHUNK_ROWS]);
    // a month's header goes only once its lines AND summary are gone (a big backlog drains over several sweeps)
    expect(sets.strings.join('?')).toMatch(/DELETE FROM "sales_month_history_sets" s[\s\S]*NOT EXISTS[\s\S]*sales_month_histories[\s\S]*NOT EXISTS[\s\S]*sales_month_history_combos/);
    // day data, same window: the "complete day data" set FIRST (never claims a half-deleted month), then bounded rows
    expect(daySets.strings.join('?')).toMatch(/DELETE FROM "sales_day_sets" d WHERE d\."month" < \? AND d\."clientId" = \?/);
    expect(daySets.values).toEqual([keepFrom, 't1']);
    expect(dayRows.strings.join('?')).toMatch(/DELETE FROM "outlet_sales_days" WHERE "id" IN \(\s*SELECT o\."id" FROM "outlet_sales_days" o\s+WHERE o\."month" < \? AND o\."clientId" = \? LIMIT \?\)/);
    expect(dayRows.values).toEqual([keepFrom, 't1', HISTORY_PURGE_CHUNK_ROWS]);
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: HISTORY_PURGE_TX_TIMEOUT_MS, maxWait: 5_000 });
    // an explicit current month (e.g. a month from now) moves the window with it
    h.prisma.$executeRaw.mockClear();
    await h.retention.purgeOldHistory({ currentMonth: shiftMonthKey(cur, 1) });
    expect(sql()[0].values).toEqual([shiftMonthKey(cur, -2), HISTORY_PURGE_CHUNK_ROWS]); // all tenants when no clientId
    expect(sql()[4].values).toEqual([shiftMonthKey(cur, -2), HISTORY_PURGE_CHUNK_ROWS]);
    // never throws
    h.prisma.$executeRaw.mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
    await expect(h.retention.purgeOldHistory()).resolves.toBe(0);
    // the regular sweep runs it too
    h.prisma.$executeRaw.mockClear();
    await h.retention.sweep({ clientId: 't1' });
    expect(sql().some((q) => q.strings.join('?').includes('DELETE FROM "sales_month_histories"'))).toBe(true);
  }));

  it('L1: every purge statement is bounded (SET LOCAL statement_timeout first) and the GCS delete is abandoned after 15 s', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const h = harness();
      const { importId: id } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 1 });
      h.prisma.$executeRawUnsafe.mockClear();
      Object.assign(h.rows.get(id)!, { status: 'FAILED', finishedAt: new Date(Date.now() - 40 * 86_400_000) });
      // a GCS delete that never answers
      h.storage.deletePrefix.mockImplementationOnce(() => new Promise<void>(() => undefined));
      const p = h.retention.purgeImport(id, 't1');
      await jest.advanceTimersByTimeAsync(GCS_DELETE_TIMEOUT_MS);
      await expect(p).resolves.toBe('purged'); // the DB purge stands; files are retried by the next sweep
      expect(h.prisma.$executeRawUnsafe).toHaveBeenCalledWith(`SET LOCAL statement_timeout = ${PURGE_STATEMENT_TIMEOUT_MS}`);
      expect(h.order.indexOf(`set:SET LOCAL statement_timeout = ${PURGE_STATEMENT_TIMEOUT_MS}`)).toBeLessThan(h.order.lastIndexOf('tx:end'));
      expect(h.rows.get(id)!.purgedAt).toBeTruthy();
      expect(h.rows.get(id)!.filesPurgedAt).toBeNull(); // not marked: the next sweep retries the GCS delete
      expect(PURGE_STATEMENT_TIMEOUT_MS).toBeLessThan(120_000);
    } finally {
      jest.useRealTimers();
    }
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

describe('retention re-check L3 / L4', () => {
  it('L3: the import-list GET sweep skips the 10-year history delete and starts no step after its 10 s window', async () => {
    const h = harness();
    const spy = jest.spyOn(h.retention, 'sweep');
    await h.svc.list(USER, {});
    const opts = spy.mock.calls[0][0]!;
    expect(opts).toEqual(expect.objectContaining({ clientId: 't1', history: false, stopStartingAfter: expect.any(Number) }));
    expect(opts.stopStartingAfter! - Date.now()).toBeLessThanOrEqual(LIST_SWEEP_START_WINDOW_MS);
    const raw = h.prisma.$executeRaw.mock.calls.map((c) => (c[0] as unknown as { strings: string[] }).strings.join('?'));
    expect(raw.some((s) => s.includes('sales_month_histories'))).toBe(false);
    // past the window nothing new starts (an expired import is left for the drains)
    const { importId: id } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 1 });
    Object.assign(h.rows.get(id)!, { status: 'FAILED', finishedAt: new Date(Date.now() - 40 * 86_400_000) });
    await expect(h.retention.sweep({ clientId: 't1', stopStartingAfter: Date.now() - 1 })).resolves.toEqual({ abandoned: 0, purged: 0 });
    // the drains / worker (no flag) still run it
    await h.retention.sweep({});
    const after = h.prisma.$executeRaw.mock.calls.map((c) => (c[0] as unknown as { strings: string[] }).strings.join('?'));
    expect(after.some((s) => s.includes('DELETE FROM "sales_month_histories"'))).toBe(true);
  });

  it('L4: a GCS prefix whose delete is still running (timed out but not settled) is not deleted a second time', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const h = harness();
      const { importId: id } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 1 });
      let finish: () => void = () => undefined;
      h.storage.deletePrefix.mockImplementationOnce(() => new Promise<void>((r) => { finish = r; }));
      const first = h.retention.deleteFiles(id, 't1');
      await jest.advanceTimersByTimeAsync(GCS_DELETE_TIMEOUT_MS);
      await expect(first).resolves.toBe(false); // gave up waiting
      h.storage.deletePrefix.mockClear();
      await expect(h.retention.deleteFiles(id, 't1')).resolves.toBe(false); // still in flight → skipped
      expect(h.storage.deletePrefix).not.toHaveBeenCalled();
      finish(); // the client call settles
      await jest.advanceTimersByTimeAsync(0);
      await expect(h.retention.deleteFiles(id, 't1')).resolves.toBe(true);
      expect(h.storage.deletePrefix).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('SalesImportUploadService — background processor not configured (integration-audit M1)', () => {
  const MSG = "Sales Import can't be switched on here yet: the background processor isn't set up in this environment.";

  it('createUpload is refused (400, operator message) before anything is created', async () => {
    const h = harness();
    h.runner.isConfigured.mockReturnValue(false);
    const p = h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 3 });
    await expect(p).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 3 })).rejects.toThrow(MSG);
    expect(h.rows.size).toBe(0);
    expect(h.audits).toEqual([]);
  });

  it('complete / reprocess / reprocess-as-new are refused too (nothing is queued that would never process)', async () => {
    const h = harness();
    const content = Buffer.from('code,amt\n1,2\n');
    const { importId } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: content.length });
    await h.svc.putPart(USER, importId, '0', h.part(content));
    const ready = (await h.svc.createUpload(USER, { filename: 'b.csv', sizeBytes: 3 })).importId;
    Object.assign(h.rows.get(ready)!, { status: 'READY', finishedAt: new Date() });
    h.runner.isConfigured.mockReturnValue(false);
    await expect(h.svc.complete(USER, importId)).rejects.toThrow(MSG);
    expect(h.rows.get(importId)!.status).toBe('UPLOADING');
    await expect(h.svc.reprocess(USER, ready)).rejects.toThrow(MSG);
    expect(h.rows.get(ready)!.status).toBe('READY');
    await expect(h.svc.reprocessAsNew(USER, ready)).rejects.toThrow(MSG);
    expect(h.runner.kick).not.toHaveBeenCalled();
  });

  it('reads, cancel and delete still work (an operator can clean up)', async () => {
    const h = harness();
    const { importId } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 3 });
    h.runner.isConfigured.mockReturnValue(false);
    await expect(h.svc.list(USER, {})).resolves.toMatchObject({ items: [expect.objectContaining({ id: importId })] });
    await expect(h.svc.remove(USER, importId)).resolves.toMatchObject({ status: 'CANCELLED' });
  });
});
