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

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, Calculator, Camera, CheckCircle, Eye, FileText, Lock, MapPin,
  Loader2, ShieldCheck, Upload, X,
} from 'lucide-react';
import { schemeApi, type EnrollInput, type EnrollResult } from '@/lib/schemes';
import {
  DISPLAY_ONLY_FIELD_TYPES,
  evaluateFormula,
  isFieldRequired,
  isFieldVisible,
  orderedFields,
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
  for (const f of schema.fields) {
    if (out[f.id] !== undefined) continue;
    if (prefill) {
      if (prefill[f.id] !== undefined) out[f.id] = prefill[f.id];
      else if (f.prefillKey && prefill[f.prefillKey] !== undefined) out[f.id] = prefill[f.prefillKey];
    }
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
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [otpVerified, setOtpVerified] = useState(false);

  const fields = useMemo(() => orderedFields(schema), [schema]);

  const setValue = useCallback((id: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [id]: value }));
  }, []);

  const reportError = useCallback(
    (msg: string) => {
      setSubmitError(msg);
      onError?.(msg);
    },
    [onError],
  );

  // ── Media upload (CAMERA / DOCUMENT / IMAGE / UPI_QR_SCAN / SIGNATURE) ───────
  const uploadFile = useCallback(
    async (fieldId: string, file: File | Blob, filename?: string) => {
      setUploading((u) => ({ ...u, [fieldId]: true }));
      const res = await schemeApi.uploadMedia(schemeId, file, filename);
      setUploading((u) => ({ ...u, [fieldId]: false }));
      if (res.success) {
        setValue(fieldId, res.data.key);
        return true;
      }
      reportError(res.error);
      return false;
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

    // 2) client-side validation (mirrors backend)
    const errs = validateSchemeValues(schema, working);
    if (otpRequired && !otpVerified) {
      errs.push('Verify the phone OTP before submitting.');
    }
    if (errs.length > 0) {
      setFieldErrors(errs);
      onError?.(errs[0]);
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
    // The editable-field typed mobile (ignored for a pinned/approved outlet).
    if (phoneOtpField && !outletApproved) {
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
            ownerPhoneMasked={ownerPhoneMasked}
          />
        );
      })}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full py-3 rounded-xl text-sm font-bold transition-all
          disabled:opacity-40 disabled:cursor-not-allowed
          bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-dark)]
          active:scale-[0.98] flex items-center justify-center gap-2"
      >
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Submitting…
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
  uploadFile: (fieldId: string, file: File | Blob, filename?: string) => Promise<boolean>;
  captureGps: () => Promise<GpsCapture | null>;
  context: SchemeFormContext;
  subject: { enrollmentMode: 'SELF' | 'SALES'; targetSchemeOutletId?: string; targetOutletRef?: string };
  otpVerified: boolean;
  setOtpVerified: (v: boolean) => void;
  ownerPhoneMasked?: string;
}

function FieldRenderer(props: FieldRendererProps) {
  const { field, values, setValue, prefill } = props;
  const val = values[field.id];
  const req = isFieldRequired(field, values);
  const locked = Boolean(field.locked);

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
      const shown = prefill?.[field.id] ?? prefill?.[key] ?? val;
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
        <Labeled field={field} req={req}>
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
        <Labeled field={field} req={req}>
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
        <Labeled field={field} req={req}>
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
        <Labeled field={field} req={req}>
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
        <Labeled field={field} req={req}>
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
        <Labeled field={field} req={req}>
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
    case 'CAMERA':
      return <MediaField {...props} req={req} accept="image/*" capture="environment" icon="camera" />;
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
        <Labeled field={field} req={req}>
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
  field, req, children,
}: {
  field: FormField;
  req: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label htmlFor={field.id} className={labelCls}>
          {field.label}
          <RequiredStar show={req} />
        </label>
        {field.locked && (
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
  field, values, uploading, uploadFile, req, accept, capture, icon,
}: FieldRendererProps & {
  req: boolean;
  accept: string;
  capture?: 'environment' | 'user';
  icon: 'camera' | 'doc';
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const key = typeof values[field.id] === 'string' ? (values[field.id] as string) : '';

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await uploadFile(field.id, file);
    // Allow re-selecting the same file.
    if (inputRef.current) inputRef.current.value = '';
  };

  const Icon = icon === 'camera' ? Camera : FileText;

  return (
    <Labeled field={field} req={req}>
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

// ── Signature field (canvas draw → upload PNG → media key) ─────────────────────

function SignatureField({ field, values, uploading, uploadFile, req }: FieldRendererProps & { req: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  const key = typeof values[field.id] === 'string' ? (values[field.id] as string) : '';

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
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
    dirty.current = true;
  };
  const end = () => {
    drawing.current = false;
  };
  const clear = () => {
    const c = canvasRef.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    dirty.current = false;
  };
  const save = () => {
    const c = canvasRef.current;
    if (!c || !dirty.current) return;
    c.toBlob((blob) => {
      if (blob) void uploadFile(field.id, blob, 'signature.png');
    }, 'image/png');
  };

  return (
    <Labeled field={field} req={req}>
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
        </div>
      )}
    </Labeled>
  );
}

// ── GPS field ─────────────────────────────────────────────────────────────────

function GpsField({ field, values, setValue, captureGps, req }: FieldRendererProps & { req: boolean }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const v = values[field.id] as GpsCapture | undefined;
  const auto = (field.captureTrigger ?? 'MANUAL') === 'ON_SUBMIT';

  const capture = async () => {
    setLoading(true);
    setError('');
    const fix = await captureGps();
    setLoading(false);
    if (fix) setValue(field.id, fix);
    else setError('Could not get location. Please try again.');
  };

  return (
    <Labeled field={field} req={req}>
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
  field, values, setValue, context, subject, otpVerified, setOtpVerified, ownerPhoneMasked, req,
}: FieldRendererProps & { req: boolean }) {
  const { schemeId, outletApproved } = context;
  const [otp, setOtp] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [sent, setSent] = useState(false);
  const [locked, setLocked] = useState(outletApproved);
  const [phoneMasked, setPhoneMasked] = useState(ownerPhoneMasked ?? '');
  const [error, setError] = useState('');
  // Pinned outlets never edit the number; everyone else types it.
  const editable = !outletApproved && !field.locked;
  const typed = String(values[field.id] ?? '');

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
    <Labeled field={field} req={req}>
      {outletApproved || locked ? (
        <div className="flex items-center gap-2 px-3 py-2.5 bg-blue-50 border border-blue-200 rounded-xl">
          <Lock className="h-3.5 w-3.5 text-blue-500 shrink-0" />
          <span className="text-xs text-blue-700 font-medium">
            OTP to owner on file{phoneMasked ? ` (${phoneMasked})` : ''}
          </span>
        </div>
      ) : (
        <input
          id={field.id}
          type="tel"
          inputMode="numeric"
          className={inputCls}
          value={typed}
          disabled={otpVerified}
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
              <button type="button" onClick={send} disabled={sending} className="text-[10px] text-gray-500 underline">
                Resend
              </button>
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
