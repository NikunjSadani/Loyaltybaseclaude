import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsStatusController } from './notifications-status.controller';
import { SalesNotificationsService } from './sales-notifications.service';
import { Msg91Service } from './msg91.service';
import { MessageDeliveryStatusService } from './message-delivery-status.service';
import { NotificationDeliveryReportController } from './notification-delivery-report.controller';
import { NotificationDeliveryReportService } from './notification-delivery-report.service';
import { NotificationDeliveryRetentionWorker } from './notification-delivery-retention.worker';

/**
 * Global so any domain (rewards, kyc, payouts) can inject NotificationsService to enqueue.
 *
 * MessageDeliveryStatusService (shared, channel-agnostic delivery-status ingestion — D3) is
 * exported so Wave 2 (transactional WhatsApp) can inject it unchanged. Its only deps are the
 * @Global() PrismaService + the in-module Msg91Service, so no cross-module inject / DI cycle is
 * introduced (no lazy ModuleRef needed).
 *
 * Wave 4 (reporting): NotificationDeliveryReportController/Service serve the operator+tenant
 * delivery-status report (D4, tenant-scoped via tenantScope), and NotificationDeliveryRetentionWorker
 * prunes receipts past the 90-day window (dormant, env-gated). All only depend on the @Global()
 * PrismaService + the in-module MessageDeliveryStatusService — no new cross-module DI.
 */
@Global()
@Module({
  controllers: [
    NotificationsController,
    NotificationsStatusController,
    NotificationDeliveryReportController,
  ],
  providers: [
    NotificationsService,
    SalesNotificationsService,
    Msg91Service,
    MessageDeliveryStatusService,
    NotificationDeliveryReportService,
    NotificationDeliveryRetentionWorker,
  ],
  exports: [
    NotificationsService,
    SalesNotificationsService,
    Msg91Service,
    MessageDeliveryStatusService,
  ],
})
export class NotificationsModule {}
