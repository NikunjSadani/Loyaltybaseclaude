/**
 * Sales Import KPI evaluation (plan §6.2 / §6.2a). PURE — no DB.
 *
 * A KPI definition = a filter over the import's normalized dimensions + a measure (AMOUNT ₹ / QUANTITY cases).
 *   - A line (aggregate row) is IN iff (anyOf empty OR it matches ≥1 anyOf entry) AND it matches no noneOf entry.
 *     This is a BOOLEAN per aggregate, so a line matching two anyOf entries is counted ONCE (set, not list).
 *   - An entry matches iff EVERY key it lists equals the line's (normalized) value for that key.
 *   - Sums are BigInt (paise / micro-cases); conversion to a JS number happens once, at the end.
 *   - Outlet scope: a definition with non-empty outletTypes/programs that does not cover the outlet → the key is
 *     OMITTED (blank ≠ 0, the engine's null policy). An in-scope outlet with no matching lines → 0 (full rewrite).
 */
import { createHash } from 'node:crypto';
import { microToCases, normalizeDim, paiseToRupees } from '../ingest/normalize';
import {
  SALES_IMPORT_DIM_KEY_PATTERN,
  SALES_KPI_MAX_FILTER_ENTRIES,
  type DimMatch,
  type SalesKpiFilter,
  type SalesKpiMeasure,
} from '../sales-import.contract';

export const SALES_KPI_MEASURES: readonly SalesKpiMeasure[] = ['AMOUNT', 'QUANTITY'];

/** One aggregate row as the evaluator needs it (SalesImportAggregate minus ids). */
export interface KpiAgg {
  dims: Record<string, string>;
  amountPaise: bigint;
  qtyMicro: bigint;
  lines: number;
}

/** The parts of a SalesKpiDefinition the evaluator reads. */
export interface KpiDefLite {
  kpiCode: string;
  measure: SalesKpiMeasure;
  filter: SalesKpiFilter;
  outletTypes: string[];
  programs: string[];
}

/** Outlet facets used for scope (Outlet.outletType.code, Outlet.programName). */
export interface OutletScopeMeta {
  outletType: string | null;
  program: string | null;
}

// ─── Matching ────────────────────────────────────────────────────────────────

export function entryMatches(dims: Record<string, string>, entry: DimMatch): boolean {
  const keys = Object.keys(entry);
  if (keys.length === 0) return true;
  for (const k of keys) {
    if ((dims[k] ?? '') !== normalizeDim(entry[k])) return false;
  }
  return true;
}

/** §6.2 `lineMatches(dims, filter)`. */
export function lineMatches(dims: Record<string, string>, filter: SalesKpiFilter): boolean {
  const anyOf = filter.anyOf ?? [];
  const noneOf = filter.noneOf ?? [];
  if (anyOf.length > 0 && !anyOf.some((e) => entryMatches(dims, e))) return false;
  if (noneOf.some((e) => entryMatches(dims, e))) return false;
  return true;
}

function scopeHas(list: string[], value: string | null): boolean {
  if (list.length === 0) return true;
  if (value === null || value === undefined) return false;
  const v = String(value).trim().toUpperCase();
  return list.some((x) => String(x).trim().toUpperCase() === v);
}

/** Is the outlet within the definition's optional outlet-type / programme scope? */
export function outletInScope(def: Pick<KpiDefLite, 'outletTypes' | 'programs'>, meta: OutletScopeMeta): boolean {
  return scopeHas(def.outletTypes ?? [], meta.outletType) && scopeHas(def.programs ?? [], meta.program);
}

// ─── Measures ────────────────────────────────────────────────────────────────

/** Raw BigInt sum of the definition's measure over the matching aggregates (scope NOT applied). */
export function sumMeasure(aggs: Iterable<KpiAgg>, def: Pick<KpiDefLite, 'measure' | 'filter'>): bigint {
  let s = 0n;
  for (const a of aggs) {
    if (!lineMatches(a.dims, def.filter)) continue;
    s += def.measure === 'AMOUNT' ? a.amountPaise : a.qtyMicro;
  }
  return s;
}

/** BigInt paise → rupees (2 dp) / micro-cases → cases (≤ 6 dp). One float conversion, at the end. */
export function measureToNumber(sum: bigint, measure: SalesKpiMeasure): number {
  return measure === 'AMOUNT' ? paiseToRupees(sum) : microToCases(sum);
}

