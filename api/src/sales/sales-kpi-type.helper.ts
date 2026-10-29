/**
 * Pure, DI-free helper for resolving the KPI set (and the primary KPI) that
 * applies to a given outlet TYPE.
 *
 * KpiDef.outletType semantics (see schema.prisma):
 *   null                         — SHARED KPI: applies to EVERY outlet type.
 *   'SSS' / 'WHOLESALER' / …     — type-SPECIFIC KPI (Outlet.outletType.code).
 *
 * "The KPI set for an outlet type" = every KpiDef where `outletType IS NULL OR
 * outletType === type` (shared KPIs always ride along). When NO type is requested
 * (the RLP/BSC toggle is off / "ALL"), the filter is a no-op and EVERY KpiDef is
 * returned — so a tenant with only shared (null) KPIs, e.g. live Deoleo, is
 * byte-identical to the pre-outletType behaviour.
 *
 * Primary pick mirrors the rest of the sales service exactly: within the filtered
 * set, the first `isPrimary` by configured order, else the first by order (code as
 * the final tiebreak). This is deliberately the SAME rule getTeamView / getTargets
 * use, so a type-agnostic call resolves the same primary they do.
 */

/** Minimal KpiDef shape this helper reads (a superset is fine). */
export interface KpiTypeLike {
  code: string;
  isPrimary: boolean;
  order: number;
  /** null = shared (applies to all types); a code = that type only. */
  outletType: string | null;
}

/** A requested outlet type is "no filter" when absent/blank or the sentinel 'ALL'. */
function isNoTypeFilter(type?: string | null): boolean {
  const t = (type ?? '').trim();
  return t === '' || t.toUpperCase() === 'ALL';
}

/**
 * Filters `kpiDefs` to those that apply to `type` (shared + that-type-specific),
 * ordered by configured order then code. When `type` is absent / 'ALL' the full
 * list is returned (no filtering).
 */
export function kpisForOutletType<T extends KpiTypeLike>(kpiDefs: T[], type?: string | null): T[] {
  const noFilter = isNoTypeFilter(type);
  const t = (type ?? '').trim();
  return [...kpiDefs]
    .filter((k) => noFilter || k.outletType == null || k.outletType === t)
    .sort((a, b) => a.order - b.order || a.code.localeCompare(b.code));
}

/**
 * The primary KPI within the outlet-type-filtered set: the first `isPrimary` by
 * configured order, else the first KPI by order, else null when the set is empty.
 */
export function primaryKpiForOutletType<T extends KpiTypeLike>(
  kpiDefs: T[],
  type?: string | null,
): T | null {
  const set = kpisForOutletType(kpiDefs, type);
  return set.find((k) => k.isPrimary) ?? set[0] ?? null;
}
