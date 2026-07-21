/**
 * E2E test-DB reset — TRUNCATEs all data tables then lets the seed repopulate, giving the Playwright
 * harness a PRISTINE, reproducible baseline on every run (no accumulated residue: stray tickets, orphan
 * employees, drained wallets, stale statuses). Called by platform/e2e/global-setup.ts BEFORE the suite.
 *
 * SAFETY: this is DESTRUCTIVE (deletes all rows). It is HARD-GUARDED to `gifsy_dev` — it reads
 * DATABASE_URL from api/.env, connects, and REFUSES to run unless `current_database() === 'gifsy_dev'`.
 * It must NEVER touch staging/prod (those live on a separate private-IP instance and are unreachable
 * here anyway). It does NOT drop the schema (unlike `prisma migrate reset`) — just truncates data — so a
 * running backend keeps working. The seed is run separately by the caller after this.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envRaw = readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const line = envRaw.split('\n').find((l) => l.startsWith('DATABASE_URL'));
if (!line) throw new Error('DATABASE_URL not found in api/.env');
const url = line.split('=').slice(1).join('=').trim().replace(/^"|"$/g, '');

const client = new pg.Client({ connectionString: url });
await client.connect();
const db = (await client.query('select current_database() d')).rows[0].d;
if (db !== 'gifsy_dev') {
  await client.end();
  throw new Error(`[reset-e2e-db] REFUSING: current_database is "${db}", not "gifsy_dev". This script only runs against the local test DB.`);
}

// Truncate every base table in `public` except Prisma's migration bookkeeping. RESTART IDENTITY +
// CASCADE clears sequences and FK-dependent rows in one statement.
const tables = (
  await client.query(
    `select tablename from pg_tables where schemaname='public' and tablename <> '_prisma_migrations'`,
  )
).rows.map((r) => `"public"."${r.tablename}"`);

if (tables.length === 0) {
  console.log('[reset-e2e-db] no tables to truncate (fresh DB) — skipping truncate');
} else {
  await client.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
  console.log(`[reset-e2e-db] truncated ${tables.length} tables in gifsy_dev (data cleared; schema intact)`);
}
await client.end();
