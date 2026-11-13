/**
 * lib/payments-report.ts — typed client for the admin Payments Report.
 *
 * A cross-stream payout-payments report over a DATE RANGE, with the full sales
 * chain per row. Role scope is enforced server-side from the JWT:
 *   - CLIENT_ADMIN → own tenant only (any clientId sent is ignored by the API).
 *   - GIFSY_ADMIN  → platform-wide, with an optional clientId filter.
 *
 * Backend:
 *   GET /api/admin/payments-report?from=&to=&status=&clientId=
 *       → { success, data: { scope, count, totals: { amount }, rows: [...] } }
 *   GET /api/admin/payments-report/export?from=&to=&status=&clientId=  → .xlsx
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
  count: number;
  totals: { amount: Money };
  /** True when the query hit the server row cap — totals reflect only the shown rows; narrow the range. */
  truncated?: boolean;
  maxRows?: number;
  rows: PaymentRow[];
}

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
function buildQuery(params: PaymentsReportParams): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Fetch the (role-scoped) payments report for the given filters. */
export function paymentsReport(params: PaymentsReportParams = {}): Promise<ApiResponse<PaymentsReport>> {
  return api.get<PaymentsReport>(`${BASE}${buildQuery(params)}`);
}

/** Browser-facing URL of the xlsx export (auth-gated; fetch as blob to download). */
export function paymentsExportUrl(params: PaymentsReportParams = {}): string {
  return `${BASE}/export${buildQuery(params)}`;
}

/**
 * Download the xlsx export: a small one saves straight away (200); a big one (202) is prepared in
 * the background — `kind: 'queued'` — and appears on the Downloads page.
 */
export function downloadPaymentsExport(params: PaymentsReportParams = {}): Promise<DownloadOutcome> {
  return downloadOrQueue(paymentsExportUrl(params), { fallbackFileName: 'payments-report.xlsx' });
}
