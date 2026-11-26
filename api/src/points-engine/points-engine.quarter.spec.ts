// QUARTERLY rules (owner-approved 2026-11-25) — the pure evaluator + validator + FY-quarter helpers.
// Worked example = Bajaj BSC consistency bonus: 5 pts per BSC case over the quarter, each month's cases scaled by
// min(1, 1.2 × TOTAL target ÷ TOTAL achieved) (120% cap at MONTHLY level), paid only if TOTAL ach ≥ target (> 0) in
// ALL 3 months; cases ≤ 0 → 0 with a reason; half-up once at the end.
// Run: npx jest src/points-engine/points-engine.quarter.spec.ts

import { evaluateRule, validateRule } from './points-engine.helper';
import { parseQuarter, quarterKeyForMonth } from './points-engine.quarter';
import type { EvalContext, PointsRuleConfig, QuarterMonthValues, RuleInput } from './points-engine.types';

const M = [1, 2, 3] as const;

/** The BSC consistency-bonus rule exactly as the owner defined it (the report's "how to express" config). */
function bscConsistencyRule(over: Partial<PointsRuleConfig> = {}): PointsRuleConfig {
  const inputs: RuleInput[] = [
    ...M.flatMap((m): RuleInput[] => [
      { ref: `tot_ach_m${m}`, source: 'achievement:TOTAL', month: m, type: 'number', nullAs: 'reject' },
      { ref: `tot_tgt_m${m}`, source: 'target:TOTAL', month: m, type: 'number', nullAs: 'reject' },
      { ref: `cases_m${m}`, source: 'achievement:BSC_CASES', month: m, type: 'number', nullAs: 'reject' },
    ]),
    { ref: 'cases_q', source: 'achievement:BSC_CASES', type: 'number', nullAs: 'reject' }, // quarter total
  ];
  const term = (m: number) => `cases_m${m} * min(1, 1.2 * tot_tgt_m${m} / tot_ach_m${m})`;
  return {
    ruleId: 'bsc_consistency',
    tenantId: 'bajaj',
    version: 1,
    status: 'draft',
    effectiveFrom: '2026-04-01',
    effectiveTo: null,
    attachsTo: { scope: 'program_kpi', program: null, kpiCode: 'BSC_CASES' },
    evaluationBasis: 'QUARTER',
    output: { awardType: 'POINTS', fieldId: 'cf_bsc', narration: 'Consistency bonus' },
    rounding: { mode: 'half_up', scale: 0 },
    inputs,
    pipeline: [
      { type: 'segmentFilter', id: 'ws', field: 'outletType', allow: ['WS'], onFail: 'zero' },
      ...M.flatMap((m) => [
        {
          type: 'gate' as const, id: `tgt${m}`, onFail: 'zero' as const, failAs: 'zero' as const,
          when: { op: 'gt' as const, left: { var: `tot_tgt_m${m}` }, right: { lit: 0 } },
          failReason: `{m${m}}: TOTAL target is 0`,
        },
        {
          type: 'gate' as const, id: `met${m}`, onFail: 'zero' as const, failAs: 'zero' as const,
          when: { op: 'gte' as const, left: { var: `tot_ach_m${m}` }, right: { var: `tot_tgt_m${m}` } },
          failReason: `{m${m}}: TOTAL below target`,
        },
      ]),
      {
        type: 'gate', id: 'cases', onFail: 'zero', failAs: 'zero',
        when: { op: 'gt', left: { var: 'cases_q' }, right: { lit: 0 } },
        failReason: 'No BSC cases in {quarter}',
      },
      { type: 'formula', id: 'bonus', output: 'add', expr: `5 * (${term(1)} + ${term(2)} + ${term(3)})` },
    ],
    ...over,
  };
}

const Q = parseQuarter('2026-Q3')!; // Oct–Dec 2026

