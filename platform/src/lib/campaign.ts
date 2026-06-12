/**
 * Campaign module — types and pure business-logic functions.
 *
 * All functions here are pure (no localStorage, no fetch) so they are
 * straightforwardly unit-testable.  Side-effectful storage adapters live
 * in the API routes / server actions that call these helpers.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Enums / union types
// ─────────────────────────────────────────────────────────────────────────────

export type CampaignType = 'LOYALTY_ONLY' | 'OPEN_CAMPAIGN' | 'MIXED';

export type OutletType = 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST';

export type FormFieldType =
  | 'TEXT'
  | 'NUMBER'
  | 'DROPDOWN'
  | 'DATE'
  | 'DOCUMENT'
  | 'IMAGE'
  | 'CAMERA'         // live camera capture (distinct from file-picker IMAGE)
  | 'GPS_POINT'
  | 'UPI_QR_SCAN'    // camera → scan QR code → extract and populate UPI ID
  | 'DATA_DISPLAY';  // read-only: shows an Excel-uploaded data point, no user input

/**
 * Controls which outlet segment sees a field.
 *   ALL                — shown to every enrolling outlet
 *   LOYALTY_MEMBERS    — only outlets that are KYC-approved loyalty members
 *   NON_LOYALTY_MEMBERS — only outlets not yet in the loyalty programme
 */
export type FieldAudience = 'ALL' | 'LOYALTY_MEMBERS' | 'NON_LOYALTY_MEMBERS';

// ─────────────────────────────────────────────────────────────────────────────
// Form config types
// ─────────────────────────────────────────────────────────────────────────────

export interface FormField {
  id: string;
  type: FormFieldType;
  label: string;
  required: boolean;
  placeholder?: string;
  helpText?: string;
  /** Controls which outlet segment sees this field */
  audience?: FieldAudience;
  /** Options list — only for DROPDOWN */
  options?: string[];
  /** Pre-fill value from the outlet targeting Excel */
  autoFillFromExcel: boolean;
  /** If pre-filled, can the enrolling employee edit it? */
  autoFillEditable: boolean;
  /**
   * For DATA_DISPLAY fields — the key used to look up the outlet's
   * Excel-uploaded data point (e.g. 'last_month_sales', 'outlet_score').
   */
  dataDisplayKey?: string;
  order: number;
}

