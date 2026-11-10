import { Module } from '@nestjs/common';
import { TenantRoutingController } from './tenant-routing.controller';
import { TenantRoutingService } from './tenant-routing.service';
import { PublicBrandingAssetController } from './public-branding-asset.controller';

// PrismaService is provided by the @Global() PrismaModule and StorageService by the
// @Global() StorageModule, so no imports needed.
@Module({
  controllers: [TenantRoutingController, PublicBrandingAssetController],
  providers: [TenantRoutingService],
})
export class TenantRoutingModule {}
