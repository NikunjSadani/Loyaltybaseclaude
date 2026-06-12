'use client';

import React, { useState, useRef, useMemo, useEffect } from 'react';
import {
  Gift, Plus, Search, Edit2, Trash2, ToggleLeft, ToggleRight,
  Upload, X, Star, Zap, Package, Check, AlertCircle, ImageIcon,
  ChevronDown, RefreshCw, Tag, Settings2, Banknote, Ticket,
  DollarSign, Save, Info,
} from 'lucide-react';
import { type GiftCatalogueItem, type VoucherDenominationType, loadGifts, saveGifts } from '@/lib/gifts';
import { getGifsySettings, saveGifsySettings } from '@/lib/gifsy-settings';
import type { GifsySettings } from '@/types';

/* ─── Categories ─────────────────────────────────────────────────────────────── */

const PHYSICAL_CATEGORIES = ['Electronics', 'Home & Kitchen', 'Personal Appliances', 'Health', 'Travel'];
const ALL_CATEGORY_OPTIONS = [...PHYSICAL_CATEGORIES, 'Vouchers'];
const FILTER_CATEGORIES = ['All', ...ALL_CATEGORY_OPTIONS];

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  active:   { label: 'Active',       cls: 'bg-green-50 text-green-700 border-green-100' },
  inactive: { label: 'Out of Stock', cls: 'bg-red-50 text-red-600 border-red-100'       },
};

function formatPts(n: number) { return n.toLocaleString('en-IN'); }
function fmtInr(n: number) { return `₹${n.toLocaleString('en-IN')}`; }

/* ─── ImageBox — uploaded preview or emoji gradient placeholder ──────────────── */

function ImageBox({
  item, size = 'md',
}: { item: Pick<GiftCatalogueItem, 'imageDataUrl' | 'emoji' | 'gradientFrom' | 'gradientTo'>; size?: 'sm' | 'md' | 'lg' }) {
  const sizeMap = { sm: 'h-16 w-full text-3xl', md: 'h-32 w-full text-5xl', lg: 'h-52 w-full text-7xl' };
  if (item.imageDataUrl) {
    return (
      <div className={`${sizeMap[size]} flex items-center justify-center overflow-hidden`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.imageDataUrl} alt="" className="w-full h-full object-cover" />
      </div>
    );
  }
  return (
    <div
      className={`${sizeMap[size]} flex items-center justify-center select-none`}
      style={{ background: `linear-gradient(135deg, ${item.gradientFrom}22, ${item.gradientTo}44)` }}
    >
      <span>{item.emoji}</span>
    </div>
  );
}

/* ─── Feature list editor ────────────────────────────────────────────────────── */

