import {
  isSelfOrDescendant,
  descendantSalesUserIds,
  firstActiveApproverId,
} from './sales-hierarchy-access.helper';

/**
 * Tree used across these tests (reportingToId points UP at the parent):
 *
 *   nsm ─ rsm ─ asm ─ so ─ xsr
 *                      └── xsr2
 *               └── so2 ─ xsr3
 */
const EDGES = [
  { id: 'nsm', reportingToId: null },
  { id: 'rsm', reportingToId: 'nsm' },
  { id: 'asm', reportingToId: 'rsm' },
  { id: 'so', reportingToId: 'asm' },
  { id: 'so2', reportingToId: 'asm' },
  { id: 'xsr', reportingToId: 'so' },
  { id: 'xsr2', reportingToId: 'so' },
  { id: 'xsr3', reportingToId: 'so2' },
];

describe('descendantSalesUserIds', () => {
  it('returns self + the whole subtree for a mid-level manager', () => {
    const sub = descendantSalesUserIds('so', EDGES);
    expect([...sub].sort()).toEqual(['so', 'xsr', 'xsr2'].sort());
  });

  it('returns the entire tree for the root', () => {
    const sub = descendantSalesUserIds('asm', EDGES);
    expect([...sub].sort()).toEqual(['asm', 'so', 'so2', 'xsr', 'xsr2', 'xsr3'].sort());
  });

  it('returns just self for a leaf', () => {
    expect([...descendantSalesUserIds('xsr', EDGES)]).toEqual(['xsr']);
  });

  it('excludes siblings and other branches (no cross-team leak)', () => {
    const sub = descendantSalesUserIds('so', EDGES);
    expect(sub.has('so2')).toBe(false);
    expect(sub.has('xsr3')).toBe(false);
  });

  it('is cycle-safe', () => {
    const cyclic = [
      { id: 'a', reportingToId: 'b' },
      { id: 'b', reportingToId: 'a' },
    ];
    expect([...descendantSalesUserIds('a', cyclic)].sort()).toEqual(['a', 'b']);
  });
});

describe('firstActiveApproverId', () => {
  const nodes = (overrides: Record<string, boolean> = {}) =>
    EDGES.map((e) => ({ ...e, isActive: overrides[e.id] ?? true }));

  it('routes an XSR submission to their direct SO (first level up)', () => {
    expect(firstActiveApproverId('xsr', nodes())).toBe('so');
  });

  it('routes an SO submission to their ASM (next level up — "whoever does KYC, the next level approves")', () => {
    expect(firstActiveApproverId('so', nodes())).toBe('asm');
  });

  it('skips a VACANT (inactive) manager and routes to the next level up', () => {
    // SO is vacant → an XSR under it escalates to the ASM.
    expect(firstActiveApproverId('xsr', nodes({ so: false }))).toBe('asm');
  });

  it('skips multiple consecutive vacant managers', () => {
    expect(firstActiveApproverId('xsr', nodes({ so: false, asm: false }))).toBe('rsm');
  });

  it('returns null when no active manager exists up the chain', () => {
    expect(firstActiveApproverId('xsr', nodes({ so: false, asm: false, rsm: false, nsm: false }))).toBeNull();
  });

  it('returns null for the root (no manager)', () => {
    expect(firstActiveApproverId('nsm', nodes())).toBeNull();
  });

  it('returns null for an unknown submitter', () => {
    expect(firstActiveApproverId('ghost', nodes())).toBeNull();
  });
});

// Sanity: the pre-existing isSelfOrDescendant still behaves (guards against regressions).
describe('isSelfOrDescendant (regression)', () => {
  it('grants a manager access to a descendant and denies a sibling branch', () => {
    expect(isSelfOrDescendant('xsr', 'so', EDGES)).toBe(true);
    expect(isSelfOrDescendant('xsr3', 'so', EDGES)).toBe(false);
  });
});
