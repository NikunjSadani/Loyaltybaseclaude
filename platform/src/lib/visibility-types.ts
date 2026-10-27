/**
 * visibility-types.ts — Shared TypeScript contract for the Visibility (POSM)
 * feature (VISIBILITY-POSM-DESIGN.md §2/§5/§6). The FE mirror of the backend's
 * `api/src/visibility/visibility-types.ts` + `visibility-form.helper.ts` shapes.
 *
 * This is the single source of truth the canonical client (`lib/visibility.ts`), the
 * shared capture renderer (`components/visibility/VisibilityCaptureForm.tsx`), and the
 * admin + sales streams all code against.
 *
 * Cloned-and-adapted from the Scheme FE contract (`lib/scheme-types.ts`) — it does NOT
 * import from or depend on the scheme feature. Visibility is a deliberately TRIMMED
 * capture instrument: photos + geo + a few classification fields, NO reward / points /
 * calculation / lookup / consent-OTP surface.
 *
 * A handful of PURE form-logic helpers (visibility / conditional-required / validate)
 * live here too so the renderer + its tests can evaluate the exact same rules the
 * backend enforces on submit — no React, no network, unit-testable.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Field-type palette — mirrors FORM_FIELD_TYPES in api/.../visibility-types.ts
// ─────────────────────────────────────────────────────────────────────────────

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
export type VisibilityFormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** Field types whose captured value is a stored GCS object key (media). Visibility = CAMERA only. */
export const MEDIA_FIELD_TYPES: ReadonlySet<VisibilityFormFieldType> =
  new Set<VisibilityFormFieldType>(['CAMERA']);

/** GPS capture trigger — when the location fix is taken. */
export const GPS_CAPTURE_TRIGGERS = ['ON_SUBMIT', 'ON_PHOTO', 'MANUAL'] as const;
export type GpsCaptureTrigger = (typeof GPS_CAPTURE_TRIGGERS)[number];

