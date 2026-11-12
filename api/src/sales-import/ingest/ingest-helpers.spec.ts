import { Readable } from 'node:stream';
import { claimNextImport, hasClaimableImports } from './claim';
import { expectedPartSize, partCountFor, partKey, PartsFile, unmatchedCsvKey } from './parts-file';
import { loadRoster, rosterOutletWhere } from './roster';
import { csvText, scaledToText, unmatchedCsvLines } from './unmatched-csv';
import { SALES_IMPORT_PART_SIZE, SALES_IMPORT_STALE_HEARTBEAT_MINUTES } from '../sales-import.contract';

describe('parts-file', () => {
  it('keys parts zero-padded under the import prefix', () => {
    expect(partKey('sales-imports/t1/i1/', 7)).toBe('sales-imports/t1/i1/parts/00007');
    expect(unmatchedCsvKey('sales-imports/t1/i1/', 'tok-1')).toBe('sales-imports/t1/i1/unmatched-tok-1.csv');
    expect(unmatchedCsvKey('sales-imports/t1/i1/', '../x')).toBe('sales-imports/t1/i1/unmatched-x.csv'); // sanitised
  });

  it('part count and expected part sizes (exact last part)', () => {
    const P = SALES_IMPORT_PART_SIZE;
    expect(partCountFor(1)).toBe(1);
    expect(partCountFor(P)).toBe(1);
    expect(partCountFor(P + 1)).toBe(2);
    expect(expectedPartSize(2 * P + 5, 0)).toBe(P);
    expect(expectedPartSize(2 * P + 5, 2)).toBe(5);
    expect(expectedPartSize(2 * P, 1)).toBe(P);
  });

  /** A file split into 10-byte parts in a fake bucket that honours inclusive `end` ranges. */
  function partsOf(content: string, partSize = 10) {
    const objects = new Map<string, Buffer>();
    const buf = Buffer.from(content);
    for (let n = 0; n * partSize < buf.length; n++) objects.set(partKey('p/', n), buf.subarray(n * partSize, (n + 1) * partSize));
    const opened: Array<[string, unknown]> = [];
    const storage = {
      openReadStream: (key: string, range?: { start?: number; end?: number }) => {
        opened.push([key, range]);
        const b = objects.get(key)!;
        return Readable.from([range ? b.subarray(range.start, (range.end ?? b.length - 1) + 1) : b]);
      },
    };
    return { file: new PartsFile(storage, 'p/', buf.length, partSize), opened };
  }

  it('streams all parts in order as one file', async () => {
    const { file } = partsOf('abcdefghijklmnopqrstuvwxyz0123');
    expect((await file.read(0, file.size)).toString()).toBe('abcdefghijklmnopqrstuvwxyz0123');
  });

  it('reads an arbitrary range across part boundaries with ranged reads only where needed', async () => {
    const { file, opened } = partsOf('abcdefghijklmnopqrstuvwxyz0123');
    expect((await file.read(7, 23)).toString()).toBe('hijklmnopqrstuvw');
    expect(opened).toEqual([
      ['p/parts/00000', { start: 7, end: 9 }],
      ['p/parts/00001', undefined], // whole part
      ['p/parts/00002', { start: 0, end: 2 }],
    ]);
    expect((await file.read(28, 30)).toString()).toBe('23');
    expect((await file.read(5, 5)).toString()).toBe('');
  });
});

describe('roster', () => {
  it('loads live outlets of the tenant, keyed by normalized code → stored code', async () => {
    const prisma = { outlet: { findMany: jest.fn().mockResolvedValue([{ outletCode: ' 0012 ' }, { outletCode: 'A1' }, { outletCode: '' }]) } };
    const r = await loadRoster(prisma as never, 't1');
    expect(prisma.outlet.findMany).toHaveBeenCalledWith({ where: { clientId: 't1', deletedAt: null }, select: { outletCode: true } });
    expect(rosterOutletWhere('t1')).toEqual({ clientId: 't1', deletedAt: null });
    expect([...r.byNormalizedCode]).toEqual([['0012', ' 0012 '], ['A1', 'A1']]);
  });
});

