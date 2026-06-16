import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  CreateBatchDto,
  CreateFieldDto,
  CreatePayoutDownloadDto,
  CreateReversalDto,
  FieldAction,
  ListFieldsQueryDto,
  ListPayoutDownloadsQueryDto,
  ListReversalsQueryDto,
  PatchFieldDto,
  PatchReversalDto,
  PayoutGroupType,
  ReversalAction,
} from './dto/credits.dto';
import {
  generatePayoutFileBuffer,
  parseUtrUpload,
  PayoutBatch,
  PayoutBatchRow,
} from './credits.helpers';

/**
 * Awards & Credits (§12a) — ported from platform/src/app/api/admin/credits/*
 * onto /v1/admin/credits. This is the REAL parameter-upload credit model:
 * CreditBatch (uploaded rows) → confirm → CreditPayoutEntry → payout download
 * (bank file) → UTR upload (mark paid) → reversals (maker-checker).
 *
 * Every query is tenant-scoped by `clientId` (from the session-bound JWT). The
 * source role gates (CLIENT_ADMIN + GIFSY_ADMIN, or GIFSY_ADMIN-only) are
 * enforced by @Roles on the controller and the RBAC permission keys by
 * @RequirePermission. The pure parser/generator logic lives in
 * credits.helpers.ts; notifications go through the foundation NotificationsService
 * (the source's MSG91 WhatsApp/email helpers become QUEUED notification rows).
 */
