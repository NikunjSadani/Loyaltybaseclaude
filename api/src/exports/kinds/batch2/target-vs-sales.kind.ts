/**
 * Target vs Sales Performance — the xlsx download of GET /v1/admin/reports/target-vs-sales?format=xlsx, as an export
 * kind (Downloads page design), AND the engine behind the on-screen JSON preview (same rows, same columns — the
 * preview can never disagree with the file).
 *
 *   Sheet "Target vs Sales": Outlet Code · Outlet Name · Outlet Type · Programme · Sub-programme · Zone · State ·
 *     <ASM> Name · <ASM> Employee ID · <SO> Name · <SO> Employee ID · <ISR> Name · <ISR> Employee ID · Month ·
 *     Billing bucket · <KPI> Target/Achieved/Pace % per enabled KpiDef (KpiDef order); one row per (qualifying outlet ×
 *     every month), outlets in localeCompare order; blank (not 0) for absent KPI values; an empty result is the header
 *     + one all-blank row.
 *   Sheet "About": what the file is, the filters applied, and plain-English definitions of the added columns.
 *
 * Added 2026-11-23 (owner, platform-wide):
 *   - Programme / Sub-programme / Zone / State — the outlet master (programName / programCategory / zone / state);
 *     missing → "Not set".
 *   - The outlet's sales hierarchy — reports/area/outlet-hierarchy.ts (the user-area assignment rule; headers in the
 *     tenant's own level names).
 *   - Billing bucket — EXACTLY the Overview "Monthly billing progress" card's rule (admin-core/dashboards/
 *     billing-progress.ts: pickReportKpi → billingKpiValue → classifyBillingOutlet → BILLING_BUCKETS labels), per
 *     (outlet × month). The card only counts the LIVE roster (liveOutletWhere), so an outlet outside it reads
 *     "Not on the live outlet list" instead of a bucket.
 *   - Filters program / outletType / managerId (the card's own `outletPassesBillingFilters` +
 *     `resolveBillingManagerScope`) and bucket (one of the BILLING_BUCKETS keys) — all optional; absent = unchanged.
 *
 * Paging: the qualifying outlet CODES (outlets with a target or sales row in the range) are read with GROUP BY and
 * sorted in Node (localeCompare — the row order cannot drift with the DB collation). The codes are walked in chunks so
 * each read is ≤ 2,000 rows (chunk = 2,000 ÷ months): targets, sales, the outlet master and the live-roster check of
 * that chunk only, written before the next chunk is read. The hierarchy is ONE tenant-wide load (four reads, paged)
 * before the first chunk — never a query per row.
 */
import { BadRequestException } from '@nestjs/common';
import { appliesToOutlet, kpiAppliesTo, type AppliesTo } from '../../../common/applies-to/applies-to';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { istDateTimeCell } from '../../../common/ist-date';
import { TargetVsSalesQueryDto } from '../../../admin-programs/dto/reports.dto';
import { targetVsSalesKpiHeaders, targetVsSalesMonthList } from '../../../admin-programs/reports/report-helpers';
import {
  BILLING_BUCKETS,
  billingKpiValue,
  billingListLabel,
  classifyBillingOutlet,
  outletPassesBillingFilters,
  pickReportKpi,
  resolveBillingManagerScope,
  type BillingBucketKey,
} from '../../../admin-core/dashboards/billing-progress';
import { liveOutletWhere, normalizeFilterParam } from '../../../admin-core/dashboards/dashboard-program-filter';
import { kpiOutletPredicate } from '../../../sales/outlet-kpi-scope.helper';
import { AREA_NOT_SET } from '../../../reports/area/user-area';
import { loadOutletHierarchyResolver, type OutletHierarchyResolver } from '../../../reports/area/outlet-hierarchy';
import type { PrismaService } from '../../../prisma/prisma.service';
import { kpiScopeEnforced } from '../../../targets/targets.service';
import { kpiCodeKeys } from '../../../targets/targets.helpers';
import type { ExportKindDef, ExportRunContext } from '../../export-kinds';
import type { XlsxCell, XlsxStreamSheet, XlsxStreamWriter } from '../../../common/xlsx-stream';
import { EXPORT_PAGE_SIZE, monthWords, parseQueryDto } from './kind-support';

