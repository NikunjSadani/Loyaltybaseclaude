'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Package, CheckCircle, Truck, Clock, XCircle, RotateCcw, Copy, Check, ExternalLink, Ticket } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate, formatPoints } from '@/lib/utils';
import { authHeader } from '@/lib/api-client';
import { buildOrderSteps, type OrderTracking } from '@/lib/order-timeline';
import { OrderStepper } from '@/components/partner/order-stepper';

/* ─── Live order shape (GET /api/rewards/orders) ──────────────────────────────
   The {success,data} envelope is unwrapped in the effect; `data.orders` is the
   list, each augmented with `reward` and `partner`. Voucher codes (GIFT_CARD /
   VOUCHER) and tracking (PHYSICAL_GIFT) are owned by P5 and rendered inline. */

interface ApiOrder {
  id: string;
  orderNumber?: string;
  reward: { id: string; name: string; imageUrls: string[] };
  partner?: { id: string; businessName?: string };
  status: string;                          // PENDING | CONFIRMED | PROCESSING | DISPATCHED | DELIVERED | CANCELLED | ...
  redemptionMode?: string | null;          // GIFT_CARD | VOUCHER | PHYSICAL_GIFT | BANK_TRANSFER | UPI
  totalPointsCost: number;
  voucherCode?: string | null;
  /** Card PIN for a card number + PIN gift card (member's own order only). */
  voucherPin?: string | null;
  voucherProvider?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  // Member-safe courier name (e.g. "Delhivery"). NOTE: the member view deliberately
  // never reads the ops-only fulfilment fields (fulfilmentChannel, fulfilledByVendorId,
  // supplierOrderRef, delivery PII) — those live only on the Gifsy ops console.
  logisticsPartner?: string | null;
  createdAt: string;
  updatedAt: string;
  // The only date columns the list endpoint sends (no confirmed/processed/returned columns
  // exist; per-step dates come from /track when a timeline is expanded).
  dispatchedAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
}

interface Order {
  id: string;
  orderNumber?: string;
  rewardName: string;
  pointsSpent: number;
  status: string;
  redemptionMode?: string | null;
  voucherCode?: string | null;
  voucherPin?: string | null;
  voucherProvider?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  logisticsPartner?: string | null;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
}

const statusConfig: Record<string, { icon: React.ReactNode; label: string; variant: BadgeVariant }> = {
  PENDING:    { icon: <Clock className="h-4 w-4" />,      label: 'Pending',    variant: 'warning' },
  CONFIRMED:  { icon: <CheckCircle className="h-4 w-4" />, label: 'Confirmed',  variant: 'info'    },
  PROCESSING: { icon: <Clock className="h-4 w-4" />,      label: 'Processing', variant: 'info'    },
  DISPATCHED: { icon: <Truck className="h-4 w-4" />,      label: 'Dispatched', variant: 'info'    },
  DELIVERED:  { icon: <CheckCircle className="h-4 w-4" />, label: 'Delivered',  variant: 'success' },
  FAILED:     { icon: <XCircle className="h-4 w-4" />,    label: 'Failed',     variant: 'danger'  },
  CANCELLED:  { icon: <XCircle className="h-4 w-4" />,    label: 'Cancelled',  variant: 'danger'  },
  RETURNED:   { icon: <RotateCcw className="h-4 w-4" />,  label: 'Returned',   variant: 'default' },
  REVERSED:   { icon: <RotateCcw className="h-4 w-4" />,  label: 'Reversed',   variant: 'default' },
};

function statusFor(status: string) {
  return statusConfig[status] ?? { icon: <Clock className="h-4 w-4" />, label: status, variant: 'default' as BadgeVariant };
}

function mapApiOrder(o: ApiOrder): Order {
  return {
    id:              o.id,
    orderNumber:     o.orderNumber,
    rewardName:      o.reward?.name ?? 'Reward',
    pointsSpent:     o.totalPointsCost,
    status:          o.status,
    redemptionMode:  o.redemptionMode ?? null,
    voucherCode:     o.voucherCode ?? null,
    voucherPin:      o.voucherPin?.trim() ? o.voucherPin : null,
    voucherProvider: o.voucherProvider ?? null,
    trackingNumber:  o.trackingNumber ?? null,
    trackingUrl:     o.trackingUrl ?? null,
    logisticsPartner: o.logisticsPartner ?? null,
    createdAt:       o.createdAt,
    updatedAt:       o.updatedAt,
    dispatchedAt:    o.dispatchedAt ?? null,
    deliveredAt:     o.deliveredAt ?? null,
    cancelledAt:     o.cancelledAt ?? null,
  };
}

