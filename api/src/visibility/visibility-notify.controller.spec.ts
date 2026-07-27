/**
 * Unit tests for visibility-notify.controller.ts — the @Public, shared-secret-gated
 * POST /v1/visibility/weekly-reminder trigger (fail-closed, mirrors kyc cleanup / push drain).
 *
 * Run: npx jest src/visibility/visibility-notify.controller.spec.ts
 */

import { ForbiddenException } from '@nestjs/common';
import { VisibilityNotifyController } from './visibility-notify.controller';
import { VisibilityNotifyService } from './visibility-notify.service';

describe('VisibilityNotifyController', () => {
  const summary = { tenants: 1, repsNotified: 2, outletsPending: 5 };
  const mockService = { runWeeklyReminder: jest.fn() } as unknown as VisibilityNotifyService;
  let controller: VisibilityNotifyController;
  const ORIGINAL = process.env.VISIBILITY_REMINDER_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    (mockService.runWeeklyReminder as jest.Mock).mockResolvedValue(summary);
    controller = new VisibilityNotifyController(mockService);
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.VISIBILITY_REMINDER_SECRET;
    else process.env.VISIBILITY_REMINDER_SECRET = ORIGINAL;
  });

  it('runs the reminder when the secret matches', async () => {
    process.env.VISIBILITY_REMINDER_SECRET = 's3cret';
    const res = await controller.weeklyReminder('s3cret');
    expect(res).toEqual(summary);
    expect(mockService.runWeeklyReminder).toHaveBeenCalledTimes(1);
  });

  it('fails CLOSED (403) when the env secret is unset', async () => {
    delete process.env.VISIBILITY_REMINDER_SECRET;
    await expect(controller.weeklyReminder('anything')).rejects.toThrow(ForbiddenException);
    expect(mockService.runWeeklyReminder).not.toHaveBeenCalled();
  });

  it('403s on a secret mismatch', async () => {
    process.env.VISIBILITY_REMINDER_SECRET = 's3cret';
    await expect(controller.weeklyReminder('wrong')).rejects.toThrow(ForbiddenException);
    expect(mockService.runWeeklyReminder).not.toHaveBeenCalled();
  });

  it('403s on a missing header (no secret provided)', async () => {
    process.env.VISIBILITY_REMINDER_SECRET = 's3cret';
    await expect(controller.weeklyReminder(undefined)).rejects.toThrow(ForbiddenException);
    expect(mockService.runWeeklyReminder).not.toHaveBeenCalled();
  });
});
