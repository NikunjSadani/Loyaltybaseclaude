'use client';

/**
 * /vendor/orders/[id] — vendor order detail + fulfilment (design §2, §5, §12).
 *
 * The vendor sees its own order: the item, the delivery name/address/phone it needs to
 * ship (§1.15 — the vendor gets the FULL shipping PII; scope-minimised to this order
 * only), a fulfilment form (channel + logistics partner + tracking / supplier ref /
 * voucher code) and RESTRICTED status advance — PROCESSING / DISPATCHED / DELIVERED
 * ONLY. Cancel / Return / Refund are Gifsy-only and are NEVER rendered here. Value and
 * points are READ-ONLY.
 *
 * Data: GET   /api/vendor/orders/:id             (flat detail, incl. delivery PII)
 *       PATCH /api/vendor/orders/:id/fulfilment  (channel / partner / tracking / voucher)
 *       POST  /api/vendor/orders/:id/transition  (PROCESSING/DISPATCHED/DELIVERED only)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Loader2, AlertTriangle, Truck, Package, User, MapPin, Phone,
  Save, CheckCircle2, XCircle, ExternalLink, Ticket, ShieldAlert, Lock,
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
  isVoucherChannel,
  buildTimeline,
  statusLabel,
  statusBadgeClass,
  channelLabel,
  GIFT_FULFILMENT_CHANNELS,
} from '@/lib/gift-orders';
import {
  vendorNextStatusOptions,
  isVendorTerminal,
  vendorConfirmCopy,
  isBlockedError,
} from '@/lib/vendor';

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function VendorOrderDetailPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const [order, setOrder] = useState<GiftOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

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
    setBlocked(false);
    const res = await api.get<GiftOrderDetail>(`/api/vendor/orders/${id}`);
    if (res.success) {
      setOrder(res.data);
    } else if (isBlockedError(res.error)) {
      setBlocked(true);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const voucher = isVoucherChannel(order?.fulfilmentChannel);
  const hasDelivery = !!(order?.delivery?.name || order?.delivery?.address || order?.delivery?.phone);

  return (
    <div className="space-y-5 fade-in max-w-3xl">
      <Link
        href="/vendor/orders"
        className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        All my orders
      </Link>

      {loading && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center text-gray-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
          Loading order…
        </div>
      )}

      {!loading && blocked && (
        <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-12 text-center text-sm" data-testid="order-blocked">
          <ShieldAlert className="w-5 h-5 text-red-500 mx-auto mb-2" />
          <p className="text-red-700 font-medium">You can&rsquo;t access this order.</p>
          <p className="text-red-600/80 text-xs mt-1">It may not be yours, or your access has been suspended.</p>
        </div>
      )}

      {!loading && !blocked && error && (
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

      {!loading && !blocked && !error && order && (
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

          {/* Summary + delivery */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-2.5">
              <p className="text-xs font-semibold text-gray-700">Order</p>
              <Field icon={<Package className="w-3.5 h-3.5" />} label="Item" value={order.rewardName ?? '—'} />
              <Field label="Channel" value={channelLabel(order.fulfilmentChannel)} />
              {/* Order value / points cost (the 194R basis) are intentionally NOT shown to the
                  vendor (design §1.15) — the backend never sends them. */}
            </div>

            {/* Delivery PII — the vendor needs name/address/phone to ship (§1.15). Digital
                vouchers have no shipping; PII may be withheld after the retention window (§16). */}
            <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-2.5">
              <p className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-[var(--brand-primary)]" />
                Delivery details
              </p>
              {voucher ? (
                <p className="text-xs text-gray-500">
                  This is a digital voucher — no shipping address. Add the voucher code below.
                </p>
              ) : hasDelivery ? (
                <div className="space-y-1.5">
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
              ) : (
                <p className="text-xs text-gray-400 flex items-start gap-1.5">
                  <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  Delivery details aren&rsquo;t available for this order (either not yet shared, or
                  the retention window has passed). Contact Gifsy if you still need to ship it.
                </p>
              )}
            </div>
          </div>

          {/* Fulfilment form */}
          <FulfilmentForm
            order={order}
            onSaved={() => { showToast('Fulfilment details saved.'); void load(); }}
            onError={(m) => showToast(m, 'error')}
          />

          {/* Status advance (dispatch / deliver only) */}
          <StatusActions
            order={order}
            onDone={(m) => { showToast(m); void load(); }}
            onError={(m) => showToast(m, 'error')}
          />

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
          {toast.type === 'error'
            ? <XCircle className="w-4 h-4 text-red-400" />
            : <CheckCircle2 className="w-4 h-4 text-green-400" />}
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

/* ─── Fulfilment form (channel → tracking OR voucher-code) ────────────────────── */

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

  useEffect(() => {
    setDraft(emptyFulfilmentDraft(order));
  }, [order.id, order.fulfilmentChannel, order.trackingNumber, order.voucherCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof FulfilmentDraft>(k: K, v: FulfilmentDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

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
    const res = await api.patch(`/api/vendor/orders/${order.id}/fulfilment`, buildFulfilmentPayload(draft));
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

/* ─── Status advance (PROCESSING / DISPATCHED / DELIVERED only) ───────────────── */

function StatusActions({
  order,
  onDone,
  onError,
}: {
  order: GiftOrderDetail;
  onDone: (m: string) => void;
  onError: (m: string) => void;
}) {
  // The vendor edge-map only ever yields PROCESSING / DISPATCHED / DELIVERED — cancel,
  // return, refund and reversal are Gifsy-only and are structurally impossible to render.
  const options = vendorNextStatusOptions(order.status);
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [acting, setActing] = useState(false);
  const inFlight = useRef(false);

  if (isVendorTerminal(order.status)) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <p className="text-xs font-semibold text-gray-700 mb-1">Status</p>
        <p className="text-xs text-gray-500">
          This order is {statusLabel(order.status).toLowerCase()} — there&rsquo;s nothing more
          for you to do. If something is wrong (e.g. a return), contact Gifsy — only Gifsy can
          cancel or reverse an order.
        </p>
      </div>
    );
  }

  const copy = pending ? vendorConfirmCopy(pending) : null;

  const runTransition = async () => {
    if (!pending) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setActing(true);
    const body: Record<string, unknown> = { toStatus: pending };
    if (note.trim()) body.notes = note.trim();
    const res = await api.post(`/api/vendor/orders/${order.id}/transition`, body);
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
        {options.map((to) => (
          <button
            key={to}
            onClick={() => { setPending(to); setNote(''); }}
            data-testid={`transition-${to}`}
            className="inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-lg font-semibold border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <Truck className="w-3.5 h-3.5" />
            {statusLabel(to)}
          </button>
        ))}
      </div>

      {/* Confirm modal — every status change confirms (honest: Queued ≠ Dispatched). */}
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
              placeholder="Reference / remark…"
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
              className="inline-flex items-center gap-1.5 text-xs px-5 py-2 rounded-lg text-white font-semibold bg-[var(--brand-primary)] hover:bg-[#a50d26] disabled:opacity-50"
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
