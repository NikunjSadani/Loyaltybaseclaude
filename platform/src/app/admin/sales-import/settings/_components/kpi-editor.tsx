'use client';

/**
 * Sales Import KPI definition editor (SALES-IMPORT-PIPELINE-PLAN §6.2, §6.2a, §11 F-6): which KPI, rupees / cases /
 * number of products bought (PRODUCT_COUNT, §6.2b),
 * which products (Product set builder), optional outlet scope, and a "Test against latest import" button.
 * FOCUS-FROM-TARGETS: "Which products count" = picked here (productSource FILTER, the builder) or from the target file
 * per outlet (TARGET_NAMES: no builder, saves `filter: {}`; the month preview reconciles the names).
 */
import React, { useState } from 'react';
import { AlertTriangle, FlaskConical, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { salesImportApi } from '@/lib/sales-import/api';
import { NO_REPLY, outcomeUnknown, reasonOr } from '@/lib/request-outcome';
import { entryKey, listOf, validateFilter } from '@/lib/sales-import/product-set';
import { formatCases, formatCount, formatProducts, formatRupees, monthLabel } from '@/lib/sales-import/format';
import type {
  SalesColumnMapping, SalesImportCombos, SalesKpiDefinitionDto, SalesKpiFilter, SalesKpiMeasure,
  SalesKpiProductSource, SalesKpiTestResult, SalesSegmentOptions,
} from '@/lib/sales-import/types';
import { ProductSetBuilder } from './product-set-builder';
import { ScopeMultiSelect, sameScopeValue } from '@/components/admin/scope-multi-select';
import type { AppliesTo } from '@/lib/applies-to';
import { kpiScopeOf } from '@/lib/kpi-scope-core';

export interface TenantKpi {
  code: string; label: string; unit: string; enabled: boolean;
  /** DEPRECATED KpiDef.outletType (one release): the KPI is for this outlet type only (null/absent = every type). */
  outletType?: string | null;
  /** KpiDef applies-to scope (APPLIES-TO-TARGETING-PLAN §0); empty facet = all. Absent on older payloads. */
  outletTypes?: string[];
  programs?: string[];
  subPrograms?: string[];
  /** KpiDef's per-outlet name column in the target file (needed for "From the target file"). Absent on older payloads. */
  hasNameOverride?: boolean;
  nameOverrideLabel?: string | null;
}

type KpiScopeSource = Pick<TenantKpi, 'code' | 'outletType' | 'outletTypes' | 'programs' | 'subPrograms'>;

/** Compares one facet of the KPI scope with the definition's choice. */
function facetConflict(kpiList: string[], chosenRaw: string[]): { disjoint: boolean; extras: string[] } | null {
  if (kpiList.length === 0) return null;
  const chosen: string[] = [];
  for (const c of chosenRaw.map((x) => x.trim()).filter(Boolean)) if (!chosen.some((x) => sameScopeValue(x, c))) chosen.push(c);
  if (chosen.length === 0) return null;
  const extras = chosen.filter((c) => !kpiList.some((k) => sameScopeValue(k, c)));
  if (extras.length === 0) return null;
  return { disjoint: extras.length === chosen.length, extras };
}

/**
 * L4 (generalised for applies-to): Sales Import writes a scoped KPI only for outlets inside the KPI's own scope,
 * intersected with the definition's outlet-type / programme scope. Returns the operator-facing warning when the two
 * scopes disagree (null when they agree or either side is unrestricted on the compared facets).
 */
export function scopeConflictWarning(kpi: KpiScopeSource | undefined, outletTypes: string[], programs: string[] = []): string | null {
  if (!kpi) return null;
  const s = kpiScopeOf(kpi);
  const t = facetConflict(s.outletTypes, outletTypes);
  const p = facetConflict(s.programs, programs);
  const types = s.outletTypes.join(', ');
  const progs = s.programs.join(', ');
  const chosenTypes = [...new Set(outletTypes.map((x) => x.trim().toUpperCase()).filter(Boolean))];
  if (t?.disjoint) {
    return `The KPI ${kpi.code} is set up for ${types} outlets only, but this scope lists ${chosenTypes.join(', ')}. No outlet will get a value. Add ${s.outletTypes.join(' or ')} or clear the outlet types.`;
  }
  if (p?.disjoint) {
    return `The KPI ${kpi.code} applies only to the programme${s.programs.length > 1 ? 's' : ''} ${progs}, but this scope lists ${programs.join(', ')}. No outlet will get a value. Add ${s.programs.join(' or ')} or clear the programmes.`;
  }
  const parts: string[] = [];
  if (t) parts.push(`The KPI ${kpi.code} is set up for ${types} outlets only, so ${t.extras.map((x) => x.toUpperCase()).join(', ')} outlets will not get a value.`);
  if (p) parts.push(`The KPI ${kpi.code} applies only to the programme${s.programs.length > 1 ? 's' : ''} ${progs}, so outlets in ${p.extras.join(', ')} will not get a value.`);
  return parts.length ? parts.join(' ') : null;
}

/** "WHOLESALER outlets in programme Gold with sub-programme Lite" — or null for an unscoped KPI. */
function describeKpiScope(s: AppliesTo): string | null {
  if (!s.outletTypes.length && !s.programs.length && !s.subPrograms.length) return null;
  const parts = [s.outletTypes.length ? `${s.outletTypes.join(', ')} outlets` : 'outlets'];
  if (s.programs.length) parts.push(`in programme ${s.programs.join(' / ')}`);
  if (s.subPrograms.length) parts.push(`with sub-programme ${s.subPrograms.join(' / ')}`);
  return parts.join(' ');
}

/** Everything a Test result depends on: the product set AND the outlet-type / programme scope. */
function testSignature(d: Pick<SalesKpiDefinitionDto, 'filter' | 'outletTypes' | 'programs' | 'measure'>): string {
  const norm = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toUpperCase()))].sort();
  return JSON.stringify([
    listOf(d.filter, 'anyOf').map(entryKey), listOf(d.filter, 'noneOf').map(entryKey),
    norm(d.outletTypes), norm(d.programs),
    // ₹ and cases are always tested together; the product count only when the draft is PRODUCT_COUNT, so switching
    // to / from it needs a fresh test. (Appended only then, so the AMOUNT/QUANTITY signature is unchanged.)
    ...(d.measure === 'PRODUCT_COUNT' ? ['PRODUCT_COUNT'] : []),
  ]);
}

