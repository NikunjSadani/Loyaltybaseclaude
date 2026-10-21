'use client';

/**
 * VisibilityCaptureForm — the SHARED capture-form renderer for the Visibility (POSM)
 * feature. The sales Tasks capture sheet and the outlet-view capture redirect both
 * render this exact component; it owns field rendering, client-side validation
 * (mirroring the backend), photo/GPS capture, client-side image compression, and
 * assembling the submit payload.
 *
 * Cloned-and-adapted from `components/schemes/SchemeFormRenderer.tsx` — it does NOT
 * import from or depend on the scheme feature. Visibility is sales-captured only, so
 * this renderer is deliberately TRIMMED: no self-enroll modes, no target subject, no
 * PHONE_OTP / LOOKUP / CALCULATED. It is a CONTROLLED component — it validates + builds
 * `formValues` and hands them to `onSubmit`; the caller owns the outletId and which
 * endpoint (submitCapture vs resubmitCapture) and drives `submitting`.
 *
 * Renders every §5/§6 field type:
 *   TEXT · TEXTAREA · NUMBER · DATE · DROPDOWN · MULTI_SELECT · TOGGLE · CAMERA · GPS_POINT
 *
 * CAMERA fields (D9/D16): native rear-camera capture (`capture="environment"`), the
 * per-field `instruction` text, and a `sampleImageKey` reference thumbnail (via the
 * auth-gated media view URL) when present. Photos are downscaled + re-encoded client-side
 * before upload to save the rep's mobile data + storage (best-practice #4), with a
 * graceful fallback to the original bytes if compression fails.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, Camera, CheckCircle, Loader2, MapPin,
} from 'lucide-react';
import { mediaViewUrl, visibilityApi } from '@/lib/visibility';
import {
  isFieldRequired,
  isFieldVisible,
  orderedFields,
  outletContextValues,
  readMediaValue,
  rejectedPhotoFieldIds,
  validateVisibilityValues,
  VISIBILITY_REJECT_REASON_LABELS,
  type GpsCapture,
  type VisibilityFormField,
  type VisibilityFormSchema,
  type VisibilityPhotoReview,
  type VisibilityPhotoReviews,
  type VisibilityRejectReasonCode,
} from '@/lib/visibility-types';

// ─────────────────────────────────────────────────────────────────────────────
// Props contract (implemented EXACTLY so the sales stream can code against it)
// ─────────────────────────────────────────────────────────────────────────────

export interface VisibilityCaptureFormProps {
  schema: VisibilityFormSchema;
  /** Prefill values keyed by field id (e.g. re-rendering a rejected capture for resubmit). */
  initialValues?: Record<string, unknown>;
  /**
   * Called with the assembled, validated `formValues` (hidden fields stripped). The
   * caller performs the actual submit (submitCapture / resubmitCapture) and drives
   * `submitting`; it may throw / return a rejected promise to surface an error inline.
   */
  onSubmit: (formValues: Record<string, unknown>) => void | Promise<void>;
  /** Whether a submit is in flight — disables the button + inputs. Caller-owned. */
  submitting?: boolean;
  /** Visibility is sales-captured only; kept explicit + extensible. */
  mode?: 'SALES';
  /**
   * Outlet attributes (from the outlet master, NOT rep-entered) exposed to conditional
   * `visibleWhen` / `requiredWhen` clauses via reserved ids (e.g. `__subProgram__`). These
   * drive live show/hide + the required marker only — they are NEVER submitted (reserved
   * keys are stripped from the payload). The backend re-derives the authoritative value on
   * submit, so a conditional photo requirement cannot be spoofed away by the client.
   */
  outletContext?: { subProgram?: string | null };
  /**
   * Per-CAMERA-field review state of the prior capture (from the backend), keyed by field
   * id. Supplied for a CHANGES_REQUESTED re-entry so the form can show which photos were
   * REJECTED (with reasons) and which were APPROVED (carried forward). See `partialRecapture`.
   */
  photoReviews?: VisibilityPhotoReviews;
  /**
   * PARTIAL re-capture mode (a CHANGES_REQUESTED re-entry). When true (and `photoReviews`
   * has ≥1 REJECTED photo) the form shows ONLY the rejected CAMERA fields as editable +
   * required; APPROVED/pending photos render read-only (carried forward by the server) and
   * all non-camera fields are hidden. The submit payload contains ONLY the re-captured
   * (rejected) fields — the server merges them onto the carried-forward approved photos.
   * A fresh capture (or a whole-capture REJECTED re-shoot) leaves this false → unchanged.
   */
  partialRecapture?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client-side image compression (best-practice #4)
// Exposed via an indirection object so it can be spied in tests AND swapped later.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_EDGE_PX = 1600;
const JPEG_QUALITY = 0.8;

async function loadBitmap(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file);
  }
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
    } else {
      resolve(null);
    }
  });
}

