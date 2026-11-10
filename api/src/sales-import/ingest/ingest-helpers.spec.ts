import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { claimNextImport, hasClaimableImports } from './claim';
import { expectedPartSize, partCountFor, partKey, PartsFile, unmatchedCsvKey } from './parts-file';
import { loadRoster, rosterHashOf, rosterOutletWhere } from './roster';
import { csvText, scaledToText, unmatchedCsvLines } from './unmatched-csv';
import { SALES_IMPORT_PART_SIZE, SALES_IMPORT_STALE_HEARTBEAT_MINUTES } from '../sales-import.contract';

describe('parts-file', () => {
  it('keys parts zero-padded under the import prefix', () => {
    expect(partKey('sales-imports/t1/i1/', 7)).toBe('sales-imports/t1/i1/parts/00007');
    expect(unmatchedCsvKey('sales-imports/t1/i1/')).toBe('sales-imports/t1/i1/unmatched.csv');
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
  it('fixed vector: sort ascending, join "\n", sha256 hex', () => {
    // sha256("A\nB"), computed independently.
    expect(rosterHashOf(['B', 'A'])).toBe('23519a43c66b4c342f25b32e09797ec5f3fc0be388cd8243fb3449afbdce4013');
    expect(rosterHashOf(['B', 'A'])).toBe(createHash('sha256').update(['A', 'B'].join('\n')).digest('hex'));
  });

  it('hash is order independent and changes when the roster changes', () => {
    expect(rosterHashOf(['b', 'a'])).toBe(rosterHashOf(['a', 'b']));
    expect(rosterHashOf(['a', 'b'])).not.toBe(rosterHashOf(['a', 'b', 'c']));
  });

  it('loads live outlets of the tenant, keyed by normalized code → stored code', async () => {
    const prisma = { outlet: { findMany: jest.fn().mockResolvedValue([{ outletCode: ' 0012 ' }, { outletCode: 'A1' }, { outletCode: '' }]) } };
    const r = await loadRoster(prisma as never, 't1');
    expect(prisma.outlet.findMany).toHaveBeenCalledWith({ where: { clientId: 't1', deletedAt: null }, select: { outletCode: true } });
    expect(rosterOutletWhere('t1')).toEqual({ clientId: 't1', deletedAt: null });
    expect([...r.byNormalizedCode]).toEqual([['0012', ' 0012 '], ['A1', 'A1']]);
    expect(r.rosterHash).toBe(rosterHashOf([' 0012 ', 'A1', '']));
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
    const lines = [...unmatchedCsvLines([{ month: '2026-10', code: 'U1', name: 'N, One', amountPaise: 750n, qtyMicro: 1_000_000n, lines: 2 }])];
    expect(lines).toEqual(['Customer code,Customer name,Month,Lines,Amount (Rs),Quantity\r\n', 'U1,"N, One",2026-10,2,7.5,1\r\n']);
  });
});

describe('claim', () => {
  const sqlOf = (mock: jest.Mock) => (mock.mock.calls[0][0] as TemplateStringsArray).join('?');

  it('claims QUEUED or heartbeat-stale PROCESSING with FOR UPDATE SKIP LOCKED, oldest first, bumping attempts', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([{ id: 'i1' }]);
    await expect(claimNextImport({ $queryRaw } as never)).resolves.toEqual({ id: 'i1' });
    const sql = sqlOf($queryRaw);
    expect(sql).toContain(`SET "status" = 'PROCESSING'`);
    expect(sql).toContain('"attempts" = "attempts" + 1');
    expect(sql).toContain(`"status" = 'QUEUED'`);
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('ORDER BY "createdAt"');
    expect(sql).toContain('RETURNING *');
    expect($queryRaw.mock.calls[0][1]).toBe(SALES_IMPORT_STALE_HEARTBEAT_MINUTES);
  });

  it('returns null when nothing is claimable', async () => {
    await expect(claimNextImport({ $queryRaw: jest.fn().mockResolvedValue([]) } as never)).resolves.toBeNull();
  });

  it('hasClaimableImports counts the same predicate', async () => {
    await expect(hasClaimableImports({ $queryRaw: jest.fn().mockResolvedValue([{ n: 2 }]) } as never)).resolves.toBe(true);
    await expect(hasClaimableImports({ $queryRaw: jest.fn().mockResolvedValue([{ n: 0 }]) } as never)).resolves.toBe(false);
  });
});
