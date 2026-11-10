import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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

export interface SalesHistoryCombosQuery {
  month?: string;
  lastMonths?: string;
}

/** Upper bound on the set headers read for the month picker (one row per stored month; history is kept 10 years). */
const MAX_SET_ROWS = (SALES_MONTH_HISTORY_RETENTION_YEARS + 2) * 12;

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
 * KPI product picker — "Stored month(s)" source (plan §10c). Reads SalesMonthHistory (the final applied lines of each
 * month) for ONE tenant with two aggregate statements: distinct product combos (GROUP BY the dims JSONB, top
 * SALES_IMPORT_MAX_DIMENSION_COMBOS by |₹|, with the uncapped distinct count) and per-key values (top
 * SALES_IMPORT_MAX_DIMENSION_VALUES by |₹| per key). The line rows never reach Node (Prisma `distinct` is applied in
 * Node after fetching every row — final check H1 — so it is not used). Months come from the set headers
 * (sales_month_history_sets), one indexed row per stored month.
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

    const sets = await this.prisma.salesMonthHistorySet.findMany({
      where: { clientId },
      select: { month: true, dimensionKeys: true },
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

    const [comboRows, valueRows] = await Promise.all([
      this.prisma.$queryRaw<ComboRow[]>(Prisma.sql`
        SELECT h."dims" AS "dims",
               SUM(h."lines")::bigint AS "lines",
               SUM(h."amountPaise")::text AS "paise",
               SUM(h."qtyPico")::text AS "pico",
               count(*) OVER () AS "total"
          FROM "sales_month_histories" h
         WHERE h."clientId" = ${clientId} AND h."month" = ANY(${months}::text[])
         GROUP BY h."dims"
         ORDER BY abs(SUM(h."amountPaise")) DESC, SUM(h."lines") DESC, h."dims"::text COLLATE "C" ASC
         LIMIT ${SALES_IMPORT_MAX_DIMENSION_COMBOS}`),
      this.prisma.$queryRaw<ValueRow[]>(Prisma.sql`
        SELECT t."key", t."value", t."lines", t."paise"
          FROM (
            SELECT kv."key" AS "key",
                   COALESCE(kv."value", '') AS "value",
                   SUM(h."lines")::bigint AS "lines",
                   SUM(h."amountPaise")::text AS "paise",
                   row_number() OVER (
                     PARTITION BY kv."key"
                     ORDER BY abs(SUM(h."amountPaise")) DESC, SUM(h."lines") DESC, COALESCE(kv."value", '') COLLATE "C" ASC
                   ) AS "rn"
              FROM "sales_month_histories" h
             CROSS JOIN LATERAL jsonb_each_text(h."dims") AS kv("key", "value")
             WHERE h."clientId" = ${clientId} AND h."month" = ANY(${months}::text[])
             GROUP BY kv."key", COALESCE(kv."value", '')
          ) t
         WHERE t."rn" <= ${SALES_IMPORT_MAX_DIMENSION_VALUES}
         ORDER BY t."key" ASC, t."rn" ASC`),
    ]);

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
}
