/**
 * SalesAggregator (plan §7.1 step 8 / task I-5). Pure, in-memory, BigInt.
 *
 * One pass over the data rows of the file. Per valid line (outlet code, date, amount and/or quantity):
 *  - EVERY customer code   → aggregate[month][normalizedCode][dimKey] += {paise, pico, lines}. The roster is applied
 *                            at PREVIEW / APPLY time (M6), so an outlet added after processing is not lost;
 *  - not on the roster NOW → also unmatched[month][code] (with the name) for unmatched.csv + the frozen summary;
 *  - every valid line      → month summary counters, dimension values, dimension combos.
 * Day level (sales-day-level, 2026-11-18): each aggregate also carries its split by IST invoice DAY (`days`, summing
 * exactly to the row). Memory: a row whose lines all fall on ONE day (the common case) costs one small integer; a
 * second distinct day allocates a small per-row day map. ⚠️ Re-measure the real file's heap peak (plan §7.1 step 11).
 * Invalid lines are skipped with a reason (≤ SALES_IMPORT_MAX_ERROR_SAMPLES samples kept, all counted).
 * Fully blank rows are ignored silently (trailing empty rows in an export).
 * Memory is bounded (S4): more than SALES_IMPORT_MAX_DISTINCT_CODES customer codes, MAX_AGGREGATE_KEYS aggregate keys
 * or MAX_UNMATCHED_KEYS unmatched keys → AggregatorLimitError (the processor shows its message).
 */
import {
  SALES_IMPORT_MAX_DIMENSION_COMBOS,
  SALES_IMPORT_MAX_DIMENSION_VALUES,
  SALES_IMPORT_MAX_DIM_VALUE_CHARS,
  SALES_IMPORT_MAX_DISTINCT_CODES,
  SALES_IMPORT_MAX_ERROR_SAMPLES,
  type MonthSummary,
  type SalesColumnMapping,
  type SalesDimensionCombo,
  type SalesDimensionValues,
  type SalesImportErrorSample,
} from '../sales-import.contract';
import type { ColumnIndex } from './header';
import { dayOfDate, type DaySlice } from '../days/day-slices';
import {
  QTY_SCALE,
  normalizeDim,
  normalizeHeader,
  normalizeOutletCode,
  paiseToRupees,
  parseInvoiceDateDetailed,
  classifyDecimal,
  picoToCases,
  picoToThousandths,
  stableDimKey,
  toPaise,
  toPico,
  type DecimalSeparator,
} from './normalize';

export interface AggValue {
  amountPaise: bigint;
  qtyPico: bigint;
  lines: number;
}

export interface AggRow extends AggValue {
  month: string;
  /** The row split by IST invoice day (sorted; sums exactly to the row). */
  days: DaySlice[];
  /** normalizeOutletCode(file cell) — NOT necessarily a roster code (M6). */
  outletCode: string;
  dims: Record<string, string>;
  dimKey: string;
}

export interface UnmatchedRow extends AggValue {
  month: string;
  code: string;
  name: string;
}

/** An aggregate entry: totals + its day split (`byDay` null = every line so far on `day0`). */
interface AggEntry extends AggValue {
  day0: number;
  byDay: Map<number, DaySlice> | null;
}

/** Add one line's values to the entry's day split (BEFORE the totals are updated). */
function addDay(e: AggEntry, day: number, paise: bigint, pico: bigint): void {
  if (e.byDay === null) {
    if (day === e.day0) return; // still single-day: the totals ARE the day's values
    e.byDay = new Map([[e.day0, { day: e.day0, amountPaise: e.amountPaise, qtyPico: e.qtyPico, lines: e.lines }]]);
  }
  const s = e.byDay.get(day);
  if (s) {
    s.amountPaise += paise;
    s.qtyPico += pico;
    s.lines++;
  } else {
    e.byDay.set(day, { day, amountPaise: paise, qtyPico: pico, lines: 1 });
  }
}

