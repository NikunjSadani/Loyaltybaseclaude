import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { KycService } from '../../../kyc/kyc.service';
import { Msg91Service } from '../../../notifications/msg91.service';
import { NotificationsService } from '../../../notifications/notifications.service';
import { SalesNotificationsService } from '../../../notifications/sales-notifications.service';

/**
 * WORKER-ONLY module for the `kyc-review-dump` / `kyc-rejected` export kinds: provides KycService (+ the notification
 * services its constructor needs) WITHOUT any controller. Importing KycModule / NotificationsModule into the exports
 * worker would also pull their controllers, which now inject ExportsService (not loaded in the worker) — DI fails.
 * The kinds only call KycService.reviewDumpPage / rejectedExportPage (reads + signed URLs); nothing is sent.
 * Listed in exports/worker-feature-modules.ts. The API itself keeps using KycModule (AppModule).
 */
@Module({
  imports: [
    // Same registration as KycModule (doc-view tokens / signing use the platform JWT_SECRET).
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.get('JWT_SECRET') }),
    }),
  ],
  providers: [KycService, NotificationsService, SalesNotificationsService, Msg91Service],
  exports: [KycService],
})
export class KycExportWorkerModule {}
