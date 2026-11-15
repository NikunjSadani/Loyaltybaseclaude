/**
 * lib/payments-report.ts — typed client for the admin Payments Report.
 *
 * A cross-stream payout-payments report over a DATE RANGE, with the full sales
 * chain per row. Role scope is enforced server-side from the JWT:
 *   - CLIENT_ADMIN → own tenant only (any clientId sent is ignored by the API).
 *   - GIFSY_ADMIN  → platform-wide, with an optional clientId filter.
 *
 * Backend:
 *   GET /api/admin/payments-report?from=&to=&status=&clientId=&page=&pageSize=
 *       → { success, data: { scope, page, pageSize, totalRows, totalPages, count,
 *                            totals: { count, amount, tdsDeducted }, rows: [...one page...] } }
 *     ONE page of rows (pageSize default 50, max 200); `totals` are a DB aggregate over EVERY matching
 *     payment (all pages), never a sum of the page.
 *   GET /api/admin/payments-report/export?from=&to=&status=&clientId=  → .xlsx (every matching row; no page params)
 *
 * The browser calls same-origin `/api/*`; the edge proxy injects the Bearer from
 * the httpOnly `token` cookie, so no auth header is needed (authHeader() is a
 * no-op kept for call-site compatibility). Money fields are `{ paise, inr }`.
 */

import { api, type ApiResponse } from '@/lib/api-client';
import { downloadOrQueue, type DownloadOutcome } from '@/lib/exports/download';

/** Every money field: integer paise (as a string) + a pre-computed rupee number. */
export interface Money {
  paise: string;
  inr: number;
}

/** One payout-payment row (mirrors the backend row shape exactly). */
export interface PaymentRow {
  clientId: string;
  /** ISO timestamp of the payment, or null when not yet paid. */
  paymentDate: string | null;
  outletCode: string | null;
  outletName: string | null;
  businessName: string | null;
  ownerName: string | null;
  zone: string | null;
  state: string | null;
  city: string | null;
  salesRepCode: string | null;
  salesRepName: string | null;
  salesRepRole: string | null;
  /** Pre-formatted reporting chain (e.g. "TSE › ASM › RSM"). */
  reportingChain: string | null;
  amount: Money;
  utr: string | null;
  status: string | null;
  /** Payout batch / header this payment belongs to. */
  payoutHeader: string | null;
  groupType: string | null;
  payoutField: string | null;
  remarks: string | null;
  /** Raw bank/vendor reason captured on a FAILED payout (null on PAID rows). */
  failureReason: string | null;
  period: string | null;
  tdsSection: string | null;
  tdsMethodology: string | null;
  tdsDeducted: Money;
  invoiceNumber: string | null;
  gstRegistrationType: string | null;
  panNumber: string | null;
  phone: string | null;
}

export interface PaymentsReport {
  scope: { clientId: string | null } & Record<string, unknown>;
  /** 1-based page these rows are. */
  page: number;
  pageSize: number;
  /** Every payment matching the filters (all pages). */
  totalRows: number;
  totalPages: number;
  /** Same as totalRows (pre-paging field name). */
  count: number;
  /** Whole-range totals over ALL matching payments (every page) — not a sum of `rows`. */
  totals: { count: number; amount: Money; tdsDeducted: Money };
  /** This page's rows only. */
  rows: PaymentRow[];
}

/** Rows-per-page choices (the API caps pageSize at 200). */
export const PAYMENTS_PAGE_SIZES = [50, 100, 200] as const;

/** Query params for both the report and the export. */
export interface PaymentsReportParams {
  /** ISO date (YYYY-MM-DD) inclusive lower bound. */
  from?: string;
  /** ISO date (YYYY-MM-DD) inclusive upper bound. */
  to?: string;
  /** PAID | FAILED | REVERSED — omitted means all statuses. */
  status?: string;
  /** GIFSY-only tenant filter; ignored for CLIENT_ADMIN (server pins scope). */
  clientId?: string;
}

const BASE = '/api/admin/payments-report';

/** Build a query string, dropping undefined/null/empty values. */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Paging for the on-screen report only (the export is every matching row and rejects page params). */
export interface PaymentsReportPage {
  page?: number;
  pageSize?: number;
}

/** Fetch ONE page of the (role-scoped) payments report for the given filters, plus whole-range totals. */
export function paymentsReport(
  params: PaymentsReportParams = {},
  paging: PaymentsReportPage = {},
): Promise<ApiResponse<PaymentsReport>> {
  const q: Record<string, string | number | undefined> = { ...params, page: paging.page, pageSize: paging.pageSize };
  return api.get<PaymentsReport>(`${BASE}${buildQuery(q)}`);
}

/** Browser-facing URL of the xlsx export (auth-gated; fetch as blob to download). */
export function paymentsExportUrl(params: PaymentsReportParams = {}): string {
  // Only the filters — never page/pageSize (the export is the whole range; the API 400s on page params there).
  const { from, to, status, clientId } = params;
  return `${BASE}/export${buildQuery({ from, to, status, clientId })}`;
}

/**
 * Download the xlsx export: a small one saves straight away (200); a big one (202) is prepared in
 * the background — `kind: 'queued'` — and appears on the Downloads page.
 */
export function downloadPaymentsExport(params: PaymentsReportParams = {}): Promise<DownloadOutcome> {
  return downloadOrQueue(paymentsExportUrl(params), { fallbackFileName: 'payments-report.xlsx' });
}
