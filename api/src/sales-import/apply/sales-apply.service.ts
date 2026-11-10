import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type SalesKpiDefinition } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { lockSalesMonth } from '../../common/sales-kpi-ownership';
import { currentMonthKey } from '../../targets/targets.helpers';
import {
  SALES_IMPORT_BATCH_STATUS,
  type ApplyMonthResult,
  type ApplyRequest,
  type ApplyResult,
  type MonthSummary,
  type SalesColumnMapping,
  type SalesMonthRecalcPreview,
  type SalesMonthRecalcRequest,
  type SalesMonthWarning,
} from '../sales-import.contract';
import { SalesKpiDefService, toDto } from '../kpi/sales-kpi-def.service';
import {
  MAPPING_CHANGED_REASON,
  historyPager,
  importPager,
  loadRosterMeta,
  mappingChangedSince,
  monthHistoryMeta,
  resolveReadyImport,
  rosterIndexOf,
  type RosterOutlet,
} from '../kpi/sales-import-data';
import { filterDimKeys, type KpiDefLite } from '../kpi/sales-kpi.helper';
import { mappingFingerprint } from '../ingest/mapping-fingerprint';
import { paiseToRupees } from '../ingest/normalize';
import { lockImportRow } from '../ingest/import-lock';
import { SQL_NOW_UTC, sqlUtc } from '../sql-time';
import { isMonthKey, monthLabel, resolveMonthState } from '../months/month-state';
import { computeMonthRows, sumOwnedValues, unitsToNumber, type MonthComputation } from './month-compute';
import { loadLastApplied } from './last-applied';
import { isOlderThanLastApplied, partialMonthWarnings, replacesManualValues } from './warnings';
import { blockedReasonFor, monthSummariesOf } from './sales-preview.service';

/**
 * Interactive-transaction timeout of a month write (apply / recalculate): the OutletSalesRecord merge plus the month
 * history DELETE + INSERT … SELECT of every customer line (≈ 300k rows for the real file). The history step logs its
 * durations ('sales-import month history written') so this bound can be checked at real scale (final check L2).
 */
export const APPLY_TX_TIMEOUT_MS = 300_000;

/** Rows per bulk INSERT … unnest statement (plan §7.2: ~6.5k outlets → 2 statements). */
export const APPLY_CHUNK = 3250;

/** A per-month failure that is reported in ApplyResult (never rolls back other months). */
class MonthApplyError extends Error {}

/**
 * Per-month apply into OutletSalesRecord (plan §7.2; task K-6). OWNER: Lane K.
 *
 * Each month = ONE interactive transaction under the per-(tenant, month) advisory lock shared with close/reopen and
 * the manual batch delete, PLUS `FOR SHARE` on the import row (H1/S1: a reprocess / cancel / delete / purge needs
 * FOR UPDATE NOWAIT, so it gets 409 instead of deleting the aggregates under a running apply). Inside: re-check OPEN,
 * READY + not purged + the reviewed processingVersion (M7), definitions hash, column-mapping fingerprint (H2) and the
 * partial / older acknowledgements against the month's CURRENT last apply (M7); map the file's customer codes onto
 * the CURRENT roster (M6); create a SALES_IMPORT batch;
 * bulk-merge the owned keys (`kpiValues - owned || new`, never touching non-owned keys, never changing the batchId
 * or name of an existing row); strip owned keys from every other row of the month (full rewrite); record the apply,
 * the month's last-applied pointer and an audit row. A month that fails is reported and does not affect the others.
 */
@Injectable()
export class SalesApplyService {
  private readonly log = new Logger(SalesApplyService.name);

  constructor(
    readonly prisma: PrismaService,
    private readonly kpiDefs: SalesKpiDefService,
  ) {}

