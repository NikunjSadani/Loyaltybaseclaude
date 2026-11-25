/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * APPLIES-TO (platform/docs/plans/APPLIES-TO-TARGETING-PLAN.md §4, D1, D2, D3, D8) — WP-A targets coverage:
 *   • template golden: an unscoped tenant (Deoleo) gets a template BYTE-IDENTICAL to the pre-APPLIES-TO
 *     one (sha256 pinned from the pre-change code at 7b3bb712);
 *   • scoped template: Program / Sub-Program info columns + `N/A` in out-of-scope value cells — incl. a
 *     LEGACY single-outlet-type tenant (OWNER DECISION 2026-11-12: a legacy single type is a REAL scope);
 *   • parser: N/A round trip, out-of-scope numeric cell IGNORED (row kept, remark, ignoredOutOfScope);
 *   • uploads: ignoredOutOfScope present ONLY for a tenant with a scoped KPI (absent when all unscoped),
 *     out-of-scope values never persisted;
 *   • upsertKpi: arrays, legacy outletType, validation 400s, canonicalisation, no-op carry, AuditLog only on change;
 *   • scope-options / scope-count (repeated params); getPace EXCLUDES out-of-scope pairs (scoped tenants only).
 */
import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import {
  TargetsService,
  kpiScopeEnforced,
  mergeScopeOptions,
} from './targets.service';
import {
  targetTemplateLayout,
  parseTargetUploadBuffer,
  KpiDefLike,
  OutletLike,
  OUT_OF_SCOPE_CELL,
  TemplateScopeOptions,
} from './targets.helpers';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ACHIEVEMENTS_TEMPLATE_KIND, TARGETS_TEMPLATE_KIND } from '../exports/kinds/batch2/targets.kinds';
import { ctxFor, expectSameWorkbook, renderKind, renderLayoutSync } from '../exports/kinds/batch2/parity.support-spec';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** The template layout through the old SheetJS rendering (byte-comparable with the pre-APPLIES-TO golden). */
const generateTargetTemplateBuffer = (kpis: KpiDefLike[], months: string[], outlets: OutletLike[], opts?: { scope?: TemplateScopeOptions }) =>
  renderLayoutSync(targetTemplateLayout(kpis, months, opts), outlets);

// ── Golden fixture (identical to the capture run against the PRE-change code at 7b3bb712) ──────────
const KPIS: KpiDefLike[] = [
  { code: 'MONTH_TGT', label: 'Month Target', isPrimary: true, hasNameOverride: false, nameOverrideLabel: null, order: 1, enabled: true },
  { code: 'FOCUS_PACK_1', label: 'Focus Pack - 1', isPrimary: false, hasNameOverride: true, nameOverrideLabel: 'Focus Pack 1 Name', order: 2, enabled: true },
  { code: 'CONSISTENCY', label: 'Consistency Target', isPrimary: false, hasNameOverride: false, nameOverrideLabel: null, order: 5, enabled: true },
];
const OUTLETS: OutletLike[] = [
  { outletCode: 'O1', name: 'Alpha Stores', outletType: 'RETAILER' },
  { outletCode: 'O2', name: 'Beta Wholesale', outletType: 'WHOLESALER' },
  { outletCode: 'O3', name: 'Gamma', outletType: 'SSS' },
];
/** sha256 of generateTargetTemplateBuffer(KPIS, ['2025-07','2025-08'], OUTLETS) BEFORE the APPLIES-TO change. */
const GOLDEN_TARGET_2M = '4fe5ed4e7cd59231c4e22d3b48a2ea45e1902dc63d72c956445cb0586ce3ce27';
/** sha256 of generateTargetTemplateBuffer(KPIS, ['2025-06'], OUTLETS) BEFORE the APPLIES-TO change. */
const GOLDEN_ACH_1M = 'de3390851cb66b7ec6fe7137e3cea8c1aa4bfac7edb764e2b4fe169b475a5b21';

const readAoa = (buf: Buffer) => {
  const wb = XLSX.read(buf, { type: 'buffer' });
  // Blank template cells are written as '' (same as the unscoped template); normalise to null for readability.
  return XLSX.utils
    .sheet_to_json<(string | number | null)[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null })
    .map((r) => r.map((c) => (c === '' ? null : c)));
};
const writeAoa = (aoa: unknown[][]) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Targets');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};

/** A writable (future) month, RELATIVE to now — never a hardcoded date. */
const NEXT_MONTH = (() => {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
})();

// ─── Pure helpers ───────────────────────────────────────────────────────────────────────────

describe('APPLIES-TO template helpers (D2)', () => {
  it('GOLDEN: no scope option → byte-identical to the pre-change template (2 months + 1 month)', () => {
    expect(sha(generateTargetTemplateBuffer(KPIS, ['2025-07', '2025-08'], OUTLETS))).toBe(GOLDEN_TARGET_2M);
    expect(sha(generateTargetTemplateBuffer(KPIS, ['2025-06'], OUTLETS))).toBe(GOLDEN_ACH_1M);
    // outlets carrying program facets do not change the unscoped layout either
    const withFacets = OUTLETS.map((o) => ({ ...o, program: 'Gold', subProgram: 'Tier A' }));
    expect(sha(generateTargetTemplateBuffer(KPIS, ['2025-07', '2025-08'], withFacets))).toBe(GOLDEN_TARGET_2M);
  });

  it('scoped: Program / Sub-Program follow Outlet Type; out-of-scope VALUE cells = N/A; name cells blank', () => {
    const outlets = [
      { ...OUTLETS[0], program: 'Gold', subProgram: 'Tier A' },
      { ...OUTLETS[1], program: null, subProgram: null },
    ];
    // FOCUS_PACK_1 only applies to O1; CONSISTENCY only to O2
    const inScope = (o: OutletLike, code: string) =>
      code === 'FOCUS_PACK_1' ? o.outletCode === 'O1' : code === 'CONSISTENCY' ? o.outletCode === 'O2' : true;
    const aoa = readAoa(generateTargetTemplateBuffer(KPIS, ['2025-07'], outlets, { scope: { isInScope: inScope } }));
    expect(aoa[1]).toEqual([
      'Outlet ID', 'Outlet Name', 'Outlet Type', 'Program', 'Sub-Program',
      'Month Target', 'Focus Pack - 1', 'Focus Pack 1 Name', 'Consistency Target',
    ]);
    expect(aoa[0][5]).toBe("Jul '25 Target"); // month block starts after the info columns
    expect(aoa[2]).toEqual(['O1', 'Alpha Stores', 'RETAILER', 'Gold', 'Tier A', null, null, null, OUT_OF_SCOPE_CELL]);
    expect(aoa[3]).toEqual(['O2', 'Beta Wholesale', 'WHOLESALER', null, null, null, OUT_OF_SCOPE_CELL, null, null]);
  });
});

