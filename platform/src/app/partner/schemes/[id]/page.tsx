'use client';

/**
 * Partner-portal scheme DETAIL + self-enroll (D27).
 *
 * Renders the scheme's enrollment form with the SHARED `SchemeFormRenderer`
 * (mode SELF) and self-enrols when D21 allows — the old dashboard banner could
 * never fill a required form, so required-form schemes were un-enrollable. Shows
 * enrolled / rejected status and lets a rejected outlet RESUBMIT the whole form
 * (D10) — the enroll endpoint supersedes a REJECTED enrollment with a new version.
 *
 * Group-aware: all calls are same-origin so the active-partner cookie scopes the
 * enrollment to the currently-selected outlet server-side.
 */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft, Sparkles, CheckCircle, AlertTriangle, Info, Loader2, Eye, MapPin, Pencil, Save, X,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { SchemeFormRenderer } from '@/components/schemes/SchemeFormRenderer';
import { schemeApi, mediaViewUrl } from '@/lib/schemes';
import {
  DISPLAY_ONLY_FIELD_TYPES,
  MEDIA_FIELD_TYPES,
  orderedFields,
  type AudienceConfig,
  type EnrollResult,
  type FormField,
  type SchemeEnrollment,
} from '@/lib/scheme-types';
import { usePartnerIdentity } from '@/lib/partner-identity';
import {
  isFixedRoster,
  loadPortalScheme,
  selfEnrollAllowed,
  statusOf,
  type EnrollmentFormResult,
  type PortalStatus,
} from '@/app/partner/schemes/portal-api';
import type { PartnerEligibleScheme } from '@/lib/scheme-types';

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/* ── Read-only captured-values summary (immutable SUBMITTED state) ───────────── */

