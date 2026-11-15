/**
 * Target vs Sales Performance — the xlsx download of GET /v1/admin/reports/target-vs-sales?format=xlsx, as an export
 * kind (Downloads page design). Output is identical to the old in-memory builder (ReportsService.targetVsSales →
 * getPace per month → buildTargetVsSalesRows → buildXlsx):
 *   one sheet "Target vs Sales"; headers = Outlet Code · Outlet Name · Outlet Type · Month · <KPI> Target/Achieved/Pace %
 *   per enabled KpiDef (KpiDef order); one row per (qualifying outlet × every month), outlets in localeCompare order;
 *   blank (not 0) for absent values; an empty result is the header + one all-blank row.
 *
 * Paging: the qualifying outlet CODES (outlets with a target or sales row in the range) are read with GROUP BY and
 * sorted in Node exactly as before (localeCompare — so the row order cannot drift with the DB collation; only the code
 * strings are held, ~6.5k × 15 bytes). Then the codes are walked in chunks sized so each read is ≤ 2,000 rows
 * (chunk = 2,000 ÷ months): targets, sales and the outlet facets of that chunk only — the getPace join is
 * re-applied per (outlet, month) in memory for that chunk, then written before the next chunk is read.
 */
import { BadRequestException } from '@nestjs/common';
import { appliesToOutlet, kpiAppliesTo, type AppliesTo } from '../../../common/applies-to/applies-to';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { TargetVsSalesQueryDto } from '../../../admin-programs/dto/reports.dto';
import {
  targetVsSalesHeaderKeys,
  targetVsSalesKpiHeaders,
  targetVsSalesMonthList,
} from '../../../admin-programs/reports/report-helpers';
import { kpiScopeEnforced } from '../../../targets/targets.service';
import { kpiCodeKeys } from '../../../targets/targets.helpers';
import type { ExportKindDef, ExportRunContext } from '../../export-kinds';
import type { XlsxCell, XlsxStreamWriter } from '../../../common/xlsx-stream';
import { EXPORT_PAGE_SIZE, monthWords, parseQueryDto } from './kind-support';

/** Ranges longer than this go to the Downloads page; the on-screen JSON preview is capped at the same size. */
export const TARGET_VS_SALES_INSTANT_MAX_MONTHS = 3;

export interface TargetVsSalesParams {
  fromMonth: string;
  toMonth: string;
  months: string[];
}

/** pace ratio → percentage rounded to 1 decimal (same as report-helpers' paceToPct). */
function paceToPct(pace: number): number {
  return Math.round(pace * 1000) / 10;
}

/** Validation identical to the endpoint (DTO pipe + the service's own checks). Exported for the JSON preview. */
export function parseTargetVsSalesParams(raw: unknown): TargetVsSalesParams {
  const q = parseQueryDto(TargetVsSalesQueryDto, raw);
  const fromMonth = q.fromMonth ?? '';
  const toMonth = q.toMonth ?? '';
  if (!fromMonth || !toMonth) {
    throw new BadRequestException('Query params `fromMonth` and `toMonth` (YYYY-MM) are required.');
  }
  let months: string[];
  try {
    months = targetVsSalesMonthList(fromMonth, toMonth);
  } catch (e) {
    throw new BadRequestException(e instanceof Error ? e.message : 'Invalid period range.');
  }
  return { fromMonth, toMonth, months };
}

type Json = Record<string, unknown>;

