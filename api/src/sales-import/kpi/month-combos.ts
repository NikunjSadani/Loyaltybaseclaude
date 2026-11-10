import { Prisma } from '@prisma/client';
import { sqlUtc } from '../sql-time';

/**
 * The per-month combos summary (plan §10c): sales_month_history_combos, one row per (tenant, month, product combo). The
 * month's set header (sales_month_history_sets) records which history set the summary was built from
 * (`combosSourceImportId` + `combosAppliedAt`), written by the apply in the SAME transaction as the summary.
 *   - WRITE: only the apply, right after the history INSERT (insertMonthCombosSql + the header stamp). There is no
 *     background rebuild (lead decision 2026-11-10): a summary can only be missing / stale if an OLDER revision applied
 *     the month during the deploy that introduced this table; re-applying the month rebuilds it.
 *   - READ: GET history-combos — strictly read-only (classifyMonthSummaries decides summary vs stored lines).
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
 * built from another set (an older revision re-applied the month without rebuilding it).
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