function daysOf(e: AggEntry): DaySlice[] {
  if (e.byDay === null) return [{ day: e.day0, amountPaise: e.amountPaise, qtyPico: e.qtyPico, lines: e.lines }];
  return [...e.byDay.values()].sort((a, b) => a.day - b.day).map((s) => ({ ...s }));
}

interface MonthAcc {
  firstDate: string;
  lastDate: string;
  lines: number;
  matchedOutlets: Set<string>;
  matchedPaise: bigint;
  matchedPico: bigint;
  unmatchedCustomers: Set<string>;
  unmatchedPaise: bigint;
  unmatchedPico: bigint;
}

interface ValueAcc {
  lines: number;
  paise: bigint;
}

interface ComboAcc {
  dims: Record<string, string>;
  lines: number;
  paise: bigint;
  pico: bigint;
}

/**
 * Bounds on what is TRACKED (memory), well above what is KEPT in the frozen outputs. A mapped "dimension"
 * that is really an invoice number would otherwise grow without limit; past the bound new distinct
 * values are no longer tracked (existing ones keep counting) and `dimensionsTruncated` is set.
 */
export const TRACKED_VALUES_PER_DIM = 20_000;
export const TRACKED_COMBOS = 50_000;
/**
 * Hard memory bounds (S4; budget in plan §7.1 step 11): exceeding one fails the import with a readable message long
 * before the 1.5 GB heap is at risk. Measured ≈ 0.4 KB of heap per tracked entry (aggregate or unmatched) incl. Map
 * overhead and BigInts; 1.8 M entries ≈ 720 MB + exceljs shared strings (≤ ~350 MB) + the code set (≤ ~50 MB).
 * The real 205 MB file needs ≈ 0.6 M aggregate + 0.4 M unmatched entries and ≈ 0.2 M codes.
 */
export const MAX_AGGREGATE_KEYS = 1_500_000;
export const MAX_UNMATCHED_KEYS = 900_000;
export const MAX_TRACKED_ENTRIES = 1_800_000; // aggregates + unmatched, combined
/** Customer names kept for unmatched.csv are truncated to this many characters (memory bound). */
export const UNMATCHED_NAME_CHARS = 80;
/** |Σ quantity| of one aggregate row must fit the BIGINT pico-cases column (±9.2e18 / 1e12). */
export const MAX_AGGREGATE_CASES = 9_000_000n;

/** The file exceeds a memory bound of the worker (message shown to the admin verbatim). */
export class AggregatorLimitError extends Error {}

/** 'auto' decimal-separator evidence from TEXT measure cells (counts + one example each). */
export interface DecimalEvidenceSummary {
  dot: number;
  comma: number;
  ambiguous: number;
  examples: { dot?: string; comma?: string; ambiguous?: string };
}

export interface AggregatorResult {
  decimalEvidence: DecimalEvidenceSummary;
  rowsRead: number;
  rowsSkipped: number;
  errorSamples: SalesImportErrorSample[];
  monthSummaries: MonthSummary[];
  dimensionValues: SalesDimensionValues;
  dimensionCombos: SalesDimensionCombo[];
  dimensionsTruncated: boolean;
  aggregateCount: number;
  aggregates(): Iterable<AggRow>;
  unmatched(): Iterable<UnmatchedRow>;
  /** Test/inspection accessor (totals only). */
  get(month: string, outletCode: string, dimKey: string): AggValue | undefined;
  /** Test/inspection accessor: the row's split by IST invoice day. */
  getDays(month: string, outletCode: string, dimKey: string): DaySlice[] | undefined;
}

const rupees = paiseToRupees;
const cases = picoToCases;
const MAX_PICO = MAX_AGGREGATE_CASES * QTY_SCALE;
const absBig = (v: bigint) => (v < 0n ? -v : v);
const byAbsDesc = (a: bigint, b: bigint) => {
  const x = absBig(a);
  const y = absBig(b);
  return x === y ? 0 : x > y ? -1 : 1;
};
const fmt = (n: number | bigint) => n.toLocaleString('en-IN');

