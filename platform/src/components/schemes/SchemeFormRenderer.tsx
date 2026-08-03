'use client';

/**
 * SchemeFormRenderer — the SHARED enrollment form renderer for the Scheme
 * Data-Collection feature. The outlet portal (2C) and the sales app (2D) both
 * render this exact component; it owns field rendering, client-side validation
 * (mirroring the backend), media/GPS/OTP capture, and the enroll submit.
 *
 * Renders every §13.1 field type:
 *   TEXT · EMAIL · NUMBER · DATE · TEXTAREA · DROPDOWN · MULTI_SELECT · TOGGLE ·
 *   SECTION · DATA_DISPLAY · CALCULATED · LOOKUP · SIGNATURE · CAMERA · DOCUMENT ·
 *   IMAGE · UPI_QR_SCAN · GPS_POINT · PHONE_OTP
 *
 * Contract (implemented EXACTLY so 2C/2D can code against it):
 *   props {
 *     schema; initialValues?; prefill?;
 *     context: { schemeId; mode; outletApproved; ownerPhoneMasked?; activePartnerId?;
 *                targetSchemeOutletId?; targetOutletRef? };   // last two: see NOTE
 *     onSubmitted(result); onError?(msg);
 *   }
 *
 * NOTE (flagged to the orchestrator): the given contract omits an enroll TARGET,
 * but both SELF (frozen/EXCEL roster) and SALES enroll require one. `context` is
 * therefore extended with OPTIONAL `targetSchemeOutletId` / `targetOutletRef` —
 * additive, non-breaking (SELF live-rule may omit both). See the return report.
 *
 * ACTIVE PARTNER: `context.activePartnerId` is informational only — the backend
 * resolves the active partner from the httpOnly cookie the proxy injects; the FE
 * cannot set that header.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, Calculator, Camera, CheckCircle, Eye, FileText, Lock, MapPin,
  Loader2, ShieldCheck, Upload, X,
} from 'lucide-react';
import { schemeApi, type EnrollInput, type EnrollResult } from '@/lib/schemes';
import {
  DISPLAY_ONLY_FIELD_TYPES,
  PREFILLABLE_VALUE_FIELD_TYPES,
  evaluateFormula,
  isFieldRequired,
  isFieldVisible,
  orderedFields,
  readMediaValue,
  resolveLookup,
  validateSchemeValues,
  type EnrollmentFormSchema,
  type FormField,
  type GpsCapture,
} from '@/lib/scheme-types';

// ─────────────────────────────────────────────────────────────────────────────
// Props contract
// ─────────────────────────────────────────────────────────────────────────────

export interface SchemeFormContext {
  schemeId: string;
  mode: 'SELF' | 'SALES';
  /** KYC-approved matched outlet → PHONE_OTP is pinned+locked to the owner's number (D16). */
  outletApproved: boolean;
  /** Masked owner number shown next to a pinned PHONE_OTP field (e.g. "••••1234"). */
  ownerPhoneMasked?: string;
  /** Informational only — active partner is server-resolved from the cookie. */
  activePartnerId?: string;
  /** Enroll target — an existing roster row (Excel/frozen/prior lazy row). */
  targetSchemeOutletId?: string;
  /** Enroll target — a live-rule outlet id to lazily add + enroll (SALES matched outlet). */
  targetOutletRef?: string;
}

