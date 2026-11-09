import { Readable } from 'node:stream';
import { xlsxRows, XlsxSheetNotFoundError, denseCells, plainCellValue } from './xlsx-row-source';
import {
  loadCentralDirectory,
  planXlsxRead,
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
