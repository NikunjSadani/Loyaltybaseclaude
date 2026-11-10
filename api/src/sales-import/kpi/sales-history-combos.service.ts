import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SALES_HISTORY_COMBOS_MAX_MONTHS,
  SALES_IMPORT_MAX_DIMENSION_COMBOS,
  SALES_IMPORT_MAX_DIMENSION_VALUES,
  SALES_MONTH_HISTORY_RETENTION_YEARS,
  type SalesDimensionCombo,
  type SalesDimensionValues,
  type SalesHistoryCombos,
} from '../sales-import.contract';
import { paiseToRupees, picoToCases } from '../ingest/normalize';
import { isMonthKey } from '../months/month-state';
import { lockSalesMonth } from '../../common/sales-kpi-ownership';
import { insertMonthCombosSql } from './month-combos';

export interface SalesHistoryCombosQuery {
  month?: string;
  lastMonths?: string;
}

/** Upper bound on the set headers read for the month picker (one row per stored month; history is kept 10 years). */
const MAX_SET_ROWS = (SALES_MONTH_HISTORY_RETENTION_YEARS + 2) * 12;
/** Defensive per-statement bound for the two summary reads (they touch thousands of rows; this caps a pathological case). */
export const HISTORY_COMBOS_STATEMENT_TIMEOUT_MS = 10_000;
/** The read transaction's own bound (a rebuild of stale months, re-check L-a, can add a few statements). */
export const HISTORY_COMBOS_TX_TIMEOUT_MS = 60_000;

interface ComboRow { dims: Prisma.JsonValue; lines: bigint | number; paise: string; pico: string; total: bigint | number }
interface ValueRow { key: string; value: string; lines: bigint | number; paise: string }
interface SummaryHead { month: string; srcMin: string; srcMax: string; atMin: Date; atMax: Date }
/** What the reader needs of a chosen month's set header to check its summary (re-check L-a). */
interface ChosenSet { month: string; sourceImportId: string; appliedAt: Date; lineRows: number }

/** A stored dims JSON object → string values ('' for JSON null), the same reading as the aggregate pager's toAgg. */
function dimsOf(raw: Prisma.JsonValue): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

/**
 * KPI product picker — "Stored month(s)" source (plan §10c). Reads the per-month combos SUMMARY
 * (sales_month_history_combos: one row per distinct product combo per month, written in the apply transaction together
 * with the month history — audit M1), never the line rows, with two aggregate statements run one after the other in one
 * transaction under `SET LOCAL statement_timeout`: distinct combos across the chosen months (GROUP BY the dims JSONB, top
 * SALES_IMPORT_MAX_DIMENSION_COMBOS by |₹|, with the uncapped distinct count) and per-key values (top
 * SALES_IMPORT_MAX_DIMENSION_VALUES by |₹| per key). Months come from the set headers (sales_month_history_sets), one
 * indexed row per stored month.
 */
@Injectable()
export class SalesHistoryCombosService {
  private readonly logger = new Logger(SalesHistoryCombosService.name);

  constructor(private readonly prisma: PrismaService) {}

  async combos(clientId: string, q: SalesHistoryCombosQuery): Promise<SalesHistoryCombos> {
    const hasMonth = q.month !== undefined && q.month !== '';
    const hasLast = q.lastMonths !== undefined && q.lastMonths !== '';
    if (hasMonth && hasLast) throw new BadRequestException('Give either month or lastMonths, not both.');
    if (hasMonth && !isMonthKey(q.month)) throw new BadRequestException('month must be YYYY-MM.');
    let last = 1;
    if (hasLast) {
      last = /^\d+$/.test(q.lastMonths!) ? Number(q.lastMonths) : NaN;
      if (!Number.isInteger(last) || last < 1 || last > SALES_HISTORY_COMBOS_MAX_MONTHS) {
        throw new BadRequestException(`lastMonths must be a whole number from 1 to ${SALES_HISTORY_COMBOS_MAX_MONTHS}.`);
      }
    }

    const sets = await this.prisma.salesMonthHistorySet.findMany({
      where: { clientId },
      select: { month: true, dimensionKeys: true, sourceImportId: true, appliedAt: true, lineRows: true },
      orderBy: { month: 'desc' },
      take: MAX_SET_ROWS,
    });
    const availableMonths = sets.map((s) => s.month);
    let chosen: typeof sets;
    if (hasMonth) {
      chosen = sets.filter((s) => s.month === q.month);
      if (chosen.length === 0) throw new NotFoundException('No stored sales lines for that month.');
    } else {
      chosen = sets.slice(0, last);
    }
    const months = chosen.map((s) => s.month).sort();
    const keySets = chosen.map((s) => [...new Set(s.dimensionKeys)].sort().join('\u001f'));
    const dimensionKeys = [...new Set(chosen.flatMap((s) => s.dimensionKeys))].sort();
    const empty: SalesHistoryCombos = {
      months, availableMonths, dimensionKeys, dimensionKeysDiffer: new Set(keySets).size > 1,
      dimensionValues: {}, dimensionCombos: [], totalCombos: 0,
    };
    if (months.length === 0) return empty;

    const { comboRows, valueRows } = await this.readSummary(clientId, chosen);

    const dimensionCombos: SalesDimensionCombo[] = comboRows.map((r) => ({
      dims: dimsOf(r.dims),
      lines: Number(r.lines),
      amountRupees: paiseToRupees(BigInt(r.paise)),
      quantity: picoToCases(BigInt(r.pico)),
    }));
    const dimensionValues: SalesDimensionValues = {};
    for (const v of valueRows) {
      (dimensionValues[v.key] ??= []).push({ value: v.value, lines: Number(v.lines), amountRupees: paiseToRupees(BigInt(v.paise)) });
    }
    return { ...empty, dimensionValues, dimensionCombos, totalCombos: Number(comboRows[0]?.total ?? 0) };
  }

