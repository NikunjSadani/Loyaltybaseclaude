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
// Phase S (S1): World-A domain modules deleted. The real domain (users, partners,
// kyc, outlets, sales, wallet, payouts, schemes/campaigns, targets, admin, visibility,
// leaderboard, notifications) is rebuilt from platform/lib as services in S3/S4.

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Background-jobs scaffold — domain cron jobs (notifications worker, points
    // expiry) are re-added as the real domain is ported from platform/lib (S3/S4).
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