async function run(ctx: ExportRunContext, p: TargetVsSalesParams, out: XlsxStreamWriter): Promise<{ rowCount: number }> {
  const clientId = ctx.clientId;
  const months = p.months;
  const kpiDefs = await ctx.prisma.kpiDef.findMany({
    where: { clientId, enabled: true },
    orderBy: [{ order: 'asc' }, { code: 'asc' }],
    select: { code: true, label: true, unit: true, outletType: true, outletTypes: true, programs: true, subPrograms: true },
  });
  // getPace's APPLIES-TO rule: only a tenant with a scoped KPI filters (all-unscoped tenant, e.g. Deoleo: unchanged).
  const scopes: Map<string, AppliesTo> | null = kpiScopeEnforced(kpiDefs)
    ? new Map(kpiDefs.map((k) => [k.code, kpiAppliesTo(k)]))
    : null;

  // Header = the old row object's key order (json_to_sheet) — a repeated KPI label collapses to its first position.
  const headers = [...new Set(targetVsSalesHeaderKeys(kpiDefs))];
  const sheet = await out.addSheet('Target vs Sales', headers);

  const monthWhere = { clientId, month: { in: months } };
  const [tCodes, sCodes] = await Promise.all([
    ctx.prisma.outletTarget.groupBy({ by: ['outletCode'], where: monthWhere }),
    ctx.prisma.outletSalesRecord.groupBy({ by: ['outletCode'], where: monthWhere }),
  ]);
  const codes = [...new Set([...tCodes.map((r) => r.outletCode), ...sCodes.map((r) => r.outletCode)])].sort((a, b) =>
    a.localeCompare(b),
  );

  if (codes.length === 0) {
    // Old builder: an empty result still carries every header column via one all-blank row.
    await sheet.addRow(headers.map(() => ''));
    return { rowCount: 0 };
  }

  const chunkSize = Math.max(1, Math.floor(EXPORT_PAGE_SIZE / months.length));
  let rowCount = 0;
  for (let i = 0; i < codes.length; i += chunkSize) {
    const chunk = codes.slice(i, i + chunkSize);
    const where = { clientId, month: { in: months }, outletCode: { in: chunk } };
    const [targets, sales, outlets] = await Promise.all([
      ctx.prisma.outletTarget.findMany({ where, select: { outletCode: true, month: true, outletName: true, targetValues: true } }),
      ctx.prisma.outletSalesRecord.findMany({ where, select: { outletCode: true, month: true, kpiValues: true } }),
      ctx.prisma.outlet.findMany({
        where: { clientId, outletCode: { in: chunk }, deletedAt: null },
        select: { outletCode: true, outletType: { select: { code: true } }, programName: true, programCategory: true },
      }),
    ]);
    const tIdx = new Map(targets.map((r) => [`${r.month}::${r.outletCode}`, r]));
    const sIdx = new Map(sales.map((r) => [`${r.month}::${r.outletCode}`, r]));
    const outletByCode = new Map(outlets.map((o) => [o.outletCode, o]));

    for (const code of chunk) {
      const o = outletByCode.get(code);
      const facets = o
        ? { outletType: o.outletType?.code ?? null, program: o.programName ?? null, subProgram: o.programCategory ?? null }
        : undefined;
      const type = o?.outletType?.code || '';
      // Name = the first month (in range order) the outlet appears in — getPace's outletName, then `|| code`.
      let name = code;
      for (const m of months) {
        const t = tIdx.get(`${m}::${code}`);
        const s = sIdx.get(`${m}::${code}`);
        if (t || s) {
          name = (t?.outletName ?? s?.outletCode ?? code) || code;
          break;
        }
      }

      for (const month of months) {
        const t = tIdx.get(`${month}::${code}`);
        const s = sIdx.get(`${month}::${code}`);
        const row: Record<string, XlsxCell> = { 'Outlet Code': code, 'Outlet Name': name, 'Outlet Type': type, Month: month };
        const present = !!(t || s);
        const targetValues = (t?.targetValues ?? {}) as Json;
        const kpiValues = (s?.kpiValues ?? {}) as Json;
        const observed = present ? new Set([...kpiCodeKeys(targetValues), ...kpiCodeKeys(kpiValues)]) : new Set<string>();
        for (const def of kpiDefs) {
          const [tHdr, aHdr, pHdr] = targetVsSalesKpiHeaders(def.label);
          let target: unknown = null;
          let achieved: unknown = null;
          let pace: number | null = null;
          const sc = scopes?.get(def.code);
          const included = observed.has(def.code) && !(sc && facets && !appliesToOutlet(sc, facets));
          if (included) {
            target = Object.prototype.hasOwnProperty.call(targetValues, def.code) ? targetValues[def.code] : null;
            achieved = Object.prototype.hasOwnProperty.call(kpiValues, def.code) ? kpiValues[def.code] : null;
            if (target !== null && target !== 0 && achieved !== null) pace = (achieved as number) / (target as number);
          }
          row[tHdr] = included && target !== null ? (target as XlsxCell) : '';
          row[aHdr] = included && achieved !== null ? (achieved as XlsxCell) : '';
          row[pHdr] = included && pace !== null ? paceToPct(pace) : '';
        }
        await sheet.addRow(headers.map((h) => row[h]));
        rowCount++;
      }
    }
  }
  return { rowCount };
}

export const TARGET_VS_SALES_KIND: ExportKindDef<TargetVsSalesParams> = {
  kind: 'target-vs-sales',
  label: 'Target vs Sales',
  // Same as GET admin/reports/target-vs-sales.
  access: { roles: ['CLIENT_ADMIN', 'GIFSY_ADMIN'], permission: 'targets:read' },
  parseParams: (raw: unknown, _user: JwtPayload) => parseTargetVsSalesParams(raw),
  // Rows = outlets × months (≈ 6.5k per month at Bajaj): up to 3 months streams instantly, longer ranges are prepared
  // in the background (the per-month join work and file size grow linearly with the range).
  isHeavy: (p) => p.months.length > TARGET_VS_SALES_INSTANT_MAX_MONTHS,
  describeParams: (p) => (p.fromMonth === p.toMonth ? monthWords(p.fromMonth) : `${monthWords(p.fromMonth)} – ${monthWords(p.toMonth)}`),
  fileName: (p) => `target-vs-sales-${p.fromMonth}-to-${p.toMonth}.xlsx`,
  run,
};
