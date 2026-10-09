'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Package, Clock, CheckCircle, Truck, XCircle, RotateCcw, Ticket, ChevronRight } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate, formatPoints } from '@/lib/utils';
import { authHeader } from '@/lib/api-client';
import type { ApiEmployeeOrder } from '../_lib/employee';

/* ─── REP Orders list ─────────────────────────────────────────────────────────
   The employee's OWN redemption orders (account-scoped by the backend). Status
   chips + a tap-through to the detail/tracking page. ───────────────────────── */

const statusConfig: Record<string, { icon: React.ReactNode; label: string; variant: BadgeVariant }> = {
  PENDING: { icon: <Clock className="h-3.5 w-3.5" />, label: 'Pending', variant: 'warning' },
  CONFIRMED: { icon: <CheckCircle className="h-3.5 w-3.5" />, label: 'Confirmed', variant: 'info' },
  PROCESSING: { icon: <Clock className="h-3.5 w-3.5" />, label: 'Processing', variant: 'info' },
  DISPATCHED: { icon: <Truck className="h-3.5 w-3.5" />, label: 'Dispatched', variant: 'info' },
  DELIVERED: { icon: <CheckCircle className="h-3.5 w-3.5" />, label: 'Delivered', variant: 'success' },
  FAILED: { icon: <XCircle className="h-3.5 w-3.5" />, label: 'Failed', variant: 'danger' },
  CANCELLED: { icon: <XCircle className="h-3.5 w-3.5" />, label: 'Cancelled', variant: 'danger' },
  RETURNED: { icon: <RotateCcw className="h-3.5 w-3.5" />, label: 'Returned', variant: 'default' },
  REVERSED: { icon: <RotateCcw className="h-3.5 w-3.5" />, label: 'Reversed', variant: 'default' },
};

function statusFor(status: string) {
  return statusConfig[status] ?? { icon: <Clock className="h-3.5 w-3.5" />, label: status, variant: 'default' as BadgeVariant };
}

const VOUCHER_MODES = new Set(['GIFT_CARD', 'VOUCHER']);

export default function RepOrdersPage() {
  const [orders, setOrders] = useState<ApiEmployeeOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch('/api/rewards/employee/orders?limit=50', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: { orders: ApiEmployeeOrder[] }; error?: string }) => {
        if (json.success && json.data) {
          setOrders(json.data.orders ?? []);
        } else {
          setError(json.error ?? 'Failed to load orders');
        }
      })
      .catch(() => setError('Failed to load orders'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-gray-900">My Orders</h1>
        <span className="text-sm text-gray-500">{orders.length} orders</span>
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
            onClick={load}
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
            const isVoucher = VOUCHER_MODES.has(order.redemptionMode ?? '') || !!order.voucherCode;
            return (
              <Link key={order.id} href={`/rep/orders/${order.id}`} className="block">
                <Card className="hover:shadow-md transition-shadow">
                  <CardContent className="px-4 py-4">
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
                      <ChevronRight className="h-4 w-4 text-gray-300 shrink-0 mt-1" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
