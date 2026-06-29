'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  ToggleRight,
  ToggleLeft,
  Settings2,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  Check,
  Loader2,
} from 'lucide-react';
import { useAdminSession } from '@/lib/admin-session';
import type { CreditField, FieldAwardType } from '@/types';

const OUTLET_TYPES = ['WHOLESALER', 'SSS', 'SUB_STOCKIST', 'SSS_TOT'] as const;
const AWARD_OPTIONS: readonly FieldAwardType[] = ['POINTS', 'PAYOUT', 'NA'];
const OUTLET_TYPE_LABELS: Record<string, string> = {
  WHOLESALER:   'Wholesaler',
  SSS:          'SSS',
  SUB_STOCKIST: 'Sub-Stockist',
  SSS_TOT:      'SSS TOT',
};
const AWARD_COLORS: Record<FieldAwardType, string> = {
  POINTS: 'bg-blue-100 text-blue-700',
  PAYOUT: 'bg-emerald-100 text-emerald-700',
  NA:     'bg-gray-100 text-gray-500',
};

type SaveState = 'idle' | 'confirm' | 'saving' | 'saved' | 'error';

/** Current saved award for an outlet type on a field (defaults to NA). */
function awardFor(f: CreditField, ot: string): FieldAwardType {
  return ((f.outletTypeAwards as Record<string, string>)[ot] ?? 'NA') as FieldAwardType;
}

/**
 * A money-path-sensitive change is any flip between POINTS and PAYOUT in either
 * direction (POINTS routes to the wallet, PAYOUT to the bank file). Moving to or
 * from NA is NOT money-path sensitive and needs no confirm.
 */
function isMoneyPathFlip(prev: FieldAwardType, next: FieldAwardType): boolean {
  return (
    (prev === 'POINTS' && next === 'PAYOUT') ||
    (prev === 'PAYOUT' && next === 'POINTS')
  );
}

/**
 * One field row: collapsed shows the read-only badges; expanded reveals an inline
 * per-outlet-type award editor (POINTS / PAYOUT / NA segmented control) + Save.
 */
