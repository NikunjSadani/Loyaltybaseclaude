/**
 * lib/visibility.ts — CANONICAL typed client for the Visibility (POSM) feature.
 *
 * Covers the entire §5/§6 API surface (VISIBILITY-POSM-DESIGN.md): admin config/form/
 * outlets/media, sales eligible/outlet-status/capture/resubmit, GIFSY review
 * list/get/approve/reject, and reports (GIFSY / tenant read-only / export). Every method
 * returns the shared `ApiResponse<T>` from api-client (`{ success, data }`), typed against
 * the backend response shapes mirrored in `lib/visibility-types.ts`.
 *
 * The browser calls same-origin `/api/visibility/*`, which the Next rewrite forwards to
 * the backend's `/v1/visibility/*` (see next.config.ts: `/api/:path*` → `/v1/:path*`).
 *
 * AUTH: the edge proxy injects the Bearer (from the httpOnly `token` cookie) and the
 * `x-active-partner-id` header on every `/api/*` request, and STRIPS any client-supplied
 * value first. The FE therefore CANNOT and MUST NOT set those headers.
 *
 * Cloned-and-adapted from `lib/schemes.ts` — it does NOT import from or depend on the
 * scheme feature.
 */

import { api, type ApiResponse } from '@/lib/api-client';
import type {
  OutletStatusResponse,
  Pagination,
  SalesEligibleResponse,
  SubmitCaptureResult,
  VisibilityCapture,
  VisibilityCaptureDetail,
  VisibilityCaptureListResponse,
  VisibilityCaptureStatus,
  VisibilityConfig,
  VisibilityFormSchema,
  VisibilityRejectReasonCode,
  VisibilityReport,
} from '@/lib/visibility-types';

const BASE = '/api/visibility';

/* ─── Multipart helper (FormData — cannot use api.post which forces JSON) ────── */

/**
 * POST a multipart/form-data body. We must NOT set Content-Type manually — the browser
 * adds the multipart boundary. Same-origin fetch carries the auth cookie, and the proxy
 * injects the Bearer, so no auth header is needed here. Returns the same `{ success, data }`
 * envelope shape as api-client.
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

/* ─── Request payload / query shapes (§6) ────────────────────────────────────── */

/** PUT /config — the whole per-tenant visibility config (all fields required). */
export interface SetVisibilityConfigInput {
  outletScope: string[];
  frequencyPerMonth: number;
  allowedSalesLevels: string[];
  geoFence: { enabled: boolean; radiusMeters: number };
}

/** PUT /form — replace the versioned capture form. */
export interface UpsertVisibilityFormInput {
  formSchema: VisibilityFormSchema;
}

/** GET /outlets — admin outlet-in-scope listing filters. */
export interface ScopeOutletsQuery {
  q?: string;
  zone?: string;
  state?: string;
}

/** POST /capture — a rep submits a capture for one in-scope outlet. */
export interface SubmitCaptureInput {
  outletId: string;
  formValues?: Record<string, unknown>;
}

/** POST /captures/:id/resubmit — re-capture after a rejection. */
export interface ResubmitCaptureInput {
  formValues?: Record<string, unknown>;
}

/** GET /captures — GIFSY review-queue filters. */
export interface AdminListCapturesQuery {
  windowKey?: string;
  status?: VisibilityCaptureStatus;
  outletCode?: string;
  page?: number;
  limit?: number;
}

/** POST /captures/:id/reject — controlled reason code + optional detail. */
export interface RejectCaptureInput {
  reasonCode: VisibilityRejectReasonCode;
  reason?: string;
}

/* ─── Response payload shapes (§6) ───────────────────────────────────────────── */

export interface VisibilityConfigResult {
  visibilityConfig: VisibilityConfig;
}