/** GET /api/rewards/orders envelope. `nextCursor` (keyset, opaque) is null on the last page;
 *  `pagination.total` is the partner's full visible order count. */
interface OrdersListResponse {
  success: boolean;
  data?: {
    orders: ApiOrder[];
    nextCursor?: string | null;
    pagination?: { total?: number };
  };
  error?: string;
}

const VOUCHER_MODES = new Set(['GIFT_CARD', 'VOUCHER']);

/** Partner-facing brand label for a voucher — the reward's brand, never the back-end
 *  aggregator (e.g. Hubble). Strips a trailing generic "voucher"/"gift card"/"card" so
 *  "Amazon Voucher" reads as "Amazon"; falls back to the full reward name. */
function brandLabel(rewardName: string): string {
  const s = (rewardName || '').trim();
  const stripped = s.replace(/\s*(e-?)?(gift\s*)?(voucher|card)s?$/i, '').trim();
  return stripped || s;
}

/* ─── Voucher code block with copy-to-clipboard ───────────────────────────── */

function CopyButton({ value, testId, label }: { value: string; testId: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  // ONE pending timer per button: every tap clears the previous one, so an old "reset to idle"
  // can never cut a newer message short.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const later = (fn: () => void, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    // A new tap always starts fresh (a previous "Copied" / "Copy failed" is cleared).
    if (timer.current) clearTimeout(timer.current);
    setState('idle');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setState('copied');
      later(() => setState('idle'), 2000);
    } catch {
      // Clipboard blocked / unavailable (insecure context, old WebView): say so, and the value
      // itself stays user-selectable (select-all) so a long-press copies it. Set on the NEXT tick
      // so the live region really goes empty first — a repeated failure is announced again.
      later(() => {
        setState('failed');
        // The failure hint clears itself after ~4 s (or on the next tap, above).
        later(() => setState('idle'), 4000);
      }, 0);
    }
  };

  return (
    <span className="flex flex-col items-end shrink-0">
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        onClick={copy}
        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-100 transition-colors"
      >
        {state === 'copied' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {state === 'copied' ? 'Copied' : 'Copy'}
      </button>
      {/* Announced politely to screen readers ("Copied" / the failure hint); the failure is visible too. */}
      <span aria-live="polite" role="status" data-testid={`${testId}-status`} className={state === 'failed' ? 'mt-0.5 text-[10px] text-red-600' : 'sr-only'}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed — long-press to copy' : ''}
      </span>
    </span>
  );
}

/**
 * The member's voucher. A number-only / PIN-only card shows one "Voucher Code" row (unchanged); a
 * card number + PIN gift card shows "Card no." and "PIN", each with its own copy button.
 */
