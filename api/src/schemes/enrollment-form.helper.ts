/**
 * enrollment-form.helper.ts — P4.2
 *
 * Pure, unit-testable form-schema structural validator.
 * Ported from platform/src/lib/campaign.ts::validateEnrollmentFormConfig +
 * the type definitions (FormFieldType, FieldAudience, VisibleWhen, FormField,
 * EnrollmentFormConfig).
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
