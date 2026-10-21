/**
 * visibility-form.helper.ts — pure form-schema field engine for the Visibility
 * (POSM) capture form. Cloned + adapted from the Scheme enrollment-form engine
 * (api/src/schemes/enrollment-form.helper.ts) and trimmed to what visibility needs
 * (photos + geo + simple classification; NO reward/calculation/lookup/consent).
 *
 * PURE: no NestJS / Prisma imports — directly unit-testable.
 *
 * Exports:
 *   - Field-type / clause types re-exported from visibility-types (single source).
 *   - validateFormSchema(schema)          — structural validator for the stored form.
 *   - validateSubmittedValues(schema, v)  — submit-time validation; returns the
 *                                           projected/validated values (hidden fields
 *                                           dropped, unknown keys dropped).
 *   - evaluateVisibleWhen / isFieldRequired / evaluateClause.
 *   - MEDIA_FIELD_TYPES.
 *
 * Design: docs/plans/VISIBILITY-POSM-DESIGN.md §1 (D9/D16), §4.
 */

import {
  FORM_FIELD_TYPES,
  FormFieldType,
  GPS_CAPTURE_TRIGGERS,
  VISIBLE_WHEN_OPS,
  VisibleWhen,
  FormField,
  VisibilityFormSchema,
  MEDIA_FIELD_TYPES,
  readMediaValue,
  OUTLET_CONTEXT_FIELD_IDS,
  PhotoReviews,
  DerivedCaptureStatus,
} from './visibility-types';

// Re-export the shared types + constants so consumers can import everything the
// form engine touches from one module (mirrors the Scheme helper's surface).
export {
  FORM_FIELD_TYPES,
  GPS_CAPTURE_TRIGGERS,
  VISIBLE_WHEN_OPS,
  MEDIA_FIELD_TYPES,
  readMediaValue,
  OUTLET_CONTEXT_FIELD_IDS,
};
export type { FormFieldType, VisibleWhen, FormField, VisibilityFormSchema };
export type {
  MediaValue,
  GpsCapture,
  OutletContextFieldId,
  PhotoReview,
  PhotoReviewStatus,
  PhotoReviews,
  DerivedCaptureStatus,
} from './visibility-types';
export { outletContextValues, readPhotoReviews } from './visibility-types';

// ─────────────────────────────────────────────────────────────────────────────
// Structural type guards
// ─────────────────────────────────────────────────────────────────────────────

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}
function isNumber(v: unknown): v is number {
  return typeof v === 'number';
}
function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// validateFormSchema — structural integrity of a stored VisibilityFormSchema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the structural integrity of a VisibilityForm.formSchema.
 *
 * Returns an array of human-readable error strings; an empty array means valid.
 *
 * Rules:
 *   Top-level:
 *     - captureGpsOnSubmit must be a boolean
 *     - fields must be a non-empty array
 *     - the form must contain AT LEAST ONE CAMERA field (visibility = photo proof)
 *     - captureGpsOnSubmit ⇒ the form must contain a GPS_POINT field
 *   Per field:
 *     - id:      non-empty string, unique across the form
 *     - type:    one of FORM_FIELD_TYPES
 *     - label:   non-empty string
 *     - required: boolean
 *     - order:   number
 *     - options (DROPDOWN / MULTI_SELECT): >= 1 string entry
 *     - captureTrigger (optional): one of GPS_CAPTURE_TRIGGERS
 *     - noGallery (optional): boolean
 *     - instruction (optional, CAMERA): string
 *     - sampleImageKey (optional, CAMERA): string
 *     - visibleWhen / requiredWhen (optional): {fieldId (resolves, not self), op, value}
 */
