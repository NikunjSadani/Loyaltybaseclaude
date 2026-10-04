import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { sniffFileType } from '../common/file-signature';

/**
 * CreditEvidenceService — B1: audit-evidence attachments on a credit/payout batch.
 *
 * Lets an operator bulk-upload the client's offline visibility-audit photos/PDFs against a
 * BATCH (no per-file tagging), so the evidence behind a 194C visibility payout lives in-portal
 * with the payment record. Cloned from VisibilityMediaService's hardened media path (magic-byte
 * sniff of the leading bytes — the client mimetype is untrusted; tenant-foldered object key;
 * auth-gated inline-safe stream) and narrowed to the agreed types (JPG/PNG/WEBP + PDF).
 *
 * Tenant scope follows the credits module: every lookup is pinned to `user.clientId` (a GIFSY
 * operator works a tenant by ASSUMING it first). It never reads/writes a money row — attachments
 * are pure metadata decoupled from the payout/invoice state machine. The only coupling is the
 * add-only-after-confirm rule: once a batch leaves PENDING_CONFIRM (invoices generated), evidence
 * can still be ADDED but not DELETED, preserving the audit trail.
 */
@Injectable()
export class CreditEvidenceService {
  /** Types allowed for audit evidence (owner-agreed: images + PDF). All are inline-safe. */
  private static readonly ALLOWED_MIME = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
  ]);

  /** Per-file byte ceiling — bounds parse/transfer memory (phone audit photos run large). */
  private static readonly MAX_BYTES = 10 * 1024 * 1024;

  /**
   * Files accepted in one bulk upload request. Kept small (matches the FE chunk size) so the
   * in-RAM ceiling per request is bounded to MAX_FILES_PER_REQUEST × MAX_BYTES (= 50 MB) —
   * multer buffers whole files in memory, and this service is the bulk path (unlike the
   * single-file visibility clone), so a large cap would be a memory-DoS amplifier.
   */
  private static readonly MAX_FILES_PER_REQUEST = 5;

  /** Total evidence files a single batch may hold. */
  private static readonly MAX_FILES_PER_BATCH = 100;

  /** Object-key tenant folder for all credit-batch evidence. */
  private static readonly FOLDER_PREFIX = 'credit-evidence/';

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** The client-facing shape of an attachment row — never leaks the GCS object key. */
  private toDto(row: {
    id: string;
    batchId: string;
    outletCode: string | null;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    uploadedById: string;
    createdAt: Date;
  }) {
    return {
      id: row.id,
      batchId: row.batchId,
      outletCode: row.outletCode,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      uploadedById: row.uploadedById,
      createdAt: row.createdAt,
    };
  }

  /** Load a batch pinned to the caller's (assumed) tenant, or 404. */
  private async requireBatch(user: JwtPayload, batchId: string) {
    const batch = await this.prisma.creditBatch.findFirst({
      where: { id: batchId, clientId: user.clientId },
      select: { id: true, clientId: true, status: true },
    });
    if (!batch) throw new NotFoundException('Batch not found');
    return batch;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Upload (bulk, magic-byte guarded)
  // ───────────────────────────────────────────────────────────────────────────

  async uploadEvidence(
    user: JwtPayload,
    batchId: string,
    files: Express.Multer.File[] | undefined,
  ) {
    const batch = await this.requireBatch(user, batchId);

    const incoming = (files ?? []).filter(Boolean);
    if (incoming.length === 0) throw new BadRequestException('No files uploaded');
    if (incoming.length > CreditEvidenceService.MAX_FILES_PER_REQUEST) {
      throw new BadRequestException(
        `Too many files in one upload (max ${CreditEvidenceService.MAX_FILES_PER_REQUEST}).`,
      );
    }

    // Validate EVERY file (type + size) before storing ANY — a single bad file fails the
    // whole request, so a partial upload never lands.
    const sniffedAll: { file: Express.Multer.File; mime: string; ext: string }[] = [];
    for (const file of incoming) {
      if (!file.buffer?.length) throw new BadRequestException(`Empty file: ${file.originalname || 'unnamed'}`);
      if (file.size > CreditEvidenceService.MAX_BYTES) {
        throw new BadRequestException(`File too large (max 10 MB): ${file.originalname || 'unnamed'}`);
      }
      const sniffed = sniffFileType(file.buffer);
      if (!sniffed || !CreditEvidenceService.ALLOWED_MIME.has(sniffed.mime)) {
        throw new BadRequestException(
          `Unsupported or corrupt file "${file.originalname || 'unnamed'}". Upload a JPG, PNG, WEBP, or PDF.`,
        );
      }
      sniffedAll.push({ file, mime: sniffed.mime, ext: sniffed.ext });
    }

    // Enforce the per-batch total AFTER validation (count existing + this request).
    const existingCount = await this.prisma.creditBatchAttachment.count({
      where: { clientId: user.clientId, batchId: batch.id },
    });
    if (existingCount + sniffedAll.length > CreditEvidenceService.MAX_FILES_PER_BATCH) {
      throw new BadRequestException(
        `This batch would exceed the evidence limit of ${CreditEvidenceService.MAX_FILES_PER_BATCH} files.`,
      );
    }

    // Store to GCS (tenant-foldered key), then persist metadata in one createMany. If ANY GCS
    // write or the insert throws, best-effort delete whatever we already wrote so a partial
    // failure never leaves orphaned objects behind (the DB row is the source of truth).
    const rows: Prisma.CreditBatchAttachmentCreateManyInput[] = [];
    const uploadedKeys: string[] = [];
    try {
      for (const { file, mime, ext } of sniffedAll) {
        const key = this.storage.generateKey(
          `${CreditEvidenceService.FOLDER_PREFIX}${user.clientId}/${batch.id}`,
          file.originalname || `evidence.${ext}`,
        );
        await this.storage.uploadFile(file.buffer, key, mime);
        uploadedKeys.push(key);
        rows.push({
          clientId: user.clientId,
          batchId: batch.id,
          outletCode: null as string | null,
          fileKey: key,
          fileName: (file.originalname || `evidence.${ext}`).slice(0, 255),
          contentType: mime,
          sizeBytes: file.size,
          uploadedById: user.sub,
        });
      }
      await this.prisma.creditBatchAttachment.createMany({ data: rows });
    } catch (e) {
      await Promise.allSettled(uploadedKeys.map((k) => this.storage.deleteFile(k)));
      throw e;
    }

    return this.listEvidence(user, batch.id);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // List (metadata only)
  // ───────────────────────────────────────────────────────────────────────────

  async listEvidence(user: JwtPayload, batchId: string) {
    const batch = await this.requireBatch(user, batchId);
    const rows = await this.prisma.creditBatchAttachment.findMany({
      where: { clientId: user.clientId, batchId: batch.id },
      orderBy: { createdAt: 'asc' },
    });
    return { attachments: rows.map((r) => this.toDto(r)) };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // View (auth-gated, inline-safe stream)
  // ───────────────────────────────────────────────────────────────────────────

  async viewEvidence(
    user: JwtPayload,
    attachmentId: string,
  ): Promise<{ bytes: Buffer; contentType: string; fileName: string; inline: boolean }> {
    const deny = () => new NotFoundException();

    const row = await this.prisma.creditBatchAttachment.findUnique({
      where: { id: attachmentId },
      select: { clientId: true, fileKey: true, fileName: true, contentType: true },
    });
    if (!row) throw deny();
    // Tenant pin: the caller's (assumed) tenant must own the row. Defence-in-depth: the key's
    // tenant folder must match too (`credit-evidence/<clientId>/…`), mirroring VisibilityMedia.
    if (row.clientId !== user.clientId) throw deny();
    if (!row.fileKey.startsWith(`${CreditEvidenceService.FOLDER_PREFIX}${user.clientId}/`)) throw deny();

    const file = await this.storage.downloadBytes(row.fileKey);
    if (!file) throw deny();

    const mime = (row.contentType || '').toLowerCase();
    const safe = CreditEvidenceService.ALLOWED_MIME.has(mime);
    // Only IMAGES render inline. A PDF is served as a download (attachment) so a crafted PDF
    // with embedded JS can't execute in the app's same origin; anything unexpected → octet-stream.
    const inline = safe && mime.startsWith('image/');
    return {
      bytes: file.bytes,
      contentType: safe ? mime : 'application/octet-stream',
      fileName: row.fileName,
      inline,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Delete (add-only after the batch is confirmed)
  // ───────────────────────────────────────────────────────────────────────────

  async deleteEvidence(user: JwtPayload, batchId: string, attachmentId: string) {
    const batch = await this.requireBatch(user, batchId);
    if (batch.status !== 'PENDING_CONFIRM') {
      throw new BadRequestException(
        'This batch is already confirmed — evidence can be added but not removed (audit trail is locked).',
      );
    }
    const row = await this.prisma.creditBatchAttachment.findFirst({
      where: { id: attachmentId, clientId: user.clientId, batchId: batch.id },
      select: { id: true, fileKey: true },
    });
    if (!row) throw new NotFoundException('Attachment not found');

    await this.prisma.creditBatchAttachment.delete({ where: { id: row.id } });
    // Best-effort object cleanup — the row is the source of truth; a stray object is swept by
    // the bucket lifecycle. Never fail the delete because GCS hiccuped.
    try {
      await this.storage.deleteFile(row.fileKey);
    } catch {
      /* ignore — lifecycle will reap it */
    }
    return { ok: true };
  }
}
