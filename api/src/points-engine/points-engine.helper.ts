/**
 * points-engine.helper.ts — Points Compute Engine (Wave 0): the PURE evaluator + validator.
 *
 * Sibling of `schemes/enrollment-form.helper.ts` — the same "hand-rolled tokenizer, NO eval"
 * discipline, extended from a flat left-to-right formula into a full whitelisted-AST evaluator.
 *
 * NO DB, NO NestJS, NO I/O, NO clock, NO random. `evaluateRule(rule, ctx)` is pure & deterministic:
 * the same (rule, ctx) ALWAYS yields the same EvalOutcome. Safe to import in spec files without the
 * module graph. Implements the contract in `points-engine.types.ts` exactly (that file is not edited).
 *
 * See docs/plans/POINTS-COMPUTE-ENGINE-DESIGN.md — §3 schema, §4 pipeline order, §5 formula safety,
 * §10 worked archetypes A–D.
 *
 * ── Pipeline order (§4, strict) ────────────────────────────────────────────────────────────────
 *   1. Bind `inputs` from ctx; apply each input's `nullAs` BEFORE any arithmetic.
 *        reject   → the whole row is SKIPPED-with-reason (EvalOutcome 'SKIP').     [safe default]
 *        skipRule → the rule contributes 0 points (EvalOutcome 'OK', points 0).
 *        zero     → treat the absent value as 0 and continue.
 *      (reject DOMINATES skipRule — a row needing review is never silently zeroed; see bindInputs.)
 *   2. `gate` / `segmentFilter` short-circuit per `onFail` (a hard `zero` fail ends the rule at 0
 *      BEFORE floor/cap — so a floor can never resurrect a gated-out row).
 *   3. Accrual nodes (`rate`, `slab`, `milestone`, `formula`) in listed order, accumulating points.
 *   4. `floor` then `cap` — ALWAYS that order (cap-before-floor could land below the floor).
 *   5. A SINGLE rounding at the very end per `rule.rounding`, then clamp to ≥ 0.
 *   6. Emit `{ status:'OK', points, trace }` (points = non-negative whole integer when scale 0).
 */

import {
  PointsRuleConfig,
  EvalContext,
  EvalOutcome,
  TraceStep,
  RuleInput,
  Operand,
  Condition,
  Predicate,
  CompareOp,
  PipelineNode,
  SlabNode,
  SlabBand,
  RoundingSpec,
} from './points-engine.types';

// ─────────────────────────────────────────────────────────────────────────────
// Enumerated constants (the single source of truth for "well-formed")
// ─────────────────────────────────────────────────────────────────────────────

const NULL_POLICIES: ReadonlySet<string> = new Set(['reject', 'zero', 'skipRule']);
const COMPARE_OPS: ReadonlySet<string> = new Set(['gte', 'lte', 'gt', 'lt', 'eq', 'neq']);
const ON_FAIL: ReadonlySet<string> = new Set(['zero', 'skipNode', 'passthrough']);
const SLAB_BASES: ReadonlySet<string> = new Set(['absolute', 'pct_of_target']);
const SLAB_APPLY: ReadonlySet<string> = new Set(['marginal', 'whole']);
const FORMULA_OUTPUTS: ReadonlySet<string> = new Set(['add', 'multiply', 'set']);
const ROUNDING_MODES: ReadonlySet<string> = new Set(['half_up', 'half_even', 'floor', 'ceil']);

/** Whitelisted formula functions → allowed arity [min,max]. Nothing else may be called. */
const FORMULA_FUNCS: Record<string, { min: number; max: number }> = {
  min: { min: 1, max: Infinity },
  max: { min: 1, max: Infinity },
  abs: { min: 1, max: 1 },
  round: { min: 1, max: 1 },
  floor: { min: 1, max: 1 },
  ceil: { min: 1, max: 1 },
  clamp: { min: 3, max: 3 }, // clamp(x, lo, hi)
  if: { min: 3, max: 3 }, //    if(cond, a, b)
};

const MAX_AST_DEPTH = 20;
const MAX_AST_NODES = 200;

const OP_SYMBOL: Record<CompareOp, string> = {
  gte: '≥',
  lte: '≤',
  gt: '>',
  lt: '<',
  eq: '=',
  neq: '≠',
};

// ─────────────────────────────────────────────────────────────────────────────
// Control-flow signals (caught by evaluateRule → shaped into EvalOutcome)
// ─────────────────────────────────────────────────────────────────────────────

/** A data condition that should surface the row for review (→ EvalOutcome 'SKIP'). */
class RuleSkip extends Error {}
/** A malformed rule that reached runtime (→ EvalOutcome 'ERROR'). */
class RuleError extends Error {}
/** A formula that would not parse — a malformed rule, so it maps to ERROR too. */
class FormulaParseError extends RuleError {}

// ─────────────────────────────────────────────────────────────────────────────
// Small numeric / formatting utilities
// ─────────────────────────────────────────────────────────────────────────────

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Compact human number for trace details (integers bare, decimals to 4 dp). */
function fmt(n: number | string | boolean): string {
  if (typeof n !== 'number') return String(n);
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10000) / 10000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Input binding + null policy (§4.1)
// ─────────────────────────────────────────────────────────────────────────────

type BoundValues = Record<string, number | string>;

type BindResult =
  | { kind: 'ok'; values: BoundValues }
  | { kind: 'skip'; reason: string } //      reject → EvalOutcome SKIP
  | { kind: 'ruleZero'; reason: string }; // skipRule → EvalOutcome OK / 0

function sourceLabel(input: RuleInput): string {
  if (input.kpiCode) return `kpi:${input.kpiCode}`;
  if (input.source) return input.source;
  return '(no source)';
}

