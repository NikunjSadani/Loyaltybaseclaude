/**
 * Billing comparison — the Excel of the "billing slower than usual" outlet list on the admin billing card
 * (GET /v1/admin/dashboard/billing-progress/comparison/slower-outlets/export, or POST admin/exports
 * {kind:'billing-comparison-slower'}).
 *
 * Rows are EXACTLY the on-screen list (same loader: admin-core/dashboards/billing-comparison.ts → slowerRows), every
 * row, same sort (ratio ascending, then last-month MTD descending). At most one row per outlet → streams instantly.
 * When the comparison isn't available, the About sheet says why and the list sheet is empty (never a silent blank file).
 */
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { istDateTimeCell, istMonthKey } from '../../../common/ist-date';
import type { ExportKindDef, ExportRunContext } from '../../export-kinds';
import type { XlsxStreamWriter } from '../../../common/xlsx-stream';
import { type BillingProgressFilters, parseBillingProgressFilters } from '../../../admin-core/dashboards/billing-progress';
import { loadBillingComparison, type BillingComparisonData } from '../../../admin-core/dashboards/billing-comparison';
import { unitSuffix } from './billing-progress.kind';
import { monthWords } from './kind-support';

export const BILLING_COMPARISON_SLOWER_KIND_ID = 'billing-comparison-slower';

export type BillingComparisonExportParams = BillingProgressFilters;

function describe(p: BillingComparisonExportParams): string {
  const parts = [`Billing slower than usual — ${p.month ? monthWords(p.month) : 'current month'}`];
  if (p.program) parts.push(`Program: ${p.program}`);
  if (p.outletType) parts.push(`Outlet type: ${p.outletType}`);
  if (p.managerId) parts.push('One manager’s team');
  return parts.join(' · ');
}

/** Plain-words status of the comparison for the About sheet. */
export function comparisonStatusText(d: BillingComparisonData): string {
  switch (d.reason) {
    case 'NO_KPI':
      return 'No enabled KPI — nothing to compare.';
    case 'NO_DAY_LEVEL_DATA':
      return 'This program has no day-by-day sales data, so month-to-date comparisons are not available.';
    case 'NO_DAY_DATA_FOR_MONTH':
      return `No day-by-day sales data for ${monthWords(d.month)} yet.`;
    case 'KPI_NOT_IN_DAY_DATA':
      return `The day-by-day sales data does not include ${d.kpi?.label ?? 'this KPI'}.`;
    default:
      break;
  }
  if (!d.lastMonth.available) {
    return d.lastMonth.availableFrom
      ? `Comparison with last month available from ${monthWords(d.lastMonth.availableFrom)}.`
      : 'Comparison with last month is not available.';
  }
  return 'Compared';
}

async function run(ctx: ExportRunContext, p: BillingComparisonExportParams, out: XlsxStreamWriter): Promise<{ rowCount: number }> {
  const data = await loadBillingComparison(ctx.prisma, ctx.clientId, p, ctx.now);
  const suffix = unitSuffix(data.kpi?.unit);
  const day = data.compareDay;

  const about = await out.addSheet('About', ['Field', 'Value'], { widths: [24, 70] });
  const aboutRows: Array<[string, string]> = [
    ['Report', 'Billing slower than usual'],
    ['Month', monthWords(data.month)],
    ['KPI', data.kpi ? `${data.kpi.label} (${data.kpi.code})` : 'No enabled KPI'],
    ['Compared to day', day ? `Day ${day} (each month read to the same day, or its last day if shorter)` : '—'],
    ['Last month', `${monthWords(data.lastMonth.month)}${data.lastMonth.compareDay ? ` to day ${data.lastMonth.compareDay}` : ''}`],
    ['Rule', `Outlets with a target whose month-to-date billing is below ${data.slowerThanUsual.thresholdPct}% of their own billing last month to the same day (outlets that billed nothing last month to that day are not listed)`],
    ['Status', comparisonStatusText(data)],
    ['Program', p.program ?? 'All programs'],
    ['Outlet type', p.outletType ?? 'All outlet types'],
    ['Manager', p.managerId ? (data.managerName ?? 'Unknown manager') + ' (and their team)' : 'Everyone'],
    ['Generated at (IST)', istDateTimeCell(ctx.now)],
  ];
  for (const r of aboutRows) await about.addRow(r);

  const headers = [
    'Outlet Code',
    'Outlet Name',
    'Program',
    'SO',
    'ASM',
    `Billed this month to day ${day ?? '—'}${suffix}`,
    `Billed last month to day ${data.lastMonth.compareDay ?? '—'}${suffix}`,
    '% of last month',
  ];
  const sheet = await out.addSheet('Slower than usual', headers);
  let rowCount = 0;
  for (const r of data.slowerRows) {
    await sheet.addRow([r.outletCode, r.outletName, r.program ?? '', r.soName ?? '', r.asmName ?? '', r.currentMtd, r.lastMonthMtd, r.ratioPct]);
    rowCount++;
  }
  return { rowCount };
}

export const BILLING_COMPARISON_SLOWER_KIND: ExportKindDef<BillingComparisonExportParams> = {
  kind: BILLING_COMPARISON_SLOWER_KIND_ID,
  label: 'Billing slower than usual',
  // Same as GET /v1/admin/dashboard/billing-progress/comparison/slower-outlets (AdminDashboardController).
  access: { roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER'], permission: 'reports:read' },
  parseParams: (raw: unknown, _user: JwtPayload) => parseBillingProgressFilters(raw),
  isHeavy: () => false,
  describeParams: describe,
  fileName: (p, now) => `billing-slower-than-usual-${p.month ?? istMonthKey(now)}.xlsx`,
  run,
};
