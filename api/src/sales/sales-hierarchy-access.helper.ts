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
  /**
   * Soft-delete marker (optional). A node with a non-null `deletedAt` is walked THROUGH (its
   * reports stay reachable, its manager stays reachable from below) but is never itself a team
   * member, a viewable member, an approver or an immediate reportee (G3). Edge lists loaded with a
   * `deletedAt: null` filter never carry it → unchanged behaviour. Load edges with
   * `loadSalesHierarchy` (sales-hierarchy.loader.ts) to get the deleted-aware list.
   */
  deletedAt?: Date | null;
  /** Optional active flag — only read by `effectiveDirectReportIds` / `firstActiveApproverId`. */
  isActive?: boolean;
}

/**
 * Returns true when `targetId` is the caller themselves OR a descendant of the
 * caller in the reporting tree.
 *
 * Walks from the target up the `reportingToId` chain. If we reach the caller,
 * the target is in the caller's subtree. The walk is bounded by the number of
 * edges and guards against cycles (defensive — the tree shouldn't have any).
 *
 * G3: a soft-deleted node in the middle of the chain is walked THROUGH (an ASM above a deleted SO
 * can view that SO's ISRs); a soft-deleted TARGET is never viewable (a resigned user is not a member).
 *
 * @param targetId           the SalesUser the caller wants to view
 * @param callerSalesUserId  the caller's own SalesUser.id
 * @param edges              tenant-scoped {id, reportingToId, deletedAt?} edge list
 */
export function isSelfOrDescendant(
  targetId: string,
  callerSalesUserId: string,
  edges: SalesUserEdge[],
  /** O1: `allowDeletedTarget` — the target may itself be soft-deleted (a removed KYC submitter). */
  opts: { allowDeletedTarget?: boolean } = {},
): boolean {
  if (!targetId || !callerSalesUserId) return false;
  if (targetId === callerSalesUserId) return true;

  const parentOf = new Map<string, string | null>();
  const deleted = new Set<string>();
  for (const e of edges) {
    parentOf.set(e.id, e.reportingToId);
    if (e.deletedAt != null) deleted.add(e.id);
  }

  // The target must exist in the tenant's edge list to be viewable at all, and must be live — unless the
  // caller explicitly asks about a REMOVED target (O1: the submitter of a KYC who resigned after filing).
  if (!parentOf.has(targetId)) return false;
  if (deleted.has(targetId) && !opts.allowDeletedTarget) return false;

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
 * G3 (PLATFORM-WIDE, owner-approved 2026-11-17) — a SOFT-DELETED manager (edge `deletedAt` set) is
 * walked THROUGH: their reports stay in the caller's downline (an ASM above a deleted SO still reaches
 * that SO's ISRs), mirroring how KycService.resolveInitialRouting escalates past a vacant manager. The
 * deleted node itself is NOT returned (a resigned user is not a team member; resign also unassigns
 * their outlets). Callers that want this pass an edge list loaded WITHOUT a `deletedAt: null` filter
 * and including `deletedAt`; an inactive-but-not-deleted node is a normal member (unchanged).
 *
 * O1 (owner 2026-11-18): `includeDeleted` ALSO returns the deleted nodes reached by the walk — used only
 * to scope KYC SUBMITTERS, so a KYC filed by a rep who was removed afterwards stays with the managers
 * above that rep. Never use it for membership / assignment scope.
 *
 * @param callerSalesUserId  the caller's own SalesUser.id (always included)
 * @param edges              tenant-scoped {id, reportingToId, deletedAt?} edge list
 */
export function descendantSalesUserIds(
  callerSalesUserId: string,
  edges: SalesUserEdge[],
  opts: { includeDeleted?: boolean } = {},
): Set<string> {
  const childrenOf = new Map<string, string[]>();
  const deleted = new Set<string>();
  for (const e of edges) {
    if (e.deletedAt != null) deleted.add(e.id);
    if (!e.reportingToId) continue;
    const arr = childrenOf.get(e.reportingToId) ?? [];
    arr.push(e.id);
    childrenOf.set(e.reportingToId, arr);
  }

  const subtree = new Set<string>([callerSalesUserId]);
  const visited = new Set<string>([callerSalesUserId]); // cycle guard (covers deleted nodes too)
  const queue: string[] = [callerSalesUserId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of childrenOf.get(current) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      if (!deleted.has(child) || opts.includeDeleted) subtree.add(child);
      queue.push(child);
    }
  }
  return subtree;
}

