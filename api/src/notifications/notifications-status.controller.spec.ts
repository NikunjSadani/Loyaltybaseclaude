// Unit tests for NotificationsStatusController — the @Public, secret-guarded transactional
// delivery-status webhook. Verifies: a SET secret is enforced (constant-time) on header or query;
// PROD with no secret FAILS CLOSED; non-prod with no secret dev-bypasses; and reconcile is
// fail-closed (no dev bypass) regardless of env.
// Run: npx jest src/notifications/notifications-status.controller.spec.ts

import { ForbiddenException } from '@nestjs/common';
import { NotificationsStatusController } from './notifications-status.controller';
import { MessageDeliveryStatusService } from './message-delivery-status.service';

const mockStatus = {
  handleWebhook: jest.fn().mockResolvedValue({ processed: 2, updated: 1 }),
  reconcile: jest.fn().mockResolvedValue({ checked: 3, updated: 2 }),
} as unknown as MessageDeliveryStatusService;

describe('NotificationsStatusController', () => {
  const OLD_ENV = process.env;
  let controller: NotificationsStatusController;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV };
    delete process.env.NOTIFICATIONS_STATUS_SECRET;
    controller = new NotificationsStatusController(mockStatus);
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  // Helper: force a PROD data plane so isFixedOtpAllowed() === false (fail-closed).
  const asProd = () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://u:p@host:5432/gifsy_prod';
    delete process.env.ALLOW_FIXED_OTP;
  };
  // Helper: a non-prod data plane so isFixedOtpAllowed() === true (dev bypass eligible).
  const asDev = () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://u:p@host:5432/gifsy_dev';
  };

  describe('POST /status — secret guard', () => {
    it('PROD + no secret configured → FAILS CLOSED (403)', async () => {
      asProd();
      await expect(controller.statusWebhook({}, undefined, undefined)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mockStatus.handleWebhook).not.toHaveBeenCalled();
    });

    it('non-prod + no secret configured → DEV-BYPASS allows and processes', async () => {
      asDev();
      const res = await controller.statusWebhook({ foo: 'bar' }, undefined, undefined);
      expect(res).toEqual({ ok: true, processed: 2, updated: 1 });
      expect(mockStatus.handleWebhook).toHaveBeenCalledWith({ foo: 'bar' });
    });

    it('SET secret enforced — correct header passes, even on prod', async () => {
      asProd();
      process.env.NOTIFICATIONS_STATUS_SECRET = 's3cr3t';
      const res = await controller.statusWebhook({}, 's3cr3t', undefined);
      expect(res.ok).toBe(true);
      expect(mockStatus.handleWebhook).toHaveBeenCalled();
    });

    it('SET secret enforced — correct query param passes', async () => {
      asDev();
      process.env.NOTIFICATIONS_STATUS_SECRET = 's3cr3t';
      const res = await controller.statusWebhook({}, undefined, 's3cr3t');
      expect(res.ok).toBe(true);
    });

    it('SET secret — wrong secret rejected (403), even in dev', async () => {
      asDev();
      process.env.NOTIFICATIONS_STATUS_SECRET = 's3cr3t';
      await expect(controller.statusWebhook({}, 'nope', undefined)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mockStatus.handleWebhook).not.toHaveBeenCalled();
    });

    it('SET secret — a wrong-length secret is rejected (no constant-time throw)', async () => {
      asDev();
      process.env.NOTIFICATIONS_STATUS_SECRET = 's3cr3t';
      await expect(controller.statusWebhook({}, 'x', undefined)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('POST /status/reconcile — fail-closed (no dev bypass)', () => {
    it('non-prod + no secret → still REFUSED (fail-closed ops trigger)', async () => {
      asDev();
      await expect(controller.reconcile(undefined, undefined)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mockStatus.reconcile).not.toHaveBeenCalled();
    });

    it('correct secret → runs the reconcile', async () => {
      asDev();
      process.env.NOTIFICATIONS_STATUS_SECRET = 's3cr3t';
      const res = await controller.reconcile('s3cr3t', undefined);
      expect(res).toEqual({ ok: true, checked: 3, updated: 2 });
      expect(mockStatus.reconcile).toHaveBeenCalled();
    });
  });
});
