'use client';

/**
 * SchemeManager — the GIFSY_ADMIN scheme configuration surface for an EXISTING
 * scheme (D5/D6/D7). Round-trips the scheme, its audienceConfig and its enrollment
 * form on open and re-hydrates all three. Three tabs:
 *   - Details : edit-in-place (schemeApi.update) + lifecycle (schemeApi.setStatus)
 *   - Audience: SchemeAudienceEditor (filter / roster upload)
 *   - Form    : SchemeFormBuilder (full palette) → schemeApi.upsertEnrollmentForm
 *
 * The reward-era "publish = duplicate" flow and the Archive→ARCHIVED 400 are gone:
 * saves are in-place and status transitions use valid SchemeStatus values only.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Save, AlertCircle, CheckCircle, Loader2, Play, Pause, XCircle, Settings2,
  Users, ClipboardList,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import {
  schemeApi,
  type UpdateSchemeInput,
} from '@/lib/schemes';
import type {
  AudienceConfig,
  CampaignType,
  EnrollmentFormSchema,
  SchemeRecord,
  SchemeStatus,
} from '@/lib/scheme-types';
import { SchemeAudienceEditor } from './SchemeAudienceEditor';
import { SchemeFormBuilder, validateSchemeFormSchema } from './SchemeFormBuilder';

const EMPTY_FORM: EnrollmentFormSchema = { captureGpsOnSubmit: false, requireOtp: false, fields: [] };

type Tab = 'details' | 'audience' | 'form';

interface EnrollmentFormResponse {
  enrollmentForm: {
    campaignType: CampaignType | string;
    formSchema: EnrollmentFormSchema;
    version?: number;
  };
}

export function SchemeManager({ schemeId }: { schemeId: string }) {
  const [scheme, setScheme] = useState<SchemeRecord | null>(null);
  const [audience, setAudience] = useState<AudienceConfig | null>(null);
  const [campaignType, setCampaignType] = useState<CampaignType>('OPEN_CAMPAIGN');
  const [formSchema, setFormSchema] = useState<EnrollmentFormSchema>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('details');

  // ── Round-trip hydration (scheme + audience + form) ─────────────────────────
  const hydrate = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const schemeRes = await api.get<{ scheme: SchemeRecord }>(`/api/schemes/${schemeId}`);
    if (!schemeRes.success) { setLoadError(schemeRes.error); setLoading(false); return; }
    setScheme(schemeRes.data.scheme);
    setAudience(schemeRes.data.scheme.audienceConfig ?? null);

    const formRes = await api.get<EnrollmentFormResponse>(`/api/schemes/${schemeId}/enrollment-form`);
    if (formRes.success && formRes.data.enrollmentForm) {
      setCampaignType((formRes.data.enrollmentForm.campaignType as CampaignType) ?? 'OPEN_CAMPAIGN');
      const fs = formRes.data.enrollmentForm.formSchema;
      setFormSchema({
        captureGpsOnSubmit: !!fs?.captureGpsOnSubmit,
        requireOtp: !!fs?.requireOtp,
        fields: Array.isArray(fs?.fields) ? fs.fields : [],
      });
    } else {
      setFormSchema(EMPTY_FORM);
    }
    setLoading(false);
  }, [schemeId]);

  useEffect(() => { void hydrate(); }, [hydrate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 text-gray-300 animate-spin" aria-label="Loading" />
      </div>
    );
  }
  if (loadError || !scheme) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-red-500">{loadError ?? 'Scheme not found'}</p>
        <button onClick={hydrate} className="mt-3 text-xs text-[var(--brand-primary)] hover:underline">Retry</button>
      </div>
    );
  }

  // Completion state — an audience exists once a mode is persisted; a form once it
  // carries ≥1 field. Both drive the tab badges, the Form-tab banner and the
  // activation gate (H3).
  const hasAudience = !!audience && (audience.mode === 'FILTER' || audience.mode === 'EXCEL');
  const hasForm = formSchema.fields.length > 0;

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {([
          { key: 'details' as Tab, label: 'Details', Icon: Settings2, done: false },
          { key: 'audience' as Tab, label: 'Audience', Icon: Users, done: hasAudience },
          { key: 'form' as Tab, label: 'Enrollment form', Icon: ClipboardList, done: hasForm },
        ]).map(({ key, label, Icon, done }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === key ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            <Icon className="w-4 h-4" /> {label}
            {done && <CheckCircle className="w-3.5 h-3.5 text-green-500" aria-label="configured" />}
          </button>
        ))}
      </div>

      {tab === 'details' && (
        <DetailsTab scheme={scheme} onChanged={setScheme} hasAudience={hasAudience} hasForm={hasForm} />
      )}
      {tab === 'audience' && (
        <SchemeAudienceEditor schemeId={schemeId} schemeName={scheme.name} audienceConfig={audience} onSaved={hydrate} />
      )}
      {tab === 'form' && (
        <FormTab
          schemeId={schemeId}
          campaignType={campaignType}
          formSchema={formSchema}
          showPrefill={audience?.mode === 'EXCEL'}
          audienceSet={hasAudience}
          onCampaignTypeChange={setCampaignType}
          onSchemaChange={setFormSchema}
          onSaved={hydrate}
        />
      )}
    </div>
  );
}

// ── Details tab (edit-in-place + status transitions) ─────────────────────────

const STATUS_META: Record<SchemeStatus, { label: string; cls: string }> = {
  DRAFT:     { label: 'Draft',     cls: 'bg-gray-100 text-gray-600' },
  ACTIVE:    { label: 'Active',    cls: 'bg-green-100 text-green-700' },
  PAUSED:    { label: 'Paused',    cls: 'bg-blue-100 text-blue-700' },
  EXPIRED:   { label: 'Expired',   cls: 'bg-red-50 text-red-500' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-red-100 text-red-600' },
};

function DetailsTab({ scheme, onChanged, hasAudience, hasForm }: {
  scheme: SchemeRecord;
  onChanged: (s: SchemeRecord) => void;
  hasAudience: boolean;
  hasForm: boolean;
}) {
  const [name, setName] = useState(scheme.name);
  const [description, setDescription] = useState(scheme.description ?? '');
  const [startDate, setStartDate] = useState(scheme.startDate.slice(0, 10));
  const [endDate, setEndDate] = useState(scheme.endDate.slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [statusSaving, setStatusSaving] = useState<SchemeStatus | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const status = scheme.status as SchemeStatus;

  const save = async () => {
    setMsg(null);
    if (!name.trim()) { setMsg({ kind: 'err', text: 'Name is required.' }); return; }
    setSaving(true);
    const input: UpdateSchemeInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      startDate: new Date(startDate).toISOString(),
      endDate: new Date(endDate).toISOString(),
    };
    const res = await schemeApi.update(scheme.id, input);
    setSaving(false);
    if (res.success) { onChanged(res.data.scheme); setMsg({ kind: 'ok', text: 'Changes saved.' }); }
    else setMsg({ kind: 'err', text: res.error });
  };

  const changeStatus = async (next: SchemeStatus) => {
    setMsg(null);
    setStatusSaving(next);
    const res = await schemeApi.setStatus(scheme.id, next);
    setStatusSaving(null);
    if (res.success) { onChanged(res.data.scheme); setMsg({ kind: 'ok', text: `Scheme ${STATUS_META[next].label.toLowerCase()}.` }); }
    else setMsg({ kind: 'err', text: res.error });
  };

  // Valid, meaningful transitions from the current status.
  const transitions: SchemeStatus[] = (() => {
    switch (status) {
      case 'DRAFT': return ['ACTIVE', 'CANCELLED'];
      case 'ACTIVE': return ['PAUSED', 'EXPIRED', 'CANCELLED'];
      case 'PAUSED': return ['ACTIVE', 'EXPIRED', 'CANCELLED'];
      case 'EXPIRED': return ['ACTIVE'];
      case 'CANCELLED': return ['DRAFT'];
      default: return [];
    }
  })();

  // H3 — a scheme may go ACTIVE only once it has BOTH a real audience and a form
  // with ≥1 field. Block the Activate control (with an explanatory tooltip) otherwise.
  const activateBlocked = !hasAudience || !hasForm;
  const activateReason =
    !hasAudience && !hasForm
      ? 'Set the audience / roster and add at least one enrollment-form field before activating.'
      : !hasAudience
      ? 'Set the audience / roster before activating.'
      : 'Add at least one enrollment-form field before activating.';

  const TRANSITION_ICON: Partial<Record<SchemeStatus, React.ReactNode>> = {
    ACTIVE: <Play className="w-3.5 h-3.5" />,
    PAUSED: <Pause className="w-3.5 h-3.5" />,
    EXPIRED: <XCircle className="w-3.5 h-3.5" />,
    CANCELLED: <XCircle className="w-3.5 h-3.5" />,
    DRAFT: <Settings2 className="w-3.5 h-3.5" />,
  };

  return (
    <div className="space-y-4">
      {/* Status bar */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Status</span>
          <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_META[status]?.cls ?? 'bg-gray-100 text-gray-600'}`}>
            {STATUS_META[status]?.label ?? status}
          </span>
          <span className="text-xs text-gray-400 font-mono ml-2">{scheme.code}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {transitions.map((t) => {
            const blocked = t === 'ACTIVE' && activateBlocked;
            return (
              <button key={t} onClick={() => changeStatus(t)}
                disabled={statusSaving !== null || blocked}
                title={blocked ? activateReason : undefined}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${t === 'ACTIVE' ? 'border-green-300 text-green-700 hover:bg-green-50' : t === 'CANCELLED' || t === 'EXPIRED' ? 'border-red-200 text-red-600 hover:bg-red-50' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                {statusSaving === t ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : TRANSITION_ICON[t]}
                {t === 'ACTIVE' ? 'Activate' : t === 'PAUSED' ? 'Pause' : t === 'EXPIRED' ? 'Expire' : t === 'CANCELLED' ? 'Cancel' : 'Reopen as draft'}
              </button>
            );
          })}
        </div>
        {transitions.includes('ACTIVE') && activateBlocked && (
          <p className="w-full text-[11px] text-amber-600 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {activateReason}
          </p>
        )}
      </div>

      {/* Basic info */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">Scheme name <span className="text-red-500">*</span></label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]" />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)] resize-none" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Start date <span className="text-red-500">*</span></label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">End date <span className="text-red-500">*</span></label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]" />
        </div>
      </div>

      {msg && (
        <p className={`text-xs flex items-center gap-1.5 ${msg.kind === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
          {msg.kind === 'ok' ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}{msg.text}
        </p>
      )}

      <div className="flex justify-end">
        <button onClick={save} disabled={saving}
          className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-[var(--brand-primary)] text-white rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