/**
 * ONE hop bound for every upward reporting walk (routing, the multi-level climb, the approver lookup, the
 * next-active-manager display). Real chains are ≤ 6 levels; the bound only stops corrupt data. (F6)
 */
export const HIERARCHY_MAX_HOPS = 20;

/** A node is soft-deleted (REMOVED). Inactive-but-not-deleted is NOT removed. */
export function isRemovedNode(e: SalesUserEdge): boolean {
  return e.deletedAt != null;
}

/** A node can be shown as a manager / approver: live AND active (routing's rule). */
export function isLiveActiveNode(e: SalesUserEdge): boolean {
  return e.deletedAt == null && e.isActive !== false;
}

/** Ids of the manager's ancestors (walking reportingToId up, cycle-safe). */
function ancestorIds(managerId: string, edges: SalesUserEdge[]): Set<string> {
  const parentOf = new Map<string, string | null>();
  for (const e of edges) parentOf.set(e.id, e.reportingToId);
  const out = new Set<string>();
  let cur = parentOf.get(managerId) ?? null;
  while (cur && !out.has(cur) && cur !== managerId) {
    out.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return out;
}

/**
 * G3 — the manager's EFFECTIVE direct reports: every NON-DELETED node directly under the manager (active
 * or inactive — exactly the people the team screens counted before), PLUS — for a direct report that was
 * REMOVED (soft-deleted) — that slot's own effective reports, recursively. Owner F2 (2026-11-18): ONLY
 * `deletedAt` triggers the walk-through; an INACTIVE manager stays a normal member and their team is NOT
 * promoted (Deoleo has inactive users on prod — their screens stay byte-identical).
 *
 * F7: cycle-safe — every node is visited once, and the manager itself or any of the manager's ANCESTORS is
 * never returned (a corrupt manager → deleted D → ancestor cycle cannot promote the boss into the team).
 * Order: BFS (direct reports first, then promoted ones in walk order).
 *
 * @param managerId  the manager whose team list is being built
 * @param edges      tenant-scoped edge list INCLUDING deleted nodes (`loadSalesHierarchy`)
 */
export function effectiveDirectReportIds(managerId: string, edges: SalesUserEdge[]): string[] {
  const childrenOf = new Map<string, SalesUserEdge[]>();
  for (const e of edges) {
    if (!e.reportingToId) continue;
    const arr = childrenOf.get(e.reportingToId) ?? [];
    arr.push(e);
    childrenOf.set(e.reportingToId, arr);
  }
  const forbidden = ancestorIds(managerId, edges);
  const out: string[] = [];
  const visited = new Set<string>([managerId]);
  const queue: string[] = [managerId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of childrenOf.get(current) ?? []) {
      if (visited.has(child.id)) continue; // cycle guard
      visited.add(child.id);
      if (forbidden.has(child.id)) continue; // F7: never promote an ancestor (corrupt cycle)
      if (isRemovedNode(child)) queue.push(child.id); // removed slot → walk through to its reports
      else out.push(child.id);
    }
  }
  return out;
}

/**
 * The effective direct reports reached ONLY through a REMOVED direct report — `effectiveDirectReportIds`
 * minus the manager's own non-deleted direct children. Callers that already load the direct children with
 * a Prisma `subordinates` include use this to fetch the extra (promoted) rows only when there are any.
 * Includes inactive promoted reports (they count toward teamSize; member LISTS filter them like before).
 */
export function promotedReportIds(managerId: string, edges: SalesUserEdge[]): string[] {
  const direct = new Set(
    edges.filter((e) => e.reportingToId === managerId && e.id !== managerId && !isRemovedNode(e)).map((e) => e.id),
  );
  return effectiveDirectReportIds(managerId, edges).filter((id) => !direct.has(id));
}

/** `promotedReportIds` restricted to ACTIVE people — the extra member ROWS a team list shows. */
export function promotedActiveReportIds(managerId: string, edges: SalesUserEdge[]): string[] {
  const byId = new Map(edges.map((e) => [e.id, e]));
  return promotedReportIds(managerId, edges).filter((id) => byId.get(id)?.isActive !== false);
}

