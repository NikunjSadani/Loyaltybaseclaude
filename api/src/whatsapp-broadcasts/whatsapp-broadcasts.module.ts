import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsappTemplatesController } from './whatsapp-templates.controller';
import { WhatsappTemplatesService } from './whatsapp-templates.service';
import { WhatsappBroadcastsController } from './whatsapp-broadcasts.controller';
import { WhatsappBroadcastsService } from './whatsapp-broadcasts.service';
import { WhatsappAudienceService } from './whatsapp-audience.service';
import { WhatsappSendWorker } from './whatsapp-send.worker';
import { WhatsappStatusService } from './whatsapp-status.service';
import { WhatsappOpsController } from './whatsapp-ops.controller';

/**
 * WhatsApp Broadcasts (Gifsy-operator only). Additive module — three new tables, a
 * template library, campaign orchestration, a gated send worker, the status webhook +
 * fallback reconcile.
 *
 * Msg91Service comes from the @Global() NotificationsModule (no import needed). There is
 * NO provider cycle: WhatsappSendWorker depends only on Prisma + Msg91 (never the
 * broadcast service), so the service injects the worker directly to kick a post-create
 * drain — no lazy ModuleRef required. Registered in app.module by adding one import line.
 *
 * Wave 2 (transactional WhatsApp delivery receipts): WhatsappStatusService also injects
 * MessageDeliveryStatusService — likewise exported by the @Global() NotificationsModule, so it
 * resolves by normal constructor injection with no import edge and no cycle (that service's only
 * deps are the @Global PrismaService + the in-module Msg91Service). On a broadcast-recipient miss
 * the status webhook delegates to it so a transactional receipt is transitioned (D3: one webhook,
 * both consumers).
 */
@Module({
  imports: [PrismaModule],
  controllers: [
    WhatsappTemplatesController,
    WhatsappBroadcastsController,
    WhatsappOpsController,
  ],
  providers: [
    WhatsappTemplatesService,
    WhatsappBroadcastsService,
    WhatsappAudienceService,
    WhatsappSendWorker,
    WhatsappStatusService,
  ],
})
export class WhatsappBroadcastsModule {}
