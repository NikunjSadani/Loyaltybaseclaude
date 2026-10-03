'use client';

/**
 * Points Engine rule builder — shared UI kit + pure helpers.
 *
 * Small, typed building blocks reused across the builder cards (inputs, labels, the status badge,
 * operand picker) + pure draft/node factories. Keeps the Tailwind idiom identical to the targets /
 * schemes admin pages (light mode, var(--brand-primary) accent, rounded-xl cards). No new deps.
 */

import React from 'react';
import type {
  Operand,
  PipelineNode,
  NodeType,
  Predicate,
  RuleConfigDraft,
  PointsRuleRow,
  RuleStatus,
  RuleInput,
} from '@/lib/points-engine/types';

// ── Tailwind idioms (verbatim from targets/schemes) ─────────────────────────────
export const inputCls =
  'w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]';
export const labelCls = 'block text-xs font-semibold text-gray-500 mb-1';
export const cardCls = 'bg-white rounded-2xl border border-gray-200 shadow-sm';

// ── Small field wrappers ─────────────────────────────────────────────────────────
export function Field({
  label,
  hint,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className={labelCls}>
        {label}
        {required && <span className="text-[var(--brand-primary)]"> *</span>}
      </label>
      {children}
      {hint && <p className="mt-0.5 text-[10px] text-gray-400">{hint}</p>}
    </div>
  );
}

export function TextField({
  value,
  onChange,
  placeholder,
  disabled,
  upper,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  upper?: boolean;
}) {
  return (
    <input
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(upper ? e.target.value.toUpperCase() : e.target.value)}
      className={`${inputCls} disabled:bg-gray-100 disabled:text-gray-400`}
    />
  );
}

export function NumberField({
  value,
  onChange,
  placeholder,
  disabled,
  min,
}: {
  value: number;
  onChange: (v: number) => void;
  placeholder?: string;
  disabled?: boolean;
  min?: number;
}) {
  // Local text so the field can be momentarily blank / mid-edit without snapping to 0. We commit a number
  // on every keystroke (a blank commits 0 so the config stays valid) but DON'T reset the text while the
  // user is clearing it; we re-sync only when the external value changes to something the text isn't.
  const [text, setText] = React.useState<string>(Number.isFinite(value) ? String(value) : '');
  React.useEffect(() => {
    const parsed = text === '' ? NaN : Number(text);
    if (text !== '' && parsed !== value && Number.isFinite(value)) setText(String(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input
      type="number"
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      min={min}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value === '' ? 0 : Number(e.target.value));
      }}
      className={`${inputCls} disabled:bg-gray-100 disabled:text-gray-400`}
    />
  );
}

