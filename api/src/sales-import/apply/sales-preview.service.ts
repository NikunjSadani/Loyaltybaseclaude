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
import {
  MAPPING_CHANGED_REASON,
  importPager,
  loadRosterMeta,
  mappingChangedSince,
  resolveReadyImport,
  rosterIndexOf,
  type RosterOutlet,
} from '../kpi/sales-import-data';
import type { KpiDefLite } from '../kpi/sales-kpi.helper';
import { outletsMissingFromProcessing, processedRosterSet, rosterOutletWhere } from '../ingest/roster';
import { paiseToRupees } from '../ingest/normalize';
import { monthLabel, resolveMonthState } from '../months/month-state';
import { computeMonthRows, sumOwnedValues, unitsToNumber, type MonthRosterSplit } from './month-compute';
import { loadLastApplied } from './last-applied';
import { loadFocusCatalogue } from '../kpi/focus-data';
import { focusBlockedReason, lazyCatalogue, notCalculatedCodes, reconcileMonth, runMonthFocus } from './month-focus';
import type { FocusCatalogue } from '../kpi/focus-products';
import { isOlderThanLastApplied, partialMonthWarnings, replacesManualValues } from './warnings';
import { activeJobsByMonth, busyText, lastJobsByMonth } from './apply-jobs-data';
import type { SalesMonthActiveJob, SalesMonthLastJob } from '../sales-import.contract';

/** Why a month cannot be applied (null = it can). Shared by preview and apply. */
export function blockedReasonFor(opts: {
  month: string;
  defsCount: number;
  mappingChanged: boolean;
  state: ReturnType<typeof resolveMonthState>;
}): string | null {
  if (opts.defsCount === 0) return 'No importer-owned KPIs are defined yet. Add them in Sales Import settings.';
  if (opts.state.relation === 'FUTURE') return `${monthLabel(opts.month)} has not started yet.`;
  if (opts.state.state === 'CLOSED') return `${monthLabel(opts.month)} is CLOSED. Only Gifsy can reopen it.`;
  if (opts.mappingChanged) return MAPPING_CHANGED_REASON;
  return null;
}

export function monthSummariesOf(imp: Pick<SalesImport, 'monthSummaries'>): MonthSummary[] {
  return Array.isArray(imp.monthSummaries) ? (imp.monthSummaries as unknown as MonthSummary[]) : [];
}

/**
 * The preview's matched / unmatched figures for a month.
 *  - Legacy import (processed before roster-only aggregates; `rosterOnly` false): its aggregates cover EVERY customer,
 *    so the split computed over them against today's roster IS the answer (M6, unchanged).
 *  - Roster-only import: the aggregates cover only the processing-time roster. Matched = the computed split (outlets on
 *    both rosters). Unmatched = the frozen unmatched figures (every customer not on the roster at processing time —
 *    including any outlet ADDED since, whose sales are therefore not applied) + the aggregates of outlets REMOVED from
 *    the roster since (the computed split's unmatched part). The two sets are disjoint, so counts and amounts add.
 */
export function previewSplit(
  summary: Pick<MonthSummary, 'unmatchedCustomers' | 'unmatchedAmountRupees' | 'unmatchedQuantity'>,
  split: MonthRosterSplit,
  rosterOnly: boolean,
): Pick<MonthSummary, 'matchedOutlets' | 'unmatchedCustomers' | 'matchedAmountRupees' | 'matchedQuantity' | 'unmatchedAmountRupees' | 'unmatchedQuantity'> {
  const frozenPaise = rosterOnly ? BigInt(Math.round((summary.unmatchedAmountRupees ?? 0) * 100)) : 0n;
  const frozenThousandths = rosterOnly ? BigInt(Math.round((summary.unmatchedQuantity ?? 0) * 1000)) : 0n;
  return {
    matchedOutlets: split.matchedOutlets,
    unmatchedCustomers: split.unmatchedCustomers + (rosterOnly ? (summary.unmatchedCustomers ?? 0) : 0),
    matchedAmountRupees: paiseToRupees(split.matchedPaise),
    matchedQuantity: unitsToNumber(split.matchedQtyThousandths, 'QUANTITY'),
    unmatchedAmountRupees: paiseToRupees(split.unmatchedPaise + frozenPaise),
    unmatchedQuantity: unitsToNumber(split.unmatchedQtyThousandths + frozenThousandths, 'QUANTITY'),
  };
}

