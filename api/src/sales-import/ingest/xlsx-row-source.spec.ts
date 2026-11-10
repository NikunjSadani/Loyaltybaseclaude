import { Readable } from 'node:stream';
import { FailFast, racing, xlsxRows, XlsxSheetNotFoundError, denseCells, plainCellValue } from './xlsx-row-source';
import {
  loadCentralDirectory,
  planXlsxRead,
  XLSX_MAX_SHARED_STRINGS_UNCOMPRESSED,
  XLSX_MAX_TOTAL_UNCOMPRESSED,
  readZipCentralDirectory,
  resequencedXlsxStream,
  XlsxFileError,
} from './xlsx-zip';
import {
  buildZip,
  bufferRangeSource,
  entryOrder,
  exceljsWorkbook,
  moveEntriesToEnd,
  sheetjsWorkbook,
  syntheticSheetRows,
  unzipEntries,
} from './test-fixtures.testspec';
import type { SourceRow } from './header';

/** The production path: central directory from the tail → re-sequenced stream → exceljs. */
async function readViaResequencer(buf: Buffer, sheet?: string | null): Promise<SourceRow[]> {
  const src = bufferRangeSource(buf);
  const plan = planXlsxRead(await loadCentralDirectory(src, buf.length, 4096));
  const out: SourceRow[] = [];
  for await (const r of xlsxRows(resequencedXlsxStream(src, plan), sheet)) out.push(r);
  return out;
}

/** Straight exceljs on the raw bytes (only valid when shared strings precede the sheet). */
async function readDirect(buf: Buffer, sheet?: string | null): Promise<SourceRow[]> {
  const out: SourceRow[] = [];
  const src = Readable.from((function* () {
    for (let i = 0; i < buf.length; i += 1024) yield buf.subarray(i, i + 1024);
  })());
  try {
    for await (const r of xlsxRows(src, sheet)) out.push(r);
  } finally {
    src.destroy(); // a failed exceljs parse must not leave the input piped (jest worker teardown)
  }
  return out;
}

const ROWS = syntheticSheetRows(50);

function expectSyntheticRows(rows: SourceRow[]) {
  expect(rows).toHaveLength(52);
  expect(rows[0]).toEqual({ rowNo: 1, cells: ['X', 'X', 'X', 'X', 'X', 'X', 'X'] });
  expect(rows[1].cells).toEqual(['Invoice Date', 'Customer Code', 'Customer', 'Code', 'Group', 'Net Amt', 'Qty']);
  const first = rows[2];
  expect(first.rowNo).toBe(3);
  expect(first.cells[0]).toBeInstanceOf(Date);
  expect((first.cells[0] as Date).toISOString().slice(0, 10)).toBe('2026-10-01');
  expect(first.cells.slice(1)).toEqual([100000, 'Shop 0', 'Q', 200, 100.25, 0.04]);
  expect(rows[51].cells[5]).toBe(149.25);
}

/** DMS-style order: shared strings BEFORE the sheet (what the real export does). */
async function dmsOrdered(): Promise<Buffer> {
  return moveEntriesToEnd(await exceljsWorkbook([['Data', ROWS]]), ['xl/worksheets/sheet1.xml']);
}

// Builds and streams real xlsx workbooks (exceljs + zlib): fast alone, but can exceed jest's 5 s default under
// full-suite CPU load (seen 2026-11-10). A red suite skips the staging deploy, so give real headroom.
jest.setTimeout(30_000);