@Injectable()
export class CreditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ─── Code generators ───────────────────────────────────────────────────────

  /** Batch code: CB-YYYY-MM-NNN (per client + period). */
  private async generateBatchCode(clientId: string, period: string): Promise<string> {
    const prefix = `CB-${period}`;
    const count = await this.prisma.creditBatch.count({
      where: { clientId, batchCode: { startsWith: prefix } },
    });
    return `${prefix}-${String(count + 1).padStart(3, '0')}`;
  }

  /** Download code: PD-YYYY-MM-NNN (per client + period). */
  private async generateDownloadCode(clientId: string, period: string): Promise<string> {
    const prefix = `PD-${period}`;
    const count = await this.prisma.creditPayoutDownload.count({
      where: { clientId, downloadCode: { startsWith: prefix } },
    });
    return `${prefix}-${String(count + 1).padStart(3, '0')}`;
  }

  /** Fire-and-forget enqueue; never fails the request (mirrors the source). */
  private async notify(params: Parameters<NotificationsService['enqueue']>[0]): Promise<void> {
    await this.notifications.enqueue(params).catch(() => {
      // Non-critical: notification failures must not fail the request.
    });
  }

  // ─── GET /v1/admin/credits/batches ─────────────────────────────────────────
  async listBatches(user: JwtPayload) {
    return this.prisma.creditBatch.findMany({
      where: { clientId: user.clientId },
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true,
        batchCode: true,
        period: true,
        status: true,
        uploadedBy: true,
        uploadedAt: true,
        confirmedBy: true,
        confirmedAt: true,
        totalOutlets: true,
        totalPoints: true,
        totalPayoutInr: true,
      },
    });
  }

  // ─── POST /v1/admin/credits/batches ────────────────────────────────────────
  async createBatch(user: JwtPayload, dto: CreateBatchDto) {
    const batchCode = await this.generateBatchCode(user.clientId, dto.period);

    const batch = await this.prisma.creditBatch.create({
      data: {
        clientId: user.clientId,
        batchCode,
        period: dto.period,
        uploadedBy: user.sub ?? '',
        totalOutlets: dto.totalOutlets,
        totalPoints: dto.totalPoints,
        totalPayoutInr: dto.totalPayoutInr,
        rows: dto.rows as unknown as Prisma.InputJsonValue,
      },
    });

    return batch;
  }

  // ─── GET /v1/admin/credits/batches/:id ─────────────────────────────────────
  async getBatch(user: JwtPayload, id: string) {
    const batch = await this.prisma.creditBatch.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!batch) throw new NotFoundException('Batch not found');
    return batch;
  }

  // ─── POST /v1/admin/credits/batches/:id/confirm ────────────────────────────
  async confirmBatch(user: JwtPayload, id: string) {
    const batch = await this.prisma.creditBatch.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!batch) throw new NotFoundException('Batch not found');
    if (batch.status !== 'PENDING_CONFIRM') {
      throw new BadRequestException(`Batch is already ${batch.status}`);
    }

    // Parse rows from JSON and create CreditPayoutEntry for each PAYOUT-type OK row.
    const rows = batch.rows as unknown as {
      outletId: string;
      outletName: string;
      fieldId: string;
      fieldName: string;
      amount: number;
      narration: string;
      awardType: string;
      status: string;
    }[];

    const payoutRows = rows.filter((r) => r.awardType === 'PAYOUT' && r.status === 'OK');

    const updated = await this.prisma.$transaction(async (tx) => {
      const confirmed = await tx.creditBatch.update({
        where: { id },
        data: {
          status: 'CONFIRMED',
          confirmedBy: user.sub,
          confirmedAt: new Date(),
        },
      });

      if (payoutRows.length > 0) {
        await tx.creditPayoutEntry.createMany({
          data: payoutRows.map((r) => ({
            clientId: user.clientId,
            batchId: id,
            outletId: r.outletId,
            outletName: r.outletName,
            fieldId: r.fieldId,
            fieldName: r.fieldName,
            period: batch.period,
            amountInr: r.amount,
            narration: r.narration ?? '',
          })),
        });
      }

      return confirmed;
    });

    // Notify Gifsy team (fire-and-forget; don't block confirm on failure).
    await this.notify({
      userId: batch.uploadedBy,
      channel: 'EMAIL',
      recipientEmail: 'ops@gifsy.in',
      subject: `[Gifsy] New Batch Confirmed — ${user.clientId} — ${batch.period}`,
      body: `New batch ${id} confirmed for ${user.clientId} (period ${batch.period}).`,
      variables: {
        event: 'CREDITS_NEW_BATCH_CONFIRMED',
        tenantName: user.clientId,
        batchId: id,
        period: batch.period,
        totalOutlets: Number(batch.totalOutlets),
        totalPoints: Number(batch.totalPoints),
        totalPayoutInr: Number(batch.totalPayoutInr),
        uploadedBy: batch.uploadedBy,
        recipientEmails: ['ops@gifsy.in'],
      },
    });

    return { batch: updated, payoutEntriesCreated: payoutRows.length };
  }

  // ─── GET /v1/admin/credits/batches/:id/reversals ───────────────────────────
  async listBatchReversals(user: JwtPayload, id: string) {
    const batch = await this.prisma.creditBatch.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!batch) throw new NotFoundException('Batch not found');

    return this.prisma.creditReversal.findMany({
      where: { batchId: id, clientId: user.clientId },
      orderBy: { requestedAt: 'desc' },
    });
  }

  // ─── POST /v1/admin/credits/batches/:id/reversals ──────────────────────────
  // Maker-checker: client requests, Gifsy approves.
  async createReversal(user: JwtPayload, id: string, dto: CreateReversalDto) {
    const batch = await this.prisma.creditBatch.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!batch) throw new NotFoundException('Batch not found');
    if (batch.status === 'PENDING_CONFIRM') {
      throw new BadRequestException('Cannot reverse a batch that has not been confirmed');
    }

    if (dto.requestedAmount > dto.originalAmount) {
      throw new BadRequestException(
        'Requested reversal amount cannot exceed original amount',
      );
    }

    // Block a duplicate pending reversal for the same outlet+field in this batch.
    const existingPending = await this.prisma.creditReversal.findFirst({
      where: {
        batchId: id,
        clientId: user.clientId,
        outletId: dto.outletId,
        fieldId: dto.fieldId,
        status: 'PENDING_GIFSY',
      },
    });
    if (existingPending) {
      throw new BadRequestException(
        'A pending reversal already exists for this outlet and field in this batch',
      );
    }

    return this.prisma.creditReversal.create({
      data: {
        clientId: user.clientId,
        batchId: id,
        outletId: dto.outletId,
        outletName: dto.outletName,
        fieldId: dto.fieldId,
        fieldName: dto.fieldName,
        period: batch.period,
        awardType: dto.awardType,
        originalAmount: dto.originalAmount,
        requestedAmount: dto.requestedAmount,
        requestedBy: user.sub,
      },
    });
  }

  // ─── GET /v1/admin/credits/eligible-outlets ────────────────────────────────
  async eligibleOutlets(user: JwtPayload) {
    const outlets = await this.prisma.outlet.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        partner: { clientId: user.clientId, isActive: true },
      },
      include: {
        outletType: { select: { code: true } },
      },
      orderBy: { outletCode: 'asc' },
    });

    return outlets.map((o) => ({
      id: o.outletCode,
      name: o.name,
      type: o.outletType.code,
      phone: o.phone ?? undefined,
    }));
  }

  // ─── GET /v1/admin/credits/fields ──────────────────────────────────────────
  async listFields(user: JwtPayload, q: ListFieldsQueryDto) {
    const activeOnly = q.active === 'true';
    return this.prisma.creditField.findMany({
      where: {
        clientId: user.clientId,
        ...(activeOnly ? { isActive: true } : {}),
      },
      orderBy: { order: 'asc' },
    });
  }

  // ─── POST /v1/admin/credits/fields ─────────────────────────────────────────
  async createField(user: JwtPayload, dto: CreateFieldDto) {
    // Duplicate-name guard (per client).
    const existing = await this.prisma.creditField.findFirst({
      where: { clientId: user.clientId, name: dto.name },
    });
    if (existing) throw new BadRequestException(`A field named "${dto.name}" already exists.`);

    // Next order value.
    const maxOrderField = await this.prisma.creditField.findFirst({
      where: { clientId: user.clientId },
      orderBy: { order: 'desc' },
    });
    const nextOrder = (maxOrderField?.order ?? 0) + 1;

    return this.prisma.creditField.create({
      data: {
        clientId: user.clientId,
        name: dto.name,
        isSeparatePayout: dto.isSeparatePayout,
        outletTypeAwards: dto.outletTypeAwards as unknown as Prisma.InputJsonValue,
        order: nextOrder,
      },
    });
  }

  // ─── PATCH /v1/admin/credits/fields/:id ────────────────────────────────────
  async patchField(user: JwtPayload, id: string, dto: PatchFieldDto) {
    const field = await this.prisma.creditField.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!field) throw new NotFoundException('Field not found');

    return this.prisma.creditField.update({
      where: { id },
      data: { isActive: dto.action === FieldAction.activate },
    });
  }

  // ─── GET /v1/admin/credits/payout-downloads ────────────────────────────────
  async listPayoutDownloads(user: JwtPayload, q: ListPayoutDownloadsQueryDto) {
    return this.prisma.creditPayoutDownload.findMany({
      where: {
        clientId: user.clientId,
        ...(q.period ? { period: q.period } : {}),
      },
      orderBy: { downloadedAt: 'desc' },
      include: {
        _count: { select: { entries: true } },
      },
    });
  }

  // ─── POST /v1/admin/credits/payout-downloads ───────────────────────────────
  // Builds the bank payout file, records the download, and marks entries
  // PROCESSING. Returns the xlsx buffer + identifiers; the controller streams it.
  async createPayoutDownload(
    user: JwtPayload,
    dto: CreatePayoutDownloadDto,
  ): Promise<{ buffer: Buffer; downloadCode: string; downloadId: string }> {
    const { period, groupType, fieldId, fieldName } = dto;

    // Active separate fields (used to exclude from STANDARD).
    const separateFields = await this.prisma.creditField.findMany({
      where: { clientId: user.clientId, isSeparatePayout: true, isActive: true },
      select: { id: true },
    });
    const separateFieldIds = new Set(separateFields.map((f) => f.id));

    const baseWhere = {
      clientId: user.clientId,
      period,
      status: 'PENDING' as const,
    };

    let entryWhere: Prisma.CreditPayoutEntryWhereInput = baseWhere;
    if (groupType === PayoutGroupType.SEPARATE && fieldId) {
      entryWhere = { ...baseWhere, fieldId };
    } else if (groupType === PayoutGroupType.STANDARD) {
      entryWhere = {
        ...baseWhere,
        NOT:
          separateFieldIds.size > 0
            ? { fieldId: { in: [...separateFieldIds] } }
            : undefined,
      };
    }

    const entries = await this.prisma.creditPayoutEntry.findMany({
      where: entryWhere,
      include: { batch: { select: { batchCode: true } } },
    });

    if (entries.length === 0) {
      throw new BadRequestException(
        `No PENDING payout entries found for period ${period}${
          fieldId ? ` / field ${fieldId}` : ''
        }.`,
      );
    }

    // Group by outlet, sum amounts.
    const outletMap = new Map<
      string,
      { outletName: string; amount: number; entryIds: string[] }
    >();
    for (const e of entries) {
      const cur = outletMap.get(e.outletId);
      if (cur) {
        cur.amount += Number(e.amountInr);
        cur.entryIds.push(e.id);
      } else {
        outletMap.set(e.outletId, {
          outletName: e.outletName,
          amount: Number(e.amountInr),
          entryIds: [e.id],
        });
      }
    }

    // Fetch bank details from ChannelPartner via Outlet.outletCode (tenant-scoped).
    const outletCodes = [...outletMap.keys()];
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, outletCode: { in: outletCodes } },
      include: {
        partner: {
          select: {
            bankName: true,
            bankAccountNumber: true,
            bankAccountHolder: true,
            ifscCode: true,
            upiId: true,
          },
        },
      },
    });
    const outletDbMap = new Map(outlets.map((o) => [o.outletCode, o]));

    const bankSnapshots = outletCodes.map((code) => {
      const o = outletDbMap.get(code);
      return {
        outletId: code,
        bankName: o?.partner?.bankName ?? '',
        accountNumber: o?.partner?.bankAccountNumber ?? '',
        ifscCode: o?.partner?.ifscCode ?? '',
        upiId: o?.partner?.upiId ?? '',
        snapshotAt: new Date().toISOString(),
      };
    });
    const snapshotMap = new Map(bankSnapshots.map((s) => [s.outletId, s]));

    const rows: PayoutBatchRow[] = outletCodes.map((code) => {
      const info = outletMap.get(code)!;
      const o = outletDbMap.get(code);
      const snapshot = snapshotMap.get(code)!;
      return {
        outletId: code,
        outletName: info.outletName,
        phone: o?.phone ?? '',
        bankName: snapshot.bankName,
        accountNumber: snapshot.accountNumber,
        ifscCode: snapshot.ifscCode,
        upiId: snapshot.upiId,
        kycStatus: 'APPROVED',
        amount: info.amount,
        isDeactivated: !(o?.isActive ?? true),
        utrStatus: 'PENDING',
        entryIds: info.entryIds,
      };
    });

    const downloadCode = await this.generateDownloadCode(user.clientId, period);
    const totalAmountInr = rows.reduce((s, r) => s + r.amount, 0);

    const payoutBatch: PayoutBatch = {
      id: downloadCode,
      creditBatchId: 'MULTI',
      period,
      groupType,
      ...(fieldId ? { fieldId } : {}),
      ...(fieldName ? { fieldName } : {}),
      status: 'OPEN',
      downloadedAt: new Date().toISOString(),
      downloadedBy: user.sub,
      totalAmount: totalAmountInr,
      bankSnapshots,
      rows,
    };

    // Create download record + mark entries with downloadId.
    const download = await this.prisma.$transaction(async (tx) => {
      const rec = await tx.creditPayoutDownload.create({
        data: {
          clientId: user.clientId,
          downloadCode,
          period,
          groupType,
          fieldId: fieldId ?? null,
          fieldName: fieldName ?? null,
          downloadedBy: user.sub,
          totalAmountInr,
          bankSnapshots: bankSnapshots as unknown as Prisma.InputJsonValue,
        },
      });

      await tx.creditPayoutEntry.updateMany({
        where: { id: { in: entries.map((e) => e.id) } },
        data: { downloadId: rec.id, status: 'PROCESSING' },
      });

      return rec;
    });

    const buffer = generatePayoutFileBuffer(payoutBatch);

    return { buffer, downloadCode, downloadId: download.id };
  }

  // ─── POST /v1/admin/credits/payout-downloads/:id/utr ───────────────────────
  // [id] is the CreditPayoutDownload id. Parses the UTR upload; previews unless
  // ?apply=true, then applies PAID/FAILED to entries and notifies paid outlets.
  async uploadUtr(user: JwtPayload, id: string, file: Express.Multer.File, apply: boolean) {
    const download = await this.prisma.creditPayoutDownload.findFirst({
      where: { id, clientId: user.clientId },
      include: {
        entries: {
          select: { id: true, outletId: true, status: true, utr: true, amountInr: true },
        },
      },
    });
    if (!download) throw new NotFoundException('Payout download not found');

    if (!file) throw new BadRequestException('No file uploaded');

    const ab = file.buffer.buffer.slice(
      file.buffer.byteOffset,
      file.buffer.byteOffset + file.buffer.byteLength,
    );

    // Injectable batch rows from DB.
    const batchRows = download.entries.map((e) => ({
      outletId: e.outletId,
      utrStatus: (e.status === 'PAID'
        ? 'PAID'
        : e.status === 'FAILED'
          ? 'FAILED'
          : 'PENDING') as 'PENDING' | 'PAID' | 'FAILED',
      utr: e.utr ?? undefined,
    }));

    // Known UTRs across all downloads for this client (dup detection).
    const usedUtrs = await this.prisma.creditPayoutEntry.findMany({
      where: { clientId: user.clientId, utr: { not: null } },
      select: { utr: true },
    });
    const knownUtrs = new Set<string>(
      usedUtrs.filter((e) => e.utr != null).map((e) => e.utr!.toUpperCase()),
    );

    const parseResult = parseUtrUpload(ab, {
      downloadCode: download.downloadCode,
      batchRows,
      knownUtrs,
    });

    // Preview unless apply=true.
    if (!apply) {
      return { parseResult, downloadCode: download.downloadCode };
    }

    if (!parseResult.canProceed) {
      throw new BadRequestException('Cannot apply — parse result has errors or no valid rows');
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const row of parseResult.rows) {
        if (row.status !== 'OK') continue;

        const entry = download.entries.find((e) => e.outletId === row.outletId);
        if (!entry) continue;

        await tx.creditPayoutEntry.update({
          where: { id: entry.id },
          data: {
            status: row.success ? 'PAID' : 'FAILED',
            utr: row.success ? row.utr || null : null,
            paidAt: row.success ? now : null,
          },
        });
      }

      const stillPending = download.entries.some((e) => {
        const row = parseResult.rows.find((r) => r.outletId === e.outletId);
        return !row || row.status === 'SKIP';
      });
      await tx.creditPayoutDownload.update({
        where: { id: download.id },
        data: { status: stillPending ? 'PARTIALLY_PAID' : 'PAID' },
      });
    });

    // Notify paid outlets (fire-and-forget; needs phone from outlet).
    const paidOutletIds = parseResult.rows
      .filter((r) => r.status === 'OK' && r.success)
      .map((r) => r.outletId);

    if (paidOutletIds.length > 0) {
      const outlets = await this.prisma.outlet.findMany({
        where: { clientId: user.clientId, outletCode: { in: paidOutletIds } },
        select: { outletCode: true, name: true, phone: true, partnerId: true },
      });
      const phoneMap = new Map(outlets.map((o) => [o.outletCode, o]));
      for (const row of parseResult.rows) {
        if (row.status !== 'OK' || !row.success) continue;
        const entry = download.entries.find((e) => e.outletId === row.outletId);
        const outlet = phoneMap.get(row.outletId);
        if (!entry || !outlet?.phone) continue;
        await this.notify({
          userId: outlet.partnerId ?? download.downloadedBy,
          channel: 'WHATSAPP',
          recipientPhone: outlet.phone,
          body: `Your payout of ₹${Number(entry.amountInr)} has been confirmed. UTR: ${
            row.utr ?? ''
          }.`,
          variables: {
            event: 'CREDITS_PAYOUT_CONFIRMED',
            outletName: outlet.name,
            amountInr: Number(entry.amountInr),
            utr: row.utr ?? '',
            period: download.period,
          },
        });
      }
    }

    return {
      applied: true,
      paidCount: parseResult.summary.paidCount,
      failedCount: parseResult.summary.failedCount,
      skippedCount: parseResult.summary.skipped,
    };
  }

  // ─── GET /v1/admin/credits/reversals ───────────────────────────────────────
  async listReversals(user: JwtPayload, q: ListReversalsQueryDto) {
    const where: Prisma.CreditReversalWhereInput = { clientId: user.clientId };
    if (q.status) where.status = q.status as Prisma.CreditReversalWhereInput['status'];
    if (q.period) where.period = q.period;

    return this.prisma.creditReversal.findMany({
      where,
      orderBy: { requestedAt: 'desc' },
    });
  }

  // ─── PATCH /v1/admin/credits/reversals/:id ─────────────────────────────────
  async patchReversal(user: JwtPayload, id: string, dto: PatchReversalDto) {
    const reversal = await this.prisma.creditReversal.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!reversal) throw new NotFoundException('Reversal not found');
    if (reversal.status !== 'PENDING_GIFSY') {
      throw new BadRequestException(`Reversal is already ${reversal.status}`);
    }

    const { action, approvedAmount, remarks } = dto;

    if (action === ReversalAction.approve && approvedAmount !== undefined) {
      if (approvedAmount > Number(reversal.requestedAmount)) {
        throw new BadRequestException('Approved amount cannot exceed requested amount');
      }
    }

    const newStatus =
      action === ReversalAction.reject
        ? 'REJECTED'
        : approvedAmount !== undefined && approvedAmount < Number(reversal.requestedAmount)
          ? 'PARTIAL'
          : 'APPROVED';

    return this.prisma.creditReversal.update({
      where: { id },
      data: {
        status: newStatus,
        approvedAmount:
          action === ReversalAction.approve
            ? (approvedAmount ?? Number(reversal.requestedAmount))
            : null,
        approvedBy: user.sub,
        approvedAt: new Date(),
        remarks: remarks ?? null,
      },
    });
  }
}
