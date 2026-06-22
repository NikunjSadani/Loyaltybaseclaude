'use client';

/**
 * Admin KPI Management page — FE-A (Targets / Stream T).
 *
 * Backed by the real KpiDef CRUD endpoints:
 *
 *   GET    /api/admin/kpis                → KpiDef[]
 *   POST   /api/admin/kpis                → upsert by (clientId, code)
 *   DELETE /api/admin/kpis/:id            → { deleted: id }
 *   POST   /api/admin/kpis/:id/set-primary → atomically demote others + set this primary
 *   POST   /api/admin/kpis/seed-defaults  → { seeded, skippedReason? }
 *
 * Primary KPI is single-select: it is chosen ONLY via the radio control in the
 * KPI list (which calls set-primary), never via the add/edit form. A DB
 * constraint enforces at-most-one primary, so "two primaries" cannot be expressed.
 *
 * UI shell / styling is preserved; only the data layer changes.
 */

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Plus, Trash2, Edit2, X, Target, Upload,
  FileSpreadsheet, ArrowRight, CheckCircle, AlertCircle,
  Layers, ChevronDown, ChevronUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api-client';

/* ─── Types (mirror backend KpiDef) ─────────────────────────────────────────── */

export interface KpiDef {
  id:                string;
  code:              string;
  label:             string;
  unit:              string;
  isPrimary:         boolean;
  hasNameOverride:   boolean;
  nameOverrideLabel: string | null;
  order:             number;
  enabled:           boolean;
}

type UpsertPayload = Omit<KpiDef, 'id'>;

/* ─── Blank form ─────────────────────────────────────────────────────────────── */

function blankForm(order: number): UpsertPayload {
  return {
    code:              '',
    label:             '',
    unit:              'cases',
    isPrimary:         false,
    hasNameOverride:   false,
    nameOverrideLabel: null,
    order,
    enabled:           true,
  };
}

/* ─── KPI row ────────────────────────────────────────────────────────────────── */