/** Resolve the raw value for an input from the context. undefined/missing collapses to null (= absent). */
function resolveRaw(input: RuleInput, ctx: EvalContext): number | string | null {
  if (input.kpiCode) {
    const v = ctx.achievements ? ctx.achievements[input.kpiCode] : undefined;
    return v === undefined || v === null ? null : v;
  }
  if (input.source) {
    const idx = input.source.indexOf(':');
    const kind = idx >= 0 ? input.source.slice(0, idx) : input.source;
    const key = idx >= 0 ? input.source.slice(idx + 1) : '';
    let v: unknown;
    if (kind === 'target') v = ctx.targets ? ctx.targets[key] : undefined;
    else if (kind === 'achievement') v = ctx.achievements ? ctx.achievements[key] : undefined;
    else if (kind === 'segment') v = ctx.segment ? (ctx.segment as Record<string, unknown>)[key] : undefined;
    else if (kind === 'pct') {
      // Derived: achievement % of target (achievement ÷ target × 100). Lets gates/milestones compare
      // against achievement RELATIVE to each outlet's own target (e.g. "pay nothing below 80% of target"),
      // which a fixed literal can't express since every outlet has a different target. Target null/≤0 →
      // absent, so the input's nullAs policy applies (never divides by zero).
      const a = ctx.achievements ? ctx.achievements[key] : undefined;
      const t = ctx.targets ? ctx.targets[key] : undefined;
      v = a == null || t == null || t <= 0 ? undefined : (a / t) * 100;
    } else v = undefined; // unknown source kind → absent (validateRule flags the config)
    if (v === undefined || v === null) return null;
    if (typeof v === 'number' || typeof v === 'string') return v;
    return null;
  }
  return null;
}

/**
 * Bind every input, applying its null policy BEFORE any arithmetic. Precedence when several inputs
 * are absent: a single `reject` dominates (the whole row surfaces for review — a row that needs a
 * human must never be silently zeroed by a later `skipRule`); else any `skipRule` makes the rule
 * contribute 0; else absent `zero` inputs become 0 and we proceed. A present-but-non-numeric number
 * input, or an enum value outside its `values`, is treated as a reject (bad data, surface it).
 */
function bindInputs(inputs: RuleInput[], ctx: EvalContext): BindResult {
  const values: BoundValues = {};
  const rejects: string[] = [];
  const skips: string[] = [];

  for (const inp of inputs) {
    const raw = resolveRaw(inp, ctx);
    const absent = raw === null;

    if (absent) {
      if (inp.nullAs === 'reject') rejects.push(`${inp.ref} (${sourceLabel(inp)})`);
      else if (inp.nullAs === 'skipRule') skips.push(`${inp.ref} (${sourceLabel(inp)})`);
      else values[inp.ref] = inp.type === 'enum' ? '' : 0; // 'zero'
      continue;
    }

    if (inp.type === 'number') {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) {
        rejects.push(`${inp.ref} is non-numeric ("${String(raw)}")`);
        continue;
      }
      values[inp.ref] = n;
    } else {
      // enum
      const s = String(raw);
      if (Array.isArray(inp.values) && inp.values.length > 0 && !inp.values.includes(s)) {
        rejects.push(`${inp.ref} value "${s}" is not an allowed enum value`);
        continue;
      }
      values[inp.ref] = s;
    }
  }

  if (rejects.length > 0) {
    return { kind: 'skip', reason: `Missing/invalid input(s): ${rejects.join('; ')}` };
  }
  if (skips.length > 0) {
    return { kind: 'ruleZero', reason: `Input(s) absent (skipRule → 0 points): ${skips.join('; ')}` };
  }
  return { kind: 'ok', values };
}

// ─────────────────────────────────────────────────────────────────────────────
// Operands & predicates
// ─────────────────────────────────────────────────────────────────────────────

function resolveOperand(op: Operand, values: BoundValues): number | string {
  if ('var' in op) {
    if (!(op.var in values)) throw new RuleError(`operand references unbound variable "${op.var}"`);
    return values[op.var];
  }
  return op.lit;
}

/** Resolve an operand that MUST be a finite number (rate/slab measure, etc.). */
function numOperand(op: Operand, values: BoundValues, label: string): number {
  const v = resolveOperand(op, values);
  if (!isFiniteNum(v)) throw new RuleError(`${label} is not a finite number ("${String(v)}")`);
  return v;
}

function operandLabel(op: Operand, values: BoundValues): string {
  if ('var' in op) return `${op.var}=${fmt(resolveOperand(op, values))}`;
  return fmt(op.lit);
}

function compareValues(opc: CompareOp, l: number | string, r: number | string): boolean {
  switch (opc) {
    case 'eq':
      return typeof l === typeof r ? l === r : false;
    case 'neq':
      return typeof l === typeof r ? l !== r : true;
    case 'gte':
    case 'lte':
    case 'gt':
    case 'lt': {
      if (!isFiniteNum(l) || !isFiniteNum(r)) return false;
      if (opc === 'gte') return l >= r;
      if (opc === 'lte') return l <= r;
      if (opc === 'gt') return l > r;
      return l < r;
    }
    default:
      return false;
  }
}

function isCondition(p: Predicate): p is Condition {
  return typeof (p as Condition).op === 'string';
}

function evalPredicate(pred: Predicate, values: BoundValues): boolean {
  if (isCondition(pred)) {
    return compareValues(pred.op, resolveOperand(pred.left, values), resolveOperand(pred.right, values));
  }
  if ('all' in pred) return pred.all.every((p) => evalPredicate(p, values));
  if ('any' in pred) return pred.any.some((p) => evalPredicate(p, values));
  if ('not' in pred) return !evalPredicate(pred.not, values);
  throw new RuleError('malformed predicate');
}

function describePredicate(pred: Predicate, values: BoundValues): string {
  if (isCondition(pred)) {
    return `${operandLabel(pred.left, values)} ${OP_SYMBOL[pred.op] ?? pred.op} ${operandLabel(pred.right, values)}`;
  }
  if ('all' in pred) return `all(${pred.all.map((p) => describePredicate(p, values)).join(', ')})`;
  if ('any' in pred) return `any(${pred.any.map((p) => describePredicate(p, values)).join(', ')})`;
  if ('not' in pred) return `not(${describePredicate(pred.not, values)})`;
  return '?';
}

// ─────────────────────────────────────────────────────────────────────────────
// Slab (§ L2) — absolute | pct_of_target × marginal | whole
// ─────────────────────────────────────────────────────────────────────────────

