import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { Msg91Service } from './msg91.service';

/** Global so any domain (rewards, kyc, payouts) can inject NotificationsService to enqueue. */
@Global()
@Module({
  providers: [NotificationsService, Msg91Service],
  exports: [NotificationsService, Msg91Service],
})
export class NotificationsModule {}
