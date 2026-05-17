'use client';

import React, { useState, useEffect } from 'react';
import { Package, CheckCircle, Truck, Clock, XCircle, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate, formatPoints } from '@/lib/utils';
import { RedemptionStatus } from '@/types';

interface Order {
  id: string;
  rewardName: string;
  pointsSpent: number;
  status: RedemptionStatus;
  trackingNumber?: string;
  createdAt: string;
  updatedAt: string;
  timeline: { status: string; date: string; note?: string }[];
}

const statusConfig: Record<
  RedemptionStatus,
  { icon: React.ReactNode; label: string; variant: 'info' | 'success' | 'warning' | 'danger' | 'default' }
> = {
  [RedemptionStatus.PENDING]: { icon: <Clock className="h-4 w-4" />, label: 'Pending', variant: 'warning' },
  [RedemptionStatus.PROCESSING]: { icon: <Clock className="h-4 w-4" />, label: 'Processing', variant: 'info' },
  [RedemptionStatus.DISPATCHED]: { icon: <Truck className="h-4 w-4" />, label: 'Dispatched', variant: 'info' },
  [RedemptionStatus.DELIVERED]: { icon: <CheckCircle className="h-4 w-4" />, label: 'Delivered', variant: 'success' },
  [RedemptionStatus.FAILED]: { icon: <XCircle className="h-4 w-4" />, label: 'Failed', variant: 'danger' },
  [RedemptionStatus.CANCELLED]: { icon: <XCircle className="h-4 w-4" />, label: 'Cancelled', variant: 'danger' },
  [RedemptionStatus.REVERSED]: { icon: <RotateCcw className="h-4 w-4" />, label: 'Reversed', variant: 'default' },
};

const MOCK_ORDERS: Order[] = [
  {
    id: 'o1',
    rewardName: 'Amazon Gift Voucher ₹200',
    pointsSpent: 200,
    status: RedemptionStatus.DELIVERED,
    trackingNumber: 'AMZ-2024-001',
    createdAt: '2026-05-01',
    updatedAt: '2026-05-05',
    timeline: [
      { status: 'Order Placed', date: '2026-05-01' },
      { status: 'Processing', date: '2026-05-02' },
      { status: 'Dispatched', date: '2026-05-03', note: 'Tracking: AMZ-2024-001' },
      { status: 'Delivered', date: '2026-05-05' },
    ],
  },
  {
    id: 'o2',
    rewardName: 'Bluetooth Speaker (JBL)',
    pointsSpent: 2500,
    status: RedemptionStatus.DISPATCHED,
    trackingNumber: 'DEOLEO-5512',
    createdAt: '2026-05-10',
    updatedAt: '2026-05-13',
    timeline: [
      { status: 'Order Placed', date: '2026-05-10' },
      { status: 'Processing', date: '2026-05-11' },
      { status: 'Dispatched', date: '2026-05-13', note: 'Tracking: DEOLEO-5512' },
    ],
  },
  {
    id: 'o3',
    rewardName: 'Movie Tickets (2x)',
    pointsSpent: 400,
    status: RedemptionStatus.PENDING,
    createdAt: '2026-05-15',
    updatedAt: '2026-05-15',
    timeline: [
      { status: 'Order Placed', date: '2026-05-15' },
    ],
  },
];

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setOrders(MOCK_ORDERS);
      setLoading(false);
    }, 500);
    return () => clearTimeout(t);
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
      ) : orders.length === 0 ? (
        <EmptyState
          icon={<Package className="h-8 w-8" />}
          title="No orders yet"
          description="Redeem your points to place your first order."
        />
      ) : (
        <div className="space-y-3">
          {orders.map((order) => {
            const config = statusConfig[order.status];
            const isExpanded = expanded === order.id;

            return (
              <Card key={order.id}>
                <CardContent className="px-4 py-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-gray-50 rounded-lg shrink-0">
                      <Package className="h-5 w-5 text-gray-500" />
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
                        <span className="text-xs text-[#C8102E] font-medium">
                          -{formatPoints(order.pointsSpent)} pts
                        </span>
                        <span className="text-xs text-gray-400">
                          Ordered {formatDate(order.createdAt)}
                        </span>
                        {order.trackingNumber && (
                          <span className="text-xs text-gray-500">
                            Track: {order.trackingNumber}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Timeline toggle */}
                  <button
                    onClick={() => setExpanded(isExpanded ? null : order.id)}
                    className="mt-3 w-full text-xs text-[#C8102E] font-medium text-left hover:underline"
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
                                isLast ? 'bg-[#C8102E]' : 'bg-gray-300'
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