describe('APPLIES-TO parser (D1/D2)', () => {
  const known = new Set(['O1', 'O2']);
  const outlets = [
    { ...OUTLETS[0], program: 'Gold', subProgram: 'Tier A' },
    { ...OUTLETS[1], program: 'Silver', subProgram: null },
  ];
  const inScopeO = (o: OutletLike, code: string) => !(code === 'CONSISTENCY' && o.outletCode === 'O2');
  const inScopeC = (oc: string, code: string) => !(code === 'CONSISTENCY' && oc === 'O2');

  /** Fill the scoped template: every non-N/A value cell gets a number; O2's N/A CONSISTENCY cell optionally overwritten. */
  const filled = (overwriteNA: number | null) => {
    const aoa = readAoa(generateTargetTemplateBuffer(KPIS, [NEXT_MONTH], outlets, { scope: { isInScope: inScopeO } }));
    aoa[2][5] = 10; aoa[2][6] = 11; aoa[2][7] = 'Diwali'; aoa[2][8] = 12;
    aoa[3][5] = 20; aoa[3][6] = 21;
    if (overwriteNA !== null) aoa[3][8] = overwriteNA;
    return writeAoa(aoa);
  };

  it('N/A round trip: N/A cells and the info columns are ignored; nothing counted as ignored', () => {
    const r = parseTargetUploadBuffer(filled(null), KPIS, known, { scope: { isInScope: inScopeC } });
    expect(r.acceptedTargets[NEXT_MONTH]).toEqual({
      O1: { MONTH_TGT: 10, FOCUS_PACK_1: 11, CONSISTENCY: 12, __names: { FOCUS_PACK_1: 'Diwali' } },
      O2: { MONTH_TGT: 20, FOCUS_PACK_1: 21 },
    });
    expect(r.summary).toEqual({ total: 2, accepted: 2, rejected: 0, ignoredOutOfScope: 0 });
    expect(r.rows.map((x) => x.remarks)).toEqual(['', '']);
  });

  it('a NUMBER typed into an out-of-scope cell is IGNORED; the row is kept with a remark; counted', () => {
    const r = parseTargetUploadBuffer(filled(99), KPIS, known, { scope: { isInScope: inScopeC } });
    expect(r.acceptedTargets[NEXT_MONTH].O2).toEqual({ MONTH_TGT: 20, FOCUS_PACK_1: 21 });
    const o2 = r.rows.find((x) => x.outletCode === 'O2')!;
    expect(o2.status).toBe('accepted');
    expect(o2.remarks).toBe('Ignored value(s) for KPI(s) not applicable to this outlet: CONSISTENCY');
    expect(r.summary.ignoredOutOfScope).toBe(1);
  });

  it('a row whose ONLY values are out of scope is skipped (kept in rows) with the ignored remark', () => {
    const aoa = readAoa(generateTargetTemplateBuffer(KPIS, [NEXT_MONTH], outlets, { scope: { isInScope: inScopeO } }));
    aoa.splice(2, 1); // drop O1
    aoa[2][8] = 5; // O2 CONSISTENCY (out of scope)
    const r = parseTargetUploadBuffer(writeAoa(aoa), KPIS, known, { scope: { isInScope: inScopeC } });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].status).toBe('skipped_blank');
    expect(r.rows[0].remarks).toMatch(/^No applicable KPI values — row skipped\. Ignored value\(s\).*CONSISTENCY$/);
    expect(r.acceptedTargets).toEqual({});
    expect(r.summary.ignoredOutOfScope).toBe(1);
  });

  it('without a scope option the parser is unchanged: N/A is silently non-numeric, numbers are kept, count 0', () => {
    const r = parseTargetUploadBuffer(filled(99), KPIS, known);
    expect(r.acceptedTargets[NEXT_MONTH].O2).toEqual({ MONTH_TGT: 20, FOCUS_PACK_1: 21, CONSISTENCY: 99 });
    expect(r.summary.ignoredOutOfScope).toBe(0);
    const r2 = parseTargetUploadBuffer(filled(null), KPIS, known);
    expect(r2.acceptedTargets[NEXT_MONTH].O2).toEqual({ MONTH_TGT: 20, FOCUS_PACK_1: 21 });
    expect(r2.rows[1].remarks).toBe('');
  });
});

describe('kpiScopeEnforced / mergeScopeOptions', () => {
  it('ANY non-empty scope enforces (incl. legacy single type); only an all-unscoped KPI set does not', () => {
    expect(kpiScopeEnforced([{ outletType: null }, { outletTypes: [], programs: [], subPrograms: [] }, { outletType: '  ' }])).toBe(false);
    expect(kpiScopeEnforced([])).toBe(false);
    expect(kpiScopeEnforced([{ outletType: null }, { outletType: 'SSS' }])).toBe(true); // legacy column only (pre-backfill)
    expect(kpiScopeEnforced([{ outletTypes: ['SSS'] }])).toBe(true); // one type (post-backfill)
    expect(kpiScopeEnforced([{ outletTypes: ['SSS', 'WHOLESALER'] }])).toBe(true);
    expect(kpiScopeEnforced([{ programs: ['Gold'] }])).toBe(true);
    expect(kpiScopeEnforced([{ subPrograms: ['Tier A'] }])).toBe(true);
    expect(kpiScopeEnforced([{ outletTypes: ['SSS'], programs: ['Gold'] }])).toBe(true);
  });

  it('settings first (settings spelling) then live-only values (most common spelling, sorted)', () => {
    expect(
      mergeScopeOptions(['Trade Loyalty', 'Gold Programme', ' '], [
        { value: 'GOLD PROGRAMME', count: 50 },
        { value: 'bajaj elite', count: 3 },
        { value: 'Bajaj Elite', count: 7 },
        { value: 'Alpha', count: 1 },
        { value: null, count: 9 },
        { value: '  ', count: 2 },
      ]),
    ).toEqual([
      { value: 'Trade Loyalty', inSettings: true },
      { value: 'Gold Programme', inSettings: true },
      { value: 'Alpha', inSettings: false },
      { value: 'Bajaj Elite', inSettings: false },
    ]);
  });
});

// ─── Service ─────────────────────────────────────────────────────────────────────────────────

const admin: JwtPayload = { sub: 'admin1', role: 'CLIENT_ADMIN', clientId: 't1', phone: '', name: '' };

const kpiRow = (k: KpiDefLike, scope: Record<string, unknown> = {}) => ({
  id: `id-${k.code}`, clientId: 't1', unit: 'cases', rollup: 'SUM', createdAt: new Date(), updatedAt: new Date(),
  outletType: null, outletTypes: [], programs: [], subPrograms: [],
  ...k, ...scope,
});
const outletRow = (o: OutletLike & { program?: string | null; subProgram?: string | null }) => ({
  id: `oid-${o.outletCode}`, outletCode: o.outletCode, name: o.name,
  programName: o.program ?? null, programCategory: o.subProgram ?? null,
  outletType: { code: o.outletType },
});

