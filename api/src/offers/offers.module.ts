import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OffersAdminController, PartnerOffersController } from './offers.controller';
import { OffersAdminService } from './offers-admin.service';
import { OffersPartnerService } from './offers-partner.service';

// "This month's offers" tiles (display-only). TenantService / TenantSettingsService come from the
// @Global TenantModule, so they are injectable here without importing it.
@Module({
  imports: [PrismaModule],
  controllers: [OffersAdminController, PartnerOffersController],
  providers: [OffersAdminService, OffersPartnerService],
})
export class OffersModule {}
