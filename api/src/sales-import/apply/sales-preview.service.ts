import { Injectable } from '@nestjs/common';
import type { SalesImport } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { currentMonthKey } from '../../targets/targets.helpers';
import {
  SALES_IMPORT_BATCH_STATUS,
  type MonthPreview,
  type MonthSummary,
  type SalesImportPreview,
  type SalesMonthWarning,
} from '../sales-import.contract';
import { SalesKpiDefService } from '../kpi/sales-kpi-def.service';
import { loadRosterMeta, resolveReadyImport, rosterHashOfMap, type RosterOutlet } from '../kpi/sales-import-data';
import type { KpiDefLite } from '../kpi/sales-kpi.helper';
import { monthLabel, resolveMonthState } from '../months/month-state';
import { computeMonthRows, sumOwnedValues } from './month-compute';
import { isOlderThanLastApplied, partialMonthWarnings, replacesManualValues } from './warnings';

/** Why a month cannot be applied (null = it can). Shared by preview and apply. */
export function blockedReasonFor(opts: {
  month: string;
  defsCount: number;
  rosterChanged: boolean;
  state: ReturnType<typeof resolveMonthState>;
}): string | null {
  if (opts.defsCount === 0) return 'No importer-owned KPIs are defined yet. Add them in Sales Import settings.';
  if (opts.state.relation === 'FUTURE') return `${monthLabel(opts.month)} has not started yet.`;
  if (opts.state.state === 'CLOSED') return `${monthLabel(opts.month)} is CLOSED. Only Gifsy can reopen it.`;
  if (opts.rosterChanged) return 'The outlet list changed after this file was processed. Reprocess the file first.';
  return null;
}

export function monthSummariesOf(imp: Pick<SalesImport, 'monthSummaries'>): MonthSummary[] {
  return Array.isArray(imp.monthSummaries) ? (imp.monthSummaries as unknown as MonthSummary[]) : [];
}

/**
 * Per-month live preview of a READY import (plan §5.2 GET :id/preview, §6.3 warnings; task K-5). OWNER: Lane K.
 * The numbers come from computeMonthRows — the SAME function apply writes with.
 */
@Injectable()
export class SalesPreviewService {
  constructor(
    readonly prisma: PrismaService,
    private readonly kpiDefs: SalesKpiDefService,
  ) {}

  async preview(clientId: string, importId: string): Promise<SalesImportPreview> {
    const imp = await resolveReadyImport(this.prisma, clientId, importId);
    const { defs, hash } = await this.kpiDefs.enabled(clientId);
    const roster = await loadRosterMeta(this.prisma, clientId);
    const rosterHashMatches = !!imp.rosterHash && rosterHashOfMap(roster) === imp.rosterHash;
    const summaries = monthSummariesOf(imp);
    const months = summaries.map((s) => s.month);
    const current = currentMonthKey();

    const kpiRows = await this.prisma.kpiDef.findMany({
      where: { clientId, code: { in: defs.map((d) => d.kpiCode) } },
      select: { code: true, label: true },
    });
    const labelOf = new Map(kpiRows.map((k) => [k.code, k.label]));

    const statuses = await this.prisma.salesMonthStatus.findMany({ where: { clientId, month: { in: months } } });
    const statusOf = new Map(statuses.map((s) => [s.month, s]));
    const lastImportIds = [...new Set(statuses.map((s) => s.lastAppliedImportId).filter((x): x is string => !!x))];
    const lastImports = lastImportIds.length
      ? await this.prisma.salesImport.findMany({ where: { clientId, id: { in: lastImportIds } }, select: { id: true, createdAt: true } })
      : [];
    const lastImportOf = new Map(lastImports.map((i) => [i.id, i]));

    const out: MonthPreview[] = [];
    for (const summary of summaries) {
      out.push(
        await this.previewMonth(clientId, imp, summary, defs, roster, rosterHashMatches, current, {
          status: statusOf.get(summary.month) ?? null,
          lastImportOf,
          labelOf,
        }),
      );
    }
    return { importId: imp.id, definitionsHash: hash, rosterHashMatches, months: out };
  }

