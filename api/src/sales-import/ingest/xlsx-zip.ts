/**
 * XLSX zip RE-SEQUENCER (plan §10a.4 Phase-0 note for Lane I).
 *
 * The problem: exceljs' streaming WorkbookReader reads the zip in ENTRY ORDER and only streams a worksheet
 * when `xl/sharedStrings.xml` and `xl/_rels/workbook.xml.rels` came before it. Otherwise it copies the
 * DECOMPRESSED sheet to a temp file (RAM on Cloud Run → OOM for a big file) — and, measured here, that
 * deferred path is also unreliable: with fast input it stops reading the remaining entries and crashes on
 * `this.model.sheets` even for a tiny file. Files re-saved by Excel/exceljs put the shared strings AFTER
 * the sheets; inline-string files (SheetJS, some ERPs) have no shared-strings table at all.
 *
 * The fix (no new dependency): the upload is in GCS, so it is RANDOM-ACCESS. Read the central directory
 * from the tail, then feed exceljs a NEW zip stream that contains only the entries it needs, in the order
 * it needs them — workbook.xml, workbook.xml.rels, styles.xml, sharedStrings.xml (an empty one is
 * synthesised when absent; inline strings don't use it), then the worksheets — each as a rewritten local
 * header (sizes/CRC from the central directory, no data descriptor) + the ORIGINAL compressed bytes,
 * copied verbatim by ranged reads. Nothing is decompressed or buffered by us, and every sheet streams.
 */
import { PassThrough, Readable } from 'node:stream';

export interface ZipEntryInfo {
  name: string;
  localHeaderOffset: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  method: number;
  flags: number;
}

export type CentralDirectoryResult =
  | { kind: 'ok'; entries: ZipEntryInfo[] }
  | { kind: 'need'; from: number } // the directory starts before `bufStart`; read again from `from`
  | { kind: 'error'; message: string };

const SIG_LOCAL = 0x04034b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CDH = 0x02014b50;
const U32 = 0xffffffff;
const U16 = 0xffff;
const EOCD_MAX = 22 + 0xffff;

function readU64(buf: Buffer, at: number): number {
  const v = buf.readBigUInt64LE(at);
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
}

/** Parse the central directory. `buf` must END at the end of the file; `bufStart` is its file offset. */
export function readZipCentralDirectory(buf: Buffer, bufStart: number): CentralDirectoryResult {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - EOCD_MAX); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    return bufStart > 0 && buf.length < EOCD_MAX
      ? { kind: 'need', from: Math.max(0, bufStart + buf.length - EOCD_MAX) }
      : { kind: 'error', message: 'zip end-of-directory record not found' };
  }
  let total = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === U16 || buf.readUInt32LE(eocd + 12) === U32 || cdOffset === U32) {
    const loc = eocd - 20;
    if (loc < 0) return bufStart > 0 ? { kind: 'need', from: Math.max(0, bufStart + loc) } : { kind: 'error', message: 'zip64 locator not found' };
    if (buf.readUInt32LE(loc) !== SIG_LOC64) return { kind: 'error', message: 'zip64 locator not found' };
    const rec64 = readU64(buf, loc + 8);
    if (rec64 < bufStart) return { kind: 'need', from: rec64 };
    const r = rec64 - bufStart;
    if (r + 56 > buf.length || buf.readUInt32LE(r) !== SIG_EOCD64) return { kind: 'error', message: 'zip64 end-of-directory record not found' };
    total = readU64(buf, r + 32);
    cdOffset = readU64(buf, r + 48);
  }
  if (cdOffset < bufStart) return { kind: 'need', from: cdOffset };

  const entries: ZipEntryInfo[] = [];
  let p = cdOffset - bufStart;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CDH) return { kind: 'error', message: 'zip central directory is corrupt' };
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc32 = buf.readUInt32LE(p + 16);
    let compressedSize = buf.readUInt32LE(p + 20);
    let uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // zip64 extra (0x0001): only the fields whose 32-bit value is 0xFFFFFFFF are present, in this order.
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = buf.readUInt16LE(x);
      const len = buf.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        const end = q + len;
        if (uncompressedSize === U32 && q + 8 <= end) { uncompressedSize = readU64(buf, q); q += 8; }
        if (compressedSize === U32 && q + 8 <= end) { compressedSize = readU64(buf, q); q += 8; }
        if (localHeaderOffset === U32 && q + 8 <= end) { localHeaderOffset = readU64(buf, q); q += 8; }
      }
      x += 4 + len;
    }
    entries.push({ name, localHeaderOffset, compressedSize, uncompressedSize, crc32, method, flags });
    p = xEnd + commentLen;
  }
  return { kind: 'ok', entries };
}

/** A user-facing "this is not an xlsx we can read" error (the processor shows the message verbatim). */
export class XlsxFileError extends Error {}

const SHEET_RE = /^xl\/worksheets\/sheet(\d+)\.xml$/;

export interface XlsxReadPlan {
  entries: ZipEntryInfo[]; // in the order to emit
  synthesizeSharedStrings: boolean;
  totalCompressedBytes: number;
}

