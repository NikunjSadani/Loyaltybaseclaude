import {
  Injectable, BadRequestException, NotFoundException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';

const POINTS_TO_PAISE = 100; // 1 point = ₹1 = 100 paise

// â”€â”€ TDS constants (194C) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Single transaction threshold: â‚¹30,000 = 3,000,000 paise
// Annual threshold:             â‚¹1,00,000 = 10,000,000 paise
// TDS rate:                     2% (for companies / partnerships)
const TDS_SINGLE_THRESHOLD_PAISE = 3_000_000;
const TDS_ANNUAL_THRESHOLD_PAISE = 10_000_000;
const TDS_RATE                   = 0.02;
const MIN_PAYOUT_PAISE           = 10_000;   // â‚¹100

export interface TdsResult {
  tdsApplicable: boolean;
  tdsPaise:      number;
  netPaise:      number;
}

interface RequestPayoutDto {
  partnerId:         string;
  clientId:          string;
  amountPaise:       number;
  bankAccountNumber: string;
  ifscCode:          string;
  beneficiaryName:   string;
  beneficiaryPhone?: string;
  bankName?:         string;
  notes?:            string;
}

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma:  PrismaService,
    private readonly wallets: WalletService,
  ) {}

  // â”€â”€ TDS calculation (pure â€” no DB, easy to test) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Calculate 194C TDS for a payout.
   * @param amountPaise      The payout amount in paise
   * @param annualTotalPaise Sum of all previous payouts this financial year (paise)
   */
  calculateTds(amountPaise: number, annualTotalPaise: number): TdsResult {
    const crossesSingle = amountPaise >= TDS_SINGLE_THRESHOLD_PAISE;
    const crossesAnnual = (annualTotalPaise + amountPaise) >= TDS_ANNUAL_THRESHOLD_PAISE;

    const tdsApplicable = crossesSingle || crossesAnnual;
    const tdsPaise = tdsApplicable
      ? Math.floor(amountPaise * TDS_RATE)
      : 0;

    return {
      tdsApplicable,
      tdsPaise,
      netPaise: amountPaise - tdsPaise,
    };
  }

  // â”€â”€ Request payout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async requestPayout(dto: RequestPayoutDto) {
    if (dto.amountPaise < MIN_PAYOUT_PAISE) {
      throw new BadRequestException(
        `Minimum payout is â‚¹${MIN_PAYOUT_PAISE / 100}. Requested: â‚¹${dto.amountPaise / 100}.`,
      );
    }

    const partner = await this.prisma.channelPartner.findFirst({
      where: { id: dto.partnerId, clientId: dto.clientId, deletedAt: null },
    });
    if (!partner) throw new NotFoundException('Partner not found.');

    const wallet = await this.prisma.wallet.findFirst({ where: { partnerId: dto.partnerId } });
    if (!wallet) throw new NotFoundException('Wallet not found for partner.');

    // Points â†’ paise: 1 pt = 100 paise
    const walletPaise = wallet.redeemablePoints * 100;
    if (walletPaise < dto.amountPaise) {
      throw new BadRequestException(
        `Insufficient wallet balance. Available: â‚¹${walletPaise / 100}, requested: â‚¹${dto.amountPaise / 100}.`,
      );
    }

    // Get annual payout total for TDS (Indian FY: Apr 1 – Mar 31)
    const now = new Date();
    const fyStart = new Date(
      now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1,
      3, 1,
    );
    const annualAgg = await this.prisma.payoutTransaction.aggregate({
      where: { partnerId: dto.partnerId, status: 'SUCCESS' as any, completedAt: { gte: fyStart } },
      _sum:  { amountPaise: true } as any,
    });
    const annualTotal = (annualAgg._sum as any)?.amountPaise ?? 0;

    const { tdsApplicable, tdsPaise, netPaise } = this.calculateTds(dto.amountPaise, annualTotal);

    const payout = await this.prisma.payoutTransaction.create({
      data: {
        partnerId:         dto.partnerId,
        payoutMode:        'BANK_TRANSFER' as any,
        status:            'PENDING' as any,
        amountPaise:       dto.amountPaise,
        beneficiaryName:   dto.beneficiaryName,
        beneficiaryPhone:  dto.beneficiaryPhone ?? null,
        bankAccountNumber: dto.bankAccountNumber,
        ifscCode:          dto.ifscCode,
        bankName:          dto.bankName ?? null,
        tdsApplicable,
        tdsPaise,
        netAmountPaise:    netPaise,
      },
    });

    // Burn wallet points immediately — 1 point = ₹1 = 100 paise
    await this.wallets.burnPoints({
      partnerId:     dto.partnerId,
      points:        Math.floor(dto.amountPaise / POINTS_TO_PAISE),
      referenceType: 'PAYOUT',
      referenceId:   payout.id,
      description:   `Payout request ₹${dto.amountPaise / 100}`,
    });

    this.logger.log(
      `Payout ${payout.id} created for ${dto.partnerId}: ₹${dto.amountPaise / 100}, TDS: ₹${tdsPaise / 100}`,
    );
    return payout;
  }

  // â”€â”€ Create batch (groups all PENDING payouts for a client) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async createBatch(dto: { clientId: string; createdByUserId: string; notes?: string }) {
    const pending = await this.prisma.payoutTransaction.findMany({
      where: { status: 'PENDING' as any, batchId: null, partner: { clientId: dto.clientId } as any },
    });

    if (!pending.length) {
      throw new BadRequestException('No pending payout transactions to batch.');
    }

    const totalNetPaise = pending.reduce((sum, t) => sum + t.netAmountPaise, 0);
    const batchCode     = `BATCH-${Date.now().toString(36).toUpperCase()}`;

    const batch = await this.prisma.payoutBatch.create({
      data: {
        clientId:         dto.clientId,
        batchCode,
        status:           'DRAFT' as any,
        payoutMode:       'BANK_TRANSFER' as any,
        totalAmountPaise: totalNetPaise,
        transactionCount: pending.length,
        createdByUserId:  dto.createdByUserId,
        notes:            dto.notes ?? null,
      },
    });

    await this.prisma.payoutTransaction.updateMany({
      where: { id: { in: pending.map(p => p.id) } },
      data:  { batchId: batch.id },
    });

    this.logger.log(`Batch ${batchCode} created: ${pending.length} txns, â‚¹${totalNetPaise / 100}`);
    return batch;
  }

  // â”€â”€ Upload payout results (UTR + success/failure per row) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async uploadPayoutResults(
    batchId: string,
    rows: Array<{
      transactionId: string;
      status:        'SUCCESS' | 'FAILED';
      utrNumber?:    string;
      paymentDate:   string;
      failureReason?: string;
    }>,
    adminUserId: string,
  ) {
    const batch = await this.prisma.payoutBatch.findFirst({ where: { id: batchId } });
    if (!batch) throw new NotFoundException(`Batch ${batchId} not found.`);

    let successCount = 0;
    let failureCount = 0;
    const errors: string[] = [];

    for (const row of rows) {
      try {
        const txn = await this.prisma.payoutTransaction.findFirst({
          where: { id: row.transactionId, batchId },
        });
        if (!txn) { errors.push(`${row.transactionId}: not found in batch`); continue; }

        await this.prisma.payoutTransaction.update({
          where: { id: row.transactionId },
          data: {
            status:         row.status as any,
            providerRefId:  row.utrNumber ?? null,
            completedAt:    new Date(row.paymentDate),
            failureReason:  row.failureReason ?? null,
          },
        });

        row.status === 'SUCCESS' ? successCount++ : failureCount++;
      } catch (e) {
        errors.push(`${row.transactionId}: ${(e as Error).message}`);
      }
    }

    // Update batch counts
    await this.prisma.payoutBatch.update({
      where: { id: batchId },
      data: {
        successCount,
        failureCount,
        status:      'COMPLETED' as any,
        completedAt: new Date(),
      },
    });

    this.logger.log(`Batch ${batchId} results uploaded: ${successCount} success, ${failureCount} failed`);
    return { successCount, failureCount, errors };
  }

  // â”€â”€ List payouts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async listPayouts(opts: {
    partnerId?: string;
    clientId?:  string;
    status?:    string;
    page?:      number;
    limit?:     number;
  } = {}) {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 20;
    const skip  = (page - 1) * limit;
    const where: any = {};
    if (opts.partnerId) where.partnerId = opts.partnerId;
    if (opts.status)    where.status    = opts.status;

    const [data, total] = await Promise.all([
      this.prisma.payoutTransaction.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.payoutTransaction.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }
}
