'use client';

/**
 * /vendor/catalogue — the vendor's OWN catalogue (design §2, §4 vendor-item flow).
 *
 * Lists this vendor's items with a moderation badge (Draft / Pending approval / Approved /
 * Rejected), a create/edit editor (₹ selling price + required MRP + category + images +
 * redemption/fulfilment + stock), and an Excel bulk upload. Honest about moderation: the
 * approval note explains that a material edit re-submits an approved item for review under
 * a Gifsy-approval policy. Scoped server-side to this vendor + its granted tenant.
 *
 * List:   { success, data: { items: VendorCatalogueItem[] } } (array-tolerant).
 * Detail: { success, data: VendorCatalogueDetail } (flat).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Package, Plus, Loader2, AlertTriangle, Search, Pencil, CheckCircle2, XCircle,
  Info, FileSpreadsheet, Download, Upload, ShieldAlert,
} from 'lucide-react';
import { api, authHeader } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { downloadBlob } from '@/lib/download';
import { formatINR } from '@/lib/money';
import {
  REDEMPTION_MODE_OPTIONS,
  FULFILMENT_CHANNEL_OPTIONS,
  type GiftCategory,
} from '@/lib/gift-catalogue';
import {
  type VendorCatalogueItem,
  type VendorCatalogueDetail,
  type VendorItemFormState,
  type GiftRedemptionMode,
  type GiftFulfilmentChannel,
  EMPTY_VENDOR_ITEM_FORM,
  validateVendorItemForm,
  vendorItemFormToPayload,
  vendorDetailToForm,
  willResubmitForApproval,
  reapprovalNote,
  moderationLabel,
  moderationBadgeClass,
  isBlockedError,
} from '@/lib/vendor';
import { useVendorMe } from '@/lib/vendor-context';

type Toast = { msg: string; type: 'success' | 'error' };

export default function VendorCataloguePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [items, setItems] = useState<VendorCatalogueItem[]>([]);
  const [categories, setCategories] = useState<GiftCategory[]>([]);
  const [query, setQuery] = useState('');

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, type: Toast['type'] = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const me = useVendorMe();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setBlocked(false);
    const res = await api.get<{ items: VendorCatalogueItem[] } | VendorCatalogueItem[]>(
      '/api/vendor/catalogue',
    );
    if (res.success) {
      setItems(Array.isArray(res.data) ? res.data : (res.data?.items ?? []));
    } else if (isBlockedError(res.error, res.status)) {
      setBlocked(true);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, []);

  // Categories power the editor's picker. ASSUMED endpoint (flag for BE) — mirrors the
  // admin /api/admin/gift-categories shared taxonomy. A failure is non-fatal (the list
  // still renders; the editor shows a hint).
  const loadCategories = useCallback(async () => {
    const res = await api.get<{ items: GiftCategory[] } | GiftCategory[]>('/api/vendor/categories');
    if (res.success) {
      setCategories(Array.isArray(res.data) ? res.data : (res.data?.items ?? []));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadCategories();
  }, [load, loadCategories]);

  const categoryName = useCallback(
    (id: string | null | undefined) => categories.find((c) => c.id === id)?.name ?? '—',
    [categories],
  );

  // Defence-in-depth: the BE scopes the list to this vendor, but if a slip ever returns a
  // foreign vendor's row, drop it here. Only filters when the row actually carries a
  // vendorId that mismatches — an absent id (the normal case) is never dropped.
  const myVendorId = me?.vendor?.id;
  const scoped = useMemo(
    () => items.filter((it) => myVendorId == null || it.vendorId == null || it.vendorId === myVendorId),
    [items, myVendorId],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        (it.categoryName ?? categoryName(it.categoryId)).toLowerCase().includes(q),
    );
  }, [scoped, query, categoryName]);

  function openCreate() {
    setEditingId(null);
    setEditorOpen(true);
  }
  function openEdit(id: string) {
    setEditingId(id);
    setEditorOpen(true);
  }

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Package className="w-5 h-5 text-[var(--brand-primary)]" />
            My Catalogue
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Add and price the gifts you supply. Set a ₹ selling price and MRP — members
            redeem your approved, in-stock items.
          </p>
        </div>
        <Button variant="primary" onClick={openCreate} data-testid="new-item-btn">
          <Plus className="w-4 h-4" />
          New item
        </Button>
      </div>

      {/* Approval policy note */}
      <div className="flex items-start gap-2 text-xs text-gray-600 bg-blue-50/60 border border-blue-100 rounded-lg px-3 py-2" data-testid="policy-note">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-blue-500" />
        <span>{reapprovalNote(me?.approvalPolicy)}</span>
      </div>

      {/* Excel bulk upload */}
      <BulkUpload onUploaded={() => void load()} />

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or category…"
          aria-label="Search my catalogue"
          data-testid="item-search"
          className="w-full bg-white border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
        />
      </div>

      {/* Loading */}
      {loading && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center text-gray-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
          Loading your catalogue…
        </div>
      )}

      {/* Blocked */}
      {!loading && blocked && (
        <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-12 text-center text-sm" data-testid="catalogue-blocked">
          <ShieldAlert className="w-5 h-5 text-red-500 mx-auto mb-2" />
          <p className="text-red-700 font-medium">Your access has been removed or suspended.</p>
          <p className="text-red-600/80 text-xs mt-1">You can no longer manage this catalogue. Contact your Gifsy account manager.</p>
          {/* A transient 403 shouldn't be a dead end for an active vendor — offer a retry. */}
          <button
            onClick={() => void load()}
            data-testid="catalogue-blocked-retry"
            className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-white"
          >
            Retry
          </button>
        </div>
      )}

      {/* Error */}
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

      {/* Empty */}
      {!loading && !blocked && !error && visible.length === 0 && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center">
          <div className="p-4 bg-gray-100 rounded-full inline-flex text-gray-400 mb-3">
            <Package className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-gray-900">
            {items.length === 0 ? 'No items yet' : 'No matches'}
          </h3>
          <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
            {items.length === 0
              ? 'Add your first gift item, or bulk-upload a filled sheet. New items go for approval before members can redeem them.'
              : 'Try a different search.'}
          </p>
          {items.length === 0 && (
            <Button variant="primary" onClick={openCreate} className="mt-4">
              <Plus className="w-4 h-4" />
              New item
            </Button>
          )}
        </div>
      )}

      {/* Table */}
      {!loading && !blocked && !error && visible.length > 0 && (
        <div className="border border-gray-200 bg-white rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Your catalogue items, with selling price, MRP, stock and moderation status.</caption>
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left">
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Item</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Category</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Selling price</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">MRP</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Stock</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs">Moderation</th>
                  <th scope="col" className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visible.map((it) => (
                  <tr key={it.id} className="hover:bg-gray-50 transition-colors" data-testid="item-row">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-gray-900">{it.name}</div>
                      {it.moderationStatus === 'REJECTED' && it.moderationReason && (
                        <div className="text-[11px] text-red-600 mt-0.5">Reason: {it.moderationReason}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {it.categoryName ?? categoryName(it.categoryId)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-900">
                      <div>{formatINR(it.sellingValuePaise)}</div>
                      {it.pointsCost != null && (
                        <div className="text-[11px] text-gray-400">= {it.pointsCost.toLocaleString('en-IN')} pts</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-500">
                      {it.mrpPaise != null ? formatINR(it.mrpPaise) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {it.stockQuantity == null ? 'Unlimited' : it.stockQuantity.toLocaleString('en-IN')}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium border ${moderationBadgeClass(it.moderationStatus)}`}
                        data-testid={`moderation-${it.id}`}
                      >
                        {moderationLabel(it.moderationStatus)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end">
                        <button
                          onClick={() => openEdit(it.id)}
                          title="Edit"
                          aria-label={`Edit ${it.name}`}
                          data-testid={`edit-${it.id}`}
                          className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                        >
                          <Pencil className="w-4 h-4" />
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

      {/* Editor modal */}
      {editorOpen && (
        <VendorItemEditor
          itemId={editingId}
          categories={categories}
          onClose={() => setEditorOpen(false)}
          onSaved={(msg) => {
            setEditorOpen(false);
            showToast(msg);
            void load();
          }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-6 right-6 z-[80] flex items-center gap-2 bg-gray-900 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg"
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

/* ─── Editor modal ───────────────────────────────────────────────────────────── */

const FIELD_CLS =
  'w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]';

export function VendorItemEditor({
  itemId,
  categories,
  onClose,
  onSaved,
}: {
  itemId: string | null;
  categories: GiftCategory[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const isEdit = itemId != null;
  const me = useVendorMe();
  const [form, setForm] = useState<VendorItemFormState>(EMPTY_VENDOR_ITEM_FORM);
  const [original, setOriginal] = useState<VendorCatalogueDetail | null>(null);
  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const inFlight = useRef(false);

  const loadDetail = useCallback(async () => {
    if (!itemId) return;
    setLoading(true);
    setLoadError(null);
    const res = await api.get<VendorCatalogueDetail>(`/api/vendor/catalogue/${itemId}`);
    if (res.success) {
      setOriginal(res.data);
      setForm(vendorDetailToForm(res.data));
    } else {
      setLoadError(res.error);
    }
    setLoading(false);
  }, [itemId]);

  useEffect(() => {
    if (isEdit) void loadDetail();
  }, [isEdit, loadDetail]);

  const set = <K extends keyof VendorItemFormState>(key: K, value: VendorItemFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    if (touched) setErrors(validateVendorItemForm(form));
  }, [form, touched]);

  // Warn that saving will re-submit an already-approved item for review (material edit
  // under a non-AUTO policy).
  const willResubmit = willResubmitForApproval(original, form, me?.approvalPolicy);

  async function handleSave() {
    const errs = validateVendorItemForm(form);
    setTouched(true);
    setErrors(errs);
    if (errs.length > 0) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setSaveError(null);

    const payload = vendorItemFormToPayload(form);
    const res = isEdit
      ? await api.patch<unknown>(`/api/vendor/catalogue/${itemId}`, payload)
      : await api.post<unknown>('/api/vendor/catalogue', payload);
    setSaving(false);
    inFlight.current = false;
    if (res.success) {
      onSaved(
        isEdit
          ? (willResubmit ? 'Item updated — re-submitted for approval.' : 'Item updated.')
          : 'Item created — submitted for approval.',
      );
    } else {
      setSaveError(res.error);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={isEdit ? 'Edit item' : 'New item'}
      description="Set the details, ₹ selling price and MRP for this gift."
      className="max-w-2xl"
    >
      {loading ? (
        <div className="py-16 text-center text-gray-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
          Loading…
        </div>
      ) : loadError ? (
        <div className="py-12 text-center text-sm">
          <p className="text-red-600">{loadError}</p>
          <button onClick={() => void loadDetail()} className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50">
            Retry
          </button>
        </div>
      ) : (
        <>
          {/* Re-approval warning (edit of an approved item, material change, non-AUTO policy) */}
          {willResubmit && (
            <div className="mb-4 flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2" data-testid="reapproval-warning">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                This is a material change to an approved item. Saving will re-submit it for
                Gifsy approval, and it will be hidden from members until approved again.
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <Field label="Name" required>
                <input
                  type="text" value={form.name} data-testid="field-name"
                  onChange={(e) => set('name', e.target.value)} className={FIELD_CLS}
                  placeholder="e.g. JBL Go 3 Speaker"
                />
              </Field>
            </div>

            <Field label="Category" required>
              <select
                value={form.categoryId} data-testid="field-category"
                onChange={(e) => set('categoryId', e.target.value)} className={FIELD_CLS}
              >
                <option value="">Select a category…</option>
                {categories
                  .filter((c) => c.isActive || c.id === form.categoryId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
              </select>
              {categories.length === 0 && (
                <p className="text-[11px] text-amber-600 mt-1">
                  No categories available yet — please contact Gifsy if you can&rsquo;t pick one.
                </p>
              )}
            </Field>

            <Field label="Stock quantity" hint="Blank = unlimited stock.">
              <input
                type="text" inputMode="numeric" value={form.stockQuantity} data-testid="field-stock"
                onChange={(e) => set('stockQuantity', e.target.value)} className={FIELD_CLS}
                placeholder="Unlimited"
              />
            </Field>

            <Field label="Selling price (₹)" required hint="What the gift is worth — this becomes the order value.">
              <input
                type="text" inputMode="decimal" value={form.sellingRupees} data-testid="field-selling"
                onChange={(e) => set('sellingRupees', e.target.value)} className={FIELD_CLS}
                placeholder="e.g. 1999"
              />
            </Field>

            <Field label="MRP (₹)" required hint="The maximum retail price. Selling price cannot exceed it.">
              <input
                type="text" inputMode="decimal" value={form.mrpRupees} data-testid="field-mrp"
                onChange={(e) => set('mrpRupees', e.target.value)} className={FIELD_CLS}
                placeholder="e.g. 2499"
              />
            </Field>

            <Field label="Redemption mode" required>
              <select
                value={form.redemptionMode} data-testid="field-redemption-mode"
                onChange={(e) => set('redemptionMode', e.target.value as GiftRedemptionMode)}
                className={FIELD_CLS}
              >
                {REDEMPTION_MODE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>

            <Field label="Fulfilment channel" required>
              <select
                value={form.fulfilmentChannel} data-testid="field-fulfilment"
                onChange={(e) => set('fulfilmentChannel', e.target.value as GiftFulfilmentChannel)}
                className={FIELD_CLS}
              >
                {FULFILMENT_CHANNEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>

            <div className="sm:col-span-2">
              <Field label="Description">
                <textarea
                  value={form.description} data-testid="field-description" rows={2}
                  onChange={(e) => set('description', e.target.value)} className={FIELD_CLS}
                  placeholder="Short member-facing description."
                />
              </Field>
            </div>

            <div className="sm:col-span-2">
              <Field label="Image URLs" hint="One per line (or comma-separated). Must be valid http(s) URLs.">
                <textarea
                  value={form.imageUrls} data-testid="field-images" rows={2}
                  onChange={(e) => set('imageUrls', e.target.value)} className={FIELD_CLS}
                  placeholder="https://cdn.example.com/gift-1.jpg"
                />
              </Field>
            </div>

            {/* Validation errors */}
            {errors.length > 0 && (
              <div className="sm:col-span-2 border border-red-200 bg-red-50 rounded-lg px-3 py-2 space-y-1" data-testid="item-errors">
                {errors.map((e, i) => (
                  <p key={i} className="flex items-start gap-1.5 text-[11px] text-red-600">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{e}
                  </p>
                ))}
              </div>
            )}
            {saveError && (
              <p className="sm:col-span-2 flex items-start gap-1.5 text-xs text-red-600" role="alert">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{saveError}
              </p>
            )}
          </div>

          {/* Footer */}
          <div className="mt-5 -mx-6 px-6 pt-4 border-t border-gray-100 flex items-center justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 text-xs font-semibold text-gray-600 rounded-lg hover:bg-gray-100">
              Cancel
            </button>
            <Button variant="primary" onClick={() => { void handleSave(); }} loading={saving} data-testid="save-item-btn">
              {isEdit ? 'Save changes' : 'Create item'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

function Field({
  label, required, hint, children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1.5">
        {label}{required && <span className="text-[var(--brand-primary)]"> *</span>}
      </label>
      {children}
      {hint && <p className="text-[11px] text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

/* ─── Excel bulk upload (mirrors the admin bulk-fulfilment UX) ─────────────────── */

interface CatalogueUploadResult {
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  errors: { row: number; name?: string; message: string }[];
}

function BulkUpload({ onUploaded }: { onUploaded: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<CatalogueUploadResult | null>(null);

  // ASSUMED endpoint (flag for BE) — a downloadable template for the vendor upload,
  // mirroring the admin fulfilment sheet. If the BE has none, this surfaces its error.
  async function downloadTemplate() {
    setDownloading(true);
    setErr('');
    try {
      const res = await fetch('/api/vendor/catalogue/template', { headers: authHeader() });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: string };
          msg = j.error ?? msg;
        } catch { /* non-JSON error body */ }
        setErr(msg);
        return;
      }
      const blob = await res.blob();
      downloadBlob(blob, `vendor_catalogue_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  async function uploadSheet(file: File) {
    setUploading(true);
    setErr('');
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      // Do NOT set Content-Type — the browser sets the multipart boundary.
      const res = await fetch('/api/vendor/catalogue/upload', {
        method: 'POST',
        headers: authHeader(),
        body: fd,
      });
      const json = (await res.json()) as {
        success?: boolean;
        data?: CatalogueUploadResult;
        error?: string;
      };
      if (!res.ok || json.success === false) {
        setErr(json.error ?? `Upload failed (HTTP ${res.status})`);
        return;
      }
      setResult(json.data ?? null);
      onUploaded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void uploadSheet(file);
    e.target.value = '';
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 px-5 py-4 space-y-3">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-xl bg-green-50">
          <FileSpreadsheet className="w-4 h-4 text-green-600" />
        </div>
        <div>
          <p className="text-sm font-semibold text-gray-900">Bulk upload</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Download the template, fill in your items (name, category, ₹ price, MRP, stock),
            then upload it. Uploaded items go for approval like any other.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void downloadTemplate()}
          disabled={downloading}
          data-testid="bulk-download"
          className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-xs font-semibold rounded-lg hover:opacity-90 disabled:opacity-40"
        >
          {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          Download template
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          data-testid="bulk-upload"
          className="inline-flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-700 text-xs font-semibold rounded-lg hover:bg-gray-50 disabled:opacity-40"
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4 text-gray-400" />}
          Upload filled sheet
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={onFileChange}
          className="hidden"
          data-testid="bulk-file-input"
        />
      </div>

      {err && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{err}</span>
        </div>
      )}

      {result && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Processed', value: result.processed, color: 'bg-gray-50 border-gray-200 text-gray-800' },
              { label: 'Succeeded', value: result.succeeded, color: 'bg-green-50 border-green-200 text-green-700' },
              { label: 'Skipped', value: result.skipped, color: 'bg-amber-50 border-amber-200 text-amber-700' },
              {
                label: 'Failed',
                value: result.failed,
                color: result.failed > 0 ? 'bg-red-50 border-red-200 text-red-700' : 'bg-gray-50 border-gray-200 text-gray-800',
              },
            ].map((s) => (
              <div key={s.label} className={`rounded-lg border px-4 py-3 text-center ${s.color}`}>
                <p className="text-2xl font-bold">{s.value}</p>
                <p className="text-xs font-medium mt-0.5 opacity-70">{s.label}</p>
              </div>
            ))}
          </div>
          {result.errors.length > 0 ? (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 space-y-1 max-h-44 overflow-y-auto" data-testid="bulk-errors">
              <p className="text-xs font-semibold text-amber-700 mb-2">Row errors</p>
              {result.errors.map((er, i) => (
                <p key={i} className="text-xs text-amber-700">
                  <span className="font-mono font-semibold">
                    Row {er.row}{er.name ? ` — ${er.name}` : ''}:{' '}
                  </span>
                  {er.message}
                </p>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle2 className="w-4 h-4" /> All rows processed without errors.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
