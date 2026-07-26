/**
 * scheme-types.ts — Shared TypeScript contract for the Scheme Data-Collection
 * feature (SCHEME-DATA-COLLECTION-DESIGN.md §11 / §13).
 *
 * These types MIRROR the backend's frozen build contract:
 *   - the form field-type palette + FormField / EnrollmentFormSchema shapes
 *     (api/src/schemes/enrollment-form.helper.ts, §13.1)
 *   - the audienceConfig JSON (§13.2)
 *   - the request/response payloads of the §13.4 API surface
 *
 * They are the single source of truth the canonical client (`lib/schemes.ts`),
 * the shared renderer (`components/schemes/SchemeFormRenderer.tsx`), and the
 * admin / outlet / sales pages (owned by streams 2B/2C/2D) all code against.
 *
 * A handful of PURE form-logic helpers (visibility / conditional-required /
 * formula / lookup) live here too so the renderer + its tests can evaluate the
 * exact same rules the backend enforces on submit — no DB, no fetch, unit-testable.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Field-type palette (§13.1) — mirrors FORM_FIELD_TYPES in enrollment-form.helper
// ─────────────────────────────────────────────────────────────────────────────

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
  // Wave-0 scheme data-collection net-new field types (D12 / §13.1)
  'EMAIL',
  'MULTI_SELECT',
  'TOGGLE',
  'PHONE_OTP',
  'LOOKUP',
  'SECTION',
  'SIGNATURE',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** Field types whose captured value is a stored GCS object key (media). */
export const MEDIA_FIELD_TYPES: ReadonlySet<FormFieldType> = new Set<FormFieldType>([
  'DOCUMENT',
  'IMAGE',
  'CAMERA',
  'UPI_QR_SCAN',
  'SIGNATURE',
]);

/** Field types that are pure display / structural — never carry a captured value. */
export const DISPLAY_ONLY_FIELD_TYPES: ReadonlySet<FormFieldType> = new Set<FormFieldType>([
  'DATA_DISPLAY',
  'SECTION',
]);

export const CAMPAIGN_TYPES = ['LOYALTY_ONLY', 'OPEN_CAMPAIGN', 'MIXED'] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

export const GPS_CAPTURE_TRIGGERS = ['ON_SUBMIT', 'ON_PHOTO', 'MANUAL'] as const;
export type GpsCaptureTrigger = (typeof GPS_CAPTURE_TRIGGERS)[number];

export const FIELD_AUDIENCES = ['ALL', 'LOYALTY_MEMBERS', 'NON_LOYALTY_MEMBERS'] as const;
export type FieldAudience = (typeof FIELD_AUDIENCES)[number];

export const VISIBLE_WHEN_OPS = ['eq', 'neq', 'gt', 'lt', 'contains'] as const;
export type VisibleWhenOp = (typeof VISIBLE_WHEN_OPS)[number];

export interface VisibleWhen {
  fieldId: string;
  op: VisibleWhenOp;
  value: string;
}

/** A single form field — mirrors `FormField` in enrollment-form.helper.ts (§13.1). */
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

  // Wave-0 scheme data-collection additions (§13.1)
  /** Conditional-required (D12b) — required only while this clause is true (and visible). */
  requiredWhen?: VisibleWhen;
  /** Per-field prefill lock (D13a) — a prefilled value the filler cannot edit. */
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

/** The stored enrollment-form schema — mirrors `EnrollmentFormSchema` (§13.1). */
export interface EnrollmentFormSchema {
  captureGpsOnSubmit: boolean;
  requireOtp: boolean;
  fields: FormField[];
}

