import { Module } from '@nestjs/common';
import { PayoutsService }    from './payouts.service';
import { PayoutsController } from './payouts.controller';
import { PrismaModule }      from '../prisma/prisma.module';
import { WalletModule }      from '../wallet/wallet.module';

@Module({
  imports:     [PrismaModule, WalletModule],
  controllers: [PayoutsController],
  providers:   [PayoutsService],
  exports:     [PayoutsService],
})
export class PayoutsModule {}