export class SalesAggregator {
  private readonly aggs = new Map<string, Map<string, Map<string, AggEntry>>>(); // month → code → dimKey
  private readonly dimsByKey = new Map<string, Record<string, string>>();
  private readonly unmatchedMap = new Map<string, Map<string, UnmatchedRow>>(); // month → code
  private readonly months = new Map<string, MonthAcc>();
  private readonly values = new Map<string, Map<string, ValueAcc>>(); // dim key → value
  private readonly combos = new Map<string, ComboAcc>(); // dimKey
  private readonly codes = new Set<string>();
  private readonly errors: SalesImportErrorSample[] = [];
  private truncated = false;
  private aggregateCount = 0;
  private unmatchedCount = 0;
  private rowsRead = 0;
  private rowsSkipped = 0;
  private readonly dimKeys: string[];
  private readonly headers: Record<string, string>;
  private readonly dimHeaders: Record<string, string> = {};
  private readonly maxCodes: number;
  private readonly maxAggregates: number;
  private readonly maxUnmatched: number;
  private readonly maxTracked: number;
  private readonly collectEvidence: boolean;
  private readonly evidence: DecimalEvidenceSummary = { dot: 0, comma: 0, ambiguous: 0, examples: {} };

  constructor(
    private readonly mapping: SalesColumnMapping,
    private readonly idx: ColumnIndex,
    /** normalizeOutletCode(roster code) → the roster's own outletCode (processing-time matched/unmatched only). */
    private readonly roster: ReadonlyMap<string, string>,
    private readonly todayIso?: string,
    /** Decimal separator of TEXT amount/quantity cells (L1). */
    private readonly decimal: DecimalSeparator = '.',
    /** Overridable memory bounds (tests use small ones). */
    limits: Partial<{ maxCodes: number; maxAggregates: number; maxUnmatched: number; maxTracked: number }> = {},
    /** 'auto' decimal mode: record evidence from text measure cells so the processor can decide once per file. */
    opts: { collectDecimalEvidence?: boolean } = {},
  ) {
    this.maxCodes = limits.maxCodes ?? SALES_IMPORT_MAX_DISTINCT_CODES;
    this.maxAggregates = limits.maxAggregates ?? MAX_AGGREGATE_KEYS;
    this.maxUnmatched = limits.maxUnmatched ?? MAX_UNMATCHED_KEYS;
    this.maxTracked = limits.maxTracked ?? MAX_TRACKED_ENTRIES;
    this.collectEvidence = opts.collectDecimalEvidence === true;
    this.dimKeys = (mapping.dimensions ?? []).map((d) => d.key);
    for (const k of this.dimKeys) this.values.set(k, new Map());
    for (const d of mapping.dimensions ?? []) this.dimHeaders[d.key] = normalizeHeader(d.header);
    this.headers = {
      outletCode: normalizeHeader(mapping.outletCode),
      invoiceDate: normalizeHeader(mapping.invoiceDate),
      amount: normalizeHeader(mapping.amount ?? ''),
      quantity: normalizeHeader(mapping.quantity ?? ''),
    };
  }

  private skip(rowNo: number, column: string | null, reason: string): void {
    this.rowsSkipped++;
    if (this.errors.length < SALES_IMPORT_MAX_ERROR_SAMPLES) this.errors.push({ row: rowNo, column, reason });
  }

  private observe(v: unknown): void {
    const e = classifyDecimal(v);
    if (e === 'none') return;
    this.evidence[e]++;
    if (this.evidence.examples[e] === undefined) this.evidence.examples[e] = String(v).trim().slice(0, 30);
  }

  private tooMany(): AggregatorLimitError {
    return new AggregatorLimitError(
      `The file is too large to process in one go (more than ${fmt(this.maxTracked)} month × customer × product and unmatched-customer entries). Split the file by month, or check the dimension / outlet-code columns.`,
    );
  }

