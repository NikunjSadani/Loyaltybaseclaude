import { Module } from '@nestjs/common';
import { SalesService } from './sales.service';
import { SalesController } from './sales.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports:     [PrismaModule, WalletModule],
  controllers: [SalesController],
  providers:   [SalesService],
  exports:     [SalesService],
})
export class SalesModule {}