/**
 * points-engine.helper.spec.ts — exhaustive unit tests for the PURE Points Compute Engine evaluator.
 *
 * Covers the four worked archetypes A–D from POINTS-COMPUTE-ENGINE-DESIGN.md §10 with EXACT expected
 * numbers, plus slab boundary inclusivity, marginal vs whole, pct_of_target, target=0 reject (no
 * divide-by-zero), the three null policies, floor-then-cap order, every rounding mode, the formula
 * whitelist rejections, the formula divide-by-zero guard, and trace-step chain correctness.
 */

import { evaluateRule, validateRule } from './points-engine.helper';
import {
  PointsRuleConfig,
  PipelineNode,
  RuleInput,
  EvalContext,
  EvalOutcome,
  RoundingSpec,
} from './points-engine.types';

// ── Builders ──────────────────────────────────────────────────────────────────

function rule(partial: {
  inputs?: RuleInput[];
  pipeline: PipelineNode[];
  rounding?: RoundingSpec;
}): PointsRuleConfig {
  return {
    ruleId: 'rule_test',
    tenantId: 'deoleo',
    version: 1,
    status: 'published',
    effectiveFrom: '2026-01-01',
    attachsTo: { scope: 'program_kpi', kpiCode: 'CASES_SOLD' },
    evaluationBasis: 'PERIOD_AGGREGATE',
    output: { awardType: 'POINTS', fieldId: 'cf_test' },
    rounding: partial.rounding ?? { mode: 'half_up', scale: 0 },
    inputs: partial.inputs ?? [],
    pipeline: partial.pipeline,
  };
}

function ctx(partial: Partial<EvalContext>): EvalContext {
  return {
    achievements: partial.achievements ?? {},
    targets: partial.targets ?? {},
    segment: partial.segment ?? {},
    meta: partial.meta,
  };
}

/** Narrowing helpers for the outcome union. */
function expectOk(o: EvalOutcome): Extract<EvalOutcome, { status: 'OK' }> {
  expect(o.status).toBe('OK');
  return o as Extract<EvalOutcome, { status: 'OK' }>;
}
function expectSkip(o: EvalOutcome): Extract<EvalOutcome, { status: 'SKIP' }> {
  expect(o.status).toBe('SKIP');
  return o as Extract<EvalOutcome, { status: 'SKIP' }>;
}

// ════════════════════════════════════════════════════════════════════════════
// §10 Archetype A — Flat per-case (L1)
// ════════════════════════════════════════════════════════════════════════════

