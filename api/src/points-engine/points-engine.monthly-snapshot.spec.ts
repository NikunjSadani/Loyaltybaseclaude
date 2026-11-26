// MONTHLY rules must evaluate byte-identically after quarterly rules were added (owner-approved 2026-11-25, opt-in).
// The snapshot was RECORDED AGAINST THE PRE-QUARTER EVALUATOR (release/next6 b4ef3c24) and is replayed here with --ci.
// Run: npx jest src/points-engine/points-engine.monthly-snapshot.spec.ts --ci

import { evaluateRule, validateRule } from './points-engine.helper';

const base = {
  ruleId: 'r', tenantId: 't', version: 1, status: 'published', effectiveFrom: '2026-01-01', effectiveTo: null,
  attachsTo: { scope: 'program_kpi', program: null, kpiCode: 'CASES' }, evaluationBasis: 'PERIOD_AGGREGATE',
  output: { awardType: 'POINTS', fieldId: 'cf' }, rounding: { mode: 'half_up', scale: 0 },
};

const rules: Record<string, unknown> = {
  rate: { ...base, inputs: [{ ref: 'v', kpiCode: 'CASES', type: 'number', nullAs: 'reject' }], pipeline: [{ type: 'rate', id: 'n1', measure: { var: 'v' }, rate: 2.5 }] },
  slabGateCap: {
    ...base,
    inputs: [
      { ref: 'v', kpiCode: 'CASES', type: 'number', nullAs: 'reject' },
      { ref: 't', source: 'target:CASES', type: 'number', nullAs: 'skipRule' },
    ],
    pipeline: [
      { type: 'gate', id: 'g', when: { op: 'gt', left: { var: 't' }, right: { lit: 0 } }, onFail: 'zero', failReason: 'Target is 0', failAs: 'zero' },
      { type: 'gate', id: 'g2', when: { op: 'gte', left: { var: 'v' }, right: { lit: 10 } }, onFail: 'zero' },
      { type: 'slab', id: 's', basis: 'pct_of_target', measure: { var: 'v' }, target: { var: 't' }, apply: 'marginal', bands: [{ from: 0, to: 100, rate: 1 }, { from: 100, to: null, rate: 3 }] },
      { type: 'cap', id: 'c', max: 400 },
    ],
  },
  formulaPct: {
    ...base,
    inputs: [{ ref: 'p', source: 'pct:CASES', type: 'number', nullAs: 'reject' }, { ref: 'v', kpiCode: 'CASES', type: 'number', nullAs: 'zero' }],
    pipeline: [{ type: 'formula', id: 'f', output: 'add', expr: 'if(p >= 120, v * min(1, 120 / p), v) * 5' }],
  },
};

const contexts: Record<string, unknown> = {
  normal: { achievements: { CASES: 150 }, targets: { CASES: 100 }, segment: {} },
  over: { achievements: { CASES: 333 }, targets: { CASES: 100 }, segment: {} },
  zeroTarget: { achievements: { CASES: 50 }, targets: { CASES: 0 }, segment: {} },
  noTarget: { achievements: { CASES: 50 }, targets: {}, segment: {} },
  noAch: { achievements: {}, targets: { CASES: 100 }, segment: {} },
  low: { achievements: { CASES: 5 }, targets: { CASES: 100 }, segment: {} },
};

describe('monthly rules — byte-identical to the pre-quarter evaluator', () => {
  for (const [rn, rule] of Object.entries(rules)) {
    it(`${rn}: valid + every context`, () => {
      expect(validateRule(rule as never)).toEqual([]);
      const out: Record<string, unknown> = {};
      for (const [cn, ctx] of Object.entries(contexts)) out[cn] = evaluateRule(rule as never, ctx as never);
      expect(out).toMatchSnapshot();
    });
  }
});
