import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { buildXlsx } from '../common/xlsx';
import { rupeesToPaise } from '../common/money';
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
  constructor(private readonly prisma: PrismaService) {}

  /** GET /v1/payouts/transactions — paginated, filterable payout transactions. */
  async listTransactions(user: JwtPayload, q: ListTransactionsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    // Default tenant scope rides the batch relation. BUT the unbatched filter asks
    // for rows where batchId is null — a `batch: { clientId }` relation filter can
    // never match a null relation, so it would wrongly exclude every waiting row.
    // For unbatched, scope by the partner's clientId instead and pin batchId null.
    const where: Prisma.PayoutTransactionWhereInput = q.unbatched
      ? { batchId: null, status: 'PENDING', partner: { clientId: user.clientId } }
      : { batch: { clientId: user.clientId } };
    if (q.status && !q.unbatched) where.status = q.status;
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

    // _sum of a BigInt column returns bigint | null. Wrap with Number() for all
    // arithmetic (paise values are well below Number.MAX_SAFE_INTEGER).
    const utilised = utilisedByMode.reduce(
      (sum, m) => sum + Number(m._sum.amountPaise ?? 0n),
      0,
    );
    const totalReceived = Number(received._sum.amountPaise ?? 0n);
    const closingBalance = Number(latestEntry?.balancePaise ?? 0n) || (totalReceived - utilised);
    const pending = Number(pendingLiability._sum.amountPaise ?? 0n);

    return {
      totalReceivedPaise: totalReceived,
      totalReceived: totalReceived / 100,
      utilisedByMode: utilisedByMode.map((m) => ({
        mode: m.payoutMode,
        amountPaise: Number(m._sum.amountPaise ?? 0n),
        amount: Number(m._sum.amountPaise ?? 0n) / 100,
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
    // dto.amount is rupees from the request body; convert to integer paise.
    const amountPaise = rupeesToPaise(dto.amount);
    const paymentMode = dto.paymentMode ?? 'BANK_TRANSFER';

    const latestEntry = await this.prisma.fundLedger.findFirst({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
    // balancePaise is BigInt from Prisma; Number() is safe.
    const currentBalance = Number(latestEntry?.balancePaise ?? 0n);
    const newBalance = currentBalance + amountPaise;

    const result = await this.prisma.$transaction(async (tx) => {
      const receiptNumber = `FR-${Date.now()}`;
      const receipt = await tx.fundReceipt.create({
        data: {
          receiptNumber,
          amountPaise: BigInt(amountPaise),
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
          amountPaise: BigInt(amountPaise),
          balancePaise: BigInt(newBalance),
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

  /**
   * POST /v1/payouts/batches/:id/assign-pending — the batch-from-pending sweep.
   * Cash redemptions create UNBATCHED transactions (batchId null, PENDING). This
   * is the missing consumer: it pulls every eligible waiting transaction into a
   * DRAFT batch in one guarded updateMany so they can be processed (GIFSY-only).
   *
   * Cross-tenant safety: the `partner: { clientId }` filter is mandatory — a batch
   * must NEVER absorb another tenant's transaction. The `payoutMode` match is also
   * mandatory so a UPI batch can't swallow BANK_TRANSFER rows.
   */
  async assignPendingTransactions(user: JwtPayload, batchId: string) {
    const clientId = user.clientId;

    const batch = await this.prisma.payoutBatch.findFirst({
      where: { id: batchId, clientId },
    });
    if (!batch) throw new NotFoundException('Payout batch not found');
    if (batch.status !== 'DRAFT') {
      throw new BadRequestException(
        'Can only assign transactions to a DRAFT batch',
      );
    }

    // Single guarded statement: only unbatched, PENDING, redemption-backed
    // transactions whose partner is in THIS tenant and whose mode matches the
    // batch are pulled in. No read-then-write window.
    const { count } = await this.prisma.payoutTransaction.updateMany({
      where: {
        batchId: null,
        status: 'PENDING',
        redemptionOrderId: { not: null },
        payoutMode: batch.payoutMode,
        partner: { clientId },
      },
      data: { batchId },
    });

    await this.prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'PAYOUT_BATCH',
        entityId: batchId,
        actorId: user.sub,
        metadata: { event: 'ASSIGN_PENDING', assigned: count },
      },
    });

    return { batchId, assigned: count };
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
   * (validation → invoice log → fund check → flag for disbursement) and finalise
   * the batch status (GIFSY-only).
   *
   * Payouts disburse the FULL amount: TDS is NOT withheld here. TDS liability is
   * owned entirely by the P6.5 TDS engine (src/tds/), which computes 194R from the
   * redemption order — this path does not touch tdsRecord or net out any TDS.
   *
   * Double-processing is prevented by a guarded atomic claim (updateMany with a
   * status-in guard) rather than a read-then-write, so two concurrent callers can
   * never both win the DRAFT → PROCESSING transition.
   */
  async processBatch(user: JwtPayload, id: string) {
    const clientId = user.clientId;

    // Distinguish a genuine NotFound (no such batch in this tenant) from a
    // bad-state claim (exists but already PROCESSING/COMPLETED/etc.) for a clean
    // error, then perform the race-safe atomic claim.
    const batch = await this.prisma.payoutBatch.findFirst({
      where: { id, clientId },
    });
    if (!batch) throw new NotFoundException('Payout batch not found');

    // Guarded atomic claim: only a batch still in a processable state flips to
    // PROCESSING. A 0-count claim means another caller already advanced it.
    const claim = await this.prisma.payoutBatch.updateMany({
      where: { id, clientId, status: { in: ['DRAFT', 'SUBMITTED', 'FAILED'] } },
      data: { status: 'PROCESSING' },
    });
    if (claim.count === 0) {
      throw new BadRequestException('Batch is not in a processable state');
    }

    const steps = {
      validation: { status: 'PENDING', count: 0, errors: [] as string[] },
      invoiceGeneration: { status: 'PENDING', count: 0 },
      fundCheck: { status: 'PENDING', available: 0, required: 0 },
      disbursement: { status: 'PENDING', flagged: 0 },
    };
    let finalStatus: 'SUBMITTED' | 'FAILED' = 'FAILED';

    // The batch is now claimed (PROCESSING). If any step below throws, reset it to
    // FAILED — a re-claimable state — so a transient error never strands the batch
    // in PROCESSING (which the claim guard deliberately does not re-admit). The
    // disbursement writes + finalisation are themselves transactional, so a throw
    // there rolls back cleanly before the reset.
    try {
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
        // amountPaise is BigInt from Prisma; compare as Number.
        if (!tx.amountPaise || Number(tx.amountPaise) <= 0) {
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

      // Step 3: Fund check — the full gross amount is required (no TDS deduction).
      // balancePaise is BigInt from Prisma; Number() is safe.
      const fundLedger = await this.prisma.fundLedger.findFirst({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
      });
      const totalRequired = validTransactions.reduce(
        (sum, tx) => sum + Number(tx.amountPaise),
        0,
      );
      const availableBalance = Number(fundLedger?.balancePaise ?? 0n);
      steps.fundCheck.available = availableBalance;
      steps.fundCheck.required = totalRequired;
      steps.fundCheck.status = availableBalance >= totalRequired ? 'PASSED' : 'FAILED';

      // Step 4: Flag for disbursement + finalise — all per-transaction writes and the
      // batch finalisation run in one transaction so a partial failure rolls back.
      let flagged = 0;
      finalStatus = steps.fundCheck.status === 'PASSED' ? 'SUBMITTED' : 'FAILED';

      await this.prisma.$transaction(async (tx) => {
        if (steps.fundCheck.status === 'PASSED') {
          for (const vt of validTransactions) {
            await tx.payoutTransaction.update({
              where: { id: vt.id },
              data: { status: 'INITIATED' },
            });
            flagged++;
          }
        }

        await tx.payoutBatch.update({
          where: { id },
          data: { status: finalStatus, processedAt: new Date() },
        });
      });
      steps.disbursement.flagged = flagged;
      steps.disbursement.status = flagged > 0 ? 'FLAGGED' : 'SKIPPED';
    } catch (err) {
      // Reset the claimed batch to FAILED so it can be retried; never leave it
      // stranded in PROCESSING. Best-effort — swallow reset errors, rethrow cause.
      await this.prisma.payoutBatch
        .update({ where: { id }, data: { status: 'FAILED' } })
        .catch(() => undefined);
      throw err;
    }

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
      },
      orderBy: { createdAt: 'asc' },
    });

    // amountPaise / netAmountPaise are BigInt from Prisma; Number() is safe
    // (paise « Number.MAX_SAFE_INTEGER). Payouts never withhold TDS (that is the
    // P6.5 engine's job), so TDS here is always 0 and net always equals gross —
    // the columns are kept for the reconciliation format's stability.
    const rows = transactions.map((t, i) => ({
      'S.No': i + 1,
      'Partner Name': t.partner?.businessName ?? '',
      PAN: t.partner?.panNumber ?? 'N/A',
      'Gross Amount (₹)': (Number(t.amountPaise) / 100).toFixed(2),
      'TDS Amount (₹)': '0.00',
      'Net Amount (₹)': (Number(t.netAmountPaise) / 100).toFixed(2),
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
