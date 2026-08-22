'use client';

/**
 * /admin/gift-orders — Gifsy gift-dispatch / fulfilment console (GIFSY ops).
 *
 * The platform-wide oversight surface for gift redemption orders ACROSS ALL tenants
 * (design §5). Lists orders with tenant / status / channel / date / order# filters,
 * links each to its detail page (where fulfilment + status transitions happen), and
 * reuses the existing Excel bulk-fulfilment sheet (download + upload).
 *
 * Data: GET /api/admin/gift-orders  → { items: GiftOrderSummary[] } (array-tolerant).
 * Bulk: GET  /api/admin/rewards/fulfilment/template  (xlsx blob)
 *       POST /api/admin/rewards/fulfilment/upload    (multipart "file")
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Truck,
  Loader2,
  AlertTriangle,
  Search,
  RefreshCw,
  Package,
  Download,
  Upload,
  FileSpreadsheet,
  CheckCircle2,
} from 'lucide-react';
import { api, authHeader } from '@/lib/api-client';
import { downloadBlob } from '@/lib/download';
import {
  type GiftOrderSummary,
  type GiftOrderFilters,
  emptyGiftOrderFilters,
  buildListQuery,
  isFiltersEmpty,
  statusLabel,
  statusBadgeClass,
  channelLabel,
  GIFT_ORDER_STATUS_LABEL,
  GIFT_FULFILMENT_CHANNELS,
  fmtValuePaise,
  fmtPoints,
} from '@/lib/gift-orders';

interface TenantOption {
  clientId: string;
  name: string;
}

interface FulfilmentUploadResult {
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  errors: { row: number; orderNumber?: string; message: string }[];
}

/** Backend list pagination envelope (when present on the response). */
interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

