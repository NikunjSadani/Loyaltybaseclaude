/**
 * ONE-OFF production cleanup for the sales-day-level change (owner-approved in principle 2026-11-18; runs ONLY after a
 * backup + the owner's explicit OK). Entry point: sales-history-trim.main.ts (usage there).
 *
 * DRY-RUN by default: prints, per tenant × month, what WOULD be removed. With `--apply`, in bounded batches:
 *   1. SalesMonthHistory rows with outletId NULL (customers that were not programme outlets at apply time) are deleted —
 *      under the month lock, BATCH rows per transaction — and the month's product-list summary
 *      (sales_month_history_combos) is rebuilt from the remaining lines and its set header re-stamped (lineRows too);
 *   2. history months (lines, summary, headers) and day-level data older than the window (current IST month + 3
 *      previous) are deleted by the SAME retention code the sweep runs (purgeOldHistory), repeated until none is left;
 *   3. per-import aggregates / raw files / unmatched.csv older than 7 days are purged by the same retention sweep
 *      (repeated until nothing expired is left).
 * Every step reports counts; a step that stops making progress stops the run with an error (never a silent partial).
 */
import { Prisma } from '@prisma/client';
import { lockSalesMonth } from '../../common/sales-kpi-ownership';
import { SALES_IMPORT_RETENTION_DAYS } from '../sales-import.contract';
import { currentMonthKey } from '../../targets/targets.helpers';
import { insertMonthCombosSql } from '../kpi/month-combos';
import { historyCutoffMonth } from '../retention-window';
import { RETENTION_STATUSES, type SalesImportRetentionService } from '../ingest/sales-import-retention.service';
import { REBUILD_PRODUCT_LIST_STATEMENT_TIMEOUT_MS, REBUILD_PRODUCT_LIST_TX_TIMEOUT_MS } from '../months/sales-months.service';

/** The Prisma surface the one-off uses (PrismaService or a mock). */
export type TrimDb = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | '$executeRaw' | '$executeRawUnsafe' | 'salesMonthHistorySet' | 'salesImport'
> & {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, opts?: { timeout?: number; maxWait?: number }): Promise<T>;
};

export const TRIM_BATCH_ROWS = 20_000;
/** Each batch statement is bounded. */
export const TRIM_STATEMENT_TIMEOUT_MS = 60_000;
/** Safety bound on the repeat loops (each pass removes ≥ 1 row or the run stops). */
export const TRIM_MAX_PASSES = 10_000;

export interface MonthCount {
  clientId: string;
  month: string;
  rows: number;
}

export interface TrimCounts {
  database: string;
  /** Oldest month KEPT (months before it are deleted). */
  keepFromMonth: string;
  importRetentionDays: number;
  /** History rows of non-programme customers (outletId NULL) in months INSIDE the window (step 1). */
  unmatchedHistory: MonthCount[];
  /** Rows per tenant × month older than the window, per table (step 2). */
  beyondWindow: {
    historyLines: MonthCount[];
    productListRows: MonthCount[];
    historySets: MonthCount[];
    dayRows: MonthCount[];
    daySets: MonthCount[];
  };
  /** Finished imports older than 7 days not yet purged, and purged imports whose files still await deletion (step 3). */
  expiredImports: number;
  pendingFileDeletes: number;
}

export interface TrimResult {
  unmatchedDeleted: number;
  monthsRebuilt: Array<{ clientId: string; month: string; lineRows: number; productListRows: number }>;
  beyondWindowPasses: number;
  importsPurged: number;
  after: TrimCounts;
}

const tenantSql = (alias: string, clientId?: string) =>
  clientId ? Prisma.sql`AND ${Prisma.raw(alias)}."clientId" = ${clientId}` : Prisma.empty;

/** current_database() must EXACTLY equal the database the operator named (never runs against the wrong one). */
export async function assertDatabase(db: Pick<TrimDb, '$queryRaw'>, expected: string | undefined): Promise<string> {
  const rows = await db.$queryRaw<Array<{ db: string }>>(Prisma.sql`SELECT current_database() AS db`);
  const actual = rows[0]?.db ?? '';
  if (!expected || expected.trim() === '') {
    throw new Error(`Set TRIM_TARGET_DB to the database this run is meant for (connected to "${actual}"). Refusing to run.`);
  }
  if (actual !== expected.trim()) {
    throw new Error(`Connected to "${actual}" but TRIM_TARGET_DB is "${expected.trim()}". Refusing to run.`);
  }
  return actual;
}

