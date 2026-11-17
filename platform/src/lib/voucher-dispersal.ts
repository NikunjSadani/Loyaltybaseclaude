/* ─── Voucher Dispersal — types, pure rules, and the API adapter ─────────────────
 *
 * A GENERIC, PLATFORM-LEVEL Gifsy tool (owner-approved 2026-11-16): a GIFSY_ADMIN uploads a
 * list of phone + name + amount + brand, previews it, confirms in a dialog, and the server buys
 * one Hubble voucher per valid row and sends it on WhatsApp. It is NOT a tenant feature — it
 * lives in the /gifsy console and never depends on an assumed tenant. A campaign may optionally
 * be billed to a client (billedToClientId) — that only labels it.
 *
 * Contract AS BUILT (api/src/voucher-dispersal — see platform/docs/plans/VOUCHER-DISPERSAL.md §3).
 * All GIFSY_ADMIN only; proxied /api/admin/voucher-dispersal/* → /v1/admin/voucher-dispersal/*;
 * every JSON reply is the `{ success, data }` envelope (errors `{ success:false, error }`):
 *   GET  /brands                                   → brand[]
 *   GET  /template.xlsx                            → file
 *   POST /campaigns {name, programLabel, billedToClientId?, note?, budgetRupees} → campaign
 *   POST /campaigns/:id/upload (multipart `file`, .xlsx only) → { previewId, campaign, rows, summary }
 *   POST /campaigns/:id/confirm {previewId, expectedValidCount, expectedTotalRupees} → campaign
 *        (the preview version + numbers the admin saw; the server refuses if its preview differs → re-upload)
 *   POST /campaigns/:id/process                    → { pass, campaign, hubbleConfigured, summary } (bounded pass)
 *   GET  /campaigns?page=                          → campaign[] (each carrying `summary`), 50 per page, newest first
 *   GET  /campaigns/:id                            → { campaign, hubbleConfigured, summary }
 *   GET  /campaigns/:id/rows?status=&page=         → { rows, total, page, pageSize } (code masked by the server)
 *   GET  /campaigns/:id/report.xlsx                → file
 *   POST /campaigns/:id/rows/:rowId/resend         → row
 *   POST /campaigns/:id/rows/:rowId/retry-buy      → { message, row }
 *   POST /campaigns/:id/cancel                     → { campaign, cancelledRows, stillWithHubble, alreadyBought }
 *
 * The normalisers read the server's field names EXACTLY (no aliases) — the contract test
 * (src/lib/__tests__/voucher-dispersal.contract.test.ts) runs them over a fixture produced by the real
 * server code and fails if any field they read is missing. They NEVER invent data:
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

/**
 * The server's `pendingReason` is a code (processor `markPending`). Plain words for each; an unknown
 * code still shows the generic note plus the raw code (never hidden).
 */
export function pendingReasonText(code: string | null): string {
  if (!code) return PENDING_RECONCILE_NOTE;
  const c = code.toUpperCase();
  const tail = ' It is checked with Hubble automatically and is not counted as bought or failed until then.';
  if (c === 'STALE_BUYING') return `The purchase call was interrupted before Hubble answered.${tail}`;
  if (c === 'HUBBLE_PROCESSING') return `Hubble is still processing this order.${tail}`;
  if (c === 'HUBBLE_SUCCESS_NO_CODE') return `Hubble reported success but has not returned the voucher code yet.${tail}`;
  if (c === 'HUBBLE_INDETERMINATE' || c === 'UNEXPECTED') return `Hubble did not give a clear answer (timeout or server error).${tail}`;
  if (c === 'HUBBLE_REJECTED_UNVERIFIED') return `Hubble refused the order, but we could not yet verify that no order exists.${tail}`;
  if (c.startsWith('HUBBLE_UNKNOWN_STATUS')) return `Hubble returned an unexpected status (${code.split(':').slice(1).join(':') || 'none'}).${tail}`;
  return `${PENDING_RECONCILE_NOTE} (${code})`;
}

// ─── Shapes ─────────────────────────────────────────────────────────────────────

