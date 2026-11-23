/**
 * ONE-OFF: build a month's day-level data from the stored file of the import last applied to it — for months applied
 * BEFORE day-level storage existed (November 2026 on prod). Entry point: sales-history-trim.main.ts `rebuild-days`.
 * DRY-RUN by default; `--apply` writes. It never changes a monthly figure (OutletSalesRecord) or a history line's
 * values — it only fills the history lines' day split and writes outlet_sales_days / sales_day_sets.
 *
 * Refuses (nothing written; the reason is printed and returned) when:
 *   - the month has no stored history, or is outside the day-data window (current month + 3 previous);
 *   - the import's stored file is gone (retention purge: raw files are kept 7 days after the import finished);
 *   - re-reading the file does not reproduce EVERY stored history line of the month exactly (amount, quantity, lines);
 *   - the CURRENT KPI definitions / roster / focus products no longer reproduce the month's stored monthly figures
 *     (then the day data would disagree with them — recalculate or re-apply the month first);
 *   - the day values do not add up to the monthly values (buildMonthDays invariant).
 * Writes happen in ONE transaction under the month lock, after re-checking (S6) that the month's history is still the
 * same set (sourceImportId + appliedAt), that the KPI definitions (hash) and the focus products (fingerprint) are the
 * ones the day values were built with, and that the stored monthly figures are still what those values end on — so a
 * recalculate / apply that ran meanwhile is never overwritten with stale day data.
 */
import type { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { lockSalesMonth } from '../../common/sales-kpi-ownership';
import type { MonthSummary, SalesColumnMapping } from '../sales-import.contract';
import type { AggregatorResult } from '../ingest/aggregator';
import { AGG_PAGE_SIZE, loadRosterMeta, rosterIndexOf, type AggRow, type AggregatePager } from '../kpi/sales-import-data';
import { encodeDays, dayOfDate } from '../days/day-slices';
import { computeMonthRows, type MonthOutletRow } from '../apply/month-compute';
import { buildMonthDays, type MonthDaysBuild } from '../apply/month-days';
import { dayDataReason, replaceMonthDays } from '../apply/month-days-write';
import { APPLY_TX_TIMEOUT_MS } from '../apply/sales-apply.service';
import { lazyCatalogue, runMonthFocus } from '../apply/month-focus';
import { kpiLabelsOf, loadFocusCatalogue } from '../kpi/focus-data';
import { definitionsHash, type KpiDefLite } from '../kpi/sales-kpi.helper';
import { dayDataRetentionMessage, isBeyondDayDataRetention } from '../retention-window';
import { monthLabel } from '../months/month-state';

export const REBUILD_SAMPLE = 20;
const HISTORY_UPDATE_CHUNK = 5000;

type Db = Prisma.TransactionClient & {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, opts?: { timeout?: number; maxWait?: number }): Promise<T>;
};

export interface RebuildDeps {
  db: Db;
  kpiDefs: { enabled(clientId: string, db?: Prisma.TransactionClient): Promise<{ defs: KpiDefLite[] }> };
  /** Re-reads the import's stored file (stored-file-parse.parseStoredFile bound to the storage service). */
  parse: (imp: { gcsPrefix: string; sizeBytes: bigint; fileKind: string }, mapping: SalesColumnMapping, roster: ReadonlyMap<string, string>) =>
    Promise<{ ok: true; result: AggregatorResult } | { ok: false; problem: string }>;
  log: Pick<Logger, 'log' | 'warn' | 'error'>;
}

export interface RebuildReport {
  clientId: string;
  month: string;
  applied: boolean;
  ok: boolean;
  /** Why nothing was (or would be) written. */
  problem?: string;
  sourceImportId?: string;
  historyLines?: number;
  historyLinesWithDays?: number;
  /** Re-read vs stored lines: lines that differ or are missing in the file (samples). */
  lineMismatches?: number;
  lineMismatchSamples?: string[];
  /** Current definitions vs stored monthly figures: outlets that differ (samples). */
  figureMismatches?: number;
  figureMismatchSamples?: string[];
  dayRows?: number;
  outlets?: number;
  lastDay?: number | null;
}