/** ctx from per-month [TOTAL ach, TOTAL tgt, BSC cases]; undefined → that key blank for that month. */
function qctx(months: Array<[number | undefined, number | undefined, number | undefined]>, outletType = 'WS'): EvalContext {
  const mv = months.map(([ach, tgt, cases], i): QuarterMonthValues => {
    const achievements: Record<string, number | null> = {};
    const targets: Record<string, number | null> = {};
    if (ach !== undefined) achievements.TOTAL = ach;
    if (cases !== undefined) achievements.BSC_CASES = cases;
    if (tgt !== undefined) targets.TOTAL = tgt;
    return { label: Q.monthLabels[i], achievements, targets };
  });
  return {
    achievements: {},
    targets: {},
    segment: { outletType },
    quarter: { label: Q.label, months: mv as [QuarterMonthValues, QuarterMonthValues, QuarterMonthValues] },
  };
}

describe('FY quarter helpers', () => {
  it('YYYY-Qn = FY start year: Q1 Apr–Jun … Q4 Jan–Mar of the next calendar year', () => {
    expect(parseQuarter('2026-Q1')).toMatchObject({ months: ['2026-04', '2026-05', '2026-06'], label: 'Apr–Jun 2026', fyLabel: 'Q1 FY2026-27' });
    expect(parseQuarter('2026-Q3')).toMatchObject({ months: ['2026-10', '2026-11', '2026-12'], label: 'Oct–Dec 2026', creditPeriod: '2026-12' });
    expect(parseQuarter('2026-Q4')).toMatchObject({ months: ['2027-01', '2027-02', '2027-03'], label: 'Jan–Mar 2027', creditPeriod: '2027-03' });
    expect(parseQuarter('2026-11')).toBeNull();
    expect(parseQuarter('2026-Q5')).toBeNull();
    expect(quarterKeyForMonth('2026-11')).toBe('2026-Q3');
    expect(quarterKeyForMonth('2027-02')).toBe('2026-Q4');
    expect(quarterKeyForMonth('2026-04')).toBe('2026-Q1');
  });
});

