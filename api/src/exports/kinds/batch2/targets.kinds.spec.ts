/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '../../../common/xlsx';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { appliesToOutlet, kpiAppliesTo } from '../../../common/applies-to/applies-to';
import { kpiScopeEnforced } from '../../../targets/targets.service';
import {
  FIXED_COLS,
  OUT_OF_SCOPE_CELL,
  SCOPE_INFO_COLS,
  getEnabledKpis,
  parseTargetUploadBuffer,
  type KpiDefLike,
  type OutletLike,
  type TemplateScopeOptions,
} from '../../../targets/targets.helpers';
import {
  ACHIEVEMENTS_EXPORT_KIND,
  ACHIEVEMENTS_TEMPLATE_KIND,
  TARGETS_EXPORT_KIND,
  TARGETS_TEMPLATE_KIND,
  assertTargetsDownloadable,
} from './targets.kinds';
import { ctxFor, expectSameWorkbook, fakeModel, maxPage, readBook, renderKind } from './parity.support-spec';

const PROGRAM_NAME_COL = 'Program Name';

// ═══ REFERENCE COPY of the old in-memory builders (targets.helpers.ts before the Downloads page, verbatim) ═══════
function old_generateTargetTemplateBuffer(
  kpis: KpiDefLike[],
  months: string[],
  outlets: OutletLike[],
  opts?: { scope?: TemplateScopeOptions },
): Buffer {
  const enabled = getEnabledKpis(kpis);
  const scope = opts?.scope;
  // Identity columns: the shared FIXED_COLS, plus the D2 info columns ONLY for a scoped template.
  const fixedCols: readonly string[] = scope ? [...FIXED_COLS, ...SCOPE_INFO_COLS] : FIXED_COLS;

  // A KPI emits a "name override" column (a per-outlet custom display name) ONLY
  // when it is explicitly configured with hasNameOverride + a nameOverrideLabel.
  // KPIs without an override keep their single value column — the template /
  // parse round-trip is byte-identical for them.
  const hasOverrideCol = (k: KpiDefLike): boolean =>
    !!(k.hasNameOverride && k.nameOverrideLabel);

  // Per-month block width = one value column per enabled KPI, PLUS one extra
  // name column for each KPI that has a name override.
  const overrideCount = enabled.filter(hasOverrideCol).length;
  const blockWidth = enabled.length + overrideCount;

  // ── Row 1: month group headers ──────────────────────────────────────────────
  const row1: (string | number)[] = Array(fixedCols.length).fill('');
  for (const month of months) {
    const [year, mm] = month.split('-');
    const abbr = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][
      Number(mm) - 1
    ];
    const label = `${abbr} '${year.slice(2)} Target`;
    row1.push(label);
    for (let i = 1; i < blockWidth; i++) row1.push('');
  }

  // ── Row 2: column headers ────────────────────────────────────────────────────
  // For each KPI emit its value-label column; immediately AFTER it (adjacent,
  // value-first) emit the nameOverrideLabel header when the KPI has an override.
  const row2: string[] = [...fixedCols];
  for (let mi = 0; mi < months.length; mi++) {
    for (const kpi of enabled) {
      row2.push(kpi.label);
      if (hasOverrideCol(kpi)) row2.push(kpi.nameOverrideLabel as string);
    }
  }

  // ── Data rows (pre-filled outlet info; KPI + name cells blank) ─────────────
  const dataRows = outlets.map((o) => {
    if (scope) {
      // Scoped layout (D2): info columns + `N/A` in each out-of-scope VALUE cell. The adjacent
      // name-override cell stays blank (a typed name there is ignored on upload anyway).
      const row: (string | number)[] = [o.outletCode, o.name, o.outletType, o.program ?? '', o.subProgram ?? ''];
      const inScope = enabled.map((k) => scope.isInScope(o, k.code));
      for (let mi = 0; mi < months.length; mi++) {
        enabled.forEach((kpi, ki) => {
          row.push(inScope[ki] ? '' : OUT_OF_SCOPE_CELL);
          if (hasOverrideCol(kpi)) row.push('');
        });
      }
      return row;
    }
    const row: (string | number)[] = [o.outletCode, o.name, o.outletType];
    for (let mi = 0; mi < months.length; mi++) {
      for (let ci = 0; ci < blockWidth; ci++) row.push('');
    }
    return row;
  });

  const ws = aoaToSheetSafe([row1, row2, ...dataRows]);

  // Column widths — mirror the value+name column layout per month block.
  const colWidths: { wch: number }[] = [
    { wch: 16 }, // Outlet ID
    { wch: 24 }, // Outlet Name
    { wch: 16 }, // Outlet Type
  ];
  if (scope) colWidths.push({ wch: 20 }, { wch: 20 }); // Program, Sub-Program
  for (let mi = 0; mi < months.length; mi++) {
    for (const kpi of enabled) {
      colWidths.push({ wch: kpi.isPrimary ? 14 : 18 });
      if (hasOverrideCol(kpi)) colWidths.push({ wch: 22 }); // name override column
    }
  }
  ws['!cols'] = colWidths;

  // Merge month group header cells (row 1) across the full (wider) block.
  const merges: XLSX.Range[] = [];
  let colOffset = fixedCols.length;
  for (let mi = 0; mi < months.length; mi++) {
    merges.push({
      s: { r: 0, c: colOffset },
      e: { r: 0, c: colOffset + blockWidth - 1 },
    });
    colOffset += blockWidth;
  }
  ws['!merges'] = merges;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Targets');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ── buildResolvedTargetsBuffer ────────────────────────────────────────────────