  async apply(user: JwtPayload, importId: string, body: ApplyRequest): Promise<ApplyResult> {
    const clientId = user.clientId;
    const req = this.validateBody(body);

    const imp = await resolveReadyImport(this.prisma, clientId, importId);
    if (imp.processingVersion !== req.processingVersion) {
      throw new ConflictException('This file was reprocessed after the preview you reviewed. Refresh the preview and try again.');
    }
    const { defs, hash } = await this.kpiDefs.enabled(clientId);
    if (hash !== req.expectedDefinitionsHash) {
      throw new ConflictException('KPI definitions changed since the preview. Refresh the preview and try again.');
    }
    if (defs.length === 0) throw new BadRequestException('No importer-owned KPIs are defined yet.');
    if (await mappingChangedSince(this.prisma, clientId, imp)) throw new ConflictException(MAPPING_CHANGED_REASON);

    const summaries = new Map(monthSummariesOf(imp).map((s) => [s.month, s]));
    const current = currentMonthKey();

    // Acknowledgement checks (400 before ANY write; re-checked per month under the month lock).
    const missingPartial: string[] = [];
    let needsOlderAck = false;
    for (const month of req.months) {
      const s = summaries.get(month);
      if (!s) continue; // reported per month below
      if (partialMonthWarnings(s, current).length > 0 && !req.acknowledgePartialMonths.includes(month)) missingPartial.push(month);
      const last = await loadLastApplied(this.prisma, clientId, month);
      if (isOlderThanLastApplied({ id: imp.id, lastDate: s.lastDate }, last)) needsOlderAck = true;
    }
    if (missingPartial.length > 0) {
      throw new BadRequestException(
        `These months are partial in this file and would be replaced entirely: ${missingPartial.map(monthLabel).join(', ')}. Acknowledge them to continue.`,
      );
    }
    if (needsOlderAck && !req.acknowledgeOlderThanLastApplied) {
      throw new BadRequestException('This file is older than the one last applied to a selected month. Acknowledge it to continue.');
    }

    const results: ApplyMonthResult[] = [];
    for (const month of req.months) {
      const summary = summaries.get(month);
      if (!summary) {
        results.push({ month, ok: false, error: `${monthLabel(month)} is not in this file.` });
        continue;
      }
      try {
        results.push(await this.applyMonth(user, imp.id, summary, req));
      } catch (e) {
        const msg = e instanceof MonthApplyError ? e.message : 'Apply failed for this month. Nothing was changed for it.';
        if (!(e instanceof MonthApplyError)) this.log.error(`apply ${imp.id} ${month} failed: ${(e as Error)?.message}`);
        results.push({ month, ok: false, error: msg });
      }
    }
    return { results };
  }

  private validateBody(body: ApplyRequest) {
    if (!body || typeof body !== 'object') throw new BadRequestException('Body is required.');
    const months = Array.isArray(body.months) ? body.months : null;
    if (!months || months.length === 0) throw new BadRequestException('Select at least one month.');
    if (months.some((m) => !isMonthKey(m))) throw new BadRequestException('months must be YYYY-MM values.');
    if (new Set(months).size !== months.length) throw new BadRequestException('A month is listed twice.');
    if (typeof body.expectedDefinitionsHash !== 'string' || !body.expectedDefinitionsHash) {
      throw new BadRequestException('expectedDefinitionsHash is required.');
    }
    if (typeof body.processingVersion !== 'number' || !Number.isInteger(body.processingVersion) || body.processingVersion < 0) {
      throw new BadRequestException('processingVersion is required (send SalesImportPreview.processingVersion).');
    }
    const ack = body.acknowledgePartialMonths ?? [];
    if (!Array.isArray(ack) || ack.some((m) => typeof m !== 'string')) {
      throw new BadRequestException('acknowledgePartialMonths must be a list of months.');
    }
    return {
      months: [...months].sort(),
      expectedDefinitionsHash: body.expectedDefinitionsHash,
      processingVersion: body.processingVersion,
      acknowledgePartialMonths: ack,
      acknowledgeOlderThanLastApplied: body.acknowledgeOlderThanLastApplied === true,
    };
  }

