// Unit tests for PointsComputeService (Points Compute Engine — Wave 1, read-only compute/preview).
// Uses the REAL pure evaluator/validator (points-engine.helper) so OK/SKIP outcomes are genuine;
// mocks Prisma + PointsEngineService.getActiveForAttachment + TenantSettingsService.
// Covers: an OK rate run (points + counts), a SKIP (missing target for a reject-input rule),
// a NO_RULE outlet, tenant scoping, engineDisabled reflects the flag, and — critically — that the
// service performs NO write (it is read-only; no CreditBatch create / update / $transaction).
// Run: npx jest --no-coverage src/points-engine/points-compute.service.spec.ts

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PointsComputeService } from './points-compute.service';
import { PrismaService } from '../prisma/prisma.service';
import { PointsEngineService } from './points-engine.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { CreditsService } from '../credits/credits.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import type { PointsRule } from '@prisma/client';

// ── Prisma mock (read methods used by the service + write methods that MUST stay unused) ──
const mockPrisma = {
  pointsRule: { findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  outlet: { findMany: jest.fn() },
  outletSalesRecord: { findMany: jest.fn() },
  outletTarget: { findMany: jest.fn() },
  creditBatch: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
  wallet: { update: jest.fn() },
  creditField: { findMany: jest.fn() },
  $transaction: jest.fn(),
};

const mockEngine = { getActiveForAttachment: jest.fn() };
const mockSettings = { getEffectiveSettings: jest.fn(), getPointsEngineFlagsUncached: jest.fn() };
// CreditsService.createBatch is the existing credits rail the commit path reuses (NOT re-implemented).
const mockCredits = { createBatch: jest.fn() };

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

function outletRow(code: string, program: string | null = 'GOLD', metro: string | null = null) {
  return {
    outletCode: code,
    name: `Outlet ${code}`,
    programName: program,
    programCategory: null,
    metro,
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
    // Direct-credit money gate reads the UNCACHED flags; default = engine on, direct-credit OFF.
    mockSettings.getPointsEngineFlagsUncached.mockResolvedValue({ enabled: true, directCreditEnabled: false });
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
    mockPrisma.creditBatch.findFirst.mockResolvedValue(null);
    mockPrisma.creditBatch.count.mockResolvedValue(0);
    service = new PointsComputeService(
      mockPrisma as unknown as PrismaService,
      mockEngine as unknown as PointsEngineService,
      mockSettings as unknown as TenantSettingsService,
      mockCredits as unknown as CreditsService,
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

  it('PAYOUT: a PAYOUT-award rule computes to a REPORT amount (whole INR) and NEVER enters the credit path', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([outletRow('O1')]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([{ outletCode: 'O1', kpiValues: { CASES_SOLD: 100 } }]);
    // Rule outputs to a PAYOUT bucket; the field is an ACTIVE PAYOUT field for the outlet type (SSS).
    mockEngine.getActiveForAttachment.mockResolvedValue(
      ruleRow({ output: { awardType: 'PAYOUT', fieldId: 'cf1' } as never }),
    );
    mockPrisma.creditField.findMany.mockResolvedValue([
      { id: 'cf1', name: 'Visibility Payout', isActive: true, outletTypeAwards: { SSS: 'PAYOUT' } },
    ]);

    const preview = await service.previewCompute(clientAdmin, { period: '2026-02' });

    const r = preview.rows[0];
    expect(r.status).toBe('OK'); // computes — no longer demoted
    expect(r.awardType).toBe('PAYOUT');
    expect(r.payoutRupees).toBe(200); // 100 × 2, whole INR (report-only)
    expect(r.points).toBeUndefined(); // kept entirely out of the points/credit path
    expect(preview.counts).toMatchObject({ total: 1, ok: 1, error: 0 });
    expect(preview.totalPoints).toBe(0);
    expect(preview.totalPayoutRupees).toBe(200);
    // SAFETY: a PAYOUT row must NOT map into the credit-upload / direct-credit rows.
    expect(PointsComputeService.mapPreviewToUploadRows(preview)).toHaveLength(0);
    expectNoWrite();
  });

  it('DEMOTE→ERROR: a PAYOUT rule whose field is POINTS-classified for the outlet type is an honest config error', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([outletRow('O1')]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([{ outletCode: 'O1', kpiValues: { CASES_SOLD: 100 } }]);
    mockEngine.getActiveForAttachment.mockResolvedValue(
      ruleRow({ output: { awardType: 'PAYOUT', fieldId: 'cf1' } as never }),
    );
    // Field is POINTS for SSS, but the rule says PAYOUT → mismatch → ERROR (not a silent payout).
    mockPrisma.creditField.findMany.mockResolvedValue([
      { id: 'cf1', name: 'Q1 Reward', isActive: true, outletTypeAwards: { SSS: 'POINTS' } },
    ]);

    const preview = await service.previewCompute(clientAdmin, { period: '2026-02' });

    expect(preview.rows[0].status).toBe('ERROR');
    expect(preview.rows[0].reason).toMatch(/not PAYOUT|POINTS/i);
    expect(preview.rows[0].payoutRupees).toBeUndefined();
    expect(preview.counts).toMatchObject({ total: 1, ok: 0, error: 1 });
    expect(preview.totalPayoutRupees).toBe(0);
    expectNoWrite();
  });

  it('idempotency key ignores non-creditable (PAYOUT) rule versions — republishing a payout rule does NOT change a POINTS run key', async () => {
    // One outlet, two KPIs: CASES_SOLD → a POINTS rule (creditable), VISIBILITY → a PAYOUT rule (report-only).
    mockPrisma.pointsRule.findMany.mockResolvedValue([{ kpiCode: 'CASES_SOLD' }, { kpiCode: 'VISIBILITY' }]);
    mockPrisma.outlet.findMany.mockResolvedValue([outletRow('O1')]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
      { outletCode: 'O1', kpiValues: { CASES_SOLD: 100, VISIBILITY: 50 } },
    ]);
    mockPrisma.creditField.findMany.mockResolvedValue([
      { id: 'cf1', name: 'Points', isActive: true, outletTypeAwards: { SSS: 'POINTS' } },
      { id: 'cf_p', name: 'Payout', isActive: true, outletTypeAwards: { SSS: 'PAYOUT' } },
    ]);
    const pointsRule = ruleRow({ ruleId: 'rule_cases', version: 3 }); // POINTS cf1, rate 2, CASES_SOLD
    const makePayout = (v: number) =>
      ruleRow({
        ruleId: 'rule_pay',
        version: v,
        kpiCode: 'VISIBILITY',
        attachsTo: { scope: 'program_kpi', program: 'GOLD', programCategory: null, kpiCode: 'VISIBILITY' } as never,
        output: { awardType: 'PAYOUT', fieldId: 'cf_p' } as never,
        inputs: [{ ref: 'value', kpiCode: 'VISIBILITY', type: 'number', nullAs: 'reject' }] as never,
        pipeline: [{ type: 'rate', id: 'n1', measure: { var: 'value' }, rate: 10 }] as never,
      });
    const wire = (payoutV: number) =>
      mockEngine.getActiveForAttachment.mockImplementation((_c, _p, _pc, kpi) =>
        Promise.resolve(kpi === 'VISIBILITY' ? makePayout(payoutV) : pointsRule),
      );

    wire(1);
    const p1 = await service.previewCompute(clientAdmin, { period: '2026-02' });
    wire(2); // payout rule republished to v2 — nothing about the creditable POINTS row changed
    const p2 = await service.previewCompute(clientAdmin, { period: '2026-02' });

    // Same creditable content → SAME idempotency key (the fix): a payout-rule republish can't spawn a 2nd batch.
    expect(p1.sourceKey).toBe(p2.sourceKey);
    // Sanity: the run really did contain BOTH a creditable points row and a report-only payout row…
    const pts = p1.rows.find((r) => r.kpiCode === 'CASES_SOLD');
    const pay = p1.rows.find((r) => r.kpiCode === 'VISIBILITY');
    expect(pts).toMatchObject({ status: 'OK', awardType: 'POINTS', points: 200 });
    expect(pay).toMatchObject({ status: 'OK', awardType: 'PAYOUT', payoutRupees: 500 });
    // …and the informational ruleVersionsUsed DID change, proving the key's independence is deliberate.
    expect(p1.ruleVersionsUsed).not.toEqual(p2.ruleVersionsUsed);
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

  // ── metro segment field (additive 4th segment facet) ─────────────────────────────────────
  it('loads Outlet.metro in the outlet select', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([outletRow('O1')]);
    await service.previewCompute(clientAdmin, { period: '2026-02' });
    expect(mockPrisma.outlet.findMany.mock.calls[0][0].select.metro).toBe(true);
  });

  it('the per-outlet segment carries metro, and a metro segmentFilter restricts (null metro → withheld, like outletType null)', async () => {
    // A rule that only accrues for metro = "Metro" outlets.
    const metroRule = ruleRow({
      pipeline: [
        { type: 'segmentFilter', id: 'sf_metro', field: 'metro', allow: ['Metro'], onFail: 'zero' },
        { type: 'rate', id: 'n1', measure: { var: 'value' }, rate: 2 },
      ] as never,
    });
    mockPrisma.outlet.findMany.mockResolvedValue([
      outletRow('O_METRO', 'GOLD', 'Metro'),
      outletRow('O_NON', 'GOLD', 'Non-Metro'),
      outletRow('O_NULL', 'GOLD', null), // outlet master didn't set metro
    ]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
      { outletCode: 'O_METRO', kpiValues: { CASES_SOLD: 100 } },
      { outletCode: 'O_NON', kpiValues: { CASES_SOLD: 100 } },
      { outletCode: 'O_NULL', kpiValues: { CASES_SOLD: 100 } },
    ]);
    mockEngine.getActiveForAttachment.mockResolvedValue(metroRule);

    const preview = await service.previewCompute(clientAdmin, { period: '2026-02' });
    const byCode = Object.fromEntries(preview.rows.map((r) => [r.outletCode, r]));

    // Metro outlet → the filter passes → full accrual.
    expect(byCode['O_METRO'].status).toBe('OK');
    expect(byCode['O_METRO'].points).toBe(200);
    // Non-Metro + null-metro outlets → segmentFilter withholds (onFail 'zero') → OK row paying 0,
    // the SAME mechanism/semantics as a non-matching or null outletType.
    expect(byCode['O_NON'].status).toBe('OK');
    expect(byCode['O_NON'].points).toBe(0);
    expect(byCode['O_NULL'].status).toBe('OK');
    expect(byCode['O_NULL'].points).toBe(0);
    // Only the Metro outlet contributed points.
    expect(preview.totalPoints).toBe(200);
    expectNoWrite();
  });

  it('ADDITIVE/Deoleo-safe: a rule that does not reference metro computes identically regardless of the outlet metro value', async () => {
    // Same plain rate rule; two outlets differing ONLY in metro → identical points.
    mockPrisma.outlet.findMany.mockResolvedValue([
      outletRow('O_A', 'GOLD', 'Metro'),
      outletRow('O_B', 'GOLD', null),
    ]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
      { outletCode: 'O_A', kpiValues: { CASES_SOLD: 100 } },
      { outletCode: 'O_B', kpiValues: { CASES_SOLD: 100 } },
    ]);
    mockEngine.getActiveForAttachment.mockResolvedValue(ruleRow()); // plain rate, no metro usage

    const preview = await service.previewCompute(clientAdmin, { period: '2026-02' });
    const byCode = Object.fromEntries(preview.rows.map((r) => [r.outletCode, r]));
    expect(byCode['O_A'].points).toBe(200);
    expect(byCode['O_B'].points).toBe(200); // metro is ignored by a rule that doesn't use it
  });

  // ── Wave 2: direct-credit commit ──────────────────────────────────────────────────────────
  describe('commitCompute (direct-credit)', () => {
    /** Wire a single-OK-row run (O1 × CASES_SOLD × rate 2 × 100 = 200 pts). */
    function wireOkRun() {
      mockPrisma.outlet.findMany.mockResolvedValue([outletRow('O1')]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([{ outletCode: 'O1', kpiValues: { CASES_SOLD: 100 } }]);
      mockEngine.getActiveForAttachment.mockResolvedValue(ruleRow());
    }

    it('refuses when the per-tenant engine is disabled (uncached gate)', async () => {
      mockSettings.getPointsEngineFlagsUncached.mockResolvedValue({ enabled: false, directCreditEnabled: true });
      await expect(service.commitCompute(clientAdmin, { period: '2026-02' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockCredits.createBatch).not.toHaveBeenCalled();
    });

    it('refuses when Gifsy has NOT enabled direct crediting (default) — a tenant admin cannot self-enable', async () => {
      // beforeEach default: enabled:true, directCreditEnabled:false.
      wireOkRun();
      await expect(service.commitCompute(clientAdmin, { period: '2026-02' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockCredits.createBatch).not.toHaveBeenCalled();
    });

    it('creates a PENDING points-only batch from OK rows through the existing credits rail (no direct wallet write)', async () => {
      mockSettings.getPointsEngineFlagsUncached.mockResolvedValue({ enabled: true, directCreditEnabled: true });
      wireOkRun();
      mockCredits.createBatch.mockResolvedValue({
        id: 'cb1', batchCode: 'CB-2026-02-001', status: 'PENDING_CONFIRM', period: '2026-02', totalPoints: 200, totalOutlets: 1,
      });

      const res = await service.commitCompute(clientAdmin, { period: '2026-02' });

      // Routed through CreditsService.createBatch with a POINTS_ENGINE source + idempotency key; pure points.
      expect(mockCredits.createBatch).toHaveBeenCalledTimes(1);
      const [, dto, source] = mockCredits.createBatch.mock.calls[0];
      expect(dto).toMatchObject({ period: '2026-02', totalOutlets: 1, totalPoints: 200, totalPayoutPaise: 0 });
      expect(dto.rows).toHaveLength(1);
      expect(dto.rows[0]).toMatchObject({ outletId: 'O1', amount: 200, awardType: 'POINTS' });
      expect(source.kind).toBe('POINTS_ENGINE');
      expect(source.key).toMatch(/^pe_[0-9a-f]{64}$/);
      expect(res).toMatchObject({ batchId: 'cb1', status: 'PENDING_CONFIRM', totalPoints: 200, idempotentHit: false });
      // The service itself NEVER moves money (money moves only on the operator's confirmBatch).
      expectNoWrite();
    });

    it('is idempotent: a run whose batch already exists reports idempotentHit (no double-credit)', async () => {
      mockSettings.getPointsEngineFlagsUncached.mockResolvedValue({ enabled: true, directCreditEnabled: true });
      wireOkRun();
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'cb1' }); // same sourceKey already has a batch
      mockCredits.createBatch.mockResolvedValue({
        id: 'cb1', batchCode: 'CB-2026-02-001', status: 'PENDING_CONFIRM', period: '2026-02', totalPoints: 200, totalOutlets: 1,
      });

      const res = await service.commitCompute(clientAdmin, { period: '2026-02' });
      expect(res.idempotentHit).toBe(true);
    });

    it('refuses a run with no creditable (OK) rows', async () => {
      mockSettings.getPointsEngineFlagsUncached.mockResolvedValue({ enabled: true, directCreditEnabled: true });
      mockPrisma.outlet.findMany.mockResolvedValue([outletRow('O1', 'SILVER')]); // no rule → NO_RULE, 0 OK rows
      mockEngine.getActiveForAttachment.mockResolvedValue(null);
      await expect(service.commitCompute(clientAdmin, { period: '2026-02' })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockCredits.createBatch).not.toHaveBeenCalled();
    });

    it('TOCTOU: refuses to commit when the fresh run no longer matches the reviewed key', async () => {
      mockSettings.getPointsEngineFlagsUncached.mockResolvedValue({ enabled: true, directCreditEnabled: true });
      wireOkRun();
      await expect(
        service.commitCompute(clientAdmin, { period: '2026-02', expectedKey: 'pe_staleKeyThatWontMatch' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockCredits.createBatch).not.toHaveBeenCalled();
    });
  });

  // ── Wave 3: pure rule simulation (authoring aid) ─────────────────────────────────────────────
  describe('simulate (authoring)', () => {
    const validDraft = {
      attachsTo: { scope: 'program_kpi', program: 'GOLD', programCategory: null, kpiCode: 'CASES_SOLD' } as never,
      output: { awardType: 'POINTS' as const, fieldId: 'cf1' },
      rounding: { mode: 'half_up' as const, scale: 0 },
      inputs: [{ ref: 'value', kpiCode: 'CASES_SOLD', type: 'number' as const, nullAs: 'reject' as const }],
      pipeline: [{ type: 'rate', id: 'n1', measure: { var: 'value' }, rate: 2 }] as never,
    };

    it('evaluates a valid draft against a sample context and returns the trace (no DB)', () => {
      const res = service.simulate(clientAdmin, { ...validDraft, context: { achievements: { CASES_SOLD: 50 } } });
      expect(res.valid).toBe(true);
      expect(res.outcome?.status).toBe('OK');
      expect(res.outcome && 'points' in res.outcome ? res.outcome.points : null).toBe(100); // 50 × 2
      expect(res.outcome?.trace.length).toBeGreaterThan(0);
      expectNoWrite();
    });

    it('returns valid:false + errors for a malformed draft (POINTS award with fractional rounding)', () => {
      const res = service.simulate(clientAdmin, {
        ...validDraft,
        rounding: { mode: 'half_up', scale: 2 }, // POINTS must be scale 0 → invalid
        context: { achievements: { CASES_SOLD: 50 } },
      });
      expect(res.valid).toBe(false);
      expect(res.errors.length).toBeGreaterThan(0);
      expect(res.outcome).toBeUndefined();
      expectNoWrite();
    });
  });
});
