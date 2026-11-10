/**
 * Sales Import normalizers and cell parsers (plan §6.1). OWNER: Lane I (task I-1).
 *
 * Pure functions, no I/O. Lane K imports normalizeDim (KPI-filter values are normalized the same way
 * the worker normalizes dimension cells, so "ADHO" / "adho " / "Adho" and 500 / "500" / "500.0" match).
 *
 * Money and quantity are converted ONCE into BigInt fixed-point (paise = ×100, micro = ×1e6) by
 * parsing the DECIMAL text of the value (never `v * 100` on a float, which turns -12.345 into
 * -1234.4999…), rounding half away from zero. Sums stay BigInt until the wire (contract: rupees/cases).
 */
import { istDateKey } from '../../common/ist-date';

export type DateOrder = 'DMY' | 'MDY' | 'YMD';

/** trim, collapse whitespace, uppercase, strip a leading BOM. */
export function normalizeHeader(s: unknown): string {
  return String(s ?? '').replace(/^﻿/, '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/** A plain decimal string "500.0" / "500.50" → "500" / "500.5" (leading zeros are kept: they are data). */
function trimDecimalZeros(s: string): string {
  if (!/^-?\d+\.\d+$/.test(s)) return s;
  return s.replace(/\.?0+$/, '');
}

/**
 * number → canonical decimal string (500, 500.0 → "500"); string → trim, collapse spaces, uppercase,
 * and a pure decimal string loses trailing fractional zeros ("500.0" → "500", so an xlsx number cell and
 * a CSV text cell of the same SKU size match); empty → "".
 */
export function normalizeDim(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return trimDecimalZeros(String(v).trim().replace(/\s+/g, ' ').toUpperCase());
}

/**
 * number → integer string without ".0"; string → trim, and a pure-number string "327852.0" → "327852"
 * (a CSV saved from a float column). Leading zeros are preserved (risk R-6).
 */
export function normalizeOutletCode(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.trunc(v)) : '';
  const s = String(v).trim();
  return /^\d+\.0+$/.test(s) ? s.replace(/\.0+$/, '') : s;
}

/** Stable JSON of a dims object (keys sorted) — the aggregate `dimKey`. */
export function stableDimKey(dims: Record<string, string>): string {
  const out: Record<string, string> = {};
  for (const k of Object.keys(dims).sort()) out[k] = dims[k];
  return JSON.stringify(out);
}

// ─── Decimal → scaled BigInt ─────────────────────────────────────────────────────

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Parse a decimal string (optionally in exponent form) and scale it by 10^scale, rounding half away
 * from zero. null when it is not a number.
 */
function scaleDecimal(text: string, scale: number): bigint | null {
  const m = DECIMAL_RE.exec(text);
  if (!m) return null;
  const [, sign, intPart = '', fracPart = '', expPart] = m;
  if (intPart === '' && fracPart === '') return null;
  const exp = expPart ? Number(expPart) : 0;
  if (!Number.isFinite(exp) || Math.abs(exp) > 400) return null;
  // All digits as one integer with the decimal point `pointPos` digits from the left.
  const digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '') || '0';
  // value = digits × 10^(exp - fracPart.length); we want value × 10^scale.
  const shift = exp - fracPart.length + scale;
  let result: bigint;
  if (shift >= 0) {
    result = BigInt(digits) * 10n ** BigInt(shift);
  } else {
    const cut = -shift;
    const padded = digits.padStart(cut + 1, '0');
    const keep = padded.slice(0, padded.length - cut);
    const dropped = padded.slice(padded.length - cut);
    result = BigInt(keep);
    if (dropped.charCodeAt(0) >= 53 /* '5' */) result += 1n; // half away from zero (on |value|)
  }
  return sign === '-' ? -result : result;
}

/**
 * Decimal separator of TEXT cells. '.' = "1,234.56" / "12,34,567.89" (',' only as valid thousands grouping);
 * ',' = "1.234,56" ('.' only as valid thousands grouping). Numeric cells (xlsx numbers) never use it.
 * A value whose separators CONTRADICT the mode ("1,5" in '.' mode, "1,234.56" or "0.500" in ',' mode) is INVALID —
 * skipped and counted, never re-interpreted.
 */
export type DecimalSeparator = '.' | ',';

/**
 * The separator a run STARTS with. An explicit profile value is final. 'auto' starts with ',' for a ';'-delimited CSV,
 * else '.', and is then decided once per file from evidence (classifyDecimal) — see SalesImportProcessorService.
 */
export function resolveDecimalSeparator(setting: 'auto' | '.' | ',' | null | undefined, csvDelimiter: string | null): DecimalSeparator {
  if (setting === '.' || setting === ',') return setting;
  return csvDelimiter === ';' ? ',' : '.';
}

