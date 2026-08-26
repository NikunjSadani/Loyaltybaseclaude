'use client';

/**
 * /admin/notification-delivery — Delivery Status report (Gifsy operator + tenant admin).
 *
 * Per-channel delivery funnels (SMS + transactional WhatsApp) + an aggregate OTP tile, a
 * filter bar (channel / date range / event), a paginated per-message receipt table, and an
 * xlsx export. TWO entry points share this page, split by role (useAdminSession):
 *   - GIFSY_ADMIN → platform-wide (all tenants), or the assumed tenant.
 *   - CLIENT_ADMIN → their OWN tenant only.
 * The BACKEND enforces the scope (tenantScope from the JWT); the FE never sends a clientId and
 * just renders the scoped payload it receives. The OTP tile is authoritative for the platform
 * operator and flagged `indicative` (redemption OTPs only) for a tenant — see the caveat below.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Send,
  Loader2,
  AlertTriangle,
  Download,
  Filter,
  X,
  MessageSquare,
  Smartphone,
  Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAdminSession } from '@/lib/admin-session';
import {
  type DeliverySummary,
  type DeliveryListPage,
  type DeliveryFilters,
  DELIVERY_PAGE_SIZE,
  emptyDeliveryFilters,
  isDeliveryFiltersEmpty,
  fetchDeliverySummary,
  fetchDeliveryList,
  downloadDeliveryExport,
  formatRate,
  channelLabel,
  statusLabel,
  statusPillClass,
} from '@/lib/notification-delivery';

const SELECT_CLS =
  'bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:border-[var(--brand-primary)]';

const n = (v: number) => v.toLocaleString('en-IN');

export default function NotificationDeliveryPage() {
  const session = useAdminSession();
  const isGifsy = session.role === 'GIFSY_ADMIN';

  const [filters, setFilters] = useState<DeliveryFilters>(emptyDeliveryFilters());
  const [applied, setApplied] = useState<DeliveryFilters>(emptyDeliveryFilters());
  const [page, setPage] = useState(1);

  const [summary, setSummary] = useState<DeliverySummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  const [listPage, setListPage] = useState<DeliveryListPage | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);

  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const loadSummary = useCallback(async (f: DeliveryFilters) => {
    setSummaryLoading(true);
    setSummaryError(null);
    const res = await fetchDeliverySummary(f);
    if (res.success) setSummary(res.data);
    else setSummaryError(res.error);
    setSummaryLoading(false);
  }, []);

  const loadList = useCallback(async (f: DeliveryFilters, p: number) => {
    setListLoading(true);
    setListError(null);
    const res = await fetchDeliveryList(f, p, DELIVERY_PAGE_SIZE);
    if (res.success) setListPage(res.data);
    else setListError(res.error);
    setListLoading(false);
  }, []);

  // Summary depends only on the applied filters; the list also depends on the page.
  useEffect(() => {
    void loadSummary(applied);
  }, [loadSummary, applied]);
  useEffect(() => {
    void loadList(applied, page);
  }, [loadList, applied, page]);

  function applyFilters() {
    setPage(1);
    setApplied(filters);
  }
  function clearFilters() {
    const empty = emptyDeliveryFilters();
    setFilters(empty);
    setApplied(empty);
    setPage(1);
  }

  async function handleDownload() {
    setDownloadError(null);
    setDownloading(true);
    try {
      await downloadDeliveryExport(applied);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  const rows = listPage?.items ?? [];
  const total = listPage?.total ?? 0;
  const pageSize = listPage?.pageSize ?? DELIVERY_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Send className="w-5 h-5 text-[var(--brand-primary)]" />
            Delivery Status
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {isGifsy
              ? 'Per-message delivery status for SMS, transactional WhatsApp, and OTP across every tenant (or the assumed tenant).'
              : 'Per-message delivery status for SMS, transactional WhatsApp, and OTP sent to your recipients.'}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={handleDownload}
          disabled={downloading || listLoading || total === 0}
          data-testid="download-delivery-btn"
        >
          {downloading ? (
            <Loader2 className="w-4 h-4 animate-spin" aria-label="Preparing" />
          ) : (
            <Download className="w-4 h-4" />
          )}
          Download Excel
        </Button>
      </div>

      {/* Funnel cards */}
      {summaryError ? (
        <div
          className="border border-red-200 bg-red-50 rounded-xl px-4 py-8 text-center text-sm"
          data-testid="summary-error"
        >
          <AlertTriangle className="w-5 h-5 text-red-500 mx-auto mb-2" />
          <p className="text-red-700">{summaryError}</p>
          <button
            onClick={() => void loadSummary(applied)}
            className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <FunnelCard
            testId="funnel-sms"
            title="SMS"
            icon={<MessageSquare className="w-4 h-4" />}
            loading={summaryLoading}
            rate={summary?.sms.deliveryRate ?? null}
            stats={[
              { label: 'Sent', value: summary?.sms.sent ?? 0 },
              { label: 'Delivered', value: summary?.sms.delivered ?? 0 },
              { label: 'Failed', value: summary?.sms.failed ?? 0 },
              { label: 'Pending', value: summary?.sms.pending ?? 0 },
            ]}
          />
          <FunnelCard
            testId="funnel-whatsapp"
            title="WhatsApp"
            icon={<MessageSquare className="w-4 h-4" />}
            loading={summaryLoading}
            rate={summary?.whatsapp.deliveryRate ?? null}
            stats={[
              { label: 'Sent', value: summary?.whatsapp.sent ?? 0 },
              { label: 'Delivered', value: summary?.whatsapp.delivered ?? 0 },
              { label: 'Read', value: summary?.whatsapp.read ?? 0 },
              { label: 'Failed', value: summary?.whatsapp.failed ?? 0 },
            ]}
          />
          <FunnelCard
            testId="funnel-otp"
            title="OTP"
            icon={<Smartphone className="w-4 h-4" />}
            loading={summaryLoading}
            rate={summary?.otp.deliveryRate ?? null}
            stats={[
              { label: 'Sent', value: summary?.otp.sent ?? 0 },
              { label: 'Delivered', value: summary?.otp.delivered ?? 0 },
              { label: 'Failed', value: summary?.otp.failed ?? 0 },
            ]}
            footer={
              summary?.otp.indicative ? (
                <p
                  className="flex items-start gap-1 text-[10px] text-amber-600 mt-2"
                  data-testid="otp-indicative"
                >
                  <Info className="w-3 h-3 mt-0.5 shrink-0" />
                  Indicative — redemption OTPs only (login/KYC OTPs are not tenant-attributed).
                </p>
              ) : null
            }
          />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 border border-gray-200 bg-white rounded-xl px-4 py-3">
        <div>
          <label className="block text-[11px] font-medium text-gray-500 mb-1" htmlFor="f-channel">
            Channel
          </label>
          <select
            id="f-channel"
            value={filters.channel ?? ''}
            data-testid="filter-channel"
            onChange={(e) =>
              setFilters((p) => ({ ...p, channel: e.target.value as DeliveryFilters['channel'] }))
            }
            className={SELECT_CLS}
          >
            <option value="">All channels</option>
            <option value="SMS">SMS</option>
            <option value="WHATSAPP">WhatsApp</option>
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-500 mb-1" htmlFor="f-from">
            From
          </label>
          <input
            id="f-from"
            type="date"
            value={filters.from ?? ''}
            data-testid="filter-from"
            onChange={(e) => setFilters((p) => ({ ...p, from: e.target.value }))}
            className={SELECT_CLS}
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-500 mb-1" htmlFor="f-to">
            To
          </label>
          <input
            id="f-to"
            type="date"
            value={filters.to ?? ''}
            data-testid="filter-to"
            onChange={(e) => setFilters((p) => ({ ...p, to: e.target.value }))}
            className={SELECT_CLS}
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-500 mb-1" htmlFor="f-event">
            Event
          </label>
          <input
            id="f-event"
            type="text"
            placeholder="e.g. ORDER_APPROVED"
            value={filters.event ?? ''}
            data-testid="filter-event"
            onChange={(e) => setFilters((p) => ({ ...p, event: e.target.value }))}
            className={SELECT_CLS}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={applyFilters} data-testid="apply-filters-btn">
            <Filter className="w-3.5 h-3.5" /> Apply
          </Button>
          {!isDeliveryFiltersEmpty(applied) && (
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

      {applied.from && applied.to && applied.from > applied.to && (
        <p
          className="flex items-start gap-1.5 text-xs text-amber-600"
          role="alert"
          data-testid="from-after-to-hint"
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          From date is after To date — no results possible.
        </p>
      )}

      {downloadError && (
        <p className="flex items-start gap-1.5 text-xs text-red-600" role="alert">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          {downloadError}
        </p>
      )}

      {/* List */}
      {listLoading && (
        <div
          className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center text-gray-400 text-sm"
          data-testid="delivery-loading"
        >
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
          Loading delivery receipts…
        </div>
      )}

      {!listLoading && listError && (
        <div
          className="border border-red-200 bg-red-50 rounded-xl px-4 py-12 text-center text-sm"
          data-testid="delivery-error"
        >
          <AlertTriangle className="w-5 h-5 text-red-500 mx-auto mb-2" />
          <p className="text-red-700">{listError}</p>
          <button
            onClick={() => void loadList(applied, page)}
            className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          >
            Retry
          </button>
        </div>
      )}

      {!listLoading && !listError && rows.length === 0 && (
        <div
          className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center"
          data-testid="delivery-empty"
        >
          <div className="p-4 bg-gray-100 rounded-full inline-flex text-gray-400 mb-3">
            <Send className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-gray-900">No delivery receipts</h3>
          <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
            {isDeliveryFiltersEmpty(applied)
              ? 'No transactional SMS or WhatsApp messages have been sent yet.'
              : 'No receipts match these filters. Try widening the date range or clearing filters.'}
          </p>
        </div>
      )}

      {!listLoading && !listError && rows.length > 0 && (
        <div className="border border-gray-200 bg-white rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Per-message delivery receipts — channel, event, recipient, status, and timestamps.
              </caption>
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left">
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Channel</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Event</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Recipient</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Status</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Sent</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Delivered</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Failure</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50 transition-colors" data-testid="delivery-row">
                    <td className="px-4 py-3 text-gray-700">{channelLabel(r.channel)}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{r.eventKey ?? '—'}</td>
                    <td className="px-4 py-3 tabular-nums text-gray-700">{r.recipientPhone ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${statusPillClass(r.status)}`}>
                        {statusLabel(r.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{fmtTs(r.sentAt)}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{fmtTs(r.deliveredAt)}</td>
                    <td className="px-4 py-3 text-xs text-red-600">{r.failureReason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 text-xs text-gray-500">
            <span data-testid="delivery-pageinfo">
              Page {listPage?.page ?? page} of {totalPages} · {n(total)} receipt{total === 1 ? '' : 's'}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={(listPage?.page ?? page) <= 1}
                data-testid="delivery-prev"
                className="px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={(listPage?.page ?? page) >= totalPages}
                data-testid="delivery-next"
                className="px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── funnel card ─────────────────────────────────────────────────────────────

function FunnelCard({
  testId,
  title,
  icon,
  loading,
  rate,
  stats,
  footer,
}: {
  testId: string;
  title: string;
  icon: React.ReactNode;
  loading: boolean;
  rate: number | null;
  stats: { label: string; value: number }[];
  footer?: React.ReactNode;
}) {
  return (
    <div className="border border-gray-200 bg-white rounded-xl px-4 py-3" data-testid={testId}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
          <span className="text-[var(--brand-primary)]">{icon}</span>
          {title}
        </span>
        <span className="text-right">
          <span className="block text-lg font-bold text-gray-900 tabular-nums" data-testid={`${testId}-rate`}>
            {loading ? '—' : formatRate(rate)}
          </span>
          <span className="block text-[10px] text-gray-400 -mt-0.5">delivery rate</span>
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2 mt-3">
        {stats.map((s) => (
          <div key={s.label}>
            <span className="block text-sm font-semibold text-gray-800 tabular-nums">
              {loading ? '—' : n(s.value)}
            </span>
            <span className="block text-[10px] text-gray-400">{s.label}</span>
          </div>
        ))}
      </div>
      {footer}
    </div>
  );
}

/** Compact timestamp for a table cell (date + HH:MM), or — when absent. */
function fmtTs(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