  private async applyMonth(
    user: JwtPayload,
    importId: string,
    summary: MonthSummary,
    req: Pick<ApplyRequest, 'expectedDefinitionsHash' | 'processingVersion'> & {
      acknowledgePartialMonths: string[];
      acknowledgeOlderThanLastApplied: boolean;
    },
  ): Promise<ApplyMonthResult> {
    const clientId = user.clientId;
    const month = summary.month;

    return this.prisma.$transaction(
      async (tx) => {
        await lockSalesMonth(tx, clientId, month);

        // 1. Re-check everything under the locks. FOR SHARE on the import row: reprocess / cancel / delete / purge
        //    (FOR UPDATE NOWAIT) are refused while this transaction runs, and the aggregates read below stay intact.
        const imp = await lockImportRow(tx, importId, clientId, 'SHARE');
        if (!imp || imp.status !== 'READY') throw new MonthApplyError('The import is no longer READY.');
        if (imp.purgedAt) throw new MonthApplyError('The data of this import was deleted after the retention period.');
        if (imp.processingVersion !== req.processingVersion) {
          throw new MonthApplyError('This file was reprocessed after the preview you reviewed. Refresh the preview.');
        }
        const override = await tx.salesMonthStatus.findUnique({ where: { clientId_month: { clientId, month } } });
        const current = currentMonthKey();
        const state = resolveMonthState(month, current, override);
        const { rows: defRows, defs, hash } = await this.kpiDefs.enabled(clientId, tx);
        if (hash !== req.expectedDefinitionsHash) throw new MonthApplyError('KPI definitions changed. Refresh the preview.');
        const mappingChanged = await mappingChangedSince(tx, clientId, imp);
        const blocked = blockedReasonFor({ month, defsCount: defs.length, mappingChanged, state });
        if (blocked) throw new MonthApplyError(blocked);
        // M7: the acknowledgements, against what is true NOW (another import may have been applied meanwhile).
        if (partialMonthWarnings(summary, current).length > 0 && !req.acknowledgePartialMonths.includes(month)) {
          throw new MonthApplyError(`${monthLabel(month)} is partial in this file and would be replaced entirely. Acknowledge it to continue.`);
        }
        const last = await loadLastApplied(tx, clientId, month);
        if (isOlderThanLastApplied({ id: importId, lastDate: summary.lastDate }, last) && !req.acknowledgeOlderThanLastApplied) {
          throw new MonthApplyError(
            `${monthLabel(month)}: the latest invoice in this file (${summary.lastDate}) is older than in the file last applied (${last?.lastInvoiceDate}). Refresh the preview and acknowledge it.`,
          );
        }
        const roster = await loadRosterMeta(tx, clientId);
        const comp = await computeMonthRows(importPager(tx, importId, month), defs, roster);
        const snap = await tx.salesImport.findFirst({ where: { id: importId, clientId }, select: { mappingSnapshot: true } });
        return this.writeMonth(tx, user, {
          month,
          source: 'IMPORT',
          sourceImportId: importId,
          processingVersion: imp.processingVersion,
          defRows,
          defs,
          hash,
          state,
          roster,
          comp,
          mapping: {
            fingerprint: imp.mappingFingerprint,
            dimensionKeys: ((snap?.mappingSnapshot as unknown as SalesColumnMapping | null)?.dimensions ?? []).map((d) => d.key),
          },
        });
      },
      { timeout: APPLY_TX_TIMEOUT_MS, maxWait: 10_000 },
    );
  }

