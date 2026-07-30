/**
 * lib/schemes.ts — CANONICAL typed client for the Scheme Data-Collection feature.
 *
 * Covers the entire §13.4 API surface (admin authoring + enrollee capture + reports
 * + notifications). Every method returns the shared `ApiResponse<T>` from api-client
 * (`{ success, data }`), typed against the backend response shapes mirrored in
 * `lib/scheme-types.ts`. The browser calls same-origin `/api/schemes/*`, which the
 * Next rewrite forwards to the backend's `/v1/schemes/*` (see next.config.ts).
 *
 * AUTH / ACTIVE PARTNER: the edge proxy injects the Bearer (from the httpOnly `token`
 * cookie) and the `x-active-partner-id` header (from the httpOnly `active_partner_id`
 * cookie) on every `/api/*` request, and STRIPS any client-supplied value first. The
 * FE therefore CANNOT and MUST NOT set those headers — the active partner is chosen
 * via the picker (setActivePartner in lib/active-partner-actions.ts). `context.
 * activePartnerId` in the renderer is informational only.
 *
 * The reward-era demo/mock/localStorage exports (DEMO_SEED_SCHEMES, seedAdminSchemes,
 * getPendingSchemes, …) and the transitional `@deprecated LEGACY-COMPAT` shims
 * (fetchAllSchemes, saveSalesEnrollment, formatDeadline, hasEnrollmentForm, …) are
 * RETIRED — every partner/sales/admin page now codes against `schemeApi` directly.
 */

import { api, type ApiResponse } from '@/lib/api-client';
import type {
  AudienceConfig,
  AudienceFilter,
  AudienceMode,
  CampaignType,
  EligibleScheme,
  EnrollmentFormSchema,
  EnrollmentMediaRef,
  EnrollmentGeoRef,
  EnrollmentMode,
  EnrollResult,
  PartnerEligibleScheme,
  SalesTarget,
  SalesTargetStatus,
  SchemeEnrollment,
  SchemeRecord,
  SchemeStatus,
  SchemeSubmission,
} from '@/lib/scheme-types';

const BASE = '/api/schemes';

/* ─── Multipart helper (FormData — cannot use api.post which forces JSON) ────── */

/**
 * POST a multipart/form-data body. We must NOT set Content-Type manually — the
 * browser adds the multipart boundary. Same-origin fetch carries the auth cookie,
 * and the proxy injects the Bearer, so no auth header is needed here. Returns the
 * same `{ success, data }` envelope shape as api-client.
 */
