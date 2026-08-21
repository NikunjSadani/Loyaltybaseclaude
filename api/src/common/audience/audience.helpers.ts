/**
 * audience.helpers.ts — pure, unit-testable audience-resolution primitives shared
 * by the Scheme broadcaster (`schemes/scheme-notify.service.ts`) and the WhatsApp
 * Broadcasts module (`whatsapp-broadcasts/*`). No Prisma / NestJS imports, so these
 * are testable with plain arrays.
 *
 * What is generalised here (the logic that used to live inline in scheme-notify):
 *   - phoneLast10        — canonical last-10-digit phone form (dedup + validity key)
 *   - OUTLET_FILTER_KEYS — the recipient-filter facet shape (zones/programNames/…)
 *   - hasOutletFilter / matchesOutletFilter — inclusion-only facet matching
 *   - ancestorSalesUserIds — the tagged-employee + up-hierarchy reporting walk (D20)
 *   - applyDndSuppression — the opt-out/DND suppression hook (empty list today)
 *
 * The DATA SOURCE differs per caller (a scheme reads its own roster; a WhatsApp
 * FILTER broadcast reads the tenant's whole Outlet/Sales master), so the Prisma
 * queries stay in each caller — only the pure predicate/canonicalisation logic is
 * shared, which is exactly what makes the scheme behaviour byte-identical after the
 * refactor.
 */

/** Canonical last-10-digit phone form (strips +91/91/punctuation). Empty when no digits. */
export function phoneLast10(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '').slice(-10);
}

/** True iff a canonicalised value is a valid bare 10-digit Indian mobile. */
export function isValidPhone(phone: string): boolean {
  return /^\d{10}$/.test(phone);
}

/**
 * The outlet-facet filter shape shared by scheme broadcasts and WhatsApp FILTER
 * broadcasts. Every facet is an INCLUSION list; an absent/empty facet matches all.
 */
export interface OutletAudienceFilter {
  zones?: string[];
  programNames?: string[];
  programCategories?: string[];
  outletTypeIds?: string[];
  states?: string[];
  /** SALES scope: narrow the tagged employees before the up-hierarchy walk (scheme only). */
  taggedSalesUserIds?: string[];
}

/** The outlet attributes a filter is matched against. */
export interface OutletMatchAttrs {
  zone?: string | null;
  programName?: string | null;
  programCategory?: string | null;
  state?: string | null;
  outletTypeId?: string | null;
}

/** True iff any outlet-narrowing facet is set (so standalone/attribute-less rows are excluded). */
export function hasOutletFilter(filter?: OutletAudienceFilter): boolean {
  if (!filter) return false;
  return [
    filter.zones,
    filter.programNames,
    filter.programCategories,
    filter.outletTypeIds,
    filter.states,
  ].some((f) => Array.isArray(f) && f.length > 0);
}

/** One facet passes when it is empty/absent, or when the outlet's value is in the list. */
function inFilter(vals: string[] | undefined, v: string | null | undefined): boolean {
  return !vals || vals.length === 0 || (v != null && vals.includes(v));
}

/** True iff the outlet attributes satisfy EVERY set facet of the filter (inclusion-only). */
export function matchesOutletFilter(
  filter: OutletAudienceFilter | undefined,
  attrs: OutletMatchAttrs,
): boolean {
  if (!hasOutletFilter(filter)) return true;
  return (
    inFilter(filter?.zones, attrs.zone) &&
    inFilter(filter?.programNames, attrs.programName) &&
    inFilter(filter?.programCategories, attrs.programCategory) &&
    inFilter(filter?.states, attrs.state) &&
    inFilter(filter?.outletTypeIds, attrs.outletTypeId)
  );
}

/** Minimal reporting edge for the up-hierarchy walk (id → its manager). */
export interface SalesReportingEdge {
  id: string;
  reportingToId: string | null;
}

/**
 * Pure: given tagged employees, return the SalesUser ids to notify — the tagged
 * users themselves PLUS every ANCESTOR up their reporting chain (D20). Walks
 * `reportingToId` upward from each tagged id. Cycle-safe + bounded. Unknown/foreign
 * ids are skipped.
 */
export function ancestorSalesUserIds(
  taggedIds: string[],
  edges: SalesReportingEdge[],
): Set<string> {
  const parentOf = new Map<string, string | null>();
  for (const e of edges) parentOf.set(e.id, e.reportingToId);

  const out = new Set<string>();
  for (const start of taggedIds) {
    if (!start || !parentOf.has(start)) continue; // unknown/foreign id — skip
    const seen = new Set<string>();
    let current: string | null = start;
    while (current && !seen.has(current)) {
      seen.add(current);
      out.add(current);
      current = parentOf.get(current) ?? null;
    }
  }
  return out;
}

/**
 * Opt-out / DND suppression hook. Removes any canonical phone present in the
 * suppression set from the recipient set. The suppression list is empty today (no
 * DND store yet), so this is a structural no-op — but every audience resolver routes
 * through it so wiring a real DND source later is a one-line change with no caller
 * churn. Returns a NEW set (never mutates the input).
 */
export function applyDndSuppression(
  phones: Set<string>,
  suppressed: ReadonlySet<string> = new Set(),
): Set<string> {
  if (suppressed.size === 0) return new Set(phones);
  const out = new Set<string>();
  for (const p of phones) if (!suppressed.has(p)) out.add(p);
  return out;
}
