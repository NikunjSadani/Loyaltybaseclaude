import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { PrismaModule } from '../prisma/prisma.module';
import { HeldOpeningBalancesController } from './held-opening-balances/held-opening-balances.controller';
import { HeldOpeningBalancesService } from './held-opening-balances/held-opening-balances.service';

@Module({
  imports: [PrismaModule],
  controllers: [WalletController, HeldOpeningBalancesController],
  providers: [WalletService, HeldOpeningBalancesService],
  // WalletService: consumed by RewardsModule (5.4a redemption debit/refund).
  // HeldOpeningBalancesService: the Daily Ops Digest reads its figures (ReportsModule).
  exports: [WalletService, HeldOpeningBalancesService],
})
export class WalletModule {}