/** Effective bands in MEASURE units (for pct_of_target, pct boundaries are scaled by target/100). */
function effectiveBands(node: SlabNode, values: BoundValues): { bands: SlabBand[]; pct?: number; target?: number } {
  if (node.basis === 'absolute') {
    return { bands: node.bands };
  }
  // pct_of_target: rate is per MEASURE unit (a case), bands just express thresholds RELATIVE to the
  // outlet's target. We scale each pct boundary into measure units and run the same algorithm on the
  // raw measure — so a 120%/target-500 outlet rates the same cases as an absolute band at those cases.
  if (!node.target) {
    throw new RuleError(`slab "${node.id}": basis 'pct_of_target' requires a target operand`);
  }
  const target = numOperand(node.target, values, `slab "${node.id}" target`);
  if (!(target > 0)) {
    // target 0 / null / negative → cannot form a percent-of-target. NEVER divide by zero; surface it.
    throw new RuleSkip(
      `slab "${node.id}": target is ${fmt(target)} — cannot compute percent-of-target (would divide by zero)`,
    );
  }
  const measure = numOperand(node.measure, values, `slab "${node.id}" measure`);
  const scaled = node.bands.map((b) => ({
    from: (b.from / 100) * target,
    to: b.to === null ? null : (b.to / 100) * target,
    rate: b.rate,
    flat: b.flat,
  }));
  return { bands: scaled, pct: (measure / target) * 100, target };
}

