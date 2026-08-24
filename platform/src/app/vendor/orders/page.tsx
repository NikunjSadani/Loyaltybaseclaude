'use client';

/**
 * /vendor/orders — the vendor's OWN redemption orders (design §2, §5).
 *
 * Lists ONLY the orders for this vendor's items (backend scopes by fulfilledByVendorId +
 * the grant's clientId). Status + date + order-number filters. Each row links to the
 * detail page where the vendor sets fulfilment + advances the order (dispatch / deliver
 * only). Value / points are READ-ONLY here.
 *
 * Data: GET /api/vendor/orders → { items: GiftOrderSummary[] } (array-tolerant).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Truck, Loader2, AlertTriangle, Search, RefreshCw, Package, ShieldAlert,
} from 'lucide-react';
import { api } from '@/lib/api-client';
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
  fmtValuePaise,
  fmtPoints,
} from '@/lib/gift-orders';
import { isBlockedError } from '@/lib/vendor';
import { useVendorMe } from '@/lib/vendor-context';

interface PaginationMeta { page: number; limit: number; total: number; pages: number }

const STATUS_FILTER_VALUES = ['all', ...Object.keys(GIFT_ORDER_STATUS_LABEL)];

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function VendorOrdersPage() {
  const [filters, setFilters] = useState<GiftOrderFilters>(emptyGiftOrderFilters());
  const [items, setItems] = useState<GiftOrderSummary[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  const me = useVendorMe();
  const myVendorId = me?.vendor?.id;

  const set = <K extends keyof GiftOrderFilters>(k: K, v: GiftOrderFilters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));

  const load = useCallback(async (f: GiftOrderFilters) => {
    setLoading(true);
    setError(null);
    setBlocked(false);
    const res = await api.get<
      GiftOrderSummary[] | { items: GiftOrderSummary[]; pagination?: PaginationMeta }
    >(`/api/vendor/orders${buildListQuery(f)}`);
    if (res.success) {
      const raw = res.data;
      const all = Array.isArray(raw) ? raw : (raw?.items ?? []);
      // Defence-in-depth: the BE scopes to this vendor, but if a slip returns a foreign
      // vendor's order, drop it. Only filters a row that actually carries a mismatching
      // fulfilledByVendorId — an absent id (the normal case) is never dropped.
      const scoped = myVendorId == null
        ? all
        : all.filter((o) => o.fulfilledByVendorId == null || o.fulfilledByVendorId === myVendorId);
      setItems(scoped);
      setPagination(Array.isArray(raw) ? null : (raw?.pagination ?? null));
    } else if (isBlockedError(res.error, res.status)) {
      setBlocked(true);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, [myVendorId]);

  useEffect(() => {
    void load(emptyGiftOrderFilters());
  }, [load]);

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
            My Orders
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Redemption orders for your items. Open an order to set the tracking / voucher
            details and mark it dispatched or delivered.
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

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
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

      {/* Blocked */}
      {!loading && blocked && (
        <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-12 text-center text-sm" data-testid="orders-blocked">
          <ShieldAlert className="w-5 h-5 text-red-500 mx-auto mb-2" />
          <p className="text-red-700 font-medium">Your access has been removed or suspended.</p>
          <p className="text-red-600/80 text-xs mt-1">You can no longer view these orders. Contact your Gifsy account manager.</p>
          {/* A transient 403 shouldn't be a dead end for an active vendor — offer a retry. */}
          <button
            onClick={() => void load(filters)}
            data-testid="orders-blocked-retry"
            className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-white"
          >
            Retry
          </button>
        </div>
      )}

      {/* Error */}
      {!loading && !blocked && error && (
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
      {!loading && !blocked && !error && items.length === 0 && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center">
          <div className="p-4 bg-gray-100 rounded-full inline-flex text-gray-400 mb-3">
            <Package className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-gray-900">No orders</h3>
          <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
            {isFiltersEmpty(filters)
              ? 'Orders appear here once members redeem your items.'
              : 'No orders match the current filters. Try widening the date range or clearing filters.'}
          </p>
        </div>
      )}

      {/* Table */}
      {!loading && !blocked && !error && items.length > 0 && (
        <div className="border border-gray-200 bg-white rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Redemption orders for your items, with channel, value, status and placed date.</caption>
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left">
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Order</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Item</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Channel</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Value</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Status</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Placed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((o) => (
                  <tr key={o.id} className="hover:bg-gray-50 transition-colors" data-testid="order-row">
                    <td className="px-4 py-3">
                      <Link
                        href={`/vendor/orders/${o.id}`}
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
                    <td className="px-4 py-3 text-gray-900">{o.rewardName ?? '—'}</td>
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

      {/* Pager */}
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

      {items.length > 0 && !pagination && pageFull && (
        <div
          className="flex items-start gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
          data-testid="page-full-warning"
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Showing the first {limit} orders — there may be more. Use Next, or narrow the
            filters (status / date range) to reach older orders.
          </span>
        </div>
      )}
    </div>
  );
}
