/**
 * Sales Import normalizers (plan §6.1). OWNER: Lane I (implements + table-driven spec, I-1).
 *
 * Lane-0 ships the SIGNATURES so Lane K (KPI-definition validation, K-2) compiles against them in
 * parallel. normalizeHeader / normalizeDim / normalizeOutletCode are fully specified in §6.1 and are
 * implemented here already (Lane K depends on normalizeDim); Lane I owns their spec and may refine them.
 * The parsers below are stubs until Lane I lands them.
 */

export type DateOrder = 'DMY' | 'MDY' | 'YMD';

/** trim, collapse whitespace, uppercase, strip a leading BOM. */
export function normalizeHeader(s: unknown): string {
  return String(s ?? '').replace(/^\uFEFF/, '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/** number → canonical decimal string (500, 500.0 → "500"); string → trim, collapse spaces, uppercase; empty → "". */
export function normalizeDim(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return String(v).trim().replace(/\s+/g, ' ').toUpperCase();
}

/** number → integer string without ".0"; string → trim (leading zeros preserved, risk R-6). */
export function normalizeOutletCode(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.trunc(v)) : '';
  return String(v).trim();
}

/** Amount → signed paise (BigInt). null = invalid (row skipped with a reason). Lane I. */
export function toPaise(_v: unknown): bigint | null {
  throw new Error('toPaise: not implemented (Lane I, task I-1)');
}

/** Quantity → signed micro-units (×1e6, BigInt). null = invalid. Lane I. */
export function toMicro(_v: unknown): bigint | null {
  throw new Error('toMicro: not implemented (Lane I, task I-1)');
}

/** Invoice date → 'YYYY-MM-DD' (calendar date, no TZ shift) or null when invalid/out of window. Lane I. */
export function parseInvoiceDate(_v: unknown, _order: DateOrder, _todayIso?: string): string | null {
  throw new Error('parseInvoiceDate: not implemented (Lane I, task I-1)');
}
