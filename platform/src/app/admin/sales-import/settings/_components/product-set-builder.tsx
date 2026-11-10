'use client';

/**
 * "Product set" builder (SALES-IMPORT-PIPELINE-PLAN §6.2a, §11 F-6). Three ways to add an entry to the Include
 * (anyOf) or Exclude (noneOf) list:
 *   1. pick combinations seen in the latest processed file (searchable, sortable, multi-select) — a picked combo pins
 *      EVERY product column to its value, a blank one included (blank = "this column is empty", not "any"),
 *   2. whole-value chips (e.g. a whole brand, every SKU group; "(blank)" = lines where that column is empty),
 *   3. free entry for products not in any file yet (an empty box there means "any value").
 * The set shows as chips. Warnings are computed LIVE from the loaded file (never appears in it / already included by
 * another entry / both included and excluded / cancelled by an exclusion); the last "Test" adds the server's view.
 */
import React, { useId, useMemo, useRef, useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  addEntries, comboEntry, coveringEntryIndex, entriesNotInCombos, entryKey, entryLabel, hasEntry,
  includeExcludeConflicts, listOf, removeEntry, removeEntryAt,
  type FilterList, type NormalizeOptions,
} from '@/lib/sales-import/product-set';
import { formatCases, formatCount, formatRupees } from '@/lib/sales-import/format';
import {
  SALES_IMPORT_MAX_DIMENSION_COMBOS, SALES_KPI_MAX_FILTER_ENTRIES,
  type SalesDimensionMapping, type SalesImportCombos, type SalesKpiFilter,
} from '@/lib/sales-import/types';

export interface EntryWarnings {
  unmatched: { anyOf: number[]; noneOf: number[] };
  redundant: { anyOf: number[] };
}

const MAX_ROWS = 100;
type SortKey = { kind: 'dim'; key: string } | { kind: 'lines' | 'amount' | 'qty' };
type AddFn = (raw: Array<Record<string, unknown>>, opts?: NormalizeOptions) => void;

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

  const include = listOf(filter, 'anyOf');
  const exclude = listOf(filter, 'noneOf');

  const live = useMemo(
    () => entriesNotInCombos(filter, combos?.dimensionCombos, SALES_IMPORT_MAX_DIMENSION_COMBOS),
    [filter, combos],
  );
  const conflicts = useMemo(() => includeExcludeConflicts(filter), [filter]);

  function add(list: FilterList, raw: Array<Record<string, unknown>>, opts: NormalizeOptions = {}) {
    const r = addEntries(filter, list, raw, { ...opts, max: SALES_KPI_MAX_FILTER_ENTRIES });
    const parts: string[] = [];
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
    if (live?.[list].includes(i) || warnings?.unmatched[list].includes(i)) {
      return `${label} never appears in the latest file. Check the spelling or size.`;
    }
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
          {combos && combos.dimensionCombos.length >= SALES_IMPORT_MAX_DIMENSION_COMBOS
            ? ' The latest file has too many product combinations to check every entry here — press Test to check them.'
            : ''}
        </p>
      </div>

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
        <ComboPicker list={tab} filter={filter} onChange={onChange} onAdd={(raw, o) => add(tab, raw, o)} dims={dims} combos={combos} />
        <WholeValueChips list={tab} onAdd={(raw, o) => add(tab, raw, o)} dims={dims} combos={combos} />
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
  list, filter, onChange, onAdd, dims, combos,
}: {
  list: FilterList; filter: SalesKpiFilter; onChange(f: SalesKpiFilter): void; onAdd: AddFn;
  dims: SalesDimensionMapping[]; combos: SalesImportCombos | null;
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
    return (
      <p className="text-xs text-gray-500">
        No processed file yet, so there is no list of products to pick from. Use the whole-value chips or type entries
        below — or upload a file first.
      </p>
    );
  }

  const shown = rows.slice(0, MAX_ROWS);
  const current = listOf(filter, list).length;
  const notYetPicked = rows.filter((c) => !hasEntry(filter, list, comboEntry(c.dims, dims)));
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
      <p className="text-xs font-medium text-gray-700">Pick combinations from the latest file</p>
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
              return (
                <tr key={entryKey(entry)} className="border-t border-gray-100">
                  <td className="px-2 py-1">
                    <input type="checkbox" aria-label={`Pick ${name}`} checked={checked} disabled={full}
                      title={full ? `The list is full (${SALES_KPI_MAX_FILTER_ENTRIES} entries)` : undefined}
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
}: { list: FilterList; onAdd: AddFn; dims: SalesDimensionMapping[]; combos: SalesImportCombos | null }) {
  const [picked, setDimKey] = useState(dims[0]?.key ?? '');
  const dim = dims.find((d) => d.key === picked) ?? dims[0];
  const dimKey = dim?.key ?? '';
  const values = combos?.dimensionValues?.[dimKey] ?? [];
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
        {values.slice(0, 40).map((v) => {
          const blank = v.value.trim() === '';
          return (
            <button key={v.value} type="button"
              // A blank value is an exact "this column is empty" match — keep it, never widen to "any".
              onClick={() => onAdd([{ [dim.key]: v.value }], { keepBlank: true })}
              aria-label={blank ? `${verb} all lines with a blank ${dim.label}` : `${verb} all of ${v.value}`}
              className="inline-flex items-center gap-1 text-xs border border-gray-300 rounded-full px-2 py-0.5 hover:border-[var(--brand-primary)]">
              <Plus className="w-3 h-3" />{blank ? `(blank ${dim.label.toLowerCase()})` : v.value}
            </button>
          );
        })}
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
