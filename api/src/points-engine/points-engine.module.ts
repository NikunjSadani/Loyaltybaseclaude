import { Module } from '@nestjs/common';
import { PointsEngineController } from './points-engine.controller';
import { PointsEngineService } from './points-engine.service';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * Points Compute Engine (Wave 0) — the versioned PointsRule config store.
 * Exports PointsEngineService so later-wave modules (compute/preview/credit) can
 * resolve the effective rule for an attachment. TenantSettingsService is @Global
 * (TenantModule) so no re-import is needed to read the pointsEngine flag.
 */
@Module({
  imports: [PrismaModule],
  controllers: [PointsEngineController],
  providers: [PointsEngineService],
  exports: [PointsEngineService],
})
export class PointsEngineModule {}
