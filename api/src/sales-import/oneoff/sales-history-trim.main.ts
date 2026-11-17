/**
 * ONE-OFF Sales Import maintenance (sales-day-level, owner decision 2026-11-18). NOT run by any deploy: an operator runs
 * it ONLY after a database BACKUP and the owner's explicit OK. Compiled into the API image
 * (dist/sales-import/oneoff/sales-history-trim.main.js), so it runs as a Cloud Run JOB execution of the API image inside
 * the VPC (same recipe as the migrate job), with DATABASE_URL + GCS_BUCKET like the worker job.
 *
 *   TRIM_TARGET_DB=<db> node dist/sales-import/oneoff/sales-history-trim.main.js trim [--client <clientId>] [--apply]
 *     DRY-RUN by default (counts per tenant × month). --apply: delete non-programme history rows (outletId NULL) and
 *     rebuild those months' product lists; delete history + day data older than the window (current month + 3
 *     previous); purge per-import aggregates / raw files / unmatched.csv older than 7 days — all in bounded batches via
 *     the retention code the sweep runs (sales-history-trim.ts).
 *
 *   TRIM_TARGET_DB=<db> node --max-old-space-size=1700 dist/sales-import/oneoff/sales-history-trim.main.js \
 *       rebuild-days --client <clientId> --month YYYY-MM [--apply]
 *     DRY-RUN by default. Builds the month's day-level data from the stored file of the import last applied to it
 *     (sales-day-rebuild.ts; refuses — and says why — when the file is gone or does not reproduce the stored lines /
 *     figures). Re-reads the whole file: run it in the 2 GiB job.
 *
 * Guard: SELECT current_database() must EXACTLY equal TRIM_TARGET_DB, for dry runs too. Exit 0 = done (or nothing to
 * do), 1 = refused / failed (the reason is printed).
 */
import { assertDatabase, applyTrim, countTrim, formatCounts } from './sales-history-trim';

export interface CliArgs {
  command: 'trim' | 'rebuild-days';
  apply: boolean;
  clientId?: string;
  month?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command !== 'trim' && command !== 'rebuild-days') {
    throw new Error('Usage: sales-history-trim.main.js trim [--client <id>] [--apply] | rebuild-days --client <id> --month YYYY-MM [--apply]');
  }
  const out: CliArgs = { command, apply: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--client') out.clientId = rest[++i];
    else if (a === '--month') out.month = rest[++i];
    else throw new Error(`Unknown argument "${a}".`);
  }
  if (out.clientId !== undefined && !out.clientId) throw new Error('--client needs a value.');
  if (command === 'rebuild-days') {
    if (!out.clientId) throw new Error('rebuild-days needs --client <clientId>.');
    if (!out.month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(out.month)) throw new Error('rebuild-days needs --month YYYY-MM.');
  }
  return out;
}

async function main(): Promise<void> {
  // BigInts print as exact decimal strings in the report (only when run as the CLI; importing this file changes nothing).
  (BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
    return this.toString();
  };
  const args = parseArgs(process.argv.slice(2));
  const { NestFactory } = await import('@nestjs/core');
  const { SalesImportWorkerModule } = await import('../ingest/sales-import-worker.module');
  const { PrismaService } = await import('../../prisma/prisma.service');
  const { StorageService } = await import('../../storage/storage.service');
  const { SalesImportRetentionService } = await import('../ingest/sales-import-retention.service');
  const { SalesKpiDefService } = await import('../kpi/sales-kpi-def.service');
  const { parseStoredFile } = await import('../ingest/stored-file-parse');
  const { rebuildMonthDays } = await import('./sales-day-rebuild');
  const app = await NestFactory.createApplicationContext(SalesImportWorkerModule, { bufferLogs: true });
  try {
    const prisma = app.get(PrismaService);
    const database = await assertDatabase(prisma, process.env.TRIM_TARGET_DB);
    const log = (l: string) => console.log(l);
    console.log(`${args.apply ? 'APPLY' : 'DRY-RUN'} ${args.command} on ${database}${args.clientId ? ` (tenant ${args.clientId})` : ' (all tenants)'}`);
    if (args.command === 'trim') {
      const before = await countTrim(prisma, { database, clientId: args.clientId });
      formatCounts(before).forEach(log);
      if (!args.apply) {
        console.log('DRY-RUN: nothing changed. Re-run with --apply (after a backup and the owner\'s OK) to make these changes.');
        return;
      }
      const r = await applyTrim({ db: prisma as never, retention: app.get(SalesImportRetentionService), log }, before, { clientId: args.clientId });
      console.log(`DONE: ${r.unmatchedDeleted} non-programme history rows deleted; ${r.monthsRebuilt.length} product lists rebuilt; ${r.beyondWindowPasses} old-month passes; ${r.importsPurged} imports purged.`);
      formatCounts(r.after).forEach((l) => log(`after: ${l}`));
    } else {
      const storage = app.get(StorageService);
      const report = await rebuildMonthDays(
        {
          db: prisma as never,
          kpiDefs: new SalesKpiDefService(prisma),
          parse: (imp, mapping, roster) => parseStoredFile(storage, imp, mapping, roster),
          log: { log, warn: log, error: (l: string) => console.error(l) },
        },
        { clientId: args.clientId!, month: args.month!, apply: args.apply },
      );
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
      else if (!args.apply) console.log('DRY-RUN: nothing changed. Re-run with --apply (after a backup and the owner\'s OK) to write it.');
    }
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(`REFUSED / FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
