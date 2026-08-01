/**
 * enrollment-form.helper.ts — P4.2 / P4.3
 *
 * Pure, unit-testable helpers for enrollment-form validation and submission.
 *
 * P4.2: validateFormSchema — structural validator for the stored form schema.
 * P4.3: evaluateVisibleWhen, recomputeCalculated, validateSubmittedValues —
 *   submission-time value validation (required-field presence, type checks,
 *   visibleWhen-hidden field skipping, CALCULATED server-side recompute).
 *
 * No DB calls, no imports from NestJS internals — safe to import in spec files
 * without standing up the full module graph.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types (mirrored from campaign.ts; kept local so the backend owns its shape)
// ─────────────────────────────────────────────────────────────────────────────

export const CAMPAIGN_TYPES = ['LOYALTY_ONLY', 'OPEN_CAMPAIGN', 'MIXED'] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

export const FORM_FIELD_TYPES = [
  'TEXT',
  'NUMBER',
  'DROPDOWN',
  'DATE',
  'DOCUMENT',
  'IMAGE',
  'CAMERA',
  'GPS_POINT',
  'UPI_QR_SCAN',
  'DATA_DISPLAY',
  'CALCULATED',
  // ── Wave-0 scheme data-collection net-new field types (D12 / §13.1) ──────────
  'EMAIL',
  'MULTI_SELECT',
  'TOGGLE',
  'PHONE_OTP',
  'LOOKUP',
  'SECTION',
  'SIGNATURE',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** GPS capture trigger (D15). */
export const GPS_CAPTURE_TRIGGERS = ['ON_SUBMIT', 'ON_PHOTO', 'MANUAL'] as const;
export type GpsCaptureTrigger = (typeof GPS_CAPTURE_TRIGGERS)[number];

/**
 * Field types that are pure display / structural — never carry a captured value,
 * never required, never validated. SECTION is the Wave-0 addition (D12).
 */
const DISPLAY_ONLY_TYPES: ReadonlySet<string> = new Set(['DATA_DISPLAY', 'SECTION']);

/** Field types whose value is a stored GCS object key (media). */
export const MEDIA_FIELD_TYPES: ReadonlySet<string> = new Set([
  'DOCUMENT',
  'IMAGE',
  'CAMERA',
  'UPI_QR_SCAN',
  'SIGNATURE',
]);

/**
 * Curated Outlet-master fields a form field can prefill FROM (dual-source prefill).
 * For a MATCHED loyalty roster row these auto-fill from the outlet's existing DB
 * record (owner fields from its ChannelPartner, outlet-native fields from Outlet);
 * a standalone row has none. Keys are the stable contract shared by the FE builder
 * dropdown, the backend resolver (scheme-enrollment.service), and this validator.
 */
export const OUTLET_FIELD_CATALOG = [
  { key: 'businessName', label: 'Business name' },
  { key: 'ownerName', label: 'Owner name' },
  { key: 'phone', label: 'Owner / outlet phone' },
  { key: 'outletCode', label: 'Outlet code' },
  { key: 'outletName', label: 'Outlet name' },
  { key: 'addressLine1', label: 'Address line 1' },
  { key: 'addressLine2', label: 'Address line 2' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'pincode', label: 'Pincode' },
  { key: 'zone', label: 'Zone' },
  { key: 'programName', label: 'Program' },
  { key: 'programCategory', label: 'Program category' },
  { key: 'panNumber', label: 'PAN' },
  { key: 'gstNumber', label: 'GST' },
] as const;
export type OutletFieldKey = (typeof OUTLET_FIELD_CATALOG)[number]['key'];
export const OUTLET_FIELD_KEYS: ReadonlySet<string> = new Set(
  OUTLET_FIELD_CATALOG.map((f) => f.key),
);

export const VISIBLE_WHEN_OPS = ['eq', 'neq', 'gt', 'lt', 'contains'] as const;
export type VisibleWhenOp = (typeof VISIBLE_WHEN_OPS)[number];

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
  dataDisplayKey?: string;
  /** Required when type === 'CALCULATED'. */
  formula?: string;
  visibleWhen?: VisibleWhen;
  order: number;

  // ── Wave-0 scheme data-collection additions (§13.1) ────────────────────────
  /**
   * Conditional-required (D12b). Same clause shape as `visibleWhen`; when present
   * the field becomes required only while the clause evaluates true (and the field
   * is itself visible). A `required: true` field is always required when visible,
   * regardless of `requiredWhen`.
   */
  requiredWhen?: VisibleWhen;
  /** Per-field prefill lock (D13a): a prefilled value the filler cannot edit. */
  locked?: boolean;
  /** Excel variable column this field prefills from (D13 / Mode B). */
  prefillKey?: string;
  /**
   * Outlet-master field this field prefills from for a MATCHED loyalty outlet
   * (dual-source prefill). One of OUTLET_FIELD_KEYS. Resolution at enroll: an
   * `outletField` on a matched row wins (DB value); else `prefillKey` (Excel column);
   * a standalone row has no outlet value → falls back to `prefillKey`.
   */
  outletField?: string;
  /** LOOKUP: the field whose selected option value is mapped through `lookupMap`. */
  lookupSourceFieldId?: string;
  /** LOOKUP: option value → shown/derived value map (D12a). */
  lookupMap?: Record<string, string>;
  /** PHONE_OTP: require a verified consent OTP before submit (D16). */
  otpRequired?: boolean;
  /** GPS_POINT: when the location fix is captured (D15). */
  captureTrigger?: GpsCaptureTrigger;
  /** GPS_POINT: reject a fix whose reported accuracy (metres) exceeds this cap (D15); unset = no cap. */
  gpsMaxAccuracy?: number;
  /** CAMERA: suppress the gallery fallback — native rear-camera capture only (D14). */
  noGallery?: boolean;
  /** CAMERA: capture a GPS fix at this photo's shutter time, embedded in the media value (per-photo geotag). */
  geotag?: boolean;
  /** CAMERA (visibility geo-fenced forms): this photo must be inside the geo-fence. Every fence-required photo with a fix must be inside; a fence-required photo with no fix → GEO_UNVERIFIABLE (flag, not a hard-fail). */
  geoFenceRequired?: boolean;
}