export interface VdBrand {
  key: string;
  label: string;
  productId: string;
  minAmount: number | null;
  maxAmount: number | null;
  denominations: number[] | null;
  /** FIXED / FLEXIBLE as Hubble reports it LIVE; null when Hubble could not be asked. */
  denominationType: string | null;
  /** false = Hubble could not return this brand's limits → its rows are INVALID until it can. */
  available: boolean | null;
  unavailableReason: string | null;
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
  sourceFileName: string | null;
  createdAt: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
  /** Server's own verdict, when it sends one; otherwise the status rule below decides. */
  canCancel: boolean | null;
}

/**
 * Every count is `null` when the server did not send it (rendered "—", never 0). The LIST endpoint
 * sends purchase counts only (no WhatsApp counts) — those stay null for list items.
 */
export interface VdDeliverySummary {
  valid: number | null;
  bought: number | null;
  pending: number | null;
  buyFailed: number | null;
  cancelled: number | null;
  messageSent: number | null;
  delivered: number | null;
  read: number | null;
  messageFailed: number | null;
  messageNotSent: number | null;
  spentRupees: number | null;
}

export interface VdListItem {
  campaign: VdCampaign;
  summary: VdDeliverySummary;
  /** Detail / process only: false = Hubble is not configured on this server (nothing can be bought). */
  hubbleConfigured: boolean | null;
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
  /** Cross-campaign warning (does not block): "Already got a ₹X … voucher on <date> in campaign …". */
  warning: string | null;
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
  /** Valid rows whose phone got a voucher in another campaign in the last 30 days (warning only). */
  warningCount: number | null;
  /** Server text for skipped blank / formula-only rows (null when none). */
  skippedNote: string | null;
  /** Server text for hidden rows that ARE included (null when none). */
  hiddenNote: string | null;
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
  /** Validation / purchase-failure / reconcile reason, in plain words. */
  reason: string | null;
  /** Cross-campaign warning from the upload (amber note; never blocked anything). */
  warning: string | null;
  /** Hubble order id when known, else our Hubble reference. */
  hubbleRef: string | null;
  /** Masked by the server (`••••` + last 4 of a 12+ char code, else `••••`); re-masked defensively. */
  voucherCodeMasked: string | null;
  messageStatus: MessageStatus | null;
  messageSentAt: string | null;
  messageDeliveredAt: string | null;
  messageReadAt: string | null;
  messageFailedAt: string | null;
  messageError: string | null;
  canResend: boolean | null;
  canRetryBuy: boolean | null;
  /** PENDING_RECONCILE: when Retry becomes available (2 h after the last attempt). */
  retryAvailableAt: string | null;
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

export interface VdCancelResult {
  campaign: VdCampaign;
  cancelledRows: number | null;
  stillWithHubble: number | null;
  alreadyBought: number | null;
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

/** Server sends SENT | DELIVERED | READ | FAILED | null. */
function asMessageStatus(v: unknown): MessageStatus | null {
  const s = String(v ?? '').toLowerCase();
  return s === 'sent' || s === 'delivered' || s === 'read' || s === 'failed' ? s : null;
}

// ─── Normalisers (exact server field names) ─────────────────────────────────────

/** Server `campaignView`. */
export function normalizeCampaign(raw: unknown): VdCampaign {
  const o = isObj(raw) ? raw : {};
  const billed = isObj(o.billedToClient) ? o.billedToClient : null;
  return {
    id: str(o.id) ?? '',
    name: str(o.name) ?? '',
    programLabel: str(o.programLabel) ?? '',
    billedToClientId: billed ? str(billed.id) : null,
    billedToClientName: billed ? str(billed.name) : null,
    note: str(o.note),
    budgetRupees: num(o.budgetRupees),
    ...asCampaignStatus(o.status),
    sourceFileName: str(o.sourceFileName),
    createdAt: str(o.createdAt),
    confirmedAt: str(o.confirmedAt),
    cancelledAt: str(o.cancelledAt),
    completedAt: str(o.completedAt),
    canCancel: bool(o.canCancel),
  };
}

/** GET /campaigns item summary — purchase counts only (no WhatsApp counts on the list). */
export function normalizeListSummary(raw: unknown): VdDeliverySummary {
  const o = isObj(raw) ? raw : {};
  return {
    valid: num(o.valid),
    bought: num(o.bought),
    pending: num(o.pending),
    buyFailed: num(o.buyFailed),
    cancelled: num(o.cancelled),
    messageSent: null,
    delivered: null,
    read: null,
    messageFailed: null,
    messageNotSent: null,
    spentRupees: num(o.spentRupees),
  };
}

/** GET /campaigns/:id (and POST /process) summary — purchase + WhatsApp counts. */
export function normalizeDeliverySummary(raw: unknown): VdDeliverySummary {
  const o = isObj(raw) ? raw : {};
  return {
    valid: num(o.valid),
    bought: num(o.bought),
    pending: num(o.pending),
    buyFailed: num(o.buyFailed),
    cancelled: num(o.cancelled),
    messageSent: num(o.messageSent),
    delivered: num(o.delivered),
    read: num(o.read),
    messageFailed: num(o.messageFailed),
    messageNotSent: num(o.messageNotSent),
    spentRupees: num(o.spentRupees),
  };
}

/** One GET /campaigns item: the campaign's own fields + `summary`. */
export function normalizeListItem(raw: unknown): VdListItem {
  const o = isObj(raw) ? raw : {};
  return { campaign: normalizeCampaign(o), summary: normalizeListSummary(o.summary), hubbleConfigured: null };
}

/** GET /campaigns/:id and POST /campaigns/:id/process: `{ campaign, hubbleConfigured, summary }`. */
export function normalizeDetail(raw: unknown): VdListItem {
  const o = isObj(raw) ? raw : {};
  return {
    campaign: normalizeCampaign(o.campaign),
    summary: normalizeDeliverySummary(o.summary),
    hubbleConfigured: bool(o.hubbleConfigured),
  };
}

function normalizePerBrand(raw: unknown): VdPerBrand[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObj).map((b) => ({
    brand: str(b.brand) ?? '—',
    count: num(b.count),
    rupees: num(b.totalRupees),
  }));
}

/** One upload preview row. */
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
    warning: str(o.warning),
  };
}

