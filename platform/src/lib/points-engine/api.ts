/**
 * Points Compute Engine — shared FE API module.
 *
 * Thin typed wrappers over the `api` client (same-origin `/api/*` → backend `/v1/*`, httpOnly cookie auth,
 * `ApiResponse<T>` envelope). Every screen uses these so paths/shapes live in one place. Binary downloads
 * (export / preview-report) use raw fetch + downloadBlob (the envelope doesn't apply to a streamed file).
 */

import { api, type ApiResponse } from '../api-client';
import { downloadBlob } from '../download';
import type {
  ComputeCommitResult,
  ComputePreview,
  PointsEngineSettings,
  PointsRuleRow,
  RuleConfigDraft,
  SimulateResult,
} from './types';

const RULES = '/api/admin/points-rules';
const COMPUTE = '/api/admin/points-compute';
const SETTINGS = '/api/admin/points-engine/settings';

// ── Rules CRUD / lifecycle ────────────────────────────────────────────────────────
export function listRules(q?: { status?: string; program?: string; kpiCode?: string }): Promise<ApiResponse<PointsRuleRow[]>> {
  const params = new URLSearchParams();
  if (q?.status) params.set('status', q.status);
  if (q?.program) params.set('program', q.program);
  if (q?.kpiCode) params.set('kpiCode', q.kpiCode);
  const qs = params.toString();
  return api.get<PointsRuleRow[]>(`${RULES}${qs ? `?${qs}` : ''}`);
}
export const getRule = (id: string) => api.get<PointsRuleRow>(`${RULES}/${id}`);
export const createRule = (draft: RuleConfigDraft) => api.post<PointsRuleRow>(RULES, draft);
export function updateRule(id: string, draft: RuleConfigDraft): Promise<ApiResponse<PointsRuleRow>> {
  // STRIP ruleId: the PATCH (updateDraft) DTO has no ruleId and the backend pipe is forbidNonWhitelisted,
  // so sending it 400s. A loaded draft carries ruleId (identity), so remove it from the update body.
  const { ruleId: _omit, ...body } = draft;
  void _omit;
  return api.patch<PointsRuleRow>(`${RULES}/${id}`, body);
}
export const publishRule = (id: string) => api.post<PointsRuleRow>(`${RULES}/${id}/publish`, {});
export const archiveRule = (id: string) => api.post<PointsRuleRow>(`${RULES}/${id}/archive`, {});

// ── Simulate (authoring aid) ────────────────────────────────────────────────────────
export function simulate(body: {
  attachsTo: RuleConfigDraft['attachsTo'];
  output: RuleConfigDraft['output'];
  rounding: RuleConfigDraft['rounding'];
  inputs: RuleConfigDraft['inputs'];
  pipeline: RuleConfigDraft['pipeline'];
  effectiveFrom?: string;
  effectiveTo?: string | null;
  context: {
    achievements?: Record<string, number | null>;
    targets?: Record<string, number | null>;
    segment?: { program?: string | null; programCategory?: string | null; outletType?: string | null; metro?: string | null };
  };
}): Promise<ApiResponse<SimulateResult>> {
  return api.post<SimulateResult>(`${COMPUTE}/simulate`, body);
}

// ── Compute preview / commit ────────────────────────────────────────────────────────
export function previewCompute(body: { period: string; program?: string | null; kpiCode?: string | null }): Promise<ApiResponse<ComputePreview>> {
  return api.post<ComputePreview>(`${COMPUTE}/preview`, body);
}
export function commitCompute(body: { period: string; program?: string | null; kpiCode?: string | null; expectedKey?: string | null }): Promise<ApiResponse<ComputeCommitResult>> {
  return api.post<ComputeCommitResult>(`${COMPUTE}/commit`, body);
}

// ── Binary downloads (export credit-upload xlsx / review report) ──────────────────────
function computeQs(q: { period: string; program?: string | null; kpiCode?: string | null }): string {
  const params = new URLSearchParams({ period: q.period });
  if (q.program) params.set('program', q.program);
  if (q.kpiCode) params.set('kpiCode', q.kpiCode);
  return params.toString();
}
/** Returns null on success, or an error message. */
async function download(url: string, filename: string): Promise<string | null> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return res.status === 403 ? "You don't have permission to do that" : `Download failed (${res.status})`;
    downloadBlob(await res.blob(), filename);
    return null;
  } catch {
    return 'Download failed — check your connection and try again.';
  }
}
export const downloadExport = (q: { period: string; program?: string | null; kpiCode?: string | null }) =>
  download(`${COMPUTE}/export?${computeQs(q)}`, `points-credit-upload-${q.period}.xlsx`);
export const downloadPreviewReport = (q: { period: string; program?: string | null; kpiCode?: string | null }) =>
  download(`${COMPUTE}/preview-report?${computeQs(q)}`, `points-preview-${q.period}.xlsx`);
export const downloadPayoutReport = (q: { period: string; program?: string | null; kpiCode?: string | null }) =>
  download(`${COMPUTE}/payout-report?${computeQs(q)}`, `points-payout-report-${q.period}.xlsx`);

// ── Settings ────────────────────────────────────────────────────────────────────────
export function getSettings(clientId?: string): Promise<ApiResponse<PointsEngineSettings>> {
  return api.get<PointsEngineSettings>(`${SETTINGS}${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''}`);
}
export function setSettings(body: PointsEngineSettings): Promise<ApiResponse<PointsEngineSettings>> {
  return api.put<PointsEngineSettings>(SETTINGS, body);
}