/**
 * Build a "final targets" export for ONE month — a verbatim dump of the stored
 * `OutletTarget.targetValues` per outlet (NO geo-resolution / compute; the
 * no-compute model just surfaces what was uploaded). Blank cell = the KPI was
 * never configured for that outlet-month (key omitted from targetValues).
 *
 * @param month  YYYY-MM being exported.
 * @param kpis   The tenant's KpiDef rows (only enabled ones become columns).
 * @param rows   Stored OutletTarget rows for that month.
 */
function old_buildResolvedTargetsBuffer(
  month: string,
  kpis: KpiDefLike[],
  rows: {
    outletCode: string;
    outletName: string | null;
    outletType: string | null;
    targetValues: unknown;
    programName?: string | null;
  }[],
): Buffer {
  const enabled = getEnabledKpis(kpis);

  // Identity columns for THIS export = the shared FIXED_COLS + a read-only "Program Name" column
  // (for filtering/analysis). Injected locally, NOT into the shared FIXED_COLS constant, so the
  // blank-template + upload-parser paths are untouched. The upload parser resolves the fixed cols
  // by header name and KPI cols by label (ignoring unknown columns), so this stays re-uploadable.
  const identityCols = [...FIXED_COLS, 'Program Name'];

  // CRITICAL: emit the SAME two-row month-group layout that
  // generateTargetTemplateBuffer produces, so a downloaded Final-Targets file
  // can be re-uploaded straight back through parseTargetUploadBuffer (which
  // requires row 1 = month-group headers and row 2 = fixed cols + KPI labels).
  // A single-header layout parses to 0 rows.

  // ── Row 1: month group header (one merged span for the single month) ────────
  const [year, mm] = month.split('-');
  const abbr = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][
    Number(mm) - 1
  ];
  const monthLabel = `${abbr} '${year.slice(2)} Target`;
  const row1: (string | number)[] = Array(identityCols.length).fill('');
  row1.push(monthLabel);
  for (let i = 1; i < enabled.length; i++) row1.push('');

  // ── Row 2: column headers ───────────────────────────────────────────────────
  const row2: string[] = [...identityCols, ...enabled.map((k) => k.label)];

  // ── Data rows (verbatim stored values; blank = KPI not configured) ──────────
  const dataRows = rows.map((r) => {
    const vals = (r.targetValues ?? {}) as Record<string, unknown>;
    const out: (string | number)[] = [
      r.outletCode,
      r.outletName ?? '',
      r.outletType ?? '',
      r.programName ?? '',
    ];
    for (const k of enabled) {
      const v = vals[k.code];
      out.push(typeof v === 'number' ? v : ''); // blank = not configured
    }
    return out;
  });

  const ws = aoaToSheetSafe([row1, row2, ...dataRows]);
  ws['!cols'] = [
    { wch: 16 },
    { wch: 24 },
    { wch: 16 },
    { wch: 20 }, // Program Name
    ...enabled.map(() => ({ wch: 16 })),
  ];

  // Merge the month-group header cell across its KPI columns (row 1).
  if (enabled.length > 0) {
    ws['!merges'] = [
      {
        s: { r: 0, c: identityCols.length },
        e: { r: 0, c: identityCols.length + enabled.length - 1 },
      },
    ];
  }

  const wb = XLSX.utils.book_new();
  // Sheet names cap at 31 chars and disallow some punctuation — month is safe.
  XLSX.utils.book_append_sheet(wb, ws, `Final Targets ${month}`);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ── buildSalesDataBuffer ──────────────────────────────────────────────────────

/**
 * Extra identity column that the "Download Sales Data" export adds and the
 * target/achievement side does NOT emit. Sits AFTER the fixed identity columns
 * and BEFORE the month block. It is sourced by joining Outlet.programName (which
 * is NOT denormalized on OutletSalesRecord) — never a KPI code.
 */