/** POST /campaigns/:id/upload: `{ previewId, campaign, rows, summary }`. */
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
      warningCount: num(s.warningCount),
      skippedNote: str(s.skippedNote),
      hiddenNote: str(s.hiddenNote),
    },
    previewId: str(o.previewId),
  };
}

/** Server `rowView` (GET rows, resend reply, retry-buy reply's `row`). */
export function normalizeRow(raw: unknown): VdRow {
  const o = isObj(raw) ? raw : {};
  const st = asRowStatus(o.status);
  const invalidReason = str(o.invalidReason);
  const buyFailureReason = str(o.buyFailureReason);
  const pendingReason = str(o.pendingReason);
  const hubbleOrderId = str(o.hubbleOrderId);
  const hubbleReferenceId = str(o.hubbleReferenceId);
  const reason =
    invalidReason
    ?? buyFailureReason
    ?? (st.status === 'PENDING_RECONCILE' ? pendingReasonText(pendingReason) : null);
  return {
    id: str(o.id) ?? '',
    rowNumber: num(o.rowNumber),
    phone: str(o.phone) ?? '',
    name: str(o.name) ?? '',
    amount: num(o.amount),
    brand: str(o.brand) ?? '',
    ...st,
    reason,
    warning: str(o.warning),
    hubbleRef: hubbleOrderId ?? hubbleReferenceId,
    voucherCodeMasked: maskVoucherCode(str(o.voucherCodeMasked)),
    messageStatus: asMessageStatus(o.messageStatus),
    messageSentAt: str(o.messageSentAt),
    messageDeliveredAt: str(o.messageDeliveredAt),
    messageReadAt: str(o.messageReadAt),
    messageFailedAt: str(o.messageFailedAt),
    messageError: str(o.messageError),
    canResend: bool(o.canResend),
    canRetryBuy: bool(o.canRetryBuy),
    retryAvailableAt: str(o.retryAvailableAt),
  };
}

