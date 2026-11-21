import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { PrismaModule } from '../prisma/prisma.module';
import { HeldOpeningBalancesController } from './held-opening-balances/held-opening-balances.controller';
import { HeldOpeningBalancesService } from './held-opening-balances/held-opening-balances.service';
import { HeldOpeningBalancesSweepWorker } from './held-opening-balances/held-opening-balances.sweep.worker';

@Module({
  imports: [PrismaModule],
  controllers: [WalletController, HeldOpeningBalancesController],
  providers: [WalletService, HeldOpeningBalancesService, HeldOpeningBalancesSweepWorker],
  // WalletService: consumed by RewardsModule (5.4a redemption debit/refund).
  // HeldOpeningBalancesService: the Daily Ops Digest reads its figures (ReportsModule).
  exports: [WalletService, HeldOpeningBalancesService],
})
export class WalletModule {}
