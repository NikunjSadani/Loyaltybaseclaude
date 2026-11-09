import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';
import type { SalesImport } from '@prisma/client';
import * as XLSX from 'xlsx';
import { SALES_IMPORT_MAX_FILE_BYTES, SALES_IMPORT_PART_SIZE } from '../sales-import.contract';
import { partKey } from './parts-file';
import { sheetjsWorkbook } from './test-fixtures.testspec';
import { SalesImportUploadService } from './sales-import-upload.service';

const USER = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 't1', phone: '', name: 'Admin' };
const OTHER = { ...USER, clientId: 't2' };
const P = SALES_IMPORT_PART_SIZE;

/** In-memory SalesImport table + bucket, scoped like Prisma would be. */
function harness() {
  const rows = new Map<string, SalesImport>();
  const objects = new Map<string, Buffer>();
  const matches = (r: SalesImport, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const val = (r as unknown as Record<string, unknown>)[k];
      if (v && typeof v === 'object' && 'not' in (v as object)) return val !== (v as { not: unknown }).not;
      return val === v;
    });
  const salesImport = {
    create: jest.fn(async ({ data }: { data: Partial<SalesImport> }) => {
      const r = {
        partsReceived: 0, bytesRead: 0n, rowsRead: 0, rowsSkipped: 0, attempts: 0, error: null, duplicateOfId: null,
        detectedHeaders: null, monthSummaries: null, errorSamples: null, dimensionValues: null, dimensionCombos: null,
        finishedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data,
      } as SalesImport;
      rows.set(r.id, r);
      return r;
    }),
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => [...rows.values()].find((r) => matches(r, where)) ?? null),
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...rows.values()].filter((r) => matches(r, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())),
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<SalesImport> }) => {
      let count = 0;
      for (const r of rows.values()) {
        if (matches(r, where)) {
          Object.assign(r, data);
          count++;
        }
      }
      return { count };
    }),
  };
  const prisma = {
    salesImport,
    salesImportAggregate: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    salesImportApply: { count: jest.fn().mockResolvedValue(0) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1', name: 'Admin' }]) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const storage = {
    uploadFile: jest.fn(async (buf: Buffer, key: string) => {
      objects.set(key, buf);
      return key;
    }),
    deleteFile: jest.fn(async (key: string) => void objects.delete(key)),
    listPrefix: jest.fn(async (prefix: string) =>
      [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([name, b]) => ({ name, size: b.length }))),
    deletePrefix: jest.fn(async (prefix: string) => {
      for (const k of [...objects.keys()]) if (k.startsWith(prefix)) objects.delete(k);
    }),
    openReadStream: jest.fn((key: string, range?: { start: number; end: number }) => {
      const b = objects.get(key) ?? Buffer.alloc(0);
      return Readable.from([range ? b.subarray(range.start, range.end + 1) : b]);
    }),
  };
  const runner = { kick: jest.fn().mockResolvedValue('inline') };
  const svc = new SalesImportUploadService(prisma as never, storage as never, runner as never);
  const part = (b: Buffer | string) => ({ buffer: Buffer.from(b), size: Buffer.from(b).length });
  return { svc, prisma, storage, runner, rows, objects, part };
}

