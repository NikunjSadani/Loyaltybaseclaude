/**
 * Sales Import — typed wrappers for the §5.2 routes (plan §11 F-1). Every call returns the platform envelope
 * `ApiResponse<T>` (with `status` on failure) so pages can special-case 409 etc. FE paths are `/api/...`; the Next
 * proxy rewrites them to backend `/v1/...`.
 */
import { api, authHeader, type ApiResponse } from '@/lib/api-client';
import type {
  ApplyEnqueued,
  ApplyRequest,
  ApplyResult,
  SalesApplyJobDto,
  FocusAcceptanceList,
  FocusAcceptanceBulkRequest,
  FocusAcceptanceRequest,
  SalesColumnMapping,
  SalesHistoryCombos,
  SalesImportCombos,
  SalesImportDetail,
  SalesImportList,
  SalesImportPreview,
  SalesImportSummary,
  SalesKpiDefinitionDto,
  SalesKpiDefinitionList,
  SalesKpiDefinitionPatch,
  SalesKpiTestRequest,
  SalesKpiTestResult,
  SalesMonthRebuildProductListResult,
  SalesMonthRecalcPreview,
  SalesMonthRecalcRequest,
  SalesMonthReopenRequest,
  SalesMonthReopenResult,
  SalesMonthRow,
  SalesSegmentOptions,
} from './types';

/** The pre-release synchronous recalculate answer (one month result). */
type SalesMonthRecalcResultLegacy = import('./types').ApplyMonthResult;

const BASE = '/api/admin/sales-import';
const MONTHS = '/api/admin/sales-months';
const id = (s: string) => encodeURIComponent(s);