/**
 * Build a "sales data" export for ONE month — a verbatim dump of the stored
 * `OutletSalesRecord.kpiValues` per outlet (NO compute), in the SAME month-group
 * 2-row layout `generateTargetTemplateBuffer` produces, PLUS a "Program Name"
 * column. This is the achievement-side twin of `buildResolvedTargetsBuffer`.
 *
 * RE-UPLOAD SAFETY (hard requirement): the produced file must ingest cleanly back
 * through `uploadAchievements` → `parseTargetUploadBuffer`. The parser (a) finds
 * the fixed columns by NAME (`Outlet ID`/`Outlet Name`/`Outlet Type`), (b) detects
 * month blocks from row 1 via `parseMonthHeader`, and (c) matches KPI columns by
 * LABEL within each month block's column range `[block.startCol, nextBlock.startCol)`.
 * The Program Name column is placed at column index `FIXED_COLS.length` — strictly
 * BEFORE the single month block's start column — so it is never inside a block's
 * range, is not a fixed column the parser looks up, and its "Program Name" label
 * resolves to neither a KPI nor an override → it is silently ignored on re-upload,
 * while every identity column resolves by name and every KPI column by label. Blank
 * cell = the KPI was never configured for that outlet-month (key omitted).
 *
 * @param month  YYYY-MM being exported.
 * @param kpis   The tenant's KpiDef rows (only enabled ones become columns).
 * @param rows   Stored OutletSalesRecord rows for that month, each carrying the
 *               outlet's Program Name resolved from the Outlet join.
 */
function old_buildSalesDataBuffer(
  month: string,
  kpis: KpiDefLike[],
  rows: {
    outletCode: string;
    outletName: string | null;
    outletType: string | null;
    programName: string | null;
    kpiValues: unknown;
  }[],
): Buffer {
  const enabled = getEnabledKpis(kpis);

  // ── Row 1: month group header ───────────────────────────────────────────────
  // Anchored at the FIRST KPI column, which now sits one column further right than
  // the target export because of the inserted Program Name column.
  const [year, mm] = month.split('-');
  const abbr = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][
    Number(mm) - 1
  ];
  const monthLabel = `${abbr} '${year.slice(2)} Target`;

  // Identity block = the 3 fixed cols + the Program Name col. The month block
  // begins immediately after it.
  const identityColCount = FIXED_COLS.length + 1;

  const row1: (string | number)[] = Array(identityColCount).fill('');
  row1.push(monthLabel);
  for (let i = 1; i < enabled.length; i++) row1.push('');

  // ── Row 2: column headers (identity + Program Name + KPI value labels) ───────
  const row2: string[] = [...FIXED_COLS, PROGRAM_NAME_COL, ...enabled.map((k) => k.label)];

  // ── Data rows (verbatim stored values; blank = KPI not configured) ──────────
  const dataRows = rows.map((r) => {
    const vals = (r.kpiValues ?? {}) as Record<string, unknown>;
    const out: (string | number)[] = [
      r.outletCode,
      r.outletName ?? '',
      r.outletType ?? '',
      r.programName ?? '', // Program Name from the Outlet join (blank if unset)
    ];
    for (const k of enabled) {
      const v = vals[k.code];
      out.push(typeof v === 'number' ? v : ''); // blank = not configured
    }
    return out;
  });

  const ws = aoaToSheetSafe([row1, row2, ...dataRows]);
  ws['!cols'] = [
    { wch: 16 }, // Outlet ID
    { wch: 24 }, // Outlet Name
    { wch: 16 }, // Outlet Type
    { wch: 22 }, // Program Name
    ...enabled.map(() => ({ wch: 16 })),
  ];

  // Merge the month-group header cell across its KPI columns (row 1), starting at
  // the first KPI column (immediately after the identity block).
  if (enabled.length > 0) {
    ws['!merges'] = [
      {
        s: { r: 0, c: identityColCount },
        e: { r: 0, c: identityColCount + enabled.length - 1 },
      },
    ];
  }

  const wb = XLSX.utils.book_new();
  // Sheet names cap at 31 chars — "Sales Data 2026-07" is well under.
  XLSX.utils.book_append_sheet(wb, ws, `Sales Data ${month}`);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}


// ═══ REFERENCE COPY of the old TargetsService download methods (queries + calls, before the Downloads page) ══════

const toLike = (k: any): KpiDefLike => ({
  code: k.code, label: k.label, isPrimary: k.isPrimary, hasNameOverride: k.hasNameOverride,
  nameOverrideLabel: k.nameOverrideLabel ?? null, order: k.order, enabled: k.enabled,
});