/**
 * `computeOutletKpis(aggsForOutlet, defs, outletMeta)` — the values written for ONE outlet × month:
 * key per in-scope definition (sum, or 0 when no line matches); out-of-scope definitions are omitted.
 */
export function computeOutletKpis(
  aggsForOutlet: readonly KpiAgg[],
  defs: readonly KpiDefLite[],
  meta: OutletScopeMeta,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of defs) {
    if (!outletInScope(def, meta)) continue;
    out[def.kpiCode] = measureToNumber(sumMeasure(aggsForOutlet, def), def.measure);
  }
  return out;
}

/**
 * Streaming accumulator for many outlets (preview / apply / tester). Each aggregate's match vector is memoised
 * by its dimKey so 400k aggregates × N definitions cost one filter evaluation per DISTINCT combo.
 */
export class OutletKpiAccumulator {
  private readonly sums = new Map<string, bigint[]>();
  private readonly lines = new Map<string, number>();
  private readonly matchCache = new Map<string, boolean[]>();
  matchedLines = 0; // Σ lines of aggregates matching ≥ 1 definition (scope NOT applied)

  constructor(readonly defs: readonly KpiDefLite[]) {}

  add(outletCode: string, agg: KpiAgg, dimKey?: string): void {
    const key = dimKey ?? stableStringify(agg.dims);
    let match = this.matchCache.get(key);
    if (!match) {
      match = this.defs.map((d) => lineMatches(agg.dims, d.filter));
      this.matchCache.set(key, match);
    }
    let arr = this.sums.get(outletCode);
    if (!arr) {
      arr = this.defs.map(() => 0n);
      this.sums.set(outletCode, arr);
    }
    let any = false;
    for (let i = 0; i < this.defs.length; i++) {
      if (!match[i]) continue;
      any = true;
      arr[i] += this.defs[i].measure === 'AMOUNT' ? agg.amountPaise : agg.qtyMicro;
    }
    if (any) this.matchedLines += agg.lines;
    this.lines.set(outletCode, (this.lines.get(outletCode) ?? 0) + agg.lines);
  }

  /** Did the outlet have ANY aggregate line this month (regardless of filter)? */
  hasLines(outletCode: string): boolean {
    return (this.lines.get(outletCode) ?? 0) > 0;
  }

  outletCodes(): string[] {
    return [...this.sums.keys()];
  }

  /** Raw BigInt sum (paise / micro-cases) of definition `i` for an outlet (scope NOT applied). */
  rawSum(outletCode: string, i: number): bigint {
    return this.sums.get(outletCode)?.[i] ?? 0n;
  }

  /** Same contract as computeOutletKpis, from the accumulated sums. */
  valuesFor(outletCode: string, meta: OutletScopeMeta): Record<string, number> {
    const arr = this.sums.get(outletCode);
    const out: Record<string, number> = {};
    this.defs.forEach((def, i) => {
      if (!outletInScope(def, meta)) return;
      out[def.kpiCode] = measureToNumber(arr ? arr[i] : 0n, def.measure);
    });
    return out;
  }
}

// ─── Filter validation / normalisation (save time) ───────────────────────────

export interface FilterValidation {
  filter: SalesKpiFilter; // normalized + de-duplicated
  errors: string[]; // blocking
  notes: string[]; // non-blocking (e.g. duplicates removed)
}

