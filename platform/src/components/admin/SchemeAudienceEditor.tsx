'use client';

/**
 * SchemeAudienceEditor — audience configuration for a scheme (D17/D18, §13.2).
 *
 *   Mode A — FILTER: filter tenant outlets by type / program / category / zone /
 *            state, with live-rule vs frozen and KYC-approved-only vs all toggles.
 *            Persists via schemeApi.setAudience. Enforces B-MED-1 (a FILTER audience
 *            needs ≥1 facet) client-side AND surfaces the backend 400 cleanly.
 *   Mode B — EXCEL: upload a roster .xlsx (schemeApi.uploadRoster) — matched vs
 *            standalone counts + dedup + unmatched employee codes.
 *
 * Controlled: the parent owns the current `audienceConfig` (round-tripped from the
 * scheme) and re-fetches it after a save.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Filter, Upload, X, AlertCircle, AlertTriangle, Check, CheckCircle, Users,
  FileSpreadsheet, Loader2, Info, Download, RefreshCw, ChevronLeft, ChevronRight, Table2,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import {
  schemeApi,
  type RosterUploadResult,
  type AudienceResult,
  type FacetValues,
  type RosterRow,
} from '@/lib/schemes';
import { downloadRosterReport } from '@/lib/scheme-roster-report';
import { aoaToSheetSafe } from '@/lib/xlsx-safe';
import { downloadBlob } from '@/lib/download';
import type { AudienceConfig, AudienceFilter, AudienceMode } from '@/lib/scheme-types';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * A minimal roster template (.xlsx) — the three required columns plus a couple of
 * example prefill variable columns and one sample data row. Built through
 * `aoaToSheetSafe` so no cell can be a formula-injection sink (AF-5b).
 */
function downloadRosterTemplate(): void {
  const aoa: (string | number)[][] = [
    ['Outlet ID', 'Outlet Name', 'Tagged Employee Code', 'owner_phone', 'last_month_sales'],
    ['OUT-1001', 'Sharma Kirana Store', 'EMP-204', '9876543210', 125000],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, aoaToSheetSafe(aoa), 'Roster');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  downloadBlob(new Blob([buf], { type: XLSX_MIME }), 'scheme-roster-template.xlsx');
}

// ── Facet multi-select (master values as a checklist + free-text fallback) ─────
//
// Offers the known Outlet-master values (from getFacetValues) as a toggleable
// checklist, while keeping a free-text input so a value not present in the master
// is never hard-blocked. `options[].value` is what's stored (an outlet-type id, or
// the string itself for zones/programs/states); `options[].name` is what's shown.