export interface EnrollmentFormSchema {
  captureGpsOnSubmit: boolean;
  requireOtp: boolean;
  fields: FormField[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Media value shape + per-photo geotag (per-photo-geotag, Stream 1 — shared contract)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A captured GPS fix. Mirrors the FE source-of-truth `GpsCapture` in
 * platform/src/lib/scheme-types.ts (kept byte-identical in meaning).
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
// Prefill pins (D13 / D13a) — Excel variables + Editable/Locked
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Value-type fields that a Mode-B Excel variable can prefill AND lock. Media
 * (DOCUMENT/IMAGE/CAMERA/UPI_QR_SCAN/SIGNATURE), GPS_POINT, and structural/display
 * types (SECTION/DATA_DISPLAY) cannot be Excel-prefilled. CALCULATED/LOOKUP are
 * server-derived (their own overwrite wins), and PHONE_OTP owns its own pin (the
 * consent-OTP path) — so all three are excluded here too.
 */
export const PREFILLABLE_FIELD_TYPES: ReadonlySet<string> = new Set([
  'TEXT',
  'NUMBER',
  'EMAIL',
  'DATE',
  'DROPDOWN',
  'MULTI_SELECT',
  'TOGGLE',
]);

/**
 * Overwrite every LOCKED prefill field with its authoritative roster value (D13a),
 * returning a NEW object (never mutates `submitted`).
 *
 * A field is a "locked prefill" when `field.locked === true` AND `field.prefillKey`
 * is a non-empty string. Its pin value is `prefillValues[field.prefillKey]`, applied
 * ONLY when that roster value is itself a non-empty string:
 *   • roster has a non-empty value → the field is FORCED to it (a client-sent value
 *     for that field id is discarded — the rep/outlet cannot substitute it).
 *   • roster has NO value for the key (missing/blank) → the field is NOT pinned and
 *     NOT blocked; it gracefully falls back to editable behaviour.
 * Only value-type fields (PREFILLABLE_FIELD_TYPES) are pinnable; PHONE_OTP,
 * CALCULATED/LOOKUP, media, GPS, and structural types are never pinned here.
 *
 * Pure + unit-testable: no DB, no NestJS. The service applies this BEFORE
 * `validateSubmittedValues` so required/type/option checks run against the pinned
 * (server-authoritative) value.
 */
export function applyPrefillPins(
  schema: EnrollmentFormSchema,
  submitted: Record<string, unknown>,
  prefillValues: Record<string, string> | null | undefined,
  outletFieldValues?: Record<string, string> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...submitted };
  const excel = prefillValues && typeof prefillValues === 'object' ? prefillValues : null;
  const outlet = outletFieldValues && typeof outletFieldValues === 'object' ? outletFieldValues : null;
  if (!excel && !outlet) return out;

  for (const field of schema.fields ?? []) {
    if (field.locked !== true) continue;
    if (!PREFILLABLE_FIELD_TYPES.has(field.type)) continue;

    // Dual-source precedence (D13): an outlet-master field on a MATCHED row wins
    // (server-authoritative DB value); else the Excel roster column. A source that
    // carries no value (missing/blank) is skipped — the field gracefully falls back
    // to editable (no brick), matching the Excel-only behaviour.
    const pin = resolveDualSourcePin(field, excel, outlet);
    if (typeof pin === 'string' && pin !== '') {
      out[field.id] = coercePinnedValue(field.type, pin);
    }
  }
  return out;
}

/**
 * The pin STRING for a field under dual-source resolution, or undefined when neither
 * source carries a non-empty value. `outletField` (matched-outlet DB value) wins over
 * `prefillKey` (Excel column) — mirrors the enroll-time resolution the FE renders.
 */
function resolveDualSourcePin(
  field: FormField,
  excel: Record<string, string> | null,
  outlet: Record<string, string> | null,
): string | undefined {
  if (outlet && typeof field.outletField === 'string' && field.outletField !== '') {
    const v = outlet[field.outletField];
    if (typeof v === 'string' && v !== '') return v;
  }
  if (excel && typeof field.prefillKey === 'string' && field.prefillKey !== '') {
    const v = excel[field.prefillKey];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/**
 * Coerce a pinned roster string into the SHAPE a normal client submission stores for
 * that field type, so a locked value and an editable value of the same field are
 * indistinguishable downstream (report/export):
 *   • MULTI_SELECT → array of trimmed option values (roster stores "A,B" → ["A","B"]).
 *   • TOGGLE       → real boolean (roster "yes"/"1"/"true" → true).
 *   • everything else → the raw string (TEXT/NUMBER/EMAIL/DATE/DROPDOWN validate as-is).
 */
function coercePinnedValue(type: string, pin: string): unknown {
  if (type === 'MULTI_SELECT') {
    return pin.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (type === 'TOGGLE') {
    const t = pin.trim().toLowerCase();
    if (TRUE_TOKENS.has(t)) return true;
    if (FALSE_TOKENS.has(t)) return false;
    return pin; // leave odd values for the validator to reject
  }
  return pin;
}

/**
 * The set of Excel-column keys a form actually BINDS to (every field's non-empty
 * `prefillKey`). Used to project a roster row's `prefillValues` down to only the
 * columns the form surfaces — so unbound admin columns (PAN, internal notes, …) are
 * never shipped to the enroller's browser (data minimisation).
 */
export function collectPrefillKeys(schema: unknown): Set<string> {
  const keys = new Set<string>();
  const fields = isObject(schema) && Array.isArray((schema as { fields?: unknown }).fields)
    ? ((schema as { fields: unknown[] }).fields)
    : [];
  for (const f of fields) {
    if (!isObject(f)) continue;
    // prefillKey (value fields, Mode B) AND dataDisplayKey (read-only DATA_DISPLAY) are
    // BOTH Excel-roster columns the form surfaces — projecting only prefillKey stripped the
    // DATA_DISPLAY column so it always rendered "—" (H2). Collect both.
    if (typeof f.prefillKey === 'string' && f.prefillKey.trim() !== '') keys.add(f.prefillKey);
    if (typeof f.dataDisplayKey === 'string' && f.dataDisplayKey.trim() !== '') keys.add(f.dataDisplayKey);
  }
  return keys;
}

/**
 * The set of OUTLET-master field keys a form BINDS to (every field's non-empty
 * `outletField`). Used to project a matched outlet's resolved DB values down to only
 * the fields the form surfaces — the enroller never receives unbound outlet attributes
 * (same data minimisation as `pickBoundPrefill` for Excel columns).
 */
export function collectOutletFieldKeys(schema: unknown): Set<string> {
  const keys = new Set<string>();
  const fields = isObject(schema) && Array.isArray((schema as { fields?: unknown }).fields)
    ? ((schema as { fields: unknown[] }).fields)
    : [];
  for (const f of fields) {
    if (isObject(f) && typeof f.outletField === 'string' && f.outletField.trim() !== '') {
      keys.add(f.outletField);
    }
  }
  return keys;
}

/**
 * Project a matched outlet's resolved field map to ONLY the outlet fields the form binds
 * to. Returns null when nothing to expose. Mirrors `pickBoundPrefill` for outlet fields.
 */
export function pickBoundOutletFields(
  outletFieldValues: Record<string, string> | null | undefined,
  schema: unknown,
): Record<string, string> | null {
  if (!outletFieldValues || typeof outletFieldValues !== 'object') return null;
  const keys = collectOutletFieldKeys(schema);
  if (keys.size === 0) return null;
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = outletFieldValues[k];
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Reserved prefill keys for the roster row's OWN identity (its supplied Outlet ID +
 * Name). The parser consumes those two fixed columns into `outletRef`/`outletName`, so
 * they never land in `prefillValues` — yet a DATA_DISPLAY (or prefill) field naturally
 * wants to show them. This merges them in under stable labels so they resolve for EVERY
 * row (matched OR standalone), without clobbering a same-named variable column.
 */
export const ROSTER_IDENTITY_COLUMNS = ['Outlet ID', 'Outlet Name'] as const;

export function withRosterIdentity(
  outletRef: string,
  outletName: string,
  prefillValues: Record<string, string> | null | undefined,
): Record<string, string> {
  const base = prefillValues && typeof prefillValues === 'object' ? { ...prefillValues } : {};
  if (base['Outlet ID'] === undefined && outletRef) base['Outlet ID'] = outletRef;
  if (base['Outlet Name'] === undefined && outletName) base['Outlet Name'] = outletName;
  return base;
}

/**
 * Project a roster row's `prefillValues` to only the columns the form binds to.
 * Returns null when there is nothing to expose (no roster values, no bound keys, or
 * no overlap) — the enrollee endpoints hand this to the FE instead of the raw blob.
 */
export function pickBoundPrefill(
  prefillValues: Record<string, string> | null | undefined,
  schema: unknown,
): Record<string, string> | null {
  if (!prefillValues || typeof prefillValues !== 'object') return null;
  const keys = collectPrefillKeys(schema);
  if (keys.size === 0) return null;
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = prefillValues[k];
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural type guards (used by the validator below)
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
// validateFormSchema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the structural integrity of an EnrollmentFormSchema stored in
 * SchemeEnrollmentForm.formSchema.
 *
 * Returns an array of human-readable error strings; an empty array means valid.
 *
 * Rules (ported from platform/src/lib/campaign.ts::validateEnrollmentFormConfig,
 * plus backend-side structural coercion checks):
 *
 *   Top-level:
 *     - captureGpsOnSubmit must be a boolean
 *     - requireOtp must be a boolean
 *     - fields must be a non-empty array
 *
 *   Per field:
 *     - id:        non-empty string, unique across the form
 *     - type:      one of FormFieldType
 *     - label:     non-empty string
 *     - required:  boolean
 *     - order:     number
 *     - options (DROPDOWN): must have at least one string entry
 *     - formula (CALCULATED): required, non-empty; all {id} refs must resolve
 *     - visibleWhen (optional):
 *         fieldId → must resolve to another field (not itself)
 *         op      → one of VISIBLE_WHEN_OPS
 *         value   → string
 */
export function validateFormSchema(rawSchema: unknown): string[] {
  const errors: string[] = [];

  // ── Top-level structure ──────────────────────────────────────────────────
  if (!isObject(rawSchema)) {
    return ['formSchema must be a JSON object.'];
  }

  if (!isBoolean(rawSchema.captureGpsOnSubmit)) {
    errors.push('formSchema.captureGpsOnSubmit must be a boolean.');
  }
  if (!isBoolean(rawSchema.requireOtp)) {
    errors.push('formSchema.requireOtp must be a boolean.');
  }

  if (!Array.isArray(rawSchema.fields)) {
    errors.push('formSchema.fields must be an array.');
    return errors; // no point checking further
  }

  const fields = rawSchema.fields as unknown[];

  if (fields.length === 0) {
    errors.push('The enrollment form must have at least one field.');
    return errors;
  }

  // ── Per-field passes ──────────────────────────────────────────────────────
  // Pass 1: collect all field ids and check structure
  const fieldIds = new Set<string>();
  const duplicateIds = new Set<string>();

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const pos = `Field ${i + 1}`;

    if (!isObject(f)) {
      errors.push(`${pos}: must be a JSON object.`);
      continue;
    }

    // id
    if (!isString(f.id) || f.id.trim() === '') {
      errors.push(`${pos}: id must be a non-empty string.`);
    } else if (fieldIds.has(f.id)) {
      duplicateIds.add(f.id);
      errors.push(`${pos}: duplicate field id "${f.id}".`);
    } else {
      fieldIds.add(f.id);
    }

    // type
    if (!isString(f.type) || !(FORM_FIELD_TYPES as readonly string[]).includes(f.type)) {
      errors.push(`${pos}: type must be one of: ${FORM_FIELD_TYPES.join(', ')}.`);
    }

    // label
    if (!isString(f.label) || f.label.trim() === '') {
      errors.push(`${pos}: label cannot be empty.`);
    }

    // required
    if (!isBoolean(f.required)) {
      errors.push(`${pos}: required must be a boolean.`);
    }

    // order
    if (!isNumber(f.order)) {
      errors.push(`${pos}: order must be a number.`);
    }

    // options — required for DROPDOWN and MULTI_SELECT (D12).
    if (f.type === 'DROPDOWN' || f.type === 'MULTI_SELECT') {
      if (!Array.isArray(f.options) || f.options.length === 0) {
        const lbl = isString(f.label) && f.label.trim() ? f.label : f.type;
        errors.push(`${pos} ("${lbl}"): ${f.type} must have at least one option.`);
      } else {
        const badOption = (f.options as unknown[]).find((o) => !isString(o));
        if (badOption !== undefined) {
          errors.push(`${pos}: all options must be strings.`);
        }
      }
    }

    // captureTrigger (optional) — GPS_POINT capture mode (D15).
    if (f.captureTrigger !== undefined) {
      if (
        !isString(f.captureTrigger) ||
        !(GPS_CAPTURE_TRIGGERS as readonly string[]).includes(f.captureTrigger)
      ) {
        errors.push(
          `${pos}: captureTrigger must be one of: ${GPS_CAPTURE_TRIGGERS.join(', ')}.`,
        );
      }
    }

    // otpRequired (optional) — PHONE_OTP verify-before-submit flag (D16).
    if (f.otpRequired !== undefined && !isBoolean(f.otpRequired)) {
      errors.push(`${pos}: otpRequired must be a boolean.`);
    }

    // locked / noGallery (optional) — must be booleans when present (D13a / D14).
    if (f.locked !== undefined && !isBoolean(f.locked)) {
      errors.push(`${pos}: locked must be a boolean.`);
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
    if (f.prefillKey !== undefined && !isString(f.prefillKey)) {
      errors.push(`${pos}: prefillKey must be a string.`);
    }

    // outletField (optional) — the dual-source prefill from an Outlet-master field.
    // Must be one of the curated OUTLET_FIELD_KEYS (a free-typed value would silently
    // resolve to nothing — the same integrity gap the Excel prefill dropdown closes, H1).
    if (f.outletField !== undefined) {
      if (!isString(f.outletField) || !OUTLET_FIELD_KEYS.has(f.outletField)) {
        errors.push(
          `${pos}: outletField must be one of: ${[...OUTLET_FIELD_KEYS].join(', ')}.`,
        );
      }
    }

    // gpsMaxAccuracy (optional) — a positive metre cap for a GPS_POINT fix (D15).
    if (f.gpsMaxAccuracy !== undefined) {
      if (!isNumber(f.gpsMaxAccuracy) || !(f.gpsMaxAccuracy > 0)) {
        errors.push(`${pos}: gpsMaxAccuracy must be a positive number (metres).`);
      }
    }

    // Consent integrity (D13a/D16): a LOCKED, Excel-bound PHONE_OTP field is pinned to
    // its roster number ONLY through the OTP path, which engages solely when the field
    // is `otpRequired`. A locked+prefillKey PHONE_OTP without otpRequired would show the
    // filler a disabled input while the backend never pins it (the client value would
    // persist) — the "Locked" promise would be silently unenforced. Reject that combo.
    if (
      f.type === 'PHONE_OTP' &&
      f.locked === true &&
      isString(f.prefillKey) &&
      (f.prefillKey as string).trim() !== '' &&
      f.otpRequired !== true
    ) {
      const lbl = isString(f.label) && f.label.trim() ? f.label : 'PHONE_OTP';
      errors.push(
        `${pos} ("${lbl}"): a locked, Excel-prefilled phone field must have otpRequired enabled (else the lock is not enforced).`,
      );
    }
  }

  // Pass 2: cross-field checks (formula refs, visibleWhen refs) — needs the
  //         full set of ids collected above, so it is a separate loop.
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!isObject(f)) continue; // already flagged above

    const pos = `Field ${i + 1}`;
    const label =
      isString(f.label) && (f.label as string).trim()
        ? (f.label as string).trim()
        : (isString(f.type) ? f.type : `${i + 1}`);

    // CALCULATED: formula required + all {ref} ids must resolve
    if (f.type === 'CALCULATED') {
      const formula = isString(f.formula) ? (f.formula as string).trim() : '';
      if (!formula) {
        errors.push(`${pos} ("${label}"): CALCULATED field must have a non-empty formula.`);
      } else {
        const refs = Array.from(formula.matchAll(/\{([^}]+)\}/g)).map((m) => m[1]);
        for (const ref of refs) {
          if (!fieldIds.has(ref)) {
            errors.push(
              `${pos} ("${label}"): formula references unknown field id "${ref}".`,
            );
          }
        }
      }
    }

    // visibleWhen (optional) — structural + reference check
    if (f.visibleWhen !== undefined) {
      const vw = f.visibleWhen;
      if (!isObject(vw)) {
        errors.push(`${pos}: visibleWhen must be an object.`);
        continue;
      }
      if (!isString(vw.fieldId) || vw.fieldId.trim() === '') {
        errors.push(`${pos}: visibleWhen.fieldId must be a non-empty string.`);
      } else if (isString(f.id) && vw.fieldId === f.id) {
        errors.push(
          `${pos} ("${label}"): visibleWhen cannot depend on itself.`,
        );
      } else if (!fieldIds.has(vw.fieldId as string)) {
        errors.push(
          `${pos} ("${label}"): visibleWhen references unknown field id "${vw.fieldId}".`,
        );
      }
      if (
        !isString(vw.op) ||
        !(VISIBLE_WHEN_OPS as readonly string[]).includes(vw.op as string)
      ) {
        errors.push(
          `${pos}: visibleWhen.op must be one of: ${VISIBLE_WHEN_OPS.join(', ')}.`,
        );
      }
      if (!isString(vw.value)) {
        errors.push(`${pos}: visibleWhen.value must be a string.`);
      }
    }

    // requiredWhen (optional) — conditional-required (D12b). Same clause shape +
    // reference rules as visibleWhen (a field cannot conditionally-require on itself).
    if (f.requiredWhen !== undefined) {
      const rw = f.requiredWhen;
      if (!isObject(rw)) {
        errors.push(`${pos}: requiredWhen must be an object.`);
      } else {
        if (!isString(rw.fieldId) || rw.fieldId.trim() === '') {
          errors.push(`${pos}: requiredWhen.fieldId must be a non-empty string.`);
        } else if (isString(f.id) && rw.fieldId === f.id) {
          errors.push(`${pos} ("${label}"): requiredWhen cannot depend on itself.`);
        } else if (!fieldIds.has(rw.fieldId as string)) {
          errors.push(
            `${pos} ("${label}"): requiredWhen references unknown field id "${rw.fieldId}".`,
          );
        }
        if (!isString(rw.op) || !(VISIBLE_WHEN_OPS as readonly string[]).includes(rw.op as string)) {
          errors.push(`${pos}: requiredWhen.op must be one of: ${VISIBLE_WHEN_OPS.join(', ')}.`);
        }
        if (!isString(rw.value)) {
          errors.push(`${pos}: requiredWhen.value must be a string.`);
        }
      }
    }

    // LOOKUP (D12a): lookupSourceFieldId must resolve to ANOTHER field, and
    // lookupMap must be a non-empty object of string→string entries. The value is
    // server-resolved at submit time from the source field's selected option.
    if (f.type === 'LOOKUP') {
      if (!isString(f.lookupSourceFieldId) || (f.lookupSourceFieldId as string).trim() === '') {
        errors.push(`${pos} ("${label}"): LOOKUP must set lookupSourceFieldId.`);
      } else if (isString(f.id) && f.lookupSourceFieldId === f.id) {
        errors.push(`${pos} ("${label}"): LOOKUP cannot source from itself.`);
      } else if (!fieldIds.has(f.lookupSourceFieldId as string)) {
        errors.push(
          `${pos} ("${label}"): LOOKUP references unknown source field id "${f.lookupSourceFieldId}".`,
        );
      }
      if (!isObject(f.lookupMap) || Object.keys(f.lookupMap as object).length === 0) {
        errors.push(`${pos} ("${label}"): LOOKUP must have a non-empty lookupMap.`);
      } else {
        const badVal = Object.values(f.lookupMap as Record<string, unknown>).find(
          (v) => !isString(v),
        );
        if (badVal !== undefined) {
          errors.push(`${pos} ("${label}"): all lookupMap values must be strings.`);
        }
      }
    }
  }

  // GPS coherence: a submit-time GPS capture (`captureGpsOnSubmit`) needs a GPS_POINT
  // field to store the fix into — after the schema-field-id projection there is no
  // fieldless storage, so the flag would silently capture nothing. Reject such a form.
  if (rawSchema.captureGpsOnSubmit === true) {
    const hasGpsField = fields.some((f) => isObject(f) && f.type === 'GPS_POINT');
    if (!hasGpsField) {
      errors.push(
        'formSchema.captureGpsOnSubmit is true but the form has no GPS_POINT field to store the fix.',
      );
    }
  }

  // Consent integrity (A-LOW-2): a `requireOtp` form MUST carry a PHONE_OTP field with
  // `otpRequired` — otherwise the top-level flag promises a consent gate that nothing on
  // the form actually enforces (fail-open). Reject such a form outright.
  if (rawSchema.requireOtp === true) {
    const hasOtpField = fields.some(
      (f) => isObject(f) && f.type === 'PHONE_OTP' && f.otpRequired === true,
    );
    if (!hasOtpField) {
      errors.push(
        'formSchema.requireOtp is true but the form has no PHONE_OTP field with otpRequired.',
      );
    }
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// P4.3 — Submission-time helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determines whether a field is visible given the current submitted values.
 *
 * If the field has no `visibleWhen` clause it is always visible.
 * The predicate is evaluated against the *raw* submitted string values so that
 * the same logic can run before type-coercion (matching the FE behaviour).
 *
 * Supported ops:
 *   eq       — exact string match
 *   neq      — not equal
 *   gt / lt  — numeric comparison (non-numeric operands → false)
 *   contains — substring match
 */
/**
 * Evaluate a single `{fieldId, op, value}` condition clause against the submitted
 * values. Shared by `evaluateVisibleWhen` (visibility) and the conditional-required
 * (`requiredWhen`) logic so both use identical operator semantics.
 */
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

export function evaluateVisibleWhen(
  field: FormField,
  submittedValues: Record<string, unknown>,
): boolean {
  if (!field.visibleWhen) return true;
  return evaluateClause(field.visibleWhen, submittedValues);
}

/**
 * Whether a (visible) field must have a value on this submission. A `required:true`
 * field is always required; a field with a `requiredWhen` clause becomes required
 * only while that clause evaluates true (conditional-required, D12b).
 */
export function isFieldRequired(
  field: FormField,
  submittedValues: Record<string, unknown>,
): boolean {
  if (field.required) return true;
  if (field.requiredWhen) return evaluateClause(field.requiredWhen, submittedValues);
  return false;
}

/** An operand token is either a `{fieldId}` ref or a numeric literal (optional leading `-`). */
const FORMULA_OPERAND_RE = /^(-?\d+(?:\.\d+)?|\{[^}]+\})/;
const FORMULA_OPERATOR_RE = /^[+\-*/]/;

/** Resolve one operand token (a `{ref}` or a numeric literal) to a number, or null if unresolvable. */
function resolveFormulaOperand(
  token: string,
  submittedValues: Record<string, unknown>,
): number | null {
  const ref = /^\{([^}]+)\}$/.exec(token);
  if (ref) {
    const val = submittedValues[ref[1]];
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    return isNaN(n) ? null : n;
  }
  const n = Number(token);
  return isNaN(n) ? null : n;
}

/**
 * Evaluates an arithmetic formula over `{fieldId}` refs / numeric literals.
 *
 * Formula grammar (subset — matches the FE renderer):
 *   - `{id}` tokens resolve to the numeric value of that submitted field; bare
 *     numeric literals are allowed too (e.g. `{f1} * 2`).
 *   - `+ - * /` operators between operands, N-ary and evaluated STRICTLY
 *     LEFT-TO-RIGHT (no operator precedence — mirrors a simple field-sum, so
 *     `{a} + {b} * {c}` is `(({a} + {b}) * {c})`).
 *   - If any referenced value is non-numeric/unresolved, the formula is malformed,
 *     or a division-by-zero occurs, the result is null (server writes null; the
 *     client-sent value is discarded).
 */
export function evaluateFormula(
  formula: string,
  submittedValues: Record<string, unknown>,
): number | null {
  // Tokenize into a strict operand (operator operand)* sequence — no eval().
  const tokens: string[] = [];
  let rest = formula.trim();
  let expectOperand = true;
  while (rest.length > 0) {
    rest = rest.replace(/^\s+/, '');
    if (rest.length === 0) break;
    const re = expectOperand ? FORMULA_OPERAND_RE : FORMULA_OPERATOR_RE;
    const m = re.exec(rest);
    if (!m) return null; // parse error
    tokens.push(m[0]);
    rest = rest.slice(m[0].length);
    expectOperand = !expectOperand;
  }
  // After consuming an operand `expectOperand` flips to false; after an operator it
  // flips to true. A well-formed expression therefore ends with `expectOperand`
  // false. If it is still true, the last token was a dangling operator (or empty).
  if (tokens.length === 0 || expectOperand) return null;

  let acc = resolveFormulaOperand(tokens[0], submittedValues);
  if (acc === null) return null;
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i];
    const operand = resolveFormulaOperand(tokens[i + 1], submittedValues);
    if (operand === null) return null;
    switch (op) {
      case '+': acc += operand; break;
      case '-': acc -= operand; break;
      case '*': acc *= operand; break;
      case '/': if (operand === 0) return null; acc /= operand; break;
      default: return null;
    }
  }
  return acc;
}

