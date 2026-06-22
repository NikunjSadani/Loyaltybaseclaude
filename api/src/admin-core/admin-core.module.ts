import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminCoreService } from './admin-core.service';
import { AdminUsersController } from './users.controller';
import { AdminSettingsController } from './settings.controller';
import { AdminHierarchyConfigController } from './hierarchy-config.controller';
import { AdminForceLogoutAllController } from './force-logout-all.controller';
import { AdminDashboardController } from './dashboard.controller';
import { AdminTaskConfigController } from './task-config.controller';
import { AdminGiftConfigController } from './gift-config.controller';

/**
 * AdminCoreModule — the ported admin sub-domains (users, settings,
 * hierarchy-config, force-logout-all, dashboard, task-config,
 * gift-config) as ONE module with ONE path-mirrored controller per sub-domain
 * and ONE cohesive AdminCoreService. Re-homed from platform/src/app/api/admin/*.
 *
 * TenantService (used by admin/settings/config) is @Global and needs no import.
 */
@Module({
  imports: [PrismaModule],
  controllers: [
    AdminUsersController,
    AdminSettingsController,
    AdminHierarchyConfigController,
    AdminForceLogoutAllController,
    AdminDashboardController,
    AdminTaskConfigController,
    AdminGiftConfigController,
  ],
  providers: [AdminCoreService],
})
export class AdminCoreModule {}
