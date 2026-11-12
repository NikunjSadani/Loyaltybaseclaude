/**
 * Per-OUTLET KPI applicability (APPLIES-TO plan D6) — thin compositions over the shared pure
 * matcher (`kpiAppliesTo` + `appliesToOutlet` in common/applies-to). No new matching rules live here.
 *
 * Every helper is a strict no-op for UNSCOPED KPIs (empty scope = applies to every outlet), so a
 * tenant with no scoped KPIs (live Deoleo) gets exactly the input back / no override.
 */
import {
  AppliesToOutletFacets,
  appliesToOutlet,
  isUnscoped,
  kpiAppliesTo,
  KpiScopeLike,
} from '../common/applies-to/applies-to';

/**
 * A per-outlet "does this KPI apply here?" predicate, or `undefined` when the KPI is unscoped
 * (applies everywhere). Callers branch on `undefined` to keep their pre-scope code path untouched.
 */
export function kpiOutletPredicate(
  k: KpiScopeLike | null | undefined,
): ((o: AppliesToOutletFacets) => boolean) | undefined {
  if (!k) return undefined;
  const scope = kpiAppliesTo(k);
  if (isUnscoped(scope)) return undefined;
  return (o) => appliesToOutlet(scope, o);
}

/** True when KpiDef `k` applies to `outlet` (unscoped → always true). */
export function kpiAppliesToOutlet(k: KpiScopeLike, outlet: AppliesToOutletFacets): boolean {
  const p = kpiOutletPredicate(k);
  return !p || p(outlet);
}

/** The KpiDefs that apply to one outlet, INPUT ORDER PRESERVED (unscoped tenant → same array content). */
export function kpisForOutlet<T extends KpiScopeLike>(kpiDefs: T[], outlet: AppliesToOutletFacets): T[] {
  return kpiDefs.filter((k) => kpiAppliesToOutlet(k, outlet));
}

/**
 * D6 primary fallback for ONE outlet. Returns the code that should be treated as THE primary for
 * this outlet ONLY when the tenant has a flagged primary but none of its flagged primaries apply to
 * the outlet — then the outlet's first in-scope KPI (by order, then code). Returns `null` (= "keep
 * the tenant's isPrimary flags exactly as they are") in every other case, incl. every unscoped tenant
 * and a tenant with no flagged primary at all.
 */
export function outletPrimaryFallback<T extends KpiScopeLike & { code: string; isPrimary: boolean; order?: number | null }>(
  kpiDefs: T[],
  outlet: AppliesToOutletFacets,
): string | null {
  const flagged = kpiDefs.filter((k) => k.isPrimary);
  if (flagged.length === 0) return null;
  if (flagged.some((k) => kpiAppliesToOutlet(k, outlet))) return null;
  const inScope = kpisForOutlet(kpiDefs, outlet).sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.code.localeCompare(b.code),
  );
  return inScope[0]?.code ?? null;
}
