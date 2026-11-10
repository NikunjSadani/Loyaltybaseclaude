import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { buildXlsx } from '../../common/xlsx';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import {
  SALES_IMPORT_ABANDONED_UPLOAD_HOURS,
  SALES_IMPORT_ALLOWED_EXTENSIONS,
  SALES_IMPORT_MAX_FILE_BYTES,
  SALES_IMPORT_MAX_INFLIGHT_UPLOADS,
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
import { isStalled, lockImportRow, rethrowBusy, IMPORT_BUSY_MESSAGE, type LockedImport } from './import-lock';
import { expectedPartSize, partCountFor, partKey, unmatchedCsvKey } from './parts-file';
import { SalesImportRetentionService } from './sales-import-retention.service';
import { SalesImportRunnerService } from './sales-import-runner.service';

const REPROCESSABLE: SalesImportStatus[] = ['READY', 'NEEDS_MAPPING', 'FAILED'];
export const SALES_IMPORT_LIST_DEFAULT_LIMIT = 20;
export const SALES_IMPORT_LIST_MAX_LIMIT = 50;
/** complete() waits at most this long for in-flight part uploads holding the row (S8). */
const COMPLETE_LOCK_TIMEOUT = '30s';

/**
 * Fields reset when an import goes (back) to QUEUED. `claimToken: null` invalidates any worker still holding the old
 * claim (M2: its heartbeat / final write match nothing and it stops), so `attempts` can safely restart at 0.
 */
const resetForQueue = (): Prisma.SalesImportUpdateManyMutationInput => ({
  status: 'QUEUED',
  queuedAt: new Date(),
  error: null,
  attempts: 0,
  claimToken: null,
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
});

/** S3: the list never selects JSON blobs. */
const SUMMARY_SELECT = {
  id: true,
  clientId: true,
  status: true,
  originalFilename: true,
  fileKind: true,
  sizeBytes: true,
  partCount: true,
  partsReceived: true,
  bytesRead: true,
  rowsRead: true,
  rowsSkipped: true,
  duplicateOfId: true,
  error: true,
  createdAt: true,
  finishedAt: true,
  uploadedById: true,
  heartbeatAt: true,
  queuedAt: true,
  purgedAt: true,
  gcsPrefix: true,
} satisfies Prisma.SalesImportSelect;
type SummaryRow = Prisma.SalesImportGetPayload<{ select: typeof SUMMARY_SELECT }>;

const DETAIL_SELECT = {
  ...SUMMARY_SELECT,
  detectedHeaders: true,
  monthSummaries: true,
  errorSamples: true,
} satisfies Prisma.SalesImportSelect;

/**
 * Upload bookkeeping + lifecycle + read side of Sales Import (plan §5.2, tasks I-9 / I-10; audit fix round).
 * Every lookup is scoped `{ id, clientId: user.clientId }` → a cross-tenant id is a plain 404. The controller (and,
 * for parts, SalesImportWriteGuard BEFORE the body is buffered) runs assertSalesImportAccess first.
 * Lifecycle writes lock the import row (see import-lock.ts) and are audited (entityType SALES_IMPORT).
 */
@Injectable()
export class SalesImportUploadService {
  private readonly logger = new Logger(SalesImportUploadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly runner: SalesImportRunnerService,
    private readonly retention: SalesImportRetentionService,
  ) {}

  private async find(user: JwtPayload, id: string): Promise<SummaryRow> {
    const row = await this.prisma.salesImport.findFirst({ where: { id, clientId: user.clientId }, select: SUMMARY_SELECT });
    if (!row) throw new NotFoundException('Sales import not found.');
    return row;
  }

  private audit(
    db: Pick<Prisma.TransactionClient, 'auditLog'>,
    user: JwtPayload,
    action: 'CREATE' | 'UPDATE' | 'DELETE' | 'EXPORT',
    importId: string,
    detail: Record<string, unknown>,
  ) {
    return db.auditLog.create({
      data: {
        action,
        entityType: 'SALES_IMPORT',
        entityId: importId,
        actorId: user.sub,
        newValues: detail as Prisma.InputJsonValue,
        metadata: { clientId: user.clientId, importId },
      },
    });
  }

  private async appliedCount(db: Pick<Prisma.TransactionClient, 'salesImportApply'>, importId: string): Promise<number> {
    return db.salesImportApply.count({ where: { importId } });
  }

  // ─── Upload ───────────────────────────────────────────────────────────────────

  async createUpload(user: JwtPayload, body: { filename: string; sizeBytes: number }): Promise<CreateSalesImportUploadResult> {
    const filename = String(body.filename ?? '').split(/[\\/]/).pop()!.trim().slice(0, 255);
    const lower = filename.toLowerCase();
    const ext = SALES_IMPORT_ALLOWED_EXTENSIONS.find((e) => lower.endsWith(e));
    if (!filename || !ext || lower === ext) throw new BadRequestException('Upload a .xlsx or .csv file.');
    const sizeBytes = Number(body.sizeBytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) throw new BadRequestException('The file is empty.');
    if (sizeBytes > SALES_IMPORT_MAX_FILE_BYTES) {
      throw new BadRequestException(`The file is larger than the ${SALES_IMPORT_MAX_FILE_BYTES / (1024 * 1024)} MB limit.`);
    }
    // S5: abandoned uploads (> 24 h) are cancelled + purged first, so they never count against the cap.
    await this.retention.sweep({ clientId: user.clientId, limit: 5 });
    const since = new Date(Date.now() - SALES_IMPORT_ABANDONED_UPLOAD_HOURS * 3_600_000);
    const inflight = await this.prisma.salesImport.count({
      where: { clientId: user.clientId, status: 'UPLOADING', createdAt: { gte: since } },
    });
    if (inflight >= SALES_IMPORT_MAX_INFLIGHT_UPLOADS) {
      throw new ConflictException(
        `${inflight} uploads are already in progress for this tenant (the limit is ${SALES_IMPORT_MAX_INFLIGHT_UPLOADS}). Finish or delete one, then try again.`,
      );
    }
    const id = randomUUID();
    const partCount = partCountFor(sizeBytes);
    await this.prisma.$transaction(async (tx) => {
      await tx.salesImport.create({
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
      await this.audit(tx, user, 'CREATE', id, { action: 'create-upload', filename, sizeBytes, partCount });
    });
    return { importId: id, partSize: SALES_IMPORT_PART_SIZE, partCount };
  }

  /**
   * Idempotent per (import, n): a retried part overwrites the same object; the count is re-derived.
   * S8: holds FOR KEY SHARE on the import row for the whole store, so complete() (FOR UPDATE) waits for in-flight
   * parts, and a part arriving after complete sees QUEUED → 409 WITHOUT touching any stored part.
   */
  async putPart(user: JwtPayload, id: string, nRaw: string, file: { buffer: Buffer; size: number } | undefined): Promise<SalesImportPartResult> {
    if (!/^\d{1,6}$/.test(nRaw)) throw new BadRequestException('Part number must be a non-negative integer.');
    const n = Number(nRaw);
    return this.prisma.$transaction(
      async (tx) => {
        const row = await lockImportRow(tx, id, user.clientId, 'KEY SHARE');
        if (!row) throw new NotFoundException('Sales import not found.');
        if (row.status !== 'UPLOADING') throw new ConflictException(`This import is ${row.status}; parts can only be added while UPLOADING.`);
        if (n >= row.partCount) throw new BadRequestException(`Part number must be between 0 and ${row.partCount - 1}.`);
        if (!file?.buffer) throw new BadRequestException('Attach the part as multipart field "file".');
        const expected = expectedPartSize(Number(row.sizeBytes), n);
        if (file.buffer.length !== expected) {
          throw new BadRequestException(`Part ${n} must be exactly ${expected} bytes (got ${file.buffer.length}).`);
        }
        await this.storage.uploadFile(file.buffer, partKey(row.gcsPrefix, n), 'application/octet-stream');
        const received = (await this.listedParts(row)).size;
        await tx.salesImport.update({ where: { id: row.id }, data: { partsReceived: received } });
        return { partsReceived: received };
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  }

  private async listedParts(row: Pick<LockedImport, 'gcsPrefix' | 'partCount'>): Promise<Map<number, number>> {
    const prefix = `${row.gcsPrefix}parts/`;
    const out = new Map<number, number>();
    for (const o of await this.storage.listPrefix(prefix)) {
      const m = /^(\d{5})$/.exec(o.name.slice(prefix.length));
      if (m && Number(m[1]) < row.partCount) out.set(Number(m[1]), o.size);
    }
    return out;
  }

  async complete(user: JwtPayload, id: string): Promise<SalesImportSummary> {
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT set_config('lock_timeout', ${COMPLETE_LOCK_TIMEOUT}, true)`);
        const row = await lockImportRow(tx, id, user.clientId, 'UPDATE');
        if (!row) throw new NotFoundException('Sales import not found.');
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
        await tx.salesImport.update({ where: { id: row.id }, data: { ...resetForQueue(), partsReceived: row.partCount } });
        await this.audit(tx, user, 'UPDATE', row.id, { action: 'complete', sizeBytes: size, partCount: row.partCount });
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await this.runner.kick();
    return this.summaryOf(await this.find(user, id));
  }

  /** First-bytes sanity check: an .xlsx is a zip; a .csv is UTF-8 text. */
  private async checkContent(row: Pick<LockedImport, 'gcsPrefix' | 'fileKind'>): Promise<void> {
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

  /**
   * Reprocess (H1/S1/S2/M3): FOR UPDATE NOWAIT on the import row — an apply holding FOR SHARE (or the worker's final
   * write) → 409 busy instead of a race. Refused once any month was applied from this import (the applied aggregates are
   * the record of what was written) and once purged. A stalled PROCESSING import (dead worker) may be reprocessed; the
   * reset clears the claim token, so the old worker can no longer write.
   */
  async reprocess(user: JwtPayload, id: string): Promise<SalesImportSummary> {
    await this.prisma
      .$transaction(
        async (tx) => {
          const row = await lockImportRow(tx, id, user.clientId, 'UPDATE NOWAIT');
          if (!row) throw new NotFoundException('Sales import not found.');
          const stalled = isStalled(row);
          if (!REPROCESSABLE.includes(row.status as SalesImportStatus) && !stalled) {
            throw new ConflictException(
              row.status === 'PROCESSING'
                ? 'This import is being processed right now. If it shows no progress for 10 minutes it can be reprocessed or cancelled.'
                : `Only READY, NEEDS_MAPPING or FAILED imports can be reprocessed (this one is ${row.status}).`,
            );
          }
          if (row.purgedAt) throw new ConflictException('This import\'s file was deleted after the retention period. Upload the file again.');
          if ((await this.appliedCount(tx, row.id)) > 0) {
            throw new ConflictException('A month was already applied from this import, so it is kept as the record of what was written. Upload the file again to re-import it.');
          }
          await tx.salesImport.update({ where: { id: row.id }, data: resetForQueue() });
          await this.audit(tx, user, 'UPDATE', row.id, { action: 'reprocess', fromStatus: row.status, stalled });
        },
        { timeout: 30_000, maxWait: 10_000 },
      )
      .catch(rethrowBusy);
    await this.runner.kick();
    return this.summaryOf(await this.find(user, id));
  }

  /**
   * POST :id/cancel (M3): QUEUED or stalled PROCESSING → CANCELLED, files + aggregates purged. A live worker notices on
   * its next heartbeat (the claim token is cleared) and stops without writing.
   */
  async cancel(user: JwtPayload, id: string): Promise<SalesImportSummary> {
    const r = await this.retention.purgeImport(id, user.clientId, {
      cancel: true,
      check: async (row, tx) => {
        if (row.status === 'QUEUED' || isStalled(row)) {
          if ((await this.appliedCount(tx, row.id)) > 0) return 'A month was already applied from this import; it cannot be cancelled.';
          return null;
        }
        if (row.status === 'PROCESSING') return 'This import is being processed and still making progress. It can be cancelled if it shows no progress for 10 minutes.';
        return `Only a QUEUED or stalled import can be cancelled (this one is ${row.status}).`;
      },
      onPurged: (tx, row) => this.audit(tx, user, 'UPDATE', row.id, { action: 'cancel', fromStatus: row.status }),
    });
    this.raiseOutcome(r);
    return this.summaryOf(await this.find(user, id));
  }

  /**
   * DELETE (cancel + clean up, plan §5.2): any never-applied import that is not being processed right now (a stalled
   * one is fine). The row becomes CANCELLED (hidden from the list), its GCS files and aggregates are removed.
   * Idempotent: deleting a CANCELLED import re-runs the cleanup and succeeds.
   */
  async remove(user: JwtPayload, id: string): Promise<SalesImportSummary> {
    const r = await this.retention.purgeImport(id, user.clientId, {
      cancel: true,
      check: async (row, tx) => {
        if (row.status === 'PROCESSING' && !isStalled(row)) return 'This import is being processed; wait until it finishes, then delete it.';
        if ((await this.appliedCount(tx, row.id)) > 0) return 'This import was applied to a month and is kept as the record of what was written.';
        return null;
      },
      onPurged: (tx, row) => this.audit(tx, user, 'DELETE', row.id, { action: 'delete', fromStatus: row.status }),
    });
    this.raiseOutcome(r);
    return this.summaryOf(await this.find(user, id));
  }

  private raiseOutcome(r: Awaited<ReturnType<SalesImportRetentionService['purgeImport']>>): void {
    if (r === 'notFound') throw new NotFoundException('Sales import not found.');
    if (r === 'busy') throw new ConflictException(IMPORT_BUSY_MESSAGE);
    if (typeof r === 'object') throw new ConflictException(r.refused);
  }

  // ─── Read ─────────────────────────────────────────────────────────────────────

  private async names(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private async appliedSet(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.prisma.salesImportApply.findMany({
      where: { importId: { in: ids } },
      select: { importId: true },
      distinct: ['importId'],
    });
    return new Set(rows.map((r) => r.importId));
  }

  private async summaryOf(row: SummaryRow): Promise<SalesImportSummary> {
    const [names, applied] = await Promise.all([this.names([row.uploadedById]), this.appliedSet([row.id])]);
    return this.toSummary(row, names, applied.has(row.id));
  }

  toSummary(row: SummaryRow, names: Map<string, string>, applied: boolean, now = Date.now()): SalesImportSummary {
    const size = Number(row.sizeBytes);
    const bytesRead = Number(row.bytesRead);
    const status = row.status as SalesImportStatus;
    const stalled = isStalled(row, now);
    const purged = !!row.purgedAt;
    return {
      id: row.id,
      status,
      originalFilename: row.originalFilename,
      fileKind: row.fileKind as SalesImportFileKind,
      sizeBytes: size,
      partCount: row.partCount,
      partsReceived: row.partsReceived,
      bytesRead,
      rowsRead: row.rowsRead,
      rowsSkipped: row.rowsSkipped,
      progressPct: status === 'PROCESSING' && size > 0 ? Math.min(100, Math.round((bytesRead / size) * 1000) / 10) : null,
      duplicateOfId: row.duplicateOfId,
      error: row.error,
      detectedHeaders: null,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      uploadedBy: names.get(row.uploadedById) ?? 'Unknown user',
      queuedAt: row.queuedAt ? row.queuedAt.toISOString() : null,
      heartbeatAt: row.heartbeatAt ? row.heartbeatAt.toISOString() : null,
      stalled,
      applied,
      purgedAt: row.purgedAt ? row.purgedAt.toISOString() : null,
      canReprocess: !applied && !purged && (REPROCESSABLE.includes(status) || stalled),
      canCancel: status === 'QUEUED' || stalled,
      canDelete: !applied && !(status === 'PROCESSING' && !stalled),
    };
  }

  async list(user: JwtPayload, q: { cursor?: string; limit?: number }): Promise<SalesImportList> {
    const limit = Math.min(SALES_IMPORT_LIST_MAX_LIMIT, Math.max(1, Math.trunc(Number(q.limit ?? SALES_IMPORT_LIST_DEFAULT_LIMIT)) || SALES_IMPORT_LIST_DEFAULT_LIMIT));
    // S5: lazy retention for this tenant (bounded; never throws).
    await this.retention.sweep({ clientId: user.clientId, limit: 3 });
    const where: Prisma.SalesImportWhereInput = { clientId: user.clientId, status: { not: 'CANCELLED' } };
    if (q.cursor) {
      const c = await this.prisma.salesImport.findFirst({ where: { id: q.cursor, clientId: user.clientId }, select: { id: true } });
      if (!c) throw new BadRequestException('Invalid cursor.');
    }
    const rows = await this.prisma.salesImport.findMany({
      where,
      select: SUMMARY_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    const [names, applied] = await Promise.all([this.names(page.map((r) => r.uploadedById)), this.appliedSet(page.map((r) => r.id))]);
    return {
      items: page.map((r) => this.toSummary(r, names, applied.has(r.id))),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /**
   * `detectedHeaders` = [headerRow, ...sample rows]. Sample rows are customer data, so they are returned only when
   * `includeSamples` (the caller holds targets:upload); everyone else gets the header row alone.
   */
  async get(user: JwtPayload, id: string, opts: { includeSamples: boolean } = { includeSamples: false }): Promise<SalesImportDetail> {
    const row = await this.prisma.salesImport.findFirst({ where: { id, clientId: user.clientId }, select: DETAIL_SELECT });
    if (!row) throw new NotFoundException('Sales import not found.');
    const summary = await this.summaryOf(row);
    const dh = Array.isArray(row.detectedHeaders) ? (row.detectedHeaders as unknown as string[][]) : null;
    return {
      ...summary,
      detectedHeaders: dh && dh.length ? (opts.includeSamples ? dh : dh.slice(0, 1)) : null,
      monthSummaries: (row.monthSummaries as unknown as MonthSummary[] | null) ?? null,
      errorSamples: (row.errorSamples as unknown as SalesImportErrorSample[] | null) ?? null,
    };
  }

  /** `:id` = 'latest' → the tenant's latest READY import; 404 when there is none (FE: "no processed file yet"). */
  async combos(user: JwtPayload, id: string): Promise<SalesImportCombos> {
    const select = { id: true, dimensionValues: true, dimensionCombos: true } satisfies Prisma.SalesImportSelect;
    const row =
      id === 'latest'
        ? await this.prisma.salesImport.findFirst({ where: { clientId: user.clientId, status: 'READY' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select })
        : await this.prisma.salesImport.findFirst({ where: { id, clientId: user.clientId }, select });
    if (!row) throw new NotFoundException(id === 'latest' ? 'No processed sales file yet.' : 'Sales import not found.');
    return {
      importId: row.id,
      dimensionValues: (row.dimensionValues as unknown as SalesDimensionValues | null) ?? {},
      dimensionCombos: (row.dimensionCombos as unknown as SalesDimensionCombo[] | null) ?? [],
    };
  }

  async unmatchedCsv(user: JwtPayload, id: string): Promise<{ stream: Readable; filename: string }> {
    const row = await this.find(user, id);
    if (row.status !== 'READY') throw new NotFoundException('The unmatched-customers file is available once the import is READY.');
    if (row.purgedAt) throw new NotFoundException('The unmatched-customers file was deleted after the retention period.');
    const key = unmatchedCsvKey(row.gcsPrefix);
    const exists = (await this.storage.listPrefix(key)).some((o) => o.name === key);
    if (!exists) throw new NotFoundException('The unmatched-customers file is not available for this import.');
    await this.audit(this.prisma, user, 'EXPORT', row.id, { action: 'unmatched.csv' });
    return { stream: this.storage.openReadStream(key), filename: `sales-import-${row.id}-unmatched.csv` };
  }

  async errorsXlsx(user: JwtPayload, id: string): Promise<{ buffer: Buffer; filename: string }> {
    const row = await this.prisma.salesImport.findFirst({ where: { id, clientId: user.clientId }, select: { id: true, errorSamples: true } });
    if (!row) throw new NotFoundException('Sales import not found.');
    const samples = (row.errorSamples as unknown as SalesImportErrorSample[] | null) ?? [];
    const rows = samples.length
      ? samples.map((s) => ({ Row: s.row, Column: s.column ?? '', Reason: s.reason }))
      : [{ Row: '', Column: '', Reason: 'No rows were skipped.' }];
    return { buffer: buildXlsx([{ name: 'Skipped rows', rows }]), filename: `sales-import-${row.id}-errors.xlsx` };
  }
}
