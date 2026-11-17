/**
 * The month-history / day-data retention WINDOW (owner decision 2026-11-18): the current IST month + the 3 months before
 * it (SALES_MONTH_HISTORY_RETENTION_MONTHS = 4). One helper for every writer, reader and the retention sweep, so a month
 * is either inside the window everywhere or outside it everywhere:
 *   - the sweep deletes history lines / product-list summary / set headers AND outlet_sales_days / sales_day_sets of every
 *     month BEFORE `historyCutoffMonth()`;
 *   - readers (Months list, recalculate, rebuild product list, KPI picker "stored months") treat such a month as having
 *     no history even while the bounded sweep is still deleting it (never a half-deleted month).
 * Setting: env SALES_HISTORY_RETENTION_MONTHS (whole number 1..120; anything else → the default 4).
 */
import { currentMonthKey } from '../targets/targets.helpers';
import { SALES_MONTH_HISTORY_RETENTION_MONTHS } from './sales-import.contract';
import { monthLabel, shiftMonthKey } from './months/month-state';

export function historyRetentionMonths(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SALES_HISTORY_RETENTION_MONTHS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return SALES_MONTH_HISTORY_RETENTION_MONTHS;
  const n = Number(raw);
  return n >= 1 && n <= 120 ? n : SALES_MONTH_HISTORY_RETENTION_MONTHS;
}

/** The OLDEST month still kept (inclusive). With the default 4 and current month 2026-11 → '2026-08'. */
export function historyCutoffMonth(currentMonth: string = currentMonthKey(), months: number = historyRetentionMonths()): string {
  return shiftMonthKey(currentMonth, -(months - 1));
}

/** Is `month` older than the retention window (its history / day data is deleted, or being deleted)? */
export function isBeyondHistoryRetention(month: string, currentMonth: string = currentMonthKey()): boolean {
  return month < historyCutoffMonth(currentMonth);
}

/** The honest message for a month outside the window (recalculate / rebuild product list / picker). */
export function historyRetentionMessage(month: string): string {
  const n = historyRetentionMonths();
  return (
    `${monthLabel(month)} is older than the stored sales lines: they are kept only for the current month and the ` +
    `${n - 1} month${n - 1 === 1 ? '' : 's'} before it. To change its figures, apply a sales file to it again.`
  );
}
