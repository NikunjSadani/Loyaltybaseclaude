import { Module } from '@nestjs/common';
import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';
import { PrismaModule } from '../prisma/prisma.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  // WalletModule (exports WalletService) is needed by uploadPayoutUtr to reverse
  // redemption points on UTR=FAILED. WalletModule imports only PrismaModule, so
  // there is no circular dependency.
  imports: [PrismaModule, WalletModule],
  controllers: [PayoutsController],
  providers: [PayoutsService],
  // Exported so the admin Operations/Finance dashboards can reuse the fund summary.
  exports: [PayoutsService],
})
export class PayoutsModule {}