/** Thousands grouping that is valid in '.' mode: Western "1,234,567" or Indian "12,34,567" (no leading zero). */
const DOT_MODE_GROUPED = /^(?:[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d?(?:,\d{2})*,\d{3})(?:\.\d*)?$/;
/** Thousands grouping that is valid in ',' mode: "1.234.567" (no leading zero), optional ",decimals". */
const COMMA_MODE_GROUPED = /^[1-9]\d{0,2}(?:\.\d{3})+(?:,\d*)?$/;

/** Split off the sign forms we accept: leading +/-, accounting "(40.00)", ERP trailing minus "40.00-". */
function signAndCore(s: string): { neg: boolean; core: string } {
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) return { neg: true, core: paren[1] };
  if (/^[^-].*-$/.test(s)) return { neg: true, core: s.slice(0, -1) };
  if (s.startsWith('-')) return { neg: true, core: s.slice(1) };
  if (s.startsWith('+')) return { neg: false, core: s.slice(1) };
  return { neg: false, core: s };
}

function stripText(v: string): string {
  return v.replace(/[\s ₹]/g, '');
}

/**
 * Evidence a TEXT measure value gives about the file's decimal separator (used only in 'auto'):
 *  - 'dot' / 'comma': only one reading is possible ("1,234.56", "0.500", "1.5", "1,234,567" → dot; "1.234,56", "1,5",
 *    "0,500", "1.234.567" → comma);
 *  - 'ambiguous': one separator followed by exactly three digits with a non-zero integer part ("2.000", "1,234") —
 *    2 or 2000?;
 *  - 'none': no separator (or not a number at all).
 */
export type DecimalEvidence = 'dot' | 'comma' | 'ambiguous' | 'none';
export function classifyDecimal(v: unknown): DecimalEvidence {
  if (typeof v !== 'string') return 'none';
  const { core } = signAndCore(stripText(v));
  if (!/^[\d.,]+$/.test(core) || !/\d/.test(core)) return 'none';
  const dots = core.split('.').length - 1;
  const commas = core.split(',').length - 1;
  if (dots === 0 && commas === 0) return 'none';
  if (dots > 0 && commas > 0) return core.lastIndexOf('.') > core.lastIndexOf(',') ? 'dot' : 'comma';
  const sep = dots > 0 ? '.' : ',';
  const count = dots > 0 ? dots : commas;
  if (count > 1) return sep === '.' ? 'comma' : 'dot'; // repeated → can only be thousands grouping
  const [intPart, frac] = core.split(sep);
  if (frac.length !== 3 || intPart === '' || intPart.startsWith('0')) return sep === '.' ? 'dot' : 'comma';
  return 'ambiguous';
}

/** A cell value → the decimal text to parse ('invalid' = present but unparsable in this mode), or null for blank. */
function numericText(v: unknown, decimal: DecimalSeparator = '.'): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v !== 'string') return null;
  const s = stripText(v);
  if (s === '') return null;
  const { neg, core: raw } = signAndCore(s);
  let core = raw;
  if (decimal === ',') {
    if (core.includes('.')) {
      if (!COMMA_MODE_GROUPED.test(core)) return 'invalid'; // a '.' that is not thousands grouping contradicts ','
      core = core.replace(/\./g, '');
    }
    if (core.split(',').length > 2) return 'invalid';
    core = core.replace(',', '.');
  } else if (core.includes(',')) {
    if (!DOT_MODE_GROUPED.test(core)) return 'invalid'; // a ',' that is not thousands grouping contradicts '.'
    core = core.replace(/,/g, '');
  }
  return neg ? `-${core}` : core;
}

function toScaled(v: unknown, scale: number, decimal: DecimalSeparator): bigint | null {
  const t = numericText(v, decimal);
  return t === null ? null : scaleDecimal(t, scale);
}

/** Amount → signed paise (BigInt). null = blank/invalid (row skipped with a reason). */
export function toPaise(v: unknown, decimal: DecimalSeparator = '.'): bigint | null {
  return toScaled(v, 2, decimal);
}

/**
 * Quantity scale: 1e-12 cases (H3). Per-line rounding ≤ 5e-13, so even a million lines drift < 1e-6 — far below
 * the final 3-dp rounding. 1/12 case as an Excel float (0.08333333333333333) keeps 12 decimals; 12 of them sum to
 * 0.999999999996 → 1.000. Fits BIGINT up to ±9.2 million cases per aggregate row (checked by the aggregator).
 */
export const QTY_SCALE_DIGITS = 12;
export const QTY_SCALE = 10n ** BigInt(QTY_SCALE_DIGITS);

/** Quantity → signed pico-cases (×1e12, BigInt). null = blank/invalid. */
export function toPico(v: unknown, decimal: DecimalSeparator = '.'): bigint | null {
  return toScaled(v, QTY_SCALE_DIGITS, decimal);
}

/** BigInt integer division rounding half away from zero. */
export function divRoundHalfAway(n: bigint, d: bigint): bigint {
  const neg = n < 0n;
  const q = ((neg ? -n : n) + d / 2n) / d;
  return neg ? -q : q;
}

