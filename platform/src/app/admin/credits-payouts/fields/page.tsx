'use client';

import { useState, useEffect } from 'react';
import {
  Plus,
  ToggleRight,
  ToggleLeft,
  Settings2,
  ChevronRight,
} from 'lucide-react';
import {
  getAllFields,
  createField,
  deactivateField,
  reactivateField,
} from '@/lib/credits-payouts-fields';
import type { CreditField, FieldAwardType } from '@/types';

const OUTLET_TYPES = ['WHOLESALER', 'SSS', 'SUB_STOCKIST', 'SSS_TOT'] as const;
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

export default function FieldConfigPage() {
  const [fields,   setFields]   = useState<CreditField[]>([]);
  const [newName,  setNewName]  = useState('');
  const [newSep,   setNewSep]   = useState(false);
  const [creating, setCreating] = useState(false);
  const [error,    setError]    = useState('');

  useEffect(() => {
    setFields(getAllFields());
  }, []);

  function refresh() {
    setFields(getAllFields());
  }

  function handleCreate() {
    setError('');
    if (!newName.trim()) { setError('Field name is required.'); return; }
    try {
      createField(newName.trim(), { isSeparatePayout: newSep });
      setNewName('');
      setNewSep(false);
      setCreating(false);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  function handleToggleActive(f: CreditField) {
    if (f.isActive) deactivateField(f.id);
    else            reactivateField(f.id);
    refresh();
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
      {fields.length === 0 ? (
        <div className="bg-gray-50 rounded-xl border border-dashed border-gray-300 p-8 text-center">
          <p className="text-sm text-gray-500">No fields configured yet. Click "Add Field" to start.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
          {fields.map((f) => (
            <div
              key={f.id}
              className={`flex items-center gap-4 px-5 py-4 ${!f.isActive ? 'opacity-50' : ''}`}
            >
              {/* Order badge */}
              <span className="w-6 h-6 rounded-full bg-gray-100 text-gray-500 text-xs flex items-center justify-center font-mono flex-shrink-0">
                {f.order}
              </span>

              {/* Field info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-gray-900">{f.name}</span>
                  {f.isSeparatePayout && (
                    <span className="text-xs bg-purple-100 text-purple-700 rounded-full px-2 py-0.5">
                      Separate
                    </span>
                  )}
                  {!f.isActive && (
                    <span className="text-xs bg-gray-100 text-gray-500 rounded-full px-2 py-0.5">
                      Deactivated
                    </span>
                  )}
                </div>
                {/* Award type pills per outlet type */}
                <div className="flex gap-1.5 mt-1.5 flex-wrap">
                  {OUTLET_TYPES.map((ot) => {
                    const award = (f.outletTypeAwards[ot] ?? 'NA') as FieldAwardType;
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

              {/* Toggle */}
              <button
                onClick={() => handleToggleActive(f)}
                className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800 transition-colors"
                title={f.isActive ? 'Deactivate' : 'Reactivate'}
              >
                {f.isActive
                  ? <ToggleRight className="w-5 h-5 text-emerald-500" />
                  : <ToggleLeft  className="w-5 h-5 text-gray-400" />
                }
                <span>{f.isActive ? 'Active' : 'Inactive'}</span>
              </button>

              <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0" />
            </div>
          ))}
        </div>
      )}

      {/* Info */}
      <p className="text-xs text-gray-400">
        Field order is permanent. Deactivated fields are hidden from templates but preserved in historical records.
      </p>
    </div>
  );
}
