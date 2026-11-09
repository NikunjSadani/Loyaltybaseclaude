/**
 * SalesAggregator (plan §7.1 step 8 / task I-5). Pure, in-memory, BigInt.
 *
 * One pass over the data rows of the file. Per valid line (outlet code, date, amount and/or quantity):
 *  - roster-matched outlet → aggregate[month][outletCode][dimKey] += {paise, micro, lines};
 *  - unmatched customer    → unmatched[month][code] += …  (counted, never an error);
 *  - every valid line      → month summary counters, dimension values, dimension combos.
 * Invalid lines are skipped with a reason (≤ SALES_IMPORT_MAX_ERROR_SAMPLES samples kept, all counted).
 * Fully blank rows are ignored silently (trailing empty rows in an export).
 */
import {
  SALES_IMPORT_MAX_DIMENSION_COMBOS,
  SALES_IMPORT_MAX_DIMENSION_VALUES,
  SALES_IMPORT_MAX_ERROR_SAMPLES,
  type MonthSummary,
  type SalesColumnMapping,
  type SalesDimensionCombo,
  type SalesDimensionValues,
  type SalesImportErrorSample,
} from '../sales-import.contract';
import type { ColumnIndex } from './header';
import { normalizeDim, normalizeHeader, normalizeOutletCode, parseInvoiceDateDetailed, stableDimKey, toMicro, toPaise } from './normalize';

export interface AggValue {
  amountPaise: bigint;
  qtyMicro: bigint;
  lines: number;
}

export interface AggRow extends AggValue {
  month: string;
  outletCode: string;
  dims: Record<string, string>;
  dimKey: string;
}

export interface UnmatchedRow extends AggValue {
  month: string;
  code: string;
  name: string;
}

interface MonthAcc {
  firstDate: string;
  lastDate: string;
  lines: number;
  matchedOutlets: Set<string>;
  matchedPaise: bigint;
  matchedMicro: bigint;
  unmatchedCustomers: Set<string>;
  unmatchedPaise: bigint;
  unmatchedMicro: bigint;
}

interface ValueAcc {
  lines: number;
  paise: bigint;
}

interface ComboAcc {
  dims: Record<string, string>;
  lines: number;
  paise: bigint;
  micro: bigint;
}

/**
 * Bounds on what is TRACKED (memory), well above what is KEPT in the frozen outputs. A mapped "dimension"
 * that is really an invoice number would otherwise grow without limit; past the bound new distinct
 * values are no longer tracked (existing ones keep counting) and `dimensionsTruncated` is set.
 */
export const TRACKED_VALUES_PER_DIM = 20_000;
export const TRACKED_COMBOS = 50_000;

export interface AggregatorResult {
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
  /** Test/inspection accessor. */
  get(month: string, outletCode: string, dimKey: string): AggValue | undefined;
}

const rupees = (paise: bigint) => Number(paise) / 100;
const cases = (micro: bigint) => Number(micro) / 1e6;
const absBig = (v: bigint) => (v < 0n ? -v : v);
const byAbsDesc = (a: bigint, b: bigint) => {
  const x = absBig(a);
  const y = absBig(b);
  return x === y ? 0 : x > y ? -1 : 1;
};

export class SalesAggregator {
  private readonly aggs = new Map<string, Map<string, Map<string, AggValue>>>(); // month → code → dimKey
  private readonly dimsByKey = new Map<string, Record<string, string>>();
  private readonly unmatchedMap = new Map<string, Map<string, UnmatchedRow>>(); // month → code
  private readonly months = new Map<string, MonthAcc>();
  private readonly values = new Map<string, Map<string, ValueAcc>>(); // dim key → value
  private readonly combos = new Map<string, ComboAcc>(); // dimKey
  private readonly errors: SalesImportErrorSample[] = [];
  private truncated = false;
  private aggregateCount = 0;
  private rowsRead = 0;
  private rowsSkipped = 0;
  private readonly dimKeys: string[];
  private readonly headers: Record<string, string>;

