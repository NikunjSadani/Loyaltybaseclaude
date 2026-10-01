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
 *   GET /api/admin/payments-report?from=&to=&status=&clientId=
 *       → { success, data: { scope, count, totals: { amount }, rows: [...] } }
 *   GET /api/admin/payments-report/export?from=&to=&status=&clientId=  → .xlsx
 *
 * Unlike the fetch-once tds-payouts sibling, the date range + status + clientId are
 * pushed to the API, so any filter change REFETCHES. Amount is displayed via
 * `amount.inr` (₹, en-IN); the date via `new Date(paymentDate).toLocaleString('en-IN')`.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Download,
  Banknote,
  Loader2,
  AlertTriangle,
  X,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { useAdminSession } from '@/lib/admin-session';
import {
  paymentsReport,
  downloadPaymentsExport,
  type PaymentsReport,
  type PaymentsReportParams,
  type Money,
} from '@/lib/payments-report';

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
    default:
      return 'bg-gray-50 text-gray-500 border border-gray-200';
  }
}

const STATUS_OPTIONS = ['ALL', 'PAID', 'FAILED', 'REVERSED'] as const;
type StatusFilter = (typeof STATUS_OPTIONS)[number];

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const defaults = currentMonthDefaults();
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [clientId, setClientId] = useState(''); // GIFSY only

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

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

  // Push the date range + status + clientId to the API; any filter change refetches.
  // Sequence guard: a slower earlier request must NEVER overwrite a newer one's result — on a
  // money+PII report that would show numbers that don't match the visible filters.
  const reqRef = useRef(0);
  const fetchReport = useCallback(async () => {
    const myReq = ++reqRef.current;
    setLoading(true);
    setError(null);
    const res = await paymentsReport(buildParams());
    if (myReq !== reqRef.current) return; // superseded by a newer fetch — discard this stale result
    if (res.success) {
      setReport(res.data);
    } else {
      setError(res.error && res.error !== 'Network error' ? res.error : 'Failed to load payments report');
    }
    setLoading(false);
  }, [buildParams]);

  useEffect(() => {
    void fetchReport();
  }, [fetchReport]);

  // ── Export (honours the active filters; server-side xlsx blob download) ──────
  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    const res = await downloadPaymentsExport(buildParams());
    setExporting(false);
    if (!res.success) setExportError(res.error);
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
        <button
          onClick={handleExport}
          disabled={exporting}
          className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-60"
        >
          {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          Export Excel
        </button>
      </div>

      {/* Export error banner */}
      {exportError && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          {exportError}
          <button onClick={() => setExportError(null)} className="ml-auto text-red-400 hover:text-red-600">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Refetch error banner (a filter change failed but prior rows still show) */}
      {error && report && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-3 max-w-md">
        <SummaryCard label="Payments" value={String(report?.count ?? rows.length)} sub="matching filters" />
        <SummaryCard label="Total Amount" value={totalAmount ? formatInr(totalAmount) : '₹0.00'} sub="filtered set" />
      </div>

      {/* Truncation banner — the query hit the server cap; totals are of the shown rows only. */}
      {report?.truncated && (
        <div className="flex items-center gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 max-w-2xl">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          Showing the first {report.maxRows ?? report.count} payments — narrow the date range for a complete report. Totals reflect only the rows shown.
        </div>
      )}

      {/* Filters */}
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-gray-400">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-gray-400">
          To
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-gray-400">
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
          >
            <option value="ALL">All Statuses</option>
            {STATUS_OPTIONS.filter((s) => s !== 'ALL').map((s) => (
              <option key={s} value={s}>{s}</option>
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
              onChange={(e) => setClientId(e.target.value)}
              className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
            />
          </label>
        )}
        {loading && (
          <span className="flex items-center gap-1.5 text-[10px] text-gray-400 pb-2">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading…
          </span>
        )}
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {rows.length === 0 ? (
          <div className="py-16 flex flex-col items-center gap-2 text-gray-400">
            <Banknote className="w-8 h-8" />
            <p className="text-sm">No payments match your filters</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
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
                    key={`${r.clientId}-${r.outletCode ?? ''}-${r.utr ?? ''}-${r.payoutField ?? ''}-${i}`}
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
                    <td className="px-3 py-3 font-mono text-[11px] text-gray-600">{r.utr ?? '—'}</td>
                    <td className="px-3 py-3 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium ${statusBadge(r.status)}`}>
                        {r.status ?? '—'}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-gray-600">{r.payoutHeader ?? '—'}</td>
                    <td className="px-3 py-3 text-gray-600">{r.groupType ?? '—'}</td>
                    <td className="px-3 py-3 text-gray-600">{r.payoutField ?? '—'}</td>
                    <td className="px-3 py-3 text-gray-500">{r.remarks ?? '—'}</td>
                    <td className="px-3 py-3 text-gray-600">{r.period ?? '—'}</td>
                    <td className="px-3 py-3 text-gray-600">{r.tdsSection ?? '—'}</td>
                    <td className="px-3 py-3 text-right">
                      {Number(r.tdsDeducted.paise) > 0 ? (
                        <span className="text-red-600 font-medium">{formatInr(r.tdsDeducted)}</span>
                      ) : (
                        <span className="text-gray-400">—</span>
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
      </div>
    </div>
  );
}
