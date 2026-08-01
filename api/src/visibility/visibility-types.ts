/**
 * visibility-types.ts — shared, dependency-free TS types for the Visibility (POSM)
 * feature. This is the single source of truth for the capture-form shape and the
 * per-tenant configuration shape; both Stream A (authoring) and Stream B
 * (capture/review/report/sales) import from here, and `visibility-form.helper.ts`
 * re-exports the form types alongside its validators.
 *
 * PURE: no NestJS / Prisma imports, so it is safe to import anywhere (services,
 * controllers, DTOs, specs) without standing up the DI container.
 *
 * Design: docs/plans/VISIBILITY-POSM-DESIGN.md §1 (D9/D16), §2.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Capture-form field model (cloned + trimmed from the Scheme form engine)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Visibility capture-form field types. This is a deliberately TRIMMED set of
 * the Scheme form-builder types — visibility captures photos + geo + a few simple
 * classification fields; it has NO reward/calculation/consent-OTP/lookup surface.
 *
 *   TEXT / TEXTAREA — free text (single- / multi-line)
 *   NUMBER          — numeric value
 *   DATE            — ISO date
 *   DROPDOWN        — single choice from `options`
 *   MULTI_SELECT    — many choices from `options`
 *   TOGGLE          — yes/no
 *   CAMERA          — native-camera photo (value = a stored GCS object key) — D9
 *   GPS_POINT       — a captured geo fix (value = a JSON blob)
 */
export const FORM_FIELD_TYPES = [
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'DATE',
  'DROPDOWN',
  'MULTI_SELECT',
  'TOGGLE',
  'CAMERA',
  'GPS_POINT',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** GPS capture trigger — when the location fix is taken. */
export const GPS_CAPTURE_TRIGGERS = ['ON_SUBMIT', 'ON_PHOTO', 'MANUAL'] as const;
export type GpsCaptureTrigger = (typeof GPS_CAPTURE_TRIGGERS)[number];

/** Field types whose stored value is a GCS object key (media). Visibility = CAMERA only. */
export const MEDIA_FIELD_TYPES: ReadonlySet<string> = new Set(['CAMERA']);

export const VISIBLE_WHEN_OPS = ['eq', 'neq', 'gt', 'lt', 'contains'] as const;
export type VisibleWhenOp = (typeof VISIBLE_WHEN_OPS)[number];

/** A single conditional clause: `submittedValues[fieldId] <op> value`. */
export interface VisibleWhen {
  fieldId: string;
  op: VisibleWhenOp;
  value: string;
}

export interface FormField {
  id: string;
  type: FormFieldType;
  label: string;
  required: boolean;
  placeholder?: string;
  helpText?: string;
  options?: string[];
  order: number;
  /** Show this field only while the clause evaluates true. */
  visibleWhen?: VisibleWhen;
  /** Make this field required only while the clause evaluates true (conditional-required). */
  requiredWhen?: VisibleWhen;
  /** GPS_POINT: when the location fix is captured. */
  captureTrigger?: GpsCaptureTrigger;
  /**
   * Reject a fix whose reported accuracy (metres) exceeds this cap (D2/D15); unset = no
   * cap. Applies to a GPS_POINT value AND to a CAMERA photo's embedded per-photo geo.
   */
  gpsMaxAccuracy?: number;
  /** CAMERA: suppress the gallery fallback — native camera capture only (D14). */
  noGallery?: boolean;
  /** CAMERA: capture a GPS fix at this photo's shutter time, embedded in the media value (per-photo geotag). */
  geotag?: boolean;
  /** CAMERA (visibility geo-fenced forms): this photo must be inside the geo-fence. Every fence-required photo with a fix must be inside; a fence-required photo with no fix → GEO_UNVERIFIABLE (flag, not a hard-fail). */
  geoFenceRequired?: boolean;

  // ── CAMERA extensions (D9 / D16) ───────────────────────────────────────────
  /** CAMERA: what/how to shoot — shown to the rep at capture time (D9). */
  instruction?: string;
  /** CAMERA: a GCS key for a reference / sample image the rep can compare against (D16). */
  sampleImageKey?: string;
}

/**
 * The stored Visibility capture-form schema. `captureGpsOnSubmit` requires a
 * GPS_POINT field to store the fix into (enforced by validateFormSchema).
 */
export interface VisibilityFormSchema {
  captureGpsOnSubmit: boolean;
  fields: FormField[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Media value shape + per-photo geotag (per-photo-geotag, Stream 1 — shared contract)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A captured GPS fix. Mirrors the scheme/FE `GpsCapture` shape (kept byte-identical in
 * meaning). Defined locally — visibility does not depend on the scheme feature.
 */
export interface GpsCapture {
  lat: number;
  lng: number;
  accuracy?: number;
  capturedAt?: string;
}

/**
 * A stored media-field value: the legacy bare object-key string, OR a `{ key, geo? }`
 * object carrying that photo's own shutter-time GPS fix (per-photo geotag). Both shapes
 * are accepted everywhere for full backward-compat.
 */
export type MediaValue = string | { key: string; geo?: GpsCapture };

/**
 * Normalize a stored media-field value (bare key string OR `{key, geo}`) to a uniform
 * shape. Backward-compatible: a bare string yields `{ key, geo: undefined }`. Returns
 * `{ key: '' }` for empty/invalid input. A malformed `geo` is dropped (→ undefined)
 * rather than throwing.
 */
export function readMediaValue(v: unknown): { key: string; geo?: GpsCapture } {
  if (typeof v === 'string') return { key: v };
  if (v && typeof v === 'object' && typeof (v as { key?: unknown }).key === 'string') {
    return { key: (v as { key: string }).key, geo: normalizeGeo((v as { geo?: unknown }).geo) };
  }
  return { key: '' };
}

/** Loose geo validation: an object with numeric lat/lng → a GpsCapture; else undefined. */
function normalizeGeo(g: unknown): GpsCapture | undefined {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return undefined;
  const o = g as Record<string, unknown>;
  if (typeof o.lat !== 'number' || typeof o.lng !== 'number') return undefined;
  return o as unknown as GpsCapture;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-tenant Visibility configuration (settings-backed; mirrors
// TenantSettingsService.VisibilityConfigSettings so Stream B has a local type)
// ─────────────────────────────────────────────────────────────────────────────

/** Geo-fence policy on capture (D10). */
export interface VisibilityGeoFence {
  enabled: boolean;
  radiusMeters: number;
}

/** Visibility (POSM) per-tenant capture configuration (D5/D6/D8/D10). */
export interface VisibilityConfig {
  /** Outlet scope = OutletType.code list (e.g. ["SSS","SSS_TOT"]); empty = none in scope yet. */
  outletScope: string[];
  /** Captures required per calendar month → windows. Integer 1..4. */
  frequencyPerMonth: number;
  /** SalesHierarchyLevel.code values that may capture (e.g. ["XSR","SO","ASM"]); empty = none. */
  allowedSalesLevels: string[];
  /** Geo-fence policy on capture (D10). */
  geoFence: VisibilityGeoFence;
}