/**
 * Resolve the viewer's IMMEDIATE REPORTEE for an outlet — the viewer's DIRECT report
 * through whom the chain of command reaches the outlet's assigned rep, so a reviewer
 * knows whom to call to action the outlet.
 *
 * Returns the id of the viewer's direct report `m` such that an assigned rep is `m`
 * itself OR a descendant of `m` (`m` ∈ the chain from the assigned rep up to the
 * viewer). Returns null when:
 *   • the viewer has no direct report in the chain (an ISR/leaf viewer, or the outlet is
 *     assigned directly to the viewer with no intervening reportee), or
 *   • none of the assigned reps sits under the viewer at all.
 *
 * Walks each assigned rep UP the `reportingToId` chain; the first node whose parent is
 * the viewer is a direct report of the viewer — that is the immediate reportee. Only
 * reps that exist in the tenant-scoped edge list are considered (the caller has already
 * access-scoped the outlet to the viewer's subtree, so `assignedSalesUserIds` should be
 * the reps that fall within it). Bounded + cycle-safe — no DB access, so it is unit-
 * testable with plain arrays.
 *
 * @param viewerSalesUserId    the viewing manager's own SalesUser.id
 * @param assignedSalesUserIds the outlet's active-assigned SalesUser ids
 * @param edges                tenant-scoped {id, reportingToId} edge list
 */
export function immediateReporteeForOutlet(
  viewerSalesUserId: string,
  assignedSalesUserIds: string[],
  edges: SalesUserEdge[],
): string | null {
  if (!viewerSalesUserId || assignedSalesUserIds.length === 0) return null;

  const parentOf = new Map<string, string | null>();
  const deleted = new Set<string>();
  for (const e of edges) {
    parentOf.set(e.id, e.reportingToId);
    if (e.deletedAt != null) deleted.add(e.id);
  }

  for (const repId of assignedSalesUserIds) {
    // The rep must exist in the tenant's edge list to be walkable at all.
    if (!repId || !parentOf.has(repId)) continue;
    const seen = new Set<string>();
    let current: string | null = repId;
    // G3: the top-most LIVE node seen so far on the way up. When the viewer's direct report on this
    // chain is soft-deleted, the immediate reportee is the next live person below that vacant slot
    // (the viewer's EFFECTIVE direct report) — never the deleted person.
    let topLive: string | null = null;
    while (current) {
      if (seen.has(current)) break; // cycle guard
      seen.add(current);
      if (!deleted.has(current)) topLive = current;
      const parent = parentOf.get(current) ?? null;
      // `current`'s parent is the viewer → `current` is a direct report of the viewer,
      // and it is the (inclusive) ancestor of the assigned rep = the immediate reportee.
      if (parent === viewerSalesUserId) {
        if (topLive) return topLive;
        break; // every node on this chain is deleted → no reportee via this rep
      }
      current = parent;
    }
  }
  return null;
}

export interface SalesApproverNode {
  id: string;
  reportingToId: string | null;
  isActive: boolean;
  /** G3: a soft-deleted node is a vacant level — skipped exactly like an inactive one. */
  deletedAt?: Date | null;
}

/**
 * Returns the SalesUser id of the first ACTIVE manager up the submitter's
 * reporting chain — i.e. the routed approver for a KYC the submitter filed.
 * Skips inactive (vacant) managers, mirroring KycService.resolveInitialRouting
 * ("the next level approves; if that level is vacant, the level above it does").
 * Returns null when no active manager exists up the chain. Bounded + cycle-safe.
 *
 * G3: pass a node list that INCLUDES soft-deleted nodes (with `deletedAt`) so the walk continues past
 * a deleted manager instead of stopping at a dangling reference — exactly resolveInitialRouting's rule
 * (skip `!isActive || deletedAt != null`). Also used as the "next active manager" for DISPLAY.
 *
 * @param submitterSalesUserId  the SalesUser who filed the KYC
 * @param nodes                 tenant-scoped node list with isActive (+ deletedAt)
 */
export function firstActiveApproverId(
  submitterSalesUserId: string,
  nodes: SalesApproverNode[],
): string | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const start = byId.get(submitterSalesUserId);
  if (!start) return null;

  const MAX_HOPS = HIERARCHY_MAX_HOPS;
  const seen = new Set<string>();
  let currentId: string | null = start.reportingToId;
  let hops = 0;
  while (currentId && hops < MAX_HOPS) {
    if (seen.has(currentId)) break; // cycle guard
    seen.add(currentId);
    hops++;
    const node = byId.get(currentId);
    if (!node) break; // dangling reference
    if (node.isActive && node.deletedAt == null) return node.id;
    currentId = node.reportingToId;
  }
  return null;
}
