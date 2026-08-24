/* ─── Gift DISBURSAL report (Wave-2) — pure types + helpers + xlsx generator ────
   The tenant-accessible + Gifsy gift-disbursal report (§6 / §12 of the design doc):
   per-tenant + per-vendor counts, the delivered ₹ value, and a status breakdown,
   over a date range, with an xlsx export.

   Two entry points share this lib (§2 personas):
     - GIFSY_ADMIN → all tenants + all vendors, with tenant + vendor filters.
     - CLIENT_ADMIN → strictly their OWN tenant (BE-scoped); no tenant filter/column.

   IMPORTANT value basis (§12): the disbursal ₹ value counts DELIVERED orders only, to
   match 194R Source-2 (a report total must equal the 194R delivered-value total for a
   tenant). CANCELLED orders keep valuePaise (refund zeroes points, not value), so any
   value sum MUST filter to DELIVERED — done here in `deliveredValuePaise`.

   Kept pure so the filter→query builder, the totals, and the workbook are unit-testable.
   Endpoint consumed: GET /api/admin/gift-disbursal?clientId=&vendorId=&from=&to=
────────────────────────────────────────────────────────────────────────────── */

import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '@/lib/xlsx-safe';

// ── Wire contract (flag any BE mismatch; do not silently guess) ────────────────

/** The order statuses we surface a per-status count for. Mirrors GiftOrderStatus. */
export const DISBURSAL_STATUSES = [
  'PLACED',
  'PROCESSING',
  'DISPATCHED',
  'DELIVERED',
  'CANCELLED',
  'RETURNED',
  'FAILED',
] as const;
export type DisbursalStatus = (typeof DISBURSAL_STATUSES)[number];

/** One grouped row = (tenant × vendor) — the report's grain. `vendorId`/`vendorName`
 *  are null for platform-sourced (non-vendor) disbursals. */
export interface DisbursalRow {
  clientId: string;
  clientName: string;
  vendorId: string | null;
  vendorName: string | null;
  /** PLATFORM | VENDOR — the item source (§1 decision #1). */
  sourceType?: string | null;
  /** Total orders in the window (any status). */
  orderCount: number;
  /** DELIVERED orders (the count that carries value). */
  deliveredCount: number;
  /** Sum of valuePaise across DELIVERED orders ONLY (§12 — matches 194R). */
  deliveredValuePaise: number;
  /** status → count, over the window. Missing keys treated as 0. */
  statusBreakdown: Partial<Record<string, number>>;
}

export interface DisbursalTotals {
  orderCount: number;
  deliveredCount: number;
  deliveredValuePaise: number;
}

/** GET /api/admin/gift-disbursal → flat report object.
 *  `scope` echoes the effective scope the BE applied (defence-in-depth: the FE renders
 *  the tenant column/filter only for GIFSY). `clients`/`vendors` power the Gifsy filters. */
export interface DisbursalReport {
  scope?: 'GIFSY' | 'TENANT';
  rows: DisbursalRow[];
  totals?: DisbursalTotals;
  /** Filter option lists (Gifsy view only; a tenant view may omit `clients`). */
  clients?: { id: string; name: string }[];
  vendors?: { id: string; name: string }[];
}

// ── Filters → query string ─────────────────────────────────────────────────────

export interface DisbursalFilters {
  /** Tenant clientId; '' = all (Gifsy only — ignored/derived by BE for a tenant admin). */
  clientId?: string;
  /** Vendor id; '' = all vendors + platform. */
  vendorId?: string;
  /** ISO date (yyyy-mm-dd) inclusive lower / upper bound on the disbursal date. */
  from?: string;
  to?: string;
}

export function emptyDisbursalFilters(): DisbursalFilters {
  return { clientId: '', vendorId: '', from: '', to: '' };
}

export function isDisbursalFiltersEmpty(f: DisbursalFilters): boolean {
  return !f.clientId && !f.vendorId && !f.from && !f.to;
}

/**
 * Build the `GET /api/admin/gift-disbursal` query string. A CLIENT_ADMIN caller is
 * tenant-scoped by the BE regardless of any clientId, so `scoped:'TENANT'` DROPS the
 * clientId param entirely (never let a tenant admin probe another tenant by editing the
 * URL). Only active constraints are emitted; returns a leading '?' or ''.
 */
export function buildDisbursalQuery(
  f: DisbursalFilters,
  scope: 'GIFSY' | 'TENANT' = 'GIFSY',
): string {
  const params = new URLSearchParams();
  if (scope === 'GIFSY' && f.clientId) params.set('clientId', f.clientId);
  if (f.vendorId) params.set('vendorId', f.vendorId);
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  const s = params.toString();
  return s ? `?${s}` : '';
}