export function SelectField<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className={`${inputCls} disabled:bg-gray-100 disabled:text-gray-400`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ── Status badge (draft=amber, published=green, archived=gray) ───────────────────
const STATUS_BADGE: Record<RuleStatus, string> = {
  draft: 'bg-amber-100 text-amber-700',
  published: 'bg-green-100 text-green-700',
  archived: 'bg-gray-100 text-gray-500',
};
export function StatusBadge({ status }: { status: RuleStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_BADGE[status]}`}>
      {status}
    </span>
  );
}

// ── Operand helpers ──────────────────────────────────────────────────────────────
export function isVarOperand(op: Operand): op is { var: string } {
  return 'var' in op;
}
export function operandToText(op: Operand): string {
  return isVarOperand(op) ? op.var : String(op.lit);
}

export interface VarOption {
  ref: string;
  type: 'number' | 'enum';
}

/**
 * A var-or-literal picker. `numericOnly` (rate/slab measure + target) restricts the var list to
 * number-typed inputs and forces a numeric literal — mirroring the backend's numericVars rule so the
 * builder can't author an operand the validator will reject.
 */
export function OperandPicker({
  value,
  onChange,
  vars,
  numericOnly,
  disabled,
}: {
  value: Operand;
  onChange: (op: Operand) => void;
  vars: VarOption[];
  numericOnly?: boolean;
  disabled?: boolean;
}) {
  const kind: 'var' | 'lit' = isVarOperand(value) ? 'var' : 'lit';
  const selectable = numericOnly ? vars.filter((v) => v.type === 'number') : vars;
  const litIsNumber = !isVarOperand(value) && typeof value.lit === 'number';
  const selCls = `${inputCls} disabled:bg-gray-100 disabled:text-gray-400`;

  return (
    <div className="flex gap-1.5">
      <select
        value={kind}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === 'var') onChange({ var: selectable[0]?.ref ?? '' });
          else onChange({ lit: 0 });
        }}
        className="w-24 shrink-0 rounded-xl border border-gray-200 px-2 py-2 text-sm focus:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 disabled:bg-gray-100 disabled:text-gray-400"
      >
        <option value="var">Input</option>
        <option value="lit">Value</option>
      </select>

      {kind === 'var' ? (
        <select
          value={isVarOperand(value) ? value.var : ''}
          disabled={disabled}
          onChange={(e) => onChange({ var: e.target.value })}
          className={selCls}
        >
          <option value="">— pick an input —</option>
          {selectable.map((v) => (
            <option key={v.ref} value={v.ref}>
              {v.ref}
            </option>
          ))}
        </select>
      ) : numericOnly || litIsNumber ? (
        <input
          type="number"
          value={!isVarOperand(value) && typeof value.lit === 'number' ? value.lit : 0}
          disabled={disabled}
          onChange={(e) => onChange({ lit: e.target.value === '' ? 0 : Number(e.target.value) })}
          className={selCls}
        />
      ) : (
        <input
          value={!isVarOperand(value) ? String(value.lit) : ''}
          disabled={disabled}
          onChange={(e) => onChange({ lit: e.target.value })}
          placeholder="text or number"
          className={selCls}
        />
      )}
    </div>
  );
}

// ── Node + draft factories ───────────────────────────────────────────────────────
let _idc = 0;
export function genId(prefix = 'n'): string {
  _idc += 1;
  return `${prefix}${Date.now().toString(36)}${_idc}`;
}

export function defaultNode(type: NodeType, firstVar: string): PipelineNode {
  const measure: Operand = { var: firstVar || 'value' };
  switch (type) {
    case 'rate':
      return { type, id: genId(), measure, rate: 1 };
    case 'slab':
      return {
        type,
        id: genId(),
        basis: 'absolute',
        measure,
        apply: 'marginal',
        bands: [{ from: 0, to: null, rate: 1 }],
      };
    case 'gate':
      return { type, id: genId(), when: { op: 'gte', left: measure, right: { lit: 0 } }, onFail: 'zero' };
    case 'segmentFilter':
      return { type, id: genId(), field: 'program', allow: [], onFail: 'zero' };
    case 'milestone':
      return { type, id: genId(), when: { op: 'gte', left: measure, right: { lit: 0 } }, flat: 0 };
    case 'floor':
      return { type, id: genId(), min: 0 };
    case 'cap':
      return { type, id: genId(), max: 0 };
    case 'formula':
      return { type, id: genId(), expr: '', output: 'add' };
  }
}

/** A blank draft for create mode — seeds a single `value` input (bound later to the attachment KPI). */
export function blankDraft(): RuleConfigDraft {
  const today = new Date().toISOString().slice(0, 10);
  return {
    effectiveFrom: today,
    effectiveTo: null,
    evaluationBasis: 'PERIOD_AGGREGATE',
    attachsTo: { scope: 'program_kpi', program: null, programCategory: null, kpiCode: '' },
    output: { awardType: 'POINTS', fieldId: '' },
    rounding: { mode: 'half_up', scale: 0 },
    inputs: [{ ref: 'value', kpiCode: '', type: 'number', nullAs: 'reject' }],
    pipeline: [],
  };
}

/** Project a stored row into the authoring draft shape. */
export function rowToDraft(row: PointsRuleRow): RuleConfigDraft {
  return {
    ruleId: row.ruleId,
    effectiveFrom: row.effectiveFrom.slice(0, 10),
    effectiveTo: row.effectiveTo ? row.effectiveTo.slice(0, 10) : null,
    evaluationBasis: row.evaluationBasis,
    attachsTo: row.attachsTo,
    output: row.output,
    rounding: row.rounding,
    inputs: row.inputs,
    pipeline: row.pipeline,
  };
}

/** The var options the pipeline + simulator may reference (declared input refs + their type). */
export function varOptions(inputs: RuleInput[]): VarOption[] {
  return inputs
    .filter((i) => i.ref.trim() !== '')
    .map((i) => ({ ref: i.ref, type: i.type }));
}

/** The first NUMBER-typed input ref (for seeding a new node's measure — never an enum, which the
 *  backend rejects as a numeric measure). '' when the rule has no numeric input yet. */
export function firstNumericVar(inputs: RuleInput[]): string {
  return inputs.find((i) => i.type === 'number' && i.ref.trim() !== '')?.ref ?? '';
}

/** Flatten a predicate to its leaf operands (for validation). */
export function predicateOperands(p: Predicate): Operand[] {
  if ('op' in p) return [p.left, p.right];
  if ('all' in p) return p.all.flatMap(predicateOperands);
  if ('any' in p) return p.any.flatMap(predicateOperands);
  if ('not' in p) return predicateOperands(p.not);
  return [];
}

/**
 * Pre-submit draft validation that mirrors the backend validateRule for the cases a builder can hit, so
 * the author is steered to a valid rule instead of a raw 400. BLOCKING issues are ones validateRule
 * definitely rejects (empty/unknown operand var, an enum used as a numeric measure, a non-contiguous or
 * wrongly open slab band, an empty formula). WARNINGS are valid-but-footgun configs (no pipeline, a cap
 * that zeroes everything, an empty segment allow-list) — surfaced, not blocked, so we never prevent a
 * config the backend would accept.
 */
export function draftIssues(draft: RuleConfigDraft): { blocking: string[]; warnings: string[] } {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const opts = varOptions(draft.inputs);
  const allRefs = new Set(opts.map((v) => v.ref));
  const numRefs = new Set(opts.filter((v) => v.type === 'number').map((v) => v.ref));

  const checkOperand = (op: Operand, where: string, numeric: boolean) => {
    if (!isVarOperand(op)) return;
    const v = op.var.trim();
    if (v === '') blocking.push(`${where}: choose an input or value.`);
    else if (!allRefs.has(v)) blocking.push(`${where}: references an unknown input "${v}".`);
    else if (numeric && !numRefs.has(v)) blocking.push(`${where}: "${v}" is not a number input.`);
  };

  if (draft.pipeline.length === 0) {
    warnings.push('No steps yet — every outlet would compute 0 points.');
  }

  draft.pipeline.forEach((n, i) => {
    const where = `Step ${i + 1} (${n.type})`;
    switch (n.type) {
      case 'rate':
        checkOperand(n.measure, where, true);
        break;
      case 'slab': {
        checkOperand(n.measure, where, true);
        if (n.basis === 'pct_of_target') {
          if (!n.target) blocking.push(`${where}: a %-of-target slab needs a target input.`);
          else checkOperand(n.target, where, true);
        }
        if (n.bands.length === 0) blocking.push(`${where}: add at least one band.`);
        n.bands.forEach((b, bi) => {
          if (bi > 0 && n.bands[bi - 1].to !== b.from)
            blocking.push(`${where}: band ${bi + 1} must start where band ${bi} ends.`);
          if (bi < n.bands.length - 1 && b.to === null)
            blocking.push(`${where}: only the last band may be open-ended (∞).`);
          if (bi === n.bands.length - 1 && b.to !== null)
            warnings.push(`${where}: the last band usually ends at ∞ (leave "to" blank).`);
        });
        break;
      }
      case 'gate':
      case 'milestone':
        predicateOperands(n.when).forEach((op) => checkOperand(op, where, false));
        break;
      case 'segmentFilter':
        if (n.allow.length === 0)
          warnings.push(`${where}: no values allowed — every outlet is filtered out (0 points).`);
        break;
      case 'cap':
        if (n.max <= 0) warnings.push(`${where}: a cap of ${n.max} clamps every total to ${n.max}.`);
        break;
      case 'formula':
        if (!n.expr.trim()) blocking.push(`${where}: enter a formula expression.`);
        break;
    }
  });

  return { blocking, warnings };
}
