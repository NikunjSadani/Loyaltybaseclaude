import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { SalesNotificationsService } from './sales-notifications.service';
import { Msg91Service } from './msg91.service';

/** Global so any domain (rewards, kyc, payouts) can inject NotificationsService to enqueue. */
@Global()
@Module({
  providers: [NotificationsService, SalesNotificationsService, Msg91Service],
  exports: [NotificationsService, SalesNotificationsService, Msg91Service],
})
export class NotificationsModule {}
