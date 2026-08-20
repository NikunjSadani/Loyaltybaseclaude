import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminCoreModule } from '../admin-core/admin-core.module';
import { TdsModule } from '../tds/tds.module';
import { GstReimbursementController } from './gst-reimbursement.controller';
import { GstReimbursementService } from './gst-reimbursement.service';
import { TdsReportsController } from './tds-reports.controller';
import { TdsReportsService } from './tds-reports.service';
import { TdsConfigController } from './tds-config.controller';
import { TdsStatutoryController } from './tds-statutory.controller';

/**
 * Visibility-led payouts — the Gifsy-portal side: GST-reimbursement (holdback release),
 * TDS reports (payout w/ GST-reg-type, unregistered/RCM, tenant recovery/attribution), and
 * the Gifsy-only per-tenant TDS-config write. AdminCoreModule provides AdminCoreService
 * (config write path → the W0-C AuditLog); TenantSettingsService is @Global.
 */
@Module({
  // TdsModule provides TdsStatutoryConfigService (the FY-effective statutory-config resolver) for
  // the platform admin controller below. AdminCoreModule imports TdsModule already; TdsModule
  // imports only PrismaModule, so this adds no cycle.
  imports: [PrismaModule, AdminCoreModule, TdsModule],
  controllers: [
    GstReimbursementController,
    TdsReportsController,
    TdsConfigController,
    TdsStatutoryController,
  ],
  providers: [GstReimbursementService, TdsReportsService],
})
export class TdsInvoicingModule {}
