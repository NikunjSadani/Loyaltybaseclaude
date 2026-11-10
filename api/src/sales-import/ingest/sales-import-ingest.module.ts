import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SalesImportProcessorService } from './sales-import-processor.service';
import { SalesImportRetentionService } from './sales-import-retention.service';
import { SalesImportRunnerService } from './sales-import-runner.service';
import { SalesImportUploadService } from './sales-import-upload.service';

/**
 * Lane I's providers (ingest: upload bookkeeping, processor, runner). OWNER: Lane I — add new ingest
 * injectables HERE (never in sales-import.module.ts) so the lanes never edit the same module file.
 * StorageService / TenantService come from @Global modules.
 */
@Module({
  imports: [PrismaModule],
  providers: [SalesImportProcessorService, SalesImportRunnerService, SalesImportUploadService, SalesImportRetentionService],
  exports: [SalesImportProcessorService, SalesImportRunnerService, SalesImportUploadService, SalesImportRetentionService],
})
export class SalesImportIngestModule {}
