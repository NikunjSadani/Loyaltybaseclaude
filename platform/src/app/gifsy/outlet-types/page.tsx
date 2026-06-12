'use client';

import { useState } from 'react';
import { Tag, Plus, Pencil, Check, X, ToggleLeft, ToggleRight } from 'lucide-react';
import {
  MASTER_OUTLET_TYPES,
  applyOutletTypeRename,
  applyOutletTypeToggle,
  type OutletType,
} from '@/lib/platform/outlet-types';

export default function OutletTypesPage() {
  const [types, setTypes]           = useState<OutletType[]>(MASTER_OUTLET_TYPES);
  const [renamingCode, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameVal] = useState('');
  const [addingNew, setAddingNew]   = useState(false);
  const [newCode, setNewCode]       = useState('');
  const [newName, setNewName]       = useState('');
  const [newDesc, setNewDesc]       = useState('');

  // ── Rename ────────────────────────────────────────────────────────────────

  function startRename(t: OutletType) {
    setRenaming(t.code);
    setRenameVal(t.name);
  }

  function commitRename() {
    if (!renamingCode || !renameValue.trim()) return;
    setTypes(applyOutletTypeRename(types, renamingCode, renameValue.trim(), 'GIFSY_ADMIN'));
    setRenaming(null);
  }

  function cancelRename() {
    setRenaming(null);
    setRenameVal('');
  }

  // ── Toggle ────────────────────────────────────────────────────────────────

  function toggleType(code: string, isActive: boolean) {
    setTypes(applyOutletTypeToggle(types, code, isActive, 'GIFSY_ADMIN'));
  }

  // ── Add new ───────────────────────────────────────────────────────────────

  function commitAdd() {
    const code = newCode.trim().toUpperCase().replace(/\s+/g, '_');
    const name = newName.trim();
    if (!code || !name) return;
    setTypes([...types, { code, name, description: newDesc.trim(), isActive: true, createdAt: new Date().toISOString().slice(0, 10) }]);
    setAddingNew(false);
    setNewCode('');
    setNewName('');
    setNewDesc('');
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-white" role="heading">Outlet Types</h1>
          <p className="text-sm text-white/50 mt-0.5">
            Global master list of outlet types across the platform.
          </p>
        </div>
        <button
          onClick={() => setAddingNew(true)}
          className="flex items-center gap-1.5 px-3 py-2 bg-[var(--brand-primary)] text-white text-xs font-medium rounded-lg hover:opacity-90 transition-opacity"
          aria-label="Add Outlet Type"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Outlet Type
        </button>
      </div>

      {/* Info note */}
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-3 text-xs text-blue-300 flex items-start gap-2">
        <Tag className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          The <strong>code</strong> is a stable identifier and never changes.
          The <strong>name</strong> can be renamed any time without affecting existing data.
        </span>
      </div>

      {/* Add new form */}
      {addingNew && (
        <div className="border border-white/20 rounded-xl p-5 bg-white/5 space-y-4">
          <p className="text-sm font-semibold text-white">New Outlet Type</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="new-code" className="block text-xs text-white/50 mb-1">Code</label>
              <input
                id="new-code"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                placeholder="e.g. MODERN_TRADE"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
                aria-label="code"
              />
            </div>
            <div>
              <label htmlFor="new-name" className="block text-xs text-white/50 mb-1">Display Name</label>
              <input
                id="new-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Modern Trade"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
              />
            </div>
          </div>
          <div>
            <label htmlFor="new-desc" className="block text-xs text-white/50 mb-1">Description (optional)</label>
            <input
              id="new-desc"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Brief description"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={commitAdd}
              className="flex items-center gap-1.5 px-3 py-2 bg-[var(--brand-primary)] text-white text-xs font-medium rounded-lg hover:opacity-90"
            >
              <Check className="w-3.5 h-3.5" />Save
            </button>
            <button
              onClick={() => setAddingNew(false)}
              className="flex items-center gap-1.5 px-3 py-2 border border-white/10 text-white/60 text-xs font-medium rounded-lg hover:text-white hover:border-white/20"
            >
              <X className="w-3.5 h-3.5" />Cancel
            </button>
          </div>
        </div>
      )}

      {/* Outlet type list */}
      <div className="space-y-2">
        {types.map((t) => (
          <div
            key={t.code}
            className="border border-white/10 rounded-xl px-5 py-4 bg-white/5 flex items-center gap-4"
          >
            {/* Code chip — only shown when code differs from current name */}
            <div className="shrink-0 w-36">
              {t.code !== t.name && (
                <span className="font-mono text-xs text-white/40 bg-white/5 border border-white/10 px-2 py-1 rounded-md">
                  {t.code}
                </span>
              )}
            </div>

            {/* Name (or rename input) */}
            <div className="flex-1 min-w-0">
              {renamingCode === t.code ? (
                <div className="flex items-center gap-2">
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameVal(e.target.value)}
                    className="bg-white/5 border border-white/20 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-white/40 w-48"
                    autoFocus
                  />
                  <button
                    onClick={commitRename}
                    className="flex items-center gap-1 px-2 py-1.5 bg-[var(--brand-primary)] text-white text-xs font-medium rounded-lg hover:opacity-90"
                    aria-label="save"
                  >
                    <Check className="w-3.5 h-3.5" />Save
                  </button>
                  <button
                    onClick={cancelRename}
                    className="flex items-center gap-1 px-2 py-1.5 border border-white/10 text-white/50 text-xs font-medium rounded-lg hover:text-white"
                    aria-label="cancel"
                  >
                    <X className="w-3.5 h-3.5" />Cancel
                  </button>
                </div>
              ) : (
                <div>
                  <p className="text-sm font-semibold text-white">{t.name}</p>
                  {t.description && (
                    <p className="text-xs text-white/40 mt-0.5">{t.description}</p>
                  )}
                </div>
              )}
            </div>

            {/* Status badge */}
            <span className={`shrink-0 text-xs font-medium px-2.5 py-1 rounded-full ${
              t.isActive
                ? 'bg-green-500/15 text-green-400 border border-green-500/20'
                : 'bg-red-500/15 text-red-400 border border-red-500/20'
            }`}>
              {t.isActive ? 'Active' : 'Inactive'}
            </span>

            {/* Actions */}
            <div className="shrink-0 flex items-center gap-2">
              {renamingCode !== t.code && (
                <button
                  onClick={() => startRename(t)}
                  className="flex items-center gap-1 px-2.5 py-1.5 border border-white/10 text-white/50 text-xs font-medium rounded-lg hover:text-white hover:border-white/20 transition-colors"
                  aria-label="rename"
                >
                  <Pencil className="w-3 h-3" />Rename
                </button>
              )}
              <button
                onClick={() => toggleType(t.code, !t.isActive)}
                className={`flex items-center gap-1 px-2.5 py-1.5 border text-xs font-medium rounded-lg transition-colors ${
                  t.isActive
                    ? 'border-red-500/20 text-red-400 hover:bg-red-500/10'
                    : 'border-green-500/20 text-green-400 hover:bg-green-500/10'
                }`}
                aria-label={t.isActive ? 'Deactivate' : 'Activate'}
              >
                {t.isActive
                  ? <><ToggleLeft className="w-3.5 h-3.5" />Deactivate</>
                  : <><ToggleRight className="w-3.5 h-3.5" />Activate</>
                }
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Footer note */}
      <p className="text-xs text-white/30 text-center">
        Per-tenant outlet type configuration is managed in each client&apos;s detail page.
      </p>
    </div>
  );
}
