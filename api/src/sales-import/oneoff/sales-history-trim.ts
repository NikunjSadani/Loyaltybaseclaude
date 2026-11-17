/**
 * ONE-OFF production cleanup for the sales-day-level change (owner-approved in principle 2026-11-18; runs ONLY after a
 * backup + the owner's explicit OK, in the order of the runbook — SALES-IMPORT-PIPELINE-PLAN.md §17b). Entry point:
 * sales-history-trim.main.ts (usage there).
 *
 * WHY IT EXISTS: deploying this release changes NO retention — the sweeps keep the old windows (30-day import data,
 * 10-year history) until SALES_RETENTION_V2=on (retention-window.ts). This script is the deliberate step that brings the
 * EXISTING data to the new windows; it applies them EXPLICITLY (v2WindowMonths / SALES_IMPORT_RETENTION_DAYS_V2),
 * whatever the switch, and only with `--apply`.
 *
 * DRY-RUN by default: prints, per tenant × month, what WOULD be removed. With `--apply`, in bounded batches:
 *   0. GUARD (S2): refuses to start when a month inside the window has history but NO day data (sales_day_sets) while the
 *      file of the import last applied to it still exists — step 3 would delete that file, the only source for
 *      `rebuild-days`. Run rebuild-days for those months first, or pass --allow-no-day-data (explicit, logged).
 *   1. SalesMonthHistory rows of customers that are NOT programme outlets by the CURRENT roster (normalised customerCode
 *      not in rosterIndexOf(loadRosterMeta(…)) — the same rule recalculate uses; the apply-time outletId is NOT used) are
 *      deleted — under the month lock, BATCH rows per transaction — rows of roster customers with a null outletId get it
 *      back-filled, and the month's product-list summary (sales_month_history_combos) is rebuilt from the remaining
 *      lines and its set header re-stamped (lineRows too). A tenant whose roster is EMPTY is skipped and reported.
 *   2. history months (lines, summary, headers) and day-level data older than the V2 window (current IST month + 3
 *      previous) are deleted by the retention code the sweep runs (purgeOldHistory with that EXPLICIT cutoff), repeated
 *      until none is left;
 *   3. per-import aggregates / raw files / unmatched.csv older than 7 days are purged by the same retention sweep (with
 *      the EXPLICIT 7 days), repeated until nothing expired is left.
 * Every step reports counts; a step that stops making progress stops the run with an error (never a silent partial).
 */
import { Prisma } from '@prisma/client';
import { lockSalesMonth } from '../../common/sales-kpi-ownership';
import { SALES_IMPORT_RETENTION_DAYS_V2 } from '../sales-import.contract';
import { currentMonthKey } from '../../targets/targets.helpers';
import { insertMonthCombosSql } from '../kpi/month-combos';
import { loadRosterMeta, rosterIndexOf } from '../kpi/sales-import-data';
import { historyCutoffMonth, v2WindowMonths } from '../retention-window';
import { RETENTION_STATUSES, type SalesImportRetentionService } from '../ingest/sales-import-retention.service';
import { REBUILD_PRODUCT_LIST_STATEMENT_TIMEOUT_MS, REBUILD_PRODUCT_LIST_TX_TIMEOUT_MS } from '../months/sales-months.service';

/** The Prisma surface the one-off uses (PrismaService or a mock). */
export type TrimDb = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | '$executeRaw' | '$executeRawUnsafe' | 'salesMonthHistorySet' | 'salesImport' | 'outlet'
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
  /** History rows of customers NOT on the tenant's CURRENT roster, in months INSIDE the window (step 1). */
  unmatchedHistory: MonthCount[];
  /** History rows of customers ON the current roster whose outletId is null (step 1 back-fills them). */
  nullOutletOnRoster: MonthCount[];
  /** Tenants with history in the window whose current roster is EMPTY: step 1 skips them (never deletes everything). */
  skippedTenants: Array<{ clientId: string; reason: string }>;
  /** Months in the window with history but NO day data while their last-applied import's file still exists (S2 guard). */
  missingDayData: Array<{ clientId: string; month: string; sourceImportId: string }>;
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
  outletIdsBackfilled: number;
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