interface StoredLine {
  id: bigint;
  customerCode: string;
  dims: Record<string, string>;
  dimKey: string;
  amountPaise: bigint;
  qtyPico: bigint;
  lines: number;
}

async function readHistory(db: Prisma.TransactionClient, clientId: string, month: string): Promise<StoredLine[]> {
  const out: StoredLine[] = [];
  let cursor: bigint | null = null;
  for (;;) {
    const page: Array<{ id: bigint; customerCode: string; dims: Prisma.JsonValue; dimKey: string; amountPaise: bigint; qtyPico: bigint; lines: number }> =
      await db.salesMonthHistory.findMany({
        where: { clientId, month, ...(cursor !== null ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: AGG_PAGE_SIZE,
        select: { id: true, customerCode: true, dims: true, dimKey: true, amountPaise: true, qtyPico: true, lines: true },
      });
    for (const r of page) {
      const dims: Record<string, string> = {};
      if (r.dims && typeof r.dims === 'object' && !Array.isArray(r.dims)) {
        for (const [k, v] of Object.entries(r.dims as Record<string, unknown>)) dims[k] = v === null || v === undefined ? '' : String(v);
      }
      out.push({ id: BigInt(r.id), customerCode: r.customerCode, dims, dimKey: r.dimKey, amountPaise: BigInt(r.amountPaise), qtyPico: BigInt(r.qtyPico), lines: r.lines });
    }
    if (page.length < AGG_PAGE_SIZE) return out;
    cursor = page[page.length - 1].id;
  }
}

/** The owned values of the month's CURRENT OutletSalesRecord rows vs what the definitions give now. */
export function figureDifferences(
  existing: Array<{ outletCode: string; kpiValues: Prisma.JsonValue }>,
  written: readonly MonthOutletRow[],
  owned: readonly string[],
): string[] {
  const diffs: string[] = [];
  const now = new Map(written.map((r) => [r.outletCode, r.values]));
  const seen = new Set<string>();
  for (const e of existing) {
    const v = (e.kpiValues && typeof e.kpiValues === 'object' && !Array.isArray(e.kpiValues) ? e.kpiValues : {}) as Record<string, unknown>;
    const stored: Record<string, number> = {};
    for (const k of owned) if (v[k] !== undefined && v[k] !== null) stored[k] = Number(v[k]);
    if (Object.keys(stored).length === 0 && !now.has(e.outletCode)) continue;
    seen.add(e.outletCode);
    const fresh = now.get(e.outletCode) ?? {};
    for (const k of new Set([...Object.keys(stored), ...Object.keys(fresh)])) {
      if (stored[k] !== fresh[k]) diffs.push(`${e.outletCode} ${k}: stored ${stored[k] ?? '(none)'} vs now ${fresh[k] ?? '(none)'}`);
    }
  }
  for (const r of written) if (!seen.has(r.outletCode)) diffs.push(`${r.outletCode}: no stored record vs now ${JSON.stringify(r.values)}`);
  return diffs;
}

export async function rebuildMonthDays(deps: RebuildDeps, a: { clientId: string; month: string; apply: boolean }): Promise<RebuildReport> {
  const { db, log } = deps;
  const { clientId, month } = a;
  const base: RebuildReport = { clientId, month, applied: false, ok: false };
  const fail = (problem: string, extra: Partial<RebuildReport> = {}): RebuildReport => {
    log.warn(JSON.stringify({ msg: 'sales-day rebuild refused', clientId, month, problem }));
    return { ...base, ...extra, problem };
  };
  // Day data outside its window would be deleted by the next sweep: never built (whatever the history window is).
  if (isBeyondDayDataRetention(month)) return fail(dayDataRetentionMessage(month));
  const header = await db.salesMonthHistorySet.findUnique({ where: { clientId_month: { clientId, month } } });
  if (!header) return fail(`${monthLabel(month)} has no stored sales history (no file was applied to it).`);
  const imp = await db.salesImport.findFirst({ where: { id: header.sourceImportId, clientId } });
  if (!imp) return fail(`The import ${header.sourceImportId} last applied to ${monthLabel(month)} no longer exists.`, { sourceImportId: header.sourceImportId });
  if (imp.purgedAt || imp.filesPurgedAt) {
    return fail(
      `The stored file of import ${imp.id} (last applied to ${monthLabel(month)}) was deleted after the retention period, so its day-by-day data cannot be rebuilt. Apply the sales file to the month again.`,
      { sourceImportId: imp.id },
    );
  }
  const mapping = imp.mappingSnapshot as unknown as SalesColumnMapping | null;
  if (!mapping) return fail(`Import ${imp.id} has no stored column mapping.`, { sourceImportId: imp.id });
  const summary = (Array.isArray(imp.monthSummaries) ? (imp.monthSummaries as unknown as MonthSummary[]) : []).find((s) => s?.month === month);

  // 1. Re-read the stored file and check it reproduces EVERY stored line of the month exactly.
  const roster = await loadRosterMeta(db, clientId);
  const stored = await readHistory(db, clientId, month);
  // Roster-only aggregates (2026-11-23): the re-reader keeps lines only for the codes it is given, so give it today's
  // roster AND every customer code of the stored history (an outlet removed since the apply still has stored lines).
  const readCodes = new Map(rosterIndexOf(roster));
  for (const h of stored) if (!readCodes.has(h.customerCode)) readCodes.set(h.customerCode, h.customerCode);
  const parsed = await deps.parse(imp, mapping, readCodes);
  if (!parsed.ok) return fail(parsed.problem, { sourceImportId: imp.id });
  const mismatches: string[] = [];
  const lines: AggRow[] = [];
  for (const h of stored) {
    const got = parsed.result.get(month, h.customerCode, h.dimKey);
    const days = parsed.result.getDays(month, h.customerCode, h.dimKey);
    if (!got || !days || got.amountPaise !== h.amountPaise || got.qtyPico !== h.qtyPico || got.lines !== h.lines) {
      mismatches.push(`${h.customerCode} ${h.dimKey}: stored ${h.amountPaise}/${h.qtyPico}/${h.lines} vs file ${got ? `${got.amountPaise}/${got.qtyPico}/${got.lines}` : '(missing)'}`);
      continue;
    }
    lines.push({ id: h.id, month, outletCode: h.customerCode, dims: h.dims, dimKey: h.dimKey, amountPaise: h.amountPaise, qtyPico: h.qtyPico, lines: h.lines, days });
  }
  const withDays = await db.salesMonthHistory.count({ where: { clientId, month, NOT: { days: { equals: Prisma.DbNull } } } });
  const counts = { sourceImportId: imp.id, historyLines: stored.length, historyLinesWithDays: withDays };
  if (mismatches.length > 0) {
    return fail(
      `Re-reading the stored file does not reproduce ${mismatches.length} of the ${stored.length} stored lines of ${monthLabel(month)}; nothing written.`,
      { ...counts, lineMismatches: mismatches.length, lineMismatchSamples: mismatches.slice(0, REBUILD_SAMPLE) },
    );
  }

  // 2. The day values, with the CURRENT definitions / roster / focus products — which must still give the stored figures.
  const { defs } = await deps.kpiDefs.enabled(clientId);
  if (defs.length === 0) return fail('No importer-owned KPIs are defined.', counts);
  const focusOf = async (q: Prisma.TransactionClient, d: KpiDefLite[]) =>
    runMonthFocus(q, {
      clientId, month, defs: d, roster,
      labelOf: await kpiLabelsOf(q, clientId, d.map((x) => x.kpiCode)),
      catalogue: lazyCatalogue(() => loadFocusCatalogue(q, clientId)),
    });
  const focus = await focusOf(db, defs);
  const defsHash = definitionsHash(defs);
  const focusFingerprint = focus.resolution.fingerprint;
  const pager: AggregatePager = async (onPage) => onPage(lines);
  // The one-off runs in the 2 GiB job, not the shared API: no SALES_DAY_BUILD_MAX_ROWS cap here.
  const comp = await computeMonthRows(pager, focus.evalDefs, roster, { collectDays: true, dayRowLimit: Number.POSITIVE_INFINITY });
  const written = comp.rows.filter((r) => Object.keys(r.values).length > 0);
  const existing = await db.outletSalesRecord.findMany({ where: { clientId, month }, select: { outletCode: true, kpiValues: true } });
  const diffs = figureDifferences(existing, written, defs.map((d) => d.kpiCode));
  if (diffs.length > 0) {
    return fail(
      `The current KPI definitions / outlet list / focus products no longer give the stored ${monthLabel(month)} figures for ${diffs.length} value(s), so day data built now would not match them. Recalculate the month (or apply its file again) first; nothing written.`,
      { ...counts, figureMismatches: diffs.length, figureMismatchSamples: diffs.slice(0, REBUILD_SAMPLE) },
    );
  }
  const build: MonthDaysBuild = buildMonthDays(comp.days, focus.evalDefs, roster, written);
  if (!build.ok) return fail(dayDataReason(build, 'REBUILD'), counts);
  const lastDay = summary?.lastDate ? dayOfDate(summary.lastDate) : null;
  const plan = { ...counts, dayRows: build.rows.length, outlets: build.outlets, lastDay };
  if (!a.apply) {
    log.log(JSON.stringify({ msg: 'sales-day rebuild DRY-RUN', clientId, month, ...plan }));
    return { ...base, ok: true, ...plan };
  }

  // 3. Write — one transaction, month lock, the history set re-checked.
  const result = await db.$transaction(
    async (tx) => {
      await lockSalesMonth(tx, clientId, month);
      const now = await tx.salesMonthHistorySet.findUnique({ where: { clientId_month: { clientId, month } } });
      if (!now || now.sourceImportId !== header.sourceImportId || now.appliedAt.getTime() !== header.appliedAt.getTime()) {
        throw new Error(`${monthLabel(month)} was applied or recalculated while the rebuild ran; run it again.`);
      }
      // S6: a recalculate does not change the history set, so re-check what the day values were built WITH — the
      // definitions and the focus products — and that the stored monthly figures still end where they do.
      const { defs: defsNow } = await deps.kpiDefs.enabled(clientId, tx);
      if (definitionsHash(defsNow) !== defsHash) {
        throw new Error(`The KPI definitions changed while the rebuild of ${monthLabel(month)} ran; nothing written — run it again.`);
      }
      if ((await focusOf(tx, defsNow)).resolution.fingerprint !== focusFingerprint) {
        throw new Error(`The focus products of ${monthLabel(month)} changed while the rebuild ran; nothing written — run it again.`);
      }
      const storedNow = await tx.outletSalesRecord.findMany({ where: { clientId, month }, select: { outletCode: true, kpiValues: true } });
      const moved = figureDifferences(storedNow, written, defs.map((d) => d.kpiCode));
      if (moved.length > 0) {
        throw new Error(`${monthLabel(month)}'s monthly figures changed while the rebuild ran (e.g. ${moved[0]}); nothing written — run it again.`);
      }
      for (let i = 0; i < lines.length; i += HISTORY_UPDATE_CHUNK) {
        const chunk = lines.slice(i, i + HISTORY_UPDATE_CHUNK);
        await tx.$executeRaw(Prisma.sql`
          UPDATE "sales_month_histories" h SET "days" = u.days::jsonb
            FROM unnest(${chunk.map((l) => l.id.toString())}::bigint[], ${chunk.map((l) => JSON.stringify(encodeDays(l.days ?? [])))}::text[]) AS u(id, days)
           WHERE h."id" = u.id AND h."clientId" = ${clientId} AND h."month" = ${month}`);
      }
      const dayData = await replaceMonthDays(tx, log, {
        clientId, month, source: 'REBUILD', sourceImportId: header.sourceImportId, build, lastDay, now: new Date(),
      });
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'SALES_MONTH',
          entityId: `${clientId}:${month}`,
          actorId: null,
          newValues: { action: 'rebuild-day-data', sourceImportId: header.sourceImportId, dayData } as unknown as Prisma.InputJsonValue,
          metadata: { clientId, month, action: 'rebuild-day-data', historyLines: lines.length },
        },
      });
      return dayData;
    },
    { timeout: APPLY_TX_TIMEOUT_MS, maxWait: 10_000 },
  );
  return { ...base, applied: true, ok: result.written, ...plan, dayRows: result.rows, outlets: result.outlets, lastDay: result.lastDay, ...(result.reason ? { problem: result.reason } : {}) };
}

