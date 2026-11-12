import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { StorageModule } from '../../storage/storage.module';
import { TenantModule } from '../../tenant/tenant.module';
import { SalesImportIngestModule } from './sales-import-ingest.module';

/**
 * Minimal Nest application context for the Cloud Run JOB `gifsy-sales-import[-staging]` (plan D-4,
 * task I-7). Deliberately does NOT import AppModule: no HTTP server, no global guards, no cron jobs.
 * OWNER: Lane I.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    StorageModule,
    TenantModule,
    SalesImportIngestModule,
  ],
})
export class SalesImportWorkerModule {}