  private async readSummary(clientId: string, chosen: ChosenSet[]): Promise<{ comboRows: ComboRow[]; valueRows: ValueRow[] }> {
    const months = chosen.map((s) => s.month).sort();
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Constant, not user input (SET takes no bind parameters).
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${HISTORY_COMBOS_STATEMENT_TIMEOUT_MS}`);
          await this.rebuildStaleMonths(tx, clientId, chosen);
          const comboRows = await tx.$queryRaw<ComboRow[]>(Prisma.sql`
            SELECT c."dims" AS "dims",
                   SUM(c."lines")::bigint AS "lines",
                   SUM(c."amountPaise")::text AS "paise",
                   SUM(c."qtyPico")::text AS "pico",
                   count(*) OVER () AS "total"
              FROM "sales_month_history_combos" c
             WHERE c."clientId" = ${clientId} AND c."month" = ANY(${months}::text[])
             GROUP BY c."dims"
             ORDER BY abs(SUM(c."amountPaise")) DESC, SUM(c."lines") DESC, c."dims"::text COLLATE "C" ASC
             LIMIT ${SALES_IMPORT_MAX_DIMENSION_COMBOS}`);
          const valueRows = await tx.$queryRaw<ValueRow[]>(Prisma.sql`
            SELECT t."key", t."value", t."lines", t."paise"
              FROM (
                SELECT kv."key" AS "key",
                       COALESCE(kv."value", '') AS "value",
                       SUM(c."lines")::bigint AS "lines",
                       SUM(c."amountPaise")::text AS "paise",
                       row_number() OVER (
                         PARTITION BY kv."key"
                         ORDER BY abs(SUM(c."amountPaise")) DESC, SUM(c."lines") DESC, COALESCE(kv."value", '') COLLATE "C" ASC
                       ) AS "rn"
                  FROM "sales_month_history_combos" c
                 CROSS JOIN LATERAL jsonb_each_text(c."dims") AS kv("key", "value")
                 WHERE c."clientId" = ${clientId} AND c."month" = ANY(${months}::text[])
                 GROUP BY kv."key", COALESCE(kv."value", '')
              ) t
             WHERE t."rn" <= ${SALES_IMPORT_MAX_DIMENSION_VALUES}
             ORDER BY t."key" ASC, t."rn" ASC`);
          return { comboRows, valueRows };
        },
        { timeout: HISTORY_COMBOS_TX_TIMEOUT_MS, maxWait: 5_000 },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A statement timeout, or no transaction could be started (P2028: pool busy / tx timeout) → the friendly 503.
      if (/statement timeout|canceling statement|57014/i.test(msg) || (e as { code?: unknown })?.code === 'P2028') {
        throw new ServiceUnavailableException('Listing the stored months took too long. Choose fewer months and try again.');
      }
      throw e;
    }
  }

  /**
   * Re-check L-a: each summary row records the history set it summarises. A chosen month whose summary is missing (while
   * the set has lines) or belongs to another set — e.g. an apply by an older revision during a deploy wrote the history
   * but not the summary — is rebuilt here, under the month lock and the same statement_timeout, from the set header as
   * it is NOW (re-read after the lock), before the reads below.
   */
  private async rebuildStaleMonths(tx: Prisma.TransactionClient, clientId: string, chosen: ChosenSet[]): Promise<void> {
    const months = chosen.map((s) => s.month);
    const heads = await tx.$queryRaw<SummaryHead[]>(Prisma.sql`
      SELECT c."month" AS "month",
             MIN(c."sourceImportId") AS "srcMin", MAX(c."sourceImportId") AS "srcMax",
             MIN(c."appliedAt") AS "atMin", MAX(c."appliedAt") AS "atMax"
        FROM "sales_month_history_combos" c
       WHERE c."clientId" = ${clientId} AND c."month" = ANY(${months}::text[])
       GROUP BY c."month"`);
    const byMonth = new Map(heads.map((h) => [h.month, h]));
    const stale = chosen
      .filter((s) => {
        const h = byMonth.get(s.month);
        if (!h) return s.lineRows > 0;
        const at = s.appliedAt.getTime();
        return h.srcMin !== s.sourceImportId || h.srcMax !== s.sourceImportId
          || new Date(h.atMin).getTime() !== at || new Date(h.atMax).getTime() !== at;
      })
      .map((s) => s.month)
      .sort(); // one lock order for every reader
    for (const month of stale) {
      await lockSalesMonth(tx, clientId, month);
      const header = await tx.salesMonthHistorySet.findUnique({
        where: { clientId_month: { clientId, month } },
        select: { sourceImportId: true, appliedAt: true },
      });
      await tx.$executeRaw(Prisma.sql`DELETE FROM "sales_month_history_combos" WHERE "clientId" = ${clientId} AND "month" = ${month}`);
      const rows = header ? await tx.$executeRaw(insertMonthCombosSql(clientId, month, header.sourceImportId, header.appliedAt)) : 0;
      this.logger.warn(JSON.stringify({ msg: 'sales-import combos summary rebuilt (missing or from another history set)', clientId, month, rows: Number(rows) }));
    }
  }
}
