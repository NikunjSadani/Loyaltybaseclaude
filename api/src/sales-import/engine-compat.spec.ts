/**
 * K-9 — Engine-compat proof (NO engine edits). The EXACT plan §9 BSC rule JSON (fieldId 'f1') runs through the REAL
 * points engine — validateRule / evaluateRule, PointsComputeService.simulate, and PointsComputeService.previewCompute —
 * against OutletSalesRecord.kpiValues produced the way a Sales Import apply produces them (computeOutletKpis over the
 * import's aggregates, merged into the existing row with the apply's `kpiValues - owned || new`).
 */
import type { PointsRule } from '@prisma/client';
import { evaluateRule, validateRule } from '../points-engine/points-engine.helper';
import { PointsComputeService } from '../points-engine/points-compute.service';
import type { PointsRuleConfig } from '../points-engine/points-engine.types';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { computeOutletKpis, type KpiAgg, type KpiDefLite } from './kpi/sales-kpi.helper';

// ── The §9 rule, verbatim (fieldId placeholder → 'f1') ─────────────────────────
const RULE_JSON = {
  effectiveFrom: '2026-11-01',
  effectiveTo: null,
  attachsTo: { scope: 'program_kpi', program: null, programCategory: null, kpiCode: 'BSC CASES' },
  evaluationBasis: 'PERIOD_AGGREGATE',
  output: { awardType: 'POINTS', fieldId: 'f1' },
  rounding: { mode: 'floor', scale: 0 },
  inputs: [
    { ref: 'cases', kpiCode: 'BSC CASES', type: 'number', nullAs: 'zero' },
    { ref: 'salesPct', source: 'pct:MONTH TARGET', type: 'number', nullAs: 'skipRule' },
  ],
  pipeline: [
    { type: 'segmentFilter', id: 'onlyWholesalers', field: 'outletType', allow: ['WHOLESALER'], onFail: 'zero' },
    { type: 'gate', id: 'salesTargetMet', when: { op: 'gte', left: { var: 'salesPct' }, right: { lit: 100 } }, onFail: 'zero' },
    { type: 'formula', id: 'perWholeCase', expr: 'floor(cases) * 10', output: 'add' },
    { type: 'cap', id: 'monthlyCap', max: 50000 },
  ],
} as const;

const CONFIG = {
  ruleId: 'bsc',
  tenantId: 't1',
  version: 1,
  status: 'published',
  ...RULE_JSON,
} as unknown as PointsRuleConfig;

// ── The importer-owned definitions (Appendix A, neutral of any real data) ──────
const DEFS: KpiDefLite[] = [
  { kpiCode: 'MONTH TARGET', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [] },
  { kpiCode: 'BSC CASES', measure: 'QUANTITY', filter: {}, outletTypes: ['WHOLESALER'], programs: [] },
];
const OWNED = DEFS.map((d) => d.kpiCode);
const line = (amountRupees: number, cases: number): KpiAgg => ({
  dims: { brand: 'X', skuGroup: '500' },
  amountPaise: BigInt(Math.round(amountRupees * 100)),
  qtyMicro: BigInt(Math.round(cases * 1e6)),
  lines: 1,
});
/** What the apply's SQL does to a row: (existing - owned) || new. */
const mergeLikeApply = (existing: Record<string, unknown>, fresh: Record<string, number>) => {
  const kept = Object.fromEntries(Object.entries(existing).filter(([k]) => !OWNED.includes(k)));
  return { ...kept, ...fresh };
};

interface Case {
  code: string;
  type: string;
  lines: KpiAgg[];
  target: number | null;
  expect: { status: 'OK'; points: number };
}
const CASES: Case[] = [
  // 37.9 cases (split over two invoice lines incl. a return), ₹ 120% of target → floor(37.9) × 10 = 370
  { code: 'WS_OK', type: 'WHOLESALER', lines: [line(130000, 40), line(-10000, -2.1)], target: 100000, expect: { status: 'OK', points: 370 } },
  // ₹ 99% → gate fails → 0
  { code: 'WS_99', type: 'WHOLESALER', lines: [line(99000, 37.9)], target: 100000, expect: { status: 'OK', points: 0 } },
  // no MONTH TARGET target → salesPct null → nullAs 'skipRule' = the rule contributes 0 (engine: OK / 0, not an error)
  { code: 'WS_NOTGT', type: 'WHOLESALER', lines: [line(120000, 37.9)], target: null, expect: { status: 'OK', points: 0 } },
  // not a wholesaler (BSC CASES is out of its scope → key omitted → nullAs zero) → segmentFilter → 0
  { code: 'SSS_1', type: 'SSS', lines: [line(120000, 37.9)], target: 100000, expect: { status: 'OK', points: 0 } },
  // 9000 cases → 90000 → capped 50000
  { code: 'WS_CAP', type: 'WHOLESALER', lines: [line(500000, 9000)], target: 100000, expect: { status: 'OK', points: 50000 } },
];

