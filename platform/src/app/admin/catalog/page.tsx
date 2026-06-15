'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  FolderTree, Package, Plus, Search, X, Loader2, Pencil, Trash2,
  AlertCircle, ChevronRight, Tag, CheckCircle2,
} from 'lucide-react';
import { buildCategoryTree, flattenCategoryTree } from '@/lib/category-tree';

// ─── Types (mirror the API payloads) ────────────────────────────────────────────

interface Category {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  sortOrder: number;
  isActive: boolean;
  _count?: { children: number; skuMappings: number };
}

interface Sku {
  id: string;
  skuCode: string;
  name: string;
  brand: string | null;
  uom: string;
  mrpPaise: number;
  dealerPricePaise: number | null;
  isActive: boolean;
  categoryMappings?: { categoryId: string; isPrimary: boolean }[];
}

type TabId = 'categories' | 'skus';

// ─── Shared helpers ──────────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') ?? '' : '';
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const inputCls =
  'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]';

// ─── Modal shell ─────────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 sticky top-0 bg-white">
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
      </div>
    </div>
  );
}

function FieldError({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────────

export default function CatalogPage() {
  const [activeTab, setActiveTab] = useState<TabId>('categories');

  const [categories, setCategories] = useState<Category[]>([]);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Modal state
  const [catModal, setCatModal] = useState<{ mode: 'create' | 'edit'; cat?: Category } | null>(null);
  const [skuModal, setSkuModal] = useState<{ mode: 'create' | 'edit'; sku?: Sku } | null>(null);

  // ── Fetch ──
  const loadCategories = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/categories', { headers: authHeaders() });
      const j = await res.json();
      if (j.success && Array.isArray(j.data.categories)) setCategories(j.data.categories);
    } catch { /* ignore — empty state renders */ }
  }, []);

  const loadSkus = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/skus?limit=200', { headers: authHeaders() });
      const j = await res.json();
      if (j.success && Array.isArray(j.data.skus)) setSkus(j.data.skus);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Initial load — loaders setState in their async callbacks (same data-fetch
    // pattern as the outlets admin page); the lint rule flags the transitive
    // setState which is expected here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    Promise.all([loadCategories(), loadSkus()]).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [loadCategories, loadSkus]);

  // ── Derived: indented category rows (parent → child tree) ──
  const categoryRows = useMemo(() => {
    const q = search.toLowerCase();
    const filtered = !search
      ? categories
      : categories.filter((c) => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
    // When searching, show a flat filtered list; otherwise nest into a tree.
    if (search) return filtered.map((c) => ({ ...c, depth: 0 }));
    return flattenCategoryTree(buildCategoryTree(categories));
  }, [categories, search]);

  const filteredSkus = useMemo(() => {
    const q = search.toLowerCase();
    return !search
      ? skus
      : skus.filter((s) => s.skuCode.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
  }, [skus, search]);

  const catNameById = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);

  // ── Tabs ──
  const tabs: { id: TabId; label: string; icon: React.ReactNode; count: number }[] = [
    { id: 'categories', label: 'Categories', icon: <FolderTree className="w-4 h-4" />, count: categories.length },
    { id: 'skus', label: 'SKUs', icon: <Package className="w-4 h-4" />, count: skus.length },
  ];

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Product Catalog</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Organise products into categories and manage your SKU master
          </p>
        </div>
        <button
          data-testid="catalog-create-btn"
          onClick={() =>
            activeTab === 'categories'
              ? setCatModal({ mode: 'create' })
              : setSkuModal({ mode: 'create' })
          }
          className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          {activeTab === 'categories' ? 'New Category' : 'New SKU'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white border border-gray-200 rounded-xl p-1 w-fit">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={activeTab === t.id}
            onClick={() => { setActiveTab(t.id); setSearch(''); }}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === t.id ? 'bg-[var(--brand-primary)] text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            {t.icon}
            {t.label}
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${
              activeTab === t.id ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
            }`}>{t.count}</span>
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            data-testid="catalog-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={activeTab === 'categories' ? 'Search categories by code or name…' : 'Search SKUs by code or name…'}
            className={`pl-9 ${inputCls}`}
          />
        </div>
      </div>

      {/* ═══ CATEGORIES TAB ═══ */}
      {activeTab === 'categories' && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Category</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Code</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">SKUs</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {loading ? (
                  <tr><td colSpan={5} className="px-4 py-16 text-center">
                    <Loader2 className="w-6 h-6 text-gray-300 mx-auto animate-spin" />
                  </td></tr>
                ) : categoryRows.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-16 text-center">
                    <FolderTree className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                    <p className="text-sm text-gray-400">No categories yet — create your first one to organise products</p>
                  </td></tr>
                ) : categoryRows.map((c) => (
                  <tr key={c.id} data-testid="category-row" className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center" style={{ paddingLeft: `${(c as { depth: number }).depth * 1.5}rem` }}>
                        {(c as { depth: number }).depth > 0 && <ChevronRight className="w-3 h-3 text-gray-300 mr-1 shrink-0" />}
                        <div className="w-7 h-7 bg-[var(--brand-primary)]/10 rounded-lg flex items-center justify-center shrink-0 mr-2">
                          <FolderTree className="w-3.5 h-3.5 text-[var(--brand-primary)]" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">{c.name}</p>
                          {c.description && <p className="text-xs text-gray-400">{c.description}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3"><span className="text-xs font-mono text-gray-500">{c.code}</span></td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-gray-600">{c._count?.skuMappings ?? 0}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                        c.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}>{c.isActive ? 'Active' : 'Inactive'}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          data-testid="category-edit"
                          onClick={() => setCatModal({ mode: 'edit', cat: c })}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/10 transition-colors"
                          title="Edit"
                        ><Pencil className="w-3.5 h-3.5" /></button>
                        <button
                          data-testid="category-delete"
                          onClick={async () => {
                            const res = await fetch(`/api/admin/categories/${c.id}`, { method: 'DELETE', headers: authHeaders() });
                            const j = await res.json();
                            if (!j.success) { alert(j.error); return; }
                            await loadCategories();
                          }}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                          title="Deactivate"
                        ><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ═══ SKUS TAB ═══ */}
      {activeTab === 'skus' && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">SKU</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Brand</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">MRP</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Categories</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {loading ? (
                  <tr><td colSpan={6} className="px-4 py-16 text-center">
                    <Loader2 className="w-6 h-6 text-gray-300 mx-auto animate-spin" />
                  </td></tr>
                ) : filteredSkus.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-16 text-center">
                    <Package className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                    <p className="text-sm text-gray-400">No SKUs yet — add your first product</p>
                  </td></tr>
                ) : filteredSkus.map((s) => (
                  <tr key={s.id} data-testid="sku-row" className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 bg-gray-100 rounded-lg flex items-center justify-center shrink-0">
                          <Package className="w-3.5 h-3.5 text-gray-500" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">{s.name}</p>
                          <p className="text-xs font-mono text-gray-400">{s.skuCode}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">{s.brand || '—'}</td>
                    <td className="px-4 py-3 text-xs font-medium text-gray-800">{rupees(s.mrpPaise)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(s.categoryMappings ?? []).length === 0
                          ? <span className="text-xs text-gray-300">—</span>
                          : (s.categoryMappings ?? []).map((m) => (
                            <span key={m.categoryId} className="inline-flex items-center gap-1 text-[11px] bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] px-1.5 py-0.5 rounded-full">
                              <Tag className="w-2.5 h-2.5" />{catNameById.get(m.categoryId) ?? m.categoryId}
                            </span>
                          ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                        s.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}>{s.isActive ? 'Active' : 'Inactive'}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          data-testid="sku-edit"
                          onClick={() => setSkuModal({ mode: 'edit', sku: s })}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/10 transition-colors"
                          title="Edit"
                        ><Pencil className="w-3.5 h-3.5" /></button>
                        <button
                          data-testid="sku-delete"
                          onClick={async () => {
                            const res = await fetch(`/api/admin/skus/${s.id}`, { method: 'DELETE', headers: authHeaders() });
                            const j = await res.json();
                            if (!j.success) { alert(j.error); return; }
                            await loadSkus();
                          }}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                          title="Deactivate"
                        ><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Category modal */}
      {catModal && (
        <CategoryForm
          mode={catModal.mode}
          cat={catModal.cat}
          categories={categories}
          onClose={() => setCatModal(null)}
          onSaved={async () => { setCatModal(null); await loadCategories(); }}
        />
      )}

      {/* SKU modal */}
      {skuModal && (
        <SkuForm
          mode={skuModal.mode}
          sku={skuModal.sku}
          categories={categories}
          onClose={() => setSkuModal(null)}
          onSaved={async () => { setSkuModal(null); await loadSkus(); }}
        />
      )}
    </div>
  );
}

// ─── Category create/edit form ───────────────────────────────────────────────────

function CategoryForm({
  mode, cat, categories, onClose, onSaved,
}: {
  mode: 'create' | 'edit';
  cat?: Category;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState(cat?.code ?? '');
  const [name, setName] = useState(cat?.name ?? '');
  const [description, setDescription] = useState(cat?.description ?? '');
  const [parentId, setParentId] = useState(cat?.parentId ?? '');
  const [isActive, setIsActive] = useState(cat?.isActive ?? true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Can't parent a category under itself.
  const parentOptions = categories.filter((c) => c.id !== cat?.id);

  const submit = async () => {
    setError(''); setSaving(true);
    try {
      const payload: Record<string, unknown> = { code, name, isActive };
      payload.description = description || undefined;
      if (mode === 'create') {
        if (parentId) payload.parentId = parentId;
      } else {
        payload.parentId = parentId || null;
      }
      const url = mode === 'create' ? '/api/admin/categories' : `/api/admin/categories/${cat!.id}`;
      const res = await fetch(url, {
        method: mode === 'create' ? 'POST' : 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!j.success) { setError(j.error || 'Failed to save'); return; }
      onSaved();
    } catch {
      setError('Network error — please try again');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={mode === 'create' ? 'New Category' : 'Edit Category'} onClose={onClose}>
      {error && <FieldError message={error} />}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Code *</label>
          <input data-testid="category-code-input" value={code} onChange={(e) => setCode(e.target.value)} className={inputCls} placeholder="e.g. BEVERAGES" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
          <input data-testid="category-name-input" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="e.g. Beverages" />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Parent category</label>
        <select value={parentId} onChange={(e) => setParentId(e.target.value)} className={inputCls}>
          <option value="">— None (top level) —</option>
          {parentOptions.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={inputCls} />
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="rounded" />
        Active
      </label>
      <FormActions saving={saving} onClose={onClose} onSubmit={submit} disabled={!code || !name} />
    </Modal>
  );
}

// ─── SKU create/edit form ────────────────────────────────────────────────────────

function SkuForm({
  mode, sku, categories, onClose, onSaved,
}: {
  mode: 'create' | 'edit';
  sku?: Sku;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [skuCode, setSkuCode] = useState(sku?.skuCode ?? '');
  const [name, setName] = useState(sku?.name ?? '');
  const [brand, setBrand] = useState(sku?.brand ?? '');
  const [uom, setUom] = useState(sku?.uom ?? 'UNIT');
  const [mrp, setMrp] = useState(sku ? String(sku.mrpPaise / 100) : '');
  const [isActive, setIsActive] = useState(sku?.isActive ?? true);
  const [categoryIds, setCategoryIds] = useState<string[]>(sku?.categoryMappings?.map((m) => m.categoryId) ?? []);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const toggleCat = (id: string) =>
    setCategoryIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = async () => {
    setError(''); setSaving(true);
    try {
      const mrpPaise = Math.round(parseFloat(mrp || '0') * 100);
      const payload: Record<string, unknown> = {
        skuCode, name, uom, mrpPaise, isActive,
        brand: brand || undefined,
        categoryIds,
      };
      const url = mode === 'create' ? '/api/admin/skus' : `/api/admin/skus/${sku!.id}`;
      const res = await fetch(url, {
        method: mode === 'create' ? 'POST' : 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!j.success) { setError(j.error || 'Failed to save'); return; }
      onSaved();
    } catch {
      setError('Network error — please try again');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={mode === 'create' ? 'New SKU' : 'Edit SKU'} onClose={onClose}>
      {error && <FieldError message={error} />}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">SKU Code *</label>
          <input data-testid="sku-code-input" value={skuCode} onChange={(e) => setSkuCode(e.target.value)} className={inputCls} placeholder="e.g. SKU-001" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
          <input data-testid="sku-name-input" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Brand</label>
          <input value={brand} onChange={(e) => setBrand(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">UOM</label>
          <input value={uom} onChange={(e) => setUom(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">MRP (₹) *</label>
          <input data-testid="sku-mrp-input" type="number" min="0" step="0.01" value={mrp} onChange={(e) => setMrp(e.target.value)} className={inputCls} placeholder="0.00" />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Categories</label>
        {categories.length === 0 ? (
          <p className="text-xs text-gray-400">No categories yet — create one first to assign SKUs.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => toggleCat(c.id)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  categoryIds.includes(c.id)
                    ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-[var(--brand-primary)]'
                }`}
              >{c.name}</button>
            ))}
          </div>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="rounded" />
        Active
      </label>
      <FormActions saving={saving} onClose={onClose} onSubmit={submit} disabled={!skuCode || !name || !mrp} />
    </Modal>
  );
}

function FormActions({
  saving, onClose, onSubmit, disabled,
}: { saving: boolean; onClose: () => void; onSubmit: () => void; disabled: boolean }) {
  return (
    <div className="flex gap-3 pt-2">
      <button onClick={onClose} className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition-colors">
        Cancel
      </button>
      <button
        data-testid="catalog-form-submit"
        onClick={onSubmit}
        disabled={disabled || saving}
        className="flex-1 py-2.5 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
        Save
      </button>
    </div>
  );
}
