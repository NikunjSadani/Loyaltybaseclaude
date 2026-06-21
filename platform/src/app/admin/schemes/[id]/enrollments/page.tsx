'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Download,
  Users,
  ClipboardList,
  AlertCircle,
} from 'lucide-react';
import { authHeader } from '@/lib/api-client';

// ─────────────────────────────────────────────────────────────────────────────
// Enrollment Dashboard
//
// NOTE (#57 mock-data removal): the backend currently exposes NO list/stats
// endpoint for a scheme's enrollments — only the authoritative xlsx export
// (GET /api/admin/schemes/:id/enrollments/export, wired below) plus the
// per-caller GET /v1/schemes/:id/my-enrollment. There is no
// GET /v1/schemes/:id/enrollments collection route. The in-page summary strip,
// geography/employee breakdowns and the detail table previously rendered
// fabricated demo data, so they have been replaced with an honest empty state.
// When the backend ships an enrollments list/stats endpoint, re-wire the stats
// + table to it.
// ─────────────────────────────────────────────────────────────────────────────

export default function EnrollmentDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: schemeId } = use(params);

  // ── Export state ──────────────────────────────────────────────────────────
  const [exporting,    setExporting]    = useState(false);
  const [exportError,  setExportError]  = useState<string | null>(null);

  // ── Excel Export — backend xlsx download (RAW blob, no JSON parse) ────────
  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(`/api/admin/schemes/${schemeId}/enrollments/export`, {
        headers: { ...authHeader() },
      });

      if (!res.ok) {
        // Attempt to parse error from JSON body; if the body is binary just use statusText
        let errMsg = res.statusText;
        try {
          const body = await res.json();
          errMsg = body?.error ?? body?.message ?? errMsg;
        } catch { /* binary body or parse failure — use statusText */ }
        setExportError(`Export failed: ${errMsg}`);
        return;
      }

      // Backend returns RAW xlsx — stream into blob → trigger anchor download
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `enrollments_${schemeId}_${new Date().toISOString().split('T')[0]}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Network error during export');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-5 fade-in">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={`/admin/schemes/${schemeId}`}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-lg font-bold text-gray-900">Enrollment Dashboard</h1>
            <p className="text-xs text-gray-500">Scheme {schemeId} · All enrollment activity</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-medium rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60"
          >
            <Download className="w-4 h-4" />
            {exporting ? 'Exporting…' : 'Export Excel'}
          </button>
          {exportError && (
            <p className="text-xs text-red-500 flex items-center gap-1 mt-1">
              <AlertCircle className="w-3 h-3" />{exportError}
            </p>
          )}
        </div>
      </div>

      {/* ── Empty state ──────────────────────────────────────────────────
          No backend list/stats endpoint exists for scheme enrollments yet.
          Rather than fabricate numbers, surface an honest empty state and
          point admins at the authoritative xlsx export above. */}
      <div className="bg-white rounded-xl border border-gray-200 py-16 px-6 text-center">
        <div className="w-12 h-12 rounded-full bg-gray-50 flex items-center justify-center mx-auto mb-4">
          <ClipboardList className="w-6 h-6 text-gray-300" />
        </div>
        <p className="text-sm font-semibold text-gray-700">Enrollment summary is not available in-app yet</p>
        <p className="text-xs text-gray-500 mt-1 max-w-md mx-auto">
          The full enrollment list, geography and employee breakdowns are not yet served by an
          API. Use <span className="font-medium text-gray-700">Export Excel</span> above to download
          the complete, authoritative enrollment data for this scheme.
        </p>
        <div className="mt-4 inline-flex items-center gap-1.5 text-xs text-gray-400">
          <Users className="w-3.5 h-3.5" />
          A live in-app dashboard will appear here once the enrollments endpoint ships.
        </div>
      </div>
    </div>
  );
}
