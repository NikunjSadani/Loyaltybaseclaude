import { Module } from '@nestjs/common';
import { RewardsController } from './rewards.controller';
import { AdminRewardsController } from './admin-rewards.controller';
import { RewardsService } from './rewards.service';
import { PrismaModule } from '../prisma/prisma.module';
import { WalletModule } from '../wallet/wallet.module';

// NotificationsModule is @Global, so NotificationsService injects without an import.
@Module({
  imports: [PrismaModule, WalletModule],
  controllers: [RewardsController, AdminRewardsController],
  providers: [RewardsService],
})
export class RewardsModule {}