describe('unmatched csv', () => {
  it.each([
    [0n, 2, '0'],
    [123456n, 2, '1234.56'],
    [-5n, 2, '-0.05'],
    [40000n, 6, '0.04'],
    [-1_500_000n, 6, '-1.5'],
  ])('scaledToText(%p, %p) → %p', (v, s, o) => expect(scaledToText(v, s)).toBe(o));

  it('escapes CSV and neutralises formula triggers in text cells', () => {
    expect(csvText('a,b')).toBe('"a,b"');
    expect(csvText('say "x"')).toBe('"say ""x"""');
    expect(csvText('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvText('-12')).toBe("'-12");
    expect(csvText('plain')).toBe('plain');
  });

  it('writes a header then one line per (code, month)', () => {
    const lines = [...unmatchedCsvLines([{ month: '2026-10', code: 'U1', name: 'N, One', amountPaise: 750n, qtyPico: 1_083_333_333_333n, lines: 2 }])];
    // quantity is written at 3 dp (same rounding as everything else on the wire)
    expect(lines).toEqual(['Customer code,Customer name,Month,Lines,Amount (Rs),Quantity\r\n', 'U1,"N, One",2026-10,2,7.5,1.083\r\n']);
  });
});

describe('claim', () => {
  const q = (mock: jest.Mock, i = 0) => mock.mock.calls[i][0] as { strings: string[]; values: unknown[] };
  const sqlOf = (mock: jest.Mock) => q(mock).strings.join('?');

  it('claims QUEUED or heartbeat-stale PROCESSING with FOR UPDATE SKIP LOCKED, oldest first, bumping attempts', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([{ id: 'i1' }]);
    await expect(claimNextImport({ $queryRaw } as never, 'tok-1')).resolves.toEqual({ id: 'i1' });
    const sql = sqlOf($queryRaw);
    expect(sql).toContain(`SET "status" = 'PROCESSING'`);
    expect(sql).toContain('"attempts" = "attempts" + 1');
    expect(sql).toContain(`"status" = 'QUEUED'`);
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('ORDER BY "createdAt"');
    expect(sql).toContain('RETURNING *');
    expect(sql).toContain('"claimToken" = ?');
    expect(q($queryRaw).values).toEqual(['tok-1', SALES_IMPORT_STALE_HEARTBEAT_MINUTES]);
  });

  it('real-DB finding 3: every time write / staleness test uses UTC (now() AT TIME ZONE \'UTC\'), never the session zone', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([]);
    await claimNextImport({ $queryRaw } as never, 't');
    await hasClaimableImports({ $queryRaw: $queryRaw.mockResolvedValueOnce([{ n: 0 }]) } as never);
    for (const i of [0, 1]) {
      const sql = q($queryRaw, i).strings.join('?');
      expect(sql).toContain(`"heartbeatAt" < (now() AT TIME ZONE 'UTC') - make_interval`);
      expect(sql.replace(/now\(\) AT TIME ZONE 'UTC'/g, '')).not.toContain('now()');
    }
    const claim = q($queryRaw, 0).strings.join('?');
    expect(claim).toContain(`"startedAt" = (now() AT TIME ZONE 'UTC')`);
    expect(claim).toContain(`"heartbeatAt" = (now() AT TIME ZONE 'UTC')`);
  });

  it('M2: every claim gets a fresh random token by default (never a reusable counter)', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([]);
    await claimNextImport({ $queryRaw } as never);
    await claimNextImport({ $queryRaw } as never);
    const [a, b] = [q($queryRaw, 0).values[0], q($queryRaw, 1).values[0]];
    expect(typeof a).toBe('string');
    expect(a).not.toBe(b);
  });

  it('returns null when nothing is claimable', async () => {
    await expect(claimNextImport({ $queryRaw: jest.fn().mockResolvedValue([]) } as never)).resolves.toBeNull();
  });

  it('hasClaimableImports counts the same predicate', async () => {
    await expect(hasClaimableImports({ $queryRaw: jest.fn().mockResolvedValue([{ n: 2 }]) } as never)).resolves.toBe(true);
    await expect(hasClaimableImports({ $queryRaw: jest.fn().mockResolvedValue([{ n: 0 }]) } as never)).resolves.toBe(false);
  });
});
