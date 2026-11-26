'use client';

/**
 * Inputs card — the variables the pipeline may read.
 *
 * Each input binds a `ref` name to a source (an achievement KPI code, a target:/pct: of a KPI, or a
 * segment field, or the outlet's VISIBILITY result for the month) with a type + a plain-English null policy.
 * Exactly one of kpiCode / source is set (mirrors the backend validator). A new rule auto-seeds one `value`
 * input bound to the attachment KPI. Visibility sources are always NUMBER inputs (design §3a).
 */

import React from 'react';
import { Plus, Trash2, Variable } from 'lucide-react';
import { VISIBILITY_SOURCES, type RuleInput, type NullPolicy } from '@/lib/points-engine/types';
import { Field, TextField, SelectField, labelCls } from './kit';

type SourceKind = 'achievement' | 'target' | 'pct' | 'segment' | 'visibility';

function readKind(inp: RuleInput): { kind: SourceKind; value: string } {
  if (inp.kpiCode != null && inp.kpiCode !== '') return { kind: 'achievement', value: inp.kpiCode };
  if (inp.source) {
    const idx = inp.source.indexOf(':');
    const kind = (idx >= 0 ? inp.source.slice(0, idx) : inp.source) as SourceKind;
    const value = idx >= 0 ? inp.source.slice(idx + 1) : '';
    if (kind === 'achievement' || kind === 'target' || kind === 'pct' || kind === 'segment' || kind === 'visibility')
      return { kind, value };
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
  quarterly = false,
}: {
  inputs: RuleInput[];
  disabled?: boolean;
  onChange: (inputs: RuleInput[]) => void;
  /** A QUARTERLY rule: each KPI input reads month 1 / 2 / 3 of the quarter or the quarter total. */
  quarterly?: boolean;
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
        const isVisibility = kind === 'visibility';
        const visMeta = isVisibility ? VISIBILITY_SOURCES.find((v) => v.key === value) : undefined;
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
                  onChange={(k) => {
                    // Segment ⇒ enum input (seed a concrete field so the source isn't an empty "segment:");
                    // leaving segment for a numeric source ⇒ drop the forced enum so the input is valid again
                    // (an enum input needs `values`, which a KPI/target source doesn't collect).
                    // Visibility ⇒ always a NUMBER input (1/0 or a window count), seeded with "approved".
                    const nextType =
                      k === 'segment' ? 'enum' : k === 'visibility' ? 'number' : kind === 'segment' ? 'number' : inp.type;
                    const nextValue =
                      k === 'segment'
                        ? value || 'program'
                        : k === 'visibility'
                          ? 'approved'
                          : kind === 'visibility'
                            ? ''
                            : value;
                    const next = applyKind({ ...inp, type: nextType }, k, nextValue);
                    if (k === 'visibility') delete next.values;
                    replaceInput(i, next);
                  }}
                  options={[
                    { value: 'achievement', label: 'Achievement (KPI code)' },
                    { value: 'target', label: 'Target of a KPI' },
                    { value: 'pct', label: '% achievement of target' },
                    { value: 'segment', label: 'Segment field' },
                    // Visibility is monthly — not offered on a quarterly rule (kept visible if already set so the
                    // validator's error can be read and fixed).
                    ...(!quarterly || isVisibility ? [{ value: 'visibility' as const, label: 'Visibility (POSM) this month' }] : []),
                  ]}
                />
              </Field>

              {quarterly && !isSegment && (
                <Field
                  label="Which month of the quarter"
                  hint="Quarter total = the 3 months added up (missing in any month → the input counts as missing, naming the month)."
                >
                  <SelectField<string>
                    value={inp.month ? String(inp.month) : 'Q'}
                    disabled={disabled}
                    onChange={(v) => {
                      const next = { ...inp };
                      if (v === 'Q') delete next.month;
                      else next.month = Number(v) as 1 | 2 | 3;
                      replaceInput(i, next);
                    }}
                    options={[
                      { value: 'Q', label: 'Quarter total (sum of 3 months)' },
                      { value: '1', label: 'Month 1 of the quarter' },
                      { value: '2', label: 'Month 2 of the quarter' },
                      { value: '3', label: 'Month 3 of the quarter' },
                    ]}
                  />
                </Field>
              )}

              <Field
                label={isSegment ? 'Segment field' : isVisibility ? 'Visibility value' : 'KPI code'}
                hint={isVisibility ? visMeta?.hint : undefined}
              >
                {isVisibility ? (
                  <SelectField
                    value={value || 'approved'}
                    disabled={disabled}
                    onChange={(v) => replaceInput(i, applyKind(inp, kind, v))}
                    options={VISIBILITY_SOURCES.map((v) => ({ value: v.key, label: v.label }))}
                  />
                ) : isSegment ? (
                  <SelectField
                    value={value || 'program'}
                    disabled={disabled}
                    onChange={(v) => replaceInput(i, applyKind(inp, kind, v))}
                    options={[
                      { value: 'program', label: 'program' },
                      { value: 'programCategory', label: 'programCategory' },
                      { value: 'outletType', label: 'outletType' },
                      { value: 'metro', label: 'metro' },
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

              <Field label="Type" hint={isVisibility ? 'Visibility values are always numbers.' : undefined}>
                <SelectField
                  value={inp.type}
                  disabled={disabled || isVisibility}
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
              {isVisibility && (
                <p className="sm:col-span-2 rounded-lg border border-sky-100 bg-sky-50 px-2.5 py-1.5 text-[11px] leading-snug text-sky-800">
                  Reads the outlet&apos;s visibility result for the compute month. A window counts only when its
                  capture is <strong>approved</strong> (every photo approved; imported old-app approvals count) —
                  waiting for review, re-take requested and rejected do not. An outlet outside the visibility
                  programme reads in programme = 0, approved = 0 and the month&apos;s window count (so it never passes
                  &ldquo;every window approved&rdquo;) — use &ldquo;Outlet in the visibility programme (1/0)&rdquo; to
                  tell &ldquo;not applicable&rdquo; apart from &ldquo;not approved&rdquo;. Windows still waiting for review or still open
                  read as not approved, and the compute screen asks you to accept that before exporting or crediting.
                  If the tenant has no visibility set up, the value is missing and the rule below decides what
                  happens. Example payout formula:{' '}
                  <code className="rounded bg-white px-1">if(visApproved == 1 &amp;&amp; TOTAL &gt;= 4000, if(metro == &apos;Metro&apos;, 500, 250), 0)</code>
                </p>
              )}
            </div>
          </div>
        );
      })}

      {quarterly && (
        <p className="rounded-lg border border-violet-100 bg-violet-50 px-2.5 py-1.5 text-[11px] leading-snug text-violet-800" data-testid="quarter-inputs-help">
          Quarterly rule: give each month its own input (e.g. <code className="rounded bg-white px-1">tot_ach_m1</code>{' '}
          = TOTAL achievement, month 1) to test every month, and use the quarter total for “all cases in the quarter”. In
          a gate reason, <code className="rounded bg-white px-1">{'{m1}'}</code> <code className="rounded bg-white px-1">{'{m2}'}</code>{' '}
          <code className="rounded bg-white px-1">{'{m3}'}</code> become the month names (“Nov 2026”) and{' '}
          <code className="rounded bg-white px-1">{'{quarter}'}</code> becomes “Oct–Dec 2026”. A 120% cap per month:{' '}
          <code className="rounded bg-white px-1">cases_m1 * min(1, 1.2 * tot_tgt_m1 / tot_ach_m1)</code>.
        </p>
      )}

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
