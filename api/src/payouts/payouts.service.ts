import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { buildXlsx } from '../common/xlsx';
import {
  BatchDetailQueryDto,
  CreateBatchDto,
  ListBatchesQueryDto,
  ListTransactionsQueryDto,
  ReceiveFundDto,
  ReconciliationQueryDto,
} from './dto/payouts.dto';

/**
 * Credits & Payouts — ported from platform/src/app/api/payouts/* onto /v1.
 * Tenant-scoped by clientId (from the session-bound JWT). Payouts are offline:
 * a bank file / UTR flow with no payment gateway — preserved as-is. Read access
 * is GIFSY_ADMIN or MIS_USER; mutating actions (create batch, record receipt,
 * process batch) are GIFSY-only (enforced by @Roles on the controller; tenant
 * scope re-checked here). Business logic lives here; the controller is thin.
 */
@Injectable()
export class PayoutsService {
  // Source constants — TDS under section 194R.
  private static readonly TDS_RATE_DEFAULT = 0.1; // 10%
  private static readonly TDS_THRESHOLD_PAISE = 2000000; // ₹20,000

  constructor(private readonly prisma: PrismaService) {}

  /** GET /v1/payouts/transactions — paginated, filterable payout transactions. */
  async listTransactions(user: JwtPayload, q: ListTransactionsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.PayoutTransactionWhereInput = {
      batch: { clientId: user.clientId },
    };
    if (q.status) where.status = q.status;
    if (q.mode) where.payoutMode = q.mode;
    if (q.partnerId) where.partnerId = q.partnerId;
    if (q.dateFrom || q.dateTo) {
      where.createdAt = {};
      if (q.dateFrom) where.createdAt.gte = q.dateFrom;
      if (q.dateTo) where.createdAt.lte = q.dateTo;
    }

    const [transactions, total] = await Promise.all([
      this.prisma.payoutTransaction.findMany({
        where,
        include: {
          partner: { select: { id: true, businessName: true } },
          batch: { select: { id: true, batchCode: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.payoutTransaction.count({ where }),
    ]);

    return {
      transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /** GET /v1/payouts/fund — fund ledger summary (received / utilised / available). */
  async getFundSummary(user: JwtPayload) {
    const clientId = user.clientId;

    const latestEntry = await this.prisma.fundLedger.findFirst({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });

    const received = await this.prisma.fundReceipt.aggregate({
      where: { clientId },
      _sum: { amountPaise: true },
    });

    const utilisedByMode = await this.prisma.payoutTransaction.groupBy({
      by: ['payoutMode'],
      where: {
        batch: { clientId },
        status: { in: ['SUCCESS', 'INITIATED'] },
      },
      _sum: { amountPaise: true },
    });

    const pendingLiability = await this.prisma.payoutTransaction.aggregate({
      where: { batch: { clientId }, status: 'PENDING' },
      _sum: { amountPaise: true },
    });

    const utilised = utilisedByMode.reduce(
      (sum, m) => sum + (m._sum.amountPaise ?? 0),
      0,
    );
    const totalReceived = received._sum.amountPaise ?? 0;
    const closingBalance = latestEntry?.balancePaise ?? totalReceived - utilised;
    const pending = pendingLiability._sum.amountPaise ?? 0;

    return {
      totalReceivedPaise: totalReceived,
      totalReceived: totalReceived / 100,
      utilisedByMode: utilisedByMode.map((m) => ({
        mode: m.payoutMode,
        amountPaise: m._sum.amountPaise ?? 0,
        amount: (m._sum.amountPaise ?? 0) / 100,
      })),
      totalUtilisedPaise: utilised,
      totalUtilised: utilised / 100,
      closingBalancePaise: closingBalance,
      closingBalance: closingBalance / 100,
      pendingLiabilityPaise: pending,
      pendingLiability: pending / 100,
      availablePaise: Math.max(0, closingBalance - pending),
      available: Math.max(0, closingBalance - pending) / 100,
    };
  }

  /** POST /v1/payouts/fund/receive — record an offline fund receipt + ledger entry (GIFSY-only). */
  async receiveFund(user: JwtPayload, dto: ReceiveFundDto) {
    const clientId = user.clientId;
    const amountPaise = Math.round(dto.amount * 100);
    const paymentMode = dto.paymentMode ?? 'BANK_TRANSFER';

    const latestEntry = await this.prisma.fundLedger.findFirst({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
    const currentBalance = latestEntry?.balancePaise ?? 0;
    const newBalance = currentBalance + amountPaise;

    const result = await this.prisma.$transaction(async (tx) => {
      const receiptNumber = `FR-${Date.now()}`;
      const receipt = await tx.fundReceipt.create({
        data: {
          receiptNumber,
          amountPaise,
          receivedAt: dto.paymentDate,
          paymentMode,
          referenceNumber: dto.referenceNumber ?? null,
          bankName: dto.bankName ?? null,
          notes: dto.notes ?? null,
          createdByUserId: user.sub,
          clientId,
        },
      });

      const ledgerEntry = await tx.fundLedger.create({
        data: {
          ledgerType: 'RECEIPT',
          amountPaise,
          balancePaise: newBalance,
          referenceType: 'FUND_RECEIPT',
          referenceId: receipt.id,
          description:
            dto.notes ?? `Fund receipt. Ref: ${dto.referenceNumber ?? 'N/A'}`,
          clientId,
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'CREATE',
          entityType: 'FUND_RECEIPT',
          entityId: receipt.id,
          actorId: user.sub,
          metadata: {
            amountPaise,
            referenceNumber: dto.referenceNumber,
            newBalance,
          },
        },
      });

      return { receipt, ledgerEntry };
    });

    return {
      receiptId: result.receipt.id,
      amount: amountPaise / 100,
      newBalance: newBalance / 100,
      referenceNumber: dto.referenceNumber,
    };
  }

  /** GET /v1/payouts/batches — paginated payout batches with transaction counts. */
  async listBatches(user: JwtPayload, q: ListBatchesQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;
    const where: Prisma.PayoutBatchWhereInput = { clientId: user.clientId };

    const [batches, total] = await Promise.all([
      this.prisma.payoutBatch.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { transactions: true } } },
      }),
      this.prisma.payoutBatch.count({ where }),
    ]);

    return {
      batches,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /** POST /v1/payouts/batches — create a DRAFT batch (GIFSY-only). */
  async createBatch(user: JwtPayload, dto: CreateBatchDto) {
    const batchCode = `PB-${Date.now()}`;
    const batch = await this.prisma.payoutBatch.create({
      data: {
        batchCode,
        payoutMode: dto.payoutMode,
        status: 'DRAFT',
        notes: dto.notes ?? null,
        createdByUserId: user.sub,
        clientId: user.clientId,
      },
    });
    return { batch };
  }

  /** GET /v1/payouts/batches/:id — a batch + its paginated transactions. */
  async getBatch(user: JwtPayload, id: string, q: BatchDetailQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const skip = (page - 1) * limit;

    const batch = await this.prisma.payoutBatch.findFirst({
      where: { id, clientId: user.clientId },
      include: { _count: { select: { transactions: true } } },
    });
    if (!batch) throw new NotFoundException('Payout batch not found');

    const where: Prisma.PayoutTransactionWhereInput = {
      batchId: id,
      batch: { clientId: user.clientId },
    };

    const [transactions, total] = await Promise.all([
      this.prisma.payoutTransaction.findMany({
        where,
        include: { partner: { select: { id: true, businessName: true } } },
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.payoutTransaction.count({ where }),
    ]);

    return {
      batch,
      transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /**
   * POST /v1/payouts/batches/:id/process — run the offline disbursement pipeline
   * (validation → invoice log → TDS computation → fund check → flag for
   * disbursement) and finalise the batch status (GIFSY-only).
   */
  async processBatch(user: JwtPayload, id: string) {
    const clientId = user.clientId;

    const batch = await this.prisma.payoutBatch.findFirst({
      where: { id, clientId },
      include: { transactions: true },
    });
    if (!batch) throw new NotFoundException('Payout batch not found');
    if (batch.status === 'COMPLETED') {
      throw new BadRequestException('Batch already processed');
    }
    if (batch.status === 'PROCESSING') {
      throw new BadRequestException('Batch is currently being processed');
    }

    // Mark as processing.
    await this.prisma.payoutBatch.update({
      where: { id },
      data: { status: 'PROCESSING' },
    });

    const steps = {
      validation: { status: 'PENDING', count: 0, errors: [] as string[] },
      invoiceGeneration: { status: 'PENDING', count: 0 },
      tdsComputation: { status: 'PENDING', totalTds: 0 },
      fundCheck: { status: 'PENDING', available: 0, required: 0 },
      disbursement: { status: 'PENDING', flagged: 0 },
    };

    // Step 1: Validation.
    const transactions = await this.prisma.payoutTransaction.findMany({
      where: { batchId: id, status: 'PENDING' },
      include: { partner: true },
    });

    steps.validation.count = transactions.length;
    const validTransactions: typeof transactions = [];

    for (const tx of transactions) {
      const errors: string[] = [];
      if (!tx.partner?.panNumber) {
        errors.push(`No PAN for partner ${tx.partnerId}`);
      }
      if (!tx.amountPaise || tx.amountPaise <= 0) {
        errors.push(`Invalid amount for tx ${tx.id}`);
      }
      if (errors.length === 0) {
        validTransactions.push(tx);
      } else {
        steps.validation.errors.push(...errors);
      }
    }
    steps.validation.status =
      steps.validation.errors.length === 0 ? 'PASSED' : 'PASSED_WITH_WARNINGS';

    // Step 2: Invoice generation (log only — no invoiceNumber field on PayoutTransaction).
    steps.invoiceGeneration.count = validTransactions.length;
    steps.invoiceGeneration.status = 'COMPLETED';

    // Step 3: TDS computation.
    let totalTds = 0;
    for (const tx of validTransactions) {
      if (tx.amountPaise >= PayoutsService.TDS_THRESHOLD_PAISE) {
        const tdsAmount = Math.round(
          tx.amountPaise * PayoutsService.TDS_RATE_DEFAULT,
        );
        totalTds += tdsAmount;
        await this.prisma.tdsRecord.create({
          data: {
            payoutTransactionId: tx.id,
            partnerId: tx.partnerId,
            panNumber: tx.partner?.panNumber ?? null,
            tdsRate: PayoutsService.TDS_RATE_DEFAULT,
            tdsPaise: tdsAmount,
          },
        });
      }
    }
    steps.tdsComputation.totalTds = totalTds;
    steps.tdsComputation.status = 'COMPLETED';

    // Step 4: Fund check.
    const fundLedger = await this.prisma.fundLedger.findFirst({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
    const totalRequired =
      validTransactions.reduce((sum, tx) => sum + tx.amountPaise, 0) - totalTds;
    steps.fundCheck.available = fundLedger?.balancePaise ?? 0;
    steps.fundCheck.required = totalRequired;
    steps.fundCheck.status =
      (fundLedger?.balancePaise ?? 0) >= totalRequired ? 'PASSED' : 'FAILED';

    // Step 5: Flag for disbursement.
    let flagged = 0;
    if (steps.fundCheck.status === 'PASSED') {
      for (const tx of validTransactions) {
        await this.prisma.payoutTransaction.update({
          where: { id: tx.id },
          data: { status: 'INITIATED' },
        });
        flagged++;
      }
    }
    steps.disbursement.flagged = flagged;
    steps.disbursement.status = flagged > 0 ? 'FLAGGED' : 'SKIPPED';

    // Update batch status.
    const finalStatus =
      steps.fundCheck.status === 'PASSED' ? 'SUBMITTED' : 'FAILED';
    await this.prisma.payoutBatch.update({
      where: { id },
      data: { status: finalStatus, processedAt: new Date() },
    });

    await this.prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'PAYOUT_BATCH',
        entityId: id,
        actorId: user.sub,
        metadata: { steps, finalStatus },
      },
    });

    return { batchId: id, status: finalStatus, steps };
  }

  /**
   * GET /v1/payouts/reconciliation — build the reconciliation xlsx export and
   * return its bytes. The source route uploaded the workbook to S3 and returned a
   * signed URL; on the Nest side this is a direct file download — the controller
   * wraps the buffer in a StreamableFile. Columns/rows mirror the source exactly,
   * built via the in-repo xlsx helper (src/reports/reports.xlsx).
   */
  async buildReconciliationFile(user: JwtPayload, q: ReconciliationQueryDto) {
    const where: Prisma.PayoutTransactionWhereInput = {
      batch: { clientId: user.clientId },
    };
    if (q.batchId) where.batchId = q.batchId;

    const transactions = await this.prisma.payoutTransaction.findMany({
      where,
      include: {
        partner: { select: { businessName: true, panNumber: true } },
        tdsRecord: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const rows = transactions.map((t, i) => ({
      'S.No': i + 1,
      'Partner Name': t.partner?.businessName ?? '',
      PAN: t.partner?.panNumber ?? t.tdsRecord?.panNumber ?? 'N/A',
      'Gross Amount (₹)': (t.amountPaise / 100).toFixed(2),
      'TDS Amount (₹)': t.tdsRecord ? (t.tdsRecord.tdsPaise / 100).toFixed(2) : '0.00',
      'Net Amount (₹)': (t.netAmountPaise / 100).toFixed(2),
      Mode: t.payoutMode,
      Status: t.status,
      Date: t.createdAt.toISOString().split('T')[0],
    }));

    return {
      buffer: buildXlsx([{ name: 'Reconciliation', rows }]),
      filename: `reconciliation-${Date.now()}.xlsx`,
      recordCount: rows.length,
    };
  }
}
