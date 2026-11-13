import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RbacModule } from '../common/rbac/rbac.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { TenantModule } from '../tenant/tenant.module';
import { ExportsEngineModule } from './exports-engine.module';
import { EXPORT_WORKER_FEATURE_MODULES } from './worker-feature-modules';

/**
 * Minimal Nest application context for the Cloud Run JOB `gifsy-exports[-staging]` (mirror of SalesImportWorkerModule).
 * Deliberately NOT AppModule: no HTTP server, no global guards, no cron jobs.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    StorageModule,
    TenantModule,
    RbacModule,
    ExportsEngineModule,
    ...EXPORT_WORKER_FEATURE_MODULES,
  ],
})
export class ExportsWorkerModule {}
