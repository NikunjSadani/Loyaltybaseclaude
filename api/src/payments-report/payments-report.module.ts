import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentsReportController } from './payments-report.controller';
import { PaymentsReportService } from './payments-report.service';

/**
 * Payments Report — READ-ONLY report + .xlsx export of all payout PAYMENTS in a date range, across
 * ALL payout streams (visibility 194C + incentive/standard). Sibling of the visibility-payout TDS
 * report (TdsInvoicingModule) but cross-stream (no tdsSection filter) and paidAt-ranged.
 */
@Module({
  imports: [PrismaModule],
  controllers: [PaymentsReportController],
  providers: [PaymentsReportService],
})
export class PaymentsReportModule {}
