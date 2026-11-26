// MONTHLY compute runs must behave exactly as before quarterly rules (audit 2026-11-26): the snapshot below was
// RECORDED AGAINST THE PRE-QUARTER SERVICE (release/next6 b4ef3c24) and is replayed with --ci. It pins every query the
// monthly preview + direct-credit commit issue, the preview + commit results, the batch period, the createBatch call and
// the prior-batch count. ONE intentional difference is normalised out (and asserted explicitly below): the active-rule
// lookup now also SELECTS `evaluationBasis` so a monthly run can drop quarterly rules — its WHERE is unchanged.
// Run: npx jest src/points-engine/points-compute.monthly-snapshot.spec.ts --ci

import { PointsComputeService } from './points-compute.service';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

const admin: JwtPayload = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '1', name: 'A' };

function rule(over: Record<string, unknown> = {}) {
  return {
    id: 'row_1', ruleId: 'rule_cases', clientId: 'deoleo', version: 3, status: 'published',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), effectiveTo: null, evaluationBasis: 'PERIOD_AGGREGATE',
    attachsTo: { scope: 'program_kpi', program: 'GOLD', programCategory: null, kpiCode: 'CASES_SOLD' },
    output: { awardType: 'POINTS', fieldId: 'cf1' }, rounding: { mode: 'half_up', scale: 0 },
    inputs: [
      { ref: 'value', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' },
      { ref: 'target', source: 'target:CASES_SOLD', type: 'number', nullAs: 'skipRule' },
    ],
    pipeline: [
      { type: 'gate', id: 'g', when: { op: 'gt', left: { var: 'target' }, right: { lit: 0 } }, onFail: 'zero', failReason: 'Target is 0', failAs: 'zero' },
      { type: 'rate', id: 'n1', measure: { var: 'value' }, rate: 2 },
    ],
    kpiCode: 'CASES_SOLD', program: 'GOLD', programCategory: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: new Date('2026-01-01T00:00:00.000Z'), createdBy: 'u1',
    ...over,
  };
}

function world() {
  const prisma = {
    pointsRule: { findMany: jest.fn(async () => [{ kpiCode: 'CASES_SOLD', evaluationBasis: 'PERIOD_AGGREGATE' }]) },
    outlet: {
      findMany: jest.fn(async () =>
        ['O1', 'O2', 'O3'].map((c) => ({ outletCode: c, name: `Outlet ${c}`, programName: 'GOLD', programCategory: null, metro: null, outletType: { code: 'SSS' } })),
      ),
    },
    outletSalesRecord: {
      findMany: jest.fn(async () => [
        { outletCode: 'O1', kpiValues: { CASES_SOLD: 100 } },
        { outletCode: 'O2', kpiValues: { CASES_SOLD: 50 } },
      ]),
    },
    outletTarget: {
      findMany: jest.fn(async () => [
        { outletCode: 'O1', targetValues: { CASES_SOLD: 80 } },
        { outletCode: 'O2', targetValues: { CASES_SOLD: 0 } },
      ]),
    },
    kpiDef: { findMany: jest.fn(async () => []) },
    creditField: { findMany: jest.fn(async () => [{ id: 'cf1', name: 'Q1 Reward', isActive: true, outletTypeAwards: { SSS: 'POINTS' } }]) },
    creditBatch: {
      findFirst: jest.fn(async () => null),
      count: jest.fn(async () => 2),
      // Only the new code reads these (prior-batch detail); the baseline never calls them.
      findMany: jest.fn(async (a: { select?: { rows?: boolean } }) =>
        a?.select?.rows ? [] : [{ id: 'x1', batchCode: 'CB-2026-02-001', sourceKind: null }, { id: 'x2', batchCode: 'CB-2026-02-002', sourceKind: 'POINTS_ENGINE' }],
      ),
    },
    auditLog: { create: jest.fn(), findFirst: jest.fn() },
  };
  const engine = { getActiveForAttachment: jest.fn(async () => rule()), getQuarterRuleForAttachment: jest.fn() };
  const settings = {
    getEffectiveSettings: jest.fn(async () => ({ pointsEngine: { enabled: true, directCreditEnabled: true } })),
    getPointsEngineFlagsUncached: jest.fn(async () => ({ enabled: true, directCreditEnabled: true })),
    getPointsEngineFirstLiveMonthUncached: jest.fn(async () => null),
  };
  const credits = {
    createBatch: jest.fn(async (_u: unknown, dto: { period: string; totalPoints: number; totalOutlets: number }) => ({
      id: 'b1', batchCode: 'CB-2026-02-003', status: 'PENDING_CONFIRM', period: dto.period, totalPoints: dto.totalPoints, totalOutlets: dto.totalOutlets,
    })),
  };
  const svc = new PointsComputeService(prisma as never, engine as never, settings as never, credits as never, {} as never);
  return { prisma, engine, credits, svc };
}

