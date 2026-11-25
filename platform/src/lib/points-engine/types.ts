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
  source?: string; // 'target:<kpi>' | 'achievement:<kpi>' | 'pct:<kpi>' | 'segment:<field>' | 'visibility:<key>'
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
export interface GateNode {
  type: 'gate';
  id: string;
  when: Predicate;
  onFail: OnFail;
  /** Opt-in: the reason shown on the row when the gate fails (e.g. "Target is 0"). */
  failReason?: string;
  /** Opt-in: 'zero' = pay 0 with the reason; 'skip' = skip + flag the row. Absent = onFail decides (today). */
  failAs?: 'zero' | 'skip';
}
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
  segment: { program?: string | null; programCategory?: string | null; outletType?: string | null; metro?: string | null };
  /** Test values for `visibility:*` inputs (a missing key = absent → the input's null policy). */
  visibility?: { approvedWindows?: number | null; approved?: number | null; windows?: number | null; inScope?: number | null };
}

/** The `visibility:<key>` input sources (design §3a) — keys + the plain labels the builder shows. */
export const VISIBILITY_SOURCES: ReadonlyArray<{ key: 'approved' | 'approvedWindows' | 'windows' | 'inScope'; label: string; hint: string }> = [
  { key: 'approved', label: 'Visibility approved this month (1/0)', hint: '1 when at least one visibility window of the month is approved, else 0.' },
  { key: 'approvedWindows', label: 'Approved visibility windows this month', hint: 'How many of the month’s visibility windows are approved.' },
  { key: 'windows', label: 'Visibility windows in the month', hint: 'How many of the month’s windows this outlet was in the visibility programme for (for “every window approved” rules).' },
  { key: 'inScope', label: 'Outlet in the visibility programme (1/0)', hint: '1 when visibility applies to this outlet this month, 0 when it does not (e.g. a wholesaler) — tells “not applicable” apart from “not approved”.' },
];
export interface TraceStep {
  nodeId: string;
  type: NodeType;
  detail: string;
  pointsBefore: number;
  delta: number;
  pointsAfter: number;
}
export type EvalOutcome =
  | { status: 'OK'; points: number; trace: TraceStep[]; reason?: string }
  | { status: 'SKIP'; reason: string; trace: TraceStep[] }
  | { status: 'ERROR'; errors: string[]; trace: TraceStep[] };

export interface SimulateResult {
  valid: boolean;
  errors: string[];
  outcome?: EvalOutcome;
  /** The test visibility values the rule read (one per visibility input; null = blank → null policy). */
  visibilityUsed?: Array<{ ref: string; source: string; value: number | null }>;
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
  /** Whole INR — present ONLY on OK PAYOUT rows (awardType === 'PAYOUT'); `points` is undefined on these. */
  payoutRupees?: number;
  achievement?: number | null;
  target?: number | null;
  reason?: string;
  explanation?: string;
  /** The outlet's visibility values the rule read (only when the rule has a visibility input). */
  visibility?: {
    approvedWindows: number;
    approved: 0 | 1;
    windows: number;
    inScope: 0 | 1;
    scope: 'IN_SCOPE' | 'NOT_IN_SCOPE' | 'NO_RECORD';
    waitingWindows: number;
    openWindows: number;
    excludedApprovals: { olderFrequency: number; notInProgramme: number };
    note: string;
  };
}
export interface ComputePreview {
  clientId: string;
  period: string;
  filter?: { program?: string | null; kpiCode?: string | null };
  counts: { total: number; ok: number; skip: number; error: number; noRule: number };
  totalPoints: number;
  /** Σ whole-INR over OK PAYOUT rows. */
  totalPayoutRupees: number;
  rows: ComputePreviewRow[];
  engineDisabled: boolean;
  /** Gifsy-enabled in-portal direct crediting — lets the UI offer/hide "Credit in portal" pre-click. */
  directCreditEnabled: boolean;
  ruleVersionsUsed: Array<{ ruleId: string; version: number }>;
  /** Content hash of this run — pass back as `expectedKey` on commit to guard the review→commit TOCTOU. */
  sourceKey: string;
  /** Only when a rule read visibility this run: the month's visibility setup + headline counts. */
  visibility?: {
    month: string;
    mode: 'PHOTO_APPROVAL' | 'AMOUNT_UPLOAD';
    available: boolean;
    unavailableReason?: string;
    windows: number;
    /** Windows of the month still open at compute time. */
    openWindowsInMonth: number;
    outletsApproved: number;
    outletsWithData: number;
    outletsWaitingReview: number;
    outletsOpenWindow: number;
    /** Outlets reading "not approved" because a review is pending / a window is open — must be accepted to export / credit. */
    outletsPending: number;
    /** Approved captures counted although the outlet was outside the dated window scope (loaded late). */
    countedOutsideDatedScope: number;
    /** Approved captures NOT counted, by reason. */
    excluded: { olderFrequency: number; notInProgramme: number };
  };
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
