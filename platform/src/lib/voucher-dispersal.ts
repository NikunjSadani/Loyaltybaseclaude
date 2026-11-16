/* ─── Voucher Dispersal — types, pure rules, and the API adapter ─────────────────
 *
 * A GENERIC, PLATFORM-LEVEL Gifsy tool (owner-approved 2026-11-16): a GIFSY_ADMIN uploads a
 * list of phone + name + amount + brand, previews it, confirms in a dialog, and
 * the server buys one Hubble voucher per valid row and sends it on WhatsApp. It is NOT a tenant
 * feature — it lives in the /gifsy console and never depends on an assumed tenant. A campaign
 * may optionally be billed to a client (billedToClientId) — that only labels it.
 *
 * Contract (all GIFSY_ADMIN only; proxied /api/admin/voucher-dispersal/* → /v1/admin/voucher-dispersal/*):
 *   GET  /brands                                   → VdBrand[]
 *   GET  /template.xlsx                            → file
 *   POST /campaigns {name, programLabel, billedToClientId?, note?, budgetRupees} → campaign
 *   POST /campaigns/:id/upload (multipart `file`)  → { campaign, rows, summary }
 *   POST /campaigns/:id/confirm {expectedValidCount, expectedTotalRupees} → campaign
 *        (the numbers shown on the preview; the server refuses if its preview differs → re-upload)
 *   GET  /campaigns                                → list with summary counts
 *   GET  /campaigns/:id                            → campaign + delivery summary
 *   GET  /campaigns/:id/rows?status=&page=         → rows (voucher code masked)
 *   GET  /campaigns/:id/report.xlsx                → file
 *   POST /campaigns/:id/rows/:rowId/resend
 *   POST /campaigns/:id/rows/:rowId/retry-buy
 *   POST /campaigns/:id/cancel
 *
 * The normalisers below are deliberately tolerant of small shape differences (envelope vs bare
 * body, a nested vs flat summary, a few field-name aliases) so a cosmetic server difference
 * degrades to a visible "—" rather than a crash. They never invent numbers: a missing count is 0
 * only where the server sent nothing at all for it.
 * ───────────────────────────────────────────────────────────────────────────────── */

import { formatInrExact } from '@/lib/format-inr';

export const VD_BASE = '/api/admin/voucher-dispersal';
export const VD_TEMPLATE_URL = `${VD_BASE}/template.xlsx`;
export const vdReportUrl = (id: string) => `${VD_BASE}/campaigns/${encodeURIComponent(id)}/report.xlsx`;

// ─── Status unions ──────────────────────────────────────────────────────────────

export const CAMPAIGN_STATUSES = [
  'DRAFT', 'PREVIEWED', 'CONFIRMED', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const ROW_STATUSES = [
  'VALID', 'INVALID', 'DUPLICATE', 'QUEUED', 'BUYING', 'PENDING_RECONCILE', 'BOUGHT', 'BUY_FAILED', 'CANCELLED',
] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

export type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed';

export type Tone = 'neutral' | 'info' | 'progress' | 'success' | 'warning' | 'danger';

export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  DRAFT: 'Draft — no file yet',
  PREVIEWED: 'Previewed — not confirmed',
  CONFIRMED: 'Confirmed — starting',
  PROCESSING: 'Processing',
  COMPLETED: 'Completed',
  COMPLETED_WITH_ERRORS: 'Completed with errors',
  CANCELLED: 'Cancelled',
};

export const CAMPAIGN_STATUS_TONE: Record<CampaignStatus, Tone> = {
  DRAFT: 'neutral',
  PREVIEWED: 'info',
  CONFIRMED: 'progress',
  PROCESSING: 'progress',
  COMPLETED: 'success',
  COMPLETED_WITH_ERRORS: 'warning',
  CANCELLED: 'neutral',
};

export const ROW_STATUS_LABEL: Record<RowStatus, string> = {
  VALID: 'Valid',
  INVALID: 'Invalid',
  DUPLICATE: 'Duplicate',
  QUEUED: 'Queued — not bought yet',
  BUYING: 'Buying…',
  PENDING_RECONCILE: 'Purchase not confirmed',
  BOUGHT: 'Bought',
  BUY_FAILED: 'Purchase failed',
  CANCELLED: 'Cancelled',
};