  push(cells: unknown[], rowNo: number): void {
    if (cells.every((c) => c === null || c === undefined || (typeof c === 'string' && c.trim() === ''))) return;
    this.rowsRead++;
    const idx = this.idx;
    if (this.collectEvidence) {
      if (idx.amount !== null) this.observe(cells[idx.amount]);
      if (idx.quantity !== null) this.observe(cells[idx.quantity]);
    }

    const code = normalizeOutletCode(cells[idx.outletCode]);
    if (code === '') return this.skip(rowNo, this.headers.outletCode, 'blank outlet code');
    if (code.length > SALES_IMPORT_MAX_DIM_VALUE_CHARS) {
      return this.skip(rowNo, this.headers.outletCode, `outlet code longer than ${SALES_IMPORT_MAX_DIM_VALUE_CHARS} characters`);
    }

    const d = parseInvoiceDateDetailed(cells[idx.invoiceDate], this.mapping.dateOrder, this.todayIso);
    if (!('date' in d)) return this.skip(rowNo, this.headers.invoiceDate, d.reason);
    const date = d.date; // the IST calendar date (normalize.ts)
    const month = date.slice(0, 7);
    const day = dayOfDate(date);

    // H4: with BOTH measures mapped, a blank one counts as 0 (e.g. a ₹-only credit note or a free-goods line keeps its
    // other measure); such a row is skipped only when both are blank. A non-blank, unparsable value is always skipped.
    const both = idx.amount !== null && idx.quantity !== null;
    const amountBlank = idx.amount !== null && isBlank(cells[idx.amount]);
    const qtyBlank = idx.quantity !== null && isBlank(cells[idx.quantity]);
    if (both && amountBlank && qtyBlank) return this.skip(rowNo, null, 'blank amount and quantity');
    let paise = 0n;
    if (idx.amount !== null && !(both && amountBlank)) {
      const v = toPaise(cells[idx.amount], this.decimal);
      if (v === null) return this.skip(rowNo, this.headers.amount, amountBlank ? 'blank amount' : 'invalid amount');
      paise = v;
    }
    let pico = 0n;
    if (idx.quantity !== null && !(both && qtyBlank)) {
      const v = toPico(cells[idx.quantity], this.decimal);
      if (v === null) return this.skip(rowNo, this.headers.quantity, qtyBlank ? 'blank quantity' : 'invalid quantity');
      pico = v;
    }

    const dims: Record<string, string> = {};
    for (const k of this.dimKeys) {
      const v = normalizeDim(cells[idx.dims[k]]);
      // Final check L1: bounded keys (aggregates, history, combos) — an over-long product value is a data error.
      if (v.length > SALES_IMPORT_MAX_DIM_VALUE_CHARS) {
        return this.skip(rowNo, this.dimHeaders[k], `${k} value longer than ${SALES_IMPORT_MAX_DIM_VALUE_CHARS} characters`);
      }
      dims[k] = v;
    }
    const dimKey = stableDimKey(dims);

    // Bounds first, so a rejected file never half-updates the counters.
    if (!this.codes.has(code)) {
      if (this.codes.size >= this.maxCodes) {
        throw new AggregatorLimitError(
          `The file has more than ${fmt(this.maxCodes)} distinct customer codes. Check that the outlet-code column is mapped correctly, or split the file.`,
        );
      }
      this.codes.add(code);
    }

    // Month summary.
    let m = this.months.get(month);
    if (!m) {
      m = {
        firstDate: date, lastDate: date, lines: 0,
        matchedOutlets: new Set(), matchedPaise: 0n, matchedPico: 0n,
        unmatchedCustomers: new Set(), unmatchedPaise: 0n, unmatchedPico: 0n,
      };
      this.months.set(month, m);
    }
    m.lines++;
    if (date < m.firstDate) m.firstDate = date;
    if (date > m.lastDate) m.lastDate = date;

    // Every customer code is aggregated (M6), keyed by its NORMALIZED code.
    let byCode = this.aggs.get(month);
    if (!byCode) this.aggs.set(month, (byCode = new Map()));
    let byDim = byCode.get(code);
    if (!byDim) byCode.set(code, (byDim = new Map()));
    const a = byDim.get(dimKey);
    if (a) {
      addDay(a, day, paise, pico);
      a.amountPaise += paise;
      a.qtyPico += pico;
      a.lines++;
      if (a.qtyPico > MAX_PICO || a.qtyPico < -MAX_PICO) {
        throw new AggregatorLimitError(`Row ${rowNo}: one outlet's quantity for a product in a month exceeds ${fmt(MAX_AGGREGATE_CASES)} cases. Check the quantity column.`);
      }
    } else {
      if (this.aggregateCount >= this.maxAggregates) {
        throw new AggregatorLimitError(
          `The file has more than ${fmt(this.maxAggregates)} distinct month × customer × product combinations. Check the dimension columns, or split the file.`,
        );
      }
      if (pico > MAX_PICO || pico < -MAX_PICO) {
        throw new AggregatorLimitError(`Row ${rowNo}: the quantity exceeds ${fmt(MAX_AGGREGATE_CASES)} cases. Check the quantity column.`);
      }
      if (this.aggregateCount + this.unmatchedCount >= this.maxTracked) throw this.tooMany();
      byDim.set(dimKey, { amountPaise: paise, qtyPico: pico, lines: 1, day0: day, byDay: null });
      this.aggregateCount++;
      if (!this.dimsByKey.has(dimKey)) this.dimsByKey.set(dimKey, dims);
    }

    // Matched / unmatched against the roster AT PROCESSING TIME (frozen summary + unmatched.csv only).
    const rosterCode = this.roster.get(code);
    if (rosterCode !== undefined) {
      m.matchedOutlets.add(rosterCode);
      m.matchedPaise += paise;
      m.matchedPico += pico;
    } else {
      m.unmatchedCustomers.add(code);
      m.unmatchedPaise += paise;
      m.unmatchedPico += pico;
      let ub = this.unmatchedMap.get(month);
      if (!ub) this.unmatchedMap.set(month, (ub = new Map()));
      const u = ub.get(code);
      const name = idx.outletName !== null ? String(cells[idx.outletName] ?? '').trim().slice(0, UNMATCHED_NAME_CHARS) : '';
      if (u) {
        u.amountPaise += paise;
        u.qtyPico += pico;
        u.lines++;
        if (!u.name && name) u.name = name;
      } else {
        if (this.unmatchedCount >= this.maxUnmatched) {
          throw new AggregatorLimitError(
            `The file has more than ${fmt(this.maxUnmatched)} unmatched customer × month entries. Check the outlet-code column mapping.`,
          );
        }
        if (this.aggregateCount + this.unmatchedCount >= this.maxTracked) throw this.tooMany();
        this.unmatchedCount++;
        ub.set(code, { month, code, name, amountPaise: paise, qtyPico: pico, lines: 1 });
      }
    }

    // Dimension values / combos (all valid lines: they help author filters).
    for (const k of this.dimKeys) {
      const vm = this.values.get(k)!;
      const v = vm.get(dims[k]);
      if (v) {
        v.lines++;
        v.paise += paise;
      } else if (vm.size < TRACKED_VALUES_PER_DIM) {
        vm.set(dims[k], { lines: 1, paise });
      } else {
        this.truncated = true;
      }
    }
    if (this.dimKeys.length > 0) {
      const c = this.combos.get(dimKey);
      if (c) {
        c.lines++;
        c.paise += paise;
        c.pico += pico;
      } else if (this.combos.size < TRACKED_COMBOS) {
        this.combos.set(dimKey, { dims, lines: 1, paise, pico });
      } else {
        this.truncated = true;
      }
    }
  }

