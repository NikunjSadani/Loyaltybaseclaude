'use client';

/**
 * Points Engine — per-tenant settings (Wave 3).
 *
 * Two flags: `enabled` (the compute/preview/export surface) and `directCreditEnabled` (the in-portal
 * compute→confirm→wallet shortcut). BOTH are GIFSY-controlled: GIFSY_ADMIN sees editable toggles (PUT
 * /api/admin/points-engine/settings — the ONLY path allowed to write them); everyone else sees a read-only
 * view with a "managed by Gifsy" note. The backend is the real gate; this page mirrors that.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, Loader2, Sparkles, Wallet } from 'lucide-react';
import { useAdminSession } from '@/lib/admin-session';
import { getSettings, setSettings } from '@/lib/points-engine/api';
import type { PointsEngineSettings } from '@/lib/points-engine/types';

function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange?: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-[var(--brand-primary)]' : 'bg-gray-200'
      } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

export default function PointsEngineSettingsPage() {
  const session = useAdminSession();
  const canEdit = session?.role === 'GIFSY_ADMIN';

  const [settings, setSettingsState] = useState<PointsEngineSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setPageError(null);
    const res = await getSettings();
    if (res.success) setSettingsState(res.data);
    else setPageError(res.error ?? 'Failed to load settings');
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (p: Partial<Pick<PointsEngineSettings, 'enabled' | 'directCreditEnabled'>>) => {
    setSettingsState((s) => (s ? { ...s, ...p } : s));
    setSaved(false);
    setSaveError(null);
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    const res = await setSettings({
      clientId: settings.clientId,
      enabled: settings.enabled,
      // Direct credit can only be on when the engine itself is on (UI guard; backend is source of truth).
      directCreditEnabled: settings.enabled && settings.directCreditEnabled,
    });
    if (res.success) {
      setSettingsState(res.data);
      setSaved(true);
    } else {
      setSaveError(res.error ?? 'Failed to save settings');
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
      </div>
    );
  }

  if (pageError) {
    return (
      <div className="fade-in p-6">
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="flex-1">
            <p className="font-semibold">Couldn&apos;t load Points Engine settings</p>
            <p className="mt-0.5">{pageError}</p>
            <button onClick={() => void load()} className="mt-2 font-semibold text-red-800 underline">
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!settings) return null;

  return (
    <div className="fade-in mx-auto max-w-2xl p-6">
      <header className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Points Engine</h1>
        <p className="mt-1 text-sm text-gray-500">
          Calculate points from configurable rules, then export for offline upload — or, when Gifsy enables
          it, credit directly in-portal.
        </p>
      </header>

      {!canEdit && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>These controls are managed by Gifsy. You can see the current state here.</span>
        </div>
      )}

      <div className="divide-y divide-gray-100 rounded-2xl border border-gray-200 bg-white">
        {/* enabled */}
        <div className="flex items-start justify-between gap-4 p-5">
          <div className="flex gap-3">
            <Sparkles className="mt-0.5 h-5 w-5 text-[var(--brand-primary)]" />
            <div>
              <p className="text-sm font-semibold text-gray-900">Enable the Points Engine</p>
              <p className="mt-0.5 text-sm text-gray-500">
                Turns on rule authoring and the compute / preview / export screens for this tenant.
              </p>
            </div>
          </div>
          <Toggle
            checked={settings.enabled}
            disabled={!canEdit}
            label="Enable the Points Engine"
            onChange={(v) => patch({ enabled: v, directCreditEnabled: v ? settings.directCreditEnabled : false })}
          />
        </div>

        {/* directCreditEnabled */}
        <div className="flex items-start justify-between gap-4 p-5">
          <div className="flex gap-3">
            <Wallet className="mt-0.5 h-5 w-5 text-[var(--brand-primary)]" />
            <div>
              <p className="text-sm font-semibold text-gray-900">Allow in-portal direct crediting</p>
              <p className="mt-0.5 text-sm text-gray-500">
                Lets operators credit computed points straight into wallets (as a batch they then confirm),
                instead of exporting a file. Requires the engine to be enabled.
              </p>
            </div>
          </div>
          <Toggle
            checked={settings.directCreditEnabled}
            disabled={!canEdit || !settings.enabled}
            label="Allow in-portal direct crediting"
            onChange={(v) => patch({ directCreditEnabled: v })}
          />
        </div>
      </div>

      {canEdit && (
        <div className="mt-5 flex items-center gap-3">
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          {saved && (
            <span className="inline-flex items-center gap-1 text-sm font-medium text-green-700">
              <CheckCircle2 className="h-4 w-4" /> Saved
            </span>
          )}
          {saveError && (
            <span className="inline-flex items-center gap-1 text-sm font-medium text-red-700">
              <AlertCircle className="h-4 w-4" /> {saveError}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
