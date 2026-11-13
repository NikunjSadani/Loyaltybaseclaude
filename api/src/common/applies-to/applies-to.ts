/**
 * APPLIES-TO targeting — the ONE pure matcher for "which outlets does this KPI / visibility
 * config apply to?" (platform/docs/plans/APPLIES-TO-TARGETING-PLAN.md §0, §2, §5).
 *
 *   AppliesTo = { outletTypes, programs, subPrograms }
 *
 * Semantics (owner-approved):
 *   - AND across facets, OR within a facet.
 *   - EMPTY facet = ALL (no restriction on that facet). A fully empty scope = unscoped.
 *   - Matching is trimmed + case-insensitive (D8).
 *   - D4: a NON-empty facet + a BLANK outlet value → OUT of scope.
 *   - D11: sub-programs are an independent flat list (not nested under programs).
 *   - Facet ↔ outlet column: outletTypes ↔ Outlet.outletType.code, programs ↔ Outlet.programName,
 *     subPrograms ↔ Outlet.programCategory.
 *
 * NOTE: visibilityConfig.outletScope keeps its own meaning (empty = NONE) — callers translate it;
 * this helper's "empty = all" rule applies to the AppliesTo shape only.
 *
 * Pure + DI-free. The Prisma `where` builder lives in the sibling `applies-to.prisma.ts`.
 * The FE mirror is `platform/src/lib/applies-to.ts` — keep the two in lock-step.
 */

export interface AppliesTo {
  /** Outlet type codes (UPPERCASED by normalize). Empty = every type. */
  outletTypes: string[];
  /** Outlet.programName values. Empty = every program. */
  programs: string[];
  /** Outlet.programCategory values. Empty = every sub-program. */
  subPrograms: string[];
}

/** Loose input accepted by normalizeAppliesTo (DB rows, DTOs, JSON settings). */
export type AppliesToInput =
  | {
      outletTypes?: ReadonlyArray<unknown> | null;
      programs?: ReadonlyArray<unknown> | null;
      subPrograms?: ReadonlyArray<unknown> | null;
    }
  | null
  | undefined;

/** An outlet's facet values (null/blank = the outlet has no value for that facet). */
export interface AppliesToOutletFacets {
  outletType?: string | null;
  program?: string | null;
  subProgram?: string | null;
}

/** A view filter (absent / blank / 'ALL' on a facet = no filter on that facet). */
export interface AppliesToFilterInput {
  outletType?: string | null;
  program?: string | null;
  subProgram?: string | null;
}

export const APPLIES_TO_FACETS = ['outletTypes', 'programs', 'subPrograms'] as const;
export type AppliesToFacet = (typeof APPLIES_TO_FACETS)[number];

/** A fresh empty (unscoped) AppliesTo. */
export function emptyAppliesTo(): AppliesTo {
  return { outletTypes: [], programs: [], subPrograms: [] };
}

/** Case-insensitive comparison key for one value. */
function ciKey(v: string): string {
  return v.trim().toUpperCase();
}

function normList(v: ReadonlyArray<unknown> | null | undefined, upper: boolean): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t) continue;
    const key = t.toUpperCase();
    if (seen.has(key)) continue; // ci dedupe, first spelling wins
    seen.add(key);
    out.push(upper ? key : t);
  }
  return out;
}

/**
 * Canonical form: trim each value, drop blanks / non-strings, dedupe case-insensitively (first
 * spelling wins, order preserved); outlet types UPPERCASED. Never shares input array references.
 */
export function normalizeAppliesTo(input: AppliesToInput): AppliesTo {
  return {
    outletTypes: normList(input?.outletTypes, true),
    programs: normList(input?.programs, false),
    subPrograms: normList(input?.subPrograms, false),
  };
}

/** True when every facet is empty (applies to every outlet). Tolerates un-normalized input. */
export function isUnscoped(scope: AppliesToInput): boolean {
  const s = normalizeAppliesTo(scope);
  return s.outletTypes.length === 0 && s.programs.length === 0 && s.subPrograms.length === 0;
}

function facetHasValue(list: ReadonlyArray<string>, value: string | null | undefined): boolean {
  if (list.length === 0) return true;
  const v = (value ?? '').trim();
  if (!v) return false; // D4: non-empty facet + blank outlet value → out of scope
  const key = v.toUpperCase();
  return list.some((x) => ciKey(x) === key);
}

/** Does `scope` apply to an outlet with these facet values? (AND across facets; D4.) */
export function appliesToOutlet(scope: AppliesToInput, outlet: AppliesToOutletFacets): boolean {
  const s = normalizeAppliesTo(scope);
  return (
    facetHasValue(s.outletTypes, outlet.outletType) &&
    facetHasValue(s.programs, outlet.program) &&
    facetHasValue(s.subPrograms, outlet.subProgram)
  );
}

/** A filter value is "no filter" when absent / blank / the sentinel 'ALL' (ci). */
export function isNoFilterValue(v: string | null | undefined): boolean {
  const t = (v ?? '').trim();
  return t === '' || t.toUpperCase() === 'ALL';
}

