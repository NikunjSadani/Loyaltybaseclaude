import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { SalesImport } from '@prisma/client';
import type { SalesColumnMapping } from '../sales-import.contract';
import { AGGREGATE_CHUNK, SalesImportProcessorService } from './sales-import-processor.service';
import { partKey, unmatchedCsvKey } from './parts-file';
import { computeRosterHash } from './roster';
import { exceljsWorkbook } from './test-fixtures.testspec';

// Synthetic tenant "t1", outlets O1/O2, neutral dims. Dates relative to a fixed past month are fine
// here (they are in the past, so the today+1 window never rejects them).
const MAPPING: SalesColumnMapping = {
  sheetName: null,
  headerRow: 'auto',
  outletCode: 'Customer Code',
  outletName: 'Customer',
  invoiceDate: 'Invoice Date',
  amount: 'Net Amt',
  quantity: 'Qty',
  dimensions: [
    { key: 'dimA', label: 'A', header: 'Code' },
    { key: 'dimB', label: 'B', header: 'Group' },
  ],
  dateOrder: 'DMY',
};

const CSV = [
  'X,X,X,X,X,X,X',
  'Invoice Date,Customer Code,Customer,Code,Group,Net Amt,Qty',
  '03-10-2026,O1,Shop One,P,500,100.00,1.5',
  '20-10-2026,O1,Shop One,P,500,-40.00,-0.5',
  '21-10-2026,O2,Shop Two,Q,200,"1,000.50",2',
  '01-11-2026,O1,Shop One,P,500,10.00,0.04',
  '05-10-2026,U9,Stranger,P,500,7.50,1',
  '31-02-2026,O1,Shop One,P,500,1,1',
  ',,,,,,',
  '',
].join('\r\n');

class FakeStorage {
  objects = new Map<string, Buffer>();
  uploads = new Map<string, string>();
  openReadStream(key: string, range?: { start?: number; end?: number }): Readable {
    const buf = this.objects.get(key);
    if (!buf) {
      const r = new Readable({ read() {} });
      process.nextTick(() => r.destroy(new Error(`No such object: ${key}`)));
      return r;
    }
    const s = range?.start ?? 0;
    const e = range?.end !== undefined ? range.end + 1 : buf.length;
    const slice = buf.subarray(s, e);
    return Readable.from((function* () {
      for (let i = 0; i < slice.length; i += 997) yield slice.subarray(i, i + 997);
    })());
  }
  async uploadStream(key: string, source: Readable): Promise<string> {
    const chunks: string[] = [];
    for await (const c of source) chunks.push(String(c));
    this.uploads.set(key, chunks.join(''));
    return key;
  }
}

function makeImport(over: Partial<SalesImport> = {}): SalesImport {
  return {
    id: 'imp1',
    clientId: 't1',
    uploadedById: 'u1',
    originalFilename: 'sales.csv',
    fileKind: 'CSV',
    sizeBytes: 0n,
    partCount: 1,
    partsReceived: 1,
    gcsPrefix: 'sales-imports/t1/imp1/',
    status: 'PROCESSING',
    contentSha256: null,
    duplicateOfId: null,
    mappingSnapshot: null,
    detectedHeaders: null,
    rosterHash: null,
    bytesRead: 0n,
    rowsRead: 0,
    rowsSkipped: 0,
    errorSamples: null,
    monthSummaries: null,
    dimensionValues: null,
    dimensionCombos: null,
    error: null,
    attempts: 1,
    heartbeatAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    updatedAt: new Date(),
    ...over,
  } as SalesImport;
}

