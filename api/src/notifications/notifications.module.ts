import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

/** Global so any domain (rewards, kyc, payouts) can inject NotificationsService to enqueue. */
@Global()
@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