function FeatureEditor({ features, onChange }: { features: string[]; onChange: (f: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    if (!draft.trim()) return;
    onChange([...features, draft.trim()]);
    setDraft('');
  };
  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-gray-700">Key Features</label>
      <div className="space-y-1.5">
        {features.map((f, i) => (
          <div key={i} className="flex items-center gap-2 group">
            <Zap className="h-3.5 w-3.5 text-[var(--brand-primary)] shrink-0" />
            <span className="flex-1 text-xs text-gray-700">{f}</span>
            <button
              type="button"
              onClick={() => onChange(features.filter((_, j) => j !== i))}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-400 hover:text-red-500 transition-all"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="Add a feature…"
          className="flex-1 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
        />
        <button
          type="button"
          onClick={add}
          className="px-3 py-1.5 text-xs bg-[var(--brand-primary)] text-white rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors"
        >
          Add
        </button>
      </div>
    </div>
  );
}

/* ─── Add / Edit modal ───────────────────────────────────────────────────────── */

type FormState = Omit<GiftCatalogueItem, 'id' | 'addedDate'>;

const BLANK_FORM: FormState = {
  name: '', brand: '', category: 'Electronics', points: 0,
  description: '', details: '', features: [],
  emoji: '🎁', gradientFrom: 'var(--brand-primary)', gradientTo: '#22c55e',
  imageDataUrl: null, available: true, popular: false,
  voucherType: undefined, fixedAmount: undefined,
};

const GRADIENT_PRESETS = [
  { from: 'var(--brand-primary)', to: '#22c55e', label: 'Green'  },
  { from: '#1d4ed8', to: '#60a5fa', label: 'Blue'   },
  { from: '#7c3aed', to: '#a78bfa', label: 'Purple' },
  { from: '#FF9900', to: '#FFB347', label: 'Orange' },
  { from: '#dc2626', to: '#f87171', label: 'Red'    },
  { from: '#0891b2', to: '#22d3ee', label: 'Cyan'   },
  { from: '#d97706', to: '#fbbf24', label: 'Amber'  },
  { from: '#be185d', to: '#f9a8d4', label: 'Pink'   },
];

function GiftModal({
  editing,
  onSave,
  onClose,
}: {
  editing: GiftCatalogueItem | null;
  onSave: (data: FormState) => void;
  onClose: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<FormState>(
    editing
      ? {
          name: editing.name, brand: editing.brand, category: editing.category, points: editing.points,
          description: editing.description, details: editing.details, features: [...editing.features],
          emoji: editing.emoji, gradientFrom: editing.gradientFrom, gradientTo: editing.gradientTo,
          imageDataUrl: editing.imageDataUrl, available: editing.available, popular: editing.popular,
          voucherType: editing.voucherType, fixedAmount: editing.fixedAmount,
        }
      : { ...BLANK_FORM }
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = (k: keyof FormState, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  const isVoucher = form.category === 'Vouchers';
  const isFixed   = isVoucher && form.voucherType === 'FIXED';
  const isFree    = isVoucher && form.voucherType === 'FREE_AMOUNT';

  /* When switching to Vouchers, default to FIXED if no type set */
  const handleCategoryChange = (cat: string) => {
    if (cat === 'Vouchers' && !form.voucherType) {
      setForm((f) => ({ ...f, category: cat, voucherType: 'FIXED' }));
    } else if (cat !== 'Vouchers') {
      setForm((f) => ({ ...f, category: cat, voucherType: undefined, fixedAmount: undefined }));
    } else {
      set('category', cat);
    }
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => set('imageDataUrl', ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.name.trim())        errs.name        = 'Name is required';
    if (!form.brand.trim())       errs.brand       = 'Brand is required';
    if (!form.description.trim()) errs.description = 'Description is required';
    if (!form.details.trim())     errs.details     = 'Details are required';
    if (!isVoucher && form.points <= 0) errs.points = 'Points must be > 0';
    if (isFixed) {
      if (!form.fixedAmount || form.fixedAmount <= 0) errs.fixedAmount = 'Face value must be > 0';
      if (form.points <= 0) errs.points = 'Points cost must be > 0';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = () => { if (validate()) onSave(form); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <h2 className="text-base font-bold text-gray-900">
            {editing ? 'Edit Gift / Voucher' : 'Add New Gift / Voucher'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">

          {/* Image section */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-gray-700">Product Image</label>
            <div className="flex gap-4 items-start">
              <div className="w-36 h-36 rounded-xl overflow-hidden border border-gray-200 shrink-0 bg-gray-50">
                {form.imageDataUrl ? (
                  <div className="relative w-full h-full">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={form.imageDataUrl} alt="" className="w-full h-full object-cover" />
                    <button
                      onClick={() => set('imageDataUrl', null)}
                      className="absolute top-1 right-1 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center text-white"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ) : (
                  <div
                    className="w-full h-full flex flex-col items-center justify-center gap-1 select-none"
                    style={{ background: `linear-gradient(135deg, ${form.gradientFrom}22, ${form.gradientTo}44)` }}
                  >
                    <span className="text-4xl">{form.emoji}</span>
                    <span className="text-[9px] text-gray-400">Emoji placeholder</span>
                  </div>
                )}
              </div>

              <div className="flex-1 space-y-3">
                <input type="file" accept="image/*" className="hidden" ref={fileRef} onChange={handleImageChange} />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-700 hover:bg-gray-50 transition-colors w-full justify-center"
                >
                  <Upload className="h-4 w-4 text-gray-400" />
                  {form.imageDataUrl ? 'Replace Image' : 'Upload Photo'}
                </button>
                <p className="text-[10px] text-gray-400 text-center">JPG, PNG or WebP · Recommended 400×400px</p>

                <div className="flex gap-2 items-center">
                  <label className="text-xs text-gray-500 shrink-0">Emoji fallback:</label>
                  <input
                    value={form.emoji}
                    onChange={(e) => set('emoji', e.target.value)}
                    className="w-16 text-center text-xl border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20"
                  />
                </div>

                <div>
                  <p className="text-[10px] text-gray-400 mb-1.5">Card background colour:</p>
                  <div className="flex gap-1.5 flex-wrap">
                    {GRADIENT_PRESETS.map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        title={p.label}
                        onClick={() => setForm((f) => ({ ...f, gradientFrom: p.from, gradientTo: p.to }))}
                        className={`w-6 h-6 rounded-full border-2 transition-all ${
                          form.gradientFrom === p.from ? 'border-gray-800 scale-110' : 'border-transparent hover:scale-105'
                        }`}
                        style={{ background: `linear-gradient(135deg, ${p.from}, ${p.to})` }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Name + Brand */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Gift / Voucher Name *</label>
              <input
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="e.g. Amazon Voucher ₹500"
                className={`w-full text-sm border rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] ${
                  errors.name ? 'border-red-400' : 'border-gray-200'
                }`}
              />
              {errors.name && <p className="text-xs text-red-500">{errors.name}</p>}
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Brand *</label>
              <input
                value={form.brand}
                onChange={(e) => set('brand', e.target.value)}
                placeholder="e.g. Amazon"
                className={`w-full text-sm border rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] ${
                  errors.brand ? 'border-red-400' : 'border-gray-200'
                }`}
              />
              {errors.brand && <p className="text-xs text-red-500">{errors.brand}</p>}
            </div>
          </div>

          {/* Category */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Category</label>
            <div className="relative">
              <select
                value={form.category}
                onChange={(e) => handleCategoryChange(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 appearance-none focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] bg-white pr-8"
              >
                {ALL_CATEGORY_OPTIONS.map((c) => <option key={c}>{c}</option>)}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
            </div>
          </div>

          {/* ── Voucher-specific fields ── */}
          {isVoucher && (
            <div className="rounded-xl border border-amber-100 bg-amber-50 p-4 space-y-4">
              <div className="flex items-center gap-2">
                <Ticket className="h-4 w-4 text-amber-600 shrink-0" />
                <p className="text-sm font-semibold text-amber-900">Voucher Configuration</p>
              </div>

              {/* Voucher type toggle */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-700">Denomination Type *</label>
                <div className="flex gap-3">
                  {(['FIXED', 'FREE_AMOUNT'] as VoucherDenominationType[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => {
                        setForm((f) => ({
                          ...f,
                          voucherType: t,
                          fixedAmount: t === 'FREE_AMOUNT' ? undefined : f.fixedAmount,
                          points:      t === 'FREE_AMOUNT' ? 0 : f.points,
                        }));
                      }}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-medium border-2 transition-all ${
                        form.voucherType === t
                          ? 'border-amber-500 bg-amber-500 text-white'
                          : 'border-gray-200 bg-white text-gray-600 hover:border-amber-300'
                      }`}
                    >
                      {t === 'FIXED' ? '🎯 Fixed Amount' : '✏️ Free Amount'}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-gray-500 mt-1">
                  {isFixed
                    ? 'The voucher has a specific face value (e.g. ₹500). Outlet pays a fixed points cost to claim it.'
                    : 'Outlet enters any amount ≥ the minimum configured in Gifsy Settings. Points are deducted proportionally.'}
                </p>
              </div>

              {/* Fixed: face value */}
              {isFixed && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-gray-700">Face Value (₹) *</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">₹</span>
                      <input
                        type="number"
                        value={form.fixedAmount ?? ''}
                        onChange={(e) => set('fixedAmount', parseFloat(e.target.value) || undefined)}
                        placeholder="500"
                        className={`w-full text-sm border rounded-xl pl-7 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] ${
                          errors.fixedAmount ? 'border-red-400' : 'border-gray-200'
                        }`}
                      />
                    </div>
                    {errors.fixedAmount && <p className="text-xs text-red-500">{errors.fixedAmount}</p>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-gray-700">Points Cost *</label>
                    <input
                      type="number"
                      value={form.points || ''}
                      onChange={(e) => set('points', parseInt(e.target.value) || 0)}
                      placeholder="500"
                      className={`w-full text-sm border rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] ${
                        errors.points ? 'border-red-400' : 'border-gray-200'
                      }`}
                    />
                    {errors.points && <p className="text-xs text-red-500">{errors.points}</p>}
                  </div>
                </div>
              )}

              {/* Free amount: informational */}
              {isFree && (
                <div className="flex items-start gap-2 bg-white rounded-lg border border-amber-100 px-3 py-2.5">
                  <Info className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-gray-600">
                    The outlet enters a custom ₹ amount at redemption time. Points deducted = Amount ÷ Conversion rate.
                    The minimum redemption floor is set in <strong>Gifsy Settings</strong> below.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Points cost for physical items */}
          {!isVoucher && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Points Cost *</label>
              <input
                type="number"
                value={form.points || ''}
                onChange={(e) => set('points', parseInt(e.target.value) || 0)}
                placeholder="e.g. 2500"
                className={`w-full text-sm border rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] ${
                  errors.points ? 'border-red-400' : 'border-gray-200'
                }`}
              />
              {errors.points && <p className="text-xs text-red-500">{errors.points}</p>}
            </div>
          )}

          {/* Short description */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">
              Short Description * <span className="text-gray-400 font-normal">(shown on card)</span>
            </label>
            <input
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="e.g. Redeemable on Amazon.in for any product"
              maxLength={80}
              className={`w-full text-sm border rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] ${
                errors.description ? 'border-red-400' : 'border-gray-200'
              }`}
            />
            <div className="flex justify-between">
              {errors.description && <p className="text-xs text-red-500">{errors.description}</p>}
              <p className="text-[10px] text-gray-400 ml-auto">{form.description.length}/80</p>
            </div>
          </div>

          {/* Long details */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">
              Full Details * <span className="text-gray-400 font-normal">(shown in detail view)</span>
            </label>
            <textarea
              value={form.details}
              onChange={(e) => set('details', e.target.value)}
              placeholder="Write a detailed paragraph about the product or voucher…"
              rows={3}
              className={`w-full text-sm border rounded-xl px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] ${
                errors.details ? 'border-red-400' : 'border-gray-200'
              }`}
            />
            {errors.details && <p className="text-xs text-red-500">{errors.details}</p>}
          </div>

          {/* Features */}
          <FeatureEditor features={form.features} onChange={(f) => set('features', f)} />

          {/* Toggles */}
          <div className="flex gap-6 pt-1">
            <button
              type="button"
              onClick={() => set('available', !form.available)}
              className="flex items-center gap-2 text-sm text-gray-700"
            >
              {form.available
                ? <ToggleRight className="h-6 w-6 text-[var(--brand-primary)]" />
                : <ToggleLeft className="h-6 w-6 text-gray-400" />}
              Available for redemption
            </button>
            <button
              type="button"
              onClick={() => set('popular', !form.popular)}
              className="flex items-center gap-2 text-sm text-gray-700"
            >
              {form.popular
                ? <Star className="h-4 w-4 text-amber-400 fill-amber-400" />
                : <Star className="h-4 w-4 text-gray-300" />}
              Mark as Popular
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t border-gray-100 shrink-0">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="flex-1 py-2.5 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--brand-primary-dark)] transition-colors"
          >
            {editing ? 'Save Changes' : 'Add Gift'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Delete confirm modal ───────────────────────────────────────────────────── */

function DeleteModal({ gift, onConfirm, onClose }: { gift: GiftCatalogueItem; onConfirm: () => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
            <AlertCircle className="h-5 w-5 text-red-500" />
          </div>
          <div>
            <p className="font-semibold text-gray-900 text-sm">Remove gift?</p>
            <p className="text-xs text-gray-500 mt-0.5">
              This will remove <strong>{gift.name}</strong> from the catalogue.
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

/* ─── Gifsy Settings Panel ───────────────────────────────────────────────────── */

function GifsySettingsPanel() {
  const [settings, setSettings] = useState<GifsySettings>(() => getGifsySettings());
  const [saved, setSaved] = useState(false);

  /** Auto-save helper — writes to localStorage immediately after any state update. */
  const applyAndSave = (updater: (s: GifsySettings) => GifsySettings) => {
    setSettings(prev => {
      const next = updater(prev);
      saveGifsySettings(next);      // persist immediately — no manual Save needed
      return next;
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleSave = () => {
    saveGifsySettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
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

      {/* ── Redemption channel toggles ── */}
      <div className="px-5 py-4 border-b border-gray-100 space-y-3">
        <p className="text-xs font-semibold text-gray-700">Redemption Channels</p>
        <p className="text-[10px] text-gray-400 -mt-1">
          Disable a channel to hide it completely from the partner rewards catalogue.
        </p>
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
                  applyAndSave(s => ({
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
                  enabled
                    ? 'bg-white border-gray-200 text-gray-800'
                    : 'bg-gray-50 border-gray-200 text-gray-400'
                }`}
              >
                <Icon className={`h-3.5 w-3.5 ${enabled ? color : 'text-gray-300'}`} />
                <span>{label}</span>
                {enabled
                  ? <ToggleRight className="h-4 w-4 text-[var(--brand-primary)]" />
                  : <ToggleLeft  className="h-4 w-4 text-gray-300" />
                }
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-5 grid grid-cols-1 sm:grid-cols-3 gap-5">
        {/* Points conversion rate */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
            <DollarSign className="h-3.5 w-3.5 text-[var(--brand-primary)]" />
            Points Conversion Rate
          </label>
          <p className="text-[10px] text-gray-400 leading-relaxed">
            How many ₹ is 1 point worth. Default: 1 pt = ₹1.
          </p>
          <div className="flex items-center gap-2 mt-2">
            <span className="text-xs text-gray-500 shrink-0">1 pt =</span>
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">₹</span>
              <input
                type="number"
                min={0.01}
                step={0.01}
                value={settings.pointsConversionRate}
                onChange={(e) => setSettings((s) => ({ ...s, pointsConversionRate: parseFloat(e.target.value) || 1 }))}
                className="w-full text-sm border border-gray-200 rounded-xl pl-7 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
              />
            </div>
          </div>
        </div>

        {/* Min bank transfer */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
            <Banknote className="h-3.5 w-3.5 text-blue-500" />
            Min Bank Transfer (₹)
          </label>
          <p className="text-[10px] text-gray-400 leading-relaxed">
            Minimum ₹ amount for a direct bank transfer redemption.
          </p>
          <div className="relative mt-2">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">₹</span>
            <input
              type="number"
              min={1}
              step={1}
              value={settings.minBankTransferAmount}
              onChange={(e) => setSettings((s) => ({ ...s, minBankTransferAmount: parseInt(e.target.value) || 100 }))}
              className="w-full text-sm border border-gray-200 rounded-xl pl-7 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
            />
          </div>
        </div>

        {/* Min voucher free amount */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
            <Ticket className="h-3.5 w-3.5 text-amber-500" />
            Min Free-Amount Voucher (₹)
          </label>
          <p className="text-[10px] text-gray-400 leading-relaxed">
            Minimum ₹ amount for free-denomination voucher redemptions.
          </p>
          <div className="relative mt-2">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">₹</span>
            <input
              type="number"
              min={1}
              step={1}
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
          Changes apply immediately to all partner sessions.
        </p>
        <button
          onClick={handleSave}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
            saved
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-dark)]'
          }`}
        >
          {saved ? <><Check className="h-4 w-4" /> Saved</> : <><Save className="h-4 w-4" /> Save Settings</>}
        </button>
      </div>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function AdminGiftsPage() {
  const [gifts, setGifts]         = useState<GiftCatalogueItem[]>(() => loadGifts());
  const [search, setSearch]       = useState('');
  const [catFilter, setCatFilter] = useState('All');
  const [avFilter, setAvFilter]   = useState<'all' | 'active' | 'inactive'>('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing]     = useState<GiftCatalogueItem | null>(null);
  const [deleting, setDeleting]   = useState<GiftCatalogueItem | null>(null);

  /* ── Derived stats ── */
  const totalGifts    = gifts.length;
  const activeGifts   = gifts.filter((g) => g.available).length;
  const outOfStock    = gifts.filter((g) => !g.available).length;
  const voucherCount  = gifts.filter((g) => g.category === 'Vouchers').length;
  const physicalCount = gifts.filter((g) => g.category !== 'Vouchers').length;

  /* ── Filtered list ── */
  const filtered = useMemo(() =>
    gifts.filter((g) => {
      const matchCat  = catFilter === 'All' || g.category === catFilter;
      const matchAv   = avFilter === 'all' || (avFilter === 'active' ? g.available : !g.available);
      const matchSrch = !search || g.name.toLowerCase().includes(search.toLowerCase()) || g.brand.toLowerCase().includes(search.toLowerCase());
      return matchCat && matchAv && matchSrch;
    }),
  [gifts, catFilter, avFilter, search]);

  /* ── Handlers ── */
  const openAdd  = () => { setEditing(null); setModalOpen(true); };
  const openEdit = (g: GiftCatalogueItem) => { setEditing(g); setModalOpen(true); };

  const saveGift = (data: FormState) => {
    setGifts((gs) => {
      const updated = editing
        ? gs.map((g) => g.id === editing.id ? { ...editing, ...data } : g)
        : [{ ...data, id: `g${Date.now()}`, addedDate: new Date().toISOString().slice(0, 10) }, ...gs];
      saveGifts(updated);
      return updated;
    });
    setModalOpen(false);
  };

  const toggleAvailability = (id: string) => {
    setGifts((gs) => {
      const updated = gs.map((g) => g.id === id ? { ...g, available: !g.available } : g);
      saveGifts(updated);
      return updated;
    });
  };

  const deleteGift = (id: string) => {
    setGifts((gs) => {
      const updated = gs.filter((g) => g.id !== id);
      saveGifts(updated);
      return updated;
    });
    setDeleting(null);
  };

  return (
    <div className="space-y-6">

      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Gift Catalogue</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Manage physical gifts and vouchers available for Wholesaler point redemption
          </p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 px-4 py-2.5 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--brand-primary-dark)] transition-colors shadow-sm"
        >
          <Plus className="h-4 w-4" />
          Add Gift / Voucher
        </button>
      </div>

      {/* Gifsy Settings Panel */}
      <GifsySettingsPanel />

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Total Items',    value: totalGifts,    color: 'text-gray-900',   onClick: () => { setCatFilter('All'); setAvFilter('all'); } },
          { label: 'Active',         value: activeGifts,   color: 'text-green-600',  onClick: () => { setCatFilter('All'); setAvFilter('active'); } },
          { label: 'Out of Stock',   value: outOfStock,    color: 'text-red-500',    onClick: () => { setCatFilter('All'); setAvFilter('inactive'); } },
          { label: 'Physical Gifts', value: physicalCount, color: 'text-blue-600',   onClick: () => { setCatFilter('All'); setAvFilter('all'); } },
          { label: 'Vouchers',       value: voucherCount,  color: 'text-amber-600',  onClick: () => { setCatFilter('Vouchers'); setAvFilter('all'); } },
        ].map((s) => (
          <button
            key={s.label}
            onClick={s.onClick}
            className="bg-white rounded-xl border border-gray-100 p-4 text-left shadow-sm hover:shadow-md transition-shadow"
          >
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search gifts or brands…"
            className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {FILTER_CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCatFilter(c)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                catFilter === c
                  ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                  : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
              }`}
            >
              {c}
            </button>
          ))}
          <div className="h-6 w-px bg-gray-200 self-center mx-1" />
          {(['all', 'active', 'inactive'] as const).map((a) => (
            <button
              key={a}
              onClick={() => setAvFilter(a)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                avFilter === a
                  ? 'bg-[#1A1A2E] text-white border-[#1A1A2E]'
                  : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
              }`}
            >
              {a === 'all' ? 'All status' : a === 'active' ? 'Active only' : 'Out of stock'}
            </button>
          ))}
          {(search || catFilter !== 'All' || avFilter !== 'all') && (
            <button
              onClick={() => { setSearch(''); setCatFilter('All'); setAvFilter('all'); }}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-600 rounded-full border border-dashed border-gray-200"
            >
              <RefreshCw className="h-3 w-3" /> Reset
            </button>
          )}
        </div>
      </div>

      {/* Gifts grid */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 bg-white rounded-2xl border border-gray-100">
          <Gift className="h-10 w-10 text-gray-300 mb-3" />
          <p className="text-sm font-medium text-gray-500">No gifts found</p>
          <p className="text-xs text-gray-400 mt-1">Try adjusting your filters</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {filtered.map((gift) => {
            const statusCfg = STATUS_CONFIG[gift.available ? 'active' : 'inactive'];
            const isVoucher  = gift.category === 'Vouchers';
            const isFixed    = isVoucher && gift.voucherType === 'FIXED';
            const isFree     = isVoucher && gift.voucherType === 'FREE_AMOUNT';

            return (
              <div
                key={gift.id}
                className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden flex flex-col hover:shadow-md transition-shadow"
              >
                {/* Image */}
                <div className="relative">
                  <ImageBox item={gift} size="md" />
                  <div className="absolute top-2 left-2 flex flex-col gap-1">
                    {gift.popular && (
                      <span className="flex items-center gap-0.5 text-[9px] font-bold bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded-full">
                        <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" /> Popular
                      </span>
                    )}
                    {isFixed && (
                      <span className="flex items-center gap-0.5 text-[9px] font-bold bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded-full">
                        <Ticket className="h-2.5 w-2.5" /> Fixed
                      </span>
                    )}
                    {isFree && (
                      <span className="flex items-center gap-0.5 text-[9px] font-bold bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded-full">
                        <Ticket className="h-2.5 w-2.5" /> Custom
                      </span>
                    )}
                  </div>
                  <div className="absolute top-2 right-2">
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${statusCfg.cls}`}>
                      {statusCfg.label}
                    </span>
                  </div>
                </div>

                {/* Info */}
                <div className="p-3 flex-1 flex flex-col">
                  <div className="flex items-start justify-between gap-1">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-400 truncate">{gift.brand}</p>
                      <p className="text-sm font-semibold text-gray-900 leading-snug line-clamp-2 mt-0.5">
                        {gift.name}
                      </p>
                    </div>
                    <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full shrink-0 mt-0.5">
                      <Tag className="h-2.5 w-2.5 inline mr-0.5" />{gift.category}
                    </span>
                  </div>

                  <p className="text-[10px] text-gray-400 mt-1.5 line-clamp-2 leading-relaxed">{gift.description}</p>

                  {gift.features.length > 0 && (
                    <div className="mt-2 space-y-0.5">
                      {gift.features.slice(0, 2).map((f, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <Check className="h-2.5 w-2.5 text-[var(--brand-primary)] shrink-0" />
                          <span className="text-[10px] text-gray-500 truncate">{f}</span>
                        </div>
                      ))}
                      {gift.features.length > 2 && (
                        <p className="text-[10px] text-gray-400 pl-3.5">+{gift.features.length - 2} more</p>
                      )}
                    </div>
                  )}

                  <div className="mt-auto pt-3 border-t border-gray-50 flex items-center justify-between">
                    {isFree ? (
                      <span className="text-sm font-bold text-purple-600">Custom Amount</span>
                    ) : isFixed && gift.fixedAmount ? (
                      <div className="flex flex-col">
                        <span className="text-sm font-bold text-[var(--brand-primary)]">{formatPts(gift.points)} pts</span>
                        <span className="text-[10px] text-gray-400">Face value {fmtInr(gift.fixedAmount)}</span>
                      </div>
                    ) : (
                      <span className="text-sm font-bold text-[var(--brand-primary)]">{formatPts(gift.points)} pts</span>
                    )}
                    <span className="text-[10px] text-gray-400">
                      {new Date(gift.addedDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex border-t border-gray-100 divide-x divide-gray-100">
                  <button
                    onClick={() => openEdit(gift)}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    <Edit2 className="h-3.5 w-3.5" /> Edit
                  </button>
                  <button
                    onClick={() => toggleAvailability(gift.id)}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs transition-colors ${
                      gift.available
                        ? 'text-orange-500 hover:bg-orange-50'
                        : 'text-green-600 hover:bg-green-50'
                    }`}
                  >
                    {gift.available
                      ? <><ToggleRight className="h-3.5 w-3.5" /> Deactivate</>
                      : <><ToggleLeft className="h-3.5 w-3.5" /> Activate</>}
                  </button>
                  <button
                    onClick={() => setDeleting(gift)}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs text-red-500 hover:bg-red-50 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Info callout */}
      <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 flex items-start gap-3">
        <ImageIcon className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-blue-900">Physical gifts &amp; vouchers</p>
          <p className="text-xs text-blue-700 mt-0.5">
            Physical gifts require a fixed points cost. Vouchers can be <strong>Fixed</strong> (specific face value)
            or <strong>Free Amount</strong> (outlet enters any amount ≥ the minimum set in Gifsy Settings above).
            Add product photos for better outlet experience.
          </p>
        </div>
      </div>

      {/* Modals */}
      {modalOpen && (
        <GiftModal editing={editing} onSave={saveGift} onClose={() => setModalOpen(false)} />
      )}
      {deleting && (
        <DeleteModal gift={deleting} onConfirm={() => deleteGift(deleting.id)} onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}
