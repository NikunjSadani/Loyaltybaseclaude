import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
} from '../sales-import.contract';
import { SalesKpiDefService, toDto } from '../kpi/sales-kpi-def.service';
import { MAPPING_CHANGED_REASON, loadRosterMeta, mappingChangedSince, resolveReadyImport } from '../kpi/sales-import-data';
import { lockImportRow } from '../ingest/import-lock';
import { isMonthKey, monthLabel, resolveMonthState } from '../months/month-state';
import { computeMonthRows, sumOwnedValues } from './month-compute';
import { loadLastApplied } from './last-applied';
import { isOlderThanLastApplied, partialMonthWarnings } from './warnings';
import { blockedReasonFor, monthSummariesOf } from './sales-preview.service';

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

        const owned = defs.map((d) => d.kpiCode);

        // Before-totals (inside the lock, so they are what this apply replaces).
        const before = sumOwnedValues(
          await tx.outletSalesRecord.findMany({ where: { clientId, month }, select: { kpiValues: true } }),
          owned,
        );

        // 2. The batch row every newly-INSERTED record points at.
        const comp = await computeMonthRows(tx, importId, month, defs, roster);
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

        // 3. Bulk merge (owned keys only). Existing rows keep their batchId and outletName.
        for (let i = 0; i < comp.rows.length; i += APPLY_CHUNK) {
          const chunk = comp.rows.slice(i, i + APPLY_CHUNK);
          const ids = chunk.map(() => randomUUID());
          const codes = chunk.map((r) => r.outletCode);
          const names = chunk.map((r) => r.outletName);
          const vals = chunk.map((r) => JSON.stringify(r.values));
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO "outlet_sales_records" ("id","clientId","outletCode","outletName","month","kpiValues","batchId","createdAt","updatedAt")
            SELECT u.id, ${clientId}, u.code, u.name, ${month}, u.vals::jsonb, ${batch.id}, now(), now()
              FROM unnest(${ids}::text[], ${codes}::text[], ${names}::text[], ${vals}::text[]) AS u(id, code, name, vals)
            ON CONFLICT ("clientId","outletCode","month") DO UPDATE
              SET "kpiValues" = (outlet_sales_records."kpiValues" - ${owned}::text[]) || EXCLUDED."kpiValues",
                  "updatedAt" = now()`);
        }

        // 4. Full rewrite: every OTHER row of the month (off-roster, or now out of every owned KPI's scope) loses its
        //    owned keys. Non-owned keys are untouched.
        const written = comp.rows.map((r) => r.outletCode);
        await tx.$executeRaw(Prisma.sql`
          UPDATE "outlet_sales_records"
             SET "kpiValues" = "kpiValues" - ${owned}::text[], "updatedAt" = now()
           WHERE "clientId" = ${clientId} AND "month" = ${month}
             AND NOT ("outletCode" = ANY(${written}::text[]))
             AND "kpiValues" ?| ${owned}::text[]`);

        // 5. History + month pointer + audit.
        const totals: Record<string, { before: number; after: number }> = {};
        defs.forEach((d, i) => (totals[d.kpiCode] = { before: before[d.kpiCode] ?? 0, after: comp.stats[i].total }));
        const outletsZeroFilled = comp.rows.filter((r) => r.zeroFilled).length;
        const applyRow = await tx.salesImportApply.create({
          data: {
            importId,
            clientId,
            month,
            appliedById: user.sub,
            batchId: batch.id,
            definitionsHash: hash,
            definitionsSnapshot: defRows.map(toDto) as unknown as Prisma.InputJsonValue,
            outletsWritten: comp.rows.length,
            outletsZeroFilled,
            totals: totals as unknown as Prisma.InputJsonValue,
          },
        });
        const now = new Date();
        await tx.salesMonthStatus.upsert({
          where: { clientId_month: { clientId, month } },
          // A first row records the month's CURRENT resolved state, so it never changes the open/closed outcome.
          create: { clientId, month, state: state.state, lastAppliedImportId: importId, lastAppliedAt: now },
          update: { lastAppliedImportId: importId, lastAppliedAt: now },
        });
        await tx.auditLog.create({
          data: {
            action: 'IMPORT',
            entityType: 'SALES_MONTH',
            entityId: `${clientId}:${month}`,
            actorId: user.sub,
            newValues: {
              importId,
              processingVersion: imp.processingVersion,
              definitionsHash: hash,
              outletsWritten: comp.rows.length,
              outletsZeroFilled,
              totals,
            } as Prisma.InputJsonValue,
            metadata: { clientId, applyId: applyRow.id, batchId: batch.id },
          },
        });

        return { month, ok: true, applyId: applyRow.id, outletsWritten: comp.rows.length, outletsZeroFilled };
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  }
}
