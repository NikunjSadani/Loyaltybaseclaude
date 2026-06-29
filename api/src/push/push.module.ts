import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PushController } from './push.controller';
import { PushSubscriptionService } from './push-subscription.service';
import { PushSenderService } from './push-sender.service';
import { PushDeliveryWorker } from './push-delivery.worker';
import { PwaAdoptionService } from './pwa-adoption.service';

/**
 * Web Push (PWA) module — subscribe/unsubscribe + VAPID key endpoint, the sender
 * (VAPID identity + per-endpoint dispatch/prune), and the drain worker (gated OFF by
 * PUSH_WORKER_ENABLED). PushSenderService is exported so domains can also send a push
 * directly if needed; the standard path is enqueue → drain worker.
 *
 * NotificationsService (used by the wallet/redemption/KYC triggers to enqueue PUSH
 * rows) comes from the @Global() NotificationsModule, so no import is needed here.
 */
@Module({
  imports: [PrismaModule],
  controllers: [PushController],
  providers: [PushSubscriptionService, PushSenderService, PushDeliveryWorker, PwaAdoptionService],
  exports: [PushSenderService],
})
export class PushModule {}
