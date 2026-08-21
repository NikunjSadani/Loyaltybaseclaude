'use client';

/**
 * /admin/whatsapp-broadcasts — campaign list / history (Gifsy-operator only).
 *
 * Lists every WhatsApp broadcast for the assumed tenant with its status + the
 * sent/delivered/read/failed counts, and a "New broadcast" entry into the wizard.
 * Data: GET /api/admin/whatsapp-broadcasts.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  MessageSquare,
  Plus,
  Loader2,
  AlertTriangle,
  Send,
  BookText,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import {
  type BroadcastSummary,
  BROADCAST_STATUS_LABEL,
} from '@/lib/whatsapp-broadcasts';
import { StatusPill } from '@/components/whatsapp/status-pill';

export default function WhatsappBroadcastsListPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<BroadcastSummary[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await api.get<BroadcastSummary[] | { items: BroadcastSummary[] }>(
      '/api/admin/whatsapp-broadcasts',
    );
    if (res.success) {
      const data = Array.isArray(res.data)
        ? res.data
        : (res.data?.items ?? []);
      setItems(data);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-[var(--brand-primary)]" />
            WhatsApp Broadcasts
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Send bulk WhatsApp template messages to outlets, sales reps, or an uploaded
            list — and track delivery.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/whatsapp-broadcasts/templates"
            className="inline-flex items-center gap-2 text-xs px-4 py-2 rounded-lg border border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 transition-colors"
          >
            <BookText className="w-3.5 h-3.5" />
            Template library
          </Link>
          <Link
            href="/admin/whatsapp-broadcasts/new"
            className="inline-flex items-center gap-2 text-xs px-4 py-2 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-[#a50d26] transition-colors"
            data-testid="new-broadcast-btn"
          >
            <Plus className="w-3.5 h-3.5" />
            New broadcast
          </Link>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center text-gray-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
          Loading broadcasts…
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-12 text-center text-sm">
          <AlertTriangle className="w-5 h-5 text-red-500 mx-auto mb-2" />
          <p className="text-red-700">{error}</p>
          <button
            onClick={() => void load()}
            className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && items.length === 0 && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center">
          <div className="p-4 bg-gray-100 rounded-full inline-flex text-gray-400 mb-3">
            <Send className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-gray-900">No broadcasts yet</h3>
          <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
            Create your first WhatsApp broadcast — pick an audience, choose an approved
            template, preview it, and send.
          </p>
          <Link
            href="/admin/whatsapp-broadcasts/new"
            className="inline-flex items-center gap-2 text-xs px-4 py-2 mt-4 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-[#a50d26] transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            New broadcast
          </Link>
        </div>
      )}

      {/* Table */}
      {!loading && !error && items.length > 0 && (
        <div className="border border-gray-200 bg-white rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left">
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Campaign</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Status</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Recipients</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Sent</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Delivered</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Read</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Failed</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((b) => (
                  <tr key={b.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/whatsapp-broadcasts/${b.id}`}
                        className="font-semibold text-gray-900 hover:text-[var(--brand-primary)]"
                      >
                        {b.title}
                      </Link>
                      {b.templateName && (
                        <div className="text-[11px] text-gray-400 mt-0.5">
                          {b.templateName}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill status={b.status} />
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {b.recipientCount.toLocaleString('en-IN')}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {b.sentCount.toLocaleString('en-IN')}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-emerald-600">
                      {b.deliveredCount.toLocaleString('en-IN')}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-blue-600">
                      {b.readCount.toLocaleString('en-IN')}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-red-600">
                      {b.failedCount.toLocaleString('en-IN')}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                      {b.status === 'SCHEDULED' && b.scheduledAt
                        ? `Scheduled ${formatDate(b.scheduledAt)}`
                        : b.sentAt
                          ? formatDate(b.sentAt)
                          : formatDate(b.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-[11px] text-gray-400">
        {items.length > 0 &&
          `${items.length} broadcast${items.length !== 1 ? 's' : ''}. Statuses: ${Object.values(
            BROADCAST_STATUS_LABEL,
          ).join(' · ')}.`}
      </p>
    </div>
  );
}

function formatDate(iso: string): string {
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
