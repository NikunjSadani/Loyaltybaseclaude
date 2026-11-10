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
  type SalesColumnMapping,
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
import { mappingFingerprint } from './mapping-fingerprint';
import { expectedPartSize, partCountFor, partKey } from './parts-file';
import { SalesImportRetentionService } from './sales-import-retention.service';
import { SalesImportRunnerService } from './sales-import-runner.service';

const REPROCESSABLE: SalesImportStatus[] = ['READY', 'NEEDS_MAPPING', 'FAILED'];
export const SALES_IMPORT_LIST_DEFAULT_LIMIT = 20;
export const SALES_IMPORT_LIST_MAX_LIMIT = 50;

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
  mappingFingerprint: true,
  reprocessedFromId: true,
  unmatchedCsvKey: true,
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

  /**
   * A failed "reprocess as new" child must never linger as a live child (it would block retries): cancel + purge it;
   * if the purge cannot lock the row right now (busy), mark it CANCELLED anyway — retention purges it later.
   */
  private async abandonChild(user: JwtPayload, childId: string): Promise<void> {
    const r = await this.retention.purgeImport(childId, user.clientId, { cancel: true }).catch(() => 'busy' as const);
    if (r !== 'purged') {
      await this.prisma.salesImport
        .updateMany({
          where: { id: childId, clientId: user.clientId, status: { notIn: ['CANCELLED'] } },
          data: { status: 'CANCELLED', finishedAt: new Date(), claimToken: null },
        })
        .catch(() => undefined);
    }
  }

  /** ≤ SALES_IMPORT_MAX_INFLIGHT_UPLOADS imports UPLOADING per tenant (abandoned ones are swept first). */
  private async assertUploadCapacity(user: JwtPayload): Promise<void> {
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
  }

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
    await this.assertUploadCapacity(user);
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
   * Re-audit M1/L2: NO transaction around the GCS write (the API shares a small DB pool with live tenants) — check the
   * state, store the part, then ONE guarded update (`WHERE status = 'UPLOADING'`). A part that lands after complete /
   * cancel gets 409 and no stored part is ever deleted (complete verified every part's size before queueing).
   */
  async putPart(user: JwtPayload, id: string, nRaw: string, file: { buffer: Buffer; size: number } | undefined): Promise<SalesImportPartResult> {
    if (!/^\d{1,6}$/.test(nRaw)) throw new BadRequestException('Part number must be a non-negative integer.');
    const n = Number(nRaw);
    const row = await this.find(user, id);
    if (row.status !== 'UPLOADING') throw new ConflictException(`This import is ${row.status}; parts can only be added while UPLOADING.`);
    if (n >= row.partCount) throw new BadRequestException(`Part number must be between 0 and ${row.partCount - 1}.`);
    if (!file?.buffer) throw new BadRequestException('Attach the part as multipart field "file".');
    const expected = expectedPartSize(Number(row.sizeBytes), n);
    if (file.buffer.length !== expected) {
      throw new BadRequestException(`Part ${n} must be exactly ${expected} bytes (got ${file.buffer.length}).`);
    }
    await this.storage.uploadFile(file.buffer, partKey(row.gcsPrefix, n), 'application/octet-stream');
    const received = (await this.listedParts(row)).size;
    const upd = await this.prisma.salesImport.updateMany({
      where: { id: row.id, clientId: user.clientId, status: 'UPLOADING' },
      data: { partsReceived: received },
    });
    if (upd.count === 0) {
      // Re-check M2: a part that lands after a CANCEL / purge re-creates an object under a prefix that was already
      // cleaned → delete it again. After a COMPLETE the object is kept: it is byte-identical to the part complete
      // verified (same n of the same file), and the queued import needs it.
      const now = await this.prisma.salesImport.findFirst({ where: { id: row.id, clientId: user.clientId }, select: { status: true, purgedAt: true } });
      if (!now || now.status === 'CANCELLED' || now.purgedAt) {
        await this.storage.deleteFile(partKey(row.gcsPrefix, n)).catch(() => undefined);
      }
      throw new ConflictException('This import is no longer accepting parts (it was completed or cancelled meanwhile).');
    }
    return { partsReceived: received };
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

  /** Every part present with its exact size (400 naming the problem otherwise). */
  private async verifyParts(row: Pick<LockedImport, 'gcsPrefix' | 'partCount' | 'sizeBytes'>): Promise<void> {
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
  }

  /** UPLOADING → QUEUED in ONE short guarded transaction (state update + audit); false when the state moved on. */
  private async queue(user: JwtPayload, row: Pick<LockedImport, 'id' | 'partCount' | 'sizeBytes'>, detail: Record<string, unknown>): Promise<boolean> {
    return this.prisma
      .$transaction(async (tx) => {
        const upd = await tx.salesImport.updateMany({
          where: { id: row.id, clientId: user.clientId, status: 'UPLOADING' },
          data: { ...resetForQueue(), partsReceived: row.partCount },
        });
        if (upd.count === 0) return false;
        await this.audit(tx, user, 'UPDATE', row.id, { sizeBytes: Number(row.sizeBytes), partCount: row.partCount, ...detail });
        return true;
      })
      .catch(rethrowBusy);
  }

  /**
   * Re-audit M1/L1/L2: verification (GCS listing + first-bytes check) runs OUTSIDE any transaction; the UPLOADING →
   * QUEUED flip is one guarded update. A part racing it either landed before the listing (counted) or gets 409.
   */
  async complete(user: JwtPayload, id: string): Promise<SalesImportSummary> {
    const row = await this.find(user, id);
    if (row.status !== 'UPLOADING') throw new ConflictException(`This import is already ${row.status}.`);
    await this.verifyParts(row);
    await this.checkContent(row);
    if (!(await this.queue(user, row, { action: 'complete' }))) {
      throw new ConflictException('This import changed state; refresh and try again.');
    }
    await this.runner.kick();
    return this.summaryOf(await this.find(user, id));
  }

  /**
   * "Reprocess as a new import" (re-audit M3): an APPLIED import cannot be reprocessed in place (its aggregates are the
   * record of what was written), so once the column mapping has changed it would be stranded. This creates a NEW import
   * from the same stored file — parts copied server-side in GCS, outside any transaction — and queues it; the old import
   * stays untouched as the record. 409 when the import is not applied (use Reprocess), the mapping is unchanged, it was
   * purged, or a live re-import of it already exists.
   */
  async reprocessAsNew(user: JwtPayload, id: string): Promise<SalesImportSummary> {
    const old = await this.find(user, id);
    if (old.purgedAt) throw new ConflictException("This import's file was deleted after the retention period. Upload the file again.");
    if (old.status !== 'READY') throw new ConflictException(`Only a READY import can be re-imported (this one is ${old.status}).`);
    if ((await this.appliedCount(this.prisma, old.id)) === 0) {
      throw new ConflictException('This import was never applied; use Reprocess instead.');
    }
    if (old.mappingFingerprint === (await this.currentFingerprint(user.clientId))) {
      throw new ConflictException('The column mapping has not changed since this file was processed; there is nothing to re-import.');
    }
    const child = (await this.liveChildren(user.clientId, [old.id])).get(old.id);
    if (child) throw new ConflictException(`This file is already being re-imported (import ${child}).`);
    await this.assertUploadCapacity(user); // re-check L4: the per-tenant in-flight cap applies here too

    const newId = randomUUID();
    const gcsPrefix = `sales-imports/${user.clientId}/${newId}/`;
    await this.prisma
      .$transaction(async (tx) => {
        // Re-check M3: the parent row is locked (NOWAIT → 409 busy) and the "one live re-import" rule re-checked under the
        // lock, so two concurrent clicks cannot both create a child (the partial unique index is the last line).
        const parent = await lockImportRow(tx, old.id, user.clientId, 'UPDATE NOWAIT');
        if (!parent || parent.purgedAt || parent.status !== 'READY') throw new ConflictException('This import changed meanwhile; refresh and try again.');
        const live = await tx.salesImport.findFirst({
          where: { clientId: user.clientId, reprocessedFromId: old.id, status: { notIn: ['CANCELLED', 'FAILED'] } },
          select: { id: true },
        });
        if (live) throw new ConflictException(`This file is already being re-imported (import ${live.id}).`);
        await tx.salesImport.create({
          data: {
            id: newId,
            clientId: user.clientId,
            uploadedById: user.sub,
            originalFilename: old.originalFilename,
            fileKind: old.fileKind,
            sizeBytes: old.sizeBytes,
            partCount: old.partCount,
            gcsPrefix,
            status: 'UPLOADING',
            reprocessedFromId: old.id,
          },
        });
        await this.audit(tx, user, 'CREATE', newId, { action: 'reprocess-as-new', fromImportId: old.id });
      })
      .catch((e: unknown) => {
        if ((e as { code?: string })?.code === 'P2002') throw new ConflictException('This file is already being re-imported.');
        return rethrowBusy(e);
      });
    const fresh = { id: newId, gcsPrefix, partCount: old.partCount, sizeBytes: old.sizeBytes };
    try {
      for (let n = 0; n < old.partCount; n++) await this.storage.copyFile(partKey(old.gcsPrefix, n), partKey(gcsPrefix, n));
      await this.verifyParts(fresh);
      // Re-check L4: the parent may have been purged while we copied (its parts gone mid-copy) → don't trust the copy.
      const parentNow = await this.prisma.salesImport.findFirst({ where: { id: old.id, clientId: user.clientId }, select: { purgedAt: true } });
      if (!parentNow || parentNow.purgedAt) throw new Error('the original import was purged during the copy');
    } catch (e) {
      await this.abandonChild(user, newId);
      this.logger.warn(`sales-import ${old.id}: re-import copy failed: ${(e as Error)?.message}`);
      throw new ConflictException('The stored file could not be copied for the re-import (it may have been deleted). Upload the file again.');
    }
    if (!(await this.queue(user, fresh, { action: 'complete', fromImportId: old.id }))) {
      throw new ConflictException('The re-import changed state; refresh and try again.');
    }
    await this.runner.kick();
    return this.summaryOf(await this.find(user, newId));
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
        if ((await this.appliedCount(tx, row.id)) > 0) return 'A month was already applied from this import; it cannot be cancelled.';
        if (row.status === 'QUEUED' || isStalled(row)) return null;
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

  /** The tenant's CURRENT column-mapping fingerprint (null without a profile). */
  private async currentFingerprint(clientId: string): Promise<string | null> {
    const p = await this.prisma.salesImportProfile.findUnique({ where: { clientId }, select: { columnMapping: true } });
    return mappingFingerprint((p?.columnMapping ?? null) as SalesColumnMapping | null);
  }

  /** Ids (of `ids`) that already have a live "reprocess as new" child (not CANCELLED / FAILED). */
  private async liveChildren(clientId: string, ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.salesImport.findMany({
      where: { clientId, reprocessedFromId: { in: ids }, status: { notIn: ['CANCELLED', 'FAILED'] } },
      select: { id: true, reprocessedFromId: true },
    });
    return new Map(rows.map((r) => [r.reprocessedFromId!, r.id]));
  }

  private async summaries(clientId: string, rows: SummaryRow[]): Promise<SalesImportSummary[]> {
    const ids = rows.map((r) => r.id);
    const [names, applied, fp, children] = await Promise.all([
      this.names(rows.map((r) => r.uploadedById)),
      this.appliedSet(ids),
      this.currentFingerprint(clientId),
      this.liveChildren(clientId, ids),
    ]);
    return rows.map((r) => this.toSummary(r, names, applied.has(r.id), { currentFingerprint: fp, hasLiveChild: children.has(r.id) }));
  }

  private async summaryOf(row: SummaryRow): Promise<SalesImportSummary> {
    return (await this.summaries(row.clientId, [row]))[0];
  }

  toSummary(
    row: SummaryRow,
    names: Map<string, string>,
    applied: boolean,
    ctx: { currentFingerprint: string | null; hasLiveChild: boolean } = { currentFingerprint: null, hasLiveChild: false },
    now = Date.now(),
  ): SalesImportSummary {
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
      reprocessedFromId: row.reprocessedFromId,
      stalled,
      applied,
      purgedAt: row.purgedAt ? row.purgedAt.toISOString() : null,
      canReprocess: !applied && !purged && (REPROCESSABLE.includes(status) || stalled),
      canReprocessAsNew:
        applied && !purged && status === 'READY' && !ctx.hasLiveChild && row.mappingFingerprint !== ctx.currentFingerprint,
      canCancel: !applied && (status === 'QUEUED' || stalled),
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
    return {
      items: await this.summaries(user.clientId, page),
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
        ? await this.prisma.salesImport.findFirst({ where: { clientId: user.clientId, status: 'READY', purgedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select })
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
    const key = row.unmatchedCsvKey; // the READY run's own file (re-check M1)
    if (!key || !key.startsWith(row.gcsPrefix)) throw new NotFoundException('The unmatched-customers file is not available for this import.');
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
