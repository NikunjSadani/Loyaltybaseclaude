'use client';

/**
 * OTP SMS templates card (B11) — per-tenant, per-purpose MSG91 OTP template ids
 * (program_settings `otpTemplates`, resolved by TenantSettingsService.getOtpTemplateId at every
 * OTP send site). Rendered on /admin/settings for a GIFSY_ADMIN ASSUMED into a tenant, so the
 * existing settings PUT (/v1/admin/settings, GIFSY_ADMIN, audited) writes THAT tenant's row.
 *
 * - Reads the authoritative stored values from GET /api/settings after mount (never from the
 *   localStorage cache, which is not tenant-keyed) — nothing is read during the initial render.
 * - An empty field = "use the global template" (MSG91_OTP_TEMPLATE_ID). Stated in the UI.
 * - Saves ONLY on an explicit edit (Save is disabled until something changed) and always sends the
 *   complete four-purpose map (REPLACE-WHOLE key); unchanged purposes keep their stored values.
 */

import { useEffect, useState } from 'react';
import { MessageSquare, Save, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { saveGifsySettingsDetailed } from '@/lib/gifsy-settings';
import type { OtpTemplates } from '@/types';

const PURPOSES: { key: keyof OtpTemplates; label: string; hint: string }[] = [
  { key: 'login',           label: 'Login OTP',                    hint: 'Sent when any user of this tenant logs in.' },
  { key: 'redemptionSelf',  label: 'Partner redemption OTP',       hint: 'Partner confirming their own redemption.' },
  { key: 'kycConsent',      label: 'KYC consent OTP',              hint: 'Outlet owner consenting during KYC.' },
  { key: 'redemptionSales', label: 'Sales-assisted redemption OTP', hint: 'Outlet owner confirming a redemption raised by sales.' },
];

const EMPTY: OtpTemplates = { login: '', redemptionSelf: '', kycConsent: '', redemptionSales: '' };
const TEMPLATE_ID_RE = /^[0-9a-f]{24}$/i;

function normalise(v: Partial<OtpTemplates> | undefined | null): OtpTemplates {
  return {
    login:           (v?.login ?? '').trim(),
    redemptionSelf:  (v?.redemptionSelf ?? '').trim(),
    kycConsent:      (v?.kycConsent ?? '').trim(),
    redemptionSales: (v?.redemptionSales ?? '').trim(),
  };
}

export function OtpTemplatesCard() {
  const [stored, setStored]   = useState<OtpTemplates | null>(null);
  const [draft, setDraft]     = useState<OtpTemplates>(EMPTY);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving]   = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved]     = useState(false);

  useEffect(() => {
    let alive = true;
    api.get<{ otpTemplates?: Partial<OtpTemplates> }>('/api/settings').then((res) => {
      if (!alive) return;
      if (res.success && res.data) {
        const v = normalise(res.data.otpTemplates);
        setStored(v);
        setDraft(v);
      } else {
        setLoadError(res.success ? 'No settings returned.' : res.error);
      }
    });
    return () => { alive = false; };
  }, []);

  const invalid = PURPOSES.filter((p) => draft[p.key].trim() !== '' && !TEMPLATE_ID_RE.test(draft[p.key].trim()));
  const dirty = !!stored && PURPOSES.some((p) => draft[p.key].trim() !== stored[p.key]);

  async function save() {
    if (!stored || !dirty || invalid.length) return;
    setSaving(true);
    setSaveError(null);
    const next = normalise(draft);
    const res = await saveGifsySettingsDetailed({ otpTemplates: next });
    setSaving(false);
    if (res.ok) {
      setStored(next);
      setDraft(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } else {
      setSaveError(res.error ?? 'Save failed — nothing was changed.');
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
        {!stored && !loadError && <p className="text-sm text-gray-400">Loading…</p>}
        {loadError && <p data-testid="otp-templates-load-error" className="text-sm text-red-600">Couldn&apos;t load: {loadError}</p>}
        {stored && PURPOSES.map((p) => {
          const value = draft[p.key];
          const bad = value.trim() !== '' && !TEMPLATE_ID_RE.test(value.trim());
          return (
            <div key={p.key} className="space-y-1">
              <label htmlFor={`otp-tpl-${p.key}`} className="text-sm font-medium text-gray-700">{p.label}</label>
              <input
                id={`otp-tpl-${p.key}`}
                data-testid={`otp-tpl-${p.key}`}
                value={value}
                onChange={(e) => setDraft((d) => ({ ...d, [p.key]: e.target.value }))}
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
        {stored && (
          <div className="flex items-center gap-3 pt-1">
            <Button
              data-testid="otp-templates-save"
              onClick={save}
              disabled={saving || !dirty || invalid.length > 0}
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