/** The stored VisibilityForm row (current version); null until authored. */
export interface VisibilityFormRecord {
  id: string;
  clientId: string;
  version: number;
  formSchema: VisibilityFormSchema;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertVisibilityFormResult {
  form: VisibilityFormRecord;
  formVersion: unknown;
}

/** One outlet row in the admin in-scope listing (GET /outlets). */
export interface ScopeOutletRow {
  id: string;
  outletCode: string;
  name: string;
  zone: string | null;
  state: string | null;
  outletType: { code: string; name: string } | null;
}

export interface ScopeOutletsResult {
  outlets: ScopeOutletRow[];
  outletScope: string[];
  total: number;
}

/** POST /media — the stored object key result. */
export interface MediaUploadResult {
  key: string;
  fileUrl: string;
  mimeType: string;
  fileSizeBytes: number;
}

/* ─── Media view-path helpers (auth-gated app route, NOT a signed URL) ───────── */

/** Build the browser-facing auth-gated media view URL for a stored object key. */
export function mediaViewUrl(key: string): string {
  return `${BASE}/captures/media?key=${encodeURIComponent(key)}`;
}

/**
 * Rewrite a backend-provided `viewPath` (`/v1/visibility/captures/media?key=…`) to the
 * browser-facing `/api/…` origin. Idempotent for already-`/api/` paths.
 */
export function rewriteMediaViewPath(viewPath: string): string {
  return viewPath.replace(/^\/v1\//, '/api/');
}

/* ─── The canonical client ───────────────────────────────────────────────────── */

export const visibilityApi = {
  // ── Admin authoring (GIFSY_ADMIN) ──────────────────────────────────────────
  getConfig() {
    return api.get<VisibilityConfig>(`${BASE}/config`);
  },
  setConfig(input: SetVisibilityConfigInput) {
    return api.put<VisibilityConfigResult>(`${BASE}/config`, input);
  },
  getForm() {
    return api.get<VisibilityFormRecord | null>(`${BASE}/form`);
  },
  upsertForm(input: UpsertVisibilityFormInput) {
    return api.put<UpsertVisibilityFormResult>(`${BASE}/form`, input);
  },
  listOutlets(query: ScopeOutletsQuery = {}) {
    return api.get<ScopeOutletsResult>(`${BASE}/outlets${qs(query as Record<string, unknown>)}`);
  },
  /** GIFSY upload — admin form-builder sample/reference images (multipart `file` → key). */
  uploadMedia(file: File | Blob, filename?: string) {
    const form = new FormData();
    form.append('file', file, filename ?? (file instanceof File ? file.name : 'capture'));
    return postMultipart<MediaUploadResult>(`${BASE}/media`, form);
  },

  // ── Sales capture (front-line sales roles) ─────────────────────────────────
  /** SALES upload — a rep's capture photo (multipart `file` → stored object key). */
  uploadSalesMedia(file: File | Blob, filename?: string) {
    const form = new FormData();
    form.append('file', file, filename ?? (file instanceof File ? file.name : 'capture'));
    return postMultipart<MediaUploadResult>(`${BASE}/sales/media`, form);
  },
  /** In-scope downline outlets + current-window status (reach + level scoped). */
  getSalesEligible() {
    return api.get<SalesEligibleResponse>(`${BASE}/sales/eligible`);
  },
  /** Sales-safe read of the ACTIVE capture form schema (GIFSY owns authoring). */
  getSalesForm() {
    return api.get<VisibilityFormRecord | null>(`${BASE}/sales/form`);
  },
  /** One outlet: all windows of the current month, each with its capture status (D13). */
  getOutletStatus(outletId: string) {
    return api.get<OutletStatusResponse>(`${BASE}/outlet/${outletId}/status`);
  },
  /** Submit a capture (window-key + geo-fence computed server-side). */
  submitCapture(input: SubmitCaptureInput) {
    return api.post<SubmitCaptureResult>(`${BASE}/capture`, input);
  },
  /** Re-capture after a rejection (D11). */
  resubmitCapture(captureId: string, input: ResubmitCaptureInput) {
    return api.post<SubmitCaptureResult>(`${BASE}/captures/${captureId}/resubmit`, input);
  },

  // ── Review queue (GIFSY_ADMIN) ─────────────────────────────────────────────
  listCaptures(query: AdminListCapturesQuery = {}) {
    return api.get<VisibilityCaptureListResponse>(
      `${BASE}/captures${qs(query as Record<string, unknown>)}`,
    );
  },
  getCapture(captureId: string) {
    return api.get<{ capture: VisibilityCaptureDetail }>(`${BASE}/captures/${captureId}`);
  },
  approveCapture(captureId: string) {
    return api.post<{ capture: VisibilityCapture }>(`${BASE}/captures/${captureId}/approve`, {});
  },
  rejectCapture(captureId: string, input: RejectCaptureInput) {
    return api.post<{ capture: VisibilityCapture }>(
      `${BASE}/captures/${captureId}/reject`,
      input,
    );
  },

  // ── Reports (GIFSY + tenant read-only, D15) ────────────────────────────────
  getReport(windowKey?: string) {
    return api.get<VisibilityReport>(`${BASE}/report${qs({ windowKey })}`);
  },
  getTenantReport(windowKey?: string) {
    return api.get<VisibilityReport>(`${BASE}/report/tenant${qs({ windowKey })}`);
  },
  /** Browser-facing URL of the xlsx export (auth-gated; navigate/anchor to download). */
  exportUrl(windowKey?: string): string {
    return `${BASE}/report/export${qs({ windowKey })}`;
  },
  /** Fetch the xlsx export as a blob and trigger a browser download. */
  async downloadExport(
    windowKey?: string,
  ): Promise<{ success: true } | { success: false; error: string }> {
    try {
      const res = await fetch(this.exportUrl(windowKey));
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
      const filename = match?.[1] ?? `visibility_captures${windowKey ? `_${windowKey}` : ''}.xlsx`;
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
};

export type { Pagination };

/* ─── Query-string builder (drops undefined/empty) ───────────────────────────── */

function qs(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}
