'use client';

/**
 * Admin Reward Catalogue + Fulfilment page (P5 — task 5.5b).
 *
 * Data source rewire:
 *   OLD: the localStorage gift demo + the admin program-setting blob route.
 *   NEW: real CRUD on the RewardCategory / RewardCatalog tables, plus the
 *        redemption-order fulfilment surface:
 *
 *     Categories: GET/POST /api/admin/rewards/categories,
 *                 PATCH/DELETE /api/admin/rewards/categories/:id
 *     Catalog:    GET/POST /api/admin/rewards/catalog,
 *                 PATCH/DELETE /api/admin/rewards/catalog/:id
 *     Orders:     GET /api/rewards/orders (admin sees all tenant orders),
 *                 POST /api/rewards/orders/:id/transition (guarded edge-map)
 *     Bulk fulfilment:
 *                 GET  /api/admin/rewards/fulfilment/template  (xlsx blob)
 *                 POST /api/admin/rewards/fulfilment/upload    (multipart "file")
 *
 * The {success,data} envelope is unwrapped on every call. Auth = Bearer token via
 * authHeader(). The localStorage gift demo + the program-setting blob route are
 * NO LONGER referenced by this page.
 *
 * GifsySettingsPanel is retained as-is — it reads/writes lib/gifsy-settings
 * (a separate localStorage settings surface), unrelated to the retired blob.
 */

import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import {
  Gift, Plus, Search, Edit2, Trash2, X, Package, Check, AlertCircle,
  RefreshCw, Tag, Settings2, Banknote, Ticket, DollarSign, Save, Info,
  Upload, Download, FileSpreadsheet, CheckCircle2, XCircle, AlertTriangle,
  Truck, ChevronDown, Layers,
} from 'lucide-react';
import { authHeader } from '@/lib/api-client';
import { getGifsySettings, saveGifsySettings } from '@/lib/gifsy-settings';
import { useAdminSession } from '@/lib/admin-session';
import type { GifsySettings } from '@/types';

/* ─── Backend shapes ─────────────────────────────────────────────────────────── */

type CatalogStatus = 'ACTIVE' | 'INACTIVE' | 'OUT_OF_STOCK' | 'DRAFT' | string;
type PayoutMode = 'GIFT_CARD' | 'UPI' | 'BANK_TRANSFER' | 'PHYSICAL_GIFT';

interface RewardCategory {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  parentId?: string | null;
  imageUrl?: string | null;
  sortOrder?: number | null;
  isActive: boolean;
}

interface CatalogItem {
  id: string;
  categoryId: string;
  category?: { id: string; name: string; code: string } | null;
  code: string;
  name: string;
  description?: string | null;
  imageUrls?: string[] | null;
  pointsCost: number;
  mrpPaise?: number | null;
  redemptionMode: PayoutMode;
  status: CatalogStatus;
  minRedemptionPoints?: number | null;
  maxRedemptionPoints?: number | null;
  stockQuantity?: number | null;
  termsAndConditions?: string | null;
  sortOrder?: number | null;
}

interface Pagination { page: number; limit: number; total: number; pages: number }

interface OrderItem {
  id: string;
  orderNumber?: string;
  reward?: { id: string; name: string; redemptionMode?: PayoutMode | null } | null;
  partner?: { id: string; businessName?: string } | null;
  status: string;
  redemptionMode?: PayoutMode | string | null;
  totalPointsCost: number;
  voucherCode?: string | null;
  voucherProvider?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FulfilmentUploadResult {
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  errors: { row: number; orderNumber?: string; message: string }[];
}

/* ─── Constants ──────────────────────────────────────────────────────────────── */

const REDEMPTION_MODES: { value: PayoutMode; label: string }[] = [
  { value: 'GIFT_CARD',      label: 'Gift Card / Voucher' },
  { value: 'PHYSICAL_GIFT',  label: 'Physical Gift'       },
  { value: 'UPI',            label: 'UPI (points → INR)'  },
  { value: 'BANK_TRANSFER',  label: 'Bank Transfer'       },
];

/** Voucher denomination — derived from the FIXED vs FREE_AMOUNT convention. */
type VoucherMode = 'FIXED' | 'FREE_AMOUNT';

const STATUS_BADGE: Record<string, string> = {
  ACTIVE:       'bg-green-50 text-green-700 border-green-100',
  INACTIVE:     'bg-gray-50 text-gray-500 border-gray-200',
  OUT_OF_STOCK: 'bg-red-50 text-red-600 border-red-100',
  DRAFT:        'bg-amber-50 text-amber-600 border-amber-100',
};

const ORDER_STATUS_BADGE: Record<string, string> = {
  PENDING:    'bg-amber-50 text-amber-700 border-amber-100',
  CONFIRMED:  'bg-blue-50 text-blue-700 border-blue-100',
  PROCESSING: 'bg-blue-50 text-blue-700 border-blue-100',
  DISPATCHED: 'bg-indigo-50 text-indigo-700 border-indigo-100',
  DELIVERED:  'bg-green-50 text-green-700 border-green-100',
  FAILED:     'bg-red-50 text-red-600 border-red-100',
  CANCELLED:  'bg-red-50 text-red-600 border-red-100',
  RETURNED:   'bg-red-50 text-red-600 border-red-100',
  REVERSED:   'bg-gray-50 text-gray-500 border-gray-200',
};

/** Guarded next-status options keyed by current status (mirrors the backend edge-map). */
const NEXT_STATUS: Record<string, string[]> = {
  PENDING:    ['CONFIRMED', 'CANCELLED'],
  CONFIRMED:  ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['DISPATCHED', 'FAILED', 'CANCELLED'],
  DISPATCHED: ['DELIVERED', 'RETURNED'],
};

const VOUCHER_LIKE = new Set<PayoutMode | string>(['GIFT_CARD']);

/** Cash payout modes (points → INR) — these also support a free-amount minimum. */
const CASH_MODES = new Set<PayoutMode | string>(['UPI', 'BANK_TRANSFER']);
/** Modes that support the FIXED / FREE_AMOUNT toggle + min/max config. */
function supportsFreeAmount(mode: PayoutMode | string): boolean {
  return mode === 'GIFT_CARD' || CASH_MODES.has(mode);
}

function fmtPts(n: number) { return n.toLocaleString('en-IN'); }
function fmtPaise(p?: number | null) {
  if (p == null) return '—';
  return `₹${(p / 100).toLocaleString('en-IN')}`;
}

/* ─── Generic fetch helper (unwraps {success,data}) ──────────────────────────── */

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET';
  const hasJsonBody = init?.body != null && typeof init.body === 'string';
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
      ...authHeader(),
      ...(init?.headers as Record<string, string> | undefined ?? {}),
    },
  });
  const json = (await res.json()) as { success?: boolean; data?: T; error?: string };
  if (!res.ok || json.success === false) {
    throw new Error(json.error ?? `Request failed (HTTP ${res.status}) [${method} ${url}]`);
  }
  return json.data as T;
}

