import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { RewardsService, HUBBLE_SWEEP_FAST_EVERY_MS } from './rewards.service';

/**
 * Driver for the automatic re-check of Hubble-handed redemption orders (RewardsService.sweepHubbleOrders).
 *
 * Same scheduling mechanism as the voucher-dispersal reconcile (VoucherDispersalProcessor.tick): a Nest
 * `@Interval` on every API instance, best-effort while the instance has CPU. Cross-instance safety is in
 * the sweep itself (advisory lock + per-order CAS claim), so several instances ticking is harmless.
 * Kill switch: HUBBLE_ORDER_SWEEP_ENABLED=false. Never throws.
 */
@Injectable()
export class HubbleOrderSweep {
  private readonly logger = new Logger(HubbleOrderSweep.name);
  private running = false;

  constructor(private readonly rewards: RewardsService) {}

  @Interval(HUBBLE_SWEEP_FAST_EVERY_MS)
  async tick(): Promise<void> {
    if (process.env.HUBBLE_ORDER_SWEEP_ENABLED === 'false') return;
    if (this.running) return; // one pass per instance at a time
    this.running = true;
    try {
      await this.rewards.sweepHubbleOrders();
    } catch (e) {
      this.logger.error(`[hubble] auto re-check tick failed: ${e}`);
    } finally {
      this.running = false;
    }
  }
}
