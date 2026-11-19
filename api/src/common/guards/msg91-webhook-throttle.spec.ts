import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { NotificationsStatusController } from '../../notifications/notifications-status.controller';
import { MessageDeliveryStatusService } from '../../notifications/message-delivery-status.service';
import { WhatsappOpsController } from '../../whatsapp-broadcasts/whatsapp-ops.controller';
import { WhatsappStatusService } from '../../whatsapp-broadcasts/whatsapp-status.service';
import { WhatsappSendWorker } from '../../whatsapp-broadcasts/whatsapp-send.worker';
import { IdentityThrottlerGuard } from './identity-throttler.guard';

jest.setTimeout(60_000);

/**
 * MSG91's "On Outbound Report Received" webhook fires for EVERY outbound message on the MSG91
 * number (not only ours), from a few shared IPs. Under the global 60/min IP bucket a bulk send
 * 429'd thousands of reports and MSG91 auto-PAUSED the prod webhook (2026-11-19: ~1,400 reports
 * in one minute, 3,000+ 429s). Both status webhooks must be exempt from the throttler — their
 * constant-time secret check is the guard. The low-volume reconcile trigger stays throttled.
 */
describe('MSG91 status webhooks are not throttled', () => {
  let app: INestApplication;
  const SECRET = 'test-webhook-secret';
  const dlr = { handleWebhook: jest.fn().mockResolvedValue({ processed: 1, updated: 0 }), reconcile: jest.fn().mockResolvedValue({ checked: 0, updated: 0 }) };
  const wa = { handleWebhook: jest.fn().mockResolvedValue({ processed: 1, updated: 0 }) };
  const saved = { n: process.env.NOTIFICATIONS_STATUS_SECRET, w: process.env.WHATSAPP_STATUS_SECRET };

  beforeEach(async () => {
    process.env.NOTIFICATIONS_STATUS_SECRET = SECRET;
    process.env.WHATSAPP_STATUS_SECRET = SECRET;
    jest.clearAllMocks();
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 60 }] }),
      ],
      controllers: [NotificationsStatusController, WhatsappOpsController],
      providers: [
        { provide: MessageDeliveryStatusService, useValue: dlr },
        { provide: WhatsappStatusService, useValue: wa },
        { provide: WhatsappSendWorker, useValue: {} },
        { provide: APP_GUARD, useClass: IdentityThrottlerGuard },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await app.close(); });
  afterAll(() => {
    if (saved.n === undefined) delete process.env.NOTIFICATIONS_STATUS_SECRET; else process.env.NOTIFICATIONS_STATUS_SECRET = saved.n;
    if (saved.w === undefined) delete process.env.WHATSAPP_STATUS_SECRET; else process.env.WHATSAPP_STATUS_SECRET = saved.w;
  });

  it('both status handlers carry @SkipThrottle metadata; reconcile does not', () => {
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', NotificationsStatusController.prototype.statusWebhook)).toBe(true);
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', WhatsappOpsController.prototype.statusWebhook)).toBe(true);
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', NotificationsStatusController.prototype.reconcile)).toBeUndefined();
  });

  it('POST /notifications/status: 120 reports from one IP in a minute are all accepted (201)', async () => {
    for (let i = 0; i < 120; i++) {
      const res = await request(app.getHttpServer()).post('/notifications/status').set('x-webhook-secret', SECRET).send({ requestId: `r${i}` });
      expect(res.status).toBe(201);
    }
    expect(dlr.handleWebhook).toHaveBeenCalledTimes(120);
  });

  it('POST /whatsapp/status: 120 reports from one IP in a minute are all accepted (201)', async () => {
    for (let i = 0; i < 120; i++) {
      const res = await request(app.getHttpServer()).post('/whatsapp/status').set('x-webhook-secret', SECRET).send({ requestId: `r${i}` });
      expect(res.status).toBe(201);
    }
    expect(wa.handleWebhook).toHaveBeenCalledTimes(120);
  });

  it('the secret is still enforced: a wrong secret is 403 and never reaches the handler', async () => {
    const res = await request(app.getHttpServer()).post('/notifications/status').set('x-webhook-secret', 'wrong').send({});
    expect(res.status).toBe(403);
    expect(dlr.handleWebhook).not.toHaveBeenCalled();
  });
});