export interface EnrollmentFormConfig {
  /**
   * Capture device GPS automatically at the moment the form is submitted.
   * Configurable per campaign.
   */
  captureGpsOnSubmit: boolean;
  /**
   * GPS is ALWAYS captured when a photo is taken — this is not configurable.
   * Stored on EnrollmentRecord.photoGeoTags.
   */
  requireOtp: boolean;
  fields: FormField[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Outlet record (from targeting list / Excel upload)
// ─────────────────────────────────────────────────────────────────────────────

export interface OutletRecord {
  outletId: string;
  outletName: string;
  outletType: OutletType;
  state: string;
  city: string;
  pincode?: string;
  /** null = no employee tagged (or tag removed in latest upload) */
  assignedEmployeeId: string | null;
  /** true = KYC-approved loyalty outlet; false = scheme-only non-KYC outlet */
  isKycEnrolled: boolean;
  /** Column values from the Excel to pre-fill form fields */
  prefillValues: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enrollment record
// ─────────────────────────────────────────────────────────────────────────────

export interface GpsCapture {
  lat: number;
  lng: number;
  accuracy: number;   // metres
  capturedAt: string; // ISO
}

export interface PhotoGeoTag {
  fieldId: string;
  photoIndex: number;
  lat: number;
  lng: number;
  capturedAt: string;
}

export interface AuditEntry {
  event: string;
  actorId: string;
  timestamp: string;
  detail: string;
}

export interface EnrollmentRecord {
  enrollmentId: string;
  schemeId: string;
  outletId: string;
  outletName: string;
  outletType: string;
  state: string;
  city: string;
  isKycEnrolled: boolean;
  assignedEmployeeId: string;
  assignedEmployeeName: string;
  /** SELF = outlet used the partner app; EMPLOYEE = sales team enrolled */
  enrolledBy: 'SELF' | 'EMPLOYEE';
  submittedAt: string;
  /** null when captureGpsOnSubmit = false */
  submissionGps: GpsCapture | null;
  otpVerified: boolean;
  otpVerifiedAt: string | null;
  otpPhone: string;
  /** fieldId → value (string | number | string[] | {lat,lng}) */
  fieldValues: Record<string, unknown>;
  photoGeoTags: PhotoGeoTag[];
  auditLog: AuditEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats type
// ─────────────────────────────────────────────────────────────────────────────

export interface StateBreakdown {
  state: string;
  targeted: number;
  enrolled: number;
  pct: number;
}

export interface EmployeeBreakdown {
  employeeId: string;
  employeeName: string;
  count: number;
}

export interface EnrollmentStats {
  totalTargeted: number;
  totalEnrolled: number;
  enrollmentPct: number;
  selfEnrolled: number;
  employeeEnrolled: number;
  otpVerifiedCount: number;
  byState: StateBreakdown[];
  byEmployee: EmployeeBreakdown[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Notification config
// ─────────────────────────────────────────────────────────────────────────────

export interface NotificationConfig {
  provider: 'MSG91';
  whatsappTemplateId: string;
  smsTemplateId: string;
  /** Maps template variable (e.g. "{{1}}") to a field id or system field name */
  variableMapping: Record<string, string>;
  otpRequired: boolean; // always true for phone verification
}

// ─────────────────────────────────────────────────────────────────────────────
// Full campaign form data (passed to SchemeBuilder)
// ─────────────────────────────────────────────────────────────────────────────

export interface CampaignConfig {
  campaignType: CampaignType;
  enrollmentForm: EnrollmentFormConfig;
  notification: NotificationConfig | null;
  budgetCap: number | null;       // ₹ — null = no cap
  requireApprovalGate: boolean;
  tags: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the outlet is already enrolled in the scheme, regardless
 * of whether it was self-enrolled or enrolled by the sales team.
 */
export function isAlreadyEnrolled(
  schemeId: string,
  outletId: string,
  enrollments: EnrollmentRecord[],
): boolean {
  return enrollments.some(
    (e) => e.schemeId === schemeId && e.outletId === outletId,
  );
}

/**
 * Returns true only when the given employee is the assigned employee for
 * the outlet.  Only tagged employees may enroll an outlet.
 */
export function canEmployeeEnroll(
  employeeId: string,
  outlet: OutletRecord,
): boolean {
  return outlet.assignedEmployeeId !== null &&
    outlet.assignedEmployeeId === employeeId;
}

/**
 * Computes aggregate enrollment statistics for a campaign dashboard.
 */
export function computeEnrollmentStats(
  targeted: OutletRecord[],
  enrollments: EnrollmentRecord[],
): EnrollmentStats {
  const totalTargeted = targeted.length;
  const totalEnrolled = enrollments.length;
  const enrollmentPct =
    totalTargeted === 0
      ? 0
      : Math.round((totalEnrolled / totalTargeted) * 100);

  const selfEnrolled     = enrollments.filter((e) => e.enrolledBy === 'SELF').length;
  const employeeEnrolled = enrollments.filter((e) => e.enrolledBy === 'EMPLOYEE').length;
  const otpVerifiedCount = enrollments.filter((e) => e.otpVerified).length;

  // Group targeted by state
  const stateTargeted: Record<string, number> = {};
  for (const o of targeted) {
    stateTargeted[o.state] = (stateTargeted[o.state] ?? 0) + 1;
  }

  // Group enrollments by state
  const stateEnrolled: Record<string, number> = {};
  for (const e of enrollments) {
    stateEnrolled[e.state] = (stateEnrolled[e.state] ?? 0) + 1;
  }

  const allStates = new Set([
    ...Object.keys(stateTargeted),
    ...Object.keys(stateEnrolled),
  ]);

  const byState: StateBreakdown[] = Array.from(allStates).map((state) => {
    const t = stateTargeted[state] ?? 0;
    const en = stateEnrolled[state] ?? 0;
    return { state, targeted: t, enrolled: en, pct: t === 0 ? 0 : Math.round((en / t) * 100) };
  });

  // Group enrollments by employee
  const empMap: Record<string, { name: string; count: number }> = {};
  for (const e of enrollments) {
    if (!empMap[e.assignedEmployeeId]) {
      empMap[e.assignedEmployeeId] = { name: e.assignedEmployeeName, count: 0 };
    }
    empMap[e.assignedEmployeeId].count += 1;
  }

  const byEmployee: EmployeeBreakdown[] = Object.entries(empMap)
    .map(([employeeId, { name, count }]) => ({ employeeId, employeeName: name, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalTargeted,
    totalEnrolled,
    enrollmentPct,
    selfEnrolled,
    employeeEnrolled,
    otpVerifiedCount,
    byState,
    byEmployee,
  };
}

/**
 * Moves a field from `fromIndex` to `toIndex` in the fields array,
 * then resets the `order` property of every field to match its new index.
 * Does not mutate the input array.
 */
export function reorderFields(
  fields: FormField[],
  fromIndex: number,
  toIndex: number,
): FormField[] {
  if (fromIndex === toIndex) return fields.map((f) => ({ ...f }));
  const copy = fields.map((f) => ({ ...f }));
  const [moved] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, moved);
  return copy.map((f, i) => ({ ...f, order: i }));
}

/**
 * Validates an EnrollmentFormConfig.
 * Returns an array of human-readable error messages; empty = valid.
 */
export function validateEnrollmentFormConfig(
  config: EnrollmentFormConfig,
): string[] {
  const errors: string[] = [];

  if (config.fields.length === 0) {
    errors.push('The enrollment form must have at least one field.');
  }

  config.fields.forEach((field, i) => {
    const pos = `Field ${i + 1}`;
    if (!field.label.trim()) {
      errors.push(`${pos}: label cannot be empty.`);
    }
    if (field.type === 'DROPDOWN') {
      if (!field.options || field.options.length === 0) {
        errors.push(`${pos} ("${field.label || 'Dropdown'}"): must have at least one option.`);
      }
    }
  });

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enrollment form helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filters a field list to only the fields that should be shown to the
 * enrolling outlet, based on whether it is already a loyalty member.
 *
 * Fields without an `audience` property default to 'ALL'.
 */
export function filterFieldsByAudience(
  fields: FormField[],
  isLoyaltyMember: boolean,
): FormField[] {
  return fields.filter((f) => {
    const audience = f.audience ?? 'ALL';
    if (audience === 'ALL') return true;
    if (audience === 'LOYALTY_MEMBERS')     return isLoyaltyMember;
    if (audience === 'NON_LOYALTY_MEMBERS') return !isLoyaltyMember;
    return true;
  });
}

/**
 * Determines whether all required fields in the (already-filtered) list
 * have non-empty values.
 *
 * Rules per type:
 *  - DATA_DISPLAY  → never required (display-only, no user input)
 *  - IMAGE/CAMERA  → value must be a non-empty array
 *  - GPS_POINT     → value must be an object with lat and lng
 *  - Everything else → value must be a non-empty string / truthy scalar
 */
export function validateFieldValues(
  fields: FormField[],
  values: Record<string, unknown>,
): { valid: boolean; missingFieldIds: string[] } {
  const missingFieldIds: string[] = [];

  for (const field of fields) {
    if (!field.required)               continue;
    if (field.type === 'DATA_DISPLAY') continue; // never user-filled

    const val = values[field.id];

    let filled: boolean;
    if (field.type === 'IMAGE' || field.type === 'CAMERA') {
      filled = Array.isArray(val) && val.length > 0;
    } else if (field.type === 'GPS_POINT') {
      filled = val != null && typeof val === 'object' &&
        'lat' in (val as object) && 'lng' in (val as object);
    } else {
      filled = val != null && String(val).trim() !== '';
    }

    if (!filled) missingFieldIds.push(field.id);
  }

  return { valid: missingFieldIds.length === 0, missingFieldIds };
}

/**
 * Computes the initial controlled values map by reading `prefillValues`
 * (outlet's Excel data, keyed by column label) for any field marked
 * `autoFillFromExcel: true`.
 *
 * DATA_DISPLAY fields are NOT included — they are rendered from the raw
 * outlet data directly, never as form values.
 *
 * Returns a partial Record: only fields that have autoFillFromExcel set.
 */
export function applyPrefillValues(
  fields: FormField[],
  prefillValues: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    if (!field.autoFillFromExcel) continue;
    if (field.type === 'DATA_DISPLAY') continue;
    result[field.id] = prefillValues[field.label] ?? '';
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Excel row parser
// ─────────────────────────────────────────────────────────────────────────────

const VALID_OUTLET_TYPES: OutletType[] = ['SSS', 'WHOLESALER', 'SUB_STOCKIST'];

/**
 * Parses a single row from the outlet-targeting Excel upload.
 *
 * KYC rows:     outletId found in existingOutletIds → only assignedEmployeeId needed
 * Non-KYC rows: outletId NOT found → outlet_name, outlet_type, state, city required
 */
export function parseOutletExcelRow(
  row: Record<string, string>,
  existingOutletIds: Set<string>,
): { outlet: OutletRecord | null; error: string | null } {
  // Normalise column keys (lowercase, underscores)
  const get = (key: string): string =>
    (row[key] ?? row[key.replace(/_/g, '')] ?? row[key.replace(/_/g, ' ')] ?? '').trim();

  const outletId         = get('outlet_id');
  const rawEmployeeId    = get('assigned_employee_id');
  const assignedEmployee = rawEmployeeId === '' ? null : rawEmployeeId;

  // Collect any extra columns as prefill values
  const STANDARD_COLS = new Set([
    'outlet_id', 'outlet_name', 'outlet_type', 'state', 'city', 'pincode',
    'assigned_employee_id',
  ]);
  const prefillValues: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!STANDARD_COLS.has(k.toLowerCase())) {
      prefillValues[k] = v;
    }
  }

  if (existingOutletIds.has(outletId)) {
    // KYC-enrolled outlet
    return {
      outlet: {
        outletId,
        outletName: '',      // resolved from system
        outletType: 'SSS',
        state: '',
        city: '',
        assignedEmployeeId: assignedEmployee,
        isKycEnrolled: true,
        prefillValues,
      },
      error: null,
    };
  }

  // Non-KYC outlet — all fields required
  const outletName = get('outlet_name');
  const rawType    = get('outlet_type').toUpperCase() as OutletType;
  const state      = get('state');
  const city       = get('city');
  const pincode    = get('pincode');

  if (!outletName) {
    return { outlet: null, error: `Row with outlet_id "${outletId}": outlet_name is required for non-KYC outlets.` };
  }
  if (!state) {
    return { outlet: null, error: `Row with outlet_id "${outletId}": state is required for non-KYC outlets.` };
  }
  if (!city) {
    return { outlet: null, error: `Row with outlet_id "${outletId}": city is required for non-KYC outlets.` };
  }
  if (!VALID_OUTLET_TYPES.includes(rawType)) {
    return {
      outlet: null,
      error: `Row with outlet_id "${outletId}": invalid outlet_type "${rawType}". Must be one of: ${VALID_OUTLET_TYPES.join(', ')}.`,
    };
  }

  return {
    outlet: {
      outletId: outletId || `NON-KYC-${Date.now()}`,
      outletName,
      outletType: rawType,
      state,
      city,
      pincode: pincode || undefined,
      assignedEmployeeId: assignedEmployee,
      isKycEnrolled: false,
      prefillValues,
    },
    error: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Excel export builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts enrollment records into flat row objects ready for xlsx export.
 * Each custom FormField becomes one or more columns using the field label.
 */
export function buildExcelExportRows(
  enrollments: EnrollmentRecord[],
  formFields: FormField[],
): Record<string, unknown>[] {
  return enrollments.map((enr) => {
    const row: Record<string, unknown> = {
      'Enrollment ID':          enr.enrollmentId,
      'Submitted At':           enr.submittedAt,
      'Outlet ID':              enr.outletId,
      'Outlet Name':            enr.outletName,
      'Outlet Type':            enr.outletType,
      'State':                  enr.state,
      'City':                   enr.city,
      'KYC Status':             enr.isKycEnrolled ? 'Enrolled' : 'Non-KYC',
      'Assigned Employee ID':   enr.assignedEmployeeId,
      'Assigned Employee Name': enr.assignedEmployeeName,
      'Enrolled By':            enr.enrolledBy,
      'OTP Verified':           enr.otpVerified ? 'Yes' : 'No',
      'OTP Verified At':        enr.otpVerifiedAt ?? '',
      'OTP Phone':              enr.otpPhone,
    };

    // Submission GPS
    if (enr.submissionGps) {
      row['Submission GPS — Latitude']   = enr.submissionGps.lat;
      row['Submission GPS — Longitude']  = enr.submissionGps.lng;
      row['Submission GPS — Accuracy (m)'] = enr.submissionGps.accuracy;
      row['Submission GPS — Captured At']  = enr.submissionGps.capturedAt;
    } else {
      row['Submission GPS — Latitude']   = '';
      row['Submission GPS — Longitude']  = '';
      row['Submission GPS — Accuracy (m)'] = '';
      row['Submission GPS — Captured At']  = '';
    }

    // Custom form fields
    for (const field of formFields) {
      const val = enr.fieldValues[field.id];

      if (field.type === 'GPS_POINT') {
        const gps = val as { lat: number; lng: number } | undefined;
        row[`${field.label} — Latitude`]  = gps?.lat ?? '';
        row[`${field.label} — Longitude`] = gps?.lng ?? '';

      } else if (field.type === 'IMAGE') {
        const urls = val as string[] | undefined ?? [];
        const tags = enr.photoGeoTags
          .filter((t) => t.fieldId === field.id)
          .map((t) => `photo${t.photoIndex}:(${t.lat},${t.lng})@${t.capturedAt}`)
          .join('; ');
        row[`${field.label} — Count`]  = urls.length;
        row[`${field.label} — URLs`]   = urls.join(', ');
        row[`${field.label} — GPS Tags`] = tags;

      } else {
        // TEXT, NUMBER, DATE, DROPDOWN, DOCUMENT
        row[field.label] = val !== undefined && val !== null ? String(val) : '';
      }
    }

    // Audit log — pipe-separated entries
    row['Audit Log'] = enr.auditLog
      .map((e) => `${e.timestamp} | ${e.actorId} | ${e.event} | ${e.detail}`)
      .join(' || ');

    return row;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock data
// ─────────────────────────────────────────────────────────────────────────────

export const MOCK_CAMPAIGN_OUTLETS: OutletRecord[] = [
  { outletId: 'O1', outletName: 'Sharma Kirana', outletType: 'SSS', state: 'Maharashtra', city: 'Mumbai', assignedEmployeeId: 'EMP-001', isKycEnrolled: true, prefillValues: {} },
  { outletId: 'O2', outletName: 'Metro Store', outletType: 'WHOLESALER', state: 'Delhi', city: 'New Delhi', assignedEmployeeId: 'EMP-002', isKycEnrolled: true, prefillValues: {} },
  { outletId: 'O3', outletName: 'Patel Provisions', outletType: 'SSS', state: 'Gujarat', city: 'Ahmedabad', assignedEmployeeId: 'EMP-001', isKycEnrolled: true, prefillValues: {} },
  { outletId: 'NON-001', outletName: 'Corner Mart (New)', outletType: 'SSS', state: 'Maharashtra', city: 'Pune', assignedEmployeeId: 'EMP-003', isKycEnrolled: false, prefillValues: { 'Shop Area': '200 sqft' } },
  { outletId: 'NON-002', outletName: 'Sunrise Grocery', outletType: 'SSS', state: 'Karnataka', city: 'Bengaluru', assignedEmployeeId: 'EMP-003', isKycEnrolled: false, prefillValues: {} },
];

export const MOCK_ENROLLMENTS: EnrollmentRecord[] = [
  {
    enrollmentId: 'ENR-001', schemeId: 'SCH001', outletId: 'O1',
    outletName: 'Sharma Kirana', outletType: 'SSS', state: 'Maharashtra', city: 'Mumbai',
    isKycEnrolled: true, assignedEmployeeId: 'EMP-001', assignedEmployeeName: 'Ravi Kumar',
    enrolledBy: 'EMPLOYEE', submittedAt: '2025-07-01T10:30:00Z',
    submissionGps: { lat: 19.076, lng: 72.877, accuracy: 12, capturedAt: '2025-07-01T10:30:00Z' },
    otpVerified: true, otpVerifiedAt: '2025-07-01T10:29:45Z', otpPhone: '9876543210',
    fieldValues: { 'f-name': 'Rajesh Sharma', 'f-type': 'Kirana' },
    photoGeoTags: [],
    auditLog: [
      { event: 'ENROLLED', actorId: 'EMP-001', timestamp: '2025-07-01T10:30:00Z', detail: 'Enrolled by employee Ravi Kumar' },
      { event: 'OTP_VERIFIED', actorId: 'SYSTEM', timestamp: '2025-07-01T10:29:45Z', detail: 'OTP verified on 9876543210' },
    ],
  },
  {
    enrollmentId: 'ENR-002', schemeId: 'SCH001', outletId: 'O2',
    outletName: 'Metro Store', outletType: 'WHOLESALER', state: 'Delhi', city: 'New Delhi',
    isKycEnrolled: true, assignedEmployeeId: 'EMP-002', assignedEmployeeName: 'Priya Menon',
    enrolledBy: 'SELF', submittedAt: '2025-07-02T14:15:00Z',
    submissionGps: null,
    otpVerified: true, otpVerifiedAt: '2025-07-02T14:14:30Z', otpPhone: '9876500001',
    fieldValues: {},
    photoGeoTags: [],
    auditLog: [
      { event: 'SELF_ENROLLED', actorId: 'O2', timestamp: '2025-07-02T14:15:00Z', detail: 'Outlet self-enrolled via partner app' },
    ],
  },
  {
    enrollmentId: 'ENR-003', schemeId: 'SCH001', outletId: 'NON-001',
    outletName: 'Corner Mart (New)', outletType: 'SSS', state: 'Maharashtra', city: 'Pune',
    isKycEnrolled: false, assignedEmployeeId: 'EMP-003', assignedEmployeeName: 'Amit Shah',
    enrolledBy: 'EMPLOYEE', submittedAt: '2025-07-03T09:45:00Z',
    submissionGps: { lat: 18.520, lng: 73.856, accuracy: 20, capturedAt: '2025-07-03T09:45:00Z' },
    otpVerified: false, otpVerifiedAt: null, otpPhone: '9876500099',
    fieldValues: { 'f-name': 'Kiran Patel', 'f-area': '200 sqft' },
    photoGeoTags: [
      { fieldId: 'f-photo', photoIndex: 0, lat: 18.520, lng: 73.856, capturedAt: '2025-07-03T09:44:00Z' },
    ],
    auditLog: [
      { event: 'ENROLLED', actorId: 'EMP-003', timestamp: '2025-07-03T09:45:00Z', detail: 'Non-KYC outlet enrolled by employee Amit Shah' },
    ],
  },
];
