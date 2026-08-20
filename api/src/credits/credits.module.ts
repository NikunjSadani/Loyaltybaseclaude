import { Module } from '@nestjs/common';
import { CreditsController } from './credits.controller';
import { CreditsService } from './credits.service';
import { PrismaModule } from '../prisma/prisma.module';
import { WalletModule } from '../wallet/wallet.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { TdsModule } from '../tds/tds.module';

@Module({
  imports: [PrismaModule, WalletModule, InvoicesModule, TdsModule],
  controllers: [CreditsController],
  providers: [CreditsService],
})
export class CreditsModule {}
