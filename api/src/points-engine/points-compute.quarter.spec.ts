// QUARTER compute runs (owner-approved 2026-11-25): PointsComputeService with `period: 'YYYY-Qn'`.
// Real evaluator; Prisma / rule store / settings / credits mocked (same pattern as points-compute.service.spec.ts).
// Covers: the 3-month load, quarterly-only rule resolution (and monthly runs never picking a quarterly rule), the
// BSC consistency bonus end-to-end (120% cap per month), missing month → SKIP naming the month, narration naming the
// quarter, distinct + stable idempotency keys, direct-credit idempotency + month-keyed batch, the credit-upload file.
// Run: npx jest src/points-engine/points-compute.quarter.spec.ts

import * as XLSX from 'xlsx';
import { PointsComputeService } from './points-compute.service';
import { PointsEngineService } from './points-engine.service';
import { writeCreditUploadXlsx } from './points-compute-export.helper';
import { collectXlsx } from '../exports/kinds/batch2/parity.support-spec';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import type { PointsRule } from '@prisma/client';

const mockPrisma = {
  pointsRule: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
  outletSalesRecord: { findMany: jest.fn() },
  outletTarget: { findMany: jest.fn() },
  creditBatch: { findFirst: jest.fn(), count: jest.fn(), create: jest.fn(), findMany: jest.fn() },
  creditField: { findMany: jest.fn() },
  kpiDef: { findMany: jest.fn() },
  auditLog: { create: jest.fn(), findFirst: jest.fn() },
};
const mockEngine = { getActiveForAttachment: jest.fn(), getQuarterRuleForAttachment: jest.fn() };
const mockSettings = { getEffectiveSettings: jest.fn(), getPointsEngineFlagsUncached: jest.fn(), getPointsEngineFirstLiveMonthUncached: jest.fn() };
const mockCredits = { createBatch: jest.fn() };
const mockTenant = { resolveVisibilityEnabled: jest.fn(), resolveVisibilityCaptureMode: jest.fn() };

const admin: JwtPayload = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '1', name: 'A' };

const term = (m: number) => `cases_m${m} * min(1, 1.2 * tot_tgt_m${m} / tot_ach_m${m})`;
function bscRow(partial: Partial<PointsRule> = {}): PointsRule {
  const M = [1, 2, 3];
  return {
    id: 'row_q', ruleId: 'rule_bsc_q', clientId: 'bajaj', version: 2, status: 'published',
    effectiveFrom: new Date('2026-04-01T00:00:00.000Z'), effectiveTo: null, evaluationBasis: 'QUARTER',
    attachsTo: { scope: 'program_kpi', program: null, programCategory: null, kpiCode: 'BSC_CASES' } as never,
    output: { awardType: 'POINTS', fieldId: 'cf_bsc', narration: 'Consistency bonus' } as never,
    rounding: { mode: 'half_up', scale: 0 } as never,
    inputs: [
      ...M.flatMap((m) => [
        { ref: `tot_ach_m${m}`, source: 'achievement:TOTAL', month: m, type: 'number', nullAs: 'reject' },
        { ref: `tot_tgt_m${m}`, source: 'target:TOTAL', month: m, type: 'number', nullAs: 'reject' },
        { ref: `cases_m${m}`, source: 'achievement:BSC_CASES', month: m, type: 'number', nullAs: 'reject' },
      ]),
      { ref: 'cases_q', source: 'achievement:BSC_CASES', type: 'number', nullAs: 'reject' },
    ] as never,
    pipeline: [
      { type: 'segmentFilter', id: 'ws', field: 'outletType', allow: ['WS'], onFail: 'zero' },
      ...M.flatMap((m) => [
        { type: 'gate', id: `tgt${m}`, onFail: 'zero', failAs: 'zero', when: { op: 'gt', left: { var: `tot_tgt_m${m}` }, right: { lit: 0 } }, failReason: `{m${m}}: TOTAL target is 0` },
        { type: 'gate', id: `met${m}`, onFail: 'zero', failAs: 'zero', when: { op: 'gte', left: { var: `tot_ach_m${m}` }, right: { var: `tot_tgt_m${m}` } }, failReason: `{m${m}}: TOTAL below target` },
      ]),
      { type: 'gate', id: 'cases', onFail: 'zero', failAs: 'zero', when: { op: 'gt', left: { var: 'cases_q' }, right: { lit: 0 } }, failReason: 'No BSC cases in {quarter}' },
      { type: 'formula', id: 'bonus', output: 'add', expr: `5 * (${term(1)} + ${term(2)} + ${term(3)})` },
    ] as never,
    kpiCode: 'BSC_CASES', program: null, programCategory: null,
    createdAt: new Date(), updatedAt: new Date(), createdBy: 'u1',
    ...partial,
  } as PointsRule;
}

