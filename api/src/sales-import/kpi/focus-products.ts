/**
 * FOCUS-FROM-TARGETS (platform/docs/plans/FOCUS-FROM-TARGETS-DESIGN.md) — PURE, no DB.
 *
 * Reads the per-outlet focus product names a month's target file carries (OutletTarget.targetValues.__names[kpiCode],
 * e.g. "CNO & ADHO500") against the tenant's known products, decides per outlet which products a TARGET_NAMES KPI
 * counts, lists every blocker (no silent failures) and builds the month's reconciliation view.
 *
 * Signatures were fixed by the lead's contract stub; extra exported helpers are additive.
 */
import { createHash } from 'node:crypto';
import { normalizeDim } from '../ingest/normalize';
import type {
  DimMatch,
  FocusBlocker,
  FocusNameSummary,
  FocusTokenResolution,
  MonthFocusKpi,
  MonthReconciliation,
  SalesKpiFilter,
} from '../sales-import.contract';
import { effectiveScopeKey, outletInScope, stableStringify, type KpiDefLite } from './sales-kpi.helper';
import type { RosterOutlet } from './sales-import-data';
import type { MonthComputation } from '../apply/month-compute';

/** Max sample outlet codes on a blocker / gap. */
export const FOCUS_SAMPLE_LIMIT = 20;

/** normalizeDim(s) with ALL whitespace removed (UPPERCASE, trimmed). The token / acceptance key. */
export function focusKey(s: unknown): string {
  return normalizeDim(s).replace(/\s+/g, '');
}

