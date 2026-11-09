import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SalesProfileService } from './sales-profile.service';
import { SalesKpiDefService } from './sales-kpi-def.service';
import { SalesMonthsService } from '../months/sales-months.service';
import { SalesPreviewService } from '../apply/sales-preview.service';
import { SalesApplyService } from '../apply/sales-apply.service';

/**
 * Lane K's providers (kpi/**, months/**, apply/**). OWNER: Lane K — add new K injectables (incl. the
 * D-1 SalesMonthClosedGuard's dependencies) HERE, never in sales-import.module.ts. This module has NO
 * controllers and does not import the points engine, so PointsEngineModule can import it for the D-1
 * guard without a circular import.
 */
const PROVIDERS = [SalesProfileService, SalesKpiDefService, SalesMonthsService, SalesPreviewService, SalesApplyService];

@Module({
  imports: [PrismaModule],
  providers: PROVIDERS,
  exports: PROVIDERS,
})
export class SalesImportKpiModule {}