// ── Form tab (build + versioned persist) ─────────────────────────────────────

function FormTab({
  schemeId, campaignType, formSchema, showPrefill, audienceSet, onCampaignTypeChange, onSchemaChange, onSaved,
}: {
  schemeId: string;
  campaignType: CampaignType;
  formSchema: EnrollmentFormSchema;
  showPrefill: boolean;
  audienceSet: boolean;
  onCampaignTypeChange: (t: CampaignType) => void;
  onSchemaChange: (s: EnrollmentFormSchema) => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // H4 — never persist an invalid schema. The save is gated on the same validation
  // the builder surfaces; the button is disabled and the errors are listed inline.
  const errors = useMemo(() => validateSchemeFormSchema(formSchema), [formSchema]);

  const save = async () => {
    setMsg(null);
    if (errors.length > 0) return;
    setSaving(true);
    const res = await schemeApi.upsertEnrollmentForm(schemeId, { campaignType, formSchema });
    setSaving(false);
    if (res.success) { setMsg({ kind: 'ok', text: 'Form saved (a new version was recorded).' }); onSaved(); }
    else setMsg({ kind: 'err', text: res.error });
  };

  return (
    <div className="space-y-4">
      {!audienceSet && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-700">Set the audience / roster first — the prefill dropdowns are populated from the roster.</p>
        </div>
      )}
      <SchemeFormBuilder
        value={formSchema}
        schemeId={schemeId}
        campaignType={campaignType}
        onChange={onSchemaChange}
        onCampaignTypeChange={onCampaignTypeChange}
        showPrefill={showPrefill}
      />
      {errors.length > 0 && (
        <div className="border border-red-200 bg-red-50 rounded-lg px-3 py-2 space-y-1">
          <p className="text-xs font-semibold text-red-600 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" /> Fix {errors.length === 1 ? 'this' : 'these'} before saving:
          </p>
          <ul className="list-disc list-inside text-xs text-red-600 space-y-0.5">
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}
      {msg && (
        <p className={`text-xs flex items-center gap-1.5 ${msg.kind === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
          {msg.kind === 'ok' ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}{msg.text}
        </p>
      )}
      <div className="flex justify-end">
        <button onClick={save} disabled={saving || errors.length > 0}
          title={errors.length > 0 ? 'Resolve the form errors above to save.' : undefined}
          className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-[var(--brand-primary)] text-white rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving…' : 'Save form'}
        </button>
      </div>
    </div>
  );
}

export default SchemeManager;
