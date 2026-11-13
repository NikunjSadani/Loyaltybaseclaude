import { Global, Module } from '@nestjs/common';
import { ExportAccessChecker } from './export-access';
import { ExportsDrainController } from './exports-drain.controller';
import { ExportsEngineModule } from './exports-engine.module';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

/**
 * Downloads page — API side. @Global so every report module's controller can inject ExportsService (to call
 * `respond(...)`) without editing its own module imports.
 */
@Global()
@Module({
  imports: [ExportsEngineModule],
  controllers: [ExportsController, ExportsDrainController],
  providers: [ExportsService, ExportAccessChecker],
  exports: [ExportsService],
})
export class ExportsModule {}
