'use client';

/**
 * /admin/gift-orders/[id] — gift order detail + fulfilment (GIFSY ops).
 *
 * Shows the full order (tenant, reward, member/delivery PII, internal "fulfilled by"),
 * a fulfilment form (channel + logistics partner + tracking / supplier ref / voucher
 * code) and guarded status transitions with a confirm gate on every change — including
 * the Gifsy-only DELIVERED→RETURNED value-reversal. Read the ops-only fields here; the
 * member's own tracking tile (partner app) never exposes channel / vendor / supplier ref.
 *
 * Data: GET   /api/admin/gift-orders/:id             (flat detail)
 *       PATCH /api/admin/gift-orders/:id/fulfilment  (channel / partner / tracking / refs)
 *       POST  /api/admin/gift-orders/:id/transition  (guarded edge-map, incl. RETURNED)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Loader2,
  AlertTriangle,
  Truck,
  Package,
  User,
  MapPin,
  Phone,
  Building2,
  Save,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Ticket,
  ShieldAlert,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { Modal } from '@/components/ui/modal';
import {
  type GiftOrderDetail,
  type FulfilmentDraft,
  emptyFulfilmentDraft,
  buildFulfilmentPayload,
  resetNonApplicableFields,
  validateFulfilment,
  nextStatusOptions,
  isTerminalStatus,
  confirmCopyFor,
  isVoucherChannel,
  buildTimeline,
  statusLabel,
  statusBadgeClass,
  channelLabel,
  GIFT_FULFILMENT_CHANNELS,
  fmtValuePaise,
  fmtPoints,
} from '@/lib/gift-orders';

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

export default function GiftOrderDetailPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const [order, setOrder] = useState<GiftOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const res = await api.get<GiftOrderDetail>(`/api/admin/gift-orders/${id}`);
    if (res.success) {
      setOrder(res.data);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5 fade-in max-w-4xl">
      <Link
        href="/admin/gift-orders"
        className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        All gift orders
      </Link>

      {loading && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center text-gray-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
          Loading order…
        </div>
      )}

      {!loading && error && (
        <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-12 text-center text-sm">
          <AlertTriangle className="w-5 h-5 text-red-500 mx-auto mb-2" />
          <p className="text-red-700">{error}</p>
          <button
            onClick={() => void load()}
            className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && order && (
        <>
          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-bold text-gray-900 font-mono">
                  {order.orderNumber ?? order.id.slice(-8)}
                </h1>
                <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${statusBadgeClass(order.status)}`} data-testid="order-status">
                  {statusLabel(order.status)}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                {order.rewardName ?? 'Gift'} · placed {formatDate(order.createdAt)}
              </p>
            </div>
          </div>

          {/* Summary grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-2.5">
              <p className="text-xs font-semibold text-gray-700">Order</p>
              <Field icon={<Building2 className="w-3.5 h-3.5" />} label="Tenant" value={order.tenantName ?? order.clientId ?? '—'} />
              <Field icon={<Package className="w-3.5 h-3.5" />} label="Reward" value={order.rewardName ?? '—'} />
              <Field icon={<User className="w-3.5 h-3.5" />} label="Partner" value={order.partnerName ?? '—'} />
              <Field
                label="Value"
                value={order.valuePaise != null ? fmtValuePaise(order.valuePaise) : '—'}
              />
              <Field label="Points spent" value={fmtPoints(order.totalPointsCost)} />
              <Field label="Mode" value={order.redemptionMode ?? '—'} />
            </div>

            {/* Internal "fulfilled by" + delivery PII — ops/tenant only (never on the
                member tile). Present for support/disputes. */}
            <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-2.5">
              <p className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
                Fulfilment
                <span className="text-[10px] font-normal text-gray-400">(internal)</span>
              </p>
              <Field label="Channel" value={channelLabel(order.fulfilmentChannel)} />
              <Field
                label="Fulfilled by"
                value={order.fulfilledByVendorName ?? (order.fulfilledByVendorId ? `Vendor ${order.fulfilledByVendorId}` : 'Gifsy')}
              />
              <Field label="Logistics partner" value={order.logisticsPartner ?? '—'} />
              {order.supplierOrderRef && <Field label="Supplier ref" value={order.supplierOrderRef} />}
              {(order.delivery?.name || order.delivery?.address || order.delivery?.phone) && (
                <div className="pt-1.5 border-t border-gray-100 space-y-1.5">
                  {order.delivery?.name && (
                    <Field icon={<User className="w-3.5 h-3.5" />} label="Ship to" value={order.delivery.name} />
                  )}
                  {order.delivery?.address && (
                    <Field icon={<MapPin className="w-3.5 h-3.5" />} label="Address" value={order.delivery.address} />
                  )}
                  {order.delivery?.phone && (
                    <Field icon={<Phone className="w-3.5 h-3.5" />} label="Phone" value={order.delivery.phone} />
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Fulfilment form */}
          <FulfilmentForm order={order} onSaved={() => { showToast('Fulfilment details saved.'); void load(); }} onError={(m) => showToast(m, 'error')} />

          {/* Status transitions */}
          <StatusActions order={order} onDone={(m) => { showToast(m); void load(); }} onError={(m) => showToast(m, 'error')} />

          {/* Timeline */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <p className="text-xs font-semibold text-gray-700 mb-3">Status timeline</p>
            <div className="pl-3 border-l-2 border-gray-100 space-y-3">
              {buildTimeline(order).map((step, idx, arr) => {
                const isLast = idx === arr.length - 1;
                return (
                  <div key={idx} className="relative flex items-start gap-3" data-testid="timeline-step">
                    <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 -ml-[17px] ${isLast ? 'bg-[var(--brand-primary)]' : 'bg-gray-300'}`} />
                    <div>
                      <p className="text-xs font-medium text-gray-800">{step.status}</p>
                      <p className="text-xs text-gray-400">{formatDate(step.date)}</p>
                      {step.note && <p className="text-xs text-gray-500 mt-0.5">{step.note}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* Toast */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-6 right-6 z-[70] flex items-center gap-2 bg-gray-900 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg"
        >
          {toast.type === 'error' ? (
            <XCircle className="w-4 h-4 text-red-400" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-green-400" />
          )}
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function Field({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-gray-500 flex items-center gap-1.5 shrink-0">
        {icon}
        {label}
      </span>
      <span className="text-gray-900 font-medium text-right break-words">{value}</span>
    </div>
  );
}

/* ─── Fulfilment form ────────────────────────────────────────────────────────── */

function FulfilmentForm({
  order,
  onSaved,
  onError,
}: {
  order: GiftOrderDetail;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [draft, setDraft] = useState<FulfilmentDraft>(() => emptyFulfilmentDraft(order));
  const [saving, setSaving] = useState(false);
  const [validationErr, setValidationErr] = useState<string | null>(null);

  // Re-seed the draft when the order reloads (e.g. after a save or transition).
  useEffect(() => {
    setDraft(emptyFulfilmentDraft(order));
  }, [order.id, order.fulfilmentChannel, order.trackingNumber, order.voucherCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof FulfilmentDraft>(k: K, v: FulfilmentDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  // Changing the channel between physical and digital-voucher clears the fields that no
  // longer apply, so a stale tracking number never rides along with a new voucher code.
  const setChannel = (v: string) =>
    setDraft((d) => resetNonApplicableFields({ ...d, fulfilmentChannel: v }));

  const voucher = isVoucherChannel(draft.fulfilmentChannel);

  const save = async () => {
    const v = validateFulfilment(draft);
    if (!v.ok) {
      setValidationErr(v.error ?? 'Invalid input');
      return;
    }
    setValidationErr(null);
    setSaving(true);
    const res = await api.patch(`/api/admin/gift-orders/${order.id}/fulfilment`, buildFulfilmentPayload(draft));
    setSaving(false);
    if (res.success) {
      onSaved();
    } else {
      onError(res.error);
    }
  };

  const inputCls =
    'w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]';

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
      <p className="text-xs font-semibold text-gray-700">Fulfilment details</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-700">Fulfilment channel *</label>
          <select
            value={draft.fulfilmentChannel}
            onChange={(e) => setChannel(e.target.value)}
            data-testid="ff-channel"
            className={`${inputCls} appearance-none bg-white`}
          >
            <option value="">— Select channel —</option>
            {GIFT_FULFILMENT_CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-700">
            {voucher ? 'Voucher provider' : 'Logistics partner'}
          </label>
          {voucher ? (
            <input
              value={draft.voucherProvider}
              onChange={(e) => set('voucherProvider', e.target.value)}
              placeholder="e.g. Amazon Pay"
              data-testid="ff-voucher-provider"
              className={inputCls}
            />
          ) : (
            <input
              value={draft.logisticsPartner}
              onChange={(e) => set('logisticsPartner', e.target.value)}
              placeholder="e.g. Delhivery, Blue Dart"
              data-testid="ff-logistics"
              className={inputCls}
            />
          )}
        </div>
      </div>

      {voucher ? (
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-700 flex items-center gap-1.5">
            <Ticket className="w-3.5 h-3.5 text-amber-500" /> Voucher code
          </label>
          <input
            value={draft.voucherCode}
            onChange={(e) => set('voucherCode', e.target.value)}
            placeholder="AMZ-XXXX-XXXX"
            data-testid="ff-voucher-code"
            className={inputCls}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Tracking number</label>
            <input
              value={draft.trackingNumber}
              onChange={(e) => set('trackingNumber', e.target.value)}
              placeholder="e.g. 1234567890"
              data-testid="ff-tracking-number"
              className={inputCls}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Tracking URL</label>
            <input
              value={draft.trackingUrl}
              onChange={(e) => set('trackingUrl', e.target.value)}
              placeholder="https://…"
              data-testid="ff-tracking-url"
              className={inputCls}
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <label className="text-xs font-medium text-gray-700">Supplier order ref</label>
            <input
              value={draft.supplierOrderRef}
              onChange={(e) => set('supplierOrderRef', e.target.value)}
              placeholder="e.g. Amazon order id (403-…)"
              data-testid="ff-supplier-ref"
              className={inputCls}
            />
          </div>
        </div>
      )}

      {validationErr && (
        <div className="flex items-center gap-2 text-xs text-red-600">
          <XCircle className="w-3.5 h-3.5 shrink-0" /> {validationErr}
        </div>
      )}

      {draft.trackingUrl.trim() && (
        <a
          href={draft.trackingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-[var(--brand-primary)] hover:underline"
        >
          Open tracking link <ExternalLink className="w-3 h-3" />
        </a>
      )}

      <div className="flex items-center justify-end">
        <button
          onClick={() => void save()}
          disabled={saving}
          data-testid="ff-save"
          className="inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-[#a50d26] disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Save fulfilment
        </button>
      </div>
    </div>
  );
}

/* ─── Status transitions (with confirm gate) ─────────────────────────────────── */

function StatusActions({
  order,
  onDone,
  onError,
}: {
  order: GiftOrderDetail;
  onDone: (m: string) => void;
  onError: (m: string) => void;
}) {
  const options = nextStatusOptions(order.status);
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [acting, setActing] = useState(false);
  // Synchronous double-submit guard (matches the editor / publish / moderation flows):
  // `disabled` alone can be out-raced by a fast double-click on a wallet-touching edge
  // (Cancel / Return refunds points), so guard the handler itself.
  const inFlight = useRef(false);

  if (isTerminalStatus(order.status)) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <p className="text-xs font-semibold text-gray-700 mb-1">Status</p>
        <p className="text-xs text-gray-500">
          This order is {statusLabel(order.status).toLowerCase()} — no further transitions are available.
        </p>
      </div>
    );
  }

  const copy = pending ? confirmCopyFor(order.status, pending) : null;

  const runTransition = async () => {
    if (!pending) return;
    if (inFlight.current) return; // sync double-submit guard
    inFlight.current = true;
    setActing(true);
    const body: Record<string, unknown> = { toStatus: pending };
    if (note.trim()) body.notes = note.trim();
    const res = await api.post(`/api/admin/gift-orders/${order.id}/transition`, body);
    setActing(false);
    inFlight.current = false;
    if (res.success) {
      onDone(`Order moved to ${statusLabel(pending)}.`);
      setPending(null);
      setNote('');
    } else {
      onError(res.error);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
      <p className="text-xs font-semibold text-gray-700">Advance status</p>
      <div className="flex flex-wrap items-center gap-2">
        {options.map((to) => {
          const danger = confirmCopyFor(order.status, to).danger;
          return (
            <button
              key={to}
              onClick={() => { setPending(to); setNote(''); }}
              data-testid={`transition-${to}`}
              className={`inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-lg font-semibold border transition-colors ${
                danger
                  ? 'border-red-300 text-red-700 hover:bg-red-50'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {danger ? <ShieldAlert className="w-3.5 h-3.5" /> : <Truck className="w-3.5 h-3.5" />}
              {statusLabel(to)}
            </button>
          );
        })}
      </div>

      {/* Confirm modal — every status change confirms; wallet/value edges warn hard. */}
      <Modal
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={copy?.title ?? 'Confirm'}
        description={copy?.description}
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Note (optional)</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Reason / reference…"
              data-testid="transition-note"
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => setPending(null)}
              disabled={acting}
              className="text-xs px-4 py-2 rounded-lg border border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 disabled:opacity-50"
            >
              Keep
            </button>
            <button
              onClick={() => void runTransition()}
              disabled={acting}
              data-testid="transition-confirm"
              className={`inline-flex items-center gap-1.5 text-xs px-5 py-2 rounded-lg text-white font-semibold disabled:opacity-50 ${
                copy?.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-[var(--brand-primary)] hover:bg-[#a50d26]'
              }`}
            >
              {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              {copy?.confirmLabel ?? 'Confirm'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
