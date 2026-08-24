/**
 * Gift Disbursal report (Gift Catalogue & Dispatch §6) — PURE grouping + xlsx build,
 * DI-free.
 *
 * MONEY-EXACTNESS INVARIANT (review): the ₹ VALUE disbursed is summed ONLY over
 * DELIVERED orders using the FROZEN `valuePaise` — the SAME basis 194R Source-2 uses
 * (it sums DELIVERED valuePaise per PAN). A CANCELLED order keeps its valuePaise
 * (refund zeroes only points), and a RETURNED order has valuePaise zeroed by the
 * Gifsy transition — so filtering to DELIVERED makes the report total == the 194R
 * base. Counts + a status breakdown span ALL statuses; only VALUE is DELIVERED-only.
 */

import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '../common/xlsx';

export interface DisbursalOrderRow {
  clientId: string;
  /** The fulfilling vendor, or null for a PLATFORM/Gifsy-fulfilled order. */
  vendorId: string | null;
  status: string;
  /** Frozen order value (paise); null for pre-value orders → treated as 0. */
  valuePaise: bigint | null;
}

export interface DisbursalGroup {
  clientId: string;
  clientName: string;
  vendorId: string | null;
  vendorName: string;
  /** Number of DELIVERED orders in this group. */
  deliveredCount: number;
  /** Sum of DELIVERED valuePaise (paise) — the 194R-aligned value basis. */
  valuePaise: number;
  /** Number of orders across ALL statuses in this group. */
  totalOrders: number;
  /** Count per status across all statuses. */
  statusBreakdown: Record<string, number>;
}

export interface DisbursalReport {
  items: DisbursalGroup[];
  totals: { deliveredCount: number; valuePaise: number; totalOrders: number };
}

const DELIVERED = 'DELIVERED';

/**
 * Group already-fetched orders into per-(tenant, vendor) disbursal rows. `clientNames`
 * / `vendorNames` are id→label maps; a null vendorId is labelled "Platform".
 */
export function buildDisbursalReport(
  rows: DisbursalOrderRow[],
  clientNames: Map<string, string>,
  vendorNames: Map<string, string>,
): DisbursalReport {
  const groups = new Map<string, DisbursalGroup>();
  const totals = { deliveredCount: 0, valuePaise: 0, totalOrders: 0 };

  for (const r of rows) {
    const key = `${r.clientId}::${r.vendorId ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        clientId: r.clientId,
        clientName: clientNames.get(r.clientId) ?? r.clientId,
        vendorId: r.vendorId,
        vendorName: r.vendorId ? vendorNames.get(r.vendorId) ?? r.vendorId : 'Platform',
        deliveredCount: 0,
        valuePaise: 0,
        totalOrders: 0,
        statusBreakdown: {},
      };
      groups.set(key, g);
    }
    g.totalOrders += 1;
    totals.totalOrders += 1;
    g.statusBreakdown[r.status] = (g.statusBreakdown[r.status] ?? 0) + 1;

    if (r.status === DELIVERED) {
      const v = r.valuePaise != null ? Number(r.valuePaise) : 0;
      g.deliveredCount += 1;
      g.valuePaise += v;
      totals.deliveredCount += 1;
      totals.valuePaise += v;
    }
  }

  const items = [...groups.values()].sort(
    (a, b) =>
      a.clientName.localeCompare(b.clientName) || a.vendorName.localeCompare(b.vendorName),
  );
  return { items, totals };
}

/** Build an .xlsx export of the disbursal report (one row per tenant×vendor group). */
export function buildDisbursalXlsx(report: DisbursalReport): Buffer {
  const header = [
    'Tenant',
    'Vendor',
    'Delivered Orders',
    'Value Disbursed (₹)',
    'Total Orders',
    'Status Breakdown',
  ];
  const dataRows = report.items.map((g) => [
    g.clientName,
    g.vendorName,
    g.deliveredCount,
    (g.valuePaise / 100).toFixed(2),
    g.totalOrders,
    Object.entries(g.statusBreakdown)
      .map(([s, c]) => `${s}:${c}`)
      .join(', '),
  ]);
  const totalRow = [
    'TOTAL',
    '',
    report.totals.deliveredCount,
    (report.totals.valuePaise / 100).toFixed(2),
    report.totals.totalOrders,
    '',
  ];

  const ws = aoaToSheetSafe([header, ...dataRows, totalRow]);
  ws['!cols'] = [{ wch: 20 }, { wch: 24 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 40 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Gift Disbursal');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
