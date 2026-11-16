/* ─── Voucher Dispersal — types, pure rules, and the API adapter ─────────────────
 *
 * A GENERIC, PLATFORM-LEVEL Gifsy tool (owner-approved 2026-11-16): a GIFSY_ADMIN uploads a
 * list of phone + name + amount + brand, previews it, confirms in a dialog, and the server buys
 * one Hubble voucher per valid row and sends it on WhatsApp. It is NOT a tenant feature — it
 * lives in the /gifsy console and never depends on an assumed tenant. A campaign may optionally
 * be billed to a client (billedToClientId) — that only labels it.
 *
 * Contract (all GIFSY_ADMIN only; proxied /api/admin/voucher-dispersal/* → /v1/admin/voucher-dispersal/*):
 *   GET  /brands                                   → VdBrand[]
 *   GET  /template.xlsx                            → file
 *   POST /campaigns {name, programLabel, billedToClientId?, note?, budgetRupees} → campaign
 *   POST /campaigns/:id/upload (multipart `file`)  → { campaign, rows, summary, previewId }
 *   POST /campaigns/:id/confirm {previewId, expectedValidCount, expectedTotalRupees} → campaign
 *        (the preview version + numbers the admin saw; the server refuses if its preview differs → re-upload)
 *   GET  /campaigns                                → list with summary counts
 *   GET  /campaigns/:id                            → campaign + delivery summary
 *   GET  /campaigns/:id/rows?status=&page=         → rows (voucher code masked; optional canResend / canRetryBuy)
 *   GET  /campaigns/:id/report.xlsx                → file
 *   POST /campaigns/:id/rows/:rowId/resend
 *   POST /campaigns/:id/rows/:rowId/retry-buy
 *   POST /campaigns/:id/cancel
 *
 * The normalisers are tolerant of small shape differences (envelope vs bare body, nested vs flat
 * summary, a few field-name aliases) but they NEVER invent data:
 *   - a number the server did not send is `null` and renders as "—" (never 0);
 *   - a status the server sent that this UI does not know is UNKNOWN and renders as
 *     "Unknown status: X" (never "Invalid", never setup / nothing-spent wording) and keeps polling.
 * ───────────────────────────────────────────────────────────────────────────────── */

import { formatInrPaise } from '@/lib/format-inr';

export const VD_BASE = '/api/admin/voucher-dispersal';
export const VD_TEMPLATE_URL = `${VD_BASE}/template.xlsx`;
export const vdReportUrl = (id: string) => `${VD_BASE}/campaigns/${encodeURIComponent(id)}/report.xlsx`;

// ─── Status unions ──────────────────────────────────────────────────────────────

export const CAMPAIGN_STATUSES = [
  'DRAFT', 'PREVIEWED', 'CONFIRMED', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED',
] as const;
/** UNKNOWN = the server sent a status this UI does not recognise (shown with the raw value). */
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number] | 'UNKNOWN';

export const ROW_STATUSES = [
  'VALID', 'INVALID', 'DUPLICATE', 'QUEUED', 'BUYING', 'PENDING_RECONCILE', 'BOUGHT', 'BUY_FAILED', 'CANCELLED',
] as const;
export type RowStatus = (typeof ROW_STATUSES)[number] | 'UNKNOWN';

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
  UNKNOWN: 'Unknown status',
};

export const CAMPAIGN_STATUS_TONE: Record<CampaignStatus, Tone> = {
  DRAFT: 'neutral',
  PREVIEWED: 'info',
  CONFIRMED: 'progress',
  PROCESSING: 'progress',
  COMPLETED: 'success',
  COMPLETED_WITH_ERRORS: 'warning',
  CANCELLED: 'neutral',
  UNKNOWN: 'warning',
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
  UNKNOWN: 'Unknown status',
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
  UNKNOWN: 'warning',
};

/** Chip text: the known label, or "Unknown status: <raw>" so an unexpected value is never disguised. */
export function campaignStatusText(c: { status: CampaignStatus; rawStatus: string }): string {
  return c.status === 'UNKNOWN' ? `Unknown status: ${c.rawStatus || '(none)'}` : CAMPAIGN_STATUS_LABEL[c.status];
}
export function rowStatusText(r: { status: RowStatus; rawStatus: string }): string {
  return r.status === 'UNKNOWN' ? `Unknown status: ${r.rawStatus || '(none)'}` : ROW_STATUS_LABEL[r.status];
}

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
  minAmount: number | null;
  maxAmount: number | null;
  denominations: number[] | null;
}

export interface VdCampaign {
  id: string;
  name: string;
  programLabel: string;
  billedToClientId: string | null;
  billedToClientName: string | null;
  note: string | null;
  budgetRupees: number | null;
  status: CampaignStatus;
  /** The status exactly as the server sent it (shown when UNKNOWN). */
  rawStatus: string;
  createdAt: string | null;
  confirmedAt: string | null;
  completedAt: string | null;
  /** Server's own verdict, when it sends one; otherwise the status rule below decides. */
  canCancel: boolean | null;
}

