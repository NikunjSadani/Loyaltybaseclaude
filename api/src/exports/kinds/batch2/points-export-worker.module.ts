import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../../../admin-core/admin-core.module';
import { CreditsModule } from '../../../credits/credits.module';
import { PointsComputeService } from '../../../points-engine/points-compute.service';
import { PointsEngineService } from '../../../points-engine/points-engine.service';

/**
 * WORKER-ONLY: provides PointsComputeService to the gifsy-exports job for the `points-*` kinds WITHOUT
 * PointsEngineModule — that module declares HTTP controllers (PointsComputeController injects ExportsService, which the
 * worker does not load). Same providers and imports as PointsEngineModule; the kinds only call previewCompute
 * (read-only — no wallet write, no CreditBatch). Never import this into AppModule (the API gets the service from
 * PointsEngineModule).
 */
@Module({
  imports: [CreditsModule, AdminCoreModule],
  providers: [PointsEngineService, PointsComputeService],
})
export class PointsExportWorkerModule {}