const outlet = (code: string) => ({ outletCode: code, name: `Outlet ${code}`, programName: 'BSC', programCategory: null, metro: null, outletType: { code: 'WS' } });
const MONTHS = ['2026-10', '2026-11', '2026-12'];
/** per outlet: [TOTAL ach, TOTAL tgt, BSC cases] for Oct, Nov, Dec (undefined month = no row). */
function load(data: Record<string, Array<[number, number, number] | undefined>>) {
  const sales: unknown[] = [];
  const targets: unknown[] = [];
  for (const [code, months] of Object.entries(data)) {
    months.forEach((v, i) => {
      if (!v) return;
      sales.push({ outletCode: code, month: MONTHS[i], kpiValues: { TOTAL: v[0], BSC_CASES: v[2] } });
      targets.push({ outletCode: code, month: MONTHS[i], targetValues: { TOTAL: v[1] } });
    });
  }
  mockPrisma.outlet.findMany.mockResolvedValue(Object.keys(data).map(outlet));
  mockPrisma.outletSalesRecord.findMany.mockResolvedValue(sales);
  mockPrisma.outletTarget.findMany.mockResolvedValue(targets);
}

describe('PointsEngineService.getActiveForAttachment — monthly vs quarterly', () => {
  it('a monthly lookup never returns a quarterly rule and vice versa (query unchanged)', async () => {
    const monthly = { ...bscRow({ id: 'm', ruleId: 'm', evaluationBasis: 'PERIOD_AGGREGATE' }) };
    const quarterly = bscRow();
    const prisma = { pointsRule: { findMany: jest.fn(async () => [quarterly, monthly]) } };
    const svc = new PointsEngineService(prisma as never);
    const d = new Date('2026-10-01T00:00:00.000Z');
    expect((await svc.getActiveForAttachment('bajaj', 'BSC', null, 'BSC_CASES', d))?.ruleId).toBe('m');
    expect((await svc.getActiveForAttachment('bajaj', 'BSC', null, 'BSC_CASES', d, 'QUARTER'))?.ruleId).toBe('rule_bsc_q');
    prisma.pointsRule.findMany.mockResolvedValue([quarterly]);
    expect(await svc.getActiveForAttachment('bajaj', 'BSC', null, 'BSC_CASES', d)).toBeNull();
  });
});