describe('BSC consistency bonus (quarterly rule, 120% cap per month)', () => {
  const rule = bscConsistencyRule();

  it('the rule is valid', () => {
    expect(validateRule(rule)).toEqual([]);
  });

  it('all 3 months met, each at 100–120% → every month at scale 1 → 5 × total cases', () => {
    const out = evaluateRule(rule, qctx([[1000, 1000, 10], [1100, 1000, 20], [1200, 1000, 30]]));
    expect(out).toMatchObject({ status: 'OK', points: 300 });
    expect((out as { reason?: string }).reason).toBeUndefined();
  });

  it('one month at 160% is scaled 0.75 (on its own), the others 100–120% stay at 1', () => {
    // 10×1 + 20×(1.2/1.6 = 0.75) + 30×1 = 55 → ×5 = 275
    expect(evaluateRule(rule, qctx([[1000, 1000, 10], [1600, 1000, 20], [1150, 1000, 30]]))).toMatchObject({ status: 'OK', points: 275 });
  });

  it('all three over 120% — each month scaled on its own, half-up ONCE at the end', () => {
    // 10×0.8 + 21×0.6 + 33×0.5 = 8 + 12.6 + 16.5 = 37.1 → ×5 = 185.5 → 186 (half-up; per-month rounding would give 40+63+83=186 by luck — see next)
    expect(evaluateRule(rule, qctx([[1500, 1000, 10], [2000, 1000, 21], [2400, 1000, 33]]))).toMatchObject({ status: 'OK', points: 186 });
    // 1×0.5 + 1×0.5 + 1×0.5 = 1.5 → ×5 = 7.5 → 8 once; rounding per month (2.5→3 each) would pay 9.
    expect(evaluateRule(rule, qctx([[2400, 1000, 1], [2400, 1000, 1], [2400, 1000, 1]]))).toMatchObject({ status: 'OK', points: 8 });
  });

  it('one month below target → 0, the reason NAMES that month', () => {
    const out = evaluateRule(rule, qctx([[1000, 1000, 10], [999, 1000, 20], [1200, 1000, 30]]));
    expect(out).toMatchObject({ status: 'OK', points: 0, reason: 'Nov 2026: TOTAL below target' });
  });

  it('two months below → 0, BOTH months named', () => {
    const out = evaluateRule(rule, qctx([[900, 1000, 10], [1000, 1000, 20], [500, 1000, 30]]));
    expect(out).toMatchObject({ status: 'OK', points: 0, reason: 'Oct 2026: TOTAL below target; Dec 2026: TOTAL below target' });
  });

  it('target 0 in a month → 0 with "<month>: TOTAL target is 0"', () => {
    const out = evaluateRule(rule, qctx([[1000, 0, 10], [1000, 1000, 20], [1000, 1000, 30]]));
    expect(out).toMatchObject({ status: 'OK', points: 0, reason: 'Oct 2026: TOTAL target is 0' });
  });

  it('missing TOTAL target in a month → SKIPPED (flagged for review) naming the month — never a silent 0', () => {
    const out = evaluateRule(rule, qctx([[1000, 1000, 10], [1000, 1000, 20], [1000, undefined, 30]]));
    expect(out).toEqual(expect.objectContaining({ status: 'SKIP', reason: 'Missing data: Dec 2026: no TOTAL target (tot_tgt_m3)' }));
  });

  it('missing achievement row for a month → SKIP naming the month for every missing input', () => {
    const out = evaluateRule(rule, qctx([[1000, 1000, 10], [undefined, 1000, undefined], [1000, 1000, 30]]));
    expect(out.status).toBe('SKIP');
    const reason = (out as { reason: string }).reason;
    expect(reason).toContain('Nov 2026: no TOTAL achievement (tot_ach_m2)');
    expect(reason).toContain('Nov 2026: no BSC_CASES achievement (cases_m2)');
    expect(reason).toContain('Nov 2026: no BSC_CASES achievement (cases_q)'); // quarter total names the blank month
  });

  it('zero / negative quarter cases → 0 with a reason naming the quarter', () => {
    expect(evaluateRule(rule, qctx([[1000, 1000, 0], [1000, 1000, 0], [1000, 1000, 0]]))).toMatchObject({
      status: 'OK', points: 0, reason: 'No BSC cases in Oct–Dec 2026',
    });
    expect(evaluateRule(rule, qctx([[1000, 1000, 5], [1000, 1000, -10], [1000, 1000, 2]]))).toMatchObject({
      status: 'OK', points: 0, reason: 'No BSC cases in Oct–Dec 2026',
    });
  });

  it('a retailer (not a wholesaler) → 0, never paid', () => {
    const out = evaluateRule(rule, qctx([[1000, 1000, 10], [1000, 1000, 10], [1000, 1000, 10]], 'RET'));
    expect(out).toMatchObject({ status: 'OK', points: 0 });
    expect((out as { reason?: string }).reason).toBe('Outlet type RET is not one this rule pays (WS)'); // plain words
    // …or the rule's own reason on the filter (quarterly rules only).
    const own = bscConsistencyRule({
      pipeline: bscConsistencyRule().pipeline.map((n) => (n.type === 'segmentFilter' ? { ...n, failReason: 'Not a wholesaler outlet' } : n)),
    });
    expect(validateRule(own)).toEqual([]);
    expect(evaluateRule(own, qctx([[1000, 1000, 10], [1000, 1000, 10], [1000, 1000, 10]], 'RET'))).toMatchObject({ status: 'OK', points: 0, reason: 'Not a wholesaler outlet' });
  });

  it('AUDIT 7: a later SKIP gate keeps every earlier failing month in the reason', () => {
    const r = bscConsistencyRule();
    const withSkip = bscConsistencyRule({
      pipeline: [
        ...r.pipeline.filter((n) => n.type !== 'formula'),
        { type: 'gate', id: 'late', onFail: 'zero', failAs: 'skip', when: { op: 'gt', left: { var: 'cases_q' }, right: { lit: 1000 } }, failReason: 'Cases need review' },
      ],
    });
    const out = evaluateRule(withSkip, qctx([[900, 1000, 10], [1000, 1000, 20], [1000, 1000, 30]]));
    expect(out).toMatchObject({ status: 'SKIP', reason: 'Oct 2026: TOTAL below target; Cases need review' });
  });

  it('a quarterly rule given no quarter (a monthly run / bad caller) → ERROR, never a 0', () => {
    const out = evaluateRule(rule, { achievements: { TOTAL: 1, BSC_CASES: 1 }, targets: { TOTAL: 1 }, segment: { outletType: 'WS' } });
    expect(out.status).toBe('ERROR');
  });

  it('deterministic: the same quarter evaluates identically (idempotent re-run)', () => {
    const ctx = qctx([[1500, 1000, 10], [2000, 1000, 21], [2400, 1000, 33]]);
    expect(evaluateRule(rule, ctx)).toEqual(evaluateRule(rule, ctx));
  });

  it('pct: with no month = Σ achievement ÷ Σ target', () => {
    const r = bscConsistencyRule({
      inputs: [{ ref: 'p', source: 'pct:TOTAL', type: 'number', nullAs: 'reject' }],
      pipeline: [{ type: 'formula', id: 'f', output: 'set', expr: 'p' }],
    });
    // (1000+1100+1200) / 3000 × 100 = 110
    expect(evaluateRule(r, qctx([[1000, 1000, 1], [1100, 1000, 1], [1200, 1000, 1]]))).toMatchObject({ status: 'OK', points: 110 });
  });
});