export const ROW_STATUS_TONE: Record<RowStatus, Tone> = {
  VALID: 'success',
  INVALID: 'danger',
  DUPLICATE: 'warning',
  QUEUED: 'neutral',
  BUYING: 'progress',
  PENDING_RECONCILE: 'warning',
  BOUGHT: 'success',
  BUY_FAILED: 'danger',
  CANCELLED: 'neutral',
};

export const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = {
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed',
};

export const MESSAGE_STATUS_TONE: Record<MessageStatus, Tone> = {
  sent: 'info',
  delivered: 'success',
  read: 'success',
  failed: 'danger',
};

/** Shown for a PENDING_RECONCILE row when the server gives no reason of its own. */
export const PENDING_RECONCILE_NOTE =
  'Hubble has not confirmed whether this purchase went through. It is not counted as bought or failed until it is reconciled.';

// ─── Shapes ─────────────────────────────────────────────────────────────────────

export interface VdBrand {
  key: string;
  label: string;
  productId: string;
  minAmount: number;
  maxAmount: number;
  denominations: number[] | null;
}

export interface VdCampaign {
  id: string;
  name: string;
  programLabel: string;
  billedToClientId: string | null;
  billedToClientName: string | null;
  note: string | null;
  budgetRupees: number;
  status: CampaignStatus;
  createdAt: string | null;
  confirmedAt: string | null;
  completedAt: string | null;
  /** Server's own verdict, when it sends one; otherwise the status rule below decides. */
  canCancel: boolean | null;
}

export interface VdDeliverySummary {
  /** Valid rows that will be / were issued (0 when the server does not report it). */
  total: number;
  bought: number;
  pending: number;
  buyFailed: number;
  messageSent: number;
  delivered: number;
  read: number;
  messageFailed: number;
  spentRupees: number;
}

export interface VdListItem {
  campaign: VdCampaign;
  summary: VdDeliverySummary;
}

export interface VdPreviewRow {
  rowNumber: number;
  phone: string;
  name: string;
  amount: number | null;
  brand: string;
  status: RowStatus;
  invalidReason: string | null;
}

export interface VdPerBrand {
  brand: string;
  count: number;
  rupees: number | null;
}

export interface VdPreviewSummary {
  total: number;
  valid: number;
  invalid: number;
  duplicates: number;
  totalRupees: number;
  budgetRupees: number;
  overBudget: boolean;
  perBrand: VdPerBrand[];
}

export interface VdPreview {
  campaign: VdCampaign;
  rows: VdPreviewRow[];
  summary: VdPreviewSummary;
}

export interface VdRow {
  id: string;
  rowNumber: number;
  phone: string;
  name: string;
  amount: number | null;
  brand: string;
  status: RowStatus;
  /** Validation / purchase-failure / reconcile reason (server text). */
  reason: string | null;
  hubbleRef: string | null;
  /** Always masked before display (see maskVoucherCode). */
  voucherCode: string | null;
  messageStatus: MessageStatus | null;
  messageSentAt: string | null;
  messageDeliveredAt: string | null;
  messageReadAt: string | null;
  messageFailedAt: string | null;
  messageError: string | null;
  canRetryBuy: boolean | null;
}

