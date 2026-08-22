'use client';

/**
 * /admin/gift-catalogue/moderation — vendor-item moderation queue (Gifsy-only).
 *
 * Lists per-tenant catalogue items with moderationStatus=PENDING and lets the operator
 * approve or reject each. In Wave-1 this is wired but typically EMPTY — it fills with
 * vendor-submitted items in Wave-2 (§4 vendor item flow). Approving makes the item
 * redeemable; rejecting removes it from the member catalogue with a reason.
 *
 * Data:
 *   GET  /api/admin/gift-catalogue/moderation           → { items: ModerationItem[] }
 *   POST /api/admin/gift-catalogue/moderation/:id/approve
 *   POST /api/admin/gift-catalogue/moderation/:id/reject  { reason }
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ShieldCheck, Loader2, AlertTriangle, Check, X, CheckCircle2, XCircle,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { formatINR } from '@/lib/money';
import { type ModerationItem, MODERATION_STATUS_LABEL } from '@/lib/gift-catalogue';

type Toast = { msg: string; type: 'success' | 'error' };

export default function ModerationQueuePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ModerationItem[]>([]);
  const [rejecting, setRejecting] = useState<ModerationItem | null>(null);
  // Per-row in-flight guard so approve/reject can't double-fire or race a second row.
  const [busyId, setBusyId] = useState<string | null>(null);

  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, type: Toast['type'] = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await api.get<{ items: ModerationItem[] } | ModerationItem[]>(
      '/api/admin/gift-catalogue/moderation',
    );
    if (res.success) {
      setItems(Array.isArray(res.data) ? res.data : (res.data?.items ?? []));
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleApprove(it: ModerationItem) {
    if (busyId) return;
    setBusyId(it.id);
    const res = await api.post<unknown>(
      `/api/admin/gift-catalogue/moderation/${it.id}/approve`,
      {},
    );
    setBusyId(null);
    if (res.success) {
      showToast(`Approved "${it.name}".`);
      // Optimistically drop it from the pending list, then reconcile with the server.
      setItems((prev) => prev.filter((r) => r.id !== it.id));
      void load();
    } else {
      showToast(res.error, 'error');
    }
  }

  async function submitReject(reason: string) {
    if (!rejecting || busyId) return;
    const it = rejecting;
    setBusyId(it.id);
    const res = await api.post<unknown>(
      `/api/admin/gift-catalogue/moderation/${it.id}/reject`,
      { reason },
    );
    setBusyId(null);
    if (res.success) {
      setRejecting(null);
      showToast(`Rejected "${it.name}".`);
      setItems((prev) => prev.filter((r) => r.id !== it.id));
      void load();
    } else {
      showToast(res.error, 'error');
    }
  }

  return (
    <div className="space-y-5 fade-in">
      <div>
        <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-[var(--brand-primary)]" />
          Moderation queue
        </h1>
        <p className="text-xs text-gray-500 mt-0.5">
          Review vendor-submitted catalogue items awaiting approval. Approve to make an item
          redeemable, or reject with a reason. (Fills with vendor items in Wave&nbsp;2.)
        </p>
      </div>

      {loading && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center text-gray-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
          Loading moderation queue…
        </div>
      )}

      {!loading && error && (
        <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-12 text-center text-sm">
          <AlertTriangle className="w-5 h-5 text-red-500 mx-auto mb-2" />
          <p className="text-red-700">{error}</p>
          <button onClick={() => void load()} className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50">
            Retry
          </button>
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center" data-testid="moderation-empty">
          <div className="p-4 bg-gray-100 rounded-full inline-flex text-gray-400 mb-3">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-gray-900">Nothing to review</h3>
          <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
            No vendor items are pending moderation right now. New submissions will appear here.
          </p>
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="border border-gray-200 bg-white rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left">
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Item</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Vendor</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Tenant</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Selling price</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">MRP</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Status</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((it) => (
                  <tr key={it.id} className="hover:bg-gray-50 transition-colors" data-testid={`moderation-row-${it.id}`}>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-gray-900">{it.name}</div>
                      {it.categoryName && (
                        <div className="text-[11px] text-gray-400">{it.categoryName}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">{it.vendorName ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-700">{it.clientName ?? '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {formatINR(it.sellingValuePaise)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-500">
                      {it.mrpPaise != null ? formatINR(it.mrpPaise) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-medium border bg-amber-50 text-amber-700 border-amber-100">
                        {MODERATION_STATUS_LABEL[it.moderationStatus]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => void handleApprove(it)}
                          disabled={busyId != null}
                          data-testid={`approve-${it.id}`}
                          aria-label={`Approve ${it.name}`}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-green-700 bg-green-50 border border-green-100 hover:bg-green-100 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {busyId === it.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                          Approve
                        </button>
                        <button
                          onClick={() => setRejecting(it)}
                          disabled={busyId != null}
                          data-testid={`reject-${it.id}`}
                          aria-label={`Reject ${it.name}`}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-red-600 bg-red-50 border border-red-100 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <X className="w-3.5 h-3.5" />
                          Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {rejecting && (
        <RejectDialog
          item={rejecting}
          saving={busyId === rejecting.id}
          onCancel={() => setRejecting(null)}
          onSubmit={submitReject}
        />
      )}

      {toast && (
        <div role="status" className="fixed bottom-6 right-6 z-[80] flex items-center gap-2 bg-gray-900 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg">
          {toast.type === 'error'
            ? <XCircle className="w-4 h-4 text-red-400" />
            : <CheckCircle2 className="w-4 h-4 text-green-400" />}
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function RejectDialog({
  item, saving, onCancel, onSubmit,
}: {
  item: ModerationItem;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onCancel(); }}
      title={`Reject “${item.name}”`}
      description="The vendor will see this reason. The item is dropped from the member catalogue."
      className="max-w-md"
    >
      <label className="block text-xs font-medium text-gray-600 mb-1.5" htmlFor="reject-reason">
        Reason<span className="text-[var(--brand-primary)]"> *</span>
      </label>
      <textarea
        id="reject-reason"
        value={reason}
        data-testid="reject-reason"
        rows={3}
        onChange={(e) => setReason(e.target.value)}
        className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
        placeholder="e.g. Price exceeds MRP; image quality too low."
      />
      <div className="flex items-center justify-end gap-2 mt-5">
        <button onClick={onCancel} className="px-4 py-2 text-xs font-semibold text-gray-600 rounded-lg hover:bg-gray-100">
          Cancel
        </button>
        <Button
          variant="destructive"
          onClick={() => onSubmit(trimmed)}
          loading={saving}
          disabled={trimmed.length === 0}
          data-testid="reject-confirm"
        >
          Reject item
        </Button>
      </div>
    </Modal>
  );
}
