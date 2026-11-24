// POST /v1/hubble/sweep — Cloud Scheduler driver: fail-closed, constant-time secret, one pass per call.
// Run: npx jest src/hubble/hubble-sweep.controller.spec.ts

import { ForbiddenException } from '@nestjs/common';
import { HubbleSweepController } from './hubble-sweep.controller';

describe('HubbleSweepController', () => {
  const summary = { claimed: 2, outcomes: { DELIVERED: 1, PROCESSING: 1 }, flaggedStale: 0, errors: 0 };
  const rewards = { sweepHubbleOrders: jest.fn() };
  const ctl = new HubbleSweepController(rewards as never);
  const prev = process.env.HUBBLE_SWEEP_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    rewards.sweepHubbleOrders.mockResolvedValue(summary);
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.HUBBLE_SWEEP_SECRET;
    else process.env.HUBBLE_SWEEP_SECRET = prev;
  });

  it('secret NOT configured → 403 even with a header (fail-closed, no dev bypass); no pass runs', async () => {
    delete process.env.HUBBLE_SWEEP_SECRET;
    await expect(ctl.sweep('anything')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.sweep(undefined)).rejects.toBeInstanceOf(ForbiddenException);
    process.env.HUBBLE_SWEEP_SECRET = '   ';
    await expect(ctl.sweep('')).rejects.toBeInstanceOf(ForbiddenException);
    expect(rewards.sweepHubbleOrders).not.toHaveBeenCalled();
  });

  it.each([
    ['missing header', undefined],
    ['wrong secret', 'not-the-secret'],
    ['wrong length', 's3cret-sweep-x'],
  ])('%s → 403, no pass runs', async (_l, header) => {
    process.env.HUBBLE_SWEEP_SECRET = 's3cret-sweep';
    await expect(ctl.sweep(header)).rejects.toBeInstanceOf(ForbiddenException);
    expect(rewards.sweepHubbleOrders).not.toHaveBeenCalled();
  });

  it('right secret (stored with a BOM / trailing newline) → runs exactly ONE pass and returns only counts', async () => {
    process.env.HUBBLE_SWEEP_SECRET = '﻿s3cret-sweep\r\n';
    const res = await ctl.sweep('s3cret-sweep');
    expect(rewards.sweepHubbleOrders).toHaveBeenCalledTimes(1);
    expect(res).toEqual(summary);
  });

  it('a skipped pass (another run holds the lock) is reported, not an error', async () => {
    process.env.HUBBLE_SWEEP_SECRET = 's3cret-sweep';
    rewards.sweepHubbleOrders.mockResolvedValue({ skipped: 'LOCKED', claimed: 0, outcomes: {}, flaggedStale: 0, errors: 0 });
    await expect(ctl.sweep('s3cret-sweep')).resolves.toEqual({ skipped: 'LOCKED', claimed: 0, outcomes: {}, flaggedStale: 0, errors: 0 });
  });
});