export const VISIBLE_WHEN_OPS = ['eq', 'neq', 'gt', 'lt', 'contains'] as const;
export type VisibleWhenOp = (typeof VISIBLE_WHEN_OPS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Outlet-attribute condition sources (mirror of api/.../visibility-types.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reserved synthetic condition fieldIds that resolve from the OUTLET (not the form) —
 * so a `visibleWhen` / `requiredWhen` clause can key on an outlet attribute such as its
 * Sub-Program. The capture renderer merges these into the values map before clause
 * evaluation (live show/hide + required-marker); the builder whitelists them as valid
 * clause sources. MUST stay in sync with the api copy
 * (`api/src/visibility/visibility-types.ts`) — the SAME ids.
 *
 * Extensible at ~zero cost: `__program__`, `__outletType__` follow the same mechanism.
 * Currently exposed: `__subProgram__` (← `Outlet.programCategory`).
 */
export const OUTLET_CONTEXT_FIELD_IDS = ['__subProgram__'] as const;
export type OutletContextFieldId = (typeof OUTLET_CONTEXT_FIELD_IDS)[number];

/** The outlet attributes exposed to conditional clauses, keyed by reserved id. */
export function outletContextValues(o: { programCategory?: string | null }): Record<string, string> {
  return { __subProgram__: (o.programCategory ?? '').trim() };
}

/** A single conditional clause: `values[fieldId] <op> value`. */
export interface VisibleWhen {
  fieldId: string;
  op: VisibleWhenOp;
  value: string;
}

/** A single capture-form field — mirrors `FormField` in the backend visibility-types. */
export interface VisibilityFormField {
  id: string;
  type: VisibilityFormFieldType;
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
  /** GPS_POINT / geotag CAMERA: reject a fix whose reported accuracy (metres) exceeds this cap (D2); unset = no cap. */
  gpsMaxAccuracy?: number;
  /** CAMERA: suppress the gallery fallback — native camera capture only (D14). */
  noGallery?: boolean;
  /** CAMERA: capture a GPS fix at this photo's shutter time, embedded in the media value (per-photo geotag). */
  geotag?: boolean;
  /** CAMERA (visibility geo-fenced forms): this photo must be inside the geo-fence. Every fence-required photo with a fix must be inside; a fence-required photo with no fix → GEO_UNVERIFIABLE (flag, not a hard-fail). */
  geoFenceRequired?: boolean;
  /** CAMERA: what/how to shoot — shown to the rep at capture time (D9). */
  instruction?: string;
  /** CAMERA: a GCS key for a reference / sample image the rep can compare against (D16). */
  sampleImageKey?: string;
}

/**
 * The stored Visibility capture-form schema. `captureGpsOnSubmit` requires a
 * GPS_POINT field to store the fix into (enforced by validateFormSchema on the backend).
 */
export interface VisibilityFormSchema {
  captureGpsOnSubmit: boolean;
  fields: VisibilityFormField[];
}

/**
 * Whether a capture form actually PRODUCES a device location on submit (D10). The
 * geo-fence check needs a GPS fix; a form gives one either via `captureGpsOnSubmit`
 * (fills every GPS_POINT field on submit) or by having at least one GPS_POINT field.
 * Used by the admin surfaces to warn/block when geo-fence is enabled but the form
 * would silently produce no location (defeating the fence — D10).
 */
export function formCapturesLocation(schema: VisibilityFormSchema | null | undefined): boolean {
  if (!schema) return false;
  if (schema.captureGpsOnSubmit === true) return true;
  return (schema.fields ?? []).some((f) => f.type === 'GPS_POINT');
}

/** A captured GPS fix (a GPS_POINT field's value). */
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
// Per-tenant Visibility configuration (settings-backed)
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

// ─────────────────────────────────────────────────────────────────────────────
// Capture record + status + window-derived UI state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * VisibilityCapture status enum (mirrors the Prisma enum).
 * `CHANGES_REQUESTED` (additive, per-photo-approval build) — some photos were REJECTED in
 * review, the window is NOT satisfied, and the rep must re-capture ONLY the flagged photos
 * (approved photos carry forward). `REJECTED` remains the whole-capture reject (re-shoot
 * everything) for back-compat.
 */
export const VISIBILITY_CAPTURE_STATUSES = [
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CHANGES_REQUESTED',
] as const;
export type VisibilityCaptureStatus = (typeof VISIBILITY_CAPTURE_STATUSES)[number];

/**
 * The per-outlet/per-window UI state derived by the backend (D7):
 *   due               — no capture yet, window open
 *   awaiting          — SUBMITTED, awaiting review
 *   approved          — APPROVED (window satisfied)
 *   rejected          — REJECTED (whole capture), re-opens the window (re-shoot all)
 *   changes_requested — CHANGES_REQUESTED (per-photo), re-opens the window (re-shoot the
 *                       flagged photos only). The backend may instead reuse `rejected`
 *                       here while setting the capture `status` to CHANGES_REQUESTED — the
 *                       FE derives the distinct label from either (see `isChangesRequested`).
 *   late              — window closed with no approval (missed / late)
 */
export type CaptureUiState =
  | 'due'
  | 'awaiting'
  | 'approved'
  | 'rejected'
  | 'changes_requested'
  | 'late';

/** Controlled reject-reason codes (D12) — mirrors VISIBILITY_REJECT_REASON_CODES. */
export const VISIBILITY_REJECT_REASON_CODES = [
  'BLURRY',
  'WRONG_OUTLET',
  'POSM_NOT_VISIBLE',
  'GEO_MISMATCH',
  'DUPLICATE_PHOTO',
  'OTHER',
] as const;
export type VisibilityRejectReasonCode = (typeof VISIBILITY_REJECT_REASON_CODES)[number];

/** Human labels for the reject-reason codes (for the admin queue UI). */
export const VISIBILITY_REJECT_REASON_LABELS: Record<VisibilityRejectReasonCode, string> = {
  BLURRY: 'Photo is blurry / unclear',
  WRONG_OUTLET: 'Wrong outlet',
  POSM_NOT_VISIBLE: 'POSM not visible',
  GEO_MISMATCH: 'Location mismatch',
  DUPLICATE_PHOTO: 'Duplicate photo',
  OTHER: 'Other',
};

/** Short human label for a capture status (sales + admin surfaces). */
export const VISIBILITY_CAPTURE_STATUS_LABELS: Record<VisibilityCaptureStatus, string> = {
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CHANGES_REQUESTED: 'Changes requested',
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-photo review (per CAMERA field) — the per-photo-approval build
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single photo (CAMERA field) review decision, as stored in
 * `VisibilityCapture.photoReviews[fieldId]` (keyed by CAMERA field id). A field ABSENT
 * from the map = not yet reviewed (pending). Mirrors the backend review shape.
 */
export interface VisibilityPhotoReview {
  status: 'APPROVED' | 'REJECTED';
  reasonCode?: VisibilityRejectReasonCode | string;
  reason?: string;
  reviewedAt: string;
  reviewedByUserId: string;
}

/** Per-CAMERA-field review state, keyed by field id. */
export type VisibilityPhotoReviews = Record<string, VisibilityPhotoReview>;

/** The per-photo review decision for the per-photo endpoint. */
export type VisibilityPhotoDecision = 'APPROVED' | 'REJECTED';

/** True when any photo in the review map is REJECTED (→ whole-capture approve blocked). */
export function hasRejectedPhoto(reviews?: VisibilityPhotoReviews | null): boolean {
  if (!reviews) return false;
  return Object.values(reviews).some((r) => r?.status === 'REJECTED');
}

/** The CAMERA field ids the reviewer REJECTED (the rep re-captures only these). */
export function rejectedPhotoFieldIds(reviews?: VisibilityPhotoReviews | null): string[] {
  if (!reviews) return [];
  return Object.entries(reviews)
    .filter(([, r]) => r?.status === 'REJECTED')
    .map(([id]) => id);
}

/**
 * Whether a capture row is in the per-photo "changes requested" state (some photos
 * flagged for re-capture). Robust to EITHER backend mapping: the authoritative signal is
 * the capture `status === 'CHANGES_REQUESTED'`; we also honour a `windowState`/`state` of
 * `'changes_requested'` if the backend surfaces it that way.
 */
export function isChangesRequested(o: {
  status?: VisibilityCaptureStatus | null;
  windowState?: CaptureUiState | null;
}): boolean {
  return o.status === 'CHANGES_REQUESTED' || o.windowState === 'changes_requested';
}

// ─────────────────────────────────────────────────────────────────────────────
// Sales discovery — GET /sales/eligible
// ─────────────────────────────────────────────────────────────────────────────

/** One in-scope outlet in the rep's current-window eligible list (D8/D14). */
export interface SalesEligibleOutlet {
  outletId: string;
  outletCode: string;
  outletName: string;
  zone: string | null;
  state: string | null;
  outletType: { code: string; name: string } | null;
  /** The outlet's Program (`Outlet.programName`, e.g. Unnati/SAMT/BSC) — drives the sales
   *  Visibility list's Program filter. Supplied by the backend; absent/blank = unset. */
  programName?: string | null;
  /**
   * The outlet's Sub-Program (`Outlet.programCategory`) — drives outlet-context
   * conditional fields in the capture form (e.g. a 2nd photo required only for a given
   * sub-program). Supplied by the backend on the eligible payload; absent/blank = no
   * outlet-context condition fires.
   */
  programCategory?: string | null;
  /** The current capture row for this (outlet, window), when one exists. */
  captureId: string | null;
  status: VisibilityCaptureStatus | null;
  currentVersion: number | null;
  rejectionReason: string | null;
  /**
   * Per-CAMERA-field review state of the current capture — present (from the backend) for a
   * CHANGES_REQUESTED row so the rep can see which photos were flagged (REJECTED, with
   * reasons) vs carried forward (APPROVED). Absent for a fresh / whole-capture-rejected row.
   */
  photoReviews?: VisibilityPhotoReviews | null;
  /** Window-derived UI state (D7). */
  windowState: CaptureUiState;
  /** Whether THIS rep may capture (allowed level AND in-subtree). */
  canCapture: boolean;
}

/**
 * Whether an outlet row represents a RE-CAPTURE (resubmit) rather than a fresh capture
 * (D11). A rejected capture routes through the resubmit endpoint (its prior row already
 * occupies `@@unique([clientId, outletId, windowKey])`, so a fresh submitCapture 409s).
 *
 * Keys on the capture STATUS being REJECTED with a captureId present — NOT on
 * `windowState`, because a rejected capture whose window has since CLOSED surfaces as
 * `windowState:'late'` (not `'rejected'`) while still being a REJECTED row that must
 * resubmit. Falls back to `windowState ∈ {rejected, late}` + captureId when `status`
 * is absent (older payloads).
 */
export function isResubmitCapture(
  outlet: Pick<SalesEligibleOutlet, 'status' | 'captureId' | 'windowState'>,
): boolean {
  if (!outlet.captureId) return false;
  // CHANGES_REQUESTED (per-photo re-capture) routes through resubmit exactly like REJECTED.
  if (outlet.status != null) {
    return outlet.status === 'REJECTED' || outlet.status === 'CHANGES_REQUESTED';
  }
  return (
    outlet.windowState === 'rejected' ||
    outlet.windowState === 'changes_requested' ||
    outlet.windowState === 'late'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sales dashboard — per-rep visibility summary of the CURRENT window (Bajaj card)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five dashboard-summary buckets an in-scope outlet's current-window capture falls
 * into, derived from the capture `status` + per-photo `photoReviews`:
 *   approved  — capture fully APPROVED (window satisfied)
 *   partial   — a multi-photo capture with ≥1 photo APPROVED and ≥1 REJECTED (status
 *               CHANGES_REQUESTED with a MIXED review): some photos cleared, the rep must
 *               re-capture only the flagged one(s)
 *   in_review — SUBMITTED, awaiting review (nothing rejected yet; a photo may be approved
 *               with others still pending)
 *   pending   — no capture submitted yet for the window
 *   rejected  — the whole capture REJECTED, or CHANGES_REQUESTED with NO photo approved
 *
 * NOTE (deliberate): this keys off review STATUS only, not the window-closed "late" state —
 * a missed/late outlet with no capture still reads as `pending` (there is no "overdue"
 * bucket on this card by design).
 */
export type VisibilitySummaryBucket =
  | 'approved'
  | 'partial'
  | 'in_review'
  | 'pending'
  | 'rejected';

/** Classify one in-scope outlet's current-window capture into a summary bucket. */
export function classifyVisibilityCapture(o: {
  status?: VisibilityCaptureStatus | null;
  photoReviews?: VisibilityPhotoReviews | null;
}): VisibilitySummaryBucket {
  const status = o.status ?? null;
  if (status === null) return 'pending';
  if (status === 'APPROVED') return 'approved';
  if (status === 'SUBMITTED') return 'in_review';
  if (status === 'REJECTED') return 'rejected';
  // CHANGES_REQUESTED: at least one required photo was rejected. It is "partially approved"
  // only when another photo was actually APPROVED; otherwise it reads as a plain rejection.
  const anyApproved = Object.values(o.photoReviews ?? {}).some((r) => r?.status === 'APPROVED');
  return anyApproved ? 'partial' : 'rejected';
}

/** Per-bucket counts (+ total) for the dashboard visibility summary card. */
export interface VisibilitySummaryCounts {
  total: number;
  approved: number;
  partial: number;
  in_review: number;
  pending: number;
  rejected: number;
}

/** Aggregate the sales-eligible outlets of the CURRENT window into summary-bucket counts. */
export function summarizeVisibilityCaptures(
  outlets: ReadonlyArray<Pick<SalesEligibleOutlet, 'status' | 'photoReviews'>>,
): VisibilitySummaryCounts {
  const counts: VisibilitySummaryCounts = {
    total: outlets.length,
    approved: 0,
    partial: 0,
    in_review: 0,
    pending: 0,
    rejected: 0,
  };
  for (const o of outlets) counts[classifyVisibilityCapture(o)]++;
  return counts;
}

/** GET /sales/eligible response — the current window + its in-scope outlets. */
export interface SalesEligibleResponse {
  windowKey: string;
  window: { startDay: number; endDay: number };
  /** Whether the caller's sales level is in the tenant's allowedSalesLevels. */
  levelAllowed: boolean;
  outlets: SalesEligibleOutlet[];
}

/** One window row of the outlet-view "Visibility — this period" card (D13). */
export interface OutletStatusWindow {
  windowKey: string;
  startDay: number;
  endDay: number;
  closed: boolean;
  captureId: string | null;
  status: VisibilityCaptureStatus | null;
  currentVersion: number | null;
  rejectionReason: string | null;
  /** Per-CAMERA-field review state of this window's capture (present for CHANGES_REQUESTED). */
  photoReviews?: VisibilityPhotoReviews | null;
  state: CaptureUiState;
}

/** GET /outlet/:outletId/status response (D13). */
export interface OutletStatusResponse {
  outlet: {
    outletId: string;
    outletCode: string;
    outletName: string;
    outletType: { code: string; name: string } | null;
  };
  inScope: boolean;
  canCapture: boolean;
  windows: OutletStatusWindow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture submit (POST /capture, POST /captures/:id/resubmit)
// ─────────────────────────────────────────────────────────────────────────────

/** A stored VisibilityCapture row (as returned in a submit / list result). */
export interface VisibilityCapture {
  id: string;
  clientId: string;
  outletId: string;
  outletCode: string;
  outletName: string;
  windowKey: string;
  status: VisibilityCaptureStatus;
  currentVersion: number;
  formVersion: number;
  formValues: Record<string, unknown> | null;
  captureLat: number | null;
  captureLng: number | null;
  captureAccuracy: number | null;
  geoFenceOk: boolean | null;
  distanceMeters: number | null;
  submittedBySalesUserId?: string | null;
  approvedByUserId?: string | null;
  rejectionReasonCode?: VisibilityRejectReasonCode | string | null;
  rejectionReason?: string | null;
  /** Per-CAMERA-field review state (per-photo approval). Absent on legacy rows (= all pending). */
  photoReviews?: VisibilityPhotoReviews | null;
  capturedAt?: string | null;
  receivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** The result of a successful submit / resubmit (POST /capture, /captures/:id/resubmit). */
export interface SubmitCaptureResult {
  capture: VisibilityCapture;
  version: number;
  geoFenceOk: boolean | null;
  distanceMeters: number | null;
  /** Server-side flags surfaced to the rep (e.g. "late", "geo-fence unverifiable", "low accuracy"). */
  flags: string[];
  /** True when a submitted photo hash collides with an existing capture's photo. */
  duplicatePhoto: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin review queue (GET /captures, GET /captures/:id)
// ─────────────────────────────────────────────────────────────────────────────

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

/** One shaped row in the admin review queue (GET /captures). */
export interface VisibilityCaptureRow {
  id: string;
  outletId: string;
  outletCode: string;
  outletName: string;
  windowKey: string;
  status: VisibilityCaptureStatus;
  currentVersion: number;
  geoFenceOk: boolean | null;
  distanceMeters: number | null;
  captureAccuracy: number | null;
  capturedAt: string | null;
  receivedAt: string | null;
  rejectionReasonCode: VisibilityRejectReasonCode | string | null;
  submittedBy: { id: string; employeeCode: string } | null;
}

export interface VisibilityCaptureListResponse {
  captures: VisibilityCaptureRow[];
  pagination: Pagination;
}

/**
 * Per-photo geo-fence status vs the outlet reference geo (mirrors the backend
 * `PhotoFenceStatus` in api/src/visibility/geo-fence.helper.ts). `unverifiable` =
 * the photo has no geo OR the outlet has no reference geo.
 */
export type PhotoFenceStatus = 'inside' | 'outside' | 'unverifiable';

/** A media ref surfaced in a capture detail (auth-gated view path). */
export interface VisibilityMediaRef {
  fieldId: string;
  label: string;
  type: string;
  key: string;
  /** Backend-provided auth-gated path (`/v1/...`); rewrite to `/api/...` for the browser. */
  viewPath: string;
  /** Per-photo shutter-time GPS fix (per-photo geotag), when this photo carries one. */
  geo?: GpsCapture;
  /** Per-photo fence status vs the outlet reference geo — set only for fence-required photos. */
  fenceStatus?: PhotoFenceStatus;
  /** This photo's review decision (per-photo approval); absent = not yet reviewed (pending). */
  review?: VisibilityPhotoReview | null;
}

/** A geo ref (a GPS_POINT field's captured value) in a capture detail. */
export interface VisibilityGeoRef {
  fieldId: string;
  label: string;
  value: unknown;
}

/** A submission snapshot in a capture's version history (append-only, D11). */
export interface VisibilityCaptureSubmission {
  id: string;
  clientId: string;
  captureId: string;
  outletId: string;
  windowKey: string;
  version: number;
  status: VisibilityCaptureStatus;
  formValues: Record<string, unknown> | null;
  formVersion: number;
  captureLat: number | null;
  captureLng: number | null;
  captureAccuracy: number | null;
  distanceMeters: number | null;
  geoFenceOk: boolean | null;
  submittedBySalesUserId?: string | null;
  /** Snapshot of the per-CAMERA-field review state at this version (history/trace). */
  photoReviews?: VisibilityPhotoReviews | null;
  createdAt: string;
}

/** A duplicate-photo match (another capture sharing an image hash). */
export interface VisibilityDuplicateMatch {
  hash: string;
  captureId: string;
  outletCode: string;
  windowKey: string;
}

/** Single-capture detail (GET /captures/:id) — the admin approval drawer payload. */
export interface VisibilityCaptureDetail extends VisibilityCapture {
  media: VisibilityMediaRef[];
  geo: VisibilityGeoRef[];
  geoFence: {
    geoFenceOk: boolean | null;
    distanceMeters: number | null;
    captureLat: number | null;
    captureLng: number | null;
    captureAccuracy: number | null;
  };
  duplicateMatches: VisibilityDuplicateMatch[];
  submissions: VisibilityCaptureSubmission[];
  submittedBy: { id: string; employeeCode: string } | null;
  approvedBy: { id: string; name: string } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coverage report (GET /report, /report/tenant)
// ─────────────────────────────────────────────────────────────────────────────

/** Coverage summary for a window — captured / pending / rejected / missed + %. */
export interface VisibilityCoverageSummary {
  denominator: number;
  captured: number;
  pending: number;
  rejected: number;
  missed: number;
  coveragePct: number;
}

/** GET /report (+ /report/tenant) — window coverage report (D15). */
export interface VisibilityReport {
  windowKey: string;
  windowClosed: boolean;
  frequencyPerMonth: number;
  outletScope: string[];
  summary: VisibilityCoverageSummary;
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE form-logic helpers — the SAME rules the backend enforces at submit
// (mirrors evaluateClause / evaluateVisibleWhen / isFieldRequired /
//  validateSubmittedValues in api/src/visibility/visibility-form.helper.ts)
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
export function isFieldVisible(
  field: VisibilityFormField,
  values: Record<string, unknown>,
): boolean {
  if (!field.visibleWhen) return true;
  return evaluateClause(field.visibleWhen, values);
}

/**
 * Whether a VISIBLE field must have a value on this submission. `required:true` is
 * always required; a `requiredWhen` clause makes it required only while true.
 */
export function isFieldRequired(
  field: VisibilityFormField,
  values: Record<string, unknown>,
): boolean {
  if (field.required) return true;
  if (field.requiredWhen) return evaluateClause(field.requiredWhen, values);
  return false;
}

/** Ordered, display-safe field list (sorted by `order`). */
export function orderedFields(schema: VisibilityFormSchema): VisibilityFormField[] {
  return [...(schema.fields ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

const TRUE_TOKENS = new Set(['true', '1', 'yes', 'on']);
const FALSE_TOKENS = new Set(['false', '0', 'no', 'off']);

function isBlank(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    (typeof v === 'string' && v.trim() === '') ||
    (Array.isArray(v) && v.length === 0)
  );
}

/**
 * Client-side mirror of the backend `validateSubmittedValues` — returns `{ errors }`
 * (empty = valid). Run BEFORE calling the capture endpoint so the common cases surface
 * inline; the backend remains the source of truth.
 *
 * Rules (mirroring the backend + the scheme validator's schema-integrity guard):
 *   - captureGpsOnSubmit is true but the form has no GPS_POINT field → error.
 *   - a visible required field (incl. a required GPS_POINT) with no value → error.
 *   - type checks: NUMBER / DATE / TOGGLE / DROPDOWN / MULTI_SELECT.
 *   - visibleWhen-hidden fields are neither validated nor required.
 */
export function validateVisibilityValues(
  schema: VisibilityFormSchema,
  values: Record<string, unknown>,
): { errors: string[] } {
  const errors: string[] = [];

  // Schema-integrity mirror: captureGpsOnSubmit promises a fix on submit, but with no
  // GPS_POINT field to hold it the flag is a silent no-op.
  if (schema.captureGpsOnSubmit === true && !schema.fields.some((f) => f.type === 'GPS_POINT')) {
    errors.push('Capture GPS on submit is enabled but the form has no GPS location field.');
  }

  for (const field of schema.fields ?? []) {
    if (!isFieldVisible(field, values)) continue;

    const raw = values[field.id];
    const empty = field.type === 'TOGGLE' ? raw === null || raw === undefined : isBlank(raw);

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
        if (isNaN(new Date(String(raw)).getTime()))
          errors.push(`"${field.label}" must be a valid date.`);
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
          : String(raw)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
        const allowed = new Set((field.options ?? []).map(String));
        const bad = arr.find((v) => !allowed.has(v));
        if (bad !== undefined) errors.push(`"${field.label}" contains an invalid option "${bad}".`);
        break;
      }
      default:
        break;
    }
  }

  return { errors };
}