describe('PointsEngineService — quarterly rule store (audit fixes)', () => {
  const draftDto = (basis: 'QUARTER' | 'PERIOD_AGGREGATE') => {
    const r = bscRow({ evaluationBasis: basis });
    return {
      ruleId: 'rule_m', effectiveFrom: '2026-10-01', evaluationBasis: basis, attachsTo: r.attachsTo, output: r.output,
      rounding: r.rounding, inputs: basis === 'QUARTER' ? r.inputs : [{ ref: 'v', kpiCode: 'BSC_CASES', type: 'number', nullAs: 'reject' }],
      pipeline: basis === 'QUARTER' ? r.pipeline : [{ type: 'rate', id: 'n', measure: { var: 'v' }, rate: 1 }],
    } as never;
  };

  it('AUDIT 1: a new version can never switch monthly ↔ quarterly (it would retire the other kind on publish)', async () => {
    const prisma = { pointsRule: { findMany: jest.fn(async () => [{ version: 1, status: 'published', evaluationBasis: 'PERIOD_AGGREGATE' }]), create: jest.fn() } };
    const svc = new PointsEngineService(prisma as never);
    await expect(svc.createDraft(admin, draftDto('QUARTER'))).rejects.toThrow(/cannot switch between monthly and quarterly.*Create a new rule for a quarterly bonus/);
    expect(prisma.pointsRule.create).not.toHaveBeenCalled();
  });

  it('AUDIT 1: editing a draft version 2 to the other kind is refused too', async () => {
    const prisma = {
      pointsRule: {
        findFirst: jest.fn(async () => ({ id: 'd2', ruleId: 'rule_m', clientId: 'bajaj', version: 2, status: 'draft', evaluationBasis: 'PERIOD_AGGREGATE' })),
        findMany: jest.fn(async () => [{ version: 1, status: 'published', evaluationBasis: 'PERIOD_AGGREGATE' }]),
        update: jest.fn(),
      },
    };
    const svc = new PointsEngineService(prisma as never);
    await expect(svc.updateDraft(admin, 'd2', draftDto('QUARTER'))).rejects.toThrow(/Create a new rule for a quarterly bonus/);
    expect(prisma.pointsRule.update).not.toHaveBeenCalled();
  });

  it('AUDIT 5: a quarterly version applies when its window overlaps the quarter; two overlapping versions → conflict text', async () => {
    const v1 = bscRow({ version: 1, effectiveFrom: new Date('2026-04-01T00:00:00.000Z'), effectiveTo: new Date('2026-11-14T00:00:00.000Z') });
    const v2 = bscRow({ id: 'r2', version: 2, effectiveFrom: new Date('2026-11-15T00:00:00.000Z') });
    const prisma = { pointsRule: { findMany: jest.fn(async (_a?: { where: unknown }) => [v2, v1]) } };
    const svc = new PointsEngineService(prisma as never);
    const qs = new Date('2026-10-01T00:00:00.000Z');
    const qe = new Date('2026-12-31T00:00:00.000Z');
    const res = await svc.getQuarterRuleForAttachment('bajaj', 'BSC', null, 'BSC_CASES', qs, qe);
    expect(res.rule).toBeNull();
    expect(res.conflict).toMatch(/rule_bsc_q v2 \(2026-11-15 → open-ended\); rule_bsc_q v1 \(2026-04-01 → 2026-11-14\)/);
    expect(prisma.pointsRule.findMany.mock.calls[0][0]!.where).toEqual(expect.objectContaining({ evaluationBasis: 'QUARTER', effectiveFrom: { lte: qe } }));
    prisma.pointsRule.findMany.mockResolvedValue([v2]);
    expect((await svc.getQuarterRuleForAttachment('bajaj', 'BSC', null, 'BSC_CASES', qs, qe)).rule?.version).toBe(2); // starts mid-quarter, still overlaps
  });
});

