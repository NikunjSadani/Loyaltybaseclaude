import { Module } from '@nestjs/common';
import { HubbleService } from './hubble.service';

/**
 * Hubble Money API client module. Provides the dependency-free HTTP adapter
 * (HubbleService) that RewardsService composes for GIFT_CARD auto-issuance.
 *
 * Deliberately has NO dependency on RewardsModule — the webhook controller that
 * calls RewardsService is registered by RewardsModule instead, so there is no
 * circular module import. ConfigModule is global (app.module), so ConfigService
 * injects without an explicit import here.
 */
@Module({
  providers: [HubbleService],
  exports: [HubbleService],
})
export class HubbleModule {}
