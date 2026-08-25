import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsStatusController } from './notifications-status.controller';
import { SalesNotificationsService } from './sales-notifications.service';
import { Msg91Service } from './msg91.service';
import { MessageDeliveryStatusService } from './message-delivery-status.service';

/**
 * Global so any domain (rewards, kyc, payouts) can inject NotificationsService to enqueue.
 *
 * MessageDeliveryStatusService (shared, channel-agnostic delivery-status ingestion — D3) is
 * exported so Wave 2 (transactional WhatsApp) can inject it unchanged. Its only deps are the
 * @Global() PrismaService + the in-module Msg91Service, so no cross-module inject / DI cycle is
 * introduced (no lazy ModuleRef needed).
 */
@Global()
@Module({
  controllers: [NotificationsController, NotificationsStatusController],
  providers: [
    NotificationsService,
    SalesNotificationsService,
    Msg91Service,
    MessageDeliveryStatusService,
  ],
  exports: [
    NotificationsService,
    SalesNotificationsService,
    Msg91Service,
    MessageDeliveryStatusService,
  ],
})
export class NotificationsModule {}