// Importer-written rows (the existing row also carries a MANUAL key and a stale owned value that must be replaced).
const ROWS = CASES.map((c) => ({
  outletCode: c.code,
  kpiValues: mergeLikeApply({ 'MANUAL KPI': 5, 'BSC CASES': 1 }, computeOutletKpis(c.lines, DEFS, { outletType: c.type, program: null })),
}));

describe('K-9 — the §9 BSC rule through the real engine, on importer-written rows', () => {
  it('importer rows look as expected (scope-omitted key, merged manual key, fractional cases)', () => {
    const ws = ROWS.find((r) => r.outletCode === 'WS_OK')!.kpiValues;
    expect(ws).toEqual({ 'MANUAL KPI': 5, 'MONTH TARGET': 120000, 'BSC CASES': 37.9 });
    const sss = ROWS.find((r) => r.outletCode === 'SSS_1')!.kpiValues;
    expect('BSC CASES' in sss).toBe(false); // stale owned value stripped, out-of-scope key omitted
  });

  it('validateRule(§9 JSON) → []', () => {
    expect(validateRule(CONFIG)).toEqual([]);
  });

  it.each(CASES)('evaluateRule: $code → $expect.status $expect.points', (c) => {
    const row = ROWS.find((r) => r.outletCode === c.code)!;
    const out = evaluateRule(CONFIG, {
      achievements: row.kpiValues as Record<string, number>,
      targets: c.target === null ? {} : { 'MONTH TARGET': c.target },
      segment: { outletType: c.type },
    });
    expect(out.status).toBe(c.expect.status);
    if (c.expect.points !== undefined && out.status === 'OK') expect(out.points).toBe(c.expect.points);
  });

  const user: JwtPayload = { sub: 'u', role: 'CLIENT_ADMIN', clientId: 't1', phone: '', name: 'A' };

  it('PointsComputeService.simulate (the /v1/admin/points-compute/simulate service) gives the same answers', () => {
    const svc = new PointsComputeService({} as never, {} as never, {} as never, {} as never);
    for (const c of CASES) {
      const row = ROWS.find((r) => r.outletCode === c.code)!;
      const res = svc.simulate(user, {
        ...(RULE_JSON as unknown as Parameters<PointsComputeService['simulate']>[1]),
        context: {
          achievements: row.kpiValues as Record<string, number>,
          targets: c.target === null ? {} : { 'MONTH TARGET': c.target },
          segment: { outletType: c.type },
        },
      });
      expect(res.valid).toBe(true);
      expect(res.outcome?.status).toBe(c.expect.status);
      if (c.expect.points !== undefined && res.outcome?.status === 'OK') expect(res.outcome.points).toBe(c.expect.points);
    }
  });

  it('PointsComputeService.previewCompute over the importer-written OutletSalesRecord rows (no engine edits)', async () => {
    const rule = {
      id: 'r1', ruleId: 'bsc', clientId: 't1', version: 1, status: 'published',
      effectiveFrom: new Date('2026-11-01T00:00:00.000Z'), effectiveTo: null, evaluationBasis: 'PERIOD_AGGREGATE',
      attachsTo: RULE_JSON.attachsTo, output: RULE_JSON.output, rounding: RULE_JSON.rounding,
      inputs: RULE_JSON.inputs, pipeline: RULE_JSON.pipeline,
      kpiCode: 'BSC CASES', program: null, programCategory: null, createdAt: new Date(), updatedAt: new Date(), createdBy: 'u',
    } as unknown as PointsRule;
    const prisma = {
      pointsRule: { findMany: jest.fn(async () => [{ kpiCode: 'BSC CASES' }]) },
      outlet: {
        findMany: jest.fn(async () =>
          CASES.map((c) => ({ outletCode: c.code, name: c.code, programName: null, programCategory: null, metro: null, outletType: { code: c.type } }))),
      },
      outletSalesRecord: { findMany: jest.fn(async () => ROWS) },
      outletTarget: {
        findMany: jest.fn(async () =>
          CASES.filter((c) => c.target !== null).map((c) => ({ outletCode: c.code, targetValues: { 'MONTH TARGET': c.target } }))),
      },
      creditField: { findMany: jest.fn(async () => [{ id: 'f1', name: 'BSC Points', isActive: true, outletTypeAwards: { WHOLESALER: 'POINTS', SSS: 'POINTS' } }]) },
    };
    const svc = new PointsComputeService(
      prisma as never,
      { getActiveForAttachment: jest.fn(async () => rule) } as never,
      { getEffectiveSettings: jest.fn(async () => ({ pointsEngine: { enabled: true, directCreditEnabled: false } })) } as never,
      {} as never,
    );
    const preview = await svc.previewCompute(user, { period: '2026-11' });
    const by = Object.fromEntries(preview.rows.map((r) => [r.outletCode, r]));
    for (const c of CASES) {
      expect(by[c.code].status).toBe(c.expect.status);
      if (c.expect.status === 'OK') expect(by[c.code].points).toBe(c.expect.points);
    }
    expect(by.WS_OK.achievement).toBe(37.9);
    expect(preview.totalPoints).toBe(370 + 50000);
    expect(preview.counts).toEqual({ total: 5, ok: 5, skip: 0, error: 0, noRule: 0 });
  });
});