function normalizeEntry(raw: unknown, list: 'anyOf' | 'noneOf', idx: number, dimKeys: Set<string>, errors: string[]): DimMatch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${list}[${idx}] must be an object of dimension → value.`);
    return null;
  }
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length === 0) {
    errors.push(
      list === 'anyOf'
        ? `${list}[${idx}] is empty. Use an empty filter {} for "all lines".`
        : `${list}[${idx}] is empty (it would exclude every line).`,
    );
    return null;
  }
  const out: DimMatch = {};
  for (const k of keys.sort()) {
    if (!SALES_IMPORT_DIM_KEY_PATTERN.test(k) || !dimKeys.has(k)) {
      errors.push(`${list}[${idx}] uses unknown dimension "${k}". Known: ${[...dimKeys].join(', ') || '(none)'}.`);
      continue;
    }
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v !== 'string' && typeof v !== 'number') {
      errors.push(`${list}[${idx}].${k} must be a text or number value.`);
      continue;
    }
    const nv = normalizeDim(v);
    if (nv === '') {
      errors.push(`${list}[${idx}].${k} is blank.`);
      continue;
    }
    out[k] = nv;
  }
  return out;
}

/**
 * Validate + normalise a filter against the tenant's profile dimension keys (§6.2a limits):
 * ≤ 200 anyOf + ≤ 200 noneOf; each entry 1..N known keys; no empty entry; values normalized (normalizeDim);
 * exact duplicates removed with a note.
 */
export function validateAndNormalizeFilter(raw: unknown, dimKeys: Iterable<string>): FilterValidation {
  const keys = new Set(dimKeys);
  const errors: string[] = [];
  const notes: string[] = [];
  if (raw === null || raw === undefined) return { filter: {}, errors, notes };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { filter: {}, errors: ['filter must be an object { anyOf?, noneOf? }.'], notes };
  }
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => k !== 'anyOf' && k !== 'noneOf');
  if (extra.length > 0) errors.push(`filter has unknown field(s): ${extra.join(', ')}.`);

  const filter: SalesKpiFilter = {};
  for (const list of ['anyOf', 'noneOf'] as const) {
    const v = r[list];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) {
      errors.push(`filter.${list} must be a list.`);
      continue;
    }
    if (v.length > SALES_KPI_MAX_FILTER_ENTRIES) {
      errors.push(`filter.${list} has ${v.length} entries; the maximum is ${SALES_KPI_MAX_FILTER_ENTRIES}.`);
      continue;
    }
    const seen = new Set<string>();
    const entries: DimMatch[] = [];
    v.forEach((e, i) => {
      const n = normalizeEntry(e, list, i, keys, errors);
      if (!n || Object.keys(n).length === 0) return;
      const sig = stableStringify(n);
      if (seen.has(sig)) {
        notes.push(`${list}[${i}] duplicates an earlier entry and was removed.`);
        return;
      }
      seen.add(sig);
      entries.push(n);
    });
    if (entries.length > 0) filter[list] = entries;
  }
  return { filter, errors, notes };
}

/** Keys referenced anywhere in a filter. */
export function filterDimKeys(filter: SalesKpiFilter | null | undefined): string[] {
  const s = new Set<string>();
  for (const e of [...(filter?.anyOf ?? []), ...(filter?.noneOf ?? [])]) for (const k of Object.keys(e)) s.add(k);
  return [...s].sort();
}

/**
 * `a` is fully covered by `b` iff every key of `b` is in `a` with the same value (b is more general or equal).
 * e.g. {brand:ADHO, skuGroup:500} is covered by {brand:ADHO}.
 */
export function entryCoveredBy(a: DimMatch, b: DimMatch): boolean {
  const bk = Object.keys(b);
  if (bk.length === 0) return true;
  return bk.every((k) => k in a && normalizeDim(a[k]) === normalizeDim(b[k]));
}

/**
 * Indexes of anyOf entries that are fully covered by ANOTHER anyOf entry (the later of two identical entries is the
 * redundant one). Non-blocking warning for the tester (§6.2a).
 */
export function redundantAnyOfEntries(anyOf: DimMatch[]): number[] {
  const out: number[] = [];
  anyOf.forEach((a, i) => {
    const covered = anyOf.some((b, j) => {
      if (i === j) return false;
      if (!entryCoveredBy(a, b)) return false;
      // identical entries: only the LATER one is redundant
      if (entryCoveredBy(b, a)) return j < i;
      return true;
    });
    if (covered) out.push(i);
  });
  return out;
}

// ─── Hashing ─────────────────────────────────────────────────────────────────

/** JSON with recursively sorted object keys (arrays keep their order). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/**
 * §6.2 `definitionsHash` = sha256 of the stable JSON of the ENABLED definitions sorted by kpiCode, id-free.
 * Only the fields that change what gets written are hashed (kpiCode, measure, filter, scope).
 */
export function definitionsHash(
  defs: ReadonlyArray<KpiDefLite & { enabled?: boolean }>,
): string {
  const canon = defs
    .filter((d) => d.enabled !== false)
    .map((d) => ({
      kpiCode: d.kpiCode,
      measure: d.measure,
      filter: d.filter ?? {},
      outletTypes: [...(d.outletTypes ?? [])].sort(),
      programs: [...(d.programs ?? [])].sort(),
    }))
    .sort((a, b) => (a.kpiCode < b.kpiCode ? -1 : a.kpiCode > b.kpiCode ? 1 : 0));
  return createHash('sha256').update(stableStringify(canon)).digest('hex');
}