/** The "Count" choices, in display order. */
const MEASURE_OPTIONS: ReadonlyArray<{ value: SalesKpiMeasure; label: string }> = [
  { value: 'AMOUNT', label: 'Rupees (₹)' },
  { value: 'QUANTITY', label: 'Cases (quantity)' },
  { value: 'PRODUCT_COUNT', label: 'Number of products bought (lines)' },
];

/** "Which products count" choices (FOCUS-FROM-TARGETS). */
const PRODUCT_SOURCE_OPTIONS: ReadonlyArray<{ value: SalesKpiProductSource; label: string }> = [
  { value: 'FILTER', label: 'Pick products here' },
  { value: 'TARGET_NAMES', label: 'From the target file, per outlet' },
];

export const TARGET_NAMES_HELP =
  "Each outlet counts the products written for this KPI in that month's target file (the KPI's name column), e.g. 'CNO & ADHO500'. Write each product as brand + SKU group (ADHO500) or just the brand (CNO); separate several with &.";

const PRODUCT_COUNT_HELP =
  "Counts each different product (combination of the product columns, e.g. Brand + SKU group) the outlet bought in the month, where the outlet's net amount for that product is above zero. Returns cancel purchases.";

function TokenInput({ label, values, onChange, placeholder }: { label: string; values: string[]; onChange(v: string[]): void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  function commit() {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  }
  return (
    <div>
      <p className="text-xs font-medium text-gray-700">{label}</p>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 text-xs bg-gray-100 rounded px-2 py-0.5">
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>×</button>
          </span>
        ))}
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder} aria-label={label}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } }}
          onBlur={commit}
          className="px-2 py-1 text-xs border border-gray-300 rounded-md w-48" />
      </div>
    </div>
  );
}