async function oldTemplate(prisma: any, user: JwtPayload, months: string[], achievement: boolean): Promise<Buffer> {
  let kpiRows = await prisma.kpiDef.findMany({ where: { clientId: user.clientId, enabled: true }, orderBy: [{ order: 'asc' }, { code: 'asc' }] });
  if (achievement) {
    const owned = (await prisma.salesKpiDefinition.findMany({ where: { clientId: user.clientId, enabled: true } })).map((d: any) => d.kpiCode);
    if (owned.length) kpiRows = kpiRows.filter((k: any) => !owned.includes(k.code));
  }
  const outlets = await prisma.outlet.findMany({ where: { clientId: user.clientId, deletedAt: null }, orderBy: { outletCode: 'asc' } });
  const kpis = kpiRows.map(toLike);
  if (kpiScopeEnforced(kpiRows)) {
    const scopes = new Map<string, any>(kpiRows.map((k: any) => [k.code, kpiAppliesTo(k)]));
    const list: OutletLike[] = outlets.map((o: any) => ({
      outletCode: o.outletCode, name: o.name, outletType: o.outletType.code, program: o.programName ?? null, subProgram: o.programCategory ?? null,
    }));
    return old_generateTargetTemplateBuffer(kpis, months, list, {
      scope: {
        isInScope: (o, code) => {
          const sc = scopes.get(code);
          return !sc || appliesToOutlet(sc, { outletType: o.outletType, program: o.program, subProgram: o.subProgram });
        },
      },
    });
  }
  return old_generateTargetTemplateBuffer(kpis, months, outlets.map((o: any) => ({ outletCode: o.outletCode, name: o.name, outletType: o.outletType.code })));
}

async function oldExport(prisma: any, user: JwtPayload, month: string, sales: boolean): Promise<Buffer> {
  const kpiRows = await prisma.kpiDef.findMany({ where: { clientId: user.clientId, enabled: true }, orderBy: [{ order: 'asc' }, { code: 'asc' }] });
  const model = sales ? prisma.outletSalesRecord : prisma.outletTarget;
  const rows = await model.findMany({ where: { clientId: user.clientId, month }, orderBy: { outletCode: 'asc' } });
  const codes = rows.map((r: any) => r.outletCode);
  const outlets = codes.length ? await prisma.outlet.findMany({ where: { clientId: user.clientId, outletCode: { in: codes }, deletedAt: null } }) : [];
  const program = new Map(outlets.map((o: any) => [o.outletCode, o.programName]));
  const type = new Map(outlets.map((o: any) => [o.outletCode, o.outletType?.code]));
  if (sales) {
    return old_buildSalesDataBuffer(month, kpiRows.map(toLike), rows.map((r: any) => ({
      outletCode: r.outletCode, outletName: r.outletName, outletType: type.get(r.outletCode) ?? '', programName: program.get(r.outletCode) ?? null, kpiValues: r.kpiValues,
    })) as any);
  }
  return old_buildResolvedTargetsBuffer(month, kpiRows.map(toLike), rows.map((r: any) => ({
    ...r, outletType: type.get(r.outletCode) ?? '', programName: program.get(r.outletCode) ?? '',
  })) as any);
}

// ═══ Fixture ═════════════════════════════════════════════════════════════════════════════════════════════════

const ADMIN = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: 'A' } as JwtPayload;
type Row = Record<string, unknown>;

function db(o: { kpis: Row[]; outlets: Row[]; targets?: Row[]; sales?: Row[]; owned?: string[] }) {
  let n = 0;
  const id = () => `id${String(++n).padStart(6, '0')}`;
  const kpi = (k: Row) => ({
    id: id(), clientId: 'bajaj', enabled: true, isPrimary: false, hasNameOverride: false, nameOverrideLabel: null,
    outletType: null, outletTypes: [], programs: [], subPrograms: [], ...k,
  });
  return {
    kpiDef: fakeModel(o.kpis.map(kpi)),
    outlet: fakeModel(o.outlets.map((r) => ({ id: id(), clientId: 'bajaj', deletedAt: null, programName: null, programCategory: null, ...r }))),
    outletTarget: fakeModel((o.targets ?? []).map((r) => ({ id: id(), clientId: 'bajaj', ...r }))),
    outletSalesRecord: fakeModel((o.sales ?? []).map((r) => ({ id: id(), clientId: 'bajaj', ...r }))),
    salesKpiDefinition: fakeModel((o.owned ?? []).map((kpiCode) => ({ id: id(), clientId: 'bajaj', enabled: true, kpiCode }))),
  };
}