/** A captured GPS fix (a GPS_POINT field's value). */
export interface GpsCapture {
  lat: number;
  lng: number;
  accuracy?: number;
  capturedAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// audienceConfig (§13.2)
// ─────────────────────────────────────────────────────────────────────────────

export type AudienceMode = 'FILTER' | 'EXCEL';

export interface AudienceFilter {
  outletTypeIds?: string[];
  programNames?: string[];
  programCategories?: string[];
  zones?: string[];
  states?: string[];
  kycApprovedOnly: boolean;
}

export interface AudienceConfig {
  mode: AudienceMode;
  selfEnrollAllowed: boolean;
  frozen: boolean;
  filter?: AudienceFilter;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheme record + status
// ─────────────────────────────────────────────────────────────────────────────

/** Valid Prisma SchemeStatus values (the "Archive → ARCHIVED" 400 bug is gone, D6). */
export const SCHEME_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'CANCELLED'] as const;
export type SchemeStatus = (typeof SCHEME_STATUSES)[number];

/** A scheme record as returned by the admin/enrollee endpoints. */
export interface SchemeRecord {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description?: string | null;
  status: SchemeStatus | string;
  startDate: string;
  endDate: string;
  imageUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  audienceConfig?: AudienceConfig | null;
  createdByUserId?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

/** An eligible scheme for an enrollee — a SchemeRecord + its current form summary. */
export interface EligibleScheme extends SchemeRecord {
  enrollmentForm?: { campaignType: CampaignType | string; version: number } | null;
}

/**
 * The outlet-portal enrollee list (`GET /schemes/enroll/eligible`) additionally
 * surfaces `mySchemeOutletId`: the active partner's MATCHED fixed-roster row id when
 * the scheme has a FIXED roster (EXCEL / FILTER-frozen) — the outlet can self-enroll
 * straight into that row (`targetSchemeOutletId`). A live-rule scheme has no
 * pre-materialized row (the server lazy-creates on enroll) → null.
 */
export interface PartnerEligibleScheme extends EligibleScheme {
  mySchemeOutletId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enrollment / submission
// ─────────────────────────────────────────────────────────────────────────────

export type EnrollmentMode = 'SELF' | 'SALES';
export type SchemeEnrollmentStatus = 'SUBMITTED' | 'REJECTED';

/** The CURRENT enrollment for a roster row (1:1 on schemeOutletId). */
export interface SchemeEnrollment {
  id: string;
  schemeId: string;
  schemeOutletId: string;
  status: SchemeEnrollmentStatus;
  enrollmentMode: EnrollmentMode | string;
  formValues: Record<string, unknown> | null;
  currentVersion: number;
  formVersion: number;
  rejectionReason?: string | null;
  submittedByUserId?: string | null;
  enrolledAt: string;
  createdAt: string;
  updatedAt: string;
}

/** An immutable submission snapshot (append-only history, D10/D11). */
export interface SchemeSubmission {
  id: string;
  schemeId: string;
  schemeOutletId: string;
  enrollmentId: string;
  version: number;
  status: SchemeEnrollmentStatus;
  formValues: Record<string, unknown>;
  formVersion: number;
  enrollmentMode: string;
  submittedByUserId?: string | null;
  rejectionReason?: string | null;
  createdAt: string;
}

/** A media ref surfaced in an admin enrollment detail (§ extractMedia). */
export interface EnrollmentMediaRef {
  fieldId: string;
  label: string;
  type: string;
  key: string;
  /** Backend-provided auth-gated path (`/v1/...`); rewrite to `/api/...` for the browser. */
  viewPath: string;
}

export interface EnrollmentGeoRef {
  fieldId: string;
  label: string;
  value: unknown;
}

/** Result of a successful enroll / resubmit (POST .../enrollment). */
export interface EnrollResult {
  enrollment: SchemeEnrollment;
  submission: SchemeSubmission;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sales discovery — a rep's reachable targets for one scheme (GET .../sales-targets)
// ─────────────────────────────────────────────────────────────────────────────

export type SalesTargetStatus = 'NOT_ENROLLED' | 'SUBMITTED' | 'REJECTED';

/**
 * One reachable enroll TARGET for a sales rep within a scheme. A target is either a
 * materialized roster row (`schemeOutletId` set — matched OR standalone, D19) or a
 * live-rule subtree outlet the rep can lazily roster + enroll (`targetOutletRef` set).
 * Its `status` is the current enrollment status (persistent read-back).
 */
export interface SalesTarget {
  /** The roster row id — pass as `targetSchemeOutletId` to enroll (matched or standalone). */
  schemeOutletId: string | null;
  /** A live-rule outlet id to lazily add + enroll — pass as `targetOutletRef`. */
  targetOutletRef: string | null;
  outletRef: string;
  outletName: string;
  matched: boolean;
  standalone: boolean;
  status: SalesTargetStatus;
  rejectionReason: string | null;
  enrollmentId: string | null;
  currentVersion: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE form-logic helpers — the SAME rules the backend enforces at submit.
// (mirrors evaluateClause / isFieldRequired / evaluateFormula / resolveLookup
//  in api/src/schemes/enrollment-form.helper.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** Evaluate a `{fieldId, op, value}` condition clause against the current values. */
export function evaluateClause(clause: VisibleWhen, values: Record<string, unknown>): boolean {
  const raw = values[clause.fieldId];
  const rawStr = raw !== null && raw !== undefined ? String(raw) : '';
  switch (clause.op) {
    case 'eq':
      return rawStr === clause.value;
    case 'neq':
      return rawStr !== clause.value;
    case 'gt': {
      const n = Number(rawStr);
      const cv = Number(clause.value);
      return !isNaN(n) && !isNaN(cv) && n > cv;
    }
    case 'lt': {
      const n = Number(rawStr);
      const cv = Number(clause.value);
      return !isNaN(n) && !isNaN(cv) && n < cv;
    }
    case 'contains':
      return rawStr.includes(clause.value);
    default:
      return false;
  }
}

/** Whether a field is visible given the current values (no clause → always visible). */
export function isFieldVisible(field: FormField, values: Record<string, unknown>): boolean {
  if (!field.visibleWhen) return true;
  return evaluateClause(field.visibleWhen, values);
}

/**
 * Whether a VISIBLE field must have a value on this submission. `required:true` is
 * always required; a `requiredWhen` clause makes it required only while true (D12b).
 */
export function isFieldRequired(field: FormField, values: Record<string, unknown>): boolean {
  if (field.required) return true;
  if (field.requiredWhen) return evaluateClause(field.requiredWhen, values);
  return false;
}

/**
 * Evaluate an N-ary arithmetic formula, LEFT-TO-RIGHT with NO operator precedence
 * (matches the backend subset). `{id}` tokens → the numeric value of that field;
 * any non-numeric ref, a malformed expression, or a divide-by-zero → null.
 *
 * Grammar: `num (op num)*` where op ∈ {+ - * /} and num is an optionally-signed
 * integer/decimal. `{a} + {b} * {c}` evaluates as `(({a} + {b}) * {c})`.
 */
export function evaluateFormula(formula: string, values: Record<string, unknown>): number | null {
  const resolved = formula.replace(/\{([^}]+)\}/g, (_m, id: string) => {
    const val = values[id];
    if (val === null || val === undefined || val === '') return 'NaN';
    const n = Number(val);
    return isNaN(n) ? 'NaN' : String(n);
  });
  if (resolved.includes('NaN')) return null;

