import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
import { classifyMonthSummaries } from './month-combos';

export interface SalesHistoryCombosQuery {
  month?: string;
  lastMonths?: string;
}

/** Upper bound on the set headers read for the month picker (one row per stored month; history is kept 10 years). */
const MAX_SET_ROWS = (SALES_MONTH_HISTORY_RETENTION_YEARS + 2) * 12;
/** Per-statement bound for the read (summary rows: thousands per month; the missing-summary fallback reads lines). */
export const HISTORY_COMBOS_STATEMENT_TIMEOUT_MS = 10_000;
/** The read transaction's own bound (a handful of statements, each ≤ the statement timeout). */
export const HISTORY_COMBOS_TX_TIMEOUT_MS = 45_000;
/**
 * A month with NO summary is read from its stored lines only up to this many line rows (re-check M2): a large month
 * would not fit the statement timeout, so it is listed in `refreshingMonths` with no combos until the background
 * refresh has built its summary.
 */
export const HISTORY_COMBOS_LINE_FALLBACK_MAX_ROWS = 50_000;
/** 503 copy (re-check M2: accurate for both causes). */
export const HISTORY_COMBOS_TIMEOUT_MESSAGE =
  'Reading the stored months took too long. Try fewer months, or try again in a few minutes.';
export const HISTORY_COMBOS_BUSY_MESSAGE = 'The server is busy right now. Try again in a moment.';

interface ComboRow { dims: Prisma.JsonValue; lines: bigint | number; paise: string; pico: string; total: bigint | number }
interface ValueRow { key: string; value: string; lines: bigint | number; paise: string }

/** A stored dims JSON object → string values ('' for JSON null), the same reading as the aggregate pager's toAgg. */
function dimsOf(raw: Prisma.JsonValue): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

/**
 * The rows the two aggregates read (one statement each): the per-month SUMMARY rows of `summaryMonths`
 * (sales_month_history_combos) plus — only for months whose summary is MISSING — the stored lines themselves
 * (sales_month_histories, read-only fallback until the background refresh writes the summary).
 */
