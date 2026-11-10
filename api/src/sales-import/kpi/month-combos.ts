import { Prisma } from '@prisma/client';
import { sqlUtc } from '../sql-time';

/**
 * The per-month combos summary write (plan §10c): ONE INSERT … SELECT … GROUP BY over the month's stored history lines,
 * stamped with the history set it summarises (`sourceImportId` + `appliedAt` = the SalesMonthHistorySet header). Used by
 * the apply (right after the history INSERT, same transaction) and by the history-combos reader when it finds a month
 * whose summary is missing or belongs to another set (re-check L-a). dimKey is the stable key of dims (1:1), so grouping
 * by both is grouping by dimKey. The caller DELETEs the month's rows first.
 */
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
