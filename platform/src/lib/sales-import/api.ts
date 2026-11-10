/**
 * Sales Import — typed wrappers for the §5.2 routes (plan §11 F-1). Every call returns the platform envelope
 * `ApiResponse<T>` (with `status` on failure) so pages can special-case 409 etc. FE paths are `/api/...`; the Next
 * proxy rewrites them to backend `/v1/...`.
 */
import { api, authHeader, type ApiResponse } from '@/lib/api-client';
import type {
  ApplyRequest,
  ApplyResult,
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
  SalesMonthRecalcPreview,
  SalesMonthRecalcRequest,
  SalesMonthRecalcResult,
  SalesMonthReopenRequest,
  SalesMonthReopenResult,
  SalesMonthRow,
  SalesSegmentOptions,
} from './types';

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
  /** Product combos from the STORED month history: one month, or the N most recent stored months (1..12). */
  historyCombos: (q: { month: string } | { lastMonths: number }) =>
    api.get<SalesHistoryCombos>(`${BASE}/history-combos?${'month' in q ? `month=${id(q.month)}` : `lastMonths=${q.lastMonths}`}`),

  // Imports
  list: (cursor?: string | null, limit = 20) =>
    api.get<SalesImportList>(`${BASE}?limit=${limit}${cursor ? `&cursor=${id(cursor)}` : ''}`),
  get: (importId: string) => api.get<SalesImportDetail>(`${BASE}/${id(importId)}`),
  reprocess: (importId: string) => api.post<SalesImportSummary>(`${BASE}/${id(importId)}/reprocess`, {}),
  /** Applied import whose mapping changed (canReprocessAsNew) → a NEW import from the same stored file (QUEUED). */
  reprocessAsNew: (importId: string) => api.post<SalesImportSummary>(`${BASE}/${id(importId)}/reprocess-as-new`, {}),
  /** QUEUED or stalled PROCESSING → CANCELLED (409 otherwise). */
  cancel: (importId: string) => api.post<SalesImportSummary>(`${BASE}/${id(importId)}/cancel`, {}),
  remove: (importId: string) => api.del<SalesImportSummary>(`${BASE}/${id(importId)}`),
  preview: (importId: string) => api.get<SalesImportPreview>(`${BASE}/${id(importId)}/preview`),
  apply: (importId: string, req: ApplyRequest) => api.post<ApplyResult>(`${BASE}/${id(importId)}/apply`, req),
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
  /** What "Recalculate from stored history" would write for an OPEN month (404 = no stored history). */
  recalcPreview: (month: string) => api.get<SalesMonthRecalcPreview>(`${MONTHS}/${id(month)}/recalculate/preview`),
  /** Rewrites the month's importer-owned KPIs from stored history (409 when a token is stale). */
  recalculate: (month: string, body: SalesMonthRecalcRequest) =>
    api.post<SalesMonthRecalcResult>(`${MONTHS}/${id(month)}/recalculate`, body),
  reopenMonth: (month: string, body: SalesMonthReopenRequest = {}) =>
    api.post<SalesMonthReopenResult>(`${MONTHS}/${id(month)}/reopen`, body),
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
