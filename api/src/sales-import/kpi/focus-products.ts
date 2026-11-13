/**
 * FOCUS-FROM-TARGETS (platform/docs/plans/FOCUS-FROM-TARGETS-DESIGN.md) — PURE, no DB.
 *
 * Reads the per-outlet focus product names a month's target file carries (OutletTarget.targetValues.__names[kpiCode],
 * e.g. "CNO & ADHO500") against the tenant's known products, decides per outlet which products a TARGET_NAMES KPI
 * counts, lists every blocker (no silent failures) and builds the month's reconciliation view.
 *
 * CONTRACT STUB written by the lead so lanes B1 (implements this file + the evaluator hook) and B2 (services that call
 * it) can work in parallel. Signatures are FIXED — change them only by agreement with the lead.
 */
import type {
  DimMatch,
  FocusBlocker,
  FocusTokenResolution,
  MonthFocusKpi,
  MonthReconciliation,
  SalesKpiFilter,
} from '../sales-import.contract';
import type { KpiDefLite } from './sales-kpi.helper';
import type { RosterOutlet } from './sales-import-data';
import type { MonthComputation } from '../apply/month-compute';

/** Max sample outlet codes on a blocker / gap. */
export const FOCUS_SAMPLE_LIMIT = 20;

/** normalizeDim(s) with ALL whitespace removed (UPPERCASE, trimmed). The token / acceptance key. */
export function focusKey(s: unknown): string {
  void s;
  throw new Error('focusKey: not implemented (lane B1)');
}

/** Split a written name on `&` or `,`; trim; drop empties; de-duplicate by focusKey (first spelling kept). */
export function splitFocusName(raw: string): string[] {
  void raw;
  throw new Error('splitFocusName: not implemented (lane B1)');
}

/** Every known product combination, indexed by the focusKey of each dims PREFIX (design §3). */
export interface FocusCatalogue {
  /** The profile's dimension keys IN PROFILE ORDER (Bajaj: ['brand', 'skuGroup']). */
  dimensionKeys: string[];
  /** prefix key → the DISTINCT DimMatches it can mean (1 = MATCHED, >1 = AMBIGUOUS). */
  byKey: ReadonlyMap<string, DimMatch[]>;
  /** Number of distinct combos the catalogue was built from (0 = nothing to check against). */
  size: number;
}

/** Build the catalogue from normalized dims records (aggregate / history-combo `dims`). */
export function buildFocusCatalogue(dimensionKeys: string[], combos: Iterable<Record<string, string>>): FocusCatalogue {
  void dimensionKeys;
  void combos;
  throw new Error('buildFocusCatalogue: not implemented (lane B1)');
}

/** Resolve one token (no acceptance applied). */
export function resolveFocusToken(token: string, catalogue: FocusCatalogue): FocusTokenResolution {
  void token;
  void catalogue;
  throw new Error('resolveFocusToken: not implemented (lane B1)');
}

/** One month's target row for an outlet, keyed by the ROSTER (stored) outlet code. */
export interface MonthTargetRow {
  /** kpiCode → numeric target (non-numeric / blank cells absent). */
  values: Record<string, number>;
  /** kpiCode → name as written (from targetValues.__names). */
  names: Record<string, string>;
}

export interface FocusAcceptanceInfo {
  byName: string;
  at: string; // ISO
}

export interface MonthFocusInput {
  month: string;
  /** The ENABLED definitions (TARGET_NAMES ones have productSource === 'TARGET_NAMES'). */
  defs: readonly KpiDefLite[];
  /** kpiCode → display label. */
  labelOf: ReadonlyMap<string, string>;
  /** Stored outlet code → meta (loadRosterMeta). */
  roster: ReadonlyMap<string, RosterOutlet>;
  /** ROSTER outlet code → the month's target row (already mapped through the normalized roster index). */
  targets: ReadonlyMap<string, MonthTargetRow>;
  catalogue: FocusCatalogue;
  /** `${kpiCode}|${key}` → who accepted the UNMATCHED token as "not sold yet" for this month. */
  acceptances: ReadonlyMap<string, FocusAcceptanceInfo>;
}

export interface MonthFocusResolution {
  /** TARGET_NAMES kpiCode → roster outlet code → the filter to use for that outlet. Outlet ABSENT = key omitted. */
  outletFilters: ReadonlyMap<string, ReadonlyMap<string, SalesKpiFilter>>;
  /** TARGET_NAMES kpiCode → roster outlet code → the name key the outlet carries (for achieved-by-name). */
  outletNameKeys: ReadonlyMap<string, ReadonlyMap<string, string>>;
  blockers: FocusBlocker[];
  /** Focus summaries with `achieved` zeroed (buildMonthReconciliation fills it from the computed rows). */
  focus: MonthFocusKpi[];
  /** design §5; '' when no enabled TARGET_NAMES definition. */
  fingerprint: string;
}

/** design §3–§5 for one month. Deterministic (sorted output) so the fingerprint is stable. */
export function resolveMonthFocus(input: MonthFocusInput): MonthFocusResolution {
  void input;
  throw new Error('resolveMonthFocus: not implemented (lane B1)');
}

/**
 * The definitions to evaluate the month with: every TARGET_NAMES definition gets `outletFilter` from the resolution;
 * FILTER definitions are returned AS THE SAME OBJECTS (their scope caches stay warm, values byte-identical).
 */
export function attachOutletFilters(defs: readonly KpiDefLite[], res: MonthFocusResolution): KpiDefLite[] {
  void defs;
  void res;
  throw new Error('attachOutletFilters: not implemented (lane B1)');
}

/** design §6: the month's MonthReconciliation from the resolution + the computed rows. */
export function buildMonthReconciliation(args: {
  input: MonthFocusInput;
  resolution: MonthFocusResolution;
  comp: MonthComputation;
  /** Latest target upload batch time for the month (null = none). */
  targetUploadedAt: Date | null;
  /** Importer-owned KPI codes (all enabled definitions). */
  ownedKpiCodes: readonly string[];
}): MonthReconciliation {
  void args;
  throw new Error('buildMonthReconciliation: not implemented (lane B1)');
}
