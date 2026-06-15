/**
 * Pure helpers for the product Catalog category hierarchy.
 *
 * Categories form a self-referential tree (parentId). These functions contain
 * the decision logic the API route and UI need, with no DB/browser dependency,
 * so they can be unit-tested directly (see how-we-test.md, option A).
 */

export interface CategoryNodeInput {
  id: string;
  parentId: string | null;
}

export type CategoryTreeNode<T extends CategoryNodeInput> = T & {
  children: CategoryTreeNode<T>[];
  depth: number;
};

/**
 * Build a parent/child tree from a flat list of categories.
 *
 * - Roots are nodes whose parentId is null OR whose parent is not present in the
 *   list (orphans are surfaced as roots so they never disappear from the UI).
 * - Each node gets a `depth` (roots = 0) so the UI can indent.
 * - Sibling order follows the input order (callers sort upstream, e.g. by
 *   sortOrder then name).
 */
export function buildCategoryTree<T extends CategoryNodeInput>(
  flat: T[],
): CategoryTreeNode<T>[] {
  const byId = new Map<string, CategoryTreeNode<T>>();
  for (const c of flat) {
    byId.set(c.id, { ...(c as T), children: [], depth: 0 });
  }

  const roots: CategoryTreeNode<T>[] = [];
  for (const c of flat) {
    const node = byId.get(c.id)!;
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Assign depth via DFS from each root.
  const setDepth = (node: CategoryTreeNode<T>, depth: number) => {
    node.depth = depth;
    for (const child of node.children) setDepth(child, depth + 1);
  };
  for (const r of roots) setDepth(r, 0);

  return roots;
}

/**
 * Flatten a category tree back into a depth-ordered list (pre-order DFS).
 * Useful for rendering an indented table where children appear under parents.
 */
export function flattenCategoryTree<T extends CategoryNodeInput>(
  roots: CategoryTreeNode<T>[],
): CategoryTreeNode<T>[] {
  const out: CategoryTreeNode<T>[] = [];
  const walk = (node: CategoryTreeNode<T>) => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const r of roots) walk(r);
  return out;
}

/**
 * Returns true if `candidateParentId` is the node itself or any of its
 * descendants — i.e. re-parenting `nodeId` under it would create a cycle.
 *
 * Used to reject an illegal reparent (a category cannot become its own
 * ancestor). `edges` maps childId → parentId for the whole tenant tree.
 */
export function wouldCreateCycle(
  nodeId: string,
  candidateParentId: string,
  edges: Map<string, string | null>,
): boolean {
  if (nodeId === candidateParentId) return true;
  // Walk up from the candidate parent; if we reach nodeId, it's a descendant.
  let current: string | null | undefined = candidateParentId;
  const seen = new Set<string>();
  while (current) {
    if (current === nodeId) return true;
    if (seen.has(current)) break; // guard against pre-existing corruption
    seen.add(current);
    current = edges.get(current) ?? null;
  }
  return false;
}
