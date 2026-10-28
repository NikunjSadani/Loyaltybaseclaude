'use client';

/**
 * One pipeline-node card: a typed editor + move-up / move-down / remove controls.
 *
 * Each node type renders only its own fields (progressive disclosure). The editors are intentionally
 * plain-English and constrained so the author can only express configs the backend validator accepts.
 */

import React from 'react';
import {
  ArrowUp, ArrowDown, Trash2, Zap, BarChart3, ShieldCheck, Filter, Trophy, ArrowDownToLine, ArrowUpToLine, FunctionSquare,
} from 'lucide-react';
import type {
  PipelineNode,
  NodeType,
  OnFail,
  RuleInput,
} from '@/lib/points-engine/types';
import { NODE_META } from '@/lib/points-engine/types';
import { Field, SelectField, NumberField, TextField, OperandPicker, varOptions } from './kit';
import { PredicateBuilder } from './PredicateBuilder';
import { SlabGrid } from './SlabGrid';

const NODE_ICON: Record<NodeType, React.ReactNode> = {
  rate: <Zap className="h-4 w-4" />,
  slab: <BarChart3 className="h-4 w-4" />,
  gate: <ShieldCheck className="h-4 w-4" />,
  segmentFilter: <Filter className="h-4 w-4" />,
  milestone: <Trophy className="h-4 w-4" />,
  floor: <ArrowDownToLine className="h-4 w-4" />,
  cap: <ArrowUpToLine className="h-4 w-4" />,
  formula: <FunctionSquare className="h-4 w-4" />,
};

// Only 'zero' actually withholds points; 'skipNode'/'passthrough' are inert for a gate and invite silent
// over-credit, so the builder no longer offers them. A rule loaded from the API that already carries a
// legacy value keeps it visible (and selectable, so it isn't silently rewritten) — draftIssues warns about
// it (see kit.draftIssues) — but a fresh gate can only be 'zero'.
function onFailOptions(current: OnFail): ReadonlyArray<{ value: OnFail; label: string }> {
  const zero = { value: 'zero' as OnFail, label: 'Pay 0 points if this fails (withhold)' };
  if (current === 'zero') return [zero];
  return [zero, { value: current, label: `${current} (legacy — won’t withhold; switch to Pay 0)` }];
}

// Pipeline order is fixed in the evaluator regardless of card position: gates/filters run FIRST, floor/cap
// LAST. A small badge keeps the visible (reorderable) order from misleading the author.
const ORDER_NOTE: Partial<Record<NodeType, string>> = {
  gate: 'checked first',
  segmentFilter: 'checked first',
  floor: 'applied at the end',
  cap: 'applied at the end',
};

export function NodeCard({
  node,
  index,
  total,
  inputs,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  node: PipelineNode;
  index: number;
  total: number;
  inputs: RuleInput[];
  disabled?: boolean;
  onChange: (node: PipelineNode) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const meta = NODE_META[node.type];

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]">
            {NODE_ICON[node.type]}
          </span>
          <div>
            <p className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
              {index + 1}. {meta.label}
              {ORDER_NOTE[node.type] && (
                <span
                  className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-gray-500"
                  title="This step runs in a fixed position regardless of its order in the list."
                >
                  {ORDER_NOTE[node.type]}
                </span>
              )}
            </p>
            <p className="text-[10px] text-gray-400">{meta.blurb}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            disabled={disabled || index === 0}
            onClick={() => onMove(-1)}
            title="Move up"
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={disabled || index === total - 1}
            onClick={() => onMove(1)}
            title="Move down"
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={onRemove}
            title="Remove step"
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <NodeEditor node={node} inputs={inputs} disabled={disabled} onChange={onChange} />
    </div>
  );
}