const KPIS: Row[] = [
  { code: 'VOL', label: 'Volume', isPrimary: true, order: 1 },
  { code: 'FP1', label: 'Focus Pack 1', order: 2, hasNameOverride: true, nameOverrideLabel: 'Focus Pack 1 Name' },
  { code: 'CON', label: '=Consistency', order: 3 },
  { code: 'OFF', label: 'Off', order: 4, enabled: false },
  { clientId: 'other', code: 'X', label: 'Other tenant', order: 1 },
];

/** The same KPIs WITHOUT any per-outlet name column (Final Targets must then be byte-identical to the old builder). */
const KPIS_NO_NAMES: Row[] = KPIS.map((k) => ({ ...k, hasNameOverride: false, nameOverrideLabel: null }));

function roster(): Row[] {
  return [
    { outletCode: 'A1', name: 'Alpha', outletType: { code: 'RETAIL' }, programName: 'Gold', programCategory: 'Tier A' },
    { outletCode: 'B2', name: '+Beta', outletType: { code: 'WHOLESALE' } },
    { outletCode: 'C3', name: 'Gamma', outletType: { code: 'SSS' }, programName: 'Silver' },
    { outletCode: 'D4', name: 'Deleted', outletType: { code: 'RETAIL' }, deletedAt: new Date() },
    { clientId: 'other', outletCode: 'Z9', name: 'Foreign', outletType: { code: 'RETAIL' } },
  ];
}

/** Real exceljs build + SheetJS read-backs: explicit headroom for a loaded full-suite run (alone: well under 1 s). */
const XLSX_TIMEOUT = 30_000;
/** Paging tests: 2,100 rows = one full 2,000-row page + a partial one — the smallest fixture that crosses the boundary. */
const PAGING_TIMEOUT = 60_000;

async function render(kind: any, prisma: unknown, raw: Row) {
  return renderKind(kind, ctxFor(ADMIN, prisma), kind.parseParams(raw, ADMIN));
}