function makeService() {
  const tx = {
    kpiDef: { upsert: jest.fn<any, any[]>(async (a: { create: { code: string } }) => ({ id: `id-${a.create.code}`, ...a.create })), updateMany: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    kpiDef: { findMany: jest.fn(), findFirst: jest.fn() },
    outlet: { findMany: jest.fn(), groupBy: jest.fn(), count: jest.fn() },
    outletTypeClientConfig: { findMany: jest.fn().mockResolvedValue([{ outletType: { code: 'SSS' } }, { outletType: { code: 'WHOLESALER' } }]) },
    outletTarget: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn<any, any[]>(async () => ({})) },
    outletSalesRecord: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn<any, any[]>(async () => ({})) },
    targetUploadBatch: { create: jest.fn().mockResolvedValue({ id: 'tb1' }) },
    salesUploadBatch: { create: jest.fn().mockResolvedValue({ id: 'sb1' }) },
    salesKpiDefinition: { findMany: jest.fn().mockResolvedValue([]) },
    $executeRaw: jest.fn<any, any[]>(async () => 1),
    $transaction: jest.fn((arg: unknown) => (Array.isArray(arg) ? Promise.all(arg) : (arg as (t: typeof tx) => unknown)(tx))),
  };
  // groupBy: programName → live programs, programCategory → live sub-programs
  prisma.outlet.groupBy.mockImplementation(async ({ by }: { by: string[] }) =>
    by[0] === 'programName'
      ? [{ programName: 'bajaj elite', _count: { _all: 2 } }, { programName: 'Bajaj Elite', _count: { _all: 9 } }]
      : [{ programCategory: 'Tier A', _count: { _all: 4 } }],
  );
  const settings = {
    getEffectiveSettings: jest.fn().mockResolvedValue({ outletPrograms: ['Gold Programme'], outletCategories: ['Premium'] }),
    getOutletTypes: jest.fn().mockResolvedValue([
      { code: 'SSS', name: 'Super Stockist', displayName: null, label: 'Super Stockist' },
      { code: 'WHOLESALER', name: 'Wholesaler', displayName: 'WS', label: 'WS' },
    ]),
  };
  // The target-upload apply runs in ONE interactive transaction: give its tx the same target-write mocks.
  Object.assign(tx, {
    outletTarget: prisma.outletTarget,
    targetUploadBatch: { update: jest.fn().mockResolvedValue({}) },
    $executeRaw: prisma.$executeRaw,
    auditLog: { create: tx.auditLog.create, findFirst: jest.fn().mockResolvedValue(null) },
  });
  const notifications = { targetsUploaded: jest.fn() };
  const service = new TargetsService(prisma as never, notifications as never, settings as never);
  return { service, prisma, tx, settings };
}

describe('Template export kinds — APPLIES-TO templates (D2 golden + scoped)', () => {
  // The templates are now the 'targets-template' / 'achievements-template' export kinds (streamed). The streamed bytes
  // differ from SheetJS's, so the golden is pinned in two steps: the layout renders byte-identically to the
  // pre-APPLIES-TO golden (test above), and the streamed file is cell-for-cell identical to that render.
  const targetTemplate = async (prisma: unknown, months: string) =>
    (await renderKind(TARGETS_TEMPLATE_KIND, ctxFor(admin, prisma), TARGETS_TEMPLATE_KIND.parseParams({ months }, admin))).buffer;
  const achievementTemplate = async (prisma: unknown, month: string) =>
    (await renderKind(ACHIEVEMENTS_TEMPLATE_KIND, ctxFor(admin, prisma), ACHIEVEMENTS_TEMPLATE_KIND.parseParams({ month }, admin))).buffer;

  it('GOLDEN: an UNSCOPED tenant (Deoleo) target + achievement templates are cell-identical to the golden layout', async () => {
    const { prisma } = makeService();
    prisma.kpiDef.findMany.mockResolvedValue(KPIS.map((k) => kpiRow(k)));
    prisma.outlet.findMany.mockResolvedValue(OUTLETS.map(outletRow));
    const goldenTarget = generateTargetTemplateBuffer(KPIS, ['2025-07', '2025-08'], OUTLETS);
    const goldenAch = generateTargetTemplateBuffer(KPIS, ['2025-06'], OUTLETS);
    expect(sha(goldenTarget)).toBe(GOLDEN_TARGET_2M);
    expect(sha(goldenAch)).toBe(GOLDEN_ACH_1M);
    expectSameWorkbook(await targetTemplate(prisma, '2025-07,2025-08'), goldenTarget);
    expectSameWorkbook(await achievementTemplate(prisma, '2025-06'), goldenAch);
  });

  it('LEGACY single-outlet-type tenant is ENFORCED: scoped layout + N/A on out-of-type cells (target + achievement)', async () => {
    const { prisma } = makeService();
    prisma.kpiDef.findMany.mockResolvedValue([
      kpiRow(KPIS[0]),
      kpiRow(KPIS[1], { outletType: 'SSS', outletTypes: ['SSS'] }), // post-backfill shape
      kpiRow(KPIS[2], { outletType: 'WHOLESALER' }), // pre-backfill shape (arrays empty)
    ]);
    prisma.outlet.findMany.mockResolvedValue(OUTLETS.map((o) => outletRow({ ...o, program: 'Gold', subProgram: 'Tier A' })));
    const tpl = await targetTemplate(prisma, '2025-07');
    const aoa = readAoa(tpl);
    expect(aoa[1]).toEqual([
      'Outlet ID', 'Outlet Name', 'Outlet Type', 'Program', 'Sub-Program',
      'Month Target', 'Focus Pack - 1', 'Focus Pack 1 Name', 'Consistency Target',
    ]);
    // FOCUS_PACK_1 → SSS only; CONSISTENCY → WHOLESALER only; MONTH_TGT unscoped
    expect(aoa[2]).toEqual(['O1', 'Alpha Stores', 'RETAILER', 'Gold', 'Tier A', null, 'N/A', null, 'N/A']);
    expect(aoa[3]).toEqual(['O2', 'Beta Wholesale', 'WHOLESALER', 'Gold', 'Tier A', null, 'N/A', null, null]);
    expect(aoa[4]).toEqual(['O3', 'Gamma', 'SSS', 'Gold', 'Tier A', null, null, null, 'N/A']);
    const ach = readAoa(await achievementTemplate(prisma, '2025-06'));
    expect(ach[1].slice(3, 5)).toEqual(['Program', 'Sub-Program']);
    expect(ach[2]).toEqual(['O1', 'Alpha Stores', 'RETAILER', 'Gold', 'Tier A', null, 'N/A', null, 'N/A']);
  });

  it('SCOPED tenant: info columns + N/A from the outlet CURRENT facets', async () => {
    const { prisma } = makeService();
    prisma.kpiDef.findMany.mockResolvedValue([
      kpiRow(KPIS[0]),
      kpiRow(KPIS[1], { programs: ['Gold'] }),
      kpiRow(KPIS[2], { outletTypes: ['SSS', 'WHOLESALER'], subPrograms: ['tier a'] }),
    ]);
    prisma.outlet.findMany.mockResolvedValue([
      outletRow({ ...OUTLETS[0], program: 'GOLD', subProgram: 'Tier A' }), // RETAILER
      outletRow({ ...OUTLETS[2], program: null, subProgram: 'Tier A' }), // SSS
    ]);
    const aoa = readAoa(await targetTemplate(prisma, '2025-07'));
    expect(aoa[1].slice(0, 5)).toEqual(['Outlet ID', 'Outlet Name', 'Outlet Type', 'Program', 'Sub-Program']);
    // O1: FOCUS in (program ci), CONSISTENCY out (type)
    expect(aoa[2]).toEqual(['O1', 'Alpha Stores', 'RETAILER', 'GOLD', 'Tier A', null, null, null, 'N/A']);
    // O3: FOCUS out (blank program, D4), CONSISTENCY in
    expect(aoa[3]).toEqual(['O3', 'Gamma', 'SSS', null, 'Tier A', null, 'N/A', null, null]);
  });
});