function EnrolledSummary({
  schemeId,
  form,
  enrollment,
}: {
  schemeId: string;
  form: EnrollmentFormResult | null;
  enrollment: SchemeEnrollment;
}) {
  const values = enrollment.formValues ?? {};
  const fields = form ? orderedFields(form.schema).filter((f) => !DISPLAY_ONLY_FIELD_TYPES.has(f.type)) : [];

  return (
    <div className="space-y-3">
      {fields.length === 0 ? (
        <p className="text-sm text-gray-500">Your enrolment has been recorded.</p>
      ) : (
        <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden">
          {fields.map((f) => {
            const v = (values as Record<string, unknown>)[f.id];
            const isMedia = MEDIA_FIELD_TYPES.has(f.type);
            const isGps = f.type === 'GPS_POINT';
            return (
              <div key={f.id} className="flex items-start gap-3 px-3 py-2.5 bg-white">
                <p className="text-xs text-gray-400 font-medium w-32 shrink-0">{f.label}</p>
                <div className="flex-1 min-w-0 text-sm text-gray-800 break-words">
                  {v == null || v === '' ? (
                    <span className="text-gray-300">—</span>
                  ) : isMedia && typeof v === 'string' ? (
                    <a
                      href={mediaViewUrl(schemeId, v)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[var(--brand-primary)] font-medium"
                    >
                      <Eye className="h-3.5 w-3.5" /> View
                    </a>
                  ) : isGps && v && typeof v === 'object' ? (
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3.5 w-3.5 text-gray-400" />
                      {String((v as { lat?: number }).lat ?? '')}, {String((v as { lng?: number }).lng ?? '')}
                    </span>
                  ) : Array.isArray(v) ? (
                    v.join(', ')
                  ) : (
                    String(v)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Enroller self-edit of a SUBMITTED submission (D — allowEnrollerEdit) ─────── */
//
// A lightweight editor for the outlet to correct its OWN already-submitted enrollment,
// gated on `audienceConfig.allowEnrollerEdit`. It edits scalar captured values and
// submits through the EXISTING resubmit endpoint (`schemeApi.resubmit`) — which the
// backend now accepts for a SUBMITTED enrollment when enroller-edit is allowed. Media,
// signature, GPS and phone-OTP fields are shown read-only; the payload starts from the
// full current formValues so those captured values are preserved on the new version.
// (This is deliberately NOT the full SchemeFormRenderer, which submits via `enroll`.)

const enrollerInputCls =
  'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none ' +
  'focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] bg-white';

function EnrollerEditForm({
  schemeId,
  form,
  enrollment,
  onSaved,
  onCancel,
}: {
  schemeId: string;
  form: EnrollmentFormResult;
  enrollment: SchemeEnrollment;
  onSaved: (r: EnrollResult) => void;
  onCancel: () => void;
}) {
  const fields = orderedFields(form.schema).filter((f) => !DISPLAY_ONLY_FIELD_TYPES.has(f.type));
  const [values, setValues] = useState<Record<string, unknown>>(
    () => ({ ...((enrollment.formValues ?? {}) as Record<string, unknown>) }),
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (id: string, v: unknown) => setValues((p) => ({ ...p, [id]: v }));
  const isOn = (v: unknown) => v === true || v === 'true' || v === 'yes' || v === '1';

  const readOnly = (f: FormField) =>
    MEDIA_FIELD_TYPES.has(f.type) || f.type === 'GPS_POINT' || f.type === 'CALCULATED' || f.type === 'LOOKUP' || f.type === 'PHONE_OTP';

  const save = async () => {
    setSaving(true);
    setErr(null);
    const res = await schemeApi.resubmit(schemeId, enrollment.id, { formValues: values });
    setSaving(false);
    if (res.success) onSaved(res.data);
    else setErr(res.error);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 border border-blue-200 bg-blue-50 rounded-xl px-3 py-2.5">
        <Info className="h-4 w-4 shrink-0 mt-0.5 text-blue-500" />
        <p className="text-xs text-blue-800 leading-relaxed">
          Edit and resubmit your details. Photos and location stay as captured.
        </p>
      </div>

      {fields.map((f) => {
        const v = values[f.id];
        if (readOnly(f)) {
          const isObj = v != null && typeof v === 'object';
          return (
            <div key={f.id}>
              <p className="text-xs font-medium text-gray-700 mb-1">{f.label}</p>
              <div className="text-xs text-gray-400 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5">
                {isObj ? 'Captured — unchanged' : v == null || v === '' ? '—' : String(v)}
              </div>
            </div>
          );
        }
        if (f.type === 'TOGGLE') {
          return (
            <div key={f.id}>
              <p className="text-xs font-medium text-gray-700 mb-1">{f.label}</p>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={isOn(v)} onChange={(e) => set(f.id, e.target.checked)} aria-label={f.label} />
                {isOn(v) ? 'Yes' : 'No'}
              </label>
            </div>
          );
        }
        if (f.type === 'DROPDOWN') {
          return (
            <div key={f.id}>
              <label htmlFor={`ed-${f.id}`} className="text-xs font-medium text-gray-700 block mb-1">{f.label}</label>
              <select id={`ed-${f.id}`} className={enrollerInputCls} value={String(v ?? '')} onChange={(e) => set(f.id, e.target.value)}>
                <option value="">Select…</option>
                {(f.options ?? []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            </div>
          );
        }
        if (f.type === 'MULTI_SELECT') {
          const sel = Array.isArray(v) ? (v as string[]) : [];
          const toggle = (opt: string) => set(f.id, sel.includes(opt) ? sel.filter((o) => o !== opt) : [...sel, opt]);
          return (
            <div key={f.id}>
              <p className="text-xs font-medium text-gray-700 mb-1">{f.label}</p>
              <div className="space-y-1.5">
                {(f.options ?? []).map((opt) => (
                  <label key={opt} className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={sel.includes(opt)} onChange={() => toggle(opt)} aria-label={`${f.label}: ${opt}`} />
                    {opt}
                  </label>
                ))}
              </div>
            </div>
          );
        }
        const inputType = f.type === 'NUMBER' ? 'number' : f.type === 'DATE' ? 'date' : f.type === 'EMAIL' ? 'email' : 'text';
        return (
          <div key={f.id}>
            <label htmlFor={`ed-${f.id}`} className="text-xs font-medium text-gray-700 block mb-1">{f.label}</label>
            <input id={`ed-${f.id}`} type={inputType} className={enrollerInputCls}
              value={v == null ? '' : String(v)} placeholder={f.placeholder}
              onChange={(e) => set(f.id, e.target.value)} />
          </div>
        );
      })}

      {err && <p className="text-xs text-red-600 font-medium">{err}</p>}

      <div className="flex gap-2">
        <button type="button" onClick={onCancel} disabled={saving}
          className="flex-1 py-3 rounded-xl text-sm font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50 flex items-center justify-center gap-1.5">
          <X className="h-4 w-4" /> Cancel
        </button>
        <button type="button" onClick={save} disabled={saving}
          className="flex-1 py-3 rounded-xl text-sm font-bold bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-dark)] disabled:opacity-40 flex items-center justify-center gap-2">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

/* ── No-form enroll (a scheme with no configured form) ───────────────────────── */

function SimpleEnroll({
  schemeId,
  targetSchemeOutletId,
  onEnrolled,
}: {
  schemeId: string;
  targetSchemeOutletId?: string;
  onEnrolled: (r: EnrollResult) => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const enrol = async () => {
    setBusy(true);
    setErr(null);
    const res = await schemeApi.enroll(schemeId, {
      enrollmentMode: 'SELF',
      formValues: {},
      targetSchemeOutletId,
    });
    setBusy(false);
    if (res.success) onEnrolled(res.data);
    else setErr(res.error);
  };

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5 w-4 h-4 rounded accent-[var(--brand-primary)]"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
        />
        <span className="text-xs text-gray-600 leading-relaxed">
          I confirm my outlet wants to participate in this activation.
        </span>
      </label>
      {err && <p className="text-xs text-red-600 font-medium">{err}</p>}
      <button
        type="button"
        onClick={enrol}
        disabled={!agreed || busy}
        className="w-full py-3 rounded-xl text-sm font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-dark)] active:scale-[0.98] flex items-center justify-center gap-2"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
        {busy ? 'Enrolling…' : 'Enrol my outlet'}
      </button>
    </div>
  );
}

/* ── Notice card ─────────────────────────────────────────────────────────────── */

function Notice({ tone, children }: { tone: 'info' | 'warn'; children: React.ReactNode }) {
  const cls =
    tone === 'warn'
      ? 'bg-amber-50 border-amber-200 text-amber-800'
      : 'bg-blue-50 border-blue-200 text-blue-800';
  const Icon = tone === 'warn' ? AlertTriangle : Info;
  return (
    <div className={`flex items-start gap-2 border rounded-xl px-3 py-2.5 ${cls}`}>
      <Icon className="h-4 w-4 shrink-0 mt-0.5" />
      <p className="text-xs leading-relaxed">{children}</p>
    </div>
  );
}

/* ── Page ────────────────────────────────────────────────────────────────────── */

export default function PartnerSchemeDetailPage() {
  const params = useParams<{ id: string }>();
  const schemeId = params?.id ?? '';
  const identity = usePartnerIdentity();

  const [loading, setLoading] = useState(true);
  const [scheme, setScheme] = useState<PartnerEligibleScheme | null>(null);
  const [enrollment, setEnrollment] = useState<SchemeEnrollment | null>(null);
  const [form, setForm] = useState<EnrollmentFormResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [justEnrolled, setJustEnrolled] = useState(false);
  const [editing, setEditing] = useState(false);

  const activePartnerId = identity.activePartnerId;

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    loadPortalScheme(schemeId)
      .then(({ scheme: s, enrollment: e, form: f }) => {
        if (cancelled) return;
        setScheme(s);
        setEnrollment(e);
        setForm(f);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load activation');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemeId, activePartnerId]);

  useEffect(() => load(), [load]);

  const onSubmitted = (result: EnrollResult) => {
    setEnrollment(result.enrollment);
    setJustEnrolled(true);
  };

  const onEdited = (result: EnrollResult) => {
    setEnrollment(result.enrollment);
    setEditing(false);
    setJustEnrolled(false);
  };

  const back = (
    <Link href="/partner/schemes" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700">
      <ArrowLeft className="h-4 w-4" /> All activations
    </Link>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (loadError || !scheme) {
    return (
      <div className="space-y-4 fade-in">
        {back}
        <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-3">
          <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center">
            <Info className="h-6 w-6 text-gray-400" />
          </div>
          <p className="text-sm font-semibold text-gray-700">
            {loadError ? 'Could not load this activation' : 'This activation is not available for your outlet'}
          </p>
          {loadError && <p className="text-xs text-gray-400">{loadError}</p>}
        </div>
      </div>
    );
  }

  const status: PortalStatus = statusOf({ enrollment });
  const canSelfEnroll = selfEnrollAllowed(scheme);
  // `allowEnrollerEdit` is a new audienceConfig key not yet on the shared AudienceConfig
  // type — read it via a local widening cast. Enables the outlet to correct its OWN
  // SUBMITTED enrollment (only meaningful when a form exists to edit).
  const allowEnrollerEdit = Boolean(
    (scheme.audienceConfig as (AudienceConfig & { allowEnrollerEdit?: boolean }) | null | undefined)?.allowEnrollerEdit,
  );
  const fixedRoster = isFixedRoster(scheme);
  // A fixed-roster scheme (EXCEL / FILTER-frozen) has no lazily-created row, so a NEW
  // self-enroll needs a materialized roster id. The eligible list surfaces the active
  // partner's MATCHED row as `mySchemeOutletId` — so an approved outlet self-enrols
  // straight into it (no more "your sales rep will enrol you" degradation). An existing
  // enrollment's schemeOutletId (resubmit target) takes precedence; live-rule → null.
  const targetSchemeOutletId = enrollment?.schemeOutletId ?? scheme.mySchemeOutletId ?? undefined;
  const canRenderFormForNew = canSelfEnroll && (!fixedRoster || Boolean(targetSchemeOutletId));

  return (
    <div className="space-y-5 fade-in">
      {back}

      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-12 h-12 rounded-2xl bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
          <Sparkles className="h-6 w-6 text-[var(--brand-primary)]" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold text-gray-900 leading-tight">{scheme.name}</h1>
          <p className="text-xs text-gray-400 mt-0.5">
            {fmtDate(scheme.startDate)} – {fmtDate(scheme.endDate)}
          </p>
        </div>
      </div>

      {scheme.description && <p className="text-sm text-gray-600 leading-relaxed">{scheme.description}</p>}

      {/* ── SUBMITTED — read-only, with optional enroller self-edit ── */}
      {status === 'SUBMITTED' && enrollment && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
            <CheckCircle className="h-5 w-5 text-emerald-600 shrink-0" />
            <div>
              <p className="text-sm font-bold text-emerald-800">
                {justEnrolled ? 'Enrolled successfully' : 'Your outlet is enrolled'}
              </p>
              <p className="text-xs text-emerald-700">Submitted {fmtDate(enrollment.enrolledAt)}</p>
            </div>
          </div>
          {editing && form ? (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Edit your submission</p>
              <EnrollerEditForm schemeId={schemeId} form={form} enrollment={enrollment} onSaved={onEdited} onCancel={() => setEditing(false)} />
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Your submission</p>
                {allowEnrollerEdit && form && (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--brand-primary)] hover:underline"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit my submission
                  </button>
                )}
              </div>
              <EnrolledSummary schemeId={schemeId} form={form} enrollment={enrollment} />
            </div>
          )}
        </div>
      )}

      {/* ── REJECTED — show reason + resubmit the whole form ── */}
      {status === 'REJECTED' && enrollment && (
        <div className="space-y-4">
          <Notice tone="warn">
            <span className="font-semibold">Your submission needs changes.</span>
            {enrollment.rejectionReason ? ` ${enrollment.rejectionReason}` : ' Please review and resubmit.'}
          </Notice>
          {form ? (
            <SchemeFormRenderer
              schema={form.schema}
              initialValues={enrollment.formValues ?? undefined}
              prefill={{
                ...(scheme.prefillValues ?? {}),
                ...(scheme.outletFieldValues ?? {}),
              }}
              context={{
                schemeId,
                mode: 'SELF',
                outletApproved: scheme.outletApproved ?? false,
                ownerPhoneMasked: scheme.ownerPhoneMasked ?? undefined,
                activePartnerId: activePartnerId ?? undefined,
                targetSchemeOutletId,
              }}
              onSubmitted={onSubmitted}
            />
          ) : (
            <SimpleEnroll schemeId={schemeId} targetSchemeOutletId={targetSchemeOutletId} onEnrolled={onSubmitted} />
          )}
        </div>
      )}

      {/* ── NOT ENROLLED — enroll (form or simple) or an assisted-only notice ── */}
      {status === 'NOT_ENROLLED' && (
        <div className="space-y-4">
          {!canSelfEnroll ? (
            <Notice tone="info">
              Self-enrolment isn’t enabled for this activation. Your sales representative will enrol your outlet.
            </Notice>
          ) : !canRenderFormForNew ? (
            <Notice tone="info">
              This activation is enrolled by your sales representative. Please reach out to them to be enrolled.
            </Notice>
          ) : form ? (
            <>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Enrolment details</p>
              <SchemeFormRenderer
                schema={form.schema}
                prefill={{
                  ...(scheme.outletFieldValues ?? {}),
                  ...(scheme.prefillValues ?? {}),
                }}
                context={{
                  schemeId,
                  mode: 'SELF',
                  outletApproved: scheme.outletApproved ?? false,
                  ownerPhoneMasked: scheme.ownerPhoneMasked ?? undefined,
                  activePartnerId: activePartnerId ?? undefined,
                  targetSchemeOutletId,
                }}
                onSubmitted={onSubmitted}
              />
            </>
          ) : (
            <SimpleEnroll schemeId={schemeId} targetSchemeOutletId={targetSchemeOutletId} onEnrolled={onSubmitted} />
          )}
        </div>
      )}
    </div>
  );
}
