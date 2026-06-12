import { Injectable, Logger } from '@nestjs/common';
import { ConfigService }     from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService }     from '../prisma/prisma.service';

interface EnqueueDto {
  userId:          string;
  channel:         string;
  body:            string;
  recipientPhone?: string;
  recipientEmail?: string;
  recipientFcm?:  string;
  subject?:        string;
  templateId?:     string;
  scheduledAt?:    Date;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma:  PrismaService,
    private readonly config:  ConfigService,
  ) {}

  // ── Enqueue ────────────────────────────────────────────────────────────────

  async enqueue(dto: EnqueueDto) {
    const record = await this.prisma.notificationQueue.create({
      data: {
        userId:         dto.userId,
        channel:        dto.channel as any,
        status:         'QUEUED' as any,
        body:           dto.body,
        subject:        dto.subject    ?? null,
        recipientPhone: dto.recipientPhone ?? null,
        recipientEmail: dto.recipientEmail ?? null,
        recipientFcm:   dto.recipientFcm   ?? null,
        templateId:     dto.templateId    ?? null,
        scheduledAt:    dto.scheduledAt   ?? null,
      },
    });
    return record;
  }

  // ── Process queue (cron: every minute) ────────────────────────────────────

  @Cron(CronExpression.EVERY_MINUTE)
  async processQueue() {
    const records = await this.prisma.notificationQueue.findMany({
      where:   { status: 'QUEUED', scheduledAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take:    50,                   // process in batches
    });

    for (const record of records) {
      // Exhaust retries → mark permanently FAILED
      if (record.retryCount >= record.maxRetries) {
        await this.prisma.notificationQueue.update({
          where: { id: record.id },
          data:  { status: 'FAILED' as any },
        });
        await this.prisma.notificationDeliveryLog.create({
          data: {
            queueId:       record.id,
            channel:       record.channel,
            status:        'FAILED' as any,
            failureReason: 'Max retries exhausted',
          },
        });
        continue;
      }

      try {
        let providerRef: string | undefined;

        if (record.channel === 'SMS' && record.recipientPhone) {
          providerRef = await this.sendViaMSG91(record.recipientPhone, record.body);
        }
        // Future: EMAIL, PUSH, WHATSAPP channels here

        await this.prisma.notificationQueue.update({
          where: { id: record.id },
          data:  { status: 'SENT' as any, processedAt: new Date() },
        });

        await this.prisma.notificationDeliveryLog.create({
          data: {
            queueId:     record.id,
            channel:     record.channel,
            status:      'SENT' as any,
            providerRef: providerRef ?? null,
            deliveredAt: new Date(),
          },
        });

      } catch (err: any) {
        this.logger.warn(`Notification ${record.id} failed: ${err.message}`);
        await this.prisma.notificationQueue.update({
          where: { id: record.id },
          data:  { retryCount: { increment: 1 } },
        });
        await this.prisma.notificationDeliveryLog.create({
          data: {
            queueId:       record.id,
            channel:       record.channel,
            status:        'FAILED' as any,
            failureReason: err.message,
          },
        });
      }
    }
  }

  // ── Private: MSG91 Flow SMS ───────────────────────────────────────────────
  // Uses MSG91_SMS_TEMPLATE_ID — a transactional/promotional Flow template.
  // Do NOT use MSG91_OTP_TEMPLATE_ID here: OTP templates are TRAI-registered
  // for OTP use only; using them for general notifications risks account flags.

  private async sendViaMSG91(phone: string, message: string): Promise<string> {
    const authKey    = this.config.get<string>('MSG91_AUTH_KEY');
    const templateId = this.config.get<string>('MSG91_SMS_TEMPLATE_ID');

    if (!authKey) {
      this.logger.warn('MSG91_AUTH_KEY not set — skipping SMS delivery');
      return 'skipped';
    }
    if (!templateId) {
      this.logger.warn('MSG91_SMS_TEMPLATE_ID not set — skipping SMS delivery');
      return 'skipped';
    }

    // MSG91 Flow API v5 — authkey in header, not body
    const url  = 'https://control.msg91.com/api/v5/flow/';
    const body = JSON.stringify({
      template_id: templateId,
      recipients:  [{ mobiles: `91${phone}`, var1: message }],
    });

    const res = await fetch(url, {
      method:  'POST',
      headers: { authkey: authKey, 'Content-Type': 'application/json' },
      body,
    });

    // MSG91 can return HTTP 200 with {"type":"error"} — check the body too
    const json = await res.json() as { type?: string; message?: string; request_id?: string };
    if (!res.ok || json?.type === 'error') {
      throw new Error(`MSG91 Flow error: ${json?.message ?? `HTTP ${res.status}`}`);
    }

    return json?.request_id ?? 'sent';
  }
}