describe('PointsComputeService — QUARTER runs', () => {
  let service: PointsComputeService;
  beforeEach(() => {
    jest.clearAllMocks();
    mockSettings.getEffectiveSettings.mockResolvedValue({ pointsEngine: { enabled: true, directCreditEnabled: true } });
    mockSettings.getPointsEngineFlagsUncached.mockResolvedValue({ enabled: true, directCreditEnabled: true });
    mockPrisma.pointsRule.findMany.mockResolvedValue([
      { kpiCode: 'BSC_CASES', evaluationBasis: 'QUARTER' },
      { kpiCode: 'TOTAL', evaluationBasis: 'PERIOD_AGGREGATE' }, // a monthly rule — never part of a quarter run
    ]);
    mockPrisma.kpiDef.findMany.mockResolvedValue([]);
    mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'cf_bsc', name: 'BSC Consistency', isActive: true, outletTypeAwards: { WS: 'POINTS' } }]);
    mockEngine.getActiveForAttachment.mockResolvedValue(bscRow());
    mockEngine.getQuarterRuleForAttachment.mockResolvedValue({ rule: bscRow() });
    mockSettings.getPointsEngineFirstLiveMonthUncached.mockResolvedValue(null);
    mockPrisma.creditBatch.findMany.mockResolvedValue([]);
    mockPrisma.creditBatch.findFirst.mockResolvedValue(null);
    mockPrisma.creditBatch.count.mockResolvedValue(0);
    mockCredits.createBatch.mockResolvedValue({ id: 'b1', batchCode: 'CB-2026-12-001', status: 'PENDING_CONFIRM', period: '2026-12', totalPoints: 275, totalOutlets: 1 });
    service = new PointsComputeService(mockPrisma as never, mockEngine as never, mockSettings as never, mockCredits as never, mockTenant as never);
    // "Today" = mid-Jan 2027, so Oct–Dec 2026 has fully ended (Date only — timers stay real).
    jest.useFakeTimers({ now: new Date('2027-01-15T06:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask', 'hrtime', 'performance'] });
  });
  afterEach(() => jest.useRealTimers());

  it('loads the 3 months, resolves QUARTERLY rules only, pays the capped bonus and names the quarter', async () => {
    load({
      W1: [[1000, 1000, 10], [1600, 1000, 20], [1150, 1000, 30]], // Nov at 160% → scaled 0.75 → 275
      W2: [[1000, 1000, 10], [999, 1000, 20], [1200, 1000, 30]], // Nov below target → 0, named
      W3: [[1000, 1000, 10], undefined, [1200, 1000, 30]], // no Nov data at all → SKIP, named
    });
    const p = await service.previewCompute(admin, { period: '2026-Q3' });

    expect(mockPrisma.outletSalesRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { clientId: 'bajaj', month: { in: MONTHS } } }));
    expect(mockPrisma.outletTarget.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { clientId: 'bajaj', month: { in: MONTHS } } }));
    // Only the quarterly KPI is computed; resolution asks for QUARTER rules effective on the quarter's first day.
    expect(new Set(p.rows.map((r) => r.kpiCode))).toEqual(new Set(['BSC_CASES']));
    expect(mockEngine.getQuarterRuleForAttachment).toHaveBeenCalledWith('bajaj', 'BSC', null, 'BSC_CASES', new Date('2026-10-01T00:00:00.000Z'), new Date('2026-12-31T00:00:00.000Z'));
    expect(mockEngine.getActiveForAttachment).not.toHaveBeenCalled();

    expect(p.quarter).toEqual({ key: '2026-Q3', label: 'Oct–Dec 2026', fyLabel: 'Q3 FY2026-27', months: MONTHS, monthLabels: ['Oct 2026', 'Nov 2026', 'Dec 2026'], creditPeriod: '2026-12', openMonths: [] });
    const by = new Map(p.rows.map((r) => [r.outletCode, r]));
    expect(by.get('W1')).toMatchObject({ status: 'OK', points: 275, achievement: 60, narration: 'Consistency bonus Oct–Dec 2026' });
    expect(by.get('W1')!.explanation).toMatch(/^Oct–Dec 2026 \(BSC_CASES by month: Oct 10, Nov 20, Dec 30\)/);
    expect(by.get('W2')).toMatchObject({ status: 'OK', points: 0, reason: 'Nov 2026: TOTAL below target' });
    expect(by.get('W3')!.status).toBe('SKIP');
    expect(by.get('W3')!.reason).toContain('Nov 2026: no TOTAL target');
    expect(by.get('W3')!.achievement).toBeNull(); // a quarter total with a blank month is never a partial sum
    expect(p.totalPoints).toBe(275);

    const upload = PointsComputeService.mapPreviewToUploadRows(p).filter((r) => r.amount > 0);
    expect(upload).toEqual([expect.objectContaining({ outletId: 'W1', amount: 275, narration: 'Consistency bonus Oct–Dec 2026' })]);
  });

  it('a quarter run and the same-numbers MONTHLY run can never share a key; a repeated quarter run is stable', async () => {
    load({ W1: [[1000, 1000, 10], [1000, 1000, 10], [1000, 1000, 10]] });
    const a = await service.previewCompute(admin, { period: '2026-Q3' });
    const b = await service.previewCompute(admin, { period: '2026-Q3' });
    expect(a.sourceKey).toBe(b.sourceKey);
    expect(a.rows).toEqual(b.rows);
    // Same creditable rows, but a different period string is hashed → different idempotency key.
    const asMonth = await service.previewCompute(admin, { period: '2026-12' }).catch(() => null);
    expect(asMonth?.sourceKey).not.toBe(a.sourceKey);
  });

  it('a MONTHLY run never resolves a quarterly rule (its KPI is not even listed)', async () => {
    mockPrisma.pointsRule.findMany.mockResolvedValue([{ kpiCode: 'BSC_CASES', evaluationBasis: 'QUARTER' }]);
    load({ W1: [[1000, 1000, 10]] });
    const p = await service.previewCompute(admin, { period: '2026-10' });
    expect(p.rows).toEqual([]);
    expect(p.quarter).toBeUndefined();
    expect(mockEngine.getActiveForAttachment).not.toHaveBeenCalled();
  });

  it('direct credit: batch filed under the quarter’s LAST month with the quarter key; a repeat is an idempotent hit', async () => {
    load({ W1: [[1000, 1000, 10], [1600, 1000, 20], [1150, 1000, 30]] });
    const first = await service.commitCompute(admin, { period: '2026-Q3' });
    const [, dto, source] = mockCredits.createBatch.mock.calls[0];
    expect(dto).toMatchObject({ period: '2026-12', totalPoints: 275, totalOutlets: 1 });
    expect(dto.rows[0]).toMatchObject({ outletId: 'W1', amount: 275, narration: 'Consistency bonus Oct–Dec 2026' });
    expect(source).toEqual({ kind: 'POINTS_ENGINE_QUARTER:2026-Q3', key: first.sourceKey });
    expect(first.idempotentHit).toBe(false);
    expect(mockPrisma.creditBatch.count).toHaveBeenCalledWith({ where: { clientId: 'bajaj', period: '2026-12', id: { not: 'b1' } } });

    mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1' });
    const again = await service.commitCompute(admin, { period: '2026-Q3', expectedKey: first.sourceKey });
    expect(again.sourceKey).toBe(first.sourceKey);
    expect(again.idempotentHit).toBe(true);
    expect(mockCredits.createBatch.mock.calls[1][2]).toEqual({ kind: 'POINTS_ENGINE_QUARTER:2026-Q3', key: first.sourceKey });
  });

  it('credit-upload file: title names the quarter + the month to upload under; narration cell names the quarter', async () => {
    load({ W1: [[1000, 1000, 10], [1000, 1000, 10], [1000, 1000, 10]] });
    const p = await service.previewCompute(admin, { period: '2026-Q3' });
    const buf = await collectXlsx(async (w) => void (await writeCreditUploadXlsx(p, w)));
    const wb = XLSX.read(buf, { type: 'buffer' });
    const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    expect(String(aoa[0][0])).toMatch(/Oct–Dec 2026 \(Q3 FY2026-27\) — upload under Dec 2026/);
    expect(aoa[1]).toEqual(['Outlet ID', 'Outlet Name', 'BSC Consistency', 'BSC Consistency Narration']);
    expect(aoa[2]).toEqual(['W1', 'Outlet W1', 150, 'Consistency bonus Oct–Dec 2026']);
  });

  it('simulator: a quarterly rule takes 3 months of test values (and refuses fewer)', () => {
    const r = bscRow();
    const dto = {
      attachsTo: r.attachsTo, output: r.output, rounding: r.rounding, inputs: r.inputs, pipeline: r.pipeline,
      evaluationBasis: 'QUARTER',
    } as never as Parameters<PointsComputeService['simulate']>[1];
    const months = [
      { label: 'Oct 2026', achievements: { TOTAL: 1500, BSC_CASES: 10 }, targets: { TOTAL: 1000 } },
      { label: 'Nov 2026', achievements: { TOTAL: 2000, BSC_CASES: 21 }, targets: { TOTAL: 1000 } },
      { label: 'Dec 2026', achievements: { TOTAL: 2400, BSC_CASES: 33 }, targets: { TOTAL: 1000 } },
    ];
    const ok = service.simulate(admin, { ...dto, context: { segment: { outletType: 'WS' }, quarterLabel: 'Oct–Dec 2026', months } });
    expect(ok.valid).toBe(true);
    expect(ok.outcome).toMatchObject({ status: 'OK', points: 186 }); // 37.1 × 5 = 185.5 → half-up once
    const bad = service.simulate(admin, { ...dto, context: { segment: { outletType: 'WS' }, months: months.slice(0, 2) } });
    expect(bad).toEqual({ valid: false, errors: ['A quarterly rule needs test values for all 3 months of the quarter.'] });
  });
  it('AUDIT 6: a quarter whose months have not all ended → preview names them; export / commit refused', async () => {
    jest.setSystemTime(new Date('2026-11-26T06:00:00.000Z')); // Nov 2026: Nov + Dec not ended
    load({ W1: [[1000, 1000, 10], [1000, 1000, 10], [1000, 1000, 10]] });
    const p = await service.previewCompute(admin, { period: '2026-Q3' });
    expect(p.quarter!.openMonths).toEqual(['Nov 2026', 'Dec 2026']);
    await expect(service.commitCompute(admin, { period: '2026-Q3' })).rejects.toThrow(/Oct–Dec 2026 is not finished — Nov 2026, Dec 2026 have not ended yet/);
    expect(mockCredits.createBatch).not.toHaveBeenCalled();
    expect(() => PointsComputeService.assertMoneyRunAllowed(p, admin, null)).toThrow(/not finished/);
  });

  it('AUDIT 3: imported months (before the first live month) → red-banner data; refused unless a GIFSY admin confirms; audited BEFORE the batch', async () => {
    mockSettings.getEffectiveSettings.mockResolvedValue({ pointsEngine: { enabled: true, directCreditEnabled: true, firstLiveMonth: '2026-11' } });
    mockSettings.getPointsEngineFirstLiveMonthUncached.mockResolvedValue('2026-11');
    load({ W1: [[1000, 1000, 10], [1600, 1000, 20], [1150, 1000, 30]] });
    const p = await service.previewCompute(admin, { period: '2026-Q3' });
    expect(p.importedMonths).toEqual(expect.objectContaining({ firstLiveMonth: '2026-11', months: ['2026-10'], monthLabels: ['Oct 2026'] }));
    expect(p.importedMonths!.confirmKey).toMatch(/^im_/);
    // A client admin can never release imported months.
    await expect(service.commitCompute(admin, { period: '2026-Q3', confirmImportedMonthsKey: p.importedMonths!.confirmKey })).rejects.toThrow(/Only a Gifsy admin/);
    const gifsy = { ...admin, role: 'GIFSY_ADMIN', assumed: true } as JwtPayload;
    await expect(service.commitCompute(gifsy, { period: '2026-Q3' })).rejects.toThrow(/imported from the old system/);
    await expect(service.commitCompute(gifsy, { period: '2026-Q3', confirmImportedMonthsKey: 'im_wrong' })).rejects.toThrow(/changed since you confirmed/);
    expect(mockCredits.createBatch).not.toHaveBeenCalled();
    await service.commitCompute(gifsy, { period: '2026-Q3', confirmImportedMonthsKey: p.importedMonths!.confirmKey });
    const audit = mockPrisma.auditLog.create.mock.calls.find((c) => c[0].data.entityType === 'POINTS_ENGINE_IMPORTED_MONTHS_CONFIRMED');
    expect(audit![0].data.metadata).toEqual(expect.objectContaining({ months: ['2026-10'], firstLiveMonth: '2026-11', ruleVersions: ['rule_bsc_q@2'] }));
    expect(mockPrisma.auditLog.create.mock.invocationCallOrder[0]).toBeLessThan(mockCredits.createBatch.mock.invocationCallOrder[0]);
  });

  it('AUDIT 3: no first live month set (every other tenant) → no imported-months data, no gate', async () => {
    load({ W1: [[1000, 1000, 10], [1000, 1000, 10], [1000, 1000, 10]] });
    const p = await service.previewCompute(admin, { period: '2026-Q3' });
    expect(p.importedMonths).toBeUndefined();
  });

  it('AUDIT 5: more than one quarterly version covering the quarter → ERROR row naming them (never a silent pick)', async () => {
    mockEngine.getQuarterRuleForAttachment.mockResolvedValue({ rule: null, conflict: 'More than one published quarterly rule version covers this quarter for BSC_CASES: a v1; a v2' });
    load({ W1: [[1000, 1000, 10], [1000, 1000, 10], [1000, 1000, 10]] });
    const p = await service.previewCompute(admin, { period: '2026-Q3' });
    expect(p.rows[0]).toMatchObject({ status: 'ERROR', reason: expect.stringMatching(/More than one published quarterly rule version/) });
  });

  it('AUDIT 5: an empty quarter run explains why (rule windows that miss the quarter)', async () => {
    mockPrisma.pointsRule.findMany
      .mockResolvedValueOnce([{ kpiCode: 'TOTAL', evaluationBasis: 'PERIOD_AGGREGATE' }]) // active KPIs: no quarterly rule overlaps
      .mockResolvedValueOnce([{ ruleId: 'rule_bsc_q', version: 1, kpiCode: 'BSC_CASES', effectiveFrom: new Date('2027-01-01T00:00:00.000Z'), effectiveTo: null }]);
    load({ W1: [[1000, 1000, 10], [1000, 1000, 10], [1000, 1000, 10]] });
    const p = await service.previewCompute(admin, { period: '2026-Q3' });
    expect(p.rows).toEqual([]);
    expect(p.emptyReason).toMatch(/No published quarterly rule is effective during Oct–Dec 2026.*BSC_CASES \(rule_bsc_q v1: 2027-01-01 → open-ended\).*on or before the quarter's first day/);
  });

  it('AUDIT 4: prior batches are named + classified; only the same quarter crediting the same field is a likely duplicate', async () => {
    load({ W1: [[1000, 1000, 10], [1600, 1000, 20], [1150, 1000, 30]] });
    mockPrisma.creditBatch.count.mockResolvedValue(3);
    mockPrisma.creditBatch.findMany
      .mockResolvedValueOnce([
        { id: 'm1', batchCode: 'CB-2026-12-001', sourceKind: 'POINTS_ENGINE' },
        { id: 'u1', batchCode: 'CB-2026-12-002', sourceKind: null },
        { id: 'q0', batchCode: 'CB-2026-12-003', sourceKind: 'POINTS_ENGINE_QUARTER:2026-Q3' },
      ])
      .mockResolvedValueOnce([{ id: 'q0', rows: [{ fieldId: 'cf_bsc', amount: 275 }] }]);
    const r = await service.commitCompute(admin, { period: '2026-Q3' });
    expect(r.priorBatches).toEqual([
      { batchCode: 'CB-2026-12-001', kind: 'MONTHLY_ENGINE', likelyDuplicate: false },
      { batchCode: 'CB-2026-12-002', kind: 'UPLOAD', likelyDuplicate: false },
      { batchCode: 'CB-2026-12-003', kind: 'QUARTER_ENGINE', quarter: 'Oct–Dec 2026', likelyDuplicate: true },
    ]);
    expect(r.quarter).toEqual({ key: '2026-Q3', label: 'Oct–Dec 2026' });
  });
});
