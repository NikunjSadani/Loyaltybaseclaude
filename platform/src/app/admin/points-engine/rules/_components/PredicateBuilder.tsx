'use client';

/**
 * Predicate builder for gate / milestone `when` clauses.
 *
 * Supports a single Condition, or a flat all/any group of conditions (AND / OR), with an optional
 * `not` wrapper — one group level deep (the type allows nesting; v1 keeps it usable + flat, which is
 * what the evaluator + validator accept). Reads/writes the backend `Predicate` union directly.
 */

import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { Condition, CompareOp, Operand, Predicate } from '@/lib/points-engine/types';
import { OperandPicker, SelectField, type VarOption } from './kit';

const OP_OPTIONS: ReadonlyArray<{ value: CompareOp; label: string }> = [
  { value: 'gte', label: '≥ (at least)' },
  { value: 'lte', label: '≤ (at most)' },
  { value: 'gt', label: '> (more than)' },
  { value: 'lt', label: '< (less than)' },
  { value: 'eq', label: '= (equals)' },
  { value: 'neq', label: '≠ (not equal)' },
];

type Combinator = 'single' | 'all' | 'any';

interface Normalized {
  not: boolean;
  combinator: Combinator;
  conditions: Condition[];
}

function isCondition(p: Predicate): p is Condition {
  return typeof (p as Condition).op === 'string';
}

function blankCondition(firstVar: string): Condition {
  const left: Operand = { var: firstVar || 'value' };
  return { op: 'gte', left, right: { lit: 0 } };
}

/** Best-effort read of a Predicate into the flat editor model (nested groups collapse to their leaves). */
function normalize(pred: Predicate, firstVar: string): Normalized {
  let not = false;
  let p = pred;
  if (p && 'not' in p) {
    not = true;
    p = p.not;
  }
  if (p && 'all' in p) {
    return { not, combinator: 'all', conditions: p.all.filter(isCondition) };
  }
  if (p && 'any' in p) {
    return { not, combinator: 'any', conditions: p.any.filter(isCondition) };
  }
  if (p && isCondition(p)) {
    return { not, combinator: 'single', conditions: [p] };
  }
  return { not, combinator: 'single', conditions: [blankCondition(firstVar)] };
}

function denormalize(n: Normalized): Predicate {
  const conds = n.conditions.length > 0 ? n.conditions : [];
  let base: Predicate;
  if (n.combinator === 'single') base = conds[0] ?? ({ op: 'gte', left: { lit: 0 }, right: { lit: 0 } } as Condition);
  else if (n.combinator === 'all') base = { all: conds };
  else base = { any: conds };
  return n.not ? { not: base } : base;
}

export function PredicateBuilder({
  value,
  onChange,
  vars,
  disabled,
}: {
  value: Predicate;
  onChange: (p: Predicate) => void;
  vars: VarOption[];
  disabled?: boolean;
}) {
  const firstVar = vars[0]?.ref ?? 'value';
  const model = normalize(value, firstVar);

  const emit = (next: Normalized) => onChange(denormalize(next));

  const setCombinator = (c: Combinator) => {
    let conditions = model.conditions;
    if (c === 'single' && conditions.length > 1) conditions = conditions.slice(0, 1);
    if (c !== 'single' && conditions.length === 0) conditions = [blankCondition(firstVar)];
    emit({ ...model, combinator: c, conditions });
  };

  const setCondition = (i: number, cond: Condition) => {
    const conditions = model.conditions.map((c, idx) => (idx === i ? cond : c));
    emit({ ...model, conditions });
  };

  const addCondition = () =>
    emit({ ...model, conditions: [...model.conditions, blankCondition(firstVar)] });

  const removeCondition = (i: number) =>
    emit({ ...model, conditions: model.conditions.filter((_, idx) => idx !== i) });

  return (
    <div className="space-y-2.5 rounded-xl border border-gray-100 bg-gray-50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-44">
          <SelectField<Combinator>
            value={model.combinator}
            disabled={disabled}
            onChange={setCombinator}
            options={[
              { value: 'single', label: 'A single condition' },
              { value: 'all', label: 'ALL of (AND)' },
              { value: 'any', label: 'ANY of (OR)' },
            ]}
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600">
          <input
            type="checkbox"
            checked={model.not}
            disabled={disabled}
            onChange={(e) => emit({ ...model, not: e.target.checked })}
            className="accent-[var(--brand-primary)]"
          />
          Invert (NOT)
        </label>
      </div>

      <div className="space-y-2">
        {model.conditions.map((cond, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-gray-200 bg-white p-2">
            {model.combinator !== 'single' && (
              <span className="shrink-0 text-[10px] font-bold uppercase text-gray-400">
                {i === 0 ? 'when' : model.combinator === 'all' ? 'and' : 'or'}
              </span>
            )}
            <div className="min-w-[150px] flex-1">
              <OperandPicker value={cond.left} vars={vars} disabled={disabled} onChange={(left) => setCondition(i, { ...cond, left })} />
            </div>
            <div className="w-36 shrink-0">
              <SelectField<CompareOp>
                value={cond.op}
                disabled={disabled}
                onChange={(op) => setCondition(i, { ...cond, op })}
                options={OP_OPTIONS}
              />
            </div>
            <div className="min-w-[150px] flex-1">
              <OperandPicker value={cond.right} vars={vars} disabled={disabled} onChange={(right) => setCondition(i, { ...cond, right })} />
            </div>
            {model.combinator !== 'single' && (
              <button
                type="button"
                disabled={disabled || model.conditions.length <= 1}
                onClick={() => removeCondition(i)}
                title="Remove condition"
                className="shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      {model.combinator !== 'single' && !disabled && (
        <button
          type="button"
          onClick={addCondition}
          className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--brand-primary)] hover:underline"
        >
          <Plus className="h-3.5 w-3.5" /> Add condition
        </button>
      )}
    </div>
  );
}