function evalSlab(node: SlabNode, values: BoundValues): { delta: number; detail: string } {
  const m = numOperand(node.measure, values, `slab "${node.id}" measure`);
  const { bands, pct } = effectiveBands(node, values);
  const basisNote =
    node.basis === 'pct_of_target' && pct !== undefined ? ` [${fmt(m)} = ${fmt(pct)}% of target]` : '';

  if (node.apply === 'whole') {
    // The band the measure LANDS in re-rates the ENTIRE measure at that band's rate (+ its flat).
    let landing: SlabBand | null = null;
    let idx = -1;
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      const hi = b.to === null ? Infinity : b.to;
      if (m >= b.from && m < hi) {
        landing = b;
        idx = i;
        break;
      }
    }
    if (!landing) {
      return { delta: 0, detail: `slab "${node.id}" whole${basisNote}: ${fmt(m)} below all bands → +0` };
    }
    const delta = m * (landing.rate ?? 0) + (landing.flat ?? 0);
    const upper = landing.to === null ? '∞' : fmt(landing.to);
    return {
      delta,
      detail:
        `slab "${node.id}" WHOLE${basisNote}: ${fmt(m)} lands band#${idx} [${fmt(landing.from)}–${upper})` +
        ` @${fmt(landing.rate ?? 0)}${landing.flat ? `+${fmt(landing.flat)}` : ''} re-rates all ${fmt(m)} → +${fmt(delta)}`,
    };
  }

  // marginal (tax-bracket): sum over bands of (units-in-band × rate) + each entered band's flat.
  let delta = 0;
  const parts: string[] = [];
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const hi = b.to === null ? Infinity : b.to;
    const upper = Math.min(m, hi);
    const units = upper - b.from;
    if (units > 0) {
      const sub = units * (b.rate ?? 0) + (b.flat ?? 0);
      delta += sub;
      parts.push(`${fmt(units)}×${fmt(b.rate ?? 0)}${b.flat ? `+${fmt(b.flat)}` : ''}`);
    }
  }
  return {
    delta,
    detail: `slab "${node.id}" MARGINAL${basisNote}: ${parts.length ? parts.join(' + ') : '0'} → +${fmt(delta)}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formula (§ L4) — tokenizer → Pratt parser → whitelisted AST → walk-evaluate (NO eval)
// ─────────────────────────────────────────────────────────────────────────────

type Ast =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'var'; name: string }
  | { t: 'un'; op: string; x: Ast }
  | { t: 'bin'; op: string; l: Ast; r: Ast }
  | { t: 'call'; name: string; args: Ast[] };

interface Token {
  kind: 'num' | 'str' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma';
  value: string;
}

const MULTI_OPS = ['==', '!=', '<=', '>=', '&&', '||'];
const SINGLE_OPS = '+-*/%<>!';

function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  const n = src.length;
  let i = 0;
  const isDigit = (c: string) => c >= '0' && c <= '9';
  const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
  const isIdent = (c: string) => /[A-Za-z0-9_]/.test(c);

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    // number: must START with a digit — a leading '.' is rejected (closes off member access like `.foo`)
    if (isDigit(c)) {
      let j = i + 1;
      let dot = false;
      while (j < n && (isDigit(src[j]) || (src[j] === '.' && !dot))) {
        if (src[j] === '.') dot = true;
        j++;
      }
      toks.push({ kind: 'num', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdent(src[j])) j++;
      toks.push({ kind: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== q) {
        s += src[j];
        j++;
      }
      if (j >= n) throw new FormulaParseError('unterminated string literal');
      toks.push({ kind: 'str', value: s });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) {
      toks.push({ kind: 'op', value: two });
      i += 2;
      continue;
    }
    if (SINGLE_OPS.includes(c)) {
      toks.push({ kind: 'op', value: c });
      i++;
      continue;
    }
    if (c === '(') {
      toks.push({ kind: 'lparen', value: c });
      i++;
      continue;
    }
    if (c === ')') {
      toks.push({ kind: 'rparen', value: c });
      i++;
      continue;
    }
    if (c === ',') {
      toks.push({ kind: 'comma', value: c });
      i++;
      continue;
    }
    // Everything else — '.', '=', '&', '|', '[', ']', '{', '}', ';', '^', '~', etc. — is REJECTED.
    // This is what structurally blocks member access, indexing, assignment and bitwise tricks.
    throw new FormulaParseError(`unexpected character "${c}"`);
  }
  return toks;
}

class Parser {
  private pos = 0;
  constructor(private toks: Token[]) {}

  parse(): Ast {
    if (this.toks.length === 0) throw new FormulaParseError('empty formula');
    const e = this.parseExpr();
    if (this.pos !== this.toks.length) {
      throw new FormulaParseError(`unexpected trailing token "${this.toks[this.pos]?.value ?? ''}"`);
    }
    return e;
  }

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return !!t && t.kind === 'op' && t.value === v;
  }
  private next(): Token {
    const t = this.toks[this.pos];
    if (!t) throw new FormulaParseError('unexpected end of formula');
    this.pos++;
    return t;
  }
  private expect(kind: Token['kind']): Token {
    const t = this.next();
    if (t.kind !== kind) throw new FormulaParseError(`expected ${kind} but found "${t.value}"`);
    return t;
  }

  private parseExpr(): Ast {
    return this.parseOr();
  }
  private parseOr(): Ast {
    let l = this.parseAnd();
    while (this.isOp('||')) {
      this.next();
      l = { t: 'bin', op: '||', l, r: this.parseAnd() };
    }
    return l;
  }
  private parseAnd(): Ast {
    let l = this.parseEq();
    while (this.isOp('&&')) {
      this.next();
      l = { t: 'bin', op: '&&', l, r: this.parseEq() };
    }
    return l;
  }
  private parseEq(): Ast {
    let l = this.parseCmp();
    while (this.isOp('==') || this.isOp('!=')) {
      const op = this.next().value;
      l = { t: 'bin', op, l, r: this.parseCmp() };
    }
    return l;
  }
  private parseCmp(): Ast {
    let l = this.parseAdd();
    while (this.isOp('<') || this.isOp('<=') || this.isOp('>') || this.isOp('>=')) {
      const op = this.next().value;
      l = { t: 'bin', op, l, r: this.parseAdd() };
    }
    return l;
  }
  private parseAdd(): Ast {
    let l = this.parseMul();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().value;
      l = { t: 'bin', op, l, r: this.parseMul() };
    }
    return l;
  }
  private parseMul(): Ast {
    let l = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().value;
      l = { t: 'bin', op, l, r: this.parseUnary() };
    }
    return l;
  }
  private parseUnary(): Ast {
    if (this.isOp('-') || this.isOp('!')) {
      const op = this.next().value;
      return { t: 'un', op, x: this.parseUnary() };
    }
    return this.parsePrimary();
  }
  private parsePrimary(): Ast {
    const t = this.peek();
    if (!t) throw new FormulaParseError('unexpected end of formula');
    if (t.kind === 'num') {
      this.next();
      const v = Number(t.value);
      if (!Number.isFinite(v)) throw new FormulaParseError(`invalid number "${t.value}"`);
      return { t: 'num', v };
    }
    if (t.kind === 'str') {
      this.next();
      return { t: 'str', v: t.value };
    }
    if (t.kind === 'lparen') {
      this.next();
      const e = this.parseExpr();
      this.expect('rparen');
      return e;
    }
    if (t.kind === 'ident') {
      this.next();
      if (this.peek() && this.peek()!.kind === 'lparen') {
        this.next(); // consume '('
        const args: Ast[] = [];
        if (!(this.peek() && this.peek()!.kind === 'rparen')) {
          args.push(this.parseExpr());
          while (this.peek() && this.peek()!.kind === 'comma') {
            this.next();
            args.push(this.parseExpr());
          }
        }
        this.expect('rparen');
        return { t: 'call', name: t.value, args };
      }
      return { t: 'var', name: t.value };
    }
    throw new FormulaParseError(`unexpected token "${t.value}"`);
  }
}

function parseFormula(expr: string): Ast {
  return new Parser(tokenize(expr)).parse();
}

function astDepth(a: Ast): number {
  switch (a.t) {
    case 'num':
    case 'str':
    case 'var':
      return 1;
    case 'un':
      return 1 + astDepth(a.x);
    case 'bin':
      return 1 + Math.max(astDepth(a.l), astDepth(a.r));
    case 'call':
      return 1 + (a.args.length ? Math.max(...a.args.map(astDepth)) : 0);
  }
}

function astNodes(a: Ast): number {
  switch (a.t) {
    case 'num':
    case 'str':
    case 'var':
      return 1;
    case 'un':
      return 1 + astNodes(a.x);
    case 'bin':
      return 1 + astNodes(a.l) + astNodes(a.r);
    case 'call':
      return 1 + a.args.reduce((s, x) => s + astNodes(x), 0);
  }
}

function walkAst(a: Ast, visit: (n: Ast) => void): void {
  visit(a);
  if (a.t === 'un') walkAst(a.x, visit);
  else if (a.t === 'bin') {
    walkAst(a.l, visit);
    walkAst(a.r, visit);
  } else if (a.t === 'call') a.args.forEach((x) => walkAst(x, visit));
}

/** Whitelist-validate a parsed AST against the declared input refs. Returns [] when valid. */
function collectFormulaErrors(ast: Ast, declared: ReadonlySet<string>, prefix: string): string[] {
  const errs: string[] = [];
  const depth = astDepth(ast);
  if (depth > MAX_AST_DEPTH) errs.push(`${prefix}: AST too deep (${depth} > ${MAX_AST_DEPTH}).`);
  const nodes = astNodes(ast);
  if (nodes > MAX_AST_NODES) errs.push(`${prefix}: AST too large (${nodes} nodes > ${MAX_AST_NODES}).`);
  walkAst(ast, (n) => {
    if (n.t === 'var' && !declared.has(n.name)) {
      errs.push(`${prefix}: references undeclared input "${n.name}".`);
    }
    if (n.t === 'call') {
      const spec = FORMULA_FUNCS[n.name];
      if (!spec) {
        errs.push(`${prefix}: unknown function "${n.name}".`);
      } else if (n.args.length < spec.min || n.args.length > spec.max) {
        const want = spec.max === Infinity ? `${spec.min}+` : spec.min === spec.max ? `${spec.min}` : `${spec.min}-${spec.max}`;
        errs.push(`${prefix}: function "${n.name}" expects ${want} arg(s), got ${n.args.length}.`);
      }
    }
  });
  return errs;
}

type FVal = number | boolean | string;

function truthy(v: FVal): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return v.length > 0;
}

function numv(v: FVal): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new RuleSkip('formula produced a non-finite number');
    return v;
  }
  throw new RuleError(`formula arithmetic on a non-number ("${String(v)}")`);
}

function evalAst(a: Ast, vars: BoundValues): FVal {
  switch (a.t) {
    case 'num':
      return a.v;
    case 'str':
      return a.v;
    case 'var':
      if (!(a.name in vars)) throw new RuleError(`formula references unbound variable "${a.name}"`);
      return vars[a.name];
    case 'un':
      if (a.op === '-') return -numv(evalAst(a.x, vars));
      if (a.op === '!') return !truthy(evalAst(a.x, vars));
      throw new RuleError(`bad unary operator "${a.op}"`);
    case 'bin':
      return evalBin(a, vars);
    case 'call':
      return evalCall(a, vars);
  }
}

function evalBin(a: Extract<Ast, { t: 'bin' }>, vars: BoundValues): FVal {
  // Logical ops short-circuit (so `b != 0 && a/b > 1` never evaluates a/b when b is 0).
  if (a.op === '&&') return truthy(evalAst(a.l, vars)) && truthy(evalAst(a.r, vars));
  if (a.op === '||') return truthy(evalAst(a.l, vars)) || truthy(evalAst(a.r, vars));

  const l = evalAst(a.l, vars);
  const r = evalAst(a.r, vars);
  switch (a.op) {
    case '+':
      return numv(l) + numv(r);
    case '-':
      return numv(l) - numv(r);
    case '*':
      return numv(l) * numv(r);
    case '/': {
      const d = numv(r);
      if (d === 0) throw new RuleSkip('formula division by zero');
      return numv(l) / d;
    }
    case '%': {
      const d = numv(r);
      if (d === 0) throw new RuleSkip('formula modulo by zero');
      return numv(l) % d;
    }
    case '==':
      return typeof l === typeof r ? l === r : false;
    case '!=':
      return typeof l === typeof r ? l !== r : true;
    case '<':
      return numv(l) < numv(r);
    case '<=':
      return numv(l) <= numv(r);
    case '>':
      return numv(l) > numv(r);
    case '>=':
      return numv(l) >= numv(r);
    default:
      throw new RuleError(`bad binary operator "${a.op}"`);
  }
}

function evalCall(a: Extract<Ast, { t: 'call' }>, vars: BoundValues): FVal {
  // `if` is LAZY — only the taken branch is evaluated (so an untaken `a/0` branch cannot throw).
  if (a.name === 'if') {
    if (a.args.length !== 3) throw new RuleError('if() expects 3 arguments');
    return truthy(evalAst(a.args[0], vars)) ? evalAst(a.args[1], vars) : evalAst(a.args[2], vars);
  }
  const spec = FORMULA_FUNCS[a.name];
  if (!spec) throw new RuleError(`unknown function "${a.name}"`);
  if (a.args.length < spec.min || a.args.length > spec.max) {
    throw new RuleError(`function "${a.name}" called with ${a.args.length} argument(s)`);
  }
  const ev = a.args.map((x) => numv(evalAst(x, vars)));
  switch (a.name) {
    case 'min':
      return Math.min(...ev);
    case 'max':
      return Math.max(...ev);
    case 'abs':
      return Math.abs(ev[0]);
    case 'round':
      return Math.round(ev[0]);
    case 'floor':
      return Math.floor(ev[0]);
    case 'ceil':
      return Math.ceil(ev[0]);
    case 'clamp':
      return Math.min(Math.max(ev[0], ev[1]), ev[2]);
    default:
      throw new RuleError(`unknown function "${a.name}"`);
  }
}

function combineFormula(before: number, result: FVal, output: string, nodeId: string): number {
  let r: number;
  if (typeof result === 'number') r = result;
  else if (typeof result === 'boolean') r = result ? 1 : 0; // a predicate result → 1/0 (handy for multiply)
  else throw new RuleError(`formula "${nodeId}" produced a non-numeric result ("${result}")`);
  if (!Number.isFinite(r)) throw new RuleSkip(`formula "${nodeId}" produced a non-finite result`);
  switch (output) {
    case 'add':
      return before + r;
    case 'multiply':
      return before * r;
    case 'set':
      return r;
    default:
      throw new RuleError(`formula "${nodeId}" has invalid output "${output}"`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rounding (§4.5) — single, final
// ─────────────────────────────────────────────────────────────────────────────

function roundHalfEven(y: number): number {
  const fl = Math.floor(y);
  const diff = y - fl;
  if (diff < 0.5) return fl;
  if (diff > 0.5) return fl + 1;
  return fl % 2 === 0 ? fl : fl + 1; // exactly .5 → nearest even
}

function roundPoints(x: number, spec: RoundingSpec | undefined): number {
  const mode = spec?.mode ?? 'half_up';
  const scale = spec?.scale ?? 0;
  const f = Math.pow(10, scale);
  const y = x * f;
  let rounded: number;
  switch (mode) {
    case 'floor':
      rounded = Math.floor(y);
      break;
    case 'ceil':
      rounded = Math.ceil(y);
      break;
    case 'half_even':
      rounded = roundHalfEven(y);
      break;
    case 'half_up':
    default:
      rounded = Math.floor(y + 0.5); // round half toward +∞ (points are ≥ 0 here)
      break;
  }
  return rounded / f;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trace helper
// ─────────────────────────────────────────────────────────────────────────────

function step(
  node: { id: string; type: TraceStep['type'] },
  before: number,
  after: number,
  detail: string,
): TraceStep {
  return { nodeId: node.id, type: node.type, detail, pointsBefore: before, delta: after - before, pointsAfter: after };
}

const ACCRUAL_TYPES: ReadonlySet<string> = new Set(['rate', 'slab', 'milestone', 'formula']);

// ─────────────────────────────────────────────────────────────────────────────
// evaluateRule — the pure entrypoint (EvaluateRule in the contract)
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateRule(rule: PointsRuleConfig, ctx: EvalContext): EvalOutcome {
  const trace: TraceStep[] = [];
  try {
    // ── 1. Bind inputs + null policy (before any arithmetic) ────────────────────
    const bind = bindInputs(rule.inputs ?? [], ctx);
    if (bind.kind === 'skip') return { status: 'SKIP', reason: bind.reason, trace };
    if (bind.kind === 'ruleZero') {
      // skipRule: the rule contributes 0 points — the row is NOT an error.
      return { status: 'OK', points: roundNonNeg(0, rule.rounding), trace };
    }
    const values = bind.values;
    const pipeline = rule.pipeline ?? [];

    let points = 0;

    // ── 2. Gates & segment filters (short-circuit per onFail) ───────────────────
    for (const node of pipeline) {
      if (node.type !== 'gate' && node.type !== 'segmentFilter') continue;

      let pass: boolean;
      let desc: string;
      if (node.type === 'gate') {
        pass = evalPredicate(node.when, values);
        desc = describePredicate(node.when, values);
      } else {
        const raw = ctx.segment ? (ctx.segment as Record<string, unknown>)[node.field] : undefined;
        const segVal = raw === undefined || raw === null ? null : String(raw);
        pass = segVal !== null && node.allow.includes(segVal);
        desc = `${node.field}=${segVal ?? '∅'} ∈ {${node.allow.join(', ')}}`;
      }

      if (pass) {
        trace.push(step(node, points, points, `${node.type} passed: ${desc}`));
        continue;
      }

      // Failed → apply onFail.
      if (node.onFail === 'zero') {
        // Hard gate: short-circuit the WHOLE rule to 0 — before floor/cap, so a floor can't revive it.
        trace.push(step(node, points, 0, `${node.type} FAILED (${desc}) → onFail 'zero', rule → 0`));
        return { status: 'OK', points: roundNonNeg(0, rule.rounding), trace };
      }
      // skipNode / passthrough → no points change, continue.
      trace.push(step(node, points, points, `${node.type} failed (${desc}) → onFail '${node.onFail}', continue`));
    }

    // ── 3. Accrual nodes (rate, slab, milestone, formula) in listed order ───────
    for (const node of pipeline) {
      if (!ACCRUAL_TYPES.has(node.type)) continue;
      const before = points;

      if (node.type === 'rate') {
        const m = numOperand(node.measure, values, `rate "${node.id}" measure`);
        const delta = m * node.rate;
        points = before + delta;
        trace.push(step(node, before, points, `rate "${node.id}": ${fmt(m)} × ${fmt(node.rate)} → +${fmt(delta)}`));
      } else if (node.type === 'slab') {
        const { delta, detail } = evalSlab(node, values);
        points = before + delta;
        trace.push(step(node, before, points, detail));
      } else if (node.type === 'milestone') {
        const hit = evalPredicate(node.when, values);
        const delta = hit ? node.flat : 0;
        points = before + delta;
        trace.push(
          step(
            node,
            before,
            points,
            `milestone "${node.id}": ${describePredicate(node.when, values)} → ${hit ? `+${fmt(node.flat)}` : 'not reached, +0'}`,
          ),
        );
      } else if (node.type === 'formula') {
        const ast = parseFormula(node.expr); // FormulaParseError → ERROR
        const result = evalAst(ast, values); // RuleSkip (÷0) → SKIP; RuleError → ERROR
        points = combineFormula(before, result, node.output, node.id);
        trace.push(
          step(node, before, points, `formula "${node.id}" (${node.output}): ${node.expr} = ${fmt(toNumLoose(result))} → ${fmt(points)}`),
        );
      }
    }

    // ── 4. Floor THEN cap (always that order) ───────────────────────────────────
    for (const node of pipeline) {
      if (node.type !== 'floor') continue;
      const before = points;
      points = Math.max(points, node.min);
      trace.push(
        step(
          node,
          before,
          points,
          points > before
            ? `floor ${fmt(node.min)} raised ${fmt(before)} → ${fmt(points)}`
            : `floor ${fmt(node.min)} (${fmt(before)} ≥ ${fmt(node.min)}, no change)`,
        ),
      );
    }
    for (const node of pipeline) {
      if (node.type !== 'cap') continue;
      const before = points;
      points = Math.min(points, node.max);
      trace.push(
        step(
          node,
          before,
          points,
          points < before
            ? `cap ${fmt(node.max)} applied (${fmt(before)} → ${fmt(points)})`
            : `cap ${fmt(node.max)} (${fmt(before)} ≤ ${fmt(node.max)}, no change)`,
        ),
      );
    }

    // ── 5. Single final rounding + non-negative clamp ───────────────────────────
    const finalPoints = roundNonNeg(points, rule.rounding);
    // MONEY-SAFETY INVARIANT: the credit rail must NEVER receive NaN / Infinity / an overflowed value.
    // A config that overflows (e.g. a huge rate×measure with no cap) or otherwise produces a non-finite
    // number fails CLOSED as an ERROR (surfaced for review) rather than silently crediting garbage points.
    if (!Number.isFinite(finalPoints) || Math.abs(finalPoints) > Number.MAX_SAFE_INTEGER) {
      return {
        status: 'ERROR',
        errors: [
          `computed points is not a finite, safe value (${finalPoints}) — check rates/flats/caps and rounding.scale`,
        ],
        trace,
      };
    }
    return { status: 'OK', points: finalPoints, trace };
  } catch (e) {
    if (e instanceof RuleSkip) return { status: 'SKIP', reason: e.message, trace };
    if (e instanceof RuleError) return { status: 'ERROR', errors: [e.message], trace };
    return { status: 'ERROR', errors: [`unexpected evaluator error: ${(e as Error).message}`], trace };
  }
}

/** Round once per spec, then clamp to a non-negative whole-points invariant (contract: points ≥ 0). */
function roundNonNeg(x: number, spec: RoundingSpec | undefined): number {
  return Math.max(0, roundPoints(x, spec));
}

function toNumLoose(v: FVal): number {
  return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : NaN;
}

// ─────────────────────────────────────────────────────────────────────────────
// validateRule — pure config-save validation (CRUD imports this; keep the signature)
// ─────────────────────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateOperand(
  op: unknown,
  declared: ReadonlySet<string>,
  where: string,
  errs: string[],
  numericVars?: ReadonlySet<string>, // when provided, a var operand here MUST be a number-typed input
): void {
  if (!isObj(op)) {
    errs.push(`${where}: operand must be an object {var} or {lit}.`);
    return;
  }
  const hasVar = 'var' in op;
  const hasLit = 'lit' in op;
  if (hasVar === hasLit) {
    errs.push(`${where}: operand must be exactly one of {var} or {lit}.`);
    return;
  }
  if (hasVar) {
    if (typeof op.var !== 'string' || op.var === '') errs.push(`${where}: operand var must be a non-empty string.`);
    else if (!declared.has(op.var)) errs.push(`${where}: operand references undeclared input "${op.var}".`);
    else if (numericVars && !numericVars.has(op.var)) {
      errs.push(`${where}: operand "${op.var}" must be a number-typed input (an enum input can't be a numeric measure/target).`);
    }
  } else {
    if (typeof op.lit !== 'number' && typeof op.lit !== 'string') {
      errs.push(`${where}: operand lit must be a number or string.`);
    } else if (typeof op.lit === 'number' && !Number.isFinite(op.lit)) {
      errs.push(`${where}: operand lit number must be finite.`);
    }
  }
}

