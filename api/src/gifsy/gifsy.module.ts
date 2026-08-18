import { Module } from '@nestjs/common';
import { GifsyController } from './gifsy.controller';
import { GifsyService } from './gifsy.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminCoreModule } from '../admin-core/admin-core.module';
// RBAC Option-X P1 — self-service Gifsy staff-role management (platform-only, Owner-gated).
// GifsyRoleService (the resolver/cache) is a GLOBAL AppModule provider, so it is injectable
// here without re-declaring it.
import { GifsyRolesController } from './gifsy-roles.controller';
import { GifsyPermissionsController } from './gifsy-permissions.controller';
import { GifsyRolesService } from './gifsy-roles.service';
import { GifsyStaffController } from './gifsy-staff.controller';
import { GifsyStaffService } from './gifsy-staff.service';

@Module({
  // AdminCoreModule (exports AdminCoreService) lets the tenant-targeted wallet-settings
  // path delegate to the SAME conversion-rate / points-expiry writes the tenant Settings
  // panel uses. TenantSettingsService is @Global (no import needed).
  imports: [PrismaModule, AdminCoreModule],
  controllers: [
    GifsyController,
    GifsyRolesController,
    GifsyPermissionsController,
    GifsyStaffController,
  ],
  providers: [GifsyService, GifsyRolesService, GifsyStaffService],
})
export class GifsyModule {}
