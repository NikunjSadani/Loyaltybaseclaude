import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SalesImportProcessorService } from './sales-import-processor.service';
import { SalesImportRunnerService } from './sales-import-runner.service';

/**
 * Lane I's providers (ingest: upload bookkeeping, processor, runner). OWNER: Lane I — add new ingest
 * injectables HERE (never in sales-import.module.ts) so the lanes never edit the same module file.
 * StorageService / TenantService come from @Global modules.
 */
@Module({
  imports: [PrismaModule],
  providers: [SalesImportProcessorService, SalesImportRunnerService],
  exports: [SalesImportProcessorService, SalesImportRunnerService],
})
export class SalesImportIngestModule {}