  /**
   * The write shared by APPLY (source IMPORT) and RECALCULATE (source HISTORY), inside the caller's transaction that
   * already holds the month lock: SALES_IMPORT batch → owned-keys merge (existing rows keep batchId / name) → strip owned
   * keys from every other row of the month → [IMPORT only] replace the month's stored history with this import's lines
   * → SalesImportApply (with `source`) → month pointer → audit.
   */
  private async writeMonth(
    tx: Prisma.TransactionClient,
    user: JwtPayload,
    w: {
      month: string;
      source: 'IMPORT' | 'HISTORY';
      sourceImportId: string;
      processingVersion: number | null;
      defRows: SalesKpiDefinition[];
      defs: KpiDefLite[];
      hash: string;
      state: ReturnType<typeof resolveMonthState>;
      roster: Map<string, RosterOutlet>;
      comp: MonthComputation;
      /** IMPORT only: the mapping the lines were parsed with (stored on the history set header). */
      mapping?: { fingerprint: string | null; dimensionKeys: string[] };
    },
  ): Promise<ApplyMonthResult> {
    const clientId = user.clientId;
    const { month, comp, defs } = w;
    const owned = defs.map((d) => d.kpiCode);

    // Before-totals (inside the lock, so they are what this write replaces).
    const before = sumOwnedValues(
      await tx.outletSalesRecord.findMany({ where: { clientId, month }, select: { kpiValues: true } }),
      owned,
    );

    // 1. The batch row every newly-INSERTED record points at.
    const batch = await tx.salesUploadBatch.create({
      data: {
        clientId,
        uploadedById: user.sub,
        month,
        status: SALES_IMPORT_BATCH_STATUS,
        totalRows: comp.rows.length,
        acceptedCount: comp.rows.length,
        rejectedCount: 0,
      },
    });

    // 2. Bulk merge (owned keys only). Existing rows keep their batchId and outletName.
    for (let i = 0; i < comp.rows.length; i += APPLY_CHUNK) {
      const chunk = comp.rows.slice(i, i + APPLY_CHUNK);
      const ids = chunk.map(() => randomUUID());
      const codes = chunk.map((r) => r.outletCode);
      const names = chunk.map((r) => r.outletName);
      const vals = chunk.map((r) => JSON.stringify(r.values));
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "outlet_sales_records" ("id","clientId","outletCode","outletName","month","kpiValues","batchId","createdAt","updatedAt")
        SELECT u.id, ${clientId}, u.code, u.name, ${month}, u.vals::jsonb, ${batch.id}, ${SQL_NOW_UTC}, ${SQL_NOW_UTC}
          FROM unnest(${ids}::text[], ${codes}::text[], ${names}::text[], ${vals}::text[]) AS u(id, code, name, vals)
        ON CONFLICT ("clientId","outletCode","month") DO UPDATE
          SET "kpiValues" = (outlet_sales_records."kpiValues" - ${owned}::text[]) || EXCLUDED."kpiValues",
              "updatedAt" = ${SQL_NOW_UTC}`);
    }

    // 3. Full rewrite: every OTHER row of the month (off-roster, or now out of every owned KPI's scope) loses its
    //    owned keys. Non-owned keys are untouched.
    const written = comp.rows.map((r) => r.outletCode);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "outlet_sales_records"
         SET "kpiValues" = "kpiValues" - ${owned}::text[], "updatedAt" = ${SQL_NOW_UTC}
       WHERE "clientId" = ${clientId} AND "month" = ${month}
         AND NOT ("outletCode" = ANY(${written}::text[]))
         AND "kpiValues" ?| ${owned}::text[]`);

    const now = new Date();
    // 4. IMPORT only: the month's stored history becomes exactly this import's lines for the month (every customer
    //    code; outletId = the roster outlet NOW, null when unmatched). One set per month, whatever was uploaded before.
    if (w.source === 'IMPORT') {
      const index = rosterIndexOf(w.roster);
      const histCodes = [...index.keys()];
      const histIds = histCodes.map((c) => w.roster.get(index.get(c)!)?.id ?? null);
      // ONE set-based INSERT … SELECT (no per-row round trips). Durations are logged so the month write can be measured
      // at real scale (final check L2); the transaction timeout of this path is APPLY_TX_TIMEOUT_MS.
      const t0 = Date.now();
      const deleted = await tx.$executeRaw(Prisma.sql`DELETE FROM "sales_month_histories" WHERE "clientId" = ${clientId} AND "month" = ${month}`);
      const t1 = Date.now();
      const inserted = await tx.$executeRaw(Prisma.sql`
        INSERT INTO "sales_month_histories"
          ("clientId","month","customerCode","outletId","dims","dimKey","keyHash","amountPaise","qtyPico","lines","sourceImportId","appliedAt","appliedById")
        SELECT ${clientId}, a."month", a."outletCode", r.id, a."dims", a."dimKey", md5(a."outletCode" || chr(31) || a."dimKey"),
               a."amountPaise", a."qtyPico", a."lines", ${w.sourceImportId}, ${sqlUtc(now)}, ${user.sub}
          FROM "sales_import_aggregates" a
          LEFT JOIN unnest(${histCodes}::text[], ${histIds}::text[]) AS r(code, id) ON r.code = a."outletCode"
         WHERE a."importId" = ${w.sourceImportId} AND a."month" = ${month}`);
      const t2 = Date.now();
      // The month's combos summary (plan §10c, audit M1): replaced from the lines just written, in this transaction, with
      // ONE INSERT … SELECT … GROUP BY (dimKey ↔ dims is 1:1 within a month: one import, one mapping). The KPI picker's
      // "Stored month(s)" source reads only this table. Recalculate does not change the history, so not this either.
      await tx.$executeRaw(Prisma.sql`DELETE FROM "sales_month_history_combos" WHERE "clientId" = ${clientId} AND "month" = ${month}`);
      const comboRows = await tx.$executeRaw(Prisma.sql`
        INSERT INTO "sales_month_history_combos" ("clientId","month","dims","dimKey","keyHash","amountPaise","qtyPico","lines")
        SELECT h."clientId", h."month", (array_agg(h."dims"))[1], h."dimKey", md5(h."dimKey"),
               SUM(h."amountPaise"), SUM(h."qtyPico"), SUM(h."lines")::int
          FROM "sales_month_histories" h
         WHERE h."clientId" = ${clientId} AND h."month" = ${month}
         GROUP BY h."clientId", h."month", h."dimKey"`);
      const t3 = Date.now();
      // The set's header: what the lines are, and the mapping they were parsed with (recalculate checks it).
      const header = {
        sourceImportId: w.sourceImportId,
        appliedAt: now,
        appliedById: user.sub,
        mappingFingerprint: w.mapping?.fingerprint ?? null,
        dimensionKeys: w.mapping?.dimensionKeys ?? [],
        lineRows: Number(inserted),
      };
      await tx.salesMonthHistorySet.upsert({
        where: { clientId_month: { clientId, month } },
        create: { clientId, month, ...header },
        update: header,
      });
      this.log.log(
        JSON.stringify({ msg: 'sales-import month history written', clientId, month, deletedRows: Number(deleted), insertedRows: Number(inserted), comboRows: Number(comboRows), deleteMs: t1 - t0, insertMs: t2 - t1, combosMs: t3 - t2 }),
      );
    }

    // 5. Apply record + month pointer + audit.
    const totals: Record<string, { before: number; after: number }> = {};
    defs.forEach((d, i) => (totals[d.kpiCode] = { before: before[d.kpiCode] ?? 0, after: comp.stats[i].total }));
    const outletsZeroFilled = comp.rows.filter((r) => r.zeroFilled).length;
    const applyRow = await tx.salesImportApply.create({
      data: {
        importId: w.sourceImportId,
        clientId,
        month,
        appliedById: user.sub,
        batchId: batch.id,
        definitionsHash: w.hash,
        definitionsSnapshot: w.defRows.map(toDto) as unknown as Prisma.InputJsonValue,
        outletsWritten: comp.rows.length,
        outletsZeroFilled,
        totals: totals as unknown as Prisma.InputJsonValue,
        source: w.source,
      },
    });
    await tx.salesMonthStatus.upsert({
      where: { clientId_month: { clientId, month } },
      // A first row records the month's CURRENT resolved state, so it never changes the open/closed outcome.
      create: { clientId, month, state: w.state.state, lastAppliedImportId: w.sourceImportId, lastAppliedAt: now },
      update: { lastAppliedImportId: w.sourceImportId, lastAppliedAt: now },
    });
    await tx.auditLog.create({
      data: {
        action: 'IMPORT',
        entityType: 'SALES_MONTH',
        entityId: `${clientId}:${month}`,
        actorId: user.sub,
        newValues: {
          source: w.source,
          importId: w.sourceImportId,
          processingVersion: w.processingVersion,
          definitionsHash: w.hash,
          outletsWritten: comp.rows.length,
          outletsZeroFilled,
          totals,
        } as Prisma.InputJsonValue,
        metadata: { clientId, applyId: applyRow.id, batchId: batch.id, source: w.source },
      },
    });

    return { month, ok: true, applyId: applyRow.id, outletsWritten: comp.rows.length, outletsZeroFilled };
  }

