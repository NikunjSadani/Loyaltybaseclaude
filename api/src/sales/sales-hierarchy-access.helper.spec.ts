import {
  isSelfOrDescendant,
  descendantSalesUserIds,
  firstActiveApproverId,
  immediateReporteeForOutlet,
  effectiveDirectReportIds,
  promotedReportIds,
  promotedActiveReportIds,
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

  // G3 — a soft-deleted middle manager must not cut the team off from the managers above.
  describe('G3 — walks THROUGH soft-deleted managers', () => {
    // asm ─ so (DELETED) ─ isr1, isr2 ; asm ─ so2 ─ isr3
    const WITH_DELETED = [
      { id: 'asm', reportingToId: null, deletedAt: null },
      { id: 'so', reportingToId: 'asm', deletedAt: new Date('2026-01-01') },
      { id: 'isr1', reportingToId: 'so', deletedAt: null },
      { id: 'isr2', reportingToId: 'so', deletedAt: null },
      { id: 'so2', reportingToId: 'asm', deletedAt: null },
      { id: 'isr3', reportingToId: 'so2', deletedAt: null },
    ];

    it('an ASM above a deleted SO still reaches that SO\'s ISRs; the deleted SO itself is NOT a team member', () => {
      const sub = descendantSalesUserIds('asm', WITH_DELETED);
      expect([...sub].sort()).toEqual(['asm', 'isr1', 'isr2', 'isr3', 'so2']);
      expect(sub.has('so')).toBe(false);
    });

    it('a chain of TWO deleted managers is walked through', () => {
      const edges = [
        { id: 'rsm', reportingToId: null, deletedAt: null },
        { id: 'asm', reportingToId: 'rsm', deletedAt: new Date() },
        { id: 'so', reportingToId: 'asm', deletedAt: new Date() },
        { id: 'isr', reportingToId: 'so', deletedAt: null },
      ];
      expect([...descendantSalesUserIds('rsm', edges)].sort()).toEqual(['isr', 'rsm']);
    });

    it('a deleted leaf is simply excluded (no team member gained)', () => {
      const edges = [
        { id: 'so', reportingToId: null, deletedAt: null },
        { id: 'isr', reportingToId: 'so', deletedAt: new Date() },
      ];
      expect([...descendantSalesUserIds('so', edges)]).toEqual(['so']);
    });

    it('a cycle running through deleted nodes terminates', () => {
      const edges = [
        { id: 'a', reportingToId: 'c', deletedAt: null },
        { id: 'b', reportingToId: 'a', deletedAt: new Date() },
        { id: 'c', reportingToId: 'b', deletedAt: new Date() },
        { id: 'd', reportingToId: 'c', deletedAt: null },
      ];
      expect([...descendantSalesUserIds('a', edges)].sort()).toEqual(['a', 'd']);
    });

    it('edges without a deletedAt field behave exactly as before (back-compat)', () => {
      expect([...descendantSalesUserIds('so', EDGES)].sort()).toEqual(['so', 'xsr', 'xsr2']);
    });
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

describe('immediateReporteeForOutlet', () => {
  // Tree (see top of file): asm ─ so ─ {xsr, xsr2}; asm ─ so2 ─ xsr3; rsm ─ asm; nsm ─ rsm.

  it('returns the DIRECT report (one level up) when the outlet is assigned to a leaf rep', () => {
    // SO viewing an outlet assigned to their own XSR → the XSR IS the direct report.
    expect(immediateReporteeForOutlet('so', ['xsr'], EDGES)).toBe('xsr');
  });

  it('two levels up resolves to the DIRECT report, not the leaf rep', () => {
    // ASM viewing an outlet assigned to xsr (ASM → so → xsr): the ASM must be told to call SO.
    expect(immediateReporteeForOutlet('asm', ['xsr'], EDGES)).toBe('so');
  });

  it('three levels up resolves to the DIRECT report', () => {
    // RSM viewing the same outlet: RSM → asm → so → xsr ⇒ the RSM calls ASM.
    expect(immediateReporteeForOutlet('rsm', ['xsr'], EDGES)).toBe('asm');
  });

  it('resolves across the correct branch when siblings exist', () => {
    // ASM has two direct reports (so, so2). An outlet under so2's branch → so2.
    expect(immediateReporteeForOutlet('asm', ['xsr3'], EDGES)).toBe('so2');
  });

  it('returns null for a leaf viewer (an ISR with no reports)', () => {
    expect(immediateReporteeForOutlet('xsr', ['xsr'], EDGES)).toBeNull();
  });

  it('returns null when the outlet is assigned directly to the viewer (no reportee to call)', () => {
    expect(immediateReporteeForOutlet('so', ['so'], EDGES)).toBeNull();
  });

  it('returns null when no assigned rep sits under the viewer (out of chain)', () => {
    // so2's subtree is {so2, xsr3}; an outlet assigned to so's branch is out of so2's chain.
    expect(immediateReporteeForOutlet('so2', ['xsr'], EDGES)).toBeNull();
  });

  it('ignores an assigned rep that is not in the tenant edge list', () => {
    expect(immediateReporteeForOutlet('asm', ['ghost'], EDGES)).toBeNull();
  });

  it('returns null for no assignments', () => {
    expect(immediateReporteeForOutlet('asm', [], EDGES)).toBeNull();
  });

  it('is cycle-safe', () => {
    const cyclic = [
      { id: 'a', reportingToId: 'b' },
      { id: 'b', reportingToId: 'a' },
    ];
    // No node's parent is the viewer 'v' (not in the cycle) → null, and it does not hang.
    expect(immediateReporteeForOutlet('v', ['a'], cyclic)).toBeNull();
  });
});

// Sanity: the pre-existing isSelfOrDescendant still behaves (guards against regressions).
describe('isSelfOrDescendant (regression)', () => {
  it('grants a manager access to a descendant and denies a sibling branch', () => {
    expect(isSelfOrDescendant('xsr', 'so', EDGES)).toBe(true);
    expect(isSelfOrDescendant('xsr3', 'so', EDGES)).toBe(false);
  });
});

// ── G3 / R1 — every walker passes THROUGH a soft-deleted manager ─────────────────────────────────────
// asm ─ so (DELETED) ─ isr ; asm ─ so2 (live) ─ isr2 ; isr owns the outlet in the KYC scenarios.
const DEL = new Date('2026-11-01');
const BRANCH = [
  { id: 'rsm', reportingToId: null, isActive: true, deletedAt: null },
  { id: 'asm', reportingToId: 'rsm', isActive: true, deletedAt: null },
  { id: 'so', reportingToId: 'asm', isActive: true, deletedAt: DEL },
  { id: 'isr', reportingToId: 'so', isActive: true, deletedAt: null },
  { id: 'so2', reportingToId: 'asm', isActive: true, deletedAt: null },
  { id: 'isr2', reportingToId: 'so2', isActive: true, deletedAt: null },
];

describe('G3 — isSelfOrDescendant walks through deleted managers, never returns them', () => {
  it('an ASM above a deleted SO can view that SO\'s ISR', () => {
    expect(isSelfOrDescendant('isr', 'asm', BRANCH)).toBe(true);
  });
  it('the deleted SO itself is never a viewable member', () => {
    expect(isSelfOrDescendant('so', 'asm', BRANCH)).toBe(false);
  });
  it('O1: allowDeletedTarget — a REMOVED submitter is still under the managers above them (and only them)', () => {
    expect(isSelfOrDescendant('so', 'asm', BRANCH, { allowDeletedTarget: true })).toBe(true);
    expect(isSelfOrDescendant('so', 'so2', BRANCH, { allowDeletedTarget: true })).toBe(false);
  });
  it('O1: descendantSalesUserIds includeDeleted returns the deleted nodes reached (submitter scope only)', () => {
    expect([...descendantSalesUserIds('asm', BRANCH, { includeDeleted: true })].sort()).toEqual(['asm', 'isr', 'isr2', 'so', 'so2']);
    expect([...descendantSalesUserIds('asm', BRANCH)].sort()).toEqual(['asm', 'isr', 'isr2', 'so2']);
  });
  it('a sibling branch is still refused', () => {
    expect(isSelfOrDescendant('isr', 'so2', BRANCH)).toBe(false);
  });
  it('a cycle through a deleted node terminates (false)', () => {
    const cyclic = [
      { id: 'x', reportingToId: 'y', deletedAt: null },
      { id: 'y', reportingToId: 'x', deletedAt: DEL },
    ];
    expect(isSelfOrDescendant('x', 'v', cyclic)).toBe(false);
  });
});

describe('R1 — firstActiveApproverId skips a soft-deleted manager (resolveInitialRouting\'s rule)', () => {
  it('ISR under a deleted SO → the ASM is the routed approver', () => {
    expect(firstActiveApproverId('isr', BRANCH)).toBe('asm');
  });
  it('a deleted node is skipped even when flagged isActive (deletedAt wins)', () => {
    const nodes = [
      { id: 'a', reportingToId: null, isActive: true, deletedAt: DEL },
      { id: 'i', reportingToId: 'a', isActive: true, deletedAt: null },
    ];
    expect(firstActiveApproverId('i', nodes)).toBeNull();
  });
  it('a cycle of deleted managers terminates', () => {
    const nodes = [
      { id: 'i', reportingToId: 'a', isActive: true, deletedAt: null },
      { id: 'a', reportingToId: 'b', isActive: true, deletedAt: DEL },
      { id: 'b', reportingToId: 'a', isActive: true, deletedAt: DEL },
    ];
    expect(firstActiveApproverId('i', nodes)).toBeNull();
  });
});

describe('G3 — immediateReporteeForOutlet never names a deleted person', () => {
  it('viewer ASM, deleted SO, assigned ISR → the ISR (the ASM\'s effective direct report)', () => {
    expect(immediateReporteeForOutlet('asm', ['isr'], BRANCH)).toBe('isr');
  });
  it('viewer RSM → the ASM (live direct report), unchanged', () => {
    expect(immediateReporteeForOutlet('rsm', ['isr'], BRANCH)).toBe('asm');
  });
  it('the deleted SO in the middle with a live node below it → that live node', () => {
    const edges = [
      { id: 'asm', reportingToId: null, deletedAt: null },
      { id: 'so', reportingToId: 'asm', deletedAt: DEL },
      { id: 'tl', reportingToId: 'so', deletedAt: null },
      { id: 'isr', reportingToId: 'tl', deletedAt: null },
    ];
    expect(immediateReporteeForOutlet('asm', ['isr'], edges)).toBe('tl');
  });
});

describe('G3 — effectiveDirectReportIds / promotedReportIds (the team list rule)', () => {
  it('a deleted direct report is replaced by its live reports; never listed itself', () => {
    expect(effectiveDirectReportIds('asm', BRANCH)).toEqual(['so2', 'isr']);
    expect(promotedReportIds('asm', BRANCH)).toEqual(['isr']);
  });
  it('F2: an INACTIVE (not deleted) direct report stays a normal member — its team is NOT promoted', () => {
    const edges = [
      { id: 'asm', reportingToId: null, isActive: true, deletedAt: null },
      { id: 'so', reportingToId: 'asm', isActive: false, deletedAt: null },
      { id: 'isr', reportingToId: 'so', isActive: true, deletedAt: null },
    ];
    expect(effectiveDirectReportIds('asm', edges)).toEqual(['so']);
    expect(promotedReportIds('asm', edges)).toEqual([]);
  });

  it('F2: an inactive person BELOW a deleted slot counts toward the team (teamSize) but is not an active member row', () => {
    const edges = [
      { id: 'asm', reportingToId: null, isActive: true, deletedAt: null },
      { id: 'so', reportingToId: 'asm', isActive: false, deletedAt: DEL },
      { id: 'isrA', reportingToId: 'so', isActive: true, deletedAt: null },
      { id: 'isrI', reportingToId: 'so', isActive: false, deletedAt: null },
    ];
    expect(promotedReportIds('asm', edges)).toEqual(['isrA', 'isrI']);
    expect(promotedActiveReportIds('asm', edges)).toEqual(['isrA']);
  });

  it('F7: a corrupt manager → deleted D → ANCESTOR cycle never promotes the ancestor (or the manager)', () => {
    // boss ← m (m reports to boss) ; m ← d (deleted) ; d ← boss  → cycle boss→d→m→boss in parent pointers.
    const edges = [
      { id: 'boss', reportingToId: 'd', deletedAt: null },
      { id: 'm', reportingToId: 'boss', deletedAt: null },
      { id: 'd', reportingToId: 'm', deletedAt: DEL },
      { id: 'isr', reportingToId: 'd', deletedAt: null },
    ];
    // Before F7 the walk went m → d (deleted) → boss and PROMOTED the boss into m's team. Now d (which is
    // also m's ancestor in this corrupt cycle) is never walked into: neither boss nor m is ever returned.
    const out = effectiveDirectReportIds('m', edges);
    expect(out).not.toContain('boss');
    expect(out).not.toContain('m');
    expect(out).toEqual([]);
    // A NON-cyclic deleted slot under m is still walked through normally.
    const ok = [...edges.filter((e) => e.id !== 'boss'), { id: 'boss', reportingToId: null, deletedAt: null }];
    expect(effectiveDirectReportIds('m', ok)).toEqual(['isr']);
  });
  it('two stacked deleted levels are walked through', () => {
    const edges = [
      { id: 'rsm', reportingToId: null, deletedAt: null },
      { id: 'asm', reportingToId: 'rsm', deletedAt: DEL },
      { id: 'so', reportingToId: 'asm', deletedAt: DEL },
      { id: 'isr', reportingToId: 'so', deletedAt: null },
    ];
    expect(effectiveDirectReportIds('rsm', edges)).toEqual(['isr']);
  });
  it('no vacant slot → no promotions (legacy edges without the optional fields behave as before)', () => {
    expect(promotedReportIds('asm', EDGES)).toEqual([]);
    expect(effectiveDirectReportIds('asm', EDGES)).toEqual(['so', 'so2']);
  });
  it('a cycle through deleted nodes terminates', () => {
    const edges = [
      { id: 'm', reportingToId: 'b', deletedAt: null },
      { id: 'a', reportingToId: 'm', deletedAt: DEL },
      { id: 'b', reportingToId: 'a', deletedAt: DEL },
      { id: 'c', reportingToId: 'b', deletedAt: null },
    ];
    // a and b are m's ANCESTORS as well as descendants (corrupt cycle) → F7 never walks into an ancestor,
    // so nothing hanging off the cycle is promoted; the walk terminates.
    expect(effectiveDirectReportIds('m', edges)).toEqual([]);
  });
});