function FieldRow({
  field,
  onToggleActive,
  onSaved,
}: {
  field: CreditField;
  onToggleActive: (f: CreditField) => void;
  onSaved: () => void | Promise<void>;
}) {
  const [open,  setOpen]  = useState(false);
  const [draft, setDraft] = useState<Record<string, FieldAwardType>>({});
  const [state, setState] = useState<SaveState>('idle');
  const [errMsg, setErrMsg] = useState('');

  // Outlet types whose award changes between POINTS and PAYOUT vs the saved value.
  const flippedTypes = OUTLET_TYPES.filter((ot) =>
    isMoneyPathFlip(awardFor(field, ot), draft[ot] ?? awardFor(field, ot)),
  );

  function expand() {
    if (!open) {
      // Initialise the draft from the saved map every time we open.
      const init: Record<string, FieldAwardType> = {};
      for (const ot of OUTLET_TYPES) init[ot] = awardFor(field, ot);
      setDraft(init);
      setState('idle');
      setErrMsg('');
    }
    setOpen((o) => !o);
  }

  function setAward(ot: string, value: FieldAwardType) {
    setDraft((d) => ({ ...d, [ot]: value }));
    // Editing after a confirm prompt or error resets back to idle.
    if (state === 'confirm' || state === 'error' || state === 'saved') setState('idle');
  }

  async function persist() {
    setState('saving');
    setErrMsg('');
    // Send the full map for all outlet types.
    const outletTypeAwards: Record<string, FieldAwardType> = {};
    for (const ot of OUTLET_TYPES) outletTypeAwards[ot] = draft[ot] ?? awardFor(field, ot);
    try {
      const res = await fetch(`/api/admin/credits/fields/${field.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outletTypeAwards }),
      });
      const json = await res.json();
      if (!json.success) {
        setErrMsg(json.error ?? 'Failed to save award map.');
        setState('error');
        return;
      }
      setState('saved');
      await onSaved();
    } catch (e) {
      setErrMsg(String(e));
      setState('error');
    }
  }

  function handleSave() {
    // If any money-path flip is pending, require an inline confirm first.
    if (flippedTypes.length > 0 && state !== 'confirm') {
      setState('confirm');
      return;
    }
    persist();
  }

  return (
    <div data-field-row={field.id} className={!field.isActive ? 'opacity-50' : ''}>
      <div className="flex items-center gap-4 px-5 py-4">
        <span className="w-6 h-6 rounded-full bg-gray-100 text-gray-500 text-xs flex items-center justify-center font-mono flex-shrink-0">
          {field.order}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-900">{field.name}</span>
            {field.isSeparatePayout && (
              <span className="text-xs bg-purple-100 text-purple-700 rounded-full px-2 py-0.5">
                Separate
              </span>
            )}
            {!field.isActive && (
              <span className="text-xs bg-gray-100 text-gray-500 rounded-full px-2 py-0.5">
                Deactivated
              </span>
            )}
          </div>
          {/* Read-only badges (always visible) */}
          <div className="flex gap-1.5 mt-1.5 flex-wrap">
            {OUTLET_TYPES.map((ot) => {
              const award = awardFor(field, ot);
              return (
                <span
                  key={ot}
                  className={`text-xs rounded-full px-2 py-0.5 ${AWARD_COLORS[award]}`}
                >
                  {OUTLET_TYPE_LABELS[ot]}: {award}
                </span>
              );
            })}
          </div>
        </div>

        <button
          onClick={() => onToggleActive(field)}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800 transition-colors"
          title={field.isActive ? 'Deactivate' : 'Reactivate'}
        >
          {field.isActive
            ? <ToggleRight className="w-5 h-5 text-emerald-500" />
            : <ToggleLeft  className="w-5 h-5 text-gray-400" />
          }
          <span>{field.isActive ? 'Active' : 'Inactive'}</span>
        </button>

        <button
          onClick={expand}
          aria-label={open ? 'Collapse award editor' : 'Edit award map'}
          aria-expanded={open}
          className="text-gray-400 hover:text-gray-700 transition-colors flex-shrink-0"
        >
          {open
            ? <ChevronDown  className="w-4 h-4" />
            : <ChevronRight className="w-4 h-4" />
          }
        </button>
      </div>

      {/* Inline award-map editor */}
      {open && (
        <div className="px-5 pb-4 -mt-1">
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-3">
            <p className="text-xs font-semibold text-gray-700">Award per outlet type</p>
            <div className="space-y-2">
              {OUTLET_TYPES.map((ot) => {
                const value = draft[ot] ?? awardFor(field, ot);
                return (
                  <div key={ot} className="flex items-center justify-between gap-3">
                    <span className="text-xs text-gray-600 w-28 flex-shrink-0">
                      {OUTLET_TYPE_LABELS[ot]}
                    </span>
                    <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden bg-white">
                      {AWARD_OPTIONS.map((opt) => {
                        const active = value === opt;
                        return (
                          <button
                            key={opt}
                            type="button"
                            aria-pressed={active}
                            onClick={() => setAward(ot, opt)}
                            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                              active
                                ? 'bg-[var(--brand-primary)] text-white'
                                : 'text-gray-600 hover:bg-gray-100'
                            }`}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Money-path confirm */}
            {state === 'confirm' && (
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-amber-800">
                  {flippedTypes.map((ot) => (
                    <p key={ot}>
                      This changes whether <strong>{OUTLET_TYPE_LABELS[ot]}</strong> amounts
                      become wallet points or bank payouts. Save?
                    </p>
                  ))}
                </div>
              </div>
            )}

            {/* Error */}
            {state === 'error' && (
              <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{errMsg}</p>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={state === 'saving'}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--brand-primary)] text-white rounded-lg text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {state === 'saving' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {state === 'saved'  && <Check    className="w-3.5 h-3.5" />}
                {state === 'confirm'
                  ? 'Confirm & Save'
                  : state === 'saving'
                  ? 'Saving…'
                  : state === 'saved'
                  ? 'Saved'
                  : 'Save'}
              </button>
              {state === 'confirm' && (
                <button
                  onClick={() => setState('idle')}
                  className="px-3 py-1.5 text-gray-500 hover:text-gray-700 text-xs"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function FieldConfigPage() {
  const session = useAdminSession();
  const [fields,   setFields]   = useState<CreditField[]>([]);
  const [newName,  setNewName]  = useState('');
  const [newSep,   setNewSep]   = useState(false);
  const [creating, setCreating] = useState(false);
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(true);

  const fetchFields = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/credits/fields');
      const json = await res.json();
      if (json.success) setFields(json.data);
    } catch {
      // silently fail — fields will just be empty
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchFields(); }, [fetchFields]);

  async function handleCreate() {
    setError('');
    if (!newName.trim()) { setError('Field name is required.'); return; }
    try {
      const res = await fetch('/api/admin/credits/fields', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), isSeparatePayout: newSep }),
      });
      const json = await res.json();
      if (!json.success) { setError(json.error ?? 'Failed to create field'); return; }
      setNewName('');
      setNewSep(false);
      setCreating(false);
      fetchFields();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleToggleActive(f: CreditField) {
    const action = f.isActive ? 'deactivate' : 'activate';
    try {
      await fetch(`/api/admin/credits/fields/${f.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      fetchFields();
    } catch {
      // silently fail
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Settings2 className="w-5 h-5 text-gray-500" />
          <div>
            <h2 className="text-lg font-bold text-gray-900">Field Configuration</h2>
            <p className="text-xs text-gray-500">
              Add or deactivate credit fields. Field order is fixed at creation time.
            </p>
          </div>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 px-3 py-2 bg-[var(--brand-primary)] text-white rounded-lg text-xs font-medium hover:opacity-90 transition-opacity"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Field
        </button>
      </div>

      {/* Create form */}
      {creating && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
          <p className="text-sm font-semibold text-gray-800">New Field</p>
          {error && (
            <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
          )}
          <div className="flex gap-3">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Field name (e.g. Scheme Volume)"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
            <button
              onClick={handleCreate}
              className="px-4 py-2 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90"
            >
              Create
            </button>
            <button
              onClick={() => { setCreating(false); setError(''); setNewName(''); }}
              className="px-3 py-2 text-gray-500 hover:text-gray-700 text-sm"
            >
              Cancel
            </button>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={newSep}
              onChange={(e) => setNewSep(e.target.checked)}
              className="w-4 h-4 rounded accent-[var(--brand-primary)]"
            />
            <span className="text-xs text-gray-600">
              Separate payout download (Gifsy downloads this field independently)
            </span>
          </label>
        </div>
      )}

      {/* Field list */}
      {loading ? (
        <div className="bg-gray-50 rounded-xl border border-gray-200 p-8 text-center">
          <p className="text-sm text-gray-500">Loading fields…</p>
        </div>
      ) : fields.length === 0 ? (
        <div className="bg-gray-50 rounded-xl border border-dashed border-gray-300 p-8 text-center">
          <p className="text-sm text-gray-500">No fields configured yet. Click "Add Field" to start.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
          {fields.map((f) => (
            <FieldRow
              key={f.id}
              field={f}
              onToggleActive={handleToggleActive}
              onSaved={fetchFields}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-gray-400">
        Field order is permanent. Deactivated fields are hidden from templates but preserved in historical records.
      </p>
    </div>
  );
}