function validatePredicate(pred: unknown, declared: ReadonlySet<string>, where: string, errs: string[], depth = 0): void {
  if (depth > 25) {
    errs.push(`${where}: predicate nested too deeply.`);
    return;
  }
  if (!isObj(pred)) {
    errs.push(`${where}: predicate must be an object.`);
    return;
  }
  if ('all' in pred || 'any' in pred) {
    const key = 'all' in pred ? 'all' : 'any';
    const arr = (pred as Record<string, unknown>)[key];
    if (!Array.isArray(arr) || arr.length === 0) {
      errs.push(`${where}.${key}: must be a non-empty array of predicates.`);
      return;
    }
    arr.forEach((p, i) => validatePredicate(p, declared, `${where}.${key}[${i}]`, errs, depth + 1));
    return;
  }
  if ('not' in pred) {
    validatePredicate((pred as Record<string, unknown>).not, declared, `${where}.not`, errs, depth + 1);
    return;
  }
  // leaf Condition
  if (typeof (pred as Record<string, unknown>).op !== 'string' || !COMPARE_OPS.has((pred as Record<string, unknown>).op as string)) {
    errs.push(`${where}: condition op must be one of ${[...COMPARE_OPS].join(', ')}.`);
  }
  validateOperand((pred as Record<string, unknown>).left, declared, `${where}.left`, errs);
  validateOperand((pred as Record<string, unknown>).right, declared, `${where}.right`, errs);
}

