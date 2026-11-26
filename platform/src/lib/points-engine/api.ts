/**
 * Points Compute Engine — shared FE API module.
 *
 * Thin typed wrappers over the `api` client (same-origin `/api/*` → backend `/v1/*`, httpOnly cookie auth,
 * `ApiResponse<T>` envelope). Every screen uses these so paths/shapes live in one place. Binary downloads
 * (export / preview-report / payout-report) go through downloadOrQueue: 200 saves the file, 202 means it is
 * being prepared in the background (Downloads page).
 */

import { api, type ApiResponse } from '../api-client';
import { downloadOrQueue, type DownloadOutcome } from '../exports/download';
import type {
  ComputeCommitResult,
  ComputePreview,
  EvaluationBasis,
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
/**
 * The name as the API wants it: trimmed; blank → null (clear) on an update, omitted on a create (a new version then
 * inherits the previous version's name server-side). The backend rejects a blank string, so never send ''.
 */
function wireName(name: string | null | undefined, mode: 'create' | 'update'): { name?: string | null } {
  if (name === undefined) return {};
  const t = (name ?? '').trim();
  if (t === '') return mode === 'update' ? { name: null } : {};
  return { name: t };
}
export function createRule(draft: RuleConfigDraft): Promise<ApiResponse<PointsRuleRow>> {
  const { name, ...rest } = draft;
  return api.post<PointsRuleRow>(RULES, { ...rest, ...wireName(name, 'create') });
}
export function updateRule(id: string, draft: RuleConfigDraft): Promise<ApiResponse<PointsRuleRow>> {
  // STRIP ruleId: the PATCH (updateDraft) DTO has no ruleId and the backend pipe is forbidNonWhitelisted,
  // so sending it 400s. A loaded draft carries ruleId (identity), so remove it from the update body.
  const { ruleId: _omit, name, ...body } = draft;
  void _omit;
  return api.patch<PointsRuleRow>(`${RULES}/${id}`, { ...body, ...wireName(name, 'update') });
}
/** Rename a rule (any status, incl. published) WITHOUT a new version — display-only; applies to every version. */
export function renameRule(id: string, name: string): Promise<ApiResponse<PointsRuleRow>> {
  const t = name.trim();
  return api.patch<PointsRuleRow>(`${RULES}/${id}/name`, { name: t === '' ? null : t });
}
/** 412 = VERSION_GAP (already-started periods would have no rule) — resend with `confirmGap: true` after the author confirms. */
export const publishRule = (id: string, opts: { confirmGap?: boolean } = {}) =>
  api.post<PointsRuleRow>(`${RULES}/${id}/publish`, opts.confirmGap ? { confirmGap: true } : {});
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
  /** 'QUARTER' simulates a quarterly rule on `context.months` (3 months of values). Omitted = monthly (unchanged). */
  evaluationBasis?: EvaluationBasis;
  context: {
    achievements?: Record<string, number | null>;
    targets?: Record<string, number | null>;
    segment?: { program?: string | null; programCategory?: string | null; outletType?: string | null; metro?: string | null };
    visibility?: { approvedWindows?: number | null; approved?: number | null; windows?: number | null };
    quarterLabel?: string;
    months?: Array<{ label?: string; achievements?: Record<string, number | null>; targets?: Record<string, number | null> }>;
  };
}): Promise<ApiResponse<SimulateResult>> {
  return api.post<SimulateResult>(`${COMPUTE}/simulate`, body);
}

// ── Compute preview / commit ────────────────────────────────────────────────────────
export function previewCompute(body: { period: string; program?: string | null; kpiCode?: string | null }): Promise<ApiResponse<ComputePreview>> {
  return api.post<ComputePreview>(`${COMPUTE}/preview`, body);
}
export function commitCompute(body: {
  period: string;
  program?: string | null;
  kpiCode?: string | null;
  expectedKey?: string | null;
  /** §3a: the pendingKey of the visibility-pending outlet set the admin accepted (server refuses a different set). */
  acceptVisibilityPendingKey?: string | null;
  /** preview.importedMonths.confirmKey — a Gifsy admin's confirmation for imported months (server-enforced). */
  confirmImportedMonthsKey?: string | null;
}): Promise<ApiResponse<ComputeCommitResult>> {
  return api.post<ComputeCommitResult>(`${COMPUTE}/commit`, body);
}

// ── Binary downloads (export credit-upload xlsx / review report) ──────────────────────
type ComputeQ = {
  period: string;
  program?: string | null;
  kpiCode?: string | null;
  /** §3a: the accepted pending-visibility outlet set (money files only). */
  acceptVisibilityPendingKey?: string | null;
  /** The run key the operator reviewed (sourceKey for the credit file, payoutKey for the payout report). */
  expectedKey?: string | null;
  /** preview.importedMonths.confirmKey (money files only). */
  confirmImportedMonthsKey?: string | null;
};
function computeQs(q: ComputeQ): string {
  const params = new URLSearchParams({ period: q.period });
  if (q.program) params.set('program', q.program);
  if (q.kpiCode) params.set('kpiCode', q.kpiCode);
  if (q.acceptVisibilityPendingKey) params.set('acceptVisibilityPendingKey', q.acceptVisibilityPendingKey);
  if (q.expectedKey) params.set('expectedKey', q.expectedKey);
  if (q.confirmImportedMonthsKey) params.set('confirmImportedMonthsKey', q.confirmImportedMonthsKey);
  return params.toString();
}
/**
 * 200 → saves the file; 202 → `kind: 'queued'` (prepared in the background, shown on the Downloads
 * page); anything else → `kind: 'error'` with a plain-English message. Never throws.
 */
function download(url: string, filename: string): Promise<DownloadOutcome> {
  return downloadOrQueue(url, { fallbackFileName: filename, init: { credentials: 'same-origin' } });
}
export const downloadExport = (q: ComputeQ) =>
  download(`${COMPUTE}/export?${computeQs(q)}`, `points-credit-upload-${q.period}.xlsx`);
export const downloadPreviewReport = (q: { period: string; program?: string | null; kpiCode?: string | null }) =>
  download(`${COMPUTE}/preview-report?${computeQs(q)}`, `points-preview-${q.period}.xlsx`);
export const downloadPayoutReport = (q: ComputeQ) =>
  download(`${COMPUTE}/payout-report?${computeQs(q)}`, `points-payout-report-${q.period}.xlsx`);

// ── Settings ────────────────────────────────────────────────────────────────────────
export function getSettings(clientId?: string): Promise<ApiResponse<PointsEngineSettings>> {
  return api.get<PointsEngineSettings>(`${SETTINGS}${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''}`);
}
export function setSettings(body: PointsEngineSettings): Promise<ApiResponse<PointsEngineSettings>> {
  return api.put<PointsEngineSettings>(SETTINGS, body);
}