/** Trigger a browser download from a Blob. */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ════════════════════════════════════════════════════════════════════════════
   Category management
   ════════════════════════════════════════════════════════════════════════════ */

interface CatFormState {
  code: string; name: string; description: string; sortOrder: number; isActive: boolean;
}

function CategoryModal({
  editing, onSave, onClose, saving,
}: {
  editing: RewardCategory | null;
  onSave: (data: CatFormState) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<CatFormState>(
    editing
      ? {
          code: editing.code, name: editing.name, description: editing.description ?? '',
          sortOrder: editing.sortOrder ?? 0, isActive: editing.isActive,
        }
      : { code: '', name: '', description: '', sortOrder: 0, isActive: true },
  );
  const [err, setErr] = useState('');

  const submit = () => {
    if (!form.code.trim() || !form.name.trim()) { setErr('Code and name are required'); return; }
    onSave(form);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-900">
            {editing ? 'Edit Category' : 'New Category'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Code *</label>
            <input
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
              disabled={!!editing}
              placeholder="VOUCHERS"
              className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 disabled:bg-gray-50 disabled:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Sort order</label>
            <input
              type="number"
              value={form.sortOrder}
              onChange={(e) => setForm((f) => ({ ...f, sortOrder: parseInt(e.target.value) || 0 }))}
              className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-700">Name *</label>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Vouchers"
            className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-700">Description</label>
          <input
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
          />
        </div>

        {err && <p className="text-xs text-red-500">{err}</p>}

        <div className="flex gap-3 pt-1">
          <button onClick={onClose} className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="flex-1 py-2.5 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--brand-primary-dark)] disabled:opacity-50"
          >
            {saving ? 'Saving…' : editing ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CategorySection({
  categories, onReload,
}: {
  categories: RewardCategory[];
  onReload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<RewardCategory | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = async (data: CatFormState) => {
    setSaving(true); setErr('');
    try {
      if (editing) {
        await apiJson(`/api/admin/rewards/categories/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: data.name, description: data.description || null,
            sortOrder: data.sortOrder, isActive: data.isActive,
          }),
        });
      } else {
        await apiJson('/api/admin/rewards/categories', {
          method: 'POST',
          body: JSON.stringify({
            code: data.code, name: data.name,
            description: data.description || undefined, sortOrder: data.sortOrder,
          }),
        });
      }
      setModal(false); setEditing(null);
      onReload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (cat: RewardCategory) => {
    setErr('');
    try {
      await apiJson(`/api/admin/rewards/categories/${cat.id}`, { method: 'DELETE' });
      onReload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not deactivate (it may still have items)');
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-[var(--brand-primary)]" />
          <h2 className="text-sm font-bold text-gray-900">Categories</h2>
          <span className="text-xs text-gray-400">({categories.length})</span>
        </div>
        <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-gray-100 p-5 space-y-3">
          {err && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">
              <XCircle className="w-4 h-4 shrink-0" /> {err}
            </div>
          )}
          <div className="flex justify-end">
            <button
              onClick={() => { setEditing(null); setModal(true); }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--brand-primary)] text-white rounded-lg text-xs font-semibold hover:bg-[var(--brand-primary-dark)]"
            >
              <Plus className="h-3.5 w-3.5" /> Add Category
            </button>
          </div>

          {categories.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">No categories yet.</p>
          ) : (
            <div className="divide-y divide-gray-100 border border-gray-100 rounded-xl">
              {categories.map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {c.name}
                      <span className="ml-2 text-[10px] font-mono text-gray-400">{c.code}</span>
                    </p>
                    {c.description && <p className="text-xs text-gray-400 truncate">{c.description}</p>}
                  </div>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${c.isActive ? STATUS_BADGE.ACTIVE : STATUS_BADGE.INACTIVE}`}>
                    {c.isActive ? 'Active' : 'Inactive'}
                  </span>
                  <button
                    onClick={() => { setEditing(c); setModal(true); }}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50"
                    aria-label="Edit category"
                  >
                    <Edit2 className="h-3.5 w-3.5" />
                  </button>
                  {c.isActive && (
                    <button
                      onClick={() => deactivate(c)}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50"
                      aria-label="Deactivate category"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {modal && (
        <CategoryModal
          editing={editing}
          saving={saving}
          onSave={save}
          onClose={() => { setModal(false); setEditing(null); }}
        />
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Catalog item modal
   ════════════════════════════════════════════════════════════════════════════ */

interface ItemFormState {
  categoryId: string;
  code: string;
  name: string;
  description: string;
  redemptionMode: PayoutMode;
  /** Only meaningful when redemptionMode === GIFT_CARD */
  voucherMode: VoucherMode;
  pointsCost: number;
  mrpRupees: string;            // optional ₹ input → mrpPaise
  minRedemptionPoints: string;
  maxRedemptionPoints: string;
  stockTracked: boolean;
  stockQuantity: number;
  termsAndConditions: string;
  status: CatalogStatus;
}

function blankItemForm(categoryId: string): ItemFormState {
  return {
    categoryId,
    code: '', name: '', description: '',
    redemptionMode: 'GIFT_CARD', voucherMode: 'FIXED',
    pointsCost: 0, mrpRupees: '',
    minRedemptionPoints: '', maxRedemptionPoints: '',
    stockTracked: false, stockQuantity: 0,
    termsAndConditions: '', status: 'ACTIVE',
  };
}

function ItemModal({
  editing, categories, onSave, onClose, saving,
}: {
  editing: CatalogItem | null;
  categories: RewardCategory[];
  onSave: (payload: Record<string, unknown>) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const activeCats = categories.filter((c) => c.isActive);

  const [form, setForm] = useState<ItemFormState>(() => {
    if (!editing) return blankItemForm(activeCats[0]?.id ?? '');
    // FREE_AMOUNT applies to gift cards AND cash modes (UPI / BANK_TRANSFER):
    // pointsCost 0 with a configured minimum.
    const isFree = supportsFreeAmount(editing.redemptionMode)
      && editing.pointsCost === 0
      && (editing.minRedemptionPoints ?? 0) >= 1;
    return {
      categoryId: editing.categoryId,
      code: editing.code,
      name: editing.name,
      description: editing.description ?? '',
      redemptionMode: editing.redemptionMode,
      voucherMode: isFree ? 'FREE_AMOUNT' : 'FIXED',
      pointsCost: editing.pointsCost,
      mrpRupees: editing.mrpPaise != null ? String(editing.mrpPaise / 100) : '',
      minRedemptionPoints: editing.minRedemptionPoints != null ? String(editing.minRedemptionPoints) : '',
      maxRedemptionPoints: editing.maxRedemptionPoints != null ? String(editing.maxRedemptionPoints) : '',
      stockTracked: editing.stockQuantity != null,
      stockQuantity: editing.stockQuantity ?? 0,
      termsAndConditions: editing.termsAndConditions ?? '',
      status: editing.status,
    };
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = <K extends keyof ItemFormState>(k: K, v: ItemFormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const isCashMode = CASH_MODES.has(form.redemptionMode);
  // Free-amount config is available for gift cards and cash modes (UPI / BANK_TRANSFER).
  const canFreeAmount = supportsFreeAmount(form.redemptionMode);
  const isFreeAmount = canFreeAmount && form.voucherMode === 'FREE_AMOUNT';

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!form.categoryId) e.categoryId = 'Pick a category';
    if (!form.code.trim()) e.code = 'Code is required';
    if (!form.name.trim()) e.name = 'Name is required';
    if (isFreeAmount) {
      const min = parseInt(form.minRedemptionPoints);
      const max = parseInt(form.maxRedemptionPoints);
      if (!min || min < 1) e.minRedemptionPoints = 'Min must be ≥ 1 for a free-amount item';
      // Max is REQUIRED for a free-amount voucher: the backend treats an item as
      // free-amount only when BOTH bounds are set, so a blank max saves an
      // un-redeemable voucher ("must cost a positive number of points" at redeem).
      if (!max || max < 1) e.maxRedemptionPoints = 'Max is required (≥ 1) for a free-amount item';
      else if (min && max < min) e.maxRedemptionPoints = 'Max must be ≥ min';
    } else {
      if (form.pointsCost <= 0) e.pointsCost = 'Points cost must be > 0';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = () => {
    if (!validate()) return;
    // Build the backend payload following the FIXED / FREE_AMOUNT voucher convention.
    const payload: Record<string, unknown> = {
      categoryId: form.categoryId,
      code: form.code.trim(),
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      redemptionMode: form.redemptionMode,
      status: form.status,
      stockQuantity: form.stockTracked ? form.stockQuantity : null,
      termsAndConditions: form.termsAndConditions.trim() || undefined,
    };
    if (form.mrpRupees.trim()) {
      payload.mrpPaise = Math.round(parseFloat(form.mrpRupees) * 100);
    }
    if (isFreeAmount) {
      payload.pointsCost = 0;
      payload.minRedemptionPoints = parseInt(form.minRedemptionPoints);
      payload.maxRedemptionPoints = form.maxRedemptionPoints.trim()
        ? parseInt(form.maxRedemptionPoints)
        : null;
    } else {
      payload.pointsCost = form.pointsCost;
      // Clear any stale free-amount bounds when not a free-amount voucher.
      payload.minRedemptionPoints = null;
      payload.maxRedemptionPoints = null;
    }
    onSave(payload);
  };

  const inputCls = (key: string) =>
    `w-full text-sm border rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] ${
      errors[key] ? 'border-red-400' : 'border-gray-200'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <h2 className="text-base font-bold text-gray-900">
            {editing ? 'Edit Reward' : 'Add Reward'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
          {/* Category + code */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Category *</label>
              <div className="relative">
                <select
                  value={form.categoryId}
                  onChange={(e) => set('categoryId', e.target.value)}
                  className={`${inputCls('categoryId')} appearance-none bg-white pr-8`}
                >
                  <option value="">— Select —</option>
                  {activeCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
              </div>
              {errors.categoryId && <p className="text-xs text-red-500">{errors.categoryId}</p>}
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Item code *</label>
              <input
                value={form.code}
                onChange={(e) => set('code', e.target.value)}
                disabled={!!editing}
                placeholder="AMZ-500"
                className={`${inputCls('code')} disabled:bg-gray-50 disabled:text-gray-400`}
              />
              {errors.code && <p className="text-xs text-red-500">{errors.code}</p>}
            </div>
          </div>

          {/* Name */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Name *</label>
            <input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Amazon Voucher ₹500"
              className={inputCls('name')}
            />
            {errors.name && <p className="text-xs text-red-500">{errors.name}</p>}
          </div>

          {/* Description */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Description</label>
            <textarea
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              rows={2}
              className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
            />
          </div>

          {/* Redemption mode */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Redemption mode *</label>
            <div className="relative">
              <select
                value={form.redemptionMode}
                onChange={(e) => set('redemptionMode', e.target.value as PayoutMode)}
                className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 appearance-none bg-white pr-8 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
              >
                {REDEMPTION_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
            </div>
          </div>

          {/* Denomination config — gift cards AND cash modes (UPI / BANK_TRANSFER). */}
          {canFreeAmount && (
            <div className="rounded-xl border border-amber-100 bg-amber-50 p-4 space-y-4">
              <div className="flex items-center gap-2">
                {isCashMode
                  ? <Banknote className="h-4 w-4 text-amber-600 shrink-0" />
                  : <Ticket className="h-4 w-4 text-amber-600 shrink-0" />}
                <p className="text-sm font-semibold text-amber-900">
                  {isCashMode ? 'Cash Payout Configuration' : 'Voucher Configuration'}
                </p>
              </div>
              <div className="flex gap-3">
                {(['FIXED', 'FREE_AMOUNT'] as VoucherMode[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => set('voucherMode', t)}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-medium border-2 transition-all ${
                      form.voucherMode === t
                        ? 'border-amber-500 bg-amber-500 text-white'
                        : 'border-gray-200 bg-white text-gray-600 hover:border-amber-300'
                    }`}
                  >
                    {t === 'FIXED' ? '🎯 Fixed' : '✏️ Free Amount'}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-500">
                {isFreeAmount
                  ? 'pointsCost = 0; the partner redeems any amount whose points fall in the min/max range below.'
                  : isCashMode
                  ? 'Fixed points cost paid out as cash.'
                  : 'Fixed face value redeemed for a set points cost.'}
              </p>

              {isFreeAmount && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-gray-700">Minimum redemption (points) *</label>
                    <input
                      type="number"
                      value={form.minRedemptionPoints}
                      onChange={(e) => set('minRedemptionPoints', e.target.value)}
                      placeholder="100"
                      className={inputCls('minRedemptionPoints')}
                    />
                    {errors.minRedemptionPoints && <p className="text-xs text-red-500">{errors.minRedemptionPoints}</p>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-gray-700">Max points *</label>
                    <input
                      type="number"
                      value={form.maxRedemptionPoints}
                      onChange={(e) => set('maxRedemptionPoints', e.target.value)}
                      placeholder="e.g. 5000"
                      className={inputCls('maxRedemptionPoints')}
                    />
                    {errors.maxRedemptionPoints && <p className="text-xs text-red-500">{errors.maxRedemptionPoints}</p>}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Points cost (not shown for free-amount vouchers — forced to 0) */}
          {!isFreeAmount && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-700">Points cost *</label>
                <input
                  type="number"
                  value={form.pointsCost || ''}
                  onChange={(e) => set('pointsCost', parseInt(e.target.value) || 0)}
                  placeholder="2500"
                  className={inputCls('pointsCost')}
                />
                {errors.pointsCost && <p className="text-xs text-red-500">{errors.pointsCost}</p>}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-700">MRP (₹)</label>
                <input
                  type="number"
                  value={form.mrpRupees}
                  onChange={(e) => set('mrpRupees', e.target.value)}
                  placeholder="(optional)"
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
                />
              </div>
            </div>
          )}

          {/* Stock */}
          <div className="rounded-xl border border-gray-100 p-4 space-y-3">
            <button
              type="button"
              onClick={() => set('stockTracked', !form.stockTracked)}
              className="flex items-center gap-2 text-sm font-medium text-gray-700"
            >
              <span className={`w-9 h-5 rounded-full relative transition-colors ${form.stockTracked ? 'bg-[var(--brand-primary)]' : 'bg-gray-200'}`}>
                <span className={`absolute top-0.5 h-4 w-4 bg-white rounded-full transition-all ${form.stockTracked ? 'left-4' : 'left-0.5'}`} />
              </span>
              Track stock quantity
            </button>
            {form.stockTracked ? (
              <div className="space-y-1">
                <label className="text-xs text-gray-500">Stock quantity (0 forces OUT_OF_STOCK)</label>
                <input
                  type="number"
                  value={form.stockQuantity}
                  onChange={(e) => set('stockQuantity', parseInt(e.target.value) || 0)}
                  className="w-40 text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
                />
              </div>
            ) : (
              <p className="text-[10px] text-gray-400">Untracked — always considered in stock.</p>
            )}
          </div>

          {/* T&C */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Terms &amp; conditions</label>
            <textarea
              value={form.termsAndConditions}
              onChange={(e) => set('termsAndConditions', e.target.value)}
              rows={2}
              className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
            />
          </div>

          {/* Status */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Status</label>
            <div className="relative">
              <select
                value={form.status}
                onChange={(e) => set('status', e.target.value)}
                className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 appearance-none bg-white pr-8 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
              >
                <option value="ACTIVE">Active</option>
                <option value="DRAFT">Draft</option>
                <option value="INACTIVE">Inactive</option>
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
            </div>
          </div>
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-gray-100 shrink-0">
          <button onClick={onClose} className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="flex-1 py-2.5 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--brand-primary-dark)] disabled:opacity-50"
          >
            {saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Reward'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Delete confirm ─────────────────────────────────────────────────────────── */

function DeleteModal({ item, onConfirm, onClose }: { item: CatalogItem; onConfirm: () => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
            <AlertCircle className="h-5 w-5 text-red-500" />
          </div>
          <div>
            <p className="font-semibold text-gray-900 text-sm">Remove reward?</p>
            <p className="text-xs text-gray-500 mt-0.5">
              This soft-deletes <strong>{item.name}</strong> from the catalogue.
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-700 hover:bg-gray-50">
            Cancel
          </button>
          <button onClick={onConfirm} className="flex-1 py-2.5 bg-red-500 text-white rounded-xl text-sm font-semibold hover:bg-red-600">
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Catalogue tab
   ════════════════════════════════════════════════════════════════════════════ */

function CatalogueTab() {
  const [categories, setCategories] = useState<RewardCategory[]>([]);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<CatalogItem | null>(null);
  const [deleting, setDeleting] = useState<CatalogItem | null>(null);
  const [saving, setSaving] = useState(false);

  const loadCategories = useCallback(async () => {
    try {
      const data = await apiJson<{ categories: RewardCategory[] }>('/api/admin/rewards/categories');
      setCategories(data.categories ?? []);
    } catch {
      /* surfaced via catalog error if both fail */
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await apiJson<{ items: CatalogItem[]; pagination: Pagination }>(
        '/api/admin/rewards/catalog?page=1&limit=200',
      );
      setItems(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load catalogue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadCategories(); loadCatalog(); }, [loadCategories, loadCatalog]);

  const saveItem = async (payload: Record<string, unknown>) => {
    setSaving(true); setError('');
    try {
      if (editing) {
        await apiJson(`/api/admin/rewards/catalog/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiJson('/api/admin/rewards/catalog', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setModal(false); setEditing(null);
      await loadCatalog();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const removeItem = async (item: CatalogItem) => {
    setError('');
    try {
      await apiJson(`/api/admin/rewards/catalog/${item.id}`, { method: 'DELETE' });
      setDeleting(null);
      await loadCatalog();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
      setDeleting(null);
    }
  };

  const filtered = useMemo(() =>
    items.filter((it) => {
      const matchCat = catFilter === 'all' || it.categoryId === catFilter;
      const matchStatus = statusFilter === 'all' || it.status === statusFilter;
      const q = search.toLowerCase();
      const matchSearch = !q || it.name.toLowerCase().includes(q) || it.code.toLowerCase().includes(q);
      return matchCat && matchStatus && matchSearch;
    }),
  [items, catFilter, statusFilter, search]);

  const stats = useMemo(() => ({
    total: items.length,
    active: items.filter((i) => i.status === 'ACTIVE').length,
    outOfStock: items.filter((i) => i.status === 'OUT_OF_STOCK').length,
    vouchers: items.filter((i) => i.redemptionMode === 'GIFT_CARD').length,
  }), [items]);

  return (
    <div className="space-y-5">
      <CategorySection categories={categories} onReload={() => { loadCategories(); loadCatalog(); }} />

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total Rewards', value: stats.total,      color: 'text-gray-900' },
          { label: 'Active',        value: stats.active,     color: 'text-green-600' },
          { label: 'Out of Stock',  value: stats.outOfStock, color: 'text-red-500' },
          { label: 'Vouchers',      value: stats.vouchers,   color: 'text-amber-600' },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search rewards or codes…"
              className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
            />
          </div>
          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            className="text-sm border border-gray-200 rounded-xl px-3 py-2 bg-white focus:outline-none focus:border-gray-400"
          >
            <option value="all">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-sm border border-gray-200 rounded-xl px-3 py-2 bg-white focus:outline-none focus:border-gray-400"
          >
            <option value="all">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="DRAFT">Draft</option>
            <option value="INACTIVE">Inactive</option>
            <option value="OUT_OF_STOCK">Out of stock</option>
          </select>
          <button
            onClick={() => { setEditing(null); setModal(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--brand-primary-dark)]"
          >
            <Plus className="h-4 w-4" /> Add Reward
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">
          <XCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16" aria-label="Loading">
          <div className="w-6 h-6 border-2 border-gray-200 border-t-[var(--brand-primary)] rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 bg-white rounded-2xl border border-gray-100">
          <Gift className="h-10 w-10 text-gray-300 mb-3" />
          <p className="text-sm font-medium text-gray-500">No rewards found</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs text-gray-400">
                  <th className="px-4 py-3 font-medium">Reward</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium">Mode</th>
                  <th className="px-4 py-3 font-medium">Points</th>
                  <th className="px-4 py-3 font-medium">Stock</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((it) => {
                  const isFree = it.redemptionMode === 'GIFT_CARD'
                    && it.pointsCost === 0 && (it.minRedemptionPoints ?? 0) >= 1;
                  return (
                    <tr key={it.id} className="hover:bg-gray-50/50">
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-900">{it.name}</p>
                        <p className="text-[10px] font-mono text-gray-400">{it.code}</p>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        <span className="inline-flex items-center gap-1 text-xs">
                          <Tag className="h-3 w-3 text-gray-400" />
                          {it.category?.name ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">{it.redemptionMode}</td>
                      <td className="px-4 py-3">
                        {isFree ? (
                          <span className="text-xs text-purple-600 font-semibold">
                            {fmtPts(it.minRedemptionPoints ?? 0)}–{it.maxRedemptionPoints != null ? fmtPts(it.maxRedemptionPoints) : '∞'}
                          </span>
                        ) : (
                          <span className="font-semibold text-gray-900">{fmtPts(it.pointsCost)}</span>
                        )}
                        {it.mrpPaise != null && (
                          <span className="block text-[10px] text-gray-400">MRP {fmtPaise(it.mrpPaise)}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">
                        {it.stockQuantity == null ? 'Untracked' : it.stockQuantity}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${STATUS_BADGE[it.status] ?? STATUS_BADGE.INACTIVE}`}>
                          {it.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => { setEditing(it); setModal(true); }}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100"
                            aria-label="Edit reward"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => setDeleting(it)}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50"
                            aria-label="Delete reward"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal && (
        <ItemModal
          editing={editing}
          categories={categories}
          saving={saving}
          onSave={saveItem}
          onClose={() => { setModal(false); setEditing(null); }}
        />
      )}
      {deleting && (
        <DeleteModal item={deleting} onConfirm={() => removeItem(deleting)} onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Fulfilment tab
   ════════════════════════════════════════════════════════════════════════════ */

interface TransitionDraft {
  toStatus: string;
  voucherCode: string;
  voucherProvider: string;
  trackingNumber: string;
  trackingUrl: string;
  notes: string;
}

function OrderRow({ order, onTransitioned }: { order: OrderItem; onTransitioned: () => void }) {
  const options = NEXT_STATUS[order.status] ?? [];
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TransitionDraft>({
    toStatus: options[0] ?? '', voucherCode: '', voucherProvider: '',
    trackingNumber: '', trackingUrl: '', notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const isVoucher = VOUCHER_LIKE.has(order.redemptionMode ?? order.reward?.redemptionMode ?? '');
  const advancingToConfirmed = draft.toStatus === 'CONFIRMED';
  const advancingToDispatched = draft.toStatus === 'DISPATCHED';

  const submit = async () => {
    if (!draft.toStatus) return;
    setBusy(true); setErr('');
    const body: Record<string, unknown> = { toStatus: draft.toStatus };
    if (draft.voucherCode.trim())     body.voucherCode = draft.voucherCode.trim();
    if (draft.voucherProvider.trim()) body.voucherProvider = draft.voucherProvider.trim();
    if (draft.trackingNumber.trim())  body.trackingNumber = draft.trackingNumber.trim();
    if (draft.trackingUrl.trim())     body.trackingUrl = draft.trackingUrl.trim();
    if (draft.notes.trim())           body.notes = draft.notes.trim();
    try {
      await apiJson(`/api/rewards/orders/${order.id}/transition`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setOpen(false);
      onTransitioned();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Transition failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <tr className="hover:bg-gray-50/50">
        <td className="px-4 py-3">
          <p className="font-mono text-xs text-gray-600">{order.orderNumber ?? order.id.slice(-8)}</p>
        </td>
        <td className="px-4 py-3 text-gray-900">{order.reward?.name ?? '—'}</td>
        <td className="px-4 py-3 text-xs text-gray-600">{order.partner?.businessName ?? '—'}</td>
        <td className="px-4 py-3 text-xs text-gray-600">{order.redemptionMode ?? '—'}</td>
        <td className="px-4 py-3 font-semibold text-gray-900">{fmtPts(order.totalPointsCost)}</td>
        <td className="px-4 py-3">
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${ORDER_STATUS_BADGE[order.status] ?? ORDER_STATUS_BADGE.REVERSED}`}>
            {order.status}
          </span>
          {order.voucherCode && (
            <span className="block mt-1 text-[10px] font-mono text-emerald-600">{order.voucherCode}</span>
          )}
          {order.trackingNumber && (
            <span className="block mt-1 text-[10px] text-gray-500 flex items-center gap-1">
              <Truck className="h-2.5 w-2.5" />{order.trackingNumber}
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          {options.length > 0 ? (
            <button
              onClick={() => { setOpen((o) => !o); setErr(''); }}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
            >
              {open ? 'Close' : 'Advance'}
            </button>
          ) : (
            <span className="text-[10px] text-gray-300">—</span>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="px-4 py-4 bg-gray-50/70">
            <div className="space-y-3 max-w-2xl">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-gray-700">Advance to</label>
                  <select
                    value={draft.toStatus}
                    onChange={(e) => setDraft((d) => ({ ...d, toStatus: e.target.value }))}
                    className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-gray-400"
                  >
                    {options.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                {advancingToConfirmed && isVoucher && (
                  <>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-700">Voucher code</label>
                      <input
                        value={draft.voucherCode}
                        onChange={(e) => setDraft((d) => ({ ...d, voucherCode: e.target.value }))}
                        placeholder="AMZ-XXXX"
                        className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-700">Provider</label>
                      <input
                        value={draft.voucherProvider}
                        onChange={(e) => setDraft((d) => ({ ...d, voucherProvider: e.target.value }))}
                        placeholder="Gifsy"
                        className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
                      />
                    </div>
                  </>
                )}
                {advancingToDispatched && (
                  <>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-700">Tracking #</label>
                      <input
                        value={draft.trackingNumber}
                        onChange={(e) => setDraft((d) => ({ ...d, trackingNumber: e.target.value }))}
                        className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-700">Tracking URL</label>
                      <input
                        value={draft.trackingUrl}
                        onChange={(e) => setDraft((d) => ({ ...d, trackingUrl: e.target.value }))}
                        className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
                      />
                    </div>
                  </>
                )}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-700">Notes</label>
                <input
                  value={draft.notes}
                  onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
                />
              </div>
              {err && (
                <div className="flex items-center gap-2 text-xs text-red-600">
                  <XCircle className="w-3.5 h-3.5 shrink-0" /> {err}
                </div>
              )}
              <button
                onClick={submit}
                disabled={busy || !draft.toStatus}
                className="px-4 py-2 bg-[var(--brand-primary)] text-white rounded-lg text-xs font-semibold hover:bg-[var(--brand-primary-dark)] disabled:opacity-50"
              >
                {busy ? 'Saving…' : `Confirm → ${draft.toStatus}`}
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

const ORDER_STATUS_FILTERS = ['all', 'PENDING', 'CONFIRMED', 'PROCESSING', 'DISPATCHED', 'DELIVERED', 'CANCELLED'];

function FulfilmentTab() {
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  // Bulk
  const fileRef = useRef<HTMLInputElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadErr, setDownloadErr] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState('');
  const [result, setResult] = useState<FulfilmentUploadResult | null>(null);

  const loadOrders = useCallback(async (status: string) => {
    setLoading(true); setError('');
    try {
      const qs = status === 'all' ? '' : `?status=${encodeURIComponent(status)}`;
      const data = await apiJson<{ orders: OrderItem[]; pagination?: Pagination }>(
        `/api/rewards/orders${qs}${qs ? '&' : '?'}page=1&limit=100`,
      );
      setOrders(data.orders ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadOrders(statusFilter); }, [loadOrders, statusFilter]);

  async function downloadTemplate() {
    setDownloading(true); setDownloadErr('');
    try {
      const qs = statusFilter === 'all' ? '' : `?status=${encodeURIComponent(statusFilter)}`;
      const res = await fetch(`/api/admin/rewards/fulfilment/template${qs}`, { headers: authHeader() });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json() as { error?: string }; msg = j.error ?? msg; } catch { /* ignore */ }
        setDownloadErr(msg);
        return;
      }
      const blob = await res.blob();
      downloadBlob(blob, `fulfilment_sheet_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      setDownloadErr(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  async function uploadSheet(file: File) {
    setUploading(true); setUploadErr(''); setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      // Do NOT set Content-Type — the browser sets the multipart boundary.
      const res = await fetch('/api/admin/rewards/fulfilment/upload', {
        method: 'POST',
        headers: authHeader(),
        body: fd,
      });
      const json = await res.json() as { success?: boolean; data?: FulfilmentUploadResult; error?: string };
      if (!res.ok || json.success === false) {
        setUploadErr(json.error ?? `Upload failed (HTTP ${res.status})`);
        return;
      }
      setResult(json.data ?? null);
      await loadOrders(statusFilter);
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) uploadSheet(file);
    e.target.value = '';
  }

  return (
    <div className="space-y-5">
      {/* Bulk fulfilment */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm px-6 py-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-green-50">
            <FileSpreadsheet className="w-4 h-4 text-green-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Bulk fulfilment</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Download the fulfilment sheet, fill in voucher codes / tracking numbers, then upload it back.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={downloadTemplate}
            disabled={downloading}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-xl hover:opacity-90 disabled:opacity-40"
          >
            {downloading
              ? <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              : <Download className="w-4 h-4" />}
            Download fulfilment sheet
          </button>

          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-700 text-sm font-semibold rounded-xl hover:bg-gray-50 disabled:opacity-40"
          >
            {uploading
              ? <div className="w-4 h-4 border-2 border-gray-200 border-t-[var(--brand-primary)] rounded-full animate-spin" />
              : <Upload className="w-4 h-4 text-gray-400" />}
            Upload filled sheet
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={onFileChange}
            className="hidden"
          />
        </div>

        {downloadErr && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">
            <XCircle className="w-4 h-4 shrink-0" /> {downloadErr}
          </div>
        )}
        {uploadErr && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{uploadErr}</span>
          </div>
        )}

        {/* Upload result */}
        {result && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Processed', value: result.processed, color: 'bg-gray-50 border-gray-200 text-gray-800' },
                { label: 'Succeeded', value: result.succeeded, color: 'bg-green-50 border-green-200 text-green-700' },
                { label: 'Skipped',   value: result.skipped,   color: 'bg-amber-50 border-amber-200 text-amber-700' },
                { label: 'Failed',    value: result.failed,    color: result.failed > 0 ? 'bg-red-50 border-red-200 text-red-700' : 'bg-gray-50 border-gray-200 text-gray-800' },
              ].map((s) => (
                <div key={s.label} className={`rounded-xl border px-4 py-3 text-center ${s.color}`}>
                  <p className="text-2xl font-bold">{s.value}</p>
                  <p className="text-xs font-medium mt-0.5 opacity-70">{s.label}</p>
                </div>
              ))}
            </div>

            {result.errors.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 space-y-1 max-h-44 overflow-y-auto" data-testid="fulfilment-errors">
                <p className="text-xs font-semibold text-amber-700 mb-2">Row errors</p>
                {result.errors.map((er, i) => (
                  <p key={i} className="text-xs text-amber-700">
                    <span className="font-mono font-semibold">
                      Row {er.row}{er.orderNumber ? ` — ${er.orderNumber}` : ''}:{' '}
                    </span>
                    {er.message}
                  </p>
                ))}
              </div>
            )}
            {result.errors.length === 0 && (
              <div className="flex items-center gap-2 text-sm text-emerald-700">
                <CheckCircle2 className="w-4 h-4" /> All rows processed without errors.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Orders queue */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-[var(--brand-primary)]" />
            <h2 className="text-sm font-bold text-gray-900">Redemption orders</h2>
            <span className="text-xs text-gray-400">({orders.length})</span>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:border-gray-400"
            >
              {ORDER_STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>{s === 'all' ? 'All statuses' : s}</option>
              ))}
            </select>
            <button
              onClick={() => loadOrders(statusFilter)}
              className="p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50"
              aria-label="Refresh orders"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>

        {error && (
          <div className="m-4 flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">
            <XCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16" aria-label="Loading">
            <div className="w-6 h-6 border-2 border-gray-200 border-t-[var(--brand-primary)] rounded-full animate-spin" />
          </div>
        ) : orders.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-12">No orders in this view.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs text-gray-400">
                  <th className="px-4 py-3 font-medium">Order</th>
                  <th className="px-4 py-3 font-medium">Reward</th>
                  <th className="px-4 py-3 font-medium">Partner</th>
                  <th className="px-4 py-3 font-medium">Mode</th>
                  <th className="px-4 py-3 font-medium">Points</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {orders.map((o) => (
                  <OrderRow key={o.id} order={o} onTransitioned={() => loadOrders(statusFilter)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Gifsy Settings panel (retained — localStorage settings, NOT the gift blob)
   ════════════════════════════════════════════════════════════════════════════ */

function GifsySettingsPanel() {
  const [settings, setSettings] = useState<GifsySettings>(() => getGifsySettings());
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // These settings persist via PUT /v1/admin/settings, which is GIFSY_ADMIN-only, and they
  // are Gifsy operating config (conversion rate, channels, min thresholds). Hide the panel
  // entirely for non-Gifsy admins rather than show controls whose save would 403.
  const isGifsyAdmin = useAdminSession().role === 'GIFSY_ADMIN';
  if (!isGifsyAdmin) return null;

  const flash = (ok: boolean) => {
    if (ok) { setError(null); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    else {
      setError('Could not save — please retry.');
      // Revert the optimistic change so the UI never shows an unsaved (e.g. 403'd) edit.
      setSettings(getGifsySettings());
    }
  };

  const applyAndSave = (updater: (s: GifsySettings) => GifsySettings) => {
    setSettings((prev) => {
      const next = updater(prev);
      void saveGifsySettings(next).then(flash);
      return next;
    });
  };

  const handleSave = () => {
    void saveGifsySettings(settings).then(flash);
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-[var(--brand-primary)]" />
          <h2 className="text-sm font-bold text-gray-900">Gifsy Settings</h2>
        </div>
        <p className="text-xs text-gray-400">Configurable by Gifsy admin only</p>
      </div>

      <div className="px-5 py-4 border-b border-gray-100 space-y-3">
        <p className="text-xs font-semibold text-gray-700">Redemption Channels</p>
        <div className="flex flex-wrap gap-3">
          {(
            [
              { key: 'physicalGifts', label: 'Physical Gifts', icon: Gift,     color: 'text-emerald-600' },
              { key: 'vouchers',      label: 'Vouchers',        icon: Tag,      color: 'text-amber-500'   },
              { key: 'bankTransfer',  label: 'Bank Transfer',   icon: Banknote, color: 'text-blue-500'    },
            ] as const
          ).map(({ key, label, icon: Icon, color }) => {
            const enabled = settings.redemptionChannels?.[key] ?? true;
            return (
              <button
                key={key}
                onClick={() =>
                  applyAndSave((s) => ({
                    ...s,
                    redemptionChannels: {
                      physicalGifts: s.redemptionChannels?.physicalGifts ?? true,
                      vouchers:      s.redemptionChannels?.vouchers      ?? true,
                      bankTransfer:  s.redemptionChannels?.bankTransfer  ?? true,
                      [key]: !enabled,
                    },
                  }))
                }
                className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-semibold transition-all ${
                  enabled ? 'bg-white border-gray-200 text-gray-800' : 'bg-gray-50 border-gray-200 text-gray-400'
                }`}
              >
                <Icon className={`h-3.5 w-3.5 ${enabled ? color : 'text-gray-300'}`} />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-5 grid grid-cols-1 sm:grid-cols-3 gap-5">
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
            <DollarSign className="h-3.5 w-3.5 text-[var(--brand-primary)]" /> Points Conversion Rate
          </label>
          <div className="flex items-center gap-2 mt-2">
            <span className="text-xs text-gray-500 shrink-0">1 pt =</span>
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">₹</span>
              <input
                type="number" min={0.01} step={0.01}
                value={settings.pointsConversionRate}
                onChange={(e) => setSettings((s) => ({ ...s, pointsConversionRate: parseFloat(e.target.value) || 1 }))}
                className="w-full text-sm border border-gray-200 rounded-xl pl-7 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
              />
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
            <Banknote className="h-3.5 w-3.5 text-blue-500" /> Min Bank Transfer (₹)
          </label>
          <div className="relative mt-2">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">₹</span>
            <input
              type="number" min={1} step={1}
              value={settings.minBankTransferAmount}
              onChange={(e) => setSettings((s) => ({ ...s, minBankTransferAmount: parseInt(e.target.value) || 100 }))}
              className="w-full text-sm border border-gray-200 rounded-xl pl-7 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
            <Ticket className="h-3.5 w-3.5 text-amber-500" /> Min Free-Amount Voucher (₹)
          </label>
          <div className="relative mt-2">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">₹</span>
            <input
              type="number" min={1} step={1}
              value={settings.minVoucherFreeAmount}
              onChange={(e) => setSettings((s) => ({ ...s, minVoucherFreeAmount: parseInt(e.target.value) || 100 }))}
              className="w-full text-sm border border-gray-200 rounded-xl pl-7 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
            />
          </div>
        </div>
      </div>

      <div className="px-5 pb-4 flex items-center justify-between">
        <p className="text-[10px] text-gray-400 flex items-center gap-1">
          <Info className="h-3 w-3" />
          {error ? <span className="text-red-500">{error}</span> : 'Changes apply immediately to all partner sessions.'}
        </p>
        <button
          onClick={handleSave}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
            saved ? 'bg-emerald-100 text-emerald-700' : 'bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-dark)]'
          }`}
        >
          {saved ? <><Check className="h-4 w-4" /> Saved</> : <><Save className="h-4 w-4" /> Save Settings</>}
        </button>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Page
   ════════════════════════════════════════════════════════════════════════════ */

type Tab = 'catalogue' | 'fulfilment';

export default function AdminGiftsPage() {
  const [tab, setTab] = useState<Tab>('catalogue');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Reward Catalogue &amp; Fulfilment</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Manage the reward catalogue and process redemption orders.
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-100">
        {([
          { key: 'catalogue', label: 'Catalogue',  icon: Gift },
          { key: 'fulfilment', label: 'Fulfilment', icon: Package },
        ] as const).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              tab === key
                ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {tab === 'catalogue' ? <CatalogueTab /> : <FulfilmentTab />}

      {/* Gifsy settings — shown under both tabs as a global config surface */}
      <GifsySettingsPanel />
    </div>
  );
}
