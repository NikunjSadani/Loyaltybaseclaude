import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { sweepHeldOpeningBalances } from './held-balance-apply';

const TEN_MINUTES_MS = 10 * 60 * 1000;

/**
 * HELD OPENING BALANCES — the periodic retry sweep (fix round 2026-11-21). Applies every PENDING held row whose
 * outlet's wallet exists and is EMPTY: a post-commit KYC trigger that was missed (instance stopped), a row loaded
 * after the approval, a transient error being retried. ON by default (owner rule: no silent waits) — dormant in
 * cost: one indexed read of PENDING rows when nothing is held. HELD_SWEEP_DISABLED=true switches it off.
 * Per-row work is safe under concurrency (wallet + held row locks, guarded claims, one live row per outlet in the DB).
 * Cloud Run only runs intervals while an instance is up — the post-commit KYC trigger is the primary path; Gifsy can
 * also run it from the console (POST /v1/admin/held-opening-balances/sweep).
 */
@Injectable()
export class HeldOpeningBalancesSweepWorker {
  private readonly logger = new Logger(HeldOpeningBalancesSweepWorker.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  @Interval(TEN_MINUTES_MS)
  async tick(): Promise<void> {
    if (process.env.HELD_SWEEP_DISABLED === 'true' || this.running) return;
    this.running = true;
    try {
      const out = await sweepHeldOpeningBalances(this.prisma);
      if (out.length > 0) {
        const n = (s: string) => out.filter((o) => o.status === s).length;
        this.logger.log(`[held-opening-balances] sweep: ${out.length} processed — ${n('APPLIED')} applied, ${n('FAILED')} failed, ${n('RETRYING')} retrying`);
      }
    } catch (e) {
      // missing table (pre-migration env) / transient DB error — never crash the scheduler
      this.logger.warn(`[held-opening-balances] sweep skipped: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
    }
  }
}
