'use client';

/**
 * /admin/gift-catalogue/categories — the platform GiftCategory taxonomy (Gifsy-only).
 *
 * One shared tree Gifsy curates (§1 decision 3). CRUD over
 * GET/POST/PUT/DELETE /api/admin/gift-categories.
 * List envelope: { success, data: { items: GiftCategory[] } } (flat list; tree built here).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FolderTree, Plus, Loader2, AlertTriangle, Pencil, Trash2,
  CheckCircle2, XCircle, ChevronRight,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import {
  type GiftCategory,
  type GiftCategoryFormState,
  type GiftMasterSummary,
  EMPTY_CATEGORY_FORM,
  validateCategoryForm,
  categoryFormToPayload,
  buildCategoryTree,
  flattenCategoryTree,
  wouldCreateCycle,
} from '@/lib/gift-catalogue';

type Toast = { msg: string; type: 'success' | 'error' };

const FIELD_CLS =
  'w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]';

export default function GiftCategoriesPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<GiftCategory[]>([]);
  // Gift masters filed under each category — so a delete can warn when the category is
  // still in use (not just when it has sub-categories). Non-fatal if it fails to load.
  const [masters, setMasters] = useState<GiftMasterSummary[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<GiftCategory | null>(null);

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
    const res = await api.get<{ items: GiftCategory[] } | GiftCategory[]>('/api/admin/gift-categories');
    if (res.success) {
      setList(Array.isArray(res.data) ? res.data : (res.data?.items ?? []));
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, []);

  // Non-fatal companion load: a failure here just means the delete falls back to the
  // backend's own referential guard (surfaced as an error toast) rather than a proactive warn.
  const loadMasters = useCallback(async () => {
    const res = await api.get<{ items: GiftMasterSummary[] } | GiftMasterSummary[]>(
      '/api/admin/gift-masters',
    );
    if (res.success) {
      setMasters(Array.isArray(res.data) ? res.data : (res.data?.items ?? []));
    }
  }, []);

  useEffect(() => { void load(); void loadMasters(); }, [load, loadMasters]);

  const rows = useMemo(() => flattenCategoryTree(buildCategoryTree(list)), [list]);
  const childCountOf = useCallback(
    (id: string) => list.filter((c) => c.parentId === id).length,
    [list],
  );
  const masterCountOf = useCallback(
    (id: string) => masters.filter((m) => m.categoryId === id).length,
    [masters],
  );

  function openCreate() { setEditing(null); setEditorOpen(true); }
  function openEdit(c: GiftCategory) { setEditing(c); setEditorOpen(true); }

  async function handleDelete(c: GiftCategory) {
    const kids = childCountOf(c.id);
    if (kids > 0) {
      showToast(`"${c.name}" has ${kids} sub-categor${kids !== 1 ? 'ies' : 'y'} — move or delete them first.`, 'error');
      return;
    }
    const refs = masterCountOf(c.id);
    if (refs > 0) {
      showToast(`"${c.name}" is used by ${refs} gift master${refs !== 1 ? 's' : ''} — re-file them under another category first.`, 'error');
      return;
    }
    if (!window.confirm(`Delete category "${c.name}"? This cannot be undone.`)) return;
    const res = await api.del<unknown>(`/api/admin/gift-categories/${c.id}`);
    if (res.success) {
      showToast(`Deleted "${c.name}".`);
      void load();
    } else {
      showToast(res.error, 'error');
    }
  }

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <FolderTree className="w-5 h-5 text-[var(--brand-primary)]" />
            Category taxonomy
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            One shared category tree for the whole platform. Tenants may hide or reorder, but
            never fork it.
          </p>
        </div>
        <Button variant="primary" onClick={openCreate} data-testid="new-category-btn">
          <Plus className="w-4 h-4" />
          New category
        </Button>
      </div>

      {loading && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center text-gray-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
          Loading categories…
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

      {!loading && !error && rows.length === 0 && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center">
          <div className="p-4 bg-gray-100 rounded-full inline-flex text-gray-400 mb-3">
            <FolderTree className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-gray-900">No categories yet</h3>
          <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
            Create the first category — gift masters are filed under this taxonomy.
          </p>
          <Button variant="primary" onClick={openCreate} className="mt-4">
            <Plus className="w-4 h-4" />
            New category
          </Button>
        </div>
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="border border-gray-200 bg-white rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left">
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Category</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Code</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Sort</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs">Active</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 text-xs text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((n) => (
                  <tr key={n.id} className="hover:bg-gray-50 transition-colors" data-testid={`category-row-${n.id}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1" style={{ paddingLeft: `${n.depth * 20}px` }}>
                        {n.depth > 0 && <ChevronRight className="w-3.5 h-3.5 text-gray-300 shrink-0" />}
                        <span className="font-semibold text-gray-900">{n.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-gray-500">{n.code}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-600">{n.sortOrder}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                        n.isActive ? 'bg-green-50 text-green-700 border-green-100' : 'bg-gray-50 text-gray-500 border-gray-200'
                      }`}>
                        {n.isActive ? 'Active' : 'Hidden'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(n)}
                          title="Edit" aria-label={`Edit ${n.name}`} data-testid={`edit-cat-${n.id}`}
                          className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => void handleDelete(n)}
                          title="Delete" aria-label={`Delete ${n.name}`} data-testid={`delete-cat-${n.id}`}
                          className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-red-600"
                        >
                          <Trash2 className="w-4 h-4" />
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

      {editorOpen && (
        <CategoryEditor
          editing={editing}
          allCategories={list}
          onClose={() => setEditorOpen(false)}
          onSaved={(msg) => {
            setEditorOpen(false);
            showToast(msg);
            void load();
          }}
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

// ── Editor ─────────────────────────────────────────────────────────────────────

export function CategoryEditor({
  editing,
  allCategories,
  onClose,
  onSaved,
}: {
  editing: GiftCategory | null;
  allCategories: GiftCategory[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const isEdit = editing != null;
  const [form, setForm] = useState<GiftCategoryFormState>(
    editing
      ? {
          code: editing.code,
          name: editing.name,
          parentId: editing.parentId ?? '',
          imageUrl: editing.imageUrl ?? '',
          sortOrder: String(editing.sortOrder ?? 0),
          isActive: editing.isActive,
        }
      : EMPTY_CATEGORY_FORM,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const inFlight = useRef(false);

  const set = <K extends keyof GiftCategoryFormState>(k: K, v: GiftCategoryFormState[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  useEffect(() => {
    if (touched) setErrors(computeErrors());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, touched]);

  // Base validation + a cycle guard: an edited category may not be parented under
  // itself or one of its own descendants (would orphan a subtree / loop the tree).
  function computeErrors(): string[] {
    const errs = validateCategoryForm(form);
    if (isEdit && editing && form.parentId && wouldCreateCycle(allCategories, editing.id, form.parentId)) {
      errs.push('A category cannot be nested under itself or one of its sub-categories.');
    }
    return errs;
  }

  async function handleSave() {
    const errs = computeErrors();
    setTouched(true);
    setErrors(errs);
    if (errs.length > 0) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setSaveError(null);

    const payload = categoryFormToPayload(form);
    const res = isEdit
      ? await api.put<unknown>(`/api/admin/gift-categories/${editing!.id}`, payload)
      : await api.post<unknown>('/api/admin/gift-categories', payload);
    setSaving(false);
    inFlight.current = false;
    if (res.success) {
      onSaved(isEdit ? 'Category updated.' : 'Category created.');
    } else {
      setSaveError(res.error);
    }
  }

  // Parent options exclude self + descendants (for an edit) to keep the tree acyclic.
  const parentOptions = allCategories.filter((c) => {
    if (!isEdit || !editing) return true;
    if (c.id === editing.id) return false;
    return !wouldCreateCycle(allCategories, editing.id, c.id);
  });

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={isEdit ? 'Edit category' : 'New category'}
      description="Manage the shared platform category tree that gift masters are filed under."
      className="max-w-lg"
    >
      <>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Name<span className="text-[var(--brand-primary)]"> *</span></label>
            <input type="text" value={form.name} data-testid="cat-name" onChange={(e) => set('name', e.target.value)} className={FIELD_CLS} placeholder="e.g. Electronics" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Code<span className="text-[var(--brand-primary)]"> *</span></label>
            <input type="text" value={form.code} data-testid="cat-code" onChange={(e) => set('code', e.target.value)} className={FIELD_CLS} placeholder="e.g. ELEC" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Parent category</label>
            <select value={form.parentId} data-testid="cat-parent" onChange={(e) => set('parentId', e.target.value)} className={FIELD_CLS}>
              <option value="">(Top level)</option>
              {parentOptions.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Sort order</label>
            <input type="text" inputMode="numeric" value={form.sortOrder} data-testid="cat-sort" onChange={(e) => set('sortOrder', e.target.value)} className={FIELD_CLS} placeholder="0" />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Image URL</label>
            <input type="text" value={form.imageUrl} data-testid="cat-image" onChange={(e) => set('imageUrl', e.target.value)} className={FIELD_CLS} placeholder="https://cdn.example.com/cat.jpg" />
          </div>
          <div className="sm:col-span-2">
            <label className="inline-flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={form.isActive} data-testid="cat-active" onChange={(e) => set('isActive', e.target.checked)} className="w-4 h-4 accent-[var(--brand-primary)]" />
              Active (visible to tenants)
            </label>
          </div>

          {errors.length > 0 && (
            <div className="sm:col-span-2 border border-red-200 bg-red-50 rounded-lg px-3 py-2 space-y-1" data-testid="category-errors">
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

        <div className="mt-5 -mx-6 px-6 pt-4 border-t border-gray-100 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-xs font-semibold text-gray-600 rounded-lg hover:bg-gray-100">Cancel</button>
          <Button variant="primary" onClick={() => { void handleSave(); }} loading={saving} data-testid="save-category-btn">
            {isEdit ? 'Save changes' : 'Create category'}
          </Button>
        </div>
      </>
    </Modal>
  );
}
