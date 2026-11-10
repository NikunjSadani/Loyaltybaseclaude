'use client';

/**
 * "Product set" builder (SALES-IMPORT-PIPELINE-PLAN §6.2a, §11 F-6, §10c). Three ways to add an entry to the Include
 * (anyOf) or Exclude (noneOf) list:
 *   1. pick combinations seen in the chosen SOURCE — the latest processed file, or the stored month history (one
 *      month, or the N most recent stored months) — searchable, sortable, multi-select. A picked combo pins each
 *      product column its file / stored lines had to its value, a blank one included (blank = "this column is empty",
 *      not "any"); a combo whose values are ALL blank cannot be picked (the backend refuses such an entry),
 *   2. whole-value chips (e.g. a whole brand, every SKU group) — non-blank values only, from the same source,
 *   3. free entry for products not in any file yet (an empty box there means "any value").
 * The set shows as chips. Warnings are computed LIVE from the selected source (never appears in it / already included
 * by another entry / both included and excluded / cancelled by an exclusion); the last "Test" (always against the
 * latest file) adds the server's view.
 */
import Link from 'next/link';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { salesImportApi } from '@/lib/sales-import/api';
import {
  ALL_BLANK_MESSAGE, addEntries, comboEntry, comboMappingDrift, coveringEntryIndex, dimensionKeyDrift,
  entriesNotInCombos, entryKey, entryLabel, hasEntry, includeExcludeConflicts, isAllBlank, listOf, removeEntry,
  removeEntryAt, type FilterList, type NormalizeOptions,
} from '@/lib/sales-import/product-set';
import { formatCases, formatCount, formatRupees, monthLabel } from '@/lib/sales-import/format';
import {
  SALES_HISTORY_COMBOS_MAX_MONTHS, SALES_IMPORT_MAX_DIMENSION_COMBOS, SALES_KPI_MAX_FILTER_ENTRIES,
  type SalesDimensionMapping, type SalesHistoryCombos, type SalesImportCombos, type SalesKpiFilter,
} from '@/lib/sales-import/types';

export interface EntryWarnings {
  unmatched: { anyOf: number[]; noneOf: number[] };
  redundant: { anyOf: number[] };
}

const MAX_ROWS = 100;
type SortKey = { kind: 'dim'; key: string } | { kind: 'lines' | 'amount' | 'qty' };
type AddFn = (raw: Array<Record<string, unknown>>, opts?: NormalizeOptions) => void;
/** What the picker / whole-value chips read: the latest file's combos or the stored history's (same shape). */
type ComboList = Pick<SalesImportCombos, 'dimensionValues' | 'dimensionCombos'>;
type Source = 'latest' | 'history';

/** A change of the stored-months select waits this long before it is fetched (quick changes send one request). */
export const HISTORY_SELECT_DEBOUNCE_MS = 300;

/** "Last N stored months" choices offered (N ≤ SALES_HISTORY_COMBOS_MAX_MONTHS). */
const LAST_CHOICES = [1, 3, 6, 12].filter((n) => n <= SALES_HISTORY_COMBOS_MAX_MONTHS);

function historyQuery(sel: string): { month: string } | { lastMonths: number } {
  return sel.startsWith('month:') ? { month: sel.slice('month:'.length) } : { lastMonths: Number(sel.slice('last:'.length)) };
}

