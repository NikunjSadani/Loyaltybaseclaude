'use client';

/**
 * Admin Visibility (POSM) — the GIFSY_ADMIN capture-management surface
 * (VISIBILITY-POSM-DESIGN.md). REPLACES the dead fake photo-approval queue
 * (local-state mutation + hardcoded fraud log).
 *
 * MODE-BRANCHED on the tenant's `visibilityCaptureMode` (D3):
 *   - PHOTO_APPROVAL → the in-app photo-capture programme (four tabs):
 *       - Config   : VisibilityConfigEditor  (per-tenant scope / frequency / levels / geo-fence)
 *       - Form     : VisibilityFormBuilder    (versioned capture form; camera instruction + sample)
 *       - Captures : VisibilityCaptureQueue   (real approve / reject queue)
 *       - Report   : VisibilityReportView     (per-window coverage + Excel export)
 *   - AMOUNT_UPLOAD → the back-office Excel bulk-upload surface
 *       (VisibilityAmountUploadPanel — records into OutletVisibilityRecord).
 *
 * GIFSY-only (enforced by ./layout.tsx). The master `visibilityEnabled` switch gates the
 * whole surface here so a tenant with Visibility OFF sees nothing to manage.
 */

import { useState } from 'react';
import { Settings2, ClipboardList, Camera, BarChart3 } from 'lucide-react';
import { useGifsySettings } from '@/lib/gifsy-settings';
import { VisibilityConfigEditor } from '@/components/admin/VisibilityConfigEditor';
import { VisibilityFormBuilder } from '@/components/admin/VisibilityFormBuilder';
import { VisibilityCaptureQueue } from '@/components/admin/VisibilityCaptureQueue';
import { VisibilityReportView } from '@/components/admin/VisibilityReportView';
import { VisibilityAmountUploadPanel } from '@/components/admin/VisibilityAmountUploadPanel';

type Tab = 'config' | 'form' | 'captures' | 'report';

const TABS: { key: Tab; label: string; Icon: typeof Settings2 }[] = [
  { key: 'config',   label: 'Config',   Icon: Settings2 },
  { key: 'form',     label: 'Form',     Icon: Camera },
  { key: 'captures', label: 'Captures', Icon: ClipboardList },
  { key: 'report',   label: 'Report',   Icon: BarChart3 },
];

export default function VisibilityAdminPage() {
  const settings = useGifsySettings();
  const visibilityEnabled = settings.visibilityEnabled === true;
  const captureMode = settings.visibilityCaptureMode ?? 'PHOTO_APPROVAL';
  const [tab, setTab] = useState<Tab>('config');

  if (!visibilityEnabled) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-500 text-sm">Visibility is disabled for this tenant.</p>
      </div>
    );
  }

  // AMOUNT_UPLOAD (D3): the in-app photo-capture programme does not apply — show the
  // back-office Excel bulk-upload surface instead of the config/form/captures/report tabs.
  if (captureMode === 'AMOUNT_UPLOAD') {
    return (
      <div className="space-y-4 fade-in">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Visibility (POSM)</h1>
          <p className="text-xs text-gray-500">Bulk-upload the monthly visibility records captured off-app.</p>
        </div>
        <VisibilityAmountUploadPanel />
      </div>
    );
  }

  return (
    <div className="space-y-4 fade-in">
      <div>
        <h1 className="text-lg font-bold text-gray-900">Visibility (POSM)</h1>
        <p className="text-xs text-gray-500">Configure the capture programme, review submitted photos, and track coverage.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map(({ key, label, Icon }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === key ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      {tab === 'config' && <VisibilityConfigEditor />}
      {tab === 'form' && <VisibilityFormBuilder />}
      {tab === 'captures' && <VisibilityCaptureQueue />}
      {tab === 'report' && <VisibilityReportView variant="admin" />}
    </div>
  );
}
