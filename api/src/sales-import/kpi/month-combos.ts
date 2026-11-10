import { Prisma } from '@prisma/client';
import { sqlUtc } from '../sql-time';

/**
 * The per-month combos summary (plan §10c): sales_month_history_combos, one row per (tenant, month, product combo). The
 * month's set header (sales_month_history_sets) records which history set the summary was built from
 * (`combosSourceImportId` + `combosAppliedAt`, written in the SAME transaction as the summary).
 *   - WRITE: the apply, right after the history INSERT, in its transaction (insertMonthCombosSql + the header stamp).
 *   - READ: GET history-combos — strictly read-only; a month whose summary is missing or from another set is answered
 *     as well as it can be and flagged `refreshingMonths` (classifyMonthSummaries).
 *   - REPAIR: refreshStaleMonthCombos, in the BACKGROUND (worker drain, inline drain, Cloud Scheduler drain) only.
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

export interface SetHead {
  month: string;
  sourceImportId: string;
  appliedAt: Date;
  lineRows: number;
  combosSourceImportId: string | null;
  combosAppliedAt: Date | null;
}
export type SummaryState = 'current' | 'stale' | 'missing' | 'empty';

/**
 * From the set header alone (no summary scan): current = the summary was built from this set; missing = no summary was
 * ever built for the month (stamp null) while it has lines; empty = no lines and no summary; stale = the summary was
 * built from another set (e.g. an older revision re-applied the month during a deploy and did not rebuild it).
 */
export function classifyMonthSummaries(sets: SetHead[]): Map<string, SummaryState> {
  const out = new Map<string, SummaryState>();
  for (const s of sets) {
    const at = s.combosAppliedAt ? new Date(s.combosAppliedAt).getTime() : null;
    if (s.combosSourceImportId === s.sourceImportId && at === new Date(s.appliedAt).getTime()) out.set(s.month, 'current');
    else if (s.combosSourceImportId === null) out.set(s.month, s.lineRows > 0 ? 'missing' : 'empty');
    else out.set(s.month, 'stale');
  }
  return out;
}

/** Bounds of one background refresh run. */
export interface CombosRefreshLimits {
  /** Months rebuilt at most per run. */
  limit: number;
  /** No new month is started after this much wall time (a started month runs to its tx bound). */
  budgetMs: number;
  /** Per statement (re-check L2: below the 30 s close / reopen and 60 s target-upload waiters on the month lock). */
  statementTimeoutMs: number;
  /** Per month transaction. */
  txTimeoutMs: number;
}

/** The job worker (no HTTP deadline): up to 12 months in ≤ 5 min; a month's tx may span several 25 s statements. */
export const COMBOS_REFRESH_WORKER_LIMITS: CombosRefreshLimits = { limit: 12, budgetMs: 5 * 60_000, statementTimeoutMs: 25_000, txTimeoutMs: 110_000 };
/**
 * Inside an HTTP request (Cloud Scheduler drain; also the API's inline drain): at most 2 months, no new month after 45 s,
 * each month ≤ 30 s → the refresh ends within ~75 s, well inside the scheduler's attempt deadline (plan §14: 170 s)
 * together with the retention sweep. A month that does not fit is retried by the next run.
 */
export const COMBOS_REFRESH_HTTP_LIMITS: CombosRefreshLimits = { limit: 2, budgetMs: 45_000, statementTimeoutMs: 25_000, txTimeoutMs: 30_000 };

/** The month lock key — IDENTICAL to lockSalesMonth (common/sales-kpi-ownership.ts), so apply and refresh exclude. */
export const salesMonthLockKey = (clientId: string, month: string) => `sales-month:${clientId}:${month}`;

/** A set header whose summary stamp is not the set itself (a header-row comparison; never scans the summary). */
const STALE_HEADER = Prisma.sql`
  (s."combosSourceImportId" IS DISTINCT FROM s."sourceImportId" OR s."combosAppliedAt" IS DISTINCT FROM s."appliedAt")`;

