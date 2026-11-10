import { Prisma } from '@prisma/client';
import { sqlUtc } from '../sql-time';

/**
 * The per-month combos summary (plan §10c): sales_month_history_combos, one row per (tenant, month, product combo),
 * stamped with the history set it summarises (`sourceImportId` + `appliedAt` = the SalesMonthHistorySet header).
 *   - WRITE: the apply, right after the history INSERT, in its transaction (insertMonthCombosSql).
 *   - READ: GET history-combos — strictly read-only; a month whose summary is missing or from another set is answered
 *     anyway and flagged `refreshingMonths` (classifyMonthSummaries).
 *   - REPAIR: refreshStaleMonthCombos, in the BACKGROUND (worker drain + the Cloud Scheduler drain), never on a request.
 */

/** ONE INSERT … SELECT … GROUP BY over the month's stored lines (dimKey is the stable key of dims, 1:1). The caller
 * DELETEs the month's rows first. */
export function insertMonthCombosSql(clientId: string, month: string, sourceImportId: string, appliedAt: Date): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "sales_month_history_combos"
      ("clientId","month","dims","dimKey","keyHash","amountPaise","qtyPico","lines","sourceImportId","appliedAt")
    SELECT h."clientId", h."month", h."dims", h."dimKey", md5(h."dimKey"),
           SUM(h."amountPaise"), SUM(h."qtyPico"), SUM(h."lines")::int, ${sourceImportId}, ${sqlUtc(appliedAt)}
      FROM "sales_month_histories" h
     WHERE h."clientId" = ${clientId} AND h."month" = ${month}
     GROUP BY h."clientId", h."month", h."dimKey", h."dims"`;
}

/** Per-month head of the summary rows (a month with rows of two sets has srcMin ≠ srcMax). */
export interface SummaryHead { month: string; srcMin: string; srcMax: string; atMin: Date; atMax: Date }
export interface SetHead { month: string; sourceImportId: string; appliedAt: Date; lineRows: number }
export type SummaryState = 'current' | 'stale' | 'missing' | 'empty';

/**
 * current = every summary row is from the month's set; stale = rows exist but (some) are from another set;
 * missing = no rows while the set has lines; empty = no rows and no lines (nothing to summarise).
 */
export function classifyMonthSummaries(sets: SetHead[], heads: SummaryHead[]): Map<string, SummaryState> {
  const byMonth = new Map(heads.map((h) => [h.month, h]));
  const out = new Map<string, SummaryState>();
  for (const s of sets) {
    const h = byMonth.get(s.month);
    if (!h) {
      out.set(s.month, s.lineRows > 0 ? 'missing' : 'empty');
      continue;
    }
    const at = new Date(s.appliedAt).getTime();
    const same = h.srcMin === s.sourceImportId && h.srcMax === s.sourceImportId
      && new Date(h.atMin).getTime() === at && new Date(h.atMax).getTime() === at;
    out.set(s.month, same ? 'current' : 'stale');
  }
  return out;
}

/** Background refresh bounds: months per run, statement timeout (apply scale), and a wall-clock budget per run. */
export const COMBOS_REFRESH_MAX_MONTHS = 12;
export const COMBOS_REFRESH_STATEMENT_TIMEOUT_MS = 120_000;
export const COMBOS_REFRESH_BUDGET_MS = 5 * 60_000;

/** The month lock key — IDENTICAL to lockSalesMonth (common/sales-kpi-ownership.ts), so apply and refresh exclude. */
export const salesMonthLockKey = (clientId: string, month: string) => `sales-month:${clientId}:${month}`;

/** A set header whose summary is missing (lines but no rows) or not entirely from that set. */
const STALE_PREDICATE = Prisma.sql`
  (s."lineRows" > 0 AND NOT EXISTS (
      SELECT 1 FROM "sales_month_history_combos" c WHERE c."clientId" = s."clientId" AND c."month" = s."month"))
  OR EXISTS (
      SELECT 1 FROM "sales_month_history_combos" c
       WHERE c."clientId" = s."clientId" AND c."month" = s."month"
         AND (c."sourceImportId" <> s."sourceImportId" OR c."appliedAt" <> s."appliedAt"))`;

export interface CombosRefreshResult { found: number; rebuilt: number; busy: number; fresh: number; failed: number; skipped: number }

type RefreshDb = Pick<Prisma.TransactionClient, '$queryRaw'> & {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, opts?: { timeout?: number; maxWait?: number }): Promise<T>;
};

/**
 * Rebuild stale / missing month summaries (bounded). For each month, in ITS OWN transaction under an apply-scale
 * statement timeout: pg_TRY_advisory_xact_lock on the same month key as apply (busy → skip, the next run retries),
 * re-check staleness after the lock, then DELETE + ONE INSERT … SELECT. Never throws; logs and returns counts.
 */
export async function refreshStaleMonthCombos(
  db: RefreshDb,
  log: { log(m: string): void; warn(m: string): void },
  opts: { limit?: number; budgetMs?: number; now?: () => number; shouldStop?: () => boolean } = {},
): Promise<CombosRefreshResult> {
  const out: CombosRefreshResult = { found: 0, rebuilt: 0, busy: 0, fresh: 0, failed: 0, skipped: 0 };
  const clock = opts.now ?? (() => Date.now());
  const t0 = clock();
  let candidates: Array<{ clientId: string; month: string }>;
  try {
    candidates = await db.$queryRaw<Array<{ clientId: string; month: string }>>(Prisma.sql`
      SELECT s."clientId" AS "clientId", s."month" AS "month"
        FROM "sales_month_history_sets" s
       WHERE ${STALE_PREDICATE}
       ORDER BY s."appliedAt" DESC
       LIMIT ${opts.limit ?? COMBOS_REFRESH_MAX_MONTHS}`);
  } catch (e) {
    log.warn(`sales-import combos refresh: could not list stale months: ${(e as Error).message}`);
    return out;
  }
  out.found = candidates.length;
  for (const { clientId, month } of candidates) {
    if (opts.shouldStop?.() || clock() - t0 >= (opts.budgetMs ?? COMBOS_REFRESH_BUDGET_MS)) {
      out.skipped++;
      continue;
    }
    try {
      const r = await db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${COMBOS_REFRESH_STATEMENT_TIMEOUT_MS}`);
          const lock = await tx.$queryRaw<Array<{ ok: boolean }>>(
            Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${salesMonthLockKey(clientId, month)}, 0)) AS "ok"`,
          );
          if (!lock[0]?.ok) return 'busy' as const; // an apply holds the month: it writes the summary itself
          const still = await tx.$queryRaw<Array<{ sourceImportId: string; appliedAt: Date }>>(Prisma.sql`
            SELECT s."sourceImportId" AS "sourceImportId", s."appliedAt" AS "appliedAt"
              FROM "sales_month_history_sets" s
             WHERE s."clientId" = ${clientId} AND s."month" = ${month} AND (${STALE_PREDICATE})`);
          if (still.length === 0) return 'fresh' as const; // rebuilt by another run / re-applied meanwhile
          await tx.$executeRaw(Prisma.sql`DELETE FROM "sales_month_history_combos" WHERE "clientId" = ${clientId} AND "month" = ${month}`);
          const rows = await tx.$executeRaw(insertMonthCombosSql(clientId, month, still[0].sourceImportId, new Date(still[0].appliedAt)));
          log.log(JSON.stringify({ msg: 'sales-import combos summary rebuilt', clientId, month, rows: Number(rows) }));
          return 'rebuilt' as const;
        },
        { timeout: COMBOS_REFRESH_STATEMENT_TIMEOUT_MS + 30_000, maxWait: 10_000 },
      );
      out[r]++;
    } catch (e) {
      out.failed++;
      log.warn(`sales-import combos refresh ${clientId} ${month} failed (next run retries): ${(e as Error).message}`);
    }
  }
  if (out.found > 0) log.log(JSON.stringify({ msg: 'sales-import combos refresh', ...out }));
  return out;
}