/** GET /campaigns/:id/rows: `{ rows, total, page, pageSize }`. */
export function normalizeRowsPage(raw: unknown, requestedPage: number): VdRowsPage {
  const o = isObj(raw) ? raw : {};
  const rows = Array.isArray(o.rows) ? o.rows.map(normalizeRow) : [];
  return {
    rows,
    total: num(o.total),
    page: num(o.page) ?? requestedPage,
    pageSize: num(o.pageSize) ?? (rows.length || 1),
  };
}

/** GET /brands item. */
export function normalizeBrand(raw: unknown): VdBrand {
  const o = isObj(raw) ? raw : {};
  return {
    key: str(o.key) ?? '',
    label: str(o.label) ?? str(o.key) ?? '',
    productId: str(o.productId) ?? '',
    minAmount: num(o.minAmount),
    maxAmount: num(o.maxAmount),
    denominations: Array.isArray(o.denominations) ? o.denominations.map(num).filter((d): d is number => d !== null) : null,
    denominationType: str(o.denominationType),
    available: bool(o.available),
    unavailableReason: str(o.unavailableReason),
  };
}

/** POST /campaigns/:id/cancel. */
export function normalizeCancelResult(raw: unknown): VdCancelResult {
  const o = isObj(raw) ? raw : {};
  return {
    campaign: normalizeCampaign(o.campaign),
    cancelledRows: num(o.cancelledRows),
    stillWithHubble: num(o.stillWithHubble),
    alreadyBought: num(o.alreadyBought),
  };
}

/** POST /campaigns/:id/rows/:rowId/retry-buy: `{ message, row }`. */
export function normalizeRetryResult(raw: unknown): { message: string | null; row: VdRow | null } {
  const o = isObj(raw) ? raw : {};
  return { message: str(o.message), row: isObj(o.row) ? normalizeRow(o.row) : null };
}

