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
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

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
  autoFillFromExcel: boolean;
  autoFillEditable: boolean;
  dataDisplayKey?: string;
  /** Required when type === 'CALCULATED'. */
  formula?: string;
  visibleWhen?: VisibleWhen;
  order: number;
}

export interface EnrollmentFormSchema {
  captureGpsOnSubmit: boolean;
  requireOtp: boolean;
  fields: FormField[];
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
 *     - autoFillFromExcel / autoFillEditable: boolean
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

    // autoFillFromExcel / autoFillEditable
    if (!isBoolean(f.autoFillFromExcel)) {
      errors.push(`${pos}: autoFillFromExcel must be a boolean.`);
    }
    if (!isBoolean(f.autoFillEditable)) {
      errors.push(`${pos}: autoFillEditable must be a boolean.`);
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

    // options — required for DROPDOWN
    if (f.type === 'DROPDOWN') {
      if (!Array.isArray(f.options) || f.options.length === 0) {
        const lbl = isString(f.label) && f.label.trim() ? f.label : 'Dropdown';
        errors.push(`${pos} ("${lbl}"): DROPDOWN must have at least one option.`);
      } else {
        const badOption = (f.options as unknown[]).find((o) => !isString(o));
        if (badOption !== undefined) {
          errors.push(`${pos}: all options must be strings.`);
        }
      }
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
export function evaluateVisibleWhen(
  field: FormField,
  submittedValues: Record<string, unknown>,
): boolean {
  if (!field.visibleWhen) return true;

  const { fieldId, op, value: condValue } = field.visibleWhen;
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

/**
 * Evaluates a simple arithmetic formula of the form `{fieldId} op {fieldId}`.
 *
 * Formula grammar (subset — matches the FE renderer):
 *   - `{id}` tokens are replaced with the numeric value of that submitted field.
 *   - Only + - * / operators between exactly two operands are supported.
 *   - If any referenced value is non-numeric or the formula is malformed the
 *     result is null (server writes null; client-sent value is discarded).
 *
 * This intentionally supports only the formula shapes used by the platform FE
 * (e.g. `{f1} * 2`, `{f1} + {f2}`). Extend if richer expressions are required.
 */
export function evaluateFormula(
  formula: string,
  submittedValues: Record<string, unknown>,
): number | null {
  // Replace {fieldId} with the submitted numeric value.
  const resolved = formula.replace(/\{([^}]+)\}/g, (_match, id: string) => {
    const val = submittedValues[id];
    if (val === null || val === undefined || val === '') return 'NaN';
    const n = Number(val);
    return isNaN(n) ? 'NaN' : String(n);
  });

  // If any replacement produced NaN the formula is not evaluable.
  if (resolved.includes('NaN')) return null;

  // Evaluate a simple two-operand arithmetic expression.
  // We deliberately avoid eval(); instead parse manually.
  const match = resolved.match(/^\s*(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) {
    // Also accept a bare number (formula with no operator, just a ref).
    const bare = resolved.trim();
    const n = Number(bare);
    return isNaN(n) ? null : n;
  }

  const [, leftStr, op, rightStr] = match;
  const left = Number(leftStr);
  const right = Number(rightStr);

  switch (op) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/': return right === 0 ? null : left / right;
    default:  return null;
  }
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
  recomputedValues: Record<string, number | null>;
}

/**
 * Validates submitted form values against the stored `formSchema`.
 *
 * Rules (P4.3):
 *   1. Visible fields that are `required` must have a non-empty value.
 *   2. Fields hidden by `visibleWhen` are not required (even if required=true).
 *   3. `autoFillFromExcel` fields are always accepted as-is (pre-filled allowed).
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
  const values: Record<string, unknown> = submitted ?? {};

  for (const field of schema.fields) {
    // DATA_DISPLAY: read-only, skip entirely.
    if (field.type === 'DATA_DISPLAY') continue;

    // CALCULATED: server-side recompute; ignore client value.
    if (field.type === 'CALCULATED') {
      const computed = field.formula
        ? evaluateFormula(field.formula, values)
        : null;
      recomputedValues[field.id] = computed;
      continue;
    }

    // Determine visibility.
    const visible = evaluateVisibleWhen(field, values);

    // Hidden fields are never validated.
    if (!visible) continue;

    const rawValue = values[field.id];
    const isEmpty =
      rawValue === null ||
      rawValue === undefined ||
      (typeof rawValue === 'string' && rawValue.trim() === '');

    // autoFillFromExcel: value may arrive pre-filled; accepted if present,
    // but still required if required=true and the field is visible.
    if (field.required && isEmpty) {
      errors.push(`Field "${field.label}" (${field.id}) is required.`);
      continue;
    }

    // Type validation — only when a value is present.
    if (!isEmpty) {
      const strVal = String(rawValue);

      if (field.type === 'NUMBER') {
        const n = Number(strVal);
        if (!isFinite(n) || isNaN(n)) {
          errors.push(`Field "${field.label}" (${field.id}) must be a valid number.`);
        }
      } else if (field.type === 'DATE') {
        // Accept YYYY-MM-DD or full ISO 8601. Reject invalid strings.
        const d = new Date(strVal);
        if (isNaN(d.getTime())) {
          errors.push(`Field "${field.label}" (${field.id}) must be a valid date.`);
        }
      }
      // DROPDOWN, TEXT, GPS_POINT, IMAGE, CAMERA, DOCUMENT, UPI_QR_SCAN:
      // any non-empty string is accepted (content validation is out-of-scope).
    }
  }

  return { errors, recomputedValues };
}
