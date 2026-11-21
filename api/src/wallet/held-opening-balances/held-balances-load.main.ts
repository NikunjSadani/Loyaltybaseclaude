/**
 * HELD OPENING BALANCES — loader JOB entrypoint (Cloud Run JOB, same image as the API; NOT run by the API).
 * Compiled to dist/wallet/held-opening-balances/held-balances-load.main.js.
 *
 *   DRY RUN (default — reads only, prints the per-row plan + totals):
 *     EXPECTED_DB=gifsy_staging TENANT=bajaj SOURCE=vendor-earnburn-2026-11-11 \
 *       MANIFEST=gs://gifsy-platform-files/migrations/bajaj-held-opening-balances-2026-11-11.json \
 *       [EXPECTED_ROWS=40] [EXPECTED_TOTAL=122843] node dist/wallet/held-opening-balances/held-balances-load.main.js
 *   APPLY (inserts PENDING held rows only — never a wallet write):
 *     … EXPECTED_ROWS=40 EXPECTED_TOTAL=122843 AS_OF=2026-11-11 HELD_APPLY=true HELD_CONFIRM="APPLY gifsy_staging" \
 *       [SUPERSEDE=true] [CREATED_BY=<gifsy user id or name>] node …
 *   (EXPECTED_ROWS, EXPECTED_TOTAL and AS_OF are REQUIRED for APPLY.)
 *
 * MANIFEST = a local path or gs://bucket/object. Exit codes: 0 ok · 1 crash · 2 guard refused · 3 manifest invalid
 * (nothing written). Runbook: platform/docs/plans/CLIENT-MIGRATION-PLAYBOOK.md §"Existing points programme".
 */
import * as fs from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { HeldLoadConfig, PrismaHeldLoadStore, runHeldLoad } from './held-balances-load';

export function heldLoadConfigFromEnv(env: NodeJS.ProcessEnv): HeldLoadConfig {
  const int = (v: string | undefined) => (v !== undefined && v.trim() !== '' && Number.isInteger(Number(v)) ? Number(v) : undefined);
  return {
    expectedDb: env.EXPECTED_DB?.trim() || undefined,
    clientId: env.TENANT?.trim() || undefined,
    source: env.SOURCE?.trim() || undefined,
    // APPLY only on the exact string "true"; anything else stays a dry run.
    apply: env.HELD_APPLY === 'true',
    confirm: env.HELD_CONFIRM,
    expectedRows: int(env.EXPECTED_ROWS),
    expectedTotal: int(env.EXPECTED_TOTAL),
    createdBy: env.CREATED_BY?.trim() || undefined,
    asOf: env.AS_OF?.trim() || undefined,
    supersede: env.SUPERSEDE === 'true',
  };
}

async function readManifest(where: string): Promise<unknown> {
  if (where.startsWith('gs://')) {
    const [, , bucket, ...rest] = where.split('/');
    const { Storage } = await import('@google-cloud/storage');
    const [buf] = await new Storage().bucket(bucket).file(rest.join('/')).download();
    return JSON.parse(buf.toString('utf8'));
  }
  return JSON.parse(fs.readFileSync(where, 'utf8'));
}

async function main(): Promise<void> {
  const where = process.env.MANIFEST?.trim();
  if (!where) {
    console.error('ABORT: MANIFEST is required (local path or gs://bucket/object)');
    process.exitCode = 2;
    return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const report = await runHeldLoad(new PrismaHeldLoadStore(prisma), heldLoadConfigFromEnv(process.env), await readManifest(where), (l) => console.log(l));
    console.log(JSON.stringify({ msg: 'held-opening-balances load report', mode: report.mode, counts: report.counts, points: report.points, inserted: report.inserted, exitCode: report.exitCode }));
    process.exitCode = report.exitCode;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(JSON.stringify({ msg: 'held-opening-balances load crashed', error: e instanceof Error ? e.message : String(e) }));
    process.exit(1);
  });
}