function NodeEditor({
  node,
  inputs,
  disabled,
  onChange,
}: {
  node: PipelineNode;
  inputs: RuleInput[];
  disabled?: boolean;
  onChange: (node: PipelineNode) => void;
}) {
  const vars = varOptions(inputs);

  switch (node.type) {
    case 'rate':
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Measure (per-unit input)">
            <OperandPicker
              value={node.measure}
              vars={vars}
              numericOnly
              disabled={disabled}
              onChange={(measure) => onChange({ ...node, measure })}
            />
          </Field>
          <Field label="Rate (points per unit)">
            <NumberField value={node.rate} disabled={disabled} onChange={(rate) => onChange({ ...node, rate })} />
          </Field>
          <p className="text-[11px] text-gray-400 sm:col-span-2">points += measure × rate</p>
        </div>
      );

    case 'slab':
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Band basis">
              <SelectField
                value={node.basis}
                disabled={disabled}
                onChange={(basis) =>
                  onChange({
                    ...node,
                    basis,
                    // pct_of_target needs a target operand; seed one when switching to it.
                    target: basis === 'pct_of_target' ? node.target ?? { lit: 0 } : node.target,
                  })
                }
                options={[
                  { value: 'absolute', label: 'Absolute (raw measure)' },
                  { value: 'pct_of_target', label: '% of target' },
                ]}
              />
            </Field>
            <Field label="Measure">
              <OperandPicker
                value={node.measure}
                vars={vars}
                numericOnly
                disabled={disabled}
                onChange={(measure) => onChange({ ...node, measure })}
              />
            </Field>
            {node.basis === 'pct_of_target' && (
              <Field label="Target" className="sm:col-span-2" hint="Bands express thresholds relative to this target.">
                <OperandPicker
                  value={node.target ?? { lit: 0 }}
                  vars={vars}
                  numericOnly
                  disabled={disabled}
                  onChange={(target) => onChange({ ...node, target })}
                />
              </Field>
            )}
          </div>

          <Field label="How bands apply">
            <SelectField
              value={node.apply}
              disabled={disabled}
              onChange={(apply) => onChange({ ...node, apply })}
              options={[
                { value: 'marginal', label: 'Marginal — each band rates only the units inside it (tax-bracket)' },
                { value: 'whole', label: 'Whole — the landing band re-rates the entire measure (cliff)' },
              ]}
            />
            <p className="mt-1 text-[11px] text-gray-400">
              {node.apply === 'marginal'
                ? 'e.g. 600 over 0–400@2, 400–500@3, 500+@4 → 400×2 + 100×3 + 100×4.'
                : 'e.g. 600 landing in the 500+@4 band → 600×4 (the whole amount re-rated).'}
            </p>
          </Field>

          <Field label={`Bands (${node.bands.length})`}>
            <SlabGrid bands={node.bands} disabled={disabled} onChange={(bands) => onChange({ ...node, bands })} />
          </Field>
        </div>
      );

    case 'gate':
      return (
        <div className="space-y-3">
          <Field label="Pay only when">
            <PredicateBuilder value={node.when} vars={vars} disabled={disabled} onChange={(when) => onChange({ ...node, when })} />
          </Field>
          <Field label="If the check fails">
            <SelectField value={node.onFail} disabled={disabled} onChange={(onFail) => onChange({ ...node, onFail })} options={onFailOptions(node.onFail)} />
          </Field>
        </div>
      );

    case 'segmentFilter':
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Segment field">
              <SelectField
                value={node.field}
                disabled={disabled}
                onChange={(field) => onChange({ ...node, field })}
                options={[
                  { value: 'program', label: 'program' },
                  { value: 'programCategory', label: 'programCategory' },
                  { value: 'outletType', label: 'outletType' },
                  { value: 'metro', label: 'metro' },
                ]}
              />
            </Field>
            <Field label="Allowed values" hint="Comma-separated — the row must match one of these.">
              <TextField
                value={node.allow.join(', ')}
                disabled={disabled}
                placeholder="GOLD, SILVER"
                onChange={(v) =>
                  onChange({
                    ...node,
                    allow: v.split(',').map((s) => s.trim()).filter((s) => s !== ''),
                  })
                }
              />
            </Field>
          </div>
          {node.allow.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {node.allow.map((a) => (
                <span key={a} className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                  {a}
                </span>
              ))}
            </div>
          )}
          <Field label="If no value matches">
            <SelectField value={node.onFail} disabled={disabled} onChange={(onFail) => onChange({ ...node, onFail })} options={onFailOptions(node.onFail)} />
          </Field>
        </div>
      );

    case 'milestone':
      return (
        <div className="space-y-3">
          <Field label="Award the bonus when">
            <PredicateBuilder value={node.when} vars={vars} disabled={disabled} onChange={(when) => onChange({ ...node, when })} />
          </Field>
          <Field label="Flat bonus (points)">
            <NumberField value={node.flat} disabled={disabled} onChange={(flat) => onChange({ ...node, flat })} />
          </Field>
        </div>
      );

    case 'floor':
      return (
        <Field label="Minimum total (points)" hint="Raises the running total up to this value.">
          <NumberField value={node.min} disabled={disabled} onChange={(min) => onChange({ ...node, min })} />
        </Field>
      );

    case 'cap':
      return (
        <Field label="Maximum total (points)" hint="Clamps the running total down to this value.">
          <NumberField value={node.max} disabled={disabled} onChange={(max) => onChange({ ...node, max })} />
        </Field>
      );

    case 'formula':
      return (
        <div className="space-y-3">
          <Field
            label="Expression"
            hint="Validated on save. Allowed: + - * / %, comparisons, && || !, and min/max/abs/round/floor/ceil/clamp/if."
          >
            <textarea
              value={node.expr}
              disabled={disabled}
              placeholder="e.g. if(newOutlets >= 3 && visibility >= 90, value * (visibility/100) + 2000, value)"
              rows={3}
              onChange={(e) => onChange({ ...node, expr: e.target.value })}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 font-mono text-xs focus:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 disabled:bg-gray-100 disabled:text-gray-400"
            />
          </Field>
          <Field label="Apply the result as">
            <SelectField
              value={node.output}
              disabled={disabled}
              onChange={(output) => onChange({ ...node, output })}
              options={[
                { value: 'add', label: 'Add to the running total' },
                { value: 'multiply', label: 'Multiply the running total' },
                { value: 'set', label: 'Set the total to the result' },
              ]}
            />
          </Field>
          {vars.length > 0 && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Available inputs</p>
              <div className="flex flex-wrap gap-1.5">
                {vars.map((v) => (
                  <span key={v.ref} className="rounded-md bg-gray-100 px-2 py-0.5 font-mono text-[11px] text-gray-600">
                    {v.ref}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      );
  }
}
