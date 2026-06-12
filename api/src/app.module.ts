import { Module }                   from '@nestjs/common';
import { ConfigModule }             from '@nestjs/config';
import { APP_GUARD }                from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule }           from '@nestjs/schedule';

import { AppController }  from './app.controller';
import { AppService }     from './app.service';
import { JwtAuthGuard }   from './common/guards/jwt-auth.guard';
import { RolesGuard }     from './common/guards/roles.guard';

import { PrismaModule }   from './prisma/prisma.module';
import { AuthModule }     from './auth/auth.module';
import { TenantModule }   from './tenant/tenant.module';
import { UsersModule }    from './users/users.module';
import { PartnersModule } from './partners/partners.module';
import { KycModule }      from './kyc/kyc.module';
import { OutletsModule }  from './outlets/outlets.module';
import { SkusModule }     from './skus/skus.module';
import { SalesModule }    from './sales/sales.module';
import { WalletModule }   from './wallet/wallet.module';
import { PayoutsModule }  from './payouts/payouts.module';
import { SchemesModule }  from './schemes/schemes.module';
import { TargetsModule }  from './targets/targets.module';
import { AdminModule }         from './admin/admin.module';
import { RewardsModule }       from './rewards/rewards.module';
import { VisibilityModule }    from './visibility/visibility.module';
import { LeaderboardModule }   from './leaderboard/leaderboard.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Background jobs: notifications worker (every minute) + points expiry (daily 00:05)
    ScheduleModule.forRoot(),
    // Rate limiting — applied globally; OTP endpoints have tighter limits set
    // directly on the controller with @Throttle({ default: { limit, ttl } }).
    // Default here: 60 requests per minute per IP (generous for API consumers).
    ThrottlerModule.forRoot([{
      name:  'default',
      ttl:   60_000,  // 1 minute window (ms)
      limit: 60,
    }]),
    PrismaModule,
    AuthModule,
    TenantModule,
    UsersModule,
    PartnersModule,
    KycModule,
    OutletsModule,
    SkusModule,
    SalesModule,
    WalletModule,
    PayoutsModule,
    SchemesModule,
    TargetsModule,
    AdminModule,
    RewardsModule,
    VisibilityModule,
    LeaderboardModule,
    NotificationsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Rate limiter applied before auth so bots can't enumerate tokens
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Apply JWT auth globally — use @Public() to opt out
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
