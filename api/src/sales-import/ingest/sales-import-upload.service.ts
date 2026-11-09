import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type SalesImport } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { buildXlsx } from '../../common/xlsx';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import {
  SALES_IMPORT_ALLOWED_EXTENSIONS,
  SALES_IMPORT_MAX_FILE_BYTES,
  SALES_IMPORT_PART_SIZE,
  type CreateSalesImportUploadResult,
  type MonthSummary,
  type SalesDimensionCombo,
  type SalesDimensionValues,
  type SalesImportCombos,
  type SalesImportDetail,
  type SalesImportErrorSample,
  type SalesImportFileKind,
  type SalesImportList,
  type SalesImportPartResult,
  type SalesImportStatus,
  type SalesImportSummary,
} from '../sales-import.contract';
import { expectedPartSize, partCountFor, partKey, unmatchedCsvKey } from './parts-file';
import { SalesImportRunnerService } from './sales-import-runner.service';

const REPROCESSABLE: SalesImportStatus[] = ['READY', 'NEEDS_MAPPING', 'FAILED'];
export const SALES_IMPORT_LIST_DEFAULT_LIMIT = 20;
export const SALES_IMPORT_LIST_MAX_LIMIT = 50;

/** Fields reset when an import goes (back) to QUEUED. */
const RESET_FOR_QUEUE = {
  status: 'QUEUED',
  error: null,
  attempts: 0,
  heartbeatAt: null,
  startedAt: null,
  finishedAt: null,
  bytesRead: 0n,
  rowsRead: 0,
  rowsSkipped: 0,
  errorSamples: Prisma.DbNull,
  monthSummaries: Prisma.DbNull,
  dimensionValues: Prisma.DbNull,
  dimensionCombos: Prisma.DbNull,
  detectedHeaders: Prisma.DbNull,
} satisfies Prisma.SalesImportUpdateManyMutationInput;

/**
 * Upload bookkeeping + read side of Sales Import (plan §5.2, tasks I-9 / I-10). OWNER: Lane I.
 * Every lookup is scoped `{ id, clientId: user.clientId }` → a cross-tenant id is a plain 404.
 * The controller runs assertSalesImportAccess (operator 400 / flag 403) BEFORE any of these.
 */
@Injectable()
export class SalesImportUploadService {
  private readonly logger = new Logger(SalesImportUploadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly runner: SalesImportRunnerService,
  ) {}

  private async find(user: JwtPayload, id: string): Promise<SalesImport> {
    const row = await this.prisma.salesImport.findFirst({ where: { id, clientId: user.clientId } });
    if (!row) throw new NotFoundException('Sales import not found.');
    return row;
  }

  // ─── Upload ───────────────────────────────────────────────────────────────────

  async createUpload(user: JwtPayload, body: { filename: string; sizeBytes: number }): Promise<CreateSalesImportUploadResult> {
    const filename = String(body.filename ?? '').split(/[\\/]/).pop()!.trim();
    const lower = filename.toLowerCase();
    const ext = SALES_IMPORT_ALLOWED_EXTENSIONS.find((e) => lower.endsWith(e));
    if (!filename || !ext || lower === ext) throw new BadRequestException('Upload a .xlsx or .csv file.');
    const sizeBytes = Number(body.sizeBytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) throw new BadRequestException('The file is empty.');
    if (sizeBytes > SALES_IMPORT_MAX_FILE_BYTES) {
      throw new BadRequestException(`The file is larger than the ${SALES_IMPORT_MAX_FILE_BYTES / (1024 * 1024)} MB limit.`);
    }
    const id = randomUUID();
    const partCount = partCountFor(sizeBytes);
    await this.prisma.salesImport.create({
      data: {
        id,
        clientId: user.clientId,
        uploadedById: user.sub,
        originalFilename: filename,
        fileKind: (ext === '.xlsx' ? 'XLSX' : 'CSV') satisfies SalesImportFileKind,
        sizeBytes: BigInt(sizeBytes),
        partCount,
        gcsPrefix: `sales-imports/${user.clientId}/${id}/`,
        status: 'UPLOADING',
      },
    });
    return { importId: id, partSize: SALES_IMPORT_PART_SIZE, partCount };
  }

