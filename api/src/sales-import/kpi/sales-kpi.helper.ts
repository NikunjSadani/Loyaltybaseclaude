/**
 * Sales Import KPI evaluation (plan §6.2 / §6.2a). PURE — no DB.
 *
 * A KPI definition = a filter over the import's normalized dimensions + a measure (AMOUNT ₹ / QUANTITY cases /
 * PRODUCT_COUNT distinct products).
 *   - A line (aggregate row) is IN iff (anyOf empty OR it matches ≥1 anyOf entry) AND it matches no noneOf entry.
 *     This is a BOOLEAN per aggregate, so a line matching two anyOf entries is counted ONCE (set, not list).
 *   - An entry matches iff EVERY key it lists equals the line's (normalized) value for that key.
 *   - Sums are BigInt (paise / pico-cases, exact); conversion to a JS number happens once, at the end of the sum
 *     (₹ exact at 2 dp; cases rounded to SALES_KPI_QUANTITY_DECIMALS = 3 — H3).
 *   - PRODUCT_COUNT ("LINES", owner-approved 2026-11-13, NET basis): for one outlet × month, the number of DISTINCT
 *     products (one product = one distinct combination of the profile's dimension columns = the aggregate's dimKey)
 *     among the MATCHING aggregates whose NET amount (Σ amountPaise over every matching aggregate of that product for
 *     the outlet, returns included) is > 0. A product bought and fully returned, or with only zero-value (free) lines,
 *     does not count. The same product arriving in several aggregates (pages, history rows) is netted, then counted
 *     once. The value is an integer (stored units = the count). Scope rules are the same as for the sums.
 *   - Outlet scope: a definition with non-empty outletTypes/programs that does not cover the outlet → the key is
 *     OMITTED (blank ≠ 0, the engine's null policy). An in-scope outlet with no matching lines → 0 (full rewrite).
 *   - L4 / APPLIES-TO §5: the KPI's OWN scope (KpiDef outletTypes / programs / subPrograms via `kpiScope`, else the
 *     legacy KpiDef.outletType via `kpiOutletType`) is a further scope, INTERSECTED with the definition's scope
 *     (`intersectAppliesTo`; a disjoint pair = no outlet). Matching follows common/applies-to `appliesToOutlet` (trimmed,
 *     ci, D4: a non-empty facet + a blank outlet value is out).
 */
import { createHash } from 'node:crypto';
import {
  type AppliesTo,
  canonicalScopeKey,
  intersectAppliesTo,
  kpiAppliesTo,
} from '../../common/applies-to/applies-to';
import { normalizeDim, paiseToRupees, picoToCases } from '../ingest/normalize';
import {
  SALES_IMPORT_DIM_KEY_PATTERN,
  SALES_KPI_MAX_FILTER_ENTRIES,
  type DimMatch,
  type SalesKpiFilter,
  type SalesKpiMeasure,
} from '../sales-import.contract';

export const SALES_KPI_MEASURES: readonly SalesKpiMeasure[] = ['AMOUNT', 'QUANTITY', 'PRODUCT_COUNT'];

/** Compile-time exhaustiveness guard for `switch (measure)`: a new measure that is not handled fails `tsc`. */
export function assertNeverMeasure(m: never): never {
  throw new Error(`Unknown sales KPI measure: ${String(m)}`);
}

/** Number of products whose net amount is > 0. */
function countPositive(net: Iterable<bigint>): bigint {
  let n = 0n;
  for (const v of net) if (v > 0n) n++;
  return n;
}

/** One aggregate row as the evaluator needs it (SalesImportAggregate minus ids). */
export interface KpiAgg {
  dims: Record<string, string>;
  amountPaise: bigint;
  qtyPico: bigint;
  lines: number;
}

/** The parts of a SalesKpiDefinition the evaluator reads. */
export interface KpiDefLite {
  kpiCode: string;
  measure: SalesKpiMeasure;
  filter: SalesKpiFilter;
  outletTypes: string[];
  programs: string[];
  /** DEPRECATED legacy KpiDef.outletType of the target KPI (null/undefined = shared). Used only when `kpiScope` is unscoped. */
  kpiOutletType?: string | null;
  /** APPLIES-TO scope of the target KPI (KpiDef outletTypes / programs / subPrograms). Wins over `kpiOutletType` when non-empty. */
  kpiScope?: Partial<AppliesTo> | null;
}

