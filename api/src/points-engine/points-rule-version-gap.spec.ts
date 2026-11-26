// VERSION GAP guard (owner trap 2026-11-26): "Edit as new version" defaulted effective-from to TODAY, so a monthly rule's
// new version (from 26 Nov) superseded — and ARCHIVED — v1 (from 1 Nov), leaving 1–25 Nov with no rule. Publishing a
// version that leaves an already-started gap now needs an explicit confirmation (412 VERSION_GAP otherwise).
// Dates are computed relative to "now" (never hardcoded future dates).
// Run: npx jest --no-coverage src/points-engine/points-rule-version-gap.spec.ts

import { PreconditionFailedException } from '@nestjs/common';
import { PointsEngineService, versionGapMessage } from './points-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import type { PointsRule } from '@prisma/client';

jest.mock('./points-engine.helper', () => ({ validateRule: jest.fn(() => []) }));

const clientAdmin: JwtPayload = { sub: 'u_client', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '1', name: 'CA' };

/** UTC-midnight Date `days` from today. */
function day(days: number): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + days));
}

function row(p: Partial<PointsRule>): PointsRule {
  return {
    id: 'row_v2', ruleId: 'rule_1', name: null, clientId: 'deoleo', version: 2, status: 'draft',
    effectiveFrom: day(0), effectiveTo: null, evaluationBasis: 'PERIOD_AGGREGATE',
    attachsTo: { scope: 'program_kpi', program: 'GOLD', programCategory: null, kpiCode: 'CASES_SOLD' } as never,
    output: { awardType: 'POINTS', fieldId: 'cf1' } as never, rounding: { mode: 'half_up', scale: 0 } as never,
    inputs: [] as never, pipeline: [] as never, kpiCode: 'CASES_SOLD', program: 'GOLD', programCategory: null,
    createdAt: new Date(), updatedAt: new Date(), createdBy: 'u1',
    ...p,
  } as PointsRule;
}

describe('publish — version gap guard', () => {
  const prisma = {
    pointsRule: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    kpiDef: { findMany: jest.fn() },
    outlet: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  let svc: PointsEngineService;

  function setup(draft: PointsRule, prior: PointsRule) {
    prisma.pointsRule.findFirst.mockResolvedValue(draft);
    // findMany #1 = other-ruleId clashes (none), #2 = same-ruleId priors.
    prisma.pointsRule.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([prior]);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.kpiDef.findMany.mockResolvedValue([{ code: 'CASES_SOLD' }]);
    prisma.outlet.findMany.mockResolvedValue([]);
    prisma.$transaction.mockImplementation(async (cb: (tx: typeof prisma) => unknown) => cb(prisma));
    prisma.pointsRule.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: object }) => ({ id: where.id, ...data }));
    svc = new PointsEngineService(prisma as unknown as PrismaService);
  });

  it('v1 from 25 days ago, v2 from today → 412 VERSION_GAP naming both dates; NOTHING is archived or published', async () => {
    const v1 = row({ id: 'row_v1', version: 1, status: 'published', effectiveFrom: day(-25) });
    const v2 = row({ effectiveFrom: day(0) });
    setup(v2, v1);
    const err = await svc.publish(clientAdmin, 'row_v2').catch((e) => e);
    expect(err).toBeInstanceOf(PreconditionFailedException);
    expect(err.getResponse()).toMatchObject({ code: 'VERSION_GAP' });
    expect(err.message).toContain(versionGapMessage(v1, v2));
    expect(err.message).toMatch(/^Version 1 covered from \d{2}-\d{2}-\d{4}; this version starts \d{2}-\d{2}-\d{4} — periods in between will have no rule\./);
    expect(prisma.pointsRule.update).not.toHaveBeenCalled();
  });

  it('with confirmGap → publishes (v1 archived, closed the day before v2)', async () => {
    const v1 = row({ id: 'row_v1', version: 1, status: 'published', effectiveFrom: day(-25) });
    setup(row({ effectiveFrom: day(0) }), v1);
    await svc.publish(clientAdmin, 'row_v2', { confirmGap: true });
    const archived = prisma.pointsRule.update.mock.calls.find((c) => c[0].where.id === 'row_v1')![0].data;
    expect(archived).toEqual({ status: 'archived', effectiveTo: day(-1) });
    expect(prisma.pointsRule.update.mock.calls.find((c) => c[0].where.id === 'row_v2')![0].data).toEqual({ status: 'published' });
  });

  it('no gap when v2 starts the SAME day as v1 (the new default) or earlier (back-dated)', async () => {
    const v1 = row({ id: 'row_v1', version: 1, status: 'published', effectiveFrom: day(-25) });
    setup(row({ effectiveFrom: day(-25) }), v1);
    await expect(svc.publish(clientAdmin, 'row_v2')).resolves.toBeDefined();

    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (cb: (tx: typeof prisma) => unknown) => cb(prisma));
    prisma.kpiDef.findMany.mockResolvedValue([{ code: 'CASES_SOLD' }]);
    setup(row({ effectiveFrom: day(-40) }), v1);
    await expect(svc.publish(clientAdmin, 'row_v2')).resolves.toBeDefined();
  });

  it('no confirmation when the gap lies entirely in the FUTURE (v1 has not started yet)', async () => {
    const v1 = row({ id: 'row_v1', version: 1, status: 'published', effectiveFrom: day(10) });
    setup(row({ effectiveFrom: day(20) }), v1);
    await expect(svc.publish(clientAdmin, 'row_v2')).resolves.toBeDefined();
  });

  it('a non-overlapping prior (already ended before v2) is not superseded, so no gap prompt', async () => {
    const v1 = row({ id: 'row_v1', version: 1, status: 'published', effectiveFrom: day(-60), effectiveTo: day(-31) });
    setup(row({ effectiveFrom: day(-30) }), v1);
    await expect(svc.publish(clientAdmin, 'row_v2')).resolves.toBeDefined();
  });
});