  // ─── Recalculate a month from its stored history (owner decision 2026-11-10) ─────────────────────────────────

  /**
   * GET admin/sales-months/:month/recalculate/preview — what recalculating would write: every importer-owned KPI of
   * the month recomputed from SalesMonthHistory with the CURRENT definitions and the CURRENT roster. No write.
   */
  async recalcPreview(clientId: string, month: string): Promise<SalesMonthRecalcPreview> {
    if (!isMonthKey(month)) throw new BadRequestException('month must be YYYY-MM.');
    const meta = await monthHistoryMeta(this.prisma, clientId, month);
    if (!meta) throw new NotFoundException(`${monthLabel(month)} has no stored sales history (no file was applied to it).`);
    const { defs, hash } = await this.kpiDefs.enabled(clientId);
    const roster = await loadRosterMeta(this.prisma, clientId);
    const override = await this.prisma.salesMonthStatus.findUnique({ where: { clientId_month: { clientId, month } } });
    const state = resolveMonthState(month, currentMonthKey(), override);
    const comp = await computeMonthRows(historyPager(this.prisma, clientId, month), defs, roster);
    const owned = defs.map((d) => d.kpiCode);
    const existing = await this.prisma.outletSalesRecord.findMany({
      where: { clientId, month },
      select: { outletCode: true, kpiValues: true, batch: { select: { status: true, createdAt: true } } },
    });
    const currentTotals = sumOwnedValues(existing, owned);
    const last = await loadLastApplied(this.prisma, clientId, month);
    const warnings: SalesMonthWarning[] = [];
    if (comp.stats.some((s) => s.outletsNegative > 0)) warnings.push('NEGATIVE_VALUES');
    if (replacesManualValues(existing, owned, last ? { createdAt: last.at, ownedCodes: last.ownedCodes } : null, SALES_IMPORT_BATCH_STATUS)) {
      warnings.push('REPLACES_MANUAL_VALUES');
    }
    const set = historySetCheck(meta, defs, await this.currentFingerprint(clientId));
    if (set.mappingChanged) warnings.push('MAPPING_CHANGED');
    const blockedReason = blockedReasonFor({ month, defsCount: defs.length, mappingChanged: false, state }) ?? set.blocked;
    const labels = new Map(
      (await this.prisma.kpiDef.findMany({ where: { clientId, code: { in: owned } }, select: { code: true, label: true } })).map((k) => [k.code, k.label]),
    );
    return {
      month,
      monthState: state.state,
      canApply: blockedReason === null,
      ...(blockedReason ? { blockedReason } : {}),
      definitionsHash: hash,
      historySourceImportId: meta.sourceImportId,
      historyAppliedAt: meta.appliedAt.toISOString(),
      matchedOutlets: comp.split.matchedOutlets,
      unmatchedCustomers: comp.split.unmatchedCustomers,
      matchedAmountRupees: paiseToRupees(comp.split.matchedPaise),
      matchedQuantity: unitsToNumber(comp.split.matchedQtyThousandths, 'QUANTITY'),
      unmatchedAmountRupees: paiseToRupees(comp.split.unmatchedPaise),
      unmatchedQuantity: unitsToNumber(comp.split.unmatchedQtyThousandths, 'QUANTITY'),
      zeroFillOutlets: comp.zeroFillOutlets,
      outletsAffected: outletsAffected(existing, comp.rows, owned),
      warnings,
      kpis: defs.map((d, i) => {
        const newTotal = comp.stats[i].total;
        const currentTotal = currentTotals[d.kpiCode] ?? 0;
        return {
          kpiCode: d.kpiCode,
          label: labels.get(d.kpiCode) ?? d.kpiCode,
          measure: d.measure,
          newTotal,
          currentTotal,
          delta: Math.round((newTotal - currentTotal) * 1e6) / 1e6,
          outletsNonZero: comp.stats[i].outletsNonZero,
          outletsNegative: comp.stats[i].outletsNegative,
        };
      }),
    };
  }