/**
 * Submission-time validation result.
 *
 * `errors`        — human-readable per-field validation messages; empty = valid.
 * `recomputedValues` — CALCULATED field values as computed server-side, keyed
 *                      by fieldId. Callers must merge these into formValues
 *                      before persisting (overwrite whatever the client sent).
 */
export interface SubmissionValidationResult {
  errors: string[];
  /** CALCULATED field values recomputed server-side (client value discarded). */
  recomputedValues: Record<string, number | null>;
  /** LOOKUP field values server-resolved from their source field (client value discarded). */
  resolvedValues: Record<string, string | null>;
}

/** RFC-5322-lite email check — good enough to reject obvious garbage without false-rejecting real addresses. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Truthy/falsy tokens accepted for a TOGGLE (yes/no) field. */
const TRUE_TOKENS = new Set(['true', '1', 'yes', 'on']);
const FALSE_TOKENS = new Set(['false', '0', 'no', 'off']);

/**
 * Server-resolve a LOOKUP field: map the SOURCE field's submitted option value
 * through the field's `lookupMap`. Returns the mapped string, or null when the
 * source value is empty / unmapped. Never trusts a client-sent lookup value.
 */
export function resolveLookup(
  field: FormField,
  submittedValues: Record<string, unknown>,
): string | null {
  if (!field.lookupSourceFieldId || !field.lookupMap) return null;
  const src = submittedValues[field.lookupSourceFieldId];
  if (src === null || src === undefined || src === '') return null;
  const key = String(src);
  const mapped = field.lookupMap[key];
  return typeof mapped === 'string' ? mapped : null;
}

