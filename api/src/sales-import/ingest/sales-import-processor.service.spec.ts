import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { SalesImport } from '@prisma/client';
import type { SalesColumnMapping } from '../sales-import.contract';
import { AGGREGATE_CHUNK, HeapGuard, SalesImportProcessorService } from './sales-import-processor.service';
import { partKey, unmatchedCsvKey } from './parts-file';
import { SALES_IMPORT_PART_SIZE } from '../sales-import.contract';
import { mappingFingerprint } from './mapping-fingerprint';
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
    claimToken: 'tok',
    mappingFingerprint: null,
    processingVersion: 0,
    purgedAt: null,
    queuedAt: null,
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
  const terminal: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const prisma = {
    client: { findUnique: jest.fn().mockResolvedValue({ features: { salesImport: opts.enabled ?? true }, status: 'ACTIVE' }) },
    salesImportProfile: { findUnique: jest.fn().mockResolvedValue(opts.mapping === null ? null : { columnMapping: opts.mapping ?? MAPPING }) },
    outlet: { findMany: jest.fn().mockResolvedValue((opts.roster ?? ['O1', 'O2']).map((outletCode) => ({ outletCode }))) },
    salesImport: {
      updateMany: jest.fn().mockImplementation(async (a: { where: unknown; data: Record<string, unknown> }) => {
        calls.push('updateMany');
        if (a.data.status) terminal.push(a);
        return { count: 1 };
      }),
      update: jest.fn().mockImplementation(async (a: { where: unknown; data: Record<string, unknown> }) => {
        calls.push('update');
        if (a.data.status) terminal.push(a);
        return {};
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
    // The READY transaction re-locks the row by its claim token first (M2).
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'imp1' }]),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));
  const svc = new SalesImportProcessorService(prisma as never, storage as never);
  /** The terminal write (the last update / updateMany whose data has a status). */
  const final = () => terminal[terminal.length - 1] as { where: Record<string, unknown>; data: Record<string, any> };
  return { svc, prisma, storage, row, calls, final };
}