function VoucherCodeBlock({ code, pin, brand }: { code: string; pin?: string | null; brand?: string | null }) {
  return (
    <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Ticket className="h-3.5 w-3.5 text-emerald-700" />
        <p className="text-[10px] font-semibold text-emerald-700 uppercase tracking-wide">
          {pin ? 'Gift Card' : 'Voucher Code'}{brand ? ` · ${brand}` : ''}
        </p>
      </div>
      {pin ? (
        <div className="space-y-2">
          <div>
            <p className="text-[10px] font-medium text-emerald-700/80 mb-0.5">Card no.</p>
            <div className="flex items-center gap-2">
              <code data-testid="voucher-code" className="flex-1 font-mono text-sm font-bold text-gray-900 break-all select-all">
                {code}
              </code>
              <CopyButton value={code} testId="copy-voucher-btn" label="Copy card number" />
            </div>
          </div>
          <div>
            <p className="text-[10px] font-medium text-emerald-700/80 mb-0.5">PIN</p>
            <div className="flex items-center gap-2">
              <code data-testid="voucher-pin" className="flex-1 font-mono text-sm font-bold text-gray-900 break-all select-all">
                {pin}
              </code>
              <CopyButton value={pin} testId="copy-voucher-pin-btn" label="Copy PIN" />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <code data-testid="voucher-code" className="flex-1 font-mono text-sm font-bold text-gray-900 break-all select-all">
            {code}
          </code>
          <CopyButton value={code} testId="copy-voucher-btn" label="Copy voucher code" />
        </div>
      )}
    </div>
  );
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Per-order /track result (history + refundedAt) for the DETAIL stepper only — fetched once,
  // on first expand. The compact bar stays status-only so the list never fans out N requests.
  const [trackingById, setTrackingById] = useState<Record<string, OrderTracking>>({});
  const requested = useRef<Set<string>>(new Set());
  // Ids whose LAST /track attempt failed → a muted "Dates couldn't be loaded" notice. A failed id
  // is dropped from `requested`, so the next expand retries (user-driven — never an auto loop).
  const [trackFailed, setTrackFailed] = useState<Record<string, boolean>>({});

  const loadTracking = useCallback((id: string) => {
    if (requested.current.has(id)) return;
    requested.current.add(id);
    const fail = () => {
      requested.current.delete(id);
      setTrackFailed(prev => ({ ...prev, [id]: true }));
    };
    fetch(`/api/rewards/orders/${encodeURIComponent(id)}/track`, { headers: { ...authHeader() } })
      .then(r => r.json())
      .then((json: { success?: boolean; data?: { tracking?: { timeline?: OrderTracking['timeline']; refundedAt?: string | null } } }) => {
        const t = json?.success ? json.data?.tracking : undefined;
        // A failed/malformed /track keeps the status-only stepper.
        if (!t || !Array.isArray(t.timeline)) { fail(); return; }
        const tracking: OrderTracking = { timeline: t.timeline, refundedAt: t.refundedAt ?? null };
        setTrackingById(prev => ({ ...prev, [id]: tracking }));
        setTrackFailed(prev => ({ ...prev, [id]: false }));
      })
      .catch(fail);
  }, []);

  const toggle = (id: string) => {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    loadTracking(id);
  };

  // "Load more" paging — the first page stays the backend default (newest 20, fast); older
  // orders are appended via the keyset `nextCursor` (null = nothing older → button hidden).
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  // Bumped on every full (re)load so a Load-more response that lands after a Retry is dropped.
  const generation = useRef(0);

  const load = useCallback(() => {
    const gen = ++generation.current;
    setLoading(true);
    setError(null);
    setNextCursor(null);
    setTotal(null);
    setLoadingMore(false);
    setLoadMoreError(false);
    fetch('/api/rewards/orders', { headers: { ...authHeader() } })
      .then(r => r.json())
      .then((json: OrdersListResponse) => {
        if (gen !== generation.current) return;
        if (json.success && json.data) {
          setOrders(json.data.orders.map(mapApiOrder));
          setNextCursor(json.data.nextCursor ?? null);
          setTotal(typeof json.data.pagination?.total === 'number' ? json.data.pagination.total : null);
        } else {
          setError(json.error ?? 'Failed to load orders');
        }
      })
      .catch(() => { if (gen === generation.current) setError('Failed to load orders'); })
      .finally(() => { if (gen === generation.current) setLoading(false); });
  }, []);

  const loadMore = () => {
    if (!nextCursor || loadingMore) return;
    const gen = generation.current;
    setLoadingMore(true);
    setLoadMoreError(false);
    fetch(`/api/rewards/orders?cursor=${encodeURIComponent(nextCursor)}`, { headers: { ...authHeader() } })
      .then(r => r.json())
      .then((json: OrdersListResponse) => {
        if (gen !== generation.current) return;
        if (!json.success || !json.data) { setLoadMoreError(true); return; }
        const more = json.data.orders.map(mapApiOrder);
        // Keyset pages never overlap, but de-dupe by id defensively so a card (and its
        // per-order /track cache, keyed by id) can never render twice.
        setOrders(prev => {
          const seen = new Set(prev.map(o => o.id));
          return [...prev, ...more.filter(o => !seen.has(o.id))];
        });
        setNextCursor(json.data.nextCursor ?? null);
        if (typeof json.data.pagination?.total === 'number') setTotal(json.data.pagination.total);
      })
      .catch(() => { if (gen === generation.current) setLoadMoreError(true); })
      .finally(() => { if (gen === generation.current) setLoadingMore(false); });
  };

  useEffect(() => { load(); }, [load]);

  // Retry reloads the list from scratch, so drop every cached/failed /track result too.
  const reload = () => {
    requested.current.clear();
    setTrackingById({});
    setTrackFailed({});
    load();
  };

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">My Orders</h1>
        {/* The TRUE total (backend count), not just the loaded page — falls back to the loaded count.
            Shown only once the list request has RESOLVED: while loading (or after a failed load)
            there is no honest count, so a "0 orders" never flashes ahead of the real list. */}
        {loading ? (
          <span data-testid="orders-count-loading" className="text-sm text-gray-400">Loading…</span>
        ) : !error ? (
          <span data-testid="orders-count" className="text-sm text-gray-500">{total ?? orders.length} orders</span>
        ) : null}
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48">
          <Spinner size="lg" />
        </div>
      ) : error ? (
        <div className="text-center py-8">
          <p className="text-sm text-red-500">{error}</p>
          <button
            type="button"
            onClick={reload}
            data-testid="orders-retry"
            className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          >
            Retry
          </button>
        </div>
      ) : orders.length === 0 ? (
        <EmptyState
          icon={<Package className="h-8 w-8" />}
          title="No orders yet"
          description="Redeem your points to place your first order."
        />
      ) : (
        <div className="space-y-3">
          {orders.map((order) => {
            const config = statusFor(order.status);
            const isExpanded = expanded === order.id;
            const isVoucher = VOUCHER_MODES.has(order.redemptionMode ?? '') || !!order.voucherCode;
            // The paid voucher code must stay visible for the WHOLE post-issuance
            // lifecycle — ops can advance a DIGITAL_VOUCHER order past CONFIRMED to
            // PROCESSING / DISPATCHED / DELIVERED, and the member still needs the code.
            // Only pre-issuance / dead states hide it.
            const showVoucher =
              isVoucher &&
              !!order.voucherCode &&
              !['PENDING', 'CANCELLED', 'FAILED', 'RETURNED', 'REVERSED'].includes(order.status);

            return (
              <Card key={order.id}>
                <CardContent className="px-4 py-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-gray-50 rounded-lg shrink-0">
                      {isVoucher ? <Ticket className="h-5 w-5 text-gray-500" /> : <Package className="h-5 w-5 text-gray-500" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold text-gray-900 leading-snug">
                          {order.rewardName}
                        </p>
                        <Badge variant={config.variant}>
                          {config.label}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
                        <span className="text-xs text-[var(--brand-primary)] font-medium">
                          -{formatPoints(order.pointsSpent)} pts
                        </span>
                        <span className="text-xs text-gray-400">
                          Ordered {formatDate(order.createdAt)}
                        </span>
                        {order.orderNumber && (
                          <span className="text-xs text-gray-400 font-mono">{order.orderNumber}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Compact progress bar — status-only (no fetch), always visible */}
                  <OrderStepper variant="compact" steps={buildOrderSteps(order)} />

                  {/* Voucher code (GIFT_CARD / VOUCHER, once confirmed) */}
                  {showVoucher && order.voucherCode && (
                    <VoucherCodeBlock code={order.voucherCode} pin={order.voucherPin} brand={brandLabel(order.rewardName)} />
                  )}

                  {/* Physical-gift tracking (member-safe: courier name + tracking only) */}
                  {!isVoucher && (order.trackingNumber || order.trackingUrl) && (
                    <div className="mt-3 flex items-center gap-2 text-xs">
                      <Truck className="h-3.5 w-3.5 text-gray-500 shrink-0" />
                      {order.logisticsPartner && (
                        <span className="text-gray-500" data-testid="carrier">{order.logisticsPartner} ·</span>
                      )}
                      {order.trackingUrl ? (
                        <a
                          href={order.trackingUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid="tracking-link"
                          className="font-medium text-[var(--brand-primary)] hover:underline inline-flex items-center gap-1"
                        >
                          {order.trackingNumber ? `Track: ${order.trackingNumber}` : 'Track shipment'}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-gray-600">Track: {order.trackingNumber}</span>
                      )}
                    </div>
                  )}

                  {/* Timeline toggle */}
                  <button
                    type="button"
                    onClick={() => toggle(order.id)}
                    aria-expanded={isExpanded}
                    className="mt-3 w-full text-xs text-[var(--brand-primary)] font-medium text-left hover:underline"
                  >
                    {isExpanded ? 'Hide timeline' : 'View timeline'}
                  </button>

                  {/* Timeline — the dated vertical stepper */}
                  {isExpanded && (
                    <>
                      <OrderStepper variant="detail" steps={buildOrderSteps(order, trackingById[order.id])} />
                      {trackFailed[order.id] && (
                        <p data-testid="order-timeline-dates-failed" className="text-[11px] text-gray-400">
                          Dates couldn&apos;t be loaded
                        </p>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}

          {/* Load more — appends the next (older) page; hidden once the cursor is exhausted. */}
          {nextCursor && (
            <div className="pt-1 text-center">
              {loadMoreError && (
                <p data-testid="orders-load-more-error" className="mb-2 text-xs text-red-500">
                  Couldn&apos;t load more orders. Please try again.
                </p>
              )}
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                data-testid="orders-load-more"
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-60"
              >
                {loadingMore && <Spinner size="sm" />}
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
