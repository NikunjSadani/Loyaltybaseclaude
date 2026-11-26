'use client';

/**
 * Points Engine rule builder — shared UI kit + pure helpers.
 *
 * Small, typed building blocks reused across the builder cards (inputs, labels, the status badge,
 * operand picker) + pure draft/node factories. Keeps the Tailwind idiom identical to the targets /
 * schemes admin pages (light mode, var(--brand-primary) accent, rounded-xl cards). No new deps.
 */

import React from 'react';
import { VISIBILITY_SOURCES } from '@/lib/points-engine/types';
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
  // Associate the label with its control: generate an id, point htmlFor at it, and inject it onto the
  // single child (TextField/NumberField/SelectField forward `id`; raw <input>/<textarea>/<select> take it
  // directly; composite controls that ignore it degrade gracefully). Using htmlFor (not wrapping) avoids
  // nested <label>s where a Field holds a control that renders its own labels (e.g. the predicate builder).
  const autoId = React.useId();
  let control = children;
  let forId = autoId;
  if (React.isValidElement(children)) {
    const childId = (children.props as { id?: string }).id;
    forId = childId ?? autoId;
    if (!childId) {
      control = React.cloneElement(children as React.ReactElement<{ id?: string }>, { id: autoId });
    }
  }
  return (
    <div className={className}>
      <label className={labelCls} htmlFor={forId}>
        {label}
        {required && <span className="text-[var(--brand-primary)]"> *</span>}
      </label>
      {control}
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
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  upper?: boolean;
  id?: string;
}) {
  return (
    <input
      id={id}
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
  id,
}: {
  value: number;
  onChange: (v: number) => void;
  placeholder?: string;
  disabled?: boolean;
  min?: number;
  id?: string;
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
      id={id}
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
  id,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <select
      id={id}
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
  /** Enum inputs: the allowed values (what a Value compared with this input must be one of). */
  values?: string[];
}

/** What a literal ("Value") operand should look like given the OTHER side of a comparison. */
export type LiteralKind = { kind: 'enum'; ref: string; values: string[] } | { kind: 'number' } | { kind: 'any' };

/** Comparison ops allowed for text (enum) comparisons — ordering (≥ ≤ > <) on text is always false. */
export const TEXT_OPS: ReadonlySet<string> = new Set(['eq', 'neq']);

/** The enum input an operand refers to, if it is a var bound to an enum-typed input. */
export function enumVarOf(op: Operand | undefined, vars: VarOption[]): VarOption | null {
  if (!op || !isVarOperand(op)) return null;
  const v = vars.find((x) => x.ref === op.var);
  return v && v.type === 'enum' ? v : null;
}

/** The literal kind for one side of a condition, from the other side (enum input → its values; number input → number). */
export function literalKindFor(other: Operand | undefined, vars: VarOption[]): LiteralKind {
  if (!other || !isVarOperand(other)) return { kind: 'any' };
  const v = vars.find((x) => x.ref === other.var);
  if (!v) return { kind: 'any' };
  if (v.type === 'enum') return { kind: 'enum', ref: v.ref, values: v.values ?? [] };
  return { kind: 'number' };
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
  literal,
  'aria-label': ariaLabel,
}: {
  value: Operand;
  onChange: (op: Operand) => void;
  vars: VarOption[];
  numericOnly?: boolean;
  disabled?: boolean;
  /**
   * Shape of the Value box, from the other side of a comparison: `enum` → a dropdown of that input's allowed values
   * (a text comparison); `number` → a number box; `any`/omitted → number box for a number literal, free text otherwise.
   */
  literal?: LiteralKind;
  'aria-label'?: string;
}) {
  const kind: 'var' | 'lit' = isVarOperand(value) ? 'var' : 'lit';
  const selectable = numericOnly ? vars.filter((v) => v.type === 'number') : vars;
  const litIsNumber = !isVarOperand(value) && typeof value.lit === 'number';
  const selCls = `${inputCls} disabled:bg-gray-100 disabled:text-gray-400`;
  const enumLit = !numericOnly && literal?.kind === 'enum' ? literal : null;
  // A fresh Value for an enum comparison starts EMPTY ("— pick a value —", flagged) — never a silently chosen value.
  const freshLit = (): Operand => (enumLit ? { lit: '' } : { lit: 0 });

  return (
    <div className="flex gap-1.5">
      <select
        value={kind}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === 'var') onChange({ var: selectable[0]?.ref ?? '' });
          else onChange(freshLit());
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
      ) : enumLit ? (
        (() => {
          const cur = !isVarOperand(value) ? String(value.lit) : '';
          const known = enumLit.values.includes(cur);
          return (
            <select
              value={cur}
              disabled={disabled}
              aria-label={ariaLabel ?? `Value for ${enumLit.ref}`}
              onChange={(e) => onChange({ lit: e.target.value })}
              className={`${selCls} ${known ? '' : 'border-red-300 text-red-700'}`}
            >
              {!known && (
                <option value={cur}>{cur === '' ? '— pick a value —' : `${cur} — value not in the allowed list`}</option>
              )}
              {enumLit.values.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          );
        })()
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
    name: '',
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
    name: row.name ?? '',
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

// ── Rule display name (display-only metadata — never affects compute) ─────────────────

/** Max length of a rule name (mirrors the backend RULE_NAME_MAX, checked on the trimmed value). */
export const RULE_NAME_MAX = 120;
/** Placeholder shown in every rule-name box. */
export const RULE_NAME_PLACEHOLDER = 'e.g. Unnati – ADHO 2.5%';
/** Shown wherever an unnamed rule is listed (with its ruleId alongside). */
export const UNNAMED_RULE = 'Unnamed rule';

/** Collapse internal whitespace + trim — exactly what the backend stores. */
export function cleanRuleName(name: string | null | undefined): string {
  return (name ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Blocking issue for a rule name, or null. A NEW rule must be named (soft requirement — Save draft is blocked with
 * this message); an existing rule may stay unnamed. A provided name must fit RULE_NAME_MAX.
 */
export function ruleNameIssue(name: string | null | undefined, required: boolean): string | null {
  const t = cleanRuleName(name);
  if (t === '') return required ? 'Give the rule a name (e.g. “Unnati – ADHO 2.5%”) so it can be told apart in lists and reports.' : null;
  if (t.length > RULE_NAME_MAX) return `Rule name is ${t.length} characters — keep it to ${RULE_NAME_MAX}.`;
  return null;
}

/**
 * Non-blocking warning when ANOTHER logical rule (different ruleId) already uses this name (case-insensitive).
 * Duplicates are allowed — they only make lists / reports ambiguous.
 */
export function duplicateRuleNameWarning(
  name: string | null | undefined,
  ownRuleId: string | null | undefined,
  rules: ReadonlyArray<Pick<PointsRuleRow, 'ruleId' | 'name'>>,
): string | null {
  const t = cleanRuleName(name).toLowerCase();
  if (t === '') return null;
  const clash = new Set(
    rules.filter((r) => r.ruleId !== ownRuleId && cleanRuleName(r.name).toLowerCase() === t).map((r) => r.ruleId),
  );
  if (clash.size === 0) return null;
  return `Another rule is already named “${cleanRuleName(name)}” — that is allowed, but lists and reports will show the same name for both. Consider a more specific name.`;
}

/** The title to show for a rule: its name, or "Unnamed rule" (the caller shows the ruleId alongside). */
export function ruleTitle(row: { name?: string | null }): { title: string; unnamed: boolean } {
  const t = cleanRuleName(row.name);
  return t ? { title: t, unnamed: false } : { title: UNNAMED_RULE, unnamed: true };
}

/**
 * Resolve a rule's output credit-field id to its NAME for display. An unknown or inactive field is called out
 * loudly — "<id> (field not found)" / "<name> (inactive)" — never shown as a bare id.
 */
export function creditFieldLabel(
  fieldId: string | null | undefined,
  fields: ReadonlyArray<{ id: string; name: string; isActive: boolean }>,
): { label: string; problem: 'missing' | 'inactive' | null } {
  const id = (fieldId ?? '').trim();
  if (id === '') return { label: '—', problem: 'missing' };
  const f = fields.find((x) => x.id === id);
  if (!f) return { label: `${id} (field not found)`, problem: 'missing' };
  if (!f.isActive) return { label: `${f.name} (inactive)`, problem: 'inactive' };
  return { label: f.name, problem: null };
}

/** Name for a duplicated rule: "<name> (copy)", trimmed to fit RULE_NAME_MAX; '' when the source is unnamed. */
export function copyRuleName(name: string | null | undefined): string {
  const t = cleanRuleName(name);
  if (t === '') return '';
  const suffix = ' (copy)';
  return t.length + suffix.length <= RULE_NAME_MAX ? `${t}${suffix}` : `${t.slice(0, RULE_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
}

/**
 * "Duplicate rule": a NEW-rule draft pre-filled from a stored rule — attachment, period basis, effective dates,
 * inputs, pipeline (every step gets a FRESH id), output, rounding and the name "<name> (copy)". It carries NO
 * ruleId, so saving mints a brand-new logical rule (version 1, draft); the source rule is never touched. Deep-cloned
 * so editing the copy can never mutate the loaded source object.
 */
export function duplicateDraft(row: PointsRuleRow): RuleConfigDraft {
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const base = rowToDraft(row);
  return {
    name: copyRuleName(row.name),
    effectiveFrom: base.effectiveFrom,
    effectiveTo: base.effectiveTo ?? null,
    evaluationBasis: base.evaluationBasis,
    attachsTo: clone(base.attachsTo),
    output: clone(base.output),
    rounding: clone(base.rounding),
    inputs: clone(base.inputs),
    pipeline: clone(base.pipeline).map((n) => ({ ...n, id: genId() })),
  };
}

/** The var options the pipeline + simulator may reference (declared input refs + their type). */
export function varOptions(inputs: RuleInput[]): VarOption[] {
  return inputs
    .filter((i) => i.ref.trim() !== '')
    .map((i) => (i.type === 'enum' ? { ref: i.ref, type: i.type, values: (i.values ?? []).filter((v) => v !== '') } : { ref: i.ref, type: i.type }));
}

/** The first NUMBER-typed input ref (for seeding a new node's measure — never an enum, which the
 *  backend rejects as a numeric measure). '' when the rule has no numeric input yet. */
export function firstNumericVar(inputs: RuleInput[]): string {
  return inputs.find((i) => i.type === 'number' && i.ref.trim() !== '')?.ref ?? '';
}

/** Max length of a gate's failReason (mirrors the backend validateRule). */
export const GATE_FAIL_REASON_MAX = 200;

/** Flatten a predicate to its leaf operands (for validation). */
/** Every leaf condition of a predicate. */
export function predicateConditions(p: Predicate): Array<{ op: string; left: Operand; right: Operand }> {
  if ('op' in p) return [p];
  if ('all' in p) return p.all.flatMap(predicateConditions);
  if ('any' in p) return p.any.flatMap(predicateConditions);
  if ('not' in p) return predicateConditions(p.not);
  return [];
}

/**
 * Text (enum) comparisons that can never be true in the engine — an ordering op (≥ ≤ > <) on text, a NUMBER
 * compared with text, or a value outside the input's allowed values. Warnings, not blocking (the backend accepts
 * them; they just always evaluate false / never match).
 */
export function enumConditionWarnings(p: Predicate, vars: VarOption[], where: string): string[] {
  const out: string[] = [];
  for (const c of predicateConditions(p)) {
    const ev = enumVarOf(c.left, vars) ?? enumVarOf(c.right, vars);
    if (!ev) continue;
    const other = enumVarOf(c.left, vars) ? c.right : c.left;
    if (!TEXT_OPS.has(c.op)) out.push(`${where}: "${ev.ref}" is text — use = or ≠ (≥ ≤ > < never match text).`);
    if (!isVarOperand(other)) {
      if (typeof other.lit === 'number') out.push(`${where}: "${ev.ref}" is text but is compared with the number ${other.lit} — pick one of its values.`);
      else if (other.lit === '') out.push(`${where}: pick a value for "${ev.ref}" (${(ev.values ?? []).join(', ')}).`);
      else if (!(ev.values ?? []).includes(other.lit)) out.push(`${where}: "${other.lit}" — value not in the allowed list of "${ev.ref}" (${(ev.values ?? []).join(', ')}), so it never matches.`);
    }
  }
  return out;
}

export function predicateOperands(p: Predicate): Operand[] {
  if ('op' in p) return [p.left, p.right];
  if ('all' in p) return p.all.flatMap(predicateOperands);
  if ('any' in p) return p.any.flatMap(predicateOperands);
  if ('not' in p) return predicateOperands(p.not);
  return [];
}

/**
 * Extract the variable references used in a formula expression, mirroring the backend lexer/parser:
 * an identifier NOT immediately followed by `(` is a variable (one followed by `(` is a function call).
 * String literals are stripped first so quoted text is never mistaken for a variable. Used only to steer
 * the author — the backend's parseFormula remains the authority. (Deliberately not stricter: it flags an
 * identifier only when the backend's walkAst would emit the same "undeclared input" error.)
 */
export function formulaVarRefs(expr: string): string[] {
  const noStrings = expr.replace(/'[^']*'|"[^"]*"/g, ' ');
  const refs: string[] = [];
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noStrings)) !== null) {
    const after = noStrings.slice(m.index + m[0].length);
    if (/^\s*\(/.test(after)) continue; // a function call, not a variable reference
    refs.push(m[0]);
  }
  return refs;
}

/**
 * Pre-submit draft validation that mirrors the backend validateRule for the cases a builder can hit, so
 * the author is steered to a valid rule instead of a raw 400. BLOCKING issues are ones validateRule
 * definitely rejects (a duplicate/absent/double-sourced input, an enum input with no values, an
 * empty/unknown operand var, an enum used as a numeric measure, a non-contiguous or wrongly open slab
 * band, an empty formula or one referencing an undeclared input, an inverted effective window). WARNINGS
 * are valid-but-footgun configs (no pipeline, a zero rate, a cap that zeroes everything, an empty segment
 * allow-list, a gate whose failure won't withhold) — surfaced, not blocked, so we never prevent a config
 * the backend would accept. Deliberately never STRICTER than validateRule.
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

  // ── inputs (mirror validateRule's inputs block exactly) ────────────────────────
  const declared = new Set<string>();
  draft.inputs.forEach((inp, i) => {
    const w = `Input ${i + 1}`;
    if (inp.ref === '') blocking.push(`${w}: give the input a reference name.`);
    else if (declared.has(inp.ref)) blocking.push(`${w}: duplicate reference name "${inp.ref}".`);
    else declared.add(inp.ref);

    const hasKpi = typeof inp.kpiCode === 'string' && inp.kpiCode !== '';
    const hasSrc = typeof inp.source === 'string' && inp.source !== '';
    if (hasKpi === hasSrc)
      blocking.push(`${w}: set exactly one source — a KPI code, or a target / % / segment field.`);

    if (inp.type === 'enum' && (!Array.isArray(inp.values) || inp.values.length === 0))
      blocking.push(`${w}: an enum / segment input must list at least one allowed value.`);

    // Visibility sources (design §3a) — mirror validateRule: a known key, number-typed.
    if (hasSrc && inp.source!.startsWith('visibility:')) {
      const key = inp.source!.slice('visibility:'.length);
      if (!VISIBILITY_SOURCES.some((v) => v.key === key)) blocking.push(`${w}: pick which visibility value to read.`);
      if (inp.type !== 'number') blocking.push(`${w}: a visibility input must be a Number.`);
      if (draft.evaluationBasis === 'QUARTER') blocking.push(`${w}: visibility is monthly — a quarterly rule cannot read it yet.`);
    }
    // Quarterly binding — mirror validateRule: a month only on a quarterly rule.
    if (inp.month !== undefined && draft.evaluationBasis !== 'QUARTER')
      blocking.push(`${w}: “month of the quarter” is only for quarterly rules.`);
  });

  // §3a: "every window approved" without inScope — mirrors the backend ruleWarnings (non-blocking).
  const srcs = new Set(draft.inputs.map((i) => i.source).filter((x): x is string => !!x));
  if (srcs.has('visibility:approvedWindows') && srcs.has('visibility:windows') && !srcs.has('visibility:inScope')) {
    warnings.push(
      'This rule compares approved visibility windows with the month’s windows but does not read “Outlet in the visibility programme (1/0)”. Outlets outside the programme never pass (they read 0 approved) — add the inScope input if they should be treated differently.',
    );
  }

  // ── effective window ───────────────────────────────────────────────────────────
  if (draft.effectiveTo && draft.effectiveFrom && draft.effectiveTo < draft.effectiveFrom)
    blocking.push('Effective-to must be on or after effective-from.');

  if (draft.pipeline.length === 0) {
    warnings.push('No steps yet — every outlet would compute 0 points.');
  }

  draft.pipeline.forEach((n, i) => {
    const where = `Step ${i + 1} (${n.type})`;
    switch (n.type) {
      case 'rate':
        checkOperand(n.measure, where, true);
        if (n.rate === 0) warnings.push(`${where}: a rate of 0 pays no points.`);
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
      case 'gate': {
        predicateOperands(n.when).forEach((op) => checkOperand(op, where, false));
        warnings.push(...enumConditionWarnings(n.when, opts, where));
        // failAs (opt-in) decides the failure when set: 'zero' and 'skip' both withhold.
        const hard = n.failAs === 'zero' || n.failAs === 'skip' || n.onFail === 'zero';
        if (!hard) warnings.push(`${where}: this gate won't withhold points on failure — only "Pay 0" withholds.`);
        if (n.failAs !== undefined && n.failAs !== 'zero' && n.failAs !== 'skip')
          blocking.push(`${where}: choose what happens when the check fails.`);
        if (typeof n.failReason === 'string') {
          if (n.failReason.length > GATE_FAIL_REASON_MAX)
            blocking.push(`${where}: the reason is ${n.failReason.length} characters — keep it to ${GATE_FAIL_REASON_MAX}.`);
          if (n.failReason.trim() !== '' && !hard)
            blocking.push(`${where}: a reason is only shown when the gate pays 0 or skips the row — switch to "Pay 0" or remove the reason.`);
          if (draft.evaluationBasis !== 'QUARTER' && QUARTER_PLACEHOLDERS.some((p) => n.failReason!.includes(p)))
            blocking.push(`${where}: {m1} / {m2} / {m3} / {quarter} in a reason only work on a quarterly rule — make the rule Quarterly or remove them.`);
        }
        break;
      }
      case 'milestone':
        predicateOperands(n.when).forEach((op) => checkOperand(op, where, false));
        warnings.push(...enumConditionWarnings(n.when, opts, where));
        break;
      case 'segmentFilter':
        if (n.allow.length === 0)
          warnings.push(`${where}: no values allowed — every outlet is filtered out (0 points).`);
        if (n.onFail !== 'zero')
          warnings.push(`${where}: this filter won't withhold points on failure — only "Pay 0" withholds.`);
        if (typeof n.failReason === 'string' && n.failReason.trim() !== '' && (draft.evaluationBasis !== 'QUARTER' || n.onFail !== 'zero'))
          blocking.push(`${where}: a filter's reason is only shown on a quarterly rule whose filter pays 0 — remove it or make the rule Quarterly.`);
        break;
      case 'cap':
        if (n.max <= 0) warnings.push(`${where}: a cap of ${n.max} clamps every total to ${n.max}.`);
        break;
      case 'formula':
        if (!n.expr.trim()) {
          blocking.push(`${where}: enter a formula expression.`);
        } else {
          [...new Set(formulaVarRefs(n.expr))].forEach((v) => {
            if (!allRefs.has(v)) blocking.push(`${where}: formula references an unknown input "${v}".`);
          });
        }
        break;
    }
  });

  // Quarter-only output setting kept on a monthly rule (never stripped silently) → must be removed or the rule made quarterly.
  if (draft.evaluationBasis !== 'QUARTER' && typeof draft.output.narration === 'string' && draft.output.narration.trim() !== '')
    blocking.push('Output: the credit narration is only used by quarterly rules — clear it or make the rule Quarterly.');

  return { blocking, warnings };
}

/** Gate-reason placeholders a QUARTERLY rule may use (mirror of the backend QUARTER_PLACEHOLDERS). */
export const QUARTER_PLACEHOLDERS = ['{m1}', '{m2}', '{m3}', '{quarter}'] as const;

// ── Rules list: program / sub-programme / KPI columns + sort ─────────────────────────
/** Blank program / sub-programme on a rule = it matches ALL of them — shown as "All (blank)". */
export const BLANK_LABEL = 'All (blank)';
/** Sub-programme filter value meaning "rules with no sub-programme". */
export const SUB_BLANK = '__blank__';
export function programCell(v: string | null | undefined): string {
  return v && v.trim() ? v : BLANK_LABEL;
}

export type RuleSortKey = 'program' | 'subProgram' | 'kpi' | 'status';
const STATUS_ORDER: Record<RuleStatus, number> = { published: 0, draft: 1, archived: 2 };

/** Client-side sort of the loaded rows (stable; ties keep the server order: ruleId asc, version desc). */
export function sortRules(rows: PointsRuleRow[], key: RuleSortKey | null, dir: 'asc' | 'desc'): PointsRuleRow[] {
  if (!key) return rows;
  // Program / sub-programme: a BLANK ("All (blank)") always sorts FIRST, in either direction.
  const blank = (r: PointsRuleRow): boolean =>
    key === 'program' ? !r.program?.trim() : key === 'subProgram' ? !r.programCategory?.trim() : false;
  const val = (r: PointsRuleRow): string | number =>
    key === 'program' ? (r.program ?? '').trim().toLowerCase()
      : key === 'subProgram' ? (r.programCategory ?? '').trim().toLowerCase()
        : key === 'kpi' ? (r.kpiCode ?? '').toLowerCase()
          : STATUS_ORDER[r.status] ?? 9;
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ba = blank(a.r);
      const bb = blank(b.r);
      if (ba !== bb) return ba ? -1 : 1;
      const va = val(a.r);
      const vb = val(b.r);
      if (va < vb) return -sign;
      if (va > vb) return sign;
      return a.i - b.i;
    })
    .map((x) => x.r);
}
