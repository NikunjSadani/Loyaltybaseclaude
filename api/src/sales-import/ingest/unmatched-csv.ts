/**
 * unmatched.csv (plan §5.2): one line per (customer code, month) found in the file but not on the
 * programme roster. Streamed (≈200k lines for the real file), CSV-escaped and formula-injection-safe.
 */
import type { UnmatchedRow } from './aggregator';
import { QTY_SCALE, divRoundHalfAway } from './normalize';

export const UNMATCHED_CSV_HEADER = ['Customer code', 'Customer name', 'Month', 'Lines', 'Amount (Rs)', 'Quantity'];

/** Exact decimal text of a scaled BigInt (paise → "12.34", thousandths → "0.04"). */
export function scaledToText(v: bigint, scale: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = abs.toString().padStart(scale + 1, '0');
  const int = s.slice(0, s.length - scale);
  const frac = s.slice(s.length - scale).replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** Quote when needed; neutralise a leading formula trigger in TEXT cells (=, +, -, @, tab, CR). */
export function csvText(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function* unmatchedCsvLines(rows: Iterable<UnmatchedRow>): Generator<string> {
  yield `${UNMATCHED_CSV_HEADER.join(',')}\r\n`;
  for (const r of rows) {
    yield `${[csvText(r.code), csvText(r.name), r.month, String(r.lines), scaledToText(r.amountPaise, 2), scaledToText(divRoundHalfAway(r.qtyPico, QTY_SCALE / 1000n), 3)].join(',')}\r\n`;
  }
}
