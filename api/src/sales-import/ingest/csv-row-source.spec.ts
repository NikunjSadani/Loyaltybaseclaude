import { Readable } from 'node:stream';
import { csvRows, sniffDelimiter } from './csv-row-source';

async function collect(src: Readable, delimiter?: string) {
  const out: Array<{ rowNo: number; cells: string[] }> = [];
  for await (const r of csvRows(src, delimiter)) out.push(r as { rowNo: number; cells: string[] });
  return out;
}
const whole = (s: string) => Readable.from([Buffer.from(s, 'utf8')]);
/** One BYTE per chunk — splits multi-byte UTF-8 characters and every token across chunks. */
const bytewise = (s: string) => Readable.from([...Buffer.from(s, 'utf8')].map((b) => Buffer.from([b])));
const cells = (rows: Array<{ cells: string[] }>) => rows.map((r) => r.cells);

const TRICKY =
  '﻿code,name,amt\r\n' +
  '1,"Shop, Main Rd",10.5\r\n' +
  '2,"He said ""hi""",-3\r\n' +
  '3,"Line one\nLine two",0\r\n' +
  '\r\n' +
  '4,₹ café,"1,234.50"\r\n' +
  '5,,\r\n' +
  '6,"",x';

describe('csvRows', () => {
  it('parses quotes, "" escapes, embedded newlines, CRLF, BOM and skips blank lines', async () => {
    const rows = await collect(whole(TRICKY));
    expect(cells(rows)).toEqual([
      ['code', 'name', 'amt'],
      ['1', 'Shop, Main Rd', '10.5'],
      ['2', 'He said "hi"', '-3'],
      ['3', 'Line one\nLine two', '0'],
      ['4', '₹ café', '1,234.50'],
      ['5', '', ''],
      ['6', '', 'x'],
    ]);
    // rowNo = physical line where the record starts (the embedded newline consumes a line).
    expect(rows.map((r) => r.rowNo)).toEqual([1, 2, 3, 4, 7, 8, 9]);
  });

  it('a 1-byte-chunked stream gives identical rows (sniffed, and incremental with a known delimiter)', async () => {
    const expected = await collect(whole(TRICKY));
    expect(await collect(bytewise(TRICKY))).toEqual(expected);
    expect(await collect(bytewise(TRICKY), ',')).toEqual(expected);
  });

  it('a "" escape split exactly across two chunks is still an escaped quote', async () => {
    const src = Readable.from([Buffer.from('a,"x"'), Buffer.from('"y"\n')]);
    expect(cells(await collect(src, ','))).toEqual([['a', 'x"y']]);
  });

  it('auto-detects ";" and "\\t"', async () => {
    expect(cells(await collect(whole('a;b;c\n1;"2;x";3\n')))).toEqual([['a', 'b', 'c'], ['1', '2;x', '3']]);
    expect(cells(await collect(whole('a\tb\n1,5\t2\n')))).toEqual([['a', 'b'], ['1,5', '2']]);
  });

  it('accepts LF-only and lone-CR line ends and no trailing newline', async () => {
    expect(cells(await collect(whole('a,b\n1,2')))).toEqual([['a', 'b'], ['1', '2']]);
    expect(cells(await collect(whole('a,b\r1,2\r')))).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('an explicit delimiter overrides sniffing', async () => {
    expect(cells(await collect(whole('a;b,c\n'), ','))).toEqual([['a;b', 'c']]);
  });

  it('yields nothing for an empty or BOM-only stream', async () => {
    expect(await collect(whole(''))).toEqual([]);
    expect(await collect(whole('﻿'))).toEqual([]);
  });

  it('streams large input without buffering it all (sniff window then incremental)', async () => {
    const line = '123456,"Some, Name",ABC,500,100.25,1.5\n';
    const n = 20_000; // ≈ 0.8 MB, beyond the 256 KiB sniff window
    const src = Readable.from((function* () {
      yield Buffer.from('code,name,a,b,amt,qty\n');
      for (let i = 0; i < n; i++) yield Buffer.from(line);
    })());
    let count = 0;
    for await (const r of csvRows(src)) {
      if (count > 0) expect(r.cells).toHaveLength(6);
      count++;
    }
    expect(count).toBe(n + 1);
  });

  it('sniffDelimiter ignores delimiters inside quotes and defaults to ","', () => {
    expect(sniffDelimiter('"a;b;c;d",x,y')).toBe(',');
    expect(sniffDelimiter('single')).toBe(',');
  });
});
