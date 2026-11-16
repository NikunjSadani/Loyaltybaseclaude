/**
 * Wallet Reversal Engine — WP6 one-off BACKFILL job entrypoint (Cloud Run JOB, same image as the API).
 * Compiled by `tsc -p tsconfig.build.json` to dist/wallet/backfill/backfill.main.js.
 *
 *   DRY_RUN (default — reads only, prints per-tenant summary + debt wallets + every anomaly):
 *     EXPECTED_DB=gifsy_staging [TENANTS=bajaj,deoleo] node dist/wallet/backfill/backfill.main.js
 *   APPLY (writes seq / pointsDelta / ledger links / positions / allocations / debtPoints / movementSeq — never balances):
 *     EXPECTED_DB=gifsy_staging TENANTS=bajaj BACKFILL_APPLY=true BACKFILL_CONFIRM="APPLY gifsy_staging" \
 *       node dist/wallet/backfill/backfill.main.js
 *   Optional: RESUME_AFTER_WALLET=<walletId> (ascending cursor), MAX_WALLETS=<n> (staged first run),
 *             KEEP_POINTS_REVERSALS_PAUSED=true (leave the tenant's POINTS reversal pause ON after APPLY — e.g. the
 *             tenant is flipped to V2 right after; lift it from the credits screen / POST reversal-engine/pause).
 *   BLOCKED wallets never stop a run (owner Q2 2026-11-16): every clean wallet is backfilled, every BLOCKED one is
 *   marked with its reason and listed under ATTENTION (ALLOW_BLOCKED is no longer needed and is ignored).
 *   APPLY pauses the tenant's POINTS reversal create/approve for its window (owner Q5) and resumes them at the end.
 *
 * Exit codes: 0 ok (incl. BLOCKED wallets — see ATTENTION) · 1 crash · 2 guard refused · 3 wallets / payout plan
 * changed mid-run (re-run) · 4 V0 ALARM (a backfill write changed a wallet's balance/counters/lots — rolled back, run
 * stopped — or a tenant balance change no committed movement row explains). Live earn/redeem during the run is
 * reconciled and printed ("live activity during the run: +X earned / −Y redeemed — explained"), not an alarm.
 * Runbook: platform/docs/plans/WALLET-REVERSAL-ENGINE-DESIGN.md §9 + §13 (WP6).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaBackfillStore } from './backfill-prisma-store';
import { BackfillConfig, runBackfill } from './backfill-runner';

export function configFromEnv(env: NodeJS.ProcessEnv): BackfillConfig {
  const list = (v: string | undefined) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  const maxWallets = env.MAX_WALLETS ? Number(env.MAX_WALLETS) : undefined;
  return {
    expectedDb: env.EXPECTED_DB?.trim() || undefined,
    // APPLY only on the exact string "true"; anything else (unset, "1", "yes") stays a dry run.
    apply: env.BACKFILL_APPLY === 'true',
    confirm: env.BACKFILL_CONFIRM,
    tenants: list(env.TENANTS),
    keepPaused: env.KEEP_POINTS_REVERSALS_PAUSED === 'true',
    resumeAfterWallet: env.RESUME_AFTER_WALLET?.trim() || undefined,
    maxWallets: maxWallets !== undefined && Number.isInteger(maxWallets) && maxWallets > 0 ? maxWallets : undefined,
  };
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const report = await runBackfill(new PrismaBackfillStore(prisma), configFromEnv(process.env), (l) => console.log(l));
    console.log(
      JSON.stringify(
        { msg: 'wallet-reversal backfill report', ...report },
        (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
      ),
    );
    process.exitCode = report.exitCode;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(JSON.stringify({ msg: 'wallet-reversal backfill crashed', error: e instanceof Error ? e.message : String(e) }));
    process.exit(1);
  });
}