/** "October 2026" / "August 2026 – October 2026 (3 stored months)". */
function historyLabel(months: string[]): string {
  if (months.length === 0) return 'the stored months';
  if (months.length === 1) return monthLabel(months[0]);
  return `${monthLabel(months[0])} – ${monthLabel(months[months.length - 1])} (${months.length} stored months)`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface SourceView {
  combos: ComboList | null;
  /** How the source is named in copy: "the latest file", "October 2026", … */
  label: string;
  /** The list is a top-N cut: absence from it proves nothing, so the live "never appears" check is off. */
  capped: boolean;
  /** Distinct combos in the source (history: before the cap). */
  total: number;
  drift: { missing: string[]; extra: string[] } | null;
  /** History only: the covered months were read with different product columns. */
  keysDiffer: boolean;
}

/**
 * The stored-history source: fetched only when chosen (GET history-combos), re-fetched when the month choice changes
 * or on Retry. `key` ties a result to the request that produced it, so a stale response never shows as current.
 */
function useHistoryCombos(active: boolean, sel: string) {
  const [tick, setTick] = useState(0);
  const key = `${sel}#${tick}`;
  const [res, setRes] = useState<{ key: string; data: SalesHistoryCombos | null; error: string | null } | null>(null);
  const [availableMonths, setAvailableMonths] = useState<string[]>([]);
  /** The month choice last sent; a CHANGE of choice is debounced (first load / Retry / re-activation are not). */
  const lastSent = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    // Audit M1: a superseded request is aborted (and its late answer ignored); quick changes of the select are debounced.
    const ctrl = new AbortController();
    const load = () => {
      lastSent.current = sel;
      salesImportApi.historyCombos(historyQuery(sel), ctrl.signal)
        .then((r) => {
          if (ctrl.signal.aborted) return;
          if (r.success) {
            setRes({ key, data: r.data, error: null });
            setAvailableMonths(r.data.availableMonths);
          } else {
            setRes({ key, data: null, error: r.error });
          }
        })
        .catch((e: unknown) => { if (!ctrl.signal.aborted) setRes({ key, data: null, error: e instanceof Error ? e.message : 'Network error' }); });
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (lastSent.current !== null && lastSent.current !== sel) timer = setTimeout(load, HISTORY_SELECT_DEBOUNCE_MS);
    else load();
    return () => {
      if (timer) clearTimeout(timer);
      ctrl.abort();
    };
  }, [active, sel, key]);
  const current = res && res.key === key ? res : null;
  return {
    loading: active && current === null,
    data: current?.data ?? null,
    error: current?.error ?? null,
    availableMonths,
    retry: () => setTick((t) => t + 1),
  };
}

