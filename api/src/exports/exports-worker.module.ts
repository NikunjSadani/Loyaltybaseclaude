import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RbacModule } from '../common/rbac/rbac.module';
import { MessageDeliveryStatusService } from '../notifications/message-delivery-status.service';
import { Msg91Service } from '../notifications/msg91.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SalesNotificationsService } from '../notifications/sales-notifications.service';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { TenantModule } from '../tenant/tenant.module';
import { ExportsEngineModule } from './exports-engine.module';
import { ExportsService } from './exports.service';
import { EXPORT_WORKER_FEATURE_MODULES } from './worker-feature-modules';

/**
 * In the worker, report CONTROLLERS (pulled in with their feature modules) inject ExportsService, but nothing ever
 * serves HTTP there. A stub satisfies the injection and makes recursion impossible: if any code path inside the job
 * tried to queue or stream an export through the API surface it fails loudly instead of re-kicking the job or building
 * a file a second way. Kinds run through ExportsProcessorService only.
 */
export const WORKER_EXPORTS_SERVICE_MESSAGE = 'ExportsService is not available inside the exports worker job';
const workerExportsServiceStub: Partial<Record<keyof ExportsService, () => never>> = {
  respond: () => {
    throw new Error(WORKER_EXPORTS_SERVICE_MESSAGE);
  },
  request: () => {
    throw new Error(WORKER_EXPORTS_SERVICE_MESSAGE);
  },
  list: () => {
    throw new Error(WORKER_EXPORTS_SERVICE_MESSAGE);
  },
  get: () => {
    throw new Error(WORKER_EXPORTS_SERVICE_MESSAGE);
  },
  download: () => {
    throw new Error(WORKER_EXPORTS_SERVICE_MESSAGE);
  },
};

@Global()
@Module({
  providers: [{ provide: ExportsService, useValue: workerExportsServiceStub }],
  exports: [ExportsService],
})
export class ExportsWorkerApiStubModule {}

/**
 * The exported providers of the @Global NotificationsModule (the API injects them app-wide — e.g. PayoutsService needs
 * Msg91Service, pulled in by the points kinds via CreditsModule) WITHOUT its HTTP controllers or its retention @Interval
 * worker. Constructing them makes no DB/network call (onModuleInit only resolves NotificationTemplatesService lazily);
 * the export kinds never send anything.
 */
@Global()
@Module({
  providers: [NotificationsService, SalesNotificationsService, Msg91Service, MessageDeliveryStatusService],
  exports: [NotificationsService, SalesNotificationsService, Msg91Service, MessageDeliveryStatusService],
})
export class ExportsWorkerNotificationsModule {}

/**
 * Minimal Nest application context for the Cloud Run JOB `gifsy-exports[-staging]` (mirror of SalesImportWorkerModule).
 * Deliberately NOT AppModule: no HTTP server, no global guards, and NO ScheduleModule.forRoot() — so @Cron/@Interval
 * methods of the feature modules below are inert (their decorators only register metadata).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    StorageModule,
    TenantModule,
    RbacModule,
    ExportsWorkerNotificationsModule,
    ExportsWorkerApiStubModule,
    ExportsEngineModule,
    ...EXPORT_WORKER_FEATURE_MODULES,
  ],
})
export class ExportsWorkerModule {}