/** A tenant's CURRENT programme customers: normalised customer code → roster outlet id (the rule recalculate uses). */
export async function currentRosterCodes(db: Pick<TrimDb, 'outlet'>, clientId: string): Promise<{ codes: string[]; ids: Array<string | null> }> {
  const roster = await loadRosterMeta(db as never, clientId);
  const index = rosterIndexOf(roster);
  const codes = [...index.keys()];
  return { codes, ids: codes.map((c) => roster.get(index.get(c)!)?.id ?? null) };
}

/** The windows the trim applies — the V2 ones, EXPLICITLY (independent of SALES_RETENTION_V2). */
export function trimWindows(now: Date = new Date()): { keepFromMonth: string; importRetentionDays: number } {
  return { keepFromMonth: historyCutoffMonth(currentMonthKey(now), v2WindowMonths()), importRetentionDays: SALES_IMPORT_RETENTION_DAYS_V2 };
}

export async function countTrim(
  db: Pick<TrimDb, '$queryRaw' | 'salesImport' | 'outlet'>,
  opts: { database: string; clientId?: string; now?: Date },
): Promise<TrimCounts> {
  const now = opts.now ?? new Date();
  const { keepFromMonth: keep, importRetentionDays } = trimWindows(now);
  const older = (alias: string) => Prisma.sql`${Prisma.raw(alias)}."month" < ${keep}`;
  const expiredBefore = new Date(now.getTime() - importRetentionDays * 86_400_000);
  const tenant = opts.clientId ? { clientId: opts.clientId } : {};

  // Step 1 is decided per tenant by its CURRENT roster (S3) — never by the apply-time outletId.
  const tenants = await db.$queryRaw<Array<{ clientId: string }>>(Prisma.sql`
    SELECT DISTINCT s."clientId" AS "clientId" FROM "sales_month_history_sets" s
     WHERE s."month" >= ${keep} ${tenantSql('s', opts.clientId)} ORDER BY 1`);
  const unmatchedHistory: MonthCount[] = [];
  const nullOutletOnRoster: MonthCount[] = [];
  const skippedTenants: TrimCounts['skippedTenants'] = [];
  for (const { clientId } of tenants) {
    const { codes } = await currentRosterCodes(db, clientId);
    if (codes.length === 0) {
      skippedTenants.push({ clientId, reason: 'its outlet roster is empty today, so no history row is removed for it (check the roster)' });
      continue;
    }
    const inWindow = Prisma.sql`h."month" >= ${keep}`;
    unmatchedHistory.push(...(await countBy(db, 'sales_month_histories', 'h',
      Prisma.sql`${inWindow} AND NOT (h."customerCode" = ANY(${codes}::text[]))`, clientId)));
    nullOutletOnRoster.push(...(await countBy(db, 'sales_month_histories', 'h',
      Prisma.sql`${inWindow} AND h."outletId" IS NULL AND h."customerCode" = ANY(${codes}::text[])`, clientId)));
  }

  // S2: months whose day data is missing while the last-applied import's file (the rebuild-days source) still exists.
  const missingDayData = await db.$queryRaw<Array<{ clientId: string; month: string; sourceImportId: string }>>(Prisma.sql`
    SELECT s."clientId" AS "clientId", s."month" AS "month", s."sourceImportId" AS "sourceImportId"
      FROM "sales_month_history_sets" s
      JOIN "sales_imports" i ON i."id" = s."sourceImportId" AND i."clientId" = s."clientId"
      LEFT JOIN "sales_day_sets" d ON d."clientId" = s."clientId" AND d."month" = s."month"
     WHERE s."month" >= ${keep} ${tenantSql('s', opts.clientId)}
       AND d."id" IS NULL AND i."purgedAt" IS NULL AND i."filesPurgedAt" IS NULL
     ORDER BY 1, 2`);

  return {
    database: opts.database,
    keepFromMonth: keep,
    importRetentionDays,
    unmatchedHistory,
    nullOutletOnRoster,
    skippedTenants,
    missingDayData: missingDayData.map((r) => ({ clientId: r.clientId, month: r.month, sourceImportId: r.sourceImportId })),
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

/** The S2 refusal (null = nothing missing). */
export function missingDayDataRefusal(c: Pick<TrimCounts, 'missingDayData'>): string | null {
  if (c.missingDayData.length === 0) return null;
  const list = c.missingDayData.map((m) => `${m.clientId} ${m.month} (import ${m.sourceImportId})`).join(', ');
  return (
    `Refusing to purge: ${c.missingDayData.length} month(s) have no day-by-day data while the file of the import last ` +
    `applied to them still exists: ${list}. Purging would delete that file, the only source for rebuild-days. Run ` +
    'rebuild-days --client <clientId> --month <YYYY-MM> (dry-run, then --apply) for each of these months first, or ' +
    're-run trim with --allow-no-day-data to purge anyway (their day-by-day data is then lost for good).'
  );
}

const total = (list: MonthCount[]) => list.reduce((s, r) => s + r.rows, 0);
export const beyondWindowTotal = (c: TrimCounts) =>
  total(c.beyondWindow.historyLines) + total(c.beyondWindow.productListRows) + total(c.beyondWindow.historySets) +
  total(c.beyondWindow.dayRows) + total(c.beyondWindow.daySets);

/** Human-readable dry-run / result report. */
export function formatCounts(c: TrimCounts): string[] {
  const out = [
    `database: ${c.database}`,
    `keep months from ${c.keepFromMonth} (current IST month + previous; the new window, applied explicitly); older months are deleted`,
    `per-import data retention: ${c.importRetentionDays} days`,
    `0) months with NO day data whose last-applied import file still exists (run rebuild-days first): ${c.missingDayData.length}`,
    ...c.missingDayData.map((m) => `   ${m.clientId} ${m.month}: import ${m.sourceImportId}`),
    `1) history rows of customers NOT on the current roster, inside the window: ${total(c.unmatchedHistory)}`,
    ...c.unmatchedHistory.map((r) => `   ${r.clientId} ${r.month}: ${r.rows}`),
    `   roster customers with no outletId (back-filled): ${total(c.nullOutletOnRoster)}`,
    ...c.nullOutletOnRoster.map((r) => `   ${r.clientId} ${r.month}: ${r.rows}`),
    ...c.skippedTenants.map((t) => `   SKIPPED tenant ${t.clientId}: ${t.reason}`),
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
  opts: { clientId?: string; now?: Date; batchRows?: number; allowNoDayData?: boolean } = {},
): Promise<TrimResult> {
  const { db, retention, log } = deps;
  const batch = opts.batchRows ?? TRIM_BATCH_ROWS;
  const recount = () => countTrim(db, { database: before.database, clientId: opts.clientId, now: opts.now });

  // ── 0. S2 guard: never destroy the only source of rebuild-days for a month without day data ──
  const refusal = missingDayDataRefusal(before);
  if (refusal) {
    if (!opts.allowNoDayData) throw new Error(refusal);
    log(`0) --allow-no-day-data: proceeding although ${before.missingDayData.length} month(s) have no day data; their files will be purged.`);
  }
  for (const t of before.skippedTenants) log(`1) SKIPPED tenant ${t.clientId}: ${t.reason}`);

  // ── 1. non-programme history rows by the CURRENT roster, month by month (month lock, bounded batches) + back-fill +
  //       product list rebuild ──
  let unmatchedDeleted = 0;
  let outletIdsBackfilled = 0;
  const monthsRebuilt: TrimResult['monthsRebuilt'] = [];
  const months = new Map<string, { clientId: string; month: string }>();
  for (const m of [...before.unmatchedHistory, ...before.nullOutletOnRoster]) months.set(`${m.clientId}|${m.month}`, m);
  const rosters = new Map<string, { codes: string[]; ids: Array<string | null> }>();
  for (const m of [...months.values()].sort((a, b) => (a.clientId + a.month < b.clientId + b.month ? -1 : 1))) {
    let r = rosters.get(m.clientId);
    if (!r) rosters.set(m.clientId, (r = await currentRosterCodes(db, m.clientId)));
    if (r.codes.length === 0) {
      log(`1) ${m.clientId} ${m.month}: SKIPPED — the roster is empty now; nothing removed.`);
      continue;
    }
    const { codes, ids } = r;
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
                 WHERE h."clientId" = ${m.clientId} AND h."month" = ${m.month}
                   AND NOT (h."customerCode" = ANY(${codes}::text[]))
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
        // Roster customers whose outletId is null (applied while they were not on the roster) get today's outlet id.
        const backfilled = Number(await tx.$executeRaw(Prisma.sql`
          UPDATE "sales_month_histories" h SET "outletId" = r.id
            FROM unnest(${codes}::text[], ${ids}::text[]) AS r(code, id)
           WHERE h."clientId" = ${m.clientId} AND h."month" = ${m.month} AND h."outletId" IS NULL AND h."customerCode" = r.code AND r.id IS NOT NULL`));
        const header = await tx.salesMonthHistorySet.findUnique({
          where: { clientId_month: { clientId: m.clientId, month: m.month } },
          select: { sourceImportId: true, appliedAt: true },
        });
        if (!header) return { backfilled, rebuilt: null }; // lines without a header: nothing reads them; the window purge / next apply handles them
        await tx.$executeRaw(Prisma.sql`DELETE FROM "sales_month_history_combos" WHERE "clientId" = ${m.clientId} AND "month" = ${m.month}`);
        const combos = Number(await tx.$executeRaw(insertMonthCombosSql(m.clientId, m.month, header.sourceImportId, header.appliedAt)));
        const left = await tx.$queryRaw<Array<{ n: number | bigint }>>(Prisma.sql`
          SELECT count(*)::int AS n FROM "sales_month_histories" WHERE "clientId" = ${m.clientId} AND "month" = ${m.month}`);
        const lineRows = Number(left[0]?.n ?? 0);
        await tx.salesMonthHistorySet.updateMany({
          where: { clientId: m.clientId, month: m.month },
          data: { lineRows, combosSourceImportId: header.sourceImportId, combosAppliedAt: header.appliedAt },
        });
        return { backfilled, rebuilt: { lineRows, productListRows: combos } };
      },
      { timeout: REBUILD_PRODUCT_LIST_TX_TIMEOUT_MS, maxWait: 10_000 },
    );
    outletIdsBackfilled += rebuilt.backfilled;
    const r2 = rebuilt.rebuilt;
    log(`1) ${m.clientId} ${m.month}: deleted ${monthDeleted} history rows of customers not on the current roster; back-filled ${rebuilt.backfilled} outlet ids${r2 ? `; product list rebuilt (${r2.productListRows} rows), ${r2.lineRows} lines left` : '; NO set header — product list not rebuilt'}`);
    if (r2) monthsRebuilt.push({ clientId: m.clientId, month: m.month, ...r2 });
  }

  // ── 2. months older than the window: the sweep's own bounded delete with the EXPLICIT V2 cutoff, until none is left ──
  let remaining = beyondWindowTotal(await recount());
  let beyondWindowPasses = 0;
  while (remaining > 0) {
    if (++beyondWindowPasses > TRIM_MAX_PASSES) throw new Error('2) too many passes deleting old months; stopped.');
    await retention.purgeOldHistory({ clientId: opts.clientId, historyCutoff: before.keepFromMonth });
    const next = beyondWindowTotal(await recount());
    log(`2) pass ${beyondWindowPasses}: ${remaining - next} rows deleted, ${next} left`);
    if (next >= remaining) throw new Error(`2) deleting months older than the window made no progress (${next} rows left) — see the retention log line; stopped.`);
    remaining = next;
  }

  // ── 3. per-import data older than 7 days (EXPLICIT): the sweep's own purge, until nothing expired is left ──
  // S2 again, right before the files go (a month may have lost its day data since the first count).
  const pre = await recount();
  const late = missingDayDataRefusal(pre);
  if (late && !opts.allowNoDayData) throw new Error(`3) ${late}`);
  let importsPurged = 0;
  for (let pass = 0; ; pass++) {
    const c = pass === 0 ? pre : await recount();
    if (c.expiredImports === 0 && c.pendingFileDeletes === 0) break;
    if (pass >= TRIM_MAX_PASSES) throw new Error('3) too many passes purging old imports; stopped.');
    const r = await retention.sweep({ clientId: opts.clientId, limit: 50, history: false, retentionDays: before.importRetentionDays });
    importsPurged += r.purged;
    const after = await recount();
    log(`3) pass ${pass + 1}: purged ${r.purged}; ${after.expiredImports} expired left, ${after.pendingFileDeletes} file deletes pending`);
    if (after.expiredImports >= c.expiredImports && after.pendingFileDeletes >= c.pendingFileDeletes) {
      throw new Error(`3) purging imports made no progress (${after.expiredImports} expired, ${after.pendingFileDeletes} file deletes pending — a busy import row or a storage error; see the log); stopped.`);
    }
  }

  return { unmatchedDeleted, outletIdsBackfilled, monthsRebuilt, beyondWindowPasses, importsPurged, after: await recount() };
}