/** Is a MULTI_SELECT/TOGGLE-aware "empty" — false and empty arrays handled per-type below. */
function isBlank(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    (typeof v === 'string' && v.trim() === '') ||
    (Array.isArray(v) && v.length === 0)
  );
}

/**
 * Validates submitted form values against the stored `formSchema`.
 *
 * Rules (P4.3):
 *   1. Visible fields that are `required` must have a non-empty value.
 *   2. Fields hidden by `visibleWhen` are not required (even if required=true).
 *   3. A prefilled value (locked or editable) is validated like any other value —
 *      locked pins are applied by `applyPrefillPins` before this runs.
 *   4. CALCULATED fields are server-recomputed; the client-sent value is ignored.
 *      The recomputed value is returned in `recomputedValues`.
 *   5. Type coercion checks:
 *      - NUMBER fields must be parseable as a finite number.
 *      - DATE fields must be a valid ISO date string (YYYY-MM-DD or ISO 8601).
 *      - All other field types accept any non-empty string.
 *   6. DATA_DISPLAY fields are read-only display labels — never required,
 *      never validated.
 *
 * @param schema         The parsed EnrollmentFormSchema from the DB record.
 * @param submitted      The raw submitted formValues from the request body
 *                       (may be undefined/null if no form is configured).
 */
