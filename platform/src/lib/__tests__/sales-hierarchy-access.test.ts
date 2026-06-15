import { describe, it, expect } from 'vitest';
import { isSelfOrDescendant, type SalesUserEdge } from '../sales-hierarchy-access';

// Reporting tree (parent = reportingToId):
//   root
//   ├── a
//   │   ├── a1
//   │   │   └── a1x
//   │   └── a2
//   └── b
//       └── b1
// plus an unrelated tenant member `lone` with no reportingTo.
const edges: SalesUserEdge[] = [
  { id: 'root', reportingToId: null },
  { id: 'a', reportingToId: 'root' },
  { id: 'a1', reportingToId: 'a' },
  { id: 'a1x', reportingToId: 'a1' },
  { id: 'a2', reportingToId: 'a' },
  { id: 'b', reportingToId: 'root' },
  { id: 'b1', reportingToId: 'b' },
  { id: 'lone', reportingToId: null },
];

describe('isSelfOrDescendant', () => {
  it('returns true for self', () => {
    expect(isSelfOrDescendant('a', 'a', edges)).toBe(true);
  });

  it('returns true for a direct child', () => {
    expect(isSelfOrDescendant('a1', 'a', edges)).toBe(true);
  });

  it('returns true for a deep descendant', () => {
    expect(isSelfOrDescendant('a1x', 'a', edges)).toBe(true);
  });

  it('returns true for a descendant from the root', () => {
    expect(isSelfOrDescendant('b1', 'root', edges)).toBe(true);
  });

  it('returns false for an unrelated member', () => {
    expect(isSelfOrDescendant('lone', 'a', edges)).toBe(false);
  });

  it('returns false for a member in a different parent subtree (cross-parent)', () => {
    expect(isSelfOrDescendant('b1', 'a', edges)).toBe(false);
  });

  it('returns false for an ancestor (cannot view upward)', () => {
    expect(isSelfOrDescendant('root', 'a', edges)).toBe(false);
  });

  it('returns false when the target node is missing from the edge list', () => {
    expect(isSelfOrDescendant('ghost', 'a', edges)).toBe(false);
  });

  it('returns false for empty target or caller ids', () => {
    expect(isSelfOrDescendant('', 'a', edges)).toBe(false);
    expect(isSelfOrDescendant('a', '', edges)).toBe(false);
  });

  it('does not loop forever on a cyclic chain', () => {
    const cyclic: SalesUserEdge[] = [
      { id: 'x', reportingToId: 'y' },
      { id: 'y', reportingToId: 'x' },
    ];
    expect(isSelfOrDescendant('x', 'z', cyclic)).toBe(false);
  });
});