/** Every count is `null` when the server did not send it (rendered "—", never 0). */
export interface VdDeliverySummary {
  bought: number | null;
  pending: number | null;
  buyFailed: number | null;
  messageSent: number | null;
  delivered: number | null;
  read: number | null;
  messageFailed: number | null;
  spentRupees: number | null;
}

export interface VdListItem {
  campaign: VdCampaign;
  summary: VdDeliverySummary;
}

export interface VdPreviewRow {
  rowNumber: number | null;
  phone: string;
  name: string;
  amount: number | null;
  brand: string;
  status: RowStatus;
  rawStatus: string;
  invalidReason: string | null;
}

export interface VdPerBrand {
  brand: string;
  count: number | null;
  rupees: number | null;
}

export interface VdPreviewSummary {
  total: number | null;
  valid: number | null;
  invalid: number | null;
  duplicates: number | null;
  totalRupees: number | null;
  budgetRupees: number | null;
  overBudget: boolean;
  perBrand: VdPerBrand[];
}

export interface VdPreview {
  campaign: VdCampaign | null;
  rows: VdPreviewRow[];
  summary: VdPreviewSummary;
  /** Opaque preview version from the upload — sent back on confirm. */
  previewId: string | null;
}

export interface VdRow {
  id: string;
  rowNumber: number | null;
  phone: string;
  name: string;
  amount: number | null;
  brand: string;
  status: RowStatus;
  rawStatus: string;
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
  canResend: boolean | null;
  canRetryBuy: boolean | null;
}

export interface VdRowsPage {
  rows: VdRow[];
  total: number | null;
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
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const pick = (o: Obj, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

function asCampaignStatus(v: unknown): { status: CampaignStatus; rawStatus: string } {
  const raw = typeof v === 'string' ? v : v == null ? '' : String(v);
  const s = raw.toUpperCase();
  return { status: (CAMPAIGN_STATUSES as readonly string[]).includes(s) ? (s as CampaignStatus) : 'UNKNOWN', rawStatus: raw };
}

function asRowStatus(v: unknown): { status: RowStatus; rawStatus: string } {
  const raw = typeof v === 'string' ? v : v == null ? '' : String(v);
  const s = raw.toUpperCase();
  return { status: (ROW_STATUSES as readonly string[]).includes(s) ? (s as RowStatus) : 'UNKNOWN', rawStatus: raw };
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
    budgetRupees: num(o.budgetRupees),
    ...asCampaignStatus(o.status),
    createdAt: str(o.createdAt),
    confirmedAt: str(o.confirmedAt),
    completedAt: str(pick(o, 'completedAt', 'finishedAt')),
    canCancel: bool(o.canCancel),
  };
}

export function normalizeDeliverySummary(raw: unknown): VdDeliverySummary {
  const o = isObj(raw) ? raw : {};
  return {
    bought: num(o.bought),
    pending: num(o.pending),
    buyFailed: num(o.buyFailed),
    messageSent: num(o.messageSent),
    delivered: num(o.delivered),
    read: num(o.read),
    messageFailed: num(o.messageFailed),
    spentRupees: num(o.spentRupees),
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
      count: num(pick(b, 'count', 'rows', 'valid')),
      rupees: num(pick(b, 'rupees', 'totalRupees', 'amount')),
    }));
  }
  if (isObj(raw)) {
    return Object.entries(raw).map(([brand, v]) =>
      isObj(v)
        ? { brand, count: num(pick(v, 'count', 'rows', 'valid')), rupees: num(pick(v, 'rupees', 'totalRupees', 'amount')) }
        : { brand, count: num(v), rupees: null },
    );
  }
  return [];
}

export function normalizePreviewRow(raw: unknown): VdPreviewRow {
  const o = isObj(raw) ? raw : {};
  return {
    rowNumber: num(o.rowNumber),
    phone: str(o.phone) ?? '',
    name: str(o.name) ?? '',
    amount: num(o.amount),
    brand: str(o.brand) ?? '',
    ...asRowStatus(o.status),
    invalidReason: str(o.invalidReason),
  };
}

export function normalizePreview(raw: unknown): VdPreview {
  const o = isObj(raw) ? raw : {};
  const s = isObj(o.summary) ? o.summary : {};
  return {
    campaign: isObj(o.campaign) ? normalizeCampaign(o.campaign) : null,
    rows: Array.isArray(o.rows) ? o.rows.map(normalizePreviewRow) : [],
    summary: {
      total: num(s.total),
      valid: num(s.valid),
      invalid: num(s.invalid),
      duplicates: num(s.duplicates),
      totalRupees: num(s.totalRupees),
      budgetRupees: num(s.budgetRupees),
      overBudget: s.overBudget === true,
      perBrand: normalizePerBrand(s.perBrand),
    },
    previewId: str(o.previewId) ?? str(s.previewId),
  };
}

