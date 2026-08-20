import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminCoreService } from './admin-core.service';
import { AdminUsersController } from './users.controller';
import { AdminSalesUsersController } from './sales-users.controller';
import { AdminSettingsController } from './settings.controller';
import { AdminHierarchyConfigController } from './hierarchy-config.controller';
import { AdminForceLogoutAllController } from './force-logout-all.controller';
import { AdminDashboardController } from './dashboard.controller';
import { AdminTaskConfigController } from './task-config.controller';
import { AdminGiftConfigController } from './gift-config.controller';
import { ProgramHealthDashboardService } from './dashboards/program-health-dashboard.service';
import { OperationsDashboardService } from './dashboards/operations-dashboard.service';
import { FinanceDashboardService } from './dashboards/finance-dashboard.service';
import { PayoutsModule } from '../payouts/payouts.module';
import { TdsModule } from '../tds/tds.module';

/**
 * AdminCoreModule — the ported admin sub-domains (users, settings,
 * hierarchy-config, force-logout-all, dashboard, task-config,
 * gift-config) as ONE module with ONE path-mirrored controller per sub-domain
 * and ONE cohesive AdminCoreService. Re-homed from platform/src/app/api/admin/*.
 *
 * TenantService (used by admin/settings/config) is @Global and needs no import.
 */
@Module({
  imports: [PrismaModule, PayoutsModule, TdsModule],
  controllers: [
    AdminUsersController,
    AdminSalesUsersController,
    AdminSettingsController,
    AdminHierarchyConfigController,
    AdminForceLogoutAllController,
    AdminDashboardController,
    AdminTaskConfigController,
    AdminGiftConfigController,
  ],
  providers: [
    AdminCoreService,
    ProgramHealthDashboardService,
    OperationsDashboardService,
    FinanceDashboardService,
  ],
  // Exported so GifsyModule can reuse the SAME per-tenant settings writes
  // (upsertSetting / setPointsExpiry) for the GIFSY-operator tenant-targeted
  // wallet-settings path — never a re-implementation of the money-path logic.
  exports: [AdminCoreService],
})
export class AdminCoreModule {}