export function ProductSetBuilder({
  filter, onChange, dims, combos, warnings,
}: {
  filter: SalesKpiFilter;
  onChange(f: SalesKpiFilter): void;
  dims: SalesDimensionMapping[];
  combos: SalesImportCombos | null;
  /** From the last fresh "Test" (server-side); merged with the live checks. */
  warnings: EntryWarnings | null;
}) {
  const [tab, setTab] = useState<FilterList>('anyOf');
  const [note, setNote] = useState<string | null>(null);
  const baseId = useId();
  const tabRefs = useRef<Record<FilterList, HTMLButtonElement | null>>({ anyOf: null, noneOf: null });

  const [source, setSource] = useState<Source>('latest');
  const [histSel, setHistSel] = useState('last:1');
  const history = useHistoryCombos(source === 'history', histSel);

  const include = listOf(filter, 'anyOf');
  const exclude = listOf(filter, 'noneOf');

  const view: SourceView = useMemo(() => {
    if (source === 'latest') {
      const list = combos?.dimensionCombos ?? [];
      return {
        combos, label: 'the latest file', capped: list.length >= SALES_IMPORT_MAX_DIMENSION_COMBOS, total: list.length,
        drift: comboMappingDrift(list, dims), keysDiffer: false,
      };
    }
    const h = history.data;
    return {
      combos: h,
      label: historyLabel(h?.months ?? []),
      capped: Boolean(h && h.totalCombos > h.dimensionCombos.length),
      total: h?.totalCombos ?? 0,
      // The set header's keys; a header without keys (e.g. a backfilled one) falls back to the combos' own keys.
      drift: h ? (h.dimensionKeys.length ? dimensionKeyDrift(h.dimensionKeys, dims) : comboMappingDrift(h.dimensionCombos, dims)) : null,
      keysDiffer: Boolean(h?.dimensionKeysDiffer),
    };
  }, [source, combos, history.data, dims]);

  const live = useMemo(
    () => entriesNotInCombos(filter, view.combos?.dimensionCombos, SALES_IMPORT_MAX_DIMENSION_COMBOS, view.capped),
    [filter, view],
  );
  const conflicts = useMemo(() => includeExcludeConflicts(filter), [filter]);
  const drift = view.drift;

  function add(list: FilterList, raw: Array<Record<string, unknown>>, opts: NormalizeOptions = {}) {
    const r = addEntries(filter, list, raw, { ...opts, max: SALES_KPI_MAX_FILTER_ENTRIES });
    const parts: string[] = [];
    if (r.allBlank > 0) parts.push(`${r.allBlank} skipped: ${ALL_BLANK_MESSAGE}`);
    if (r.duplicates > 0) parts.push(`${r.duplicates} already in the set — skipped.`);
    if (r.overCap > 0) {
      parts.push(`${r.overCap} not added: a list can hold at most ${SALES_KPI_MAX_FILTER_ENTRIES} entries. ` +
        'Use a whole-value chip (e.g. a whole brand) to cover many combinations with one entry.');
    }
    setNote(parts.length ? parts.join(' ') : null);
    if (r.added > 0) onChange(r.filter);
  }

  function chipWarning(list: FilterList, i: number): string | null {
    const entries = listOf(filter, list);
    const label = entryLabel(entries[i], dims);
    const own = (k: 'include' | 'exclude') => conflicts.filter((c) => (k === 'include' ? c.include : c.exclude) === i);
    if (list === 'anyOf') {
      const c = own('include')[0];
      if (c) {
        return c.kind === 'same'
          ? `${label} is both included and excluded, so it counts nothing.`
          : `${label} counts nothing: "except ${entryLabel(exclude[c.exclude], dims)}" removes all of it.`;
      }
    } else {
      const c = own('exclude')[0];
      if (c) {
        return c.kind === 'same'
          ? `${label} is both included and excluded.`
          : `This exclusion removes all of the included ${entryLabel(include[c.include], dims)}.`;
      }
    }
    if (live?.[list].includes(i)) return `${label} never appears in ${view.label}. Check the spelling or size.`;
    if (warnings?.unmatched[list].includes(i)) return `${label} never appears in the latest file. Check the spelling or size.`;
    if (list === 'anyOf') {
      const by = coveringEntryIndex(include, i);
      if (by >= 0) return `${label} is already included by ${entryLabel(include[by], dims)}.`;
      if (warnings?.redundant.anyOf.includes(i)) return `${label} is already included by another entry.`;
    }
    return null;
  }

  const tabs: FilterList[] = ['anyOf', 'noneOf'];
  function onTabKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const idx = tabs.indexOf(tab);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
      : (idx + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setTab(tabs[next]);
    tabRefs.current[tabs[next]]?.focus();
  }
  const tabId = (l: FilterList) => `${baseId}-tab-${l}`;
  const panelId = `${baseId}-panel`;

  return (
    <div className="space-y-3" data-testid="product-set-builder">
      {/* Current set as chips */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 space-y-2">
        <p className="text-xs font-medium text-gray-600">Products counted</p>
        <div className="flex flex-wrap gap-1.5" data-testid="product-set-chips">
          {include.length === 0 && <span className="text-xs text-gray-700">All products{exclude.length ? '' : ' in the file'}</span>}
          {include.map((e, i) => (
            <Chip key={`in-${entryKey(e)}`} label={entryLabel(e, dims)} warning={chipWarning('anyOf', i)}
              onRemove={() => onChange(removeEntryAt(filter, 'anyOf', i))} />
          ))}
          {exclude.map((e, i) => (
            <Chip key={`ex-${entryKey(e)}`} label={`except ${entryLabel(e, dims)}`} warning={chipWarning('noneOf', i)} exclude
              onRemove={() => onChange(removeEntryAt(filter, 'noneOf', i))} />
          ))}
        </div>
        <p className="text-[11px] text-gray-500">
          A line is counted when it matches at least one included entry and no excluded entry. A line matching two
          entries is counted once.
          {view.capped && (
            <span data-testid="product-set-capped-note">
              {source === 'latest'
                ? ' The latest file has too many product combinations to check every entry here — press Test to check them.'
                : ` ${capitalize(view.label)} has ${formatCount(view.total)} product combinations; only the ` +
                  `${formatCount(view.combos?.dimensionCombos.length ?? 0)} largest by ₹ are listed, so entries are not checked against it here.`}
            </span>
          )}
        </p>
      </div>

      {/* Source of the pick list (WAI-ARIA radio group; the month choice is a labelled select). */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="product-set-source">
        <span id={`${baseId}-source`} className="text-xs font-medium text-gray-700">Pick products from</span>
        <div role="radiogroup" aria-labelledby={`${baseId}-source`} className="flex gap-4 text-xs text-gray-800">
          {(['latest', 'history'] as Source[]).map((s) => (
            <label key={s} className="flex items-center gap-1.5">
              <input type="radio" name={`${baseId}-source`} value={s} checked={source === s} onChange={() => setSource(s)} />
              {s === 'latest' ? 'Latest file' : 'Stored month(s)'}
            </label>
          ))}
        </div>
        {source === 'history' && (
          <select value={histSel} onChange={(e) => setHistSel(e.target.value)} aria-label="Stored months to pick from"
            className="text-xs border border-gray-300 rounded-md px-1.5 py-1">
            {LAST_CHOICES.map((n) => (
              <option key={n} value={`last:${n}`}>{n === 1 ? 'Most recent stored month' : `Last ${n} stored months`}</option>
            ))}
            {history.availableMonths.map((m) => <option key={m} value={`month:${m}`}>{monthLabel(m)}</option>)}
          </select>
        )}
      </div>
      {source === 'history' && (
        <p className="text-[11px] text-gray-500 -mt-1">
          Stored months hold the lines of the file last applied to each month (every customer). &ldquo;Last N&rdquo; means
          the N most recent months that have stored lines. Test still checks against the latest file.
        </p>
      )}

      {source === 'history' && history.data && history.data.unavailableMonths.length > 0 && (
        <p role="status" className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2" data-testid="product-set-unavailable">
          {history.data.unavailableMonths.length === 1 ? 'The product list for ' : 'The product lists for '}
          {history.data.unavailableMonths.map(monthLabel).join(', ')}{' '}
          {history.data.unavailableMonths.length === 1 ? "isn't" : "aren't"} available — re-apply{' '}
          {history.data.unavailableMonths.length === 1 ? 'the month' : 'those months'} (
          <Link href="/admin/sales-import/months" className="underline font-medium">Months page</Link>) to rebuild it.
          {history.data.months.length > history.data.unavailableMonths.length ? ' The list below leaves it out.' : ''}
        </p>
      )}

      {(drift || view.keysDiffer) && (
        <p role="status" className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2" data-testid="product-set-mapping-drift">
          {drift && (source === 'latest' ? (
            <>
              The latest processed file was read with a different column mapping
              {drift.missing.length ? ` (it has no ${drift.missing.map((k) => dims.find((d) => d.key === k)?.label ?? k).join(', ')} column)` : ''}.
              Picks from it only pin the columns that file had. Reprocess or upload a file with the current mapping for
              an up-to-date list.
            </>
          ) : (
            <>
              The stored lines of {view.label} were read with a different column mapping
              {drift.missing.length ? ` (they have no ${drift.missing.map((k) => dims.find((d) => d.key === k)?.label ?? k).join(', ')} column)` : ''}.
              Picks from them only pin the columns those lines had.{' '}
            </>
          ))}
          {view.keysDiffer && 'The selected months were read with different product columns in different months, so some combinations pin fewer columns.'}
        </p>
      )}

      {/* Include / Exclude tabs (WAI-ARIA tabs: arrow keys move between them) */}
      <div role="tablist" aria-label="Add products" className="flex gap-1 border-b border-gray-200">
        {tabs.map((l) => (
          <button key={l} type="button" role="tab" id={tabId(l)} aria-selected={tab === l} aria-controls={panelId}
            tabIndex={tab === l ? 0 : -1} ref={(el) => { tabRefs.current[l] = el; }}
            onClick={() => setTab(l)} onKeyDown={onTabKey}
            className={`px-3 py-1.5 text-xs font-medium -mb-px border-b-2 ${tab === l ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]' : 'border-transparent text-gray-500'}`}>
            {l === 'anyOf' ? `Include (${include.length})` : `Exclude (${exclude.length})`}
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-500" aria-live="polite">{note}</p>

      <div role="tabpanel" id={panelId} aria-labelledby={tabId(tab)} className="space-y-4">
        {source === 'history' && history.loading ? (
          <p role="status" className="text-xs text-gray-500">Loading the stored months…</p>
        ) : source === 'history' && history.error ? (
          <div role="alert" className="text-xs text-red-600 flex items-center gap-2">
            Couldn&apos;t load the stored months: {history.error}
            <Button size="sm" variant="outline" type="button" onClick={history.retry}>Retry</Button>
          </div>
        ) : (
          <>
            <ComboPicker list={tab} filter={filter} onChange={onChange} onAdd={(raw, o) => add(tab, raw, o)} dims={dims}
              combos={view.combos} sourceLabel={view.label}
              emptyText={source === 'latest'
                ? 'No processed file yet, so there is no list of products to pick from. Use the whole-value chips or type entries below — or upload a file first.'
                : history.data && history.data.months.length > 0
                  ? `${capitalize(view.label)} has no stored product combinations. Pick from the latest file, or type entries below.`
                  : 'No month has stored sales lines yet — they are kept once a month is applied from a file. Pick from the latest file, or type entries below.'} />
            <WholeValueChips list={tab} onAdd={(raw, o) => add(tab, raw, o)} dims={dims} combos={view.combos} />
          </>
        )}
        <FreeEntry list={tab} onAdd={(raw) => add(tab, raw)} dims={dims} />
      </div>
    </div>
  );
}

function Chip({ label, warning, onRemove, exclude }: { label: string; warning: string | null; onRemove(): void; exclude?: boolean }) {
  const cls = warning
    ? 'bg-amber-50 border-amber-300 text-amber-800'
    : exclude ? 'bg-red-50 border-red-200 text-red-700' : 'bg-white border-gray-300 text-gray-800';
  return (
    <span className={`inline-flex flex-col rounded-lg border px-2 py-1 text-xs ${cls}`} data-testid="product-set-chip" title={warning ?? undefined}>
      <span className="inline-flex items-center gap-1">
        {label}
        <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className="opacity-60 hover:opacity-100"><X className="w-3 h-3" /></button>
      </span>
      {warning && <span className="text-[10px] mt-0.5" data-testid="product-set-chip-warning">{warning}</span>}
    </span>
  );
}

function ComboPicker({
  list, filter, onChange, onAdd, dims, combos, sourceLabel, emptyText,
}: {
  list: FilterList; filter: SalesKpiFilter; onChange(f: SalesKpiFilter): void; onAdd: AddFn;
  dims: SalesDimensionMapping[]; combos: ComboList | null;
  /** "the latest file" / "October 2026" — named in the heading. */
  sourceLabel: string;
  /** Shown instead of the table when the source has no combos. */
  emptyText: string;
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>({ kind: 'amount' });
  const [desc, setDesc] = useState(true);

  const rows = useMemo(() => {
    const all = combos?.dimensionCombos ?? [];
    const tokens = q.trim().toUpperCase().split(/\s+/).filter(Boolean);
    const filtered = tokens.length === 0 ? all : all.filter((c) => {
      const text = dims.map((d) => c.dims[d.key] ?? '').join(' ').toUpperCase();
      return tokens.every((t) => text.includes(t));
    });
    const val = (c: (typeof all)[number]): string | number => {
      if (sort.kind === 'dim') return c.dims[sort.key] ?? '';
      if (sort.kind === 'lines') return c.lines;
      if (sort.kind === 'qty') return c.quantity;
      return Math.abs(c.amountRupees);
    };
    return [...filtered].sort((a, b) => {
      const x = val(a); const y = val(b);
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return desc ? -cmp : cmp;
    });
  }, [combos, q, sort, dims, desc]);

  if (!combos || combos.dimensionCombos.length === 0) {
    return <p className="text-xs text-gray-500">{emptyText}</p>;
  }

  const shown = rows.slice(0, MAX_ROWS);
  const current = listOf(filter, list).length;
  const pickable = rows.filter((c) => !isAllBlank(comboEntry(c.dims, dims)));
  const blankRows = rows.length - pickable.length;
  const notYetPicked = pickable.filter((c) => !hasEntry(filter, list, comboEntry(c.dims, dims)));
  const room = Math.max(0, SALES_KPI_MAX_FILTER_ENTRIES - current);
  const willAdd = Math.min(room, notYetPicked.length);

  const isActive = (key: SortKey) => JSON.stringify(key) === JSON.stringify(sort);
  const ariaSort = (key: SortKey): React.AriaAttributes['aria-sort'] =>
    (isActive(key) ? (desc ? 'descending' : 'ascending') : 'none');
  const sortBtn = (key: SortKey, label: string) => {
    const active = isActive(key);
    return (
      <button type="button" className={`font-medium ${active ? 'text-gray-900' : ''}`}
        aria-label={`Sort by ${label}`}
        onClick={() => { if (active) setDesc((v) => !v); else { setSort(key); setDesc(key.kind !== 'dim'); } }}>
        {label}{active ? (desc ? ' ↓' : ' ↑') : ''}
      </button>
    );
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-gray-700">Pick combinations from {sourceLabel}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <span className="sr-only">Search combinations</span>
          <Search className="w-3.5 h-3.5 absolute left-2 top-2 text-gray-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search, e.g. a brand"
            className="pl-7 pr-2 py-1.5 text-xs border border-gray-300 rounded-md w-56" />
        </label>
        <Button size="sm" variant="outline" type="button" disabled={willAdd === 0}
          onClick={() => onAdd(notYetPicked.slice(0, room).map((c) => comboEntry(c.dims, dims)), { keepBlank: true })}>
          Select all {q.trim() ? `"${q.trim()}" ` : ''}({willAdd})
        </Button>
        {blankRows > 0 && (
          <span className="text-[11px] text-gray-500" data-testid="combo-all-blank-note">
            {blankRows} combination{blankRows === 1 ? '' : 's'} with every product column blank cannot be picked.
          </span>
        )}
        {notYetPicked.length > room && (
          <span className="text-[11px] text-amber-700">
            Only {room} more fit (max {SALES_KPI_MAX_FILTER_ENTRIES} entries) — narrow the search or use a whole-value chip.
          </span>
        )}
      </div>
      <div className="max-h-72 overflow-auto border border-gray-200 rounded-lg">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-gray-50">
            <tr className="text-left text-gray-500">
              <th className="px-2 py-1 w-6"><span className="sr-only">Pick</span></th>
              {dims.map((d) => <th key={d.key} className="px-2 py-1" aria-sort={ariaSort({ kind: 'dim', key: d.key })}>{sortBtn({ kind: 'dim', key: d.key }, d.label)}</th>)}
              <th className="px-2 py-1 text-right" aria-sort={ariaSort({ kind: 'lines' })}>{sortBtn({ kind: 'lines' }, 'Lines')}</th>
              <th className="px-2 py-1 text-right" aria-sort={ariaSort({ kind: 'amount' })}>{sortBtn({ kind: 'amount' }, '₹')}</th>
              <th className="px-2 py-1 text-right" aria-sort={ariaSort({ kind: 'qty' })}>{sortBtn({ kind: 'qty' }, 'Cases')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => {
              const entry = comboEntry(c.dims, dims);
              const checked = hasEntry(filter, list, entry);
              const name = entryLabel(entry, dims);
              const full = !checked && current >= SALES_KPI_MAX_FILTER_ENTRIES;
              const allBlank = isAllBlank(entry);
              return (
                <tr key={entryKey(entry)} className="border-t border-gray-100">
                  <td className="px-2 py-1">
                    <input type="checkbox" aria-label={allBlank ? 'Cannot pick: every product column is blank' : `Pick ${name}`}
                      checked={checked} disabled={full || allBlank}
                      title={allBlank ? ALL_BLANK_MESSAGE : full ? `The list is full (${SALES_KPI_MAX_FILTER_ENTRIES} entries)` : undefined}
                      onChange={() => (checked ? onChange(removeEntry(filter, list, entry)) : onAdd([entry], { keepBlank: true }))} />
                  </td>
                  {dims.map((d) => <td key={d.key} className="px-2 py-1 text-gray-800">{c.dims[d.key] || <span className="text-gray-400">(blank)</span>}</td>)}
                  <td className="px-2 py-1 text-right text-gray-600">{formatCount(c.lines)}</td>
                  <td className="px-2 py-1 text-right text-gray-600">{formatRupees(c.amountRupees)}</td>
                  <td className="px-2 py-1 text-right text-gray-600">{formatCases(c.quantity)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > MAX_ROWS && <p className="text-[11px] text-gray-500">Showing {MAX_ROWS} of {formatCount(rows.length)} — search to narrow down.</p>}
    </div>
  );
}

function WholeValueChips({
  list, onAdd, dims, combos,
}: { list: FilterList; onAdd: AddFn; dims: SalesDimensionMapping[]; combos: ComboList | null }) {
  const [picked, setDimKey] = useState(dims[0]?.key ?? '');
  const dim = dims.find((d) => d.key === picked) ?? dims[0];
  const dimKey = dim?.key ?? '';
  // Non-blank values only: a whole-column "(blank)" entry would match only lines with that column empty and is
  // refused by the backend when it is the entry's only value.
  const values = (combos?.dimensionValues?.[dimKey] ?? []).filter((v) => v.value.trim() !== '');
  if (!dim || values.length === 0) return null;
  const verb = list === 'anyOf' ? 'Add' : 'Exclude';
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-gray-700">{verb} a whole</p>
        {dims.length > 1 ? (
          <select value={dimKey} onChange={(e) => setDimKey(e.target.value)} aria-label="Whole-value column"
            className="text-xs border border-gray-300 rounded-md px-1.5 py-1">
            {dims.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
        ) : <span className="text-xs text-gray-700">{dim.label}</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {values.slice(0, 40).map((v) => (
          <button key={v.value} type="button"
            onClick={() => onAdd([{ [dim.key]: v.value }])}
            aria-label={`${verb} all of ${v.value}`}
            className="inline-flex items-center gap-1 text-xs border border-gray-300 rounded-full px-2 py-0.5 hover:border-[var(--brand-primary)]">
            <Plus className="w-3 h-3" />{v.value}
          </button>
        ))}
      </div>
    </div>
  );
}

function FreeEntry({ list, onAdd, dims }: { list: FilterList; onAdd(raw: Array<Record<string, unknown>>): void; dims: SalesDimensionMapping[] }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  if (dims.length === 0) {
    return <p className="text-xs text-gray-500">Add product columns to the column mapping to build a product set.</p>;
  }
  function submit() {
    if (!dims.some((d) => (vals[d.key] ?? '').trim() !== '')) { setErr('Type at least one value.'); return; }
    setErr(null);
    onAdd([vals]);
    setVals({});
  }
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-gray-700">Type an entry (for products not in a file yet)</p>
      <div className="flex flex-wrap items-end gap-2">
        {dims.map((d, i) => (
          <label key={d.key} className="text-[11px] text-gray-500">
            {d.label}{i > 0 ? ' (optional)' : ''}
            <input value={vals[d.key] ?? ''} onChange={(e) => setVals((p) => ({ ...p, [d.key]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
              aria-label={`Free entry ${d.label}`}
              aria-invalid={err ? true : undefined}
              className="block mt-0.5 px-2 py-1 text-xs border border-gray-300 rounded-md w-36" />
          </label>
        ))}
        <Button size="sm" variant="outline" type="button" onClick={submit}><Plus className="w-3.5 h-3.5" /> {list === 'anyOf' ? 'Include' : 'Exclude'}</Button>
      </div>
      <p className="text-xs text-red-600" aria-live="assertive" data-testid="free-entry-error">{err}</p>
      <p className="text-[11px] text-gray-400">Leave a column empty to mean &ldquo;all&rdquo; (e.g. only a brand = every size of it).</p>
    </div>
  );
}
