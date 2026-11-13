import { PassThrough } from 'node:stream';
import * as XLSX from 'xlsx';
import { createXlsxStreamWriter } from './xlsx-stream';

async function collect(build: (w: ReturnType<typeof createXlsxStreamWriter>) => Promise<void>): Promise<Buffer> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((r) => sink.on('end', () => r()));
  const w = createXlsxStreamWriter(sink);
  await build(w);
  await done;
  return Buffer.concat(chunks);
}

describe('createXlsxStreamWriter', () => {
  it('writes headers + rows that SheetJS reads back identically, across two sheets', async () => {
    const buf = await collect(async (w) => {
      const s1 = await w.addSheet('Outlets', ['Code', 'Name', 'Amount', 'Active']);
      await s1.addRow(['C1', 'Shop A', 12.5, true]);
      await s1.addRow(['C2', null, 0, false]);
      const s2 = await w.addSheet('Summary', ['Field', 'Value']);
      await s2.addRow(['Total', 12.5]);
      expect(w.rowCount).toBe(3);
      await w.finish();
    });
    const wb = XLSX.read(buf, { type: 'buffer' });
    expect(wb.SheetNames).toEqual(['Outlets', 'Summary']);
    const a = XLSX.utils.sheet_to_json(wb.Sheets.Outlets, { header: 1, defval: '' });
    expect(a).toEqual([['Code', 'Name', 'Amount', 'Active'], ['C1', 'Shop A', 12.5, true], ['C2', '', 0, false]]);
    expect(XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1 })).toEqual([['Field', 'Value'], ['Total', 12.5]]);
  });

  it('neutralises formula injection in cells, headers and hyperlink text (cellSafe)', async () => {
    const buf = await collect(async (w) => {
      const s = await w.addSheet('S', ['=HEADER()', 'Link']);
      await s.addRow(['=cmd()', { __hyperlink: true, text: '+evil', target: 'https://example.com/x' }]);
      await w.finish();
    });
    const a = XLSX.utils.sheet_to_json(XLSX.read(buf, { type: 'buffer' }).Sheets.S, { header: 1 }) as string[][];
    expect(a[0][0]).toBe("'=HEADER()");
    expect(a[1][0]).toBe("'=cmd()");
    expect(a[1][1]).toBe("'+evil");
  });

  it('sanitises and de-duplicates sheet names', async () => {
    const buf = await collect(async (w) => {
      await w.addSheet('Nov/Dec: [report]', ['A']);
      await w.addSheet('Nov/Dec: [report]', ['A']);
      await w.finish();
    });
    const names = XLSX.read(buf, { type: 'buffer' }).SheetNames;
    expect(names[0]).toBe('Nov Dec   report');
    expect(names[1]).not.toBe(names[0]);
  });

  it('streams 20,000 rows without holding them (row count + readable output)', async () => {
    const buf = await collect(async (w) => {
      const s = await w.addSheet('Big', ['i', 'label']);
      for (let i = 0; i < 20_000; i++) await s.addRow([i, `row ${i}`]);
      await w.finish();
    });
    const a = XLSX.utils.sheet_to_json(XLSX.read(buf, { type: 'buffer' }).Sheets.Big, { header: 1 }) as unknown[][];
    expect(a.length).toBe(20_001);
    expect(a[20_000]).toEqual([19_999, 'row 19999']);
  });
});