/**
 * Downscale an image to <= MAX_EDGE_PX on its longest edge and re-encode JPEG at
 * JPEG_QUALITY. Falls back to the ORIGINAL file whenever anything is unavailable /
 * fails (non-image, no canvas, decode error, or a larger result) — capture must never
 * be blocked by a failed optimisation.
 */
export async function compressImage(
  file: File,
  maxEdge = MAX_EDGE_PX,
  quality = JPEG_QUALITY,
): Promise<Blob> {
  try {
    if (!file.type || !file.type.startsWith('image/')) return file;
    const bitmap = await loadBitmap(file);
    const width = bitmap.width;
    const height = bitmap.height;
    if (!width || !height) return file;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap as CanvasImageSource, 0, 0, targetW, targetH);

    const blob = await canvasToBlob(canvas, quality);
    if (!blob || blob.size === 0) return file;
    // Only keep the compressed bytes if they are actually smaller than the original.
    return blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

/** Indirection holder — tests spy on `imageCompression.compress`. */
export const imageCompression = { compress: compressImage };

// ─────────────────────────────────────────────────────────────────────────────
// Style tokens (match the shared partner/scheme renderers)
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
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function VisibilityCaptureForm({
  schema,
  initialValues,
  onSubmit,
  submitting = false,
  outletContext,
  photoReviews,
  partialRecapture = false,
}: VisibilityCaptureFormProps) {
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...(initialValues ?? {}) }));
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const fields = useMemo(() => orderedFields(schema), [schema]);

  // PARTIAL re-capture: the set of CAMERA field ids the reviewer REJECTED — the ONLY fields
  // the rep re-captures. Active only when partial mode is on AND at least one photo is
  // rejected (otherwise fall through to the normal full form, so nothing breaks if the
  // review map is missing).
  const rejectedIds = useMemo(
    () => new Set(partialRecapture ? rejectedPhotoFieldIds(photoReviews) : []),
    [partialRecapture, photoReviews],
  );
  const partial = partialRecapture && rejectedIds.size > 0;

  // Reserved outlet-context values (keyed by `__…__` id) resolved from the outlet master.
  // These are merged into the values map ONLY for clause evaluation (live show/hide +
  // required marker); they never live in `values`, so they are never submitted.
  const reservedValues = useMemo(
    () => outletContextValues({ programCategory: outletContext?.subProgram ?? null }),
    [outletContext?.subProgram],
  );
  // The map every conditional clause (visibleWhen / requiredWhen) is evaluated against:
  // the rep-entered values plus the reserved outlet-context values.
  const evalValues = useMemo(() => ({ ...values, ...reservedValues }), [values, reservedValues]);

  const setValue = useCallback((id: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [id]: value }));
  }, []);

  // ── Media upload (CAMERA) — compress then upload → store the object key ───────
  // Returns the uploaded object key (null on failure) so a geotag caller can attach a
  // per-photo GPS fix and store `{ key, geo }` itself. By default it also stores the bare
  // key string (unchanged behaviour for a non-geotag CAMERA); pass `{ store: false }` to
  // suppress that and take ownership of the stored shape.
  const uploadFile = useCallback(
    async (
      fieldId: string,
      file: File,
      opts?: { store?: boolean },
    ): Promise<string | null> => {
      setUploading((u) => ({ ...u, [fieldId]: true }));
      const optimised = await imageCompression.compress(file);
      const res = await visibilityApi.uploadSalesMedia(optimised, `${fieldId}.jpg`);
      setUploading((u) => ({ ...u, [fieldId]: false }));
      if (res.success) {
        if (opts?.store !== false) setValue(fieldId, res.data.key);
        return res.data.key;
      }
      setSubmitError(res.error);
      return null;
    },
    [setValue],
  );

  // ── GPS capture ───────────────────────────────────────────────────────────
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

    // 0) PARTIAL re-capture (CHANGES_REQUESTED): only the REJECTED CAMERA fields are
    //    re-captured + validated + submitted. Each rejected photo must carry a fresh media
    //    key; the per-photo geotag (captured at shutter time) provides its location, so the
    //    schema-level GPS-on-submit fill is skipped here. Everything else (approved photos,
    //    non-camera fields) is carried forward by the server and NOT in the payload.
    if (partial) {
      const errors: string[] = [];
      const formValues: Record<string, unknown> = {};
      for (const f of fields) {
        if (f.type !== 'CAMERA' || !rejectedIds.has(f.id)) continue;
        const media = readMediaValue(values[f.id]);
        if (!media.key) {
          errors.push(`"${f.label}" must be re-captured.`);
          continue;
        }
        formValues[f.id] = values[f.id];
      }
      if (errors.length > 0) {
        setFieldErrors(errors);
        return;
      }
      setBusy(true);
      try {
        await onSubmit(formValues);
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Submit failed');
      } finally {
        setBusy(false);
      }
      return;
    }

    // 1) capture GPS at submit into every empty GPS field. Two triggers fill a single
    //    fix: a field whose own captureTrigger === 'ON_SUBMIT', and the top-level
    //    schema.captureGpsOnSubmit flag (which fills EVERY empty GPS_POINT field).
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

    // 2) client-side validation (mirrors the backend) — evaluated against the merged map
    //    so a conditional field keyed on an outlet attribute (e.g. a 2nd photo required
    //    for a given sub-program) is enforced live.
    const workingEval = { ...working, ...reservedValues };
    const { errors } = validateVisibilityValues(schema, workingEval);
    if (errors.length > 0) {
      setFieldErrors(errors);
      return;
    }

    // 3) build the payload — drop fields hidden by a `visibleWhen` clause so a stale
    //    value from a now-hidden field is never submitted (mirrors the validator), using
    //    the merged map for the same reason as above.
    const formValues: Record<string, unknown> = {};
    for (const f of fields) {
      if (!isFieldVisible(f, workingEval)) continue;
      const v = working[f.id];
      if (v !== undefined) formValues[f.id] = v;
    }
    // Defensive: never submit a reserved outlet-context key (`__…__`) — they are
    // evaluation-only and the backend re-derives them authoritatively.
    for (const k of Object.keys(formValues)) {
      if (/^__.*__$/.test(k)) delete formValues[k];
    }

    setBusy(true);
    try {
      await onSubmit(formValues);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submit failed');
    } finally {
      setBusy(false);
    }
  }, [values, fields, schema, captureGps, onSubmit, reservedValues, partial, rejectedIds]);

  // Block submit while ANY field is still uploading (L2): an optional CAMERA photo mid-
  // upload would otherwise be silently omitted from formValues by a submit that races it.
  const uploadingAny = Object.values(uploading).some(Boolean);
  const disabled = submitting || busy || uploadingAny;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {partial && (
        <div data-testid="partial-recapture-note" className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
          <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-700">
            Some photos were flagged — re-capture only the photos marked below. Your approved
            photos are kept and don&apos;t need re-shooting.
          </p>
        </div>
      )}

      {fields.map((field) => {
        if (!isFieldVisible(field, evalValues)) return null;

        // PARTIAL mode: show ONLY CAMERA fields. Rejected ones are editable (re-capture);
        // approved/pending ones render read-only as "carried forward"; non-camera fields hide.
        if (partial) {
          if (field.type !== 'CAMERA') return null;
          if (rejectedIds.has(field.id)) {
            const rev = photoReviews?.[field.id];
            return (
              <div key={field.id} className="space-y-1.5">
                <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                  <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-red-700">
                    <span className="font-semibold">Flagged for re-capture</span>
                    {rev?.reasonCode
                      ? ` · ${VISIBILITY_REJECT_REASON_LABELS[rev.reasonCode as VisibilityRejectReasonCode] ?? rev.reasonCode}`
                      : ''}
                    {rev?.reason ? ` — ${rev.reason}` : ''}
                  </p>
                </div>
                <FieldRenderer
                  field={field}
                  values={evalValues}
                  setValue={setValue}
                  uploading={Boolean(uploading[field.id])}
                  uploadFile={uploadFile}
                  captureGps={captureGps}
                />
              </div>
            );
          }
          return <CarriedForwardPhoto key={field.id} field={field} review={photoReviews?.[field.id]} />;
        }

        return (
          <FieldRenderer
            key={field.id}
            field={field}
            values={evalValues}
            setValue={setValue}
            uploading={Boolean(uploading[field.id])}
            uploadFile={uploadFile}
            captureGps={captureGps}
          />
        );
      })}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={disabled}
        className="w-full py-3 rounded-xl text-sm font-bold transition-all
          disabled:opacity-40 disabled:cursor-not-allowed
          bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-dark)]
          active:scale-[0.98] flex items-center justify-center gap-2"
      >
        {submitting || busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Submitting…
          </>
        ) : uploadingAny ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Uploading photo…
          </>
        ) : partial ? (
          'Submit re-capture'
        ) : (
          'Submit capture'
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
  field: VisibilityFormField;
  values: Record<string, unknown>;
  setValue: (id: string, v: unknown) => void;
  uploading: boolean;
  uploadFile: (fieldId: string, file: File, opts?: { store?: boolean }) => Promise<string | null>;
  captureGps: () => Promise<GpsCapture | null>;
}