function KpiRow({
  kpi,
  onEdit,
  onDelete,
  onSetPrimary,
  settingPrimary,
}: {
  kpi: KpiDef;
  onEdit: (k: KpiDef) => void;
  onDelete: (id: string) => void;
  onSetPrimary: (id: string) => void;
  settingPrimary: boolean;
}) {
  return (
    <tr className={`text-sm border-b border-gray-50 ${!kpi.enabled ? 'opacity-50' : ''}`}>
      <td className="py-2.5 pl-5 pr-2 text-center">
        <label
          className={`inline-flex items-center justify-center ${settingPrimary ? 'cursor-not-allowed' : 'cursor-pointer'}`}
          title={kpi.isPrimary ? 'Primary KPI' : 'Make this the Primary KPI'}
        >
          <input
            type="radio"
            name="primary-kpi"
            checked={kpi.isPrimary}
            disabled={settingPrimary}
            onChange={() => { if (!kpi.isPrimary) onSetPrimary(kpi.id); }}
            aria-label={`Set ${kpi.label} as the Primary KPI`}
            className="h-4 w-4 accent-[var(--brand-primary)] disabled:opacity-50"
          />
        </label>
      </td>
      <td className="py-2.5 pl-2 pr-2 font-mono text-xs text-gray-500">{kpi.code}</td>
      <td className="py-2.5 px-2 font-medium text-gray-900">
        {kpi.label}
        {kpi.isPrimary && (
          <span className="ml-1.5 text-[10px] font-bold bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
            Primary
          </span>
        )}
        {kpi.hasNameOverride && (
          <span className="ml-1 text-[10px] font-semibold bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
            Override: {kpi.nameOverrideLabel}
          </span>
        )}
      </td>
      <td className="py-2.5 px-2 text-xs text-gray-400">{kpi.unit}</td>
      <td className="py-2.5 px-2 text-xs text-center">
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${kpi.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
          {kpi.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </td>
      <td className="py-2.5 px-2 text-xs text-gray-400 text-right">{kpi.order}</td>
      <td className="py-2.5 pl-2 pr-4 text-right">
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={() => onEdit(kpi)}
            title="Edit"
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors"
          >
            <Edit2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onDelete(kpi.id)}
            title="Delete"
            className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}

/* ─── Add / Edit form ────────────────────────────────────────────────────────── */

function KpiForm({
  initial,
  onSave,
  onCancel,
  saving,
  error,
}: {
  initial: UpsertPayload & { id?: string };
  onSave:  (payload: UpsertPayload) => void;
  onCancel: () => void;
  saving: boolean;
  error: string;
}) {
  const [form, setForm] = useState<UpsertPayload>({ ...initial });

  const set = <K extends keyof UpsertPayload>(k: K, v: UpsertPayload[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  const isEdit = !!initial.id;

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-2xl p-5 space-y-4">
      <p className="text-sm font-bold text-gray-900">{isEdit ? 'Edit KPI' : 'Add KPI'}</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Code */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">Code *</label>
          <input
            value={form.code}
            onChange={e => set('code', e.target.value.toUpperCase())}
            disabled={isEdit}
            placeholder="e.g. MONTH_TGT"
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm disabled:bg-gray-100 disabled:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
          />
          {isEdit && <p className="text-[10px] text-gray-400 mt-0.5">Code cannot be changed after creation.</p>}
        </div>

        {/* Label */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">Label *</label>
          <input
            value={form.label}
            onChange={e => set('label', e.target.value)}
            placeholder="e.g. Month Target"
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
          />
        </div>

        {/* Unit */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">Unit</label>
          <input
            value={form.unit}
            onChange={e => set('unit', e.target.value)}
            placeholder="cases"
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
          />
        </div>

        {/* Order */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">Order</label>
          <input
            type="number"
            value={form.order}
            onChange={e => set('order', Number(e.target.value))}
            min={1}
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
          />
        </div>
      </div>

      {/* Checkboxes — Primary is NOT set here; it is a single-select chosen via
          the radio in the KPI list (set-primary endpoint + DB constraint). */}
      <div className="flex flex-wrap gap-5">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.hasNameOverride}
            onChange={e => set('hasNameOverride', e.target.checked)}
            className="rounded"
          />
          <span className="text-xs text-gray-700 font-medium">Has name-override column</span>
        </label>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={e => set('enabled', e.target.checked)}
            className="rounded"
          />
          <span className="text-xs text-gray-700 font-medium">Enabled</span>
        </label>
      </div>

      {/* Name-override label */}
      {form.hasNameOverride && (
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">Override column label</label>
          <input
            value={form.nameOverrideLabel ?? ''}
            onChange={e => set('nameOverrideLabel', e.target.value || null)}
            placeholder={`${form.label || 'KPI'} Name`}
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
          />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          variant="primary"
          loading={saving}
          disabled={!form.code.trim() || !form.label.trim()}
          onClick={() => onSave(form)}
        >
          <CheckCircle className="h-4 w-4" />
          {isEdit ? 'Save Changes' : 'Add KPI'}
        </Button>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function AdminTargetsPage() {
  const [kpis,      setKpis]      = useState<KpiDef[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [pageError, setPageError] = useState('');

  const [formOpen,  setFormOpen]  = useState(false);
  const [editing,   setEditing]   = useState<KpiDef | null>(null);
  const [saving,    setSaving]    = useState(false);
  const [saveError, setSaveError] = useState('');

  const [seeding,   setSeeding]   = useState(false);
  const [seedMsg,   setSeedMsg]   = useState('');

  const [settingPrimary, setSettingPrimary] = useState(false);
  const [primaryError,   setPrimaryError]   = useState('');

  const [showEnabled, setShowEnabled] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [expandHelp, setExpandHelp]  = useState(false);

  /* ── Load ─────────────────────────────────────────────────────────────────── */

  const reload = useCallback(async () => {
    setLoading(true);
    setPageError('');
    const res = await api.get<KpiDef[]>('/api/admin/kpis');
    if (res.success) {
      setKpis(res.data);
    } else {
      setPageError(res.error ?? 'Failed to load KPIs');
    }
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  /* ── Upsert ───────────────────────────────────────────────────────────────── */

  const handleSave = async (payload: UpsertPayload) => {
    setSaving(true);
    setSaveError('');
    const res = await api.post<KpiDef>('/api/admin/kpis', payload);
    if (res.success) {
      setFormOpen(false);
      setEditing(null);
      await reload();
    } else {
      setSaveError(res.error ?? 'Save failed');
    }
    setSaving(false);
  };

  /* ── Delete ───────────────────────────────────────────────────────────────── */

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this KPI? This cannot be undone.')) return;
    const res = await api.del<{ deleted: string }>(`/api/admin/kpis/${id}`);
    if (res.success) {
      await reload();
    } else {
      alert(res.error ?? 'Delete failed');
    }
  };

  /* ── Set primary (single-select; atomic on the server) ───────────────────── */

  const handleSetPrimary = async (id: string) => {
    setSettingPrimary(true);
    setPrimaryError('');
    const res = await api.post<KpiDef>(`/api/admin/kpis/${id}/set-primary`, {});
    if (res.success) {
      // Reload so the badge/summary reflect the server's atomic demote+promote.
      await reload();
    } else {
      // Do NOT optimistically move the badge — surface the error and leave the
      // previously-reloaded list (with the old primary) intact.
      setPrimaryError(res.error ?? 'Failed to set primary KPI');
    }
    setSettingPrimary(false);
  };

  /* ── Seed defaults ────────────────────────────────────────────────────────── */

  const handleSeed = async () => {
    setSeeding(true);
    setSeedMsg('');
    const res = await api.post<{ seeded: number; skippedReason?: string }>(
      '/api/admin/kpis/seed-defaults',
      {},
    );
    if (res.success) {
      const { seeded, skippedReason } = res.data;
      setSeedMsg(skippedReason ?? `Seeded ${seeded} KPI(s).`);
      await reload();
    } else {
      setSeedMsg(res.error ?? 'Seed failed');
    }
    setSeeding(false);
  };

  /* ── Filtered view ────────────────────────────────────────────────────────── */

  const filtered = kpis.filter(k => {
    if (showEnabled === 'enabled')  return k.enabled;
    if (showEnabled === 'disabled') return !k.enabled;
    return true;
  });

  const enabledCount  = kpis.filter(k => k.enabled).length;
  const primaryKpi    = kpis.find(k => k.isPrimary);

  /* ── Helpers for form initial state ──────────────────────────────────────── */

  const nextOrder = Math.max(...kpis.map(k => k.order), 0) + 1;

  return (
    <div className="space-y-6">

      {/* ── Excel Upload Banner ─────────────────────────────────────────────── */}
      <Link
        href="/admin/targets/upload"
        className="flex items-center justify-between gap-4 px-5 py-4 rounded-2xl border-2 border-[var(--brand-primary)]/30 bg-[var(--brand-primary)]/5 hover:bg-[var(--brand-primary)]/10 hover:border-[var(--brand-primary)]/50 transition-colors group"
      >
        <div className="flex items-center gap-4">
          <div className="p-2.5 rounded-xl bg-[var(--brand-primary)]/10 shrink-0">
            <FileSpreadsheet className="h-6 w-6 text-[var(--brand-primary)]" />
          </div>
          <div>
            <p className="text-sm font-bold text-gray-900">Upload Targets via Excel</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Download a template pre-filled with the outlet roster and upload targets in bulk.
            </p>
          </div>
        </div>
        <ArrowRight className="h-5 w-5 text-[var(--brand-primary)] shrink-0 group-hover:translate-x-1 transition-transform" />
      </Link>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">KPI Management</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Define the tenant KPI catalogue. KPIs here drive the Excel template columns and upload validation.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <Button
            variant="outline"
            loading={seeding}
            onClick={handleSeed}
            title="Seed Deoleo default KPIs (no-op if any KPIs already exist)"
          >
            <Layers className="h-4 w-4" />
            Seed Defaults
          </Button>
          <Button
            variant="primary"
            onClick={() => { setEditing(null); setFormOpen(v => !v); setSaveError(''); }}
          >
            <Plus className="h-4 w-4" />
            {formOpen && !editing ? 'Cancel' : 'Add KPI'}
          </Button>
        </div>
      </div>

      {/* Seed message */}
      {seedMsg && (
        <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5 text-sm text-blue-700">
          <CheckCircle className="h-4 w-4 shrink-0" /> {seedMsg}
        </div>
      )}

      {/* Set-primary error */}
      {primaryError && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" /> {primaryError}
        </div>
      )}

      {/* ── Help accordion ─────────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-sm">
        <button
          onClick={() => setExpandHelp(v => !v)}
          className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-gray-50 transition-colors"
        >
          <p className="text-xs font-semibold text-gray-600">What is a KPI? How does this work?</p>
          {expandHelp
            ? <ChevronUp className="h-4 w-4 text-gray-400" />
            : <ChevronDown className="h-4 w-4 text-gray-400" />}
        </button>
        {expandHelp && (
          <div className="border-t border-gray-100 px-5 py-4 text-xs text-gray-500 space-y-1.5">
            <p>Each KPI (Key Performance Indicator) defines one column in the Excel template.</p>
            <p>The <strong>Code</strong> is a stable machine key (e.g. <code>MONTH_TGT</code>). The <strong>Label</strong> is shown to partners.</p>
            <p>Mark one KPI as <strong>Primary</strong> — it becomes the headline metric on partner dashboards.</p>
            <p>Enable <strong>Has name-override column</strong> if each outlet can have a different display name for that KPI (e.g. Focus Pack 1 Name).</p>
            <p><strong>Seed Defaults</strong> pre-fills the Deoleo default KPI set (no-op if any KPIs already exist).</p>
          </div>
        )}
      </div>

      {/* ── Add/Edit form ──────────────────────────────────────────────────── */}
      {formOpen && !editing && (
        <KpiForm
          initial={blankForm(nextOrder)}
          onSave={handleSave}
          onCancel={() => { setFormOpen(false); setSaveError(''); }}
          saving={saving}
          error={saveError}
        />
      )}

      {editing && (
        <KpiForm
          initial={{ ...editing }}
          onSave={handleSave}
          onCancel={() => { setEditing(null); setSaveError(''); }}
          saving={saving}
          error={saveError}
        />
      )}

      {/* ── KPI table ──────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        {/* Sub-header */}
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-gray-100 flex-wrap">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-gray-400" />
            <span className="text-sm font-semibold text-gray-700">
              {kpis.length} KPI{kpis.length !== 1 ? 's' : ''} ·{' '}
              {enabledCount} enabled
              {kpis.length > 0
                ? ` · Primary: ${primaryKpi ? primaryKpi.label : '— none —'}`
                : ''}
            </span>
          </div>

          {/* Filter chips */}
          <div className="flex items-center gap-1 bg-gray-100 rounded-full p-1">
            {(['all', 'enabled', 'disabled'] as const).map(v => (
              <button
                key={v}
                onClick={() => setShowEnabled(v)}
                className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors capitalize
                  ${showEnabled === v ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
              >
                {v === 'all' ? 'All' : v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Spinner size="lg" />
          </div>
        ) : pageError ? (
          <div className="flex items-center gap-2 px-5 py-4 text-sm text-red-600">
            <AlertCircle className="h-4 w-4 shrink-0" /> {pageError}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center px-4">
            <Target className="h-10 w-10 text-gray-200" />
            <p className="text-sm font-semibold text-gray-400">
              {kpis.length === 0 ? 'No KPIs defined yet.' : 'No KPIs match the current filter.'}
            </p>
            {kpis.length === 0 && (
              <p className="text-xs text-gray-300">
                Click <strong>Seed Defaults</strong> to load the Deoleo standard KPI set, or add your own with <strong>+ Add KPI</strong>.
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide bg-gray-50">
                  <th className="py-2.5 pl-5 pr-2 text-center">Primary</th>
                  <th className="py-2.5 pl-2 pr-2">Code</th>
                  <th className="py-2.5 px-2">Label</th>
                  <th className="py-2.5 px-2">Unit</th>
                  <th className="py-2.5 px-2 text-center">Status</th>
                  <th className="py-2.5 px-2 text-right">Order</th>
                  <th className="py-2.5 pl-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {filtered
                  .slice()
                  .sort((a, b) => a.order - b.order)
                  .map(kpi => (
                    editing?.id === kpi.id ? null : (
                      <KpiRow
                        key={kpi.id}
                        kpi={kpi}
                        onEdit={k => { setEditing(k); setFormOpen(false); setSaveError(''); }}
                        onDelete={handleDelete}
                        onSetPrimary={handleSetPrimary}
                        settingPrimary={settingPrimary}
                      />
                    )
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Upload shortcut footer */}
      <div className="flex items-center justify-center gap-2 py-2 text-xs text-gray-400">
        <Upload className="h-3.5 w-3.5" />
        Once your KPIs are set, go to{' '}
        <Link href="/admin/targets/upload" className="text-[var(--brand-primary)] hover:underline font-semibold">
          Upload Targets
        </Link>{' '}
        to download the template and bulk-upload target values.
      </div>
    </div>
  );
}
