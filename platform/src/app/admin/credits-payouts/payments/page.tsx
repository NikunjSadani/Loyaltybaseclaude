'use client';

/**
 * /admin/credits-payouts/payments — Payments Report (all payout streams).
 *
 * A filterable, date-ranged view of every payout payment with the full sales chain:
 *   outlet · owner/business · zone/state/city · sales rep (code+name+role) ·
 *   reporting chain · amount · UTR · status · payout batch · group/field · remarks ·
 *   period · TDS section/methodology/deducted · invoice · GST reg type · PAN · phone.
 *
 * Role scope (enforced server-side from the JWT — the query is only a hint):
 *   - CLIENT_ADMIN → own tenant only (no clientId sent; any value is ignored by the API).
 *   - GIFSY_ADMIN  → platform-wide, with an optional clientId filter.
 *
 * Backend:
 *   GET /api/admin/payments-report?from=&to=&status=&clientId=&page=&pageSize=
 *       → { success, data: { page, pageSize, totalRows, totalPages, totals: { count, amount, tdsDeducted }, rows } }
 *   GET /api/admin/payments-report/export?from=&to=&status=&clientId=  → .xlsx (every matching row)
 *
 * SERVER-PAGED: the API returns one page of rows (50 / 100 / 200) and the totals over EVERY
 * matching payment (a database aggregate), so a wide range (Bajaj: ~48k payments) never loads
 * into the API or the browser at once. Any filter change refetches from page 1. Amount is displayed via
 * `amount.inr` (₹, en-IN); the date via `new Date(paymentDate).toLocaleString('en-IN')`.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Download,
  Banknote,
  Loader2,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { useAdminSession } from '@/lib/admin-session';
import {
  paymentsReport,
  downloadPaymentsExport,
  type PaymentsReport,
  type PaymentsReportParams,
  type Money,
  PAYMENTS_PAGE_SIZES,
} from '@/lib/payments-report';
import { formatInrPaise } from '@/lib/money-format';
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';

/** Format a `{ paise, inr }` money field via its rupee value (₹, en-IN). */
function formatInr(m: Money): string {
  return `₹${Number(m.inr).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Format an ISO payment date for display, tolerating null. */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

/** Status badge styling. */
function statusBadge(status: string | null): string {
  switch ((status ?? '').toUpperCase()) {
    case 'PAID':
      return 'bg-green-50 text-green-700 border border-green-200';
    case 'FAILED':
      return 'bg-red-50 text-red-700 border border-red-200';
    case 'REVERSED':
      return 'bg-amber-50 text-amber-700 border border-amber-200';
    case 'CANCELLED':
      return 'bg-gray-100 text-gray-700 border border-gray-300';
    default:
      return 'bg-gray-50 text-gray-500 border border-gray-200';
  }
}

/** Whole numbers in Indian grouping (48,086 · 1,00,000). */
function formatCount(n: number): string {
  return n.toLocaleString('en-IN');
}

const STATUS_OPTIONS = ['ALL', 'PAID', 'FAILED', 'REVERSED', 'CANCELLED'] as const;
type StatusFilter = (typeof STATUS_OPTIONS)[number];

/** Human label of a payment status (filter options + row badge). Unknown statuses show as sent. */
const STATUS_LABELS: Record<string, string> = {
  PENDING:    'Pending',
  PROCESSING: 'In bank file',
  PAID:       'Paid',
  FAILED:     'Failed',
  REVERSED:   'Reversed',
  CANCELLED:  'Cancelled',
};
const statusLabel = (s: string | null) => (s ? STATUS_LABELS[s.toUpperCase()] ?? s : '—');

// ── SummaryCard (mirrors admin/tds-payouts) ──────────────────────────────────
function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
      <p className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</p>
      <p className="text-base font-bold text-gray-900 mt-1">{value}</p>
      {sub && <p className="text-[10px] text-gray-400">{sub}</p>}
    </div>
  );
}

/** Default the range to the current calendar month so the initial (auto) load is bounded — an
 *  empty range would ask the server for every payment across all time (all tenants for GIFSY). */
function currentMonthDefaults(): { from: string; to: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ym = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  return { from: `${ym}-01`, to: `${ym}-${pad(now.getDate())}` };
}

export default function AdminPaymentsReportPage() {
  const session = useAdminSession();
  const isGifsy = session.role === 'GIFSY_ADMIN';

  const [report, setReport] = useState<PaymentsReport | null>(null);
  // The filters (+ page size) the CURRENT `report` was loaded for — compared with the live filters to tell when the
  // figures on screen belong to a previous filter set (in flight, or the new filters failed to load).
  const [reportKey, setReportKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Next / Previous / Retry so a request is (re)sent even when `page` already holds that value
  // (e.g. a failed page-2 load left page=2 while the table still shows page 1).
  const [reloadTick, setReloadTick] = useState(0);

  const defaults = currentMonthDefaults();
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [clientId, setClientId] = useState(''); // GIFSY only
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAYMENTS_PAGE_SIZES[0]);

  // Every filter / page-size change goes back to page 1 (page 7 of the old filter is meaningless).
  const onFilter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  const exportAction = useDownloadAction();

  // Build the query params from the current filters (drops empty values;
  // CLIENT_ADMIN never contributes a clientId — the server pins its scope).
  const buildParams = useCallback((): PaymentsReportParams => {
    const params: PaymentsReportParams = {};
    if (from) params.from = from;
    if (to) params.to = to;
    if (status !== 'ALL') params.status = status;
    if (isGifsy && clientId.trim()) params.clientId = clientId.trim();
    return params;
  }, [from, to, status, clientId, isGifsy]);
  const filterKey = JSON.stringify({ ...buildParams(), pageSize });

  // Push the date range + status + clientId to the API; any filter change refetches.
  // Sequence guard: a slower earlier request must NEVER overwrite a newer one's result — on a
  // money+PII report that would show numbers that don't match the visible filters.
  const reqRef = useRef(0);
  const fetchReport = useCallback(async () => {
    const myReq = ++reqRef.current;
    const key = filterKey;
    setLoading(true);
    setError(null);
    // A page past the end is clamped SERVER-side (the response carries the effective page); the pager below always
    // navigates from report.page, so it never trusts a page number that did not load.
    const res = await paymentsReport(buildParams(), { page, pageSize });
    if (myReq !== reqRef.current) return; // superseded by a newer fetch — discard this stale result
    if (res.success) {
      setReport(res.data);
      setReportKey(key);
    } else {
      setError(res.error && res.error !== 'Network error' ? res.error : 'Failed to load payments report');
    }
    setLoading(false);
    // reloadTick: Next / Previous / Retry re-run this even when page/filters are unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildParams, page, pageSize, filterKey, reloadTick]);

  useEffect(() => {
    void fetchReport();
  }, [fetchReport]);

  // ── Export (honours the active filters; server-side xlsx blob download) ──────
  // 200 → saves straight away; 202 → prepared in the background (Downloads page).
  const handleExport = () => {
    void exportAction.run(() => downloadPaymentsExport(buildParams()));
  };

  // Full-screen spinner / error only before the first result is in hand; a refetch
  // keeps the filters + prior rows visible so the controls never disappear.
  if (loading && !report) {
    return (
      <div className="flex items-center justify-center min-h-screen" aria-label="Loading">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error && !report) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700 flex items-center gap-2 m-4">
        <AlertTriangle className="w-4 h-4 flex-shrink-0" />
        {error}
      </div>
    );
  }

  const rows = report?.rows ?? [];
  const totalAmount = report?.totals.amount;
  const totalTds = report?.totals.tdsDeducted;
  const totalRows = report?.totalRows ?? report?.count ?? rows.length;
  const shownPage = report?.page ?? page;
  const shownPageSize = report?.pageSize ?? pageSize;
  const totalPages = report?.totalPages ?? (totalRows ? Math.ceil(totalRows / shownPageSize) : 0);
  const firstShown = rows.length ? (shownPage - 1) * shownPageSize + 1 : 0;
  const lastShown = rows.length ? firstShown + rows.length - 1 : 0;
  // The figures on screen are for a DIFFERENT filter set than the controls show (in flight, or it failed to load).
  const stale = !!report && reportKey !== filterKey;
  const staleFailed = stale && !loading && !!error;
  // An empty page with non-zero totals is never a real state (the server clamps) — treat it as still loading.
  const pageGap = rows.length === 0 && totalRows > 0;
  // Navigate from the page that is actually ON SCREEN (report.page), never from a page number that failed to load;
  // paging is off while the screen shows another filter set (its pages are not the new filters' pages).
  const canPrev = !loading && !stale && shownPage > 1;
  const canNext = !loading && !stale && shownPage < totalPages;
  const goTo = (target: number) => {
    setPage(target);
    setReloadTick((t) => t + 1);
  };
  const retry = () => setReloadTick((t) => t + 1);
  const dim = loading || stale ? 'opacity-60 transition-opacity' : 'transition-opacity';

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[var(--brand-primary)]/10 flex items-center justify-center">
            <Banknote className="w-5 h-5 text-[var(--brand-primary)]" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900">Payments Report</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              {isGifsy
                ? 'Platform-wide payout payments across all streams, with the full sales chain.'
                : 'Your payout payments across all streams, with the full sales chain (read-only).'}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 max-w-xs">
          <button
            onClick={handleExport}
            disabled={exportAction.blocked}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-60"
          >
            {exportAction.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            {downloadButtonLabel(exportAction, 'Export Excel')}
          </button>
          {/* Queued / error message — directly below the button (one placement on every report screen). */}
          <DownloadActionStatus action={exportAction} />
        </div>
      </div>

      {/* Refetch error banner (a filter change failed but prior rows still show) */}
      {error && report && (
        <div role="alert" className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700 flex items-center gap-2 flex-wrap">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{error}</span>
          {staleFailed && <span>The figures below are still for the previous filters.</span>}
          <button
            type="button"
            onClick={retry}
            disabled={loading}
            className="ml-auto px-2.5 py-1 rounded-lg border border-red-200 bg-white text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            Retry
          </button>
        </div>
      )}

      {/* Summary strip — whole-range totals (database aggregate over every matching payment, all pages). */}
      <section aria-label="Payment totals" aria-busy={loading || undefined} className={dim}>
        <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-1.5" data-testid="payments-totals-label">
          {staleFailed
            ? 'Showing the previous filters — the new filters failed to load'
            : stale
              ? 'Updating for the new filters…'
              : 'Totals for the selected filters — all pages'}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-xl">
          <SummaryCard label="Payments" value={formatCount(totalRows)} sub="matching filters" />
          <SummaryCard label="Total Amount" value={totalAmount ? formatInr(totalAmount) : '₹0.00'} sub="all matching payments" />
          <SummaryCard label="TDS Deducted" value={totalTds ? formatInr(totalTds) : '₹0.00'} sub="all matching payments" />
        </div>
      </section>

      {/* Filters */}
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-gray-400">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => onFilter(setFrom)(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-gray-400">
          To
          <input
            type="date"
            value={to}
            onChange={(e) => onFilter(setTo)(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-gray-400">
          Status
          <select
            value={status}
            onChange={(e) => onFilter(setStatus)(e.target.value as StatusFilter)}
            className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
          >
            <option value="ALL">All Statuses</option>
            {STATUS_OPTIONS.filter((s) => s !== 'ALL').map((s) => (
              <option key={s} value={s}>{statusLabel(s)}</option>
            ))}
          </select>
        </label>
        {isGifsy && (
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-gray-400">
            Client ID
            <input
              type="text"
              placeholder="All tenants"
              value={clientId}
              onChange={(e) => onFilter(setClientId)(e.target.value)}
              className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
            />
          </label>
        )}
        {loading && (
          <span role="status" className="flex items-center gap-1.5 text-[10px] text-gray-400 pb-2">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading…
          </span>
        )}
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden" aria-busy={loading || undefined}>
        {pageGap ? (
          <div className="py-16 flex items-center justify-center gap-2 text-gray-400 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading payments…
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 flex flex-col items-center gap-2 text-gray-400">
            <Banknote className="w-8 h-8" />
            <p className="text-sm">No payments match your filters</p>
          </div>
        ) : (
          <div className={`overflow-x-auto ${dim}`}>
            <table className="w-full text-xs whitespace-nowrap">
              <thead>
                <tr className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-100">
                  {isGifsy && <th className="text-left px-3 py-3">Tenant</th>}
                  <th className="text-left px-3 py-3">Payment Date</th>
                  <th className="text-left px-3 py-3">Outlet ID</th>
                  <th className="text-left px-3 py-3">Outlet Name</th>
                  <th className="text-left px-3 py-3">Business / Owner</th>
                  <th className="text-left px-3 py-3">Zone</th>
                  <th className="text-left px-3 py-3">State / City</th>
                  <th className="text-left px-3 py-3">Sales Rep</th>
                  <th className="text-left px-3 py-3">Reporting Chain</th>
                  <th className="text-right px-3 py-3">Amount</th>
                  <th className="text-left px-3 py-3">UTR</th>
                  <th className="text-center px-3 py-3">Status</th>
                  <th className="text-left px-3 py-3">Payout Batch</th>
                  <th className="text-left px-3 py-3">Group Type</th>
                  <th className="text-left px-3 py-3">Payout Field</th>
                  <th className="text-left px-3 py-3">Remarks</th>
                  <th className="text-left px-3 py-3">Failure Reason</th>
                  <th className="text-left px-3 py-3">Period</th>
                  <th className="text-left px-3 py-3">TDS Section</th>
                  <th className="text-right px-3 py-3">TDS Deducted</th>
                  <th className="text-left px-3 py-3">Invoice No.</th>
                  <th className="text-left px-3 py-3">GST Reg Type</th>
                  <th className="text-left px-3 py-3">PAN</th>
                  <th className="text-left px-3 py-3">Phone</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r, i) => (
                  <tr
                    key={`${firstShown + i}-${r.clientId}-${r.outletCode ?? ''}-${r.utr ?? ''}-${r.payoutField ?? ''}`}
                    className="hover:bg-gray-50 transition-colors"
                  >
                    {isGifsy && <td className="px-3 py-3 text-gray-600">{r.clientId}</td>}
                    <td className="px-3 py-3 text-gray-600">{formatDate(r.paymentDate)}</td>
                    <td className="px-3 py-3 font-mono text-[11px] text-gray-600">{r.outletCode ?? '—'}</td>
                    <td className="px-3 py-3 font-medium text-gray-800">{r.outletName ?? '—'}</td>
                    <td className="px-3 py-3">
                      <p className="text-gray-800">{r.businessName ?? '—'}</p>
                      <p className="text-gray-400">{r.ownerName ?? '—'}</p>
                    </td>
                    <td className="px-3 py-3 text-gray-600">{r.zone ?? '—'}</td>
                    <td className="px-3 py-3 text-gray-600">
                      {r.state ?? '—'}
                      {r.city ? ` / ${r.city}` : ''}
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-mono text-[11px] text-gray-600">{r.salesRepCode ?? '—'}</p>
                      <p className="text-gray-500">
                        {r.salesRepName ?? '—'}
                        {r.salesRepRole ? ` (${r.salesRepRole})` : ''}
                      </p>
                    </td>
                    <td className="px-3 py-3 text-gray-500">{r.reportingChain ?? '—'}</td>
                    <td className="px-3 py-3 text-right font-medium text-gray-800">{formatInr(r.amount)}</td>
                    <td className="px-3 py-3 font-mono text-[11px] text-gray-600">
                      {r.settledByTds ? (
                        // B-L6: settled by TDS withholding — no bank payment, so no UTR.
                        <span data-testid="payment-settled-by-tds" className="font-sans text-amber-700">
                          Settled by TDS withholding (no bank payment)
                        </span>
                      ) : (
                        (r.utr ?? '—')
                      )}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium ${statusBadge(r.status)}`}>
                        {statusLabel(r.status)}
                      </span>
                      {r.reversal && (
                        <div data-testid="payment-reversal" className="mt-1 text-left whitespace-normal min-w-[14rem] space-y-0.5">
                          <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-800 border border-amber-200">
                            Reversed — {formatInrPaise(r.reversal.receivablePaise)} owed back (receivable)
                            {Number(r.reversal.tdsCreditPaise) > 0 && ` · ${formatInrPaise(r.reversal.tdsCreditPaise)} TDS credit`}
                          </span>
                          {r.reversal.note && <p className="text-[11px] text-amber-800">{r.reversal.note}</p>}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-gray-600">{r.payoutHeader ?? '—'}</td>
                    <td className="px-3 py-3 text-gray-600">{r.groupType ?? '—'}</td>
                    <td className="px-3 py-3 text-gray-600">{r.payoutField ?? '—'}</td>
                    <td className="px-3 py-3 text-gray-500">{r.remarks ?? '—'}</td>
                    <td className="px-3 py-3 text-red-600">{r.failureReason ?? '—'}</td>
                    <td className="px-3 py-3 text-gray-600">{r.period ?? '—'}</td>
                    <td className="px-3 py-3 text-gray-600">{r.tdsSection ?? '—'}</td>
                    <td className="px-3 py-3 text-right">
                      {Number(r.tdsDeducted.paise) > 0 ? (
                        <span className="text-red-600 font-medium">{formatInr(r.tdsDeducted)}</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                      {(r.tdsNote || Number(r.tdsCreditPaise ?? 0) > 0) && (
                        <span data-testid="payment-tds-note" className="block text-[11px] text-blue-700 whitespace-normal min-w-[12rem]">
                          {r.tdsNote ?? `${formatInrPaise(r.tdsCreditPaise ?? 0)} covered by TDS credit`}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 font-mono text-[11px] text-gray-600">{r.invoiceNumber ?? '—'}</td>
                    <td className="px-3 py-3 text-gray-600">{r.gstRegistrationType ?? '—'}</td>
                    <td className="px-3 py-3 font-mono text-[11px] text-gray-600">{r.panNumber ?? '—'}</td>
                    <td className="px-3 py-3 text-gray-600">{r.phone ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* Pager — the server returns one page; Previous/Next fetch the neighbouring page. */}
        {totalRows > 0 && (
          <nav
            aria-label="Payments pages"
            className="flex items-center justify-between flex-wrap gap-3 px-3 py-2.5 border-t border-gray-100 text-xs text-gray-600"
          >
            <span data-testid="payments-range" aria-live="polite">
              {rows.length
                ? `Showing ${formatCount(firstShown)}–${formatCount(lastShown)} of ${formatCount(totalRows)}`
                : `No rows on this page · ${formatCount(totalRows)} in total`}
            </span>
            <div className="flex items-center gap-3 flex-wrap">
              {loading && (
                <span className="flex items-center gap-1 text-gray-400">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading page…
                </span>
              )}
              <label className="flex items-center gap-1.5 text-gray-500">
                Rows per page
                <select
                  value={pageSize}
                  onChange={(e) => onFilter(setPageSize)(Number(e.target.value))}
                  className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
                >
                  {PAYMENTS_PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
              <span className="text-gray-500">
                Page {formatCount(shownPage)} of {formatCount(Math.max(totalPages, 1))}
              </span>
              <button
                type="button"
                onClick={() => goTo(Math.max(1, shownPage - 1))}
                disabled={!canPrev}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Previous
              </button>
              <button
                type="button"
                onClick={() => goTo(shownPage + 1)}
                disabled={!canNext}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </nav>
        )}
      </div>
    </div>
  );
}
