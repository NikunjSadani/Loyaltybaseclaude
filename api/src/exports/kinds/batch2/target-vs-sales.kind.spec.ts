import { BadRequestException } from '@nestjs/common';
import { buildXlsx } from '../../../common/xlsx';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { TargetsService } from '../../../targets/targets.service';
import {
  buildTargetVsSalesRows,
  targetVsSalesHeaderKeys,
  targetVsSalesMonthList,
  type PaceMonthResult,
} from '../../../admin-programs/reports/report-helpers';
import { TARGET_VS_SALES_KIND } from './target-vs-sales.kind';
import { ctxFor, expectSameWorkbook, fakeModel, maxPage, readBook, renderKind } from './parity.support-spec';

/** Real exceljs build + SheetJS read-backs: explicit headroom for a loaded full-suite run (alone: well under 1 s). */
const XLSX_TIMEOUT = 30_000;

const ADMIN = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: 'A' } as JwtPayload;

type Row = Record<string, unknown>;

function db(opts: { kpis: Row[]; targets: Row[]; sales: Row[]; outlets: Row[] }) {
  let n = 0;
  const id = () => `id${String(++n).padStart(6, '0')}`;
  return {
    kpiDef: fakeModel(opts.kpis.map((k) => ({ id: id(), enabled: true, outletType: null, outletTypes: [], programs: [], subPrograms: [], ...k }))),
    outletTarget: fakeModel(opts.targets.map((r) => ({ id: id(), ...r }))),
    outletSalesRecord: fakeModel(opts.sales.map((r) => ({ id: id(), ...r }))),
    outlet: fakeModel(opts.outlets.map((r) => ({ id: id(), deletedAt: null, programName: null, programCategory: null, ...r }))),
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

describe('target-vs-sales export kind', () => {
  it('parity: same sheet, headers and every cell as the old in-memory download', async () => {
    const prisma = fixture();
    const expected = await oldDownload(prisma, ADMIN, '2026-01', '2026-03');
    const params = TARGET_VS_SALES_KIND.parseParams({ fromMonth: '2026-01', toMonth: '2026-03', format: 'xlsx' }, ADMIN);
    const { buffer, rowCount } = await renderKind(TARGET_VS_SALES_KIND, ctxFor(ADMIN, prisma), params);
    expectSameWorkbook(buffer, expected);
    expect(rowCount).toBe(4 * 3); // a1, B2, b10, DEL × 3 months
    const s = readBook(buffer).sheets['Target vs Sales'];
    expect(s.aoa[0]).toEqual(['Outlet Code', 'Outlet Name', 'Outlet Type', 'Month', 'Volume Target', 'Volume Achieved', 'Volume Pace %', "'=Focus Target", "'=Focus Achieved", "'=Focus Pace %"]);
    // Foreign tenant and out-of-range outlets never appear.
    const codes = new Set(s.aoa.slice(1).map((r) => r[0]));
    expect(codes).toEqual(new Set(['a1', 'B2', 'b10', 'DEL']));
    // Deleted outlet name keeps the formula guard; numbers stay numbers.
    expect(s.aoa.find((r) => r[0] === 'DEL')?.[1]).toBe("'+Deleted shop");
    expect(s.aoa.find((r) => r[0] === 'b10' && r[3] === '2026-01')?.slice(4, 7)).toEqual([100, 87.53, 87.5]);
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
    const params = TARGET_VS_SALES_KIND.parseParams({ fromMonth: '2026-05', toMonth: '2026-05' }, ADMIN);
    expectSameWorkbook((await renderKind(TARGET_VS_SALES_KIND, ctxFor(ADMIN, prisma), params)).buffer, expected);
  }, XLSX_TIMEOUT);

  it('parity: no data → header + one blank row', async () => {
    const prisma = db({ kpis: KPIS, outlets: [], targets: [], sales: [] });
    const expected = await oldDownload(prisma, ADMIN, '2026-01', '2026-02');
    const params = TARGET_VS_SALES_KIND.parseParams({ fromMonth: '2026-01', toMonth: '2026-02' }, ADMIN);
    const { buffer, rowCount } = await renderKind(TARGET_VS_SALES_KIND, ctxFor(ADMIN, prisma), params);
    expectSameWorkbook(buffer, expected);
    expect(rowCount).toBe(0);
  }, XLSX_TIMEOUT);

  it('pages: 2,100 outlets × 3 months — identical output, no read returns more than 2,000 rows', async () => {
    const outlets: Row[] = [];
    const targets: Row[] = [];
    const sales: Row[] = [];
    for (let i = 0; i < 2100; i++) {
      const code = `O${String(i).padStart(5, '0')}`;
      outlets.push({ clientId: 'bajaj', outletCode: code, outletType: { code: i % 2 ? 'RETAIL' : 'WHOLESALE' } });
      for (const m of ['2026-01', '2026-02', '2026-03']) {
        if ((i + m.length) % 3) targets.push({ clientId: 'bajaj', outletCode: code, month: m, outletName: `Shop ${i}`, targetValues: { VOL: i } });
        if (i % 5) sales.push({ clientId: 'bajaj', outletCode: code, month: m, kpiValues: { VOL: i / 2 } });
      }
    }
    const prisma = db({ kpis: KPIS, outlets, targets, sales });
    const expected = await oldDownload(prisma, ADMIN, '2026-01', '2026-03');
    for (const m of [prisma.outletTarget, prisma.outletSalesRecord, prisma.outlet]) m.findMany.mockClear();
    const params = TARGET_VS_SALES_KIND.parseParams({ fromMonth: '2026-01', toMonth: '2026-03' }, ADMIN);
    const { buffer, rowCount } = await renderKind(TARGET_VS_SALES_KIND, ctxFor(ADMIN, prisma), params);
    const qualifying = new Set([...targets, ...sales].map((r) => r.outletCode)).size;
    expect(qualifying).toBeGreaterThan(1900); // outlets with no data in the range are not rows
    expect(rowCount).toBe(qualifying * 3);
    expectSameWorkbook(buffer, expected);
    expect(prisma.outletTarget.findMany.mock.calls.length).toBeGreaterThan(1);
    for (const m of [prisma.outletTarget, prisma.outletSalesRecord, prisma.outlet]) expect(await maxPage(m)).toBeLessThanOrEqual(2000);
    // 2,100 outlets = one full 2,000-row page + a partial one (the smallest fixture that crosses it); 3 months of
    // old-path getPace + the streamed build + two read-backs — explicit headroom for a loaded full-suite run.
  }, 60_000);

  it('params: same validation as the endpoint; > 3 months is heavy; range ≤ 15', () => {
    const p = (raw: unknown) => TARGET_VS_SALES_KIND.parseParams(raw, ADMIN);
    expect(() => p({ fromMonth: '2026-13', toMonth: '2026-01' })).toThrow(BadRequestException);
    expect(() => p({ fromMonth: '2026-05', toMonth: '2026-03' })).toThrow(/must not be after/);
    expect(() => p({ fromMonth: '2025-01', toMonth: '2026-04' })).toThrow(/maximum allowed is 15/);
    expect(() => p({ fromMonth: '2026-01', toMonth: '2026-02', bogus: 1 })).toThrow(BadRequestException);
    expect(() => p({ toMonth: '2026-02' })).toThrow(BadRequestException);
    // requestOrigin is server-set on every request — never a validation error.
    expect(p({ fromMonth: '2026-01', toMonth: '2026-03', requestOrigin: 'https://x' }).months).toHaveLength(3);
    expect(TARGET_VS_SALES_KIND.isHeavy(p({ fromMonth: '2026-01', toMonth: '2026-03' }))).toBe(false);
    expect(TARGET_VS_SALES_KIND.isHeavy(p({ fromMonth: '2026-01', toMonth: '2026-04' }))).toBe(true);
    expect(TARGET_VS_SALES_KIND.access).toEqual({ roles: ['CLIENT_ADMIN', 'GIFSY_ADMIN'], permission: 'targets:read' });
    expect(TARGET_VS_SALES_KIND.fileName(p({ fromMonth: '2026-01', toMonth: '2026-03' }), new Date())).toBe('target-vs-sales-2026-01-to-2026-03.xlsx');
    expect(TARGET_VS_SALES_KIND.describeParams(p({ fromMonth: '2026-01', toMonth: '2026-03' }))).toBe('Jan 2026 – Mar 2026');
  });
});
