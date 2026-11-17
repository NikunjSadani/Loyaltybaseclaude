/**
 * The day-level WRITE (sales-day-level, owner decision 2026-11-18), shared by apply / recalculate (SalesApplyService)
 * and the one-off November rebuild (oneoff/sales-day-rebuild.ts). Runs INSIDE the caller's transaction, which already
 * holds the month lock (lockSalesMonth): the month's outlet_sales_days rows are REPLACED and its sales_day_sets row is
 * upserted — or, when the day data cannot be built, both are removed and the result says why (never stale day data
 * next to new monthly values; never silent).
 */
import type { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { SalesDayDataResult } from '../sales-import.contract';
import type { MonthDaysBuild } from './month-days';

/** Rows per outlet_sales_days INSERT … unnest statement (≈ 6.5k outlets × billing days ≈ tens of thousands per month). */
export const DAY_CHUNK = 5000;

export type DayWriteSource = 'IMPORT' | 'HISTORY' | 'REBUILD';

/** Why a month write stores no day-level data (shown in ApplyMonthResult.dayData.reason + the audit row). */
export function dayDataReason(build: Exclude<MonthDaysBuild, { ok: true }>, source: DayWriteSource): string {
  if (build.code === 'NO_DAY_SPLIT') {
    return source === 'IMPORT'
      ? 'This file was processed before day-by-day sales were stored, so this month now has no day-by-day data. Reprocess the file and apply it again to store it.'
      : "This month's stored sales lines were applied before day-by-day sales were stored, so this month has no day-by-day data. Apply the sales file to the month again to store it.";
  }
  return `The day-by-day values did not add up to the monthly values (${build.detail}), so no day-by-day data was stored for this month. Contact Gifsy support.`;
}

export async function replaceMonthDays(
  tx: Pick<Prisma.TransactionClient, '$executeRaw' | 'salesDaySet'>,
  log: Pick<Logger, 'log' | 'warn' | 'error'>,
  a: {
    clientId: string;
    month: string;
    source: DayWriteSource;
    sourceImportId: string;
    build: MonthDaysBuild;
    /** Last invoice day of the month in the applied file; null = unknown (→ the latest day written). */
    lastDay: number | null;
    now: Date;
  },
): Promise<SalesDayDataResult> {
  const { clientId, month, build } = a;
  const t0 = Date.now();
  const deleted = await tx.$executeRaw(Prisma.sql`DELETE FROM "outlet_sales_days" WHERE "clientId" = ${clientId} AND "month" = ${month}`);
  let lastDay = a.lastDay;
  if (build.ok && lastDay === null) {
    for (const r of build.rows) lastDay = Math.max(lastDay ?? 0, r.day);
  }
  if (!build.ok || lastDay === null) {
    await tx.salesDaySet.deleteMany({ where: { clientId, month } });
    const reason = !build.ok
      ? dayDataReason(build, a.source)
      : 'The last invoice day of the applied file for this month is unknown, so no day-by-day data was stored. Apply the sales file to the month again.';
    const detail = !build.ok ? (build.code === 'MISMATCH' ? { detail: build.detail } : { rowsWithoutDays: build.rowsWithoutDays }) : {};
    const line = JSON.stringify({
      msg: 'sales-import day data NOT written', clientId, month, source: a.source, deletedRows: Number(deleted),
      code: build.ok ? 'NO_LAST_DAY' : build.code, ...detail,
    });
    if (!build.ok && build.code === 'MISMATCH') log.error(line);
    else log.warn(line);
    return { written: false, outlets: 0, rows: 0, lastDay: null, reason };
  }
  for (let i = 0; i < build.rows.length; i += DAY_CHUNK) {
    const chunk = build.rows.slice(i, i + DAY_CHUNK);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "outlet_sales_days" ("clientId","outletId","outletCode","month","day","mtdValues","sourceImportId")
      SELECT ${clientId}, u.oid, u.code, ${month}, u.day, u.vals::jsonb, ${a.sourceImportId}
        FROM unnest(${chunk.map((r) => r.outletId)}::text[], ${chunk.map((r) => r.outletCode)}::text[],
                    ${chunk.map((r) => r.day)}::int[], ${chunk.map((r) => JSON.stringify(r.mtdValues))}::text[]) AS u(oid, code, day, vals)`);
  }
  const set = { lastDay, sourceImportId: a.sourceImportId, appliedAt: a.now };
  await tx.salesDaySet.upsert({ where: { clientId_month: { clientId, month } }, create: { clientId, month, ...set }, update: set });
  log.log(
    JSON.stringify({
      msg: 'sales-import day data written', clientId, month, source: a.source, deletedRows: Number(deleted),
      insertedRows: build.rows.length, outlets: build.outlets, lastDay, ms: Date.now() - t0,
    }),
  );
  return { written: true, outlets: build.outlets, rows: build.rows.length, lastDay };
}
