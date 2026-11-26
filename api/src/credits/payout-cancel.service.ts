import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { formatINR } from '../common/money';
import {
  applyCancellation,
  assertGifsyAssumed,
  CANCELLATION_AUDIT_ENTITY,
  cancelBlockText,
  evaluateCancellation,
  KIND_STATUS,
  kindOfStatus,
  MAX_CANCEL_ROWS,
  normaliseReason,
  toJson,
  type CancelBlock,
  type CancelItem,
  type CancelKind,
  type CancelRowView,
} from './payout-cancel';
import { buildCancelTemplate, parseCancelFile, type FileProblem, type ParsedCancelRow } from './payout-cancel-file';
import { buildPayoutStatus, type StatusEntryRow } from './payout-status';
import type { CancelPayoutsDto, CancelPreviewDto, CancelTemplateQueryDto, PayoutEntriesQueryDto } from './dto/payout-cancel.dto';

const CREDIT_BATCH_CONFIRM_ENTITY = 'CREDIT_BATCH_CONFIRM';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A file row the admin is told about (cannot be cancelled) — row number + why. */
export interface FileBlockedRow {
  rowNum: number;
  entryId: string;
  outletId: string;
  reason: string;
  code: string;
}

/**
 * Payout cancellation + Payout Status breakdown (owner 2026-11-25). Money rules live in payout-cancel.ts; this service
 * is the tenant-scoped adapter (scoping from the JWT, never from input), the file flow, and the refusal audit.
 */
