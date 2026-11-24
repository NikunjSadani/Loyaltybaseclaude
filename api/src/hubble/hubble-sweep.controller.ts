import { Controller, ForbiddenException, Headers, HttpCode, Post } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/roles.decorator';
import { RewardsService } from '../rewards/rewards.service';

/**
 * POST /v1/hubble/sweep — Cloud Scheduler driver for the automatic re-check of Hubble-handed redemption
 * orders (RewardsService.sweepHubbleOrders). Prod runs with CPU throttling, so the in-process @Interval
 * (HubbleOrderSweep) does not fire reliably while idle — this request-driven pass is the reliable driver
 * (same pattern as push-drain / voucher-dispersal drain). The @Interval tick stays as a harmless extra:
 * overlapping runs are safe (advisory transaction lock on the claim phase + per-order CAS claim).
 *
 * `@Public`, header `x-drain-secret`, constant-time compare, FAIL-CLOSED when HUBBLE_SWEEP_SECRET is unset
 * (no dev bypass). A DEDICATED secret. Reveals only counts. Runbook: HUBBLE-RECONCILE-RUNBOOK.md §2a.
 */
@Controller('hubble')
export class HubbleSweepController {
  constructor(private readonly rewards: RewardsService) {}

  @Public()
  @SkipThrottle()
  @Post('sweep')
  @HttpCode(200)
  async sweep(@Headers('x-drain-secret') secret?: string) {
    const clean = (v?: string) => v?.replace(/^﻿/, '').trim() || undefined;
    const expected = clean(process.env.HUBBLE_SWEEP_SECRET);
    if (!expected) throw new ForbiddenException('Sweep disabled');
    const got = Buffer.from(secret ?? '');
    const want = Buffer.from(expected);
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new ForbiddenException('Invalid sweep secret');
    const r = await this.rewards.sweepHubbleOrders();
    return {
      ...(r.skipped ? { skipped: r.skipped } : {}),
      claimed: r.claimed,
      outcomes: r.outcomes,
      flaggedStale: r.flaggedStale,
      flaggedOther: r.flaggedOther,
      flaggedOutOfWindow: r.flaggedOutOfWindow,
      errors: r.errors,
      ...(r.budget ? { budget: r.budget } : {}),
    };
  }
}
