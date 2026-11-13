/**
 * Target / achievement downloads as export kinds (Downloads page design):
 *   targets-template       GET /v1/admin/targets/template?months=YYYY-MM,…   (> 3 months → Downloads page)
 *   targets-export         GET /v1/admin/targets/export?month=YYYY-MM        ("Download Final Targets")
 *   achievements-template  GET /v1/admin/achievements/template?month=YYYY-MM
 *   achievements-export    GET /v1/admin/achievements/export?month=YYYY-MM   ("Download Sales Data")
 *
 * Output is identical to the old in-memory builders (same layouts — targets.helpers `*Layout`, same queries, same
 * validation messages). Rows are read in keyset pages of ≤ 2,000 (outlet roster / stored month rows ordered by
 * outletCode, id) and each page is written before the next is read; the per-page Outlet join (program name, current
 * outlet type) is bounded to that page's codes. The upload parse path is NOT here (guards lane).
 */
import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { appliesToOutlet, kpiAppliesTo } from '../../../common/applies-to/applies-to';
import { importerOwnedKpiCodes } from '../../../common/sales-kpi-ownership';
import { AchievementTemplateQueryDto, TemplateQueryDto } from '../../../targets/dto/targets.dto';
import { kpiScopeEnforced } from '../../../targets/targets.service';
import {
  resolvedTargetsLayout,
  salesDataLayout,
  targetTemplateLayout,
  type KpiDefLike,
  type MonthBlockSheetLayout,
  type OutletLike,
} from '../../../targets/targets.helpers';
import type { ExportAccess, ExportKindDef } from '../../export-kinds';
import type { XlsxStreamWriter } from '../../../common/xlsx-stream';
import { keysetPages, monthWords, parseQueryDto } from './kind-support';

/** Same as every templates/exports route on TargetsController / AchievementsController. */
const TARGETS_READ: ExportAccess = { roles: ['CLIENT_ADMIN', 'GIFSY_ADMIN'], permission: 'targets:read' };

/** Target templates covering more months than this are prepared on the Downloads page. */
export const TARGET_TEMPLATE_INSTANT_MAX_MONTHS = 3;

const NO_KPIS_SEED_MESSAGE =
  'No enabled KPIs found for this tenant. Seed KPIs first via POST /v1/admin/kpis/seed-defaults.';
const NO_KPIS_MESSAGE = 'No enabled KPIs found for this tenant.';
const ALL_IMPORTER_OWNED_MESSAGE = 'Every enabled KPI is fed by Sales Import, so there is nothing to upload manually.';

type Prisma = PrismaService;

function toKpiLike(k: {
  code: string;
  label: string;
  isPrimary: boolean;
  hasNameOverride: boolean;
  nameOverrideLabel: string | null;
  order: number;
  enabled: boolean;
}): KpiDefLike {
  return {
    code: k.code,
    label: k.label,
    isPrimary: k.isPrimary,
    hasNameOverride: k.hasNameOverride,
    nameOverrideLabel: k.nameOverrideLabel ?? null,
    order: k.order,
    enabled: k.enabled,
  };
}

function enabledKpiRows(prisma: Prisma, clientId: string) {
  return prisma.kpiDef.findMany({ where: { clientId, enabled: true }, orderBy: [{ order: 'asc' }, { code: 'asc' }] });
}

type KpiRow = Awaited<ReturnType<typeof enabledKpiRows>>[number];

/** The KPI columns a template/export uses — throws the same 400s the old builders threw. */
async function kpisFor(prisma: Prisma, clientId: string, kind: 'targets-template' | 'achievements-template' | 'export'): Promise<KpiRow[]> {
  let rows = await enabledKpiRows(prisma, clientId);
  if (rows.length === 0) throw new BadRequestException(kind === 'export' ? NO_KPIS_MESSAGE : NO_KPIS_SEED_MESSAGE);
  if (kind === 'achievements-template') {
    // Sales Import source ownership (§7.4): importer-owned KPIs get no column in the manual template.
    // A tenant with no SalesKpiDefinition (Deoleo, every tenant today) → [] → no filtering.
    const owned = await importerOwnedKpiCodes(prisma, clientId);
    if (owned.length > 0) {
      rows = rows.filter((k) => !owned.includes(k.code));
      if (rows.length === 0) throw new BadRequestException(ALL_IMPORTER_OWNED_MESSAGE);
    }
  }
  return rows;
}

/**
 * Pre-flight for the report endpoints: the same "no enabled KPI" 400s the old builders threw BEFORE any byte was
 * sent. `run` repeats the check (a request queued through the generic Downloads route still fails with the message).
 */
export async function assertTargetsDownloadable(
  prisma: Prisma,
  clientId: string,
  kindId: 'targets-template' | 'targets-export' | 'achievements-template' | 'achievements-export',
): Promise<void> {
  await kpisFor(
    prisma,
    clientId,
    kindId === 'targets-template' ? 'targets-template' : kindId === 'achievements-template' ? 'achievements-template' : 'export',
  );
}

