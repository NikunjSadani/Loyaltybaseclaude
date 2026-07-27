'use client';

/**
 * VisibilityConfigEditor — the GIFSY_ADMIN per-tenant Visibility (POSM) capture
 * configuration surface (VISIBILITY-POSM-DESIGN.md D5/D6/D8/D10). Round-trips the
 * single per-tenant `visibilityConfig` block on open and re-hydrates it:
 *
 *   - outletScope        : which OutletType.code values are in scope (checkbox set).
 *   - frequencyPerMonth  : 1–4 captures/month → windows (with a live window preview).
 *   - allowedSalesLevels : which SalesHierarchyLevel.code values may capture.
 *   - geoFence           : { enabled, radiusMeters } capture geo-fence policy.
 *
 * The WHOLE block is saved via `visibilityApi.setConfig` (REPLACE-WHOLE PUT /config).
 * Cloned-and-adapted from the Scheme admin UX; it does NOT import the scheme feature.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Save, AlertCircle, CheckCircle, Loader2, MapPin, Layers, CalendarClock, Users,
} from 'lucide-react';
import { visibilityApi } from '@/lib/visibility';
import { formCapturesLocation, type VisibilityConfig } from '@/lib/visibility-types';
import { MASTER_OUTLET_TYPES } from '@/lib/platform/outlet-types';
import { ROLE_LABELS, type SalesRole } from '@/lib/sales-role';
import { WINDOW_STARTS } from '@/lib/visibility-window';

const SALES_LEVELS: SalesRole[] = ['XSR', 'SO', 'ASM', 'RSM', 'ZNM', 'NSM'];

const DEFAULT_CONFIG: VisibilityConfig = {
  outletScope: [],
  frequencyPerMonth: 1,
  allowedSalesLevels: [],
  geoFence: { enabled: false, radiusMeters: 50 },
};

/** Human window preview for a frequency, e.g. 2× → "[1–15] [16–end]" (D6). */
export function describeWindows(freq: number): string {
  const starts = WINDOW_STARTS[freq as 1 | 2 | 3 | 4];
  if (!starts) return '';
  return starts
    .map((start, i) => {
      const isLast = i === starts.length - 1;
      const end = isLast ? 'end' : String(starts[i + 1] - 1);
      return `[${start}–${end}]`;
    })
    .join(' ');
}

