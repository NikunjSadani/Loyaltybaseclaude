/**
 * The day split of one aggregate / history row (sales-day-level, owner decision 2026-11-18).
 *
 * Stored in `sales_import_aggregates.days` and copied to `sales_month_histories.days` as compact JSON:
 *   [[day, "amountPaise", "qtyPico", lines], …]   sorted by day, BigInts as decimal strings (pico-cases exceed 2^53).
 * The day is the IST calendar day of the invoice date (normalize.parseInvoiceDateDetailed already yields the IST date).
 * The parts sum EXACTLY to the row's amountPaise / qtyPico / lines — `slicesMatchTotals` checks it before any use, so a
 * damaged split can never produce day values that disagree with the monthly value.
 */
import type { Prisma } from '@prisma/client';

export interface DaySlice {
  day: number;
  amountPaise: bigint;
  qtyPico: bigint;
  lines: number;
}

export type DaysJson = Array<[number, string, string, number]>;

export function encodeDays(slices: readonly DaySlice[]): DaysJson {
  return [...slices]
    .sort((a, b) => a.day - b.day)
    .map((s) => [s.day, s.amountPaise.toString(), s.qtyPico.toString(), s.lines]);
}

const INT_RE = /^-?\d+$/;

/** Stored JSON → slices; null when absent (written before day-level storage) or malformed in any way. */
export function decodeDays(raw: Prisma.JsonValue | null | undefined): DaySlice[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: DaySlice[] = [];
  for (const e of raw) {
    if (!Array.isArray(e) || e.length !== 4) return null;
    const [day, paise, pico, lines] = e as unknown[];
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 31) return null;
    if (typeof paise !== 'string' || !INT_RE.test(paise) || typeof pico !== 'string' || !INT_RE.test(pico)) return null;
    if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 0) return null;
    out.push({ day, amountPaise: BigInt(paise), qtyPico: BigInt(pico), lines });
  }
  return out;
}

/** Do the slices add up exactly to the row (and name each day at most once)? */
export function slicesMatchTotals(
  slices: readonly DaySlice[],
  totals: { amountPaise: bigint; qtyPico: bigint; lines: number },
): boolean {
  let p = 0n;
  let q = 0n;
  let l = 0;
  const seen = new Set<number>();
  for (const s of slices) {
    if (seen.has(s.day)) return false;
    seen.add(s.day);
    p += s.amountPaise;
    q += s.qtyPico;
    l += s.lines;
  }
  return p === totals.amountPaise && q === totals.qtyPico && l === totals.lines;
}

/** 'YYYY-MM-DD' (IST calendar date) → day of month. */
export function dayOfDate(date: string): number {
  return Number(date.slice(8, 10));
}