/** Ranges longer than this go to the Downloads page; the on-screen JSON preview is capped at the same size. */
export const TARGET_VS_SALES_INSTANT_MAX_MONTHS = 3;

/** The `bucket` filter accepts the card's progress bands only (the cross-cutting lists are not per-row states). */
export const TARGET_VS_SALES_BUCKET_KEYS: readonly BillingBucketKey[] = BILLING_BUCKETS.map((b) => b.key);

/** Bucket-column words for rows the card does not bucket. */
export const TVS_BUCKET_NOT_LIVE = 'Not on the live outlet list';
export const TVS_BUCKET_NO_KPI = 'No KPI set up';

export interface TargetVsSalesParams {
  fromMonth: string;
  toMonth: string;
  months: string[];
  /** Trimmed Outlet.programName; null = all. */
  program: string | null;
  /** OutletType code; null = all. */
  outletType: string | null;
  /** A sales manager's SalesUser.id — their WHOLE downline; null = everyone. */
  managerId: string | null;
  /** One of the card's progress bands; null = every row. */
  bucket: BillingBucketKey | null;
}

/** pace ratio → percentage rounded to 1 decimal (same as report-helpers' paceToPct). */
function paceToPct(pace: number): number {
  return Math.round(pace * 1000) / 10;
}

/** Validate the optional `bucket` filter (same 400 style as the dashboard). */
export function parseTargetVsSalesBucket(raw: unknown): BillingBucketKey | null {
  const v = normalizeFilterParam(raw, 'bucket');
  if (!v) return null;
  if (!(TARGET_VS_SALES_BUCKET_KEYS as readonly string[]).includes(v)) {
    throw new BadRequestException(
      `Unknown \`bucket\` "${v}" — use one of ${TARGET_VS_SALES_BUCKET_KEYS.join(', ')} (the "No target", "Not covered" and ` +
        '"Behind pace" lists are not available as a Target vs Sales filter).',
    );
  }
  return v as BillingBucketKey;
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
  return {
    fromMonth,
    toMonth,
    months,
    program: normalizeFilterParam(q.program, 'program'),
    outletType: normalizeFilterParam(q.outletType, 'outletType'),
    managerId: normalizeFilterParam(q.managerId, 'managerId'),
    bucket: parseTargetVsSalesBucket(q.bucket),
  };
}

function bucketLabel(key: BillingBucketKey): string {
  return BILLING_BUCKETS.find((b) => b.key === key)!.label;
}

/** Downloads-page summary: the period, then each filter applied. */
export function describeTargetVsSales(p: TargetVsSalesParams, managerName?: string | null): string {
  const parts = [p.fromMonth === p.toMonth ? monthWords(p.fromMonth) : `${monthWords(p.fromMonth)} – ${monthWords(p.toMonth)}`];
  if (p.program) parts.push(`Programme: ${p.program}`);
  if (p.outletType) parts.push(`Outlet type: ${p.outletType}`);
  if (p.managerId) parts.push(managerName ? `Sales manager: ${managerName} (and team)` : 'One sales manager’s team');
  if (p.bucket) parts.push(`Billing bucket: ${bucketLabel(p.bucket)}`);
  return parts.join(' · ');
}

type Json = Record<string, unknown>;

export interface TargetVsSalesMeta {
  headers: string[];
  kpis: Array<{ code: string; label: string; unit: string | null }>;
  /** The KPI the Billing bucket column is measured on (the card's primary KPI); null = no enabled KPI. */
  bucketKpi: { code: string; label: string } | null;
  managerName: string | null;
  hierarchy: OutletHierarchyResolver;
}

