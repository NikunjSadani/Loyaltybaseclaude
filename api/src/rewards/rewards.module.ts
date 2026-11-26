import { Module } from '@nestjs/common';
import { RewardsController } from './rewards.controller';
import { AdminRewardsController } from './admin-rewards.controller';
import { AdminRewardStockController } from './admin-reward-stock.controller';
import { RewardStockService } from './reward-stock.service';
import { RewardsService } from './rewards.service';
import { HubbleOrderSweep } from './hubble-order-sweep';
import { PrismaModule } from '../prisma/prisma.module';
import { WalletModule } from '../wallet/wallet.module';
import { HubbleModule } from '../hubble/hubble.module';
import { HubbleWebhookController } from '../hubble/hubble-webhook.controller';
import { HubbleSweepController } from '../hubble/hubble-sweep.controller';

// NotificationsModule is @Global, so NotificationsService injects without an import.
// HubbleModule provides the Hubble API client; the Hubble webhook controller is
// registered HERE (not in HubbleModule) so it can inject RewardsService without a
// circular module import (RewardsModule → HubbleModule for the client; the controller
// → RewardsService, both resolved within this module).
@Module({
  imports: [PrismaModule, WalletModule, HubbleModule],
  controllers: [RewardsController, AdminRewardsController, AdminRewardStockController, HubbleWebhookController, HubbleSweepController],
  // HubbleOrderSweep: the automatic re-check of Hubble-handed orders (@Interval, like voucher dispersal).
  providers: [RewardsService, HubbleOrderSweep, RewardStockService],
  // Exported so the Gift Catalogue dispatch console can reuse the guarded order
  // lifecycle (transition/update/list) instead of re-implementing fulfilment logic.
  exports: [RewardsService],
})
export class RewardsModule {}
