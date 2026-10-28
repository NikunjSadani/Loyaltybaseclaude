/**
 * Points Compute Engine — shared rule & evaluation CONTRACT (Wave 0).
 *
 * A points rule is an ORDERED PIPELINE of typed nodes; L1–L4 are not separate engines, just which node
 * types a rule uses (rate=L1, slab=L2, gate/segmentFilter/milestone/floor/cap=L3, formula=L4). Evaluation
 * is a PURE, DETERMINISTIC function `evaluateRule(rule, ctx) → EvalOutcome` — no DB, no clock, no I/O.
 * See docs/plans/POINTS-COMPUTE-ENGINE-DESIGN.md (§3 schema, §4 pipeline order, §5 formula safety).
 *
 * This file is the single source of truth both the Prisma `PointsRule` store (CRUD) and the evaluator
 * (points-engine.helper.ts) build against. Do not fork these shapes.
 */

// ── Inputs & null policy ───────────────────────────────────────────────────────

/** Per-input handling when the source value is null/absent (a blank cell is an OMITTED key, never 0). */
export type NullPolicy =
  | 'reject' // missing value → the whole row is SKIPPED-with-reason (surface for review). Safe default.
  | 'zero' //   treat as 0 and continue.
  | 'skipRule'; // this rule contributes 0 points (but the row is not an error).

/** A variable the pipeline may read, bound from the evaluation context. */
export interface RuleInput {
  /** Variable name referenced by nodes/formulae (e.g. "value", "target", "newOutlets"). */
  ref: string;
  /** Achievement source: `OutletSalesRecord.kpiValues[kpiCode]`. Omit if `source` is set. */
  kpiCode?: string;
  /** Alternate source, e.g. "target:CASES_SOLD" → `OutletTarget.targetValues["CASES_SOLD"]`. */
  source?: string;
  type: 'number' | 'enum';
  nullAs: NullPolicy;
  /** Allowed values when type === 'enum' (e.g. segment codes). */
  values?: string[];
}

// ── Operands, predicates ───────────────────────────────────────────────────────

/** A value reference (a bound input var) or a literal. */
export type Operand = { var: string } | { lit: number | string };

export type CompareOp = 'gte' | 'lte' | 'gt' | 'lt' | 'eq' | 'neq';
export interface Condition {
  op: CompareOp;
  left: Operand;
  right: Operand;
}
/** A condition, or a boolean combination (used by gate/milestone `when`). */
export type Predicate =
  | Condition
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate };

/** What a gate/segmentFilter does when its predicate fails. */
export type OnFail =
  | 'zero' // short-circuit the whole rule to 0 points (hard gate).
  | 'skipNode' // skip just this node, continue the pipeline.
  | 'passthrough'; // no-op (points so far unchanged).

// ── Pipeline nodes ─────────────────────────────────────────────────────────────

/** L1 — points += measure × rate. */
export interface RateNode {
  type: 'rate';
  id: string;
  measure: Operand;
  rate: number;
}

/** A half-open band [from, to); the last band uses to=null for ∞. `rate` × units-in-band and/or a `flat`. */
export interface SlabBand {
  from: number;
  to: number | null;
  rate?: number;
  flat?: number;
}

/** L2 — piecewise rate by band of an absolute measure or of % -of-target achievement. */
export interface SlabNode {
  type: 'slab';
  id: string;
  /** `absolute` → band on the raw measure; `pct_of_target` → band on (measure ÷ target × 100). */
  basis: 'absolute' | 'pct_of_target';
  measure: Operand;
  /** Required when basis === 'pct_of_target'. */
  target?: Operand;
  /** `marginal` = tax-bracket (rate per band); `whole` = top band's rate re-rates everything (cliff). */
  apply: 'marginal' | 'whole';
  /** Ordered, gap/overlap-free bands (validated at config-save). */
  bands: SlabBand[];
}

/** L3 — pay per `onFail` unless the predicate holds. */
export interface GateNode {
  type: 'gate';
  id: string;
  when: Predicate;
  onFail: OnFail;
}

/** L3 — restrict to a segment (program/category/outletType/metro) value set. */
export interface SegmentFilterNode {
  type: 'segmentFilter';
  id: string;
  /** Which context segment field to test (e.g. "program", "programCategory", "outletType", "metro"). */
  field: string;
  allow: string[];
  onFail: OnFail;
}

/** L3 — a flat lump of points when a discrete threshold is reached. */
export interface MilestoneNode {
  type: 'milestone';
  id: string;
  when: Predicate;
  flat: number;
}