export interface TargetVsSalesSink {
  /** Called once, before any row, with the final header list. */
  start(headers: string[]): Promise<void>;
  row(cells: XlsxCell[]): Promise<void>;
}

/** The engine: streams every row to `sink` (chunked reads). Shared by the xlsx kind and the JSON preview. */
export async function runTargetVsSales(
  prisma: PrismaService,
  clientId: string,
  p: TargetVsSalesParams,
  sink: TargetVsSalesSink,
): Promise<{ rowCount: number; meta: TargetVsSalesMeta }> {
  const months = p.months;
  const kpiDefs = await prisma.kpiDef.findMany({
    where: { clientId, enabled: true },
    orderBy: [{ order: 'asc' }, { code: 'asc' }],
    select: {
      code: true, label: true, unit: true, isPrimary: true,
      outletType: true, outletTypes: true, programs: true, subPrograms: true,
    },
  });
  // getPace's APPLIES-TO rule: only a tenant with a scoped KPI filters (all-unscoped tenant, e.g. Deoleo: unchanged).
  const scopes: Map<string, AppliesTo> | null = kpiScopeEnforced(kpiDefs)
    ? new Map(kpiDefs.map((k) => [k.code, kpiAppliesTo(k)]))
    : null;
  // Billing bucket = the Overview card's KPI (primary, else first enabled) and its applies-to predicate.
  const bucketKpi = pickReportKpi(kpiDefs);
  const bucketAppliesTo = kpiOutletPredicate(bucketKpi);

  const hierarchy = await loadOutletHierarchyResolver(prisma as never, clientId);
  const { downline, managerName } = resolveBillingManagerScope(hierarchy.salesUsers, p.managerId);
  const outletFiltered = !!(p.program || p.outletType || p.managerId);

  const leadHeaders = [
    'Outlet Code', 'Outlet Name', 'Outlet Type', 'Programme', 'Sub-programme', 'Zone', 'State',
    ...hierarchy.headers, 'Month', 'Billing bucket',
  ];
  // KPI headers keep the old rule: a repeated KPI label collapses to its first position.
  const kpiHeaders = [...new Set(kpiDefs.flatMap((k) => targetVsSalesKpiHeaders(k.label)))];
  const headers = [...leadHeaders, ...kpiHeaders];
  await sink.start(headers);

  const meta: TargetVsSalesMeta = {
    headers,
    kpis: kpiDefs.map((k) => ({ code: k.code, label: k.label, unit: k.unit ?? null })),
    bucketKpi: bucketKpi ? { code: bucketKpi.code, label: bucketKpi.label } : null,
    managerName,
    hierarchy,
  };

  const monthWhere = { clientId, month: { in: months } };
  const [tCodes, sCodes] = await Promise.all([
    prisma.outletTarget.groupBy({ by: ['outletCode'], where: monthWhere }),
    prisma.outletSalesRecord.groupBy({ by: ['outletCode'], where: monthWhere }),
  ]);
  const codes = [...new Set([...tCodes.map((r) => r.outletCode), ...sCodes.map((r) => r.outletCode)])].sort((a, b) =>
    a.localeCompare(b),
  );

  const chunkSize = Math.max(1, Math.floor(EXPORT_PAGE_SIZE / months.length));
  let rowCount = 0;
  for (let i = 0; i < codes.length; i += chunkSize) {
    const chunk = codes.slice(i, i + chunkSize);
    const where = { clientId, month: { in: months }, outletCode: { in: chunk } };
    const [targets, sales, outlets, live] = await Promise.all([
      prisma.outletTarget.findMany({ where, select: { outletCode: true, month: true, outletName: true, targetValues: true } }),
      prisma.outletSalesRecord.findMany({ where, select: { outletCode: true, month: true, kpiValues: true } }),
      prisma.outlet.findMany({
        where: { clientId, outletCode: { in: chunk }, deletedAt: null },
        select: {
          id: true,
          outletCode: true,
          outletType: { select: { code: true } },
          programName: true,
          programCategory: true,
          zone: true,
          state: true,
          // The card's manager filter reads the outlet's CURRENT direct assignments.
          salesAssignments: { where: { unassignedAt: null }, orderBy: { assignedAt: 'desc' }, select: { salesUserId: true } },
        },
      }),
      // The card's universe (the live roster) — the SAME condition, applied to this chunk only.
      prisma.outlet.findMany({ where: { clientId, outletCode: { in: chunk }, ...liveOutletWhere() }, select: { outletCode: true } }),
    ]);
    const tIdx = new Map(targets.map((r) => [`${r.month}::${r.outletCode}`, r]));
    const sIdx = new Map(sales.map((r) => [`${r.month}::${r.outletCode}`, r]));
    const outletByCode = new Map(outlets.map((o) => [o.outletCode, o]));
    const liveCodes = new Set(live.map((o) => o.outletCode));

    for (const code of chunk) {
      const o = outletByCode.get(code);
      const typeCode = o?.outletType?.code ?? null;
      if (outletFiltered) {
        // An outlet missing from the outlet master has no programme / type / assignment → it cannot match a filter.
        if (!o) continue;
        const repIds = (o.salesAssignments ?? []).map((a) => a.salesUserId);
        if (!outletPassesBillingFilters({ programName: o.programName ?? null, outletType: typeCode, repIds }, p, downline)) continue;
      }
      const facets = o ? { outletType: typeCode, program: o.programName ?? null, subProgram: o.programCategory ?? null } : undefined;
      const type = o?.outletType?.code || '';
      const master = (v: string | null | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : AREA_NOT_SET);
      const masterCells: XlsxCell[] = [
        master(o?.programName),
        master(o?.programCategory),
        master(o?.zone),
        master(o?.state),
        ...hierarchy.cellsFor(o?.id),
      ];
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

        // ── Billing bucket: the Overview card's rule for this outlet and month ──
        let bucketCell: string;
        let bucketKey: BillingBucketKey | null = null;
        if (!bucketKpi) bucketCell = TVS_BUCKET_NO_KPI;
        else if (!o || !liveCodes.has(code)) bucketCell = TVS_BUCKET_NOT_LIVE;
        else {
          const cls = classifyBillingOutlet(
            bucketAppliesTo,
            facets!,
            billingKpiValue(t?.targetValues, bucketKpi.code),
            billingKpiValue(s?.kpiValues, bucketKpi.code),
          );
          if (cls.kind === 'BUCKET') {
            bucketKey = cls.bucket;
            bucketCell = bucketLabel(cls.bucket);
          } else bucketCell = billingListLabel(cls.kind);
        }
        if (p.bucket && bucketKey !== p.bucket) continue;

        const kpiRow: Record<string, XlsxCell> = {};
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
          kpiRow[tHdr] = included && target !== null ? (target as XlsxCell) : '';
          kpiRow[aHdr] = included && achieved !== null ? (achieved as XlsxCell) : '';
          kpiRow[pHdr] = included && pace !== null ? paceToPct(pace) : '';
        }
        await sink.row([code, name, type, ...masterCells, month, bucketCell, ...kpiHeaders.map((h) => kpiRow[h])]);
        rowCount++;
      }
    }
  }
  return { rowCount, meta };
}