  constructor(
    private readonly mapping: SalesColumnMapping,
    private readonly idx: ColumnIndex,
    /** normalizeOutletCode(roster code) → the roster's own outletCode (aggregates are keyed by the latter). */
    private readonly roster: ReadonlyMap<string, string>,
    private readonly todayIso?: string,
  ) {
    this.dimKeys = (mapping.dimensions ?? []).map((d) => d.key);
    for (const k of this.dimKeys) this.values.set(k, new Map());
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

  push(cells: unknown[], rowNo: number): void {
    if (cells.every((c) => c === null || c === undefined || (typeof c === 'string' && c.trim() === ''))) return;
    this.rowsRead++;
    const idx = this.idx;

    const code = normalizeOutletCode(cells[idx.outletCode]);
    if (code === '') return this.skip(rowNo, this.headers.outletCode, 'blank outlet code');

    const d = parseInvoiceDateDetailed(cells[idx.invoiceDate], this.mapping.dateOrder, this.todayIso);
    if (!('date' in d)) return this.skip(rowNo, this.headers.invoiceDate, d.reason);
    const date = d.date;
    const month = date.slice(0, 7);

    let paise = 0n;
    if (idx.amount !== null) {
      const v = toPaise(cells[idx.amount]);
      if (v === null) return this.skip(rowNo, this.headers.amount, isBlank(cells[idx.amount]) ? 'blank amount' : 'invalid amount');
      paise = v;
    }
    let micro = 0n;
    if (idx.quantity !== null) {
      const v = toMicro(cells[idx.quantity]);
      if (v === null) return this.skip(rowNo, this.headers.quantity, isBlank(cells[idx.quantity]) ? 'blank quantity' : 'invalid quantity');
      micro = v;
    }

    const dims: Record<string, string> = {};
    for (const k of this.dimKeys) dims[k] = normalizeDim(cells[idx.dims[k]]);
    const dimKey = stableDimKey(dims);

    // Month summary.
    let m = this.months.get(month);
    if (!m) {
      m = {
        firstDate: date, lastDate: date, lines: 0,
        matchedOutlets: new Set(), matchedPaise: 0n, matchedMicro: 0n,
        unmatchedCustomers: new Set(), unmatchedPaise: 0n, unmatchedMicro: 0n,
      };
      this.months.set(month, m);
    }
    m.lines++;
    if (date < m.firstDate) m.firstDate = date;
    if (date > m.lastDate) m.lastDate = date;

    const rosterCode = this.roster.get(code);
    if (rosterCode !== undefined) {
      m.matchedOutlets.add(rosterCode);
      m.matchedPaise += paise;
      m.matchedMicro += micro;
      let byCode = this.aggs.get(month);
      if (!byCode) this.aggs.set(month, (byCode = new Map()));
      let byDim = byCode.get(rosterCode);
      if (!byDim) byCode.set(rosterCode, (byDim = new Map()));
      const a = byDim.get(dimKey);
      if (a) {
        a.amountPaise += paise;
        a.qtyMicro += micro;
        a.lines++;
      } else {
        byDim.set(dimKey, { amountPaise: paise, qtyMicro: micro, lines: 1 });
        this.aggregateCount++;
        if (!this.dimsByKey.has(dimKey)) this.dimsByKey.set(dimKey, dims);
      }
    } else {
      m.unmatchedCustomers.add(code);
      m.unmatchedPaise += paise;
      m.unmatchedMicro += micro;
      let byCode = this.unmatchedMap.get(month);
      if (!byCode) this.unmatchedMap.set(month, (byCode = new Map()));
      const u = byCode.get(code);
      const name = idx.outletName !== null ? String(cells[idx.outletName] ?? '').trim() : '';
      if (u) {
        u.amountPaise += paise;
        u.qtyMicro += micro;
        u.lines++;
        if (!u.name && name) u.name = name;
      } else {
        byCode.set(code, { month, code, name, amountPaise: paise, qtyMicro: micro, lines: 1 });
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
        c.micro += micro;
      } else if (this.combos.size < TRACKED_COMBOS) {
        this.combos.set(dimKey, { dims, lines: 1, paise, micro });
      } else {
        this.truncated = true;
      }
    }
  }

  result(): AggregatorResult {
    const monthSummaries: MonthSummary[] = [...this.months.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([month, m]) => ({
        month,
        firstDate: m.firstDate,
        lastDate: m.lastDate,
        lines: m.lines,
        matchedOutlets: m.matchedOutlets.size,
        unmatchedCustomers: m.unmatchedCustomers.size,
        matchedAmountRupees: rupees(m.matchedPaise),
        matchedQuantity: cases(m.matchedMicro),
        unmatchedAmountRupees: rupees(m.unmatchedPaise),
        unmatchedQuantity: cases(m.unmatchedMicro),
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
      .map(([, c]) => ({ dims: c.dims, lines: c.lines, amountRupees: rupees(c.paise), quantity: cases(c.micro) }));

    const aggs = this.aggs;
    const dimsByKey = this.dimsByKey;
    const unmatchedMap = this.unmatchedMap;
    return {
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
            for (const [dimKey, v] of byDim) yield { month, outletCode, dims: dimsByKey.get(dimKey)!, dimKey, ...v };
          }
        }
      },
      *unmatched() {
        for (const byCode of unmatchedMap.values()) yield* byCode.values();
      },
      get: (month, outletCode, dimKey) => aggs.get(month)?.get(outletCode)?.get(dimKey),
    };
  }
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}
