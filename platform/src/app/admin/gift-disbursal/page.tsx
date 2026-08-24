'use client';

/**
 * /admin/gift-disbursal — Gift Disbursal report (Gifsy + tenant admin).
 *
 * Per-tenant × per-vendor disbursal counts, the DELIVERED ₹ value (§12 — matches 194R),
 * and a status breakdown over a date range, with an xlsx export.
 *
 * TWO entry points share this page, split by the signed-in role (useAdminSession):
 *   - GIFSY_ADMIN → scope 'GIFSY': all tenants + vendors; tenant + vendor filters + column.
 *   - CLIENT_ADMIN → scope 'TENANT': strictly their OWN tenant (BE-scoped); no tenant
 *     filter/column, and the clientId param is never sent (see buildDisbursalQuery).
 *
 * Data: GET /api/admin/gift-disbursal?clientId=&vendorId=&from=&to= → DisbursalReport.
 * The xlsx is generated client-side from the same rows (mirrors the other FE exporters).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileBarChart2, Loader2, AlertTriangle, Download, Filter, X,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { downloadBlob } from '@/lib/download';
import { formatINR } from '@/lib/money';
import { useAdminSession } from '@/lib/admin-session';
import {
  type DisbursalReport,
  type DisbursalFilters,
  DISBURSAL_STATUSES,
  emptyDisbursalFilters,
  isDisbursalFiltersEmpty,
  buildDisbursalQuery,
  statusCount,
  rowVendorLabel,
  computeTotals,
  generateDisbursalExcel,
  disbursalFilename,
} from '@/lib/gift-disbursal';

const OTHER_STATUSES = DISBURSAL_STATUSES.filter((s) => s !== 'DELIVERED');
const SELECT_CLS =
  'bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:border-[var(--brand-primary)]';

export default function GiftDisbursalPage() {
  const session = useAdminSession();
  // Scope is derived from the signed-in role. A GIFSY_ADMIN gets the cross-tenant view;
  // everyone else admitted by the layout (CLIENT_ADMIN) is tenant-scoped. Session hydrates
  // on mount (empty name pre-hydration) — we only fetch once the role is a real admin role.
  const scope: 'GIFSY' | 'TENANT' = session.role === 'GIFSY_ADMIN' ? 'GIFSY' : 'TENANT';
  const isGifsy = scope === 'GIFSY';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<DisbursalReport | null>(null);
  const [filters, setFilters] = useState<DisbursalFilters>(emptyDisbursalFilters());
  // The applied filters drive the fetch; the draft drives the inputs (apply on button).
  const [applied, setApplied] = useState<DisbursalFilters>(emptyDisbursalFilters());
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const load = useCallback(async (f: DisbursalFilters) => {
    setLoading(true);
    setError(null);
    const res = await api.get<DisbursalReport>(`/api/admin/gift-disbursal${buildDisbursalQuery(f, scope)}`);
    if (res.success) setReport(res.data);
    else setError(res.error);
    setLoading(false);
  }, [scope]);

  useEffect(() => { void load(applied); }, [load, applied]);

  const clientOptions = report?.clients ?? [];
  const vendorOptions = report?.vendors ?? [];
  const rows = report?.rows ?? [];
  const totals = report ? computeTotals(report) : { orderCount: 0, deliveredCount: 0, deliveredValuePaise: 0 };

  const columnCount = useMemo(
    () => (isGifsy ? 1 : 0) + 4 + OTHER_STATUSES.length + 1,
    [isGifsy],
  );

  function applyFilters() { setApplied(filters); }
  function clearFilters() {
    const empty = emptyDisbursalFilters();
    setFilters(empty);
    setApplied(empty);
  }

  function handleDownload() {
    setDownloadError(null);
    try {
      const bytes = generateDisbursalExcel(report ?? { rows: [] }, scope);
      // Copy into a fresh ArrayBuffer so the Blob gets a clean buffer regardless of the
      // Uint8Array's byteOffset (mirrors the other exporters' download path).
      const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const blob = new Blob([ab], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      downloadBlob(blob, disbursalFilename());
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : 'Could not build the Excel file.');
    }
  }

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <FileBarChart2 className="w-5 h-5 text-[var(--brand-primary)]" />
            Gift Disbursal
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {isGifsy
              ? 'Gifts disbursed across every tenant and vendor. Value counts DELIVERED orders only (matches 194R).'
              : 'Gifts disbursed to your outlets, by vendor. Value counts DELIVERED orders only.'}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={handleDownload}
          disabled={loading || rows.length === 0}
          data-testid="download-disbursal-btn"
        >
          <Download className="w-4 h-4" />
          Download Excel
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 border border-gray-200 bg-white rounded-xl px-4 py-3">
        {isGifsy && (
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-1" htmlFor="f-tenant">Tenant</label>
            <select
              id="f-tenant"
              value={filters.clientId ?? ''}
              data-testid="filter-tenant"
              onChange={(e) => setFilters((p) => ({ ...p, clientId: e.target.value }))}
              className={SELECT_CLS}
            >
              <option value="">All tenants</option>
              {clientOptions.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="block text-[11px] font-medium text-gray-500 mb-1" htmlFor="f-vendor">Vendor</label>
          <select
            id="f-vendor"
            value={filters.vendorId ?? ''}
            data-testid="filter-vendor"
            onChange={(e) => setFilters((p) => ({ ...p, vendorId: e.target.value }))}
            className={SELECT_CLS}
          >
            <option value="">All vendors + platform</option>
            {vendorOptions.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-500 mb-1" htmlFor="f-from">From</label>
          <input
            id="f-from" type="date" value={filters.from ?? ''} data-testid="filter-from"
            onChange={(e) => setFilters((p) => ({ ...p, from: e.target.value }))} className={SELECT_CLS}
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-500 mb-1" htmlFor="f-to">To</label>
          <input
            id="f-to" type="date" value={filters.to ?? ''} data-testid="filter-to"
            onChange={(e) => setFilters((p) => ({ ...p, to: e.target.value }))} className={SELECT_CLS}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={applyFilters} data-testid="apply-filters-btn">
            <Filter className="w-3.5 h-3.5" /> Apply
          </Button>
          {!isDisbursalFiltersEmpty(applied) && (
            <button
              onClick={clearFilters}
              data-testid="clear-filters-btn"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-sm text-gray-500 hover:bg-gray-100"
            >
              <X className="w-3.5 h-3.5" /> Clear
            </button>
          )}
        </div>
      </div>

      {downloadError && (
        <p className="flex items-start gap-1.5 text-xs text-red-600" role="alert">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{downloadError}
        </p>
      )}

      {/* Loading */}
      {loading && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center text-gray-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
          Loading disbursal report…
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-12 text-center text-sm" data-testid="disbursal-error">
          <AlertTriangle className="w-5 h-5 text-red-500 mx-auto mb-2" />
          <p className="text-red-700">{error}</p>
          <button onClick={() => void load(applied)} className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50">
            Retry
          </button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && rows.length === 0 && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center" data-testid="disbursal-empty">
          <div className="p-4 bg-gray-100 rounded-full inline-flex text-gray-400 mb-3">
            <FileBarChart2 className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-gray-900">No disbursals in range</h3>
          <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
            {isDisbursalFiltersEmpty(applied)
              ? 'No gift orders have been disbursed yet.'
              : 'No disbursals match these filters. Try widening the date range or clearing filters.'}
          </p>
        </div>
      )}

      {/* Table */}
      {!loading && !error && rows.length > 0 && (
        <div className="border border-gray-200 bg-white rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Gift disbursal by {isGifsy ? 'tenant and ' : ''}vendor — order and delivered counts, a status breakdown, and the DELIVERED-only value.
              </caption>
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left">
                  {isGifsy && <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Tenant</th>}
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Vendor</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Source</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Orders</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Delivered</th>
                  {OTHER_STATUSES.map((s) => (
                    <th key={s} scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">
                      {s.charAt(0) + s.slice(1).toLowerCase()}
                    </th>
                  ))}
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Delivered value (₹)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r, i) => (
                  <tr key={`${r.clientId}-${r.vendorId ?? 'platform'}-${i}`} className="hover:bg-gray-50 transition-colors" data-testid="disbursal-row">
                    {isGifsy && <td className="px-4 py-3 font-medium text-gray-900">{r.clientName ?? r.clientId}</td>}
                    <td className="px-4 py-3 text-gray-700">{rowVendorLabel(r)}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{r.sourceType ?? (r.vendorId ? 'VENDOR' : 'PLATFORM')}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">{(r.orderCount ?? 0).toLocaleString('en-IN')}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-gray-900">{(r.deliveredCount ?? 0).toLocaleString('en-IN')}</td>
                    {OTHER_STATUSES.map((s) => (
                      <td key={s} className="px-4 py-3 text-right tabular-nums text-gray-500">
                        {statusCount(r, s).toLocaleString('en-IN')}
                      </td>
                    ))}
                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-gray-900">
                      {formatINR(r.deliveredValuePaise ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 border-t border-gray-200 font-semibold">
                  <td className="px-4 py-3 text-gray-900 text-xs" colSpan={isGifsy ? 3 : 2}>Total</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-900">{totals.orderCount.toLocaleString('en-IN')}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-900">{totals.deliveredCount.toLocaleString('en-IN')}</td>
                  {OTHER_STATUSES.map((s) => (
                    <td key={s} className="px-4 py-3 text-right tabular-nums text-gray-500">
                      {rows.reduce((acc, r) => acc + statusCount(r, s), 0).toLocaleString('en-IN')}
                    </td>
                  ))}
                  <td className="px-4 py-3 text-right tabular-nums text-gray-900" data-testid="disbursal-total-value">
                    {formatINR(totals.deliveredValuePaise)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          {/* Screen-reader hint on column count so the totals row colSpan reads sensibly. */}
          <span className="sr-only">{columnCount} columns</span>
        </div>
      )}
    </div>
  );
}
