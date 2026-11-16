import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { HubbleModule } from '../hubble/hubble.module';
import { VoucherDispersalController, VoucherDispersalDrainController } from './voucher-dispersal.controller';
import { VoucherDispersalService } from './voucher-dispersal.service';
import { VoucherDispersalProcessor } from './voucher-dispersal.processor';

/**
 * Voucher Dispersal (platform/docs/plans/VOUCHER-DISPERSAL.md) — platform-level Gifsy admin tool.
 * NotificationsService comes from the @Global NotificationsModule. The Hubble webhook (registered by
 * RewardsModule) reaches VoucherDispersalProcessor lazily through ModuleRef for `vd…` references, so
 * there is no module import cycle.
 */
@Module({
  imports: [PrismaModule, HubbleModule],
  controllers: [VoucherDispersalController, VoucherDispersalDrainController],
  providers: [VoucherDispersalService, VoucherDispersalProcessor],
  exports: [VoucherDispersalProcessor],
})
export class VoucherDispersalModule {}