export interface VdRowsPage {
  rows: VdRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface VdClient {
  id: string;
  name: string;
}

// ─── Small coercers ─────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const n0 = (v: unknown): number => num(v) ?? 0;
const pick = (o: Obj, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

function asCampaignStatus(v: unknown): CampaignStatus {
  const s = String(v ?? '').toUpperCase();
  return (CAMPAIGN_STATUSES as readonly string[]).includes(s) ? (s as CampaignStatus) : 'DRAFT';
}

function asRowStatus(v: unknown): RowStatus {
  const s = String(v ?? '').toUpperCase();
  return (ROW_STATUSES as readonly string[]).includes(s) ? (s as RowStatus) : 'INVALID';
}

function asMessageStatus(v: unknown): MessageStatus | null {
  const s = String(v ?? '').toLowerCase();
  return s === 'sent' || s === 'delivered' || s === 'read' || s === 'failed' ? s : null;
}

// ─── Normalisers ────────────────────────────────────────────────────────────────

export function normalizeCampaign(raw: unknown): VdCampaign {
  const o = isObj(raw) ? raw : {};
  const billed = isObj(o.billedToClient) ? o.billedToClient : null;
  return {
    id: str(o.id) ?? '',
    name: str(o.name) ?? '',
    programLabel: str(o.programLabel) ?? '',
    billedToClientId: str(o.billedToClientId) ?? (billed ? str(pick(billed, 'id', 'slug')) : null),
    billedToClientName:
      str(o.billedToClientName)
      ?? (billed ? str(pick(billed, 'displayName', 'name', 'internalName')) : null)
      ?? null,
    note: str(o.note),
    budgetRupees: n0(o.budgetRupees),
    status: asCampaignStatus(o.status),
    createdAt: str(o.createdAt),
    confirmedAt: str(o.confirmedAt),
    completedAt: str(pick(o, 'completedAt', 'finishedAt')),
    canCancel: typeof o.canCancel === 'boolean' ? o.canCancel : null,
  };
}

export function normalizeDeliverySummary(raw: unknown): VdDeliverySummary {
  const o = isObj(raw) ? raw : {};
  return {
    total: n0(pick(o, 'valid', 'validCount', 'total', 'totalRows')),
    bought: n0(o.bought),
    pending: n0(o.pending),
    buyFailed: n0(o.buyFailed),
    messageSent: n0(o.messageSent),
    delivered: n0(o.delivered),
    read: n0(o.read),
    messageFailed: n0(o.messageFailed),
    spentRupees: n0(o.spentRupees),
  };
}

/** One list item or detail body: `{campaign, summary}`, or a campaign carrying `summary` / flat counts. */
export function normalizeListItem(raw: unknown): VdListItem {
  const o = isObj(raw) ? raw : {};
  const campaignRaw = isObj(o.campaign) ? o.campaign : o;
  const summaryRaw = isObj(o.summary) ? o.summary : isObj(campaignRaw.summary) ? campaignRaw.summary : campaignRaw;
  return { campaign: normalizeCampaign(campaignRaw), summary: normalizeDeliverySummary(summaryRaw) };
}

function normalizePerBrand(raw: unknown): VdPerBrand[] {
  if (Array.isArray(raw)) {
    return raw.filter(isObj).map((b) => ({
      brand: str(pick(b, 'label', 'brand', 'key')) ?? '—',
      count: n0(pick(b, 'count', 'rows', 'valid')),
      rupees: num(pick(b, 'rupees', 'totalRupees', 'amount')),
    }));
  }
  if (isObj(raw)) {
    return Object.entries(raw).map(([brand, v]) =>
      isObj(v)
        ? { brand, count: n0(pick(v, 'count', 'rows', 'valid')), rupees: num(pick(v, 'rupees', 'totalRupees', 'amount')) }
        : { brand, count: n0(v), rupees: null },
    );
  }
  return [];
}

export function normalizePreviewRow(raw: unknown): VdPreviewRow {
  const o = isObj(raw) ? raw : {};
  return {
    rowNumber: n0(o.rowNumber),
    phone: str(o.phone) ?? '',
    name: str(o.name) ?? '',
    amount: num(o.amount),
    brand: str(o.brand) ?? '',
    status: asRowStatus(o.status),
    invalidReason: str(o.invalidReason),
  };
}

export function normalizePreview(raw: unknown): VdPreview {
  const o = isObj(raw) ? raw : {};
  const s = isObj(o.summary) ? o.summary : {};
  return {
    campaign: normalizeCampaign(o.campaign),
    rows: Array.isArray(o.rows) ? o.rows.map(normalizePreviewRow) : [],
    summary: {
      total: n0(s.total),
      valid: n0(s.valid),
      invalid: n0(s.invalid),
      duplicates: n0(s.duplicates),
      totalRupees: n0(s.totalRupees),
      budgetRupees: n0(s.budgetRupees),
      overBudget: s.overBudget === true,
      perBrand: normalizePerBrand(s.perBrand),
    },
  };
}

export function normalizeRow(raw: unknown): VdRow {
  const o = isObj(raw) ? raw : {};
  const status = asRowStatus(o.status);
  return {
    id: str(o.id) ?? '',
    rowNumber: n0(o.rowNumber),
    phone: str(o.phone) ?? '',
    name: str(o.name) ?? '',
    amount: num(o.amount),
    brand: str(o.brand) ?? '',
    status,
    reason: str(pick(o, 'invalidReason', 'buyError', 'failureReason', 'buyFailureReason', 'reconcileNote', 'error')),
    hubbleRef: str(pick(o, 'hubbleRef', 'hubbleOrderId', 'hubbleReference', 'hubbleOrderRef')),
    voucherCode: maskVoucherCode(str(pick(o, 'voucherCode', 'voucherCodeMasked', 'codeMasked', 'maskedCode'))),
    messageStatus: asMessageStatus(o.messageStatus),
    messageSentAt: str(pick(o, 'messageSentAt', 'sentAt')),
    messageDeliveredAt: str(pick(o, 'messageDeliveredAt', 'deliveredAt')),
    messageReadAt: str(pick(o, 'messageReadAt', 'readAt')),
    messageFailedAt: str(pick(o, 'messageFailedAt', 'failedAt')),
    messageError: str(pick(o, 'messageError', 'messageFailureReason', 'messageFailReason')),
    canRetryBuy: typeof o.canRetryBuy === 'boolean' ? o.canRetryBuy : null,
  };
}

export function normalizeRowsPage(raw: unknown, requestedPage: number): VdRowsPage {
  if (Array.isArray(raw)) {
    return { rows: raw.map(normalizeRow), total: raw.length, page: requestedPage, pageSize: raw.length || 1 };
  }
  const o = isObj(raw) ? raw : {};
  const list = Array.isArray(o.rows) ? o.rows : Array.isArray(o.items) ? o.items : [];
  const rows = list.map(normalizeRow);
  return {
    rows,
    total: num(o.total) ?? rows.length,
    page: num(o.page) ?? requestedPage,
    pageSize: num(o.pageSize) ?? (rows.length || 1),
  };
}

export function normalizeBrand(raw: unknown): VdBrand {
  const o = isObj(raw) ? raw : {};
  return {
    key: str(o.key) ?? '',
    label: str(o.label) ?? str(o.key) ?? '',
    productId: str(o.productId) ?? '',
    minAmount: n0(o.minAmount),
    maxAmount: n0(o.maxAmount),
    denominations: Array.isArray(o.denominations) ? o.denominations.map(n0) : null,
  };
}

export function normalizeClients(raw: unknown): VdClient[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.clients) ? raw.clients : [];
  return list
    .filter(isObj)
    .map((c) => ({
      id: str(pick(c, 'slug', 'id')) ?? '',
      name: str(pick(c, 'displayName', 'internalName', 'name')) ?? str(pick(c, 'slug', 'id')) ?? '',
    }))
    .filter((c) => c.id !== '')
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Business rules (pure) ──────────────────────────────────────────────────────

/** Confirm-dialog title: `Buy and send N vouchers · ₹X total?` */
export function confirmDialogTitle(s: Pick<VdPreviewSummary, 'valid' | 'totalRupees'>): string {
  return `Buy and send ${s.valid} vouchers · ${formatInrExact(s.totalRupees)} total?`;
}

/** Confirm body: the exact numbers shown on the preview, so the server can refuse if its preview differs. */
export function confirmPayload(s: Pick<VdPreviewSummary, 'valid' | 'totalRupees'>): { expectedValidCount: number; expectedTotalRupees: number } {
  return { expectedValidCount: s.valid, expectedTotalRupees: s.totalRupees };
}

export type ConfirmBlock = { blocked: true; reason: string } | { blocked: false };

/** Why confirm is blocked (or not). Over-budget and zero-valid-rows both block. */
export function confirmBlock(s: VdPreviewSummary): ConfirmBlock {
  if (s.overBudget || (s.budgetRupees > 0 && s.totalRupees > s.budgetRupees)) {
    return {
      blocked: true,
      reason: `The valid rows total ${formatInrExact(s.totalRupees)}, which is over the ${formatInrExact(s.budgetRupees)} budget. Fix the file (or create a campaign with a bigger budget) and upload again.`,
    };
  }
  if (s.valid <= 0) return { blocked: true, reason: 'There are no valid rows to issue. Fix the file and upload again.' };
  return { blocked: false };
}

/** Live campaigns (money moving / messages going out) — the detail view auto-refreshes while live. */
export function isLiveCampaign(status: CampaignStatus): boolean {
  return status === 'CONFIRMED' || status === 'PROCESSING';
}

/** A campaign that has not been confirmed — nothing has been spent. */
export function isSetupCampaign(status: CampaignStatus): boolean {
  return status === 'DRAFT' || status === 'PREVIEWED';
}

export function canCancelCampaign(c: Pick<VdCampaign, 'status' | 'canCancel'>): boolean {
  if (c.canCancel !== null) return c.canCancel;
  return c.status === 'DRAFT' || c.status === 'PREVIEWED' || c.status === 'CONFIRMED' || c.status === 'PROCESSING';
}

/** Resend WhatsApp is offered ONLY for a bought voucher (it re-sends the same code). */
export function canResendRow(r: Pick<VdRow, 'status'>): boolean {
  return r.status === 'BOUGHT';
}

/** Retry purchase: the server's own flag wins; otherwise only a failed purchase may be retried. */
export function canRetryRow(r: Pick<VdRow, 'status' | 'canRetryBuy'>): boolean {
  if (r.canRetryBuy !== null) return r.canRetryBuy;
  return r.status === 'BUY_FAILED';
}

/** Polling: start at 3s, back off ×1.5 to a 30s ceiling. */
export const POLL_START_MS = 3_000;
export const POLL_MAX_MS = 30_000;
export function nextPollDelay(prev: number): number {
  return Math.min(POLL_MAX_MS, Math.round(Math.max(prev, POLL_START_MS) * 1.5));
}

/** After a campaign completes, keep refreshing this long for late WhatsApp delivered / read updates. */
export const POLL_AFTER_COMPLETE_MS = 30 * 60 * 1000;

export type PollPhase = 'live' | 'settling' | 'off';

/**
 * Whether the detail view should auto-refresh:
 *  - 'live'     while CONFIRMED / PROCESSING;
 *  - 'settling' for 30 minutes after COMPLETED / COMPLETED_WITH_ERRORS — measured from the server's
 *               `completedAt`, or (when the server sends none) from the moment this page saw it finish;
 *  - 'off'      otherwise (setup, cancelled, or the 30-minute window has passed / is unknown).
 */
export function pollPhase(
  c: Pick<VdCampaign, 'status' | 'completedAt'>,
  now: number,
  observedCompletedAt: number | null,
): PollPhase {
  if (isLiveCampaign(c.status)) return 'live';
  if (c.status !== 'COMPLETED' && c.status !== 'COMPLETED_WITH_ERRORS') return 'off';
  const serverAt = c.completedAt ? new Date(c.completedAt).getTime() : NaN;
  const from = Number.isFinite(serverAt) ? serverAt : observedCompletedAt;
  if (from === null) return 'off';
  return now - from < POLL_AFTER_COMPLETE_MS ? 'settling' : 'off';
}

/** Never show a full voucher code — keep anything already masked, otherwise show only the last 4. */
export function maskVoucherCode(code: string | null): string | null {
  if (!code) return null;
  if (/[*•]{3,}/.test(code)) return code;
  if (code.length <= 4) return '••••';
  return `••••${code.slice(-4)}`;
}

export function formatRupees(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : formatInrExact(v);
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Default programme label when a bill-to client is picked (still editable). */
export function defaultProgramLabel(clientName: string): string {
  return `${clientName} Loyalty`;
}

// ─── Create-form validation (pure) ──────────────────────────────────────────────

export interface CreateForm {
  name: string;
  programLabel: string;
  billedToClientId: string;
  note: string;
  budgetRupees: string;
}

export function validateCreateForm(f: CreateForm): Partial<Record<keyof CreateForm, string>> {
  const errors: Partial<Record<keyof CreateForm, string>> = {};
  if (!f.name.trim()) errors.name = 'Enter a campaign name.';
  if (!f.programLabel.trim()) errors.programLabel = 'Enter the programme name shown in the WhatsApp message.';
  const b = Number(f.budgetRupees);
  if (f.budgetRupees.trim() === '' || !Number.isFinite(b) || b <= 0) errors.budgetRupees = 'Enter a budget in rupees greater than 0.';
  return errors;
}

// ─── API adapter ────────────────────────────────────────────────────────────────

export type VdResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";

/** The server's own words for a failure (`{error}` / Nest `{message}` string or list), else a plain fallback. */
async function errorText(res: Response): Promise<string> {
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  if (isObj(body)) {
    const raw = body.error ?? body.message;
    if (Array.isArray(raw) && raw.length) return raw.join(', ');
    if (isObj(raw) && typeof raw.message === 'string') return raw.message;
    if (typeof raw === 'string' && raw.trim()) return raw;
  }
  if (res.status === 401) return 'Your session has expired. Please sign in again.';
  if (res.status === 403) return 'Only a Gifsy admin can use Voucher Dispersal.';
  if (res.status === 404) return 'Not found.';
  return `The server could not complete this (error ${res.status}). Please try again.`;
}

async function vdRequest<T>(path: string, init: RequestInit, map: (data: unknown) => T): Promise<VdResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${VD_BASE}${path}`, init);
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
  if (!res.ok) return { ok: false, error: await errorText(res), status: res.status };
  let body: unknown = null;
  if (res.status !== 204) {
    try { body = await res.json(); } catch { body = null; }
  }
  // Envelope `{success, data}` or a bare body.
  if (isObj(body) && 'success' in body) {
    if (body.success === false) {
      const e = typeof body.error === 'string' && body.error ? body.error : 'The server refused this request.';
      return { ok: false, error: e, status: res.status };
    }
    body = body.data;
  }
  try {
    return { ok: true, data: map(body) };
  } catch {
    return { ok: false, error: 'The server reply could not be read. Please refresh.' };
  }
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const cid = (id: string) => encodeURIComponent(id);

export const vdApi = {
  brands: () =>
    vdRequest('/brands', {}, (d) => (Array.isArray(d) ? d : isObj(d) && Array.isArray(d.brands) ? d.brands : []).map(normalizeBrand)),

  listCampaigns: () =>
    vdRequest('/campaigns', {}, (d) => {
      const list = Array.isArray(d) ? d : isObj(d) && Array.isArray(d.campaigns) ? d.campaigns : isObj(d) && Array.isArray(d.items) ? d.items : [];
      return list.map(normalizeListItem);
    }),

  getCampaign: (id: string) => vdRequest(`/campaigns/${cid(id)}`, {}, normalizeListItem),

  createCampaign: (body: { name: string; programLabel: string; billedToClientId?: string; note?: string; budgetRupees: number }) =>
    vdRequest('/campaigns', json(body), (d) => normalizeCampaign(isObj(d) && isObj(d.campaign) ? d.campaign : d)),

  upload: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    // No Content-Type header — the browser sets the multipart boundary.
    return vdRequest(`/campaigns/${cid(id)}/upload`, { method: 'POST', body: fd }, normalizePreview);
  },

  confirm: (id: string, body: { expectedValidCount: number; expectedTotalRupees: number }) =>
    vdRequest(`/campaigns/${cid(id)}/confirm`, json(body), (d) => normalizeCampaign(isObj(d) && isObj(d.campaign) ? d.campaign : d)),

  rows: (id: string, opts: { status?: string; page?: number }) => {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    const page = opts.page ?? 1;
    q.set('page', String(page));
    return vdRequest(`/campaigns/${cid(id)}/rows?${q.toString()}`, {}, (d) => normalizeRowsPage(d, page));
  },

  resend: (id: string, rowId: string) => vdRequest(`/campaigns/${cid(id)}/rows/${cid(rowId)}/resend`, json({}), () => true),

  retryBuy: (id: string, rowId: string) => vdRequest(`/campaigns/${cid(id)}/rows/${cid(rowId)}/retry-buy`, json({}), () => true),

  cancel: (id: string) => vdRequest(`/campaigns/${cid(id)}/cancel`, json({}), () => true),
};

/** Tenant list for the optional "Bill to client" picker (GET /api/gifsy/clients). */
export async function fetchBillableClients(): Promise<VdResult<VdClient[]>> {
  let res: Response;
  try {
    res = await fetch('/api/gifsy/clients');
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
  if (!res.ok) return { ok: false, error: await errorText(res), status: res.status };
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  if (isObj(body) && 'success' in body) body = body.data;
  return { ok: true, data: normalizeClients(body) };
}
