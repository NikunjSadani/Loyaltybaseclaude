'use client';

import React, { useState, useEffect } from 'react';
import { Package, CheckCircle, Truck, Clock, XCircle, RotateCcw, Copy, Check, ExternalLink, Ticket } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate, formatPoints } from '@/lib/utils';

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
  voucherProvider?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string | null;
  processedAt?: string | null;
  dispatchedAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
}

interface TimelineStep { status: string; date: string; note?: string }

interface Order {
  id: string;
  orderNumber?: string;
  rewardName: string;
  pointsSpent: number;
  status: string;
  redemptionMode?: string | null;
  voucherCode?: string | null;
  voucherProvider?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  timeline: TimelineStep[];
}

const statusConfig: Record<string, { icon: React.ReactNode; label: string; variant: BadgeVariant }> = {
  PENDING:    { icon: <Clock className="h-4 w-4" />,      label: 'Pending',    variant: 'warning' },
  CONFIRMED:  { icon: <CheckCircle className="h-4 w-4" />, label: 'Confirmed',  variant: 'info'    },
  PROCESSING: { icon: <Clock className="h-4 w-4" />,      label: 'Processing', variant: 'info'    },
  DISPATCHED: { icon: <Truck className="h-4 w-4" />,      label: 'Dispatched', variant: 'info'    },
  DELIVERED:  { icon: <CheckCircle className="h-4 w-4" />, label: 'Delivered',  variant: 'success' },
  FAILED:     { icon: <XCircle className="h-4 w-4" />,    label: 'Failed',     variant: 'danger'  },
  CANCELLED:  { icon: <XCircle className="h-4 w-4" />,    label: 'Cancelled',  variant: 'danger'  },
  REVERSED:   { icon: <RotateCcw className="h-4 w-4" />,  label: 'Reversed',   variant: 'default' },
};

function statusFor(status: string) {
  return statusConfig[status] ?? { icon: <Clock className="h-4 w-4" />, label: status, variant: 'default' as BadgeVariant };
}

/** Build a status timeline from the order's stamped timestamps. */
function buildTimeline(o: ApiOrder): TimelineStep[] {
  const steps: TimelineStep[] = [{ status: 'Order Placed', date: o.createdAt }];
  if (o.confirmedAt) steps.push({ status: 'Confirmed', date: o.confirmedAt });
  if (o.processedAt) steps.push({ status: 'Processing', date: o.processedAt });
  if (o.dispatchedAt) {
    steps.push({
      status: 'Dispatched', date: o.dispatchedAt,
      note: o.trackingNumber ? `Tracking: ${o.trackingNumber}` : undefined,
    });
  }
  if (o.deliveredAt)  steps.push({ status: 'Delivered', date: o.deliveredAt });
  if (o.cancelledAt)  steps.push({ status: 'Cancelled', date: o.cancelledAt });
  // Fallback: if no intermediate stamp but the current status is past PENDING,
  // surface it so the timeline reflects the live status.
  if (steps.length === 1 && o.status !== 'PENDING') {
    steps.push({ status: statusFor(o.status).label, date: o.updatedAt });
  }
  return steps;
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
    voucherProvider: o.voucherProvider ?? null,
    trackingNumber:  o.trackingNumber ?? null,
    trackingUrl:     o.trackingUrl ?? null,
    createdAt:       o.createdAt,
    updatedAt:       o.updatedAt,
    timeline:        buildTimeline(o),
  };
}

const VOUCHER_MODES = new Set(['GIFT_CARD', 'VOUCHER']);

/* ─── Voucher code block with copy-to-clipboard ───────────────────────────── */

function VoucherCodeBlock({ code, provider }: { code: string; provider?: string | null }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — leave state unchanged.
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Ticket className="h-3.5 w-3.5 text-emerald-700" />
        <p className="text-[10px] font-semibold text-emerald-700 uppercase tracking-wide">
          Voucher Code{provider ? ` · ${provider}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <code data-testid="voucher-code" className="flex-1 font-mono text-sm font-bold text-gray-900 break-all">
          {code}
        </code>
        <button
          type="button"
          data-testid="copy-voucher-btn"
          aria-label="Copy voucher code"
          onClick={copy}
          className="flex items-center gap-1 shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-100 transition-colors"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/rewards/orders')
      .then(r => r.json())
      .then((json: { success: boolean; data?: { orders: ApiOrder[] }; error?: string }) => {
        if (json.success && json.data) {
          setOrders(json.data.orders.map(mapApiOrder));
        } else {
          setError(json.error ?? 'Failed to load orders');
        }
      })
      .catch(() => setError('Failed to load orders'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">My Orders</h1>
        <span className="text-sm text-gray-500">{orders.length} orders</span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48">
          <Spinner size="lg" />
        </div>
      ) : error ? (
        <div className="text-sm text-red-500 text-center py-8">{error}</div>
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
            const showVoucher = isVoucher && order.status === 'CONFIRMED' && !!order.voucherCode;

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

                  {/* Voucher code (GIFT_CARD / VOUCHER, once confirmed) */}
                  {showVoucher && order.voucherCode && (
                    <VoucherCodeBlock code={order.voucherCode} provider={order.voucherProvider} />
                  )}

                  {/* Physical-gift tracking */}
                  {!isVoucher && (order.trackingNumber || order.trackingUrl) && (
                    <div className="mt-3 flex items-center gap-2 text-xs">
                      <Truck className="h-3.5 w-3.5 text-gray-500 shrink-0" />
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
                    onClick={() => setExpanded(isExpanded ? null : order.id)}
                    className="mt-3 w-full text-xs text-[var(--brand-primary)] font-medium text-left hover:underline"
                  >
                    {isExpanded ? 'Hide timeline' : 'View timeline'}
                  </button>

                  {/* Timeline */}
                  {isExpanded && (
                    <div className="mt-3 pl-3 border-l-2 border-gray-100 space-y-3">
                      {order.timeline.map((step, idx) => {
                        const isLast = idx === order.timeline.length - 1;
                        return (
                          <div key={idx} className="relative flex items-start gap-3">
                            <div
                              className={`w-2 h-2 rounded-full mt-1.5 shrink-0 -ml-[17px] ${
                                isLast ? 'bg-[var(--brand-primary)]' : 'bg-gray-300'
                              }`}
                            />
                            <div>
                              <p className="text-xs font-medium text-gray-800">{step.status}</p>
                              <p className="text-xs text-gray-400">{formatDate(step.date)}</p>
                              {step.note && (
                                <p className="text-xs text-gray-500 mt-0.5">{step.note}</p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