  private async previewMonth(
    clientId: string,
    imp: SalesImport,
    summary: MonthSummary,
    defs: KpiDefLite[],
    roster: Map<string, RosterOutlet>,
    rosterHashMatches: boolean,
    current: string,
    ctx: {
      status: { state: string; lastAppliedImportId: string | null } | null;
      lastImportOf: Map<string, { id: string; createdAt: Date }>;
      labelOf: Map<string, string>;
    },
  ): Promise<MonthPreview> {
    const month = summary.month;
    const owned = defs.map((d) => d.kpiCode);
    const state = resolveMonthState(month, current, ctx.status);

    const comp = await computeMonthRows(this.prisma, imp.id, month, defs, roster);
    const existing = await this.prisma.outletSalesRecord.findMany({
      where: { clientId, month },
      select: { outletCode: true, kpiValues: true, batch: { select: { status: true, createdAt: true } } },
    });
    const currentTotals = sumOwnedValues(existing, owned);

    const lastApply = await this.prisma.salesImportApply.findFirst({
      where: { clientId, month },
      orderBy: { createdAt: 'desc' },
      select: { importId: true, createdAt: true, appliedById: true, definitionsSnapshot: true },
    });
    const lastApplyCodes = Array.isArray(lastApply?.definitionsSnapshot)
      ? (lastApply!.definitionsSnapshot as Array<{ kpiCode?: string }>).map((d) => String(d?.kpiCode ?? ''))
      : [];

    const warnings: SalesMonthWarning[] = [...partialMonthWarnings(summary, current)];
    const lastImp = ctx.status?.lastAppliedImportId ? ctx.lastImportOf.get(ctx.status.lastAppliedImportId) : null;
    if (isOlderThanLastApplied(imp, lastImp)) warnings.push('OLDER_THAN_LAST_APPLIED');
    if (
      replacesManualValues(
        existing,
        owned,
        lastApply ? { createdAt: lastApply.createdAt, ownedCodes: lastApplyCodes } : null,
        SALES_IMPORT_BATCH_STATUS,
      )
    ) {
      warnings.push('REPLACES_MANUAL_VALUES');
    }
    if (comp.stats.some((s) => s.outletsNegative > 0)) warnings.push('NEGATIVE_VALUES');
    if (!rosterHashMatches) warnings.push('ROSTER_CHANGED');

    const blockedReason = blockedReasonFor({ month, defsCount: defs.length, rosterChanged: !rosterHashMatches, state });

    let lastApplied: MonthPreview['lastApplied'] = null;
    if (lastApply) {
      const u = await this.prisma.user.findUnique({ where: { id: lastApply.appliedById }, select: { name: true } });
      lastApplied = { importId: lastApply.importId, at: lastApply.createdAt.toISOString(), byName: u?.name ?? 'Unknown' };
    }

    return {
      ...summary,
      monthState: state.state,
      canApply: blockedReason === null,
      ...(blockedReason ? { blockedReason } : {}),
      warnings,
      zeroFillOutlets: comp.zeroFillOutlets,
      kpis: defs.map((d, i) => {
        const newTotal = comp.stats[i].total;
        const currentTotal = currentTotals[d.kpiCode] ?? 0;
        return {
          kpiCode: d.kpiCode,
          label: ctx.labelOf.get(d.kpiCode) ?? d.kpiCode,
          measure: d.measure,
          newTotal,
          currentTotal,
          delta: Math.round((newTotal - currentTotal) * 1e6) / 1e6,
          outletsNonZero: comp.stats[i].outletsNonZero,
          outletsNegative: comp.stats[i].outletsNegative,
        };
      }),
      lastApplied,
    };
  }
}