export function normalizeRow(raw: unknown): VdRow {
  const o = isObj(raw) ? raw : {};
  return {
    id: str(o.id) ?? '',
    rowNumber: num(o.rowNumber),
    phone: str(o.phone) ?? '',
    name: str(o.name) ?? '',
    amount: num(o.amount),
    brand: str(o.brand) ?? '',
    ...asRowStatus(o.status),
    reason: str(pick(o, 'invalidReason', 'buyError', 'failureReason', 'buyFailureReason', 'reconcileNote', 'error')),
    hubbleRef: str(pick(o, 'hubbleRef', 'hubbleOrderId', 'hubbleReference', 'hubbleOrderRef')),
    voucherCode: maskVoucherCode(str(pick(o, 'voucherCode', 'voucherCodeMasked', 'codeMasked', 'maskedCode'))),
    messageStatus: asMessageStatus(o.messageStatus),
    messageSentAt: str(pick(o, 'messageSentAt', 'sentAt')),
    messageDeliveredAt: str(pick(o, 'messageDeliveredAt', 'deliveredAt')),
    messageReadAt: str(pick(o, 'messageReadAt', 'readAt')),
    messageFailedAt: str(pick(o, 'messageFailedAt', 'failedAt')),
    messageError: str(pick(o, 'messageError', 'messageFailureReason', 'messageFailReason')),
    canResend: bool(o.canResend),
    canRetryBuy: bool(o.canRetryBuy),
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
    total: num(o.total),
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
    minAmount: num(o.minAmount),
    maxAmount: num(o.maxAmount),
    denominations: Array.isArray(o.denominations) ? o.denominations.map(num).filter((d): d is number => d !== null) : null,
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

// ─── Display helpers ────────────────────────────────────────────────────────────

/** ₹ with Indian grouping; 2 decimals only when there are paise. Missing → "—". */
export function formatRupees(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : formatInrPaise(v);
}

/** A count, or "—" when the server did not send it (never a made-up 0). */
export function formatCount(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-IN');
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** "1 duplicate row" / "3 duplicate rows". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** Billed-to display: the client's name, else its id, else "—". */
export function billedToText(c: Pick<VdCampaign, 'billedToClientName' | 'billedToClientId'>, clients?: VdClient[] | null): string {
  if (c.billedToClientName) return c.billedToClientName;
  if (c.billedToClientId) return clients?.find((x) => x.id === c.billedToClientId)?.name ?? c.billedToClientId;
  return '—';
}

/** Default programme label when a bill-to client is picked (still editable). */
export function defaultProgramLabel(clientName: string): string {
  return `${clientName} Loyalty`;
}

/**
 * Never show a full voucher code. Anything already masked by the server is kept; otherwise only
 * codes of 10+ characters reveal their last 4 — shorter codes are fully masked (4 of 6 would leak most of it).
 */
export function maskVoucherCode(code: string | null): string | null {
  if (!code) return null;
  if (/[*•]{3,}/.test(code)) return code;
  if (code.length >= 10) return `••••${code.slice(-4)}`;
  return '••••••••';
}

// ─── Business rules (pure) ──────────────────────────────────────────────────────

/** Over budget — the SAME condition drives the red colour and the purchase block. */
export function isOverBudget(s: Pick<VdPreviewSummary, 'overBudget' | 'totalRupees' | 'budgetRupees'>): boolean {
  return s.overBudget || (s.totalRupees !== null && s.budgetRupees !== null && s.totalRupees > s.budgetRupees);
}

/** Confirm-dialog title: `Buy and send N vouchers · ₹X total?` */
export function confirmDialogTitle(s: Pick<VdPreviewSummary, 'valid' | 'totalRupees'>): string {
  return `Buy and send ${formatCount(s.valid)} vouchers · ${formatRupees(s.totalRupees)} total?`;
}

export interface ConfirmBody {
  previewId: string;
  expectedValidCount: number;
  expectedTotalRupees: number;
}

/** Confirm body: the preview version + numbers the admin saw (null when any is missing → cannot confirm). */
export function confirmPayload(p: Pick<VdPreview, 'previewId' | 'summary'>): ConfirmBody | null {
  if (!p.previewId || p.summary.valid === null || p.summary.totalRupees === null) return null;
  return { previewId: p.previewId, expectedValidCount: p.summary.valid, expectedTotalRupees: p.summary.totalRupees };
}

export type ConfirmBlock = { blocked: true; reason: string } | { blocked: false };

/** Why "Buy & send" is blocked (or not): over budget, nothing valid, or the server reply was incomplete. */
export function confirmBlock(p: Pick<VdPreview, 'previewId' | 'summary'>): ConfirmBlock {
  const s = p.summary;
  if (isOverBudget(s)) {
    return {
      blocked: true,
      reason: `The valid rows total ${formatRupees(s.totalRupees)}, which is over the ${formatRupees(s.budgetRupees)} budget. Fix the file (or create a campaign with a bigger budget) and upload again.`,
    };
  }
  if (s.valid === null || s.totalRupees === null || !p.previewId) {
    return { blocked: true, reason: "The server's preview reply was incomplete (missing totals or preview id). Upload the file again." };
  }
  if (s.valid <= 0) return { blocked: true, reason: 'There are no valid rows to issue. Fix the file and upload again.' };
  return { blocked: false };
}

/** Live campaigns (money moving / messages going out). */
export function isLiveCampaign(status: CampaignStatus): boolean {
  return status === 'CONFIRMED' || status === 'PROCESSING';
}

/** A campaign that has not been confirmed — nothing has been spent. UNKNOWN is never "setup". */
export function isSetupCampaign(status: CampaignStatus): boolean {
  return status === 'DRAFT' || status === 'PREVIEWED';
}

export function canCancelCampaign(c: Pick<VdCampaign, 'status' | 'canCancel'>): boolean {
  if (c.canCancel !== null) return c.canCancel;
  return c.status === 'DRAFT' || c.status === 'PREVIEWED' || c.status === 'CONFIRMED' || c.status === 'PROCESSING';
}

/**
 * Resend WhatsApp: the server's `canResend` decides. Without it, only a BOUGHT row — and not while the
 * campaign is still PROCESSING with no message attempt yet (the first send may simply not have happened).
 */
export function canResendRow(r: Pick<VdRow, 'status' | 'canResend' | 'messageStatus'>, campaignStatus: CampaignStatus): boolean {
  if (r.canResend !== null) return r.canResend;
  if (r.status !== 'BOUGHT') return false;
  return !(campaignStatus === 'PROCESSING' && r.messageStatus === null);
}

/** Retry purchase: the server's own flag wins; otherwise only a failed purchase may be retried. */
export function canRetryRow(r: Pick<VdRow, 'status' | 'canRetryBuy'>): boolean {
  if (r.canRetryBuy !== null) return r.canRetryBuy;
  return r.status === 'BUY_FAILED';
}

/** Network failure or 5xx: the server may or may not have acted → the outcome is UNKNOWN. */
export function isUncertainFailure(status: number | undefined): boolean {
  return status === undefined || status >= 500;
}

/** Polling: start at 3s, back off ×1.5 to a 30s ceiling. */
export const POLL_START_MS = 3_000;
export const POLL_MAX_MS = 30_000;
export function nextPollDelay(prev: number): number {
  return Math.min(POLL_MAX_MS, Math.round(Math.max(prev, POLL_START_MS) * 1.5));
}

/** After a campaign completes, keep refreshing this long for late WhatsApp delivered / read updates. */
export const POLL_AFTER_COMPLETE_MS = 30 * 60 * 1000;

export type PollPhase = 'live' | 'settling' | 'unknown' | 'off';

/**
 * Whether the detail view should auto-refresh:
 *  - 'live'     while CONFIRMED / PROCESSING;
 *  - 'unknown'  while the status is not one this UI knows (keep watching rather than go quiet);
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
  if (c.status === 'UNKNOWN') return 'unknown';
  if (c.status !== 'COMPLETED' && c.status !== 'COMPLETED_WITH_ERRORS') return 'off';
  const serverAt = c.completedAt ? new Date(c.completedAt).getTime() : NaN;
  const from = Number.isFinite(serverAt) ? serverAt : observedCompletedAt;
  if (from === null) return 'off';
  return now - from < POLL_AFTER_COMPLETE_MS ? 'settling' : 'off';
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

/** Client-side file check before upload (the server re-validates everything). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export function checkUploadFile(f: { name: string; size: number }): string | null {
  if (!/\.(xlsx|xls|csv)$/i.test(f.name)) return 'Choose an Excel (.xlsx / .xls) or .csv file.';
  if (f.size === 0) return 'That file is empty.';
  if (f.size > MAX_UPLOAD_BYTES) return 'That file is over 10 MB. Split the list into smaller files.';
  return null;
}

// ─── API adapter ────────────────────────────────────────────────────────────────

/** `status` is undefined for a network failure (no response at all). */
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
  return `The server could not complete this (error ${res.status}).`;
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
    return { ok: false, error: 'The server reply could not be read. Please refresh.', status: res.status };
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

  confirm: (id: string, body: ConfirmBody) =>
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
