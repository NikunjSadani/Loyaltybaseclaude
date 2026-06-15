import { describe, it, expect } from 'vitest';
import {
  buildCategoryTree,
  flattenCategoryTree,
  wouldCreateCycle,
} from '../category-tree';

type Cat = { id: string; parentId: string | null; name: string };

describe('buildCategoryTree', () => {
  it('returns an empty array for empty input', () => {
    expect(buildCategoryTree<Cat>([])).toEqual([]);
  });

  it('treats parentId=null nodes as roots at depth 0', () => {
    const tree = buildCategoryTree<Cat>([
      { id: 'a', parentId: null, name: 'A' },
      { id: 'b', parentId: null, name: 'B' },
    ]);
    expect(tree.map((n) => n.id)).toEqual(['a', 'b']);
    expect(tree.every((n) => n.depth === 0)).toBe(true);
  });

  it('nests children under their parent with incremented depth', () => {
    const tree = buildCategoryTree<Cat>([
      { id: 'root', parentId: null, name: 'Root' },
      { id: 'child', parentId: 'root', name: 'Child' },
      { id: 'grand', parentId: 'child', name: 'Grand' },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].id).toBe('child');
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it('preserves input order among siblings', () => {
    const tree = buildCategoryTree<Cat>([
      { id: 'p', parentId: null, name: 'P' },
      { id: 'c2', parentId: 'p', name: 'C2' },
      { id: 'c1', parentId: 'p', name: 'C1' },
    ]);
    expect(tree[0].children.map((c) => c.id)).toEqual(['c2', 'c1']);
  });

  it('surfaces an orphan (parent not in list) as a root rather than dropping it', () => {
    const tree = buildCategoryTree<Cat>([
      { id: 'orphan', parentId: 'missing', name: 'Orphan' },
    ]);
    expect(tree.map((n) => n.id)).toEqual(['orphan']);
    expect(tree[0].depth).toBe(0);
  });
});

describe('flattenCategoryTree', () => {
  it('returns nodes in pre-order (parent before its children)', () => {
    const tree = buildCategoryTree<Cat>([
      { id: 'root', parentId: null, name: 'Root' },
      { id: 'child', parentId: 'root', name: 'Child' },
      { id: 'grand', parentId: 'child', name: 'Grand' },
      { id: 'root2', parentId: null, name: 'Root2' },
    ]);
    expect(flattenCategoryTree(tree).map((n) => n.id)).toEqual([
      'root',
      'child',
      'grand',
      'root2',
    ]);
  });
});

describe('wouldCreateCycle', () => {
  // edges: child -> parent
  const edges = new Map<string, string | null>([
    ['root', null],
    ['child', 'root'],
    ['grand', 'child'],
  ]);

  it('rejects making a node its own parent', () => {
    expect(wouldCreateCycle('child', 'child', edges)).toBe(true);
  });

  it('rejects re-parenting a node under its own descendant', () => {
    // moving 'root' under 'grand' (grand is a descendant of root) → cycle
    expect(wouldCreateCycle('root', 'grand', edges)).toBe(true);
  });

  it('allows re-parenting under an unrelated node', () => {
    const e = new Map<string, string | null>([
      ['root', null],
      ['child', 'root'],
      ['other', null],
    ]);
    expect(wouldCreateCycle('child', 'other', e)).toBe(false);
  });

  it('allows moving a node to a root (no parent chain to climb)', () => {
    expect(wouldCreateCycle('grand', 'root', edges)).toBe(false);
  });
});
