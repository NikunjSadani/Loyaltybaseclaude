/**
 * Sales Import — "Product set" builder logic (plan §6.2a, §11 F-6). Pure functions only; the React builder in
 * app/admin/sales-import/settings/_components uses these.
 *
 * A KPI filter is a SET: a line is IN iff (anyOf empty OR it matches ≥1 anyOf entry) AND it matches no noneOf
 * entry. Entries are DimMatch objects whose keys ⊆ the profile's dimension keys; values are normalized the same
 * way the backend does (normalizeDim, api/src/sales-import/ingest/normalize.ts) so "adho " / "ADHO" are one value.
 */
import {
  SALES_KPI_MAX_FILTER_ENTRIES,
  type DimMatch,
  type SalesDimensionMapping,
  type SalesKpiFilter,
} from './types';

export type FilterList = 'anyOf' | 'noneOf';

/**
 * EXACT mirror of the backend `normalizeDim` (api/src/sales-import/ingest/normalize.ts): number → canonical string;
 * string → trim, collapse spaces, uppercase, and a pure decimal string loses trailing fractional zeros ("500.0" → "500",
 * leading zeros kept). Must stay byte-for-byte equivalent or a typed "500.0" chip never matches the file's "500"
 * combo; the shared vectors in `__tests__/product-set.test.ts` mirror `normalize.spec.ts`.
 */
export function normalizeDim(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const s = String(v).trim().replace(/\s+/g, ' ').toUpperCase();
  return /^-?\d+\.\d+$/.test(s) ? s.replace(/\.?0+$/, '') : s;
}

export interface NormalizeOptions {
  /**
   * Keep blank values as an EXACT-match "this column is blank" (the backend's entryMatches compares
   * `(dims[k] ?? '') === value`, so `{skuGroup:''}` matches only lines whose SKU group is empty). Used for entries
   * picked from the file (combo rows, the "(blank)" whole-value chip). Default false: a blank means "any value"
   * and the key is dropped — that is what an empty free-entry box means.
   */
  keepBlank?: boolean;
}

/**
 * Normalizes every value. By default drops blank keys (`{brand:' adho ', skuGroup:''}` → `{brand:'ADHO'}`); with
 * `keepBlank` a blank stays as an exact-match value (`→ {brand:'ADHO', skuGroup:''}`).
 */
export function normalizeEntry(raw: Record<string, unknown>, opts: NormalizeOptions = {}): DimMatch {
  const out: DimMatch = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = normalizeDim(v);
    if (n !== '' || opts.keepBlank) out[k] = n;
  }
  return out;
}

/** A combo picked from the file → an entry pinning EVERY mapped column (blank included) to that combo's value. */
export function comboEntry(comboDims: DimMatch, dims: SalesDimensionMapping[]): DimMatch {
  const keys = dims.length ? dims.map((d) => d.key) : Object.keys(comboDims);
  return normalizeEntry(Object.fromEntries(keys.map((k) => [k, comboDims[k] ?? ''])), { keepBlank: true });
}

/** Does a line/combo with these dims match the entry? Mirrors backend entryMatches (missing dim = blank). */
export function entryMatchesDims(entry: DimMatch, lineDims: DimMatch): boolean {
  const keys = Object.keys(entry);
  if (keys.length === 0) return true;
  return keys.every((k) => normalizeDim(lineDims[k] ?? '') === entry[k]);
}

/** Stable identity of an entry (sorted keys) — used for de-duplication and as a React key. */
export function entryKey(e: DimMatch): string {
  return JSON.stringify(Object.keys(e).sort().map((k) => [k, e[k]]));
}

export function sameEntry(a: DimMatch, b: DimMatch): boolean {
  return entryKey(a) === entryKey(b);
}

/** True when every key of `general` is present in `specific` with an equal value (general ⊇ specific's lines). */
export function covers(general: DimMatch, specific: DimMatch): boolean {
  const keys = Object.keys(general);
  if (keys.length === 0) return false;
  return keys.every((k) => specific[k] === general[k]);
}

export function listOf(f: SalesKpiFilter, list: FilterList): DimMatch[] {
  return f[list] ?? [];
}

function withList(f: SalesKpiFilter, list: FilterList, entries: DimMatch[]): SalesKpiFilter {
  const next: SalesKpiFilter = { ...f };
  if (entries.length) next[list] = entries;
  else delete next[list];
  return next;
}

/**
 * Adds entries (normalized) to a list, skipping empty entries and exact duplicates.
 * Returns the new filter and how many were skipped as duplicates (for a "already in the set" note).
 */
export function addEntries(
  f: SalesKpiFilter,
  list: FilterList,
  raw: Array<Record<string, unknown>>,
  opts: NormalizeOptions & { max?: number } = {},
): { filter: SalesKpiFilter; added: number; duplicates: number; overCap: number } {
  const cur = [...listOf(f, list)];
  const max = opts.max ?? Infinity;
  let added = 0;
  let duplicates = 0;
  let overCap = 0;
  for (const r of raw) {
    const e = normalizeEntry(r, opts);
    if (Object.keys(e).length === 0) continue;
    if (cur.some((c) => sameEntry(c, e))) { duplicates++; continue; }
    if (cur.length >= max) { overCap++; continue; }
    cur.push(e);
    added++;
  }
  return { filter: withList(f, list, cur), added, duplicates, overCap };
}

export function removeEntryAt(f: SalesKpiFilter, list: FilterList, index: number): SalesKpiFilter {
  return withList(f, list, listOf(f, list).filter((_, i) => i !== index));
}

