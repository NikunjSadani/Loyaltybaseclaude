import { Injectable } from '@nestjs/common';
import { NotificationChannel, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface EnqueueNotificationParams {
  userId: string;
  channel: NotificationChannel;
  body: string;
  subject?: string;
  recipientPhone?: string;
  recipientEmail?: string;
  recipientFcm?: string;
  templateId?: string;
  variables?: Record<string, unknown>;
  scheduledAt?: Date;
}

/**
 * Notifications — the enqueue SEAM (foundation slice of the P7 notifications build).
 *
 * The kept DB queue model (`NotificationQueue` + `NotificationTemplate` +
 * `NotificationDeliveryLog`) is the source of truth. Domains call `enqueue()` to
 * register a notification; the actual MSG91 delivery worker (templates, channel
 * routing, retries, delivery logs) is built in P7. Until then rows sit in QUEUED.
 * MSG91 is the sole provider (see Gap #21 / 04-architecture §5).
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Enqueue a notification for later delivery by the P7 worker. Returns the queued row id. */
  async enqueue(params: EnqueueNotificationParams): Promise<{ id: string }> {
    const row = await this.prisma.notificationQueue.create({
      data: {
        userId: params.userId,
        channel: params.channel,
        status: 'QUEUED',
        body: params.body,
        subject: params.subject,
        recipientPhone: params.recipientPhone,
        recipientEmail: params.recipientEmail,
        recipientFcm: params.recipientFcm,
        templateId: params.templateId,
        variables: (params.variables ?? undefined) as Prisma.InputJsonValue | undefined,
        scheduledAt: params.scheduledAt,
      },
      select: { id: true },
    });
    return row;
  }
}
