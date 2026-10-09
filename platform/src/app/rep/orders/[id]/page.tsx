'use client';

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, Package, Ticket, Truck, ExternalLink, Copy, Check,
  Clock, CheckCircle, XCircle, RotateCcw,
} from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { formatDate, formatDateTime, formatPoints } from '@/lib/utils';
import { authHeader } from '@/lib/api-client';
import type { ApiEmployeeOrder, EmployeeTrack } from '../../_lib/employee';

/* ─── REP order detail + tracking ─────────────────────────────────────────────
   GET /api/rewards/employee/orders/:id → { order } (member-safe: delivery fields +
   voucher code) and GET /api/rewards/employee/orders/:id/track → { tracking } (status
   + tracking + the dispatch status timeline). A cross-account id 404s server-side. ── */

const statusConfig: Record<string, { label: string; variant: BadgeVariant }> = {
  PENDING: { label: 'Pending', variant: 'warning' },
  CONFIRMED: { label: 'Confirmed', variant: 'info' },
  PROCESSING: { label: 'Processing', variant: 'info' },
  DISPATCHED: { label: 'Dispatched', variant: 'info' },
  DELIVERED: { label: 'Delivered', variant: 'success' },
  FAILED: { label: 'Failed', variant: 'danger' },
  CANCELLED: { label: 'Cancelled', variant: 'danger' },
  RETURNED: { label: 'Returned', variant: 'default' },
  REVERSED: { label: 'Reversed', variant: 'default' },
};

function statusFor(status: string) {
  return statusConfig[status] ?? { label: status, variant: 'default' as BadgeVariant };
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  DELIVERED: <CheckCircle className="h-3.5 w-3.5" />,
  CANCELLED: <XCircle className="h-3.5 w-3.5" />,
  RETURNED: <RotateCcw className="h-3.5 w-3.5" />,
  REVERSED: <RotateCcw className="h-3.5 w-3.5" />,
};

const VOUCHER_MODES = new Set(['GIFT_CARD', 'VOUCHER']);

