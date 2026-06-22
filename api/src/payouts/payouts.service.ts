import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PayoutStatus, Prisma, RedemptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { buildXlsx } from '../common/xlsx';
import { rupeesToPaise } from '../common/money';
import { parsePayoutUtrUpload } from './payout-utr.helpers';
import { resolveEffectiveKycStatus } from '../kyc/kyc-eligibility';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
  ) {}

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

    // No in-portal fund / gateway exists — the bank transfer is offline — so there
    // is no fund-availability gate. Processing flags the valid transactions to
    // INITIATED and finalises the batch SUBMITTED; completion/reversal happen later
    // via the uploaded UTR (uploadPayoutUtr).
    const steps = {
      validation: { status: 'PENDING', count: 0, errors: [] as string[] },
      invoiceGeneration: { status: 'PENDING', count: 0 },
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
        include: {
          partner: {
            include: {
              // GLB-1b: feed ALL of the partner's submissions to the canonical
              // resolveEffectiveKycStatus (deterministic createdAt→updatedAt→id
              // tiebreak) so a stale APPROVED row cannot win a millisecond tie after
              // an in-place reKyc() mutation. Select the 4 fields the resolver needs.
              kycSubmissions: {
                orderBy: [{ createdAt: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
                select: { id: true, status: true, createdAt: true, updatedAt: true },
              },
            },
          },
        },
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

        // GLB-1b — partner eligibility gate: inactive/deleted or non-KYC-APPROVED
        // partners must be excluded from disbursement (mirrors the credit-rail gate
        // in credits.service.ts; uses the same latest-submission query pattern).
        const partner = tx.partner;
        if (!partner || partner.isActive === false || partner.deletedAt != null) {
          const reason = partner?.deletedAt != null ? 'PARTNER_DELETED' : 'PARTNER_INACTIVE';
          errors.push(`Partner ${tx.partnerId} is ineligible (${reason}); excluded from batch`);
        } else {
          // Canonical resolver (matches the credit + redemption rails); default for
          // no submission = null = NOT approved (never paid).
          const kycStatus = resolveEffectiveKycStatus(partner.kycSubmissions ?? []);
          if (kycStatus !== 'APPROVED') {
            errors.push(
              `Partner ${tx.partnerId} KYC is not approved (status: ${kycStatus ?? 'NO_SUBMISSION'}); excluded from batch`,
            );
          }
        }

        // GLM-3 — beneficiary field validation: mode-required fields must be present
        // at process time (they are snapshotted at confirm time but could be null if
        // the partner had no KYC-verified bank/UPI details when the order was confirmed).
        if (tx.payoutMode === 'UPI') {
          if (!tx.upiId) {
            errors.push(`Missing upiId for UPI transaction ${tx.id}`);
          }
        } else if (tx.payoutMode === 'BANK_TRANSFER') {
          if (!tx.bankAccountNumber || !tx.ifscCode) {
            const missing: string[] = [];
            if (!tx.bankAccountNumber) missing.push('bankAccountNumber');
            if (!tx.ifscCode) missing.push('ifscCode');
            errors.push(
              `Missing beneficiary field(s) [${missing.join(', ')}] for BANK_TRANSFER transaction ${tx.id}`,
            );
          }
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

      // Step 3: Flag for disbursement + finalise — all per-transaction writes and the
      // batch finalisation run in one transaction so a partial failure rolls back.
      // No fund gate: any batch that survives validation is SUBMITTED.
      let flagged = 0;
      finalStatus = 'SUBMITTED';

      await this.prisma.$transaction(async (tx) => {
        for (const vt of validTransactions) {
          await tx.payoutTransaction.update({
            where: { id: vt.id },
            data: { status: 'INITIATED' },
          });
          flagged++;
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

  /**
   * GET /v1/payouts/batches/:id/utr-template — build the fillable UTR template for a
   * batch and return its bytes. One row per PayoutTransaction keyed by its stable id
   * (Transaction ID). The admin fills UTR + Status (PAID/FAILED) offline and
   * re-uploads via uploadPayoutUtr. The Transaction ID column is the ONLY join key —
   * never edited by the admin.
   */
  async buildPayoutUtrTemplate(user: JwtPayload, batchId: string) {
    const batch = await this.prisma.payoutBatch.findFirst({
      where: { id: batchId, clientId: user.clientId },
    });
    if (!batch) throw new NotFoundException('Payout batch not found');

    const transactions = await this.prisma.payoutTransaction.findMany({
      where: { batchId, batch: { clientId: user.clientId } },
      include: {
        partner: { select: { businessName: true, panNumber: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // amountPaise is BigInt from Prisma; Number() is safe (paise « MAX_SAFE_INTEGER).
    // Beneficiary columns are sourced from the PayoutTransaction's frozen snapshot
    // (captured at confirm time) — NOT live partner data — so the admin pays the
    // exact beneficiary the redemption was confirmed against. One file for both
    // rails; blank where a field wasn't entered. These columns are READ-ONLY: the
    // re-upload parser keys off "Transaction ID" + "Status"/"UTR" (by header name,
    // ignoring extra columns), so the round-trip is unaffected.
    // UTR + Status are intentionally blank for the admin to fill offline.
    const rows = transactions.map((t) => ({
      'Transaction ID': t.id,
      'Partner Name': t.partner?.businessName ?? '',
      PAN: t.partner?.panNumber ?? 'N/A',
      'Amount (₹)': (Number(t.amountPaise) / 100).toFixed(2),
      Mode: t.payoutMode,
      'Beneficiary Name': t.beneficiaryName ?? '',
      'Bank Account Number': t.bankAccountNumber ?? '',
      IFSC: t.ifscCode ?? '',
      'Bank Name': t.bankName ?? '',
      'UPI ID': t.upiId ?? '',
      UTR: '',
      Status: '',
    }));

    return {
      buffer: buildXlsx([{ name: 'UTR Upload', rows }]),
      filename: `payout-utr-${batch.batchCode}.xlsx`,
      recordCount: rows.length,
    };
  }

  /**
   * POST /v1/payouts/batches/:id/utr?apply=true — ingest the filled UTR report.
   *
   * Mirrors credits.uploadUtr: preview unless apply=true, a knownUtrs Set for
   * cross-batch duplicate-UTR detection, and a single $transaction that mutates each
   * OK row. The OFFLINE bank transfer's outcome is the ONLY thing that completes or
   * reverses an INR redemption:
   *   - PAID  → PayoutTransaction SUCCESS (providerRefId = UTR, completedAt = now);
   *             linked RedemptionOrder → DELIVERED (if not already terminal). No
   *             points change.
   *   - FAILED → PayoutTransaction FAILED (failureReason); linked RedemptionOrder
   *              points reversed ONCE (M2 claim) then → FAILED.
   *
   * Idempotency: terminal PayoutTransactions (SUCCESS/FAILED/REVERSED) are skipped,
   * and the FAILED refund uses the exact M2 claim
   * (updateMany where pointsDeducted>0 → 0; reverse only if count>0), so
   * re-uploading the same report is a no-op.
   */
  async uploadPayoutUtr(
    user: JwtPayload,
    batchId: string,
    file: Express.Multer.File,
    apply: boolean,
  ) {
    const batch = await this.prisma.payoutBatch.findFirst({
      where: { id: batchId, clientId: user.clientId },
    });
    if (!batch) throw new NotFoundException('Payout batch not found');

    if (!file) throw new BadRequestException('No file uploaded');

    const transactions = await this.prisma.payoutTransaction.findMany({
      where: { batchId, batch: { clientId: user.clientId } },
      select: {
        id: true,
        status: true,
        providerRefId: true,
        payoutMode: true,
        partnerId: true,
        redemptionOrderId: true,
      },
    });

    const ab = file.buffer.buffer.slice(
      file.buffer.byteOffset,
      file.buffer.byteOffset + file.buffer.byteLength,
    );

    const batchTxnIds = new Set(transactions.map((t) => t.id));

    // Known UTRs across ALL of this client's payout transactions (cross-batch dup
    // detection), upper-cased to match the parser's normalisation.
    const usedUtrs = await this.prisma.payoutTransaction.findMany({
      where: { batch: { clientId: user.clientId }, providerRefId: { not: null } },
      select: { providerRefId: true },
    });
    const knownUtrs = new Set<string>(
      usedUtrs
        .filter((t) => t.providerRefId != null)
        .map((t) => t.providerRefId!.toUpperCase()),
    );

    const parseResult = parsePayoutUtrUpload(ab, { batchTxnIds, knownUtrs });

    // Preview unless apply=true.
    if (!apply) {
      return { parseResult, batchCode: batch.batchCode };
    }

    if (!parseResult.canProceed) {
      throw new BadRequestException(
        'Cannot apply — parse result has errors or no valid rows',
      );
    }

    const txnMap = new Map(transactions.map((t) => [t.id, t]));
    const TERMINAL_PAYOUT: PayoutStatus[] = [
      PayoutStatus.SUCCESS,
      PayoutStatus.FAILED,
      PayoutStatus.REVERSED,
    ];
    const now = new Date();

    let paidCount = 0;
    let failedCount = 0;
    let reversedCount = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const row of parseResult.rows) {
        if (row.status !== 'OK' || !row.outcome) continue;

        const txn = txnMap.get(row.txnId);
        if (!txn) continue;

        // Idempotency: never re-process a payout transaction already in a terminal
        // state. A re-upload of the same report falls through here as a no-op.
        if (TERMINAL_PAYOUT.includes(txn.status)) continue;

        if (row.outcome === 'PAID') {
          await tx.payoutTransaction.update({
            where: { id: txn.id },
            data: {
              status: 'SUCCESS',
              providerRefId: row.utr,
              completedAt: now,
            },
          });
          paidCount++;

          // Complete the linked redemption (DELIVERED) unless it is already in a
          // terminal state. No points change on success.
          if (txn.redemptionOrderId) {
            await tx.redemptionOrder.updateMany({
              where: {
                id: txn.redemptionOrderId,
                status: {
                  notIn: [
                    RedemptionStatus.DELIVERED,
                    RedemptionStatus.CANCELLED,
                    RedemptionStatus.RETURNED,
                    RedemptionStatus.FAILED,
                  ],
                },
              },
              data: { status: RedemptionStatus.DELIVERED, deliveredAt: now },
            });
          }
        } else {
          // FAILED.
          await tx.payoutTransaction.update({
            where: { id: txn.id },
            data: {
              status: 'FAILED',
              failureReason: row.remarks || 'UTR report: FAILED',
            },
          });
          failedCount++;

          // Reverse the redemption points ONCE (M2 claim), then mark the order
          // FAILED. The claim makes a re-upload of the same FAILED a no-op.
          if (txn.redemptionOrderId) {
            const orderId = txn.redemptionOrderId;
            const order = await tx.redemptionOrder.findFirst({
              where: { id: orderId },
              select: { pointsDeducted: true, partnerId: true, orderNumber: true },
            });
            if (order) {
              const refundClaim = await tx.redemptionOrder.updateMany({
                where: { id: orderId, pointsDeducted: { gt: 0 } },
                data: { pointsDeducted: 0 },
              });
              if (refundClaim.count > 0) {
                await this.wallet.reverse(
                  order.partnerId,
                  order.pointsDeducted,
                  {
                    referenceId: orderId,
                    description: `Reversal ${order.orderNumber}`,
                  },
                  tx,
                );
                reversedCount++;
              }
              await tx.redemptionOrder.update({
                where: { id: orderId },
                data: { status: RedemptionStatus.FAILED },
              });
            }
          }
        }
      }
    });

    return { applied: true, paidCount, failedCount, reversedCount };
  }
}
