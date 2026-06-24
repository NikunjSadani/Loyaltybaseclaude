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

/**
 * Returns the set of SalesUser ids in the caller's reporting subtree — the
 * caller themselves plus every descendant reached by following `reportingToId`
 * edges downward. Used to scope "whole-downline" reads (a manager's assigned
 * outlets and their team's KYC submissions) in ONE query instead of an
 * isSelfOrDescendant() call per row. Cycle-safe.
 *
 * @param callerSalesUserId  the caller's own SalesUser.id (always included)
 * @param edges              tenant-scoped {id, reportingToId} edge list
 */
export function descendantSalesUserIds(
  callerSalesUserId: string,
  edges: SalesUserEdge[],
): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!e.reportingToId) continue;
    const arr = childrenOf.get(e.reportingToId) ?? [];
    arr.push(e.id);
    childrenOf.set(e.reportingToId, arr);
  }

  const subtree = new Set<string>([callerSalesUserId]);
  const queue: string[] = [callerSalesUserId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of childrenOf.get(current) ?? []) {
      if (!subtree.has(child)) {
        subtree.add(child);
        queue.push(child);
      }
    }
  }
  return subtree;
}

export interface SalesApproverNode {
  id: string;
  reportingToId: string | null;
  isActive: boolean;
}

/**
 * Returns the SalesUser id of the first ACTIVE manager up the submitter's
 * reporting chain — i.e. the routed approver for a KYC the submitter filed.
 * Skips inactive (vacant) managers, mirroring KycService.resolveInitialRouting
 * ("the next level approves; if that level is vacant, the level above it does").
 * Returns null when no active manager exists up the chain. Bounded + cycle-safe.
 *
 * @param submitterSalesUserId  the SalesUser who filed the KYC
 * @param nodes                 tenant-scoped node list with isActive
 */
export function firstActiveApproverId(
  submitterSalesUserId: string,
  nodes: SalesApproverNode[],
): string | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const start = byId.get(submitterSalesUserId);
  if (!start) return null;

  const MAX_HOPS = 20;
  const seen = new Set<string>();
  let currentId: string | null = start.reportingToId;
  let hops = 0;
  while (currentId && hops < MAX_HOPS) {
    if (seen.has(currentId)) break; // cycle guard
    seen.add(currentId);
    hops++;
    const node = byId.get(currentId);
    if (!node) break; // dangling reference
    if (node.isActive) return node.id;
    currentId = node.reportingToId;
  }
  return null;
}
