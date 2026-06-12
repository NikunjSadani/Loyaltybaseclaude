'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Plus, Trash2, Edit2, X, ChevronDown, ChevronRight,
  Target, Upload, Download, FileSpreadsheet,
  AlertTriangle, Lock, Copy, CheckCircle,
  ArrowRight, ArrowLeft, Globe, Building2, LayoutGrid,
  Navigation, ShoppingCart, Package, Layers, Store,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  type NewOutletType, type NewGeoLevel, type KpiType,
  type KpiParam, type TargetConfig, type RejectionEntry, type MockOutlet,
  OUTLET_TYPE_LABELS, OUTLET_TYPE_DESC,
  NEW_GEO_LEVEL_LABELS, KPI_TYPE_LABELS, KPI_TYPE_UNITS, NEW_GEO_OPTIONS,
  MOCK_OUTLETS,
  getAllTargetConfigs, upsertTargetConfig, deleteTargetConfig,
  detectConflict, isMonthLocked, formatMonth, getMonthOptions,
  getOutletsForConfig, resolveNewConfig, getResolvedTargetsData, CURRENT_MONTH,
} from '@/lib/targets';

/* ─── Visual constants ───────────────────────────────────────────────────────── */

const OUTLET_ICONS: Record<NewOutletType, React.ReactNode> = {
  SSS:     <Store    className="h-5 w-5" />,
  WHOLESALER:   <Package  className="h-5 w-5" />,
  SUB_STOCKIST: <Layers   className="h-5 w-5" />,
  SSS_TOT:      <ShoppingCart className="h-5 w-5" />,
};

const OUTLET_TILE_CLS: Record<NewOutletType, string> = {
  SSS:     'border-blue-200   bg-blue-50   text-blue-700   hover:bg-blue-100',
  WHOLESALER:   'border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100',
  SUB_STOCKIST: 'border-amber-200  bg-amber-50  text-amber-700  hover:bg-amber-100',
  SSS_TOT:      'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
};

const OUTLET_BADGE: Record<NewOutletType, string> = {
  SSS:     'bg-blue-100   text-blue-700',
  WHOLESALER:   'bg-purple-100 text-purple-700',
  SUB_STOCKIST: 'bg-amber-100  text-amber-700',
  SSS_TOT:      'bg-emerald-100 text-emerald-700',
};

const GEO_ICONS: Record<NewGeoLevel, React.ReactNode> = {
  INDIA: <Globe      className="h-4 w-4" />,
  STATE: <Building2  className="h-4 w-4" />,
  ASM:   <LayoutGrid className="h-4 w-4" />,
  CITY:  <Navigation className="h-4 w-4" />,
};

const KPI_TYPES: KpiType[] = [
  'monthly_volume', 'quarterly_volume', 'focus_sku',
  'focus_category', 'lines', 'visit_freq', 'custom',
];

const OUTLET_TYPES: NewOutletType[] = ['SSS', 'WHOLESALER', 'SUB_STOCKIST', 'SSS_TOT'];
const GEO_LEVELS:  NewGeoLevel[]    = ['INDIA', 'STATE', 'ASM', 'CITY'];

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

function makeBlankConfig(): TargetConfig {
  const now = new Date().toISOString();
  return {
    id: `tcfg_${Date.now()}`,
    outletType: 'SSS',
    geoLevel: 'INDIA',
    geoName: 'Pan India',
    months: [],
    kpis: [{ id: `kpi_${Date.now()}`, displayName: '', type: 'monthly_volume', unit: 'cases', isPrimary: true }],
    status: 'DRAFT',
    targetValues: {},
    createdAt: now,
    updatedAt: now,
  };
}