/** Split a written name on `&` or `,`; trim; drop empties; de-duplicate by focusKey (first spelling kept). */
export function splitFocusName(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of String(raw ?? '').split(/[&,]/)) {
    const t = part.trim();
    if (t === '') continue;
    const k = focusKey(t);
    if (k === '' || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** A name's identity regardless of spelling / order: its tokens' keys sorted and joined with '&' ('' = no tokens). */
export function focusNameKey(raw: string): string {
  return splitFocusName(raw)
    .map(focusKey)
    .sort()
    .join('&');
}

/** Every known product combination, indexed by the focusKey of each dims PREFIX (design §3). */
export interface FocusCatalogue {
  /** The profile's dimension keys IN PROFILE ORDER (Bajaj: ['brand', 'skuGroup']). */
  dimensionKeys: string[];
  /** prefix key → the DISTINCT DimMatches it can mean (1 = MATCHED, >1 = AMBIGUOUS). */
  byKey: ReadonlyMap<string, DimMatch[]>;
  /** Number of distinct combos the catalogue was built from (0 = nothing to check against). */
  size: number;
}

/** Build the catalogue from normalized dims records (aggregate / history-combo `dims`). */
export function buildFocusCatalogue(dimensionKeys: string[], combos: Iterable<Record<string, string>>): FocusCatalogue {
  const keys = [...dimensionKeys];
  const seenCombos = new Set<string>();
  const byKeySig = new Map<string, Map<string, DimMatch>>();
  for (const combo of combos) {
    const values = keys.map((k) => normalizeDim(combo?.[k]));
    const comboSig = JSON.stringify(values);
    if (seenCombos.has(comboSig)) continue;
    seenCombos.add(comboSig);
    let key = '';
    const match: DimMatch = {};
    for (let i = 0; i < keys.length; i++) {
      const v = values[i];
      if (v === '') break; // a blank value ends the prefix
      key += focusKey(v);
      match[keys[i]] = v;
      let set = byKeySig.get(key);
      if (!set) byKeySig.set(key, (set = new Map()));
      const m = { ...match };
      set.set(stableStringify(m), m);
    }
  }
  const byKey = new Map<string, DimMatch[]>();
  for (const [k, set] of byKeySig) {
    byKey.set(
      k,
      [...set.entries()].sort((a, b) => cmp(a[0], b[0])).map(([, m]) => m),
    );
  }
  // No product columns → no product can be named (every combo would be the empty prefix): an EMPTY catalogue, so the
  // upload check reports NO_PRODUCT_LIST instead of "checked" with every token unmatched.
  return { dimensionKeys: keys, byKey, size: keys.length === 0 ? 0 : seenCombos.size };
}

/** Resolve one token (no acceptance applied). */
export function resolveFocusToken(token: string, catalogue: FocusCatalogue): FocusTokenResolution {
  const t = String(token ?? '').trim();
  const key = focusKey(t);
  const found = key === '' ? [] : (catalogue.byKey.get(key) ?? []);
  if (found.length === 1) return { token: t, key, status: 'MATCHED', product: { ...found[0] } };
  if (found.length === 0) return { token: t, key, status: 'UNMATCHED' };
  return { token: t, key, status: 'AMBIGUOUS', candidates: found.map((m) => ({ ...m })) };
}

/** One month's target row for an outlet, keyed by the ROSTER (stored) outlet code. */
export interface MonthTargetRow {
  /** kpiCode → numeric target (non-numeric / blank cells absent). */
  values: Record<string, number>;
  /** kpiCode → name as written (from targetValues.__names). */
  names: Record<string, string>;
}

export interface FocusAcceptanceInfo {
  byName: string;
  at: string; // ISO
}

export interface MonthFocusInput {
  month: string;
  /** The ENABLED definitions (TARGET_NAMES ones have productSource === 'TARGET_NAMES'). */
  defs: readonly KpiDefLite[];
  /** kpiCode → display label. */
  labelOf: ReadonlyMap<string, string>;
  /** Stored outlet code → meta (loadRosterMeta). */
  roster: ReadonlyMap<string, RosterOutlet>;
  /** ROSTER outlet code → the month's target row (already mapped through the normalized roster index). */
  targets: ReadonlyMap<string, MonthTargetRow>;
  catalogue: FocusCatalogue;
  /** `${kpiCode}|${key}` → who accepted the UNMATCHED token as "not sold yet" for this month. */
  acceptances: ReadonlyMap<string, FocusAcceptanceInfo>;
}

export interface MonthFocusResolution {
  /** TARGET_NAMES kpiCode → roster outlet code → the filter to use for that outlet. Outlet ABSENT = key omitted. */
  outletFilters: ReadonlyMap<string, ReadonlyMap<string, SalesKpiFilter>>;
  /** TARGET_NAMES kpiCode → roster outlet code → the name key the outlet carries (for achieved-by-name). */
  outletNameKeys: ReadonlyMap<string, ReadonlyMap<string, string>>;
  blockers: FocusBlocker[];
  /** Focus summaries with `achieved` zeroed (buildMonthReconciliation fills it from the computed rows). */
  focus: MonthFocusKpi[];
  /** design §5; '' when no enabled TARGET_NAMES definition. */
  fingerprint: string;
}

/** The acceptance key of an UNMATCHED token for a KPI (SalesFocusAcceptance kpiCode + key). */
export function focusAcceptanceKey(kpiCode: string, key: string): string {
  return `${kpiCode}|${key}`;
}

/**
 * FOCUS-NAMES-FROM-KPI: the KPI code whose per-outlet names a TARGET_NAMES definition reads — its own kpiCode, or the
 * code it borrows (`focusNamesFromKpi`, e.g. FB1 CASES → FOCUS BRAND).
 */
export function focusNamesKpiOf(def: Pick<KpiDefLite, 'kpiCode' | 'focusNamesFromKpi'>): string {
  return def.focusNamesFromKpi && def.focusNamesFromKpi.trim() !== '' ? def.focusNamesFromKpi : def.kpiCode;
}

/** Is the definition per-outlet (products from the target file)? */
export function isTargetNamesDef(def: Pick<KpiDefLite, 'productSource'>): boolean {
  return def.productSource === 'TARGET_NAMES';
}

/** A filter no real line matches (all of a name's tokens accepted as "not sold yet" → value 0, never ALL lines). */
export function matchNothingFilter(dimensionKeys: readonly string[]): SalesKpiFilter {
  return { anyOf: [{ [dimensionKeys[0] ?? '__none']: '\u0000NO_PRODUCT' }] };
}

/** "Focus Brand 1 (FOCUS BRAND)" — or just the code when the label is the code. */
export function focusKpiDisplay(kpiCode: string, labelOf: ReadonlyMap<string, string>): string {
  const label = (labelOf.get(kpiCode) ?? '').trim();
  return label === '' || label === kpiCode ? kpiCode : `${label} (${kpiCode})`;
}

/** "brand AB + SKU group C" for the screen. */
export function describeDimMatch(m: DimMatch): string {
  return Object.keys(m)
    .map((k) => `${humanDim(k)} ${m[k]}`)
    .join(' + ');
}

function humanDim(k: string): string {
  return k
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\bsku\b/g, 'SKU');
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const outletsText = (n: number) => `${n} ${plural(n, 'outlet', 'outlets')}`;

function orList(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}`;
}

function sample(codes: Iterable<string>): string[] {
  return [...codes].sort(cmp).slice(0, FOCUS_SAMPLE_LIMIT);
}

interface NameGroup {
  key: string;
  tokenKeys: string[];
  spellings: Map<string, number>;
  outlets: string[];
  byType: Record<string, number>;
  filter: SalesKpiFilter;
}

/** design §3–§5 for one month. Deterministic (sorted output) so the fingerprint is stable. */
export function resolveMonthFocus(input: MonthFocusInput): MonthFocusResolution {
  const tnDefs = input.defs.filter(isTargetNamesDef);
  if (tnDefs.length === 0) {
    return { outletFilters: new Map(), outletNameKeys: new Map(), blockers: [], focus: [], fingerprint: '' };
  }
  const { catalogue } = input;
  const resolutionCache = new Map<string, FocusTokenResolution>();
  const resolveKey = (token: string): FocusTokenResolution => {
    const k = focusKey(token);
    let r = resolutionCache.get(k);
    if (!r) resolutionCache.set(k, (r = resolveFocusToken(token, catalogue)));
    return r;
  };
  const noMatch = matchNothingFilter(catalogue.dimensionKeys);
  const rosterSorted = [...input.roster.entries()].sort((a, b) => cmp(a[0], b[0]));

  const outletFilters = new Map<string, Map<string, SalesKpiFilter>>();
  const outletNameKeys = new Map<string, Map<string, string>>();
  const blockers: FocusBlocker[] = [];
  const focus: MonthFocusKpi[] = [];
  const fpPerOutlet: Array<[string, string, string]> = [];
  const fpMissing: Array<[string, string]> = [];
  const fpBlankNames: Array<[string, string, string]> = [];
  const fpAccepted = new Set<string>();
  const fpResolutions = new Map<string, unknown>(); // name key → its token resolutions

  // FOCUS-NAMES-FROM-KPI: the codes a borrowing definition may read from = enabled TARGET_NAMES defs reading their OWN
  // names (one level only, matching the save-time validation). Blockers are collected per definition and emitted in
  // the same kpiCode order as before; a borrower's UNMATCHED / AMBIGUOUS blockers that its source already reports are
  // dropped (one fix / acceptance on the source clears both).
  const ownNameCodes = new Set(tnDefs.filter((d) => focusNamesKpiOf(d) === d.kpiCode).map((d) => d.kpiCode));
  const blockersByDef = new Map<string, FocusBlocker[]>();
  const borrowedFrom = new Map<string, string>(); // borrower kpiCode → source kpiCode
  // De-dupe identity of a key-less blocker (separator-only names: the name as written). Internal only — the blocker
  // payload stays exactly as before (no `key`).
  const dedupeKeyOf = new Map<FocusBlocker, string>();

  for (const def of [...tnDefs].sort((a, b) => cmp(a.kpiCode, b.kpiCode))) {
    const kpiCode = def.kpiCode;
    const nameKpi = focusNamesKpiOf(def);
    const defBlockers: FocusBlocker[] = [];
    blockersByDef.set(kpiCode, defBlockers);
    const display = focusKpiDisplay(kpiCode, input.labelOf);
    const label = (input.labelOf.get(kpiCode) ?? '').trim() || kpiCode;
    if (nameKpi !== kpiCode) {
      borrowedFrom.set(kpiCode, nameKpi);
      if (!ownNameCodes.has(nameKpi)) {
        // The source is not an enabled own-names TARGET_NAMES definition: no outlet gets a value (omitted, never a
        // silent 0) and the month is blocked until the source is fixed.
        outletFilters.set(kpiCode, new Map());
        outletNameKeys.set(kpiCode, new Map());
        const inScope = rosterSorted.filter(([, meta]) => outletInScope(def, meta)).map(([code]) => code);
        defBlockers.push({
          code: 'FOCUS_SOURCE_MISSING',
          kpiCode,
          outlets: inScope.length,
          sampleOutletCodes: sample(inScope),
          message: `${display} uses the focus product names of "${nameKpi}", but "${nameKpi}" is not an enabled Sales Import KPI whose products come from the target file. Fix it in Sales Import settings.`,
        });
        fpMissing.push([kpiCode, `\u0000SOURCE:${nameKpi}`]);
        focus.push({ kpiCode, label, measure: def.measure, names: [], missingName: { outlets: 0, sampleOutletCodes: [] } });
        continue;
      }
      const src = tnDefs.find((d) => d.kpiCode === nameKpi)!;
      if (effectiveScopeKey(def) !== effectiveScopeKey(src)) {
        // Same names but a different set of outlets would NOT be the same product set per outlet (e.g. the KPI's
        // applies-to changed in KPI settings after saving). Block: no outlet gets a value until the scopes match.
        outletFilters.set(kpiCode, new Map());
        outletNameKeys.set(kpiCode, new Map());
        const inScope = rosterSorted.filter(([, meta]) => outletInScope(def, meta)).map(([code]) => code);
        defBlockers.push({
          code: 'FOCUS_SCOPE_MISMATCH',
          kpiCode,
          outlets: inScope.length,
          sampleOutletCodes: sample(inScope),
          message: `${display} uses the focus product names of ${focusKpiDisplay(nameKpi, input.labelOf)}, but the two apply to different outlets. Make the outlet types / programmes (Sales Import settings) and the KPI's applies-to (KPI settings) the same for both.`,
        });
        fpMissing.push([kpiCode, `\u0000SCOPE:${nameKpi}`]);
        focus.push({ kpiCode, label, measure: def.measure, names: [], missingName: { outlets: 0, sampleOutletCodes: [] } });
        continue;
      }
    }
    // An UNMATCHED token is accepted when accepted for this KPI or (borrower) for the KPI whose names it reads.
    const acceptanceOf = (key: string): { ak: string; info: FocusAcceptanceInfo } | null => {
      for (const code of nameKpi === kpiCode ? [kpiCode] : [kpiCode, nameKpi]) {
        const ak = focusAcceptanceKey(code, key);
        const info = input.acceptances.get(ak);
        if (info) return { ak, info };
      }
      return null;
    };
    const sourceDef = nameKpi === kpiCode ? undefined : tnDefs.find((d) => d.kpiCode === nameKpi);
    const filters = new Map<string, SalesKpiFilter>();
    const nameKeys = new Map<string, string>();
    const groups = new Map<string, NameGroup>();
    const unmatched = new Map<string, { token: string; outlets: Set<string> }>();
    const ambiguous = new Map<string, { token: string; candidates: DimMatch[]; outlets: Set<string> }>();
    const missing: string[] = [];
    const separatorOnly = new Map<string, Set<string>>(); // name as written → outlets
    let inScopeOutlets = 0;
    let namesWritten = 0; // in-scope outlets with ANY non-blank name for nameKpi

    for (const [code, meta] of rosterSorted) {
      if (!outletInScope(def, meta)) continue;
      inScopeOutlets++;
      const row = input.targets.get(code);
      const rawName = row?.names?.[nameKpi];
      const name = typeof rawName === 'string' ? rawName.trim() : '';
      const t = row?.values?.[kpiCode];
      let hasTarget = typeof t === 'number' && Number.isFinite(t);
      if (sourceDef && !hasTarget) {
        // FOCUS-NAMES-FROM-KPI: a borrower usually has NO target of its own (cases achieved only, e.g. Bajaj FB1 CASES).
        // An outlet with a SOURCE target but no name gets no cases value either → flag it on the borrower too, unless
        // the source already flags that same outlet (in the source's scope) — one blocker per outlet, fixed once.
        const st = row?.values?.[nameKpi];
        const srcHasTarget = typeof st === 'number' && Number.isFinite(st);
        hasTarget = srcHasTarget && !outletInScope(sourceDef, meta);
      }
      if (name !== '') namesWritten++;
      const tokens = name === '' ? [] : splitFocusName(name);
      if (tokens.length === 0 && name !== '') {
        // Audit follow-up: a written name made only of separators ("&", ",", " & ") is NOT "no name" — the operator
        // wrote something that names no product. Always a blocker (target or not); key omitted.
        let s = separatorOnly.get(name);
        if (!s) separatorOnly.set(name, (s = new Set()));
        s.add(code);
        fpBlankNames.push([kpiCode, code, name]);
        continue;
      }
      if (tokens.length === 0) {
        // §4 rows 3–4: no name → key omitted; with a numeric target it is a blocker.
        if (hasTarget) {
          missing.push(code);
          fpMissing.push([kpiCode, code]);
        }
        continue;
      }
      const tokenKeys = tokens.map(focusKey);
      const nameKey = [...tokenKeys].sort().join('&');
      let g = groups.get(nameKey);
      if (!g) {
        const products = new Map<string, DimMatch>();
        for (const tok of tokens) {
          const r = resolveKey(tok);
          if (r.status === 'MATCHED' && r.product) products.set(stableStringify(r.product), r.product);
        }
        g = {
          key: nameKey,
          tokenKeys,
          spellings: new Map(),
          outlets: [],
          byType: {},
          filter: products.size > 0 ? { anyOf: [...products.values()].map((p) => ({ ...p })) } : noMatch,
        };
        groups.set(nameKey, g);
      }
      g.spellings.set(name, (g.spellings.get(name) ?? 0) + 1);
      g.outlets.push(code);
      const type = meta.outletType ?? '';
      g.byType[type] = (g.byType[type] ?? 0) + 1;

      for (const tok of tokens) {
        const r = resolveKey(tok);
        if (r.status === 'UNMATCHED') {
          const acc = acceptanceOf(r.key);
          if (acc) {
            fpAccepted.add(acc.ak);
            continue;
          }
          let u = unmatched.get(r.key);
          if (!u) unmatched.set(r.key, (u = { token: tok.trim(), outlets: new Set() }));
          u.outlets.add(code);
        } else if (r.status === 'AMBIGUOUS') {
          let a = ambiguous.get(r.key);
          if (!a) ambiguous.set(r.key, (a = { token: tok.trim(), candidates: r.candidates ?? [], outlets: new Set() }));
          a.outlets.add(code);
        }
      }
      // Blocked outlets still get their (matched-tokens) filter so the preview shows numbers; the blocker stops apply.
      filters.set(code, g.filter);
      nameKeys.set(code, nameKey);
      fpPerOutlet.push([code, kpiCode, nameKey]);
    }

    outletFilters.set(kpiCode, filters);
    outletNameKeys.set(kpiCode, nameKeys);

    for (const [key, u] of [...unmatched.entries()].sort((a, b) => cmp(a[0], b[0]))) {
      const n = u.outlets.size;
      defBlockers.push({
        code: 'FOCUS_UNMATCHED',
        kpiCode,
        token: u.token,
        key,
        outlets: n,
        sampleOutletCodes: sample(u.outlets),
        message: `"${u.token}" in ${display} is not a product in the sales data (${outletsText(n)}). Fix the target file, or accept it as not sold yet.`,
      });
    }
    for (const [key, a] of [...ambiguous.entries()].sort((x, y) => cmp(x[0], y[0]))) {
      const n = a.outlets.size;
      defBlockers.push({
        code: 'FOCUS_AMBIGUOUS',
        kpiCode,
        token: a.token,
        key,
        outlets: n,
        sampleOutletCodes: sample(a.outlets),
        message: `"${a.token}" in ${display} could mean more than one product: ${orList(a.candidates.map(describeDimMatch))}. Write it so only one product matches (${outletsText(n)}).`,
      });
    }
    if (missing.length > 0) {
      const n = missing.length;
      defBlockers.push({
        code: 'FOCUS_MISSING_NAME',
        kpiCode,
        outlets: n,
        sampleOutletCodes: sample(missing),
        message:
          nameKpi === kpiCode
            ? `${outletsText(n)} ${plural(n, 'has', 'have')} a ${label} target but no product name in the target file.`
            : `${outletsText(n)} ${plural(n, 'has', 'have')} a target but no ${focusKpiDisplay(nameKpi, input.labelOf)} product name in the target file, so ${label} (which uses those names) gets no value for ${plural(n, 'it', 'them')}.`,
      });
    }
    // Same code (FOCUS_MISSING_NAME — cleared only by fixing the target file), its own message per name as written.
    for (const [written, outlets] of [...separatorOnly.entries()].sort((a, b) => cmp(a[0], b[0]))) {
      const n = outlets.size;
      const blocker: FocusBlocker = {
        code: 'FOCUS_MISSING_NAME',
        kpiCode,
        outlets: n,
        sampleOutletCodes: sample(outlets),
        message: `"${written}" in ${display} for ${outletsText(n)} has no product in it. Write the product name(s) in the target file.`,
      };
      dedupeKeyOf.set(blocker, `\u0000SEP:${written}`);
      defBlockers.push(blocker);
    }
    // FOCUS-NAMES-FROM-KPI: the source carries NO name at all this month (e.g. no target file yet, or its name column
    // left empty) → every outlet of the borrower would silently get no value. Block, loudly.
    if (nameKpi !== kpiCode && inScopeOutlets > 0 && namesWritten === 0) {
      defBlockers.push({
        code: 'FOCUS_NO_NAMES',
        kpiCode,
        outlets: inScopeOutlets,
        sampleOutletCodes: [],
        message: `${label}: no ${focusKpiDisplay(nameKpi, input.labelOf)} focus names in this month's target file — every outlet would get no ${label} value. Upload the target file with the focus names first, or stop importing ${label} for now.`,
      });
      fpMissing.push([kpiCode, `\u0000NONAMES:${nameKpi}`]);
    }

    const names: FocusNameSummary[] = [...groups.values()].map((g) => {
      const name = [...g.spellings.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0][0];
      const tokens = splitFocusName(name).map((tok) => {
        const r = resolveKey(tok);
        const out: FocusTokenResolution = { ...r, token: tok.trim() };
        if (r.status === 'UNMATCHED') {
          const acc = acceptanceOf(r.key)?.info;
          if (acc) out.accepted = { byName: acc.byName, at: acc.at };
        }
        return out;
      });
      return {
        name,
        key: g.key,
        outlets: g.outlets.length,
        outletsByType: g.byType,
        tokens,
        achieved: { total: 0, outletsZero: 0 },
      };
    });
    names.sort((a, b) => b.outlets - a.outlets || cmp(a.key, b.key));
    for (const g of groups.values()) {
      if (!fpResolutions.has(g.key)) {
        fpResolutions.set(
          g.key,
          [...g.tokenKeys].sort(cmp).map((k) => {
            const r = resolutionCache.get(k)!;
            return [k, r.status, r.product ?? null, r.candidates ?? null];
          }),
        );
      }
    }
    focus.push({
      kpiCode,
      label,
      measure: def.measure,
      names,
      missingName: { outlets: missing.length, sampleOutletCodes: sample(missing) },
    });
  }

  for (const def of [...tnDefs].sort((a, b) => cmp(a.kpiCode, b.kpiCode))) {
    const own = blockersByDef.get(def.kpiCode) ?? [];
    const src = borrowedFrom.get(def.kpiCode);
    if (src === undefined || !ownNameCodes.has(src)) {
      blockers.push(...own);
      continue;
    }
    const identity = (b: FocusBlocker): string | undefined => b.key ?? dedupeKeyOf.get(b);
    const reported = new Set(
      (blockersByDef.get(src) ?? []).filter((b) => identity(b) !== undefined).map((b) => `${b.code}|${identity(b)}`),
    );
    blockers.push(...own.filter((b) => identity(b) === undefined || !reported.has(`${b.code}|${identity(b)}`)));
  }

  const tupleCmp = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = cmp(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  };
  const fingerprint = createHash('sha256')
    .update(
      stableStringify({
        month: input.month,
        perOutlet: [...fpPerOutlet].sort(tupleCmp),
        resolutions: [...fpResolutions.entries()].sort((a, b) => cmp(a[0], b[0])),
        accepted: [...fpAccepted].sort(cmp),
        missing: [...fpMissing].sort(tupleCmp),
        blankNames: [...fpBlankNames].sort(tupleCmp),
      }),
    )
    .digest('hex');

  return { outletFilters, outletNameKeys, blockers, focus, fingerprint };
}