// ── Derivations ────────────────────────────────────────────────────────────────

export function statusCount(row: DisbursalRow, status: string): number {
  return row.statusBreakdown?.[status] ?? 0;
}

/** Vendor label for a row — platform items show a clear "Platform" rather than a blank. */
export function rowVendorLabel(row: DisbursalRow): string {
  if (row.vendorName) return row.vendorName;
  if (row.vendorId == null && (row.sourceType == null || row.sourceType === 'PLATFORM')) {
    return 'Platform';
  }
  return '—';
}

/**
 * Compute totals from the rows when the BE doesn't send them (defensive — the report
 * footer must always be correct). Prefers the server `totals` when present.
 */
export function computeTotals(report: DisbursalReport): DisbursalTotals {
  if (report.totals) return report.totals;
  return (report.rows ?? []).reduce<DisbursalTotals>(
    (acc, r) => ({
      orderCount: acc.orderCount + (r.orderCount ?? 0),
      deliveredCount: acc.deliveredCount + (r.deliveredCount ?? 0),
      deliveredValuePaise: acc.deliveredValuePaise + (r.deliveredValuePaise ?? 0),
    }),
    { orderCount: 0, deliveredCount: 0, deliveredValuePaise: 0 },
  );
}

// ── Excel generator ─────────────────────────────────────────────────────────────

const RUPEE = (paise: number) => Math.round(paise) / 100;

/**
 * Column layout. In a TENANT-scoped export the Tenant column is dropped (every row is
 * the caller's own tenant — redundant + a scope leak if the BE ever mislabelled it).
 */
export function disbursalColumns(scope: 'GIFSY' | 'TENANT'): string[] {
  const cols: string[] = [];
  if (scope === 'GIFSY') cols.push('Tenant');
  cols.push('Vendor', 'Source', 'Total orders', 'Delivered');
  for (const s of DISBURSAL_STATUSES) {
    if (s === 'DELIVERED') continue; // shown as the dedicated "Delivered" column above
    cols.push(s.charAt(0) + s.slice(1).toLowerCase());
  }
  cols.push('Delivered value (₹)');
  return cols;
}

/**
 * Generate the disbursal xlsx (single sheet: rows + a TOTAL footer). Delivered value is
 * the DELIVERED-only sum (§12). Returns a Uint8Array (Buffer→Uint8Array wrap so
 * instanceof checks pass across jsdom/Vitest realms — mirrors the other exporters).
 */
export function generateDisbursalExcel(
  report: DisbursalReport,
  scope: 'GIFSY' | 'TENANT',
): Uint8Array {
  const wb = XLSX.utils.book_new();
  const headers = disbursalColumns(scope);
  const otherStatuses = DISBURSAL_STATUSES.filter((s) => s !== 'DELIVERED');

  const dataRows: (string | number)[][] = (report.rows ?? []).map((r) => {
    const row: (string | number)[] = [];
    if (scope === 'GIFSY') row.push(r.clientName ?? r.clientId ?? '');
    row.push(rowVendorLabel(r));
    row.push(r.sourceType ?? (r.vendorId ? 'VENDOR' : 'PLATFORM'));
    row.push(r.orderCount ?? 0);
    row.push(r.deliveredCount ?? 0);
    for (const s of otherStatuses) row.push(statusCount(r, s));
    row.push(RUPEE(r.deliveredValuePaise ?? 0));
    return row;
  });

  const totals = computeTotals(report);
  const totalRow: (string | number)[] = [];
  if (scope === 'GIFSY') totalRow.push('TOTAL');
  totalRow.push(scope === 'GIFSY' ? '' : 'TOTAL', '');
  totalRow.push(totals.orderCount, totals.deliveredCount);
  // Per-status totals across all rows.
  for (const s of otherStatuses) {
    totalRow.push((report.rows ?? []).reduce((acc, r) => acc + statusCount(r, s), 0));
  }
  totalRow.push(RUPEE(totals.deliveredValuePaise));

  const ws = aoaToSheetSafe([headers, ...dataRows, totalRow]);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(h.length + 2, 12) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Gift Disbursal');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Suggested download filename, date-stamped (relative to now — never a hardcoded date). */
export function disbursalFilename(now: Date = new Date()): string {
  const d = now.toISOString().slice(0, 10);
  return `gift-disbursal-${d}.xlsx`;
}
