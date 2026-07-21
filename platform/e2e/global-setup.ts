import { execSync } from 'node:child_process';
import path from 'node:path';
import { resolveEnv } from './fixtures/env';

/**
 * Playwright globalSetup — runs ONCE before any project. It brings `gifsy_dev` to a PRISTINE seed
 * baseline (truncate all data + re-seed) so every LOCAL run starts from the same known state. This is
 * what makes the harness reproducible / CI-grade: no accumulated residue (stray tickets, orphan
 * employees, drained wallets, stale statuses) can drift the assertions between runs.
 *
 * GATED + SAFE:
 *   - Runs ONLY for a LOCAL run (E2E_ENV !== 'staging'). On staging we point at the deployed FE and
 *     have no business (and no ability) to wipe that shared DB — skip entirely.
 *   - Skippable with E2E_SKIP_RESET=1 (e.g. to inspect state across runs or bring your own fixtures).
 *   - The reset script (api/prisma/reset-e2e-db.mjs) HARD-GUARDS `current_database() === 'gifsy_dev'`
 *     and refuses otherwise, and it TRUNCATEs (no schema drop) so a running backend keeps serving.
 *   - Requires the local stack up (DB proxy :5433 + api/.env DATABASE_URL → gifsy_dev). Run-book:
 *     platform/docs/plans/E2E-HARNESS-REVIVAL.md.
 */
export default function globalSetup(): void {
  const env = resolveEnv();
  if (env.name === 'staging') {
    console.log('[global-setup] E2E_ENV=staging → skipping DB reset (never touch the shared staging DB).');
    return;
  }
  if (process.env.E2E_SKIP_RESET) {
    console.log('[global-setup] E2E_SKIP_RESET set → skipping DB reset (using the existing gifsy_dev state).');
    return;
  }
  const apiDir = path.resolve(__dirname, '..', '..', 'api');
  console.log('[global-setup] resetting gifsy_dev to a pristine seed baseline (truncate + seed)…');
  // 1) Truncate all data tables (guarded to gifsy_dev inside the script). 2) Re-seed.
  execSync('node prisma/reset-e2e-db.mjs', { cwd: apiDir, stdio: 'inherit' });
  execSync('npx prisma db seed', { cwd: apiDir, stdio: 'inherit' });
  console.log('[global-setup] gifsy_dev reset + seeded — pristine baseline ready.');
}