function validateSlabBands(node: SlabNode, where: string, errs: string[]): void {
  const bands = node.bands;
  if (!Array.isArray(bands) || bands.length === 0) {
    errs.push(`${where}: slab must have at least one band.`);
    return;
  }
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i] as unknown as Record<string, unknown>;
    const w = `${where}.bands[${i}]`;
    if (!isObj(b)) {
      errs.push(`${w}: must be an object.`);
      continue;
    }
    if (!isFiniteNum(b.from)) errs.push(`${w}: from must be a finite number.`);
    const isLast = i === bands.length - 1;
    if (b.to === null) {
      if (!isLast) errs.push(`${w}: only the LAST band may have to=null (∞).`);
    } else if (!isFiniteNum(b.to)) {
      errs.push(`${w}: to must be a finite number (or null on the last band).`);
    } else if (isFiniteNum(b.from) && !(b.to > b.from)) {
      errs.push(`${w}: to (${b.to}) must be greater than from (${b.from}).`);
    }
    if (b.rate !== undefined && !isFiniteNum(b.rate)) errs.push(`${w}: rate must be a finite number when present.`);
    if (b.flat !== undefined && !isFiniteNum(b.flat)) errs.push(`${w}: flat must be a finite number when present.`);
  }
  // Contiguity: half-open [from,to) bands must be ascending, gap-free AND overlap-free, i.e. each
  // band's `to` equals the next band's `from`. (This is what makes boundary inclusivity consistent.)
  for (let i = 0; i < bands.length - 1; i++) {
    const cur = bands[i];
    const nxt = bands[i + 1];
    if (cur.to === null) {
      errs.push(`${where}.bands[${i}]: a non-last band cannot be open-ended (to=null).`);
      continue;
    }
    if (isFiniteNum(cur.to) && isFiniteNum(nxt.from) && cur.to !== nxt.from) {
      errs.push(
        `${where}.bands[${i}]→[${i + 1}]: bands must be contiguous (gap/overlap) — band ${i} to=${cur.to} but band ${i + 1} from=${nxt.from}.`,
      );
    }
  }
}