function blankKpi(): KpiParam {
  return {
    id: `kpi_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
    displayName: '',
    type: 'monthly_volume',
    unit: 'cases',
    isPrimary: false,
  };
}

function conflictMsg(c: { conflicting: TargetConfig; overlappingMonths: string[] }): string {
  const months = c.overlappingMonths.map(formatMonth).join(', ');
  return `Conflict: A ${NEW_GEO_LEVEL_LABELS[c.conflicting.geoLevel]}-level config for "${c.conflicting.geoName}" already covers ${months}. Choose different months or a different location.`;
}

/* ─── Excel helpers (dynamic import avoids SSR bundle) ───────────────────────── */

async function xlsxDownloadTemplate(config: TargetConfig) {
  const XLSX = await import('xlsx');
  const outlets = getOutletsForConfig(config);
  const kpiHeaders = config.kpis.map(k => k.displayName);
  // month column uses display label (e.g. "Jul '26") — avoids Excel auto-converting "2026-07" to a date serial
  const headers = ['month', 'outlet_id', 'outlet_name', ...kpiHeaders];
  const rows: (string | number)[][] = [];
  for (const month of config.months) {
    for (const o of outlets) {
      rows.push([formatMonth(month), o.id, o.name, ...config.kpis.map(() => '')]);
    }
  }
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Targets');
  XLSX.writeFile(wb, `targets_template_${config.outletType.toLowerCase()}_${config.geoName.replace(/\s+/g, '_')}.xlsx`);
}

async function xlsxParseFile(file: File): Promise<Array<Record<string, unknown>>> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

async function xlsxDownloadRejections(items: RejectionEntry[]) {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([
    ['outlet_id', 'outlet_name', 'rejection_reason'],
    ...items.map(r => [r.outletId, r.outletName ?? '', r.reason]),
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Rejections');
  XLSX.writeFile(wb, 'target_upload_rejections.xlsx');
}

async function xlsxDownloadNoTargets(
  month: string,
  configs: TargetConfig[],
) {
  const XLSX = await import('xlsx');
  const rows: unknown[][] = [['outlet_id', 'outlet_name', 'outlet_type', 'city', 'state', 'asm_zone', 'month_missing']];
  for (const ot of OUTLET_TYPES) {
    const missing = MOCK_OUTLETS[ot].filter(o => !resolveNewConfig(o, ot, month, configs));
    missing.forEach(o => rows.push([o.id, o.name, OUTLET_TYPE_LABELS[ot], o.city, o.state, o.asm, month]));
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'No Targets');
  XLSX.writeFile(wb, `outlets_no_active_targets_${month}.xlsx`);
}

/**
 * Download a resolved targets Excel for a given month.
 * One sheet per outlet type; each sheet has:
 *   outlet_id | outlet_name | city | state | asm_zone | [KPI columns…] | target_source
 */
async function xlsxDownloadResolvedTargets(
  month:   string,
  configs: TargetConfig[],
) {
  const XLSX     = await import('xlsx');
  const rows     = getResolvedTargetsData(month, configs);
  const wb       = XLSX.utils.book_new();
  const types: NewOutletType[] = ['SSS', 'WHOLESALER', 'SUB_STOCKIST', 'SSS_TOT'];

  for (const ot of types) {
    const typeRows = rows.filter(r => r.outletType === ot);
    if (typeRows.length === 0) continue;

    // Collect all unique KPI display-names for this type (union across resolved configs)
    const kpiNames: string[] = [];
    for (const r of typeRows) {
      for (const name of Object.keys(r.kpiValues)) {
        if (!kpiNames.includes(name)) kpiNames.push(name);
      }
    }

    const header = ['outlet_id', 'outlet_name', 'city', 'state', 'asm_zone', ...kpiNames, 'target_source'];
    const data   = typeRows.map(r => [
      r.outletId,
      r.outletName,
      r.city,
      r.state,
      r.asmZone,
      ...kpiNames.map(n => r.kpiValues[n] ?? ''),
      r.targetSource,
    ]);

    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    XLSX.utils.book_append_sheet(wb, ws, OUTLET_TYPE_LABELS[ot]);
  }

  XLSX.writeFile(wb, `final_targets_${month}.xlsx`);
}

/* ─── Upload modal ────────────────────────────────────────────────────────────── */

type ParsedRow = { month: string; outletId: string; outletName: string; kpiValues: Record<string, number> };

function UploadModal({
  config,
  onClose,
  onActivated,
}: {
  config: TargetConfig;
  onClose: () => void;
  onActivated: (updated: TargetConfig) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedRow[]>([]);
  const [rejections, setRejections] = useState<RejectionEntry[]>([]);
  const [parsing, setParsing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const expectedOutlets = getOutletsForConfig(config);
  const expectedIds = new Set(expectedOutlets.map(o => o.id));

  const handleFile = async (f: File) => {
    setFile(f);
    setParsing(true);
    setError('');
    try {
      const rows = await xlsxParseFile(f);
      const accepted: ParsedRow[] = [];
      const rejected: RejectionEntry[] = [];

      // Build a lookup of ALL outlets across all types for cross-type detection
      const allOutletLookup: Record<string, { type: NewOutletType; outlet: MockOutlet }> = {};
      for (const ot of OUTLET_TYPES) {
        for (const o of MOCK_OUTLETS[ot]) {
          allOutletLookup[o.id] = { type: ot, outlet: o };
        }
      }

      for (const row of rows) {
        const rawId = String(row['outlet_id'] ?? '').trim();
        if (!rawId) continue;

        const entry = allOutletLookup[rawId];

        if (!entry) {
          rejected.push({ outletId: rawId, reason: `Outlet ${rawId} does not exist in the system.` });
          continue;
        }

        if (entry.type !== config.outletType) {
          rejected.push({
            outletId: rawId,
            outletName: entry.outlet.name,
            reason: `Outlet ${rawId} (${entry.outlet.name}) is a ${OUTLET_TYPE_LABELS[entry.type]}, not a ${OUTLET_TYPE_LABELS[config.outletType]}.`,
          });
          continue;
        }

        if (!expectedIds.has(rawId)) {
          // Correct type, but outside geo scope
          const o = entry.outlet;
          const scopeDesc =
            config.geoLevel === 'STATE' ? `state ${config.geoName}` :
            config.geoLevel === 'ASM'   ? `ASM zone ${config.geoName}` :
            config.geoLevel === 'CITY'  ? `city ${config.geoName}` :
            'Pan India scope';
          rejected.push({
            outletId: rawId,
            outletName: o.name,
            reason: `Outlet ${rawId} (${o.name}) is in ${o.city}, ${o.state} which is outside this configuration's ${scopeDesc}.`,
          });
          continue;
        }

        // Validate month column
        // Template writes "Jul '26" format to avoid Excel date-serial conversion.
        // Parser accepts both that and raw "2026-07" so hand-edited files work too.
        const rawMonth = String(row['month'] ?? '').trim();
        if (!rawMonth) {
          rejected.push({
            outletId: rawId,
            outletName: entry.outlet.name,
            reason: 'Missing "month" column value. Download the latest template — it now includes a month column.',
          });
          continue;
        }
        const matchedMonth = config.months.find(
          m => formatMonth(m) === rawMonth || m === rawMonth,
        );
        if (!matchedMonth) {
          const validMonths = config.months.map(formatMonth).join(', ');
          rejected.push({
            outletId: rawId,
            outletName: entry.outlet.name,
            reason: `Month "${rawMonth}" is not part of this configuration. Valid months: ${validMonths}.`,
          });
          continue;
        }

        // Reject rows for past months — only current and future months can be updated
        if (isMonthLocked(matchedMonth)) {
          rejected.push({
            outletId: rawId,
            outletName: entry.outlet.name,
            reason: `Month "${rawMonth}" is locked (past months cannot be updated). Only the current month and future months can be modified via re-upload.`,
          });
          continue;
        }

        // Validate and parse KPI values — blank or non-numeric → reject
        const kpiValues: Record<string, number> = {};
        let kpiError: string | null = null;

        for (const kpi of config.kpis) {
          const raw = row[kpi.displayName];
          const rawStr = String(raw ?? '').trim();

          if (rawStr === '') {
            kpiError = `KPI "${kpi.displayName}" is blank. All KPI values must be filled in.`;
            break;
          }

          const num = Number(rawStr);
          if (isNaN(num)) {
            kpiError = `KPI "${kpi.displayName}" has an invalid value "${rawStr}". Only numbers are accepted.`;
            break;
          }

          if (num < 0) {
            kpiError = `KPI "${kpi.displayName}" has a negative value (${rawStr}). Values must be 0 or greater.`;
            break;
          }

          kpiValues[kpi.id] = num;
        }

        if (kpiError) {
          rejected.push({ outletId: rawId, outletName: entry.outlet.name, reason: kpiError });
          continue;
        }

        accepted.push({ month: matchedMonth, outletId: rawId, outletName: entry.outlet.name, kpiValues });
      }

      setParsed(accepted);
      setRejections(rejected);
    } catch {
      setError('Failed to parse file. Make sure it is a valid .xlsx or .csv file.');
    } finally {
      setParsing(false);
    }
  };

  const handleConfirm = async () => {
    setConfirming(true);
    await new Promise(r => setTimeout(r, 600));
    // Build month → outletId → kpiId → value from accepted rows
    const newTargetValues: Record<string, Record<string, Record<string, number>>> = {};
    for (const row of parsed) {
      if (!newTargetValues[row.month]) newTargetValues[row.month] = {};
      newTargetValues[row.month][row.outletId] = row.kpiValues;
    }
    // Merge: keep existing locked-month data; overwrite current/future months with new data
    const updated: TargetConfig = {
      ...config,
      status: 'ACTIVE',
      targetValues: { ...config.targetValues, ...newTargetValues },
      rejectionReport: rejections.length > 0 ? rejections : undefined,
      updatedAt: new Date().toISOString(),
    };
    onActivated(updated);
    setConfirming(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h2 className="text-base font-bold text-gray-900">Upload Target Values</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {OUTLET_TYPE_LABELS[config.outletType]} · {NEW_GEO_LEVEL_LABELS[config.geoLevel]}: {config.geoName}
              {' · '}{config.months.map(formatMonth).join(', ')}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Step 1: Download template */}
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-gray-800">Step 1 — Download template</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Pre-filled with {expectedOutlets.length} outlet(s) and {config.kpis.length} KPI column(s)
              </p>
            </div>
            <button
              onClick={() => xlsxDownloadTemplate(config)}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[var(--brand-primary)] border border-[var(--brand-primary)]/30 rounded-lg hover:bg-[var(--brand-primary)]/5 transition-colors whitespace-nowrap"
            >
              <Download className="h-3.5 w-3.5" /> Download Template
            </button>
          </div>

          {/* Step 2: Upload */}
          <div>
            <p className="text-sm font-semibold text-gray-800 mb-2">Step 2 — Upload filled template</p>
            <div
              className="border-2 border-dashed border-gray-200 rounded-xl p-6 text-center cursor-pointer hover:border-[var(--brand-primary)]/50 hover:bg-[var(--brand-primary)]/2 transition-colors"
              onClick={() => fileRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            >
              <Upload className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              {file ? (
                <p className="text-sm font-medium text-gray-700">{file.name}</p>
              ) : (
                <>
                  <p className="text-sm text-gray-500">Click to upload or drag and drop</p>
                  <p className="text-xs text-gray-400 mt-1">.xlsx or .csv</p>
                </>
              )}
              <input ref={fileRef} type="file" accept=".xlsx,.csv" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
            </div>
          </div>

          {/* Parsing */}
          {parsing && (
            <div className="flex items-center justify-center gap-2 py-4 text-sm text-gray-500">
              <Spinner size="sm" /> Parsing file…
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /> {error}
            </div>
          )}

          {/* Results */}
          {!parsing && file && parsed.length + rejections.length > 0 && (() => {
            const uniqueOutlets = new Set(parsed.map(r => r.outletId)).size;
            const uniqueMonths  = new Set(parsed.map(r => r.month)).size;
            const PREVIEW_LIMIT = 5;
            const previewRows   = parsed.slice(0, PREVIEW_LIMIT);
            const overflow      = parsed.length - PREVIEW_LIMIT;
            return (
              <div className="space-y-3">
                {/* Summary — "rows" because one row = one outlet × one month */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 text-center">
                    <p className="text-2xl font-bold text-emerald-700">{parsed.length}</p>
                    <p className="text-xs text-emerald-600 mt-0.5">
                      Rows accepted
                      {uniqueMonths > 0 && <span className="block text-[10px] text-emerald-500">{uniqueOutlets} outlet{uniqueOutlets !== 1 ? 's' : ''} × {uniqueMonths} month{uniqueMonths !== 1 ? 's' : ''}</span>}
                    </p>
                  </div>
                  <div className={`rounded-xl border p-3 text-center ${rejections.length > 0 ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'}`}>
                    <p className={`text-2xl font-bold ${rejections.length > 0 ? 'text-red-600' : 'text-gray-400'}`}>{rejections.length}</p>
                    <p className={`text-xs mt-0.5 ${rejections.length > 0 ? 'text-red-500' : 'text-gray-400'}`}>Rows rejected</p>
                  </div>
                </div>

                {/* Rejection banner — details in Excel only, not shown on portal */}
                {rejections.length > 0 && (
                  <div className="flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3">
                    <span className="flex items-center gap-2 text-sm font-semibold text-red-700">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      {rejections.length} row{rejections.length !== 1 ? 's' : ''} rejected — download the report for details
                    </span>
                    <button
                      onClick={() => xlsxDownloadRejections(rejections)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-100 hover:bg-red-200 text-red-700 font-semibold text-xs transition-colors whitespace-nowrap"
                    >
                      <Download className="h-3.5 w-3.5" /> Download report
                    </button>
                  </div>
                )}

                {/* Preview — capped at 5 rows regardless of upload size */}
                {parsed.length > 0 && (
                  <div className="rounded-xl border border-gray-200 overflow-hidden">
                    <p className="px-4 py-2 bg-gray-50 text-xs font-semibold text-gray-600 border-b border-gray-200">
                      Preview — first {Math.min(parsed.length, PREVIEW_LIMIT)} of {parsed.length} accepted rows
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-[10px] text-gray-400 uppercase tracking-wide">
                            <th className="px-3 py-2 text-left">Month</th>
                            <th className="px-3 py-2 text-left">Outlet</th>
                            {config.kpis.map(k => (
                              <th key={k.id} className="px-3 py-2 text-right">{k.displayName}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {previewRows.map(row => (
                            <tr key={`${row.month}-${row.outletId}`}>
                              <td className="px-3 py-1.5 text-gray-500">{formatMonth(row.month)}</td>
                              <td className="px-3 py-1.5 font-mono text-gray-700">{row.outletId}</td>
                              {config.kpis.map(k => (
                                <td key={k.id} className="px-3 py-1.5 text-right text-gray-800">{row.kpiValues[k.id] ?? 0}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {overflow > 0 && (
                      <p className="px-4 py-2 text-xs text-gray-400 bg-gray-50 border-t border-gray-100">
                        … and {overflow} more row{overflow !== 1 ? 's' : ''} not shown
                      </p>
                    )}
                  </div>
                )}

                <p className="text-xs text-gray-400 italic">
                  Each upload fully replaces the previous one. To fix rejected rows, correct their values and re-upload the complete file including all rows.
                </p>
              </div>
            );
          })()}
        </div>

        {/* Footer */}
        <div className="px-5 pb-5 flex justify-end gap-3 border-t border-gray-100 pt-4">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={confirming}
            disabled={parsed.length === 0 || parsing}
            onClick={handleConfirm}
          >
            <CheckCircle className="h-4 w-4" />
            {parsed.length === 0
              ? 'Confirm & Activate'
              : `Confirm & Activate (${new Set(parsed.map(r => r.outletId)).size} outlets × ${new Set(parsed.map(r => r.month)).size} month${new Set(parsed.map(r => r.month)).size !== 1 ? 's' : ''})`}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ─── Config wizard (3-step) ─────────────────────────────────────────────────── */

function ConfigWizard({
  initial,
  allConfigs,
  onSave,
  onCancel,
  startStep = 1,
}: {
  initial: TargetConfig;
  allConfigs: TargetConfig[];
  onSave: (cfg: TargetConfig) => void;
  onCancel: () => void;
  startStep?: 1 | 2 | 3;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(startStep);
  const [cfg, setCfg] = useState<TargetConfig>(() => ({
    ...initial,
    kpis: initial.kpis.map(k => ({ ...k })),
  }));
  const [saving, setSaving] = useState(false);
  const [conflictErr, setConflictErr] = useState('');
  const monthOptions = getMonthOptions();

  // Check if any month is locked → KPIs are immutable
  const hasLockedMonths = cfg.months.some(isMonthLocked);

  // Re-run conflict check on scope changes
  useEffect(() => {
    if (step === 2 && cfg.months.length > 0) {
      const c = detectConflict(cfg, allConfigs, initial.id);
      setConflictErr(c ? conflictMsg(c) : '');
    } else {
      setConflictErr('');
    }
  }, [cfg.outletType, cfg.geoLevel, cfg.geoName, cfg.months, step, allConfigs, initial.id]);

  const setGeoLevel = (level: NewGeoLevel) =>
    setCfg(c => ({ ...c, geoLevel: level, geoName: NEW_GEO_OPTIONS[level][0] }));

  const toggleMonth = (m: string) => {
    if (isMonthLocked(m)) return;
    setCfg(c => ({
      ...c,
      months: c.months.includes(m) ? c.months.filter(x => x !== m) : [...c.months, m].sort(),
    }));
  };

  const setKpi = (idx: number, field: keyof KpiParam, value: string) =>
    setCfg(c => {
      const kpis = [...c.kpis];
      kpis[idx] = {
        ...kpis[idx],
        [field]: value,
        ...(field === 'type' ? { unit: KPI_TYPE_UNITS[value as KpiType] } : {}),
      };
      return { ...c, kpis };
    });

  const addKpi = () => setCfg(c => ({ ...c, kpis: [...c.kpis, blankKpi()] }));
  const removeKpi = (idx: number) => setCfg(c => ({ ...c, kpis: c.kpis.filter((_, i) => i !== idx) }));

  /** Mark exactly one KPI as primary; clear the flag on all others. */
  const setPrimary = (idx: number) =>
    setCfg(c => ({
      ...c,
      kpis: c.kpis.map((k, i) => ({ ...k, isPrimary: i === idx ? true : false })),
    }));

  const kpisValid = cfg.kpis.length > 0 && cfg.kpis.every(k => k.displayName.trim().length > 0);
  const scopeValid = cfg.months.length > 0 && !conflictErr;

  const handleSave = async () => {
    setSaving(true);
    await new Promise(r => setTimeout(r, 400));
    onSave({ ...cfg, updatedAt: new Date().toISOString() });
    setSaving(false);
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Wizard header */}
      <div className="flex items-center gap-4 px-6 py-4 border-b border-gray-100 bg-gray-50">
        {[
          { n: 1 as const, label: 'Outlet Type' },
          { n: 2 as const, label: 'Scope' },
          { n: 3 as const, label: 'KPIs' },
        ].map(({ n, label }, i) => (
          <React.Fragment key={n}>
            <button
              onClick={() => n < step && setStep(n)}
              className={`flex items-center gap-2 text-sm font-semibold transition-colors
                ${step === n ? 'text-[var(--brand-primary)]' : step > n ? 'text-emerald-600 cursor-pointer' : 'text-gray-300 cursor-default'}`}
            >
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs border-2
                ${step === n ? 'border-[var(--brand-primary)] text-[var(--brand-primary)] bg-[var(--brand-primary)]/5'
                  : step > n ? 'border-emerald-500 bg-emerald-50 text-emerald-600'
                  : 'border-gray-200 text-gray-300'}`}>
                {step > n ? <CheckCircle className="h-3.5 w-3.5" /> : n}
              </span>
              <span className="hidden sm:inline">{label}</span>
            </button>
            {i < 2 && <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />}
          </React.Fragment>
        ))}
        <button onClick={onCancel} className="ml-auto p-1.5 rounded-full hover:bg-gray-200 text-gray-400">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="p-6">
        {/* ── Step 1: Outlet Type ─────────────────────────────────────────────── */}
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-bold text-gray-900">Choose Outlet Type</h3>
              <p className="text-sm text-gray-500 mt-0.5">Select the channel partner type this configuration applies to.</p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {OUTLET_TYPES.map(ot => (
                <button
                  key={ot}
                  onClick={() => setCfg(c => ({ ...c, outletType: ot }))}
                  className={`relative flex flex-col items-center gap-2.5 p-4 rounded-xl border-2 transition-all text-center
                    ${cfg.outletType === ot
                      ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/5 shadow-sm ring-2 ring-[var(--brand-primary)]/20'
                      : 'border-gray-200 hover:border-gray-300 bg-white'}`}
                >
                  <div className={`p-2.5 rounded-xl ${cfg.outletType === ot ? 'bg-[var(--brand-primary)] text-white' : 'bg-gray-100 text-gray-500'}`}>
                    {OUTLET_ICONS[ot]}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-gray-900">{OUTLET_TYPE_LABELS[ot]}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5 leading-tight">{OUTLET_TYPE_DESC[ot]}</p>
                  </div>
                  {cfg.outletType === ot && (
                    <CheckCircle className="absolute top-2 right-2 h-4 w-4 text-[var(--brand-primary)]" />
                  )}
                </button>
              ))}
            </div>
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => setStep(2)}>
                Continue <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 2: Geo Level + Location + Months ─────────────────────────── */}
        {step === 2 && (
          <div className="space-y-5">
            <div>
              <h3 className="text-base font-bold text-gray-900">Set Scope</h3>
              <p className="text-sm text-gray-500 mt-0.5">Define the geography and time period.</p>
            </div>

            {/* Geo level tabs */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Geography Level</label>
              <div className="flex flex-wrap gap-2">
                {GEO_LEVELS.map(gl => (
                  <button
                    key={gl}
                    onClick={() => setGeoLevel(gl)}
                    className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border text-sm font-semibold transition-colors
                      ${cfg.geoLevel === gl
                        ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}
                  >
                    {GEO_ICONS[gl]}
                    {NEW_GEO_LEVEL_LABELS[gl]}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400">
                {cfg.geoLevel === 'INDIA' && 'Applies to all outlets in India. Lowest priority in hierarchy.'}
                {cfg.geoLevel === 'STATE' && 'Applies to all outlets in the selected state.'}
                {cfg.geoLevel === 'ASM'   && 'Applies to outlets in the ASM zone. Overrides State config.'}
                {cfg.geoLevel === 'CITY'  && 'Highest priority. Applies to this city only, overrides all parent configs.'}
              </p>
            </div>

            {/* Location */}
            {cfg.geoLevel !== 'INDIA' && (
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Location</label>
                <select
                  value={cfg.geoName}
                  onChange={e => setCfg(c => ({ ...c, geoName: e.target.value }))}
                  className="w-full max-w-xs text-sm border border-gray-200 rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
                >
                  {NEW_GEO_OPTIONS[cfg.geoLevel].map(g => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
            )}

            {/* Month picker */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Time Period <span className="normal-case font-normal text-gray-400">(select one or more months)</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {monthOptions.map(mo => (
                  <button
                    key={mo.value}
                    onClick={() => toggleMonth(mo.value)}
                    disabled={mo.locked}
                    title={mo.locked ? 'This month is locked (current or past)' : undefined}
                    className={`flex items-center gap-1 px-3 py-1.5 rounded-full border text-xs font-semibold transition-all
                      ${mo.locked
                        ? 'border-gray-100 bg-gray-50 text-gray-300 cursor-not-allowed'
                        : cfg.months.includes(mo.value)
                          ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white'
                          : 'border-gray-200 bg-white text-gray-600 hover:border-gray-400'}`}
                  >
                    {mo.locked && <Lock className="h-2.5 w-2.5" />}
                    {mo.label}
                  </button>
                ))}
              </div>
              {cfg.months.length === 0 && (
                <p className="text-xs text-amber-600">Select at least one month to continue.</p>
              )}
            </div>

            {/* Conflict error */}
            {conflictErr && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{conflictErr}</span>
              </div>
            )}

            {/* Outlet count hint */}
            {cfg.months.length > 0 && !conflictErr && (
              <div className="flex items-center gap-2 text-xs text-gray-500 bg-gray-50 rounded-xl px-3 py-2">
                <Store className="h-3.5 w-3.5" />
                This config will cover <strong className="text-gray-800">{getOutletsForConfig(cfg).length}</strong> outlet(s) in scope.
              </div>
            )}

            <div className="flex gap-3 justify-between">
              <Button variant="outline" onClick={() => setStep(1)}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Button variant="primary" disabled={!scopeValid} onClick={() => setStep(3)}>
                Continue <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 3: KPIs ────────────────────────────────────────────────────── */}
        {step === 3 && (
          <div className="space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-bold text-gray-900">Define KPIs</h3>
                <p className="text-sm text-gray-500 mt-0.5">Use the actual SKU / category names as they appear in your catalog.</p>
              </div>
              {hasLockedMonths && (
                <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded-xl px-3 py-1.5 text-xs font-semibold text-amber-700">
                  <Lock className="h-3.5 w-3.5" />
                  KPIs locked — contains past/current months
                </div>
              )}
            </div>

            {/* KPI header row */}
            <div className="hidden md:grid grid-cols-12 gap-2 text-[10px] font-semibold text-gray-400 uppercase tracking-wide px-1">
              <div className="col-span-4">Display Name <span className="normal-case font-normal text-gray-300">(shown to partner)</span></div>
              <div className="col-span-3">KPI Type</div>
              <div className="col-span-2">Unit</div>
              <div className="col-span-2 text-center">Primary</div>
              <div className="col-span-1" />
            </div>

            <div className="space-y-2">
              {cfg.kpis.map((kpi, idx) => (
                <div
                  key={kpi.id}
                  className={`grid grid-cols-12 gap-2 items-center p-2.5 rounded-xl border ${
                    kpi.isPrimary
                      ? hasLockedMonths ? 'bg-amber-50 border-amber-100' : 'bg-[var(--brand-primary)]/5 border-[var(--brand-primary)]/30'
                      : hasLockedMonths ? 'bg-gray-50 border-gray-100' : 'bg-white border-gray-200'
                  }`}
                >
                  <div className="col-span-12 md:col-span-4">
                    <input
                      type="text"
                      value={kpi.displayName}
                      onChange={e => setKpi(idx, 'displayName', e.target.value)}
                      disabled={hasLockedMonths}
                      placeholder="e.g. Bertolli EV 500ml / EVOO Category"
                      className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-2 disabled:bg-gray-50 disabled:text-gray-400 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
                    />
                  </div>
                  <div className="col-span-6 md:col-span-3">
                    <select
                      value={kpi.type}
                      onChange={e => setKpi(idx, 'type', e.target.value)}
                      disabled={hasLockedMonths}
                      className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-2 bg-white disabled:bg-gray-50 disabled:text-gray-400 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
                    >
                      {KPI_TYPES.map(t => <option key={t} value={t}>{KPI_TYPE_LABELS[t]}</option>)}
                    </select>
                  </div>
                  <div className="col-span-4 md:col-span-2">
                    <input
                      type="text"
                      value={kpi.unit}
                      onChange={e => setKpi(idx, 'unit', e.target.value)}
                      disabled={hasLockedMonths}
                      placeholder="cases / visits"
                      className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-2 disabled:bg-gray-50 disabled:text-gray-400 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
                    />
                  </div>
                  {/* Primary KPI radio */}
                  <div className="col-span-1 md:col-span-2 flex items-center justify-center">
                    <button
                      onClick={() => !hasLockedMonths && setPrimary(idx)}
                      disabled={hasLockedMonths}
                      title={kpi.isPrimary ? 'Primary KPI (shown as headline metric)' : 'Set as Primary KPI'}
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all disabled:opacity-40 ${
                        kpi.isPrimary
                          ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]'
                          : 'border-gray-300 hover:border-[var(--brand-primary)]/60'
                      }`}
                    >
                      {kpi.isPrimary && <span className="w-2 h-2 rounded-full bg-white" />}
                    </button>
                  </div>
                  <div className="col-span-1 flex items-center justify-end">
                    {hasLockedMonths
                      ? <Lock className="h-3.5 w-3.5 text-gray-300" />
                      : (
                        <button
                          onClick={() => removeKpi(idx)}
                          disabled={cfg.kpis.length === 1}
                          className="p-1 text-gray-500 hover:text-red-500 disabled:opacity-30 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )
                    }
                  </div>
                </div>
              ))}
            </div>

            {!hasLockedMonths && (
              <button
                onClick={addKpi}
                className="flex items-center gap-1.5 text-xs font-semibold text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/5 px-3 py-2 rounded-lg border border-[var(--brand-primary)]/20 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" /> Add KPI
              </button>
            )}

            {/* Summary */}
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-3 text-xs text-blue-700 space-y-0.5">
              <p className="font-semibold text-blue-800">Configuration Summary</p>
              <p>Type: <strong>{OUTLET_TYPE_LABELS[cfg.outletType]}</strong></p>
              <p>Scope: <strong>{NEW_GEO_LEVEL_LABELS[cfg.geoLevel]}</strong> — {cfg.geoName}</p>
              <p>Months: <strong>{cfg.months.map(formatMonth).join(', ')}</strong></p>
              <p>KPIs: <strong>{cfg.kpis.filter(k => k.displayName).length}</strong> defined</p>
              {(() => {
                const primary = cfg.kpis.find(k => k.isPrimary);
                return primary?.displayName
                  ? <p>Primary KPI: <strong>{primary.displayName}</strong> (shown as headline on dashboards)</p>
                  : null;
              })()}
              <p className="pt-1 text-blue-500">Target values will be uploaded separately via Excel. Config will be saved as DRAFT.</p>
            </div>

            <div className="flex gap-3 justify-between">
              <Button variant="outline" onClick={() => setStep(2)}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Button variant="primary" loading={saving} disabled={!kpisValid} onClick={handleSave}>
                Save as Draft
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Config card ────────────────────────────────────────────────────────────── */

function ConfigCard({
  cfg,
  onEdit,
  onDelete,
  onDuplicate,
  onUpload,
}: {
  cfg: TargetConfig;
  onEdit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onUpload: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const allLocked = cfg.months.length > 0 && cfg.months.every(isMonthLocked);
  const anyLocked = cfg.months.some(isMonthLocked);

  return (
    <div className={`bg-white rounded-2xl border overflow-hidden transition-shadow hover:shadow-sm ${cfg.status === 'ACTIVE' ? 'border-emerald-200' : 'border-gray-200'}`}>
      <div className="flex items-center gap-3 px-5 py-4">
        {/* Outlet type icon */}
        <div className={`p-2 rounded-xl shrink-0 ${
          cfg.outletType === 'SSS'     ? 'bg-blue-50   text-blue-600'   :
          cfg.outletType === 'WHOLESALER'   ? 'bg-purple-50 text-purple-600' :
          cfg.outletType === 'SUB_STOCKIST' ? 'bg-amber-50  text-amber-600'  :
                                              'bg-emerald-50 text-emerald-600'
        }`}>
          {OUTLET_ICONS[cfg.outletType]}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center flex-wrap gap-1.5">
            <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${OUTLET_BADGE[cfg.outletType]}`}>
              {OUTLET_TYPE_LABELS[cfg.outletType]}
            </span>
            <span className="flex items-center gap-1 text-xs font-semibold text-gray-700">
              {GEO_ICONS[cfg.geoLevel]}
              {NEW_GEO_LEVEL_LABELS[cfg.geoLevel]}: {cfg.geoName}
            </span>
            <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
              cfg.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
            }`}>
              {cfg.status}
            </span>
          </div>

          {/* Month chips */}
          <div className="flex flex-wrap gap-1 mt-1.5">
            {cfg.months.map(m => (
              <span
                key={m}
                className={`flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border
                  ${isMonthLocked(m) ? 'bg-gray-50 text-gray-400 border-gray-200' : 'bg-[var(--brand-primary)]/5 text-[var(--brand-primary)] border-[var(--brand-primary)]/20'}`}
              >
                {isMonthLocked(m) && <Lock className="h-2 w-2" />}
                {formatMonth(m)}
              </span>
            ))}
            {cfg.months.length === 0 && <span className="text-xs text-gray-400 italic">No months set</span>}
          </div>

          <p className="text-xs text-gray-400 mt-1">
            {cfg.kpis.length} KPI{cfg.kpis.length !== 1 ? 's' : ''}
            {cfg.status === 'ACTIVE' && Object.keys(cfg.targetValues).length > 0 && (() => {
              const outlets = new Set(Object.values(cfg.targetValues).flatMap(m => Object.keys(m))).size;
              const months  = Object.keys(cfg.targetValues).length;
              return ` · ${outlets} outlet${outlets !== 1 ? 's' : ''} × ${months} month${months !== 1 ? 's' : ''} with targets`;
            })()}
            {cfg.rejectionReport && cfg.rejectionReport.length > 0
              && ` · ${cfg.rejectionReport.length} rejected on last upload`}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Upload / Re-upload — available for both DRAFT (first upload) and ACTIVE (re-upload present/future months) */}
          {(cfg.status === 'DRAFT' || cfg.status === 'ACTIVE') && (
            <button
              onClick={onUpload}
              title={cfg.status === 'ACTIVE' ? 'Re-upload to update targets for current / future months' : 'Upload target values (Excel)'}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-[var(--brand-primary)] text-white rounded-lg hover:opacity-90 transition-opacity"
            >
              <Upload className="h-3.5 w-3.5" />
              {cfg.status === 'ACTIVE' ? 'Re-upload' : 'Upload'}
            </button>
          )}
          {!allLocked && cfg.status !== 'ACTIVE' && (
            <button onClick={onEdit} title="Edit" className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors">
              <Edit2 className="h-4 w-4" />
            </button>
          )}
          <button onClick={onDuplicate} title="Duplicate (clears months)" className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors">
            <Copy className="h-4 w-4" />
          </button>
          <button onClick={onDelete} title="Delete" className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors">
            <Trash2 className="h-4 w-4" />
          </button>
          <button onClick={() => setExpanded(v => !v)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors">
            <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      {/* Expanded KPI list */}
      {expanded && (
        <div className="border-t border-gray-100">
          <table className="w-full text-left">
            <thead>
              <tr className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide bg-gray-50">
                <th className="py-2 pl-5 pr-2">KPI Name</th>
                <th className="py-2 px-2">Type</th>
                <th className="py-2 pl-2 pr-5">Unit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {cfg.kpis.map(kpi => (
                <tr key={kpi.id} className="text-sm">
                  <td className="py-2.5 pl-5 pr-2 font-medium text-gray-800">{kpi.displayName}</td>
                  <td className="py-2.5 px-2 text-xs text-gray-400">{KPI_TYPE_LABELS[kpi.type]}</td>
                  <td className="py-2.5 pl-2 pr-5 text-xs text-gray-400">{kpi.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Last upload rejection report (if any) */}
          {cfg.rejectionReport && cfg.rejectionReport.length > 0 && (
            <div className="border-t border-orange-100 bg-orange-50 px-5 py-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-orange-700 flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {cfg.rejectionReport.length} outlet(s) were rejected on last upload
                </p>
                <button
                  onClick={() => xlsxDownloadRejections(cfg.rejectionReport!)}
                  className="flex items-center gap-1 text-[10px] font-semibold text-orange-700 hover:text-orange-900 px-2 py-1 rounded bg-orange-100 hover:bg-orange-200 transition-colors"
                >
                  <Download className="h-3 w-3" /> Download
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── No-targets warning ─────────────────────────────────────────────────────── */

function NoTargetsWarning({ configs }: { configs: TargetConfig[] }) {
  const [checkMonth, setCheckMonth] = useState('');
  const [downloading, setDownloading] = useState(false);
  const monthOpts = getMonthOptions().filter(m => !m.locked);

  // Default to next calendar month
  useEffect(() => {
    if (monthOpts.length > 0 && !checkMonth) setCheckMonth(monthOpts[0].value);
  }, [monthOpts, checkMonth]);

  const missingCount = checkMonth
    ? OUTLET_TYPES.reduce((sum, ot) => {
        return sum + MOCK_OUTLETS[ot].filter(o => !resolveNewConfig(o, ot, checkMonth, configs)).length;
      }, 0)
    : 0;

  if (missingCount === 0) return null;

  const handleDownload = async () => {
    setDownloading(true);
    await xlsxDownloadNoTargets(checkMonth, configs);
    setDownloading(false);
  };

  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 bg-amber-50 border border-amber-200 rounded-2xl p-4">
      <div className="flex items-center gap-2 flex-1">
        <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
        <div>
          <p className="text-sm font-semibold text-amber-800">
            {missingCount} outlet{missingCount !== 1 ? 's' : ''} have no active target for{' '}
            <select
              value={checkMonth}
              onChange={e => setCheckMonth(e.target.value)}
              className="inline-block text-sm font-bold text-amber-800 bg-transparent border-b border-amber-400 focus:outline-none cursor-pointer"
            >
              {monthOpts.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </p>
          <p className="text-xs text-amber-600 mt-0.5">Partners in scope will not receive target notifications.</p>
        </div>
      </div>
      <button
        onClick={handleDownload}
        disabled={downloading}
        className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-amber-700 border border-amber-300 rounded-lg hover:bg-amber-100 bg-white transition-colors whitespace-nowrap"
      >
        {downloading ? <Spinner size="xs" /> : <Download className="h-3.5 w-3.5" />}
        Download Report
      </button>
    </div>
  );
}

/* ─── Excel-only mode (Deoleo) ────────────────────────────────────────────────
 * Set NEXT_PUBLIC_EXCEL_TARGETS_ONLY=true in the tenant's deployment to hide
 * the legacy wizard/card UI and show only the Excel upload entry point.
 * All other tenants continue to see the full config interface.
 * ─────────────────────────────────────────────────────────────────────────── */

const EXCEL_TARGETS_ONLY = process.env.NEXT_PUBLIC_EXCEL_TARGETS_ONLY === 'true';

function ExcelOnlyTargetsPage() {
  const router = useRouter();
  useEffect(() => { router.replace('/admin/targets/upload'); }, [router]);
  return null;
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function AdminTargetsPage() {
  if (EXCEL_TARGETS_ONLY) return <ExcelOnlyTargetsPage />;

  const [configs, setConfigs]    = useState<TargetConfig[]>([]);
  const [loading, setLoading]    = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingCfg, setEditingCfg] = useState<TargetConfig | null>(null);
  const [uploadCfg, setUploadCfg]   = useState<TargetConfig | null>(null);
  const [filterType,    setFilterType]    = useState<NewOutletType | 'ALL'>('ALL');
  const [filterStatus,  setFilterStatus]  = useState<'ALL' | 'DRAFT' | 'ACTIVE'>('ALL');
  const [downloadMonth, setDownloadMonth] = useState<string>(CURRENT_MONTH);
  const [downloading,   setDownloading]   = useState(false);

  const reload = useCallback(() => {
    setConfigs(getAllTargetConfigs());
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { reload(); setLoading(false); }, 300);
    return () => clearTimeout(t);
  }, [reload]);

  const handleSave = (cfg: TargetConfig) => {
    upsertTargetConfig(cfg);
    reload();
    setWizardOpen(false);
    setEditingCfg(null);
  };

  const handleDelete = (id: string) => {
    if (!confirm('Delete this target configuration?')) return;
    deleteTargetConfig(id);
    reload();
  };

  const handleDuplicate = (src: TargetConfig) => {
    const dup: TargetConfig = {
      ...src,
      id: `tcfg_${Date.now()}`,
      months: [],             // clear months for the duplicate
      status: 'DRAFT',
      targetValues: {},
      rejectionReport: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setEditingCfg(dup);
    setWizardOpen(false);
  };

  const handleActivated = (updated: TargetConfig) => {
    upsertTargetConfig(updated);
    reload();
    setUploadCfg(null);
    // Notify partners (mock — in production POST to /api/notifications)
    console.info('[TARGET] Config activated, partner notifications queued:', updated.id);
  };

  const handleDownloadFinalTargets = async () => {
    setDownloading(true);
    await xlsxDownloadResolvedTargets(downloadMonth, configs);
    setDownloading(false);
  };

  const filtered = configs.filter(c => {
    if (filterType !== 'ALL' && c.outletType !== filterType) return false;
    if (filterStatus !== 'ALL' && c.status !== filterStatus) return false;
    return true;
  });

  return (
    <div className="space-y-6">

      {/* ── Excel Upload Banner (primary entry point) ───────────────────── */}
      <Link
        href="/admin/targets/upload"
        className="flex items-center justify-between gap-4 px-5 py-4 rounded-2xl border-2 border-[var(--brand-primary)]/30 bg-[var(--brand-primary)]/5 hover:bg-[var(--brand-primary)]/10 hover:border-[var(--brand-primary)]/50 transition-colors group"
      >
        <div className="flex items-center gap-4">
          <div className="p-2.5 rounded-xl bg-[var(--brand-primary)]/10 shrink-0">
            <FileSpreadsheet className="h-6 w-6 text-[var(--brand-primary)]" />
          </div>
          <div>
            <p className="text-sm font-bold text-gray-900">Upload Targets via Excel</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Configure KPIs, download a template, fill it in, and upload to set outlet-level targets in bulk.
            </p>
          </div>
        </div>
        <ArrowRight className="h-5 w-5 text-[var(--brand-primary)] shrink-0 group-hover:translate-x-1 transition-transform" />
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Target Configuration</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Configure sales targets by outlet type and geography. Hierarchy: City &gt; ASM &gt; State &gt; Pan India.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          {/* Download Final Targets — resolved view per outlet with source column */}
          <div className="flex items-center gap-1.5 border border-gray-200 rounded-xl px-3 py-2 bg-white">
            <Download className="h-4 w-4 text-gray-400 shrink-0" />
            <select
              value={downloadMonth}
              onChange={e => setDownloadMonth(e.target.value)}
              className="text-xs text-gray-700 bg-transparent border-none outline-none cursor-pointer font-medium"
            >
              {getMonthOptions().map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <button
              onClick={handleDownloadFinalTargets}
              disabled={downloading}
              className="flex items-center gap-1 text-xs font-semibold text-[var(--brand-primary)] hover:underline disabled:opacity-40 whitespace-nowrap"
            >
              {downloading ? <Spinner size="xs" /> : null}
              Download Final Targets
            </button>
          </div>

          <Button
            variant="primary"
            onClick={() => { setEditingCfg(null); setWizardOpen(v => !v); }}
          >
            <Plus className="h-4 w-4" />
            {wizardOpen && !editingCfg ? 'Cancel' : 'New Config'}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-64">
          <Spinner size="lg" />
        </div>
      ) : (
        <>
          {/* Wizard — new config */}
          {wizardOpen && !editingCfg && (
            <ConfigWizard
              initial={makeBlankConfig()}
              allConfigs={configs}
              onSave={handleSave}
              onCancel={() => setWizardOpen(false)}
              startStep={1}
            />
          )}

          {/* Wizard — edit / duplicate */}
          {editingCfg && (
            <ConfigWizard
              initial={editingCfg}
              allConfigs={configs}
              onSave={handleSave}
              onCancel={() => setEditingCfg(null)}
              startStep={editingCfg.months.length === 0 ? 2 : 3}
            />
          )}

          {/* No-targets warning */}
          <NoTargetsWarning configs={configs} />

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Outlet type filter */}
            <div className="flex items-center gap-1 bg-gray-100 rounded-full p-1">
              {(['ALL', ...OUTLET_TYPES] as const).map(ot => (
                <button
                  key={ot}
                  onClick={() => setFilterType(ot)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors
                    ${filterType === ot ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  {ot === 'ALL' ? 'All Types' : OUTLET_TYPE_LABELS[ot]}
                </button>
              ))}
            </div>

            {/* Status filter */}
            <div className="flex items-center gap-1 bg-gray-100 rounded-full p-1">
              {(['ALL', 'DRAFT', 'ACTIVE'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setFilterStatus(s)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors
                    ${filterStatus === s ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  {s === 'ALL' ? 'All Status' : s}
                </button>
              ))}
            </div>

            <span className="text-xs text-gray-400 ml-auto">
              {filtered.length} configuration{filtered.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Config list */}
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <Target className="h-12 w-12 text-gray-200" />
              <p className="text-sm font-semibold text-gray-400">No target configurations found.</p>
              <p className="text-xs text-gray-300 max-w-xs">
                {configs.length === 0
                  ? 'Create your first configuration by clicking "+ New Config" above.'
                  : 'Try clearing the filters.'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map(cfg => (
                editingCfg?.id === cfg.id ? null : (
                  <ConfigCard
                    key={cfg.id}
                    cfg={cfg}
                    onEdit={() => { setEditingCfg(cfg); setWizardOpen(false); }}
                    onDelete={() => handleDelete(cfg.id)}
                    onDuplicate={() => handleDuplicate(cfg)}
                    onUpload={() => setUploadCfg(cfg)}
                  />
                )
              ))}
            </div>
          )}
        </>
      )}

      {/* Upload modal */}
      {uploadCfg && (
        <UploadModal
          config={uploadCfg}
          onClose={() => setUploadCfg(null)}
          onActivated={handleActivated}
        />
      )}
    </div>
  );
}
