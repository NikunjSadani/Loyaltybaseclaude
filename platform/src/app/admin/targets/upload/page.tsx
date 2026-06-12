'use client';

import { useState, useRef, useCallback } from 'react';
import {
  Upload, Download, Plus, Trash2, ChevronDown, ChevronUp,
  CheckCircle2, XCircle, AlertTriangle, FileSpreadsheet,
  ArrowUp, ArrowDown, Settings2, Info,
} from 'lucide-react';
import {
  getTenantKpiDefs, saveTenantKpiDefs, makeKpiId,
  DEOLEO_DEFAULT_KPIS,
  type TenantKpiDef,
} from '@/lib/platform/tenant-kpi-config';
import {
  generateTargetTemplate,
  parseTargetUpload,
  buildErrorReportBuffer,
  type ParseResult,
} from '@/lib/target-excel-upload';
import {
  buildMonthRange, MOCK_OUTLETS,
  upsertTargetConfig, getAllTargetConfigs,
  type NewOutletType,
} from '@/lib/targets';

// ── Roles permitted to access this page ──────────────────────────────────────
// Both CLIENT_ADMIN and GIFSY_ADMIN are allowed.
const ALLOWED_ROLES = ['CLIENT_ADMIN', 'GIFSY_ADMIN'] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getAllOutletIds(): Set<string> {
  const ids = new Set<string>();
  for (const outlets of Object.values(MOCK_OUTLETS)) {
    for (const o of outlets) ids.add(o.id);
  }
  return ids;
}