export const salesImportApi = {
  // Profile (column mapping)
  getProfile: () => api.get<SalesColumnMapping | null>(`${BASE}/profile`),
  saveProfile: (m: SalesColumnMapping) => api.put<SalesColumnMapping>(`${BASE}/profile`, m),

  // KPI definitions
  listKpis: () => api.get<SalesKpiDefinitionList>(`${BASE}/kpis`),
  createKpi: (d: SalesKpiDefinitionDto) => api.post<SalesKpiDefinitionDto>(`${BASE}/kpis`, d),
  patchKpi: (kpiId: string, p: SalesKpiDefinitionPatch) => api.patch<SalesKpiDefinitionDto>(`${BASE}/kpis/${id(kpiId)}`, p),
  disableKpi: (kpiId: string) => api.del<SalesKpiDefinitionDto>(`${BASE}/kpis/${id(kpiId)}`),
  testKpi: (req: SalesKpiTestRequest) => api.post<SalesKpiTestResult>(`${BASE}/kpis/test`, req),
  segmentOptions: () => api.get<SalesSegmentOptions>(`${BASE}/segment-options`),
  combos: (importId: string | 'latest' = 'latest') => api.get<SalesImportCombos>(`${BASE}/${id(importId)}/combos`),
  /**
   * Product combos from the STORED month history: one month, or the N most recent stored months (1..12). Takes an
   * AbortSignal so the picker can cancel a superseded request. Plain fetch because the SHARED api client takes no signal
   * (adding one there is a platform-wide change, held for the owner); errors follow its conventions (403 message).
   */
  historyCombos: async (q: { month: string } | { lastMonths: number }, signal?: AbortSignal): Promise<ApiResponse<SalesHistoryCombos>> => {
    const qs = 'month' in q ? `month=${id(q.month)}` : `lastMonths=${q.lastMonths}`;
    try {
      const res = await fetch(`${BASE}/history-combos?${qs}`, { method: 'GET', signal, headers: authHeader() });
      let body: { success?: boolean; data?: SalesHistoryCombos; error?: string; message?: string } | null = null;
      try { body = await res.json(); } catch { body = null; }
      if (res.status === 403) return { success: false, error: body?.error ?? "You don't have permission to do that", status: 403 };
      if (!res.ok || !body) return { success: false, error: body?.error ?? body?.message ?? (res.statusText || `HTTP ${res.status}`), status: res.status };
      return body as ApiResponse<SalesHistoryCombos>;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Network error' };
    }
  },

  // Imports
  list: (cursor?: string | null, limit = 20) =>
    api.get<SalesImportList>(`${BASE}?limit=${limit}${cursor ? `&cursor=${id(cursor)}` : ''}`),
  /** `background` = an automatic status poll (not a click) → not counted as activity by the Usage Report. */
  get: (importId: string, opts?: { background?: boolean }) => api.get<SalesImportDetail>(`${BASE}/${id(importId)}`, opts),
  reprocess: (importId: string) => api.post<SalesImportSummary>(`${BASE}/${id(importId)}/reprocess`, {}),
  /** Applied import whose mapping changed (canReprocessAsNew) → a NEW import from the same stored file (QUEUED). */
  reprocessAsNew: (importId: string) => api.post<SalesImportSummary>(`${BASE}/${id(importId)}/reprocess-as-new`, {}),
  /** QUEUED or stalled PROCESSING → CANCELLED (409 otherwise). */
  cancel: (importId: string) => api.post<SalesImportSummary>(`${BASE}/${id(importId)}/cancel`, {}),
  remove: (importId: string) => api.del<SalesImportSummary>(`${BASE}/${id(importId)}`),
  preview: (importId: string) => api.get<SalesImportPreview>(`${BASE}/${id(importId)}/preview`),
  /**
   * 202 ApplyEnqueued: the apply runs in the BACKGROUND (owner 2026-11-18) — follow `job` with getApplyJob. ApplyResult
   * is the pre-release synchronous answer (an API not yet updated during a deploy), still handled by the page.
   */
  apply: (importId: string, req: ApplyRequest) => api.post<ApplyEnqueued | ApplyResult>(`${BASE}/${id(importId)}/apply`, req),
  /** A background Apply / Recalculate job (progress + per-month results). */
  getApplyJob: (jobId: string) => api.get<SalesApplyJobDto>(`${BASE}/apply-jobs/${id(jobId)}`),
  /** The job a click created, by the page's requestId (404 = that click recorded nothing). */
  findApplyJob: (requestId: string) => api.get<SalesApplyJobDto>(`${BASE}/apply-jobs?requestId=${id(requestId)}`),
  unmatchedCsvUrl: (importId: string) => `${BASE}/${id(importId)}/unmatched.csv`,
  errorsXlsxUrl: (importId: string) => `${BASE}/${id(importId)}/errors.xlsx`,

  // Months
  months: (from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const qs = q.toString();
    return api.get<SalesMonthRow[]>(`${MONTHS}${qs ? `?${qs}` : ''}`);
  },
  closeMonth: (month: string) => api.post<SalesMonthRow>(`${MONTHS}/${id(month)}/close`, {}),
  /** Rebuilds the month's stored product list (KPI picker source) from its stored lines — changes no figures. */
  rebuildProductList: (month: string) => api.post<SalesMonthRebuildProductListResult>(`${MONTHS}/${id(month)}/rebuild-product-list`, {}),
  /** What "Recalculate from stored history" would write for an OPEN month (404 = no stored history). */
  recalcPreview: (month: string) => api.get<SalesMonthRecalcPreview>(`${MONTHS}/${id(month)}/recalculate/preview`),
  /** Rewrites the month's importer-owned KPIs from stored history — a BACKGROUND job (202; 409 when a token is stale). */
  recalculate: (month: string, body: SalesMonthRecalcRequest) =>
    api.post<ApplyEnqueued | SalesMonthRecalcResultLegacy>(`${MONTHS}/${id(month)}/recalculate`, body),
  reopenMonth: (month: string, body: SalesMonthReopenRequest = {}) =>
    api.post<SalesMonthReopenResult>(`${MONTHS}/${id(month)}/reopen`, body),

  // Focus products from the target file (FOCUS-FROM-TARGETS §5): accept an UNMATCHED name as "not sold yet" / undo.
  /** Accept one UNMATCHED focus product name (month + KPI + token key) as "not sold yet" — it then counts as 0. */
  acceptFocusToken: (month: string, body: FocusAcceptanceRequest) =>
    api.post<FocusAcceptanceList>(`${MONTHS}/${id(month)}/focus-acceptances`, body),
  /** Accept SEVERAL UNMATCHED names of ONE KPI in one request — all or nothing (owner 2026-11-26 "Accept all"). */
  acceptFocusTokens: (month: string, body: FocusAcceptanceBulkRequest) =>
    api.post<FocusAcceptanceList & { acceptedCount: number }>(`${MONTHS}/${id(month)}/focus-acceptances/bulk`, body),
  /** Removes that acceptance (the name blocks applying again until it is matched or accepted). */
  undoFocusAcceptance: (month: string, kpiCode: string, key: string) =>
    api.del<FocusAcceptanceList>(
      `${MONTHS}/${id(month)}/focus-acceptances?${new URLSearchParams({ kpiCode, key }).toString()}`,
    ),
};

/** Fetches a binary download (csv/xlsx) and returns the Blob, or an error message from the JSON envelope. */
export async function fetchDownload(url: string): Promise<ApiResponse<Blob>> {
  try {
    const res = await fetch(url, { headers: authHeader() });
    if (!res.ok) {
      let msg = `Download failed (HTTP ${res.status})`;
      try {
        const j = (await res.json()) as { error?: string; message?: string };
        msg = j.error ?? j.message ?? msg;
      } catch { /* not JSON */ }
      return { success: false, error: msg, status: res.status };
    }
    return { success: true, data: await res.blob() };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}