/** Outlet facets used for scope (Outlet.outletType.code, Outlet.programName, Outlet.programCategory). */
export interface OutletScopeMeta {
  outletType: string | null;
  program: string | null;
  /** Outlet.programCategory (Sub-Program). Absent = blank (out of any non-empty subPrograms scope, D4). */
  subProgram?: string | null;
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

type ScopeDef = Pick<KpiDefLite, 'outletTypes' | 'programs' | 'kpiOutletType' | 'kpiScope'>;

/** The target KPI's own scope: `kpiScope` arrays when any is non-empty, else the legacy `kpiOutletType`. */
export function kpiOwnScope(def: Pick<KpiDefLite, 'kpiOutletType' | 'kpiScope'>): AppliesTo {
  return kpiAppliesTo({
    outletType: def.kpiOutletType ?? null,
    outletTypes: def.kpiScope?.outletTypes ?? [],
    programs: def.kpiScope?.programs ?? [],
    subPrograms: def.kpiScope?.subPrograms ?? [],
  });
}

/**
 * A definition's effective scope, COMPILED once: each non-empty facet as a Set of trimmed + UPPERCASED values
 * (null = facet empty = every value). `null` overall = disjoint → the definition writes NO outlet.
 */
interface CompiledScope {
  outletTypes: ReadonlySet<string> | null;
  programs: ReadonlySet<string> | null;
  subPrograms: ReadonlySet<string> | null;
}

// Per definition OBJECT (defs are immutable once built). Both the intersected AppliesTo and its compiled Sets are
// computed on the first call only, so the 400k-aggregate × N-defs hot path does a WeakMap hit + ≤3 Set lookups per
// outlet — never re-normalising / re-intersecting the scope.
const effectiveScopeCache = new WeakMap<object, AppliesTo | null>();
const compiledScopeCache = new WeakMap<object, CompiledScope | null>();

/**
 * The definition's effective scope = its own outletTypes / programs ∩ the target KPI's scope (`intersectAppliesTo`).
 * null = disjoint → the definition writes NO outlet.
 */
export function effectiveDefScope(def: ScopeDef): AppliesTo | null {
  const hit = effectiveScopeCache.get(def);
  if (hit !== undefined) return hit;
  const eff = intersectAppliesTo({ outletTypes: def.outletTypes ?? [], programs: def.programs ?? [] }, kpiOwnScope(def));
  effectiveScopeCache.set(def, eff);
  return eff;
}

const facetSet = (list: ReadonlyArray<string>): ReadonlySet<string> | null =>
  list.length === 0 ? null : new Set(list.map((v) => v.trim().toUpperCase()));

function compiledDefScope(def: ScopeDef): CompiledScope | null {
  const hit = compiledScopeCache.get(def);
  if (hit !== undefined) return hit;
  const eff = effectiveDefScope(def);
  const compiled =
    eff === null
      ? null
      : { outletTypes: facetSet(eff.outletTypes), programs: facetSet(eff.programs), subPrograms: facetSet(eff.subPrograms) };
  compiledScopeCache.set(def, compiled);
  return compiled;
}

/** Same rule as common/applies-to `facetHasValue`: empty facet = all; D4 blank outlet value = out; trimmed + ci. */
function facetAllows(set: ReadonlySet<string> | null, value: string | null | undefined): boolean {
  if (set === null) return true;
  const v = (value ?? '').trim();
  return v !== '' && set.has(v.toUpperCase());
}

/**
 * Is the outlet within the definition's optional scope (intersected with the target KPI's own scope)? Equivalent to
 * `appliesToOutlet(effectiveDefScope(def), meta)` (pinned by spec) but against the compiled per-definition Sets.
 */
export function outletInScope(def: ScopeDef, meta: OutletScopeMeta): boolean {
  const c = compiledDefScope(def);
  if (c === null) return false;
  return (
    facetAllows(c.outletTypes, meta.outletType) &&
    facetAllows(c.programs, meta.program) &&
    facetAllows(c.subPrograms, meta.subProgram ?? null)
  );
}

// ─── Measures ────────────────────────────────────────────────────────────────

/**
 * Raw BigInt value of the definition's measure over the matching aggregates (scope NOT applied): the sum of paise /
 * pico-cases, or for PRODUCT_COUNT the number of distinct products (dims combination) with net amount > 0.
 */
export function sumMeasure(aggs: Iterable<KpiAgg>, def: Pick<KpiDefLite, 'measure' | 'filter'>): bigint {
  const m = def.measure;
  switch (m) {
    case 'AMOUNT':
    case 'QUANTITY': {
      let s = 0n;
      for (const a of aggs) {
        if (!lineMatches(a.dims, def.filter)) continue;
        s += m === 'AMOUNT' ? a.amountPaise : a.qtyPico;
      }
      return s;
    }
    case 'PRODUCT_COUNT': {
      const net = new Map<string, bigint>();
      for (const a of aggs) {
        if (!lineMatches(a.dims, def.filter)) continue;
        const k = stableStringify(a.dims);
        net.set(k, (net.get(k) ?? 0n) + a.amountPaise);
      }
      return countPositive(net.values());
    }
    default:
      return assertNeverMeasure(m);
  }
}

/**
 * BigInt paise → rupees (2 dp) / pico-cases → cases (rounded to 3 dp) / product count → the integer itself.
 * One conversion, at the end of the sum.
 */
export function measureToNumber(sum: bigint, measure: SalesKpiMeasure): number {
  switch (measure) {
    case 'AMOUNT':
      return paiseToRupees(sum);
    case 'QUANTITY':
      return picoToCases(sum);
    case 'PRODUCT_COUNT':
      return Number(sum);
    default:
      return assertNeverMeasure(measure);
  }
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
 * by its dimKey so 400k aggregates × N definitions cost one filter evaluation per DISTINCT combo. Accumulators over
 * the SAME definitions may share one cache (the tester keeps one accumulator per month).
 *
 * AMOUNT / QUANTITY definitions add into a per-outlet BigInt array (fast path, unchanged). PRODUCT_COUNT definitions
 * instead share ONE per-outlet Map<dimKey, net paise> holding every product that matches ≥ 1 PRODUCT_COUNT definition;
 * the count is derived at read time (`rawSum`) as the products matching THAT definition with net > 0 — so repeated,
 * split or later negative aggregates of the same outlet × product net off before counting. The map exists only when
 * the definitions include a PRODUCT_COUNT one.
 */
export class OutletKpiAccumulator {
  private readonly sums = new Map<string, bigint[]>();
  private readonly lines = new Map<string, number>();
  /** outlet → product key (dimKey) → net paise, for products matching ≥ 1 PRODUCT_COUNT definition. null = none exist. */
  private readonly productNet: Map<string, Map<string, bigint>> | null;
  matchedLines = 0; // Σ lines of aggregates matching ≥ 1 definition (scope NOT applied)

  constructor(
    readonly defs: readonly KpiDefLite[],
    private readonly matchCache: Map<string, boolean[]> = new Map(),
  ) {
    this.productNet = defs.some((d) => d.measure === 'PRODUCT_COUNT') ? new Map() : null;
  }

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
    let product = false;
    for (let i = 0; i < this.defs.length; i++) {
      if (!match[i]) continue;
      any = true;
      const m = this.defs[i].measure;
      switch (m) {
        case 'AMOUNT':
          arr[i] += agg.amountPaise;
          break;
        case 'QUANTITY':
          arr[i] += agg.qtyPico;
          break;
        case 'PRODUCT_COUNT':
          product = true; // netted once per aggregate below, counted per definition in rawSum
          break;
        default:
          assertNeverMeasure(m);
      }
    }
    if (product && this.productNet) {
      let net = this.productNet.get(outletCode);
      if (!net) this.productNet.set(outletCode, (net = new Map()));
      net.set(key, (net.get(key) ?? 0n) + agg.amountPaise);
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

  /**
   * Raw BigInt value of definition `i` for an outlet (scope NOT applied): the sum (paise / pico-cases), or for a
   * PRODUCT_COUNT definition the number of products matching it whose net amount is > 0.
   */
  rawSum(outletCode: string, i: number): bigint {
    if (this.defs[i]?.measure !== 'PRODUCT_COUNT') return this.sums.get(outletCode)?.[i] ?? 0n;
    const net = this.productNet?.get(outletCode);
    if (!net) return 0n;
    let n = 0n;
    for (const [key, v] of net) {
      if (v > 0n && this.matchCache.get(key)?.[i] === true) n++;
    }
    return n;
  }

  /** Same contract as computeOutletKpis, from the accumulated sums. */
  valuesFor(outletCode: string, meta: OutletScopeMeta): Record<string, number> {
    const out: Record<string, number> = {};
    this.defs.forEach((def, i) => {
      if (!outletInScope(def, meta)) return;
      out[def.kpiCode] = measureToNumber(this.rawSum(outletCode, i), def.measure);
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
    // A TEXT '' is a valid exact "this column is empty in the file" match (the FE saves blank combo values that way);
    // a number that normalizes to nothing (NaN / Infinity) is not.
    if (nv === '' && typeof v !== 'string') {
      errors.push(`${list}[${idx}].${k} is not a valid value.`);
      continue;
    }
    out[k] = nv;
  }
  if (keys.length > 0 && Object.keys(out).length === keys.length && Object.values(out).every((x) => x === '')) {
    errors.push(`${list}[${idx}] matches only blank values in every column; pick at least one non-blank value.`);
    return null;
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
 * Only the fields that change what gets written are hashed (kpiCode, measure, filter, scope incl. the KPI's own type).
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
      // L4 / APPLIES-TO §5: the KPI's own scope via canonicalScopeKey — unscoped → nothing (every shared-KPI hash is
      // unchanged), exactly one type & no programs → the legacy `kpiOutletType: TYPE` (every type-tagged hash is
      // unchanged), anything else → `kpiScope: {sorted, UPPERCASED}`.
      ...canonicalScopeKey(kpiOwnScope(d)),
    }))
    .sort((a, b) => (a.kpiCode < b.kpiCode ? -1 : a.kpiCode > b.kpiCode ? 1 : 0));
  return createHash('sha256').update(stableStringify(canon)).digest('hex');
}
