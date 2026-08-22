'use client';

/**
 * /admin/gift-catalogue — Gift Master list + create/edit editor (Gifsy-operator only).
 *
 * The platform-source master items authored once and published to tenants. CRUD over
 * GET/POST/PUT/DELETE /api/admin/gift-masters (+ the publish dialog per row).
 *
 * List envelope: { success, data: { items: GiftMasterSummary[] } } (list → { items }).
 * Detail:        { success, data: GiftMasterDetail } (detail → flat).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Gift, Plus, Loader2, AlertTriangle, Search, Pencil, Send, Archive,
  ArchiveRestore, CheckCircle2, XCircle,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { formatINR } from '@/lib/money';
import {
  type GiftMasterSummary,
  type GiftMasterDetail,
  type GiftMasterFormState,
  type GiftCategory,
  type GiftRedemptionMode,
  type GiftFulfilmentChannel,
  type GiftMasterStatus,
  EMPTY_MASTER_FORM,
  REDEMPTION_MODE_OPTIONS,
  FULFILMENT_CHANNEL_OPTIONS,
  validateGiftMasterForm,
  giftMasterFormToPayload,
  giftMasterDetailToForm,
} from '@/lib/gift-catalogue';
import { PublishDialog } from './publish-dialog';

const STATUS_BADGE: Record<GiftMasterStatus, string> = {
  ACTIVE: 'bg-green-50 text-green-700 border-green-100',
  ARCHIVED: 'bg-gray-50 text-gray-500 border-gray-200',
};

type Toast = { msg: string; type: 'success' | 'error' };

export default function GiftMasterListPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<GiftMasterSummary[]>([]);
  const [categories, setCategories] = useState<GiftCategory[]>([]);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [publishFor, setPublishFor] = useState<GiftMasterSummary | null>(null);

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
    const res = await api.get<{ items: GiftMasterSummary[] } | GiftMasterSummary[]>(
      '/api/admin/gift-masters',
    );
    if (res.success) {
      setItems(Array.isArray(res.data) ? res.data : (res.data?.items ?? []));
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, []);

  // Categories power the editor's category picker; a failure there is non-fatal (the
  // list still renders) — the editor just shows an empty picker + a hint.
  const loadCategories = useCallback(async () => {
    const res = await api.get<{ items: GiftCategory[] } | GiftCategory[]>('/api/admin/gift-categories');
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

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (!showArchived && it.status === 'ARCHIVED') return false;
      if (!q) return true;
      return (
        it.name.toLowerCase().includes(q) ||
        it.code.toLowerCase().includes(q) ||
        (it.categoryName ?? categoryName(it.categoryId)).toLowerCase().includes(q)
      );
    });
  }, [items, query, showArchived, categoryName]);

  function openCreate() {
    setEditingId(null);
    setEditorOpen(true);
  }
  function openEdit(id: string) {
    setEditingId(id);
    setEditorOpen(true);
  }

  async function handleArchiveToggle(it: GiftMasterSummary) {
    const archiving = it.status !== 'ARCHIVED';
    const verb = archiving ? 'Archive' : 'Restore';
    if (archiving && !window.confirm(
      `Archive "${it.name}"? It will be hidden from all tenants' catalogues. In-flight orders continue.`,
    )) return;

    const res = archiving
      ? await api.del<unknown>(`/api/admin/gift-masters/${it.id}`)
      : await api.put<unknown>(`/api/admin/gift-masters/${it.id}`, { status: 'ACTIVE' });
    if (res.success) {
      showToast(`${verb}d "${it.name}".`);
      void load();
    } else {
      showToast(res.error, 'error');
    }
  }

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Gift className="w-5 h-5 text-[var(--brand-primary)]" />
            Gift Masters
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Author platform gift items once, then publish + price them per tenant. Managed by
            Gifsy on behalf of every brand.
          </p>
        </div>
        <Button variant="primary" onClick={openCreate} data-testid="new-master-btn">
          <Plus className="w-4 h-4" />
          New gift master
        </Button>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, code, or category…"
            aria-label="Search gift masters"
            data-testid="master-search"
            className="w-full bg-white border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
          />
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            data-testid="show-archived"
            className="w-4 h-4 accent-[var(--brand-primary)]"
          />
          Show archived
        </label>
      </div>

      {/* Loading */}
      {loading && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center text-gray-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
          Loading gift masters…
        </div>
      )}

      {/* Error */}
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

      {/* Empty */}
      {!loading && !error && visible.length === 0 && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center">
          <div className="p-4 bg-gray-100 rounded-full inline-flex text-gray-400 mb-3">
            <Gift className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-gray-900">
            {items.length === 0 ? 'No gift masters yet' : 'No matches'}
          </h3>
          <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
            {items.length === 0
              ? 'Create your first platform gift master, then publish it to one or more tenants.'
              : 'Try a different search, or toggle “Show archived”.'}
          </p>
          {items.length === 0 && (
            <Button variant="primary" onClick={openCreate} className="mt-4">
              <Plus className="w-4 h-4" />
              New gift master
            </Button>
          )}
        </div>
      )}

      {/* Table */}
      {!loading && !error && visible.length > 0 && (
        <div className="border border-gray-200 bg-white rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left">
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Gift</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Category</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">MRP</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Fulfilment</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Stock</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Published</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Status</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visible.map((it) => (
                  <tr key={it.id} className="hover:bg-gray-50 transition-colors" data-testid={`master-row-${it.id}`}>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-gray-900">{it.name}</div>
                      <div className="text-[11px] font-mono text-gray-400">{it.code}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {it.categoryName ?? categoryName(it.categoryId)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {formatINR(it.mrpPaise)}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {FULFILMENT_CHANNEL_OPTIONS.find((f) => f.value === it.fulfilmentChannel)?.label
                        ?? it.fulfilmentChannel}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {it.stockQuantity == null ? 'Unlimited' : it.stockQuantity.toLocaleString('en-IN')}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {it.publishedTenantCount != null
                        ? `${it.publishedTenantCount} tenant${it.publishedTenantCount !== 1 ? 's' : ''}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium border ${STATUS_BADGE[it.status]}`}>
                        {it.status === 'ACTIVE' ? 'Active' : 'Archived'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(it.id)}
                          title="Edit"
                          aria-label={`Edit ${it.name}`}
                          data-testid={`edit-${it.id}`}
                          className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setPublishFor(it)}
                          disabled={it.status === 'ARCHIVED'}
                          title={it.status === 'ARCHIVED' ? 'Restore before publishing' : 'Publish & price'}
                          aria-label={`Publish ${it.name}`}
                          data-testid={`publish-${it.id}`}
                          className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-[var(--brand-primary)] disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Send className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => void handleArchiveToggle(it)}
                          title={it.status === 'ARCHIVED' ? 'Restore' : 'Archive'}
                          aria-label={`${it.status === 'ARCHIVED' ? 'Restore' : 'Archive'} ${it.name}`}
                          data-testid={`archive-${it.id}`}
                          className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                        >
                          {it.status === 'ARCHIVED'
                            ? <ArchiveRestore className="w-4 h-4" />
                            : <Archive className="w-4 h-4" />}
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
        <MasterEditor
          masterId={editingId}
          categories={categories}
          onClose={() => setEditorOpen(false)}
          onSaved={(msg) => {
            setEditorOpen(false);
            showToast(msg);
            void load();
          }}
        />
      )}

      {/* Publish dialog */}
      {publishFor && (
        <PublishDialog
          master={publishFor}
          onClose={() => setPublishFor(null)}
          onPublished={() => {
            setPublishFor(null);
            showToast('Publish settings saved.');
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

// ── Editor modal ───────────────────────────────────────────────────────────────

const FIELD_CLS =
  'w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]';

export function MasterEditor({
  masterId,
  categories,
  onClose,
  onSaved,
}: {
  masterId: string | null;
  categories: GiftCategory[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const isEdit = masterId != null;
  const [form, setForm] = useState<GiftMasterFormState>(EMPTY_MASTER_FORM);
  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const inFlight = useRef(false);

  const loadDetail = useCallback(async () => {
    if (!masterId) return;
    setLoading(true);
    setLoadError(null);
    const res = await api.get<GiftMasterDetail>(`/api/admin/gift-masters/${masterId}`);
    if (res.success) {
      setForm(giftMasterDetailToForm(res.data));
    } else {
      setLoadError(res.error);
    }
    setLoading(false);
  }, [masterId]);

  useEffect(() => {
    if (isEdit) void loadDetail();
  }, [isEdit, loadDetail]);

  const set = <K extends keyof GiftMasterFormState>(key: K, value: GiftMasterFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // Live-validate once the user has attempted a save (so we don't shout on first open).
  useEffect(() => {
    if (touched) setErrors(validateGiftMasterForm(form));
  }, [form, touched]);

  async function handleSave() {
    const errs = validateGiftMasterForm(form);
    setTouched(true);
    setErrors(errs);
    if (errs.length > 0) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setSaveError(null);

    const payload = giftMasterFormToPayload(form);
    const res = isEdit
      ? await api.put<unknown>(`/api/admin/gift-masters/${masterId}`, payload)
      : await api.post<unknown>('/api/admin/gift-masters', payload);
    setSaving(false);
    inFlight.current = false;
    if (res.success) {
      onSaved(isEdit ? 'Gift master updated.' : 'Gift master created.');
    } else {
      setSaveError(res.error);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={isEdit ? 'Edit gift master' : 'New gift master'}
      description="Author a platform gift item, then publish and price it per tenant."
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Name" required>
                <input
                  type="text" value={form.name} data-testid="field-name"
                  onChange={(e) => set('name', e.target.value)} className={FIELD_CLS}
                  placeholder="e.g. JBL Go 3 Speaker"
                />
              </Field>
              <Field label="Code" required hint="A platform-unique SKU for this master.">
                <input
                  type="text" value={form.code} data-testid="field-code"
                  onChange={(e) => set('code', e.target.value)} className={FIELD_CLS}
                  placeholder="e.g. GM-JBL-GO3"
                />
              </Field>

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
                    No categories yet — create one under the Categories tab first.
                  </p>
                )}
              </Field>

              <Field label="MRP (₹)" required>
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

              <Field label="Default fulfilment channel" required>
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

              <Field label="Stock quantity" hint="Blank = unlimited stock.">
                <input
                  type="text" inputMode="numeric" value={form.stockQuantity} data-testid="field-stock"
                  onChange={(e) => set('stockQuantity', e.target.value)} className={FIELD_CLS}
                  placeholder="Unlimited"
                />
              </Field>

              <Field label="Status">
                <select
                  value={form.status} data-testid="field-status"
                  onChange={(e) => set('status', e.target.value as GiftMasterStatus)}
                  className={FIELD_CLS}
                >
                  <option value="ACTIVE">Active</option>
                  <option value="ARCHIVED">Archived</option>
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

              <div className="sm:col-span-2">
                <Field label="Terms &amp; conditions">
                  <textarea
                    value={form.termsAndConditions} data-testid="field-tnc" rows={2}
                    onChange={(e) => set('termsAndConditions', e.target.value)} className={FIELD_CLS}
                    placeholder="Redemption terms, validity, warranty…"
                  />
                </Field>
              </div>

              {/* Validation errors */}
              {errors.length > 0 && (
                <div className="sm:col-span-2 border border-red-200 bg-red-50 rounded-lg px-3 py-2 space-y-1" data-testid="master-errors">
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
              <Button variant="primary" onClick={() => { void handleSave(); }} loading={saving} data-testid="save-master-btn">
                {isEdit ? 'Save changes' : 'Create gift master'}
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
