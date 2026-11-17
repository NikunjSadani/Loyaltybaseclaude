/**
 * Sales Import retention — the ONE place every sweep, reader and the one-off trim read their windows from.
 *
 * Two regimes, chosen by the switch SALES_RETENTION_V2 (env; exactly "on" enables it — anything else, including unset,
 * is OFF, the default):
 *   - OFF (default; what origin/develop did — a deploy changes NO retention): per-import aggregates / raw files /
 *     unmatched.csv are purged SALES_IMPORT_RETENTION_DAYS (30) days after the import finished, and month history (lines,
 *     product-list summary, set headers) is kept SALES_MONTH_HISTORY_RETENTION_YEARS (10) years.
 *   - ON (owner decision 2026-11-18; turned on ONLY after the runbook in SALES-IMPORT-PIPELINE-PLAN.md §17b — backup,
 *     rebuild-days, trim): per-import data 7 days (SALES_IMPORT_RETENTION_DAYS_V2), month history the current IST month +
 *     the 3 before it (SALES_MONTH_HISTORY_RETENTION_MONTHS; the setting SALES_HISTORY_RETENTION_MONTHS overrides it).
 *
 * The DAY-LEVEL data (outlet_sales_days + sales_day_sets) always follows the 4-month window, whatever the switch: the
 * tables are new (nothing existing is deleted by it — every row in them was written by this release), the comparison
 * that reads them needs only the current month + 3 previous, and bounding them from day one keeps them small.
 *
 * The one-off trim (oneoff/sales-history-trim.ts) applies the V2 windows EXPLICITLY with --apply (v2WindowMonths /
 * SALES_IMPORT_RETENTION_DAYS_V2), independent of the switch — it is the step that brings existing data to the new
 * windows before the switch is turned on.
 *
 * A month is either inside the history window everywhere or outside it everywhere: the sweep deletes history of every
 * month BEFORE historyCutoffMonth(); readers (Months list, recalculate, rebuild product list, KPI picker) treat such a
 * month as having no history even while the bounded sweep is still deleting it.
 */
import { currentMonthKey } from '../targets/targets.helpers';
import {
  SALES_IMPORT_RETENTION_DAYS,
  SALES_IMPORT_RETENTION_DAYS_V2,
  SALES_MONTH_HISTORY_RETENTION_MONTHS,
  SALES_MONTH_HISTORY_RETENTION_YEARS,
} from './sales-import.contract';
import { monthLabel, shiftMonthKey } from './months/month-state';

export const SALES_RETENTION_V2_ENV = 'SALES_RETENTION_V2';

/** Is the new retention (7-day import data, 4-month history) switched on? Default OFF. */
export function salesRetentionV2(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SALES_RETENTION_V2_ENV]?.trim().toLowerCase() === 'on';
}

/** Days after an import finishes that its aggregates / raw files / unmatched.csv are purged (30 OFF, 7 ON). */
export function importRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return salesRetentionV2(env) ? SALES_IMPORT_RETENTION_DAYS_V2 : SALES_IMPORT_RETENTION_DAYS;
}

/**
 * The NEW (V2) month window: SALES_HISTORY_RETENTION_MONTHS (whole number 1..120) or the default 4. Used by the day
 * data always, by month history when the switch is ON, and by the one-off trim explicitly.
 */
export function v2WindowMonths(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SALES_HISTORY_RETENTION_MONTHS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return SALES_MONTH_HISTORY_RETENTION_MONTHS;
  const n = Number(raw);
  return n >= 1 && n <= 120 ? n : SALES_MONTH_HISTORY_RETENTION_MONTHS;
}

/** The legacy 10-year history window, as a month count for historyCutoffMonth (cutoff = current − 120 months, exactly as before). */
export const LEGACY_HISTORY_WINDOW_MONTHS = SALES_MONTH_HISTORY_RETENTION_YEARS * 12 + 1;

/** Months of month HISTORY kept (current month included): the V2 window when ON, the legacy 10 years when OFF. */
export function historyRetentionMonths(env: NodeJS.ProcessEnv = process.env): number {
  return salesRetentionV2(env) ? v2WindowMonths(env) : LEGACY_HISTORY_WINDOW_MONTHS;
}

/** The OLDEST month whose history is still kept (inclusive). OFF: current − 120 months; ON (default 4): current − 3. */
export function historyCutoffMonth(currentMonth: string = currentMonthKey(), months: number = historyRetentionMonths()): string {
  return shiftMonthKey(currentMonth, -(months - 1));
}

/** Is `month` older than the history window (its history is deleted, or being deleted)? */
export function isBeyondHistoryRetention(month: string, currentMonth: string = currentMonthKey()): boolean {
  return month < historyCutoffMonth(currentMonth);
}

/** The OLDEST month whose DAY-LEVEL data is kept — always the V2 window (see the header). */
export function dayDataCutoffMonth(currentMonth: string = currentMonthKey(), env: NodeJS.ProcessEnv = process.env): string {
  return shiftMonthKey(currentMonth, -(v2WindowMonths(env) - 1));
}

export function isBeyondDayDataRetention(month: string, currentMonth: string = currentMonthKey()): boolean {
  return month < dayDataCutoffMonth(currentMonth);
}

/** The honest message for a month outside the history window (recalculate / rebuild product list / picker). */
export function historyRetentionMessage(month: string): string {
  if (!salesRetentionV2()) {
    return (
      `${monthLabel(month)} is older than the stored sales lines: they are kept for ${SALES_MONTH_HISTORY_RETENTION_YEARS} years. ` +
      'To change its figures, apply a sales file to it again.'
    );
  }
  const n = historyRetentionMonths();
  return (
    `${monthLabel(month)} is older than the stored sales lines: they are kept only for the current month and the ` +
    `${n - 1} month${n - 1 === 1 ? '' : 's'} before it. To change its figures, apply a sales file to it again.`
  );
}

/** Why a month outside the day-data window gets no day-by-day figures (apply / recalculate result). */
export function dayDataRetentionMessage(month: string): string {
  const n = v2WindowMonths();
  return (
    `Day-by-day figures are kept only for the current month and the ${n - 1} month${n - 1 === 1 ? '' : 's'} before it, ` +
    `so none were stored for ${monthLabel(month)} (its monthly figures were updated as usual).`
  );
}