function facetPassesFilter(list: ReadonlyArray<string>, filter: string | null | undefined): boolean {
  if (list.length === 0 || isNoFilterValue(filter)) return true;
  const key = ciKey(filter as string);
  return list.some((x) => ciKey(x) === key);
}

/**
 * View-filter match (D6/D7): each facet passes if the scope facet is EMPTY, OR the filter facet is
 * absent / blank / 'ALL', OR the scope facet contains the filter value (ci). AND across facets.
 * With no filter at all every scope passes (→ legacy "no type requested = all KPIs").
 */
export function appliesToFilter(scope: AppliesToInput, filter: AppliesToFilterInput | null | undefined): boolean {
  const s = normalizeAppliesTo(scope);
  const f = filter ?? {};
  return (
    facetPassesFilter(s.outletTypes, f.outletType) &&
    facetPassesFilter(s.programs, f.program) &&
    facetPassesFilter(s.subPrograms, f.subProgram)
  );
}

/**
 * Intersection of two scopes (outlets matched by BOTH). Per facet: empty ∩ X = X; X ∩ Y = the ci
 * common values (a's spelling, a's order). Returns `null` when the scopes are DISJOINT (some facet
 * is non-empty on both sides with no common value → no outlet can match both).
 */
export function intersectAppliesTo(a: AppliesToInput, b: AppliesToInput): AppliesTo | null {
  const na = normalizeAppliesTo(a);
  const nb = normalizeAppliesTo(b);
  const out = emptyAppliesTo();
  for (const f of APPLIES_TO_FACETS) {
    const la = na[f];
    const lb = nb[f];
    if (la.length === 0) out[f] = [...lb];
    else if (lb.length === 0) out[f] = [...la];
    else {
      const keys = new Set(lb.map(ciKey));
      const common = la.filter((x) => keys.has(ciKey(x)));
      if (common.length === 0) return null;
      out[f] = common;
    }
  }
  return out;
}

/** Legacy KpiDef.outletType → AppliesTo (null/blank = unscoped; else that one type, UPPERCASED). */
export function fromLegacyOutletType(outletType: string | null | undefined): AppliesTo {
  return normalizeAppliesTo({ outletTypes: outletType == null ? [] : [outletType] });
}

/** Minimal KpiDef shape for resolving its scope (new arrays + the DEPRECATED legacy column). */
export interface KpiScopeLike {
  outletType?: string | null;
  outletTypes?: ReadonlyArray<string> | null;
  programs?: ReadonlyArray<string> | null;
  subPrograms?: ReadonlyArray<string> | null;
}

/**
 * The effective AppliesTo of a KpiDef row. The new arrays WIN when any facet is non-empty;
 * otherwise falls back to the DEPRECATED `outletType` column (rows read without the new columns,
 * or a legacy-only writer during the one-release dual-write window).
 */
export function kpiAppliesTo(k: KpiScopeLike): AppliesTo {
  const arrays = normalizeAppliesTo({
    outletTypes: k.outletTypes ?? [],
    programs: k.programs ?? [],
    subPrograms: k.subPrograms ?? [],
  });
  if (!isUnscoped(arrays)) return arrays;
  return fromLegacyOutletType(k.outletType);
}

/**
 * Legacy dual-write value for KpiDef.outletType (plan §0): the single type when the scope is
 * EXACTLY one outlet type and no programs / sub-programs; else null.
 */
export function legacyOutletTypeOf(scope: AppliesToInput): string | null {
  const s = normalizeAppliesTo(scope);
  return s.outletTypes.length === 1 && s.programs.length === 0 && s.subPrograms.length === 0
    ? s.outletTypes[0]
    : null;
}

/** Hash fragment for definitionsHash (plan §5). Spread into the hashed object. */
export type CanonicalScopeKey =
  | Record<string, never>
  | { kpiOutletType: string }
  | { kpiScope: { outletTypes: string[]; programs: string[]; subPrograms: string[] } };

/**
 * Stable hash fragment for a scope (plan §5 — existing hashes must not change):
 *   - unscoped                               → {}                       (emit nothing)
 *   - exactly one outlet type, no programs/subPrograms → { kpiOutletType: 'TYPE' } (legacy form)
 *   - anything else                          → { kpiScope: { outletTypes, programs, subPrograms } }
 *     with every value UPPERCASED (matching is ci, so spelling-only edits don't churn the hash) and
 *     each list sorted.
 */
export function canonicalScopeKey(scope: AppliesToInput): CanonicalScopeKey {
  const s = normalizeAppliesTo(scope);
  if (isUnscoped(s)) return {};
  const legacy = legacyOutletTypeOf(s);
  if (legacy !== null) return { kpiOutletType: legacy };
  const sorted = (l: string[]) => l.map(ciKey).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return {
    kpiScope: {
      outletTypes: sorted(s.outletTypes),
      programs: sorted(s.programs),
      subPrograms: sorted(s.subPrograms),
    },
  };
}
