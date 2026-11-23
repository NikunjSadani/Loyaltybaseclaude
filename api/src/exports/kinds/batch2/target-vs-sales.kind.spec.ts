import { BadRequestException } from '@nestjs/common';
import { buildXlsx } from '../../../common/xlsx';
import { istMonthKey } from '../../../common/ist-date';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import type { PrismaService } from '../../../prisma/prisma.service';
import { TargetsService } from '../../../targets/targets.service';
import {
  buildTargetVsSalesRows,
  targetVsSalesHeaderKeys,
  targetVsSalesMonthList,
  type PaceMonthResult,
} from '../../../admin-programs/reports/report-helpers';
import {
  BILLING_BUCKETS,
  billingListLabel,
  loadBillingProgress,
  type BillingProgressFilters,
} from '../../../admin-core/dashboards/billing-progress';
import {
  TARGET_VS_SALES_KIND,
  TVS_BUCKET_NO_KPI,
  TVS_BUCKET_NOT_LIVE,
  describeTargetVsSales,
  parseTargetVsSalesParams,
} from './target-vs-sales.kind';
import { ctxFor, fakeModel, maxPage, readBook, renderKind } from './parity.support-spec';

/** Real exceljs build + SheetJS read-backs: explicit headroom for a loaded full-suite run (alone: well under 1 s). */
const XLSX_TIMEOUT = 30_000;

const ADMIN = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: 'A' } as JwtPayload;
const DEOLEO_ADMIN = { ...ADMIN, clientId: 'deoleo' } as JwtPayload;

type Row = Record<string, unknown>;

