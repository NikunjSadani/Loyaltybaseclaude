import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { SalesNotificationsService } from './sales-notifications.service';
import { Msg91Service } from './msg91.service';

/** Global so any domain (rewards, kyc, payouts) can inject NotificationsService to enqueue. */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, SalesNotificationsService, Msg91Service],
  exports: [NotificationsService, SalesNotificationsService, Msg91Service],
})
export class NotificationsModule {}
