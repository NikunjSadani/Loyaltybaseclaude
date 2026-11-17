import { Readable } from 'node:stream';
import type { SalesColumnMapping } from '../sales-import.contract';
import { SALES_IMPORT_PART_SIZE } from '../sales-import.contract';
import { partKey } from './parts-file';
import { parseStoredFile } from './stored-file-parse';
import { exceljsWorkbook } from './test-fixtures.testspec';

jest.setTimeout(30_000);

// The one-off rebuild's re-reader must read a stored file EXACTLY like the processor (same fixtures as its spec).
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
  '31-02-2026,O1,Shop One,P,500,1,1',
  '',
].join('\r\n');

function storageOf(file: Buffer, prefix: string) {
  const objects = new Map<string, Buffer>();
  for (let n = 0; n * SALES_IMPORT_PART_SIZE < file.length; n++) {
    objects.set(partKey(prefix, n), file.subarray(n * SALES_IMPORT_PART_SIZE, (n + 1) * SALES_IMPORT_PART_SIZE));
  }
  return {
    openReadStream: (key: string, range?: { start: number; end: number }) => {
      const b = objects.get(key) ?? Buffer.alloc(0);
      return Readable.from([range ? b.subarray(range.start, range.end + 1) : b]);
    },
  };
}

describe('parseStoredFile (one-off day-data rebuild re-reader)', () => {
  const KEY = '{"dimA":"P","dimB":"500"}';

  it('CSV: same lines, totals and IST day split as processing; undatable lines skipped + sampled', async () => {
    const file = Buffer.from(CSV);
    const r = await parseStoredFile(storageOf(file, 'p/'), { gcsPrefix: 'p/', sizeBytes: BigInt(file.length), fileKind: 'CSV' }, MAPPING, new Map([['O1', 'O1']]));
    if (!r.ok) throw new Error(r.problem);
    expect(r.result.get('2026-10', 'O1', KEY)).toEqual({ amountPaise: 6000n, qtyPico: 1_000_000_000_000n, lines: 2 });
    expect(r.result.getDays('2026-10', 'O1', KEY)!.map((d) => [d.day, d.amountPaise])).toEqual([[3, 10000n], [20, -4000n]]);
    expect(r.result.get('2026-10', 'O2', '{"dimA":"Q","dimB":"200"}')).toEqual({ amountPaise: 100050n, qtyPico: 2_000_000_000_000n, lines: 1 });
    expect(r.result.errorSamples).toEqual([{ row: 7, column: 'INVOICE DATE', reason: 'invalid date' }]);
  });

  it('XLSX through the re-sequencer (date cells = calendar days)', async () => {
    const file = await exceljsWorkbook([
      ['Data', [
        ['Invoice Date', 'Customer Code', 'Customer', 'Code', 'Group', 'Net Amt', 'Qty'],
        [new Date(Date.UTC(2026, 9, 3)), 'O1', 'Shop', 'p', 500, 100.25, 1.5],
        [new Date(Date.UTC(2026, 9, 4)), 'O1', 'Shop', 'P', '500', -0.25, 0.5],
      ]],
    ]);
    const r = await parseStoredFile(storageOf(file, 'x/'), { gcsPrefix: 'x/', sizeBytes: BigInt(file.length), fileKind: 'XLSX' }, MAPPING, new Map());
    if (!r.ok) throw new Error(r.problem);
    expect(r.result.getDays('2026-10', 'O1', KEY)!.map((d) => [d.day, d.amountPaise])).toEqual([[3, 10025n], [4, -25n]]);
  });

  it('S5: a heap guard — when it trips while re-reading, the parse stops with a readable problem (never an OOM)', async () => {
    const file = Buffer.from(CSV);
    const checks: number[] = [];
    const guard = { check: (rows: number) => { checks.push(rows); return rows >= 3; } };
    const r = await parseStoredFile(storageOf(file, 'p/'), { gcsPrefix: 'p/', sizeBytes: BigInt(file.length), fileKind: 'CSV' }, MAPPING, new Map(), { heapGuard: guard });
    expect(r).toEqual({ ok: false, problem: expect.stringMatching(/too large to re-read.*memory limit/) });
    expect(checks.length).toBeGreaterThan(0);
    // without an injected guard the real one (75 % of the configured old space) is used — the normal file passes
    const ok = await parseStoredFile(storageOf(file, 'p/'), { gcsPrefix: 'p/', sizeBytes: BigInt(file.length), fileKind: 'CSV' }, MAPPING, new Map());
    expect(ok.ok).toBe(true);
  });

  it('a header the mapping cannot find → a readable problem (never an empty success)', async () => {
    const file = Buffer.from('a,b,c\r\n1,2,3\r\n');
    const r = await parseStoredFile(storageOf(file, 'p/'), { gcsPrefix: 'p/', sizeBytes: BigInt(file.length), fileKind: 'CSV' }, MAPPING, new Map());
    expect(r.ok).toBe(false);
  });
});