function setup(opts: { file: Buffer; kind?: 'CSV' | 'XLSX'; mapping?: SalesColumnMapping | null; enabled?: boolean; roster?: string[]; storedSize?: number; attempts?: number }) {
  const storage = new FakeStorage();
  const row = makeImport({ fileKind: opts.kind ?? 'CSV', sizeBytes: BigInt(opts.storedSize ?? opts.file.length), attempts: opts.attempts ?? 1 });
  storage.objects.set(partKey(row.gcsPrefix, 0), opts.file);
  const calls: string[] = [];
  const prisma = {
    client: { findUnique: jest.fn().mockResolvedValue({ features: { salesImport: opts.enabled ?? true }, status: 'ACTIVE' }) },
    salesImportProfile: { findUnique: jest.fn().mockResolvedValue(opts.mapping === null ? null : { columnMapping: opts.mapping ?? MAPPING }) },
    outlet: { findMany: jest.fn().mockResolvedValue((opts.roster ?? ['O1', 'O2']).map((outletCode) => ({ outletCode }))) },
    salesImport: {
      updateMany: jest.fn().mockImplementation(async () => {
        calls.push('updateMany');
        return { count: 1 };
      }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    salesImportAggregate: {
      deleteMany: jest.fn().mockImplementation(async () => {
        calls.push('deleteMany');
        return { count: 0 };
      }),
      createMany: jest.fn().mockImplementation(async ({ data }: { data: unknown[] }) => {
        calls.push(`createMany:${data.length}`);
        return { count: data.length };
      }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const svc = new SalesImportProcessorService(prisma as never, storage as never);
  /** The terminal write (last updateMany whose data has a status). */
  const final = () => {
    const c = prisma.salesImport.updateMany.mock.calls.map((a) => a[0]).filter((a) => a.data.status);
    return c[c.length - 1];
  };
  return { svc, prisma, storage, row, calls, final };
}

describe('SalesImportProcessorService.processClaimed', () => {
  it('READY (CSV): aggregates, month summaries, sha256, roster hash, unmatched.csv, skip samples', async () => {
    const file = Buffer.from(CSV, 'utf8');
    const { svc, prisma, storage, row, final } = setup({ file });
    await svc.processClaimed(row);

    const f = final();
    expect(f.where).toEqual({ id: 'imp1', status: 'PROCESSING', attempts: 1 });
    expect(f.data).toMatchObject({
      status: 'READY',
      error: null,
      contentSha256: createHash('sha256').update(file).digest('hex'),
      duplicateOfId: null,
      rosterHash: computeRosterHash(['O1', 'O2']),
      rowsRead: 6,
      rowsSkipped: 1,
      bytesRead: BigInt(file.length),
      errorSamples: [{ row: 8, column: 'INVOICE DATE', reason: 'invalid date' }],
    });
    expect(f.data.monthSummaries).toEqual([
      {
        month: '2026-10', firstDate: '2026-10-03', lastDate: '2026-10-21', lines: 4,
        matchedOutlets: 2, unmatchedCustomers: 1,
        matchedAmountRupees: 1060.5, matchedQuantity: 3, unmatchedAmountRupees: 7.5, unmatchedQuantity: 1,
      },
      {
        month: '2026-11', firstDate: '2026-11-01', lastDate: '2026-11-01', lines: 1,
        matchedOutlets: 1, unmatchedCustomers: 0,
        matchedAmountRupees: 10, matchedQuantity: 0.04, unmatchedAmountRupees: 0, unmatchedQuantity: 0,
      },
    ]);
    expect(f.data.mappingSnapshot).toEqual(MAPPING);
    expect(f.data.dimensionCombos).toEqual([
      { dims: { dimA: 'Q', dimB: '200' }, lines: 1, amountRupees: 1000.5, quantity: 2 },
      { dims: { dimA: 'P', dimB: '500' }, lines: 4, amountRupees: 77.5, quantity: 2.04 },
    ]);

    const written = prisma.salesImportAggregate.createMany.mock.calls.flatMap((c) => c[0].data);
    expect(written).toEqual([
      { importId: 'imp1', month: '2026-10', outletCode: 'O1', dims: { dimA: 'P', dimB: '500' }, dimKey: '{"dimA":"P","dimB":"500"}', amountPaise: 6000n, qtyMicro: 1_000_000n, lines: 2 },
      { importId: 'imp1', month: '2026-10', outletCode: 'O2', dims: { dimA: 'Q', dimB: '200' }, dimKey: '{"dimA":"Q","dimB":"200"}', amountPaise: 100050n, qtyMicro: 2_000_000n, lines: 1 },
      { importId: 'imp1', month: '2026-11', outletCode: 'O1', dims: { dimA: 'P', dimB: '500' }, dimKey: '{"dimA":"P","dimB":"500"}', amountPaise: 1000n, qtyMicro: 40_000n, lines: 1 },
    ]);
    expect(storage.uploads.get(unmatchedCsvKey(row.gcsPrefix))).toBe(
      'Customer code,Customer name,Month,Lines,Amount (Rs),Quantity\r\nU9,Stranger,2026-10,1,7.5,1\r\n',
    );
  });

  it('reprocess is idempotent: old aggregates are deleted BEFORE new ones are written, in 5k chunks', async () => {
    const n = 2 * AGGREGATE_CHUNK + 7;
    const codes = Array.from({ length: n }, (_, i) => `C${i}`);
    const lines = ['Invoice Date,Customer Code,Customer,Code,Group,Net Amt,Qty', ...codes.map((c) => `03-10-2026,${c},n,P,500,1,1`)];
    const { svc, calls, row, final } = setup({ file: Buffer.from(lines.join('\n')), roster: codes });
    await svc.processClaimed(row);
    expect(final().data.status).toBe('READY');
    const writes = calls.filter((c) => c === 'deleteMany' || c.startsWith('createMany'));
    expect(writes).toEqual(['deleteMany', `createMany:${AGGREGATE_CHUNK}`, `createMany:${AGGREGATE_CHUNK}`, 'createMany:7']);
  });

  it('READY (XLSX in Excel entry order) through the re-sequencer', async () => {
    const file = await exceljsWorkbook([
      [
        'Data',
        [
          ['X', 'X'],
          ['Invoice Date', 'Customer Code', 'Customer', 'Code', 'Group', 'Net Amt', 'Qty'],
          [new Date(Date.UTC(2026, 9, 3)), 'O1', 'Shop', 'p', 500, 100.25, 1.5],
          [new Date(Date.UTC(2026, 9, 4)), 'O1', 'Shop', 'P', '500', -0.25, 0.5],
        ],
      ],
    ]);
    const { svc, prisma, row, final } = setup({ file, kind: 'XLSX' });
    await svc.processClaimed(row);
    expect(final().data).toMatchObject({ status: 'READY', rowsRead: 2, rowsSkipped: 0, contentSha256: createHash('sha256').update(file).digest('hex') });
    expect(prisma.salesImportAggregate.createMany.mock.calls[0][0].data).toEqual([
      { importId: 'imp1', month: '2026-10', outletCode: 'O1', dims: { dimA: 'P', dimB: '500' }, dimKey: '{"dimA":"P","dimB":"500"}', amountPaise: 10000n, qtyMicro: 2_000_000n, lines: 2 },
    ]);
  });

  it('a duplicate of an earlier READY upload (same tenant + sha) sets duplicateOfId', async () => {
    const { svc, prisma, row, final } = setup({ file: Buffer.from(CSV) });
    prisma.salesImport.findFirst.mockResolvedValue({ id: 'older' });
    await svc.processClaimed(row);
    expect(final().data.duplicateOfId).toBe('older');
    expect(prisma.salesImport.findFirst.mock.calls[0][0].where).toMatchObject({ clientId: 't1', status: 'READY', id: { not: 'imp1' } });
  });

  it('NEEDS_MAPPING when no profile exists: detectedHeaders = first 10 rows as text', async () => {
    const { svc, prisma, row, final } = setup({ file: Buffer.from(CSV), mapping: null });
    await svc.processClaimed(row);
    const f = final();
    expect(f.data.status).toBe('NEEDS_MAPPING');
    expect(f.data.error).toContain('No column mapping');
    expect(f.data.detectedHeaders).toHaveLength(8); // the file has 8 non-blank rows
    expect(f.data.detectedHeaders[1]).toEqual(['Invoice Date', 'Customer Code', 'Customer', 'Code', 'Group', 'Net Amt', 'Qty']);
    expect(prisma.salesImportAggregate.createMany).not.toHaveBeenCalled();
  });

  it('NEEDS_MAPPING when a mapped header is missing (reason names it)', async () => {
    const { svc, row, final } = setup({ file: Buffer.from(CSV), mapping: { ...MAPPING, invoiceDate: 'Bill Date' } });
    await svc.processClaimed(row);
    expect(final().data).toMatchObject({ status: 'NEEDS_MAPPING' });
    expect(final().data.error).toContain('BILL DATE');
  });

  it('NEEDS_MAPPING when the mapped sheet does not exist', async () => {
    const file = await exceljsWorkbook([['Data', [['a']]]]);
    const { svc, row, final } = setup({ file, kind: 'XLSX', mapping: { ...MAPPING, sheetName: 'Other' } });
    await svc.processClaimed(row);
    expect(final().data).toMatchObject({ status: 'NEEDS_MAPPING', error: 'Sheet "Other" was not found in the file (sheets: Data).' });
  });

  it('FAILED when the flag is off (worker re-checks, uncached)', async () => {
    const { svc, prisma, row, final } = setup({ file: Buffer.from(CSV), enabled: false });
    await svc.processClaimed(row);
    expect(final().data).toMatchObject({ status: 'FAILED', error: 'Sales Import is not enabled for this tenant.' });
    expect(prisma.salesImportProfile.findUnique).not.toHaveBeenCalled();
  });

  it('FAILED after too many attempts', async () => {
    const { svc, row, final } = setup({ file: Buffer.from(CSV), attempts: 4 });
    await svc.processClaimed(row);
    expect(final().data.status).toBe('FAILED');
    expect(final().data.error).toContain('3 times');
  });

  it('FAILED with a readable message for a corrupt .xlsx', async () => {
    const { svc, row, final } = setup({ file: Buffer.from('PK\u0003\u0004 this is not really a zip'), kind: 'XLSX' });
    await svc.processClaimed(row);
    expect(final().data.status).toBe('FAILED');
    expect(final().data.error).toMatch(/not a readable \.xlsx workbook/);
  });

  it('FAILED when fewer bytes are stored than declared', async () => {
    const file = Buffer.from(CSV);
    const { svc, row, final } = setup({ file, storedSize: file.length + 10 });
    await svc.processClaimed(row);
    expect(final().data).toMatchObject({ status: 'FAILED' });
    expect(final().data.error).toContain('incomplete');
  });

  it('an unexpected (DB) error → FAILED with a generic message, no internals leaked', async () => {
    const { svc, prisma, row, final } = setup({ file: Buffer.from(CSV) });
    prisma.salesImportAggregate.createMany.mockRejectedValue(new Error('connection to server at "10.0.0.1" failed'));
    const errSpy = jest.spyOn((svc as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => undefined);
    await svc.processClaimed(row);
    expect(final().data.status).toBe('FAILED');
    expect(final().data.error).not.toContain('10.0.0.1');
    expect(final().data.error).toContain('Reprocess');
    expect(errSpy).toHaveBeenCalled();
  });

  it('claimNext delegates to the SKIP LOCKED claim', async () => {
    const { svc, prisma } = setup({ file: Buffer.from(CSV) });
    prisma.$queryRaw.mockResolvedValue([makeImport({ id: 'claimed' })]);
    await expect(svc.claimNext()).resolves.toMatchObject({ id: 'claimed' });
  });
});
