/**
 * The per-month KPI computation shared by PREVIEW and APPLY, so the numbers the admin previews are exactly the
 * numbers apply writes (same function, same aggregates, same definitions).
 */
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { OutletKpiAccumulator, measureToNumber, outletInScope, type KpiDefLite } from '../kpi/sales-kpi.helper';
import { forEachAggregatePage, type RosterOutlet } from '../kpi/sales-import-data';

export interface MonthOutletRow {
  outletCode: string;
  outletName: string;
  /** kpiCode → value for every IN-SCOPE owned KPI (out-of-scope keys omitted; no lines → 0). */
  values: Record<string, number>;
  /** The outlet had no aggregate line at all this month (every value is a zero-fill). */
  zeroFilled: boolean;
}

export interface MonthKpiStat {
  kpiCode: string;
  totalRaw: bigint; // paise / micro
  total: number;
  outletsNonZero: number;
  outletsNegative: number;
}

export interface MonthComputation {
  rows: MonthOutletRow[];
  stats: MonthKpiStat[];
  zeroFillOutlets: number;
}

export async function computeMonthRows(
  db: PrismaService | Prisma.TransactionClient,
  importId: string,
  month: string,
  defs: readonly KpiDefLite[],
  roster: Map<string, RosterOutlet>,
): Promise<MonthComputation> {
  const acc = new OutletKpiAccumulator(defs);
  await forEachAggregatePage(db, importId, month, (page) => {
    for (const a of page) {
      if (!roster.has(a.outletCode)) continue; // dropped from the roster since processing → never written
      acc.add(a.outletCode, a, a.dimKey);
    }
  });

  const stats: MonthKpiStat[] = defs.map((d) => ({ kpiCode: d.kpiCode, totalRaw: 0n, total: 0, outletsNonZero: 0, outletsNegative: 0 }));
  const rows: MonthOutletRow[] = [];
  let zeroFillOutlets = 0;
  for (const [code, meta] of [...roster.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (!defs.some((d) => outletInScope(d, meta))) continue; // in no owned KPI's scope → untouched
    const values: Record<string, number> = {};
    defs.forEach((d, i) => {
      if (!outletInScope(d, meta)) return;
      const raw = acc.rawSum(code, i);
      values[d.kpiCode] = measureToNumber(raw, d.measure);
      stats[i].totalRaw += raw;
      if (raw !== 0n) stats[i].outletsNonZero++;
      if (raw < 0n) stats[i].outletsNegative++;
    });
    const zeroFilled = !acc.hasLines(code);
    if (zeroFilled) zeroFillOutlets++;
    rows.push({ outletCode: code, outletName: meta.name, values, zeroFilled });
  }
  defs.forEach((d, i) => (stats[i].total = measureToNumber(stats[i].totalRaw, d.measure)));
  return { rows, stats, zeroFillOutlets };
}

/** Σ of the owned keys across the month's CURRENT OutletSalesRecord rows (numeric values only). */
export function sumOwnedValues(
  rows: Array<{ kpiValues: Prisma.JsonValue }>,
  owned: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(owned.map((k) => [k, 0]));
  for (const r of rows) {
    const v = r.kpiValues;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    for (const k of owned) {
      const n = (v as Record<string, unknown>)[k];
      const num = typeof n === 'number' ? n : typeof n === 'string' && n.trim() !== '' ? Number(n) : NaN;
      if (Number.isFinite(num)) out[k] += num;
    }
  }
  for (const k of owned) out[k] = Math.round(out[k] * 1e6) / 1e6;
  return out;
}
