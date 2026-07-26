'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, BarChart3 } from 'lucide-react';
import { schemeApi, type TenantSchemeReport } from '@/lib/schemes';
import { SchemeReportView } from '@/components/admin/SchemeReportView';

// ─────────────────────────────────────────────────────────────────────────────
// Tenant read-only per-scheme report (D26). Aggregates + a per-outlet row list;
// NO raw media / formValues and no export — those are GIFSY-only.
// ─────────────────────────────────────────────────────────────────────────────

export default function TenantSchemeReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: schemeId } = use(params);
  const [report, setReport] = useState<TenantSchemeReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await schemeApi.getTenantReport(schemeId);
    if (res.success) setReport(res.data);
    else setError(res.error);
    setLoading(false);
  }, [schemeId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-center gap-3">
        <Link href="/admin/scheme-reports" className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"><ArrowLeft className="w-4 h-4" /></Link>
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2"><BarChart3 className="w-5 h-5 text-[var(--brand-primary)]" /> {report?.scheme.name ?? 'Scheme report'}</h1>
          <p className="text-xs text-gray-500">Read-only coverage report</p>
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
