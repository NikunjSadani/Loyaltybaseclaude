import { Module } from '@nestjs/common';
import { GiftCatalogueController } from './gift-catalogue.controller';
import { DispatchController } from './dispatch.controller';
import { GiftCatalogueService } from './gift-catalogue.service';
import { GiftBackfillService } from './gift-backfill.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RewardsModule } from '../rewards/rewards.module';

/**
 * Gift Catalogue & Dispatch (Wave 1) — PLATFORM master catalogue + publish + the
 * cross-tenant fulfilment console. TenantSettingsService is @Global (conversion
 * rate for publish/backfill). The dispatch console reuses RewardsService's guarded
 * order lifecycle, so RewardsModule is imported (and exports RewardsService).
 * Vendor authoring + the vendor portal are Wave 2.
 */
@Module({
  imports: [PrismaModule, RewardsModule],
  controllers: [GiftCatalogueController, DispatchController],
  providers: [GiftCatalogueService, GiftBackfillService],
})
export class GiftCatalogueModule {}