export function VisibilityConfigEditor() {
  const [config, setConfig] = useState<VisibilityConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // Whether the ACTIVE capture form actually produces a device location on submit (D10).
  // null = not yet known / no form authored. Used to warn+block when geo-fence is on but
  // the form captures no GPS (which would silently defeat the fence).
  const [formHasLocation, setFormHasLocation] = useState<boolean | null>(null);

  const hydrate = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    // Load the config AND the active form together (the geo-fence cross-check needs both).
    const [res, formRes] = await Promise.all([
      visibilityApi.getConfig(),
      visibilityApi.getForm(),
    ]);
    if (res.success) {
      const d = res.data ?? null;
      setConfig({
        outletScope: Array.isArray(d?.outletScope) ? d!.outletScope : [],
        frequencyPerMonth: d?.frequencyPerMonth ?? 1,
        allowedSalesLevels: Array.isArray(d?.allowedSalesLevels) ? d!.allowedSalesLevels : [],
        geoFence: {
          enabled: !!d?.geoFence?.enabled,
          radiusMeters: d?.geoFence?.radiusMeters ?? 50,
        },
      });
    } else {
      setLoadError(res.error);
    }
    setFormHasLocation(
      formRes.success && formRes.data?.formSchema
        ? formCapturesLocation(formRes.data.formSchema)
        : null,
    );
    setLoading(false);
  }, []);

  useEffect(() => { void hydrate(); }, [hydrate]);

  const toggleScope = (code: string) =>
    setConfig((c) => ({
      ...c,
      outletScope: c.outletScope.includes(code)
        ? c.outletScope.filter((x) => x !== code)
        : [...c.outletScope, code],
    }));

  const toggleLevel = (code: string) =>
    setConfig((c) => ({
      ...c,
      allowedSalesLevels: c.allowedSalesLevels.includes(code)
        ? c.allowedSalesLevels.filter((x) => x !== code)
        : [...c.allowedSalesLevels, code],
    }));

  const windowPreview = useMemo(() => describeWindows(config.frequencyPerMonth), [config.frequencyPerMonth]);

  // Geo-fence enabled but the active form produces NO device location = the fence can never
  // be evaluated → it silently passes everything (defeats D10). Warn + block save.
  const geoFenceNeedsGps = config.geoFence.enabled && formHasLocation === false;

  const save = async () => {
    setMsg(null);
    if (config.outletScope.length === 0) { setMsg({ kind: 'err', text: 'Select at least one outlet type in scope.' }); return; }
    if (config.allowedSalesLevels.length === 0) { setMsg({ kind: 'err', text: 'Select at least one sales level that may capture.' }); return; }
    const radius = Number(config.geoFence.radiusMeters);
    if (config.geoFence.enabled && (!isFinite(radius) || radius <= 0)) {
      setMsg({ kind: 'err', text: 'Geo-fence radius must be a positive number of metres.' }); return;
    }
    if (geoFenceNeedsGps) {
      setMsg({ kind: 'err', text: 'Geo-fence is on but the capture form records no location. Add a GPS field (or enable "Capture GPS on submit") on the Form tab, or turn the geo-fence off.' });
      return;
    }
    setSaving(true);
    const res = await visibilityApi.setConfig({
      outletScope: config.outletScope,
      frequencyPerMonth: config.frequencyPerMonth,
      allowedSalesLevels: config.allowedSalesLevels,
      geoFence: { enabled: config.geoFence.enabled, radiusMeters: radius },
    });
    setSaving(false);
    if (res.success) setMsg({ kind: 'ok', text: 'Visibility configuration saved.' });
    else setMsg({ kind: 'err', text: res.error });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 text-gray-300 animate-spin" aria-label="Loading" />
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-red-500">{loadError}</p>
        <button onClick={hydrate} className="mt-3 text-xs text-[var(--brand-primary)] hover:underline">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Outlet scope */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-[var(--brand-primary)]" />
          <p className="text-sm font-semibold text-gray-800">Outlet scope</p>
        </div>
        <p className="text-xs text-gray-500">Which outlet types must capture visibility proof. Only enabled types capture.</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {MASTER_OUTLET_TYPES.map((t) => {
            const on = config.outletScope.includes(t.code);
            return (
              <label key={t.code}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${on ? 'border-[var(--brand-primary)] bg-green-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <input type="checkbox" checked={on} onChange={() => toggleScope(t.code)}
                  aria-label={t.code} className="w-3.5 h-3.5 accent-[var(--brand-primary)]" />
                <span className="text-xs font-medium text-gray-700">{t.name}</span>
                {t.code !== t.name && <span className="text-[10px] font-mono text-gray-400">{t.code}</span>}
              </label>
            );
          })}
        </div>
      </div>

      {/* Frequency */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <CalendarClock className="w-4 h-4 text-[var(--brand-primary)]" />
          <p className="text-sm font-semibold text-gray-800">Capture frequency</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <select value={config.frequencyPerMonth}
            onChange={(e) => setConfig((c) => ({ ...c, frequencyPerMonth: Number(e.target.value) }))}
            aria-label="Captures per month"
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]">
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}× per month</option>)}
          </select>
          <p className="text-xs text-gray-500">
            Windows this month: <span className="font-mono text-gray-700">{windowPreview}</span>
          </p>
        </div>
        <p className="text-[11px] text-gray-400">A window is satisfied only by an approved capture; a missed window stays missed (late captures are flagged).</p>
      </div>

      {/* Allowed sales levels */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-[var(--brand-primary)]" />
          <p className="text-sm font-semibold text-gray-800">Who may capture</p>
        </div>
        <p className="text-xs text-gray-500">Sales levels allowed to capture (plus any manager for an outlet in their downline).</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {SALES_LEVELS.map((code) => {
            const on = config.allowedSalesLevels.includes(code);
            return (
              <label key={code}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${on ? 'border-[var(--brand-primary)] bg-green-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <input type="checkbox" checked={on} onChange={() => toggleLevel(code)}
                  aria-label={code} className="w-3.5 h-3.5 accent-[var(--brand-primary)]" />
                <span className="text-xs font-semibold text-gray-700">{code}</span>
                <span className="text-[10px] text-gray-400 truncate">{ROLE_LABELS[code]}</span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Geo-fence */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <MapPin className="w-4 h-4 text-[var(--brand-primary)]" />
          <p className="text-sm font-semibold text-gray-800">Geo-fence</p>
        </div>
        <label className="flex items-start gap-3 cursor-pointer">
          <button type="button" aria-pressed={config.geoFence.enabled} aria-label="Enable geo-fence"
            onClick={() => setConfig((c) => ({ ...c, geoFence: { ...c.geoFence, enabled: !c.geoFence.enabled } }))}
            className={`w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5 relative ${config.geoFence.enabled ? 'bg-[var(--brand-primary)]' : 'bg-gray-200'}`}>
            <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 shadow transition-all ${config.geoFence.enabled ? 'left-4' : 'left-0.5'}`} />
          </button>
          <div>
            <p className="text-xs font-medium text-gray-800">Enforce a capture geo-fence</p>
            <p className="text-[11px] text-gray-500">Block a capture taken beyond the radius from the outlet&apos;s registered store-board location. Outlets without a reference geo are allowed but flagged &quot;unverifiable&quot;.</p>
          </div>
        </label>
        {config.geoFence.enabled && (
          <div className="flex items-center gap-2 pl-12">
            <label className="text-xs text-gray-600">Radius</label>
            <input type="number" min={1} value={config.geoFence.radiusMeters}
              onChange={(e) => setConfig((c) => ({ ...c, geoFence: { ...c.geoFence, radiusMeters: Number(e.target.value) } }))}
              aria-label="Geo-fence radius (metres)"
              className="w-24 border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]" />
            <span className="text-xs text-gray-500">metres (suggested 50 m)</span>
          </div>
        )}
        {geoFenceNeedsGps && (
          <div data-testid="geo-fence-no-gps-warning"
            className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
            <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-red-700">
              The geo-fence is enabled but the active capture form records <strong>no device location</strong>
              &nbsp;— it can never be checked, so every capture would silently pass. Add a GPS field (or turn on
              &quot;Capture GPS on submit&quot;) on the <strong>Form</strong> tab, or disable the geo-fence. Saving is
              blocked until then.
            </p>
          </div>
        )}
      </div>

      {msg && (
        <p className={`text-xs flex items-center gap-1.5 ${msg.kind === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
          {msg.kind === 'ok' ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}{msg.text}
        </p>
      )}

      <div className="flex justify-end">
        <button onClick={save} disabled={saving || geoFenceNeedsGps}
          className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-[var(--brand-primary)] text-white rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving…' : 'Save configuration'}
        </button>
      </div>
    </div>
  );
}

export default VisibilityConfigEditor;