export interface CombosRefreshResult { found: number; rebuilt: number; busy: number; fresh: number; failed: number; skipped: number }

type RefreshDb = Pick<Prisma.TransactionClient, '$queryRaw'> & {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, opts?: { timeout?: number; maxWait?: number }): Promise<T>;
};

/**
 * Rebuild stale / missing month summaries (bounded by `limits`). For each month, in ITS OWN transaction under the
 * statement timeout: pg_TRY_advisory_xact_lock on the same month key as apply (busy → skip, the next run retries),
 * re-check the header after the lock, then DELETE + ONE INSERT … SELECT + stamp the header (guarded by the set it
 * read). Never throws; logs and returns counts.
 */
export async function refreshStaleMonthCombos(
  db: RefreshDb,
  log: { log(m: string): void; warn(m: string): void },
  limits: CombosRefreshLimits,
  opts: { now?: () => number; shouldStop?: () => boolean } = {},
): Promise<CombosRefreshResult> {
  const out: CombosRefreshResult = { found: 0, rebuilt: 0, busy: 0, fresh: 0, failed: 0, skipped: 0 };
  const clock = opts.now ?? (() => Date.now());
  const t0 = clock();
  let candidates: Array<{ clientId: string; month: string }>;
  try {
    candidates = await db.$queryRaw<Array<{ clientId: string; month: string }>>(Prisma.sql`
      SELECT s."clientId" AS "clientId", s."month" AS "month"
        FROM "sales_month_history_sets" s
       WHERE ${STALE_HEADER}
       ORDER BY s."appliedAt" DESC
       LIMIT ${limits.limit}`);
  } catch (e) {
    log.warn(`sales-import combos refresh: could not list stale months: ${(e as Error).message}`);
    return out;
  }
  out.found = candidates.length;
  for (const { clientId, month } of candidates) {
    if (opts.shouldStop?.() || clock() - t0 >= limits.budgetMs) {
      out.skipped++;
      continue;
    }
    try {
      const r = await db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.floor(limits.statementTimeoutMs)}`);
          const lock = await tx.$queryRaw<Array<{ ok: boolean }>>(
            Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${salesMonthLockKey(clientId, month)}, 0)) AS "ok"`,
          );
          if (!lock[0]?.ok) return 'busy' as const; // an apply holds the month: it writes the summary itself
          const still = await tx.$queryRaw<Array<{ sourceImportId: string; appliedAt: Date }>>(Prisma.sql`
            SELECT s."sourceImportId" AS "sourceImportId", s."appliedAt" AS "appliedAt"
              FROM "sales_month_history_sets" s
             WHERE s."clientId" = ${clientId} AND s."month" = ${month} AND ${STALE_HEADER}`);
          if (still.length === 0) return 'fresh' as const; // rebuilt by another run / re-applied meanwhile
          const src = still[0].sourceImportId;
          const at = new Date(still[0].appliedAt);
          await tx.$executeRaw(Prisma.sql`DELETE FROM "sales_month_history_combos" WHERE "clientId" = ${clientId} AND "month" = ${month}`);
          const rows = await tx.$executeRaw(insertMonthCombosSql(clientId, month, src, at));
          await tx.$executeRaw(Prisma.sql`
            UPDATE "sales_month_history_sets"
               SET "combosSourceImportId" = ${src}, "combosAppliedAt" = ${sqlUtc(at)}
             WHERE "clientId" = ${clientId} AND "month" = ${month}
               AND "sourceImportId" = ${src} AND "appliedAt" = ${sqlUtc(at)}`);
          log.log(JSON.stringify({ msg: 'sales-import combos summary rebuilt', clientId, month, rows: Number(rows) }));
          return 'rebuilt' as const;
        },
        { timeout: limits.txTimeoutMs, maxWait: 5_000 },
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