describe('targets-template / achievements-template export kinds', () => {
  it('parity (unscoped tenant): target template, 2 months — identical to the old builder incl. merges', async () => {
    const prisma = db({ kpis: KPIS, outlets: roster() });
    const expected = await oldTemplate(prisma, ADMIN, ['2026-07', '2026-08'], false);
    const { buffer, rowCount } = await render(TARGETS_TEMPLATE_KIND, prisma, { months: '2026-07,2026-08' });
    expectSameWorkbook(buffer, expected);
    expect(rowCount).toBe(3); // A1, B2, C3 — deleted + foreign excluded
    const s = readBook(buffer).sheets.Targets;
    expect(s.merges).toEqual([{ s: { r: 0, c: 3 }, e: { r: 0, c: 6 } }, { s: { r: 0, c: 7 }, e: { r: 0, c: 10 } }]);
    expect(s.aoa[3][1]).toBe("'+Beta"); // cellSafe
  }, XLSX_TIMEOUT);

  it('parity (scoped tenant): Program / Sub-Program + N/A cells; achievement template drops importer-owned KPIs', async () => {
    const kpis = [KPIS[0], { ...KPIS[1], programs: ['Gold'] }, { ...KPIS[2], outletTypes: ['SSS'] }];
    const prisma = db({ kpis, outlets: roster(), owned: ['VOL'] });
    expectSameWorkbook((await render(TARGETS_TEMPLATE_KIND, prisma, { months: '2026-07' })).buffer, await oldTemplate(prisma, ADMIN, ['2026-07'], false));
    const ach = (await render(ACHIEVEMENTS_TEMPLATE_KIND, prisma, { month: '2026-06' })).buffer;
    expectSameWorkbook(ach, await oldTemplate(prisma, ADMIN, ['2026-06'], true));
    expect(readBook(ach).sheets.Targets.aoa[1]).not.toContain('Volume');
    expect(readBook(ach).sheets.Targets.aoa.flat()).toContain(OUT_OF_SCOPE_CELL);
  }, XLSX_TIMEOUT);

  it('ACHIEVEMENT-ONLY KPI: no column in the target template / Final Targets (identical to a tenant without it); kept in the achievement template', async () => {
    const cases = { ...KPIS[2], code: 'BSC CASES', label: 'BSC Cases', order: 99, achievementOnly: true };
    const withCases = db({ kpis: [...KPIS, cases], outlets: roster() });
    const without = db({ kpis: KPIS, outlets: roster() });
    // Same bytes as the tenant that never had the KPI (and = the old builder) — Deoleo's file is untouched by the flag.
    const tpl = (await render(TARGETS_TEMPLATE_KIND, withCases, { months: '2026-07' })).buffer;
    expectSameWorkbook(tpl, (await render(TARGETS_TEMPLATE_KIND, without, { months: '2026-07' })).buffer);
    expectSameWorkbook(tpl, await oldTemplate(without, ADMIN, ['2026-07'], false));
    expect(readBook(tpl).sheets.Targets.aoa[1]).not.toContain('BSC Cases');
    expect(readBook((await render(ACHIEVEMENTS_TEMPLATE_KIND, withCases, { month: '2026-07' })).buffer).sheets.Targets.aoa[1])
      .toContain('BSC Cases');
    const fin = (await render(TARGETS_EXPORT_KIND, withCases, { month: '2026-07' })).buffer;
    expect(XLSX.utils.sheet_to_json<unknown[]>(XLSX.read(fin, { type: 'buffer' }).Sheets[XLSX.read(fin, { type: 'buffer' }).SheetNames[0]], { header: 1 })[1])
      .not.toContain('BSC Cases');
    const allAo = db({ kpis: [cases], outlets: roster() });
    await expect(assertTargetsDownloadable(allAo as any, 'bajaj', 'targets-template')).rejects.toThrow(/achievement only/);
    await expect(assertTargetsDownloadable(allAo as any, 'bajaj', 'achievements-template')).resolves.toBeUndefined();
  }, XLSX_TIMEOUT);

  it('round trip: a filled streamed template parses back through the upload parser', async () => {
    const prisma = db({ kpis: KPIS.slice(0, 2), outlets: roster() });
    const { buffer } = await render(ACHIEVEMENTS_TEMPLATE_KIND, prisma, { month: '2026-06' });
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Targets, { header: 1, defval: '' });
    aoa[2][3] = 10;
    aoa[2][4] = 5;
    aoa[2][5] = 'Diwali';
    const out = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(aoa), 'Targets');
    const parsed = parseTargetUploadBuffer(XLSX.write(out, { type: 'buffer', bookType: 'xlsx' }), KPIS.slice(0, 2).map((k) => ({ enabled: true, isPrimary: false, hasNameOverride: false, nameOverrideLabel: null, ...k }) as any), new Set(['A1', 'B2', 'C3']));
    expect(parsed.acceptedTargets['2026-06'].A1).toEqual({ VOL: 10, FP1: 5, __names: { FP1: 'Diwali' } });
  }, XLSX_TIMEOUT);

  it('pages: 2,100 outlets — identical, ≤ 2,000 rows per read (one full page + a partial one)', async () => {
    const outlets: Row[] = Array.from({ length: 2100 }, (_, i) => ({ outletCode: `O${String(i).padStart(5, '0')}`, name: `Shop ${i}`, outletType: { code: 'RETAIL' } }));
    const prisma = db({ kpis: KPIS, outlets });
    const expected = await oldTemplate(prisma, ADMIN, ['2026-07'], false);
    prisma.outlet.findMany.mockClear();
    const { buffer, rowCount } = await render(TARGETS_TEMPLATE_KIND, prisma, { months: '2026-07' });
    expect(rowCount).toBe(2100);
    expectSameWorkbook(buffer, expected);
    expect(prisma.outlet.findMany.mock.calls.length).toBe(2);
    expect(await maxPage(prisma.outlet)).toBeLessThanOrEqual(2000);
  }, PAGING_TIMEOUT);

  it('params, heavy rule, access, names; no-KPI 400s (pre-flight + run)', async () => {
    const p = (raw: Row) => TARGETS_TEMPLATE_KIND.parseParams(raw, ADMIN);
    expect(() => p({ months: '2026-13' })).toThrow(BadRequestException);
    expect(() => p({})).toThrow(BadRequestException);
    expect(() => p({ months: '2026-01', x: 1 })).toThrow(BadRequestException);
    expect(TARGETS_TEMPLATE_KIND.isHeavy(p({ months: '2026-01,2026-02,2026-03' }))).toBe(false);
    expect(TARGETS_TEMPLATE_KIND.isHeavy(p({ months: '2026-01,2026-02,2026-03,2026-04' }))).toBe(true);
    expect(TARGETS_TEMPLATE_KIND.fileName(p({ months: '2026-01,2026-02' }), new Date())).toBe('target-template-2026-01_2026-02.xlsx');
    expect(() => ACHIEVEMENTS_TEMPLATE_KIND.parseParams({ month: '2026-13' }, ADMIN)).toThrow(BadRequestException);
    expect(ACHIEVEMENTS_TEMPLATE_KIND.fileName({ month: '2026-06' }, new Date())).toBe('sales-template-2026-06.xlsx');
    for (const k of [TARGETS_TEMPLATE_KIND, ACHIEVEMENTS_TEMPLATE_KIND, TARGETS_EXPORT_KIND, ACHIEVEMENTS_EXPORT_KIND]) {
      expect(k.access).toEqual({ roles: ['CLIENT_ADMIN', 'GIFSY_ADMIN'], permission: 'targets:read' });
    }
    const none = db({ kpis: [], outlets: roster() });
    await expect(assertTargetsDownloadable(none as any, 'bajaj', 'targets-template')).rejects.toThrow(/Seed KPIs first/);
    await expect(render(TARGETS_TEMPLATE_KIND, none, { months: '2026-07' })).rejects.toThrow(/Seed KPIs first/);
    await expect(assertTargetsDownloadable(none as any, 'bajaj', 'targets-export')).rejects.toThrow('No enabled KPIs found for this tenant.');
    const allOwned = db({ kpis: KPIS.slice(0, 1), outlets: roster(), owned: ['VOL'] });
    await expect(assertTargetsDownloadable(allOwned as any, 'bajaj', 'achievements-template')).rejects.toThrow(/fed by Sales Import/);
    await expect(assertTargetsDownloadable(allOwned as any, 'bajaj', 'targets-template')).resolves.toBeUndefined();
  }, XLSX_TIMEOUT);
});

