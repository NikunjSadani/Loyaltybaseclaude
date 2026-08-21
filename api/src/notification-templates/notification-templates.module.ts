import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminCoreModule } from '../admin-core/admin-core.module';
import { NotificationTemplatesController } from './notification-templates.controller';
import { NotificationTemplatesService } from './notification-templates.service';

/**
 * Per-tenant notification-templates config (Phase 2, config layer).
 *
 * AdminCoreModule provides AdminCoreService (the settings write path → the PROGRAM_SETTINGS
 * AuditLog + tenant-settings cache bust); PrismaModule provides the read. The service is EXPORTED
 * so later consumers (the actual SMS/WhatsApp senders) can inject the resolver. AdminCoreModule
 * imports only PrismaModule/PayoutsModule/TdsModule, so this adds no cycle.
 */
@Module({
  imports: [PrismaModule, AdminCoreModule],
  controllers: [NotificationTemplatesController],
  providers: [NotificationTemplatesService],
  exports: [NotificationTemplatesService],
})
export class NotificationTemplatesModule {}