export function validateFormSchema(rawSchema: unknown): string[] {
  const errors: string[] = [];

  if (!isObject(rawSchema)) {
    return ['formSchema must be a JSON object.'];
  }

  if (!isBoolean(rawSchema.captureGpsOnSubmit)) {
    errors.push('formSchema.captureGpsOnSubmit must be a boolean.');
  }

  if (!Array.isArray(rawSchema.fields)) {
    errors.push('formSchema.fields must be an array.');
    return errors;
  }

  const fields = rawSchema.fields as unknown[];
  if (fields.length === 0) {
    errors.push('The visibility form must have at least one field.');
    return errors;
  }

  // Pass 1 — per-field structure + id collection.
  const fieldIds = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const pos = `Field ${i + 1}`;

    if (!isObject(f)) {
      errors.push(`${pos}: must be a JSON object.`);
      continue;
    }

    if (!isString(f.id) || f.id.trim() === '') {
      errors.push(`${pos}: id must be a non-empty string.`);
    } else if (/^__.*__$/.test(f.id)) {
      // A real field may NOT use a `__…__` id. These are reserved for server-injected
      // outlet-context values (e.g. `__subProgram__`) and are stripped from client payloads,
      // so a `__…__` form field would be silently dropped / shadow the authoritative value.
      // Forbidding the whole pattern (not just the current reserved set) keeps the payload
      // strip provably safe for any future context id.
      errors.push(`${pos}: id "${f.id}" is reserved (ids wrapped in double underscores cannot be a form field id).`);
    } else if (fieldIds.has(f.id)) {
      errors.push(`${pos}: duplicate field id "${f.id}".`);
    } else {
      fieldIds.add(f.id);
    }

    if (!isString(f.type) || !(FORM_FIELD_TYPES as readonly string[]).includes(f.type)) {
      errors.push(`${pos}: type must be one of: ${FORM_FIELD_TYPES.join(', ')}.`);
    }

    if (!isString(f.label) || f.label.trim() === '') {
      errors.push(`${pos}: label cannot be empty.`);
    }

    if (!isBoolean(f.required)) {
      errors.push(`${pos}: required must be a boolean.`);
    }

    if (!isNumber(f.order)) {
      errors.push(`${pos}: order must be a number.`);
    }

    // options — required for the choice field types.
    if (f.type === 'DROPDOWN' || f.type === 'MULTI_SELECT') {
      if (!Array.isArray(f.options) || f.options.length === 0) {
        const lbl = isString(f.label) && f.label.trim() ? f.label : String(f.type);
        errors.push(`${pos} ("${lbl}"): ${f.type} must have at least one option.`);
      } else if ((f.options as unknown[]).some((o) => !isString(o))) {
        errors.push(`${pos}: all options must be strings.`);
      }
    }

    if (f.captureTrigger !== undefined) {
      if (
        !isString(f.captureTrigger) ||
        !(GPS_CAPTURE_TRIGGERS as readonly string[]).includes(f.captureTrigger)
      ) {
        errors.push(`${pos}: captureTrigger must be one of: ${GPS_CAPTURE_TRIGGERS.join(', ')}.`);
      }
    }

    if (f.noGallery !== undefined && !isBoolean(f.noGallery)) {
      errors.push(`${pos}: noGallery must be a boolean.`);
    }

    // geotag / geoFenceRequired (optional) — per-photo geotag flags. geoFenceRequired
    // is only meaningful on a CAMERA field (a fence check needs a photo to bind to).
    if (f.geotag !== undefined && !isBoolean(f.geotag)) {
      errors.push(`${pos}: geotag must be a boolean.`);
    }
    if (f.geoFenceRequired !== undefined) {
      if (!isBoolean(f.geoFenceRequired)) {
        errors.push(`${pos}: geoFenceRequired must be a boolean.`);
      }
      if (f.type !== 'CAMERA') {
        errors.push(`${pos}: geoFenceRequired is only valid on a CAMERA field.`);
      }
    }

    // CAMERA per-field authoring extensions (D9 / D16) — strings when present.
    if (f.instruction !== undefined && !isString(f.instruction)) {
      errors.push(`${pos}: instruction must be a string.`);
    }
    if (f.sampleImageKey !== undefined && !isString(f.sampleImageKey)) {
      errors.push(`${pos}: sampleImageKey must be a string.`);
    }
  }

  // Pass 2 — cross-field clause reference checks.
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!isObject(f)) continue;
    const pos = `Field ${i + 1}`;
    const label =
      isString(f.label) && (f.label as string).trim()
        ? (f.label as string).trim()
        : isString(f.type)
          ? (f.type as string)
          : `${i + 1}`;

    for (const clauseKey of ['visibleWhen', 'requiredWhen'] as const) {
      const clause = f[clauseKey];
      if (clause === undefined) continue;
      if (!isObject(clause)) {
        errors.push(`${pos}: ${clauseKey} must be an object.`);
        continue;
      }
      if (!isString(clause.fieldId) || clause.fieldId.trim() === '') {
        errors.push(`${pos}: ${clauseKey}.fieldId must be a non-empty string.`);
      } else if (isString(f.id) && clause.fieldId === f.id) {
        errors.push(`${pos} ("${label}"): ${clauseKey} cannot depend on itself.`);
      } else if (
        !fieldIds.has(clause.fieldId as string) &&
        !(OUTLET_CONTEXT_FIELD_IDS as readonly string[]).includes(clause.fieldId as string)
      ) {
        // A clause may key on another FORM field OR a reserved outlet-attribute id
        // (e.g. `__subProgram__`) that the capture service injects server-side.
        errors.push(
          `${pos} ("${label}"): ${clauseKey} references unknown field id "${clause.fieldId}".`,
        );
      }
      if (!isString(clause.op) || !(VISIBLE_WHEN_OPS as readonly string[]).includes(clause.op as string)) {
        errors.push(`${pos}: ${clauseKey}.op must be one of: ${VISIBLE_WHEN_OPS.join(', ')}.`);
      }
      if (!isString(clause.value)) {
        errors.push(`${pos}: ${clauseKey}.value must be a string.`);
      }
    }
  }

  // At least one CAMERA field — visibility is proof-of-POSM via photo.
  const hasCamera = fields.some((f) => isObject(f) && f.type === 'CAMERA');
  if (!hasCamera) {
    errors.push('The visibility form must have at least one CAMERA (photo) field.');
  }

  // GPS coherence: a submit-time GPS capture needs a GPS_POINT field to store into.
  if (rawSchema.captureGpsOnSubmit === true) {
    const hasGps = fields.some((f) => isObject(f) && f.type === 'GPS_POINT');
    if (!hasGps) {
      errors.push(
        'formSchema.captureGpsOnSubmit is true but the form has no GPS_POINT field to store the fix.',
      );
    }
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Submission-time helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Evaluate a single `{fieldId, op, value}` clause against the submitted values. */
export function evaluateClause(
  clause: VisibleWhen,
  submittedValues: Record<string, unknown>,
): boolean {
  const { fieldId, op, value: condValue } = clause;
  const raw = submittedValues[fieldId];
  const rawStr = raw !== null && raw !== undefined ? String(raw) : '';

  switch (op) {
    case 'eq':
      return rawStr === condValue;
    case 'neq':
      return rawStr !== condValue;
    case 'gt': {
      const n = Number(rawStr);
      const cv = Number(condValue);
      return !isNaN(n) && !isNaN(cv) && n > cv;
    }
    case 'lt': {
      const n = Number(rawStr);
      const cv = Number(condValue);
      return !isNaN(n) && !isNaN(cv) && n < cv;
    }
    case 'contains':
      return rawStr.includes(condValue);
    default:
      return false;
  }
}

/** Whether a field is visible under the current submitted values. */
export function evaluateVisibleWhen(
  field: FormField,
  submittedValues: Record<string, unknown>,
): boolean {
  if (!field.visibleWhen) return true;
  return evaluateClause(field.visibleWhen, submittedValues);
}

/**
 * Whether a (visible) field must have a value: a `required:true` field is always
 * required; a `requiredWhen` field is required only while its clause is true.
 */
export function isFieldRequired(
  field: FormField,
  submittedValues: Record<string, unknown>,
): boolean {
  if (field.required) return true;
  if (field.requiredWhen) return evaluateClause(field.requiredWhen, submittedValues);
  return false;
}

/**
 * Parse a GPS_POINT value (an object, or a JSON string) to a `{lat,lng}` fix whose
 * coordinates are finite AND within valid Earth ranges (lat −90..90, lng −180..180).
 * Returns null for anything unparseable/out-of-range — the single source of truth for
 * "is this a usable geo fix" shared by submit-time validation and the geo-fence extractor.
 */
export function parseGpsPoint(raw: unknown): { lat: number; lng: number } | null {
  let val: unknown = raw;
  if (typeof val === 'string') {
    try {
      val = JSON.parse(val);
    } catch {
      return null;
    }
  }
  if (!val || typeof val !== 'object' || Array.isArray(val)) return null;
  const g = val as Record<string, unknown>;
  const lat = typeof g.lat === 'number' ? g.lat : typeof g.lat === 'string' ? parseFloat(g.lat) : NaN;
  const lng = typeof g.lng === 'number' ? g.lng : typeof g.lng === 'string' ? parseFloat(g.lng) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** MULTI_SELECT-aware "empty" (false is a real TOGGLE answer, handled by the caller). */
function isBlank(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    (typeof v === 'string' && v.trim() === '') ||
    (Array.isArray(v) && v.length === 0)
  );
}

const TRUE_TOKENS = new Set(['true', '1', 'yes', 'on']);
const FALSE_TOKENS = new Set(['false', '0', 'no', 'off']);

/** Submission-time validation result. */
export interface SubmissionValidationResult {
  /** Human-readable per-field validation messages; empty = valid. */
  errors: string[];
  /**
   * The validated values PROJECTED to only the schema's field ids AND only the
   * fields visible under the submitted values. Hidden fields and unknown client
   * keys are dropped, so a conditionally-hidden field's stale value is never
   * persisted. Callers persist this object as-is.
   */
  values: Record<string, unknown>;
}

/**
 * Validate submitted form values against the stored schema and return the projected
 * values (hidden + unknown keys dropped).
 *
 * Rules:
 *   1. Visible required fields must have a non-empty value.
 *   2. `visibleWhen`-hidden fields are neither validated nor required, and are dropped.
 *   3. Type coercion checks (NUMBER / DATE / DROPDOWN / MULTI_SELECT / TOGGLE).
 *   4. TEXT / TEXTAREA / CAMERA / GPS_POINT accept any non-empty value (media = an
 *      object key; geo = a JSON blob).
 */
export function validateSubmittedValues(
  schema: VisibilityFormSchema,
  submitted: Record<string, unknown> | null | undefined,
): SubmissionValidationResult {
  const errors: string[] = [];
  const projected: Record<string, unknown> = {};
  const values: Record<string, unknown> = submitted ?? {};

  for (const field of schema.fields ?? []) {
    // Hidden fields — never validated, never persisted.
    if (!evaluateVisibleWhen(field, values)) continue;

    const rawValue = values[field.id];
    const empty =
      field.type === 'TOGGLE'
        ? rawValue === null || rawValue === undefined
        : isBlank(rawValue);

    if (isFieldRequired(field, values) && empty) {
      errors.push(`Field "${field.label}" (${field.id}) is required.`);
      continue;
    }

    if (empty) continue;

    switch (field.type) {
      case 'NUMBER': {
        const n = Number(String(rawValue));
        if (!isFinite(n) || isNaN(n)) {
          errors.push(`Field "${field.label}" (${field.id}) must be a valid number.`);
          continue;
        }
        break;
      }
      case 'DATE': {
        const d = new Date(String(rawValue));
        if (isNaN(d.getTime())) {
          errors.push(`Field "${field.label}" (${field.id}) must be a valid date.`);
          continue;
        }
        break;
      }
      case 'TOGGLE': {
        const ok =
          typeof rawValue === 'boolean' ||
          TRUE_TOKENS.has(String(rawValue).toLowerCase()) ||
          FALSE_TOKENS.has(String(rawValue).toLowerCase());
        if (!ok) {
          errors.push(`Field "${field.label}" (${field.id}) must be yes/no.`);
          continue;
        }
        break;
      }
      case 'DROPDOWN': {
        if (Array.isArray(field.options) && field.options.length > 0) {
          if (!field.options.map(String).includes(String(rawValue))) {
            errors.push(`Field "${field.label}" (${field.id}) has an invalid selection.`);
            continue;
          }
        }
        break;
      }
      case 'MULTI_SELECT': {
        const arr = Array.isArray(rawValue)
          ? rawValue.map(String)
          : String(rawValue)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
        const allowed = new Set((field.options ?? []).map(String));
        const bad = arr.find((v) => !allowed.has(v));
        if (bad !== undefined) {
          errors.push(`Field "${field.label}" (${field.id}) contains an invalid option "${bad}".`);
          continue;
        }
        break;
      }
      case 'GPS_POINT': {
        // A present GPS fix MUST parse to numeric lat/lng in valid ranges — garbage/no
        // GPS is a 400, never a silently-empty geo (H1). A required-but-missing GPS field
        // is already caught by the `empty` check above.
        if (parseGpsPoint(rawValue) === null) {
          errors.push(`Field "${field.label}" (${field.id}) must be a valid GPS location (lat/lng).`);
          continue;
        }
        break;
      }
      case 'CAMERA': {
        // A CAMERA value is a bare object-key string OR a `{ key, geo? }` object carrying
        // that photo's shutter-time GPS fix (per-photo geotag). A bare string stays valid
        // (full back-compat). When a geo IS embedded, validate its shape/Earth-range via
        // parseGpsPoint + the per-field accuracy cap (D2). A photo with no geo stays valid.
        const media = readMediaValue(rawValue);
        if (!media.key) {
          errors.push(`Field "${field.label}" (${field.id}) has an invalid media reference.`);
          continue;
        }
        const rawGeo =
          rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
            ? (rawValue as { geo?: unknown }).geo
            : undefined;
        if (rawGeo !== undefined && rawGeo !== null) {
          const point = media.geo ? parseGpsPoint(media.geo) : null;
          if (!point) {
            errors.push(
              `Field "${field.label}" (${field.id}) has a malformed or out-of-range photo location.`,
            );
            continue;
          }
          if (typeof field.gpsMaxAccuracy === 'number' && field.gpsMaxAccuracy > 0) {
            const acc = Number(media.geo?.accuracy);
            if (isFinite(acc) && acc > field.gpsMaxAccuracy) {
              errors.push(
                `Field "${field.label}" (${field.id}) location accuracy (±${acc}m) exceeds the ${field.gpsMaxAccuracy}m limit — move to open sky and recapture.`,
              );
              continue;
            }
          }
        }
        break;
      }
      // TEXT, TEXTAREA — any non-empty value accepted.
      default:
        break;
    }

    // The field is visible and valid → keep it in the projected values.
    projected[field.id] = rawValue;
  }

  return { errors, values: projected };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-photo review — CAMERA-field sets + server-authoritative derived status
// (VISIBILITY-PER-PHOTO-APPROVAL)
// ─────────────────────────────────────────────────────────────────────────────

/** True when a stored media value carries a non-empty object key (a photo is present). */
function hasPhoto(v: unknown): boolean {
  return readMediaValue(v).key.length > 0;
}

/**
 * The CAMERA fields of the form that currently hold a submitted photo, visible under the
 * given (merged) values. Used by the whole-capture approve-ALL / reject-ALL: every photo
 * actually present gets a review written, so "approve/reject everything" is literal.
 */
export function presentCameraFieldIds(
  schema: VisibilityFormSchema | null | undefined,
  mergedValues: Record<string, unknown>,
): string[] {
  if (!schema) return [];
  return (schema.fields ?? [])
    .filter((f) => f.type === 'CAMERA')
    .filter((f) => evaluateVisibleWhen(f, mergedValues))
    .filter((f) => hasPhoto(mergedValues[f.id]))
    .map((f) => f.id);
}

/**
 * The REQUIRED, visible CAMERA fields for this capture — the photos that MUST be present
 * (mirrors submit-time `isFieldRequired`, including a `requiredWhen` that keys on an outlet
 * attribute, so `mergedValues` must already carry the server outlet context). This is the
 * gating set: the window is satisfied only when every one of these is APPROVED.
 */
export function requiredCameraFieldIds(
  schema: VisibilityFormSchema | null | undefined,
  mergedValues: Record<string, unknown>,
): string[] {
  if (!schema) return [];
  return (schema.fields ?? [])
    .filter((f) => f.type === 'CAMERA')
    .filter((f) => evaluateVisibleWhen(f, mergedValues))
    .filter((f) => isFieldRequired(f, mergedValues))
    .map((f) => f.id);
}

/**
 * The gating CAMERA field set used to DERIVE the whole-capture status: the required,
 * visible photos. When a form declares no required CAMERA field (all-optional — rare),
 * fall back to the present photos so per-photo review still functions and a capture can
 * still reach APPROVED. `mergedValues` must carry the server outlet context (for
 * `requiredWhen`). Pure.
 */
export function gatingCameraFieldIds(
  schema: VisibilityFormSchema | null | undefined,
  mergedValues: Record<string, unknown>,
): string[] {
  const required = requiredCameraFieldIds(schema, mergedValues);
  if (required.length > 0) return required;
  return presentCameraFieldIds(schema, mergedValues);
}

/**
 * The SINGLE server-authoritative rule for the derived whole-capture status, over the
 * gating CAMERA fields:
 *   - any gating photo REJECTED            → CHANGES_REQUESTED (window NOT satisfied)
 *   - gating non-empty AND all APPROVED    → APPROVED (satisfies the window, D7)
 *   - else (some pending, none rejected)   → SUBMITTED
 * An empty gating set can never derive APPROVED (a capture with nothing to prove stays
 * SUBMITTED until an explicit approve-ALL).
 */
export function deriveCaptureStatus(
  gatingFieldIds: string[],
  reviews: PhotoReviews,
): DerivedCaptureStatus {
  // ANY explicitly REJECTED photo — required OR optional — forces CHANGES_REQUESTED. A reviewer's
  // rejection must never be silently retained inside a window-satisfying (APPROVED) capture, so the
  // rejection check scans ALL reviews, not just the gating set (otherwise a rejected OPTIONAL photo
  // would be ignored and the capture could finalise APPROVED with it still rejected).
  for (const r of Object.values(reviews)) {
    if (r?.status === 'REJECTED') return 'CHANGES_REQUESTED';
  }
  // APPROVED only when every gating (required + visible) photo is APPROVED.
  let allApproved = gatingFieldIds.length > 0;
  for (const id of gatingFieldIds) {
    const r = reviews[id];
    if (!r || r.status !== 'APPROVED') allApproved = false;
  }
  return allApproved ? 'APPROVED' : 'SUBMITTED';
}
