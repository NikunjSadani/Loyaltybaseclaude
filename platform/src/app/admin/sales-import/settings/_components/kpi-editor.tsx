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

export interface TenantKpi { code: string; label: string; unit: string; enabled: boolean }

function filterSignature(f: SalesKpiFilter): string {
  return JSON.stringify([listOf(f, 'anyOf').map(entryKey), listOf(f, 'noneOf').map(entryKey)]);
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

const sameValue = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

/**
 * Checkbox multi-select over the tenant's real outlet types / programmes (GET segment-options). The backend matches
 * scope case- and space-insensitively (and upper-cases outlet types on save), so selection is compared the same way.
 * A saved value that is no longer offered (e.g. its outlets were deleted) stays listed, ticked, so it can be removed.
 */
function ScopeMultiSelect({ label, options, values, onChange }: {
  label: string;
  options: Array<{ value: string; label: string }>;
  values: string[];
  onChange(v: string[]): void;
}) {
  const stale = values.filter((v) => !options.some((o) => sameValue(o.value, v)));
  const rows = [...options, ...stale.map((v) => ({ value: v, label: `${v} (no outlets now)` }))];
  const isOn = (v: string) => values.some((x) => sameValue(x, v));
  function toggle(v: string) {
    onChange(isOn(v) ? values.filter((x) => !sameValue(x, v)) : [...values, v]);
  }
  return (
    <fieldset>
      <legend className="text-xs font-medium text-gray-700">{label}</legend>
      <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-gray-200 px-2 py-1.5 space-y-1">
        {rows.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-xs text-gray-800">
            <input type="checkbox" checked={isOn(o.value)} onChange={() => toggle(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
      {values.length > 0 && <p className="mt-1 text-[11px] text-gray-500">{values.length} selected</p>}
    </fieldset>
  );
}

export function KpiEditor({
  initial, tenantKpis, ownedCodes, mapping, combos, segments = null, onSaved, onCancel, onDuplicateAsCases,
}: {
  initial: SalesKpiDefinitionDto;
  tenantKpis: TenantKpi[];
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
  const sig = filterSignature(def.filter);
  const freshTest = test && test.sig === sig && test.result;

  const options = tenantKpis.filter((k) => k.enabled && (k.code === def.kpiCode || !ownedCodes.includes(k.code)));

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
    if (blockers.length || saving) return;
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
        <h3 className="text-sm font-semibold text-gray-900">{editing ? `Edit ${def.kpiCode}` : 'New Sales Import KPI'}</h3>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-xs font-medium text-gray-700">
          KPI
          <select value={def.kpiCode} disabled={editing} aria-label="KPI"
            onChange={(e) => setDef((d) => ({ ...d, kpiCode: e.target.value }))}
            className="mt-1 block w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 disabled:bg-gray-50">
            <option value="">Choose a KPI…</option>
            {options.map((k) => <option key={k.code} value={k.code}>{k.label} ({k.code}{k.unit ? `, ${k.unit}` : ''})</option>)}
          </select>
          {options.length === 0 && !editing && (
            <span className="block mt-1 font-normal text-gray-500">Every enabled KPI already comes from Sales Import. Create a new KPI under Targets first.</span>
          )}
        </label>
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

      {/* Test */}
      <div className="rounded-lg border border-gray-200 p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" type="button" onClick={runTest} loading={testing} disabled={validation.errors.length > 0}>
            <FlaskConical className="w-3.5 h-3.5" /> Test against latest import
          </Button>
          <span className="text-[11px] text-gray-500">Shows the monthly totals this KPI would get. Nothing is saved.</span>
        </div>
        {testError && <p className="text-xs text-red-600" role="alert">{testError}</p>}
        {test && !freshTest && <p className="text-xs text-gray-500">The products changed since the last test — test again.</p>}
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
        </span>
      </div>

      {blockers.length > 0 && (
        <ul className="text-xs text-red-700 list-disc pl-4" data-testid="kpi-editor-blockers">
          {blockers.map((b) => <li key={b}>{b}</li>)}
        </ul>
      )}
      {saveError && <p className="text-sm text-red-600" role="alert">{saveError}</p>}

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" type="button" onClick={save} loading={saving} disabled={blockers.length > 0}>Save KPI</Button>
        <Button variant="outline" type="button" onClick={onCancel}>Cancel</Button>
        {def.measure === 'AMOUNT' && hasQty && (
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