  // Tokenize left-to-right: a number, then alternating operator / number. A leading
  // `-`/`+` is a sign when a number is expected, an operator otherwise.
  type Tok = { kind: 'num'; val: number } | { kind: 'op'; val: string };
  const tokens: Tok[] = [];
  let i = 0;
  let expectNumber = true;
  while (i < resolved.length) {
    const ch = resolved[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (expectNumber) {
      const m = /^[+-]?\d+(?:\.\d+)?/.exec(resolved.slice(i));
      if (!m) return null;
      tokens.push({ kind: 'num', val: Number(m[0]) });
      i += m[0].length;
      expectNumber = false;
    } else if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ kind: 'op', val: ch });
      i += 1;
      expectNumber = true;
    } else {
      return null;
    }
  }
  if (tokens.length === 0 || tokens[tokens.length - 1].kind === 'op') return null;

  let acc = (tokens[0] as { val: number }).val;
  for (let k = 1; k < tokens.length; k += 2) {
    const op = (tokens[k] as { val: string }).val;
    const rhs = (tokens[k + 1] as { val: number }).val;
    switch (op) {
      case '+': acc += rhs; break;
      case '-': acc -= rhs; break;
      case '*': acc *= rhs; break;
      case '/':
        if (rhs === 0) return null;
        acc /= rhs;
        break;
      default: return null;
    }
  }
  return isFinite(acc) ? acc : null;
}

/** Server-resolve a LOOKUP: map the SOURCE field's value through `lookupMap`. */
export function resolveLookup(field: FormField, values: Record<string, unknown>): string | null {
  if (!field.lookupSourceFieldId || !field.lookupMap) return null;
  const src = values[field.lookupSourceFieldId];
  if (src === null || src === undefined || src === '') return null;
  const mapped = field.lookupMap[String(src)];
  return typeof mapped === 'string' ? mapped : null;
}

/** True/false tokens accepted for a TOGGLE value (mirrors backend). */
const TRUE_TOKENS = new Set(['true', '1', 'yes', 'on']);
const FALSE_TOKENS = new Set(['false', '0', 'no', 'off']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isBlank(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    (typeof v === 'string' && v.trim() === '') ||
    (Array.isArray(v) && v.length === 0)
  );
}

/**
 * Client-side mirror of the backend `validateSubmittedValues` — returns an array of
 * human-readable errors (empty = valid). CALCULATED / LOOKUP / display fields are
 * server-owned and skipped here. Run BEFORE calling the enroll endpoint so the
 * common cases surface inline; the backend remains the source of truth.
 */
export function validateSchemeValues(
  schema: EnrollmentFormSchema,
  values: Record<string, unknown>,
): string[] {
  const errors: string[] = [];

  // Schema-integrity mirror of the backend: `captureGpsOnSubmit` promises a location
  // fix on submit, but with no GPS_POINT field to hold it the flag is a silent no-op.
  // Reject such a form so a fieldless toggle can't ship (mirrors the requireOtp integrity
  // guard in the backend validateFormSchema).
  if (schema.captureGpsOnSubmit === true && !schema.fields.some((f) => f.type === 'GPS_POINT')) {
    errors.push('Capture GPS on submit is enabled but the form has no GPS location field.');
  }

  for (const field of schema.fields) {
    if (DISPLAY_ONLY_FIELD_TYPES.has(field.type)) continue;
    if (field.type === 'CALCULATED' || field.type === 'LOOKUP') continue;
    if (!isFieldVisible(field, values)) continue;

    const raw = values[field.id];
    const empty =
      field.type === 'TOGGLE' ? raw === null || raw === undefined : isBlank(raw);

    if (isFieldRequired(field, values) && empty) {
      errors.push(`"${field.label}" is required.`);
      continue;
    }
    if (empty) continue;

    switch (field.type) {
      case 'NUMBER': {
        const n = Number(String(raw));
        if (!isFinite(n) || isNaN(n)) errors.push(`"${field.label}" must be a valid number.`);
        break;
      }
      case 'DATE': {
        if (isNaN(new Date(String(raw)).getTime())) errors.push(`"${field.label}" must be a valid date.`);
        break;
      }
      case 'EMAIL': {
        if (!EMAIL_RE.test(String(raw).trim())) errors.push(`"${field.label}" must be a valid email address.`);
        break;
      }
      case 'PHONE_OTP': {
        const digits = String(raw).replace(/\D/g, '').slice(-10);
        if (digits.length !== 10) errors.push(`"${field.label}" must be a valid 10-digit mobile number.`);
        break;
      }
      case 'TOGGLE': {
        const ok =
          typeof raw === 'boolean' ||
          TRUE_TOKENS.has(String(raw).toLowerCase()) ||
          FALSE_TOKENS.has(String(raw).toLowerCase());
        if (!ok) errors.push(`"${field.label}" must be yes/no.`);
        break;
      }
      case 'DROPDOWN': {
        if (Array.isArray(field.options) && field.options.length > 0) {
          if (!field.options.map(String).includes(String(raw))) {
            errors.push(`"${field.label}" has an invalid selection.`);
          }
        }
        break;
      }
      case 'MULTI_SELECT': {
        const arr = Array.isArray(raw)
          ? raw.map(String)
          : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
        const allowed = new Set((field.options ?? []).map(String));
        const bad = arr.find((v) => !allowed.has(v));
        if (bad !== undefined) errors.push(`"${field.label}" contains an invalid option "${bad}".`);
        break;
      }
      default:
        break;
    }
  }
  return errors;
}

/** Ordered, display-safe field list (sorted by `order`). */
export function orderedFields(schema: EnrollmentFormSchema): FormField[] {
  return [...(schema.fields ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