describe('SalesImportUploadService — upload', () => {
  it('createUpload: plans 4 MiB parts under sales-imports/<client>/<id>/ and stores the basename', async () => {
    const h = harness();
    const r = await h.svc.createUpload(USER, { filename: 'C:\\fakepath\\Sales Nov.XLSX', sizeBytes: 2 * P + 1 });
    expect(r).toEqual({ importId: expect.any(String), partSize: P, partCount: 3 });
    const row = h.rows.get(r.importId)!;
    expect(row).toMatchObject({ clientId: 't1', uploadedById: 'u1', originalFilename: 'Sales Nov.XLSX', fileKind: 'XLSX', status: 'UPLOADING', partCount: 3 });
    expect(row.gcsPrefix).toBe(`sales-imports/t1/${r.importId}/`);
  });

  it.each([
    [{ filename: 'data.xls', sizeBytes: 10 }, 'Upload a .xlsx or .csv'],
    [{ filename: '.csv', sizeBytes: 10 }, 'Upload a .xlsx or .csv'],
    [{ filename: 'a.csv', sizeBytes: 0 }, 'empty'],
    [{ filename: 'a.csv', sizeBytes: SALES_IMPORT_MAX_FILE_BYTES + 1 }, 'limit'],
  ])('createUpload rejects %p', async (body, msg) => {
    await expect(harness().svc.createUpload(USER, body)).rejects.toThrow(msg);
  });

  async function started(h: ReturnType<typeof harness>, filename: string, content: Buffer) {
    const { importId, partCount } = await h.svc.createUpload(USER, { filename, sizeBytes: content.length });
    return { id: importId, partCount };
  }

  it('putPart: idempotent per n (a retried part overwrites, the count does not double)', async () => {
    const h = harness();
    const { id } = await started(h, 'a.csv', Buffer.from('a,b\n1,2\n'));
    await expect(h.svc.putPart(USER, id, '0', h.part('a,b\n1,2\n'))).resolves.toEqual({ partsReceived: 1 });
    await expect(h.svc.putPart(USER, id, '0', h.part('a,b\n1,2\n'))).resolves.toEqual({ partsReceived: 1 });
    expect(h.storage.uploadFile).toHaveBeenCalledTimes(2);
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

  it('putPart: 409 unless UPLOADING; a part racing a cancel is removed again', async () => {
    const h = harness();
    const { id } = await started(h, 'a.csv', Buffer.from('abc'));
    h.rows.get(id)!.status = 'QUEUED';
    await expect(h.svc.putPart(USER, id, '0', h.part('abc'))).rejects.toBeInstanceOf(ConflictException);
    h.rows.get(id)!.status = 'UPLOADING';
    h.prisma.salesImport.updateMany.mockImplementationOnce(async () => ({ count: 0 })); // cancelled mid-flight
    await expect(h.svc.putPart(USER, id, '0', h.part('abc'))).rejects.toBeInstanceOf(ConflictException);
    expect(h.storage.deleteFile).toHaveBeenCalledWith(partKey(`sales-imports/t1/${id}/`, 0));
  });

  it('complete: missing parts → 400 naming them; then QUEUED + kick', async () => {
    const h = harness();
    const content = Buffer.from('code,amt\n1,2\n');
    const { id } = await started(h, 'a.csv', content);
    await expect(h.svc.complete(USER, id)).rejects.toThrow('missing part(s) 0');
    await h.svc.putPart(USER, id, '0', h.part(content));
    const s = await h.svc.complete(USER, id);
    expect(s).toMatchObject({ id, status: 'QUEUED', partsReceived: 1, uploadedBy: 'Admin', progressPct: null });
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

    const utf16 = Buffer.from('\uFEFFcode,amt\n', 'utf16le');
    const c2 = await started(h, 'b.csv', utf16);
    await h.svc.putPart(USER, c2.id, '0', h.part(utf16));
    await expect(h.svc.complete(USER, c2.id)).rejects.toThrow('UTF-8');

    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x31, 0x0a]); // "café,1" in Latin-1
    const c3 = await started(h, 'c.csv', latin1);
    await h.svc.putPart(USER, c3.id, '0', h.part(latin1));
    await expect(h.svc.complete(USER, c3.id)).rejects.toThrow('UTF-8');
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
  async function inState(h: ReturnType<typeof harness>, status: string) {
    const { importId } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 3 });
    Object.assign(h.rows.get(importId)!, { status, error: 'old', attempts: 2, rowsRead: 9 });
    return importId;
  }

  it.each(['READY', 'NEEDS_MAPPING', 'FAILED'])('reprocess from %s → QUEUED (reset) in one tx with aggregates deleted, then kick', async (st) => {
    const h = harness();
    const id = await inState(h, st);
    const s = await h.svc.reprocess(USER, id);
    expect(s).toMatchObject({ status: 'QUEUED', error: null, rowsRead: 0 });
    expect(h.rows.get(id)!.attempts).toBe(0);
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.prisma.salesImportAggregate.deleteMany).toHaveBeenCalledWith({ where: { importId: id } });
    expect(h.runner.kick).toHaveBeenCalled();
  });

  it.each(['UPLOADING', 'QUEUED', 'PROCESSING', 'CANCELLED'])('reprocess from %s → 409', async (st) => {
    const h = harness();
    await expect(h.svc.reprocess(USER, await inState(h, st))).rejects.toBeInstanceOf(ConflictException);
  });

  it.each(['UPLOADING', 'QUEUED', 'READY', 'NEEDS_MAPPING', 'FAILED'])('DELETE from %s → CANCELLED, files + aggregates removed', async (st) => {
    const h = harness();
    const id = await inState(h, st);
    h.objects.set(partKey(`sales-imports/t1/${id}/`, 0), Buffer.from('abc'));
    const s = await h.svc.remove(USER, id);
    expect(s.status).toBe('CANCELLED');
    expect(h.storage.deletePrefix).toHaveBeenCalledWith(`sales-imports/t1/${id}/`);
    expect(h.objects.size).toBe(0);
    expect(h.prisma.salesImportAggregate.deleteMany).toHaveBeenCalledWith({ where: { importId: id } });
  });

  it('DELETE is idempotent (a second call succeeds and re-runs the cleanup)', async () => {
    const h = harness();
    const id = await inState(h, 'FAILED');
    await h.svc.remove(USER, id);
    await expect(h.svc.remove(USER, id)).resolves.toMatchObject({ status: 'CANCELLED' });
    expect(h.storage.deletePrefix).toHaveBeenCalledTimes(2);
  });

  it('DELETE refuses PROCESSING and applied imports (409), and other tenants (404)', async () => {
    const h = harness();
    const busy = await inState(h, 'PROCESSING');
    await expect(h.svc.remove(USER, busy)).rejects.toThrow('being processed');
    const applied = await inState(h, 'READY');
    h.prisma.salesImportApply.count.mockResolvedValueOnce(2);
    await expect(h.svc.remove(USER, applied)).rejects.toThrow('applied');
    await expect(h.svc.remove(OTHER, applied)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.storage.deletePrefix).not.toHaveBeenCalled();
  });
});

