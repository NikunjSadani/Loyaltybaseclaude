/**
 * Pure, DI-free helper for resolving the KPI set (and the primary KPI) that applies to a sales VIEW
 * scope filter (outlet type / program / sub-program) — APPLIES-TO plan §2, D6/D7.
 *
 * A KpiDef's scope = `kpiAppliesTo(k)` (common/applies-to): the new `outletTypes` / `programs` /
 * `subPrograms` arrays when any is non-empty, else the DEPRECATED `outletType` column
 * (null = SHARED KPI, every outlet type; a code = that type only).
 *
 * "The KPI set for a filter" = every KpiDef whose scope passes `appliesToFilter(scope, filter)`:
 * per facet, an EMPTY KPI facet (shared) always rides along, an absent / 'ALL' filter facet is a
 * no-op, else the KPI facet must contain the filter value (trimmed, case-insensitive). With NO
 * filter, EVERY KpiDef is returned — so a tenant with only unscoped KPIs, e.g. live Deoleo, is
 * byte-identical to the pre-scope behaviour.
 *
 * Primary pick mirrors the rest of the sales service exactly: within the filtered set, the first
 * `isPrimary` by configured order, else the first by order (code as the final tiebreak) — D6
 * "primary falls back to the first in-scope KPI".
 *
 * `kpisForOutletType` / `primaryKpiForOutletType` are the legacy type-only entry points, kept as
 * thin wrappers (`{ outletType: type }` filter).
 */
import { AppliesToFilterInput, appliesToFilter, kpiAppliesTo } from '../common/applies-to/applies-to';

/** Minimal KpiDef shape this helper reads (a superset is fine). */
export interface KpiTypeLike {
  code: string;
  isPrimary: boolean;
  order: number;
  /** DEPRECATED legacy tag: null = shared (applies to all types); a code = that type only. */
  outletType?: string | null;
  /** APPLIES-TO scope arrays (empty / absent = all). Win over `outletType` when any is non-empty. */
  outletTypes?: ReadonlyArray<string> | null;
  programs?: ReadonlyArray<string> | null;
  subPrograms?: ReadonlyArray<string> | null;
}

/** A sales view's scope filter; any facet absent / blank / 'ALL' = no filter on that facet. */
export type KpiScopeFilter = AppliesToFilterInput;

/**
 * Filters `kpiDefs` to those that apply to the view `filter` (unscoped + matching-scope KPIs),
 * ordered by configured order then code. With no filter the full list is returned (no filtering).
 */
export function kpisForScopeFilter<T extends KpiTypeLike>(
  kpiDefs: T[],
  filter?: KpiScopeFilter | null,
): T[] {
  return [...kpiDefs]
    .filter((k) => appliesToFilter(kpiAppliesTo(k), filter))
    .sort((a, b) => a.order - b.order || a.code.localeCompare(b.code));
}

/**
 * The primary KPI within the filter's KPI set: the first `isPrimary` by configured order, else the
 * first KPI by order (D6 fallback), else null when the set is empty.
 */
export function primaryKpiFor<T extends KpiTypeLike>(
  kpiDefs: T[],
  filter?: KpiScopeFilter | null,
): T | null {
  const set = kpisForScopeFilter(kpiDefs, filter);
  return set.find((k) => k.isPrimary) ?? set[0] ?? null;
}

/**
 * Legacy wrapper: KPIs for an outlet TYPE (shared + that-type-specific). Absent / blank / 'ALL'
 * → every KpiDef. Identical results to the pre-scope implementation for legacy data.
 */
export function kpisForOutletType<T extends KpiTypeLike>(kpiDefs: T[], type?: string | null): T[] {
  return kpisForScopeFilter(kpiDefs, { outletType: type });
}

/** Legacy wrapper: the primary KPI within the outlet-type-filtered set. */
export function primaryKpiForOutletType<T extends KpiTypeLike>(
  kpiDefs: T[],
  type?: string | null,
): T | null {
  return primaryKpiFor(kpiDefs, { outletType: type });
}