function downloadBuffer(buf: ArrayBuffer, filename: string) {
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TargetUploadPage() {
  // KPI config
  const [kpiDefs,             setKpiDefs]            = useState<TenantKpiDef[]>(() => getTenantKpiDefs());
  const [kpiOpen,             setKpiOpen]            = useState(false);
  const [addingKpi,           setAddingKpi]          = useState(false);
  const [newKpiLabel,         setNewKpiLabel]        = useState('');
  const [newKpiUnit,          setNewKpiUnit]         = useState('cases');
  const [newKpiOverride,      setNewKpiOverride]     = useState(false);
  const [newKpiOverrideLabel, setNewKpiOverrideLabel] = useState('');

  // Template options — 12-month forward window (current month through next 11)
  const monthOptions = buildMonthRange(12);
  const [fromMonth, setFromMonth] = useState(monthOptions[0]?.value ?? '');
  const [toMonth,   setToMonth]   = useState(monthOptions[2]?.value ?? monthOptions[0]?.value ?? '');

  // Upload
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const [fileName,    setFileName]    = useState('');
  const [parsing,     setParsing]     = useState(false);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [savedConfig, setSavedConfig] = useState(false);

  // ── KPI helpers ────────────────────────────────────────────────────────

  function saveKpis(defs: TenantKpiDef[]) {
    setKpiDefs(defs);
    saveTenantKpiDefs(defs);
  }

  function toggleKpi(id: string) {
    saveKpis(kpiDefs.map(d => d.id === id ? { ...d, enabled: !d.enabled } : d));
  }

  function removeKpi(id: string) {
    saveKpis(kpiDefs.filter(d => d.id !== id));
  }

  function moveKpi(id: string, dir: -1 | 1) {
    const sorted = [...kpiDefs].sort((a, b) => a.order - b.order);
    const idx    = sorted.findIndex(d => d.id === id);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= sorted.length) return;
    [sorted[idx].order, sorted[newIdx].order] = [sorted[newIdx].order, sorted[idx].order];
    saveKpis(sorted);
  }

  function commitAddKpi() {
    const label = newKpiLabel.trim();
    if (!label) return;
    const id    = makeKpiId(label);
    const order = Math.max(...kpiDefs.map(d => d.order), 0) + 1;
    const def: TenantKpiDef = {
      id,
      label,
      unit:              newKpiUnit,
      isPrimary:         false,
      hasNameOverride:   newKpiOverride,
      nameOverrideLabel: newKpiOverride ? (newKpiOverrideLabel.trim() || `${label} Name`) : '',
      order,
      enabled:           true,
    };
    saveKpis([...kpiDefs, def]);
    setAddingKpi(false);
    setNewKpiLabel('');
    setNewKpiUnit('cases');
    setNewKpiOverride(false);
    setNewKpiOverrideLabel('');
  }

  // ── Template download ──────────────────────────────────────────────────

  function selectedMonths(): string[] {
    const from = monthOptions.findIndex(m => m.value === fromMonth);
    const to   = monthOptions.findIndex(m => m.value === toMonth);
    if (from < 0 || to < 0 || to < from) return [];
    return monthOptions.slice(from, to + 1).map(m => m.value);
  }

  function handleDownloadTemplate() {
    const months = selectedMonths();
    if (months.length === 0) return;
    const buf = generateTargetTemplate(kpiDefs, months);
    downloadBuffer(buf, `targets_template_${months[0]}_to_${months[months.length - 1]}.xlsx`);
  }

  // When "From" changes to something after "To", push "To" forward to match
  function handleFromChange(val: string) {
    setFromMonth(val);
    const fromIdx = monthOptions.findIndex(m => m.value === val);
    const toIdx   = monthOptions.findIndex(m => m.value === toMonth);
    if (toIdx < fromIdx) setToMonth(val);
  }

  // ── Quarter-aware presets ──────────────────────────────────────────────
  // Computed once from the current date so "This Quarter" always reflects
  // the actual calendar quarter, not a fixed month count.
  const PRESETS = (() => {
    const now  = new Date();
    const cm   = now.getMonth() + 1;           // 1-12
    const cy   = now.getFullYear();
    const cq   = Math.ceil(cm / 3);            // current quarter 1-4
    const curr = monthOptions[0]?.value ?? ''; // current month (start of window)

    // This quarter: from today's month → last month of current quarter
    const tqEndM  = cq * 3;
    const tqEnd   = `${cy}-${String(tqEndM).padStart(2, '0')}`;

    // Next quarter: first → last month of the following quarter
    const nq      = cq === 4 ? 1 : cq + 1;
    const ny      = cq === 4 ? cy + 1 : cy;
    const nqStart = `${ny}-${String((nq - 1) * 3 + 1).padStart(2, '0')}`;
    const nqEnd   = `${ny}-${String(nq * 3).padStart(2, '0')}`;

    // Numeric presets anchored to current month
    const mo = (i: number) => monthOptions[i]?.value ?? curr;

    return [
      { label: 'This Quarter', from: curr,    to: tqEnd,  key: 'tq'  },
      { label: 'Next Quarter', from: nqStart, to: nqEnd,  key: 'nq'  },
      { label: '6 months',     from: curr,    to: mo(5),  key: '6m'  },
      { label: '12 months',    from: curr,    to: mo(11), key: '12m' },
    ];
  })();

  function applyPreset(from: string, to: string) {
    setFromMonth(from);
    setToMonth(to);
  }

  /** Which preset key is currently active, if any */
  const activePreset = PRESETS.find(
    p => p.from === fromMonth && p.to === toMonth,
  )?.key ?? null;

  // ── Upload & parse ─────────────────────────────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    setFileName(file.name);
    setParsing(true);
    setParseResult(null);
    setSavedConfig(false);
    try {
      const arrayBuf = await file.arrayBuffer();
      const result   = parseTargetUpload(arrayBuf, kpiDefs, getAllOutletIds());
      setParseResult(result);
    } catch (e) {
      console.error('Upload parse error:', e);
    } finally {
      setParsing(false);
    }
  }, [kpiDefs]);

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  // ── Save ───────────────────────────────────────────────────────────────

  function handleSaveTargets() {
    if (!parseResult || parseResult.summary.updated === 0) return;
    const now        = new Date().toISOString();
    const allConfigs = getAllTargetConfigs();
    const months     = Object.keys(parseResult.targetValues);
    const existing   = allConfigs.find(c => c.id === 'excel_upload_config');
    const base = existing ?? {
      id: 'excel_upload_config',
      outletType:  'SSS' as NewOutletType,
      geoLevel:    'INDIA' as const,
      geoName:     'Pan India',
      months:      [],
      kpis:        kpiDefs.filter(d => d.enabled).sort((a, b) => a.order - b.order).map(d => ({
        id: d.id, displayName: d.label, type: 'custom' as const, unit: d.unit, isPrimary: d.isPrimary,
      })),
      status:           'ACTIVE' as const,
      targetValues:     {},
      kpiNameOverrides: {},
      createdAt: now, updatedAt: now,
    };
    const merged = {
      ...base,
      months:           Array.from(new Set([...(base.months ?? []), ...months])).sort(),
      targetValues:     { ...(base.targetValues ?? {}),     ...parseResult.targetValues     },
      kpiNameOverrides: { ...(base.kpiNameOverrides ?? {}), ...parseResult.kpiNameOverrides },
      updatedAt: now,
    };
    upsertTargetConfig(merged);
    setSavedConfig(true);
  }

  // ── Download report ────────────────────────────────────────────────────

  function handleDownloadReport() {
    if (!parseResult) return;
    downloadBuffer(
      buildErrorReportBuffer(parseResult.rows),
      `upload_report_${new Date().toISOString().slice(0, 10)}.xlsx`,
    );
  }

  const sortedKpis       = [...kpiDefs].sort((a, b) => a.order - b.order);
  const enabledKpiCount  = kpiDefs.filter(d => d.enabled).length;
  const overrideColCount = kpiDefs.filter(d => d.enabled && d.hasNameOverride).length;
  const chosenMonths     = selectedMonths();
  const monthSpanLabel   = chosenMonths.length > 0
    ? `${monthOptions.find(m => m.value === chosenMonths[0])?.label} → ${monthOptions.find(m => m.value === chosenMonths[chosenMonths.length - 1])?.label}`
    : '—';
  // "To" options: only months ≥ fromMonth
  const toOptions = monthOptions.filter(
    m => m.value >= fromMonth,
  );

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5 pb-10">

      {/* ── Section 1: KPI Configuration ───────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <button
          onClick={() => setKpiOpen(o => !o)}
          className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gray-100">
              <Settings2 className="w-4 h-4 text-gray-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">KPI Configuration</p>
              <p className="text-xs text-gray-500 mt-0.5">{enabledKpiCount} active KPIs · {overrideColCount} with name-override columns</p>
            </div>
          </div>
          {kpiOpen
            ? <ChevronUp   className="w-4 h-4 text-gray-400" />
            : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </button>

        {kpiOpen && (
          <div className="border-t border-gray-100 px-6 py-5 space-y-4">

            {/* Info note */}
            <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-xs text-blue-700">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-blue-500" />
              <span>
                Changes here affect the template you generate. Adding a KPI automatically adds a new column — no code changes needed.
                Accessible to both <strong>CLIENT_ADMIN</strong> and <strong>GIFSY_ADMIN</strong>.{' '}
                <button
                  onClick={() => saveKpis(DEOLEO_DEFAULT_KPIS)}
                  className="underline text-blue-600 hover:text-blue-800"
                >
                  Reset to Deoleo defaults
                </button>
              </span>
            </div>

            {/* KPI list */}
            <div className="space-y-2">
              {sortedKpis.map((kpi, idx) => (
                <div
                  key={kpi.id}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors ${
                    kpi.enabled ? 'border-gray-200 bg-gray-50' : 'border-gray-100 bg-gray-50 opacity-50'
                  }`}
                >
                  {/* Order */}
                  <div className="flex flex-col gap-0.5 shrink-0">
                    <button onClick={() => moveKpi(kpi.id, -1)} disabled={idx === 0}
                      className="p-0.5 rounded hover:bg-gray-200 disabled:opacity-20" aria-label="Move up">
                      <ArrowUp className="w-3 h-3 text-gray-400" />
                    </button>
                    <button onClick={() => moveKpi(kpi.id, 1)} disabled={idx === sortedKpis.length - 1}
                      className="p-0.5 rounded hover:bg-gray-200 disabled:opacity-20" aria-label="Move down">
                      <ArrowDown className="w-3 h-3 text-gray-400" />
                    </button>
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-800">{kpi.label}</span>
                      {kpi.isPrimary && (
                        <span className="text-[10px] font-semibold bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                          Primary
                        </span>
                      )}
                      {kpi.hasNameOverride && (
                        <span className="text-[10px] font-semibold bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
                          Name col: {kpi.nameOverrideLabel}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">{kpi.unit} · ID: {kpi.id}</p>
                  </div>

                  {/* Toggle + remove */}
                  <button onClick={() => toggleKpi(kpi.id)}
                    className={`shrink-0 text-xs px-2.5 py-1 rounded-lg border font-medium transition-colors ${
                      kpi.enabled
                        ? 'border-red-200 text-red-600 hover:bg-red-50'
                        : 'border-green-200 text-green-700 hover:bg-green-50'
                    }`}>
                    {kpi.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button onClick={() => removeKpi(kpi.id)}
                    className="shrink-0 p-1.5 rounded-lg hover:bg-red-50 text-gray-300 hover:text-red-500 transition-colors"
                    aria-label="Remove KPI">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            {/* Add KPI */}
            {addingKpi ? (
              <div className="border border-gray-200 rounded-xl p-4 bg-white space-y-3">
                <p className="text-xs font-semibold text-gray-700">New KPI</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Column Label *</label>
                    <input
                      value={newKpiLabel}
                      onChange={e => setNewKpiLabel(e.target.value)}
                      placeholder="e.g. New SKU"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 placeholder:text-gray-300 focus:outline-none focus:border-gray-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Unit</label>
                    <input
                      value={newKpiUnit}
                      onChange={e => setNewKpiUnit(e.target.value)}
                      placeholder="cases"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 placeholder:text-gray-300 focus:outline-none focus:border-gray-400"
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={newKpiOverride}
                    onChange={e => setNewKpiOverride(e.target.checked)} className="rounded" />
                  <span className="text-xs text-gray-600">Has per-outlet name override column</span>
                </label>
                {newKpiOverride && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Override column label</label>
                    <input
                      value={newKpiOverrideLabel}
                      onChange={e => setNewKpiOverrideLabel(e.target.value)}
                      placeholder={`${newKpiLabel || 'KPI'} Name`}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 placeholder:text-gray-300 focus:outline-none focus:border-gray-400"
                    />
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={commitAddKpi} disabled={!newKpiLabel.trim()}
                    className="flex items-center gap-1.5 px-3 py-2 bg-[var(--brand-primary)] text-white text-xs font-semibold rounded-lg hover:opacity-90 disabled:opacity-40">
                    Add KPI
                  </button>
                  <button onClick={() => setAddingKpi(false)}
                    className="px-3 py-2 border border-gray-200 text-gray-500 text-xs rounded-lg hover:bg-gray-50">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => setAddingKpi(true)}
                className="flex items-center gap-1.5 px-3 py-2 border border-dashed border-gray-300 text-gray-500 text-xs font-medium rounded-xl hover:border-gray-400 hover:text-gray-700 hover:bg-gray-50 transition-colors">
                <Plus className="w-3.5 h-3.5" />
                Add KPI
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Section 2: Download Template ───────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-green-50">
            <FileSpreadsheet className="w-4 h-4 text-green-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Step 1 — Download Template</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Generate a blank Excel. Fill in Outlet ID, target values, and KPI names, then upload below.
            </p>
          </div>
        </div>

        {/* Preset chips */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 font-semibold mr-1">Quick select:</span>
          {PRESETS.map(p => (
            <button
              key={p.key}
              onClick={() => applyPreset(p.from, p.to)}
              className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
                activePreset === p.key
                  ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* From / To / Download */}
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">From</label>
            <select value={fromMonth} onChange={e => handleFromChange(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:border-gray-400">
              {monthOptions.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">To</label>
            <select value={toMonth} onChange={e => setToMonth(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:border-gray-400">
              {toOptions.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <button
            onClick={handleDownloadTemplate}
            disabled={chosenMonths.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-xl hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            <Download className="w-4 h-4" />
            Download Template
          </button>
        </div>

        {/* Summary line */}
        {chosenMonths.length > 0 && (
          <p className="text-xs text-gray-500">
            <span className="font-semibold text-gray-700">{monthSpanLabel}</span>
            {' '}· {chosenMonths.length} month{chosenMonths.length !== 1 ? 's' : ''}
            {' '}· {12 + overrideColCount + enabledKpiCount * chosenMonths.length} total columns
          </p>
        )}
      </div>

      {/* ── Section 3: Upload ───────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-blue-50">
            <Upload className="w-4 h-4 text-blue-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Step 2 — Upload Filled Template</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Upload your completed Excel. Past months are never overwritten. Unknown outlet IDs are skipped.
            </p>
          </div>
        </div>

        {/* Drop zone */}
        <div
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-gray-200 rounded-2xl px-8 py-10 text-center cursor-pointer hover:border-[var(--brand-primary)] hover:bg-green-50/30 transition-colors"
        >
          <FileSpreadsheet className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          {fileName
            ? <p className="text-sm font-medium text-gray-700">{fileName}</p>
            : <p className="text-sm text-gray-400">Drop your Excel here or <span className="text-[var(--brand-primary)] font-medium underline">browse</span></p>
          }
          <p className="text-xs text-gray-300 mt-1">Accepts .xlsx and .xls</p>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls"
            onChange={handleFileInputChange} className="hidden" />
        </div>

        {parsing && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <div className="w-4 h-4 border-2 border-gray-200 border-t-[var(--brand-primary)] rounded-full animate-spin" />
            Parsing file…
          </div>
        )}
      </div>

      {/* ── Section 4: Results ─────────────────────────────────────────── */}
      {parseResult && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-900">Upload Result</p>
            {savedConfig && (
              <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Saved to active configs
              </span>
            )}
          </div>

          {/* Summary row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Total rows"  value={parseResult.summary.total}   color="gray"    />
            <StatCard label="Updated"     value={parseResult.summary.updated}  color="green"   />
            <StatCard label="Skipped"     value={parseResult.summary.skipped}  color="amber"   />
            <StatCard label="Errors"      value={parseResult.summary.errors}   color="red"     />
          </div>

          {/* Skipped / error rows preview */}
          {parseResult.rows.filter(r => r.status !== 'updated').length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 space-y-1 max-h-44 overflow-y-auto">
              <p className="text-xs font-semibold text-amber-700 mb-2">Skipped / Error rows</p>
              {parseResult.rows
                .filter(r => r.status !== 'updated')
                .slice(0, 20)
                .map(r => (
                  <p key={r.rowIndex} className="text-xs text-amber-700">
                    <span className="font-mono font-semibold">Row {r.rowIndex} — {r.outletId}:</span>{' '}
                    {r.remarks}
                  </p>
                ))}
              {parseResult.rows.filter(r => r.status !== 'updated').length > 20 && (
                <p className="text-xs text-amber-500">…download the report for full details</p>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 flex-wrap">
            {parseResult.summary.updated > 0 && !savedConfig && (
              <button onClick={handleSaveTargets}
                className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity">
                <CheckCircle2 className="w-4 h-4" />
                Save {parseResult.summary.updated} updated target{parseResult.summary.updated !== 1 ? 's' : ''}
              </button>
            )}
            <button onClick={handleDownloadReport}
              className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-600 text-sm font-medium rounded-xl hover:bg-gray-50 transition-colors">
              <Download className="w-4 h-4" />
              Download Report
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

const STAT_COLORS = {
  gray:  'bg-gray-50   border-gray-200  text-gray-800',
  green: 'bg-green-50  border-green-200 text-green-700',
  amber: 'bg-amber-50  border-amber-200 text-amber-700',
  red:   'bg-red-50    border-red-200   text-red-700',
} as const;

function StatCard({ label, value, color }: { label: string; value: number; color: keyof typeof STAT_COLORS }) {
  return (
    <div className={`rounded-xl border px-4 py-3 text-center ${STAT_COLORS[color]}`}>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs font-medium mt-0.5 opacity-70">{label}</p>
    </div>
  );
}