/**
 * The ONLY BigInt → wire-number conversions (inverse of toPaise / toPico), used by the worker's frozen summaries and
 * the KPI evaluator alike, so ₹ and cases are rounded identically everywhere — ONCE, at the end of a sum:
 * paise are exact at 2 dp; cases are rounded exactly (BigInt, half away from zero) to SALES_KPI_QUANTITY_DECIMALS (3).
 */
export function paiseToRupees(paise: bigint): number {
  return Number(paise) / 100;
}
export function picoToCases(pico: bigint): number {
  return Number(divRoundHalfAway(pico, QTY_SCALE / 1000n)) / 1000;
}

// ─── Dates ───────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, JUNE: 6, JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10,
  NOVEMBER: 11, DECEMBER: 12,
};

const DAY_MS = 86_400_000;
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30); // serial 1 = 1900-01-01 for serials ≥ 61 (1900 leap bug)

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function ymd(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate(); // days in month m
  if (d > dim) return null;
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

function utcYmd(d: Date): string | null {
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function year4(tok: string): number {
  const n = Number(tok);
  return tok.length <= 2 ? 2000 + n : n;
}

/** The date part of a text value → 'YYYY-MM-DD' or null. */
function parseDateText(raw: string, order: DateOrder): string | null {
  let s = raw.trim();
  if (s === '') return null;

  // A time part with an explicit zone (Z / ±hh:mm) is an INSTANT → its IST calendar day.
  if (/[T ]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? istDateKey(d) : null;
  }
  // A wall-clock time without a zone is IST local time: keep the calendar date, drop the time.
  s = s.replace(/[T ]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?(\s*[AP]M)?$/i, '').trim();

  const toks = s.split(/[-/.\s]+/).filter(Boolean);
  if (toks.length !== 3) return null;
  const alphaIdx = toks.findIndex((t) => /^[A-Za-z]+$/.test(t));
  if (alphaIdx >= 0) {
    const mo = MONTHS[toks[alphaIdx].toUpperCase()];
    if (!mo) return null;
    const nums = toks.filter((_, i) => i !== alphaIdx);
    if (!nums.every((t) => /^\d{1,4}$/.test(t))) return null;
    // "2026-Oct-05" → Y M D; "05-Oct-2026" / "Oct-05-2026" → D/M then Y.
    if (nums[0].length === 4) return ymd(Number(nums[0]), mo, Number(nums[1]));
    return ymd(year4(nums[1]), mo, Number(nums[0]));
  }
  if (!toks.every((t) => /^\d{1,4}$/.test(t))) return null;
  const [a, b, c] = toks;
  if (a.length === 4) return ymd(Number(a), Number(b), Number(c)); // unambiguous Y-M-D
  if (c.length !== 4 && c.length !== 2) return null;
  switch (order) {
    case 'DMY':
      return ymd(year4(c), Number(b), Number(a));
    case 'MDY':
      return ymd(year4(c), Number(a), Number(b));
    case 'YMD':
      return a.length === 2 ? ymd(year4(a), Number(b), Number(c)) : null;
  }
  return null;
}

export type ParsedInvoiceDate = { date: string } | { reason: 'blank date' | 'invalid date' | 'date out of range' };

/**
 * Invoice date → calendar 'YYYY-MM-DD' (no TZ shift for date cells / plain dates), with the reason when
 * it is rejected. Window: 2000-01-01 ≤ date ≤ today+1 (`todayIso` = IST today unless injected).
 *  - Date (exceljs date cell, naive UTC) → its UTC Y-M-D.
 *  - number → Excel 1900-system serial (the time fraction is ignored).
 *  - text → `order` for numeric D/M/Y; month names and a 4-digit leading year are unambiguous.
 */
export function parseInvoiceDateDetailed(v: unknown, order: DateOrder, todayIso?: string): ParsedInvoiceDate {
  let date: string | null;
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return { reason: 'blank date' };
  if (v instanceof Date) {
    date = utcYmd(v);
  } else if (typeof v === 'number') {
    // Serials < 61 sit before the fictitious 1900-02-29 and are long before the window anyway.
    date = Number.isFinite(v) && v >= 61 ? utcYmd(new Date(EXCEL_EPOCH_MS + Math.floor(v) * DAY_MS)) : null;
  } else if (typeof v === 'string') {
    date = parseDateText(v, order);
  } else {
    date = null;
  }
  if (!date) return { reason: 'invalid date' };
  const today = todayIso ?? istDateKey(new Date());
  const maxIso = new Date(Date.parse(`${today}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  if (date < '2000-01-01' || date > maxIso) return { reason: 'date out of range' };
  return { date };
}

/** Invoice date → 'YYYY-MM-DD' (calendar date, no TZ shift) or null when invalid/out of window. */
export function parseInvoiceDate(v: unknown, order: DateOrder, todayIso?: string): string | null {
  const r = parseInvoiceDateDetailed(v, order, todayIso);
  return 'date' in r ? r.date : null;
}