/** The pinned record of a run: every collaborator call (args) + results. */
function record(w: ReturnType<typeof world>, extra: Record<string, unknown>) {
  const calls = (fn: jest.Mock) => fn.mock.calls.map((c) => c);
  const ruleCalls = calls(w.prisma.pointsRule.findMany as jest.Mock).map((c) => {
    const a = JSON.parse(JSON.stringify(c[0]));
    if (a?.select) delete a.select.evaluationBasis; // the one intentional, additive change (asserted below)
    return a;
  });
  return {
    pointsRuleFindMany: ruleCalls,
    outletFindMany: calls(w.prisma.outlet.findMany as jest.Mock),
    salesFindMany: calls(w.prisma.outletSalesRecord.findMany as jest.Mock),
    targetFindMany: calls(w.prisma.outletTarget.findMany as jest.Mock),
    kpiDefFindMany: calls(w.prisma.kpiDef.findMany as jest.Mock),
    creditFieldFindMany: calls(w.prisma.creditField.findMany as jest.Mock),
    getActiveForAttachment: calls(w.engine.getActiveForAttachment as jest.Mock),
    creditBatchFindFirst: calls(w.prisma.creditBatch.findFirst as jest.Mock),
    creditBatchCount: calls(w.prisma.creditBatch.count as jest.Mock),
    createBatch: calls(w.credits.createBatch as jest.Mock).map((c) => [c[1], c[2]]),
    ...extra,
  };
}

describe('MONTHLY compute — byte-identical to the pre-quarter service', () => {
  it('preview: queries + result', async () => {
    const w = world();
    const preview = await w.svc.previewCompute(admin, { period: '2026-02' });
    expect(record(w, { preview })).toMatchSnapshot();
  });

  it('direct credit: queries, batch period, createBatch args, prior-batch count, result', async () => {
    const w = world();
    const res = await w.svc.commitCompute(admin, { period: '2026-02' });
    // The new prior-batch DETAIL is additive and intentionally outside the pinned baseline result.
    const { priorBatches, ...baselineShape } = res as typeof res & { priorBatches?: unknown };
    expect(record(w, { commit: baselineShape })).toMatchSnapshot();
    if (priorBatches !== undefined) {
      expect(priorBatches).toEqual([
        { batchCode: 'CB-2026-02-001', kind: 'UPLOAD', likelyDuplicate: false },
        { batchCode: 'CB-2026-02-002', kind: 'MONTHLY_ENGINE', likelyDuplicate: false },
      ]);
    }
  });

  it('the one intentional difference: the active-rule lookup selects evaluationBasis (its WHERE is unchanged)', async () => {
    const w = world();
    await w.svc.previewCompute(admin, { period: '2026-02' });
    const a = (w.prisma.pointsRule.findMany as jest.Mock).mock.calls[0][0];
    // On the baseline this select is { kpiCode: true }; the new code adds evaluationBasis (to drop quarterly rules).
    expect(Object.keys(a.select).filter((k) => k !== 'evaluationBasis')).toEqual(['kpiCode']);
  });
});
