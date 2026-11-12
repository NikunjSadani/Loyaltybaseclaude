/**
 * TEST-ONLY helpers for the ingest specs (the `*spec.ts` suffix keeps this file out of `nest build`;
 * jest's testRegex `.spec.ts$` does not run it as a suite). All data is SYNTHETIC: neutral codes
 * (O1, O2…), dims (dimA/dimB) and round numbers — never values from a real DMS file.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import * as ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { Readable } from 'node:stream';
import { crc32, RangeSource, readZipCentralDirectory } from './xlsx-zip';

export interface ZipFileEntry {
  name: string;
  data: Buffer;
}

/** A plain (non-zip64, deflate, no data descriptors) zip with entries in EXACTLY the given order. */
export function buildZip(entries: ZipFileEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const comp = deflateRawSync(e.data);
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Every entry of a zip, in its stored order (handles data descriptors via the central directory sizes). */
export function unzipEntries(zip: Buffer): ZipFileEntry[] {
  const cd = readZipCentralDirectory(zip, 0);
  if (cd.kind !== 'ok') throw new Error(`unzipEntries: ${cd.kind}`);
  return [...cd.entries]
    .sort((a, b) => a.localHeaderOffset - b.localHeaderOffset)
    .map((e) => {
      const p = e.localHeaderOffset;
      const method = zip.readUInt16LE(p + 8);
      const start = p + 30 + zip.readUInt16LE(p + 26) + zip.readUInt16LE(p + 28);
      const raw = zip.subarray(start, start + e.compressedSize);
      return { name: e.name, data: method === 0 ? Buffer.from(raw) : inflateRawSync(raw) };
    });
}

/** Re-zip with the named entries moved to the END (in the given order); everything else keeps its order. */
export function moveEntriesToEnd(zip: Buffer, names: string[]): Buffer {
  const all = unzipEntries(zip);
  const moved = names.map((n) => {
    const e = all.find((x) => x.name === n);
    if (!e) throw new Error(`moveEntriesToEnd: no entry ${n}`);
    return e;
  });
  return buildZip([...all.filter((e) => !names.includes(e.name)), ...moved]);
}

export function entryOrder(zip: Buffer): string[] {
  return unzipEntries(zip).map((e) => e.name);
}

/** An exceljs-written workbook (uses a shared-strings table). `sheets` = [name, rows][]. */
export async function exceljsWorkbook(sheets: Array<[string, unknown[][]]>, dateFmt = 'dd-mm-yyyy'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of sheets) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) {
      const row = ws.addRow(r);
      row.eachCell((cell) => {
        if (cell.value instanceof Date) cell.numFmt = dateFmt;
      });
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A SheetJS-written workbook (inline strings, no shared-strings table by default). */
export function sheetjsWorkbook(sheets: Array<[string, unknown[][]]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows, { cellDates: true }), name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** Neutral synthetic DMS-like rows: a marker row, a header, then `n` invoice lines. */
export function syntheticSheetRows(n: number): unknown[][] {
  const rows: unknown[][] = [
    ['X', 'X', 'X', 'X', 'X', 'X', 'X'],
    ['Invoice Date', 'Customer Code', 'Customer', 'Code', 'Group', 'Net Amt', 'Qty'],
  ];
  for (let i = 0; i < n; i++) {
    rows.push([
      new Date(Date.UTC(2026, 9, 1 + (i % 28))),
      100000 + (i % 7),
      `Shop ${i % 7}`,
      i % 2 ? 'P' : 'Q',
      i % 3 ? 500 : 200,
      100.25 + i,
      i % 5 === 0 ? 0.04 : 1.5,
    ]);
  }
  return rows;
}

/** RangeSource over an in-memory buffer, streaming in small chunks (exercises backpressure). */
export function bufferRangeSource(buf: Buffer, chunk = 1024): RangeSource & { reads: Array<[number, number]> } {
  const reads: Array<[number, number]> = [];
  return {
    reads,
    read: async (s, e) => {
      reads.push([s, e]);
      return Buffer.from(buf.subarray(s, e));
    },
    stream: (s, e) => {
      reads.push([s, e]);
      return Readable.from((function* () {
        for (let i = s; i < e; i += chunk) yield buf.subarray(i, Math.min(e, i + chunk));
      })());
    },
  };
}
