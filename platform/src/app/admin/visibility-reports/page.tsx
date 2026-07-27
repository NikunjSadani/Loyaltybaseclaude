'use client';

/**
 * Tenant read-only Visibility (POSM) coverage report (VISIBILITY-POSM-DESIGN.md D15).
 * CLIENT_ADMIN / MIS_USER cannot configure Visibility or review captures (GIFSY-only),
 * but can view aggregate per-window coverage. Mirrors /admin/scheme-reports: no raw
 * media, no export — that surface lives on the GIFSY Report tab.
 *
 * Reads via visibilityApi.getTenantReport (VisibilityReportView variant="tenant").
 */

import { BarChart3, FileSpreadsheet } from 'lucide-react';
import { useGifsySettings } from '@/lib/gifsy-settings';
import { VisibilityReportView } from '@/components/admin/VisibilityReportView';

export default function VisibilityReportsPage() {
  const captureMode = useGifsySettings().visibilityCaptureMode ?? 'PHOTO_APPROVAL';

  return (
    <div className="space-y-5 fade-in">
      <div>
        <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-[var(--brand-primary)]" /> Visibility Reports
        </h1>
        <p className="text-xs text-gray-500">Read-only per-window POSM coverage for your tenant.</p>
      </div>

      {captureMode === 'AMOUNT_UPLOAD' ? (
        // Per-window PHOTO_APPROVAL coverage is not meaningful in amount-upload mode (there
        // are no photo captures / windows) — the record of truth is OutletVisibilityRecord,
        // exported from the GIFSY admin bulk-upload surface (D3).
        <div
          data-testid="visibility-reports-amount-upload"
          className="flex flex-col items-center gap-2 py-12 text-center text-gray-500 bg-white rounded-2xl border border-gray-100"
        >
          <FileSpreadsheet className="h-8 w-8 text-gray-300" />
          <p className="text-sm font-medium text-gray-600">Amount-upload mode</p>
          <p className="text-xs text-gray-400 max-w-sm">
            Your organization records visibility via the back-office monthly Excel upload, so there is
            no per-window photo coverage to report here. Visibility records are exported from the
            bulk-upload surface.
          </p>
        </div>
      ) : (
        <VisibilityReportView variant="tenant" />
      )}
    </div>
  );
}
