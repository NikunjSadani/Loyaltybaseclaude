import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { VendorAdminController } from './vendor-admin.controller';
import { AdminTenantsController } from './admin-tenants.controller';
import { VendorPortalController } from './vendor-portal.controller';
import { GiftDisbursalController } from './gift-disbursal.controller';
import { VendorAdminService } from './vendor-admin.service';
import { VendorPortalService } from './vendor-portal.service';
import { GiftDisbursalService } from './gift-disbursal.service';

/**
 * Gift Catalogue & Dispatch — Wave 2 VENDOR module. Gifsy vendor management
 * (/v1/admin/vendors), the hard-scoped vendor portal (/v1/vendor/*), and the
 * tenant-accessible Gift Disbursal report (/v1/admin/gift-disbursal).
 *
 * TenantSettingsService + NotificationsService are @Global (conversion rate for
 * vendor pricing; member notifications on vendor dispatch/deliver), so only
 * PrismaModule is imported here.
 */
@Module({
  imports: [PrismaModule],
  controllers: [
    VendorAdminController,
    AdminTenantsController,
    VendorPortalController,
    GiftDisbursalController,
  ],
  providers: [VendorAdminService, VendorPortalService, GiftDisbursalService],
})
export class VendorModule {}