  /** Idempotent per (import, n): a retried part overwrites the same object; the count is re-derived. */
  async putPart(user: JwtPayload, id: string, nRaw: string, file: { buffer: Buffer; size: number } | undefined): Promise<SalesImportPartResult> {
    const row = await this.find(user, id);
    if (row.status !== 'UPLOADING') throw new ConflictException(`This import is ${row.status}; parts can only be added while UPLOADING.`);
    if (!/^\d{1,6}$/.test(nRaw)) throw new BadRequestException('Part number must be a non-negative integer.');
    const n = Number(nRaw);
    if (n >= row.partCount) throw new BadRequestException(`Part number must be between 0 and ${row.partCount - 1}.`);
    if (!file?.buffer) throw new BadRequestException('Attach the part as multipart field "file".');
    const expected = expectedPartSize(Number(row.sizeBytes), n);
    if (file.buffer.length !== expected) {
      throw new BadRequestException(`Part ${n} must be exactly ${expected} bytes (got ${file.buffer.length}).`);
    }
    const key = partKey(row.gcsPrefix, n);
    await this.storage.uploadFile(file.buffer, key, 'application/octet-stream');
    const received = await this.countParts(row);
    const upd = await this.prisma.salesImport.updateMany({
      where: { id: row.id, clientId: user.clientId, status: 'UPLOADING' },
      data: { partsReceived: received },
    });
    if (upd.count === 0) {
      // Cancelled (or completed) while this part was in flight: don't leave an orphan object behind.
      await this.storage.deleteFile(key).catch(() => undefined);
      throw new ConflictException('This import is no longer accepting parts.');
    }
    return { partsReceived: received };
  }

  private async listedParts(row: SalesImport): Promise<Map<number, number>> {
    const prefix = `${row.gcsPrefix}parts/`;
    const out = new Map<number, number>();
    for (const o of await this.storage.listPrefix(prefix)) {
      const m = /^(\d{5})$/.exec(o.name.slice(prefix.length));
      if (m && Number(m[1]) < row.partCount) out.set(Number(m[1]), o.size);
    }
    return out;
  }

  private async countParts(row: SalesImport): Promise<number> {
    return (await this.listedParts(row)).size;
  }

  async complete(user: JwtPayload, id: string): Promise<SalesImportSummary> {
    const row = await this.find(user, id);
    if (row.status !== 'UPLOADING') throw new ConflictException(`This import is already ${row.status}.`);
    const size = Number(row.sizeBytes);
    const parts = await this.listedParts(row);
    const missing: number[] = [];
    const wrong: number[] = [];
    let total = 0;
    for (let n = 0; n < row.partCount; n++) {
      const got = parts.get(n);
      if (got === undefined) missing.push(n);
      else if (got !== expectedPartSize(size, n)) wrong.push(n);
      else total += got;
    }
    if (missing.length) throw new BadRequestException(`Upload incomplete: missing part(s) ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}.`);
    if (wrong.length || total !== size) throw new BadRequestException(`Upload corrupted: part(s) ${wrong.slice(0, 20).join(', ')} have the wrong size. Upload the file again.`);

    await this.checkContent(row);

    const upd = await this.prisma.salesImport.updateMany({
      where: { id: row.id, clientId: user.clientId, status: 'UPLOADING' },
      data: { ...RESET_FOR_QUEUE, partsReceived: row.partCount },
    });
    if (upd.count === 0) throw new ConflictException('This import changed state; refresh and try again.');
    await this.runner.kick();
    return this.summaryOf(await this.find(user, id));
  }