  /**
   * POST admin/sales-months/:month/recalculate — rewrite the month's importer-owned KPIs from its stored history (same
   * write as apply; recorded as a SalesImportApply with source HISTORY; the history itself is unchanged). Month lock;
   * month must be OPEN; 409 when the definitions or the history changed since the preview.
   */
  async recalculate(user: JwtPayload, month: string, body: SalesMonthRecalcRequest): Promise<ApplyMonthResult> {
    if (!isMonthKey(month)) throw new BadRequestException('month must be YYYY-MM.');
    if (!body || typeof body.expectedDefinitionsHash !== 'string' || typeof body.expectedHistoryAppliedAt !== 'string') {
      throw new BadRequestException('expectedDefinitionsHash and expectedHistoryAppliedAt are required (from the recalculate preview).');
    }
    const clientId = user.clientId;
    return this.prisma.$transaction(
      async (tx) => {
        await lockSalesMonth(tx, clientId, month);
        const meta = await monthHistoryMeta(tx, clientId, month);
        if (!meta) throw new NotFoundException(`${monthLabel(month)} has no stored sales history.`);
        if (meta.appliedAt.toISOString() !== body.expectedHistoryAppliedAt) {
          throw new ConflictException('A newer file was applied to this month since the preview. Refresh the preview and try again.');
        }
        const override = await tx.salesMonthStatus.findUnique({ where: { clientId_month: { clientId, month } } });
        const state = resolveMonthState(month, currentMonthKey(), override);
        const { rows: defRows, defs, hash } = await this.kpiDefs.enabled(clientId, tx);
        if (hash !== body.expectedDefinitionsHash) throw new ConflictException('KPI definitions changed since the preview. Refresh the preview and try again.');
        const blocked =
          blockedReasonFor({ month, defsCount: defs.length, mappingChanged: false, state }) ??
          historySetCheck(meta, defs, null).blocked;
        if (blocked) throw new ConflictException(blocked);
        const roster = await loadRosterMeta(tx, clientId);
        const comp = await computeMonthRows(historyPager(tx, clientId, month), defs, roster);
        return this.writeMonth(tx, user, {
          month,
          source: 'HISTORY',
          sourceImportId: meta.sourceImportId,
          processingVersion: null,
          defRows,
          defs,
          hash,
          state,
          roster,
          comp,
        });
      },
      { timeout: APPLY_TX_TIMEOUT_MS, maxWait: 10_000 },
    );
  }

