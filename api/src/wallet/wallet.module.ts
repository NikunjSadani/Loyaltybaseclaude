import { Module }              from '@nestjs/common';
import { WalletService }       from './wallet.service';
import { WalletController }    from './wallet.controller';
import { PointsExpiryService } from './points-expiry.service';
import { PrismaModule }        from '../prisma/prisma.module';

@Module({
  imports:     [PrismaModule],
  controllers: [WalletController],
  providers:   [WalletService, PointsExpiryService],
  exports:     [WalletService],
})
export class WalletModule {}