  /** First-bytes sanity check: an .xlsx is a zip; a .csv is UTF-8 text. */
  private async checkContent(row: SalesImport): Promise<void> {
    const head = await this.readHead(partKey(row.gcsPrefix, 0), 4096);
    const isZip = head.length >= 4 && head.readUInt32LE(0) === 0x04034b50;
    if (row.fileKind === 'XLSX') {
      if (!isZip) throw new BadRequestException('The file is not a valid .xlsx workbook. If it is a CSV, rename it to .csv.');
      return;
    }
    if (isZip) throw new BadRequestException('This file is an Excel workbook, not a CSV. Rename it to .xlsx and upload again.');
    if (head.includes(0)) throw new BadRequestException('The CSV is not UTF-8 text. In Excel use Save As → "CSV UTF-8 (Comma delimited)".');
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    } catch {
      throw new BadRequestException('The CSV is not UTF-8 text. In Excel use Save As → "CSV UTF-8 (Comma delimited)".');
    }
  }

  private async readHead(key: string, bytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of this.storage.openReadStream(key, { start: 0, end: bytes - 1 })) chunks.push(c as Buffer);
    return Buffer.concat(chunks).subarray(0, bytes);
  }

  async reprocess(user: JwtPayload, id: string): Promise<SalesImportSummary> {
    const row = await this.find(user, id);
    if (!REPROCESSABLE.includes(row.status as SalesImportStatus)) {
      throw new ConflictException(`Only READY, NEEDS_MAPPING or FAILED imports can be reprocessed (this one is ${row.status}).`);
    }
    // One transaction: the worker can't claim the row (QUEUED) until the old aggregates are gone, and
    // a preview never sees a READY import with half its aggregates deleted.
    await this.prisma.$transaction(
      async (tx) => {
        const upd = await tx.salesImport.updateMany({
          where: { id: row.id, clientId: user.clientId, status: row.status },
          data: { ...RESET_FOR_QUEUE },
        });
        if (upd.count === 0) throw new ConflictException('This import changed state; refresh and try again.');
        await tx.salesImportAggregate.deleteMany({ where: { importId: row.id } });
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    await this.runner.kick();
    return this.summaryOf(await this.find(user, id));
  }

  /**
   * Cancel + clean up (plan §5.2 DELETE): allowed for any import that was never applied and is not being
   * processed right now. Soft-delete: the row becomes CANCELLED (hidden from the list), its GCS files and
   * aggregates are removed. Idempotent: deleting a CANCELLED import re-runs the cleanup and succeeds.
   */
  async remove(user: JwtPayload, id: string): Promise<SalesImportSummary> {
    const row = await this.find(user, id);
    if (row.status !== 'CANCELLED') {
      if (row.status === 'PROCESSING') throw new ConflictException('This import is being processed; wait until it finishes, then delete it.');
      const applies = await this.prisma.salesImportApply.count({ where: { importId: row.id } });
      if (applies > 0) throw new ConflictException('This import was applied to a month and is kept as the record of what was written.');
      const upd = await this.prisma.salesImport.updateMany({
        where: { id: row.id, clientId: user.clientId, status: row.status },
        data: { status: 'CANCELLED', finishedAt: new Date(), error: null },
      });
      if (upd.count === 0) throw new ConflictException('This import changed state; refresh and try again.');
    }
    const prefix = `sales-imports/${user.clientId}/${row.id}/`;
    if (row.gcsPrefix === prefix) await this.storage.deletePrefix(prefix);
    else this.logger.error(`sales-import ${row.id}: unexpected gcsPrefix "${row.gcsPrefix}", storage cleanup skipped`);
    await this.prisma.salesImportAggregate.deleteMany({ where: { importId: row.id } });
    return this.summaryOf(await this.find(user, id));
  }

  // ─── Read ─────────────────────────────────────────────────────────────────────

  private async names(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private summaryOf(row: SalesImport, names?: Map<string, string>): Promise<SalesImportSummary> | SalesImportSummary {
    if (!names) return this.names([row.uploadedById]).then((m) => this.toSummary(row, m));
    return this.toSummary(row, names);
  }

  toSummary(row: SalesImport, names: Map<string, string>): SalesImportSummary {
    const size = Number(row.sizeBytes);
    const bytesRead = Number(row.bytesRead);
    return {
      id: row.id,
      status: row.status as SalesImportStatus,
      originalFilename: row.originalFilename,
      fileKind: row.fileKind as SalesImportFileKind,
      sizeBytes: size,
      partCount: row.partCount,
      partsReceived: row.partsReceived,
      bytesRead,
      rowsRead: row.rowsRead,
      rowsSkipped: row.rowsSkipped,
      progressPct: row.status === 'PROCESSING' && size > 0 ? Math.min(100, Math.round((bytesRead / size) * 1000) / 10) : null,
      duplicateOfId: row.duplicateOfId,
      error: row.error,
      detectedHeaders: row.status === 'NEEDS_MAPPING' ? ((row.detectedHeaders as string[][] | null) ?? null) : null,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      uploadedBy: names.get(row.uploadedById) ?? 'Unknown user',
    };
  }

  async list(user: JwtPayload, q: { cursor?: string; limit?: number }): Promise<SalesImportList> {
    const limit = Math.min(SALES_IMPORT_LIST_MAX_LIMIT, Math.max(1, Math.trunc(Number(q.limit ?? SALES_IMPORT_LIST_DEFAULT_LIMIT)) || SALES_IMPORT_LIST_DEFAULT_LIMIT));
    const where: Prisma.SalesImportWhereInput = { clientId: user.clientId, status: { not: 'CANCELLED' } };
    if (q.cursor) {
      const c = await this.prisma.salesImport.findFirst({ where: { id: q.cursor, clientId: user.clientId }, select: { id: true } });
      if (!c) throw new BadRequestException('Invalid cursor.');
    }
    const rows = await this.prisma.salesImport.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    const names = await this.names(page.map((r) => r.uploadedById));
    return { items: page.map((r) => this.toSummary(r, names)), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
  }

  async get(user: JwtPayload, id: string): Promise<SalesImportDetail> {
    const row = await this.find(user, id);
    const summary = await this.summaryOf(row);
    return {
      ...summary,
      monthSummaries: (row.monthSummaries as unknown as MonthSummary[] | null) ?? null,
      errorSamples: (row.errorSamples as unknown as SalesImportErrorSample[] | null) ?? null,
    };
  }

  /** `:id` = 'latest' → the tenant's latest READY import; 404 when there is none (FE: "no processed file yet"). */
  async combos(user: JwtPayload, id: string): Promise<SalesImportCombos> {
    const row =
      id === 'latest'
        ? await this.prisma.salesImport.findFirst({ where: { clientId: user.clientId, status: 'READY' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
        : await this.find(user, id);
    if (!row) throw new NotFoundException('No processed sales file yet.');
    return {
      importId: row.id,
      dimensionValues: (row.dimensionValues as unknown as SalesDimensionValues | null) ?? {},
      dimensionCombos: (row.dimensionCombos as unknown as SalesDimensionCombo[] | null) ?? [],
    };
  }

  async unmatchedCsv(user: JwtPayload, id: string): Promise<{ stream: Readable; filename: string }> {
    const row = await this.find(user, id);
    if (row.status !== 'READY') throw new NotFoundException('The unmatched-customers file is available once the import is READY.');
    const key = unmatchedCsvKey(row.gcsPrefix);
    const exists = (await this.storage.listPrefix(key)).some((o) => o.name === key);
    if (!exists) throw new NotFoundException('The unmatched-customers file is not available for this import.');
    return { stream: this.storage.openReadStream(key), filename: `sales-import-${row.id}-unmatched.csv` };
  }

  async errorsXlsx(user: JwtPayload, id: string): Promise<{ buffer: Buffer; filename: string }> {
    const row = await this.find(user, id);
    const samples = (row.errorSamples as unknown as SalesImportErrorSample[] | null) ?? [];
    const rows = samples.length
      ? samples.map((s) => ({ Row: s.row, Column: s.column ?? '', Reason: s.reason }))
      : [{ Row: '', Column: '', Reason: 'No rows were skipped.' }];
    return { buffer: buildXlsx([{ name: 'Skipped rows', rows }]), filename: `sales-import-${row.id}-errors.xlsx` };
  }
}
