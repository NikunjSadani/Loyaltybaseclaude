import { Module } from '@nestjs/common';
import { CreditsController } from './credits.controller';
import { CreditsService } from './credits.service';
import { CreditEvidenceService } from './credit-evidence.service';
import { PrismaModule } from '../prisma/prisma.module';
import { WalletModule } from '../wallet/wallet.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { TdsModule } from '../tds/tds.module';

@Module({
  imports: [PrismaModule, WalletModule, InvoicesModule, TdsModule],
  controllers: [CreditsController],
  providers: [CreditsService, CreditEvidenceService],
  // Exported so the Points Compute Engine (Wave 2 direct-credit path) can create + credit a
  // CreditBatch through the SAME rail as a manual upload (safety caps, confirm, reversal all reused).
  exports: [CreditsService],
})
export class CreditsModule {}