function FieldRenderer(props: FieldRendererProps) {
  const { field, values, setValue } = props;
  const val = values[field.id];
  const req = isFieldRequired(field, values);

  switch (field.type) {
    case 'CAMERA':
      return <CameraField {...props} req={req} />;

    case 'GPS_POINT':
      return <GpsField {...props} req={req} />;

    case 'NUMBER':
      return (
        <Labeled field={field} req={req}>
          <input
            id={field.id}
            type="number"
            className={inputCls}
            value={String(val ?? '')}
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
            onChange={(e) => setValue(field.id, e.target.value)}
          />
        </Labeled>
      );

    case 'TEXTAREA':
      return (
        <Labeled field={field} req={req}>
          <textarea
            id={field.id}
            rows={3}
            className={inputCls}
            value={String(val ?? '')}
            placeholder={field.placeholder}
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
              aria-label={field.label}
              onChange={(e) => setValue(field.id, e.target.checked)}
            />
            {on ? 'Yes' : 'No'}
          </label>
        </Labeled>
      );
    }

    // ── TEXT (default) ───────────────────────────────────────────────────────
    default:
      return (
        <Labeled field={field} req={req}>
          <input
            id={field.id}
            type="text"
            className={inputCls}
            value={String(val ?? '')}
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
  field: VisibilityFormField;
  req: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={field.id} className={labelCls}>
        {field.label}
        <RequiredStar show={req} />
      </label>
      {children}
      {field.helpText && <p className={helpCls}>{field.helpText}</p>}
    </div>
  );
}