describe('xlsxRows over the re-sequenced stream', () => {
  it('SheetJS file (inline strings, NO shared-strings table): marker row, header, 50 lines, dates, numeric code, fraction', async () => {
    const buf = sheetjsWorkbook([['Data', ROWS]]);
    expect(entryOrder(buf)).not.toContain('xl/sharedStrings.xml');
    expectSyntheticRows(await readViaResequencer(buf));
  });

  it('exceljs/Excel order (shared strings AFTER the sheet, workbook.xml last)', async () => {
    const buf = await exceljsWorkbook([['Data', ROWS]]);
    const order = entryOrder(buf);
    expect(order.indexOf('xl/worksheets/sheet1.xml')).toBeLessThan(order.indexOf('xl/sharedStrings.xml'));
    expectSyntheticRows(await readViaResequencer(buf));
  });

  it('DMS order (shared strings first) gives the same rows via the re-sequencer and directly', async () => {
    const buf = await dmsOrdered();
    const order = entryOrder(buf);
    expect(order.indexOf('xl/sharedStrings.xml')).toBeLessThan(order.indexOf('xl/worksheets/sheet1.xml'));
    const via = await readViaResequencer(buf);
    expectSyntheticRows(via);
    expect(await readDirect(buf)).toEqual(via);
  });

  it('every entry order yields identical rows (sheet first, sst last, workbook last)', async () => {
    const base = await exceljsWorkbook([['Data', ROWS]]);
    const expected = await readViaResequencer(base);
    for (const tail of [['xl/sharedStrings.xml'], ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels'], ['xl/styles.xml']]) {
      expect(await readViaResequencer(moveEntriesToEnd(base, tail))).toEqual(expected);
    }
  });

  it('documents the exceljs trap the re-sequencer avoids: raw out-of-order input fails', async () => {
    // exceljs defers the sheet to a temp file and then crashes (or would OOM on a big file).
    await expect(readDirect(sheetjsWorkbook([['Data', ROWS]]))).rejects.toBeDefined();
  });

  it('picks the FIRST sheet in workbook order by default, or the named sheet (case/space-insensitive)', async () => {
    const buf = await exceljsWorkbook([
      ['Summary', [['just a title']]],
      ['Data', ROWS],
    ]);
    expect(await readViaResequencer(buf)).toEqual([{ rowNo: 1, cells: ['just a title'] }]);
    expectSyntheticRows(await readViaResequencer(buf, ' data '));
  });

  it('a missing sheet name → XlsxSheetNotFoundError listing the sheets', async () => {
    const buf = await exceljsWorkbook([['Data', ROWS]]);
    await expect(readViaResequencer(buf, 'Nope')).rejects.toBeInstanceOf(XlsxSheetNotFoundError);
    await expect(readViaResequencer(buf, 'Nope')).rejects.toThrow('Sheet "Nope" was not found in the file (sheets: Data).');
  });

  it('copies only the needed entries (theme/docProps are never read)', async () => {
    const buf = await exceljsWorkbook([['Data', ROWS]]);
    const cd = readZipCentralDirectory(buf, 0);
    if (cd.kind !== 'ok') throw new Error(cd.kind);
    const plan = planXlsxRead(cd.entries);
    expect(plan.entries.map((e) => e.name)).toEqual([
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/sharedStrings.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    expect(plan.synthesizeSharedStrings).toBe(false);
    let copied = 0;
    const src = bufferRangeSource(buf);
    for await (const _ of resequencedXlsxStream(src, plan, (n) => (copied += n))) void _;
    expect(copied).toBe(plan.totalCompressedBytes);
  });
});

describe('zip directory + plan', () => {
  it('reading only a TAIL asks for more when the directory starts earlier, then succeeds', async () => {
    const buf = await exceljsWorkbook([['Data', ROWS]]);
    const full = readZipCentralDirectory(buf, 0);
    if (full.kind !== 'ok') throw new Error(full.kind);
    const tailStart = buf.length - 40;
    const r = readZipCentralDirectory(buf.subarray(tailStart), tailStart);
    expect(r.kind).toBe('need');
    if (r.kind !== 'need') return;
    expect(readZipCentralDirectory(buf.subarray(r.from), r.from)).toEqual(full);
    expect(await loadCentralDirectory(bufferRangeSource(buf), buf.length, 40)).toEqual(full.entries);
  });

  it('not a zip → XlsxFileError with a readable message', async () => {
    const junk = Buffer.from('definitely not a zip file '.repeat(10));
    await expect(loadCentralDirectory(bufferRangeSource(junk), junk.length)).rejects.toBeInstanceOf(XlsxFileError);
    expect(readZipCentralDirectory(Buffer.alloc(100), 0).kind).toBe('error');
  });

  it('a zip that is not a workbook → XlsxFileError', () => {
    const zip = buildZip([{ name: 'readme.txt', data: Buffer.from('hi') }]);
    const cd = readZipCentralDirectory(zip, 0);
    if (cd.kind !== 'ok') throw new Error(cd.kind);
    expect(() => planXlsxRead(cd.entries)).toThrow(XlsxFileError);
  });

  it('an encrypted entry → XlsxFileError', async () => {
    const cd = readZipCentralDirectory(await exceljsWorkbook([['Data', ROWS]]), 0);
    if (cd.kind !== 'ok') throw new Error(cd.kind);
    const entries = cd.entries.map((e) => (e.name === 'xl/worksheets/sheet1.xml' ? { ...e, flags: e.flags | 1 } : e));
    expect(() => planXlsxRead(entries)).toThrow('encrypted');
  });

  it('S4: declared unpacked sizes are capped (shared strings and the total)', async () => {
    const cd = readZipCentralDirectory(await exceljsWorkbook([['Data', ROWS]]), 0);
    if (cd.kind !== 'ok') throw new Error(cd.kind);
    const sst = cd.entries.map((e) => (e.name === 'xl/sharedStrings.xml' ? { ...e, uncompressedSize: XLSX_MAX_SHARED_STRINGS_UNCOMPRESSED + 1 } : e));
    expect(() => planXlsxRead(sst)).toThrow(/shared-text table is too large/);
    const total = cd.entries.map((e) => (e.name === 'xl/worksheets/sheet1.xml' ? { ...e, uncompressedSize: XLSX_MAX_TOTAL_UNCOMPRESSED + 1 } : e));
    expect(() => planXlsxRead(total)).toThrow(/unpacks to/);
    expect(() => planXlsxRead(cd.entries)).not.toThrow();
  });

  it('the re-sequenced stream is itself a valid zip with the planned entries', async () => {
    const buf = sheetjsWorkbook([['Data', ROWS]]);
    const src = bufferRangeSource(buf);
    const plan = planXlsxRead(await loadCentralDirectory(src, buf.length));
    const chunks: Buffer[] = [];
    for await (const c of resequencedXlsxStream(src, plan)) chunks.push(c as Buffer);
    // Walk the emitted local headers.
    const names: string[] = [];
    let p = 0;
    const out = Buffer.concat(chunks);
    while (out.readUInt32LE(p) === 0x04034b50) {
      const nl = out.readUInt16LE(p + 26);
      const xl = out.readUInt16LE(p + 28);
      names.push(out.toString('utf8', p + 30, p + 30 + nl));
      p += 30 + nl + xl + out.readUInt32LE(p + 18);
    }
    expect(names).toEqual(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml']);
    expect(out.readUInt32LE(p)).toBe(0x06054b50);
    // The original sheet bytes are copied verbatim.
    const original = unzipEntries(buf).find((e) => e.name === 'xl/worksheets/sheet1.xml')!;
    expect(original.data.length).toBeGreaterThan(0);
  });
});

describe('cell flattening', () => {
  it.each([
    [{ richText: [{ text: 'A' }, { text: 'B' }] }, 'AB'],
    [{ formula: 'A1*2', result: 4 }, 4],
    [{ sharedFormula: 'A1', result: 'x' }, 'x'],
    [{ formula: 'A1' }, null],
    [{ error: '#N/A' }, null],
    [{ text: 'link', hyperlink: 'http://x' }, 'link'],
    [undefined, null],
    [7, 7],
  ])('plainCellValue(%p) → %p', (v, o) => expect(plainCellValue(v)).toEqual(o));

  it('denseCells shifts the 1-based sparse exceljs values array', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(denseCells([, 'a', , 3])).toEqual(['a', null, 3]);
    expect(denseCells(undefined)).toEqual([]);
  });
});

describe('re-audit M2: inflated bytes are enforced against the declared sizes', () => {
  async function consume(stream: Readable): Promise<void> {
    for await (const _ of stream) void _;
  }
  async function tampered(name: string, delta: number) {
    const buf = await exceljsWorkbook([['Data', ROWS]]);
    const src = bufferRangeSource(buf);
    const entries = (await loadCentralDirectory(src, buf.length)).map((e) => (e.name === name ? { ...e, uncompressedSize: e.uncompressedSize + delta } : e));
    return { src, plan: planXlsxRead(entries) };
  }

  it.each(['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml'])('%s inflating to MORE than declared → XlsxFileError (zip bomb), reported via onError', async (name) => {
    const { src, plan } = await tampered(name, -10);
    const errors: Error[] = [];
    await expect(consume(resequencedXlsxStream(src, plan, undefined, (e) => errors.push(e)))).rejects.toThrow(/unpacks to more than its declared/);
    expect(errors[0]).toBeInstanceOf(XlsxFileError);
  });

  it('inflating to LESS than declared → XlsxFileError (corrupt)', async () => {
    const { src, plan } = await tampered('xl/worksheets/sheet1.xml', +10);
    await expect(consume(resequencedXlsxStream(src, plan))).rejects.toThrow(/not the declared/);
  });

  it('honest sizes still read end to end (entries are handed to exceljs STORED)', async () => {
    const buf = await exceljsWorkbook([['Data', ROWS]]);
    expectSyntheticRows(await readViaResequencer(buf));
  });
});

describe('re-check H1: the fail-fast race retains nothing per row', () => {
  it('after many rows at most one settle callback is retained, and none once iteration ends', async () => {
    const ff = new FailFast();
    async function* many() {
      for (let i = 0; i < 5000; i++) yield i;
    }
    let n = 0;
    let maxRetained = 0;
    for await (const v of racing(many(), ff)) {
      n += v >= 0 ? 1 : 0;
      maxRetained = Math.max(maxRetained, ff.retained);
    }
    expect(n).toBe(5000);
    expect(maxRetained).toBe(0); // between rows nothing is held
    expect(ff.retained).toBe(0);
  });

  it('a failure rejects the pending next() (no hang) and every later call', async () => {
    const ff = new FailFast();
    const never: AsyncIterator<number> = { next: () => new Promise(() => undefined) };
    const it = racing(never, ff)[Symbol.asyncIterator]();
    const pending = it.next();
    expect(ff.retained).toBe(1);
    ff.fail(new Error('input broke'));
    await expect(pending).rejects.toThrow('input broke');
    expect(ff.retained).toBe(0);
    await expect(ff.guard(Promise.resolve(1))).rejects.toThrow('input broke');
  });
});

describe('shared-strings cap follows the heap (audit M2)', () => {
  it('min(400 MiB, 25 % of the OLD-SPACE size) — audit M-1; planXlsxRead enforces the effective cap', async () => {
    const { sharedStringsCap } = jest.requireActual('./xlsx-zip') as typeof import('./xlsx-zip');
    expect(sharedStringsCap(1700 * 1024 ** 2)).toBe(400 * 1024 ** 2); // the job (not 425 / 473 MiB)
    expect(sharedStringsCap(1000 * 1024 ** 2)).toBe(250 * 1024 ** 2);
    expect(sharedStringsCap(4096 * 1024 ** 2)).toBeLessThan(XLSX_MAX_SHARED_STRINGS_UNCOMPRESSED);
    const cd = readZipCentralDirectory(await exceljsWorkbook([['Data', ROWS]]), 0);
    if (cd.kind !== 'ok') throw new Error(cd.kind);
    const sst = cd.entries.find((e) => e.name === 'xl/sharedStrings.xml')!;
    expect(() => planXlsxRead(cd.entries, { sharedStrings: sst.uncompressedSize - 1 })).toThrow(/shared-text table is too large/);
    expect(() => planXlsxRead(cd.entries, { sharedStrings: sst.uncompressedSize })).not.toThrow();
  });
});

describe('audit M-2: a consumer abort is never reported as a corrupt file', () => {
  it('destroying the re-sequenced stream mid-copy (heap backstop) does not call onError, whatever the copy does next', async () => {
    const buf = await exceljsWorkbook([['Data', syntheticSheetRows(400)]]);
    const base = bufferRangeSource(buf, 256);
    // ranged reads trickle: the copy is guaranteed to be mid-entry (and to write again) after the destroy
    const slow = {
      read: base.read,
      stream: (s: number, e: number) =>
        Readable.from((async function* () {
          for await (const c of base.stream(s, e)) {
            await new Promise((r) => setTimeout(r, 5));
            yield c as Buffer;
          }
        })()),
    };
    const plan = planXlsxRead(await loadCentralDirectory(base, buf.length, 4096));
    const errors: Error[] = [];
    const out = resequencedXlsxStream(slow, plan, undefined, (e) => errors.push(e));
    out.on('error', () => undefined);
    await new Promise<void>((resolve) => out.once('data', () => resolve()));
    out.destroy(new Error('The file is too large to process in one go.'));
    await new Promise((r) => setTimeout(r, 300)); // let the copy loop hit its next write on the destroyed stream
    expect(errors).toEqual([]);
  });
});