  /**
   * Audit L-4: the frozen month summary rounds quantities the way preview / apply do — per matched OUTLET and per
   * unmatched CUSTOMER, each to 3 dp, then summed — so the import detail page and the preview show the same numbers.
   */
  private roundedQuantities(month: string): { matched: number; unmatched: number } {
    let matched = 0n;
    for (const [code, byDim] of this.aggs.get(month) ?? []) {
      if (this.roster.get(code) === undefined) continue;
      let pico = 0n;
      for (const v of byDim.values()) pico += v.qtyPico;
      matched += picoToThousandths(pico);
    }
    let unmatched = 0n;
    for (const u of this.unmatchedMap.get(month)?.values() ?? []) unmatched += picoToThousandths(u.qtyPico);
    return { matched: Number(matched) / 1000, unmatched: Number(unmatched) / 1000 };
  }

  result(): AggregatorResult {
    const monthSummaries: MonthSummary[] = [...this.months.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([month, m]) => ({ month, m, q: this.roundedQuantities(month) }))
      .map(({ month, m, q }) => ({
        month,
        firstDate: m.firstDate,
        lastDate: m.lastDate,
        lines: m.lines,
        matchedOutlets: m.matchedOutlets.size,
        unmatchedCustomers: m.unmatchedCustomers.size,
        matchedAmountRupees: rupees(m.matchedPaise),
        matchedQuantity: q.matched,
        unmatchedAmountRupees: rupees(m.unmatchedPaise),
        unmatchedQuantity: q.unmatched,
      }));

    const dimensionValues: SalesDimensionValues = {};
    for (const [k, vm] of this.values) {
      dimensionValues[k] = [...vm.entries()]
        .sort(([va, a], [vb, b]) => byAbsDesc(a.paise, b.paise) || b.lines - a.lines || (va < vb ? -1 : va > vb ? 1 : 0))
        .slice(0, SALES_IMPORT_MAX_DIMENSION_VALUES)
        .map(([value, a]) => ({ value, lines: a.lines, amountRupees: rupees(a.paise) }));
    }
    const dimensionCombos: SalesDimensionCombo[] = [...this.combos.entries()]
      .sort(([ka, a], [kb, b]) => byAbsDesc(a.paise, b.paise) || b.lines - a.lines || (ka < kb ? -1 : ka > kb ? 1 : 0))
      .slice(0, SALES_IMPORT_MAX_DIMENSION_COMBOS)
      .map(([, c]) => ({ dims: c.dims, lines: c.lines, amountRupees: rupees(c.paise), quantity: cases(c.pico) }));

    const aggs = this.aggs;
    const dimsByKey = this.dimsByKey;
    const unmatchedMap = this.unmatchedMap;
    return {
      decimalEvidence: { ...this.evidence, examples: { ...this.evidence.examples } },
      rowsRead: this.rowsRead,
      rowsSkipped: this.rowsSkipped,
      errorSamples: [...this.errors],
      monthSummaries,
      dimensionValues,
      dimensionCombos,
      dimensionsTruncated: this.truncated,
      aggregateCount: this.aggregateCount,
      *aggregates() {
        for (const [month, byCode] of aggs) {
          for (const [outletCode, byDim] of byCode) {
            for (const [dimKey, v] of byDim) {
              yield {
                month, outletCode, dims: dimsByKey.get(dimKey)!, dimKey,
                amountPaise: v.amountPaise, qtyPico: v.qtyPico, lines: v.lines, days: daysOf(v),
              };
            }
          }
        }
      },
      *unmatched() {
        for (const byCode of unmatchedMap.values()) yield* byCode.values();
      },
      get: (month, outletCode, dimKey) => {
        const e = aggs.get(month)?.get(outletCode)?.get(dimKey);
        return e ? { amountPaise: e.amountPaise, qtyPico: e.qtyPico, lines: e.lines } : undefined;
      },
      getDays: (month, outletCode, dimKey) => {
        const e = aggs.get(month)?.get(outletCode)?.get(dimKey);
        return e ? daysOf(e) : undefined;
      },
    };
  }
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}