// ── Camera field (native rear-camera, instruction + sample thumbnail, D9/D16) ──

function CameraField({ field, values, setValue, uploading, uploadFile, captureGps, req }: FieldRendererProps & { req: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Read back through readMediaValue so BOTH a legacy bare-key string and a per-photo
  // `{ key, geo }` value resolve to the same shape (full backward-compat).
  const media = readMediaValue(values[field.id]);
  const key = media.key;
  const geo = media.geo;
  // Gallery is suppressed by default for visibility (native camera only); an authoring
  // `noGallery === false` re-enables the gallery fallback.
  const cameraOnly = field.noGallery !== false;
  // Cap-violation message (D2) — a present-but-too-imprecise shutter fix rejects the shot.
  const [capError, setCapError] = useState('');
  // Busy across the WHOLE geotag capture (upload + GPS fix). `uploading` alone flips false the
  // instant the upload finishes, while `captureGps()` can still be pending up to 10s — without
  // this the button re-enables mid-fix (double-capture race) with no "getting location" feedback.
  const [busy, setBusy] = useState(false);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;
    setCapError('');
    if (field.geotag) {
      // Per-photo geotag: fetch a GPS fix AT SHUTTER TIME (the moment the photo is taken),
      // concurrently with the upload. `store: false` — this caller owns the stored shape.
      setBusy(true);
      try {
        const [uploadedKey, fix] = await Promise.all([
          uploadFile(field.id, file, { store: false }),
          captureGps(),
        ]);
        if (!uploadedKey) return; // upload failed — error already surfaced (submitError)
        // D2 accuracy cap: a PRESENT-but-too-imprecise fix rejects the shot. A missing fix
        // (denied / timed out) does NOT block — store `{ key }` and let the backend flag it
        // (geo-fence unverifiable).
        if (
          fix &&
          typeof field.gpsMaxAccuracy === 'number' &&
          typeof fix.accuracy === 'number' &&
          fix.accuracy > field.gpsMaxAccuracy
        ) {
          setCapError(
            `Location too imprecise (±${Math.round(fix.accuracy)}m > ±${field.gpsMaxAccuracy}m) — move to open sky and re-capture.`,
          );
          return; // photo NOT stored → field stays uncaptured, the rep can re-capture
        }
        setValue(field.id, fix ? { key: uploadedKey, geo: fix } : { key: uploadedKey });
      } finally {
        setBusy(false);
      }
    } else {
      // Non-geotag CAMERA: unchanged — uploadFile stores the bare key string.
      await uploadFile(field.id, file);
    }
  };

  return (
    <Labeled field={field} req={req}>
      {field.instruction && (
        <p data-testid={`camera-instruction-${field.id}`} className="text-xs text-gray-600 mb-1.5">
          {field.instruction}
        </p>
      )}
      {field.sampleImageKey && (
        <img
          data-testid={`camera-sample-${field.id}`}
          src={mediaViewUrl(field.sampleImageKey)}
          alt={`${field.label} — sample`}
          className="mb-2 h-24 w-auto rounded-lg border border-gray-200 object-cover"
        />
      )}
      {key ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2 px-3 py-2.5 bg-green-50 border border-green-200 rounded-xl">
            <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
            <span className="text-xs text-green-700 font-medium truncate">Photo captured</span>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="ml-auto text-[10px] text-green-600 underline"
            >
              Retake
            </button>
          </div>
          {geo ? (
            // Neutral tone — a captured fix is NOT "inside the fence" (the client can't know the
            // verdict); avoid a green ✓ that reads as approval.
            <p className="flex items-center gap-1 text-xs text-gray-500 font-medium">
              <MapPin className="h-3 w-3 shrink-0" />
              location captured{geo.accuracy != null ? ` · ±${Math.round(geo.accuracy)}m` : ''}
            </p>
          ) : field.geotag ? (
            // Geotag requested but no fix obtained — tell the rep, since a fence-required photo
            // with no location gets flagged for review.
            <p className="flex items-center gap-1 text-xs text-amber-600 font-medium">
              <AlertCircle className="h-3 w-3 shrink-0" />
              saved without location — Retake to add it
            </p>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading || busy}
          className="w-full flex items-center justify-center gap-2 py-2.5 border-2 border-dashed border-gray-200 rounded-xl text-sm text-gray-500 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] disabled:opacity-50 transition-colors"
        >
          {uploading || busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
          {busy ? 'Getting location…' : uploading ? 'Uploading…' : 'Capture photo'}
        </button>
      )}
      {capError && (
        <p className="text-xs text-red-600 flex items-start gap-1.5 mt-1.5 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
          <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
          {capError}
        </p>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        // `capture` on a file input opens the rear camera directly on field phones (D14).
        {...(cameraOnly ? { capture: 'environment' as const } : {})}
        className="hidden"
        aria-label={field.label}
        onChange={onFile}
      />
    </Labeled>
  );
}

// ── Carried-forward photo (partial re-capture, read-only) ──────────────────────

/**
 * A CAMERA field that was APPROVED (or left pending) in the prior review and is carried
 * forward by the server on a partial re-capture — shown read-only so the rep sees it is
 * kept and must NOT re-shoot it. We render a status chip rather than the stored image,
 * because sales-side read-back of another capture's media is not guaranteed.
 */
function CarriedForwardPhoto({
  field, review,
}: {
  field: VisibilityFormField;
  review?: VisibilityPhotoReview;
}) {
  const approved = review?.status === 'APPROVED';
  return (
    <div data-testid={`carried-forward-${field.id}`}>
      <label className={labelCls}>{field.label}</label>
      <div className="flex items-center gap-2 px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl">
        <CheckCircle className={`h-3.5 w-3.5 shrink-0 ${approved ? 'text-green-500' : 'text-gray-400'}`} />
        <span className="text-xs text-gray-600 font-medium">
          {approved ? 'Approved — kept from your last submission' : 'Kept from your last submission'}
        </span>
      </div>
    </div>
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

export default VisibilityCaptureForm;