describe('targets-export / achievements-export export kinds', () => {
  const stored = () => ({
    targets: [
      { outletCode: 'B2', month: '2026-07', outletName: 'Beta', targetValues: { VOL: 100, FP1: 20, CON: 'x', __names: { FP1: 'Combo' } } },
      { outletCode: 'A1', month: '2026-07', outletName: null, targetValues: { VOL: 0 } },
      { outletCode: 'D4', month: '2026-07', outletName: '=Deleted', targetValues: { VOL: 5 } },
      { outletCode: 'A1', month: '2026-08', outletName: 'Other month', targetValues: { VOL: 1 } },
      { clientId: 'other', outletCode: 'Z9', month: '2026-07', outletName: 'Foreign', targetValues: { VOL: 9 } },
    ],
    sales: [
      { outletCode: 'C3', month: '2026-07', outletName: 'Gamma', kpiValues: { VOL: 12.5, FP1: 0 } },
      { outletCode: 'A1', month: '2026-07', outletName: 'Alpha', kpiValues: {} },
      { clientId: 'other', outletCode: 'Z9', month: '2026-07', outletName: 'Foreign', kpiValues: { VOL: 9 } },
    ],
  });

  it('parity: final targets (verbatim values, current outlet type, program name, blank for absent/non-numeric)', async () => {
    const prisma = db({ kpis: KPIS_NO_NAMES, outlets: roster(), ...stored() });
    const { buffer, rowCount } = await render(TARGETS_EXPORT_KIND, prisma, { month: '2026-07' });
    expectSameWorkbook(buffer, await oldExport(prisma, ADMIN, '2026-07', false));
    expect(rowCount).toBe(3);
    expect(readBook(buffer).names).toEqual(['Final Targets 2026-07']);
  }, XLSX_TIMEOUT);

  it('parity: sales data', async () => {
    const prisma = db({ kpis: KPIS, outlets: roster(), ...stored() });
    const { buffer, rowCount } = await render(ACHIEVEMENTS_EXPORT_KIND, prisma, { month: '2026-07' });
    expectSameWorkbook(buffer, await oldExport(prisma, ADMIN, '2026-07', true));
    expect(rowCount).toBe(2);
  }, XLSX_TIMEOUT);

  it('parity: empty month → the two header rows only', async () => {
    const prisma = db({ kpis: KPIS_NO_NAMES, outlets: roster() });
    expectSameWorkbook((await render(TARGETS_EXPORT_KIND, prisma, { month: '2026-01' })).buffer, await oldExport(prisma, ADMIN, '2026-01', false));
    expectSameWorkbook((await render(ACHIEVEMENTS_EXPORT_KIND, prisma, { month: '2026-01' })).buffer, await oldExport(prisma, ADMIN, '2026-01', true));
  }, XLSX_TIMEOUT);

  it('pages: 2,100 stored rows — identical, ≤ 2,000 per read (rows AND the outlet join), more than one read', async () => {
    const outlets: Row[] = [];
    const targets: Row[] = [];
    for (let i = 0; i < 2100; i++) {
      const code = `O${String(i).padStart(5, '0')}`;
      outlets.push({ outletCode: code, name: `S${i}`, outletType: { code: 'RETAIL' }, programName: `P${i % 7}` });
      targets.push({ outletCode: code, month: '2026-07', outletName: `S${i}`, targetValues: { VOL: i } });
    }
    const prisma = db({ kpis: KPIS_NO_NAMES, outlets, targets });
    const expected = await oldExport(prisma, ADMIN, '2026-07', false);
    prisma.outletTarget.findMany.mockClear();
    prisma.outlet.findMany.mockClear();
    const { buffer, rowCount } = await render(TARGETS_EXPORT_KIND, prisma, { month: '2026-07' });
    expect(rowCount).toBe(2100);
    expectSameWorkbook(buffer, expected);
    expect(prisma.outletTarget.findMany.mock.calls.length).toBeGreaterThan(1);
    expect(prisma.outlet.findMany.mock.calls.length).toBeGreaterThan(1);
    expect(await maxPage(prisma.outletTarget)).toBeLessThanOrEqual(2000);
    expect(await maxPage(prisma.outlet)).toBeLessThanOrEqual(2000);
  }, PAGING_TIMEOUT);

  it('owner 2026-11-26: a KPI with a name column gets it right after its value column (header, widths, merge, stored names, cellSafe), and the export re-uploads with the names', async () => {
    const t = stored();
    t.targets[0].targetValues = { VOL: 100, FP1: 20, CON: 'x', __names: { FP1: '=Combo & ADHO500' } };
    const prisma = db({ kpis: KPIS, outlets: roster(), ...t });
    const { buffer } = await render(TARGETS_EXPORT_KIND, prisma, { month: '2026-07' });
    const s = readBook(buffer).sheets['Final Targets 2026-07'];
    expect(s.aoa[1]).toEqual(['Outlet ID', 'Outlet Name', 'Outlet Type', 'Program Name', 'Volume', 'Focus Pack 1', 'Focus Pack 1 Name', "'=Consistency"]);
    expect(s.merges).toEqual([{ s: { r: 0, c: 4 }, e: { r: 0, c: 7 } }]);
    const b2 = s.aoa.find((r: unknown[]) => r[0] === 'B2')!;
    expect(b2.slice(4, 7)).toEqual([100, 20, "'=Combo & ADHO500"]); // formula-guarded
    const a1 = s.aoa.find((r: unknown[]) => r[0] === 'A1')!;
    expect(a1[6] ?? '').toBe(''); // no stored name → blank
    // A name label equal to its KPI label (Bajaj prod) → "<label> Name", never the same header twice.
    const dup = db({ kpis: [KPIS[0], { ...KPIS[1], nameOverrideLabel: 'focus pack 1 ' }], outlets: roster(), ...stored() });
    const d = readBook((await render(TARGETS_EXPORT_KIND, dup, { month: '2026-07' })).buffer).sheets['Final Targets 2026-07'];
    expect(d.aoa[1].slice(4)).toEqual(['Volume', 'Focus Pack 1', 'Focus Pack 1 Name']);
    // Re-upload: the names come back.
    const kpiLike = [KPIS[0], KPIS[1]].map((k) => ({ enabled: true, isPrimary: false, hasNameOverride: false, nameOverrideLabel: null, ...k }) as any);
    // (the "=Consistency" header is written formula-guarded, so only VOL + FP1 are re-read here)
    const parsed = parseTargetUploadBuffer(buffer, kpiLike, new Set(['A1', 'B2', 'C3']));
    expect(parsed.acceptedTargets['2026-07'].B2).toEqual({ VOL: 100, FP1: 20, __names: { FP1: "'=Combo & ADHO500" } });
  }, XLSX_TIMEOUT);

  it('params: loose month for targets (as before), strict for sales; other query params ignored', () => {
    expect(() => TARGETS_EXPORT_KIND.parseParams({ month: 'July' }, ADMIN)).toThrow('A valid YYYY-MM "month" query param is required');
    expect(() => TARGETS_EXPORT_KIND.parseParams({}, ADMIN)).toThrow(BadRequestException);
    expect(TARGETS_EXPORT_KIND.parseParams({ month: '2026-13', extra: 'x' }, ADMIN)).toEqual({ month: '2026-13' });
    expect(() => ACHIEVEMENTS_EXPORT_KIND.parseParams({ month: '2026-13' }, ADMIN)).toThrow(BadRequestException);
    expect(TARGETS_EXPORT_KIND.isHeavy({ month: '2026-07' })).toBe(false);
    expect(ACHIEVEMENTS_EXPORT_KIND.isHeavy({ month: '2026-07' })).toBe(false);
    expect(TARGETS_EXPORT_KIND.fileName({ month: '2026-07' }, new Date())).toBe('final-targets-2026-07.xlsx');
    expect(ACHIEVEMENTS_EXPORT_KIND.fileName({ month: '2026-07' }, new Date())).toBe('sales-data-2026-07.xlsx');
  });
});

