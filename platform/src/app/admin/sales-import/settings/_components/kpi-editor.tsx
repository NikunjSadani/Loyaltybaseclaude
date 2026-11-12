'use client';

/**
 * Sales Import KPI definition editor (SALES-IMPORT-PIPELINE-PLAN §6.2, §6.2a, §11 F-6): which KPI, rupees or cases,
 * which products (Product set builder), optional outlet scope, and a "Test against latest import" button.
 */
import React, { useState } from 'react';
import { AlertTriangle, FlaskConical, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { salesImportApi } from '@/lib/sales-import/api';
import { entryKey, listOf, validateFilter } from '@/lib/sales-import/product-set';
import { formatCases, formatCount, formatRupees, monthLabel } from '@/lib/sales-import/format';
import type {
  SalesColumnMapping, SalesImportCombos, SalesKpiDefinitionDto, SalesKpiFilter, SalesKpiMeasure, SalesKpiTestResult,
  SalesSegmentOptions,
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
function testSignature(d: Pick<SalesKpiDefinitionDto, 'filter' | 'outletTypes' | 'programs'>): string {
  const norm = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toUpperCase()))].sort();
  return JSON.stringify([
    listOf(d.filter, 'anyOf').map(entryKey), listOf(d.filter, 'noneOf').map(entryKey),
    norm(d.outletTypes), norm(d.programs),
  ]);
}

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

  const editing = Boolean(initial.id);
  const dims = mapping.dimensions;
  const hasAmount = Boolean(mapping.amount);
  const hasQty = Boolean(mapping.quantity);
  const validation = validateFilter(def.filter, dims.map((d) => d.key));
  const sig = testSignature(def);
  const freshTest = test && test.sig === sig && test.result;

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

  const blockers: string[] = [...validation.errors];
  if (!def.kpiCode) blockers.push('Choose a KPI.');
  if (def.measure === 'AMOUNT' && !hasAmount) blockers.push('The column mapping has no amount column, so a rupee KPI is not possible.');
  if (def.measure === 'QUANTITY' && !hasQty) blockers.push('The column mapping has no quantity column, so a cases KPI is not possible.');

  async function runTest() {
    if (validation.errors.length) return;
    setTesting(true);
    setTestError(null);
    const r = await salesImportApi.testKpi({ importId: 'latest', definition: def });
    setTesting(false);
    if (!r.success) { setTestError(r.status === 404 ? 'There is no processed file yet. Upload one first, then test.' : r.error); return; }
    setTest({ sig, result: r.data });
  }

  async function save() {
    if (!canEdit || blockers.length || saving) return;
    setSaving(true);
    setSaveError(null);
    const { id, ...body } = def;
    const r = id ? await salesImportApi.patchKpi(id, body) : await salesImportApi.createKpi(body);
    setSaving(false);
    if (!r.success) { setSaveError(r.error); return; }
    onSaved(r.data);
  }

  const measureLabel = def.measure === 'AMOUNT' ? '₹' : 'cases';

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
          <div className="mt-1 flex gap-4 text-sm">
            {(['AMOUNT', 'QUANTITY'] as SalesKpiMeasure[]).map((m) => (
              <label key={m} className={`flex items-center gap-1.5 ${(m === 'AMOUNT' ? hasAmount : hasQty) ? '' : 'opacity-50'}`}>
                <input type="radio" name="measure" checked={def.measure === m} disabled={m === 'AMOUNT' ? !hasAmount : !hasQty}
                  onChange={() => setDef((d) => ({ ...d, measure: m }))} />
                {m === 'AMOUNT' ? 'Rupees (₹)' : 'Cases (quantity)'}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div>
        <p className="text-xs font-medium text-gray-700 mb-2">Which products</p>
        <ProductSetBuilder
          filter={def.filter}
          onChange={(f) => setDef((d) => ({ ...d, filter: f }))}
          dims={dims}
          combos={combos}
          warnings={freshTest ? { unmatched: freshTest.unmatchedEntries, redundant: freshTest.redundantEntries } : null}
        />
      </div>

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

      {/* Test */}
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
                <thead><tr className="text-left text-gray-500"><th className="pr-4">Month</th><th className="pr-4 text-right">₹</th><th className="pr-4 text-right">Cases</th><th className="text-right">Outlets &gt; 0</th></tr></thead>
                <tbody>
                  {freshTest.months.map((m) => (
                    <tr key={m.month}>
                      <td className="pr-4">{monthLabel(m.month)}</td>
                      <td className={`pr-4 text-right ${def.measure === 'AMOUNT' ? 'font-semibold' : ''}`}>{formatRupees(m.totalAmountRupees)}</td>
                      <td className={`pr-4 text-right ${def.measure === 'QUANTITY' ? 'font-semibold' : ''}`}>{formatCases(m.totalQuantity)}</td>
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
            kpiCode: '', measure: 'QUANTITY', filter: def.filter, outletTypes: def.outletTypes, programs: def.programs,
              enabled: true, order: def.order + 1,
            });
          }}>
            Duplicate as cases KPI
          </Button>
        )}
      </div>
    </div>
  );
}