describe('TargetsService — APPLIES-TO uploads (D1)', () => {
  // Parse / write rules via the DIRECT apply of a tenant outside TargetsService.confirmRequired (the preview →
  // confirm gate itself is covered in targets.service.spec.ts).
  beforeEach(() => jest.spyOn(TargetsService, 'confirmRequired').mockReturnValue(false));
  afterEach(() => jest.restoreAllMocks());
  const upload =(rows: unknown[][], scoped: boolean) => {
    const row1 = scoped
      ? ['', '', '', '', '', `${NEXT_LABEL()}`, '']
      : ['', '', '', `${NEXT_LABEL()}`, ''];
    const row2 = scoped
      ? ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Program', 'Sub-Program', 'Month Target', 'Consistency Target']
      : ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Month Target', 'Consistency Target'];
    return { buffer: writeAoa([row1, row2, ...rows]), originalname: 'x.xlsx' } as Express.Multer.File;
  };
  function NEXT_LABEL() {
    const [y, m] = NEXT_MONTH.split('-');
    const abbr = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1];
    return `${abbr} '${y.slice(2)} Target`;
  }
  const two = [KPIS[0], KPIS[2]];

  it('UNSCOPED tenant: outlet select unchanged, nothing ignored, NO ignoredOutOfScope key (targets + achievements)', async () => {
    const { service, prisma } = makeService();
    prisma.kpiDef.findMany.mockResolvedValue(two.map((k) => kpiRow(k)));
    prisma.outlet.findMany.mockResolvedValue([outletRow(OUTLETS[1])]);
    const r = await service.uploadTargets(admin, upload([['O2', 'Beta', 'WHOLESALER', 5, 6]], false));
    expect(prisma.outlet.findMany.mock.calls[0][0].select).toEqual({ outletCode: true, name: true, outletType: { select: { code: true } } });
    expect('ignoredOutOfScope' in r).toBe(false);
    expect(rawWrites(prisma)).toEqual([{ table: 'outlet_targets', outletCode: 'O2', values: { MONTH_TGT: 5, CONSISTENCY: 6 }, carry: undefined }]);
    prisma.$executeRaw.mockClear();
    const a = await service.uploadAchievements(admin, upload([['O2', 'Beta', 'WHOLESALER', 5, 6]], false));
    expect('ignoredOutOfScope' in a).toBe(false);
  });

  it('LEGACY single-type tenant is ENFORCED: the out-of-type value is ignored + counted (targets + achievements)', async () => {
    const { service, prisma } = makeService();
    prisma.kpiDef.findMany.mockResolvedValue([kpiRow(KPIS[0]), kpiRow(KPIS[2], { outletType: 'SSS', outletTypes: ['SSS'] })]);
    prisma.outlet.findMany.mockResolvedValue([outletRow(OUTLETS[1])]); // WHOLESALER
    const r = await service.uploadTargets(admin, upload([['O2', 'Beta', 'WHOLESALER', '', '', 5, 6]], true));
    expect(r.ignoredOutOfScope).toBe(1);
    // Written via the carry-over statement: only the in-scope value, and the stored CONSISTENCY is carried.
    expect(rawWrites(prisma)).toEqual([{ table: 'outlet_targets', outletCode: 'O2', values: { MONTH_TGT: 5 }, carry: ['CONSISTENCY'] }]);
    // pre-backfill shape (legacy column only) enforces the same way
    prisma.$executeRaw.mockClear();
    prisma.kpiDef.findMany.mockResolvedValue([kpiRow(KPIS[0]), kpiRow(KPIS[2], { outletType: 'SSS' })]);
    const a = await service.uploadAchievements(admin, upload([['O2', 'Beta', 'WHOLESALER', '', '', 7, 8]], true));
    expect(a.ignoredOutOfScope).toBe(1);
    expect(rawWrites(prisma)).toEqual([{ table: 'outlet_sales_records', outletCode: 'O2', values: { MONTH_TGT: 7 }, carry: ['CONSISTENCY'] }]);
  });

  it('SCOPED tenant with nothing out of scope still reports ignoredOutOfScope: 0', async () => {
    const { service, prisma } = makeService();
    prisma.kpiDef.findMany.mockResolvedValue([kpiRow(KPIS[0]), kpiRow(KPIS[2], { outletTypes: ['WHOLESALER'] })]);
    prisma.outlet.findMany.mockResolvedValue([outletRow(OUTLETS[1])]);
    const r = await service.uploadTargets(admin, upload([['O2', 'Beta', 'WHOLESALER', '', '', 5, 6]], true));
    expect(r.ignoredOutOfScope).toBe(0);
  });

  it('SCOPED tenant targets: out-of-scope cell ignored, row kept + remark, not persisted, counted', async () => {
    const { service, prisma } = makeService();
    prisma.kpiDef.findMany.mockResolvedValue([kpiRow(KPIS[0]), kpiRow(KPIS[2], { programs: ['Gold'] })]);
    prisma.outlet.findMany.mockResolvedValue([
      outletRow({ ...OUTLETS[0], program: 'gold' }),
      outletRow({ ...OUTLETS[1], program: 'Silver' }),
    ]);
    const r = await service.uploadTargets(
      admin,
      upload([['O1', 'Alpha', 'RETAILER', 'gold', '', 1, 2], ['O2', 'Beta', 'WHOLESALER', 'Silver', '', 3, 4]], true),
    );
    expect(prisma.outlet.findMany.mock.calls[0][0].select).toEqual(
      expect.objectContaining({ programName: true, programCategory: true }),
    );
    expect(r.ignoredOutOfScope).toBe(1);
    expect(r.acceptedCount).toBe(2);
    // The ignored-value remark comes back as a WARNING row (memory-safety: accepted rows are not echoed).
    expect(r.warningRows.find((x) => x.outletCode === 'O2')!.remarks).toMatch(/CONSISTENCY/);
    expect(r.warningRows.find((x) => x.outletCode === 'O1')).toBeUndefined();
    // O1 (everything in scope) → the plain replace statement; O2 (CONSISTENCY out of scope) → its own statement that
    // writes the in-scope value and carries the stored CONSISTENCY over.
    expect(prisma.outletTarget.upsert).not.toHaveBeenCalled();
    expect(rawWrites(prisma)).toEqual([
      { table: 'outlet_targets', outletCode: 'O1', values: { MONTH_TGT: 1, CONSISTENCY: 2 }, carry: undefined },
      { table: 'outlet_targets', outletCode: 'O2', values: { MONTH_TGT: 3 }, carry: ['CONSISTENCY'] },
    ]);
  });

  it('SCOPED tenant achievements: same rule + ignoredOutOfScope on the response', async () => {
    const { service, prisma } = makeService();
    prisma.kpiDef.findMany.mockResolvedValue([kpiRow(KPIS[0]), kpiRow(KPIS[2], { outletTypes: ['SSS', 'RETAILER'] })]);
    prisma.outlet.findMany.mockResolvedValue([outletRow(OUTLETS[1])]); // WHOLESALER
    const r = await service.uploadAchievements(admin, upload([['O2', 'Beta', 'WHOLESALER', '', '', 7, 8]], true));
    expect(r.ignoredOutOfScope).toBe(1);
    expect(prisma.outletSalesRecord.upsert).not.toHaveBeenCalled();
    expect(rawWrites(prisma)).toEqual([{ table: 'outlet_sales_records', outletCode: 'O2', values: { MONTH_TGT: 7 }, carry: ['CONSISTENCY'] }]);
  });

  // ── OWNER DECISION (audit #3): a re-upload NEVER deletes stored out-of-scope values ─────────────
  describe('re-upload preserves stored out-of-scope values (mixed + all-out-of-scope rows)', () => {
    const scopedKpis = () => [kpiRow(KPIS[0]), kpiRow(KPIS[2], { programs: ['Gold'] })];
    const silverO2 = () => [outletRow({ ...OUTLETS[1], program: 'Silver' })];

    it('MIXED row (targets): the statement keeps the stored subset of every out-of-scope KPI, overlaid by the upload', async () => {
      const { service, prisma } = makeService();
      prisma.kpiDef.findMany.mockResolvedValue(scopedKpis());
      prisma.outlet.findMany.mockResolvedValue(silverO2());
      await service.uploadTargets(admin, upload([['O2', 'Beta', 'WHOLESALER', 'Silver', '', 3, 99]], true));
      expect(prisma.outletTarget.upsert).not.toHaveBeenCalled();
      const [call] = insertCalls(prisma);
      const sql = sqlText(call);
      expect(sql).toContain('ON CONFLICT ("clientId","outletCode","month") DO UPDATE SET');
      // stored subset (jsonb_each over the EXISTING row, keys = carry list) || EXCLUDED (the upload)
      expect(sql).toMatch(/jsonb_each\("outlet_targets"\."targetValues"\)[\s\S]*\|\| EXCLUDED\."targetValues"/);
      // custom names of carried KPIs survive too (merged under the uploaded names)
      expect(sql).toContain(`COALESCE("outlet_targets"."targetValues"->'__names', '{}'::jsonb)`);
      expect(sql).toContain(`jsonb_build_object('__names'`);
      // the ignored 99 is never written
      // Exact checks — NOT a substring over every bound string: values[0] is a random UUID, which contains
      // "99" ~10% of the time (same flake class as the UUID-'999' fix in targets.service.spec).
      const bound = sqlValues(call);
      expect(bound).not.toContain(99);
      expect(bound).not.toContain('99');
      const jsonParams = bound.filter((v): v is string => typeof v === 'string' && v.startsWith('{')).map((v) => JSON.parse(v));
      expect(jsonParams).toEqual([{ MONTH_TGT: 3 }]);
      expect(rawWrites(prisma)).toEqual([{ table: 'outlet_targets', outletCode: 'O2', values: { MONTH_TGT: 3 }, carry: ['CONSISTENCY'] }]);
    });

    it('MIXED row (achievements): same carry-over (no __names handling)', async () => {
      const { service, prisma } = makeService();
      prisma.kpiDef.findMany.mockResolvedValue(scopedKpis());
      prisma.outlet.findMany.mockResolvedValue(silverO2());
      await service.uploadAchievements(admin, upload([['O2', 'Beta', 'WHOLESALER', 'Silver', '', 3, 99]], true));
      const [call] = insertCalls(prisma);
      const sql = sqlText(call);
      expect(sql).toMatch(/jsonb_each\("outlet_sales_records"\."kpiValues"\)[\s\S]*\|\| EXCLUDED\."kpiValues"/);
      expect(sql).not.toContain('__names');
      expect(rawWrites(prisma)).toEqual([{ table: 'outlet_sales_records', outletCode: 'O2', values: { MONTH_TGT: 3 }, carry: ['CONSISTENCY'] }]);
    });

    it('ALL-OUT-OF-SCOPE row: nothing is written at all → the stored row is untouched (targets + achievements)', async () => {
      const { service, prisma } = makeService();
      prisma.kpiDef.findMany.mockResolvedValue(scopedKpis());
      prisma.outlet.findMany.mockResolvedValue(silverO2());
      const r = await service.uploadTargets(admin, upload([['O2', 'Beta', 'WHOLESALER', 'Silver', '', '', 99]], true));
      const a = await service.uploadAchievements(admin, upload([['O2', 'Beta', 'WHOLESALER', 'Silver', '', '', 99]], true));
      expect(r.ignoredOutOfScope).toBe(1);
      expect(a.ignoredOutOfScope).toBe(1);
      expect(r.savedCount).toBe(0);
      expect(insertCalls(prisma)).toHaveLength(0);
      expect(prisma.outletTarget.upsert).not.toHaveBeenCalled();
      expect(prisma.outletSalesRecord.upsert).not.toHaveBeenCalled();
    });

    it('importer-owned + out-of-scope codes are carried TOGETHER in one statement (achievements)', async () => {
      const { service, prisma } = makeService();
      prisma.salesKpiDefinition.findMany.mockResolvedValue([{ kpiCode: 'FOCUS_PACK_1' }]);
      prisma.kpiDef.findMany.mockResolvedValue([...scopedKpis(), kpiRow(KPIS[1])]);
      prisma.outlet.findMany.mockResolvedValue(silverO2());
      await service.uploadAchievements(admin, upload([['O2', 'Beta', 'WHOLESALER', 'Silver', '', 3, 99]], true));
      expect(rawWrites(prisma)).toEqual([
        { table: 'outlet_sales_records', outletCode: 'O2', values: { MONTH_TGT: 3 }, carry: ['FOCUS_PACK_1', 'CONSISTENCY'] },
      ]);
    });
  });
});