@Injectable()
export class PayoutCancelService {
  private readonly logger = new Logger(PayoutCancelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // ─── Payout Status: per-upload + per-field breakdown ────────────────────────────────────────────
  async payoutStatus(user: JwtPayload, batchId: string) {
    const batch = await this.prisma.creditBatch.findFirst({
      where: { id: batchId, clientId: user.clientId },
      select: { id: true, batchCode: true, period: true, status: true, totalPayoutPaise: true, sourceKind: true, rows: true },
    });
    if (!batch) throw new NotFoundException('Batch not found');
    const [rows, visFields, confirmRow] = await Promise.all([
      this.prisma.creditPayoutEntry.findMany({
        where: { clientId: user.clientId, batchId },
        select: {
          id: true, fieldId: true, fieldName: true, outletId: true, outletName: true, period: true, amountPaise: true,
          status: true, utr: true, paidAt: true, createdAt: true, updatedAt: true, cancelledAt: true, tdsDeductedPaise: true,
          batch: { select: { batchCode: true, sourceKind: true } },
          reversalAllocations: { select: { state: true, amountPaise: true, receivablePaise: true, creditReversal: { select: { approvedAt: true } } } },
        },
      }),
      this.prisma.creditField.findMany({ where: { clientId: user.clientId, payoutStream: 'VISIBILITY' }, select: { id: true } }),
      this.prisma.auditLog.findFirst({
        where: { entityType: CREDIT_BATCH_CONFIRM_ENTITY, entityId: batchId },
        orderBy: { createdAt: 'desc' },
        select: { metadata: true },
      }),
    ]);
    const m = confirmRow?.metadata && typeof confirmRow.metadata === 'object' && !Array.isArray(confirmRow.metadata)
      ? (confirmRow.metadata as Record<string, unknown>)
      : null;
    const entries: StatusEntryRow[] = rows.map((e) => ({
      ...e,
      status: String(e.status),
      heldByReversal: e.reversalAllocations.some((a) => a.state === 'RESERVED'),
    }));
    return buildPayoutStatus({
      batch,
      entries,
      visibilityFieldIds: new Set(visFields.map((f) => f.id)),
      notApplied: Array.isArray(m?.notApplied) ? (m!.notApplied as Array<{ points?: number; kind?: string }>) : [],
    });
  }

  // ─── Row drill-down (paginated) ─────────────────────────────────────────────────────────────────
  async listEntries(user: JwtPayload, q: PayoutEntriesQueryDto) {
    const pageSize = q.pageSize ?? 50;
    const where: Prisma.CreditPayoutEntryWhereInput = { clientId: user.clientId };
    if (q.batchId) where.batchId = q.batchId;
    if (q.fieldId) where.fieldId = q.fieldId;
    if (q.period) where.period = q.period;
    if (q.status) where.status = q.status as Prisma.CreditPayoutEntryWhereInput['status'];
    const search = q.search?.trim();
    if (search) {
      where.OR = [
        { outletId: { contains: search, mode: 'insensitive' } },
        { outletName: { contains: search, mode: 'insensitive' } },
      ];
    }
    const total = await this.prisma.creditPayoutEntry.count({ where });
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(q.page ?? 1, pages);
    const rows = await this.prisma.creditPayoutEntry.findMany({
      where,
      orderBy: [{ outletId: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, batchId: true, outletId: true, outletName: true, fieldId: true, fieldName: true, period: true,
        amountPaise: true, status: true, utr: true, paidAt: true, failureReason: true, attemptedAt: true, downloadId: true,
        tdsDeductedPaise: true, cancelledAt: true, cancelReason: true, cancelledById: true,
        batch: { select: { batchCode: true } },
        download: { select: { downloadCode: true } },
        reversalAllocations: { where: { state: 'RESERVED' }, select: { id: true } },
      },
    });
    return {
      rows: rows.map((e) => {
        const st = String(e.status);
        const held = e.reversalAllocations.length > 0;
        const settledByTds = !!e.utr && e.utr.startsWith('TDS-WITHHELD-');
        return {
          id: e.id,
          batchId: e.batchId,
          batchCode: e.batch?.batchCode ?? '',
          outletId: e.outletId,
          outletName: e.outletName,
          fieldId: e.fieldId,
          fieldName: e.fieldName,
          period: e.period,
          amountPaise: Number(e.amountPaise),
          tdsDeductedPaise: Number(e.tdsDeductedPaise ?? 0n),
          status: st,
          bankFileCode: e.download?.downloadCode ?? null,
          utr: settledByTds ? null : e.utr,
          settledByTds,
          paidAt: e.paidAt?.toISOString() ?? null,
          failureReason: e.failureReason,
          attemptedAt: e.attemptedAt?.toISOString() ?? null,
          cancelledAt: e.cancelledAt?.toISOString() ?? null,
          cancelReason: e.cancelReason,
          heldByReversal: held,
          /** Quick hint for the screen; the server re-checks everything on preview / apply. */
          cancelKind: held ? null : st === 'PENDING' && e.downloadId == null ? 'UNPAID' : st === 'FAILED' ? 'FAILED' : null,
        };
      }),
      pagination: { page, pageSize, total, pages },
    };
  }

  // ─── Cancellation history of an upload (audit rows) ─────────────────────────────────────────────
  async listCancellations(user: JwtPayload, batchId: string) {
    const batch = await this.prisma.creditBatch.findFirst({ where: { id: batchId, clientId: user.clientId }, select: { id: true } });
    if (!batch) throw new NotFoundException('Batch not found');
    const rows = await this.prisma.auditLog.findMany({
      where: { entityType: CANCELLATION_AUDIT_ENTITY, entityId: batchId, action: 'UPDATE' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, createdAt: true, actorId: true, actor: { select: { name: true } }, metadata: true },
    });
    return rows.map((r) => {
      const md = (r.metadata ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        at: r.createdAt.toISOString(),
        by: r.actor?.name ?? r.actorId,
        cancellationId: md.cancellationId ?? null,
        source: md.source ?? null,
        reason: md.reason ?? null,
        count: md.count ?? 0,
        amountPaise: md.amountPaise ?? 0,
        invoicesVoided: md.invoicesVoided ?? [],
        file: md.file ?? null,
      };
    });
  }

  // ─── On-screen preview (no write) ───────────────────────────────────────────────────────────────
  async preview(user: JwtPayload, dto: CancelPreviewDto) {
    assertGifsyAssumed(user);
    const status = KIND_STATUS[dto.kind];
    let items: CancelItem[];
    if (dto.entryIds && dto.entryIds.length > 0) {
      const rows = await this.prisma.creditPayoutEntry.findMany({
        where: { clientId: user.clientId, id: { in: dto.entryIds } },
        select: { id: true, status: true, amountPaise: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      // What the admin will confirm = what the row is NOW; a wrong-kind / missing row is listed as refused.
      items = dto.entryIds.map((id) => ({
        id,
        expectedStatus: status,
        expectedAmountPaise: byId.get(id)?.amountPaise ?? 0n,
      }));
    } else if (dto.batchId) {
      const rows = await this.prisma.creditPayoutEntry.findMany({
        where: {
          clientId: user.clientId,
          batchId: dto.batchId,
          ...(dto.fieldId ? { fieldId: dto.fieldId } : {}),
          status,
          ...(status === 'PENDING' ? { downloadId: null } : {}),
        },
        select: { id: true, amountPaise: true },
        orderBy: { id: 'asc' },
        take: MAX_CANCEL_ROWS + 1,
      });
      if (rows.length > MAX_CANCEL_ROWS) {
        throw new BadRequestException(`More than ${MAX_CANCEL_ROWS.toLocaleString('en-IN')} rows — use the upload file and split it.`);
      }
      items = rows.map((r) => ({ id: r.id, expectedStatus: status, expectedAmountPaise: r.amountPaise }));
    } else {
      throw new BadRequestException('Choose the rows to cancel, or an upload.');
    }
    const ev = await evaluateCancellation(this.prisma, user.clientId, items);
    return { kind: dto.kind, ...ev };
  }

  // ─── On-screen apply ────────────────────────────────────────────────────────────────────────────
  async cancel(user: JwtPayload, dto: CancelPayoutsDto) {
    assertGifsyAssumed(user);
    const reason = normaliseReason(dto.reason);
    const items: CancelItem[] = dto.items.map((i) => ({
      id: i.id,
      expectedStatus: i.expectedStatus,
      expectedAmountPaise: BigInt(i.expectedAmountPaise),
    }));
    return this.runAudited(user, { source: 'SCREEN', kind: dto.kind, reason, count: items.length }, () =>
      this.prisma.$transaction(
        (tx) => applyCancellation(tx, { clientId: user.clientId, actorId: user.sub, reason, items, source: 'SCREEN', kind: dto.kind }),
        { timeout: 180_000, maxWait: 20_000 },
      ),
    );
  }

  // ─── File: template ─────────────────────────────────────────────────────────────────────────────
  async template(user: JwtPayload, q: CancelTemplateQueryDto): Promise<{ buffer: Buffer; filename: string }> {
    assertGifsyAssumed(user);
    const want = q.status ?? 'ALL';
    const statusWhere: Prisma.CreditPayoutEntryWhereInput[] = [];
    if (want !== 'FAILED') statusWhere.push({ status: 'PENDING', downloadId: null });
    if (want !== 'PENDING') statusWhere.push({ status: 'FAILED' });
    const where: Prisma.CreditPayoutEntryWhereInput = { clientId: user.clientId, OR: statusWhere };
    if (q.batchId) where.batchId = q.batchId;
    if (q.fieldId) where.fieldId = q.fieldId;
    if (q.period) where.period = q.period;
    const rows = await this.prisma.creditPayoutEntry.findMany({
      where,
      orderBy: [{ period: 'asc' }, { outletId: 'asc' }, { id: 'asc' }],
      take: MAX_CANCEL_ROWS + 1,
      select: {
        id: true, batchId: true, outletId: true, outletName: true, fieldId: true, fieldName: true, period: true, amountPaise: true,
        status: true, failureReason: true, attemptedAt: true, autoInvoiceId: true,
        batch: { select: { batchCode: true } }, download: { select: { downloadCode: true } },
      },
    });
    if (rows.length > MAX_CANCEL_ROWS) {
      throw new BadRequestException(`More than ${MAX_CANCEL_ROWS.toLocaleString('en-IN')} rows match — narrow the filter (one upload or one month).`);
    }
    const views: CancelRowView[] = rows.map((e) => ({
      entryId: e.id,
      batchId: e.batchId,
      batchCode: e.batch?.batchCode ?? '',
      outletId: e.outletId,
      outletName: e.outletName,
      fieldId: e.fieldId,
      fieldName: e.fieldName,
      period: e.period,
      amountPaise: Number(e.amountPaise),
      status: String(e.status),
      kind: kindOfStatus(String(e.status)),
      downloadCode: e.download?.downloadCode ?? null,
      failureReason: e.failureReason ?? null,
      attemptedAt: e.attemptedAt?.toISOString() ?? null,
      autoInvoiceId: e.autoInvoiceId ?? null,
    }));
    const scope = [
      want === 'PENDING' ? 'unpaid rows' : want === 'FAILED' ? 'failed rows' : 'unpaid and failed rows',
      q.batchId ? `of upload ${views[0]?.batchCode ?? q.batchId}` : 'of this client',
      q.fieldId ? `(field ${views[0]?.fieldName ?? q.fieldId})` : '',
      q.period ? `for ${q.period}` : '',
    ].filter(Boolean).join(' ');
    return {
      buffer: buildCancelTemplate(views, scope),
      filename: `cancel-payouts-${user.clientId}-${new Date().toISOString().slice(0, 10)}.xlsx`,
    };
  }

  // ─── File: upload → preview, or apply ───────────────────────────────────────────────────────────
  async uploadFile(
    user: JwtPayload,
    file: Express.Multer.File | undefined,
    body: { reason?: string; apply?: string; acknowledgedRowNums?: string },
  ) {
    assertGifsyAssumed(user);
    if (!file) throw new BadRequestException('No file uploaded');
    const fileReason = (body?.reason ?? '').trim() || null;
    const plan = await this.planFile(user, file, fileReason);
    if (body?.apply !== 'true') return { applied: false, ...plan.preview };

    const reasonForAudit = fileReason ?? 'Cancelled by file (per-row reasons)';
    // Every refusal of an apply — incl. the checks below — leaves an audit row.
    return this.runAudited(user, { source: 'FILE', kind: null, reason: reasonForAudit, count: plan.items.length }, () =>
      this.applyFile(user, file, body, fileReason, plan),
    );
  }

  private async applyFile(
    user: JwtPayload,
    file: Express.Multer.File,
    body: { acknowledgedRowNums?: string },
    fileReason: string | null,
    plan: Awaited<ReturnType<PayoutCancelService['planFile']>>,
  ) {
    if (plan.preview.headerError) throw new BadRequestException(plan.preview.headerError);
    if (plan.items.length === 0) throw new BadRequestException('No row in the file can be cancelled — nothing to apply.');
    // Every row that cannot be cancelled must be explicitly acknowledged (never a silent skip).
    let acked: number[] = [];
    try {
      const raw = body?.acknowledgedRowNums ? JSON.parse(body.acknowledgedRowNums) : [];
      acked = Array.isArray(raw) ? raw.map((n) => Number(n)).filter((n) => Number.isInteger(n)) : [];
    } catch {
      throw new BadRequestException('acknowledgedRowNums must be a JSON list of row numbers.');
    }
    const ackSet = new Set(acked);
    const unacked = plan.preview.blocked.filter((b) => !ackSet.has(b.rowNum));
    if (unacked.length > 0) {
      throw new ConflictException({
        message:
          `Nothing was cancelled — ${unacked.length} row${unacked.length === 1 ? '' : 's'} in the file can't be cancelled and ${unacked.length === 1 ? 'was' : 'were'} not acknowledged ` +
          '(the file or the payouts changed since the preview). Review the list and confirm again.',
        details: { blocked: unacked },
      });
    }
    const reason = fileReason ?? 'Cancelled by file (per-row reasons)';
    // Keep the uploaded file (like other uploads) — its key goes into the audit row.
    let key: string | null = null;
    try {
      key = this.storage.generateKey(`payout-cancellations/${user.clientId}`, file.originalname || 'cancel-payouts.xlsx');
      await this.storage.uploadFile(file.buffer, key, XLSX_MIME);
    } catch (e) {
      this.logger.error(`cancel file store failed: ${(e as Error)?.message}`);
      throw new ConflictException('The file could not be stored, so nothing was cancelled — try again.');
    }
    try {
      return {
        applied: true,
        ...(await this.prisma.$transaction(
          (tx) =>
            applyCancellation(tx, {
              clientId: user.clientId,
              actorId: user.sub,
              reason,
              items: plan.items,
              source: 'FILE',
              file: {
                key,
                name: file.originalname || 'cancel-payouts.xlsx',
                acknowledgedBlocked: plan.preview.blocked.map((b) => ({
                  entryId: b.entryId,
                  code: b.code as CancelBlock['code'],
                  reason: `row ${b.rowNum}: ${b.reason}`,
                  row: null,
                })),
              },
            }),
          { timeout: 180_000, maxWait: 20_000 },
        )),
        notCancelled: plan.preview.blocked,
      };
    } catch (e) {
      if (key) await this.storage.deleteFile(key).catch(() => undefined);
      throw e;
    }
  }

  /** Parse + evaluate a file (no write): what will be cancelled, and every row that can't be (with the row number). */
  private async planFile(user: JwtPayload, file: Express.Multer.File, fileReason: string | null) {
    const parsed = parseCancelFile(file.buffer, fileReason);
    const blocked: FileBlockedRow[] = parsed.problems.map((p: FileProblem) => ({ ...p, code: 'BAD_ROW' }));
    // Duplicates in the file: the first occurrence stands, later ones are listed.
    const first = new Map<string, ParsedCancelRow>();
    const unique: ParsedCancelRow[] = [];
    for (const r of parsed.rows) {
      const prev = first.get(r.entryId);
      if (prev) {
        blocked.push({ rowNum: r.rowNum, entryId: r.entryId, outletId: r.outletId, reason: `${cancelBlockText('DUPLICATE')} (same as row ${prev.rowNum})`, code: 'DUPLICATE' });
        continue;
      }
      first.set(r.entryId, r);
      unique.push(r);
    }
    if (unique.length > MAX_CANCEL_ROWS) {
      throw new BadRequestException(`At most ${MAX_CANCEL_ROWS.toLocaleString('en-IN')} rows can be cancelled in one file — split it.`);
    }
    const items: CancelItem[] = unique.map((r) => ({ id: r.entryId, expectedStatus: r.expectedStatus, expectedAmountPaise: r.expectedAmountPaise, reason: r.reason }));
    const ev = parsed.headerError ? null : await evaluateCancellation(this.prisma, user.clientId, items);
    const rowOf = new Map(unique.map((r) => [r.entryId, r]));
    for (const b of ev?.blocked ?? []) {
      const r = rowOf.get(b.entryId);
      blocked.push({ rowNum: r?.rowNum ?? 0, entryId: b.entryId, outletId: b.row?.outletId ?? r?.outletId ?? '', reason: b.reason, code: b.code });
    }
    blocked.sort((a, b) => a.rowNum - b.rowNum);
    const okIds = new Set((ev?.ok ?? []).map((o) => o.entryId));
    return {
      items: items.filter((i) => okIds.has(i.id)),
      preview: {
        fileName: file.originalname || null,
        headerError: parsed.headerError,
        notMarked: parsed.notMarked,
        ok: (ev?.ok ?? []).map((o) => ({ ...o, rowNum: rowOf.get(o.entryId)?.rowNum ?? 0, reason: rowOf.get(o.entryId)?.reason ?? '' })),
        blocked,
        invoicesToVoid: ev?.invoicesToVoid ?? [],
        totals: ev?.totals ?? { unpaid: { count: 0, paise: 0 }, failed: { count: 0, paise: 0 }, all: { count: 0, paise: 0 } },
        canApply: !parsed.headerError && (ev?.ok.length ?? 0) > 0,
      },
    };
  }

  /** Run an apply; a refusal leaves an audit row too (after the transaction rolled back). Best effort. */
  private async runAudited<T>(
    user: JwtPayload,
    ctx: { source: 'SCREEN' | 'FILE'; kind: CancelKind | null; reason: string; count: number; fileKey?: string | null },
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HttpException) {
        const body = e.getResponse();
        const message = typeof body === 'string' ? body : String((body as { message?: unknown }).message ?? e.message);
        const details = typeof body === 'object' && body ? (body as { details?: unknown }).details : undefined;
        await this.prisma.auditLog
          .create({
            data: {
              action: 'REJECT',
              entityType: CANCELLATION_AUDIT_ENTITY,
              entityId: `refused:${randomUUID()}`,
              actorId: user.sub,
              metadata: toJson({ event: 'PAYOUT_CANCEL_REFUSED', clientId: user.clientId, ...ctx, status: e.getStatus(), message, details: details ?? null }),
            },
          })
          .catch((err: unknown) => this.logger.warn(`cancel refusal audit failed: ${(err as Error)?.message}`));
      }
      throw e;
    }
  }
}

/** Plain words for a cancelled total (used by the controller's response message). */
export function cancelledMessage(count: number, paise: number): string {
  return `${count} payout${count === 1 ? '' : 's'} cancelled · ${formatINR(paise)}`;
}