describe('SalesImportProcessorService.processClaimed', () => {
  it('READY (CSV): aggregates, month summaries, sha256, roster hash, unmatched.csv, skip samples', async () => {
    const file = Buffer.from(CSV, 'utf8');
    const { svc, prisma, storage, row, final } = setup({ file });
    await svc.processClaimed(row);

    const f = final();
    expect(f.where).toEqual({ id: 'imp1' });
    // ...inside ONE transaction that first re-locked the row BY ITS CLAIM TOKEN (M2)
    const lockSql = prisma.$queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    expect(lockSql.strings.join('?')).toContain('"claimToken" = ?');
    expect(lockSql.values).toEqual(['imp1', 'tok']);
    expect(f.data).toMatchObject({
      status: 'READY',
      error: null,
      contentSha256: createHash('sha256').update(file).digest('hex'),
      duplicateOfId: null,
      mappingFingerprint: mappingFingerprint(MAPPING),
      processingVersion: { increment: 1 },
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
      { importId: 'imp1', month: '2026-10', outletCode: 'O1', dims: { dimA: 'P', dimB: '500' }, dimKey: '{"dimA":"P","dimB":"500"}', amountPaise: 6000n, qtyPico: 1_000_000n * 1_000_000n, lines: 2 },
      { importId: 'imp1', month: '2026-10', outletCode: 'O2', dims: { dimA: 'Q', dimB: '200' }, dimKey: '{"dimA":"Q","dimB":"200"}', amountPaise: 100050n, qtyPico: 2_000_000n * 1_000_000n, lines: 1 },
      // M6: the unmatched customer is aggregated too (apply maps codes onto the roster current at apply time)
      { importId: 'imp1', month: '2026-10', outletCode: 'U9', dims: { dimA: 'P', dimB: '500' }, dimKey: '{"dimA":"P","dimB":"500"}', amountPaise: 750n, qtyPico: 1_000_000n * 1_000_000n, lines: 1 },
      { importId: 'imp1', month: '2026-11', outletCode: 'O1', dims: { dimA: 'P', dimB: '500' }, dimKey: '{"dimA":"P","dimB":"500"}', amountPaise: 1000n, qtyPico: 40_000n * 1_000_000n, lines: 1 },
    ]);
    // M1 (re-check): the CSV is per run (claim token) and its key is stored on the row in the READY write
    expect(f.data.unmatchedCsvKey).toBe(unmatchedCsvKey(row.gcsPrefix, 'tok'));
    expect(storage.uploads.get(unmatchedCsvKey(row.gcsPrefix, 'tok'))).toBe(
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
      { importId: 'imp1', month: '2026-10', outletCode: 'O1', dims: { dimA: 'P', dimB: '500' }, dimKey: '{"dimA":"P","dimB":"500"}', amountPaise: 10000n, qtyPico: 2_000_000n * 1_000_000n, lines: 2 },
    ]);
  });

  it('a duplicate of an earlier READY upload (same tenant + sha) sets duplicateOfId', async () => {
    const { svc, prisma, row, final } = setup({ file: Buffer.from(CSV) });
    prisma.salesImport.findFirst.mockResolvedValue({ id: 'older' });
    await svc.processClaimed(row);
    expect(final().data.duplicateOfId).toBe('older');
    expect(prisma.salesImport.findFirst.mock.calls[0][0].where).toMatchObject({ clientId: 't1', status: 'READY', id: { notIn: ['imp1'] } });
  });

  it("L2 (re-check): a 'reprocess as new' import is never a duplicate of its own parent", async () => {
    const { svc, prisma, row } = setup({ file: Buffer.from(CSV) });
    await svc.processClaimed({ ...row, reprocessedFromId: 'parent' } as never);
    expect(prisma.salesImport.findFirst.mock.calls[0][0].where.id).toEqual({ notIn: ['imp1', 'parent'] });
  });

  it('NEEDS_MAPPING when no profile exists: detectedHeaders = best-guess header row + 3 sample rows (S3)', async () => {
    const { svc, prisma, row, final } = setup({ file: Buffer.from(CSV), mapping: null });
    await svc.processClaimed(row);
    const f = final();
    expect(f.data.status).toBe('NEEDS_MAPPING');
    expect(f.data.error).toContain('No column mapping');
    expect(f.where).toEqual({ id: 'imp1', status: 'PROCESSING', claimToken: 'tok' });
    expect(f.data.detectedHeaders).toHaveLength(4); // the "X" marker row is skipped as the guess
    expect(f.data.detectedHeaders[0]).toEqual(['Invoice Date', 'Customer Code', 'Customer', 'Code', 'Group', 'Net Amt', 'Qty']);
    expect(f.data.detectedHeaders[1][1]).toBe('O1');
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

describe('SalesImportProcessorService — audit fix round', () => {
  it('M2: a superseded claim (token gone at the final lock) writes NOTHING — no aggregates, no status', async () => {
    const { svc, prisma, row, final } = setup({ file: Buffer.from(CSV) });
    prisma.$queryRaw.mockResolvedValue([]); // reprocess / cancel cleared or replaced the token
    await svc.processClaimed(row);
    expect(final()).toBeUndefined();
    expect(prisma.salesImportAggregate.deleteMany).not.toHaveBeenCalled();
    expect(prisma.salesImportAggregate.createMany).not.toHaveBeenCalled();
  });

  it('M2/M3: a heartbeat that matches no row (cancelled) stops the parse without writing', async () => {
    const rows = ['Invoice Date,Customer Code,Customer,Code,Group,Net Amt,Qty'];
    for (let i = 0; i < 45_000; i++) rows.push(`03-10-2026,O1,S,P,500,1,1`);
    const { svc, prisma, row, final } = setup({ file: Buffer.from(rows.join('\n')) });
    prisma.salesImport.updateMany.mockImplementation(async (a: { data: Record<string, unknown> }) => ({ count: a.data.status ? 1 : 0 }));
    await svc.processClaimed(row);
    expect(final()).toBeUndefined();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('M2: a claim without a token never runs', async () => {
    const { svc, prisma, row, final } = setup({ file: Buffer.from(CSV) });
    await svc.processClaimed({ ...row, claimToken: null });
    expect(final()).toBeUndefined();
    expect(prisma.client.findUnique).not.toHaveBeenCalled();
  });

  it('M1: a storage error mid-stream fails the import cleanly with a readable message (pipeline propagates it)', async () => {
    const file = Buffer.from(CSV);
    // declared size spans two parts but part 1 is missing → the GCS read of part 1 errors after part 0 streamed
    const { svc, row, final } = setup({ file, storedSize: SALES_IMPORT_PART_SIZE + 10 });
    const big = Buffer.concat([file, Buffer.alloc(SALES_IMPORT_PART_SIZE - file.length, 0x0a)]);
    (svc as unknown as { storage: { objects: Map<string, Buffer> } }).storage.objects.set(partKey(row.gcsPrefix, 0), big);
    await svc.processClaimed(row);
    expect(final().data.status).toBe('FAILED');
    expect(final().data.error).toMatch(/could not be read: No such object/);
  });

  it("L1: a ';'-delimited CSV reads ',' as the decimal separator (auto)", async () => {
    const csv = ['Invoice Date;Customer Code;Customer;Code;Group;Net Amt;Qty', '03-10-2026;O1;S;P;500;1.234,50;0,5'].join('\n');
    const { svc, prisma, row, final } = setup({ file: Buffer.from(csv) });
    await svc.processClaimed(row);
    expect(final().data.status).toBe('READY');
    expect(prisma.salesImportAggregate.createMany.mock.calls[0][0].data[0]).toMatchObject({ amountPaise: 123450n, qtyPico: 500_000_000_000n });
  });

  it("L1: the profile's explicit '.' wins over the ';' auto-detection", async () => {
    const csv = ['Invoice Date;Customer Code;Customer;Code;Group;Net Amt;Qty', '03-10-2026;O1;S;P;500;1234.50;0.5'].join('\n');
    const { svc, prisma, row } = setup({ file: Buffer.from(csv), mapping: { ...MAPPING, decimalSeparator: '.' } });
    await svc.processClaimed(row);
    expect(prisma.salesImportAggregate.createMany.mock.calls[0][0].data[0]).toMatchObject({ amountPaise: 123450n });
  });

  it('S3: detectedHeaders is capped (columns, 50-char cells, ≤ 3 sample rows)', async () => {
    const wide = Array.from({ length: 400 }, (_, i) => `H${i}`);
    const long = 'Z'.repeat(80);
    const csv = [wide.join(','), ...Array.from({ length: 6 }, () => wide.map(() => long).join(','))].join('\n');
    const { svc, row, final } = setup({ file: Buffer.from(csv), mapping: null });
    await svc.processClaimed(row);
    const dh = final().data.detectedHeaders as string[][];
    expect(dh).toHaveLength(4);
    expect(dh[0]).toHaveLength(300);
    expect(dh[1][0]).toHaveLength(50);
  });

  it('S4: an unclosed quote that would swallow the file fails with a readable CSV message', async () => {
    const csv = 'Invoice Date,Customer Code,Customer,Code,Group,Net Amt,Qty\n03-10-2026,O1,"' + 'a'.repeat(40_000);
    const { svc, row, final } = setup({ file: Buffer.from(csv) });
    await svc.processClaimed(row);
    expect(final().data.status).toBe('FAILED');
    expect(final().data.error).toMatch(/longer than .* characters/);
  });
});

describe('SalesImportProcessorService — re-audit H1 (auto decimal separator decided once per file)', () => {
  const HDR = 'Invoice Date;Customer Code;Customer;Code;Group;Net Amt;Qty';
  const csv = (...lines: string[]) => Buffer.from([HDR, ...lines].join('\n'));
  const written = (prisma: { salesImportAggregate: { createMany: jest.Mock } }) =>
    prisma.salesImportAggregate.createMany.mock.calls.flatMap((c) => c[0].data as Array<Record<string, unknown>>);

  it("';' file with '2.000' cases and '0.500' rupees → '.' decided from evidence (re-read): 2 cases, ₹0.50 — not 2000 / ₹500", async () => {
    const { svc, prisma, row, final } = setup({ file: csv('03-10-2026;O1;S;P;500;0.500;2.000') });
    await svc.processClaimed(row);
    expect(final().data.status).toBe('READY');
    expect(written(prisma)).toEqual([expect.objectContaining({ outletCode: 'O1', amountPaise: 50n, qtyPico: 2_000_000_000_000n })]);
    expect(final().data.rowsSkipped).toBe(0);
  });

  it("';' file with '1,234.56' → ₹1,234.56 (not ₹1.23)", async () => {
    const { svc, prisma, row, final } = setup({ file: csv('03-10-2026;O1;S;P;500;1,234.56;1') });
    await svc.processClaimed(row);
    expect(final().data.status).toBe('READY');
    expect(written(prisma)[0]).toMatchObject({ amountPaise: 123456n, qtyPico: 1_000_000_000_000n });
  });

  it("';' file whose only separators are ambiguous ('2.000') → NEEDS_MAPPING 'choose the decimal separator', never a guess", async () => {
    const { svc, prisma, row, final } = setup({ file: csv('03-10-2026;O1;S;P;500;7;2.000', '04-10-2026;O1;S;P;500;8;1.500') });
    await svc.processClaimed(row);
    expect(final().data.status).toBe('NEEDS_MAPPING');
    expect(final().data.error).toMatch(/Choose the decimal separator.*"2\.000"/);
    expect(prisma.salesImportAggregate.createMany).not.toHaveBeenCalled();
  });

  it("a file mixing '1,5' and '0.5' → NEEDS_MAPPING naming both", async () => {
    const { svc, row, final } = setup({ file: csv('03-10-2026;O1;S;P;500;1,5;1', '04-10-2026;O1;S;P;500;0.5;1') });
    await svc.processClaimed(row);
    expect(final().data).toMatchObject({ status: 'NEEDS_MAPPING' });
    expect(final().data.error).toMatch(/both "\." and ","/);
  });

  it("explicit ',' mode: a contradicting '1,234.56' is INVALID (skipped + counted), never re-read; '2.000' = 2000 as configured", async () => {
    const { svc, prisma, row, final } = setup({
      file: csv('03-10-2026;O1;S;P;500;1,234.56;1', '04-10-2026;O1;S;P;500;2.000;1'),
      mapping: { ...MAPPING, decimalSeparator: ',' },
    });
    await svc.processClaimed(row);
    expect(final().data).toMatchObject({ status: 'READY', rowsSkipped: 1, errorSamples: [{ row: 2, column: 'NET AMT', reason: 'invalid amount' }] });
    expect(written(prisma)[0]).toMatchObject({ amountPaise: 200000n });
  });

  it("explicit '.' mode: '1,5' is INVALID, not 15", async () => {
    const { svc, row, final } = setup({ file: csv('03-10-2026;O1;S;P;500;1,5;1'), mapping: { ...MAPPING, decimalSeparator: '.' } });
    await svc.processClaimed(row);
    expect(final().data).toMatchObject({ status: 'READY', rowsSkipped: 1 });
  });
});

describe('SalesImportProcessorService — re-audit memory / M2', () => {
  it('a heap past the guard fails the import readably (FileProblem) instead of an OOM kill', async () => {
    const lines = ['Invoice Date,Customer Code,Customer,Code,Group,Net Amt,Qty'];
    for (let i = 0; i < 20_050; i++) lines.push('03-10-2026,O1,S,P,500,1,1'); // two checks (10k rows apart) must both be over
    const { svc, row, final } = setup({ file: Buffer.from(lines.join('\n')) });
    const v8 = jest.requireActual('node:v8') as typeof import('node:v8');
    const real = v8.getHeapStatistics();
    const spy = jest.spyOn(v8, 'getHeapStatistics').mockImplementation(() => ({ ...real, used_heap_size: real.heap_size_limit }));
    try {
      await svc.processClaimed(row);
    } finally {
      spy.mockRestore();
    }
    expect(final().data).toMatchObject({ status: 'FAILED' });
    expect(final().data.error).toMatch(/too large to process/);
  });

  it('M2: an xlsx entry inflating beyond its declared size → FAILED with the readable xlsx message', async () => {
    const good = await exceljsWorkbook([['Data', [['Invoice Date', 'Customer Code', 'Customer', 'Code', 'Group', 'Net Amt', 'Qty'], [new Date(Date.UTC(2026, 9, 3)), 'O1', 'S', 'P', 500, 1, 1]]]]);
    // Shrink the declared size of the sheet in the CENTRAL DIRECTORY (what the worker trusts) by patching the bytes.
    const buf = Buffer.from(good);
    const name = Buffer.from('xl/worksheets/sheet1.xml');
    for (let p = buf.length - 22; p >= 0; p--) {
      if (buf.readUInt32LE(p) === 0x02014b50 && buf.subarray(p + 46, p + 46 + name.length).equals(name)) {
        buf.writeUInt32LE(buf.readUInt32LE(p + 24) - 20, p + 24);
        break;
      }
    }
    const { svc, row, final } = setup({ file: buf, kind: 'XLSX' });
    await svc.processClaimed(row);
    expect(final().data.status).toBe('FAILED');
    expect(final().data.error).toMatch(/unpacks to more than its declared/);
  });
});

describe('HeapGuard (re-check M4)', () => {
  it('fails only after TWO consecutive over-threshold checks of USED heap vs the limit (committed / available space ignored — audit L1)', () => {
    const v8 = jest.requireActual('node:v8') as typeof import('node:v8');
    const base = v8.getHeapStatistics();
    const seq = [
      { used_heap_size: base.heap_size_limit, total_available_size: base.heap_size_limit }, // over (used)
      { used_heap_size: 1, total_available_size: base.heap_size_limit }, // fine → resets
      { used_heap_size: base.heap_size_limit, total_available_size: base.heap_size_limit }, // over
      { used_heap_size: 1, total_available_size: 1 }, // little "available" but used heap is low → NOT over (resets)
      { used_heap_size: base.heap_size_limit, total_available_size: base.heap_size_limit }, // over
      { used_heap_size: base.heap_size_limit, total_available_size: base.heap_size_limit }, // over → second strike
    ];
    let i = 0;
    const spy = jest.spyOn(v8, 'getHeapStatistics').mockImplementation(() => ({ ...base, ...seq[i++] }));
    try {
      const g = new HeapGuard();
      expect([g.overLimit(), g.overLimit(), g.overLimit(), g.overLimit(), g.overLimit(), g.overLimit()]).toEqual([false, false, false, false, false, true]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('HeapGuard cadence + threshold (real-DB finding 1)', () => {
  it('checks every 2,000 rows AND at least every 2 s; trips at 75 % of the configured heap limit', () => {
    const g = new HeapGuard();
    const t0 = Date.now();
    expect(g.due(1_999, t0)).toBe(false);
    expect(g.due(2_000, t0)).toBe(true); // row cadence
    expect(g.due(2_001, t0 + 1_000)).toBe(false);
    expect(g.due(2_002, t0 + 2_100)).toBe(true); // time cadence (slow rows)
    // audit L1: the row trigger is relative to the LAST check, not a multiple of 2,000
    expect(g.due(4_001, t0 + 2_200)).toBe(false); // 1,999 rows since the last check
    expect(g.due(4_002, t0 + 2_300)).toBe(true);
    const v8 = jest.requireActual('node:v8') as typeof import('node:v8');
    const base = v8.getHeapStatistics();
    const at = (frac: number) => ({ ...base, used_heap_size: Math.round(base.heap_size_limit * frac), total_available_size: base.heap_size_limit });
    let next = at(0.74);
    const spy = jest.spyOn(v8, 'getHeapStatistics').mockImplementation(() => next);
    try {
      const h = new HeapGuard();
      expect([h.overLimit(), h.overLimit()]).toEqual([false, false]); // 74 %: never
      next = at(0.76);
      expect([h.overLimit(), h.overLimit()]).toEqual([false, true]); // 76 %: second consecutive check trips
    } finally {
      spy.mockRestore();
    }
  });
});

describe('heap backstop outside the row loop (audit M2)', () => {
  it('a phase with NO rows (input stalls) is still guarded: the timer trips, the input is destroyed, FAILED readable', async () => {
    const { svc, row, final, storage } = setup({ file: Buffer.from(CSV) });
    // the part stream never produces a byte (like exceljs building a huge shared-strings table before row 1)
    (storage as unknown as { openReadStream: () => Readable }).openReadStream = () => new Readable({ read() {} });
    const v8 = jest.requireActual('node:v8') as typeof import('node:v8');
    const base = v8.getHeapStatistics();
    const spy = jest.spyOn(v8, 'getHeapStatistics').mockImplementation(() => ({ ...base, used_heap_size: base.heap_size_limit }));
    try {
      await svc.processClaimed(row);
    } finally {
      spy.mockRestore();
    }
    expect(final().data.status).toBe('FAILED');
    expect(final().data.error).toMatch(/too large to process in one go/);
  }, 15_000);
});