async function postMultipart<T>(url: string, form: FormData): Promise<ApiResponse<T>> {
  try {
    const res = await fetch(url, { method: 'POST', body: form });
    const body = await res.json();
    if (!res.ok) return { success: false, error: body?.error ?? res.statusText };
    return body as ApiResponse<T>;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

/* ─── Request payload shapes (§13.4) ─────────────────────────────────────────── */

export interface CreateSchemeInput {
  code: string;
  name: string;
  description?: string;
  startDate: string; // ISO
  endDate: string; // ISO
  imageUrl?: string;
  metadata?: Record<string, unknown>;
  /** DRAFT (default) or ACTIVE (D6). */
  status?: 'DRAFT' | 'ACTIVE';
}

export interface UpdateSchemeInput {
  name?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  imageUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface UpsertEnrollmentFormInput {
  campaignType: CampaignType;
  formSchema: EnrollmentFormSchema;
}

export interface SetAudienceInput {
  mode: AudienceMode;
  /** Applies to matched real outlets only (D21). */
  selfEnrollAllowed: boolean;
  /** FILTER only: true → snapshot roster at save; false → live-rule (lazy rows). */
  frozen: boolean;
  /** Required in FILTER mode; ignored in EXCEL mode. */
  filter?: AudienceFilter;
}

export interface RosterUploadOptions {
  idColumn?: string;
  nameColumn?: string;
  taggedEmployeeColumn?: string;
}

export type { EnrollResult } from './scheme-types';

export interface AdminListEnrollmentsQuery {
  status?: 'SUBMITTED' | 'REJECTED';
  outletTypeId?: string;
  programName?: string;
  zone?: string;
  state?: string;
  from?: string; // ISO date
  to?: string; // ISO date
  page?: number;
  limit?: number;
}

/** Query for the rep's reachable-targets list (GET .../sales-targets). */
export interface SalesTargetsQuery {
  status?: SalesTargetStatus;
  page?: number;
  limit?: number;
}

export type BroadcastChannel = 'WHATSAPP' | 'SMS';
export type BroadcastScope = 'OUTLETS' | 'SALES' | 'BOTH';

export interface BroadcastRecipientFilter {
  zones?: string[];
  programNames?: string[];
  programCategories?: string[];
  outletTypeIds?: string[];
  states?: string[];
  taggedSalesUserIds?: string[];
}

export interface BroadcastInput {
  channel: BroadcastChannel;
  templateId: string;
  recipientScope: BroadcastScope;
  recipientFilter?: BroadcastRecipientFilter;
  bodyValues?: string[];
}

/** Common subject-resolution fields for enroll / OTP (§13.4). */
export interface SchemeSubject {
  enrollmentMode?: EnrollmentMode;
  /** An existing roster row (Excel Mode B / frozen snapshot / prior lazy row). */
  targetSchemeOutletId?: string;
  /** A live-rule outlet id to lazily add + enroll (SALES matched outlet). */
  targetOutletRef?: string;
}

export interface EnrollInput extends SchemeSubject {
  formValues?: Record<string, unknown>;
  /** The typed mobile for an editable PHONE_OTP field (ignored for pinned outlets). */
  mobile?: string;
}

export interface ResubmitInput {
  formValues?: Record<string, unknown>;
  mobile?: string;
}

export interface SendOtpInput extends SchemeSubject {
  mobile?: string;
}

export interface VerifyOtpInput extends SchemeSubject {
  mobile?: string;
  otp: string;
}

/* ─── Response payload shapes (§13.4) ────────────────────────────────────────── */

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface RosterRow {
  id: string;
  clientId: string;
  schemeId: string;
  outletRef: string;
  outletName: string;
  matchedOutletId: string | null;
  matchedPartnerId: string | null;
  taggedSalesUserId: string | null;
  prefillValues: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  enrollment?: { id: string; status: string; currentVersion: number } | null;
}

/** Per-input-row disposition for the downloadable upload report (Phase 2). */
export interface RosterRowReport {
  rowIndex: number;
  outletRef: string;
  outletName: string;
  taggedEmployeeCode: string;
  disposition: 'SAVED' | 'DUPLICATE_DROPPED';
  linkage: 'MATCHED' | 'STANDALONE' | '';
  taggedEmployeeFound: boolean | null;
}

export interface RosterUploadResult {
  totalRows: number;
  upserted: number;
  matchedCount: number;
  standaloneCount: number;
  duplicateRefs: string[];
  unmatchedEmployeeCodes: string[];
  /** Non-blank rows dropped for a missing outlet id (accounted for in the report). */
  skippedRows?: number;
  /** Per-input-row disposition (every file row) — drives the full report sheet. */
  rows?: RosterRowReport[];
}

export interface AudienceResult {
  audienceConfig: AudienceConfig;
  materializedCount: number;
}

/** One shaped roster row in the admin captured-data list (§ shapeRosterRow). */
export interface AdminEnrollmentRow {
  schemeOutletId: string;
  outletRef: string;
  outletName: string;
  standalone: boolean;
  matchedOutlet: {
    id: string;
    name: string;
    outletCode: string;
    outletTypeId: string | null;
    programName: string | null;
    programCategory: string | null;
    zone: string | null;
    state: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  matchedPartner: { id: string; businessName: string | null; phone: string | null } | null;
  taggedSalesUser: { id: string; employeeCode: string } | null;
  prefillValues: Record<string, unknown> | null;
  enrollment: SchemeEnrollment | null;
}

export interface AdminEnrollmentDetail extends SchemeEnrollment {
  schemeOutlet: AdminEnrollmentRow['matchedOutlet'] & Record<string, unknown>;
  submissions: SchemeSubmission[];
  media: EnrollmentMediaRef[];
  geo: EnrollmentGeoRef[];
  /**
   * Field id → label/type for the form version this submission was captured against
   * (H5). Lets the admin drawer render human labels for captured values instead of raw
   * field ids. Optional — absent when captured against a form with no snapshot.
   */
  formFields?: Array<{ id: string; label: string; type: string }>;
}

/** GET :id/prefill-sources — the form-builder "Prefill from" dropdown options (H1). */
export interface PrefillSources {
  /** Distinct roster Excel prefill columns present on this scheme's roster. */
  excelColumns: string[];
  /** The curated Outlet-master fields (dual-source prefill for matched loyalty outlets). */
  outletFields: Array<{ key: string; label: string }>;
}

/** GET :id/facet-values — distinct outlet-master facets for the audience + report pickers. */
export interface FacetValues {
  zones: string[];
  programNames: string[];
  programCategories: string[];
  states: string[];
  outletTypes: Array<{ id: string; name: string }>;
}

/** POST :id/broadcast/preview — the recipient count for a broadcast, WITHOUT sending. */
export interface BroadcastPreview {
  recipientCount: number;
}

export interface OtpSendResult {
  success: boolean;
  expiresIn: number;
  /** true → the field is pinned to the approved outlet owner's number (D16). */
  locked: boolean;
  schemeOutletId: string;
  phoneMasked: string;
}

export interface MediaUploadResult {
  key: string;
  fileUrl: string;
  mimeType: string;
  fileSizeBytes: number;
}

export interface ReportBucket {
  key: string;
  rosterCount: number;
  enrolledCount: number;
}

export interface SchemeReport {
  scheme: { id: string; code: string; name: string; status: string };
  audienceMode: AudienceMode | null;
  frozen: boolean;
  coverageDenominator: number;
  summary: {
    rosterCount: number;
    enrolledCount: number;
    submittedCount: number;
    rejectedCount: number;
    notEnrolledCount: number;
    coveragePct: number;
  };
  byStatus: { SUBMITTED: number; REJECTED: number; NOT_ENROLLED: number };
  byZone: ReportBucket[];
  byProgram: ReportBucket[];
  byOutletType: ReportBucket[];
}

export interface TenantSchemeReport extends SchemeReport {
  rows: Array<{
    outletRef: string;
    outletName: string;
    matched: boolean;
    zone: string | null;
    program: string | null;
    outletType: string | null;
    status: string;
  }>;
}

export interface SchemeBroadcastRow {
  id: string;
  clientId: string;
  schemeId: string;
  channel: string;
  templateId: string;
  recipientScope: string;
  recipientFilter: BroadcastRecipientFilter | null;
  sentCount: number;
  failedCount: number;
  sentByUserId: string | null;
  createdAt: string;
}

export interface BroadcastResult {
  broadcast: SchemeBroadcastRow;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
}

/* ─── Media view-path helpers (D30 — auth-gated app route, NOT a signed URL) ─── */

/** Build the browser-facing auth-gated media view URL for a stored object key. */
export function mediaViewUrl(schemeId: string, key: string): string {
  return `${BASE}/${schemeId}/enrollments/media?key=${encodeURIComponent(key)}`;
}

/**
 * Rewrite a backend-provided `viewPath` (`/v1/schemes/…/media?key=…`) to the
 * browser-facing `/api/…` origin. Idempotent for already-`/api/` paths.
 */
export function rewriteMediaViewPath(viewPath: string): string {
  return viewPath.replace(/^\/v1\//, '/api/');
}

/* ─── The canonical client ───────────────────────────────────────────────────── */

export const schemeApi = {
  // ── Admin authoring (GIFSY_ADMIN) ──────────────────────────────────────────
  create(input: CreateSchemeInput) {
    return api.post<{ scheme: SchemeRecord }>(BASE, input);
  },
  update(schemeId: string, input: UpdateSchemeInput) {
    return api.patch<{ scheme: SchemeRecord }>(`${BASE}/${schemeId}`, input);
  },
  setStatus(schemeId: string, status: SchemeStatus) {
    return api.patch<{ scheme: SchemeRecord }>(`${BASE}/${schemeId}/status`, { status });
  },
  upsertEnrollmentForm(schemeId: string, input: UpsertEnrollmentFormInput) {
    return api.put<{ enrollmentForm: unknown; formVersion: unknown }>(
      `${BASE}/${schemeId}/enrollment-form`,
      input,
    );
  },
  setAudience(schemeId: string, input: SetAudienceInput) {
    return api.post<AudienceResult>(`${BASE}/${schemeId}/audience`, input);
  },
  /** Mode-B roster Excel upload (multipart `file` + optional column-name overrides). */
  uploadRoster(schemeId: string, file: File, opts: RosterUploadOptions = {}) {
    const form = new FormData();
    form.append('file', file);
    if (opts.idColumn) form.append('idColumn', opts.idColumn);
    if (opts.nameColumn) form.append('nameColumn', opts.nameColumn);
    if (opts.taggedEmployeeColumn) form.append('taggedEmployeeColumn', opts.taggedEmployeeColumn);
    return postMultipart<RosterUploadResult>(`${BASE}/${schemeId}/roster/upload`, form);
  },
  getRoster(schemeId: string, query: { page?: number; limit?: number } = {}) {
    return api.get<{ roster: RosterRow[]; pagination: Pagination }>(
      `${BASE}/${schemeId}/roster${qs(query)}`,
    );
  },
  /** The form-builder "Prefill from" dropdown options: roster Excel columns + outlet-field catalog (H1). */
  getPrefillSources(schemeId: string) {
    return api.get<PrefillSources>(`${BASE}/${schemeId}/prefill-sources`);
  },
  /** Distinct outlet-master facet values for the audience builder + report filters. */
  getFacetValues(schemeId: string) {
    return api.get<FacetValues>(`${BASE}/${schemeId}/facet-values`);
  },
  listEnrollments(schemeId: string, query: AdminListEnrollmentsQuery = {}) {
    return api.get<{ enrollments: AdminEnrollmentRow[]; pagination: Pagination }>(
      `${BASE}/${schemeId}/enrollments${qs(query as Record<string, unknown>)}`,
    );
  },
  getEnrollment(schemeId: string, enrollmentId: string) {
    return api.get<{ enrollment: AdminEnrollmentDetail }>(
      `${BASE}/${schemeId}/enrollments/${enrollmentId}`,
    );
  },
  reject(schemeId: string, enrollmentId: string, reason: string) {
    return api.post<{ enrollment: SchemeEnrollment }>(
      `${BASE}/${schemeId}/enrollments/${enrollmentId}/reject`,
      { reason },
    );
  },

  // ── Notifications (GIFSY_ADMIN, D29) ───────────────────────────────────────
  broadcast(schemeId: string, input: BroadcastInput) {
    return api.post<BroadcastResult>(`${BASE}/${schemeId}/broadcast`, input);
  },
  listBroadcasts(schemeId: string) {
    return api.get<{ broadcasts: SchemeBroadcastRow[] }>(`${BASE}/${schemeId}/broadcasts`);
  },
  /** Dry-run a broadcast: the de-duped recipient count for a confirm dialog (no send). */
  previewBroadcast(schemeId: string, input: BroadcastInput) {
    return api.post<BroadcastPreview>(`${BASE}/${schemeId}/broadcast/preview`, input);
  },

  // ── Reports (GIFSY_ADMIN + tenant read-only, D26/D30) ──────────────────────
  getReport(schemeId: string) {
    return api.get<SchemeReport>(`${BASE}/${schemeId}/report`);
  },
  getTenantReport(schemeId: string) {
    return api.get<TenantSchemeReport>(`${BASE}/${schemeId}/report/tenant`);
  },
  /** Browser-facing URL of the xlsx export (auth-gated; navigate/anchor to download). */
  exportUrl(schemeId: string): string {
    return `${BASE}/${schemeId}/report/export`;
  },
  /** Fetch the xlsx export as a blob and trigger a browser download. */
  async downloadExport(schemeId: string): Promise<{ success: true } | { success: false; error: string }> {
    try {
      const res = await fetch(this.exportUrl(schemeId));
      if (!res.ok) {
        let error = res.statusText;
        try {
          const body = await res.json();
          error = body?.error ?? error;
        } catch {
          /* non-JSON error body */
        }
        return { success: false, error };
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = /filename="?([^"]+)"?/.exec(disposition);
      const filename = match?.[1] ?? `scheme_${schemeId}_enrollments.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Download failed' };
    }
  },

  // ── Enrollee: eligible list + read-back ────────────────────────────────────
  /**
   * Eligible ACTIVE schemes for the active partner (x-active-partner-id set server-side).
   * Each scheme carries `mySchemeOutletId` — the matched fixed-roster row id (self-enroll
   * target) or null for a live-rule scheme.
   */
  listEligible() {
    return api.get<{ schemes: PartnerEligibleScheme[] }>(`${BASE}/enroll/eligible`);
  },

  // ── Sales rep: discovery (active in-window schemes + per-scheme reachable targets) ──
  /** Active, in-window schemes a rep can enroll into (form summary per scheme). */
  listSalesEligible() {
    return api.get<{ schemes: EligibleScheme[] }>(`${BASE}/sales/eligible`);
  },
  /** The rep's reachable targets for one scheme, each with its current enrollment status. */
  getSalesTargets(schemeId: string, query: SalesTargetsQuery = {}) {
    return api.get<{ targets: SalesTarget[]; pagination: Pagination }>(
      `${BASE}/${schemeId}/sales-targets${qs(query as Record<string, unknown>)}`,
    );
  },
  getMyEnrollment(schemeId: string) {
    return api.get<{
      schemeOutlet: {
        id: string;
        outletName: string;
        /**
         * Roster Excel prefill (D13 / Mode B) for this matched roster row, keyed by
         * each field's `prefillKey` (Excel column header) and/or field id. Optional —
         * absent/null when the row carries no prefill; the renderer then prefills nothing.
         */
        prefillValues?: Record<string, string> | null;
        /**
         * Dual-source prefill (UX-hardening): the matched outlet's Outlet-master field
         * values, keyed by each field's `outletField`, projected to the form's bound
         * outlet fields. Absent/null when the form binds none.
         */
        outletFieldValues?: Record<string, string> | null;
      };
      /** True when the matched outlet's owner is KYC-approved (renderer pre-pins the owner phone). */
      outletApproved?: boolean;
      /** Masked on-file owner phone for a KYC-approved matched outlet; null otherwise. */
      ownerPhoneMasked?: string | null;
      enrollment: SchemeEnrollment;
    }>(`${BASE}/${schemeId}/enrollment`);
  },

  // ── Enrollee: phone-OTP consent sub-flow (D16) ─────────────────────────────
  sendOtp(schemeId: string, input: SendOtpInput) {
    return api.post<OtpSendResult>(`${BASE}/${schemeId}/enrollment/otp-send`, input);
  },
  verifyOtp(schemeId: string, input: VerifyOtpInput) {
    return api.post<{ verified: boolean; phone: string }>(
      `${BASE}/${schemeId}/enrollment/otp-verify`,
      input,
    );
  },

  // ── Enrollee: media upload (multipart → stored object key) ──────────────────
  uploadMedia(schemeId: string, file: File | Blob, filename?: string) {
    const form = new FormData();
    form.append('file', file, filename ?? (file instanceof File ? file.name : 'capture'));
    return postMultipart<MediaUploadResult>(`${BASE}/${schemeId}/enrollment/media`, form);
  },

  // ── Enrollee: enroll + resubmit (versioned) ────────────────────────────────
  enroll(schemeId: string, input: EnrollInput) {
    return api.post<EnrollResult>(`${BASE}/${schemeId}/enrollment`, input);
  },
  resubmit(schemeId: string, enrollmentId: string, input: ResubmitInput) {
    return api.post<EnrollResult>(
      `${BASE}/${schemeId}/enrollments/${enrollmentId}/resubmit`,
      input,
    );
  },
};

/* ─── Query-string builder (drops undefined/empty) ───────────────────────────── */

function qs(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}