describe('SalesImportUploadService — read', () => {
  it('get: summary + detail, progressPct only while PROCESSING, detectedHeaders only for NEEDS_MAPPING', async () => {
    const h = harness();
    const { importId: id } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 1000 });
    Object.assign(h.rows.get(id)!, { status: 'PROCESSING', bytesRead: 333n, detectedHeaders: [['A']] });
    expect(await h.svc.get(USER, id)).toMatchObject({ progressPct: 33.3, detectedHeaders: null, monthSummaries: null, errorSamples: null });
    Object.assign(h.rows.get(id)!, { status: 'NEEDS_MAPPING' });
    expect(await h.svc.get(USER, id)).toMatchObject({ progressPct: null, detectedHeaders: [['A']] });
    await expect(h.svc.get(OTHER, id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list: tenant-scoped, hides CANCELLED, pages with a cursor, rejects a foreign cursor', async () => {
    const h = harness();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { importId } = await h.svc.createUpload(USER, { filename: `f${i}.csv`, sizeBytes: 1 });
      h.rows.get(importId)!.createdAt = new Date(Date.UTC(2026, 9, 1 + i));
      ids.push(importId);
    }
    h.rows.get(ids[1])!.status = 'CANCELLED';
    const r = await h.svc.list(USER, { limit: 50 });
    expect(r.items.map((i) => i.id)).toEqual([ids[2], ids[0]]);
    expect(r.nextCursor).toBeNull();
    expect(h.prisma.salesImport.findMany.mock.calls[0][0].where).toEqual({ clientId: 't1', status: { not: 'CANCELLED' } });
    expect(h.prisma.salesImport.findMany.mock.calls[0][0].take).toBe(51);
    await expect(h.svc.list(OTHER, { cursor: ids[0] })).rejects.toThrow('Invalid cursor');
    expect((await h.svc.list(OTHER, {})).items).toEqual([]);
  });

  it('combos: latest READY, 404 when the tenant has none; a specific id returns its frozen picker data', async () => {
    const h = harness();
    await expect(h.svc.combos(USER, 'latest')).rejects.toBeInstanceOf(NotFoundException);
    const { importId: id } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 1 });
    Object.assign(h.rows.get(id)!, { status: 'READY', dimensionValues: { dimA: [{ value: 'P', lines: 1, amountRupees: 1 }] }, dimensionCombos: [] });
    await expect(h.svc.combos(USER, 'latest')).resolves.toEqual({ importId: id, dimensionValues: { dimA: [{ value: 'P', lines: 1, amountRupees: 1 }] }, dimensionCombos: [] });
    await expect(h.svc.combos(OTHER, 'latest')).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.svc.combos(OTHER, id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('unmatched.csv: READY only and must exist; streams the stored object', async () => {
    const h = harness();
    const { importId: id } = await h.svc.createUpload(USER, { filename: 'a.csv', sizeBytes: 1 });
    await expect(h.svc.unmatchedCsv(USER, id)).rejects.toBeInstanceOf(NotFoundException);
    h.rows.get(id)!.status = 'READY';
    await expect(h.svc.unmatchedCsv(USER, id)).rejects.toThrow('not available');
    h.objects.set(`sales-imports/t1/${id}/unmatched.csv`, Buffer.from('h\r\n'));
    const r = await h.svc.unmatchedCsv(USER, id);
    expect(r.filename).toBe(`sales-import-${id}-unmatched.csv`);
    const chunks: Buffer[] = [];
    for await (const c of r.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('h\r\n');
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
