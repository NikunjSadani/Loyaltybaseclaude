'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, Loader2, BarChart3, ClipboardList } from 'lucide-react';
import { schemeApi, type TenantSchemeReport } from '@/lib/schemes';
import { SchemeReportView } from '@/components/admin/SchemeReportView';

// ─────────────────────────────────────────────────────────────────────────────
// Tenant read-only per-scheme report (D26). In-app view = aggregates + a per-outlet
// row list (status only, no raw media/formValues). The "Download Excel" button pulls
// the full detail export (raw captured values + media links, D30) — the backend
// HARD-SCOPES a CLIENT_ADMIN to their OWN tenant, so it can only ever contain this
// tenant's own enrollments.
// ─────────────────────────────────────────────────────────────────────────────

export default function TenantSchemeReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: schemeId } = use(params);
  const [report, setReport] = useState<TenantSchemeReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await schemeApi.getTenantReport(schemeId);
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
          <Link href="/admin/scheme-reports" className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"><ArrowLeft className="w-4 h-4" /></Link>
          <div>
            <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2"><BarChart3 className="w-5 h-5 text-[var(--brand-primary)]" /> {report?.scheme.name ?? 'Scheme report'}</h1>
            <p className="text-xs text-gray-500">Read-only coverage report</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <Link href={`/admin/scheme-reports/${schemeId}/enrollments`}
              className="flex items-center gap-2 px-4 py-2 bg-white text-gray-700 text-sm font-medium rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors">
              <ClipboardList className="w-4 h-4" /> View enrollments
            </Link>
            <button onClick={handleExport} disabled={exporting || loading || !!error}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-medium rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60">
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {exporting ? 'Exporting…' : 'Download Excel'}
            </button>
          </div>
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