/** Pick and order the entries exceljs needs. Throws XlsxFileError for a file that can't be a workbook. */
export function planXlsxRead(entries: ZipEntryInfo[]): XlsxReadPlan {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const workbook = byName.get('xl/workbook.xml');
  const rels = byName.get('xl/_rels/workbook.xml.rels');
  const sheets = entries
    .filter((e) => SHEET_RE.test(e.name))
    .sort((a, b) => Number(SHEET_RE.exec(a.name)![1]) - Number(SHEET_RE.exec(b.name)![1]));
  if (!workbook || !rels || sheets.length === 0) {
    throw new XlsxFileError('The file is not a readable .xlsx workbook (workbook or worksheet parts are missing).');
  }
  const chosen = [workbook, rels];
  const styles = byName.get('xl/styles.xml');
  if (styles) chosen.push(styles);
  const shared = byName.get('xl/sharedStrings.xml');
  if (shared) chosen.push(shared);
  chosen.push(...sheets);
  for (const e of chosen) {
    if (e.flags & 0x0001) throw new XlsxFileError('The .xlsx file is encrypted. Save an unprotected copy and upload that.');
    if (e.method !== 0 && e.method !== 8) throw new XlsxFileError(`The .xlsx file uses an unsupported compression method (${e.method}).`);
  }
  return {
    entries: chosen,
    synthesizeSharedStrings: !shared,
    totalCompressedBytes: chosen.reduce((s, e) => s + e.compressedSize, 0),
  };
}

// ─── Writing the re-sequenced stream ─────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A local file header with sizes known up front (no data descriptor); zip64 extra when needed. */
export function localHeader(name: string, method: number, crc: number, compressedSize: number, uncompressedSize: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const big = compressedSize >= U32 || uncompressedSize >= U32;
  const extra = big ? Buffer.alloc(20) : Buffer.alloc(0);
  if (big) {
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(16, 2);
    extra.writeBigUInt64LE(BigInt(uncompressedSize), 4);
    extra.writeBigUInt64LE(BigInt(compressedSize), 12);
  }
  const h = Buffer.alloc(30);
  h.writeUInt32LE(SIG_LOCAL, 0);
  h.writeUInt16LE(big ? 45 : 20, 4);
  h.writeUInt16LE(0x0800, 6); // UTF-8 name; bit 3 (data descriptor) deliberately clear
  h.writeUInt16LE(method, 8);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(big ? U32 : compressedSize, 18);
  h.writeUInt32LE(big ? U32 : uncompressedSize, 22);
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(extra.length, 28);
  return Buffer.concat([h, nameBuf, extra]);
}

const EMPTY_SST = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>',
  'utf8',
);

/** Random access into the uploaded file. */
export interface RangeSource {
  /** Bytes [start, endExclusive) as a Buffer (small reads: headers, the directory). */
  read(start: number, endExclusive: number): Promise<Buffer>;
  /** Bytes [start, endExclusive) as a stream (entry data; may be hundreds of MB). */
  stream(start: number, endExclusive: number): Readable;
}

/**
 * The re-sequenced zip as ONE Readable. `onBytes` sees every compressed byte copied (progress).
 * Backpressure-correct: each entry's data is piped and awaited before the next starts.
 */
export function resequencedXlsxStream(src: RangeSource, plan: XlsxReadPlan, onBytes?: (n: number) => void): Readable {
  const out = new PassThrough({ highWaterMark: 1024 * 1024 });
  // Resolves on 'drain'; rejects once the consumer destroyed the stream (early stop / error), so the
  // copy loop ends and its GCS read streams are released instead of waiting forever.
  const write = (chunk: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (out.destroyed) return reject(new Error('re-sequenced stream closed'));
      if (out.write(chunk)) return resolve();
      const done = () => {
        out.off('drain', done);
        out.off('close', done);
        if (out.destroyed) reject(new Error('re-sequenced stream closed'));
        else resolve();
      };
      out.on('drain', done);
      out.on('close', done);
    });

  const run = async () => {
    const emitted = new Set<string>();
    for (const e of plan.entries) {
      // Emit the synthetic shared strings right before the first worksheet.
      if (plan.synthesizeSharedStrings && !emitted.has('sst') && SHEET_RE.test(e.name)) {
        emitted.add('sst');
        await write(localHeader('xl/sharedStrings.xml', 0, crc32(EMPTY_SST), EMPTY_SST.length, EMPTY_SST.length));
        await write(EMPTY_SST);
      }
      const lh = await src.read(e.localHeaderOffset, e.localHeaderOffset + 30);
      if (lh.length < 30 || lh.readUInt32LE(0) !== SIG_LOCAL) throw new XlsxFileError('The .xlsx file is corrupt (bad local header).');
      const dataStart = e.localHeaderOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      await write(localHeader(e.name, e.method, e.crc32, e.compressedSize, e.uncompressedSize));
      if (e.compressedSize > 0) {
        for await (const chunk of src.stream(dataStart, dataStart + e.compressedSize)) {
          const b = chunk as Buffer;
          onBytes?.(b.length);
          await write(b);
        }
      }
    }
    // A bare end-of-central-directory record: unzipper's Parse ends cleanly on it.
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    await write(eocd);
    out.end();
  };
  run().catch((err: unknown) => {
    if (!out.destroyed) out.destroy(err instanceof Error ? err : new Error(String(err)));
  });
  return out;
}

/**
 * Read the central directory from the END of a random-access file of `size` bytes: first the last
 * `initialTail` bytes, then once more from wherever the directory starts (bounded by `maxDirectoryBytes`).
 */
export async function loadCentralDirectory(
  src: Pick<RangeSource, 'read'>,
  size: number,
  initialTail = 256 * 1024,
  maxDirectoryBytes = 64 * 1024 * 1024,
): Promise<ZipEntryInfo[]> {
  let start = Math.max(0, size - initialTail);
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = readZipCentralDirectory(await src.read(start, size), start);
    if (r.kind === 'ok') return r.entries;
    if (r.kind === 'error') throw new XlsxFileError(`The file is not a readable .xlsx workbook (${r.message}).`);
    if (r.from >= start || size - r.from > maxDirectoryBytes) break;
    start = r.from;
  }
  throw new XlsxFileError('The file is not a readable .xlsx workbook (zip directory not found).');
}