// Prisma.Sql (tagged-template $executeRaw) → text with the bound values removed, and the bound values.
// Nested Prisma.sql fragments are flattened by Prisma, so `.strings` / `.values` are the final statement.
function sqlText(call: unknown[]): string {
  return ((call[0] as { strings: readonly string[] }).strings ?? []).join('');
}
function sqlValues(call: unknown[]): unknown[] {
  return (call[0] as { values?: unknown[] }).values ?? [];
}
/** The raw INSERT statements only (the target apply also takes a pg_advisory_xact_lock via $executeRaw). */
function insertCalls(prisma: { $executeRaw: jest.Mock }): unknown[][] {
  return prisma.$executeRaw.mock.calls.filter((call: unknown[]) => /INSERT INTO/.test(sqlText(call)));
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * Each written ROW → { table, outletCode, uploaded values, carry list (absent = plain replace) }. Target uploads write
 * MULTI-ROW statements (one per carry set); each row tuple is (uuid, clientId, outletCode, outletName, month, json, …).
 */
function rawWrites(prisma: { $executeRaw: jest.Mock }) {
  return insertCalls(prisma).flatMap((call: unknown[]) => {
    const table = /INSERT INTO "(\w+)"/.exec(sqlText(call))![1];
    const values = sqlValues(call);
    const carry = values.find((v) => Array.isArray(v)) as string[] | undefined;
    const rows: Array<{ table: string; outletCode: unknown; values: unknown; carry: string[] | undefined }> = [];
    for (let i = 0; i + 5 < values.length; i++) {
      const v = values[i + 5];
      if (typeof values[i] === 'string' && UUID_RE.test(values[i] as string) && typeof v === 'string' && v.startsWith('{')) {
        rows.push({ table, outletCode: values[i + 2], values: JSON.parse(v), carry });
        i += 5;
      }
    }
    return rows;
  });
}

describe('TargetsService — deleteAchievementBatch keeps stored out-of-scope values (OWNER DECISION)', () => {
  const MONTH = '2026-10';
  const scopedKpis = () => [kpiRow(KPIS[0]), kpiRow(KPIS[2], { programs: ['Gold'] })];

  /** prisma mock whose interactive $transaction runs the callback with the same mock (tx = prisma). */
  function setup(opts: {
    kpis: unknown[];
    owned?: string[];
    rows?: Array<{ outletCode: string; kpiValues: Record<string, unknown> }>;
    batches?: Array<{ id: string; month: string; status?: string }>;
  }) {
    const rows = opts.rows ?? [];
    const batches = opts.batches ?? [];
    const prisma: any = {
      kpiDef: { findMany: jest.fn().mockResolvedValue(opts.kpis) },
      outlet: {
        findMany: jest.fn().mockResolvedValue([
          outletRow({ ...OUTLETS[0], program: 'Gold' }), // O1: CONSISTENCY in scope
          outletRow({ ...OUTLETS[1], program: 'Silver' }), // O2: CONSISTENCY OUT of scope
        ]),
      },
      salesKpiDefinition: { findMany: jest.fn().mockResolvedValue((opts.owned ?? []).map((kpiCode) => ({ kpiCode }))) },
      salesUploadBatch: {
        findFirst: jest.fn(async ({ where }: any) => {
          if (where.id === 'b1' && where.clientId) return { id: 'b1', clientId: 't1', status: 'COMPLETED', acceptedCount: rows.length };
          const pool = batches.filter(
            (b) =>
              (!where.month || b.month === where.month) &&
              (!where.status || (b.status ?? 'COMPLETED') === where.status) &&
              (!where.id?.not || b.id !== where.id.not),
          );
          return pool[0] ? { id: pool[0].id } : null;
        }),
        delete: jest.fn().mockResolvedValue({}),
      },
      outletSalesRecord: {
        findMany: jest.fn(async ({ distinct }: any) => (distinct ? [{ month: MONTH }] : rows)),
        count: jest.fn().mockResolvedValue(1),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((cb: (t: unknown) => unknown) => cb(prisma));
    const service = new TargetsService(prisma as never, {} as never, {} as never);
    // Only the carry-over UPDATEs (skip the advisory lock statements).
    const updates = () =>
      prisma.$executeRaw.mock.calls
        .filter((c: unknown[]) => sqlText(c).includes('UPDATE "outlet_sales_records"'))
        .map((c: unknown[]) => {
          const v = sqlValues(c);
          return { keep: v.find((x) => Array.isArray(x)), holder: v[1], codes: v[v.length - 1] };
        });
    return { service, prisma, updates };
  }

  it('UNSCOPED tenant (Deoleo): identical plain cascade delete — no transaction, no raw SQL, no outlet read', async () => {
    const { service, prisma } = setup({ kpis: [kpiRow(KPIS[0]), kpiRow(KPIS[2])] });
    await expect(service.deleteAchievementBatch(admin, 'b1')).resolves.toEqual({ deleted: true, id: 'b1', removedRecords: 0 });
    expect(prisma.salesUploadBatch.delete).toHaveBeenCalledWith({ where: { id: 'b1' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.outlet.findMany).not.toHaveBeenCalled();
  });

  it('SCOPED: a row carrying an out-of-scope value keeps ONLY that value, re-pointed to the latest other same-month batch', async () => {
    const { service, prisma, updates } = setup({
      kpis: scopedKpis(),
      rows: [
        { outletCode: 'O1', kpiValues: { MONTH_TGT: 1, CONSISTENCY: 2 } }, // all in scope → goes with the batch
        { outletCode: 'O2', kpiValues: { MONTH_TGT: 3, CONSISTENCY: 4 } }, // CONSISTENCY out of scope → kept
      ],
      batches: [{ id: 'b0', month: MONTH }],
    });
    const res = await service.deleteAchievementBatch(admin, 'b1');
    expect(updates()).toEqual([{ keep: ['CONSISTENCY'], holder: 'b0', codes: ['O2'] }]);
    expect(prisma.salesUploadBatch.delete).toHaveBeenCalledWith({ where: { id: 'b1' } });
    expect(res).toEqual({ deleted: true, id: 'b1', removedRecords: 1 }); // O1 removed by the cascade
    // the month is advisory-locked inside the same transaction
    expect(prisma.$executeRaw.mock.calls.some((c: unknown[]) => sqlText(c).includes('pg_advisory_xact_lock'))).toBe(true);
  });

  it('SCOPED: no same-month batch → held by the latest other batch of the tenant', async () => {
    const { service, updates } = setup({
      kpis: scopedKpis(),
      rows: [{ outletCode: 'O2', kpiValues: { CONSISTENCY: 4 } }],
      batches: [{ id: 'bOld', month: '2026-08' }],
    });
    await service.deleteAchievementBatch(admin, 'b1');
    expect(updates()).toEqual([{ keep: ['CONSISTENCY'], holder: 'bOld', codes: ['O2'] }]);
  });

  it('SCOPED: no other batch anywhere → 409 and NOTHING is deleted (the values are never removed)', async () => {
    const { service, prisma, updates } = setup({
      kpis: scopedKpis(),
      rows: [{ outletCode: 'O2', kpiValues: { MONTH_TGT: 3, CONSISTENCY: 4 } }],
      batches: [],
    });
    await expect(service.deleteAchievementBatch(admin, 'b1')).rejects.toThrow(/cannot be deleted/);
    expect(updates()).toEqual([]);
    expect(prisma.salesUploadBatch.delete).not.toHaveBeenCalled();
  });

  it('SCOPED: rows with nothing out of scope → plain cascade inside the transaction (no UPDATE, no holder needed)', async () => {
    const { service, prisma, updates } = setup({
      kpis: scopedKpis(),
      rows: [{ outletCode: 'O1', kpiValues: { MONTH_TGT: 1, CONSISTENCY: 2 } }, { outletCode: 'O2', kpiValues: { MONTH_TGT: 3 } }],
      batches: [],
    });
    await service.deleteAchievementBatch(admin, 'b1');
    expect(updates()).toEqual([]);
    expect(prisma.salesUploadBatch.delete).toHaveBeenCalledWith({ where: { id: 'b1' } });
  });

  it('SCOPED + importer-owned: owned keys → importer batch (owned rule); out-of-scope keys → a manual holder', async () => {
    const { service, updates } = setup({
      kpis: [...scopedKpis(), kpiRow(KPIS[1])],
      owned: ['FOCUS_PACK_1'],
      rows: [
        { outletCode: 'O2', kpiValues: { MONTH_TGT: 3, CONSISTENCY: 4, FOCUS_PACK_1: 5 } }, // owned + oos
        { outletCode: 'O1', kpiValues: { MONTH_TGT: 1, FOCUS_PACK_1: 6 } }, // owned only
      ],
      batches: [{ id: 'imp', month: MONTH, status: 'SALES_IMPORT' }, { id: 'b0', month: MONTH }],
    });
    await service.deleteAchievementBatch(admin, 'b1');
    expect(updates()).toEqual([
      { keep: ['CONSISTENCY', 'FOCUS_PACK_1'], holder: 'imp', codes: ['O2'] },
      { keep: ['FOCUS_PACK_1'], holder: 'imp', codes: ['O1'] },
    ]);
  });
});

describe('TargetsService — upsertKpi APPLIES-TO scope (§4)', () => {
  it('create with arrays: types canonical, programs → settings / most-common-live spelling, legacy column null', async () => {
    const { service, tx } = makeService();
    await service.upsertKpi(admin, { code: 'K', label: 'K', outletTypes: ['sss', 'Wholesaler'], programs: ['gold programme', 'BAJAJ ELITE'], subPrograms: ['tier a'] });
    const arg = tx.kpiDef.upsert.mock.calls[0][0];
    expect(arg.create).toEqual(expect.objectContaining({
      outletType: null, outletTypes: ['SSS', 'WHOLESALER'], programs: ['Gold Programme', 'Bajaj Elite'], subPrograms: ['Tier A'],
    }));
    expect(arg.update).toEqual(expect.objectContaining({ outletType: null, outletTypes: ['SSS', 'WHOLESALER'] }));
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create.mock.calls[0][0].data).toEqual(expect.objectContaining({
      action: 'CREATE', entityType: 'KPI_DEF', actorId: 'admin1',
      metadata: { clientId: 't1', kpiCode: 'K', change: 'kpi-scope' },
    }));
  });

  it('exactly one type and no programs → legacy outletType dual-written', async () => {
    const { service, tx } = makeService();
    await service.upsertKpi(admin, { code: 'K', label: 'K', outletTypes: ['wholesaler'] });
    expect(tx.kpiDef.upsert.mock.calls[0][0].create).toEqual(expect.objectContaining({ outletType: 'WHOLESALER', outletTypes: ['WHOLESALER'] }));
  });

  it('arrays WIN over the legacy outletType; legacy alone → [type]', async () => {
    const { service, tx } = makeService();
    await service.upsertKpi(admin, { code: 'K', label: 'K', outletType: 'SSS', outletTypes: ['WHOLESALER'] });
    expect(tx.kpiDef.upsert.mock.calls[0][0].create.outletTypes).toEqual(['WHOLESALER']);
    await service.upsertKpi(admin, { code: 'K2', label: 'K', outletType: 'sss' });
    expect(tx.kpiDef.upsert.mock.calls[1][0].create).toEqual(expect.objectContaining({ outletType: 'SSS', outletTypes: ['SSS'] }));
  });

  it.each([
    ['outletTypes', { outletTypes: ['RETAILER'] }, /outletTypes: "RETAILER" is not a known outlet type.*allowed: SSS, WHOLESALER/],
    ['programs', { programs: ['Platinum'] }, /programs: "Platinum" is not a known program.*allowed: Gold Programme, Bajaj Elite/],
    ['subPrograms', { subPrograms: ['Tier Z', 'Tier Y'] }, /subPrograms: "Tier Z", "Tier Y" are not known sub-programs.*allowed: Premium, Tier A/],
  ])('400 for an unknown %s value, listing the allowed values; nothing written', async (_f, body, msg) => {
    const { service, prisma, tx } = makeService();
    const p = service.upsertKpi(admin, { code: 'K', label: 'K', ...body });
    await expect(p).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.upsertKpi(admin, { code: 'K', label: 'K', ...body })).rejects.toThrow(msg);
    expect(tx.kpiDef.upsert).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('UNCHANGED resend (any case / order) is a no-op: not re-validated, no scope write, no audit', async () => {
    const { service, prisma, tx, settings } = makeService();
    // stored scope uses values that are NO LONGER allowed (type disabled, program renamed)
    prisma.kpiDef.findFirst.mockResolvedValue({ outletType: null, outletTypes: ['OLD_TYPE', 'SSS'], programs: ['Retired Prog'], subPrograms: [] });
    await service.upsertKpi(admin, { code: 'K', label: 'Renamed', outletTypes: ['sss', 'old_type'], programs: ['retired prog'], subPrograms: [] });
    expect(prisma.outletTypeClientConfig.findMany).not.toHaveBeenCalled();
    expect(settings.getEffectiveSettings).not.toHaveBeenCalled();
    const arg = tx.kpiDef.upsert.mock.calls[0][0];
    expect(arg.update).not.toHaveProperty('outletTypes');
    expect(arg.update).not.toHaveProperty('outletType');
    expect(arg.update.label).toBe('Renamed');
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('omitted facets are carried; only the CHANGED facet is validated; audit has before/after', async () => {
    const { service, prisma, tx } = makeService();
    prisma.kpiDef.findFirst.mockResolvedValue({ outletType: null, outletTypes: ['OLD_TYPE'], programs: ['Retired Prog'], subPrograms: [] });
    await service.upsertKpi(admin, { code: 'K', label: 'K', subPrograms: ['premium'] });
    expect(prisma.outletTypeClientConfig.findMany).not.toHaveBeenCalled(); // outletTypes unchanged → not validated
    expect(tx.kpiDef.upsert.mock.calls[0][0].update).toEqual(expect.objectContaining({
      outletType: null, outletTypes: ['OLD_TYPE'], programs: ['Retired Prog'], subPrograms: ['Premium'],
    }));
    expect(tx.auditLog.create.mock.calls[0][0].data).toEqual(expect.objectContaining({
      action: 'UPDATE',
      oldValues: { outletTypes: ['OLD_TYPE'], programs: ['Retired Prog'], subPrograms: [] },
      newValues: { outletTypes: ['OLD_TYPE'], programs: ['Retired Prog'], subPrograms: ['Premium'] },
    }));
  });

  it('no scope field at all → no read, no scope write, no audit (label-only edit)', async () => {
    const { service, prisma, tx } = makeService();
    await service.upsertKpi(admin, { code: 'K', label: 'K' });
    expect(prisma.kpiDef.findFirst).not.toHaveBeenCalled();
    expect(tx.kpiDef.upsert.mock.calls[0][0].create.outletType).toBeNull();
    expect(tx.kpiDef.upsert.mock.calls[0][0].create).not.toHaveProperty('outletTypes');
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('clearing a scope ([] everywhere) on an existing KPI writes [] + null and audits', async () => {
    const { service, prisma, tx } = makeService();
    prisma.kpiDef.findFirst.mockResolvedValue({ outletType: 'SSS', outletTypes: ['SSS'], programs: [], subPrograms: [] });
    await service.upsertKpi(admin, { code: 'K', label: 'K', outletTypes: [] });
    expect(tx.kpiDef.upsert.mock.calls[0][0].update).toEqual(expect.objectContaining({ outletType: null, outletTypes: [] }));
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('create with an empty scope writes [] but does NOT audit', async () => {
    const { service, tx } = makeService();
    await service.upsertKpi(admin, { code: 'K', label: 'K', outletTypes: [], programs: [] });
    expect(tx.kpiDef.upsert.mock.calls[0][0].create).toEqual(expect.objectContaining({ outletTypes: [], programs: [], subPrograms: [] }));
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('TargetsService — scope-options / scope-count', () => {
  it('scope-options: enabled types {code,label}; programs/subPrograms = settings ∪ live with inSettings', async () => {
    const { service, prisma } = makeService();
    const r = await service.scopeOptions(admin);
    expect(r).toEqual({
      outletTypes: [{ code: 'SSS', label: 'Super Stockist' }, { code: 'WHOLESALER', label: 'WS' }],
      programs: [{ value: 'Gold Programme', inSettings: true }, { value: 'Bajaj Elite', inSettings: false }],
      subPrograms: [{ value: 'Premium', inSettings: true }, { value: 'Tier A', inSettings: false }],
    });
    for (const c of prisma.outlet.groupBy.mock.calls) {
      expect(c[0].where).toEqual(expect.objectContaining({ clientId: 't1', deletedAt: null }));
    }
  });

  it('scope-count: tenant LIVE universe (no isActive proxy, NULL-safe kycIntent) AND the scope where', async () => {
    const { service, prisma } = makeService();
    prisma.outlet.count.mockResolvedValue(42);
    await expect(service.scopeCount(admin, { outletTypes: ['sss', 'WHOLESALER'], programs: 'Gold', subPrograms: [''] })).resolves.toEqual({ count: 42 });
    const where = prisma.outlet.count.mock.calls[0][0].where;
    expect(where.AND[0]).toEqual({
      clientId: 't1', deletedAt: null, deactivatedAt: null,
      OR: [{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }],
    });
    expect(JSON.stringify(where)).not.toContain('isActive');
    expect(where.AND[1].AND).toHaveLength(2); // types + programs (blank subPrograms = all)
  });

  it('scope-count: a value containing a comma is ONE value (never split)', async () => {
    const { service, prisma } = makeService();
    prisma.outlet.count.mockResolvedValue(3);
    await service.scopeCount(admin, { programs: ['Gold, Plus', 'Silver'] });
    const where = prisma.outlet.count.mock.calls[0][0].where;
    expect(where.AND[1]).toEqual({
      AND: [{ OR: [
        { programName: { equals: 'Gold, Plus', mode: 'insensitive' } },
        { programName: { equals: 'Silver', mode: 'insensitive' } },
      ] }],
    });
  });

  it('scope-count with no params = every live outlet', async () => {
    const { service, prisma } = makeService();
    prisma.outlet.count.mockResolvedValue(7);
    await expect(service.scopeCount(admin, {})).resolves.toEqual({ count: 7 });
    expect(prisma.outlet.count.mock.calls[0][0].where.AND[1]).toEqual({});
  });
});

describe('TargetsService — getPace APPLIES-TO (out-of-scope pairs EXCLUDED — every aggregate reader agrees)', () => {
  const setup = (kpiScopes: Record<string, unknown>[]) => {
    const ctx = makeService();
    ctx.prisma.outletTarget.findMany.mockResolvedValue([{ outletCode: 'O2', outletName: 'Beta', targetValues: { MONTH_TGT: 10, CONSISTENCY: 4 } }]);
    ctx.prisma.outletSalesRecord.findMany.mockResolvedValue([]);
    ctx.prisma.kpiDef.findMany.mockResolvedValue(kpiScopes);
    ctx.prisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O2', outletType: { code: 'WHOLESALER' }, programName: 'Silver', programCategory: null }]);
    return ctx;
  };

  it('scoped tenant: the out-of-scope KPI is excluded from the outlet pace', async () => {
    const { service, prisma } = setup([{ code: 'MONTH_TGT', outletType: null }, { code: 'CONSISTENCY', programs: ['Gold'] }]);
    const res = await service.getPace(admin, { month: NEXT_MONTH });
    expect(res.outlets[0].kpis).toEqual([{ code: 'MONTH_TGT', target: 10, achieved: null, pace: null }]);
    expect(prisma.outlet.findMany.mock.calls[0][0].select).toEqual(expect.objectContaining({ programName: true, programCategory: true }));
  });

  it('legacy single-type tenant: the out-of-type KPI is excluded too', async () => {
    const { service } = setup([{ code: 'MONTH_TGT', outletType: null }, { code: 'CONSISTENCY', outletType: 'SSS' }]);
    const res = await service.getPace(admin, { month: NEXT_MONTH });
    expect(res.outlets[0].kpis).toEqual([{ code: 'MONTH_TGT', target: 10, achieved: null, pace: null }]);
  });

  it('unscoped tenant: response and outlet query unchanged', async () => {
    const { service, prisma } = setup([{ code: 'MONTH_TGT', outletType: null }, { code: 'CONSISTENCY', outletType: null }]);
    const res = await service.getPace(admin, { month: NEXT_MONTH });
    expect(res.outlets[0].kpis).toEqual([
      { code: 'MONTH_TGT', target: 10, achieved: null, pace: null },
      { code: 'CONSISTENCY', target: 4, achieved: null, pace: null },
    ]);
    expect(prisma.outlet.findMany.mock.calls[0][0].select).toEqual({ outletCode: true, outletType: { select: { code: true } } });
  });
});

describe('KpiScopeCountQueryDto — repeated query params (global ValidationPipe options)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ValidationPipe } = require('@nestjs/common');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { KpiScopeCountQueryDto } = require('./dto/targets.dto');
  const pipe = new ValidationPipe({
    whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true },
  });
  const run = (q: Record<string, unknown>) =>
    pipe.transform(q, { type: 'query', metatype: KpiScopeCountQueryDto, data: '' });

  it('a single param becomes a one-element array; a comma inside a value is kept', async () => {
    await expect(run({ programs: 'Gold, Plus' })).resolves.toEqual(expect.objectContaining({ programs: ['Gold, Plus'] }));
  });

  it('repeated params stay an array; absent facets stay absent', async () => {
    const out = await run({ outletTypes: ['SSS', 'WS'], subPrograms: 'Tier A' });
    expect(out.outletTypes).toEqual(['SSS', 'WS']);
    expect(out.subPrograms).toEqual(['Tier A']);
    expect(out.programs).toBeUndefined();
  });

  it('unknown keys are still rejected', async () => {
    await expect(run({ foo: 'x' })).rejects.toBeDefined();
  });
});
