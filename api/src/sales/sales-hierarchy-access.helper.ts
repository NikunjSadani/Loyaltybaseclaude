/**
 * Pure access-control helper for the sales reporting hierarchy.
 *
 * A SalesUser may view themselves or anyone in their own reporting subtree
 * (i.e. a descendant reached by following `reportingToId` edges *upward* from
 * the target back to the caller). This module contains no DB access so it can
 * be unit-tested with plain arrays — the service loads the tenant's edge list
 * (already tenant-scoped) and calls `isSelfOrDescendant`.
 *
 * Ported verbatim from platform/src/lib/sales-hierarchy-access.ts. This carries
 * the cross-tenant IDOR fix: the target must exist in the tenant-scoped edge
 * list to be viewable at all, and access is only granted when the target is the
 * caller or a descendant in the caller's subtree.
 */

export interface SalesUserEdge {
  id: string;
  reportingToId: string | null;
}

/**
 * Returns true when `targetId` is the caller themselves OR a descendant of the
 * caller in the reporting tree.
 *
 * Walks from the target up the `reportingToId` chain. If we reach the caller,
 * the target is in the caller's subtree. The walk is bounded by the number of
 * edges and guards against cycles (defensive — the tree shouldn't have any).
 *
 * @param targetId           the SalesUser the caller wants to view
 * @param callerSalesUserId  the caller's own SalesUser.id
 * @param edges              tenant-scoped {id, reportingToId} edge list
 */
export function isSelfOrDescendant(
  targetId: string,
  callerSalesUserId: string,
  edges: SalesUserEdge[],
): boolean {
  if (!targetId || !callerSalesUserId) return false;
  if (targetId === callerSalesUserId) return true;

  const parentOf = new Map<string, string | null>();
  for (const e of edges) parentOf.set(e.id, e.reportingToId);

  // The target must exist in the tenant's edge list to be viewable at all.
  if (!parentOf.has(targetId)) return false;

  const seen = new Set<string>();
  let current: string | null = targetId;
  while (current) {
    if (seen.has(current)) return false; // cycle guard
    seen.add(current);
    const parent = parentOf.get(current) ?? null;
    if (parent === callerSalesUserId) return true;
    current = parent;
  }
  return false;
}