describe('quarterly validation', () => {
  const monthly = (over: Partial<PointsRuleConfig>): PointsRuleConfig => ({
    ...bscConsistencyRule(),
    evaluationBasis: 'PERIOD_AGGREGATE',
    output: { awardType: 'POINTS', fieldId: 'cf' },
    inputs: [{ ref: 'v', kpiCode: 'X', type: 'number', nullAs: 'reject' }],
    pipeline: [{ type: 'rate', id: 'r', measure: { var: 'v' }, rate: 1 }],
    ...over,
  });

  it('month on a monthly rule, narration on a monthly rule, quarter placeholders on a monthly rule → refused', () => {
    expect(validateRule(monthly({ inputs: [{ ref: 'v', kpiCode: 'X', type: 'number', nullAs: 'reject', month: 2 }] })).join(' ')).toMatch(/only for quarterly rules/);
    expect(validateRule(monthly({ output: { awardType: 'POINTS', fieldId: 'cf', narration: 'Bonus' } })).join(' ')).toMatch(/narration is only used by quarterly/);
    expect(
      validateRule(
        monthly({
          pipeline: [
            { type: 'gate', id: 'g', when: { op: 'gt', left: { var: 'v' }, right: { lit: 0 } }, onFail: 'zero', failReason: '{m1}: low' },
          ],
        }),
      ).join(' '),
    ).toMatch(/only work in a quarterly rule/);
  });

  it('a segment-filter reason on a monthly rule is refused (it would never show)', () => {
    expect(
      validateRule(monthly({ pipeline: [{ type: 'segmentFilter', id: 's', field: 'outletType', allow: ['WS'], onFail: 'zero', failReason: 'x' }] })).join(' '),
    ).toMatch(/only shown on a quarterly rule/);
  });

  it('bad month value, unknown basis, visibility in a quarterly rule → refused', () => {
    const q = bscConsistencyRule();
    expect(validateRule({ ...q, inputs: [...q.inputs, { ref: 'z', kpiCode: 'X', type: 'number', nullAs: 'zero', month: 4 as never }] }).join(' ')).toMatch(/month must be 1, 2 or 3/);
    expect(validateRule({ ...q, evaluationBasis: 'YEAR' as never }).join(' ')).toMatch(/evaluationBasis must be one of/);
    expect(validateRule({ ...q, inputs: [...q.inputs, { ref: 'vis', source: 'visibility:approved', type: 'number', nullAs: 'reject' }] }).join(' ')).toMatch(
      /visibility inputs are monthly/,
    );
  });

  it('a monthly rule without evaluationBasis is still valid (unchanged)', () => {
    const r = monthly({});
    delete (r as Partial<PointsRuleConfig>).evaluationBasis;
    expect(validateRule(r)).toEqual([]);
  });
});