export function validateRule(rule: PointsRuleConfig): string[] {
  const errs: string[] = [];
  if (!isObj(rule)) return ['rule must be an object.'];

  // ── inputs ──────────────────────────────────────────────────────────────────
  const declared = new Set<string>();
  const declaredNumber = new Set<string>(); // refs with type 'number' — valid as a numeric measure/target
  if (!Array.isArray(rule.inputs)) {
    errs.push('inputs must be an array.');
  } else {
    rule.inputs.forEach((inp, i) => {
      const w = `inputs[${i}]`;
      if (!isObj(inp)) {
        errs.push(`${w}: must be an object.`);
        return;
      }
      if (typeof inp.ref !== 'string' || inp.ref === '') errs.push(`${w}: ref must be a non-empty string.`);
      else if (declared.has(inp.ref)) errs.push(`${w}: duplicate input ref "${inp.ref}".`);
      else {
        declared.add(inp.ref);
        if (inp.type === 'number') declaredNumber.add(inp.ref);
      }

      if (inp.type !== 'number' && inp.type !== 'enum') errs.push(`${w}: type must be 'number' or 'enum'.`);
      if (typeof inp.nullAs !== 'string' || !NULL_POLICIES.has(inp.nullAs)) {
        errs.push(`${w}: nullAs must be one of ${[...NULL_POLICIES].join(', ')}.`);
      }
      const hasKpi = typeof inp.kpiCode === 'string' && inp.kpiCode !== '';
      const hasSrc = typeof inp.source === 'string' && inp.source !== '';
      if (hasKpi === hasSrc) errs.push(`${w}: set exactly one of kpiCode or source.`);
      if (inp.type === 'enum' && (!Array.isArray(inp.values) || inp.values.length === 0)) {
        errs.push(`${w}: an enum input must list non-empty 'values'.`);
      }
    });
  }

  // ── attachsTo (denormalized into indexed, non-null columns → must be well-formed) ──
  if (!isObj(rule.attachsTo)) {
    errs.push('attachsTo must be an object.');
  } else {
    if (rule.attachsTo.scope !== 'program_kpi') errs.push("attachsTo.scope must be 'program_kpi'.");
    if (typeof rule.attachsTo.kpiCode !== 'string' || rule.attachsTo.kpiCode === '') {
      errs.push('attachsTo.kpiCode must be a non-empty string.');
    }
    if (rule.attachsTo.program != null && typeof rule.attachsTo.program !== 'string') {
      errs.push('attachsTo.program must be a string or null.');
    }
    if (rule.attachsTo.programCategory != null && typeof rule.attachsTo.programCategory !== 'string') {
      errs.push('attachsTo.programCategory must be a string or null.');
    }
  }

  // ── output (the credit bucket + award type the computed points feed in Wave 2) ──
  if (!isObj(rule.output)) {
    errs.push('output must be an object.');
  } else {
    if (rule.output.awardType !== 'POINTS' && rule.output.awardType !== 'PAYOUT') {
      errs.push("output.awardType must be 'POINTS' or 'PAYOUT'.");
    }
    if (typeof rule.output.fieldId !== 'string' || rule.output.fieldId === '') {
      errs.push('output.fieldId must be a non-empty credit-field id.');
    }
  }

  // ── rounding ──────────────────────────────────────────────────────────────────
  if (rule.rounding !== undefined) {
    if (!isObj(rule.rounding)) {
      errs.push('rounding must be an object.');
    } else {
      if (typeof rule.rounding.mode !== 'string' || !ROUNDING_MODES.has(rule.rounding.mode)) {
        errs.push(`rounding.mode must be one of ${[...ROUNDING_MODES].join(', ')}.`);
      }
      if (
        !Number.isInteger(rule.rounding.scale) ||
        (rule.rounding.scale as number) < 0 ||
        (rule.rounding.scale as number) > 6
      ) {
        // Upper bound guards against Math.pow(10, scale) overflowing to Infinity (→ NaN points).
        // Points/paise are whole, so scale 0 is normal; >6 is never meaningful for a money output.
        errs.push('rounding.scale must be an integer between 0 and 6.');
      }
    }
  }

  // A POINTS award is a WHOLE count — it must not round to a fraction. The credits upload the engine
  // exports into rejects any value with >1 decimal place, and a fractional "point" is not creditable,
  // so a POINTS rule may only use rounding.scale 0. A PAYOUT award is reported in WHOLE RUPEES (INR,
  // rounded off — owner directive 2026-10-21, PAYOUT-COMPUTE-REPORT.md), so it likewise may only use
  // rounding.scale 0. rounding omitted ⇒ scale 0 ⇒ fine.
  if (
    isObj(rule.output) &&
    (rule.output.awardType === 'POINTS' || rule.output.awardType === 'PAYOUT') &&
    isObj(rule.rounding) &&
    Number.isInteger(rule.rounding.scale) &&
    (rule.rounding.scale as number) !== 0
  ) {
    errs.push(
      rule.output.awardType === 'POINTS'
        ? 'A POINTS-award rule must use rounding.scale 0 — points are a whole count.'
        : 'A PAYOUT-award rule must use rounding.scale 0 — payouts are reported in whole rupees (INR).',
    );
  }

  // ── pipeline ──────────────────────────────────────────────────────────────────
  if (!Array.isArray(rule.pipeline)) {
    errs.push('pipeline must be an array.');
    return errs;
  }
  const nodeIds = new Set<string>();
  rule.pipeline.forEach((node, i) => {
    const w = `pipeline[${i}]`;
    if (!isObj(node)) {
      errs.push(`${w}: must be an object.`);
      return;
    }
    if (typeof node.id !== 'string' || node.id === '') errs.push(`${w}: id must be a non-empty string.`);
    else if (nodeIds.has(node.id)) errs.push(`${w}: duplicate node id "${node.id}".`);
    else nodeIds.add(node.id);

    const n = node as PipelineNode;
    switch (n.type) {
      case 'rate':
        validateOperand(n.measure, declared, `${w}.measure`, errs, declaredNumber);
        if (!isFiniteNum(n.rate)) errs.push(`${w}: rate must be a finite number.`);
        break;
      case 'slab':
        if (!SLAB_BASES.has(n.basis)) errs.push(`${w}: basis must be 'absolute' or 'pct_of_target'.`);
        if (!SLAB_APPLY.has(n.apply)) errs.push(`${w}: apply must be 'marginal' or 'whole'.`);
        validateOperand(n.measure, declared, `${w}.measure`, errs, declaredNumber);
        if (n.basis === 'pct_of_target') {
          if (n.target === undefined) errs.push(`${w}: basis 'pct_of_target' requires a target operand.`);
          else validateOperand(n.target, declared, `${w}.target`, errs, declaredNumber);
        }
        validateSlabBands(n, w, errs);
        break;
      case 'gate':
        validatePredicate(n.when, declared, `${w}.when`, errs);
        if (!ON_FAIL.has(n.onFail)) errs.push(`${w}: onFail must be one of ${[...ON_FAIL].join(', ')}.`);
        break;
      case 'segmentFilter':
        if (typeof n.field !== 'string' || n.field === '') errs.push(`${w}: field must be a non-empty string.`);
        if (!Array.isArray(n.allow) || n.allow.some((a) => typeof a !== 'string')) {
          errs.push(`${w}: allow must be an array of strings.`);
        }
        if (!ON_FAIL.has(n.onFail)) errs.push(`${w}: onFail must be one of ${[...ON_FAIL].join(', ')}.`);
        break;
      case 'milestone':
        validatePredicate(n.when, declared, `${w}.when`, errs);
        if (!isFiniteNum(n.flat)) errs.push(`${w}: flat must be a finite number.`);
        break;
      case 'floor':
        if (!isFiniteNum(n.min)) errs.push(`${w}: min must be a finite number.`);
        break;
      case 'cap':
        if (!isFiniteNum(n.max)) errs.push(`${w}: max must be a finite number.`);
        break;
      case 'formula': {
        if (!FORMULA_OUTPUTS.has(n.output)) errs.push(`${w}: output must be 'add', 'multiply' or 'set'.`);
        if (typeof n.expr !== 'string' || n.expr.trim() === '') {
          errs.push(`${w}: expr must be a non-empty string.`);
          break;
        }
        try {
          const ast = parseFormula(n.expr);
          errs.push(...collectFormulaErrors(ast, declared, `${w}.expr`));
        } catch (e) {
          errs.push(`${w}.expr: parse error — ${(e as Error).message}.`);
        }
        break;
      }
      default:
        errs.push(`${w}: unknown node type "${(n as { type?: string }).type}".`);
    }
  });

  return errs;
}
