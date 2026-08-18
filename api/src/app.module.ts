import { Module }                   from '@nestjs/common';
import { ConfigModule }             from '@nestjs/config';
import { isFixedOtpAllowed }        from './common/fixed-otp';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule }           from '@nestjs/schedule';
import { LoggerModule }             from 'nestjs-pino';
import { buildLoggerParams }        from './common/logging/logger.config';

import { AppController }  from './app.controller';
import { AppService }     from './app.service';
import { JwtAuthGuard }   from './common/guards/jwt-auth.guard';
import { RolesGuard }     from './common/guards/roles.guard';
import { TenantGuard }    from './common/guards/tenant.guard';
import { PermissionGuard } from './common/guards/permission.guard';
import { GifsyRoleService } from './common/rbac/gifsy-role.service';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { AllExceptionsFilter }  from './common/filters/all-exceptions.filter';

import { PrismaModule }   from './prisma/prisma.module';
import { StorageModule }  from './storage/storage.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AuthModule }     from './auth/auth.module';
import { TenantModule }   from './tenant/tenant.module';
import { TicketsModule }  from './tickets/tickets.module';
import { WalletModule }   from './wallet/wallet.module';
import { GifsyModule }    from './gifsy/gifsy.module';
import { VisibilityModule } from './visibility/visibility.module';
import { RewardsModule }  from './rewards/rewards.module';
import { PartnerModule }  from './partner/partner.module';
import { KycModule }      from './kyc/kyc.module';
import { SalesModule }    from './sales/sales.module';
import { PayoutsModule }  from './payouts/payouts.module';
import { ReportsModule }  from './reports/reports.module';
import { SchemesModule }  from './schemes/schemes.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { CreditsModule }  from './credits/credits.module';
import { AdminOutletsModule } from './admin-outlets/admin-outlets.module';
import { AdminCoreModule } from './admin-core/admin-core.module';
import { AdminProgramsModule } from './admin-programs/admin-programs.module';
import { TargetsModule }      from './targets/targets.module';
import { InvoicesModule }     from './invoices/invoices.module';
import { TdsModule }          from './tds/tds.module';
import { TdsInvoicingModule } from './tds-invoicing/tds-invoicing.module';
import { PushModule }         from './push/push.module';
import { TenantRoutingModule } from './tenant-routing/tenant-routing.module';
// Phase S (S1): World-A domain modules deleted. The real domain (users, partners,
// kyc, outlets, sales, wallet, payouts, schemes/campaigns, targets, admin, visibility,
// leaderboard, notifications) is rebuilt from platform/lib as services in S3/S4.

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Structured logging (Chunk O1) — nestjs-pino. JSON to stdout in prod
    // (Cloud Logging), pretty single-line in dev. Registered near the top so
    // the pino logger is available to feature modules below.
    LoggerModule.forRootAsync({ useFactory: buildLoggerParams }),
    // Background-jobs scaffold — domain cron jobs (notifications worker, points
    // expiry) are re-added as the real domain is ported from platform/lib (S3/S4).
    ScheduleModule.forRoot(),
    // Rate limiting — applied globally; OTP endpoints have tighter limits set
    // directly on the controller with @Throttle({ default: { limit, ttl } }).
    // Default here: 60 requests per minute per IP (generous for API consumers).
    ThrottlerModule.forRoot({
      throttlers: [{
        name:  'default',
        ttl:   60_000,  // 1 minute window (ms)
        limit: 60,
      }],
      // Skip ALL rate limiting when FIXED_OTP is honored here (local dev + the E2E harness,
      // whose real-login setup makes several OTP requests per run). Gated by isFixedOtpAllowed
      // (non-prod NODE_ENV, or an explicit ALLOW_FIXED_OTP opt-in; always refused on the prod
      // DB), so throttling can never be disabled on the real production data plane.
      skipIf: () => isFixedOtpAllowed() && !!process.env.FIXED_OTP,
    }),
    PrismaModule,
    StorageModule,
    NotificationsModule,
    AuthModule,
    TenantModule,
    TicketsModule,
    WalletModule,
    GifsyModule,
    VisibilityModule,
    RewardsModule,
    PartnerModule,
    KycModule,
    SalesModule,
    PayoutsModule,
    ReportsModule,
    SchemesModule,
    LeaderboardModule,
    CreditsModule,
    AdminOutletsModule,
    AdminCoreModule,
    AdminProgramsModule,
    TargetsModule,
    InvoicesModule,
    TdsModule,
    TdsInvoicingModule,
    PushModule,
    TenantRoutingModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Standard response envelope { success, data } / { success, error } — the
    // backend half of the contract lib/api-client.ts expects (replaces api-response.ts).
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER,      useClass: AllExceptionsFilter },
    // Rate limiter applied before auth so bots can't enumerate tokens
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Apply JWT auth globally — use @Public() to opt out
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Tenant chokepoint (S5): after JWT (so req.user exists), asserts a tenant is
    // resolved on every authenticated request + stamps req.tenantId. Defense-in-depth;
    // DB-level isolation (RLS / Prisma auto-scope) is Gap #23 → P8.6.
    { provide: APP_GUARD, useClass: TenantGuard },
    // RBAC permission enforcement — flag-gated, no-op unless @RequirePermission + flags on
    { provide: APP_GUARD, useClass: PermissionGuard },
    // RBAC Option-X — resolves a GIFSY_STAFF user's GifsyRole permissions (injected by
    // PermissionGuard). PrismaModule is @Global, so no extra imports are needed.
    GifsyRoleService,
  ],
})
export class AppModule {}
