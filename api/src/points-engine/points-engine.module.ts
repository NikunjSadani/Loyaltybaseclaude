import { Module } from '@nestjs/common';
import { PointsEngineController } from './points-engine.controller';
import { PointsEngineService } from './points-engine.service';
import { PointsComputeController } from './points-compute.controller';
import { PointsComputeService } from './points-compute.service';
import { PointsEngineSettingsController } from './points-engine-settings.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { CreditsModule } from '../credits/credits.module';
import { AdminCoreModule } from '../admin-core/admin-core.module';

/**
 * Points Compute Engine.
 *   - Wave 0: the versioned PointsRule config store (PointsEngineService + CRUD controller).
 *   - Wave 1: the read-only compute/preview service (PointsComputeService + controller) — joins
 *     achievements/targets/segment, resolves the effective rule via PointsEngineService, runs the
 *     pure evaluator, and returns a ComputePreview. NO wallet write / NO CreditBatch in Wave 1.
 *
 * PrismaModule gives the repositories; TenantSettingsService is @Global (TenantModule) so the
 * pointsEngine.enabled flag reads without a re-import. PointsEngineService stays exported so
 * later-wave modules can resolve the effective rule for an attachment.
 */
@Module({
  imports: [PrismaModule, CreditsModule, AdminCoreModule],
  controllers: [PointsEngineController, PointsComputeController, PointsEngineSettingsController],
  providers: [PointsEngineService, PointsComputeService],
  exports: [PointsEngineService, PointsComputeService],
})
export class PointsEngineModule {}