/**
 * The definitions to evaluate the month with: every TARGET_NAMES definition gets `outletFilter` from the resolution;
 * FILTER definitions are returned AS THE SAME OBJECTS (their scope caches stay warm, values byte-identical).
 */
export function attachOutletFilters(defs: readonly KpiDefLite[], res: MonthFocusResolution): KpiDefLite[] {
  return defs.map((def) => {
    if (!isTargetNamesDef(def)) return def;
    const filters = res.outletFilters.get(def.kpiCode);
    return { ...def, outletFilter: (code: string) => filters?.get(code) };
  });
}

const round = (x: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

/** design §6: the month's MonthReconciliation from the resolution + the computed rows. */
export function buildMonthReconciliation(args: {
  input: MonthFocusInput;
  resolution: MonthFocusResolution;
  comp: MonthComputation;
  /** Latest target upload batch time for the month (null = none). */
  targetUploadedAt: Date | null;
  /** Importer-owned KPI codes (all enabled definitions). */
  ownedKpiCodes: readonly string[];
}): MonthReconciliation {
  const { input, resolution, comp, targetUploadedAt, ownedKpiCodes } = args;
  const numeric = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const measureOf = new Map(input.defs.map((d) => [d.kpiCode, d.measure]));

  const kpis = ownedKpiCodes.map((kpiCode) => {
    let outlets = 0;
    let total = 0;
    for (const row of input.targets.values()) {
      const v = row.values?.[kpiCode];
      if (!numeric(v)) continue;
      outlets++;
      total += v;
    }
    return {
      kpiCode,
      label: (input.labelOf.get(kpiCode) ?? '').trim() || kpiCode,
      outletsWithTarget: outlets,
      totalTarget: round(total, 2),
      // Owned KPIs are exactly the enabled definitions, so the measure is always known ('AMOUNT' is unreachable).
      measure: measureOf.get(kpiCode) ?? 'AMOUNT',
    };
  });

  const valuesOf = new Map(comp.rows.map((r) => [r.outletCode, r.values]));
  const focus: MonthFocusKpi[] = resolution.focus.map((f) => {
    const nameKeys = resolution.outletNameKeys.get(f.kpiCode);
    const achieved = new Map<string, { total: number; outletsZero: number }>();
    for (const [code, key] of nameKeys ?? []) {
      let a = achieved.get(key);
      if (!a) achieved.set(key, (a = { total: 0, outletsZero: 0 }));
      const v = valuesOf.get(code)?.[f.kpiCode];
      if (numeric(v)) a.total += v;
      if (!numeric(v) || v === 0) a.outletsZero++;
    }
    return {
      ...f,
      names: f.names.map((n) => {
        const a = achieved.get(n.key) ?? { total: 0, outletsZero: 0 };
        return { ...n, achieved: { total: round(a.total, 6), outletsZero: a.outletsZero } };
      }),
    };
  });

  const owned = [...ownedKpiCodes];
  const targetNoSales: string[] = [];
  const salesNoTarget: string[] = [];
  for (const code of input.roster.keys()) {
    const row = input.targets.get(code);
    const hasSales = comp.matchedOutletCodes.has(code);
    if (!hasSales && row && owned.some((k) => numeric(row.values?.[k]))) targetNoSales.push(code);
    if (hasSales && !row) salesNoTarget.push(code);
  }

  return {
    targets: {
      kpis,
      targetUploadedAt: targetUploadedAt ? targetUploadedAt.toISOString() : null,
      newerThanLastApply: false,
    },
    focus,
    blockers: resolution.blockers,
    gaps: {
      targetNoSales: { outlets: targetNoSales.length, sampleOutletCodes: sample(targetNoSales) },
      salesNoTarget: { outlets: salesNoTarget.length, sampleOutletCodes: sample(salesNoTarget) },
    },
    focusFingerprint: resolution.fingerprint,
  };
}