const STATUS_FILTER_VALUES = ['all', ...Object.keys(GIFT_ORDER_STATUS_LABEL)];

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function GiftOrdersConsolePage() {
  const [filters, setFilters] = useState<GiftOrderFilters>(emptyGiftOrderFilters());
  const [items, setItems] = useState<GiftOrderSummary[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Tenant options accumulate across loads (union) so the dropdown never loses a
  // tenant just because the current filter narrowed the result set.
  const [tenantOptions, setTenantOptions] = useState<TenantOption[]>([]);

  const set = <K extends keyof GiftOrderFilters>(k: K, v: GiftOrderFilters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));

  const load = useCallback(async (f: GiftOrderFilters) => {
    setLoading(true);
    setError(null);
    const res = await api.get<
      GiftOrderSummary[] | { items: GiftOrderSummary[]; pagination?: PaginationMeta }
    >(`/api/admin/gift-orders${buildListQuery(f)}`);
    if (res.success) {
      const raw = res.data;
      const data = Array.isArray(raw) ? raw : (raw?.items ?? []);
      setItems(data);
      setPagination(Array.isArray(raw) ? null : (raw?.pagination ?? null));
      // Merge any newly-seen tenants into the accumulated option list.
      setTenantOptions((prev) => {
        const seen = new Map(prev.map((t) => [t.clientId, t]));
        for (const o of data) {
          if (o.clientId && !seen.has(o.clientId)) {
            seen.set(o.clientId, { clientId: o.clientId, name: o.tenantName ?? o.clientId });
          }
        }
        return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
      });
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, []);

  // Initial load only. Subsequent loads are triggered by "Apply" / refresh so a
  // date/text field edit doesn't fire a request per keystroke.
  useEffect(() => {
    void load(emptyGiftOrderFilters());
  }, [load]);

  // Deferred apply (Apply button / Enter in the free-text + date fields). A new query
  // always resets to page 1 so we never land on an out-of-range page.
  const applyFilters = () => {
    const next = { ...filters, page: 1 };
    setFilters(next);
    void load(next);
  };
  const resetFilters = () => {
    const cleared = emptyGiftOrderFilters();
    setFilters(cleared);
    void load(cleared);
  };
  // Discrete selects (tenant / status / channel) auto-apply on change — no Apply needed,
  // and they reset to page 1 (the previous page is meaningless under a new filter).
  const setAndApply = <K extends keyof GiftOrderFilters>(k: K, v: GiftOrderFilters[K]) => {
    const next = { ...filters, [k]: v, page: 1 };
    setFilters(next);
    void load(next);
  };
  const goToPage = (p: number) => {
    const next = { ...filters, page: p };
    setFilters(next);
    void load(next);
  };

  const limit = filters.limit ?? 100;
  const pageNum = filters.page ?? 1;
  // A full page with no backend pagination meta means older orders may be unreachable.
  const pageFull = items.length >= limit;
  const hasPrev = pageNum > 1;
  const hasNext = pagination ? pageNum < pagination.pages : pageFull;
  const showPager = hasPrev || hasNext || (pagination != null && pagination.pages > 1);

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Truck className="w-5 h-5 text-[var(--brand-primary)]" />
            Gift Dispatch
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Track and fulfil gift redemption orders across all tenants — set the channel,
            logistics partner and tracking, and advance each order&rsquo;s status.
          </p>
        </div>
        <button
          onClick={() => void load(filters)}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50"
          title="Refresh"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {/* Bulk fulfilment */}
      <BulkFulfilment onUploaded={() => void load(filters)} />

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <label className="text-[11px] font-medium text-gray-500 block mb-1">Order number</label>
            <Search className="absolute left-3 top-[34px] h-4 w-4 text-gray-400" />
            <input
              value={filters.q ?? ''}
              onChange={(e) => set('q', e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
              placeholder="Search order #…"
              data-testid="filter-q"
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
            />
          </div>

          <div>
            <label className="text-[11px] font-medium text-gray-500 block mb-1">Tenant</label>
            <select
              value={filters.clientId ?? ''}
              onChange={(e) => setAndApply('clientId', e.target.value)}
              data-testid="filter-tenant"
              className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-gray-400"
            >
              <option value="">All tenants</option>
              {tenantOptions.map((t) => (
                <option key={t.clientId} value={t.clientId}>{t.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-medium text-gray-500 block mb-1">Status</label>
            <select
              value={filters.status ?? 'all'}
              onChange={(e) => setAndApply('status', e.target.value)}
              data-testid="filter-status"
              className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-gray-400"
            >
              {STATUS_FILTER_VALUES.map((s) => (
                <option key={s} value={s}>{s === 'all' ? 'All statuses' : statusLabel(s)}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-medium text-gray-500 block mb-1">Channel</label>
            <select
              value={filters.channel ?? 'all'}
              onChange={(e) => setAndApply('channel', e.target.value)}
              data-testid="filter-channel"
              className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-gray-400"
            >
              <option value="all">All channels</option>
              {GIFT_FULFILMENT_CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-medium text-gray-500 block mb-1">From</label>
            <input
              type="date"
              value={filters.from ?? ''}
              onChange={(e) => set('from', e.target.value)}
              data-testid="filter-from"
              className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-gray-400"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-gray-500 block mb-1">To</label>
            <input
              type="date"
              value={filters.to ?? ''}
              onChange={(e) => set('to', e.target.value)}
              data-testid="filter-to"
              className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-gray-400"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={applyFilters}
              data-testid="apply-filters"
              className="text-xs px-4 py-2 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-[#a50d26]"
            >
              Apply
            </button>
            {!isFiltersEmpty(filters) && (
              <button
                onClick={resetFilters}
                data-testid="reset-filters"
                className="text-xs px-3 py-2 rounded-lg border border-gray-300 text-gray-600 font-medium hover:bg-gray-50"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center text-gray-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
          Loading orders…
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-12 text-center text-sm">
          <AlertTriangle className="w-5 h-5 text-red-500 mx-auto mb-2" />
          <p className="text-red-700">{error}</p>
          <button
            onClick={() => void load(filters)}
            className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && items.length === 0 && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center">
          <div className="p-4 bg-gray-100 rounded-full inline-flex text-gray-400 mb-3">
            <Package className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-gray-900">No gift orders</h3>
          <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
            {isFiltersEmpty(filters)
              ? 'Gift redemption orders will appear here once members redeem physical or voucher rewards.'
              : 'No orders match the current filters. Try widening the date range or clearing filters.'}
          </p>
        </div>
      )}

      {/* Table */}
      {!loading && !error && items.length > 0 && (
        <div className="border border-gray-200 bg-white rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left">
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Order</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Tenant</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Reward</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Partner</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Channel</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Value</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Status</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Placed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((o) => (
                  <tr key={o.id} className="hover:bg-gray-50 transition-colors" data-testid="order-row">
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/gift-orders/${o.id}`}
                        className="font-mono text-xs font-semibold text-gray-900 hover:text-[var(--brand-primary)]"
                      >
                        {o.orderNumber ?? o.id.slice(-8)}
                      </Link>
                      {o.trackingNumber && (
                        <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1">
                          <Truck className="w-2.5 h-2.5" />
                          {o.trackingNumber}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">{o.tenantName ?? o.clientId ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-900">{o.rewardName ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-600">{o.partnerName ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-600">{channelLabel(o.fulfilmentChannel)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {o.valuePaise != null ? fmtValuePaise(o.valuePaise) : `${fmtPoints(o.totalPointsCost)} pts`}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${statusBadgeClass(o.status)}`}>
                        {statusLabel(o.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                      {formatDate(o.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-gray-400" data-testid="orders-count">
            {pagination
              ? `Page ${pageNum} of ${pagination.pages} · ${pagination.total.toLocaleString('en-IN')} order${pagination.total !== 1 ? 's' : ''}`
              : `${items.length} order${items.length !== 1 ? 's' : ''} shown${pageNum > 1 ? ` (page ${pageNum})` : ''}`}
          </p>
          {showPager && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => goToPage(pageNum - 1)}
                disabled={!hasPrev || loading}
                data-testid="page-prev"
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                onClick={() => goToPage(pageNum + 1)}
                disabled={!hasNext || loading}
                data-testid="page-next"
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {/* Page-full warning when the backend gives no pagination meta — older orders past
          the first {limit} would otherwise be silently unreachable without narrowing. */}
      {items.length > 0 && !pagination && pageFull && (
        <div
          className="flex items-start gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
          data-testid="page-full-warning"
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Showing the first {limit} orders — there may be more. Use Next, or narrow the
            filters (tenant / status / date range) to reach older orders.
          </span>
        </div>
      )}
    </div>
  );
}

/* ─── Bulk fulfilment (reused Excel sheet download + upload) ──────────────────── */

function BulkFulfilment({ onUploaded }: { onUploaded: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<FulfilmentUploadResult | null>(null);

  async function downloadTemplate() {
    setDownloading(true);
    setErr('');
    try {
      const res = await fetch('/api/admin/rewards/fulfilment/template', { headers: authHeader() });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: string };
          msg = j.error ?? msg;
        } catch {
          /* non-JSON error body */
        }
        setErr(msg);
        return;
      }
      const blob = await res.blob();
      downloadBlob(blob, `gift_fulfilment_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  async function uploadSheet(file: File) {
    setUploading(true);
    setErr('');
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      // Do NOT set Content-Type — the browser sets the multipart boundary.
      const res = await fetch('/api/admin/rewards/fulfilment/upload', {
        method: 'POST',
        headers: authHeader(),
        body: fd,
      });
      const json = (await res.json()) as {
        success?: boolean;
        data?: FulfilmentUploadResult;
        error?: string;
      };
      if (!res.ok || json.success === false) {
        setErr(json.error ?? `Upload failed (HTTP ${res.status})`);
        return;
      }
      setResult(json.data ?? null);
      onUploaded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void uploadSheet(file);
    e.target.value = '';
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 px-5 py-4 space-y-3">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-xl bg-green-50">
          <FileSpreadsheet className="w-4 h-4 text-green-600" />
        </div>
        <div>
          <p className="text-sm font-semibold text-gray-900">Bulk fulfilment</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Download the fulfilment sheet, fill in channel / voucher codes / tracking, then upload it back.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void downloadTemplate()}
          disabled={downloading}
          data-testid="bulk-download"
          className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-xs font-semibold rounded-lg hover:opacity-90 disabled:opacity-40"
        >
          {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          Download sheet
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          data-testid="bulk-upload"
          className="inline-flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-700 text-xs font-semibold rounded-lg hover:bg-gray-50 disabled:opacity-40"
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4 text-gray-400" />}
          Upload filled sheet
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={onFileChange}
          className="hidden"
          data-testid="bulk-file-input"
        />
      </div>

      {err && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{err}</span>
        </div>
      )}

      {result && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Processed', value: result.processed, color: 'bg-gray-50 border-gray-200 text-gray-800' },
              { label: 'Succeeded', value: result.succeeded, color: 'bg-green-50 border-green-200 text-green-700' },
              { label: 'Skipped', value: result.skipped, color: 'bg-amber-50 border-amber-200 text-amber-700' },
              {
                label: 'Failed',
                value: result.failed,
                color: result.failed > 0 ? 'bg-red-50 border-red-200 text-red-700' : 'bg-gray-50 border-gray-200 text-gray-800',
              },
            ].map((s) => (
              <div key={s.label} className={`rounded-lg border px-4 py-3 text-center ${s.color}`}>
                <p className="text-2xl font-bold">{s.value}</p>
                <p className="text-xs font-medium mt-0.5 opacity-70">{s.label}</p>
              </div>
            ))}
          </div>
          {result.errors.length > 0 ? (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 space-y-1 max-h-44 overflow-y-auto" data-testid="bulk-errors">
              <p className="text-xs font-semibold text-amber-700 mb-2">Row errors</p>
              {result.errors.map((er, i) => (
                <p key={i} className="text-xs text-amber-700">
                  <span className="font-mono font-semibold">
                    Row {er.row}{er.orderNumber ? ` — ${er.orderNumber}` : ''}:{' '}
                  </span>
                  {er.message}
                </p>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle2 className="w-4 h-4" /> All rows processed without errors.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