  private async currentFingerprint(clientId: string): Promise<string | null> {
    const p = await this.prisma.salesImportProfile.findUnique({ where: { clientId }, select: { columnMapping: true } });
    return mappingFingerprint((p?.columnMapping ?? null) as SalesColumnMapping | null);
  }
}

/**
 * Final check M1: can the CURRENT KPI definitions be evaluated on a month's stored lines? Blocked when an enabled KPI
 * filters on a dimension key the stored lines do not have (it would silently match nothing → zeros); MAPPING_CHANGED
 * warning when the mapping changed since but every used dimension is present. (`currentFingerprint` null = skip the
 * warning check.)
 */
export function historySetCheck(
  meta: { mappingFingerprint: string | null; dimensionKeys: string[] },
  defs: readonly KpiDefLite[],
  currentFingerprint: string | null,
): { blocked: string | null; mappingChanged: boolean } {
  const have = new Set(meta.dimensionKeys);
  const missing: string[] = [];
  for (const d of defs) {
    const absent = filterDimKeys(d.filter).filter((k) => !have.has(k));
    if (absent.length) missing.push(`${d.kpiCode} (${absent.join(', ')})`);
  }
  if (missing.length) {
    return {
      blocked: `These KPIs use dimensions that this month's stored lines do not have: ${missing.join('; ')}. Apply a file processed with the current mapping instead.`,
      mappingChanged: false,
    };
  }
  return { blocked: null, mappingChanged: currentFingerprint !== null && meta.mappingFingerprint !== currentFingerprint };
}

/**
 * OutletSalesRecord rows whose OWNED values a full rewrite would change: written rows whose owned values differ (or that
 * do not exist yet), plus existing rows that would lose owned keys.
 */
export function outletsAffected(
  existing: Array<{ outletCode: string; kpiValues: Prisma.JsonValue }>,
  rows: Array<{ outletCode: string; values: Record<string, number> }>,
  owned: readonly string[],
): number {
  const ownedOf = (v: Prisma.JsonValue): Record<string, number> => {
    const out: Record<string, number> = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    for (const k of owned) {
      const n = (v as Record<string, unknown>)[k];
      if (n !== undefined && n !== null) out[k] = Number(n);
    }
    return out;
  };
  const before = new Map(existing.map((r) => [r.outletCode, ownedOf(r.kpiValues)]));
  const after = new Map(rows.map((r) => [r.outletCode, r.values]));
  let n = 0;
  for (const code of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(code);
    const b = after.get(code) ?? {};
    if (a === undefined) {
      n++; // a new row is created
      continue;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    if ([...keys].some((k) => a[k] === undefined || b[k] === undefined || Math.abs(a[k] - b[k]) > 1e-9)) n++;
  }
  return n;
}
