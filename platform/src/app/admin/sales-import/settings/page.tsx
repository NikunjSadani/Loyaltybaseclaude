'use client';

/**
 * /admin/sales-import/settings — one-time setup (SALES-IMPORT-PIPELINE-PLAN §11 F-6, owner walkthrough §1):
 *   1. column mapping (how to read this tenant's file),
 *   2. Sales Import KPIs (rupees or cases × a product set × optional outlet scope), each testable against the
 *      latest processed file. A KPI defined here is "importer-owned": the manual achievement upload skips it.
 */
import Link from 'next/link';
import React, { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Power, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api-client';
import { salesImportApi } from '@/lib/sales-import/api';
import { usePermissions } from '@/lib/use-permissions';
import { describeFilter } from '@/lib/sales-import/product-set';
import { measureUnitLabel } from '@/lib/sales-import/format';
import type {
  SalesColumnMapping, SalesImportCombos, SalesKpiDefinitionDto, SalesSegmentOptions,
} from '@/lib/sales-import/types';
import { ColumnMappingForm } from './_components/column-mapping-form';
import { KpiEditor, type TenantKpi } from './_components/kpi-editor';

/**
 * Distinct non-empty cells of the detected HEADING row — suggestions for the heading inputs. detectedHeaders is
 * [headingRow, ...sampleRows]; sample rows are data (outlet codes, amounts), never suggested as headings.
 */
function headerSuggestions(rows: string[][] | null | undefined): string[] {
  const out = new Set<string>();
  for (const c of rows?.[0] ?? []) { const v = String(c ?? '').trim(); if (v) out.add(v); }
  return [...out];
}

async function loadDetectedHeaders(): Promise<string[]> {
  // ?fromImport=<id> (link from an import that needed mapping) wins; else the newest import that needed mapping.
  // Only GET :id carries detectedHeaders (the list always returns null), so the newest candidate is fetched.
  const fromImport = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('fromImport') : null;
  if (fromImport) {
    const r = await salesImportApi.get(fromImport);
    if (r.success && r.data.detectedHeaders?.length) return headerSuggestions(r.data.detectedHeaders);
  }
  const list = await salesImportApi.list(null, 10);
  if (!list.success) return [];
  const candidate = list.data.items.find((i) => i.status === 'NEEDS_MAPPING' && !i.purgedAt);
  if (!candidate) return [];
  const r = await salesImportApi.get(candidate.id);
  return r.success ? headerSuggestions(r.data.detectedHeaders) : [];
}

function KpiSection({ mapping, canEdit }: { mapping: SalesColumnMapping; canEdit: boolean }) {
  const [defs, setDefs] = useState<SalesKpiDefinitionDto[] | null>(null);
  const [tenantKpis, setTenantKpis] = useState<TenantKpi[]>([]);
  const [tenantKpisError, setTenantKpisError] = useState<string | null>(null);
  const [combos, setCombos] = useState<SalesImportCombos | null>(null);
  const [segments, setSegments] = useState<SalesSegmentOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SalesKpiDefinitionDto | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [rowMsg, setRowMsg] = useState<string | null>(null);
  /** KPI code just saved → "fill past months" pointer to the Months page. */
  const [savedKpi, setSavedKpi] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([
      salesImportApi.listKpis(),
      api.get<TenantKpi[]>('/api/admin/kpis'),
      salesImportApi.combos('latest'),
      salesImportApi.segmentOptions(),
    ]).then(([d, k, c, s]) => {
      if (cancelled) return;
      if (d.success) setDefs([...d.data.definitions].sort((a, b) => a.order - b.order || a.kpiCode.localeCompare(b.kpiCode)));
      else setError(d.error);
      if (k.success && Array.isArray(k.data)) { setTenantKpis(k.data); setTenantKpisError(null); }
      else setTenantKpisError(k.success ? 'unexpected response' : k.error);
      setCombos(c.success ? c.data : null); // 404 = no processed file yet → no picker list
      setSegments(s.success ? s.data : null); // unavailable → the scope inputs fall back to free text
    });
    return () => { cancelled = true; };
  }, [tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  function open(d: SalesKpiDefinitionDto) { setEditing(d); setEditorKey((k) => k + 1); setRowMsg(null); setSavedKpi(null); }

  async function setEnabled(d: SalesKpiDefinitionDto, enabled: boolean) {
    if (!d.id) return;
    if (!enabled && !window.confirm(`Stop importing ${d.kpiCode}? It goes back to the manual achievement upload. Values already stored stay as they are.`)) return;
    const r = enabled ? await salesImportApi.patchKpi(d.id, { enabled: true }) : await salesImportApi.disableKpi(d.id);
    setRowMsg(r.success ? null : r.error);
    reload();
  }

  const kpiLabel = (code: string) => tenantKpis.find((k) => k.code === code)?.label ?? code;
  const ownedBy = (exceptId?: string) => (defs ?? []).filter((d) => d.enabled && d.id !== exceptId).map((d) => d.kpiCode);

  return (
    <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4" data-testid="kpi-section">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">KPIs from the sales file</h2>
          <p className="text-xs text-gray-500 mt-0.5 max-w-3xl">
            Each KPI here is calculated from the sales file and is no longer accepted from the manual achievement upload.
            KPIs not listed here keep coming from the manual upload. Targets are uploaded as today.
          </p>
        </div>
        {!editing && canEdit && (
          <Button size="sm" variant="primary" onClick={() => open({
            kpiCode: '', measure: mapping.amount ? 'AMOUNT' : 'QUANTITY', filter: {}, outletTypes: [], programs: [],
            enabled: true, order: defs?.length ?? 0,
          })}>
            <Plus className="w-3.5 h-3.5" /> Add KPI
          </Button>
        )}
      </div>

      {rowMsg && <p role="alert" className="text-sm text-red-600">{rowMsg}</p>}
      {savedKpi && (
        <div role="status" data-testid="kpi-saved-fill-past"
          className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <strong>{savedKpi}</strong> is saved. It applies to months you apply from now on. To fill it for past months
          from the figures already stored, open{' '}
          <Link href="/admin/sales-import/months" className="underline font-medium">Months → Recalculate from stored history</Link>.
        </div>
      )}

      {defs === null ? (
        error ? (
          <div role="alert" className="text-sm text-red-600 flex items-center gap-2">
            Couldn&apos;t load KPIs: {error} <Button size="sm" variant="outline" onClick={reload}>Retry</Button>
          </div>
        ) : <div className="py-4"><Spinner size="sm" /></div>
      ) : defs.length === 0 ? (
        <p className="text-sm text-gray-500">
          {canEdit ? 'No KPIs yet. Press Add KPI to define the first one.' : 'No KPIs are set up for Sales Import yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 bg-gray-50 border-b border-gray-200">
                <th className="px-3 py-2 font-medium">KPI</th>
                <th className="px-3 py-2 font-medium">Counts</th>
                <th className="px-3 py-2 font-medium">Products</th>
                <th className="px-3 py-2 font-medium">Outlets</th>
                <th className="px-3 py-2 font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {defs.map((d) => (
                <tr key={d.id ?? d.kpiCode} className={`border-b border-gray-100 ${d.enabled ? '' : 'opacity-60'}`}>
                  <td className="px-3 py-2">
                    <span className="font-medium text-gray-900">{kpiLabel(d.kpiCode)}</span>
                    <span className="block text-[11px] text-gray-500 font-mono">{d.kpiCode}</span>
                    {!d.enabled && <span className="text-[10px] font-semibold text-gray-500">Not imported (manual upload)</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-700">{measureUnitLabel(d.measure)}</td>
                  <td className="px-3 py-2 text-gray-700 max-w-md">
                    {d.productSource === 'TARGET_NAMES'
                      ? <span data-testid={`kpi-products-${d.kpiCode}`}>From the target file<span className="block text-[11px] text-gray-500">per outlet, each month</span></span>
                      : describeFilter(d.filter, mapping.dimensions)}
                  </td>
                  <td className="px-3 py-2 text-gray-600 text-xs">
                    {d.outletTypes.length || d.programs.length
                      ? [d.outletTypes.length ? `Types: ${d.outletTypes.join(', ')}` : '', d.programs.length ? `Programmes: ${d.programs.join(', ')}` : ''].filter(Boolean).join(' · ')
                      : 'All'}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" onClick={() => open(d)} aria-label={`${canEdit ? 'Edit' : 'View'} ${d.kpiCode}`} disabled={Boolean(editing)}>
                      <Pencil className="w-3.5 h-3.5" /> {canEdit ? 'Edit' : 'View'}
                    </Button>
                    {!canEdit ? null : d.enabled ? (
                      <Button size="sm" variant="ghost" onClick={() => setEnabled(d, false)} aria-label={`Stop importing ${d.kpiCode}`} className="text-red-600">
                        <Power className="w-3.5 h-3.5" /> Stop importing
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => setEnabled(d, true)} aria-label={`Import ${d.kpiCode} again`}>
                        <RotateCcw className="w-3.5 h-3.5" /> Import again
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <KpiEditor
          key={editorKey}
          initial={editing}
          tenantKpis={tenantKpis}
          tenantKpisError={tenantKpisError}
          onRetryTenantKpis={reload}
          canEdit={canEdit}
          ownedCodes={ownedBy(editing.id)}
          mapping={mapping}
          combos={combos}
          segments={segments}
          onSaved={(saved) => { setEditing(null); setSavedKpi(saved.kpiCode || null); reload(); }}
          onCancel={() => setEditing(null)}
          onDuplicateAsCases={(d) => open(d)}
        />
      )}
    </section>
  );
}

export default function SalesImportSettingsPage() {
  const { ready, has } = usePermissions();
  const canEdit = ready && has('targets:manage_config');
  const [profile, setProfile] = useState<SalesColumnMapping | null | undefined>(undefined);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [detected, setDetected] = useState<string[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setProfileError(null);
    salesImportApi.getProfile().then((r) => {
      if (cancelled) return;
      if (r.success) setProfile(r.data ?? null);
      else setProfileError(r.error);
    });
    loadDetectedHeaders().then((h) => { if (!cancelled) setDetected(h); }).catch(() => {});
    return () => { cancelled = true; };
  }, [tick]);

  return (
    <div className="space-y-5 pb-10">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Sales Import settings</h1>
        <p className="text-sm text-gray-500 mt-0.5">Set these up once. They are reused for every file.</p>
      </div>

      {profile === undefined ? (
        profileError ? (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-3">
            Couldn&apos;t load settings: {profileError}
            <Button size="sm" variant="outline" onClick={() => setTick((t) => t + 1)}>Retry</Button>
          </div>
        ) : <div className="py-10 flex justify-center"><Spinner size="lg" /></div>
      ) : (
        <>
          <ColumnMappingForm initial={profile} detectedHeaders={detected} onSaved={(m) => setProfile(m)} canEdit={canEdit} />
          {profile ? (
            <KpiSection mapping={profile} canEdit={canEdit} />
          ) : (
            <p className="text-sm text-gray-500 bg-white rounded-xl border border-gray-200 p-6">
              Save the column mapping first; then you can define the KPIs.
            </p>
          )}
        </>
      )}
    </div>
  );
}