function FacetMultiSelect({
  label, options, values, onChange, placeholder,
}: {
  label: string;
  options: { value: string; name: string }[];
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [text, setText] = useState('');
  const toggle = (v: string) =>
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  const add = (raw: string) => {
    const v = raw.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setText('');
  };
  const known = new Set(options.map((o) => o.value));
  const customValues = values.filter((v) => !known.has(v));
  const nameOf = (v: string) => options.find((o) => o.value === v)?.name ?? v;

  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      {options.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2 max-h-32 overflow-y-auto">
          {options.map((o) => {
            const on = values.includes(o.value);
            return (
              <button key={o.value} type="button" onClick={() => toggle(o.value)}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-colors ${on ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}`}>
                {on && <Check className="w-3 h-3" />}{o.name}
              </button>
            );
          })}
        </div>
      )}
      {customValues.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {customValues.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-medium">
              {nameOf(v)}
              <button type="button" onClick={() => toggle(v)} className="text-gray-400 hover:text-red-500"><X className="w-3 h-3" /></button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(text); } }}
          placeholder={placeholder}
          className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
        />
        <button type="button" onClick={() => add(text)} className="px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg text-xs hover:bg-gray-200">Add</button>
      </div>
    </div>
  );
}

function ToggleRow({
  value, onChange, label, description,
}: { value: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <button type="button" onClick={() => onChange(!value)} aria-pressed={value}
        className={`w-10 h-5 rounded-full transition-colors mt-0.5 relative shrink-0 ${value ? 'bg-[var(--brand-primary)]' : 'bg-gray-200'}`}>
        <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow ${value ? 'left-5' : 'left-0.5'}`} />
      </button>
      <div>
        <p className="text-sm font-semibold text-gray-800">{label}</p>
        {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
      </div>
    </label>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

const EMPTY_FILTER: AudienceFilter = { kycApprovedOnly: false };

function facetCount(f: AudienceFilter): number {
  return (
    (f.outletTypeIds?.length ?? 0) +
    (f.programNames?.length ?? 0) +
    (f.programCategories?.length ?? 0) +
    (f.zones?.length ?? 0) +
    (f.states?.length ?? 0)
  );
}

interface Props {
  schemeId: string;
  /** For the roster-upload report title + filename. */
  schemeName?: string;
  audienceConfig: AudienceConfig | null;
  /** Called after a successful audience save so the parent re-hydrates. */
  onSaved?: () => void;
}

export function SchemeAudienceEditor({ schemeId, schemeName, audienceConfig, onSaved }: Props) {
  const [mode, setMode] = useState<AudienceMode>(audienceConfig?.mode ?? 'FILTER');
  const [selfEnrollAllowed, setSelfEnrollAllowed] = useState(audienceConfig?.selfEnrollAllowed ?? false);
  const [frozen, setFrozen] = useState(audienceConfig?.frozen ?? false);
  const [filter, setFilter] = useState<AudienceFilter>(audienceConfig?.filter ?? EMPTY_FILTER);
  // `allowEnrollerEdit` is a new audienceConfig key not yet on the shared AudienceConfig
  // type (owned by scheme-types.ts, off-limits here) — read it via a local widening cast.
  const [allowEnrollerEdit, setAllowEnrollerEdit] = useState(
    (audienceConfig as (AudienceConfig & { allowEnrollerEdit?: boolean }) | null)?.allowEnrollerEdit ?? false,
  );

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<AudienceResult | null>(null);

  // Master facet values for the FILTER checklists (free-text fallback if unavailable).
  const [facets, setFacets] = useState<FacetValues | null>(null);
  // Mode-switch guard: switching FILTER↔EXCEL after rows exist strands them.
  const [pendingMode, setPendingMode] = useState<AudienceMode | null>(null);
  const [rosterUploaded, setRosterUploaded] = useState(false);
  // Bumped after each upload so the Current-roster table re-fetches.
  const [rosterRefreshKey, setRosterRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void schemeApi.getFacetValues(schemeId).then((res) => {
      if (!cancelled && res.success) setFacets(res.data);
    });
    return () => { cancelled = true; };
  }, [schemeId]);

  const setFilterKey = <K extends keyof AudienceFilter>(k: K, v: AudienceFilter[K]) =>
    setFilter((f) => ({ ...f, [k]: v }));

  // A persisted audience, a just-materialized snapshot, or a roster upload this
  // session all mean a mode switch would strand existing rows.
  const hasStrandableRows = !!audienceConfig || !!saveResult || rosterUploaded;
  const requestMode = (next: AudienceMode) => {
    if (next === mode) return;
    if (hasStrandableRows) { setPendingMode(next); return; }
    setMode(next);
  };
  const confirmModeSwitch = () => {
    if (!pendingMode) return;
    setMode(pendingMode);
    setPendingMode(null);
    setSaveResult(null);
    setSaveError(null);
  };

  const saveAudience = async () => {
    setSaveError(null);
    setSaveResult(null);
    if (mode === 'FILTER' && facetCount(filter) === 0) {
      setSaveError('Add at least one filter (outlet type, program, category, zone or state) — an empty filter is not allowed.');
      return;
    }
    setSaving(true);
    const res = await schemeApi.setAudience(schemeId, {
      mode,
      selfEnrollAllowed,
      frozen: mode === 'FILTER' ? frozen : false,
      filter: mode === 'FILTER' ? filter : undefined,
      allowEnrollerEdit,
    });
    setSaving(false);
    if (res.success) {
      setSaveResult(res.data);
      onSaved?.();
    } else {
      setSaveError(res.error);
    }
  };

  return (
    <div className="space-y-5">
      {/* Mode picker */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {([
          { value: 'FILTER' as AudienceMode, Icon: Filter, label: 'Filter tenant outlets', desc: 'Target by type / program / category / zone / state.' },
          { value: 'EXCEL' as AudienceMode, Icon: FileSpreadsheet, label: 'Upload a roster (Excel)', desc: 'One row per outlet id + name + tagged employee + variables.' },
        ]).map(({ value, Icon, label, desc }) => (
          <button key={value} type="button" onClick={() => requestMode(value)}
            className={`flex items-start gap-3 p-3.5 rounded-xl border-2 text-left transition-all ${mode === value ? 'border-[var(--brand-primary)] bg-green-50' : 'border-gray-200 hover:border-gray-300'}`}>
            <div className={`p-1.5 rounded-lg shrink-0 ${mode === value ? 'bg-[var(--brand-primary)] text-white' : 'bg-gray-100 text-gray-500'}`}><Icon className="w-4 h-4" /></div>
            <div>
              <p className={`text-sm font-semibold ${mode === value ? 'text-[var(--brand-primary)]' : 'text-gray-800'}`}>{label}</p>
              <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
            </div>
          </button>
        ))}
      </div>

      {/* Mode-switch warning — switching strands the existing roster / snapshot */}
      {pendingMode && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl p-3.5">
          <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-800">
              Switch to {pendingMode === 'EXCEL' ? 'roster upload' : 'filter'} mode?
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              This scheme already has {mode === 'EXCEL' ? 'a roster' : 'a filter audience'}. Switching modes strands the existing roster / snapshot rows — they no longer match the new audience definition. You will need to re-save the audience{pendingMode === 'EXCEL' ? ' and upload a fresh roster' : ''} after switching.
            </p>
            <div className="flex gap-2 mt-2">
              <button type="button" onClick={confirmModeSwitch}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-500 text-white hover:bg-amber-600">Switch anyway</button>
              <button type="button" onClick={() => setPendingMode(null)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Self-enroll (both modes) */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
        <ToggleRow value={selfEnrollAllowed} onChange={setSelfEnrollAllowed}
          label="Allow outlet self-enrollment" description="Matched real outlets can enroll themselves from the outlet portal (D21). Standalone rows are always rep-filled." />
        <ToggleRow value={allowEnrollerEdit} onChange={setAllowEnrollerEdit}
          label="Allow enroller to edit their own submission" description="On = the outlet (or the sales rep) can re-open and correct their own SUBMITTED enrollment. Off = a submitted enrollment is locked to them (only a Gifsy admin can edit it)." />
      </div>

      {/* FILTER facets */}
      {mode === 'FILTER' && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
          <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
            <Info className="w-3.5 h-3.5 text-blue-400 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-blue-700">Inclusions only — add one or more facets. Values are matched against the Outlet master (type id / program name / category / zone / state).</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FacetMultiSelect label="Outlet type" placeholder="add a custom type id, then Enter"
              options={(facets?.outletTypes ?? []).map((t) => ({ value: t.id, name: t.name }))}
              values={filter.outletTypeIds ?? []} onChange={(v) => setFilterKey('outletTypeIds', v)} />
            <FacetMultiSelect label="Program names" placeholder="add a custom program, then Enter"
              options={(facets?.programNames ?? []).map((s) => ({ value: s, name: s }))}
              values={filter.programNames ?? []} onChange={(v) => setFilterKey('programNames', v)} />
            <FacetMultiSelect label="Program categories" placeholder="add a custom category, then Enter"
              options={(facets?.programCategories ?? []).map((s) => ({ value: s, name: s }))}
              values={filter.programCategories ?? []} onChange={(v) => setFilterKey('programCategories', v)} />
            <FacetMultiSelect label="Zones" placeholder="add a custom zone, then Enter"
              options={(facets?.zones ?? []).map((s) => ({ value: s, name: s }))}
              values={filter.zones ?? []} onChange={(v) => setFilterKey('zones', v)} />
            <FacetMultiSelect label="States" placeholder="add a custom state, then Enter"
              options={(facets?.states ?? []).map((s) => ({ value: s, name: s }))}
              values={filter.states ?? []} onChange={(v) => setFilterKey('states', v)} />
          </div>
          <div className="border-t border-gray-100 pt-4 space-y-3">
            <ToggleRow value={filter.kycApprovedOnly} onChange={(v) => setFilterKey('kycApprovedOnly', v)}
              label="KYC-approved outlets only" description="Off = include all matching outlets (approved or not)." />
            <ToggleRow value={frozen} onChange={setFrozen}
              label="Freeze the audience now (snapshot)" description="On = materialize a fixed roster at save. Off = live-rule (rows added lazily as outlets enroll)." />
          </div>
        </div>
      )}

      {/* Save audience */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-gray-500">
          {mode === 'FILTER'
            ? `${facetCount(filter)} facet${facetCount(filter) === 1 ? '' : 's'} selected`
            : 'Excel roster mode — save, then upload the roster below.'}
        </div>
        <button onClick={saveAudience} disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-medium rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          {saving ? 'Saving…' : 'Save audience'}
        </button>
      </div>
      {saveError && (
        <p className="text-xs text-red-500 flex items-start gap-1.5"><AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />{saveError}</p>
      )}
      {saveResult && (
        <p className="text-xs text-green-600 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />
          Audience saved{saveResult.materializedCount > 0 ? ` — ${saveResult.materializedCount} outlet${saveResult.materializedCount === 1 ? '' : 's'} in the roster snapshot.` : mode === 'FILTER' ? ' (live-rule — roster grows as outlets enroll).' : '.'}
        </p>
      )}

      {/* EXCEL roster upload + current-roster view/download */}
      {mode === 'EXCEL' && (
        <>
          <RosterUploadPanel
            schemeId={schemeId}
            schemeName={schemeName}
            onUploaded={() => { setRosterUploaded(true); setRosterRefreshKey((k) => k + 1); }}
          />
          <CurrentRosterPanel schemeId={schemeId} refreshKey={rosterRefreshKey} />
        </>
      )}
    </div>
  );
}

// ── Current roster view + download (Mode B) ───────────────────────────────────

function linkageLabel(row: RosterRow): 'Matched' | 'Standalone' {
  return row.matchedOutletId ? 'Matched' : 'Standalone';
}

function CurrentRosterPanel({ schemeId, refreshKey }: { schemeId: string; refreshKey: number }) {
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const LIMIT = 25;

  const load = async (p: number) => {
    setLoading(true);
    setError(null);
    const res = await schemeApi.getRoster(schemeId, { page: p, limit: LIMIT });
    setLoading(false);
    if (res.success) {
      setRows(res.data.roster);
      setPage(res.data.pagination.page);
      setPages(res.data.pagination.pages);
      setTotal(res.data.pagination.total);
    } else {
      setError(res.error);
    }
  };

  // Refetch on mount, on scheme change, and after each upload (refreshKey bumps).
  // A fresh upload resets to page 1.
  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemeId, refreshKey]);

  const doDownload = async () => {
    setDownloading(true);
    setDownloadError(null);
    const res = await schemeApi.downloadRosterExport(schemeId);
    setDownloading(false);
    if (!res.success) setDownloadError(res.error);
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm font-semibold text-gray-800 flex items-center gap-2">
          <Table2 className="w-4 h-4 text-gray-500" /> Current roster
          {total > 0 && <span className="text-xs font-normal text-gray-400">({total} outlet{total === 1 ? '' : 's'})</span>}
        </p>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => void load(page)} disabled={loading}
            className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 disabled:opacity-60">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <button type="button" onClick={doDownload} disabled={downloading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--brand-primary)] text-white text-xs font-medium hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60">
            {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            {downloading ? 'Preparing…' : 'Download roster (.xlsx)'}
          </button>
        </div>
      </div>

      {downloadError && (
        <p className="text-xs text-red-500 flex items-start gap-1.5"><AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />{downloadError}</p>
      )}
      {error && (
        <p className="text-xs text-red-500 flex items-start gap-1.5"><AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />{error}</p>
      )}

      {!error && rows.length === 0 && !loading && (
        <p className="text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-3 py-4 text-center">
          No roster rows yet — upload a roster above.
        </p>
      )}

      {rows.length > 0 && (
        <div className="border border-gray-100 rounded-xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-left">
                <th className="px-3 py-2 font-medium">Outlet ID</th>
                <th className="px-3 py-2 font-medium">Outlet Name</th>
                <th className="px-3 py-2 font-medium">Linkage</th>
                <th className="px-3 py-2 font-medium">Tagged employee</th>
                <th className="px-3 py-2 font-medium">Enrollment status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const linkage = linkageLabel(r);
                return (
                  <tr key={r.id} className="text-gray-700">
                    <td className="px-3 py-2 font-mono text-[11px]">{r.outletRef}</td>
                    <td className="px-3 py-2">{r.outletName}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium ${linkage === 'Matched' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                        {linkage}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-500">{r.taggedSalesUser?.employeeCode ?? '—'}</td>
                    <td className="px-3 py-2">{r.enrollment?.status ?? 'NOT_ENROLLED'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>Page {page} of {pages}</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void load(page - 1)} disabled={loading || page <= 1}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">
              <ChevronLeft className="w-3.5 h-3.5" /> Prev
            </button>
            <button type="button" onClick={() => void load(page + 1)} disabled={loading || page >= pages}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">
              Next <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Roster upload panel (Mode B) ──────────────────────────────────────────────

function RosterUploadPanel({ schemeId, schemeName, onUploaded }: { schemeId: string; schemeName?: string; onUploaded?: () => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RosterUploadResult | null>(null);
  const [showCols, setShowCols] = useState(false);
  const [idColumn, setIdColumn] = useState('');
  const [nameColumn, setNameColumn] = useState('');
  const [taggedEmployeeColumn, setTaggedEmployeeColumn] = useState('');

  const doUpload = async (file: File) => {
    setError(null);
    setResult(null);
    setUploading(true);
    const res = await schemeApi.uploadRoster(schemeId, file, {
      idColumn: idColumn.trim() || undefined,
      nameColumn: nameColumn.trim() || undefined,
      taggedEmployeeColumn: taggedEmployeeColumn.trim() || undefined,
    });
    setUploading(false);
    if (res.success) { setResult(res.data); onUploaded?.(); }
    else setError(res.error);
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-800 flex items-center gap-2"><Users className="w-4 h-4 text-gray-500" /> Roster upload</p>
        <div className="flex items-center gap-3">
          <button type="button" onClick={downloadRosterTemplate} className="inline-flex items-center gap-1.5 text-xs text-[var(--brand-primary)] hover:underline">
            <Download className="w-3.5 h-3.5" /> Download template (.xlsx)
          </button>
          <button type="button" onClick={() => setShowCols((s) => !s)} className="text-xs text-[var(--brand-primary)] hover:underline">
            {showCols ? 'Hide column overrides' : 'Column overrides'}
          </button>
        </div>
      </div>

      {showCols && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {[
            { label: 'Outlet id column', value: idColumn, set: setIdColumn, ph: 'outlet_id' },
            { label: 'Outlet name column', value: nameColumn, set: setNameColumn, ph: 'outlet_name' },
            { label: 'Tagged employee column', value: taggedEmployeeColumn, set: setTaggedEmployeeColumn, ph: 'employee_code' },
          ].map(({ label, value, set, ph }) => (
            <div key={label}>
              <label className="block text-[10px] text-gray-500 mb-1">{label}</label>
              <input type="text" value={value} onChange={(e) => set(e.target.value)} placeholder={ph}
                className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5" />
            </div>
          ))}
        </div>
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) void doUpload(f); }}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${dragOver ? 'border-[var(--brand-primary)] bg-green-50' : 'border-gray-300 hover:border-gray-400 bg-gray-50'}`}
      >
        {uploading ? <Loader2 className="w-6 h-6 text-[var(--brand-primary)] mx-auto mb-2 animate-spin" /> : <Upload className="w-6 h-6 text-gray-400 mx-auto mb-2" />}
        <p className="text-sm font-medium text-gray-700">{uploading ? 'Uploading roster…' : 'Drop the roster Excel here'}</p>
        <p className="text-xs text-gray-400 mt-0.5">or click to browse · .xlsx / .xls</p>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void doUpload(f); e.target.value = ''; }} />
      </div>

      {error && <p className="text-xs text-red-500 flex items-start gap-1.5"><AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />{error}</p>}

      {result && (
        <div className="border border-green-200 rounded-xl overflow-hidden">
          <div className="px-3 py-2 bg-green-50 border-b border-green-200 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="font-semibold text-green-800">{result.upserted} of {result.totalRows} rows saved</span>
            <span className="text-green-700">{result.matchedCount} matched</span>
            <span className="text-gray-600">{result.standaloneCount} standalone</span>
            <button
              type="button"
              onClick={() => downloadRosterReport(result, schemeName)}
              className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white border border-green-300 text-green-700 font-medium hover:bg-green-100 transition-colors"
            >
              <Download className="w-3.5 h-3.5" /> Download report (.xlsx)
            </button>
          </div>
          <div className="px-3 py-2 text-xs text-gray-600 space-y-1">
            {result.duplicateRefs.length > 0 && (
              <p className="flex items-start gap-1.5 text-amber-600"><AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                {result.duplicateRefs.length} duplicate outlet id{result.duplicateRefs.length === 1 ? '' : 's'} de-duplicated: {result.duplicateRefs.slice(0, 6).join(', ')}{result.duplicateRefs.length > 6 ? ' …' : ''}
              </p>
            )}
            {result.unmatchedEmployeeCodes.length > 0 && (
              <p className="flex items-start gap-1.5 text-amber-600"><AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                {result.unmatchedEmployeeCodes.length} tagged employee code{result.unmatchedEmployeeCodes.length === 1 ? '' : 's'} not found: {result.unmatchedEmployeeCodes.slice(0, 6).join(', ')}{result.unmatchedEmployeeCodes.length > 6 ? ' …' : ''}
              </p>
            )}
            {result.duplicateRefs.length === 0 && result.unmatchedEmployeeCodes.length === 0 && (
              <p className="flex items-center gap-1.5 text-green-600"><CheckCircle className="w-3.5 h-3.5" /> No duplicates or unmatched employees.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default SchemeAudienceEditor;