describe('Archetype A — flat per-case (L1 rate)', () => {
  const r = rule({
    inputs: [{ ref: 'cases', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' }],
    pipeline: [{ type: 'rate', id: 'r1', measure: { var: 'cases' }, rate: 2 }],
  });

  it('137 cases × 2 = 274', () => {
    const o = expectOk(evaluateRule(r, ctx({ achievements: { CASES_SOLD: 137 } })));
    expect(o.points).toBe(274);
    expect(o.trace).toHaveLength(1);
    expect(o.trace[0]).toMatchObject({ nodeId: 'r1', type: 'rate', pointsBefore: 0, delta: 274, pointsAfter: 274 });
  });

  it('0 cases → 0', () => {
    expect(expectOk(evaluateRule(r, ctx({ achievements: { CASES_SOLD: 0 } }))).points).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §10 Archetype B — %-of-target slab, the marginal-vs-whole swing (the single best `apply` test)
// ════════════════════════════════════════════════════════════════════════════

describe('Archetype B — %-of-target slab, marginal vs whole (600 cases, target 500)', () => {
  // Bands on pct-of-target: [0,80%)→2, [80,100%)→3, [100%,∞)→4 pts per CASE.
  // Scaled to a 500 target → [0,400)→2, [400,500)→3, [500,∞)→4 on raw cases.
  const bands = [
    { from: 0, to: 80, rate: 2 },
    { from: 80, to: 100, rate: 3 },
    { from: 100, to: null, rate: 4 },
  ];
  const inputs: RuleInput[] = [
    { ref: 'cases', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' },
    { ref: 'target', source: 'target:CASES_SOLD', type: 'number', nullAs: 'reject' },
  ];
  const slab = (apply: 'marginal' | 'whole'): PipelineNode => ({
    type: 'slab',
    id: 's1',
    basis: 'pct_of_target',
    measure: { var: 'cases' },
    target: { var: 'target' },
    apply,
    bands,
  });
  const c600 = ctx({ achievements: { CASES_SOLD: 600 }, targets: { CASES_SOLD: 500 } });

  it('MARGINAL: 400×2 + 100×3 + 100×4 = 1,500', () => {
    expect(expectOk(evaluateRule(rule({ inputs, pipeline: [slab('marginal')] }), c600)).points).toBe(1500);
  });

  it('WHOLE (cliff): 600 lands the ≥100% band @4 → 600×4 = 2,400', () => {
    expect(expectOk(evaluateRule(rule({ inputs, pipeline: [slab('whole')] }), c600)).points).toBe(2400);
  });

  it('the marginal↔whole swing is 900 points on identical bands + input', () => {
    const m = expectOk(evaluateRule(rule({ inputs, pipeline: [slab('marginal')] }), c600)).points;
    const w = expectOk(evaluateRule(rule({ inputs, pipeline: [slab('whole')] }), c600)).points;
    expect(w - m).toBe(900);
  });

  it('boundary inclusivity at EXACTLY 100% (500 cases): lands the [100,∞) band, not [80,100)', () => {
    const c500 = ctx({ achievements: { CASES_SOLD: 500 }, targets: { CASES_SOLD: 500 } });
    // marginal: 400×2 + 100×3 + 0 = 1,100 ; whole: 500×4 = 2,000
    expect(expectOk(evaluateRule(rule({ inputs, pipeline: [slab('marginal')] }), c500)).points).toBe(1100);
    expect(expectOk(evaluateRule(rule({ inputs, pipeline: [slab('whole')] }), c500)).points).toBe(2000);
  });

  it('target = 0 → SKIP with reason (NEVER divides by zero / NaN / Infinity)', () => {
    const c0 = ctx({ achievements: { CASES_SOLD: 600 }, targets: { CASES_SOLD: 0 } });
    const o = expectSkip(evaluateRule(rule({ inputs, pipeline: [slab('marginal')] }), c0));
    expect(o.reason).toMatch(/target is 0/);
  });

  it('target null + nullAs zero → becomes 0 → SKIP (guarded, no divide-by-zero)', () => {
    const inputsZeroTarget: RuleInput[] = [
      { ref: 'cases', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' },
      { ref: 'target', source: 'target:CASES_SOLD', type: 'number', nullAs: 'zero' },
    ];
    const cNull = ctx({ achievements: { CASES_SOLD: 600 }, targets: { CASES_SOLD: null } });
    expectSkip(evaluateRule(rule({ inputs: inputsZeroTarget, pipeline: [slab('marginal')] }), cNull));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §10 Archetype C — gated milestone + cap + floor (L3), order gate→accrual→milestone→floor→cap
// ════════════════════════════════════════════════════════════════════════════

describe('Archetype C — gated milestone + cap (L3)', () => {
  // Litres target 4,000; gate at 80% (=3,200 litres); 1 pt/L once gated; +1,000 at ≥100%; floor 500; cap 5,000.
  const inputs: RuleInput[] = [
    { ref: 'litres', kpiCode: 'LITRES', type: 'number', nullAs: 'reject' },
    { ref: 'target', source: 'target:LITRES', type: 'number', nullAs: 'reject' },
  ];
  const pipeline: PipelineNode[] = [
    { type: 'gate', id: 'g1', when: { op: 'gte', left: { var: 'litres' }, right: { lit: 3200 } }, onFail: 'zero' },
    { type: 'rate', id: 'r1', measure: { var: 'litres' }, rate: 1 },
    { type: 'milestone', id: 'm1', when: { op: 'gte', left: { var: 'litres' }, right: { var: 'target' } }, flat: 1000 },
    { type: 'floor', id: 'f1', min: 500 },
    { type: 'cap', id: 'c1', max: 5000 },
  ];
  const r = rule({ inputs, pipeline });
  const at = (litres: number) => ctx({ achievements: { LITRES: litres }, targets: { LITRES: 4000 } });

  it('3,000 L (75%) fails the gate → 0 (floor 500 does NOT revive it)', () => {
    const o = expectOk(evaluateRule(r, at(3000)));
    expect(o.points).toBe(0);
    // gate short-circuits before floor/cap — only the gate step is traced.
    expect(o.trace[o.trace.length - 1]).toMatchObject({ nodeId: 'g1', pointsAfter: 0 });
    expect(o.trace.some((s) => s.nodeId === 'f1')).toBe(false);
  });

  it('3,400 L (85%): gated in, 3,400 pts, no milestone, under cap → 3,400', () => {
    expect(expectOk(evaluateRule(r, at(3400))).points).toBe(3400);
  });

  it('4,800 L (120%): 4,800 + 1,000 milestone = 5,800 → capped at 5,000', () => {
    expect(expectOk(evaluateRule(r, at(4800))).points).toBe(5000);
  });

  it('trace-step chain is internally consistent and explains the final number (4,800 case)', () => {
    const o = expectOk(evaluateRule(r, at(4800)));
    // Each step chains: pointsBefore == previous pointsAfter, and pointsAfter == pointsBefore + delta.
    let prevAfter = 0;
    for (const s of o.trace) {
      expect(s.pointsBefore).toBe(prevAfter);
      expect(s.pointsAfter).toBe(s.pointsBefore + s.delta);
      prevAfter = s.pointsAfter;
    }
    expect(o.points).toBe(prevAfter); // final rounding is a no-op on whole points
    expect(o.trace.map((s) => s.nodeId)).toEqual(['g1', 'r1', 'm1', 'f1', 'c1']);
    expect(o.trace[4].type).toBe('cap');
    expect(o.trace[4].detail).toContain('cap 5000');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §10 Archetype D — two-KPI bundled bonus + compliance multiplier (L4 formula)
// ════════════════════════════════════════════════════════════════════════════

describe('Archetype D — two-KPI gate + multiplier (L4 formula)', () => {
  const inputs: RuleInput[] = [
    { ref: 'cases', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' },
    { ref: 'newOutlets', kpiCode: 'NEW_OUTLETS', type: 'number', nullAs: 'zero' },
    { ref: 'visibility', kpiCode: 'VISIBILITY', type: 'number', nullAs: 'zero' },
  ];
  const r = rule({
    inputs,
    pipeline: [
      {
        type: 'formula',
        id: 'f1',
        output: 'set',
        expr: 'if(newOutlets >= 3 && visibility >= 90, cases * (visibility / 100) + 2000, cases)',
      },
    ],
  });
  const at = (cases: number, newOutlets: number, visibility: number) =>
    ctx({ achievements: { CASES_SOLD: cases, NEW_OUTLETS: newOutlets, VISIBILITY: visibility } });

  it('(400 cases, 4 new, 95% vis) qualifies → 400×0.95 + 2000 = 2,380', () => {
    expect(expectOk(evaluateRule(r, at(400, 4, 95))).points).toBe(2380);
  });

  it('(400, 2, 95) fails new-outlet gate → base 400', () => {
    expect(expectOk(evaluateRule(r, at(400, 2, 95))).points).toBe(400);
  });

  it('(400, 4, 88) fails visibility gate → base 400', () => {
    expect(expectOk(evaluateRule(r, at(400, 4, 88))).points).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Slab — absolute basis, marginal vs whole, exact-boundary inclusivity
// ════════════════════════════════════════════════════════════════════════════

describe('Slab — absolute basis', () => {
  const bands = [
    { from: 0, to: 100, rate: 1 },
    { from: 100, to: null, rate: 2 },
  ];
  const inputs: RuleInput[] = [{ ref: 'u', kpiCode: 'U', type: 'number', nullAs: 'reject' }];
  const slab = (apply: 'marginal' | 'whole'): PipelineNode => ({
    type: 'slab',
    id: 's1',
    basis: 'absolute',
    measure: { var: 'u' },
    apply,
    bands,
  });

  it('150 marginal: 100×1 + 50×2 = 200', () => {
    expect(expectOk(evaluateRule(rule({ inputs, pipeline: [slab('marginal')] }), ctx({ achievements: { U: 150 } }))).points).toBe(200);
  });
  it('150 whole (cliff): 150×2 = 300', () => {
    expect(expectOk(evaluateRule(rule({ inputs, pipeline: [slab('whole')] }), ctx({ achievements: { U: 150 } }))).points).toBe(300);
  });
  it('exactly 100 lands the [100,∞) band (from-inclusive, to-exclusive): marginal 100, whole 200', () => {
    expect(expectOk(evaluateRule(rule({ inputs, pipeline: [slab('marginal')] }), ctx({ achievements: { U: 100 } }))).points).toBe(100);
    expect(expectOk(evaluateRule(rule({ inputs, pipeline: [slab('whole')] }), ctx({ achievements: { U: 100 } }))).points).toBe(200);
  });

  it('per-band flat is added once the band is entered (marginal)', () => {
    const withFlat: PipelineNode = {
      type: 'slab',
      id: 's1',
      basis: 'absolute',
      measure: { var: 'u' },
      apply: 'marginal',
      bands: [
        { from: 0, to: 100, rate: 1, flat: 50 },
        { from: 100, to: null, rate: 2, flat: 500 },
      ],
    };
    // 150: band0 100×1+50 = 150 ; band1 50×2+500 = 600 ; total 750
    expect(expectOk(evaluateRule(rule({ inputs, pipeline: [withFlat] }), ctx({ achievements: { U: 150 } }))).points).toBe(750);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Null policies — reject / zero / skipRule (distinguished)
// ════════════════════════════════════════════════════════════════════════════

describe('Null policies', () => {
  // p is always present (50); x is ABSENT and carries the policy under test.
  const build = (xPolicy: RuleInput['nullAs']) =>
    rule({
      inputs: [
        { ref: 'p', kpiCode: 'P', type: 'number', nullAs: 'reject' },
        { ref: 'x', kpiCode: 'X', type: 'number', nullAs: xPolicy },
      ],
      pipeline: [
        { type: 'rate', id: 'rp', measure: { var: 'p' }, rate: 1 },
        { type: 'rate', id: 'rx', measure: { var: 'x' }, rate: 1 },
      ],
    });
  const cMissingX = ctx({ achievements: { P: 50 } }); // X omitted entirely

  it("'zero': absent X becomes 0 → 50 (from p) + 0 (from x) = 50", () => {
    expect(expectOk(evaluateRule(build('zero'), cMissingX)).points).toBe(50);
  });

  it("'skipRule': the whole rule contributes 0 (OK, not an error)", () => {
    const o = expectOk(evaluateRule(build('skipRule'), cMissingX));
    expect(o.points).toBe(0);
  });

  it("'reject': the row is SKIPPED-with-reason", () => {
    const o = expectSkip(evaluateRule(build('reject'), cMissingX));
    expect(o.reason).toMatch(/x/);
  });

  it('a blank cell is an OMITTED key, not 0 — null is treated identically to a missing key', () => {
    const cNull = ctx({ achievements: { P: 50, X: null } });
    expectSkip(evaluateRule(build('reject'), cNull));
  });

  it('reject DOMINATES skipRule when both are absent (safe-for-money precedence)', () => {
    const r = rule({
      inputs: [
        { ref: 'a', kpiCode: 'A', type: 'number', nullAs: 'skipRule' },
        { ref: 'b', kpiCode: 'B', type: 'number', nullAs: 'reject' },
      ],
      pipeline: [{ type: 'rate', id: 'r1', measure: { var: 'a' }, rate: 1 }],
    });
    expectSkip(evaluateRule(r, ctx({ achievements: {} })));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Floor-then-cap ordering (always floor first, then cap)
// ════════════════════════════════════════════════════════════════════════════

describe('Floor then cap ordering', () => {
  it('floor 1000 then cap 800 on 500 pts → 800 (floor-first; cap-first would give 1000)', () => {
    const r = rule({
      pipeline: [
        { type: 'rate', id: 'r1', measure: { lit: 500 }, rate: 1 },
        { type: 'floor', id: 'f1', min: 1000 },
        { type: 'cap', id: 'c1', max: 800 },
      ],
    });
    const o = expectOk(evaluateRule(r, ctx({})));
    expect(o.points).toBe(800);
    // floor raised 500→1000, then cap pulled 1000→800.
    expect(o.trace.find((s) => s.nodeId === 'f1')!.pointsAfter).toBe(1000);
    expect(o.trace.find((s) => s.nodeId === 'c1')!.pointsAfter).toBe(800);
  });

  it('floor applies even when a cap node is listed BEFORE it in the pipeline (order is structural)', () => {
    const r = rule({
      pipeline: [
        { type: 'rate', id: 'r1', measure: { lit: 300 }, rate: 1 },
        { type: 'cap', id: 'c1', max: 5000 }, // listed first, still applied AFTER floor
        { type: 'floor', id: 'f1', min: 500 },
      ],
    });
    expect(expectOk(evaluateRule(r, ctx({}))).points).toBe(500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Rounding modes (single, final)
// ════════════════════════════════════════════════════════════════════════════

describe('Rounding modes', () => {
  const at = (measure: number, rate: number, rounding: RoundingSpec) =>
    expectOk(
      evaluateRule(rule({ pipeline: [{ type: 'rate', id: 'r1', measure: { lit: measure }, rate }], rounding }), ctx({})),
    ).points;

  it('2.5 → half_up 3, half_even 2, floor 2, ceil 3', () => {
    expect(at(5, 0.5, { mode: 'half_up', scale: 0 })).toBe(3);
    expect(at(5, 0.5, { mode: 'half_even', scale: 0 })).toBe(2);
    expect(at(5, 0.5, { mode: 'floor', scale: 0 })).toBe(2);
    expect(at(5, 0.5, { mode: 'ceil', scale: 0 })).toBe(3);
  });

  it('3.5 → half_up 4, half_even 4, floor 3, ceil 4', () => {
    expect(at(7, 0.5, { mode: 'half_up', scale: 0 })).toBe(4);
    expect(at(7, 0.5, { mode: 'half_even', scale: 0 })).toBe(4);
    expect(at(7, 0.5, { mode: 'floor', scale: 0 })).toBe(3);
    expect(at(7, 0.5, { mode: 'ceil', scale: 0 })).toBe(4);
  });

  it('rounding happens ONCE at the end (scale > 0 keeps declared decimals)', () => {
    expect(at(1.2345, 1, { mode: 'half_up', scale: 2 })).toBe(1.23);
  });

  it('negative intermediate result is clamped to the non-negative whole-points invariant', () => {
    const r = rule({
      pipeline: [{ type: 'formula', id: 'f1', output: 'set', expr: '0 - 50' }],
    });
    expect(expectOk(evaluateRule(r, ctx({}))).points).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Gate / segmentFilter onFail semantics
// ════════════════════════════════════════════════════════════════════════════

describe('Gate / segmentFilter onFail', () => {
  const base = (onFail: 'zero' | 'skipNode' | 'passthrough'): PipelineNode[] => [
    { type: 'gate', id: 'g1', when: { op: 'gte', left: { var: 'v' }, right: { lit: 100 } }, onFail },
    { type: 'rate', id: 'r1', measure: { var: 'v' }, rate: 1 },
  ];
  const inputs: RuleInput[] = [{ ref: 'v', kpiCode: 'V', type: 'number', nullAs: 'reject' }];

  it("onFail 'zero' failing → 0 (hard gate)", () => {
    expect(expectOk(evaluateRule(rule({ inputs, pipeline: base('zero') }), ctx({ achievements: { V: 50 } }))).points).toBe(0);
  });
  it("onFail 'skipNode' failing → pipeline continues → rate still accrues 50", () => {
    expect(expectOk(evaluateRule(rule({ inputs, pipeline: base('skipNode') }), ctx({ achievements: { V: 50 } }))).points).toBe(50);
  });
  it("onFail 'passthrough' failing → continues → 50", () => {
    expect(expectOk(evaluateRule(rule({ inputs, pipeline: base('passthrough') }), ctx({ achievements: { V: 50 } }))).points).toBe(50);
  });
  it('gate passing → full accrual', () => {
    expect(expectOk(evaluateRule(rule({ inputs, pipeline: base('zero') }), ctx({ achievements: { V: 120 } }))).points).toBe(120);
  });

  it('segmentFilter allows only the listed segment values', () => {
    const r = rule({
      inputs,
      pipeline: [
        { type: 'segmentFilter', id: 'sf1', field: 'program', allow: ['GOLD'], onFail: 'zero' },
        { type: 'rate', id: 'r1', measure: { var: 'v' }, rate: 1 },
      ],
    });
    expect(expectOk(evaluateRule(r, ctx({ achievements: { V: 100 }, segment: { program: 'GOLD' } }))).points).toBe(100);
    expect(expectOk(evaluateRule(r, ctx({ achievements: { V: 100 }, segment: { program: 'SILVER' } }))).points).toBe(0);
  });

  it('nested predicate (all/any/not) evaluates correctly in a gate', () => {
    const r = rule({
      inputs: [
        { ref: 'a', kpiCode: 'A', type: 'number', nullAs: 'reject' },
        { ref: 'b', kpiCode: 'B', type: 'number', nullAs: 'reject' },
      ],
      pipeline: [
        {
          type: 'gate',
          id: 'g1',
          when: { all: [{ op: 'gte', left: { var: 'a' }, right: { lit: 10 } }, { op: 'gte', left: { var: 'b' }, right: { lit: 5 } }] },
          onFail: 'zero',
        },
        { type: 'rate', id: 'r1', measure: { var: 'a' }, rate: 1 },
      ],
    });
    expect(expectOk(evaluateRule(r, ctx({ achievements: { A: 10, B: 5 } }))).points).toBe(10);
    expect(expectOk(evaluateRule(r, ctx({ achievements: { A: 10, B: 4 } }))).points).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Formula — divide-by-zero guard + if() laziness
// ════════════════════════════════════════════════════════════════════════════

describe('Formula runtime safety', () => {
  const inputs: RuleInput[] = [
    { ref: 'cases', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' },
    { ref: 'denom', kpiCode: 'DENOM', type: 'number', nullAs: 'reject' },
  ];

  it('division by zero → SKIP (never NaN/Infinity)', () => {
    const r = rule({ inputs, pipeline: [{ type: 'formula', id: 'f1', output: 'set', expr: 'cases / denom' }] });
    const o = expectSkip(evaluateRule(r, ctx({ achievements: { CASES_SOLD: 100, DENOM: 0 } })));
    expect(o.reason).toMatch(/division by zero/);
  });

  it('if() is LAZY — the untaken divide-by-zero branch never runs', () => {
    const r = rule({
      inputs,
      pipeline: [{ type: 'formula', id: 'f1', output: 'set', expr: 'if(denom == 0, 0, cases / denom)' }],
    });
    expect(expectOk(evaluateRule(r, ctx({ achievements: { CASES_SOLD: 100, DENOM: 0 } }))).points).toBe(0);
  });

  it('&& short-circuits — the right operand divide-by-zero never runs', () => {
    const r = rule({
      inputs,
      pipeline: [{ type: 'formula', id: 'f1', output: 'set', expr: 'if(denom != 0 && cases / denom > 1, 999, 7)' }],
    });
    expect(expectOk(evaluateRule(r, ctx({ achievements: { CASES_SOLD: 100, DENOM: 0 } }))).points).toBe(7);
  });

  it('formula output add / multiply / set combine with points-so-far', () => {
    const inputsC: RuleInput[] = [{ ref: 'cases', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' }];
    const run = (output: 'add' | 'multiply' | 'set') =>
      expectOk(
        evaluateRule(
          rule({
            inputs: inputsC,
            pipeline: [
              { type: 'rate', id: 'r1', measure: { var: 'cases' }, rate: 1 }, // 100 so far
              { type: 'formula', id: 'f1', output, expr: '10' },
            ],
          }),
          ctx({ achievements: { CASES_SOLD: 100 } }),
        ),
      ).points;
    expect(run('add')).toBe(110);
    expect(run('multiply')).toBe(1000);
    expect(run('set')).toBe(10);
  });

  it('whitelisted math functions evaluate (min/max/abs/round/floor/ceil/clamp)', () => {
    const inputsC: RuleInput[] = [{ ref: 'x', kpiCode: 'X', type: 'number', nullAs: 'reject' }];
    const run = (expr: string, x: number) =>
      expectOk(evaluateRule(rule({ inputs: inputsC, pipeline: [{ type: 'formula', id: 'f1', output: 'set', expr }] }), ctx({ achievements: { X: x } }))).points;
    expect(run('min(x, 50)', 80)).toBe(50);
    expect(run('max(x, 50)', 80)).toBe(80);
    expect(run('abs(x)', -7)).toBe(7);
    expect(run('clamp(x, 10, 20)', 35)).toBe(20);
    expect(run('floor(x / 3)', 10)).toBe(3);
    expect(run('ceil(x / 3)', 10)).toBe(4);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// validateRule — formula whitelist + structural config checks
// ════════════════════════════════════════════════════════════════════════════

describe('validateRule — formula whitelist (no eval, bounded AST)', () => {
  const formulaRule = (expr: string): PointsRuleConfig =>
    rule({
      inputs: [{ ref: 'cases', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' }],
      pipeline: [{ type: 'formula', id: 'f1', output: 'set', expr }],
    });

  it('a valid formula passes (returns [])', () => {
    expect(validateRule(formulaRule('if(cases > 0, cases * 2, 0)'))).toEqual([]);
  });

  it('REJECTS member access (cases.foo)', () => {
    const errs = validateRule(formulaRule('cases.foo'));
    expect(errs.some((e) => /parse error/.test(e))).toBe(true);
  });

  it('REJECTS indexing (cases[0])', () => {
    expect(validateRule(formulaRule('cases[0]')).some((e) => /parse error/.test(e))).toBe(true);
  });

  it('REJECTS assignment (cases = 1)', () => {
    expect(validateRule(formulaRule('cases = 1')).some((e) => /parse error/.test(e))).toBe(true);
  });

  it('REJECTS an unknown function (evil(cases))', () => {
    expect(validateRule(formulaRule('evil(cases)')).some((e) => /unknown function "evil"/.test(e))).toBe(true);
  });

  it('REJECTS an undeclared variable reference (notDeclared + 1)', () => {
    expect(validateRule(formulaRule('notDeclared + 1')).some((e) => /undeclared input "notDeclared"/.test(e))).toBe(true);
  });

  it('REJECTS an over-deep AST (> 20)', () => {
    const deep = '-'.repeat(21) + 'cases'; // 21 nested unary nodes → depth 22
    expect(validateRule(formulaRule(deep)).some((e) => /too deep/.test(e))).toBe(true);
  });

  it('REJECTS an over-large AST (> 200 nodes)', () => {
    const big = 'max(' + Array(201).fill('cases').join(', ') + ')'; // 1 call + 201 vars = 202 nodes
    expect(validateRule(formulaRule(big)).some((e) => /too large/.test(e))).toBe(true);
  });

  it('REJECTS wrong function arity (clamp needs 3 args)', () => {
    expect(validateRule(formulaRule('clamp(cases, 1)')).some((e) => /expects 3 arg/.test(e))).toBe(true);
  });

  it('REJECTS a bitwise/unexpected character (cases & 1)', () => {
    expect(validateRule(formulaRule('cases & 1')).some((e) => /parse error/.test(e))).toBe(true);
  });
});

describe('validateRule — structural config checks', () => {
  it('a well-formed rate rule is valid', () => {
    const r = rule({
      inputs: [{ ref: 'cases', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' }],
      pipeline: [{ type: 'rate', id: 'r1', measure: { var: 'cases' }, rate: 2 }],
    });
    expect(validateRule(r)).toEqual([]);
  });

  it('flags a measure var that is not a declared input', () => {
    const r = rule({
      inputs: [{ ref: 'cases', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' }],
      pipeline: [{ type: 'rate', id: 'r1', measure: { var: 'unknownVar' }, rate: 2 }],
    });
    expect(validateRule(r).some((e) => /undeclared input "unknownVar"/.test(e))).toBe(true);
  });

  it('flags slab band gap / overlap (non-contiguous half-open bands)', () => {
    const gap = rule({
      inputs: [{ ref: 'u', kpiCode: 'U', type: 'number', nullAs: 'reject' }],
      pipeline: [
        {
          type: 'slab',
          id: 's1',
          basis: 'absolute',
          measure: { var: 'u' },
          apply: 'marginal',
          bands: [
            { from: 0, to: 100, rate: 1 },
            { from: 150, to: null, rate: 2 }, // gap 100..150
          ],
        },
      ],
    });
    expect(validateRule(gap).some((e) => /contiguous/.test(e))).toBe(true);

    const overlap = rule({
      inputs: [{ ref: 'u', kpiCode: 'U', type: 'number', nullAs: 'reject' }],
      pipeline: [
        {
          type: 'slab',
          id: 's1',
          basis: 'absolute',
          measure: { var: 'u' },
          apply: 'marginal',
          bands: [
            { from: 0, to: 100, rate: 1 },
            { from: 80, to: null, rate: 2 }, // overlaps 80..100
          ],
        },
      ],
    });
    expect(validateRule(overlap).some((e) => /contiguous/.test(e))).toBe(true);
  });

  it('flags a non-last band that is open-ended (to=null)', () => {
    const r = rule({
      inputs: [{ ref: 'u', kpiCode: 'U', type: 'number', nullAs: 'reject' }],
      pipeline: [
        {
          type: 'slab',
          id: 's1',
          basis: 'absolute',
          measure: { var: 'u' },
          apply: 'whole',
          bands: [
            { from: 0, to: null, rate: 1 },
            { from: 100, to: null, rate: 2 },
          ],
        },
      ],
    });
    expect(validateRule(r).some((e) => /only the LAST band/.test(e) || /open-ended/.test(e))).toBe(true);
  });

  it('flags a pct_of_target slab missing its target operand', () => {
    const r = rule({
      inputs: [{ ref: 'u', kpiCode: 'U', type: 'number', nullAs: 'reject' }],
      pipeline: [
        {
          type: 'slab',
          id: 's1',
          basis: 'pct_of_target',
          measure: { var: 'u' },
          apply: 'marginal',
          bands: [{ from: 0, to: null, rate: 1 }],
        } as PipelineNode,
      ],
    });
    expect(validateRule(r).some((e) => /requires a target/.test(e))).toBe(true);
  });

  it('flags an enum input with no values, and a duplicate input ref', () => {
    const r = rule({
      inputs: [
        { ref: 'seg', source: 'segment:program', type: 'enum', nullAs: 'reject' }, // no values
        { ref: 'seg', kpiCode: 'X', type: 'number', nullAs: 'zero' }, // duplicate ref
      ],
      pipeline: [{ type: 'rate', id: 'r1', measure: { lit: 1 }, rate: 1 }],
    });
    const errs = validateRule(r);
    expect(errs.some((e) => /non-empty 'values'/.test(e))).toBe(true);
    expect(errs.some((e) => /duplicate input ref "seg"/.test(e))).toBe(true);
  });

  it('flags a bad nullAs, a bad rounding mode and a duplicate node id', () => {
    const r = rule({
      inputs: [{ ref: 'a', kpiCode: 'A', type: 'number', nullAs: 'bogus' as unknown as RuleInput['nullAs'] }],
      pipeline: [
        { type: 'rate', id: 'dup', measure: { var: 'a' }, rate: 1 },
        { type: 'cap', id: 'dup', max: 10 },
      ],
      rounding: { mode: 'weird' as unknown as RoundingSpec['mode'], scale: 0 },
    });
    const errs = validateRule(r);
    expect(errs.some((e) => /nullAs must be one of/.test(e))).toBe(true);
    expect(errs.some((e) => /rounding.mode must be one of/.test(e))).toBe(true);
    expect(errs.some((e) => /duplicate node id "dup"/.test(e))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Determinism
// ════════════════════════════════════════════════════════════════════════════

describe('Determinism', () => {
  it('the same (rule, ctx) yields an identical outcome every time', () => {
    const r = rule({
      inputs: [{ ref: 'cases', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' }],
      pipeline: [{ type: 'rate', id: 'r1', measure: { var: 'cases' }, rate: 3 }],
    });
    const c = ctx({ achievements: { CASES_SOLD: 42 } });
    const a = evaluateRule(r, c);
    const b = evaluateRule(r, c);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Derived pct-of-target input — relative gates (fire per-outlet, not a fixed absolute)
// ════════════════════════════════════════════════════════════════════════════

describe('Derived pct:<kpi> input (relative target-gate)', () => {
  // "Pay nothing below 80% of target" expressed RELATIVELY via a pct:CASES_SOLD input, so it fires at
  // the correct point for each outlet's own (different) target — which a fixed literal cannot express.
  const relRule = rule({
    inputs: [
      { ref: 'cases', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' },
      { ref: 'pct', source: 'pct:CASES_SOLD', type: 'number', nullAs: 'reject' },
    ],
    pipeline: [
      { type: 'gate', id: 'g', when: { op: 'gte', left: { var: 'pct' }, right: { lit: 80 } }, onFail: 'zero' },
      { type: 'rate', id: 'r', measure: { var: 'cases' }, rate: 1 },
    ],
  });

  it('passes at exactly 80% (400/500) → 400', () => {
    const o = evaluateRule(relRule, ctx({ achievements: { CASES_SOLD: 400 }, targets: { CASES_SOLD: 500 } }));
    expect(o.status).toBe('OK');
    if (o.status === 'OK') expect(o.points).toBe(400);
  });
  it('fails just below 80% (399/500 = 79.8%) → 0', () => {
    const o = evaluateRule(relRule, ctx({ achievements: { CASES_SOLD: 399 }, targets: { CASES_SOLD: 500 } }));
    expect(o.status).toBe('OK');
    if (o.status === 'OK') expect(o.points).toBe(0);
  });
  it('fires at a DIFFERENT absolute for a different target (820/1000 = 82%) → 820', () => {
    const o = evaluateRule(relRule, ctx({ achievements: { CASES_SOLD: 820 }, targets: { CASES_SOLD: 1000 } }));
    expect(o.status).toBe('OK');
    if (o.status === 'OK') expect(o.points).toBe(820);
  });
  it('target 0 → reject (no divide-by-zero)', () => {
    const o = evaluateRule(relRule, ctx({ achievements: { CASES_SOLD: 400 }, targets: { CASES_SOLD: 0 } }));
    expect(o.status).toBe('SKIP');
  });
});