/** GET /v1/gifsy/clients → `{ clients: [{ id, slug (= id), internalName, displayName, … }] }`. */
export function normalizeClients(raw: unknown): VdClient[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.clients) ? raw.clients : [];
  return list
    .filter(isObj)
    .map((c) => ({
      // `billedToClientId` must be Client.id (the server looks it up by id; id IS the tenant slug).
      id: str(pick(c, 'id', 'slug')) ?? '',
      name: str(pick(c, 'displayName', 'internalName', 'name')) ?? str(pick(c, 'id', 'slug')) ?? '',
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

/** Server DTO limits (CreateDispersalCampaignDto). */
export const VD_NAME_MAX = 120;
export const VD_PROGRAM_LABEL_MAX = 60;
export const VD_NOTE_MAX = 500;
export const VD_BUDGET_MAX_RUPEES = 10_000_000;

export function validateCreateForm(f: CreateForm): Partial<Record<keyof CreateForm, string>> {
  const errors: Partial<Record<keyof CreateForm, string>> = {};
  if (!f.name.trim()) errors.name = 'Enter a campaign name.';
  else if (f.name.trim().length > VD_NAME_MAX) errors.name = `Keep the campaign name to ${VD_NAME_MAX} characters.`;
  if (!f.programLabel.trim()) errors.programLabel = 'Enter the programme name shown in the WhatsApp message.';
  else if (f.programLabel.trim().length > VD_PROGRAM_LABEL_MAX) errors.programLabel = `Keep the programme name to ${VD_PROGRAM_LABEL_MAX} characters.`;
  if (f.note.trim().length > VD_NOTE_MAX) errors.note = `Keep the note to ${VD_NOTE_MAX} characters.`;
  const raw = f.budgetRupees.trim();
  const b = Number(raw);
  if (raw === '' || !Number.isFinite(b) || b <= 0) errors.budgetRupees = 'Enter a budget in rupees greater than 0.';
  else if (!/^\d+$/.test(raw)) errors.budgetRupees = 'Enter the budget in whole rupees (no paise).';
  else if (b > VD_BUDGET_MAX_RUPEES) errors.budgetRupees = `The budget can be at most ${formatRupees(VD_BUDGET_MAX_RUPEES)} per campaign.`;
  return errors;
}

/** Client-side file check before upload (the server re-validates everything; it accepts .xlsx only). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export function checkUploadFile(f: { name: string; size: number }): string | null {
  if (!/\.xlsx$/i.test(f.name)) return 'Choose an Excel .xlsx file — download the template and fill it in.';
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
  // The `{success, data}` envelope (TransformInterceptor) — a bare body is tolerated.
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

/** GET /campaigns page size (server CAMPAIGNS_PAGE_SIZE). A full page means there may be another. */
export const VD_CAMPAIGNS_PAGE_SIZE = 50;

const asArray = (d: unknown): unknown[] => (Array.isArray(d) ? d : []);

export const vdApi = {
  brands: () => vdRequest('/brands', {}, (d) => asArray(d).map(normalizeBrand)),

  listCampaigns: (page = 1) =>
    vdRequest(`/campaigns?page=${encodeURIComponent(String(page))}`, {}, (d) => asArray(d).map(normalizeListItem)),

  getCampaign: (id: string) => vdRequest(`/campaigns/${cid(id)}`, {}, normalizeDetail),

  createCampaign: (body: { name: string; programLabel: string; billedToClientId?: string; note?: string; budgetRupees: number }) =>
    vdRequest('/campaigns', json(body), normalizeCampaign),

  upload: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    // No Content-Type header — the browser sets the multipart boundary.
    return vdRequest(`/campaigns/${cid(id)}/upload`, { method: 'POST', body: fd }, normalizePreview);
  },

  confirm: (id: string, body: ConfirmBody) => vdRequest(`/campaigns/${cid(id)}/confirm`, json(body), normalizeCampaign),

  /**
   * POST /process — a bounded processing pass (≤ 25 s) that nudges buying / sending while an admin
   * watches (Cloud Run gives CPU only during a request; the drain scheduler is the backup). SINGLE-FLIGHT
   * per campaign across the whole tab: a call made right after confirm and the detail page's poll-time
   * calls share one request — never two in flight for the same campaign.
   */
  process: (id: string): Promise<VdResult<VdListItem>> => {
    const cur = processInFlight.get(id);
    if (cur) return cur;
    const p = vdRequest(`/campaigns/${cid(id)}/process`, json({}), normalizeDetail).finally(() => {
      processInFlight.delete(id);
    });
    processInFlight.set(id, p);
    return p;
  },

  rows: (id: string, opts: { status?: string; page?: number }) => {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    const page = opts.page ?? 1;
    q.set('page', String(page));
    return vdRequest(`/campaigns/${cid(id)}/rows?${q.toString()}`, {}, (d) => normalizeRowsPage(d, page));
  },

  resend: (id: string, rowId: string) => vdRequest(`/campaigns/${cid(id)}/rows/${cid(rowId)}/resend`, json({}), normalizeRow),

  retryBuy: (id: string, rowId: string) =>
    vdRequest(`/campaigns/${cid(id)}/rows/${cid(rowId)}/retry-buy`, json({}), normalizeRetryResult),

  cancel: (id: string) => vdRequest(`/campaigns/${cid(id)}/cancel`, json({}), normalizeCancelResult),
};

const processInFlight = new Map<string, Promise<VdResult<VdListItem>>>();
/** True while a POST /process for this campaign is outstanding (any caller in this tab). */
export function isProcessInFlight(id: string): boolean {
  return processInFlight.has(id);
}

/**
 * Detail-page bookkeeping for the /process nudge: 4xx are ignored quietly (e.g. campaign not
 * processable); a non-blocking note appears only after REPEATED 5xx / network failures.
 */
export const PROCESS_FAILURES_BEFORE_NOTE = 2;
export function nextProcessFailures(prev: number, res: VdResult<unknown>): number {
  if (res.ok) return 0;
  return isUncertainFailure(res.status) ? prev + 1 : prev;
}

/** Whether the detail page should nudge processing: while live (CONFIRMED / PROCESSING) or in the 30-min settling window. */
export function shouldNudgeProcessing(phase: PollPhase): boolean {
  return phase === 'live' || phase === 'settling';
}

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
