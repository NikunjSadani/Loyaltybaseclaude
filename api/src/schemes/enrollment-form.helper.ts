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

export const FIELD_AUDIENCES = ['ALL', 'LOYALTY_MEMBERS', 'NON_LOYALTY_MEMBERS'] as const;
export type FieldAudience = (typeof FIELD_AUDIENCES)[number];

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
  audience?: FieldAudience;
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
  /** LOOKUP: the field whose selected option value is mapped through `lookupMap`. */
  lookupSourceFieldId?: string;
  /** LOOKUP: option value → shown/derived value map (D12a). */
  lookupMap?: Record<string, string>;
  /** PHONE_OTP: require a verified consent OTP before submit (D16). */
  otpRequired?: boolean;
  /** GPS_POINT: when the location fix is captured (D15). */
  captureTrigger?: GpsCaptureTrigger;
  /** CAMERA: suppress the gallery fallback — native rear-camera capture only (D14). */
  noGallery?: boolean;
}

export interface EnrollmentFormSchema {
  captureGpsOnSubmit: boolean;
  requireOtp: boolean;
  fields: FormField[];
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
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...submitted };
  if (!prefillValues || typeof prefillValues !== 'object') return out;

  for (const field of schema.fields ?? []) {
    if (field.locked !== true) continue;
    if (typeof field.prefillKey !== 'string' || field.prefillKey === '') continue;
    if (!PREFILLABLE_FIELD_TYPES.has(field.type)) continue;

    const pin = prefillValues[field.prefillKey];
    if (typeof pin === 'string' && pin !== '') {
      out[field.id] = coercePinnedValue(field.type, pin);
    }
  }
  return out;
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
    if (isObject(f) && typeof f.prefillKey === 'string' && f.prefillKey.trim() !== '') {
      keys.add(f.prefillKey);
    }
  }
  return keys;
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
 *     - audience (optional): one of FieldAudience
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

    // audience (optional)
    if (f.audience !== undefined) {
      if (!isString(f.audience) || !(FIELD_AUDIENCES as readonly string[]).includes(f.audience)) {
        errors.push(`${pos}: audience must be one of: ${FIELD_AUDIENCES.join(', ')}.`);
      }
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
    if (f.prefillKey !== undefined && !isString(f.prefillKey)) {
      errors.push(`${pos}: prefillKey must be a string.`);
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
      // TEXT, GPS_POINT, IMAGE, CAMERA, DOCUMENT, UPI_QR_SCAN, SIGNATURE:
      // any non-empty value accepted (media = a stored object key; geo = a JSON blob).
      default:
        break;
    }
  }

  return { errors, recomputedValues, resolvedValues };
}
