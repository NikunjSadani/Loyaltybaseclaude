import { Module } from '@nestjs/common';
import { GifsyController } from './gifsy.controller';
import { GifsyService } from './gifsy.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminCoreModule } from '../admin-core/admin-core.module';

@Module({
  // AdminCoreModule (exports AdminCoreService) lets the tenant-targeted wallet-settings
  // path delegate to the SAME conversion-rate / points-expiry writes the tenant Settings
  // panel uses. TenantSettingsService is @Global (no import needed).
  imports: [PrismaModule, AdminCoreModule],
  controllers: [GifsyController],
  providers: [GifsyService],
})
export class GifsyModule {}
