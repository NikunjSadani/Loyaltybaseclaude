import { ForbiddenException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { HubbleWebhookController } from './hubble-webhook.controller';
import type { RewardsService } from '../rewards/rewards.service';

/**
 * Webhook auth (Hubble X-Verify HMAC) + referenceId extraction. The reconcile itself
 * is covered by rewards.service.spec; here we only prove the signature gate and routing.
 */
describe('HubbleWebhookController', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.HUBBLE_WEBHOOK_SECRET;
    delete process.env.DATABASE_URL; // avoid the gifsy_prod hard-refuse in isFixedOtpAllowed
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  const make = (outcome = 'DELIVERED') => {
    const reconcile = jest.fn().mockResolvedValue(outcome);
    const rewards = { reconcileHubbleOrder: reconcile } as unknown as RewardsService;
    return { controller: new HubbleWebhookController(rewards), reconcile };
  };
  const req = (payload: unknown) =>
    ({ rawBody: Buffer.from(JSON.stringify(payload)) }) as never;
  const sign = (secret: string, raw: Buffer) =>
    createHmac('sha256', secret).update(raw).digest('base64');

  it('dev-bypasses (no secret, non-prod) and reconciles by referenceId', async () => {
    process.env.NODE_ENV = 'test';
    const { controller, reconcile } = make();
    const payload = { referenceId: 'ord_1' };
    const res = await controller.webhook(req(payload), payload, undefined);
    expect(reconcile).toHaveBeenCalledWith('ord_1');
    expect(res).toEqual({ ok: true, reconciled: true, outcome: 'DELIVERED' });
  });

  it('accepts a valid X-Verify signature when the secret is set', async () => {
    process.env.HUBBLE_WEBHOOK_SECRET = 's3cr3t';
    const { controller, reconcile } = make();
    const payload = { data: { referenceId: 'ord_2' } };
    const r = req(payload);
    const res = await controller.webhook(r, payload, sign('s3cr3t', (r as { rawBody: Buffer }).rawBody));
    expect(reconcile).toHaveBeenCalledWith('ord_2');
    expect(res.reconciled).toBe(true);
  });

  it('rejects an invalid X-Verify signature (no reconcile)', async () => {
    process.env.HUBBLE_WEBHOOK_SECRET = 's3cr3t';
    const { controller, reconcile } = make();
    const payload = { referenceId: 'ord_3' };
    await expect(controller.webhook(req(payload), payload, 'wrong')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('rejects a missing X-Verify when the secret is set', async () => {
    process.env.HUBBLE_WEBHOOK_SECRET = 's3cr3t';
    const { controller } = make();
    const payload = { referenceId: 'ord_4' };
    await expect(controller.webhook(req(payload), payload, undefined)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('fail-closed when no secret AND dev-bypass not allowed (prod data plane)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_FIXED_OTP;
    process.env.DATABASE_URL = 'postgres://u:p@h/gifsy_prod';
    const { controller } = make();
    const payload = { referenceId: 'ord_5' };
    await expect(controller.webhook(req(payload), payload, undefined)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('acks without reconciling when no referenceId is present (valid signature)', async () => {
    process.env.HUBBLE_WEBHOOK_SECRET = 's3cr3t';
    const { controller, reconcile } = make();
    const payload = { foo: 'bar' };
    const r = req(payload);
    const res = await controller.webhook(r, payload, sign('s3cr3t', (r as { rawBody: Buffer }).rawBody));
    expect(res).toEqual({ ok: true, reconciled: false });
    expect(reconcile).not.toHaveBeenCalled();
  });
});
