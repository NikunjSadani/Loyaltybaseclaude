'use client';

/**
 * VisibilityReportView — per-window coverage report for Visibility (POSM)
 * (VISIBILITY-POSM-DESIGN.md D15). Shared by BOTH the GIFSY admin report tab and
 * the tenant read-only report page.
 *
 *   - `variant="admin"`  → reads visibilityApi.getReport + shows the Excel export.
 *   - `variant="tenant"` → reads visibilityApi.getTenantReport, NO export.
 *
 * Coverage tiles (denominator / captured / pending / rejected / missed + %) with a
 * window selector derived from the report's own frequencyPerMonth. It does NOT import
 * the scheme feature.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Loader2, AlertCircle, BarChart3 } from 'lucide-react';
import { visibilityApi } from '@/lib/visibility';
import type { VisibilityReport } from '@/lib/visibility-types';
import { windowOptions } from '@/lib/visibility-window';

type Variant = 'admin' | 'tenant';

/** Derive `YYYY-MM` from a `YYYY-MM-Pn` window key (for the window selector). */
function monthOfWindowKey(windowKey: string): string | null {
  const m = /^(\d{4}-\d{2})-P\d+$/.exec(windowKey);
  return m ? m[1] : null;
}

export function VisibilityReportView({ variant }: { variant: Variant }) {
  const [report, setReport] = useState<VisibilityReport | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const fetcher = variant === 'admin' ? visibilityApi.getReport : visibilityApi.getTenantReport;

  const load = useCallback(async (windowKey?: string) => {
    setLoading(true);
    setError(null);
    const res = await fetcher(windowKey);
    if (res.success) {
      setReport(res.data);
      setSelected(res.data.windowKey);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, [fetcher]);

  useEffect(() => { void load(); }, [load]);

  // Window options for the report's own month + frequency.
  const options = useMemo(() => {
    if (!report) return [];
    const month = monthOfWindowKey(report.windowKey);
    if (!month) return [];
    try { return windowOptions(month, report.frequencyPerMonth); }
    catch { return []; }
  }, [report]);

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    const res = await visibilityApi.downloadExport(selected || undefined);
    setExporting(false);
    if (!res.success) setExportError(res.error);
  };

  return (
    <div className="space-y-5">
      {/* Header row: window selector + export */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500">Window</label>
          <select
            value={selected}
            onChange={(e) => { setSelected(e.target.value); void load(e.target.value); }}
            aria-label="Report window"
            disabled={options.length === 0}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
          >
            {options.length === 0 && report && <option value={report.windowKey}>{report.windowKey}</option>}
            {options.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.value})</option>)}
          </select>
          {report?.windowClosed && <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">closed</span>}
        </div>
        {variant === 'admin' && (
          <div className="flex flex-col items-end gap-1">
            <button onClick={handleExport} disabled={exporting}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-medium rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60">
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {exporting ? 'Exporting…' : 'Export Excel'}
            </button>
            {exportError && <p className="text-xs text-red-500 flex items-center gap-1 mt-1"><AlertCircle className="w-3 h-3" />{exportError}</p>}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-gray-300 animate-spin" aria-label="Loading" /></div>
      ) : error || !report ? (
        <div className="py-16 text-center"><p className="text-sm text-red-500">{error ?? 'Report unavailable'}</p><button onClick={() => load()} className="mt-3 text-xs text-[var(--brand-primary)] hover:underline">Retry</button></div>
      ) : (
        <>
          {/* Coverage tiles */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Tile label="In scope" value={report.summary.denominator} />
            <Tile label="Captured" value={report.summary.captured} tone="green" />
            <Tile label="Pending" value={report.summary.pending} tone="amber" />
            <Tile label="Rejected" value={report.summary.rejected} tone="red" />
            <Tile label="Missed" value={report.summary.missed} tone="red" />
            <Tile label="Coverage" value={`${report.summary.coveragePct}%`} tone="blue" />
          </div>

          {/* Coverage bar */}
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <BarChart3 className="w-4 h-4 text-[var(--brand-primary)]" />
              <p className="text-xs font-semibold text-gray-700">Coverage — {report.windowKey}</p>
            </div>
            <div className="h-3 bg-gray-100 rounded-full overflow-hidden flex">
              <div className="h-full bg-green-500" style={{ width: `${pct(report.summary.captured, report.summary.denominator)}%` }} title={`Captured ${report.summary.captured}`} />
              <div className="h-full bg-amber-400" style={{ width: `${pct(report.summary.pending, report.summary.denominator)}%` }} title={`Pending ${report.summary.pending}`} />
              <div className="h-full bg-red-400" style={{ width: `${pct(report.summary.rejected, report.summary.denominator)}%` }} title={`Rejected ${report.summary.rejected}`} />
            </div>
            <div className="flex items-center gap-4 mt-2 text-[11px] text-gray-500 flex-wrap">
              <Legend color="bg-green-500" label={`Captured ${report.summary.captured}`} />
              <Legend color="bg-amber-400" label={`Pending ${report.summary.pending}`} />
              <Legend color="bg-red-400" label={`Rejected ${report.summary.rejected}`} />
              <Legend color="bg-gray-200" label={`Missed / not started ${report.summary.missed}`} />
            </div>
            <p className="text-[11px] text-gray-400 mt-2">Scope: {report.outletScope.length ? report.outletScope.join(', ') : '—'} · {report.frequencyPerMonth}× per month</p>
          </div>
        </>
      )}
    </div>
  );
}

function pct(n: number, d: number): number {
  if (!d || d <= 0) return 0;
  return Math.min(100, Math.round((n / d) * 100));
}

function Tile({ label, value, tone }: { label: string; value: number | string; tone?: 'green' | 'red' | 'blue' | 'amber' }) {
  const cls = tone === 'green' ? 'text-green-600' : tone === 'red' ? 'text-red-500' : tone === 'blue' ? 'text-blue-600' : tone === 'amber' ? 'text-amber-600' : 'text-gray-900';
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className={`text-2xl font-bold ${cls}`}>{value}</p>
      <p className="text-xs text-gray-500 mt-0.5">{label}</p>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="flex items-center gap-1"><span className={`inline-block w-2.5 h-2.5 rounded-sm ${color}`} />{label}</span>;
}

export default VisibilityReportView;
