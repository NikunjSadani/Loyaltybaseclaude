/**
 * Points Compute Engine — FRONTEND type mirror of the backend contract.
 *
 * Mirrors api/src/points-engine/points-engine.types.ts (the rule/node grammar) + the compute/commit/
 * settings response shapes. The BACKEND is the single source of truth + the real validator (validateRule);
 * these types are for the authoring/compute UI only. Keep in sync with the backend contract.
 */

// ── Inputs & null policy ────────────────────────────────────────────────────────
export type NullPolicy = 'reject' | 'zero' | 'skipRule';

export interface RuleInput {
  ref: string;
  kpiCode?: string;
  source?: string; // 'target:<kpi>' | 'achievement:<kpi>' | 'pct:<kpi>' | 'segment:<field>'
  type: 'number' | 'enum';
  nullAs: NullPolicy;
  values?: string[];
}

// ── Operands & predicates ───────────────────────────────────────────────────────
export type Operand = { var: string } | { lit: number | string };
export type CompareOp = 'gte' | 'lte' | 'gt' | 'lt' | 'eq' | 'neq';
export interface Condition {
  op: CompareOp;
  left: Operand;
  right: Operand;
}
export type Predicate =
  | Condition
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate };
export type OnFail = 'zero' | 'skipNode' | 'passthrough';

// ── Pipeline nodes ──────────────────────────────────────────────────────────────
export interface RateNode { type: 'rate'; id: string; measure: Operand; rate: number }
export interface SlabBand { from: number; to: number | null; rate?: number; flat?: number }
export interface SlabNode {
  type: 'slab';
  id: string;
  basis: 'absolute' | 'pct_of_target';
  measure: Operand;
  target?: Operand;
  apply: 'marginal' | 'whole';
  bands: SlabBand[];
}
export interface GateNode { type: 'gate'; id: string; when: Predicate; onFail: OnFail }
export interface SegmentFilterNode { type: 'segmentFilter'; id: string; field: string; allow: string[]; onFail: OnFail }
export interface MilestoneNode { type: 'milestone'; id: string; when: Predicate; flat: number }
export interface FloorNode { type: 'floor'; id: string; min: number }
export interface CapNode { type: 'cap'; id: string; max: number }
export interface FormulaNode { type: 'formula'; id: string; expr: string; output: 'add' | 'multiply' | 'set' }

export type PipelineNode =
  | RateNode | SlabNode | GateNode | SegmentFilterNode | MilestoneNode | FloorNode | CapNode | FormulaNode;
export type NodeType = PipelineNode['type'];

// ── Rule object ─────────────────────────────────────────────────────────────────
export type RuleStatus = 'draft' | 'published' | 'archived';
export type AwardType = 'POINTS' | 'PAYOUT';
export interface RoundingSpec { mode: 'half_up' | 'half_even' | 'floor' | 'ceil'; scale: number }
export interface RuleAttachment {
  scope: 'program_kpi';
  program?: string | null;
  programCategory?: string | null;
  kpiCode: string;
}
export interface RuleOutput { awardType: AwardType; fieldId: string }

/** The authoring fields a draft create/update sends (server owns identity/version/status). */
export interface RuleConfigDraft {
  ruleId?: string;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo?: string | null;
  evaluationBasis?: 'PERIOD_AGGREGATE';
  attachsTo: RuleAttachment;
  output: RuleOutput;
  rounding: RoundingSpec;
  inputs: RuleInput[];
  pipeline: PipelineNode[];
}

