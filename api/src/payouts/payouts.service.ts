import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PayoutStatus, PaymentDetailsStatus, Prisma, RedemptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { Msg91Service } from '../notifications/msg91.service';
import { WHATSAPP_KYC } from '../notifications/whatsapp-kyc.config';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { buildXlsx } from '../common/xlsx';
import { rupeesToPaise } from '../common/money';
import { monthYearIST, formatDateIST, istDayRangeFilter, istDateKey } from '../common/ist-date';
import {
  parsePayoutUtrUpload,
  NOT_PROCESSED_ERROR,
  ORDER_REFUNDED_ERROR,
  alreadySentToBankError,
  normaliseRef,
  type KnownRefUse,
  type PayoutUtrTxnInfo,
} from './payout-utr.helpers';

/** Redemption states in which an order can no longer be "paid" (its points went back). */
const ORDER_REFUNDED_STATUSES: RedemptionStatus[] = [
  RedemptionStatus.CANCELLED,
  RedemptionStatus.RETURNED,
  RedemptionStatus.FAILED,
];
/** providerResponse.paidOffPlatform === true (set when a payment was recorded as paid outside Gifsy). */
function isPaidOffPlatform(providerResponse: unknown): boolean {
  return (
    !!providerResponse &&
    typeof providerResponse === 'object' &&
    (providerResponse as Record<string, unknown>).paidOffPlatform === true
  );
}

/** The mode-required beneficiary fields are missing on the frozen snapshot. */
function missingBeneficiary(t: { payoutMode: string; upiId: string | null; bankAccountNumber: string | null; ifscCode: string | null }): boolean {
  if (t.payoutMode === 'UPI') return !t.upiId;
  if (t.payoutMode === 'BANK_TRANSFER') return !t.bankAccountNumber || !t.ifscCode;
  return false;
}

/** True when the linked order is cancelled/returned/failed or its points were refunded (M2 claim → 0). */
function isOrderRefunded(o: { status?: RedemptionStatus | string | null; pointsDeducted?: number | null } | null | undefined): boolean {
  if (!o) return false;
  if (o.status && (ORDER_REFUNDED_STATUSES as string[]).includes(o.status)) return true;
  return o.pointsDeducted === 0;
}
import {
  noIssuedVoucherGuard,
  hasIssuedVoucher,
  transitionOrderStatus,
} from '../rewards/order-status-transition';
import { resolveEffectiveKycStatus } from '../kyc/kyc-eligibility';
import { normalizeIdentityValue } from '../common/partner-group.helper';
import {
  BatchDetailQueryDto,
  CreateBatchDto,
  ListBatchesQueryDto,
  ListTransactionsQueryDto,
  ReceiveFundDto,
  ReconciliationQueryDto,
} from './dto/payouts.dto';

/**
 * Stable event tag for the MessageDeliveryReceipt rows written by the post-commit payout-credit
 * WhatsApp notification (D5 — completeness: this send was previously tracked NOWHERE). Groups
 * these sends in the per-tenant/per-event delivery report (D4).
 */