function sourceRows(clientId: string, summaryMonths: string[], lineMonths: string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT c."dims" AS "dims", c."lines"::bigint AS "lines", c."amountPaise" AS "paise", c."qtyPico" AS "pico"
      FROM "sales_month_history_combos" c
     WHERE c."clientId" = ${clientId} AND c."month" = ANY(${summaryMonths}::text[])
    UNION ALL
    SELECT h."dims", h."lines"::bigint, h."amountPaise"::numeric, h."qtyPico"::numeric
      FROM "sales_month_histories" h
     WHERE h."clientId" = ${clientId} AND h."month" = ANY(${lineMonths}::text[])`;
}

/**
 * KPI product picker — "Stored month(s)" source (plan §10c). STRICTLY READ-ONLY (re-check M1/M2): one
 * `READ ONLY` transaction under `SET LOCAL statement_timeout`, no month lock, no writes. Inside it: the set headers
 * (sales_month_history_sets), a per-month head of the combos SUMMARY (sales_month_history_combos), then two aggregate
 * statements one after the other — distinct combos across the chosen months (GROUP BY dims, top
 * SALES_IMPORT_MAX_DIMENSION_COMBOS by |₹| + the uncapped count) and per-key values (top SALES_IMPORT_MAX_DIMENSION_VALUES
 * by |₹|). The summary state comes from the set header's stamp. A month whose summary is from another history set (e.g.
 * written by an older revision during a deploy) is answered from that summary; a month with NO summary is answered from
 * its stored lines when it has ≤ HISTORY_COMBOS_LINE_FALLBACK_MAX_ROWS of them (else not at all); all are reported in
 * `refreshingMonths`, and the background refresh (month-combos.ts refreshStaleMonthCombos) rebuilds them.
 */
@Injectable()
export class SalesHistoryCombosService {
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

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
          // Constant, not user input (SET takes no bind parameters).
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${HISTORY_COMBOS_STATEMENT_TIMEOUT_MS}`);
          const sets = await tx.salesMonthHistorySet.findMany({
            where: { clientId },
            select: {
              month: true, dimensionKeys: true, sourceImportId: true, appliedAt: true, lineRows: true,
              combosSourceImportId: true, combosAppliedAt: true,
            },
            orderBy: { month: 'desc' },
            take: MAX_SET_ROWS,
          });
          const availableMonths = sets.map((s) => s.month);
          const chosen = hasMonth ? sets.filter((s) => s.month === q.month) : sets.slice(0, last);
          if (hasMonth && chosen.length === 0) throw new NotFoundException('No stored sales lines for that month.');
          const months = chosen.map((s) => s.month).sort();
          const keySets = chosen.map((s) => [...new Set(s.dimensionKeys)].sort().join('\u001f'));
          const empty: SalesHistoryCombos = {
            months,
            availableMonths,
            dimensionKeys: [...new Set(chosen.flatMap((s) => s.dimensionKeys))].sort(),
            dimensionKeysDiffer: new Set(keySets).size > 1,
            dimensionValues: {},
            dimensionCombos: [],
            totalCombos: 0,
            refreshingMonths: [],
          };
          if (months.length === 0) return empty;

          // Summary state from the header stamp alone (re-check L1: no scan of the summary rows).
          const state = classifyMonthSummaries(chosen);
          const lineRowsOf = new Map(chosen.map((s) => [s.month, s.lineRows]));
          const summaryMonths = months.filter((m) => state.get(m) === 'current' || state.get(m) === 'stale');
          // Missing summary: small months are read from their lines; large ones wait for the refresh (re-check M2).
          const lineMonths = months.filter((m) => state.get(m) === 'missing' && (lineRowsOf.get(m) ?? 0) <= HISTORY_COMBOS_LINE_FALLBACK_MAX_ROWS);
          const refreshingMonths = months.filter((m) => state.get(m) === 'stale' || state.get(m) === 'missing');
          if (summaryMonths.length === 0 && lineMonths.length === 0) return { ...empty, refreshingMonths };

          const comboRows = await tx.$queryRaw<ComboRow[]>(Prisma.sql`
            WITH src AS (${sourceRows(clientId, summaryMonths, lineMonths)})
            SELECT s."dims" AS "dims",
                   SUM(s."lines")::bigint AS "lines",
                   SUM(s."paise")::text AS "paise",
                   SUM(s."pico")::text AS "pico",
                   count(*) OVER () AS "total"
              FROM src s
             GROUP BY s."dims"
             ORDER BY abs(SUM(s."paise")) DESC, SUM(s."lines") DESC, s."dims"::text COLLATE "C" ASC
             LIMIT ${SALES_IMPORT_MAX_DIMENSION_COMBOS}`);
          const valueRows = await tx.$queryRaw<ValueRow[]>(Prisma.sql`
            WITH src AS (${sourceRows(clientId, summaryMonths, lineMonths)})
            SELECT t."key", t."value", t."lines", t."paise"
              FROM (
                SELECT kv."key" AS "key",
                       COALESCE(kv."value", '') AS "value",
                       SUM(s."lines")::bigint AS "lines",
                       SUM(s."paise")::text AS "paise",
                       row_number() OVER (
                         PARTITION BY kv."key"
                         ORDER BY abs(SUM(s."paise")) DESC, SUM(s."lines") DESC, COALESCE(kv."value", '') COLLATE "C" ASC
                       ) AS "rn"
                  FROM src s
                 CROSS JOIN LATERAL jsonb_each_text(s."dims") AS kv("key", "value")
                 GROUP BY kv."key", COALESCE(kv."value", '')
              ) t
             WHERE t."rn" <= ${SALES_IMPORT_MAX_DIMENSION_VALUES}
             ORDER BY t."key" ASC, t."rn" ASC`);

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
          return { ...empty, dimensionValues, dimensionCombos, totalCombos: Number(comboRows[0]?.total ?? 0), refreshingMonths };
        },
        { timeout: HISTORY_COMBOS_TX_TIMEOUT_MS, maxWait: 5_000 },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A statement timeout, or no transaction could be started (P2028: pool busy / tx timeout) → the friendly 503.
      if ((e as { code?: unknown })?.code === 'P2028') throw new ServiceUnavailableException(HISTORY_COMBOS_BUSY_MESSAGE);
      if (/statement timeout|canceling statement|57014/i.test(msg)) throw new ServiceUnavailableException(HISTORY_COMBOS_TIMEOUT_MESSAGE);
      throw e;
    }
  }
}
