'use client';

/**
 * Employee Rewards — Hierarchy-levels editor (Phase A).
 *
 * Edits the tenant's sales-hierarchy level config: role codes, display names, which level
 * is the leaf (owns outlets) / root (no manager), and the SalesUser role each maps to.
 * Loads GET /api/admin/hierarchy-levels and saves PUT /api/admin/hierarchy-levels.
 *
 * Client-side validation MIRRORS the server rules (which return 400): non-empty; levels
 * contiguous 1..N (guaranteed here because level = row position); exactly one leaf; exactly
 * one root; unique roleCode (case-insensitive); valid userRole. The level number is derived
 * from row order, so reordering rows renumbers the levels automatically.
 *
 * Reached from the Overview's "Configure hierarchy levels" link — intentionally NOT a
 * top-level nav item (keeps the cockpit nav clean).
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Layers, Plus, Trash2, ArrowUp, ArrowDown, Save, Loader2,
  CheckCircle, AlertTriangle, X, ArrowLeft,
} from 'lucide-react';
import Link from 'next/link';
import { authHeader } from '@/lib/api-client';
import { DEOLEO_HIERARCHY } from '@/lib/employee-hierarchy';
import type { TenantHierarchyLevel, HierarchyUserRole } from '@/types';

/* ─── Editable row model (level is derived from position) ──────────────────────── */

interface LevelDraft {
  roleCode: string;
  roleLabel: string;
  isLeaf: boolean;
  isRoot: boolean;
  userRole: HierarchyUserRole | '';
}

const USER_ROLE_OPTIONS: HierarchyUserRole[] = [
  'SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR',
];

function toDraft(levels: TenantHierarchyLevel[]): LevelDraft[] {
  return [...levels]
    .sort((a, b) => a.level - b.level)
    .map((l) => ({
      roleCode: l.roleCode,
      roleLabel: l.roleLabel ?? l.roleCode,
      isLeaf: l.isLeaf,
      isRoot: l.isRoot,
      userRole: l.userRole ?? '',
    }));
}

/* ─── Client-side validation (mirror of the server rules) ──────────────────────── */