export interface SchemeFormRendererProps {
  schema: EnrollmentFormSchema;
  initialValues?: Record<string, unknown>;
  /** Excel/roster prefill, keyed by field id and/or the field's `prefillKey`. */
  prefill?: Record<string, unknown>;
  context: SchemeFormContext;
  onSubmitted: (result: EnrollResult) => void;
  onError?: (msg: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Style tokens (match the existing partner renderer)
// ─────────────────────────────────────────────────────────────────────────────

const inputCls =
  'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 ' +
  'focus:border-[var(--brand-primary)] bg-white disabled:bg-gray-50 disabled:text-gray-400';
const labelCls = 'text-xs font-medium text-gray-700 block mb-1';
const helpCls = 'text-[11px] text-gray-400 mt-0.5';

function RequiredStar({ show }: { show: boolean }) {
  return show ? <span className="text-red-500 ml-0.5">*</span> : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Initial value resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolveInitialValues(
  schema: EnrollmentFormSchema,
  initialValues: Record<string, unknown> | undefined,
  prefill: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(initialValues ?? {}) };
  if (!prefill) return out;
  for (const f of schema.fields) {
    if (out[f.id] !== undefined) continue;
    // Only inject a prefill string into a VALUE field. A media (stored object key),
    // GPS fix, signature, CALCULATED, LOOKUP, SECTION or DATA_DISPLAY field must never
    // receive a raw prefill string — it would corrupt that field's value shape.
    if (!PREFILLABLE_VALUE_FIELD_TYPES.has(f.type)) continue;
    // Dual-source resolution (D13 + outletField): the field-id-keyed value wins, then the
    // matched-outlet master field (`outletField`), then the Excel column (`prefillKey`).
    if (prefill[f.id] !== undefined) out[f.id] = prefill[f.id];
    else if (f.outletField && prefill[f.outletField] !== undefined) out[f.id] = prefill[f.outletField];
    else if (f.prefillKey && prefill[f.prefillKey] !== undefined) out[f.id] = prefill[f.prefillKey];
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function SchemeFormRenderer({
  schema,
  initialValues,
  prefill,
  context,
  onSubmitted,
  onError,
}: SchemeFormRendererProps) {
  const { schemeId, mode, outletApproved, ownerPhoneMasked } = context;

  const [values, setValues] = useState<Record<string, unknown>>(() =>
    resolveInitialValues(schema, initialValues, prefill),
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [errorFieldId, setErrorFieldId] = useState<string | null>(null);
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [otpVerified, setOtpVerified] = useState(false);
  // SIG-2: signature fields that have strokes but whose PNG hasn't been saved/uploaded
  // yet. Tracked so Submit can block (with a clear message) instead of silently dropping
  // a signature the rep drew but never tapped "Save signature" for.
  const [unsavedSignatures, setUnsavedSignatures] = useState<Record<string, boolean>>({});

  const fields = useMemo(() => orderedFields(schema), [schema]);

  const setValue = useCallback((id: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [id]: value }));
  }, []);

  const setSignatureUnsaved = useCallback((id: string, v: boolean) => {
    setUnsavedSignatures((prev) => (Boolean(prev[id]) === v ? prev : { ...prev, [id]: v }));
  }, []);

  // ENR-M1: true while ANY field's media upload is in flight → Submit is blocked.
  const anyUploading = useMemo(() => Object.values(uploading).some(Boolean), [uploading]);

  const reportError = useCallback(
    (msg: string) => {
      setSubmitError(msg);
      onError?.(msg);
    },
    [onError],
  );

  // ── Media upload (CAMERA / DOCUMENT / IMAGE / UPI_QR_SCAN / SIGNATURE) ───────
  // Returns the uploaded object key (null on failure) so a geotag caller can attach a
  // per-photo GPS fix and store `{ key, geo }` itself. By default it also stores the bare
  // key string into the field value (unchanged behaviour for every non-geotag caller);
  // pass `{ store: false }` to suppress that and take ownership of the stored shape.
  const uploadFile = useCallback(
    async (
      fieldId: string,
      file: File | Blob,
      filename?: string,
      opts?: { store?: boolean },
    ): Promise<string | null> => {
      setUploading((u) => ({ ...u, [fieldId]: true }));
      try {
        const res = await schemeApi.uploadMedia(schemeId, file, filename);
        if (res.success) {
          if (opts?.store !== false) setValue(fieldId, res.data.key);
          return res.data.key;
        }
        reportError(res.error);
        return null;
      } finally {
        // Reset in finally so a throw/reject can never leave Submit stuck disabled (ENR-M1).
        setUploading((u) => ({ ...u, [fieldId]: false }));
      }
    },
    [schemeId, setValue, reportError],
  );

  // ── PHONE-OTP consent sub-flow (D16) ────────────────────────────────────────
  const phoneOtpField = useMemo(
    () => fields.find((f) => f.type === 'PHONE_OTP') ?? null,
    [fields],
  );

  const otpRequired = Boolean(
    schema.requireOtp || (phoneOtpField && phoneOtpField.otpRequired),
  );

  const subject = useMemo(
    () => ({
      enrollmentMode: mode,
      targetSchemeOutletId: context.targetSchemeOutletId,
      targetOutletRef: context.targetOutletRef,
    }),
    [mode, context.targetSchemeOutletId, context.targetOutletRef],
  );

  // ── GPS capture ─────────────────────────────────────────────────────────────
  const captureGps = useCallback((): Promise<GpsCapture | null> => {
    return new Promise((resolve) => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: Math.round(pos.coords.accuracy),
            capturedAt: new Date().toISOString(),
          }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10_000 },
      );
    });
  }, []);

  // ── Submit ──────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    setSubmitError(null);
    setFieldErrors([]);
    setErrorFieldId(null);

    // ENR-M1: never submit while a media/camera/signature upload is still in flight — the
    // file could be dropped or a just-captured field wrongly read as empty. The button is
    // also disabled on `anyUploading`; this guards a programmatic / racy invocation.
    if (Object.values(uploading).some(Boolean)) return;

    // 1) capture GPS at submit. Two triggers land a single fix into empty GPS fields:
    //    - a field whose own captureTrigger === 'ON_SUBMIT', and
    //    - the top-level schema.captureGpsOnSubmit flag, which fills EVERY empty
    //      GPS_POINT field (not just ON_SUBMIT ones) — otherwise the flag is a no-op
    //      for MANUAL/ON_PHOTO fields the filler left blank (B-MED-1).
    const working: Record<string, unknown> = { ...values };
    const allGps = fields.filter((f) => f.type === 'GPS_POINT');
    const gpsToFill = schema.captureGpsOnSubmit
      ? allGps
      : allGps.filter((f) => (f.captureTrigger ?? 'MANUAL') === 'ON_SUBMIT');
    if (gpsToFill.length > 0) {
      const fix = await captureGps();
      if (fix) {
        for (const f of gpsToFill) if (working[f.id] == null) working[f.id] = fix;
      }
    }

    // SIG-2: a signature that was drawn but never saved would be silently lost here (its
    // value is still empty). Block Submit with a clear, field-pointed message so the rep
    // taps "Save signature" first — a drawn signature can never vanish without being told.
    const pendingSig = fields.find(
      (f) => f.type === 'SIGNATURE' && isFieldVisible(f, working) && unsavedSignatures[f.id],
    );
    if (pendingSig) {
      const msg = `Tap "Save signature" to save "${pendingSig.label}" before submitting.`;
      setFieldErrors([msg]);
      onError?.(msg);
      setErrorFieldId(pendingSig.id);
      if (typeof document !== 'undefined') {
        requestAnimationFrame(() =>
          document
            .getElementById(pendingSig.id)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
        );
      }
      return;
    }

    // 2) client-side validation (mirrors backend)
    const errs = validateSchemeValues(schema, working);
    if (otpRequired && !otpVerified) {
      errs.push('Verify the phone OTP before submitting.');
    }
    if (errs.length > 0) {
      setFieldErrors(errs);
      onError?.(errs[0]);
      // Scroll to / highlight the first field the errors point at. Field-level messages
      // embed the field label in quotes ("<label>" is required.) — map that back to a
      // rendered field id so the user lands on the exact input that needs attention.
      const m = /"([^"]+)"/.exec(errs[0]);
      const firstField = m ? fields.find((f) => f.label === m[1]) : undefined;
      setErrorFieldId(firstField?.id ?? null);
      if (firstField && typeof document !== 'undefined') {
        requestAnimationFrame(() =>
          document
            .getElementById(firstField.id)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
        );
      }
      return;
    }

    // 3) build the enroll payload (drop display/section fields; server owns CALCULATED/LOOKUP).
    //    Skip fields hidden by a `visibleWhen` clause so a stale value from a now-hidden
    //    field is never submitted — mirrors the validator, which also skips invisible
    //    fields (B-MED-2).
    const formValues: Record<string, unknown> = {};
    for (const f of fields) {
      if (DISPLAY_ONLY_FIELD_TYPES.has(f.type)) continue;
      if (!isFieldVisible(f, working)) continue;
      const v = working[f.id];
      if (v !== undefined) formValues[f.id] = v;
    }

    const payload: EnrollInput = {
      enrollmentMode: mode,
      targetSchemeOutletId: context.targetSchemeOutletId,
      targetOutletRef: context.targetOutletRef,
      formValues,
    };
    // The editable-field typed mobile (ignored for a pinned/approved outlet, and for a
    // LOCKED phone field — the backend authoritatively OTPs the roster-prefilled number,
    // so we must not let a client value override it).
    if (phoneOtpField && !outletApproved && !phoneOtpField.locked) {
      const m = working[phoneOtpField.id];
      if (typeof m === 'string' && m) payload.mobile = m;
    }

    setSubmitting(true);
    const res = await schemeApi.enroll(schemeId, payload);
    setSubmitting(false);

    if (res.success) {
      onSubmitted(res.data);
    } else {
      reportError(res.error);
    }
  }, [
    values, fields, schema, otpRequired, otpVerified, mode, context, phoneOtpField,
    outletApproved, schemeId, captureGps, onSubmitted, onError, reportError,
    uploading, unsavedSignatures,
  ]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {fields.map((field) => {
        if (!isFieldVisible(field, values)) return null;
        return (
          <FieldRenderer
            key={field.id}
            field={field}
            values={values}
            setValue={setValue}
            prefill={prefill}
            uploading={Boolean(uploading[field.id])}
            uploadFile={uploadFile}
            captureGps={captureGps}
            context={context}
            subject={subject}
            otpVerified={otpVerified}
            setOtpVerified={setOtpVerified}
            setSignatureUnsaved={setSignatureUnsaved}
            ownerPhoneMasked={ownerPhoneMasked}
            errorFieldId={errorFieldId}
          />
        );
      })}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting || anyUploading}
        className="w-full py-3 rounded-xl text-sm font-bold transition-all
          disabled:opacity-40 disabled:cursor-not-allowed
          bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-dark)]
          active:scale-[0.98] flex items-center justify-center gap-2"
      >
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Submitting…
          </>
        ) : anyUploading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Waiting for upload to finish…
          </>
        ) : (
          'Submit'
        )}
      </button>

      {fieldErrors.length > 0 && (
        <div role="alert" className="bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 space-y-1">
          {fieldErrors.map((e, i) => (
            <p key={i} className="text-xs text-red-700 flex items-start gap-1.5">
              <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
              {e}
            </p>
          ))}
        </div>
      )}

      {submitError && fieldErrors.length === 0 && (
        <div role="alert" className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
          <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
          <p className="text-xs text-red-700">{submitError}</p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-field renderer
// ─────────────────────────────────────────────────────────────────────────────

interface FieldRendererProps {
  field: FormField;
  values: Record<string, unknown>;
  setValue: (id: string, v: unknown) => void;
  prefill?: Record<string, unknown>;
  uploading: boolean;
  uploadFile: (
    fieldId: string,
    file: File | Blob,
    filename?: string,
    opts?: { store?: boolean },
  ) => Promise<string | null>;
  captureGps: () => Promise<GpsCapture | null>;
  context: SchemeFormContext;
  subject: { enrollmentMode: 'SELF' | 'SALES'; targetSchemeOutletId?: string; targetOutletRef?: string };
  otpVerified: boolean;
  setOtpVerified: (v: boolean) => void;
  /** SIG-2: report whether this (signature) field has drawn-but-unsaved strokes. */
  setSignatureUnsaved?: (id: string, v: boolean) => void;
  ownerPhoneMasked?: string;
  /** Field id the last failed submit pointed at — highlighted + scrolled into view. */
  errorFieldId?: string | null;
}

/**
 * Resolve the effective prefill value for a field across the dual sources: the field-id
 * key, the matched-outlet master field (`outletField`), then the Excel column
 * (`prefillKey`). Mirrors the enroll-time resolution order (outletField beats Excel).
 */
function resolvePrefillValue(
  field: FormField,
  prefill: Record<string, unknown> | undefined,
): unknown {
  return (
    prefill?.[field.id] ??
    (field.outletField ? prefill?.[field.outletField] : undefined) ??
    (field.prefillKey ? prefill?.[field.prefillKey] : undefined)
  );
}

function FieldRenderer(props: FieldRendererProps) {
  const { field, values, setValue, prefill, errorFieldId } = props;
  const val = values[field.id];
  const req = isFieldRequired(field, values);
  // A LOCKED field disables its input ONLY when a prefill value actually exists for it
  // (roster Excel column OR the matched-outlet master field) — matching the backend,
  // where a blank source falls back to editable and never pins (so a required locked
  // field with a blank source can't brick the form). `prefill` carries only form-bound,
  // non-empty values (server-projected).
  const prefillVal = resolvePrefillValue(field, prefill);
  const hasPrefill = prefillVal !== undefined && prefillVal !== null && prefillVal !== '';
  const locked = Boolean(field.locked) && hasPrefill;
  const highlight = errorFieldId != null && field.id === errorFieldId;

  switch (field.type) {
    // ── Structural / display ──────────────────────────────────────────────────
    case 'SECTION':
      return (
        <div className="pt-2">
          <h4 className="text-sm font-bold text-gray-800">{field.label}</h4>
          {field.helpText && <p className="text-xs text-gray-500 mt-0.5">{field.helpText}</p>}
        </div>
      );

    case 'DATA_DISPLAY': {
      const key = field.dataDisplayKey ?? field.prefillKey ?? field.label;
      const shown =
        prefill?.[field.id] ??
        (field.outletField ? prefill?.[field.outletField] : undefined) ??
        prefill?.[key] ??
        val;
      return (
        <Labeled field={field} req={false}>
          <div className="flex items-center gap-2 px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl">
            <Eye className="h-3.5 w-3.5 text-gray-400 shrink-0" />
            <span className="text-sm font-medium text-gray-700">
              {shown != null && shown !== '' ? String(shown) : '—'}
            </span>
          </div>
        </Labeled>
      );
    }

    case 'CALCULATED': {
      const result = field.formula ? evaluateFormula(field.formula, values) : null;
      return (
        <Labeled field={field} req={false}>
          <div className="flex items-center gap-2 px-3 py-2.5 bg-orange-50 border border-orange-200 rounded-xl">
            <Calculator className="h-3.5 w-3.5 text-orange-400 shrink-0" />
            <span className="text-sm font-medium text-orange-700">
              {result !== null ? result.toLocaleString() : '—'}
            </span>
          </div>
        </Labeled>
      );
    }

    case 'LOOKUP': {
      const mapped = resolveLookup(field, values);
      return (
        <Labeled field={field} req={false}>
          <div className="flex items-center gap-2 px-3 py-2.5 bg-indigo-50 border border-indigo-200 rounded-xl">
            <span className="text-sm font-medium text-indigo-700">{mapped ?? '—'}</span>
          </div>
        </Labeled>
      );
    }

    // ── Text-like ─────────────────────────────────────────────────────────────
    // NOTE: the built backend FORM_FIELD_TYPES does NOT include TEXTAREA (it is in
    // the design §13.1 prose but not the frozen enum) — so a TEXTAREA field can never
    // be authored or submitted. No case is rendered for it. Flagged in the build report.
    case 'NUMBER':
      return (
        <Labeled field={field} req={req} locked={locked} highlight={highlight}>
          <input
            id={field.id}
            type="number"
            className={inputCls}
            value={String(val ?? '')}
            disabled={locked}
            placeholder={field.placeholder}
            onChange={(e) => setValue(field.id, e.target.value)}
          />
        </Labeled>
      );

    case 'EMAIL':
      return (
        <Labeled field={field} req={req} locked={locked} highlight={highlight}>
          <input
            id={field.id}
            type="email"
            inputMode="email"
            autoCapitalize="none"
            className={inputCls}
            value={String(val ?? '')}
            disabled={locked}
            placeholder={field.placeholder}
            onChange={(e) => setValue(field.id, e.target.value)}
          />
        </Labeled>
      );

    case 'DATE':
      return (
        <Labeled field={field} req={req} locked={locked} highlight={highlight}>
          <input
            id={field.id}
            type="date"
            className={inputCls}
            value={String(val ?? '')}
            disabled={locked}
            onChange={(e) => setValue(field.id, e.target.value)}
          />
        </Labeled>
      );

    case 'DROPDOWN':
      return (
        <Labeled field={field} req={req} locked={locked} highlight={highlight}>
          <select
            id={field.id}
            className={inputCls}
            value={String(val ?? '')}
            disabled={locked}
            onChange={(e) => setValue(field.id, e.target.value)}
          >
            <option value="">Select…</option>
            {(field.options ?? []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </Labeled>
      );

    case 'MULTI_SELECT': {
      const selected = Array.isArray(val) ? (val as string[]) : [];
      const toggle = (opt: string) => {
        const next = selected.includes(opt)
          ? selected.filter((o) => o !== opt)
          : [...selected, opt];
        setValue(field.id, next);
      };
      return (
        <Labeled field={field} req={req} locked={locked} highlight={highlight}>
          <div className="space-y-1.5">
            {(field.options ?? []).map((opt) => (
              <label key={opt} className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={selected.includes(opt)}
                  disabled={locked}
                  onChange={() => toggle(opt)}
                  aria-label={`${field.label}: ${opt}`}
                />
                {opt}
              </label>
            ))}
          </div>
        </Labeled>
      );
    }

    case 'TOGGLE': {
      const on = val === true || val === 'true' || val === 'yes' || val === '1';
      return (
        <Labeled field={field} req={req} locked={locked} highlight={highlight}>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              role="switch"
              checked={on}
              disabled={locked}
              aria-label={field.label}
              onChange={(e) => setValue(field.id, e.target.checked)}
            />
            {on ? 'Yes' : 'No'}
          </label>
        </Labeled>
      );
    }

    // ── Media ────────────────────────────────────────────────────────────────
    // CAMERA is a TRUE in-app live capture (webcam / rear camera) — NO gallery or
    // file-picker fallback. DOCUMENT / IMAGE / UPI_QR_SCAN legitimately allow files
    // and stay on the MediaField (file-input) path.
    case 'CAMERA':
      return <CameraField {...props} req={req} />;
    case 'IMAGE':
      return <MediaField {...props} req={req} accept="image/*" icon="camera" />;
    case 'UPI_QR_SCAN':
      return <MediaField {...props} req={req} accept="image/*" icon="camera" />;
    case 'DOCUMENT':
      return <MediaField {...props} req={req} accept="image/*,application/pdf" icon="doc" />;
    case 'SIGNATURE':
      return <SignatureField {...props} req={req} />;

    // ── GPS ──────────────────────────────────────────────────────────────────
    case 'GPS_POINT':
      return <GpsField {...props} req={req} />;

    // ── Phone OTP ────────────────────────────────────────────────────────────
    case 'PHONE_OTP':
      return <PhoneOtpField {...props} req={req} />;

    // ── TEXT (default) ───────────────────────────────────────────────────────
    default:
      return (
        <Labeled field={field} req={req} locked={locked} highlight={highlight}>
          <input
            id={field.id}
            type="text"
            className={inputCls}
            value={String(val ?? '')}
            disabled={locked}
            placeholder={field.placeholder}
            onChange={(e) => setValue(field.id, e.target.value)}
          />
        </Labeled>
      );
  }
}

// ── Shared label wrapper ──────────────────────────────────────────────────────

function Labeled({
  field, req, children, locked, highlight,
}: {
  field: FormField;
  req: boolean;
  children: React.ReactNode;
  /**
   * Whether this field is genuinely prefill-locked (field.locked AND a resolved source
   * value). Gating the pill on this — rather than raw `field.locked` — avoids a
   * misleading "Locked" badge on a field whose source cell is blank (still editable).
   */
  locked?: boolean;
  /** The last failed submit pointed at this field — draw an attention ring. */
  highlight?: boolean;
}) {
  return (
    <div className={highlight ? 'ring-2 ring-red-400 rounded-xl p-2 -m-2' : undefined}>
      <div className="flex items-center justify-between mb-1">
        <label htmlFor={field.id} className={labelCls}>
          {field.label}
          <RequiredStar show={req} />
        </label>
        {locked && (
          <span
            data-testid={`lock-icon-${field.id}`}
            className="flex items-center gap-1 text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full"
          >
            <Lock className="h-2.5 w-2.5" /> Locked
          </span>
        )}
      </div>
      {children}
      {field.helpText && <p className={helpCls}>{field.helpText}</p>}
    </div>
  );
}

// ── Media field (CAMERA / IMAGE / DOCUMENT / UPI_QR_SCAN) ──────────────────────

function MediaField({
  field, values, uploading, uploadFile, req, accept, capture, icon, errorFieldId,
}: FieldRendererProps & {
  req: boolean;
  accept: string;
  capture?: 'environment' | 'user';
  icon: 'camera' | 'doc';
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const key = typeof values[field.id] === 'string' ? (values[field.id] as string) : '';
  const highlight = errorFieldId != null && field.id === errorFieldId;

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await uploadFile(field.id, file);
    // Allow re-selecting the same file.
    if (inputRef.current) inputRef.current.value = '';
  };

  const Icon = icon === 'camera' ? Camera : FileText;

  return (
    <Labeled field={field} req={req} highlight={highlight}>
      {key ? (
        <div className="flex items-center gap-2 px-3 py-2.5 bg-green-50 border border-green-200 rounded-xl">
          <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
          <span className="text-xs text-green-700 font-medium truncate">Captured</span>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="ml-auto text-[10px] text-green-600 underline"
          >
            Replace
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="w-full flex items-center justify-center gap-2 py-2.5 border-2 border-dashed border-gray-200 rounded-xl text-sm text-gray-500 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] disabled:opacity-50 transition-colors"
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon === 'camera' ? <Icon className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
          {uploading ? 'Uploading…' : icon === 'camera' ? 'Capture photo' : 'Upload file'}
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        // `capture` on a file input opens the rear camera directly on field phones (D14).
        {...(capture ? { capture } : {})}
        className="hidden"
        aria-label={field.label}
        onChange={onFile}
      />
    </Labeled>
  );
}

// ── Camera field (CAMERA only — TRUE in-app live capture, NO file fallback) ────
//
// Unlike MediaField (a hidden <input type="file">), CAMERA opens the device camera
// in-app via getUserMedia, shows the live stream, and captures the current frame to
// a JPEG that is POSTed through the same `uploadFile` helper (→ stored object key in
// values[field.id]). There is deliberately NO gallery / file-picker fallback — a
// "Capture photo" field must prove a live photo, so on any camera failure we surface
// an inline error + Retry, never a file input.
//
// NOTE: getUserMedia requires a SECURE CONTEXT (HTTPS or localhost). Staging and prod
// are both served over HTTPS, so this is satisfied there and in local dev on localhost.
function CameraField({
  field, values, setValue, uploading, uploadFile, captureGps, req, errorFieldId,
}: FieldRendererProps & { req: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [live, setLive] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read back through readMediaValue so BOTH a legacy bare-key string and a per-photo
  // `{ key, geo }` value resolve to the same shape (full backward-compat).
  const media = readMediaValue(values[field.id]);
  const key = media.key;
  const geo = media.geo;
  const highlight = errorFieldId != null && field.id === errorFieldId;

  // Stop every track so the camera indicator light turns off promptly.
  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Always release the camera on unmount — never leave the light on.
  useEffect(() => () => stopStream(), [stopStream]);

  // Attach the live stream once the <video> is actually mounted (it only renders in
  // the `live` state).
  useEffect(() => {
    if (live && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [live]);

  const openCamera = useCallback(async () => {
    setError(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('Camera access is required for this field — allow the camera and try again.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      setLive(true);
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
        setError('No camera found.');
      } else {
        setError('Camera access is required for this field — allow the camera and try again.');
      }
    }
  }, []);

  const cancel = useCallback(() => {
    stopStream();
    setLive(false);
  }, [stopStream]);

  const capture = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    // Size the canvas to the video's intrinsic frame so the stored image is full-res.
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // Frame is captured synchronously above — release the camera immediately.
    stopStream();
    setLive(false);
    setCapturing(true);
    setError(null);
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          setCapturing(false);
          return;
        }
        if (field.geotag) {
          // Per-photo geotag: fetch a GPS fix AT SHUTTER TIME, concurrently with the
          // upload. `store: false` — this caller owns the stored shape (`{ key, geo }`).
          const [uploadedKey, fix] = await Promise.all([
            uploadFile(field.id, blob, 'capture.jpg', { store: false }),
            captureGps(),
          ]);
          setCapturing(false);
          if (!uploadedKey) return; // upload failed — error already surfaced (submitError)
          // D2 accuracy cap: a PRESENT-but-too-imprecise fix rejects the shot. A missing
          // fix (denied / timed out) does NOT block — store `{ key }` and let the backend
          // flag it (geo-fence unverifiable).
          if (
            fix &&
            typeof field.gpsMaxAccuracy === 'number' &&
            typeof fix.accuracy === 'number' &&
            fix.accuracy > field.gpsMaxAccuracy
          ) {
            setError(
              `Location too imprecise (±${Math.round(fix.accuracy)}m > ±${field.gpsMaxAccuracy}m) — move to open sky and re-capture.`,
            );
            return; // photo NOT stored → field stays uncaptured, Retry re-opens the camera
          }
          setValue(field.id, fix ? { key: uploadedKey, geo: fix } : { key: uploadedKey });
        } else {
          // Non-geotag CAMERA: unchanged — uploadFile stores the bare key string.
          await uploadFile(field.id, blob, 'capture.jpg');
          setCapturing(false);
        }
      },
      'image/jpeg',
      0.9,
    );
  }, [field.id, field.geotag, field.gpsMaxAccuracy, stopStream, uploadFile, captureGps, setValue]);

  const busy = uploading || capturing;

  return (
    <Labeled field={field} req={req} highlight={highlight}>
      {key ? (
        // Confirmed state — mirrors the other media fields. Retake re-opens the CAMERA
        // (never a file dialog).
        <div className="space-y-1">
          <div className="flex items-center gap-2 px-3 py-2.5 bg-green-50 border border-green-200 rounded-xl">
            <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
            <span className="text-xs text-green-700 font-medium truncate">Captured</span>
            <button
              type="button"
              onClick={openCamera}
              className="ml-auto text-[10px] text-green-600 underline"
            >
              Retake
            </button>
          </div>
          {geo ? (
            // Neutral tone — a captured fix is NOT the same as "inside the fence" (the client
            // can't know the fence verdict); avoid a green ✓ that reads as approval.
            <p className="flex items-center gap-1 text-[10px] text-gray-500 font-medium">
              <MapPin className="h-3 w-3 shrink-0" />
              location captured{geo.accuracy != null ? ` · ±${Math.round(geo.accuracy)}m` : ''}
            </p>
          ) : field.geotag ? (
            // Geotag was requested but no fix was obtained (denied / timed out) — tell the rep,
            // since a fence-required photo with no location gets flagged for review.
            <p className="flex items-center gap-1 text-[10px] text-amber-600 font-medium">
              <AlertCircle className="h-3 w-3 shrink-0" />
              saved without location — Retake to add it
            </p>
          ) : null}
        </div>
      ) : live ? (
        <div className="space-y-2">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            aria-label={field.label}
            className="w-full rounded-xl bg-black aspect-[3/4] object-cover"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={capture}
              disabled={busy}
              className="flex-1 py-2 rounded-xl text-sm font-semibold bg-[var(--brand-primary)] text-white disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              <Camera className="h-4 w-4" /> Capture
            </button>
            <button
              type="button"
              onClick={cancel}
              className="px-4 py-2 rounded-xl text-sm bg-gray-100 text-gray-600 flex items-center gap-1.5"
            >
              <X className="h-3.5 w-3.5" /> Cancel
            </button>
          </div>
        </div>
      ) : error ? (
        <div className="space-y-2">
          <p className="text-xs text-red-600 flex items-start gap-1.5 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
            <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
            {error}
          </p>
          <button
            type="button"
            onClick={openCamera}
            className="w-full flex items-center justify-center gap-2 py-2.5 border-2 border-dashed border-gray-200 rounded-xl text-sm text-gray-500 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] transition-colors"
          >
            <Camera className="h-4 w-4" /> Retry
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={openCamera}
          disabled={busy}
          className="w-full flex items-center justify-center gap-2 py-2.5 border-2 border-dashed border-gray-200 rounded-xl text-sm text-gray-500 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] disabled:opacity-50 transition-colors"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
          {capturing && !uploading ? 'Tagging location…' : busy ? 'Uploading…' : 'Capture photo'}
        </button>
      )}
      {/* Off-screen canvas — the capture target; never shown to the user. */}
      <canvas ref={canvasRef} className="hidden" />
    </Labeled>
  );
}

// ── Signature field (canvas draw → upload PNG → media key) ─────────────────────

function SignatureField({ field, values, uploading, uploadFile, req, errorFieldId, setSignatureUnsaved }: FieldRendererProps & { req: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  // SIG-2: hint shown when "Save signature" is tapped on an empty canvas — a no-op that
  // must NOT read as a silent success.
  const [emptyHint, setEmptyHint] = useState(false);
  const key = typeof values[field.id] === 'string' ? (values[field.id] as string) : '';
  const highlight = errorFieldId != null && field.id === errorFieldId;

  // H6: the canvas is drawn at a fixed bitmap size (320×120) but stretched by CSS
  // (`w-full`). Map the pointer from CSS pixels into bitmap pixels by scaling on each
  // axis — otherwise the ink lands offset from the cursor at any width ≠ 320px.
  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  };
  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawing.current = true;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.stroke();
    if (!dirty.current) {
      // First stroke: mark the field as having drawn-but-unsaved ink so Submit blocks
      // until it's saved (SIG-2).
      dirty.current = true;
      setEmptyHint(false);
      setSignatureUnsaved?.(field.id, true);
    }
  };
  const end = () => {
    drawing.current = false;
  };
  const clear = () => {
    const c = canvasRef.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    dirty.current = false;
    setEmptyHint(false);
    // Nothing to lose once cleared → Submit is no longer blocked on this field.
    setSignatureUnsaved?.(field.id, false);
  };
  const save = () => {
    const c = canvasRef.current;
    if (!c || !dirty.current) {
      // Empty canvas → surface a hint instead of a confusing silent no-op (SIG-2b).
      setEmptyHint(true);
      return;
    }
    setEmptyHint(false);
    c.toBlob((blob) => {
      if (!blob) return;
      void (async () => {
        const uploadedKey = await uploadFile(field.id, blob, 'signature.png');
        // Only clear the unsaved flag once the PNG is actually stored — a failed upload
        // must keep Submit blocked so the signature can't be silently lost (SIG-2c).
        if (uploadedKey) setSignatureUnsaved?.(field.id, false);
      })();
    }, 'image/png');
  };

  return (
    <Labeled field={field} req={req} highlight={highlight}>
      {key ? (
        <div className="flex items-center gap-2 px-3 py-2.5 bg-green-50 border border-green-200 rounded-xl">
          <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
          <span className="text-xs text-green-700 font-medium">Signature captured</span>
          <button type="button" onClick={clear} className="ml-auto text-[10px] text-green-600 underline">
            Re-sign
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <canvas
            id={field.id}
            ref={canvasRef}
            width={320}
            height={120}
            aria-label={field.label}
            className="w-full border border-gray-200 rounded-xl bg-white touch-none"
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerLeave={end}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={uploading}
              className="flex-1 py-2 rounded-xl text-sm font-semibold bg-[var(--brand-primary)] text-white disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save signature
            </button>
            <button type="button" onClick={clear} className="px-4 py-2 rounded-xl text-sm bg-gray-100 text-gray-600">
              Clear
            </button>
          </div>
          {emptyHint && (
            <p className="text-[11px] text-amber-600 flex items-center gap-1">
              <AlertCircle className="h-3 w-3 shrink-0" /> Draw your signature above first.
            </p>
          )}
        </div>
      )}
    </Labeled>
  );
}

// ── GPS field ─────────────────────────────────────────────────────────────────

function GpsField({ field, values, setValue, captureGps, req, errorFieldId }: FieldRendererProps & { req: boolean }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const v = values[field.id] as GpsCapture | undefined;
  const auto = (field.captureTrigger ?? 'MANUAL') === 'ON_SUBMIT';
  const highlight = errorFieldId != null && field.id === errorFieldId;

  const capture = async () => {
    setLoading(true);
    setError('');
    const fix = await captureGps();
    setLoading(false);
    if (fix) setValue(field.id, fix);
    else setError('Could not get location. Please try again.');
  };

  return (
    <Labeled field={field} req={req} highlight={highlight}>
      {v && typeof v.lat === 'number' ? (
        <div className="flex items-center gap-2 px-3 py-2.5 bg-green-50 border border-green-200 rounded-xl">
          <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
          <span className="text-xs text-green-700 font-medium">
            {v.lat.toFixed(6)}, {v.lng.toFixed(6)}
          </span>
          {v.accuracy != null && <span className="ml-auto text-[10px] text-green-500">±{v.accuracy}m</span>}
          <button type="button" onClick={capture} className="text-[10px] text-green-600 underline ml-1">
            Re-capture
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={capture}
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 py-2.5 border border-dashed border-green-300 bg-green-50 rounded-xl text-sm font-medium text-green-700 hover:bg-green-100 disabled:opacity-50 transition-colors"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
          {loading ? 'Getting location…' : auto ? 'Capture (auto on submit)' : 'Capture location'}
        </button>
      )}
      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
    </Labeled>
  );
}

// ── Phone-OTP field (D16) ─────────────────────────────────────────────────────

function PhoneOtpField({
  field, values, setValue, context, subject, otpVerified, setOtpVerified, ownerPhoneMasked, req, prefill, errorFieldId,
}: FieldRendererProps & { req: boolean }) {
  const { schemeId, outletApproved } = context;
  const highlight = errorFieldId != null && field.id === errorFieldId;
  const [otp, setOtp] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [sent, setSent] = useState(false);
  const [locked, setLocked] = useState(outletApproved);
  const [phoneMasked, setPhoneMasked] = useState(ownerPhoneMasked ?? '');
  const [error, setError] = useState('');
  // A per-field LOCKED phone is enforced ONLY when a roster number actually exists for
  // this row (matches the backend: no roster value → falls back to an editable typed
  // number, never a disabled empty input that would dead-end the OTP send).
  const prefillVal = resolvePrefillValue(field, prefill);
  const hasPrefill = prefillVal !== undefined && prefillVal !== null && prefillVal !== '';
  // Pinned outlets never edit the number; a locked-with-roster-value field is read-only;
  // everyone else (incl. locked-but-no-roster-value) types it.
  const editable = !outletApproved && (!field.locked || !hasPrefill);
  const typed = String(values[field.id] ?? '');
  // A per-field LOCKED phone (D13a) on a non-approved row WITH a roster number: show it
  // read-only. The backend authoritatively OTPs that number on send, so the filler must
  // not be able to type a different one.
  const fieldLocked = !outletApproved && Boolean(field.locked) && hasPrefill;

  const send = async () => {
    setSending(true);
    setError('');
    const res = await schemeApi.sendOtp(schemeId, {
      ...subject,
      mobile: editable ? typed : undefined,
    });
    setSending(false);
    if (res.success) {
      setSent(true);
      setLocked(res.data.locked);
      setPhoneMasked(res.data.phoneMasked);
    } else {
      setError(res.error);
    }
  };

  // ENR-H3: reset the whole OTP flow so a NEW number forces a fresh Send OTP. Clears the
  // sent/verified state + the entered code and re-enables the phone input.
  const changeNumber = () => {
    setSent(false);
    setOtp('');
    setError('');
    setOtpVerified(false);
  };

  const verify = async () => {
    setVerifying(true);
    setError('');
    const res = await schemeApi.verifyOtp(schemeId, {
      ...subject,
      mobile: editable ? typed : undefined,
      otp,
    });
    setVerifying(false);
    if (res.success && res.data.verified) {
      setOtpVerified(true);
      // Record the verified number as the field value (backend re-pins on submit).
      setValue(field.id, res.data.phone);
    } else {
      setError(res.success ? 'Invalid OTP' : res.error);
    }
  };

  return (
    <Labeled field={field} req={req} locked={Boolean(field.locked) && hasPrefill} highlight={highlight}>
      {outletApproved || locked ? (
        <div className="flex items-center gap-2 px-3 py-2.5 bg-blue-50 border border-blue-200 rounded-xl">
          <Lock className="h-3.5 w-3.5 text-blue-500 shrink-0" />
          <span className="text-xs text-blue-700 font-medium">
            OTP to owner on file{phoneMasked ? ` (${phoneMasked})` : ''}
          </span>
        </div>
      ) : fieldLocked ? (
        // Locked, roster-prefilled number — read-only. Backend OTPs this number on send.
        <input
          id={field.id}
          type="tel"
          inputMode="numeric"
          className={inputCls}
          value={typed}
          disabled
          placeholder={field.placeholder ?? '10-digit mobile'}
          aria-label={field.label}
        />
      ) : (
        <input
          id={field.id}
          type="tel"
          inputMode="numeric"
          className={inputCls}
          value={typed}
          // ENR-H3: once the OTP is sent, LOCK the number until the rep explicitly taps
          // "Change number" — otherwise they could verify number A's code against an
          // edited number B, so the recorded consent phone would diverge from the code.
          disabled={otpVerified || sent}
          placeholder={field.placeholder ?? '10-digit mobile'}
          aria-label={field.label}
          onChange={(e) => setValue(field.id, e.target.value)}
        />
      )}

      {otpVerified ? (
        <div className="flex items-center gap-1.5 mt-2 text-xs text-green-700 font-medium">
          <ShieldCheck className="h-3.5 w-3.5 text-green-500" /> Verified
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          {!sent ? (
            <button
              type="button"
              onClick={send}
              disabled={sending || (editable && typed.replace(/\D/g, '').length < 10)}
              className="text-sm font-semibold text-[var(--brand-primary)] hover:underline disabled:opacity-40 disabled:no-underline flex items-center gap-1.5"
            >
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Send OTP
            </button>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <input
                  type="tel"
                  inputMode="numeric"
                  className={inputCls + ' flex-1'}
                  value={otp}
                  placeholder="Enter OTP"
                  aria-label="Enter OTP"
                  onChange={(e) => setOtp(e.target.value)}
                />
                <button
                  type="button"
                  onClick={verify}
                  disabled={verifying || otp.length < 4}
                  className="px-3 py-2.5 rounded-xl text-sm font-semibold bg-[var(--brand-primary)] text-white disabled:opacity-40 flex items-center gap-1.5"
                >
                  {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Verify
                </button>
                <button type="button" onClick={send} disabled={sending} className="text-xs text-gray-500 underline px-2 py-2">
                  Resend
                </button>
              </div>
              {editable && (
                <button type="button" onClick={changeNumber} className="text-xs text-gray-500 underline py-1">
                  Change number
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
          <X className="h-3 w-3" /> {error}
        </p>
      )}
    </Labeled>
  );
}

export default SchemeFormRenderer;