function VoucherCodeBlock({ code, provider }: { code: string; provider?: string | null }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — leave state unchanged */
    }
  };
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Ticket className="h-3.5 w-3.5 text-emerald-700" />
        <p className="text-[10px] font-semibold text-emerald-700 uppercase tracking-wide">
          Voucher Code{provider ? ` · ${provider}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 font-mono text-sm font-bold text-gray-900 break-all">{code}</code>
        <button
          type="button"
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

export default function RepOrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params?.id ?? '');

  const [order, setOrder] = useState<(ApiEmployeeOrder & { deliveryName?: string | null; deliveryCity?: string | null; deliveryAddressLine1?: string | null }) | null>(null);
  const [track, setTrack] = useState<EmployeeTrack | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/rewards/employee/orders/${id}`, { headers: { ...authHeader() } })
        .then((r) => r.json())
        .catch(() => null),
      fetch(`/api/rewards/employee/orders/${id}/track`, { headers: { ...authHeader() } })
        .then((r) => r.json())
        .catch(() => null),
    ]).then(([orderJson, trackJson]) => {
      if (cancelled) return;
      if (orderJson?.success && orderJson.data?.order) {
        setOrder(orderJson.data.order);
      } else {
        setError(orderJson?.error ?? 'Order not found');
      }
      if (trackJson?.success && trackJson.data?.tracking) {
        setTrack(trackJson.data.tracking as EmployeeTrack);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
        <Package className="h-12 w-12 text-gray-300" />
        <div>
          <p className="text-gray-700 font-semibold">Order not found</p>
          <p className="text-sm text-gray-500 mt-1">{error ?? 'This order is not available.'}</p>
        </div>
        <Button variant="primary" onClick={() => router.push('/rep/orders')}>
          Back to Orders
        </Button>
      </div>
    );
  }

  const config = statusFor(order.status);
  const isVoucher = VOUCHER_MODES.has(order.redemptionMode ?? '') || !!order.voucherCode;
  const showVoucher =
    isVoucher &&
    !!order.voucherCode &&
    !['PENDING', 'CANCELLED', 'FAILED', 'RETURNED', 'REVERSED'].includes(order.status);
  const timeline = track?.timeline ?? [];
  const trackingNumber = track?.trackingNumber ?? order.trackingNumber;
  const trackingUrl = track?.trackingUrl ?? order.trackingUrl;
  const logisticsPartner = track?.logisticsPartner ?? order.logisticsPartner;

  return (
    <div className="space-y-5 fade-in">
      <button
        type="button"
        onClick={() => router.push('/rep/orders')}
        className="flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Orders
      </button>

      <Card>
        <CardContent className="px-4 py-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-gray-50 rounded-lg shrink-0">
              {isVoucher ? (
                <Ticket className="h-5 w-5 text-gray-500" />
              ) : (
                <Package className="h-5 w-5 text-gray-500" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold text-gray-900 leading-snug">
                  {order.reward?.name ?? 'Reward'}
                </p>
                <Badge variant={config.variant}>{config.label}</Badge>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
                <span className="text-xs text-[var(--brand-primary)] font-medium">
                  -{formatPoints(order.totalPointsCost)} pts
                </span>
                <span className="text-xs text-gray-400">Ordered {formatDate(order.createdAt)}</span>
                {order.orderNumber && (
                  <span className="text-xs text-gray-400 font-mono">{order.orderNumber}</span>
                )}
              </div>
            </div>
          </div>

          {showVoucher && order.voucherCode && (
            <VoucherCodeBlock code={order.voucherCode} provider={order.voucherProvider} />
          )}

          {!isVoucher && (trackingNumber || trackingUrl) && (
            <div className="flex items-center gap-2 text-xs">
              <Truck className="h-3.5 w-3.5 text-gray-500 shrink-0" />
              {logisticsPartner && <span className="text-gray-500">{logisticsPartner} ·</span>}
              {trackingUrl ? (
                <a
                  href={trackingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-[var(--brand-primary)] hover:underline inline-flex items-center gap-1"
                >
                  {trackingNumber ? `Track: ${trackingNumber}` : 'Track shipment'}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span className="text-gray-600">Track: {trackingNumber}</span>
              )}
            </div>
          )}

          {/* Delivery address (physical gifts) */}
          {order.deliveryName && (
            <div className="rounded-xl bg-gray-50 px-3 py-2.5">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5">
                Delivering to
              </p>
              <p className="text-sm font-medium text-gray-800">{order.deliveryName}</p>
              <p className="text-xs text-gray-500">
                {[order.deliveryAddressLine1, order.deliveryCity].filter(Boolean).join(', ')}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tracking timeline */}
      <Card>
        <CardContent className="px-4 py-4">
          <p className="text-sm font-bold text-gray-900 mb-3">Order timeline</p>
          {timeline.length === 0 ? (
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full mt-1.5 shrink-0 bg-[var(--brand-primary)]" />
              <div>
                <p className="text-xs font-medium text-gray-800 flex items-center gap-1.5">
                  {STATUS_ICON[order.status] ?? <Clock className="h-3.5 w-3.5" />}
                  {config.label}
                </p>
                <p className="text-xs text-gray-400">{formatDate(order.updatedAt)}</p>
              </div>
            </div>
          ) : (
            <div className="pl-3 border-l-2 border-gray-100 space-y-3">
              {timeline.map((step, idx) => {
                const isLast = idx === timeline.length - 1;
                const s = statusFor(step.toStatus);
                return (
                  <div key={idx} className="relative flex items-start gap-3">
                    <div
                      className={`w-2 h-2 rounded-full mt-1.5 shrink-0 -ml-[17px] ${
                        isLast ? 'bg-[var(--brand-primary)]' : 'bg-gray-300'
                      }`}
                    />
                    <div>
                      <p className="text-xs font-medium text-gray-800">{s.label}</p>
                      <p className="text-xs text-gray-400">{formatDateTime(step.createdAt)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
