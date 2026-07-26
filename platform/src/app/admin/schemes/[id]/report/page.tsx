'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, Loader2, BarChart3 } from 'lucide-react';
import { schemeApi, type SchemeReport } from '@/lib/schemes';
import { SchemeReportView } from '@/components/admin/SchemeReportView';

// ─────────────────────────────────────────────────────────────────────────────
// GIFSY_ADMIN full scheme report (D26) — coverage aggregates + the auth-gated
// xlsx export (raw values + media links, D30).
// ─────────────────────────────────────────────────────────────────────────────

export default function SchemeReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: schemeId } = use(params);
  const [report, setReport] = useState<SchemeReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await schemeApi.getReport(schemeId);
    if (res.success) setReport(res.data);
    else setError(res.error);
    setLoading(false);
  }, [schemeId]);

  useEffect(() => { void load(); }, [load]);

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    const res = await schemeApi.downloadExport(schemeId);
    setExporting(false);
    if (!res.success) setExportError(res.error);
  };

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link href={`/admin/schemes/${schemeId}`} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"><ArrowLeft className="w-4 h-4" /></Link>
          <div>
            <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2"><BarChart3 className="w-5 h-5 text-[var(--brand-primary)]" /> Report</h1>
            <p className="text-xs text-gray-500">{report?.scheme.name ?? `Scheme ${schemeId}`} · coverage</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button onClick={handleExport} disabled={exporting}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-medium rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60">
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {exporting ? 'Exporting…' : 'Export Excel'}
          </button>
          {exportError && <p className="text-xs text-red-500 mt-1">{exportError}</p>}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-gray-300 animate-spin" /></div>
      ) : error || !report ? (
        <div className="py-16 text-center"><p className="text-sm text-red-500">{error ?? 'Report unavailable'}</p><button onClick={load} className="mt-3 text-xs text-[var(--brand-primary)] hover:underline">Retry</button></div>
      ) : (
        <SchemeReportView report={report} />
      )}
    </div>
  );
}