export function validateSubmittedValues(
  schema: EnrollmentFormSchema,
  submitted: Record<string, unknown> | null | undefined,
): SubmissionValidationResult {
  const errors: string[] = [];
  const recomputedValues: Record<string, number | null> = {};
  const resolvedValues: Record<string, string | null> = {};
  const values: Record<string, unknown> = submitted ?? {};

  for (const field of schema.fields) {
    // DATA_DISPLAY / SECTION: read-only display / structural, skip entirely.
    if (DISPLAY_ONLY_TYPES.has(field.type)) continue;

    // CALCULATED: server-side recompute; ignore client value.
    if (field.type === 'CALCULATED') {
      const computed = field.formula ? evaluateFormula(field.formula, values) : null;
      recomputedValues[field.id] = computed;
      continue;
    }

    // LOOKUP: server-resolve from the source field; ignore client value.
    if (field.type === 'LOOKUP') {
      resolvedValues[field.id] = resolveLookup(field, values);
      continue;
    }

    // Determine visibility. Hidden fields are never validated or required.
    if (!evaluateVisibleWhen(field, values)) continue;

    const rawValue = values[field.id];

    // TOGGLE: `false` is a real answer, not "empty". A TOGGLE is only blank when
    // the key is missing/null. Everything else is required-check-exempt from isBlank.
    const empty = field.type === 'TOGGLE' ? rawValue === null || rawValue === undefined : isBlank(rawValue);

    // Effective required = base required OR a satisfied requiredWhen (D12b).
    if (isFieldRequired(field, values) && empty) {
      errors.push(`Field "${field.label}" (${field.id}) is required.`);
      continue;
    }

    // Type validation — only when a value is present.
    if (empty) continue;

    // Media fields (DOCUMENT/IMAGE/CAMERA/UPI_QR_SCAN/SIGNATURE): the value is a bare
    // object-key string OR a `{ key, geo? }` object carrying that photo's shutter-time
    // GPS fix (per-photo geotag). Both shapes are accepted; a bare string stays valid
    // (full back-compat). When a geo IS embedded, validate its shape/Earth-range and the
    // per-field accuracy cap (D2). A photo with no embedded geo stays valid.
    if (MEDIA_FIELD_TYPES.has(field.type)) {
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
        // `readMediaValue` drops a non-object / non-numeric-lat-lng geo (→ media.geo
        // undefined); an out-of-range but numeric geo survives → range-check it here.
        const g = media.geo;
        const inRange =
          !!g &&
          Number.isFinite(g.lat) && g.lat >= -90 && g.lat <= 90 &&
          Number.isFinite(g.lng) && g.lng >= -180 && g.lng <= 180;
        if (!inRange) {
          errors.push(`Field "${field.label}" (${field.id}) has a malformed or out-of-range photo location.`);
          continue;
        }
        // D2 accuracy cap for the embedded photo geo (data-quality filter, mirrors the
        // GPS_POINT cap below). A fix with no reported accuracy is accepted.
        if (typeof field.gpsMaxAccuracy === 'number' && field.gpsMaxAccuracy > 0) {
          const acc = Number(media.geo?.accuracy);
          if (isFinite(acc) && acc > field.gpsMaxAccuracy) {
            errors.push(
              `Field "${field.label}" (${field.id}) location accuracy (±${acc}m) exceeds the ${field.gpsMaxAccuracy}m limit — move to open sky and recapture.`,
            );
          }
        }
      }
      continue;
    }

    switch (field.type) {
      case 'NUMBER': {
        const n = Number(String(rawValue));
        if (!isFinite(n) || isNaN(n)) {
          errors.push(`Field "${field.label}" (${field.id}) must be a valid number.`);
        }
        break;
      }
      case 'DATE': {
        const d = new Date(String(rawValue));
        if (isNaN(d.getTime())) {
          errors.push(`Field "${field.label}" (${field.id}) must be a valid date.`);
        }
        break;
      }
      case 'EMAIL': {
        if (!EMAIL_RE.test(String(rawValue).trim())) {
          errors.push(`Field "${field.label}" (${field.id}) must be a valid email address.`);
        }
        break;
      }
      case 'PHONE_OTP': {
        // Structural: a 10-digit mobile (last-10, punctuation-tolerant). Whether a
        // VERIFIED OTP is required is enforced by the service (needs DB + the resolved
        // target number) — the pure helper only checks the value's shape.
        const digits = String(rawValue).replace(/\D/g, '').slice(-10);
        if (digits.length !== 10) {
          errors.push(`Field "${field.label}" (${field.id}) must be a valid 10-digit mobile number.`);
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
        }
        break;
      }
      case 'DROPDOWN': {
        if (Array.isArray(field.options) && field.options.length > 0) {
          if (!field.options.map(String).includes(String(rawValue))) {
            errors.push(`Field "${field.label}" (${field.id}) has an invalid selection.`);
          }
        }
        break;
      }
      case 'MULTI_SELECT': {
        // Accept an array of option values, or a comma-separated string. Each entry
        // must be one of the configured options.
        const arr = Array.isArray(rawValue)
          ? rawValue.map(String)
          : String(rawValue).split(',').map((s) => s.trim()).filter(Boolean);
        const allowed = new Set((field.options ?? []).map(String));
        const bad = arr.find((v) => !allowed.has(v));
        if (bad !== undefined) {
          errors.push(`Field "${field.label}" (${field.id}) contains an invalid option "${bad}".`);
        }
        break;
      }
      case 'GPS_POINT': {
        // Accuracy gate (D15): a DATA-QUALITY filter (NOT an anti-fraud control — lat/lng/
        // accuracy are all client-attested, unverifiable server-side). When the field caps
        // accuracy and the fix REPORTS a numeric accuracy worse than the cap, reject it to
        // drop honest low-quality fixes. A fix with no reported accuracy is accepted (can't
        // prove it fails). Opt-in + back-compatible. For true proof-of-location use the
        // separate fail-closed visibility/POSM geo-fence, not this cap.
        if (typeof field.gpsMaxAccuracy === 'number' && field.gpsMaxAccuracy > 0 &&
            rawValue !== null && typeof rawValue === 'object') {
          const acc = Number((rawValue as { accuracy?: unknown }).accuracy);
          if (isFinite(acc) && acc > field.gpsMaxAccuracy) {
            errors.push(
              `Field "${field.label}" (${field.id}) location accuracy (±${acc}m) exceeds the ${field.gpsMaxAccuracy}m limit — move to open sky and recapture.`,
            );
          }
        }
        break;
      }
      // TEXT (and any other non-cased value type): any non-empty value accepted.
      // Media types (IMAGE/CAMERA/DOCUMENT/UPI_QR_SCAN/SIGNATURE) never reach here — they are
      // validated + `continue`d by the MEDIA_FIELD_TYPES block above (which accepts a bare key
      // string OR a `{ key, geo }` object and rejects a keyless value).
      default:
        break;
    }
  }

  return { errors, recomputedValues, resolvedValues };
}