async function countBy(db: Pick<TrimDb, '$queryRaw'>, table: string, alias: string, where: Prisma.Sql, clientId?: string): Promise<MonthCount[]> {
  const rows = await db.$queryRaw<Array<{ clientId: string; month: string; n: number | bigint }>>(Prisma.sql`
    SELECT ${Prisma.raw(alias)}."clientId" AS "clientId", ${Prisma.raw(alias)}."month" AS "month", count(*)::int AS n
      FROM ${Prisma.raw(`"${table}"`)} ${Prisma.raw(alias)}
     WHERE ${where} ${tenantSql(alias, clientId)}
     GROUP BY 1, 2 ORDER BY 1, 2`);
  return rows.map((r) => ({ clientId: r.clientId, month: r.month, rows: Number(r.n) }));
}

export async function countTrim(
  db: Pick<TrimDb, '$queryRaw' | 'salesImport'>,
  opts: { database: string; clientId?: string; now?: Date },
): Promise<TrimCounts> {
  const now = opts.now ?? new Date();
  const keep = historyCutoffMonth(currentMonthKey(now));
  const older = (alias: string) => Prisma.sql`${Prisma.raw(alias)}."month" < ${keep}`;
  const expiredBefore = new Date(now.getTime() - SALES_IMPORT_RETENTION_DAYS * 86_400_000);
  const tenant = opts.clientId ? { clientId: opts.clientId } : {};
  return {
    database: opts.database,
    keepFromMonth: keep,
    importRetentionDays: SALES_IMPORT_RETENTION_DAYS,
    unmatchedHistory: await countBy(db, 'sales_month_histories', 'h', Prisma.sql`h."outletId" IS NULL AND h."month" >= ${keep}`, opts.clientId),
    beyondWindow: {
      historyLines: await countBy(db, 'sales_month_histories', 'h', older('h'), opts.clientId),
      productListRows: await countBy(db, 'sales_month_history_combos', 'c', older('c'), opts.clientId),
      historySets: await countBy(db, 'sales_month_history_sets', 's', older('s'), opts.clientId),
      dayRows: await countBy(db, 'outlet_sales_days', 'o', older('o'), opts.clientId),
      daySets: await countBy(db, 'sales_day_sets', 'd', older('d'), opts.clientId),
    },
    expiredImports: await db.salesImport.count({
      where: { ...tenant, status: { in: RETENTION_STATUSES }, purgedAt: null, finishedAt: { lt: expiredBefore } },
    }),
    pendingFileDeletes: await db.salesImport.count({ where: { ...tenant, purgedAt: { not: null }, filesPurgedAt: null } }),
  };
}

const total = (list: MonthCount[]) => list.reduce((s, r) => s + r.rows, 0);
export const beyondWindowTotal = (c: TrimCounts) =>
  total(c.beyondWindow.historyLines) + total(c.beyondWindow.productListRows) + total(c.beyondWindow.historySets) +
  total(c.beyondWindow.dayRows) + total(c.beyondWindow.daySets);

/** Human-readable dry-run / result report. */
export function formatCounts(c: TrimCounts): string[] {
  const out = [
    `database: ${c.database}`,
    `keep months from ${c.keepFromMonth} (current IST month + previous); older months are deleted`,
    `per-import data retention: ${c.importRetentionDays} days`,
    `1) non-programme history rows (outletId NULL) inside the window: ${total(c.unmatchedHistory)}`,
    ...c.unmatchedHistory.map((r) => `   ${r.clientId} ${r.month}: ${r.rows}`),
    '2) older than the window:',
  ];
  for (const [name, list] of Object.entries(c.beyondWindow) as Array<[string, MonthCount[]]>) {
    out.push(`   ${name}: ${total(list)}`, ...list.map((r) => `     ${r.clientId} ${r.month}: ${r.rows}`));
  }
  out.push(`3) imports finished > ${c.importRetentionDays} days ago not yet purged: ${c.expiredImports}; purged imports with files still to delete: ${c.pendingFileDeletes}`);
  return out;
}