const PAYOUT_NOTIFY_EVENT_KEY = 'PAYOUT_NOTIFY';

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
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly msg91: Msg91Service,
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
    // Still tenant-scoped via `batch: { clientId }` above, so another tenant's batch id
    // simply matches nothing. Ignored with `unbatched` (which pins batchId null).
    if (q.batchId && !q.unbatched) where.batchId = q.batchId;
    // Date-only FE `<input type="date">` bounds are treated as FULL INCLUSIVE IST days
    // (a raw `new Date("YYYY-MM-DD")` is 05:30 IST → would skew the start and truncate the
    // last IST day); a full ISO datetime is used as-given. Mirrors rewards/gift/reports.
    const createdAtRange = istDayRangeFilter(q.dateFrom, q.dateTo);
    if (createdAtRange) where.createdAt = createdAtRange;

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

      // Per-tenant behaviour flag (clients.features.allowPayoutWithoutPan, default OFF): when ON,
      // a partner with no PAN on file is NOT excluded. They are paid the full amount; the TDS at the
      // no-PAN rate is a company-borne liability (the 194R engine keys it per no-PAN deductee) shown
      // in the TDS reports as "NO PAN ON FILE". Every other check below stays.
      // Absent/false → the missing-PAN exclusion is byte-identical to before (e.g. Deoleo).
      const batchClient = await this.prisma.client.findUnique({
        where: { id: clientId },
        select: { features: true },
      });
      const allowPayoutWithoutPan =
        (batchClient?.features as Record<string, unknown> | null)?.allowPayoutWithoutPan === true;

      for (const tx of transactions) {
        const errors: string[] = [];
        if (!allowPayoutWithoutPan && !tx.partner?.panNumber) {
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

      // Bulk money mutation over uploaded rows — raise the interactive-tx timeout (default 5s) so the ATOMIC transaction survives a full-tenant batch; must stay all-or-nothing (do NOT chunk — would risk partial/double credit).
      await this.prisma.$transaction(async (tx) => {
        for (const vt of validTransactions) {
          // Compare-and-set: only a row STILL PENDING moves to INITIATED. A concurrent UTR upload
          // may have recorded it as paid off-platform (SUCCESS) since the read above — never
          // overwrite that; a 0-count claim simply skips the row.
          const res = await tx.payoutTransaction.updateMany({
            where: { id: vt.id, status: 'PENDING' },
            data: { status: 'INITIATED' },
          });
          if (res.count > 0) flagged++;
        }

        await tx.payoutBatch.update({
          where: { id },
          data: { status: finalStatus, processedAt: new Date() },
        });
      }, { timeout: 180_000, maxWait: 20_000 });
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
      Date: istDateKey(t.createdAt),
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
      // Optional: Y = this payment was made OUTSIDE Gifsy and is only being recorded here (the
      // only way to mark a not-yet-processed PENDING transaction PAID). Blank/N = paid via the
      // processed batch.
      'Paid outside platform (Y/N)': '',
      'Off-platform note': '',
      // Optional, Y rows only: must equal the payout amount if filled (blank = paid in full).
      'Amount paid (₹)': '',
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
   * PROCESS-FIRST guard (owner-approved, all tenants): PAID is accepted only for a transaction
   * that went through processBatch (INITIATED/PROCESSING). A still-PENDING/HOLD transaction is
   * rejected per row UNLESS the row sets "Paid outside platform (Y/N)" = Y — a payment made
   * OUTSIDE Gifsy whose outcome is recorded here is never blocked: it still needs a valid UTR and
   * a positive amount, is flagged in providerResponse { paidOffPlatform, note, … } and gets an
   * AuditLog row in the same tx. FAILED rows are unaffected. (Historical VENDOR_IMPORT data lives on
   * the CREDITS rail — CreditBatch.sourceKind — and never passes through this upload.)
   *
   * Idempotency: terminal PayoutTransactions (SUCCESS/FAILED/REVERSED) are skipped,
   * and the FAILED refund uses the exact M2 claim
   * (updateMany where pointsDeducted>0 → 0; reverse only if count>0), so
   * re-uploading the same report is a no-op.
   *
   * Concurrency: each payout's terminal write is a compare-and-set inside the tx
   * (`updateMany where { id, status: <non-terminal status read> }`). Of two overlapping
   * uploads for the same payout (e.g. one PAID, one FAILED) exactly one wins; the loser's
   * row is returned in `skipped` and NONE of its side effects run (no refund, no order
   * status write, no partner verify/demote, no WhatsApp). The order FAILED write is a
   * guarded claim too, so it adds at most one FAILED history row.
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
        amountPaise: true,
        providerRefId: true,
        payoutMode: true,
        partnerId: true,
        redemptionOrderId: true,
        // Frozen beneficiary snapshot — used by the capture-bank-at-redemption verify-stamp to
        // confirm the partner's CURRENT rails still equal the ones that were actually paid before
        // flipping paymentDetailsStatus to VERIFIED (never verify details a payout didn't pay).
        upiId: true,
        bankAccountNumber: true,
        ifscCode: true,
        // For the "already marked paid on <date> (<off-platform|bank>)" notice.
        completedAt: true,
        providerResponse: true,
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
      select: { providerRefId: true, partnerId: true, providerResponse: true },
    });
    const knownUtrs = new Set<string>(
      usedUtrs
        .filter((t) => t.providerRefId != null)
        .map((t) => t.providerRefId!.toUpperCase()),
    );
    // NORMALISED reference → every past use (partner + was it an off-platform record?). A Y row may
    // reuse only its own partner's off-platform references, never a genuine bank UTR.
    const knownRefs = new Map<string, KnownRefUse[]>();
    for (const t of usedUtrs) {
      if (t.providerRefId == null) continue;
      const k = normaliseRef(t.providerRefId);
      const list = knownRefs.get(k) ?? [];
      list.push({ partnerId: t.partnerId ?? null, offPlatform: isPaidOffPlatform(t.providerResponse) });
      knownRefs.set(k, list);
    }

    // Linked redemption state — an off-platform PAID must never "pay" an order whose points were
    // already refunded (cancelled / returned / failed) — that would be a double benefit.
    const orderIds = [...new Set(transactions.map((t) => t.redemptionOrderId).filter((x): x is string => !!x))];
    const orders = orderIds.length
      ? await this.prisma.redemptionOrder.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, status: true, pointsDeducted: true },
        })
      : [];
    const orderById = new Map(orders.map((o) => [o.id, o]));

    // txnInfo turns on the PROCESS-FIRST guard: PAID only for a processed (INITIATED/PROCESSING)
    // transaction, unless the row is marked "Paid outside platform" = Y (recorded off-platform
    // payment — never blocked). Surfaced as per-row errors in the preview AND enforced on apply.
    const txnInfo = new Map<string, PayoutUtrTxnInfo>(
      transactions.map((t) => [
        t.id,
        {
          status: t.status,
          amountPaise: t.amountPaise,
          partnerId: t.partnerId,
          orderRefunded: t.redemptionOrderId ? isOrderRefunded(orderById.get(t.redemptionOrderId)) : false,
          paidOn: t.completedAt ? istDateKey(t.completedAt) : undefined,
          paidOffPlatform: isPaidOffPlatform(t.providerResponse),
        },
      ]),
    );
    const parseResult = parsePayoutUtrUpload(ab, {
      batchTxnIds,
      knownUtrs,
      txnInfo,
      knownRefs,
      batchRef: batch.batchCode ?? batchId,
    });

    // Preview unless apply=true.
    if (!apply) {
      return { parseResult, batchCode: batch.batchCode };
    }

    if (!parseResult.canProceed) {
      // Name the failing rows (sheet row + reason, first 10) so the admin can fix the file — e.g.
      // the PROCESS-FIRST guard's "This payment wasn't processed in a batch …" message.
      const rowErrors = parseResult.rows
        .filter((r) => r.status === 'ERROR')
        .map((r) => `Row ${r.rowNum}: ${r.errors.join(' ')}`);
      const detail = parseResult.headerError
        ? ` ${parseResult.headerError}`
        : rowErrors.length
          ? ` ${rowErrors.slice(0, 10).join(' | ')}${rowErrors.length > 10 ? ` (+${rowErrors.length - 10} more)` : ''}`
          : '';
      throw new BadRequestException(
        `Cannot apply — parse result has errors or no valid rows.${detail}`,
      );
    }

    const txnMap = new Map(transactions.map((t) => [t.id, t]));

    // Off-platform (Y) rows bypass the processing gates BY DESIGN (the money already left outside
    // Gifsy) — but which gates WOULD have failed is recorded on each audit row for review.
    const offPlatformPartnerIds = [
      ...new Set(
        parseResult.rows
          .filter((r) => r.status === 'OK' && r.outcome === 'PAID' && r.paidOffPlatform)
          .map((r) => txnMap.get(r.txnId)?.partnerId)
          .filter((x): x is string => !!x),
      ),
    ];
    const bypassedGatesByPartner = new Map<string, string[]>();
    if (offPlatformPartnerIds.length) {
      const gatePartners = await this.prisma.channelPartner.findMany({
        where: { id: { in: offPlatformPartnerIds } },
        select: {
          id: true,
          panNumber: true,
          isActive: true,
          deletedAt: true,
          kycSubmissions: {
            orderBy: [{ createdAt: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
            select: { id: true, status: true, createdAt: true, updatedAt: true },
          },
        },
      });
      for (const gp of gatePartners as Array<{
        id: string;
        panNumber?: string | null;
        isActive?: boolean | null;
        deletedAt?: Date | null;
        kycSubmissions?: Parameters<typeof resolveEffectiveKycStatus>[0];
      }>) {
        const gates: string[] = [];
        if (!gp.panNumber || !String(gp.panNumber).trim()) gates.push('noPan');
        const kyc = resolveEffectiveKycStatus(gp.kycSubmissions ?? []);
        if (kyc !== 'APPROVED') gates.push(`kycNotApproved:${kyc ?? 'NO_SUBMISSION'}`);
        if (gp.isActive === false) gates.push('partnerInactive');
        if (gp.deletedAt != null) gates.push('partnerDeleted');
        bypassedGatesByPartner.set(gp.id, gates);
      }
    }

    const TERMINAL_PAYOUT: PayoutStatus[] = [
      PayoutStatus.SUCCESS,
      PayoutStatus.FAILED,
      PayoutStatus.REVERSED,
    ];
    const now = new Date();

    let paidCount = 0;
    let failedCount = 0;
    let reversedCount = 0;
    // PAID rows recorded as paid OUTSIDE the platform ("Paid outside platform" = Y).
    let offPlatformCount = 0;
    // Rows whose compare-and-set claim lost to an overlapping upload (see the claim below).
    const skipped: Array<{
      rowNum: number;
      txnId: string;
      outcome: 'PAID' | 'FAILED';
      reason: string;
    }> = [];
    // FAILED rows whose ORDER holds a voucher code: the payout is marked FAILED, but the order is
    // left exactly as is (no refund, no FAILED flip) for ops — the issued-voucher refund block.
    const blockedOrders: Array<{
      rowNum: number;
      txnId: string;
      orderId: string;
      orderNumber: string;
      reason: string;
    }> = [];

    // Collected DURING the tx (do NOT read/send inside it): one payout-credit WhatsApp
    // per PAID redemption cash-out, dispatched AFTER the tx commits so neither a read
    // nor a delivery failure can roll back the money path. We push ONLY the ids already
    // on the txn (from txnMap) — the partner/order rows are batch-read post-commit.
    const payoutWhatsapps: Array<{
      partnerId: string;
      redemptionOrderId: string | null;
      utr: string;
    }> = [];

    // Bulk money mutation over uploaded rows — raise the interactive-tx timeout (default 5s) so the ATOMIC transaction survives a full-tenant batch; must stay all-or-nothing (do NOT chunk — would risk partial/double credit).
    // DETERMINISTIC LOCK ORDER: process rows sorted by txnId (plain code-unit compare, not
    // locale) so two overlapping uploads touching the same payouts acquire the payout row locks
    // in the same order — they serialise instead of deadlocking. Sorting a COPY keeps each row's
    // reported rowNum (file position) unchanged.
    const rowsInLockOrder = [...parseResult.rows].sort((a, b) =>
      a.txnId < b.txnId ? -1 : a.txnId > b.txnId ? 1 : a.rowNum - b.rowNum,
    );
    await this.prisma.$transaction(async (tx) => {
      for (const row of rowsInLockOrder) {
        if (row.status !== 'OK' || !row.outcome) continue;

        const txn = txnMap.get(row.txnId);
        if (!txn) continue;

        // Idempotency: never re-process a payout transaction already in a terminal
        // state. A re-upload of the same report falls through here as a no-op.
        if (TERMINAL_PAYOUT.includes(txn.status)) continue;

        // CONCURRENCY CLAIM (compare-and-set): the terminal check above is from a read taken
        // BEFORE this tx, so an overlapping upload (e.g. PAID vs FAILED for the same payout)
        // may already have moved this row. The terminal write is therefore conditional on the
        // row still holding the exact non-terminal status we read. Postgres re-evaluates the
        // predicate after the competing tx commits, so exactly ONE upload wins. A lost claim
        // (count 0) skips the row with a row-level result and runs NONE of its side effects
        // (refund, order status, partner verify/demote, WhatsApp gather) — every side effect
        // below runs only for the winner, after its claim.
        // Defence-in-depth for the PROCESS-FIRST guard (the parser already rejects it): a PAID
        // row on a still-unprocessed transaction is only ever applied as an OFF-PLATFORM payment.
        const unprocessed = txn.status === PayoutStatus.PENDING || txn.status === PayoutStatus.HOLD;
        if (row.outcome === 'PAID' && unprocessed && !row.paidOffPlatform) {
          skipped.push({ rowNum: row.rowNum, txnId: txn.id, outcome: row.outcome, reason: NOT_PROCESSED_ERROR });
          continue;
        }
        const offPlatform = row.outcome === 'PAID' && row.paidOffPlatform;
        if (offPlatform && !unprocessed) {
          skipped.push({
            rowNum: row.rowNum,
            txnId: txn.id,
            outcome: row.outcome,
            reason: alreadySentToBankError(batch.batchCode ?? batchId),
          });
          continue;
        }
        if (offPlatform && txn.redemptionOrderId) {
          const order = await tx.redemptionOrder.findFirst({
            where: { id: txn.redemptionOrderId },
            select: { status: true, pointsDeducted: true },
          });
          if (isOrderRefunded(order)) {
            skipped.push({ rowNum: row.rowNum, txnId: txn.id, outcome: row.outcome, reason: ORDER_REFUNDED_ERROR });
            continue;
          }
        }

        const claim = await tx.payoutTransaction.updateMany({
          where: { id: txn.id, status: txn.status },
          data:
            row.outcome === 'PAID'
              ? {
                  status: PayoutStatus.SUCCESS,
                  providerRefId: row.utr,
                  completedAt: now,
                  // Off-platform flag lives in the existing providerResponse JSON (no schema change).
                  ...(offPlatform
                    ? {
                        providerResponse: {
                          paidOffPlatform: true,
                          note: row.offPlatformNote || null,
                          recordedById: user.sub,
                          recordedAt: now.toISOString(),
                          previousStatus: txn.status,
                        },
                      }
                    : {}),
                }
              : {
                  status: PayoutStatus.FAILED,
                  failureReason: row.remarks || 'UTR report: FAILED',
                },
        });
        if (claim.count === 0) {
          skipped.push({
            rowNum: row.rowNum,
            txnId: txn.id,
            outcome: row.outcome,
            reason: 'Payout already updated by another upload',
          });
          continue;
        }

        if (row.outcome === 'PAID') {
          paidCount++;

          // Off-platform payment recorded on the platform → explicit audit row (who, which payout,
          // prior status, reference, note) — written in the SAME tx as the status change.
          if (offPlatform) {
            offPlatformCount++;
            await tx.auditLog.create({
              data: {
                actorId: user.sub,
                action: 'UPDATE',
                entityType: 'PayoutTransaction',
                entityId: txn.id,
                oldValues: { status: txn.status },
                newValues: {
                  status: PayoutStatus.SUCCESS,
                  paidOffPlatform: true,
                  providerRefId: row.utr,
                  note: row.offPlatformNote || null,
                },
                metadata: {
                  batchId,
                  batchCode: batch.batchCode,
                  source: 'PAYOUT_UTR_UPLOAD',
                  paidOffPlatform: true,
                  // Processing gates this payment bypassed because it was paid outside Gifsy.
                  bypassedGates: [
                    ...(bypassedGatesByPartner.get(txn.partnerId) ?? []),
                    ...(unprocessed ? ['notProcessed'] : []),
                    ...(missingBeneficiary(txn) ? ['missingBeneficiaryFields'] : []),
                  ],
                },
              },
            });
          }

          // Capture-bank-at-redemption: a COMPLETED payout verifies the partner's self-captured
          // bank/UPI so they surface in Store Information (docs/plans/PAYMENT-DETAILS-AT-REDEMPTION-DESIGN.md).
          // Two guards (audit-hardened):
          //  - status IN {UNVERIFIED, NEEDS_RECAPTURE}: a real payment is authoritative and also
          //    clears a prior NEEDS_RECAPTURE; it never downgrades a VERIFIED (operator/KYC/Deoleo) row.
          //  - SNAPSHOT MATCH: the partner's CURRENT rail must still equal the one this txn actually
          //    paid (the frozen snapshot) — so re-captured, never-paid details can't ride a payout on
          //    old details into VERIFIED. Match the rail that was paid (UPI if present, else bank+IFSC).
          //  - UPI is compared CASE-INSENSITIVELY via normalizeIdentityValue('upi') (VPAs are
          //    case-insensitive per NPCI; partners now store the lower-cased form while older payout
          //    snapshots may be mixed-case). Done in JS, not Prisma `mode:'insensitive'` (which
          //    compiles to ILIKE and would treat `_`/`%` in a VPA as wildcards). The update then
          //    CAS-guards on the EXACT upiId value just read, so a concurrent re-capture between the
          //    read and the write still cannot be promoted to VERIFIED.
          // NOT for an off-platform payment: the money did not go to the captured bank/UPI rail
          // through Gifsy, so it proves nothing about those details — they stay unverified.
          if (!offPlatform) {
            await this.updatePartnerIfSnapshotRailMatches(
              tx,
              txn,
              { in: [PaymentDetailsStatus.UNVERIFIED, PaymentDetailsStatus.NEEDS_RECAPTURE] },
              { paymentDetailsStatus: PaymentDetailsStatus.VERIFIED, bankVerifiedAt: now },
            );
          }

          // Gather (do NO reads here) the payout-credit WhatsApp payload: push only the
          // ids already on the txn — the partner/order rows are batch-read AFTER commit
          // so a gather read can never abort this atomic money mutation. Tenant-gated so
          // we only collect for configured tenants.
          if (WHATSAPP_KYC[user.clientId]?.payoutCreditTemplate) {
            payoutWhatsapps.push({
              partnerId: txn.partnerId,
              redemptionOrderId: txn.redemptionOrderId,
              utr: row.utr ?? '',
            });
          }

          // Complete the linked redemption (DELIVERED) unless it is already in a
          // terminal state. No points change on success. Shared transition: the DELIVERED
          // history row (actor = uploader) is written only when this claim wins.
          if (txn.redemptionOrderId) {
            await transitionOrderStatus(tx, {
              orderId: txn.redemptionOrderId,
              guard: {
                status: {
                  notIn: [
                    RedemptionStatus.DELIVERED,
                    RedemptionStatus.CANCELLED,
                    RedemptionStatus.RETURNED,
                    RedemptionStatus.FAILED,
                  ],
                },
              },
              fromStatus: null,
              toStatus: RedemptionStatus.DELIVERED,
              data: { deliveredAt: now },
              changedById: user.sub,
            });
          }
        } else {
          // FAILED (payout row already flipped by the claim above).
          failedCount++;

          // Capture-bank-at-redemption: a FAILED payout on still-unverified self-captured details
          // marks them for recapture (hidden + re-prompted next redemption). Guarded on UNVERIFIED
          // so a failed payout can NEVER hide operator/KYC-verified details or touch Deoleo. SNAPSHOT
          // MATCH (mirrors the PAID path): only when the failed txn's rail is the partner's CURRENT
          // rail — a failure on OLD details (the partner has since re-captured a new rail) must not
          // demote the new, not-yet-tried details.
          await this.updatePartnerIfSnapshotRailMatches(
            tx,
            txn,
            PaymentDetailsStatus.UNVERIFIED,
            { paymentDetailsStatus: PaymentDetailsStatus.NEEDS_RECAPTURE },
          );

          // Reverse the redemption points ONCE (M2 claim), then mark the order
          // FAILED. The claim makes a re-upload of the same FAILED a no-op.
          if (txn.redemptionOrderId) {
            const orderId = txn.redemptionOrderId;
            const order = await tx.redemptionOrder.findFirst({
              where: { id: orderId },
              select: { pointsDeducted: true, partnerId: true, orderNumber: true, status: true, voucherCode: true },
            });
            if (order && hasIssuedVoucher(order.voucherCode)) {
              // Issued-voucher refund block (owner money rule, all paths): a voucher code is on the
              // order → do NOT refund and do NOT flip it to FAILED (leave it exactly as is, like the
              // Hubble path). A cash order should never carry one (the voucher write guard refuses
              // it), so this is an anomaly → reported in the response + logged for ops.
              blockedOrders.push({
                rowNum: row.rowNum,
                txnId: txn.id,
                orderId,
                orderNumber: order.orderNumber,
                reason: 'A voucher code is on this order — points not refunded and order left unchanged; needs ops review',
              });
              this.logger.error(
                `[payout-utr] order ${order.orderNumber}: UTR FAILED but a voucher code is on the order — NOT refunded, order left as is`,
              );
            } else if (order) {
              // The claims ALSO carry the no-issued-voucher guard, so a code set after our read
              // still blocks the refund and the FAILED flip atomically.
              const refundClaim = await tx.redemptionOrder.updateMany({
                where: { id: orderId, pointsDeducted: { gt: 0 }, ...noIssuedVoucherGuard(order.voucherCode) },
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
              // Shared transition: status + FAILED history row (actor = uploader). GUARDED
              // (atomic claim `status != FAILED`): the history row is written only when this
              // write actually moves the order to FAILED, so an overlapping/repeat upload can
              // never add a duplicate FAILED row. Already FAILED on read → no write at all.
              if (order.status !== RedemptionStatus.FAILED) {
                await transitionOrderStatus(tx, {
                  orderId,
                  guard: { status: { not: RedemptionStatus.FAILED }, ...noIssuedVoucherGuard(order.voucherCode) },
                  fromStatus: order.status,
                  toStatus: RedemptionStatus.FAILED,
                  changedById: user.sub,
                });
              }
            }
          }
        }
      }
    }, { timeout: 180_000, maxWait: 20_000 });

    // POST-COMMIT owner WhatsApp on payout credit (deoleo_payout_credit) for each PAID
    // redemption cash-out. DIRECT send, fire-and-forget: the money tx above is already
    // committed, so neither the batch reads nor a delivery failure MUST EVER affect it.
    // Tenant-gated. The whole block is wrapped so a read failure is logged and ALL sends
    // are skipped (never a 500). Batch-reading the partners + orders here (vs per-row
    // reads inside the tx) is also more efficient.
    //   {{1}} ownerName · {{2}} points · {{3}} UTR · {{4}} date of payment · {{5}} month
    // Note {{5}} for a redemption = the month of PAYMENT (monthYearIST(now)) — a redemption
    // is not tied to a credit month (product decision).
    if (payoutWhatsapps.length > 0) {
      const template = WHATSAPP_KYC[user.clientId]?.payoutCreditTemplate;
      if (template) {
        try {
          // Batch-read the unique partners + orders referenced by the pending sends.
          const partnerIds = [...new Set(payoutWhatsapps.map((w) => w.partnerId))];
          const orderIds = [
            ...new Set(
              payoutWhatsapps
                .map((w) => w.redemptionOrderId)
                .filter((id): id is string => id != null),
            ),
          ];
          const [partners, orders] = await Promise.all([
            this.prisma.channelPartner.findMany({
              // isParent:false — defensive; parents have no wallet/payouts so never appear
              // here (docs/plans/PARTNER-MULTI-OUTLET.md §9).
              where: { id: { in: partnerIds }, isParent: false },
              select: { id: true, ownerName: true, phone: true },
            }),
            orderIds.length > 0
              ? this.prisma.redemptionOrder.findMany({
                  where: { id: { in: orderIds } },
                  select: { id: true, pointsDeducted: true },
                })
              : Promise.resolve([] as { id: string; pointsDeducted: number }[]),
          ]);
          const partnerMap = new Map(partners.map((p) => [p.id, p]));
          const orderMap = new Map(orders.map((o) => [o.id, o]));

          const paymentMonth = monthYearIST(now);
          const paymentDate = formatDateIST(now);
          for (const w of payoutWhatsapps) {
            const phone = partnerMap.get(w.partnerId)?.phone?.trim();
            const points = w.redemptionOrderId
              ? orderMap.get(w.redemptionOrderId)?.pointsDeducted ?? 0
              : 0;
            // Only send with a real recipient AND a positive points value. A redemption
            // cash-out always has pointsDeducted>0, so a 0/absent value means a
            // non-redemption or already-reversed txn that must not get a "0 points" msg.
            if (!phone || points <= 0) continue;
            const ownerName = partnerMap.get(w.partnerId)?.ownerName?.trim() || 'Partner';
            const bodyValues = [
              ownerName,
              String(points),
              w.utr,
              paymentDate,
              paymentMonth,
            ];
            // ── Additive per-message delivery receipt (D5 — DELIVERY-STATUS-REPORTING-SCOPE.md) ──
            // Best-effort + billing-safe, mirroring the transactional-WhatsApp leg in
            // notifications.service and the scheme-notify D3 fix. The money tx above is ALREADY
            // committed; this whole post-commit block is fire-and-forget, so the receipt write can
            // NEVER affect the payout OR the notification. A receipt-write failure (or the gate being
            // off) leaves the send byte-identical to before (the 3-arg send fires with no crqid), and
            // a billed send is never left FAILED (SENT is flipped before the catch; FAILED is guarded
            // on status:'QUEUED').
            const receipt = await this.createReceipt(user.clientId, phone);
            try {
              // crqid passed ONLY when a receipt exists — a no-receipt call (gate off / write failure)
              // stays byte-identical to the prior 3-arg send. Destructure defensively (`?? {}`).
              const sendRes = receipt
                ? await this.msg91.sendWhatsappTemplate(phone, template, bodyValues, {
                    crqid: receipt.crqid,
                  })
                : await this.msg91.sendWhatsappTemplate(phone, template, bodyValues);
              await this.markReceiptSent(receipt, (sendRes ?? {}).requestId ?? null);
            } catch (e) {
              // Non-critical: a WhatsApp delivery failure must NEVER fail the payout.
              this.logger.warn(`[payout-whatsapp] payout-credit send failed (client ${user.clientId}): ${e}`);
              // Guarded (QUEUED-only): only an UNBILLED send flips to FAILED; a billed send is already
              // SENT → no-op. Does NOT rethrow — the payout-notify block stays fire-and-forget.
              await this.markReceiptFailed(receipt, String(e));
            }
          }
        } catch (e) {
          // Non-critical: the post-commit batch-read must never surface as a 500.
          this.logger.warn(`[payout-whatsapp] payout-credit notify block failed (client ${user.clientId}): ${e}`);
        }
      }
    }

    return {
      applied: true,
      paidCount,
      failedCount,
      reversedCount,
      offPlatformCount,
      skipped,
      blockedOrders,
      // Rows for already-SUCCESS transactions — reported (possible double payment), never applied.
      alreadyPaid: parseResult.alreadyPaid,
      warnings: parseResult.warnings,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Delivery receipts (D5) — best-effort, gated, never-throwing. Mirrors the helpers
  // in notifications.service (transactional WhatsApp) and scheme-notify (D3). MONEY-
  // ADJACENT FILE: these helpers exist ONLY to record delivery tracking for the
  // post-commit payout-credit WhatsApp; they never run inside the payout tx and can
  // never affect the payout or the notification (all three swallow their own errors).
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Capture-bank-at-redemption SNAPSHOT MATCH — shared by the UTR upload's PAID (→ VERIFIED) and
   * FAILED (→ NEEDS_RECAPTURE) paths. Applies `data` to the partner ONLY when (a) its
   * paymentDetailsStatus matches `status` AND (b) the rail this txn actually tried (its frozen
   * snapshot: UPI if present, else bank+IFSC) is STILL the partner's CURRENT rail — so an outcome on
   * OLD details never promotes/demotes details the partner has since re-captured.
   *  - UPI: compared CASE-INSENSITIVELY via normalizeIdentityValue('upi') (VPAs are case-insensitive
   *    per NPCI; partners store the lower-cased form while older snapshots may be mixed-case). Done in
   *    JS, not Prisma `mode:'insensitive'` (ILIKE would treat `_`/`%` in a VPA as wildcards). The
   *    update CAS-guards on the EXACT upiId just read, so a concurrent re-capture between the read and
   *    the write still cannot be touched.
   *  - BANK: both account number AND IFSC must be present on the snapshot (a null snapshot would
   *    otherwise match `bankAccountNumber: null` on a partner with no bank details) and equal.
   *  - A snapshot with neither rail → no-op.
   */
  private async updatePartnerIfSnapshotRailMatches(
    tx: Prisma.TransactionClient,
    txn: { partnerId: string; upiId: string | null; bankAccountNumber: string | null; ifscCode: string | null },
    status: Prisma.ChannelPartnerWhereInput['paymentDetailsStatus'],
    data: Prisma.ChannelPartnerUpdateManyMutationInput,
  ): Promise<void> {
    if (txn.upiId) {
      const current = await tx.channelPartner.findFirst({
        where: { id: txn.partnerId, paymentDetailsStatus: status },
        select: { upiId: true },
      });
      const currentUpi = normalizeIdentityValue('upi', current?.upiId);
      if (current?.upiId && currentUpi && currentUpi === normalizeIdentityValue('upi', txn.upiId)) {
        await tx.channelPartner.updateMany({
          where: { id: txn.partnerId, paymentDetailsStatus: status, upiId: current.upiId },
          data,
        });
      }
    } else if (txn.bankAccountNumber && txn.ifscCode) {
      await tx.channelPartner.updateMany({
        where: {
          id: txn.partnerId,
          paymentDetailsStatus: status,
          bankAccountNumber: txn.bankAccountNumber,
          ifscCode: txn.ifscCode,
        },
        data,
      });
    }
  }

  /**
   * Create a QUEUED MessageDeliveryReceipt (channel WHATSAPP) for a to-be-sent payout-credit
   * notification. Returns `{ id, crqid }` or null when a receipt can't be written — BEST-EFFORT:
   * every failure (feature off, missing clientId, pre-migration table, transient DB error) is
   * swallowed with a log and returns null (the send then proceeds without a crqid).
   *
   * The crqid is 32 hex chars from Node's built-in `crypto` (alphanumeric, hyphen-free per the
   * MSG91 CRQID constraint) — NO external dependency (a new npm dep would pass gates but crash at boot).
   */
  private async createReceipt(
    clientId: string,
    recipientPhone: string,
  ): Promise<{ id: string; crqid: string } | null> {
    // M2 dormancy gate — the ENTIRE delivery-receipt feature is OFF unless DELIVERY_RECEIPTS_ENABLED
    // === 'true'. Returning null here makes the payout notification byte-identical to pre-feature
    // behaviour (no receipt row, WhatsApp fires the 3-arg send with NO crqid).
    if (process.env.DELIVERY_RECEIPTS_ENABLED !== 'true') return null;
    // Never write an unscoped receipt — an empty clientId would mis-scope the row in the per-tenant
    // (D4) delivery report.
    if (!clientId?.trim()) return null;
    const crqid = randomBytes(16).toString('hex');
    try {
      return await this.prisma.messageDeliveryReceipt.create({
        data: {
          clientId,
          channel: 'WHATSAPP',
          crqid,
          eventKey: PAYOUT_NOTIFY_EVENT_KEY,
          recipientPhone,
          status: 'QUEUED',
        },
        select: { id: true, crqid: true },
      });
    } catch (e) {
      this.logger.warn(`[payout-whatsapp] delivery-receipt create skipped: ${e}`);
      return null;
    }
  }

  /**
   * Flip a receipt QUEUED→SENT (guarded on status:'QUEUED' so it's idempotent and can never be
   * downgraded from a terminal state later). BEST-EFFORT + billing-safe: a billed send must persist
   * SENT if at all possible, so we NEVER throw and NEVER write FAILED here — a total failure logs.
   */
  private async markReceiptSent(
    receipt: { id: string } | null,
    requestId: string | null,
  ): Promise<void> {
    if (!receipt) return;
    try {
      await this.prisma.messageDeliveryReceipt.updateMany({
        where: { id: receipt.id, status: 'QUEUED' },
        data: { status: 'SENT', sentAt: new Date(), msg91RequestId: requestId ?? undefined },
      });
    } catch (e) {
      this.logger.warn(
        `[payout-whatsapp] receipt ${receipt.id} SENT write failed (left non-FAILED to avoid a false failure on a billed send): ${e}`,
      );
    }
  }

  /**
   * Flip a receipt QUEUED→FAILED (guarded on status:'QUEUED'). Only ever applies to a receipt that
   * was never marked SENT — i.e. the send genuinely threw (unbilled). A receipt already SENT (billed
   * message) does NOT match the guard, so a billed message's receipt is never downgraded to FAILED.
   */
  private async markReceiptFailed(
    receipt: { id: string } | null,
    reason: string,
  ): Promise<void> {
    if (!receipt) return;
    try {
      await this.prisma.messageDeliveryReceipt.updateMany({
        where: { id: receipt.id, status: 'QUEUED' },
        data: { status: 'FAILED', failureReason: reason.slice(0, 500) },
      });
    } catch (e) {
      this.logger.warn(`[payout-whatsapp] receipt ${receipt.id} FAILED write failed: ${e}`);
    }
  }
}
