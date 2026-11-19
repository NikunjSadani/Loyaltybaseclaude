/**
 * Wallet Reversal Engine — WP6 VERIFY job entrypoint (READ-ONLY; Cloud Run JOB, same image as the API).
 * Compiled to dist/wallet/backfill/verify.main.js. Runs V0–V9 (design §9) per tenant and prints PASS/FAIL per check.
 *
 *   EXPECTED_DB=gifsy_staging [TENANTS=bajaj,deoleo] \
 *   [V0_BASELINE_JSON='[{"clientId":"bajaj",...}]'   ← the "V0 before" lines the backfill APPLY printed; V0 passes when
 *                                                      identical OR every change is explained by movement rows added
 *                                                      since ("live activity since the APPLY baseline: +X earned /
 *                                                      −Y redeemed — explained"); an unexplained change FAILS]
 *   [NEVER_NEGATIVE_TENANTS=deoleo]                  ← default "deoleo" (V5)
 *   [EXPECTED_NEGATIVE_BALANCES='{"bajaj":{"<walletId>":-840,…}}']  ← V6b, by wallet id (or the legacy list of values
 *     '{"bajaj":[-840,-612,-520,-360,-360,-297,-280,-280]}'); compared with each wallet's balance at the CUTOVER
 *     node dist/wallet/backfill/verify.main.js
 *
 * Exit codes: 0 all PASS/INFO/SKIP · 1 crash · 2 guard refused · 5 at least one FAIL.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaBackfillStore } from './backfill-prisma-store';
import { CheckResult, runVerifyChecks, V0Snapshot, VerifySnapshot } from './verify-checks';

export interface VerifyConfig {
  expectedDb: string | undefined;
  tenants?: string[];
  v0Baseline: Map<string, V0Snapshot>;
  neverNegativeTenants: Set<string>;
  expectedNegatives: Map<string, number[] | Record<string, number>>;
}

export function verifyConfigFromEnv(env: NodeJS.ProcessEnv): VerifyConfig {
  const list = (v: string | undefined) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  const baseline = new Map<string, V0Snapshot>();
  if (env.V0_BASELINE_JSON) {
    const parsed = JSON.parse(env.V0_BASELINE_JSON) as V0Snapshot | V0Snapshot[];
    for (const s of Array.isArray(parsed) ? parsed : [parsed]) baseline.set(s.clientId, s);
  }
  // Per tenant: { walletId: balance } (preferred — fix round 3, B2) or a list of balances (multiset, legacy form).
  const negatives = new Map<string, number[] | Record<string, number>>();
  if (env.EXPECTED_NEGATIVE_BALANCES) {
    const parsed = JSON.parse(env.EXPECTED_NEGATIVE_BALANCES) as Record<string, number[] | Record<string, number>>;
    for (const [k, v] of Object.entries(parsed)) negatives.set(k, v);
  }
  return {
    expectedDb: env.EXPECTED_DB?.trim() || undefined,
    tenants: list(env.TENANTS),
    v0Baseline: baseline,
    neverNegativeTenants: new Set(list(env.NEVER_NEGATIVE_TENANTS) ?? ['deoleo']),
    expectedNegatives: negatives,
  };
}

export interface VerifySource {
  currentDatabase(): Promise<string>;
  listTenants(): Promise<string[]>;
  loadVerifySnapshot(clientId: string): Promise<VerifySnapshot>;
}

export async function runVerify(src: VerifySource, cfg: VerifyConfig, log: (l: string) => void): Promise<{ exitCode: number; results: CheckResult[] }> {
  if (!cfg.expectedDb) {
    log('REFUSED: EXPECTED_DB is not set');
    return { exitCode: 2, results: [] };
  }
  const db = await src.currentDatabase();
  if (db !== cfg.expectedDb) {
    log(`REFUSED: connected to "${db}" but EXPECTED_DB="${cfg.expectedDb}"`);
    return { exitCode: 2, results: [] };
  }
  log(`wallet-reversal verify (read-only) on ${db}`);
  const results: CheckResult[] = [];
  const tenants = cfg.tenants && cfg.tenants.length ? cfg.tenants : await src.listTenants();
  for (const clientId of tenants) {
    const snap = await src.loadVerifySnapshot(clientId);
    const rs = runVerifyChecks(snap, {
      v0Baseline: cfg.v0Baseline.get(clientId),
      neverNegativeTenant: cfg.neverNegativeTenants.has(clientId),
      expectedNegativeBalances: cfg.expectedNegatives.get(clientId),
    });
    for (const r of rs) {
      const listIds = r.ids.length && (r.status === 'FAIL' || r.status === 'WARN');
      log(`[${clientId}] ${r.status.padEnd(4)} ${r.check} — ${r.detail}${listIds ? ` [${r.ids.join(', ')}]` : ''}`);
    }
    results.push(...rs);
  }
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const warned = results.filter((r) => r.status === 'WARN').length;
  log(failed ? `VERIFY: ❌ ${failed} check(s) FAILED` : 'VERIFY: ✅ all checks passed');
  // Owner rule (no silent pass-throughs): WARN items pass the gate but are always called out.
  if (warned) log(`VERIFY: ⚠ ${warned} check(s) need Gifsy attention (WARN lines above — blocked wallets / payout reversal flags)`);
  return { exitCode: failed ? 5 : 0, results };
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const out = await runVerify(new PrismaBackfillStore(prisma), verifyConfigFromEnv(process.env), (l) => console.log(l));
    process.exitCode = out.exitCode;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(JSON.stringify({ msg: 'wallet-reversal verify crashed', error: e instanceof Error ? e.message : String(e) }));
    process.exit(1);
  });
}
