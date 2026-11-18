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
    delete process.env.HUBBLE_WEBHOOK_SECRET_STAGING;
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

  it('F3 fail-closed: NO secret configured → 403 even on non-prod with FIXED_OTP allowed (no reconcile)', async () => {
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_FIXED_OTP = 'true';
    process.env.FIXED_OTP = '123456';
    const { controller, reconcile } = make();
    const payload = { referenceId: 'ord_1' };
    await expect(controller.webhook(req(payload), payload, undefined)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('F3 fail-closed: a whitespace-only secret counts as NOT configured', async () => {
    process.env.HUBBLE_WEBHOOK_SECRET = '   ';
    const { controller, reconcile } = make();
    const payload = { referenceId: 'ord_1b' };
    const r = req(payload);
    await expect(
      controller.webhook(r, payload, sign('   ', (r as { rawBody: Buffer }).rawBody)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('F3: falls back to HUBBLE_WEBHOOK_SECRET_STAGING when the neutral name is unset', async () => {
    process.env.HUBBLE_WEBHOOK_SECRET_STAGING = 'stg-secret';
    const { controller, reconcile } = make();
    const payload = { referenceId: 'ord_1c' };
    const r = req(payload);
    await controller.webhook(r, payload, sign('stg-secret', (r as { rawBody: Buffer }).rawBody));
    expect(reconcile).toHaveBeenCalledWith('ord_1c', { webhookStatus: null });
  });

  it('F3: the neutral HUBBLE_WEBHOOK_SECRET wins over the *_STAGING fallback', async () => {
    process.env.HUBBLE_WEBHOOK_SECRET = 'prod-secret';
    process.env.HUBBLE_WEBHOOK_SECRET_STAGING = 'stg-secret';
    const { controller, reconcile } = make();
    const payload = { referenceId: 'ord_1d' };
    const r = req(payload);
    await expect(
      controller.webhook(r, payload, sign('stg-secret', (r as { rawBody: Buffer }).rawBody)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await controller.webhook(r, payload, sign('prod-secret', (r as { rawBody: Buffer }).rawBody));
    expect(reconcile).toHaveBeenCalledWith('ord_1d', { webhookStatus: null });
  });

  it('accepts a valid X-Verify signature when the secret is set', async () => {
    process.env.HUBBLE_WEBHOOK_SECRET = 's3cr3t';
    const { controller, reconcile } = make();
    const payload = { data: { referenceId: 'ord_2' } };
    const r = req(payload);
    const res = await controller.webhook(r, payload, sign('s3cr3t', (r as { rawBody: Buffer }).rawBody));
    expect(reconcile).toHaveBeenCalledWith('ord_2', { webhookStatus: null });
    expect(res.reconciled).toBe(true);
  });

  it('passes the webhook\'s own order status (upper-cased, top-level or nested) to the reconcile', async () => {
    process.env.HUBBLE_WEBHOOK_SECRET = 's3cr3t';
    const { controller, reconcile } = make();
    for (const [payload, status] of [
      [{ referenceId: 'ord_s1', status: 'failed' }, 'FAILED'],
      [{ data: { referenceId: 'ord_s2', status: 'SUCCESS' } }, 'SUCCESS'],
    ] as const) {
      const r = req(payload);
      await controller.webhook(r, payload, sign('s3cr3t', (r as { rawBody: Buffer }).rawBody));
      expect(reconcile).toHaveBeenLastCalledWith(expect.any(String), { webhookStatus: status });
    }
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

describe('HubbleWebhookController — Voucher Dispersal failures always ack 200 (review of 4d8454ad, M3 — the endpoint is shared with every tenant live webhook)', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, HUBBLE_WEBHOOK_SECRET: 's3cret' };
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });
  const call = async (reconcileByReference: jest.Mock) => {
    const rewards = { reconcileHubbleOrder: jest.fn() } as unknown as RewardsService;
    const moduleRef = { get: () => ({ reconcileByReference }) } as never;
    const controller = new HubbleWebhookController(rewards, moduleRef);
    const payload = { referenceId: 'vd0123456789abcdef01234567' };
    const raw = Buffer.from(JSON.stringify(payload));
    return controller.webhook({ rawBody: raw } as never, payload, createHmac('sha256', 's3cret').update(raw).digest('base64'));
  };

  it('a dispersal lookup that failed → 200, not reconciled (the failure is recorded on the campaign, never a 5xx)', async () => {
    await expect(call(jest.fn().mockResolvedValue('LOOKUP_FAILED'))).resolves.toEqual({ ok: true, reconciled: false, outcome: 'DISPERSAL_LOOKUP_FAILED' });
  });

  it('a dispersal processing error → 200, not reconciled (logged; never a 5xx)', async () => {
    await expect(call(jest.fn().mockRejectedValue(new Error('db down')))).resolves.toEqual({ ok: true, reconciled: false });
  });

  it('a processed dispersal webhook → 200 with the outcome', async () => {
    await expect(call(jest.fn().mockResolvedValue('SKIPPED'))).resolves.toEqual({ ok: true, reconciled: true, outcome: 'DISPERSAL_SKIPPED' });
  });
});