/** The About sheet's rows (also returned by the JSON preview). */
export function targetVsSalesAbout(
  p: TargetVsSalesParams,
  meta: TargetVsSalesMeta,
  rowCount: number,
  now: Date,
): Array<[string, string]> {
  const kpi = meta.bucketKpi;
  const h = meta.hierarchy.labels;
  return [
    ['Report', 'Target vs Sales Performance'],
    ['Period', p.fromMonth === p.toMonth ? monthWords(p.fromMonth) : `${monthWords(p.fromMonth)} – ${monthWords(p.toMonth)}`],
    ['Programme filter', p.program ?? 'All programmes'],
    ['Outlet type filter', p.outletType ?? 'All outlet types'],
    [
      'Sales manager filter',
      p.managerId ? `${meta.managerName ?? 'Unknown or removed manager — no outlets match'}${meta.managerName ? ' (and everyone below them)' : ''}` : 'Everyone',
    ],
    ['Billing bucket filter', p.bucket ? bucketLabel(p.bucket) : 'All rows'],
    ['Rows', String(rowCount)],
    ['Generated at (IST)', istDateTimeCell(now)],
    ['Programme / Sub-programme', `The outlet's programme and sub-programme in the outlet master. "${AREA_NOT_SET}" = blank in the outlet master, or the outlet is not in the outlet master.`],
    ['Zone / State', `The outlet's zone and state in the outlet master. "${AREA_NOT_SET}" = blank in the outlet master, or the outlet is not in the outlet master.`],
    ...meta.hierarchy.notes.map((n, i): [string, string] => [i === 0 ? `${h.ASM} / ${h.SO} / ${h.XSR}` : '', n]),
    [
      'Billing bucket',
      kpi
        ? `The same rule as the Overview's "Monthly billing progress" card, for that outlet and month: billed ÷ target on the card's KPI, ${kpi.label} (${kpi.code}). ` +
          `${BILLING_BUCKETS.map((b) => b.label).join(' · ')} ("Not started" = nothing billed yet). ` +
          `"${billingListLabel('NO_TARGET')}" = no positive ${kpi.label} target that month. ` +
          `"${billingListLabel('NOT_COVERED')}" = the outlet is outside that KPI's programme / outlet-type scope. ` +
          `"${TVS_BUCKET_NOT_LIVE}" = the outlet is deleted, deactivated, parked or not interested, so the Overview does not count it. ` +
          'Note: the Overview\'s "No target" count also includes live outlets with no target and no sales row at all — those outlets never appear in this report.'
        : `"${TVS_BUCKET_NO_KPI}" — this programme has no enabled KPI, so there is nothing to bucket (the Overview card is hidden too).`,
    ],
    [
      'Filters',
      'Programme, outlet type and sales manager match the Overview card exactly: the outlet master\'s programme and outlet type, and ' +
        'the sales manager = outlets assigned directly to that manager or to anyone below them. The billing bucket filter keeps only the ' +
        'rows (outlet × month) in that bucket. When any outlet filter is set, outlets missing from the outlet master are left out.',
    ],
    ['KPI columns', 'Blank = nothing uploaded for that outlet, month and KPI (a real 0 shows as 0). Pace % = achieved ÷ target × 100.'],
  ];
}

async function run(ctx: ExportRunContext, p: TargetVsSalesParams, out: XlsxStreamWriter): Promise<{ rowCount: number }> {
  const main: { sheet?: XlsxStreamSheet; width: number } = { width: 0 };
  const { rowCount, meta } = await runTargetVsSales(ctx.prisma, ctx.clientId, p, {
    async start(headers) {
      main.width = headers.length;
      main.sheet = await out.addSheet('Target vs Sales', headers);
    },
    async row(cells) {
      await main.sheet!.addRow(cells);
    },
  });
  // An empty result still carries every header column via one all-blank row (the old builder's behaviour).
  if (rowCount === 0) await main.sheet!.addRow(Array.from({ length: main.width }, () => ''));
  const about = await out.addSheet('About', ['Field', 'Value'], { widths: [28, 110] });
  for (const r of targetVsSalesAbout(p, meta, rowCount, ctx.now)) await about.addRow(r);
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
  describeParams: (p) => describeTargetVsSales(p),
  fileName: (p) => `target-vs-sales-${p.fromMonth}-to-${p.toMonth}${p.bucket ? `-${p.bucket.toLowerCase().replace(/_/g, '-')}` : ''}.xlsx`,
  run,
};