/** Removes the entry equal to `e` (used by un-ticking a combo row). Blank values in `e` are kept (exact match). */
export function removeEntry(f: SalesKpiFilter, list: FilterList, e: DimMatch): SalesKpiFilter {
  const n = normalizeEntry(e, { keepBlank: true });
  return withList(f, list, listOf(f, list).filter((c) => !sameEntry(c, n)));
}

export function hasEntry(f: SalesKpiFilter, list: FilterList, e: DimMatch): boolean {
  const n = normalizeEntry(e, { keepBlank: true });
  return listOf(f, list).some((c) => sameEntry(c, n));
}

/**
 * Human label for an entry chip, in mapping order: "ADHO 500"; an entry that leaves dimensions open gets
 * "(all <label>s)" — e.g. "CNO (all SKU groups)". Exclusions are prefixed by the caller ("except …").
 */
export function entryLabel(e: DimMatch, dims: SalesDimensionMapping[]): string {
  const ordered = dims.length ? dims : Object.keys(e).map((k) => ({ key: k, label: k, header: k }));
  const known = new Set(ordered.map((d) => d.key));
  const parts = ordered.filter((d) => e[d.key] !== undefined)
    .map((d) => (e[d.key] === '' ? `(blank ${d.label.trim().toLowerCase() || d.key})` : e[d.key]));
  for (const k of Object.keys(e)) if (!known.has(k)) parts.push(`${k}=${e[k] === '' ? '(blank)' : e[k]}`);
  const open = ordered.filter((d) => e[d.key] === undefined);
  const base = parts.join(' ');
  if (open.length === 0 || parts.length === 0) return base;
  return `${base} (all ${open.map((d) => pluralLabel(d.label)).join(', ')})`;
}

function pluralLabel(label: string): string {
  const l = label.trim().toLowerCase();
  if (!l) return 'values';
  return l.endsWith('s') ? l : `${l}s`;
}

/** Entries in the anyOf list that are fully covered by ANOTHER anyOf entry (client-side "already included by"). */
export function coveringEntryIndex(entries: DimMatch[], index: number): number {
  const target = entries[index];
  return entries.findIndex((e, i) => i !== index && !sameEntry(e, target) && covers(e, target));
}

export interface IncludeExcludeConflict {
  /** Index into anyOf. */
  include: number;
  /** Index into noneOf. */
  exclude: number;
  /** 'same' = the identical entry is in both lists; 'cancels' = the exclusion removes every line of the inclusion. */
  kind: 'same' | 'cancels';
}

/**
 * Include/exclude conflicts: an entry in both lists, or an exclusion that covers an inclusion (so that inclusion
 * can never count anything). Neither is invalid, but both are almost always a mistake.
 */
export function includeExcludeConflicts(f: SalesKpiFilter): IncludeExcludeConflict[] {
  const inc = listOf(f, 'anyOf');
  const exc = listOf(f, 'noneOf');
  const out: IncludeExcludeConflict[] = [];
  inc.forEach((ie, i) => {
    exc.forEach((ee, j) => {
      if (sameEntry(ie, ee)) out.push({ include: i, exclude: j, kind: 'same' });
      else if (covers(ee, ie)) out.push({ include: i, exclude: j, kind: 'cancels' });
    });
  });
  return out;
}

/**
 * Entries (by index) that match NO combo of the loaded file — computed live, without a Test call. Returns null when
 * the combo list is unavailable or was capped (≥ SALES_IMPORT_MAX_DIMENSION_COMBOS), because then "not in the list"
 * does not prove "not in the file".
 */
export function entriesNotInCombos(
  f: SalesKpiFilter,
  combos: Array<{ dims: DimMatch }> | null | undefined,
  maxCombos: number,
): { anyOf: number[]; noneOf: number[] } | null {
  if (!combos || combos.length === 0 || combos.length >= maxCombos) return null;
  const miss = (list: FilterList) => listOf(f, list).flatMap((e, i) => (combos.some((c) => entryMatchesDims(e, c.dims)) ? [] : [i]));
  return { anyOf: miss('anyOf'), noneOf: miss('noneOf') };
}

export interface FilterValidation {
  /** Blocking — save must be refused. */
  errors: string[];
}

/** Blocking checks (§6.2a): an empty entry, > 200 entries per list, a dimension key not in the mapping. */
export function validateFilter(f: SalesKpiFilter, dimKeys: string[]): FilterValidation {
  const errors: string[] = [];
  const allowed = new Set(dimKeys);
  for (const list of ['anyOf', 'noneOf'] as const) {
    const entries = listOf(f, list);
    const name = list === 'anyOf' ? 'Included products' : 'Excluded products';
    if (entries.length > SALES_KPI_MAX_FILTER_ENTRIES) {
      errors.push(`${name}: at most ${SALES_KPI_MAX_FILTER_ENTRIES} entries (has ${entries.length}).`);
    }
    entries.forEach((e, i) => {
      // A key with a blank value is a deliberate "this column is blank" match, not an empty entry.
      if (Object.keys(e).length === 0) errors.push(`${name}: entry ${i + 1} is empty. Remove it or pick a value.`);
      for (const k of Object.keys(e)) {
        if (!allowed.has(k)) errors.push(`${name}: entry ${i + 1} uses "${k}", which is not a mapped product column.`);
      }
    });
  }
  return { errors };
}

/** One-line description of a filter for the KPI table. */
export function describeFilter(f: SalesKpiFilter, dims: SalesDimensionMapping[]): string {
  const inc = listOf(f, 'anyOf');
  const exc = listOf(f, 'noneOf');
  const incText = inc.length ? inc.map((e) => entryLabel(e, dims)).join(' + ') : 'All products';
  const excText = exc.length ? ` except ${exc.map((e) => entryLabel(e, dims)).join(', ')}` : '';
  return incText + excText;
}