async function writeMonthBlockSheet<R>(
  out: XlsxStreamWriter,
  layout: MonthBlockSheetLayout<R>,
  pages: AsyncIterable<R[]>,
): Promise<{ rowCount: number }> {
  const sheet = await out.addSheet(layout.sheetName, layout.monthRow.map(String), {
    widths: layout.widths,
    merges: layout.merges,
  });
  await sheet.addRow(layout.headerRow);
  let rowCount = 0;
  for await (const page of pages) {
    for (const r of page) {
      await sheet.addRow(layout.row(r));
      rowCount++;
    }
  }
  return { rowCount };
}

// ─── Templates (outlet roster × KPIs × months) ────────────────────────────────────────────────────────────────────

/**
 * All non-deleted outlets (targets/achievements can be set for any outlet regardless of KYC/active state), ordered by
 * outletCode like the old roster query — in keyset pages, selecting only the columns the template prints.
 */
async function* rosterPages(prisma: Prisma, clientId: string): AsyncGenerator<OutletLike[]> {
  for await (const page of keysetPages((p) =>
    prisma.outlet.findMany({
      where: { clientId, deletedAt: null },
      orderBy: [{ outletCode: 'asc' }, { id: 'asc' }],
      select: { id: true, outletCode: true, name: true, programName: true, programCategory: true, outletType: { select: { code: true } } },
      ...p,
    }),
  )) {
    yield page.map((o) => ({
      outletCode: o.outletCode,
      name: o.name,
      outletType: o.outletType.code,
      program: o.programName ?? null,
      subProgram: o.programCategory ?? null,
    }));
  }
}

async function writeTemplate(prisma: Prisma, clientId: string, kpiRows: KpiRow[], months: string[], out: XlsxStreamWriter) {
  const kpis = kpiRows.map(toKpiLike);
  // APPLIES-TO D2: only a tenant with an enforced KPI scope gets the scoped layout (Program / Sub-Program columns +
  // `N/A` in out-of-scope cells); every other tenant (Deoleo: all unscoped) gets the unchanged layout.
  let layout: MonthBlockSheetLayout<OutletLike>;
  if (kpiScopeEnforced(kpiRows)) {
    const scopes = new Map(kpiRows.map((k) => [k.code, kpiAppliesTo(k)]));
    layout = targetTemplateLayout(kpis, months, {
      scope: {
        isInScope: (o, code) => {
          const sc = scopes.get(code);
          return !sc || appliesToOutlet(sc, { outletType: o.outletType, program: o.program, subProgram: o.subProgram });
        },
      },
    });
  } else {
    layout = targetTemplateLayout(kpis, months);
  }
  return writeMonthBlockSheet(out, layout, rosterPages(prisma, clientId));
}

export interface TargetsTemplateParams {
  /** The `months` query exactly as sent (the file name uses it). */
  monthsRaw: string;
  months: string[];
}

export const TARGETS_TEMPLATE_KIND: ExportKindDef<TargetsTemplateParams> = {
  kind: 'targets-template',
  label: 'Target upload template',
  access: TARGETS_READ,
  parseParams(raw: unknown, _user: JwtPayload) {
    const q = parseQueryDto(TemplateQueryDto, raw);
    const months = q.months
      .split(',')
      .map((m) => m.trim())
      .filter((m) => /^\d{4}-\d{2}$/.test(m));
    if (months.length === 0) {
      throw new BadRequestException('At least one valid YYYY-MM month is required in the "months" query param');
    }
    return { monthsRaw: q.months, months };
  },
  // Rows = every outlet; columns = KPIs × months — a long month list makes a very wide file.
  isHeavy: (p) => p.months.length > TARGET_TEMPLATE_INSTANT_MAX_MONTHS,
  describeParams: (p) => p.months.map(monthWords).join(', '),
  fileName: (p) => `target-template-${p.monthsRaw.replace(/,/g, '_')}.xlsx`,
  async run(ctx, p, out) {
    const kpiRows = await kpisFor(ctx.prisma, ctx.clientId, 'targets-template');
    return writeTemplate(ctx.prisma, ctx.clientId, kpiRows, p.months, out);
  },
};

export interface MonthParams {
  month: string;
}

/** `?month=` only (the routes read `@Query('month')`; other query params are ignored, as today). */
function monthParam(raw: unknown, strict: boolean): MonthParams {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).month : undefined;
  const month = typeof v === 'string' ? v : String(v);
  const re = strict ? /^\d{4}-(0[1-9]|1[0-2])$/ : /^\d{4}-\d{2}$/;
  if (!re.test(month)) throw new BadRequestException('A valid YYYY-MM "month" query param is required');
  return { month };
}