/** L3 — clamp the running total to a minimum. Applied near the end (floor before cap). */
export interface FloorNode {
  type: 'floor';
  id: string;
  min: number;
}

/** L3 — clamp the running total to a maximum. Applied last. */
export interface CapNode {
  type: 'cap';
  id: string;
  max: number;
}

/**
 * L4 — cross-parameter arithmetic. `expr` is a constrained expression over bound input vars, evaluated
 * by a parse-then-whitelist-AST evaluator (NO eval/Function). Whitelisted: + - * / %, unary -, comparisons,
 * && || !, and functions min,max,abs,round,floor,ceil,clamp,if. Validated at config-save; bounded depth/nodes.
 */
export interface FormulaNode {
  type: 'formula';
  id: string;
  expr: string;
  /** How the formula result combines with points so far. */
  output: 'add' | 'multiply' | 'set';
}

export type PipelineNode =
  | RateNode
  | SlabNode
  | GateNode
  | SegmentFilterNode
  | MilestoneNode
  | FloorNode
  | CapNode
  | FormulaNode;

export type NodeType = PipelineNode['type'];

// ── The rule object (stored as versioned JSON; see §3) ─────────────────────────

export type RuleStatus = 'draft' | 'published' | 'archived';
export type AwardType = 'POINTS' | 'PAYOUT';

export interface RoundingSpec {
  mode: 'half_up' | 'half_even' | 'floor' | 'ceil';
  /** Decimal places; 0 = whole points. Single rounding, applied once at the very end. */
  scale: number;
}

/** Where a rule attaches: per (program × input-KPI), tenant-wide (decision §12 #2). */
export interface RuleAttachment {
  scope: 'program_kpi';
  program?: string | null; // matches Outlet.programName (null = any program)
  programCategory?: string | null; // matches Outlet.programCategory (optional)
  kpiCode: string; // the PRIMARY input KPI this rule is registered under
}

export interface PointsRuleConfig {
  ruleId: string; // stable identity across versions
  tenantId: string; // clientId
  version: number; // monotonic; a published version is NEVER mutated
  status: RuleStatus;
  effectiveFrom: string; // 'YYYY-MM-DD' business-time validity
  effectiveTo?: string | null;
  attachsTo: RuleAttachment;
  evaluationBasis: 'PERIOD_AGGREGATE'; // PER_TRANSACTION deferred (§12 #3)
  /** Where computed points land — a credit-field bucket + award type. */
  output: { awardType: AwardType; fieldId: string };
  rounding: RoundingSpec;
  /** The ONLY variables the pipeline may read. */
  inputs: RuleInput[];
  pipeline: PipelineNode[];
}

// ── Evaluation context & result ────────────────────────────────────────────────

/** Resolved per entity (outlet) × period — the pure inputs to the evaluator. */
export interface EvalContext {
  /** kpiCode → achievement value (null = the cell was blank / key omitted). */
  achievements: Record<string, number | null>;
  /** kpiCode → target value (null = no target set). */
  targets: Record<string, number | null>;
  /** Segmentation facet of the outlet (from the Outlet row). */
  segment: {
    program?: string | null;
    programCategory?: string | null;
    outletType?: string | null;
    /** Free-text metro classification from the outlet master (e.g. "Metro"/"Non-Metro"); null when unset. */
    metro?: string | null;
  };
  /** Optional identifiers for trace/debug (NOT read by rule logic). */
  meta?: { outletCode?: string; period?: string };
}

/** One step of the "why N points" explanation — one per pipeline node that ran. */
export interface TraceStep {
  nodeId: string;
  type: NodeType;
  /** Human-readable ("gate passed: value 120 ≥ target 100", "slab band 100–120% @15 marginal"). */
  detail: string;
  pointsBefore: number;
  delta: number;
  pointsAfter: number;
}

/** The pure evaluator's outcome for one entity × period. */
export type EvalOutcome =
  | { status: 'OK'; points: number; trace: TraceStep[] } // points = whole, non-negative, rounded
  | { status: 'SKIP'; reason: string; trace: TraceStep[] } // e.g. a `reject` input was null
  | { status: 'ERROR'; errors: string[]; trace: TraceStep[] }; // malformed rule reached runtime

/** The pure entrypoint the evaluator must export. */
export type EvaluateRule = (rule: PointsRuleConfig, ctx: EvalContext) => EvalOutcome;
