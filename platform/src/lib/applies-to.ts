/**
 * APPLIES-TO targeting — FE mirror of `api/src/common/applies-to/applies-to.ts`
 * (platform/docs/plans/APPLIES-TO-TARGETING-PLAN.md §0/§2). Keep the two in lock-step.
 *
 *   AppliesTo = { outletTypes, programs, subPrograms }
 *   - AND across facets, OR within; EMPTY facet = ALL.
 *   - Trimmed + case-insensitive matching (D8).
 *   - D4: a NON-empty facet + a BLANK outlet value → OUT of scope.
 *   - outletTypes ↔ outlet type code, programs ↔ programName, subPrograms ↔ programCategory.
 *
 * The backend is authoritative (D3 — enforced at write + KPI-list building); the FE uses this for
 * previews (matching-outlet counts, scope chips, warnings) only.
 */

export interface AppliesTo {
  /** Outlet type codes (UPPERCASED by normalize). Empty = every type. */
  outletTypes: string[];
  /** Outlet programName values. Empty = every program. */
  programs: string[];
  /** Outlet programCategory values. Empty = every sub-program. */
  subPrograms: string[];
}

export type AppliesToInput =
  | {
      outletTypes?: ReadonlyArray<unknown> | null;
      programs?: ReadonlyArray<unknown> | null;
      subPrograms?: ReadonlyArray<unknown> | null;
    }
  | null
  | undefined;

export interface AppliesToOutletFacets {
  outletType?: string | null;
  program?: string | null;
  subProgram?: string | null;
}

export function emptyAppliesTo(): AppliesTo {
  return { outletTypes: [], programs: [], subPrograms: [] };
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
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(upper ? key : t);
  }
  return out;
}

/** Trim, drop blanks / non-strings, dedupe case-insensitively (first spelling wins); types UPPERCASED. */
export function normalizeAppliesTo(input: AppliesToInput): AppliesTo {
  return {
    outletTypes: normList(input?.outletTypes, true),
    programs: normList(input?.programs, false),
    subPrograms: normList(input?.subPrograms, false),
  };
}

/** True when every facet is empty (applies to every outlet). */
export function isUnscoped(scope: AppliesToInput): boolean {
  const s = normalizeAppliesTo(scope);
  return s.outletTypes.length === 0 && s.programs.length === 0 && s.subPrograms.length === 0;
}

function facetHasValue(list: ReadonlyArray<string>, value: string | null | undefined): boolean {
  if (list.length === 0) return true;
  const v = (value ?? '').trim();
  if (!v) return false; // D4
  const key = v.toUpperCase();
  return list.some((x) => x.trim().toUpperCase() === key);
}

/**
 * Intersection of two scopes (outlets matched by BOTH) — mirror of the backend `intersectAppliesTo`. Per facet:
 * empty ∩ X = X; X ∩ Y = the ci common values (a's spelling, a's order). `null` when DISJOINT (some facet is
 * non-empty on both sides with no common value → no outlet can match both).
 */
export function intersectAppliesTo(a: AppliesToInput, b: AppliesToInput): AppliesTo | null {
  const na = normalizeAppliesTo(a);
  const nb = normalizeAppliesTo(b);
  const out = emptyAppliesTo();
  for (const f of ['outletTypes', 'programs', 'subPrograms'] as const) {
    const la = na[f];
    const lb = nb[f];
    if (la.length === 0) out[f] = [...lb];
    else if (lb.length === 0) out[f] = [...la];
    else {
      const keys = new Set(lb.map((x) => x.toUpperCase()));
      const common = la.filter((x) => keys.has(x.toUpperCase()));
      if (common.length === 0) return null;
      out[f] = common;
    }
  }
  return out;
}

/** Does `scope` apply to an outlet with these facet values? */
export function appliesToOutlet(scope: AppliesToInput, outlet: AppliesToOutletFacets): boolean {
  const s = normalizeAppliesTo(scope);
  return (
    facetHasValue(s.outletTypes, outlet.outletType) &&
    facetHasValue(s.programs, outlet.program) &&
    facetHasValue(s.subPrograms, outlet.subProgram)
  );
}