/** A month key `delta` months from the current IST month — never a hard-coded date. */
function monthOffset(delta: number, from = new Date()): string {
  const [y, m] = istMonthKey(from).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const BAJAJ_LEVELS = [
  { clientId: 'bajaj', code: 'XSR', name: 'ISR', level: 1 },
  { clientId: 'bajaj', code: 'SO', name: 'SO', level: 2 },
  { clientId: 'bajaj', code: 'ASM', name: 'ASM', level: 3 },
  { clientId: 'bajaj', code: 'RSM', name: 'SM', level: 4 },
];

const LEVEL_OF: Record<string, number> = { XSR: 1, SO: 2, ASM: 3, RSM: 4 };

/** A sales user row shaped like every select in play (kind hierarchy + dashboard). */
function su(
  id: string,
  code: string,
  reportsTo: string | null,
  o: { clientId?: string; isActive?: boolean; deletedAt?: Date | null; name?: string; status?: string; level?: number } = {},
): Row {
  return {
    id,
    clientId: o.clientId ?? 'bajaj',
    userId: `user-${id}`,
    reportingToId: reportsTo,
    isActive: o.isActive ?? true,
    deletedAt: o.deletedAt ?? null,
    employeeCode: `E-${id}`,
    zone: null,
    hierarchyLevel: { code, name: code, level: o.level ?? LEVEL_OF[code] ?? 1 },
    user: { name: o.name ?? `Name ${id}`, status: o.status ?? 'ACTIVE' },
  };
}

function db(opts: {
  kpis: Row[];
  targets: Row[];
  sales: Row[];
  outlets: Row[];
  levels?: Row[];
  salesUsers?: Row[];
  assignments?: Row[];
}) {
  let n = 0;
  const id = () => `id${String(++n).padStart(6, '0')}`;
  return {
    kpiDef: fakeModel(
      opts.kpis.map((k) => ({ id: id(), enabled: true, isPrimary: false, outletType: null, outletTypes: [], programs: [], subPrograms: [], ...k })),
    ),
    outletTarget: fakeModel(opts.targets.map((r) => ({ id: id(), ...r }))),
    outletSalesRecord: fakeModel(opts.sales.map((r) => ({ id: id(), updatedAt: new Date(), ...r }))),
    outlet: fakeModel(
      opts.outlets.map((r) => ({
        id: id(),
        deletedAt: null,
        deactivatedAt: null,
        kycIntent: null,
        programName: null,
        programCategory: null,
        zone: null,
        state: null,
        partnerId: null,
        parentId: null,
        salesAssignments: [],
        ...r,
        name: r.name ?? `Outlet ${String(r.outletCode)}`,
      })),
    ),
    salesHierarchyLevel: fakeModel((opts.levels ?? []).map((r) => ({ id: id(), ...r }))),
    salesUser: fakeModel(opts.salesUsers ?? []),
    salesUserAssignment: fakeModel((opts.assignments ?? []).map((r) => ({ id: id(), unassignedAt: null, outletId: null, partnerId: null, ...r }))),
    salesImportApply: fakeModel([]),
    salesImport: fakeModel([]),
  };
}

/** REFERENCE COPY of the old in-memory download (ReportsService.targetVsSales, format=xlsx, before the Downloads page). */
async function oldDownload(prisma: ReturnType<typeof db>, user: JwtPayload, fromMonth: string, toMonth: string): Promise<Buffer> {
  const targets = new TargetsService(prisma as never, {} as never);
  const months = targetVsSalesMonthList(fromMonth, toMonth);
  const kpiDefs = (await prisma.kpiDef.findMany({
    where: { clientId: user.clientId, enabled: true },
    orderBy: [{ order: 'asc' }, { code: 'asc' }],
  })) as Array<{ code: string; label: string; unit: string | null }>;
  const paceResults: PaceMonthResult[] = [];
  for (const month of months) {
    const res = await targets.getPace(user, { month });
    paceResults.push({ month, outlets: res.outlets });
  }
  const { rows } = buildTargetVsSalesRows(months, kpiDefs, paceResults);
  const headerKeys = targetVsSalesHeaderKeys(kpiDefs);
  const sheetRows = rows.length ? rows : [Object.fromEntries(headerKeys.map((h) => [h, '']))];
  return buildXlsx([{ name: 'Target vs Sales', rows: sheetRows }]);
}

/** Lead columns before Month in the new layout: Code, Name, Type, Programme, Sub, Zone, State + 6 hierarchy. */
const MONTH_COL = 13;
const BUCKET_COL = 14;
const FIRST_KPI_COL = 15;

/** The new sheet with the 2026-11-23 columns removed = the old sheet's columns. */
function oldColumnsOf(aoa: unknown[][]): unknown[][] {
  const keep = (r: unknown[]) => {
    const out = [r[0], r[1], r[2], r[MONTH_COL], ...r.slice(FIRST_KPI_COL)].map((c) => (c === undefined ? null : c));
    while (out.length && out[out.length - 1] === null) out.pop();
    return out;
  };
  const rows = aoa.map(keep);
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

/** Old columns + row order + every value identical to the old in-memory download; About sheet added. */
function expectOldColumnsUnchanged(actual: Buffer, expected: Buffer) {
  const a = readBook(actual);
  const e = readBook(expected);
  expect(a.names).toEqual(['Target vs Sales', 'About']);
  expect(oldColumnsOf(a.sheets['Target vs Sales'].aoa)).toEqual(e.sheets['Target vs Sales'].aoa);
}

const KPIS = [
  { clientId: 'bajaj', code: 'VOL', label: 'Volume', unit: 'cases', order: 1 },
  { clientId: 'bajaj', code: 'FOC', label: '=Focus', unit: 'cases', order: 2 }, // formula-looking label → cellSafe
  { clientId: 'bajaj', code: 'OFF', label: 'Off', unit: null, order: 3, enabled: false },
  { clientId: 'other', code: 'VOL', label: 'Other tenant KPI', unit: null, order: 1 },
];

function fixture() {
  return db({
    kpis: KPIS,
    outlets: [
      { clientId: 'bajaj', outletCode: 'b10', outletType: { code: 'WHOLESALE' } },
      { clientId: 'bajaj', outletCode: 'B2', outletType: { code: 'RETAIL' } },
      { clientId: 'bajaj', outletCode: 'a1', outletType: { code: 'RETAIL' } },
      { clientId: 'bajaj', outletCode: 'DEL', outletType: { code: 'RETAIL' }, deletedAt: new Date() },
      { clientId: 'other', outletCode: 'X1', outletType: { code: 'RETAIL' } },
    ],
    targets: [
      { clientId: 'bajaj', outletCode: 'b10', month: '2026-01', outletName: 'Bee Ten', targetValues: { VOL: 100, FOC: 0, __names: { FOC: 'x' } } },
      { clientId: 'bajaj', outletCode: 'b10', month: '2026-03', outletName: 'Renamed later', targetValues: { VOL: 120 } },
      { clientId: 'bajaj', outletCode: 'a1', month: '2026-02', outletName: null, targetValues: { VOL: 7.5 } },
      { clientId: 'bajaj', outletCode: 'DEL', month: '2026-01', outletName: '+Deleted shop', targetValues: { VOL: 10 } },
      { clientId: 'other', outletCode: 'X1', month: '2026-01', outletName: 'Foreign', targetValues: { VOL: 999 } },
      { clientId: 'bajaj', outletCode: 'OUTSIDE', month: '2025-12', outletName: 'Out of range', targetValues: { VOL: 1 } },
    ],
    sales: [
      { clientId: 'bajaj', outletCode: 'b10', month: '2026-01', kpiValues: { VOL: 87.53, FOC: 3 } },
      { clientId: 'bajaj', outletCode: 'B2', month: '2026-02', kpiValues: { VOL: 0 } }, // sales only, no target
      { clientId: 'bajaj', outletCode: 'a1', month: '2026-02', kpiValues: {} },
      { clientId: 'other', outletCode: 'X1', month: '2026-01', kpiValues: { VOL: 5 } },
    ],
  });
}

async function render(prisma: ReturnType<typeof db>, raw: Row, user: JwtPayload = ADMIN) {
  const params = TARGET_VS_SALES_KIND.parseParams(raw, user);
  const out = await renderKind(TARGET_VS_SALES_KIND, ctxFor(user, prisma), params);
  const book = readBook(out.buffer);
  return { ...out, book, sheet: book.sheets['Target vs Sales'].aoa, about: book.sheets.About?.aoa ?? [] };
}

describe('target-vs-sales export kind — unchanged columns (parity with the old download)', () => {
  it('parity: same rows, order and every old cell as the old in-memory download', async () => {
    const prisma = fixture();
    const expected = await oldDownload(prisma, ADMIN, '2026-01', '2026-03');
    const { buffer, rowCount, sheet } = await render(prisma, { fromMonth: '2026-01', toMonth: '2026-03', format: 'xlsx' });
    expectOldColumnsUnchanged(buffer, expected);
    expect(rowCount).toBe(4 * 3); // a1, B2, b10, DEL × 3 months
    // Foreign tenant and out-of-range outlets never appear.
    expect(new Set(sheet.slice(1).map((r) => r[0]))).toEqual(new Set(['a1', 'B2', 'b10', 'DEL']));
    expect(sheet.find((r) => r[0] === 'DEL')?.[1]).toBe("'+Deleted shop");
    expect(sheet.find((r) => r[0] === 'b10' && r[MONTH_COL] === '2026-01')?.slice(FIRST_KPI_COL, FIRST_KPI_COL + 3)).toEqual([100, 87.53, 87.5]);
  }, XLSX_TIMEOUT);

  it('parity: APPLIES-TO scoped tenant (out-of-scope KPI blank) and duplicate KPI labels', async () => {
    const prisma = db({
      kpis: [
        { clientId: 'bajaj', code: 'VOL', label: 'Volume', unit: null, order: 1, outletTypes: ['WHOLESALE'] },
        { clientId: 'bajaj', code: 'VOL2', label: 'Volume', unit: null, order: 2 },
      ],
      outlets: [
        { clientId: 'bajaj', outletCode: 'R1', outletType: { code: 'RETAIL' } },
        { clientId: 'bajaj', outletCode: 'W1', outletType: { code: 'WHOLESALE' } },
      ],
      targets: [
        { clientId: 'bajaj', outletCode: 'R1', month: '2026-05', outletName: 'Retail', targetValues: { VOL: 5, VOL2: 6 } },
        { clientId: 'bajaj', outletCode: 'W1', month: '2026-05', outletName: 'Whole', targetValues: { VOL: 50, VOL2: 0 } },
      ],
      sales: [{ clientId: 'bajaj', outletCode: 'W1', month: '2026-05', kpiValues: { VOL: 25, VOL2: 4 } }],
    });
    const expected = await oldDownload(prisma, ADMIN, '2026-05', '2026-05');
    expectOldColumnsUnchanged((await render(prisma, { fromMonth: '2026-05', toMonth: '2026-05' })).buffer, expected);
  }, XLSX_TIMEOUT);

  it('parity: no data → header + one blank row (and the About sheet)', async () => {
    const prisma = db({ kpis: KPIS, outlets: [], targets: [], sales: [] });
    const expected = await oldDownload(prisma, ADMIN, '2026-01', '2026-02');
    const { buffer, rowCount } = await render(prisma, { fromMonth: '2026-01', toMonth: '2026-02' });
    expectOldColumnsUnchanged(buffer, expected);
    expect(rowCount).toBe(0);
  }, XLSX_TIMEOUT);

  it('pages: 2,100 outlets × 3 months — identical old columns, no read returns more than 2,000 rows, no per-row query', async () => {
    const outlets: Row[] = [];
    const targets: Row[] = [];
    const sales: Row[] = [];
    const assignments: Row[] = [];
    const salesUsers: Row[] = [su('asm', 'ASM', null), su('so', 'SO', 'asm'), su('isr', 'XSR', 'so')];
    for (let i = 0; i < 2100; i++) {
      const code = `O${String(i).padStart(5, '0')}`;
      outlets.push({ id: `out-${i}`, clientId: 'bajaj', outletCode: code, outletType: { code: i % 2 ? 'RETAIL' : 'WHOLESALE' } });
      assignments.push({ salesUserId: 'isr', outletId: `out-${i}` });
      for (const m of ['2026-01', '2026-02', '2026-03']) {
        if ((i + m.length) % 3) targets.push({ clientId: 'bajaj', outletCode: code, month: m, outletName: `Shop ${i}`, targetValues: { VOL: i } });
        if (i % 5) sales.push({ clientId: 'bajaj', outletCode: code, month: m, kpiValues: { VOL: i / 2 } });
      }
    }
    const prisma = db({ kpis: KPIS, outlets, targets, sales, levels: BAJAJ_LEVELS, salesUsers, assignments });
    const expected = await oldDownload(prisma, ADMIN, '2026-01', '2026-03');
    const models = [prisma.outletTarget, prisma.outletSalesRecord, prisma.outlet, prisma.salesUserAssignment, prisma.salesUser, prisma.salesHierarchyLevel];
    for (const m of models) m.findMany.mockClear();
    const { buffer, rowCount, sheet } = await render(prisma, { fromMonth: '2026-01', toMonth: '2026-03' });
    const qualifying = new Set([...targets, ...sales].map((r) => r.outletCode)).size;
    expect(qualifying).toBeGreaterThan(1900);
    expect(rowCount).toBe(qualifying * 3);
    expectOldColumnsUnchanged(buffer, expected);
    expect(prisma.outletTarget.findMany.mock.calls.length).toBeGreaterThan(1);
    for (const m of models) expect(await maxPage(m)).toBeLessThanOrEqual(2000);
    // Hierarchy = one tenant-wide load: 1 levels read, 1 sales-user read, assignments + outlets in 2 pages each.
    expect(prisma.salesHierarchyLevel.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.salesUser.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.salesUserAssignment.findMany).toHaveBeenCalledTimes(2);
    // Every row resolved its hierarchy from that load.
    expect(sheet[1].slice(7, 13)).toEqual(['Name asm', 'E-asm', 'Name so', 'E-so', 'Name isr', 'E-isr']);
  }, 60_000);
});

describe('target-vs-sales — new columns (2026-11-23)', () => {
  const M = monthOffset(-1);

  /**
   * Bajaj-like hierarchy:  SM rsm ← ASM asm1 ← SO so1 ← ISR isr1 / isr2;  ASM asm1 ← SO so2 ← ISR isr3;
   * ASM asmV (INACTIVE = vacant) ← SO so3 ← ISR isr4;  ISR isrOff (inactive rep — ignored).
   */
  function hierarchyWorld(extra: Partial<Parameters<typeof db>[0]> = {}) {
    return db({
      kpis: [{ clientId: 'bajaj', code: 'TOTAL', label: 'Total', unit: 'INR', order: 1, isPrimary: true }],
      levels: BAJAJ_LEVELS,
      salesUsers: [
        su('rsm', 'RSM', null),
        su('asm1', 'ASM', 'rsm', { name: 'Asha' }),
        su('so1', 'SO', 'asm1', { name: 'Bina' }),
        su('so2', 'SO', 'asm1', { name: 'Arun' }),
        su('isr1', 'XSR', 'so1', { name: 'Zed' }),
        su('isr2', 'XSR', 'so1', { name: 'Yan' }),
        su('isr3', 'XSR', 'so2', { name: 'Xia' }),
        su('asmV', 'ASM', 'rsm', { isActive: false, name: 'Gone' }),
        su('so3', 'SO', 'asmV', { name: 'Chet' }),
        su('isr4', 'XSR', 'so3', { name: 'Wes' }),
        su('isrOff', 'XSR', 'so2', { isActive: false, name: 'Off' }),
        su('foreign', 'ASM', null, { clientId: 'other' }),
      ],
      outlets: [
        // MULTI: isr1 direct + isr3 via the owner partner → two SOs, one ASM.
        { id: 'o-multi', clientId: 'bajaj', outletCode: 'MULTI', partnerId: 'p1', outletType: { code: 'RETAIL' }, programName: ' Gold ', programCategory: 'Urban', zone: 'West', state: 'Maharashtra', salesAssignments: [{ salesUserId: 'isr1' }] },
        // VAC: under the vacant ASM.
        { id: 'o-vac', clientId: 'bajaj', outletCode: 'VAC', outletType: { code: 'WHOLESALE' }, programName: 'Silver', salesAssignments: [{ salesUserId: 'isr4' }] },
        // SOONLY: assigned to an SO directly (no ISR below them for this outlet).
        { id: 'o-so', clientId: 'bajaj', outletCode: 'SOONLY', outletType: { code: 'RETAIL' }, programName: 'Gold', salesAssignments: [{ salesUserId: 'so2' }] },
        // NOREP: only an inactive rep → nobody covers it.
        { id: 'o-norep', clientId: 'bajaj', outletCode: 'NOREP', outletType: { code: 'RETAIL' }, salesAssignments: [{ salesUserId: 'isrOff' }] },
        // CHILD: child of group p9 → inherits the group's rep (isr2).
        { id: 'o-child', clientId: 'bajaj', outletCode: 'CHILD', parentId: 'p9', outletType: { code: 'RETAIL' }, programName: 'Gold' },
      ],
      assignments: [
        { salesUserId: 'isr1', outletId: 'o-multi' },
        { salesUserId: 'isr3', partnerId: 'p1' },
        { salesUserId: 'isr4', outletId: 'o-vac' },
        { salesUserId: 'so2', outletId: 'o-so' },
        { salesUserId: 'isrOff', outletId: 'o-norep' },
        { salesUserId: 'isr2', partnerId: 'p9' },
      ],
      targets: ['MULTI', 'VAC', 'SOONLY', 'NOREP', 'CHILD'].map((c, i) => ({
        clientId: 'bajaj', outletCode: c, month: M, outletName: c, targetValues: { TOTAL: [100, 100, 0, 100, 100][i] },
      })),
      sales: [
        { clientId: 'bajaj', outletCode: 'MULTI', month: M, kpiValues: { TOTAL: 25 } },
        { clientId: 'bajaj', outletCode: 'VAC', month: M, kpiValues: { TOTAL: 100 } },
        { clientId: 'bajaj', outletCode: 'SOONLY', month: M, kpiValues: { TOTAL: 5 } },
        { clientId: 'bajaj', outletCode: 'GHOST', month: M, kpiValues: { TOTAL: 5 } }, // not in the outlet master
      ],
      ...extra,
    });
  }

  const byCode = (sheet: unknown[][], code: string) => sheet.find((r) => r[0] === code)!;

  it('headers: new columns after Outlet Type, before Month — in the tenant’s own level names (Bajaj XSR → ISR)', async () => {
    const { sheet } = await render(hierarchyWorld(), { fromMonth: M, toMonth: M });
    expect(sheet[0].slice(0, FIRST_KPI_COL + 3)).toEqual([
      'Outlet Code', 'Outlet Name', 'Outlet Type', 'Programme', 'Sub-programme', 'Zone', 'State',
      'ASM Name', 'ASM Employee ID', 'SO Name', 'SO Employee ID', 'ISR Name', 'ISR Employee ID',
      'Month', 'Billing bucket', 'Total Target', 'Total Achieved', 'Total Pace %',
    ]);
  }, XLSX_TIMEOUT);

  it('multi-rep outlet: distinct people joined with ", ", names and IDs in the same order; master fields trimmed', async () => {
    const { sheet } = await render(hierarchyWorld(), { fromMonth: M, toMonth: M });
    const r = byCode(sheet, 'MULTI');
    expect(r.slice(3, 7)).toEqual(['Gold', 'Urban', 'West', 'Maharashtra']);
    expect(r.slice(7, 13)).toEqual(['Asha', 'E-asm1', 'Arun, Bina', 'E-so2, E-so1', 'Xia, Zed', 'E-isr3, E-isr1']);
    // Child outlet inherits the parent group's rep.
    expect(byCode(sheet, 'CHILD').slice(7, 13)).toEqual(['Asha', 'E-asm1', 'Bina', 'E-so1', 'Yan', 'E-isr2']);
  }, XLSX_TIMEOUT);

  it('vacant ASM → "Vacant (code)"; rep above a rung / no active rep / not in master → "Not set" (never blank)', async () => {
    const { sheet } = await render(hierarchyWorld(), { fromMonth: M, toMonth: M });
    expect(byCode(sheet, 'VAC').slice(7, 13)).toEqual(['Vacant (E-asmV)', 'E-asmV', 'Chet', 'E-so3', 'Wes', 'E-isr4']);
    expect(byCode(sheet, 'SOONLY').slice(7, 13)).toEqual(['Asha', 'E-asm1', 'Arun', 'E-so2', 'Not set', 'Not set']);
    expect(byCode(sheet, 'NOREP').slice(3, 13)).toEqual(['Not set', 'Not set', 'Not set', 'Not set', ...Array(6).fill('Not set')]);
    expect(byCode(sheet, 'GHOST').slice(3, 13)).toEqual(Array(10).fill('Not set'));
  }, XLSX_TIMEOUT);

  it('Deoleo-like tenant (SO + ASM levels only): own level names; the ISR pair reads "Not set" and the About sheet says why', async () => {
    const prisma = db({
      kpis: [{ clientId: 'deoleo', code: 'VOL', label: 'Volume', unit: null, order: 1 }],
      levels: [
        { clientId: 'deoleo', code: 'SO', name: 'Sales Officer', level: 1 },
        { clientId: 'deoleo', code: 'ASM', name: 'Area Sales Manager', level: 2 },
      ],
      salesUsers: [su('d-asm', 'ASM', null, { clientId: 'deoleo', level: 2 }), su('d-so', 'SO', 'd-asm', { clientId: 'deoleo', level: 1 })],
      outlets: [{ id: 'd-o1', clientId: 'deoleo', outletCode: 'D1', outletType: { code: 'RETAIL' } }],
      assignments: [{ salesUserId: 'd-so', outletId: 'd-o1' }],
      targets: [{ clientId: 'deoleo', outletCode: 'D1', month: M, outletName: 'D1', targetValues: { VOL: 10 } }],
      sales: [],
    });
    const { sheet, about } = await render(prisma, { fromMonth: M, toMonth: M }, DEOLEO_ADMIN);
    expect(sheet[0].slice(7, 13)).toEqual([
      'Area Sales Manager Name', 'Area Sales Manager Employee ID', 'Sales Officer Name', 'Sales Officer Employee ID', 'ISR Name', 'ISR Employee ID',
    ]);
    expect(sheet[1].slice(7, 13)).toEqual(['Name d-asm', 'E-d-asm', 'Name d-so', 'E-d-so', 'Not set', 'Not set']);
    expect(about.map((r) => r[1]).join('\n')).toMatch(/has no ISR level, so that column pair reads "Not set"/);
  }, XLSX_TIMEOUT);

  it('billing bucket per row: the card’s labels incl. no target, not covered, not live, not in master; no KPI', async () => {
    const prisma = hierarchyWorld();
    // PARKED outlet with a target → outside the card's live roster.
    prisma.outlet.rows.push({ id: 'o-park', clientId: 'bajaj', outletCode: 'PARK', deletedAt: null, deactivatedAt: null, kycIntent: 'PARKED', outletType: { code: 'RETAIL' }, salesAssignments: [] });
    prisma.outletTarget.rows.push({ id: 'tp', clientId: 'bajaj', outletCode: 'PARK', month: M, outletName: 'PARK', targetValues: { TOTAL: 50 } });
    const { sheet } = await render(prisma, { fromMonth: M, toMonth: M });
    const bucket = (c: string) => byCode(sheet, c)[BUCKET_COL];
    expect(bucket('MULTI')).toBe('20–39%');
    expect(bucket('VAC')).toBe('Achieved (100%+)');
    expect(bucket('SOONLY')).toBe('No target'); // target 0
    expect(bucket('NOREP')).toBe('Not started');
    expect(bucket('PARK')).toBe(TVS_BUCKET_NOT_LIVE);
    expect(bucket('GHOST')).toBe(TVS_BUCKET_NOT_LIVE);

    // Scoped primary KPI (RETAIL only) → the WHOLESALE outlet is "Not covered by the KPI target".
    const scoped = hierarchyWorld({ kpis: [{ clientId: 'bajaj', code: 'TOTAL', label: 'Total', unit: 'INR', order: 1, isPrimary: true, outletTypes: ['RETAIL'] }] });
    expect(byCode((await render(scoped, { fromMonth: M, toMonth: M })).sheet, 'VAC')[BUCKET_COL]).toBe(billingListLabel('NOT_COVERED'));

    // No enabled KPI at all.
    const noKpi = hierarchyWorld({ kpis: [] });
    expect(byCode((await render(noKpi, { fromMonth: M, toMonth: M })).sheet, 'MULTI')[BUCKET_COL]).toBe(TVS_BUCKET_NO_KPI);
  }, XLSX_TIMEOUT);

  it('filters: programme, outlet type, sales manager (whole downline) and bucket; About lists them', async () => {
    const codes = async (raw: Row) => (await render(hierarchyWorld(), { fromMonth: M, toMonth: M, ...raw })).sheet.slice(1).map((r) => r[0]);
    expect(await codes({})).toEqual(['CHILD', 'GHOST', 'MULTI', 'NOREP', 'SOONLY', 'VAC']);
    expect(await codes({ program: 'Gold' })).toEqual(['CHILD', 'MULTI', 'SOONLY']); // ' Gold ' matches (trimmed)
    expect(await codes({ outletType: 'WHOLESALE' })).toEqual(['VAC']);
    // The card's manager rule = DIRECT outlet assignments of anyone in the downline (asm1 → so1, so2, isr1–3 and the
    // inactive-but-not-removed isrOff); group-level assignments (CHILD) are not part of the card's rule.
    expect(await codes({ managerId: 'asm1' })).toEqual(['MULTI', 'NOREP', 'SOONLY']);
    expect(await codes({ managerId: 'so3' })).toEqual(['VAC']);
    expect(await codes({ managerId: 'nobody' })).toEqual([]);
    expect(await codes({ bucket: 'ACHIEVED' })).toEqual(['VAC']);
    expect(await codes({ bucket: 'P20_40', program: 'Gold' })).toEqual(['MULTI']);

    const { about, rowCount } = await render(hierarchyWorld(), { fromMonth: M, toMonth: M, managerId: 'asm1', bucket: 'P20_40', outletType: 'RETAIL' });
    expect(rowCount).toBe(1);
    const lines = Object.fromEntries(about.map((r) => [r[0], r[1]]));
    expect(lines['Sales manager filter']).toBe('Asha (and everyone below them)');
    expect(lines['Billing bucket filter']).toBe('20–39%');
    expect(lines['Outlet type filter']).toBe('RETAIL');
    expect(lines['Programme filter']).toBe('All programmes');
    expect(lines['Billing bucket']).toMatch(/same rule as the Overview/);
  }, XLSX_TIMEOUT);

  it('a filter matching nothing → header + one blank row', async () => {
    const { sheet, rowCount } = await render(hierarchyWorld(), { fromMonth: M, toMonth: M, program: 'Nope' });
    expect(rowCount).toBe(0);
    expect(sheet).toHaveLength(1);
  }, XLSX_TIMEOUT);
});

describe('target-vs-sales params', () => {
  const p = (raw: unknown) => TARGET_VS_SALES_KIND.parseParams(raw, ADMIN);

  it('same validation as the endpoint; > 3 months is heavy; range ≤ 15', () => {
    expect(() => p({ fromMonth: '2026-13', toMonth: '2026-01' })).toThrow(BadRequestException);
    expect(() => p({ fromMonth: '2026-05', toMonth: '2026-03' })).toThrow(/must not be after/);
    expect(() => p({ fromMonth: '2025-01', toMonth: '2026-04' })).toThrow(/maximum allowed is 15/);
    expect(() => p({ fromMonth: '2026-01', toMonth: '2026-02', bogus: 1 })).toThrow(BadRequestException);
    expect(() => p({ toMonth: '2026-02' })).toThrow(BadRequestException);
    expect(p({ fromMonth: '2026-01', toMonth: '2026-03', requestOrigin: 'https://x' }).months).toHaveLength(3);
    expect(TARGET_VS_SALES_KIND.isHeavy(p({ fromMonth: '2026-01', toMonth: '2026-03' }))).toBe(false);
    expect(TARGET_VS_SALES_KIND.isHeavy(p({ fromMonth: '2026-01', toMonth: '2026-04' }))).toBe(true);
    expect(TARGET_VS_SALES_KIND.access).toEqual({ roles: ['CLIENT_ADMIN', 'GIFSY_ADMIN'], permission: 'targets:read' });
    expect(TARGET_VS_SALES_KIND.fileName(p({ fromMonth: '2026-01', toMonth: '2026-03' }), new Date())).toBe('target-vs-sales-2026-01-to-2026-03.xlsx');
    expect(TARGET_VS_SALES_KIND.describeParams(p({ fromMonth: '2026-01', toMonth: '2026-03' }))).toBe('Jan 2026 – Mar 2026');
  });

  it('filters: absent / blank = null (today’s behaviour); trimmed; described for the Downloads page', () => {
    expect(p({ fromMonth: '2026-01', toMonth: '2026-01' })).toMatchObject({ program: null, outletType: null, managerId: null, bucket: null });
    expect(p({ fromMonth: '2026-01', toMonth: '2026-01', program: '  ', outletType: '' })).toMatchObject({ program: null, outletType: null });
    const f = p({ fromMonth: '2026-10', toMonth: '2026-10', program: ' Gold ', outletType: 'RETAIL', managerId: 'su-1', bucket: 'P0_20' });
    expect(f).toMatchObject({ program: 'Gold', outletType: 'RETAIL', managerId: 'su-1', bucket: 'P0_20' });
    expect(TARGET_VS_SALES_KIND.describeParams(f)).toBe('Oct 2026 · Programme: Gold · Outlet type: RETAIL · One sales manager’s team · Billing bucket: Under 20%');
    expect(describeTargetVsSales(f, 'Asha')).toContain('Sales manager: Asha (and team)');
    expect(TARGET_VS_SALES_KIND.fileName(f, new Date())).toBe('target-vs-sales-2026-10-to-2026-10-p0-20.xlsx');
  });

  it('bad bucket → 400 with a clear message (incl. the card’s non-band lists)', () => {
    for (const bucket of ['NOPE', 'BEHIND_PACE', 'NO_TARGET', 'NOT_COVERED', 'p0_20']) {
      const err = (() => {
        try {
          p({ fromMonth: '2026-01', toMonth: '2026-01', bucket });
        } catch (e) {
          return e;
        }
        return null;
      })();
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toMatch(/Unknown `bucket`.*NOT_STARTED, P0_20, P20_40, P40_60, P60_80, P80_100, ACHIEVED/);
    }
    expect(() => p({ fromMonth: '2026-01', toMonth: '2026-01', program: ['a', 'b'] })).toThrow(BadRequestException);
    expect(() => p({ fromMonth: '2026-01', toMonth: '2026-01', program: 'x'.repeat(201) })).toThrow(/too long/);
  });

  it('round-trip: params stored as JSON and re-parsed by the worker are identical', () => {
    for (const raw of [
      { fromMonth: '2026-10', toMonth: '2026-10', format: 'xlsx', program: 'Gold', outletType: 'RETAIL', managerId: 'su-1', bucket: 'ACHIEVED' },
      { fromMonth: '2026-01', toMonth: '2026-06', program: '' },
    ]) {
      const api = p(raw);
      const worker = p(JSON.parse(JSON.stringify(raw)));
      expect(worker).toEqual(api);
      expect(parseTargetVsSalesParams(JSON.parse(JSON.stringify(raw)))).toEqual(api);
    }
  });
});

describe('Overview billing card ⇔ Target vs Sales billing bucket — the same fixture never disagrees', () => {
  const M = monthOffset(-1);

  /** A varied tenant: every band, zero / negative / no target, scoped KPI, parked + deactivated outlets, filters. */
  function equivalenceWorld() {
    const outlets: Row[] = [];
    const targets: Row[] = [];
    const sales: Row[] = [];
    const assignments: Row[] = [];
    const pairs: Array<[number | null, number | null]> = [
      [100, 0], [100, -5], [100, 0.1], [100, 19.99], [100, 20], [100, 39.9], [100, 40], [100, 59.99], [100, 60], [100, 79.9],
      [100, 80], [100, 99.996], [100, 100], [100, 250], [0, 50], [-10, 5], [null, 30], [33.33, 33.325], [1e6, 999_999.99], [7, 3.5],
    ];
    const reps = ['isr1', 'isr2', 'isr3', 'so2'];
    for (let i = 0; i < 60; i++) {
      const code = `E${String(i).padStart(3, '0')}`;
      const [t, a] = pairs[i % pairs.length];
      const rep = reps[i % reps.length];
      outlets.push({
        id: `eo-${i}`,
        clientId: 'bajaj',
        outletCode: code,
        outletType: { code: i % 3 === 0 ? 'WHOLESALE' : 'RETAIL' },
        programName: i % 2 ? 'Gold' : 'Silver ',
        programCategory: i % 4 === 0 ? 'Rural' : null,
        kycIntent: i === 7 ? 'PARKED' : i === 8 ? 'NOT_INTERESTED' : null,
        deactivatedAt: i === 9 ? new Date() : null,
        salesAssignments: [{ salesUserId: rep }],
      });
      assignments.push({ salesUserId: rep, outletId: `eo-${i}` });
      if (t !== null) targets.push({ clientId: 'bajaj', outletCode: code, month: M, outletName: code, targetValues: { TOTAL: t, OTHER: 5 } });
      if (a !== null) sales.push({ clientId: 'bajaj', outletCode: code, month: M, kpiValues: { TOTAL: a } });
    }
    return db({
      kpis: [
        { clientId: 'bajaj', code: 'OTHER', label: 'Other', unit: null, order: 0 },
        // The card's KPI = the flagged primary (not the first by order), scoped to RETAIL → WHOLESALE outlets are "not covered".
        { clientId: 'bajaj', code: 'TOTAL', label: 'Total', unit: 'INR', order: 5, isPrimary: true, outletTypes: ['RETAIL'] },
      ],
      levels: BAJAJ_LEVELS,
      salesUsers: [
        su('rsm', 'RSM', null), su('asm1', 'ASM', 'rsm'), su('so1', 'SO', 'asm1'), su('so2', 'SO', 'asm1'),
        su('isr1', 'XSR', 'so1'), su('isr2', 'XSR', 'so1'), su('isr3', 'XSR', 'so2'),
      ],
      outlets,
      assignments,
      targets,
      sales,
    });
  }

  function cardLabelByOutlet(d: Awaited<ReturnType<typeof loadBillingProgress>>): Map<string, string> {
    const m = new Map<string, string>();
    for (const r of d.inScope) m.set(r.outletCode, BILLING_BUCKETS.find((b) => b.key === r.bucket)!.label);
    for (const r of d.noTarget) m.set(r.outletCode, billingListLabel('NO_TARGET'));
    for (const r of d.notCovered) m.set(r.outletCode, billingListLabel('NOT_COVERED'));
    return m;
  }

  const FILTER_SETS: Array<Partial<BillingProgressFilters>> = [
    {},
    { program: 'Gold' },
    { program: 'Silver', outletType: 'RETAIL' },
    { managerId: 'so1' },
    { managerId: 'asm1', program: 'Gold' },
  ];

  for (const f of FILTER_SETS) {
    it(`every outlet row agrees with the card, and every band lists the same outlets — filters ${JSON.stringify(f)}`, async () => {
      const prisma = equivalenceWorld();
      const filters: BillingProgressFilters = { month: M, program: null, outletType: null, managerId: null, ...f };
      const card = await loadBillingProgress(prisma as unknown as PrismaService, 'bajaj', filters, new Date());
      const cardLabels = cardLabelByOutlet(card);

      const { sheet } = await render(prisma, { fromMonth: M, toMonth: M, ...f });
      const report = new Map(sheet.slice(1).map((r) => [String(r[0]), String(r[BUCKET_COL])]));
      expect(report.size).toBeGreaterThan(0);

      for (const [code, label] of report) {
        if (label === TVS_BUCKET_NOT_LIVE) {
          expect(cardLabels.has(code)).toBe(false); // the card does not count it either
          continue;
        }
        expect({ code, label }).toEqual({ code, label: cardLabels.get(code) });
      }
      // Every bucketed outlet on the card (it has a target row) is in the report with the same band — and the
      // report's bucket filter returns exactly the card's list for that band.
      for (const b of BILLING_BUCKETS) {
        const cardSet = card.inScope.filter((r) => r.bucket === b.key).map((r) => r.outletCode).sort();
        const reportSet = [...report].filter(([, l]) => l === b.label).map(([c]) => c).sort();
        expect({ band: b.key, outlets: reportSet }).toEqual({ band: b.key, outlets: cardSet });
        const filtered = await render(prisma, { fromMonth: M, toMonth: M, ...f, bucket: b.key });
        expect({ band: b.key, outlets: filtered.sheet.slice(1).map((r) => String(r[0])).sort() }).toEqual({ band: b.key, outlets: cardSet });
      }
    }, 60_000);
  }
});