export const ACHIEVEMENTS_TEMPLATE_KIND: ExportKindDef<MonthParams> = {
  kind: 'achievements-template',
  label: 'Sales (achievement) upload template',
  access: TARGETS_READ,
  // The route validates AchievementTemplateQueryDto (strict YYYY-MM, 01–12).
  parseParams: (raw: unknown) => ({ month: parseQueryDto(AchievementTemplateQueryDto, raw).month }),
  isHeavy: () => false, // one month: outlets × KPIs, streamed row by row
  describeParams: (p) => monthWords(p.month),
  fileName: (p) => `sales-template-${p.month}.xlsx`,
  async run(ctx, p, out) {
    const kpiRows = await kpisFor(ctx.prisma, ctx.clientId, 'achievements-template');
    return writeTemplate(ctx.prisma, ctx.clientId, kpiRows, [p.month], out);
  },
};

// ─── Stored-month exports ──────────────────────────────────────────────────────────────────────────────────────────

/** Current Outlet facts for one page of codes: program name + the AUTHORITATIVE outlet type (not the stale snapshot). */
async function outletFacts(prisma: Prisma, clientId: string, codes: string[]) {
  const outlets = codes.length
    ? await prisma.outlet.findMany({
        where: { clientId, outletCode: { in: codes }, deletedAt: null },
        select: { outletCode: true, programName: true, outletType: { select: { code: true } } },
      })
    : [];
  return {
    program: new Map(outlets.map((o) => [o.outletCode, o.programName])),
    type: new Map(outlets.map((o) => [o.outletCode, o.outletType?.code])),
  };
}

export const TARGETS_EXPORT_KIND: ExportKindDef<MonthParams> = {
  kind: 'targets-export',
  label: 'Final targets',
  access: TARGETS_READ,
  parseParams: (raw: unknown) => monthParam(raw, false),
  isHeavy: () => false, // one month of stored rows, streamed in pages
  describeParams: (p) => monthWords(p.month),
  fileName: (p) => `final-targets-${p.month}.xlsx`,
  async run(ctx, p, out) {
    const { prisma, clientId } = ctx;
    const kpis = (await kpisFor(prisma, clientId, 'export')).map(toKpiLike);
    async function* pages() {
      for await (const page of keysetPages((q) =>
        prisma.outletTarget.findMany({
          where: { clientId, month: p.month },
          orderBy: [{ outletCode: 'asc' }, { id: 'asc' }],
          select: { id: true, outletCode: true, outletName: true, targetValues: true },
          ...q,
        }),
      )) {
        const facts = await outletFacts(prisma, clientId, page.map((r) => r.outletCode));
        yield page.map((r) => ({
          outletCode: r.outletCode,
          outletName: r.outletName,
          targetValues: r.targetValues,
          // Always the current Outlet.outletType.code; blank when the outlet is absent from the roster join.
          outletType: facts.type.get(r.outletCode) ?? '',
          programName: facts.program.get(r.outletCode) ?? '',
        }));
      }
    }
    return writeMonthBlockSheet(out, resolvedTargetsLayout(p.month, kpis), pages());
  },
};

export const ACHIEVEMENTS_EXPORT_KIND: ExportKindDef<MonthParams> = {
  kind: 'achievements-export',
  label: 'Sales data',
  access: TARGETS_READ,
  // Strict YYYY-MM (01-12) — a loose \d{2} accepts 2026-13 and yields a corrupt header instead of a clean 400.
  parseParams: (raw: unknown) => monthParam(raw, true),
  isHeavy: () => false,
  describeParams: (p) => monthWords(p.month),
  fileName: (p) => `sales-data-${p.month}.xlsx`,
  async run(ctx, p, out) {
    const { prisma, clientId } = ctx;
    const kpis = (await kpisFor(prisma, clientId, 'export')).map(toKpiLike);
    async function* pages() {
      for await (const page of keysetPages((q) =>
        prisma.outletSalesRecord.findMany({
          where: { clientId, month: p.month },
          orderBy: [{ outletCode: 'asc' }, { id: 'asc' }],
          select: { id: true, outletCode: true, outletName: true, kpiValues: true },
          ...q,
        }),
      )) {
        const facts = await outletFacts(prisma, clientId, page.map((r) => r.outletCode));
        yield page.map((r) => ({
          outletCode: r.outletCode,
          outletName: r.outletName,
          outletType: facts.type.get(r.outletCode) ?? '',
          programName: facts.program.get(r.outletCode) ?? null,
          kpiValues: r.kpiValues,
        }));
      }
    }
    return writeMonthBlockSheet(out, salesDataLayout(p.month, kpis), pages());
  },
};

export const TARGET_EXPORT_KINDS = [TARGETS_TEMPLATE_KIND, TARGETS_EXPORT_KIND, ACHIEVEMENTS_TEMPLATE_KIND, ACHIEVEMENTS_EXPORT_KIND];