/**
 * Per-month live preview of a READY import (plan §5.2 GET :id/preview, §6.3 warnings; task K-5). OWNER: Lane K.
 * The numbers come from computeMonthRows — the SAME function apply writes with — over the roster as it is NOW. Since
 * roster-only aggregates (2026-11-23) an outlet added after processing has no lines here: `rosterOutletsNotIncluded`
 * says how many (the page shows it loudly); legacy imports (processedRosterCodes NULL) behave as before.
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
    const mappingChanged = await mappingChangedSince(this.prisma, clientId, imp);
    // Roster-only aggregates (2026-11-23): outlets on today's roster that were NOT on the processing-time roster have no
    // aggregates — their sales in this file are not included. null = a legacy import (every customer aggregated).
    const missing = outletsMissingFromProcessing(processedRosterSet(imp.processedRosterCodes), rosterIndexOf(roster));
    const rosterOnly = missing !== null;
    // Legacy imports only: outlets created since processing ARE included there (informational, as before).
    const rosterOutletsAddedSinceProcessing = !rosterOnly && imp.finishedAt
      ? await this.prisma.outlet.count({ where: { ...rosterOutletWhere(clientId), createdAt: { gt: imp.finishedAt } } })
      : 0;
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
    // FOCUS-FROM-TARGETS: one catalogue (stored months + this import's products) for every month of the preview.
    const catalogue = lazyCatalogue(() => loadFocusCatalogue(this.prisma, clientId, { importId: imp.id }));
    // Background jobs (2026-11-18): a month with an Apply / Recalculate queued or running (by anyone) cannot be ticked.
    const active = await activeJobsByMonth(this.prisma, clientId, months);
    const finished = await lastJobsByMonth(this.prisma, clientId, months);

    const out: MonthPreview[] = [];
    for (const summary of summaries) {
      out.push(
        await this.previewMonth(clientId, imp, summary, defs, roster, mappingChanged, current, {
          rosterOnly,
          status: statusOf.get(summary.month) ?? null,
          labelOf,
          catalogue,
          activeJob: active.get(summary.month) ?? null,
          lastJob: finished.get(summary.month) ?? null,
        }),
      );
    }
    return {
      importId: imp.id,
      definitionsHash: hash,
      processingVersion: imp.processingVersion,
      mappingChanged,
      rosterOutletsAddedSinceProcessing,
      rosterOutletsNotIncluded: missing ?? 0,
      months: out,
    };
  }

  private async previewMonth(
    clientId: string,
    imp: SalesImport,
    summary: MonthSummary,
    defs: KpiDefLite[],
    roster: Map<string, RosterOutlet>,
    mappingChanged: boolean,
    current: string,
    ctx: {
      /** The import has roster-only aggregates (see previewSplit). */
      rosterOnly?: boolean;
      status: { state: string } | null;
      labelOf: Map<string, string>;
      catalogue: () => Promise<FocusCatalogue>;
      activeJob?: SalesMonthActiveJob | null;
      lastJob?: SalesMonthLastJob | null;
    },
  ): Promise<MonthPreview> {
    const month = summary.month;
    const owned = defs.map((d) => d.kpiCode);
    const state = resolveMonthState(month, current, ctx.status);

    // FOCUS-FROM-TARGETS: the SAME resolution + evaluation apply re-runs under the month lock (so it writes these values).
    const focus = await runMonthFocus(this.prisma, { clientId, month, defs, roster, labelOf: ctx.labelOf, catalogue: ctx.catalogue });
    const comp = await computeMonthRows(importPager(this.prisma, imp.id, month), focus.evalDefs, roster);
    const existing = await this.prisma.outletSalesRecord.findMany({
      where: { clientId, month },
      select: { outletCode: true, kpiValues: true, batch: { select: { status: true, createdAt: true } } },
    });
    const currentTotals = sumOwnedValues(existing, owned);
    const last = await loadLastApplied(this.prisma, clientId, month);

    const warnings: SalesMonthWarning[] = [...partialMonthWarnings(summary, current)];
    if (isOlderThanLastApplied({ id: imp.id, lastDate: summary.lastDate }, last)) warnings.push('OLDER_THAN_LAST_APPLIED');
    if (
      replacesManualValues(
        existing,
        owned,
        last ? { createdAt: last.at, ownedCodes: last.ownedCodes } : null,
        SALES_IMPORT_BATCH_STATUS,
      )
    ) {
      warnings.push('REPLACES_MANUAL_VALUES');
    }
    if (comp.stats.some((s) => s.outletsNegative > 0)) warnings.push('NEGATIVE_VALUES');

    const reconciliation = reconcileMonth(focus, comp, owned, last?.at ?? null, existing);
    const ncCodes = notCalculatedCodes(reconciliation);
    const activeJob = ctx.activeJob ?? null;
    const blockedReason =
      (activeJob ? `${busyText(month, activeJob)}. Wait for it to finish.` : null) ??
      blockedReasonFor({ month, defsCount: defs.length, mappingChanged, state }) ?? focusBlockedReason(month, focus.resolution.blockers);

    let lastApplied: MonthPreview['lastApplied'] = null;
    if (last) {
      const u = await this.prisma.user.findUnique({ where: { id: last.appliedById }, select: { name: true } });
      lastApplied = { importId: last.importId, at: last.at.toISOString(), byName: u?.name ?? 'Unknown', lastInvoiceDate: last.lastInvoiceDate };
    }

    return {
      ...summary,
      // Matched / unmatched against the roster as it is NOW (the frozen summary used the processing-time roster).
      ...previewSplit(summary, comp.split, ctx.rosterOnly === true),
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
          ...(ncCodes.has(d.kpiCode) ? { notCalculated: true as const } : {}),
        };
      }),
      lastApplied,
      reconciliation,
      activeJob,
      lastJob: ctx.lastJob ?? null,
    };
  }
}
