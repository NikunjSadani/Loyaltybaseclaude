'use client';

/**
 * Inputs card — the variables the pipeline may read.
 *
 * Each input binds a `ref` name to a source (an achievement KPI code, a target:/pct: of a KPI, or a
 * segment field) with a type + a plain-English null policy. Exactly one of kpiCode / source is set
 * (mirrors the backend validator). A new rule auto-seeds one `value` input bound to the attachment KPI.
 */

import React from 'react';
import { Plus, Trash2, Variable } from 'lucide-react';
import type { RuleInput, NullPolicy } from '@/lib/points-engine/types';
import { Field, TextField, SelectField, labelCls } from './kit';

type SourceKind = 'achievement' | 'target' | 'pct' | 'segment';

function readKind(inp: RuleInput): { kind: SourceKind; value: string } {
  if (inp.kpiCode != null && inp.kpiCode !== '') return { kind: 'achievement', value: inp.kpiCode };
  if (inp.source) {
    const idx = inp.source.indexOf(':');
    const kind = (idx >= 0 ? inp.source.slice(0, idx) : inp.source) as SourceKind;
    const value = idx >= 0 ? inp.source.slice(idx + 1) : '';
    if (kind === 'achievement' || kind === 'target' || kind === 'pct' || kind === 'segment') return { kind, value };
  }
  return { kind: 'achievement', value: '' };
}

/** Rebuild the kpiCode/source pair for a given kind + value (exactly one is ever set). */
function applyKind(inp: RuleInput, kind: SourceKind, value: string): RuleInput {
  if (kind === 'achievement') return { ...inp, kpiCode: value, source: undefined };
  return { ...inp, kpiCode: undefined, source: `${kind}:${value}` };
}

const NULL_OPTIONS: ReadonlyArray<{ value: NullPolicy; label: string }> = [
  { value: 'reject', label: 'Skip row (reject) — surface for review' },
  { value: 'zero', label: 'Treat as 0' },
  { value: 'skipRule', label: 'Rule pays 0' },
];

export function InputsCard({
  inputs,
  disabled,
  onChange,
}: {
  inputs: RuleInput[];
  disabled?: boolean;
  onChange: (inputs: RuleInput[]) => void;
}) {
  const setInput = (i: number, patch: Partial<RuleInput>) =>
    onChange(inputs.map((inp, idx) => (idx === i ? { ...inp, ...patch } : inp)));

  const replaceInput = (i: number, next: RuleInput) =>
    onChange(inputs.map((inp, idx) => (idx === i ? next : inp)));

  const addInput = () =>
    onChange([...inputs, { ref: `input${inputs.length + 1}`, kpiCode: '', type: 'number', nullAs: 'reject' }]);

  const removeInput = (i: number) => onChange(inputs.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-3">
      {inputs.map((inp, i) => {
        const { kind, value } = readKind(inp);
        const isSegment = kind === 'segment';
        return (
          <div key={i} className="rounded-xl border border-gray-200 bg-gray-50 p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-bold text-gray-700">
                <Variable className="h-3.5 w-3.5 text-[var(--brand-primary)]" /> Input #{i + 1}
              </div>
              <button
                type="button"
                disabled={disabled || inputs.length <= 1}
                onClick={() => removeInput(i)}
                title="Remove input"
                className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Reference name" hint="How the pipeline refers to this value.">
                <TextField
                  value={inp.ref}
                  disabled={disabled}
                  placeholder="value"
                  onChange={(ref) => setInput(i, { ref })}
                />
              </Field>

              <Field label="Source">
                <SelectField<SourceKind>
                  value={kind}
                  disabled={disabled}
                  onChange={(k) =>
                    replaceInput(i, applyKind({ ...inp, type: k === 'segment' ? 'enum' : inp.type }, k, value))
                  }
                  options={[
                    { value: 'achievement', label: 'Achievement (KPI code)' },
                    { value: 'target', label: 'Target of a KPI' },
                    { value: 'pct', label: '% achievement of target' },
                    { value: 'segment', label: 'Segment field' },
                  ]}
                />
              </Field>

              <Field label={isSegment ? 'Segment field' : 'KPI code'}>
                {isSegment ? (
                  <SelectField
                    value={value || 'program'}
                    disabled={disabled}
                    onChange={(v) => replaceInput(i, applyKind(inp, kind, v))}
                    options={[
                      { value: 'program', label: 'program' },
                      { value: 'programCategory', label: 'programCategory' },
                      { value: 'outletType', label: 'outletType' },
                    ]}
                  />
                ) : (
                  <TextField
                    value={value}
                    disabled={disabled}
                    upper
                    placeholder="CASES_SOLD"
                    onChange={(v) => replaceInput(i, applyKind(inp, kind, v))}
                  />
                )}
              </Field>

              <Field label="Type">
                <SelectField
                  value={inp.type}
                  disabled={disabled}
                  onChange={(type) => setInput(i, { type })}
                  options={[
                    { value: 'number', label: 'Number' },
                    { value: 'enum', label: 'Enum (text)' },
                  ]}
                />
              </Field>

              {inp.type === 'enum' && (
                <Field label="Allowed values" className="sm:col-span-2" hint="Comma-separated (required for an enum input).">
                  <TextField
                    value={(inp.values ?? []).join(', ')}
                    disabled={disabled}
                    placeholder="GOLD, SILVER, BRONZE"
                    onChange={(v) =>
                      setInput(i, { values: v.split(',').map((s) => s.trim()).filter((s) => s !== '') })
                    }
                  />
                </Field>
              )}

              <div className="sm:col-span-2">
                <label className={labelCls}>If the value is missing</label>
                <div className="flex flex-wrap gap-3 pt-1">
                  {NULL_OPTIONS.map((o) => (
                    <label key={o.value} className="flex items-center gap-1.5 text-xs text-gray-700">
                      <input
                        type="radio"
                        name={`nullAs-${i}`}
                        checked={inp.nullAs === o.value}
                        disabled={disabled}
                        onChange={() => setInput(i, { nullAs: o.value })}
                        className="accent-[var(--brand-primary)]"
                      />
                      {o.label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {!disabled && (
        <button
          type="button"
          onClick={addInput}
          className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--brand-primary)] hover:underline"
        >
          <Plus className="h-3.5 w-3.5" /> Add input
        </button>
      )}
    </div>
  );
}