function validate(rows: LevelDraft[]): string[] {
  const errs: string[] = [];
  if (rows.length === 0) {
    errs.push('At least one level is required.');
    return errs;
  }
  // Unique, non-empty role codes (case-insensitive)
  const codes = rows.map((r) => r.roleCode.trim());
  if (codes.some((c) => c === '')) errs.push('Every level needs a role code.');
  const lower = codes.map((c) => c.toLowerCase());
  const dupes = lower.filter((c, i) => c !== '' && lower.indexOf(c) !== i);
  if (dupes.length > 0) {
    errs.push(`Role codes must be unique (case-insensitive). Duplicate: ${[...new Set(dupes)].join(', ')}.`);
  }
  // Exactly one leaf
  const leaves = rows.filter((r) => r.isLeaf).length;
  if (leaves !== 1) errs.push(`Exactly one level must be the leaf (owns outlets). Currently ${leaves}.`);
  // Exactly one root
  const roots = rows.filter((r) => r.isRoot).length;
  if (roots !== 1) errs.push(`Exactly one level must be the root (no manager). Currently ${roots}.`);
  // Mapped role is REQUIRED on every level (matches the server): without it a custom code falls back
  // to the field-rep default, silently collapsing managers to field reps.
  if (rows.some((r) => r.userRole === '')) {
    errs.push('Every level needs a mapped role — otherwise managers would be treated as field reps.');
  }
  if (rows.some((r) => r.userRole !== '' && !USER_ROLE_OPTIONS.includes(r.userRole as HierarchyUserRole))) {
    errs.push('One or more levels has an invalid mapped role.');
  }
  return errs;
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function HierarchyLevelsPage() {
  const [rows, setRows] = useState<LevelDraft[]>(toDraft(DEOLEO_HIERARCHY));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/hierarchy-levels', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.success && Array.isArray(j.data?.levels) && j.data.levels.length > 0) {
          setRows(toDraft(j.data.levels));
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const errors = useMemo(() => validate(rows), [rows]);
  const canSave = errors.length === 0 && !saving;

  /* ── Mutators ──────────────────────────────────────────────────────────────── */

  const update = (idx: number, patch: Partial<LevelDraft>) =>
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const setLeaf = (idx: number) =>
    setRows((rs) => rs.map((r, i) => ({ ...r, isLeaf: i === idx })));

  const setRoot = (idx: number) =>
    setRows((rs) => rs.map((r, i) => ({ ...r, isRoot: i === idx })));

  const addRow = () =>
    setRows((rs) => [...rs, { roleCode: '', roleLabel: '', isLeaf: false, isRoot: false, userRole: '' }]);

  const removeRow = (idx: number) =>
    setRows((rs) => rs.filter((_, i) => i !== idx));

  const move = (idx: number, dir: -1 | 1) =>
    setRows((rs) => {
      const j = idx + dir;
      if (j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });

  /* ── Save ──────────────────────────────────────────────────────────────────── */

  const save = async () => {
    setError(null);
    setSuccess(null);
    if (errors.length > 0) { setError(errors[0]); return; }
    setSaving(true);

    // Level = position (1..N) → contiguous by construction. roleLabel defaults to roleCode
    // server-side; userRole omitted when unset (it is optional).
    const payloadLevels = rows.map((r, i) => {
      const base: {
        level: number; roleCode: string; roleLabel?: string;
        isLeaf: boolean; isRoot: boolean; userRole?: HierarchyUserRole;
      } = {
        level: i + 1,
        roleCode: r.roleCode.trim(),
        roleLabel: r.roleLabel.trim() || r.roleCode.trim(),
        isLeaf: r.isLeaf,
        isRoot: r.isRoot,
      };
      if (r.userRole !== '') base.userRole = r.userRole;
      return base;
    });

    try {
      const res = await fetch('/api/admin/hierarchy-levels', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ levels: payloadLevels }),
      });
      let json: { success?: boolean; error?: string; message?: string; data?: { levels?: TenantHierarchyLevel[] } } = {};
      try { json = await res.json(); } catch { /* non-JSON — fall through */ }

      if (!res.ok || json.success === false) {
        throw new Error(json.error || json.message || `Save failed (HTTP ${res.status}).`);
      }
      // Re-seed from the server's canonical response when present.
      if (Array.isArray(json.data?.levels) && json.data.levels.length > 0) {
        setRows(toDraft(json.data.levels));
      }
      setSuccess('Hierarchy levels saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  /* ── Render ──────────────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/admin/overview" className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
          <ArrowLeft className="h-4 w-4 text-gray-600" />
        </Link>
        <div className="flex-1">
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Layers className="h-5 w-5 text-[var(--brand-primary)]" />
            Hierarchy Levels
          </h1>
          <p className="text-xs text-gray-500">
            Define the sales hierarchy: role codes, display names, leaf / root, and mapped role.
          </p>
        </div>
        <button
          data-testid="save-levels"
          onClick={save}
          disabled={!canSave}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[var(--brand-primary)] text-white text-xs font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {/* Success banner */}
      {success && (
        <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
          <CheckCircle className="h-4 w-4 text-emerald-600 flex-shrink-0" />
          <p className="text-sm text-emerald-800 font-medium">{success}</p>
          <button onClick={() => setSuccess(null)} className="ml-auto p-1 rounded hover:bg-emerald-100 text-emerald-600">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <AlertTriangle className="h-4 w-4 text-red-600 flex-shrink-0" />
          <p className="text-sm text-red-700 font-medium">{error}</p>
          <button onClick={() => setError(null)} className="ml-auto p-1 rounded hover:bg-red-100 text-red-600">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Validation issues (live) */}
      {!loading && errors.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 space-y-1">
          <p className="text-xs font-semibold text-amber-800">Fix before saving:</p>
          {errors.map((e, i) => (
            <p key={i} className="text-xs text-amber-700">• {e}</p>
          ))}
        </div>
      )}

      {/* Levels table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500 w-14">Level</th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500">Role code</th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500">Display name</th>
                <th className="text-center px-3 py-2 text-xs font-semibold text-gray-500 w-16">Leaf</th>
                <th className="text-center px-3 py-2 text-xs font-semibold text-gray-500 w-16">Root</th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500">Mapped role</th>
                <th className="px-3 py-2 w-24"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rows.map((row, idx) => (
                <tr key={idx} data-testid="level-row" className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-500 text-xs">L{idx + 1}</td>
                  <td className="px-3 py-2">
                    <input
                      data-testid={`role-code-${idx}`}
                      value={row.roleCode}
                      onChange={(e) => update(idx, { roleCode: e.target.value })}
                      placeholder="e.g. XSR"
                      className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm font-mono outline-none focus:border-[var(--brand-primary)]"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      data-testid={`role-label-${idx}`}
                      value={row.roleLabel}
                      onChange={(e) => update(idx, { roleLabel: e.target.value })}
                      placeholder="(defaults to code)"
                      className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-[var(--brand-primary)]"
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input
                      type="radio"
                      name="leaf"
                      aria-label={`Set level ${idx + 1} as leaf`}
                      checked={row.isLeaf}
                      onChange={() => setLeaf(idx)}
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input
                      type="radio"
                      name="root"
                      aria-label={`Set level ${idx + 1} as root`}
                      checked={row.isRoot}
                      onChange={() => setRoot(idx)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      data-testid={`user-role-${idx}`}
                      value={row.userRole}
                      onChange={(e) => update(idx, { userRole: e.target.value as HierarchyUserRole | '' })}
                      className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white outline-none focus:border-[var(--brand-primary)]"
                    >
                      <option value="">— none —</option>
                      {USER_ROLE_OPTIONS.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => move(idx, -1)}
                        disabled={idx === 0}
                        aria-label="Move up"
                        className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => move(idx, 1)}
                        disabled={idx === rows.length - 1}
                        aria-label="Move down"
                        className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        data-testid={`remove-${idx}`}
                        onClick={() => removeRow(idx)}
                        disabled={rows.length <= 1}
                        aria-label="Remove level"
                        className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loading && (
          <div className="px-3 py-3 border-t border-gray-100">
            <button
              type="button"
              data-testid="add-level"
              onClick={addRow}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 bg-white text-gray-700 text-xs font-semibold hover:bg-gray-50 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              Add level
            </button>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400">
        Level 1 is the leaf (owns outlets); the highest level is the root (no reporting manager).
        Use the arrows to reorder — levels renumber automatically.
      </p>
    </div>
  );
}
