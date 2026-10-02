// Unit tests for PointsComputeService (Points Compute Engine — Wave 1, read-only compute/preview).
// Uses the REAL pure evaluator/validator (points-engine.helper) so OK/SKIP outcomes are genuine;
// mocks Prisma + PointsEngineService.getActiveForAttachment + TenantSettingsService.
// Covers: an OK rate run (points + counts), a SKIP (missing target for a reject-input rule),
// a NO_RULE outlet, tenant scoping, engineDisabled reflects the flag, and — critically — that the
// service performs NO write (it is read-only; no CreditBatch create / update / $transaction).
// Run: npx jest --no-coverage src/points-engine/points-compute.service.spec.ts

import { PointsComputeService } from './points-compute.service';
import { PrismaService } from '../prisma/prisma.service';
import { PointsEngineService } from './points-engine.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import type { PointsRule } from '@prisma/client';

// ── Prisma mock (read methods used by the service + write methods that MUST stay unused) ──
const mockPrisma = {
  pointsRule: { findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  outlet: { findMany: jest.fn() },
  outletSalesRecord: { findMany: jest.fn() },
  outletTarget: { findMany: jest.fn() },
  creditBatch: { create: jest.fn(), update: jest.fn() },
  wallet: { update: jest.fn() },
  creditField: { findMany: jest.fn() },
  $transaction: jest.fn(),
};

const mockEngine = { getActiveForAttachment: jest.fn() };
const mockSettings = { getEffectiveSettings: jest.fn() };

const clientAdmin: JwtPayload = {
  sub: 'u_client', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '1', name: 'CA',
};

// ── fixtures ────────────────────────────────────────────────────────────────────────────
function ruleRow(partial: Partial<PointsRule> = {}): PointsRule {
  return {
    id: 'row_1',
    ruleId: 'rule_cases',
    clientId: 'deoleo',
    version: 3,
    status: 'published',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
    evaluationBasis: 'PERIOD_AGGREGATE',
    attachsTo: { scope: 'program_kpi', program: 'GOLD', programCategory: null, kpiCode: 'CASES_SOLD' } as never,
    output: { awardType: 'POINTS', fieldId: 'cf1' } as never,
    rounding: { mode: 'half_up', scale: 0 } as never,
    inputs: [{ ref: 'value', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' }] as never,
    pipeline: [{ type: 'rate', id: 'n1', measure: { var: 'value' }, rate: 2 }] as never,
    kpiCode: 'CASES_SOLD',
    program: 'GOLD',
    programCategory: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: 'u1',
    ...partial,
  } as PointsRule;
}

function outletRow(code: string, program: string | null = 'GOLD') {
  return {
    outletCode: code,
    name: `Outlet ${code}`,
    programName: program,
    programCategory: null,
    outletType: { code: 'SSS' },
  };
}

function expectNoWrite() {
  expect(mockPrisma.pointsRule.create).not.toHaveBeenCalled();
  expect(mockPrisma.pointsRule.update).not.toHaveBeenCalled();
  expect(mockPrisma.creditBatch.create).not.toHaveBeenCalled();
  expect(mockPrisma.creditBatch.update).not.toHaveBeenCalled();
  expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
  expect(mockPrisma.$transaction).not.toHaveBeenCalled();
}

describe('PointsComputeService (Wave 1 — read-only preview)', () => {
  let service: PointsComputeService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSettings.getEffectiveSettings.mockResolvedValue({
      pointsEngine: { enabled: true, directCreditEnabled: false },
    });
    // default inputs
    mockPrisma.pointsRule.findMany.mockResolvedValue([{ kpiCode: 'CASES_SOLD' }]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
    mockPrisma.outletTarget.findMany.mockResolvedValue([]);
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    // Default output field: active, POINTS-classified for outlet type SSS (the fixture's type) → OK rows
    // survive the live-classification reconciliation. Individual tests override to prove demotion.
    mockPrisma.creditField.findMany.mockResolvedValue([
      { id: 'cf1', name: 'Q1 Reward', isActive: true, outletTypeAwards: { SSS: 'POINTS' } },
    ]);
    mockEngine.getActiveForAttachment.mockResolvedValue(null);
    service = new PointsComputeService(
      mockPrisma as unknown as PrismaService,
      mockEngine as unknown as PointsEngineService,
      mockSettings as unknown as TenantSettingsService,
    );
  });

  it('OK: a rate rule computes points and counts correctly (and performs NO write)', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([outletRow('O1')]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([{ outletCode: 'O1', kpiValues: { CASES_SOLD: 100 } }]);
    mockEngine.getActiveForAttachment.mockResolvedValue(ruleRow());

    const preview = await service.previewCompute(clientAdmin, { period: '2026-02' });

    expect(preview.rows).toHaveLength(1);
    const r = preview.rows[0];
    expect(r.status).toBe('OK');
    expect(r.points).toBe(200); // 100 cases × rate 2
    expect(r.achievement).toBe(100);
    expect(r.awardType).toBe('POINTS');
    expect(r.fieldId).toBe('cf1');
    expect(r.fieldName).toBe('Q1 Reward'); // resolved from CreditField — required for the credits-upload round-trip
    expect(r.ruleVersion).toBe(3);
    expect(r.explanation).toContain('200 pts');
    expect(preview.counts).toEqual({ total: 1, ok: 1, skip: 0, error: 0, noRule: 0 });
    expect(preview.totalPoints).toBe(200);
    expect(preview.ruleVersionsUsed).toEqual([{ ruleId: 'rule_cases', version: 3 }]);
    expect(preview.engineDisabled).toBe(false);
    expectNoWrite();

    // mapPreviewToUploadRows → 1 OK row, whole points (no ×100).
    const uploadRows = PointsComputeService.mapPreviewToUploadRows(preview);
    expect(uploadRows).toHaveLength(1);
    expect(uploadRows[0]).toMatchObject({
      rowNum: 1, outletId: 'O1', fieldId: 'cf1', amount: 200, awardType: 'POINTS', status: 'OK',
    });
  });

  it('DEMOTE→ERROR: output field is PAYOUT-classified for the outlet type (would be ×100 on upload)', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([outletRow('O1')]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([{ outletCode: 'O1', kpiValues: { CASES_SOLD: 100 } }]);
    mockEngine.getActiveForAttachment.mockResolvedValue(ruleRow());
    // The live field classifies SSS as PAYOUT → a whole-points award would be re-derived as a ₹ payout.
    mockPrisma.creditField.findMany.mockResolvedValue([
      { id: 'cf1', name: 'Q1 Reward', isActive: true, outletTypeAwards: { SSS: 'PAYOUT' } },
    ]);

    const preview = await service.previewCompute(clientAdmin, { period: '2026-02' });

    expect(preview.rows[0].status).toBe('ERROR');
    expect(preview.rows[0].reason).toMatch(/PAYOUT|payout|×100/);
    expect(preview.rows[0].points).toBeUndefined(); // cleared — never summed or exported
    expect(preview.counts).toMatchObject({ total: 1, ok: 0, error: 1 });
    expect(preview.totalPoints).toBe(0);
    expectNoWrite();
  });

  it('DEMOTE→ERROR: output field is inactive (would be silently dropped on upload)', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([outletRow('O1')]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([{ outletCode: 'O1', kpiValues: { CASES_SOLD: 100 } }]);
    mockEngine.getActiveForAttachment.mockResolvedValue(ruleRow());
    mockPrisma.creditField.findMany.mockResolvedValue([
      { id: 'cf1', name: 'Q1 Reward', isActive: false, outletTypeAwards: { SSS: 'POINTS' } },
    ]);

    const preview = await service.previewCompute(clientAdmin, { period: '2026-02' });

    expect(preview.rows[0].status).toBe('ERROR');
    expect(preview.rows[0].reason).toMatch(/inactive/i);
    expect(preview.counts).toMatchObject({ total: 1, ok: 0, error: 1 });
    expectNoWrite();
  });

  it('DEMOTE→ERROR: a PAYOUT-award rule is not creditable by the Wave-1 points preview', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([outletRow('O1')]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([{ outletCode: 'O1', kpiValues: { CASES_SOLD: 100 } }]);
    // Rule outputs to a PAYOUT bucket — paise crediting is Wave 2; the points preview must refuse it.
    mockEngine.getActiveForAttachment.mockResolvedValue(
      ruleRow({ output: { awardType: 'PAYOUT', fieldId: 'cf1' } as never }),
    );

    const preview = await service.previewCompute(clientAdmin, { period: '2026-02' });

    expect(preview.rows[0].status).toBe('ERROR');
    expect(preview.rows[0].reason).toMatch(/PAYOUT|Wave 2/i);
    expect(preview.counts).toMatchObject({ total: 1, ok: 0, error: 1 });
    expectNoWrite();
  });

  it('SKIP: a reject-input rule skips when its target is missing', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([outletRow('O1')]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([{ outletCode: 'O1', kpiValues: { CASES_SOLD: 100 } }]);
    // No OutletTarget rows → target:CASES_SOLD is absent → the reject input SKIPs the row.
    mockEngine.getActiveForAttachment.mockResolvedValue(
      ruleRow({
        inputs: [
          { ref: 'value', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'zero' },
          { ref: 'target', source: 'target:CASES_SOLD', type: 'number', nullAs: 'reject' },
        ] as never,
      }),
    );

    const preview = await service.previewCompute(clientAdmin, { period: '2026-02' });

    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0].status).toBe('SKIP');
    expect(preview.rows[0].reason).toMatch(/target/i);
    expect(preview.counts).toMatchObject({ total: 1, ok: 0, skip: 1 });
    expect(preview.totalPoints).toBe(0);
    expectNoWrite();
  });

  it('NO_RULE: an outlet with no active rule for the attachment', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([outletRow('O1', 'SILVER')]);
    mockEngine.getActiveForAttachment.mockResolvedValue(null); // nothing governs SILVER × CASES_SOLD

    const preview = await service.previewCompute(clientAdmin, { period: '2026-02' });

    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0].status).toBe('NO_RULE');
    expect(preview.counts).toMatchObject({ total: 1, noRule: 1, ok: 0 });
    expect(preview.ruleVersionsUsed).toEqual([]);
    expectNoWrite();
  });

  it('tenant scope: every input query + rule resolution is pinned to the caller clientId', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([outletRow('O1')]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([{ outletCode: 'O1', kpiValues: { CASES_SOLD: 10 } }]);
    mockEngine.getActiveForAttachment.mockResolvedValue(ruleRow());

    await service.previewCompute(clientAdmin, { period: '2026-02' });

    expect(mockPrisma.pointsRule.findMany.mock.calls[0][0].where.clientId).toBe('deoleo');
    expect(mockPrisma.outlet.findMany.mock.calls[0][0].where.clientId).toBe('deoleo');
    expect(mockPrisma.outletSalesRecord.findMany.mock.calls[0][0].where.clientId).toBe('deoleo');
    expect(mockPrisma.outletTarget.findMany.mock.calls[0][0].where.clientId).toBe('deoleo');
    expect(mockEngine.getActiveForAttachment.mock.calls[0][0]).toBe('deoleo'); // first arg = clientId
  });

  it('engineDisabled reflects the per-tenant pointsEngine.enabled flag', async () => {
    mockSettings.getEffectiveSettings.mockResolvedValue({
      pointsEngine: { enabled: false, directCreditEnabled: false },
    });
    const preview = await service.previewCompute(clientAdmin, { period: '2026-02' });
    expect(preview.engineDisabled).toBe(true);
    expectNoWrite();
  });

  it('a program filter scopes the outlet query and echoes into the preview filter', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    const preview = await service.previewCompute(clientAdmin, { period: '2026-02', program: 'GOLD' });
    expect(mockPrisma.outlet.findMany.mock.calls[0][0].where.programName).toBe('GOLD');
    expect(preview.filter).toEqual({ program: 'GOLD', kpiCode: null });
  });

  it('a kpiCode filter pins the run to that one KPI without the active-rules discovery query', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([outletRow('O1')]);
    mockEngine.getActiveForAttachment.mockResolvedValue(null);
    await service.previewCompute(clientAdmin, { period: '2026-02', kpiCode: 'LITRES' });
    // kpiCode filter short-circuits the discovery findMany on pointsRule.
    expect(mockPrisma.pointsRule.findMany).not.toHaveBeenCalled();
    expect(mockEngine.getActiveForAttachment.mock.calls[0][3]).toBe('LITRES'); // kpiCode arg
  });
});
