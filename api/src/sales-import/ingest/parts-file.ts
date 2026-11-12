/**
 * The uploaded file as stored in GCS: `SALES_IMPORT_PART_SIZE` parts under `<gcsPrefix>parts/<nnnnn>`
 * (plan D-2 A). Exposes it as ONE logical file: a sequential stream, and random-access ranges (the xlsx
 * re-sequencer reads the zip directory from the tail and copies entries by range).
 */
import { Readable } from 'node:stream';
import { SALES_IMPORT_PART_SIZE } from '../sales-import.contract';
import type { StorageService } from '../../storage/storage.service';
import type { RangeSource } from './xlsx-zip';

/** Object key of part `n` (zero-padded so a prefix listing sorts in order). */
export function partKey(gcsPrefix: string, n: number): string {
  return `${gcsPrefix}parts/${String(n).padStart(5, '0')}`;
}

/**
 * Object key of the frozen unmatched-customers CSV of ONE processing run (re-check M1: per run, so a superseded worker
 * can never overwrite the file of the run that became READY). The READY transaction stores it on the row
 * (`SalesImport.unmatchedCsvKey`); readers use the stored key only.
 */
export function unmatchedCsvKey(gcsPrefix: string, runId: string): string {
  return `${gcsPrefix}unmatched-${runId.replace(/[^A-Za-z0-9-]/g, '')}.csv`;
}

export function partCountFor(sizeBytes: number, partSize = SALES_IMPORT_PART_SIZE): number {
  return Math.max(1, Math.ceil(sizeBytes / partSize));
}

/** Expected byte size of part `n` of a `sizeBytes` file. */
export function expectedPartSize(sizeBytes: number, n: number, partSize = SALES_IMPORT_PART_SIZE): number {
  return Math.max(0, Math.min(partSize, sizeBytes - n * partSize));
}

export class PartsFile implements RangeSource {
  constructor(
    private readonly storage: Pick<StorageService, 'openReadStream'>,
    private readonly gcsPrefix: string,
    readonly size: number,
    private readonly partSize = SALES_IMPORT_PART_SIZE,
  ) {}

  /** Bytes [start, endExclusive) across part boundaries, as a byte stream. */
  stream(start = 0, endExclusive = this.size): Readable {
    const { storage, gcsPrefix, partSize } = this;
    const s0 = Math.max(0, start);
    const e0 = Math.min(this.size, endExclusive);
    async function* gen(): AsyncGenerator<Buffer> {
      for (let p = Math.floor(s0 / partSize); p * partSize < e0; p++) {
        const base = p * partSize;
        const from = Math.max(s0, base) - base;
        const toIncl = Math.min(e0, base + partSize) - base - 1;
        if (toIncl < from) continue;
        const whole = from === 0 && toIncl === partSize - 1;
        const rs = whole ? storage.openReadStream(partKey(gcsPrefix, p)) : storage.openReadStream(partKey(gcsPrefix, p), { start: from, end: toIncl });
        for await (const chunk of rs) yield chunk as Buffer;
      }
    }
    return Readable.from(gen(), { objectMode: false });
  }

  async read(start: number, endExclusive: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of this.stream(start, endExclusive)) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }
}