export async function applyTrim(
  deps: {
    db: TrimDb;
    retention: Pick<SalesImportRetentionService, 'purgeOldHistory' | 'sweep'>;
    log: (line: string) => void;
  },
  before: TrimCounts,
  opts: { clientId?: string; now?: Date; batchRows?: number } = {},
): Promise<TrimResult> {
  const { db, retention, log } = deps;
  const batch = opts.batchRows ?? TRIM_BATCH_ROWS;
  const recount = () => countTrim(db, { database: before.database, clientId: opts.clientId, now: opts.now });

  // ── 1. non-programme history rows, month by month (under the month lock, bounded batches) + product list rebuild ──
  let unmatchedDeleted = 0;
  const monthsRebuilt: TrimResult['monthsRebuilt'] = [];
  for (const m of before.unmatchedHistory) {
    let monthDeleted = 0;
    for (let pass = 0; pass < TRIM_MAX_PASSES; pass++) {
      const n = await db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${TRIM_STATEMENT_TIMEOUT_MS}`);
          await lockSalesMonth(tx, m.clientId, m.month);
          return Number(
            await tx.$executeRaw(Prisma.sql`
              DELETE FROM "sales_month_histories" WHERE "id" IN (
                SELECT h."id" FROM "sales_month_histories" h
                 WHERE h."clientId" = ${m.clientId} AND h."month" = ${m.month} AND h."outletId" IS NULL
                 LIMIT ${batch})`),
          );
        },
        { timeout: TRIM_STATEMENT_TIMEOUT_MS + 15_000, maxWait: 10_000 },
      );
      monthDeleted += n;
      if (n < batch) break;
    }
    unmatchedDeleted += monthDeleted;
    const rebuilt = await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${REBUILD_PRODUCT_LIST_STATEMENT_TIMEOUT_MS}`);
        await lockSalesMonth(tx, m.clientId, m.month);
        const header = await tx.salesMonthHistorySet.findUnique({
          where: { clientId_month: { clientId: m.clientId, month: m.month } },
          select: { sourceImportId: true, appliedAt: true },
        });
        if (!header) return null; // lines without a header: nothing reads them; the window purge / next apply handles them
        await tx.$executeRaw(Prisma.sql`DELETE FROM "sales_month_history_combos" WHERE "clientId" = ${m.clientId} AND "month" = ${m.month}`);
        const combos = Number(await tx.$executeRaw(insertMonthCombosSql(m.clientId, m.month, header.sourceImportId, header.appliedAt)));
        const left = await tx.$queryRaw<Array<{ n: number | bigint }>>(Prisma.sql`
          SELECT count(*)::int AS n FROM "sales_month_histories" WHERE "clientId" = ${m.clientId} AND "month" = ${m.month}`);
        const lineRows = Number(left[0]?.n ?? 0);
        await tx.salesMonthHistorySet.updateMany({
          where: { clientId: m.clientId, month: m.month },
          data: { lineRows, combosSourceImportId: header.sourceImportId, combosAppliedAt: header.appliedAt },
        });
        return { lineRows, productListRows: combos };
      },
      { timeout: REBUILD_PRODUCT_LIST_TX_TIMEOUT_MS, maxWait: 10_000 },
    );
    log(`1) ${m.clientId} ${m.month}: deleted ${monthDeleted} non-programme history rows${rebuilt ? `; product list rebuilt (${rebuilt.productListRows} rows), ${rebuilt.lineRows} lines left` : '; NO set header — product list not rebuilt'}`);
    if (rebuilt) monthsRebuilt.push({ clientId: m.clientId, month: m.month, ...rebuilt });
  }

  // ── 2. months older than the window: the sweep's own bounded delete, repeated until none is left ──
  let remaining = beyondWindowTotal(await recount());
  let beyondWindowPasses = 0;
  while (remaining > 0) {
    if (++beyondWindowPasses > TRIM_MAX_PASSES) throw new Error('2) too many passes deleting old months; stopped.');
    await retention.purgeOldHistory({ clientId: opts.clientId });
    const next = beyondWindowTotal(await recount());
    log(`2) pass ${beyondWindowPasses}: ${remaining - next} rows deleted, ${next} left`);
    if (next >= remaining) throw new Error(`2) deleting months older than the window made no progress (${next} rows left) — see the retention log line; stopped.`);
    remaining = next;
  }

  // ── 3. per-import data older than 7 days: the sweep's own purge, repeated until nothing expired is left ──
  let importsPurged = 0;
  for (let pass = 0; ; pass++) {
    const c = await recount();
    if (c.expiredImports === 0 && c.pendingFileDeletes === 0) break;
    if (pass >= TRIM_MAX_PASSES) throw new Error('3) too many passes purging old imports; stopped.');
    const r = await retention.sweep({ clientId: opts.clientId, limit: 50, history: false });
    importsPurged += r.purged;
    const after = await recount();
    log(`3) pass ${pass + 1}: purged ${r.purged}; ${after.expiredImports} expired left, ${after.pendingFileDeletes} file deletes pending`);
    if (after.expiredImports >= c.expiredImports && after.pendingFileDeletes >= c.pendingFileDeletes) {
      throw new Error(`3) purging imports made no progress (${after.expiredImports} expired, ${after.pendingFileDeletes} file deletes pending — a busy import row or a storage error; see the log); stopped.`);
    }
  }

  return { unmatchedDeleted, monthsRebuilt, beyondWindowPasses, importsPurged, after: await recount() };
}
