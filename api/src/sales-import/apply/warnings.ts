/**
 * Month warnings (plan §6.3). PURE. Used by preview (display) and apply (the ack checks), so both agree.
 */
import type { MonthSummary, SalesMonthWarning } from '../sales-import.contract';
import { lastDayOfMonth } from '../months/month-state';

/** STARTS_AFTER_FIRST / ENDS_BEFORE_MONTH_END (the latter never for the current month: it is still running). */
export function partialMonthWarnings(summary: Pick<MonthSummary, 'month' | 'firstDate' | 'lastDate'>, currentMonth: string): SalesMonthWarning[] {
  const out: SalesMonthWarning[] = [];
  if (!summary.firstDate || summary.firstDate.slice(8, 10) !== '01') out.push('STARTS_AFTER_FIRST');
  if (summary.month !== currentMonth && (!summary.lastDate || summary.lastDate < lastDayOfMonth(summary.month))) {
    out.push('ENDS_BEFORE_MONTH_END');
  }
  return out;
}

/**
 * OLDER_THAN_LAST_APPLIED (UX-1, data recency — not upload time): this file's latest invoice date IN THE MONTH is
 * earlier than the latest invoice date of the import last applied to the month. Re-applying the same import never warns.
 */
export function isOlderThanLastApplied(
  thisImport: { id: string; lastDate: string },
  lastApplied: { importId: string; lastInvoiceDate: string | null } | null | undefined,
): boolean {
  return (
    !!lastApplied &&
    lastApplied.importId !== thisImport.id &&
    !!lastApplied.lastInvoiceDate &&
    !!thisImport.lastDate &&
    thisImport.lastDate < lastApplied.lastInvoiceDate
  );
}

/** The latest invoice date of `month` in an import's frozen month summaries (null when absent). */
export function lastInvoiceDateOf(monthSummaries: unknown, month: string): string | null {
  if (!Array.isArray(monthSummaries)) return null;
  const s = (monthSummaries as Array<{ month?: unknown; lastDate?: unknown }>).find((x) => x?.month === month);
  return typeof s?.lastDate === 'string' ? s.lastDate : null;
}

/**
 * REPLACES_MANUAL_VALUES: some current row of the month holds an owned key whose value was NOT written by the importer:
 *   - the month was never applied, or
 *   - the key was not owned at the last apply (the KPI moved manual → importer since), or
 *   - the row's batch is a MANUAL batch created after the last apply (only possible while the KPI was released).
 * (The plan's literal rule — "owned key on a row whose batch ≠ SALES_IMPORT" — would fire forever, because an apply
 * deliberately keeps the batchId of rows it updates.)
 */
export function replacesManualValues(
  rows: Array<{ kpiValues: unknown; batch: { status: string; createdAt: Date } | null }>,
  owned: readonly string[],
  lastApply: { createdAt: Date; ownedCodes: readonly string[] } | null,
  importerStatus: string,
): boolean {
  for (const r of rows) {
    const v = r.kpiValues;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    for (const k of owned) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      if (!lastApply) return true;
      if (!lastApply.ownedCodes.includes(k)) return true;
      if (r.batch && r.batch.status !== importerStatus && r.batch.createdAt > lastApply.createdAt) return true;
    }
  }
  return false;
}
