import { Module } from '@nestjs/common';
import { EXPORT_KINDS } from './kinds';
import { EXPORT_KIND_REGISTRY, ExportsProcessorService } from './exports-processor.service';
import { ExportsRunnerService } from './exports-runner.service';

/**
 * The engine shared by the API (ExportsModule) and the worker job (ExportsWorkerModule): kind registry, processor,
 * runner. No controllers. Depends only on @Global modules (Prisma, Storage).
 */
@Module({
  providers: [{ provide: EXPORT_KIND_REGISTRY, useValue: EXPORT_KINDS }, ExportsProcessorService, ExportsRunnerService],
  exports: [EXPORT_KIND_REGISTRY, ExportsProcessorService, ExportsRunnerService],
})
export class ExportsEngineModule {}
