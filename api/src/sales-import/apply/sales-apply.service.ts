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
import { loadRosterMeta, resolveReadyImport, rosterHashOfMap } from '../kpi/sales-import-data';
import { isMonthKey, monthLabel, resolveMonthState } from '../months/month-state';
import { computeMonthRows, sumOwnedValues } from './month-compute';
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
 * the manual batch delete. Inside: re-check OPEN, READY, definitions hash and roster; create a SALES_IMPORT batch;
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
    const { defs, hash } = await this.kpiDefs.enabled(clientId);
    if (hash !== req.expectedDefinitionsHash) {
      throw new ConflictException('KPI definitions changed since the preview. Refresh the preview and try again.');
    }
    if (defs.length === 0) throw new BadRequestException('No importer-owned KPIs are defined yet.');

    const summaries = new Map(monthSummariesOf(imp).map((s) => [s.month, s]));
    const current = currentMonthKey();

    // Acknowledgement checks (400 before ANY write).
    const missingPartial: string[] = [];
    let needsOlderAck = false;
    const statuses = await this.prisma.salesMonthStatus.findMany({ where: { clientId, month: { in: req.months } } });
    const lastIds = [...new Set(statuses.map((s) => s.lastAppliedImportId).filter((x): x is string => !!x))];
    const lastImports = lastIds.length
      ? await this.prisma.salesImport.findMany({ where: { clientId, id: { in: lastIds } }, select: { id: true, createdAt: true } })
      : [];
    for (const month of req.months) {
      const s = summaries.get(month);
      if (!s) continue; // reported per month below
      if (partialMonthWarnings(s, current).length > 0 && !req.acknowledgePartialMonths.includes(month)) missingPartial.push(month);
      const st = statuses.find((x) => x.month === month);
      const last = st?.lastAppliedImportId ? lastImports.find((i) => i.id === st.lastAppliedImportId) : null;
      if (isOlderThanLastApplied(imp, last)) needsOlderAck = true;
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
        results.push(await this.applyMonth(user, imp.id, summary, req.expectedDefinitionsHash));
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
    const ack = body.acknowledgePartialMonths ?? [];
    if (!Array.isArray(ack) || ack.some((m) => typeof m !== 'string')) {
      throw new BadRequestException('acknowledgePartialMonths must be a list of months.');
    }
    return {
      months: [...months].sort(),
      expectedDefinitionsHash: body.expectedDefinitionsHash,
      acknowledgePartialMonths: ack,
      acknowledgeOlderThanLastApplied: body.acknowledgeOlderThanLastApplied === true,
    };
  }

  private async applyMonth(user: JwtPayload, importId: string, summary: MonthSummary, expectedHash: string): Promise<ApplyMonthResult> {
    const clientId = user.clientId;
    const month = summary.month;

    return this.prisma.$transaction(
      async (tx) => {
        await lockSalesMonth(tx, clientId, month);

        // 1. Re-check everything under the lock.
        const override = await tx.salesMonthStatus.findUnique({ where: { clientId_month: { clientId, month } } });
        const state = resolveMonthState(month, currentMonthKey(), override);
        const imp = await tx.salesImport.findFirst({ where: { id: importId, clientId } });
        if (!imp || imp.status !== 'READY') throw new MonthApplyError('The import is no longer READY.');
        const { rows: defRows, defs, hash } = await this.kpiDefs.enabled(clientId, tx);
        if (hash !== expectedHash) throw new MonthApplyError('KPI definitions changed. Refresh the preview.');
        const roster = await loadRosterMeta(tx, clientId);
        const rosterChanged = !imp.rosterHash || rosterHashOfMap(roster) !== imp.rosterHash;
        const blocked = blockedReasonFor({ month, defsCount: defs.length, rosterChanged, state });
        if (blocked) throw new MonthApplyError(blocked);

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
            newValues: { importId, definitionsHash: hash, outletsWritten: comp.rows.length, outletsZeroFilled, totals } as Prisma.InputJsonValue,
            metadata: { clientId, applyId: applyRow.id, batchId: batch.id },
          },
        });

        return { month, ok: true, applyId: applyRow.id, outletsWritten: comp.rows.length, outletsZeroFilled };
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  }
}