/** A stored PointsRule row as returned by the CRUD API. */
export interface PointsRuleRow {
  id: string;
  ruleId: string;
  clientId: string;
  version: number;
  status: RuleStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  evaluationBasis: 'PERIOD_AGGREGATE';
  attachsTo: RuleAttachment;
  output: RuleOutput;
  rounding: RoundingSpec;
  inputs: RuleInput[];
  pipeline: PipelineNode[];
  kpiCode: string;
  program: string | null;
  programCategory: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Evaluation context + outcome (for the simulator) ─────────────────────────────
export interface EvalContext {
  achievements: Record<string, number | null>;
  targets: Record<string, number | null>;
  segment: { program?: string | null; programCategory?: string | null; outletType?: string | null };
}
export interface TraceStep {
  nodeId: string;
  type: NodeType;
  detail: string;
  pointsBefore: number;
  delta: number;
  pointsAfter: number;
}
export type EvalOutcome =
  | { status: 'OK'; points: number; trace: TraceStep[] }
  | { status: 'SKIP'; reason: string; trace: TraceStep[] }
  | { status: 'ERROR'; errors: string[]; trace: TraceStep[] };

export interface SimulateResult {
  valid: boolean;
  errors: string[];
  outcome?: EvalOutcome;
}

// ── Compute preview + commit (Waves 1–2) ─────────────────────────────────────────
export type PreviewRowStatus = 'OK' | 'SKIP' | 'ERROR' | 'NO_RULE';
export interface ComputePreviewRow {
  outletCode: string;
  outletName?: string | null;
  program?: string | null;
  programCategory?: string | null;
  kpiCode: string;
  ruleId?: string;
  ruleVersion?: number;
  awardType?: AwardType;
  fieldId?: string;
  fieldName?: string;
  status: PreviewRowStatus;
  points?: number;
  achievement?: number | null;
  target?: number | null;
  reason?: string;
  explanation?: string;
}
export interface ComputePreview {
  clientId: string;
  period: string;
  filter?: { program?: string | null; kpiCode?: string | null };
  counts: { total: number; ok: number; skip: number; error: number; noRule: number };
  totalPoints: number;
  rows: ComputePreviewRow[];
  engineDisabled: boolean;
  /** Gifsy-enabled in-portal direct crediting — lets the UI offer/hide "Credit in portal" pre-click. */
  directCreditEnabled: boolean;
  ruleVersionsUsed: Array<{ ruleId: string; version: number }>;
  /** Content hash of this run — pass back as `expectedKey` on commit to guard the review→commit TOCTOU. */
  sourceKey: string;
}
export interface ComputeCommitResult {
  batchId: string;
  batchCode: string;
  status: string;
  period: string;
  totalPoints: number;
  totalOutlets: number;
  counts: { total: number; ok: number; skip: number; error: number; noRule: number };
  sourceKey: string;
  idempotentHit: boolean;
  /** Count of OTHER credit batches (engine OR manual) already in this period — the UI warns (Option A). */
  priorBatchesThisPeriod: number;
}

// ── Settings ─────────────────────────────────────────────────────────────────────
export interface PointsEngineSettings {
  clientId: string;
  enabled: boolean;
  directCreditEnabled: boolean;
}

/** Node-type UI metadata (label + the disclosure level, for the "Add step" menu). */
export const NODE_META: Record<NodeType, { label: string; level: string; blurb: string }> = {
  rate: { label: 'Rate', level: 'Basic', blurb: 'points += measure × rate' },
  slab: { label: 'Slab / tiers', level: 'Tiered', blurb: 'piecewise rate by band (marginal or cliff)' },
  gate: { label: 'Gate', level: 'Conditional', blurb: 'pay nothing / skip unless a condition holds' },
  segmentFilter: { label: 'Segment filter', level: 'Conditional', blurb: 'restrict to program / category / outlet type' },
  milestone: { label: 'Milestone', level: 'Conditional', blurb: 'a flat bonus when a threshold is reached' },
  floor: { label: 'Floor', level: 'Clamp', blurb: 'clamp the total to a minimum' },
  cap: { label: 'Cap', level: 'Clamp', blurb: 'clamp the total to a maximum' },
  formula: { label: 'Formula', level: 'Advanced', blurb: 'cross-parameter arithmetic (power users)' },
};
