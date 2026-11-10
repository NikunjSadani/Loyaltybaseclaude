'use client';

/**
 * OTP SMS templates card (B11) — per-tenant, per-purpose MSG91 OTP template ids
 * (program_settings `otpTemplates`, resolved by TenantSettingsService.getOtpTemplateId at every
 * OTP send site incl. login). Rendered on /admin/settings for a GIFSY_ADMIN ASSUMED into a tenant.
 *
 * Talks ONLY to the dedicated GIFSY_ADMIN-only endpoint (GIFSY_STAFF cannot reach it; the generic
 * settings PUT refuses this key):
 *   GET /api/admin/settings/otp-templates → { clientId, templates, stored } — the STORED row, never the
 *       fail-soft effective view. If the read fails the card shows the error + Retry and offers NO
 *       editable fields/Save, so a failed read can never be mistaken for "all empty" and saved over.
 *   PUT /api/admin/settings/otp-templates { clientId, changes } — `clientId` is the tenant this card
 *       LOADED (the server 409s if the session's brand changed in another tab); `changes` holds ONLY the
 *       purposes the operator edited, merged server-side onto the freshly-read stored row, so untouched
 *       purposes are never blanked.
 * Nothing is read during the initial render (fetch happens after mount). Empty = the global template.
 */

import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, Save, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import type { OtpTemplates } from '@/types';

const PURPOSES: { key: keyof OtpTemplates; label: string; hint: string }[] = [
  { key: 'login',           label: 'Login OTP',                     hint: 'Sent when any user of this tenant logs in.' },
  { key: 'redemptionSelf',  label: 'Partner redemption OTP',        hint: 'Partner confirming their own redemption.' },
  { key: 'kycConsent',      label: 'KYC consent OTP',               hint: 'Outlet owner consenting during KYC.' },
  { key: 'redemptionSales', label: 'Sales-assisted redemption OTP', hint: 'Outlet owner confirming a redemption raised by sales.' },
];

const TEMPLATE_ID_RE = /^[0-9a-f]{24}$/i;

interface Loaded { clientId: string; templates: OtpTemplates }

export function OtpTemplatesCard() {
  const [loaded, setLoaded]       = useState<Loaded | null>(null);
  const [draft, setDraft]         = useState<OtpTemplates | null>(null);
  const [loading, setLoading]     = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving]       = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved]         = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    const res = await api.get<{ clientId: string; templates: OtpTemplates; stored: boolean }>('/api/admin/settings/otp-templates');
    if (res.success && res.data?.clientId && res.data.templates) {
      setLoaded({ clientId: res.data.clientId, templates: res.data.templates });
      setDraft(res.data.templates);
    } else {
      setLoaded(null);
      setDraft(null);
      setLoadError(res.success ? 'The server returned no templates.' : res.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const changes: Partial<OtpTemplates> = {};
  if (loaded && draft) {
    for (const p of PURPOSES) {
      const v = draft[p.key].trim();
      if (v !== loaded.templates[p.key]) changes[p.key] = v;
    }
  }
  const dirty = Object.keys(changes).length > 0;
  const invalid = !!draft && PURPOSES.some((p) => {
    const v = draft[p.key].trim();
    return v !== '' && !TEMPLATE_ID_RE.test(v);
  });

  async function save() {
    if (!loaded || !dirty || invalid) return;
    setSaving(true);
    setSaveError(null);
    const res = await api.put<{ clientId: string; templates: OtpTemplates }>('/api/admin/settings/otp-templates', {
      clientId: loaded.clientId,
      changes,
    });
    setSaving(false);
    if (res.success && res.data?.templates) {
      setLoaded({ clientId: res.data.clientId ?? loaded.clientId, templates: res.data.templates });
      setDraft(res.data.templates);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } else {
      setSaveError(res.success ? 'Save failed — nothing was changed.' : res.error || 'Save failed — nothing was changed.');
    }
  }

  return (
    <Card data-testid="otp-templates-card">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-[var(--brand-primary)]" /> OTP SMS templates
        </CardTitle>
        <CardDescription className="mt-1">
          This tenant&apos;s own MSG91 (DLT) template for each OTP. <strong>Leave a field empty to use the
          global platform template</strong> for that OTP. Template ids are 24 characters (0-9, a-f).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && <p className="text-sm text-gray-400">Loading…</p>}
        {!loading && loadError && (
          <div className="flex items-center gap-3">
            <p data-testid="otp-templates-load-error" role="alert" className="text-sm text-red-600">
              Couldn&apos;t load this tenant&apos;s OTP templates: {loadError}. Nothing can be edited until they load.
            </p>
            <Button data-testid="otp-templates-retry" variant="outline" onClick={() => void load()}>Retry</Button>
          </div>
        )}
        {!loading && loaded && draft && PURPOSES.map((p) => {
          const value = draft[p.key];
          const bad = value.trim() !== '' && !TEMPLATE_ID_RE.test(value.trim());
          return (
            <div key={p.key} className="space-y-1">
              <label htmlFor={`otp-tpl-${p.key}`} className="text-sm font-medium text-gray-700">{p.label}</label>
              <input
                id={`otp-tpl-${p.key}`}
                data-testid={`otp-tpl-${p.key}`}
                value={value}
                onChange={(e) => setDraft((d) => (d ? { ...d, [p.key]: e.target.value } : d))}
                placeholder="Empty = global template"
                aria-invalid={bad}
                className={`w-full rounded-lg border px-3 py-2 text-sm font-mono ${bad ? 'border-red-400' : 'border-gray-200'}`}
              />
              <p className="text-xs text-gray-400">
                {p.hint}{' '}
                {value.trim() === '' ? <span data-testid={`otp-tpl-${p.key}-global`}>Using the global template.</span> : null}
                {bad ? <span className="text-red-600"> Must be 24 characters, 0-9 / a-f.</span> : null}
              </p>
            </div>
          );
        })}
        {saveError && <p data-testid="otp-templates-error" role="alert" className="text-sm text-red-600">{saveError}</p>}
        {!loading && loaded && (
          <div className="flex items-center gap-3 pt-1">
            <Button
              data-testid="otp-templates-save"
              onClick={save}
              disabled={saving || !dirty || invalid}
              className="bg-[var(--brand-primary)] text-white"
            >
              {saving ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              Save templates
            </Button>
            {saved && <span className="text-xs text-green-600">Saved</span>}
            {!dirty && !saved && <span className="text-xs text-gray-400">No unsaved changes</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
