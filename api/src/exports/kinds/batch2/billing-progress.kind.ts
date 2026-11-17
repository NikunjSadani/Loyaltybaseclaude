/**
 * Billing progress — the Excel of ONE tile's outlet list on the admin Billing-progress dashboard
 * (GET /v1/admin/dashboard/billing-progress/outlets/export, or POST admin/exports {kind:'billing-progress-outlets'}).
 *
 * Rows are EXACTLY the on-screen list (same loader: admin-core/dashboards/billing-progress.ts → selectBillingRows),
 * every row (no paging), same sort (achievement % ascending, then target descending).
 *
 * Paging note: the report is a per-outlet bucketing of the whole month, so the loader reads the tenant's outlet
 * universe + the month's target/sales rows once (≈6.5k each at Bajaj — the same reads the dashboard endpoint does)
 * and then writes the selected rows; the file is at most one row per outlet, so it streams instantly (not heavy).
 */
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { istDateTimeCell, istMonthKey } from '../../../common/ist-date';
import type { ExportKindDef, ExportRunContext } from '../../export-kinds';
import type { XlsxStreamWriter } from '../../../common/xlsx-stream';
import {
  billingListLabel,
  monthStatusOf,
  type BillingListKey,
  type BillingProgressFilters,
  loadBillingProgress,
  parseBillingListKey,
  parseBillingProgressFilters,
  selectBillingRows,
} from '../../../admin-core/dashboards/billing-progress';
import { monthWords } from './kind-support';

export const BILLING_PROGRESS_OUTLETS_KIND_ID = 'billing-progress-outlets';

export interface BillingProgressExportParams extends BillingProgressFilters {
  bucket: BillingListKey;
}

export function parseBillingProgressExportParams(raw: unknown): BillingProgressExportParams {
  const q = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  return { ...parseBillingProgressFilters(q), bucket: parseBillingListKey(q.bucket) };
}

/** Downloads-page summary. Month status is derived from the month (a past month → "Missed target"), the same
 *  wording as the About sheet. `now` is injectable for tests. */
export function describeBillingExport(p: BillingProgressExportParams, now: Date = new Date()): string {
  const status = p.month ? monthStatusOf(p.month, now) : 'CURRENT';
  const parts = [
    `Billing progress — ${billingListLabel(p.bucket, status)} — ${p.month ? monthWords(p.month) : 'current month'}`,
  ];
  if (p.program) parts.push(`Program: ${p.program}`);
  if (p.outletType) parts.push(`Outlet type: ${p.outletType}`);
  if (p.managerId) parts.push('One manager’s team');
  return parts.join(' · ');
}

function describe(p: BillingProgressExportParams): string {
  return describeBillingExport(p);
}

/** Same INR spellings as the screen (platform/src/lib/format-inr.ts `isInrUnit`). */
export function isInrUnit(unit: string | null | undefined): boolean {
  const u = (unit ?? '').trim().toLowerCase();
  return ['inr', '₹', 'rs', 'rs.', 'rupee', 'rupees'].includes(u);
}

/** Column-header unit suffix: INR → " (₹)", another unit → " (<unit>)", none → "". */
export function unitSuffix(unit: string | null | undefined): string {
  if (isInrUnit(unit)) return ' (₹)';
  const u = (unit ?? '').trim();
  return u ? ` (${u})` : '';
}

async function run(ctx: ExportRunContext, p: BillingProgressExportParams, out: XlsxStreamWriter): Promise<{ rowCount: number }> {
  const { bucket, ...filters } = p;
  const data = await loadBillingProgress(ctx.prisma, ctx.clientId, filters, ctx.now);
  const suffix = unitSuffix(data.kpi?.unit);

  // Sheet 1 — "About": what this file is, so it still makes sense once forwarded.
  const about = await out.addSheet('About', ['Field', 'Value'], { widths: [24, 60] });
  const aboutRows: Array<[string, string]> = [
    ['Report', 'Monthly billing progress'],
    ['List', billingListLabel(bucket, data.monthStatus, data.fullMonth)],
    ['Month', monthWords(data.month)],
    ['KPI', data.kpi ? `${data.kpi.label} (${data.kpi.code})` : 'No enabled KPI'],
    ['Program', filters.program ?? 'All programs'],
    ['Outlet type', filters.outletType ?? 'All outlet types'],
    ['Manager', filters.managerId ? (data.managerName ?? 'Unknown manager') + ' (and their team)' : 'Everyone'],
    ['Data as of', data.asOf ?? 'No sales uploaded for this month yet'],
    [
      'Target rows not in the live roster (tenant-wide)',
      `${data.targetsOutsideRoster} — for outlets deleted, parked or not interested; not counted in this report`,
    ],
    ['Generated at (IST)', istDateTimeCell(ctx.now)],
    ['Note', 'Includes outlets whose KYC is still pending (they can bill). Billed = achieved value of the KPI.'],
  ];
  for (const r of aboutRows) await about.addRow(r);

  // Sheet 2 — the outlets, exactly the on-screen list. Same word as the screen: "Billed".
  const headers = [
    'Outlet Code',
    'Outlet Name',
    'Program',
    'Outlet Type',
    'SO',
    'ASM',
    `Target${suffix}`,
    `Billed${suffix}`,
    'Achievement %',
    'Note',
  ];
  const sheet = await out.addSheet('Billing progress', headers);
  let rowCount = 0;
  for (const r of selectBillingRows(data, bucket)) {
    await sheet.addRow([
      r.outletCode,
      r.outletName,
      r.program ?? '',
      r.outletType ?? '',
      r.soName ?? '',
      r.asmName ?? '',
      r.target,
      r.achieved,
      r.pct ?? '',
      r.note ?? '',
    ]);
    rowCount++;
  }
  return { rowCount };
}

export const BILLING_PROGRESS_OUTLETS_KIND: ExportKindDef<BillingProgressExportParams> = {
  kind: BILLING_PROGRESS_OUTLETS_KIND_ID,
  label: 'Billing progress',
  // Same as GET /v1/admin/dashboard/billing-progress/outlets (AdminDashboardController).
  access: { roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER'], permission: 'reports:read' },
  parseParams: (raw: unknown, _user: JwtPayload) => parseBillingProgressExportParams(raw),
  isHeavy: () => false,
  describeParams: describe,
  fileName: (p, now) => `billing-progress-${p.bucket.toLowerCase().replace(/_/g, '-')}-${p.month ?? istMonthKey(now)}.xlsx`,
  run,
};