export function KpiEditor({
  initial, tenantKpis, tenantKpisError = null, onRetryTenantKpis, ownedCodes, mapping, combos, segments = null,
  onSaved, onCancel, onDuplicateAsCases, canEdit = true,
}: {
  initial: SalesKpiDefinitionDto;
  tenantKpis: TenantKpi[];
  /** The tenant KPI list failed to load (so an empty dropdown is NOT "every KPI is taken"). */
  tenantKpisError?: string | null;
  onRetryTenantKpis?(): void;
  /** False → the user lacks targets:manage_config; Save is hidden. */
  canEdit?: boolean;
  /** KPI codes already owned by OTHER enabled definitions. */
  ownedCodes: string[];
  mapping: SalesColumnMapping;
  combos: SalesImportCombos | null;
  /** The tenant's outlet types / programmes; an empty (or unavailable) list falls back to free text. */
  segments?: SalesSegmentOptions | null;
  onSaved(d: SalesKpiDefinitionDto): void;
  onCancel(): void;
  onDuplicateAsCases(d: SalesKpiDefinitionDto): void;
}) {
  const [def, setDef] = useState<SalesKpiDefinitionDto>(initial);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ sig: string; result: SalesKpiTestResult } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  /** L1: explicit "this KPI counts ALL products" for a saved from-the-target-file KPI switched to an empty pick list. */
  const [allProductsOk, setAllProductsOk] = useState(false);

  const editing = Boolean(initial.id);
  const productSource: SalesKpiProductSource = def.productSource ?? 'FILTER';
  const fromTargets = productSource === 'TARGET_NAMES';
  const dims = mapping.dimensions;
  const hasAmount = Boolean(mapping.amount);
  const hasQty = Boolean(mapping.quantity);
  const validation = validateFilter(def.filter, dims.map((d) => d.key));
  const sig = testSignature(def);
  const freshTest = test && test.sig === sig && test.result;
  const showProducts = def.measure === 'PRODUCT_COUNT';

  const options = tenantKpis.filter((k) => k.enabled && (k.code === def.kpiCode || !ownedCodes.includes(k.code)));
  const selectedKpi = tenantKpis.find((k) => k.code === def.kpiCode);
  const selectedKpiScope = kpiScopeOf(selectedKpi);
  const selectedKpiScopeText = describeKpiScope(selectedKpiScope);
  const scopeWarning = scopeConflictWarning(selectedKpi, def.outletTypes, def.programs);
  // Informational note: the KPI's own scope narrows outlets further than the definition says.
  const kpiScopeNarrows = Boolean(selectedKpiScopeText) && (
    (selectedKpiScope.outletTypes.length > 0 && def.outletTypes.length === 0)
    || (selectedKpiScope.programs.length > 0 && def.programs.length === 0)
    || selectedKpiScope.subPrograms.length > 0
  );
  let noOptionsText: string | null = null;
  if (options.length === 0 && !editing && !tenantKpisError) {
    if (tenantKpis.length === 0) noOptionsText = 'This programme has no KPIs yet. Create one under Targets first, then come back.';
    else if (!tenantKpis.some((k) => k.enabled)) noOptionsText = 'Every KPI of this programme is switched off. Switch one on under Targets first.';
    else noOptionsText = 'Every enabled KPI already comes from Sales Import. Create a new KPI under Targets first.';
  }

  // From the target file: the picked-product list is not used (saved as {}), so its errors don't block.
  const blockers: string[] = fromTargets ? [] : [...validation.errors];
  if (!def.kpiCode) blockers.push('Choose a KPI.');
  if (def.measure === 'AMOUNT' && !hasAmount) blockers.push('The column mapping has no amount column, so a rupee KPI is not possible.');
  if (def.measure === 'QUANTITY' && !hasQty) blockers.push('The column mapping has no quantity column, so a cases KPI is not possible.');
  if (def.measure === 'PRODUCT_COUNT' && !hasAmount) blockers.push('The column mapping has no amount column, so a products-bought KPI is not possible (products are counted by their net amount).');
  if (def.measure === 'PRODUCT_COUNT' && dims.length === 0) blockers.push('The column mapping has no product columns, so products cannot be told apart.');
  // L2: "From the target file" needs the KPI's per-outlet name column, or every outlet would count nothing.
  if (fromTargets && selectedKpi?.hasNameOverride === false) {
    blockers.push(`Turn on the per-outlet name column for ${selectedKpi.label || def.kpiCode} under Targets → KPI settings first, or pick the products here.`);
  }
  // L1: a KPI that took its products from the target file, switched to "Pick products here" with nothing picked, would
  // silently count EVERY product. Ask for an explicit choice instead.
  const emptyPickList = listOf(def.filter, 'anyOf').length === 0 && listOf(def.filter, 'noneOf').length === 0;
  const needsAllProductsTick = !fromTargets && initial.productSource === 'TARGET_NAMES' && emptyPickList;
  if (needsAllProductsTick && !allProductsOk) {
    blockers.push('No products are picked, so this KPI would count ALL products. Pick the products it counts, or tick “This KPI counts ALL products”.');
  }
  const measureAvailable = (m: SalesKpiMeasure): boolean =>
    m === 'AMOUNT' ? hasAmount : m === 'QUANTITY' ? hasQty : hasAmount && dims.length > 0;

  async function runTest() {
    if (validation.errors.length) return;
    setTesting(true);
    setTestError(null);
    const r = await salesImportApi.testKpi({ importId: 'latest', definition: def });
    setTesting(false);
    if (!r.success) {
      setTestError(r.status === 404 ? 'There is no processed file yet. Upload one first, then test.'
        // A test only reads (nothing is saved), so running it again is always safe.
        : outcomeUnknown(r) ? `The test didn’t finish: ${NO_REPLY}. A test saves nothing — press Test again.`
          : `The test didn’t run: ${reasonOr(r.error, 'the server refused it without a reason')}.`);
      return;
    }
    setTest({ sig, result: r.data });
  }

  async function save() {
    if (!canEdit || blockers.length || saving) return;
    setSaving(true);
    setSaveError(null);
    const { id, productSource: _src, ...rest } = def;
    void _src;
    // productSource is sent when it is TARGET_NAMES, or when the definition already carried one (so switching back to
    // "Pick products here" is saved); a plain FILTER definition is sent exactly as before.
    const body: SalesKpiDefinitionDto = fromTargets
      ? { ...rest, productSource: 'TARGET_NAMES', filter: {} }
      : initial.productSource !== undefined ? { ...rest, productSource: 'FILTER' } : rest;
    const r = id ? await salesImportApi.patchKpi(id, body) : await salesImportApi.createKpi(body);
    setSaving(false);
    if (!r.success) {
      setSaveError(outcomeUnknown(r)
        ? `We couldn’t confirm whether this KPI was saved: ${NO_REPLY}. Close this editor and check the KPI list before saving again.`
        : r.error.trim() || 'Not saved: the server refused it without a reason.');
      return;
    }
    onSaved(r.data);
  }

  const measureLabel = def.measure === 'AMOUNT' ? '₹' : def.measure === 'QUANTITY' ? 'cases' : 'number of products bought';

  return (
    <div className="rounded-xl border border-gray-300 bg-white p-5 space-y-5" data-testid="kpi-editor">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">{!canEdit ? `${def.kpiCode} (view only)` : editing ? `Edit ${def.kpiCode}` : 'New Sales Import KPI'}</h3>
      </div>

      {/* Read-only without targets:manage_config: the disabled fieldset disables every control inside. */}
      <fieldset disabled={!canEdit} className="space-y-5 min-w-0 border-0 p-0 m-0" data-testid="kpi-editor-fields">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="text-xs font-medium text-gray-700">
          <label>
            KPI
            <select value={def.kpiCode} disabled={editing} aria-label="KPI"
              onChange={(e) => setDef((d) => ({ ...d, kpiCode: e.target.value }))}
              className="mt-1 block w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 disabled:bg-gray-50">
              <option value="">Choose a KPI…</option>
              {options.map((k) => <option key={k.code} value={k.code}>{k.label} ({k.code}{k.unit ? `, ${k.unit}` : ''})</option>)}
            </select>
          </label>
          {tenantKpisError && !editing && (
            <div role="alert" className="mt-1 flex items-center gap-2 font-normal text-red-600" data-testid="kpi-list-error">
              Couldn&apos;t load the KPI list: {tenantKpisError}
              {onRetryTenantKpis && <Button size="sm" variant="outline" type="button" onClick={onRetryTenantKpis}>Retry</Button>}
            </div>
          )}
          {noOptionsText && <p className="mt-1 font-normal text-gray-500">{noOptionsText}</p>}
        </div>
        <fieldset>
          <legend className="text-xs font-medium text-gray-700">Count</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {MEASURE_OPTIONS.map(({ value: m, label }) => (
              <label key={m} className={`flex items-center gap-1.5 ${measureAvailable(m) ? '' : 'opacity-50'}`}>
                <input type="radio" name="measure" checked={def.measure === m} disabled={!measureAvailable(m)}
                  onChange={() => setDef((d) => ({ ...d, measure: m }))} />
                {label}
              </label>
            ))}
          </div>
          {def.measure === 'PRODUCT_COUNT' && (
            <p className="mt-1 text-[11px] text-gray-500" data-testid="measure-product-count-help">{PRODUCT_COUNT_HELP}</p>
          )}
        </fieldset>
      </div>

      <fieldset>
        <legend className="text-xs font-medium text-gray-700">Which products count</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {PRODUCT_SOURCE_OPTIONS.map(({ value, label }) => (
            <label key={value} className="flex items-center gap-1.5">
              <input type="radio" name="productSource" checked={productSource === value}
                onChange={() => setDef((d) => ({ ...d, productSource: value }))} />
              {label}
            </label>
          ))}
        </div>
        {fromTargets ? (
          <div className="mt-2 space-y-2" data-testid="product-source-target-names">
            <p className="text-[11px] text-gray-600">{TARGET_NAMES_HELP}</p>
            {selectedKpi?.hasNameOverride && selectedKpi.nameOverrideLabel && (
              <p className="text-[11px] text-gray-600">
                Name column for {def.kpiCode} in the target file: <strong>{selectedKpi.nameOverrideLabel}</strong>.
              </p>
            )}
            {selectedKpi && selectedKpi.hasNameOverride === false && (
              <p role="status" data-testid="product-source-no-name-column"
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                The KPI {def.kpiCode} has no per-outlet name column yet. Turn it on for this KPI under Targets → KPI
                settings first, so the target file can carry the product names.
              </p>
            )}
            <p className="text-[11px] text-gray-500">
              Check how each name was read — and any name that could not be matched — in the month preview of an import
              (or Months → Recalculate) before applying.
            </p>
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            {needsAllProductsTick && (
              <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
                data-testid="kpi-all-products-confirm">
                <input type="checkbox" className="mt-0.5" checked={allProductsOk} onChange={(e) => setAllProductsOk(e.target.checked)} />
                <span>
                  <strong>This KPI counts ALL products.</strong> No products are picked below, so every product in the
                  sales file counts — not the focus products from the target file any more.
                </span>
              </label>
            )}
            <ProductSetBuilder
              filter={def.filter}
              onChange={(f) => setDef((d) => ({ ...d, filter: f }))}
              dims={dims}
              combos={combos}
              warnings={freshTest ? { unmatched: freshTest.unmatchedEntries, redundant: freshTest.redundantEntries } : null}
            />
          </div>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        {segments && segments.outletTypes.length > 0 ? (
          <ScopeMultiSelect label="Only these outlet types (optional)" values={def.outletTypes}
            options={segments.outletTypes.map((t) => ({ value: t.code, label: t.name && t.name !== t.code ? `${t.name} (${t.code})` : t.code }))}
            onChange={(v) => setDef((d) => ({ ...d, outletTypes: v }))} />
        ) : (
          <TokenInput label="Only these outlet types (optional)" values={def.outletTypes} placeholder="e.g. WHOLESALER, Enter"
            onChange={(v) => setDef((d) => ({ ...d, outletTypes: v }))} />
        )}
        {segments && segments.programs.length > 0 ? (
          <ScopeMultiSelect label="Only these programmes (optional)" values={def.programs}
            options={segments.programs.map((p) => ({ value: p, label: p }))}
            onChange={(v) => setDef((d) => ({ ...d, programs: v }))} />
        ) : (
          <TokenInput label="Only these programmes (optional)" values={def.programs} placeholder="Programme name, Enter"
            onChange={(v) => setDef((d) => ({ ...d, programs: v }))} />
        )}
      </div>
      <p className="text-[11px] text-gray-500 -mt-3">Leave both empty for every outlet. Outlets outside the scope get no value (blank, not 0).</p>
      {scopeWarning && (
        <p role="status" data-testid="kpi-scope-conflict" className="-mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {scopeWarning}
        </p>
      )}
      {!scopeWarning && kpiScopeNarrows && (
        <p data-testid="kpi-scope-kpi-type" className="-mt-2 text-[11px] text-gray-500">
          The KPI {def.kpiCode} is set up for {selectedKpiScopeText} only, so only those outlets get a value.
        </p>
      )}
      </fieldset>

      {/* Test — only for a picked product list: per-outlet names are checked in the month preview. */}
      {!fromTargets && (
      <div className="rounded-lg border border-gray-200 p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" type="button" onClick={runTest} loading={testing} disabled={validation.errors.length > 0}>
            <FlaskConical className="w-3.5 h-3.5" /> Test against latest import
          </Button>
          <span className="text-[11px] text-gray-500">Shows the monthly totals this KPI would get. Nothing is saved.</span>
        </div>
        {testError && <p className="text-xs text-red-600" role="alert">{testError}</p>}
        {test && !freshTest && <p className="text-xs text-gray-500">The products or the outlet scope changed since the last test — test again.</p>}
        {freshTest && (
          <div className="space-y-1" data-testid="kpi-test-result">
            <p className="text-xs text-gray-600">{formatCount(freshTest.matchedLines)} invoice lines match.</p>
            {freshTest.months.length > 0 && (
              <table className="text-xs">
                <thead><tr className="text-left text-gray-500"><th className="pr-4">Month</th><th className="pr-4 text-right">₹</th><th className="pr-4 text-right">Cases</th>{showProducts && <th className="pr-4 text-right">Products (all outlets added up)</th>}<th className="text-right">Outlets &gt; 0</th></tr></thead>
                <tbody>
                  {freshTest.months.map((m) => (
                    <tr key={m.month}>
                      <td className="pr-4">{monthLabel(m.month)}</td>
                      <td className={`pr-4 text-right ${def.measure === 'AMOUNT' ? 'font-semibold' : ''}`}>{formatRupees(m.totalAmountRupees)}</td>
                      <td className={`pr-4 text-right ${def.measure === 'QUANTITY' ? 'font-semibold' : ''}`}>{formatCases(m.totalQuantity)}</td>
                      {showProducts && <td className="pr-4 text-right font-semibold">{formatProducts(m.totalProducts ?? 0)}</td>}
                      <td className="text-right">{formatCount(m.outletsNonZero)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {(freshTest.unmatchedEntries.anyOf.length + freshTest.unmatchedEntries.noneOf.length + freshTest.redundantEntries.anyOf.length) > 0 && (
              <p className="text-xs text-amber-700 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Some entries need a look — see the amber chips above.</p>
            )}
          </div>
        )}
      </div>
      )}

      <div className="flex items-start gap-2 text-xs text-blue-800 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          {def.kpiCode ? <strong>{def.kpiCode}</strong> : 'This KPI'} will no longer be accepted from the manual achievement
          upload — its values will come only from sales files ({measureLabel}).
          {editing && (
            <> Changes apply only to months you apply from now on: months already applied keep their old values until
              you apply a file to them again (closed months must be reopened by Gifsy first).</>
          )}
        </span>
      </div>

      {blockers.length > 0 && (
        <ul className="text-xs text-red-700 list-disc pl-4" data-testid="kpi-editor-blockers">
          {blockers.map((b) => <li key={b}>{b}</li>)}
        </ul>
      )}
      {saveError && <p className="text-sm text-red-600" role="alert">{saveError}</p>}

      <div className="flex flex-wrap gap-2">
        {canEdit && <Button variant="primary" type="button" onClick={save} loading={saving} disabled={blockers.length > 0}>Save KPI</Button>}
        <Button variant="outline" type="button" onClick={onCancel}>{canEdit ? 'Cancel' : 'Close'}</Button>
        {canEdit && def.measure === 'AMOUNT' && hasQty && (
          <Button variant="ghost" type="button" onClick={() => {
            if (!window.confirm('Start a new cases KPI with the same products? Unsaved changes to this KPI are discarded — save it first if you changed it.')) return;
            onDuplicateAsCases({
            kpiCode: '', measure: 'QUANTITY', filter: fromTargets ? {} : def.filter, outletTypes: def.outletTypes, programs: def.programs,
              enabled: true, order: def.order + 1, ...(fromTargets ? { productSource: 'TARGET_NAMES' as const } : {}),
            });
          }}>
            Duplicate as cases KPI
          </Button>
        )}
      </div>
    </div>
  );
}
