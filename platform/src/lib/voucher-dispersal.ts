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
 *   POST /campaigns/:id/cancel                     → { campaign, cancelledRows, stillWithHubble, alreadyBought, discardedPendingBatchRows }
 *   PATCH /campaigns/:id {name?, budgetRupees?}    → campaign (budget never below spent + committed; audited)
 *   POST /campaigns/:id/batches (multipart `file`) → batch preview { batchNumber, batchStatus, previewId, campaign, rows, summary }
 *   GET  /campaigns/:id/batches/:n                 → the same preview, for a batch still waiting for confirmation
 *   POST /campaigns/:id/batches/:n/confirm {previewId, expectedValidCount, expectedTotalRupees} → campaign
 *   POST /campaigns/:id/batches/:n/discard         → { campaign, batchNumber, discardedRows }
 *   GET  /campaigns/:id/rows?batch=N               → only batch N (an unconfirmed batch is listed only this way)
 *
 * The normalisers read the server's field names EXACTLY (no aliases) — the contract test
 * (src/lib/__tests__/voucher-dispersal.contract.test.ts) runs them over a fixture produced by the real
 * server code and fails if any field they read is missing. They NEVER invent data:
 *   - a number the server did not send is `null` and renders as "—" (never 0);
 *   - a status the server sent that this UI does not know is UNKNOWN and renders as
 *     "Unknown status: X" (never "Invalid", never setup / nothing-spent wording) and keeps polling.
 * ───────────────────────────────────────────────────────────────────────────────── */

import { backgroundInit } from '@/lib/client-medium';
import { formatInrPaise } from '@/lib/format-inr';

export const VD_BASE = '/api/admin/voucher-dispersal';
export const VD_TEMPLATE_URL = `${VD_BASE}/template.xlsx`;
export const vdReportUrl = (id: string) => `${VD_BASE}/campaigns/${encodeURIComponent(id)}/report.xlsx`;
/** Report download file name used when the server sends none. */
export const vdReportFallbackName = (id: string) => `voucher-campaign-${id}.xlsx`;

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
  if (c === 'NO_ORDER_AT_HUBBLE_YET') return `Hubble has no order for this reference yet.${tail}`;
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
  /** Server: name / budget may be edited (every status except CANCELLED). */
  canEdit: boolean | null;
  /** Server: null = "Add more people" is available; otherwise the plain reason it is not. */
  addPeopleBlockedReason: string | null;
  /** Server: the last error once the campaign's status update has failed repeatedly (else null). */
  settleError: string | null;
}

/**
 * Every count is `null` when the server did not send it (rendered "—", never 0). The LIST endpoint
 * sends purchase counts only (no WhatsApp counts) — those stay null for list items.
 */
export interface VdDeliverySummary {
  valid: number | null;
  bought: number | null;
  pending: number | null;
  /** Buy failed — rows marked "not bought" are NOT included (they are `markedClosed`). */
  buyFailed: number | null;
  /** Rows an admin marked "not bought" — closed. */
  markedClosed: number | null;
  /** List only: OPEN order alerts of the campaign (shown as a badge on the card). */
  openOrderAlerts: number | null;
  cancelled: number | null;
  messageSent: number | null;
  delivered: number | null;
  read: number | null;
  messageFailed: number | null;
  messageNotSent: number | null;
  spentRupees: number | null;
  /** Detail only: the lowest the budget may be edited down to (already spent + committed). */
  budgetFloorRupees: number | null;
  /** Detail only: the SAME breakdown the server's floor / batch confirm / retry checks use. */
  budgetUsage: VdBudgetUsage | null;
  /** Detail only: > 0 when money spent or with Hubble (not queued) exceeds the budget. */
  overBudgetRupees: number | null;
  /** Detail only: queued vouchers that no longer fit within the budget. */
  queuedAtRiskRupees: number | null;
  /** Detail only: rows Hubble BOUGHT after they had failed / been refused. */
  lateCompletedRows: number | null;
  /** Detail only: rows that had failed and are back with Hubble (pending again) — they count again. */
  failedBackWithHubbleRows: number | null;
  /**
   * Detail only: order alerts — the OPEN total + latest (up to 20), and the RESOLVED ones (Hubble confirmed the order
   * failed / no order) apart. Never counted as spend.
   */
  earlierOrderAlerts: VdEarlierOrderAlerts;
  /** List only: an "Add more people" batch waiting for confirmation (its number), else null. */
  pendingBatchNumber: number | null;
}

export interface VdBudgetUsage {
  spentRupees: number | null;
  /** BUYING + PENDING_RECONCILE: with Hubble, not yet confirmed. */
  withHubbleRupees: number | null;
  /** Failed purchases whose reference reached Hubble — Hubble may still complete them. */
  failedMayCompleteRupees: number | null;
  queuedRupees: number | null;
  floorRupees: number | null;
}

/** A row reference: "batch 1, row 3". */
export interface VdRowRef {
  batchNumber: number | null;
  rowNumber: number | null;
}

export interface VdEarlierOrderAlerts {
  total: number | null;
  items: VdEarlierOrderAlert[];
  resolvedTotal: number | null;
  resolvedItems: VdEarlierOrderAlert[];
}

/**
 * One alert (one per Hubble reference): Hubble activity on an order the campaign no longer acts on — an EARLIER
 * (retired) order of a row, the order of a row marked "not bought", or the row's CURRENT order that completed but
 * could not be applied (NOT_APPLIED).
 */
export interface VdEarlierOrderAlert extends VdRowRef {
  /** When it was created or last got worse. */
  at: string | null;
  /** When it was first raised. */
  firstAt: string | null;
  kind: 'SUPERSEDED' | 'MARKED_NOT_BOUGHT' | 'NOT_APPLIED' | string;
  referenceId: string | null;
  /** The strongest REAL status Hubble reported; LOOKUP_FAILED only when it could never be checked; FAILED / NO_ORDER when resolved. */
  hubbleStatus: string | null;
  /** Every report for this reference, oldest first (latest 20). */
  statusHistory: string[];
  /** Last time the lookup itself failed. */
  lastCheckFailedAt: string | null;
  /** Set when Hubble confirmed the order failed / there is no order. */
  resolvedAt: string | null;
}

function alertSubject(kind: string): string {
  return kind === 'MARKED_NOT_BOUGHT'
    ? 'the order of this row (marked not bought)'
    : kind === 'NOT_APPLIED'
      ? "this row's current order"
      : 'an earlier order (retired by a retry)';
}

/** OUR labels on an alert (the server prefixes them `__`; a raw Hubble status never starts with it). */
export const VD_ALERT_LABEL: Record<string, string> = {
  __LOOKUP_FAILED: "couldn't check",
  __NO_ORDER: 'no order',
  __NO_ORDER_UNVERIFIED: 'no order (unverified)',
  __APPLIED: 'applied to the row',
};

function alertHistory(a: VdEarlierOrderAlert): string {
  const label = (x: string) => VD_ALERT_LABEL[x] ?? x;
  return a.statusHistory.length > 1 ? ` (reports: ${a.statusHistory.map(label).join(' → ')})` : '';
}

/** An open alert whose LATEST report says "failed / no order" — kept open (never resolved over a stronger report). */
function contradictionNote(a: VdEarlierOrderAlert): string {
  if (a.hubbleStatus === null || a.hubbleStatus.startsWith('__')) return '';
  const last = a.statusHistory[a.statusHistory.length - 1];
  if (last === 'FAILED') return ' Hubble now says the order failed — this contradicts its earlier report, so the alert stays open.';
  if (last === '__NO_ORDER') return ' Hubble now says there is no order — this contradicts its earlier report, so the alert stays open.';
  if (last === '__NO_ORDER_UNVERIFIED') return ' Hubble now says there is no order, but that could not be verified, so the alert stays open.';
  if (last === '__APPLIED') return " Hubble's answer was applied to the row since — but it reported more earlier, so the alert stays open.";
  return '';
}

function alertRef(a: VdEarlierOrderAlert): string {
  const ref = rowRefText(a);
  return `${ref.charAt(0).toUpperCase()}${ref.slice(1)}`;
}

/**
 * An OPEN alert, worded per kind and the REAL status: "Batch 1, row 3: an earlier order (retired by a retry) — Hubble
 * reports it completed (reports: …) — check with Hubble (…)." "Couldn't check" only when no real status is known.
 */
export function earlierOrderAlertText(a: VdEarlierOrderAlert): string {
  const st = a.hubbleStatus;
  const notApplied = a.kind === 'NOT_APPLIED';
  const status =
    st === '__NO_ORDER_UNVERIFIED'
      ? 'Hubble says there is no order, but that is not verified yet (re-checked automatically)'
      : st === '__LOOKUP_FAILED' || st === null
      ? "couldn't check it with Hubble (the lookup failed; no status known yet)"
      : st === 'SUCCESS'
        ? `Hubble reports it completed${notApplied ? ', but it could not be applied to the row' : ''}`
        : st === 'PROCESSING'
          ? `Hubble reports it still processing${notApplied ? ' (not applied to the row)' : ''}`
          : `Hubble reports a status we do not recognise ("${st}")`;
  const tail =
    st === null || st.startsWith('__')
      ? 'check it with Hubble'
      : a.kind === 'MARKED_NOT_BOUGHT'
        ? 'check with Hubble (a voucher may have been issued; the row stays closed)'
        : notApplied
          ? 'check with Hubble (a paid voucher may not have reached the person)'
          : 'check with Hubble (a voucher may have been issued twice)';
  const lastCheck =
    a.lastCheckFailedAt && st !== null && !st.startsWith('__')
      ? ` The last check with Hubble failed (${formatWhen(a.lastCheckFailedAt)}) — Hubble may have reported more since.`
      : '';
  return `${alertRef(a)}: ${alertSubject(a.kind)} — ${status}${alertHistory(a)} — ${tail}.${contradictionNote(a)}${lastCheck}`;
}

/** A RESOLVED alert: "Batch 1, row 3: an earlier order (retired by a retry) — resolved: Hubble confirmed the order failed (reports: …)." */
export function resolvedOrderAlertText(a: VdEarlierOrderAlert): string {
  const why =
    a.hubbleStatus === '__NO_ORDER'
      ? 'Hubble confirmed there is no order'
      : a.hubbleStatus === '__APPLIED'
        ? "Hubble's answer was applied to the row"
        : 'Hubble confirmed the order failed';
  return `${alertRef(a)}: ${alertSubject(a.kind)} — resolved: ${why}${alertHistory(a)}.`;
}

/** "spent ₹A · with Hubble (not yet confirmed) ₹B · failed purchases Hubble may still complete ₹C · queued ₹D". */
export function budgetUsageText(u: VdBudgetUsage): string {
  return `spent ${formatRupees(u.spentRupees)} · with Hubble (not yet confirmed) ${formatRupees(u.withHubbleRupees)} · failed purchases Hubble may still complete ${formatRupees(u.failedMayCompleteRupees)} · queued ${formatRupees(u.queuedRupees)}`;
}

export const BATCH_STATUSES = ['PREVIEWED', 'CONFIRMED', 'DISCARDED', 'CANCELLED'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number] | 'UNKNOWN';
export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  PREVIEWED: 'Waiting for confirmation — nothing bought',
  CONFIRMED: 'Confirmed',
  DISCARDED: 'Discarded — nothing bought',
  CANCELLED: 'Cancelled before confirming',
  UNKNOWN: 'Unknown status',
};
export const BATCH_STATUS_TONE: Record<BatchStatus, Tone> = {
  PREVIEWED: 'info',
  CONFIRMED: 'success',
  DISCARDED: 'neutral',
  CANCELLED: 'neutral',
  UNKNOWN: 'warning',
};

/** One upload batch (1 = the campaign's first file; 2, 3, … = "Add more people"). */
export interface VdBatch {
  batchNumber: number | null;
  status: BatchStatus;
  rawStatus: string;
  sourceFileName: string | null;
  uploadedByName: string | null;
  uploadedAt: string | null;
  confirmedByName: string | null;
  confirmedAt: string | null;
  discardedByName: string | null;
  discardedAt: string | null;
  discardReason: string | null;
  /** Only while waiting for confirmation. */
  previewId: string | null;
  total: number | null;
  valid: number | null;
  invalid: number | null;
  duplicates: number | null;
  bought: number | null;
  buyFailed: number | null;
  /** Rows marked "not bought" — closed (not in `buyFailed`). */
  markedClosed: number | null;
  pending: number | null;
  cancelled: number | null;
  totalRupees: number | null;
  spentRupees: number | null;
}

export interface VdEditChange {
  field: 'name' | 'budgetRupees' | string;
  from: string | number | null;
  to: string | number | null;
}

/** One audited campaign edit (who, when, old → new). */
export interface VdEdit {
  at: string | null;
  byName: string | null;
  changes: VdEditChange[];
}

export interface VdListItem {
  campaign: VdCampaign;
  summary: VdDeliverySummary;
  /** Detail / process only: false = Hubble is not configured on this server (nothing can be bought). */
  hubbleConfigured: boolean | null;
  /** Detail only (empty for list items): every upload batch. */
  batches: VdBatch[];
  /** Detail only (empty for list items): name / budget edits, newest first. */
  edits: VdEdit[];
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

/** An "Add more people" batch preview: the budget is checked against what is LEFT of the campaign budget. */
export interface VdBatchPreview extends VdPreview {
  batchNumber: number | null;
  batchStatus: BatchStatus;
  /** Already spent + committed on the campaign (every earlier batch). */
  alreadyCommittedRupees: number | null;
  /** Budget − already spent / committed (never below 0). */
  remainingBudgetRupees: number | null;
  /** > 0 when spending already exceeds the budget. */
  overBudgetRupees: number | null;
  /** Rows marked DUPLICATE because the phone already has a voucher (or a failed purchase) in an earlier batch. */
  crossBatchDuplicates: number | null;
}

export interface VdDiscardResult {
  campaign: VdCampaign;
  batchNumber: number | null;
  discardedRows: number | null;
}

export interface VdRow {
  id: string;
  /** Upload batch this row came from (1 = the first file). */
  batchNumber: number | null;
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
  /** Server: Hubble's last answer was a status it does not recognise → an admin may "Mark as not bought". */
  canMarkNotBought: boolean | null;
  /** Server: the row was marked "not bought" — closed (who + what to do); null otherwise. */
  closedNote: string | null;
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
  /** Rows of an unconfirmed "Add more people" batch removed with the cancel. */
  discardedPendingBatchRows: number | null;
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
    canEdit: bool(o.canEdit),
    addPeopleBlockedReason: str(o.addPeopleBlockedReason),
    settleError: str(o.settleError),
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
    markedClosed: num(o.markedClosed),
    openOrderAlerts: num(o.openOrderAlerts),
    cancelled: num(o.cancelled),
    messageSent: null,
    delivered: null,
    read: null,
    messageFailed: null,
    messageNotSent: null,
    spentRupees: num(o.spentRupees),
    budgetFloorRupees: null,
    budgetUsage: null,
    overBudgetRupees: null,
    queuedAtRiskRupees: null,
    lateCompletedRows: null,
    failedBackWithHubbleRows: null,
    earlierOrderAlerts: { total: null, items: [], resolvedTotal: null, resolvedItems: [] },
    pendingBatchNumber: num(o.pendingBatchNumber),
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
    markedClosed: num(o.markedClosed),
    openOrderAlerts: null,
    cancelled: num(o.cancelled),
    messageSent: num(o.messageSent),
    delivered: num(o.delivered),
    read: num(o.read),
    messageFailed: num(o.messageFailed),
    messageNotSent: num(o.messageNotSent),
    spentRupees: num(o.spentRupees),
    budgetFloorRupees: num(o.budgetFloorRupees),
    budgetUsage: isObj(o.budgetUsage)
      ? {
          spentRupees: num(o.budgetUsage.spentRupees),
          withHubbleRupees: num(o.budgetUsage.withHubbleRupees),
          failedMayCompleteRupees: num(o.budgetUsage.failedMayCompleteRupees),
          queuedRupees: num(o.budgetUsage.queuedRupees),
          floorRupees: num(o.budgetUsage.floorRupees),
        }
      : null,
    overBudgetRupees: num(o.overBudgetRupees),
    queuedAtRiskRupees: num(o.queuedAtRiskRupees),
    lateCompletedRows: num(o.lateCompletedRows),
    failedBackWithHubbleRows: num(o.failedBackWithHubbleRows),
    earlierOrderAlerts: normalizeEarlierOrderAlerts(o.earlierOrderAlerts),
    pendingBatchNumber: null,
  };
}

function asBatchStatus(v: unknown): { status: BatchStatus; rawStatus: string } {
  const raw = typeof v === 'string' ? v : v == null ? '' : String(v);
  const s = raw.toUpperCase();
  return { status: (BATCH_STATUSES as readonly string[]).includes(s) ? (s as BatchStatus) : 'UNKNOWN', rawStatus: raw };
}

/** One `batches[]` item of GET /campaigns/:id. */
export function normalizeBatch(raw: unknown): VdBatch {
  const o = isObj(raw) ? raw : {};
  return {
    batchNumber: num(o.batchNumber),
    ...asBatchStatus(o.status),
    sourceFileName: str(o.sourceFileName),
    uploadedByName: str(o.uploadedByName),
    uploadedAt: str(o.uploadedAt),
    confirmedByName: str(o.confirmedByName),
    confirmedAt: str(o.confirmedAt),
    discardedByName: str(o.discardedByName),
    discardedAt: str(o.discardedAt),
    discardReason: str(o.discardReason),
    previewId: str(o.previewId),
    total: num(o.total),
    valid: num(o.valid),
    invalid: num(o.invalid),
    duplicates: num(o.duplicates),
    bought: num(o.bought),
    buyFailed: num(o.buyFailed),
    markedClosed: num(o.markedClosed),
    pending: num(o.pending),
    cancelled: num(o.cancelled),
    totalRupees: num(o.totalRupees),
    spentRupees: num(o.spentRupees),
  };
}

const scalar = (v: unknown): string | number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' ? v : null);

/** One `edits[]` item of GET /campaigns/:id. */
export function normalizeEdit(raw: unknown): VdEdit {
  const o = isObj(raw) ? raw : {};
  return {
    at: str(o.at),
    byName: str(o.byName),
    changes: Array.isArray(o.changes)
      ? o.changes.filter(isObj).map((c) => ({ field: str(c.field) ?? '', from: scalar(c.from), to: scalar(c.to) }))
      : [],
  };
}

/** One GET /campaigns item: the campaign's own fields + `summary`. */
export function normalizeListItem(raw: unknown): VdListItem {
  const o = isObj(raw) ? raw : {};
  return { campaign: normalizeCampaign(o), summary: normalizeListSummary(o.summary), hubbleConfigured: null, batches: [], edits: [] };
}

/** GET /campaigns/:id and POST /campaigns/:id/process: `{ campaign, hubbleConfigured, summary }`. */
export function normalizeDetail(raw: unknown): VdListItem {
  const o = isObj(raw) ? raw : {};
  return {
    campaign: normalizeCampaign(o.campaign),
    summary: normalizeDeliverySummary(o.summary),
    hubbleConfigured: bool(o.hubbleConfigured),
    batches: Array.isArray(o.batches) ? o.batches.map(normalizeBatch) : [],
    edits: Array.isArray(o.edits) ? o.edits.map(normalizeEdit) : [],
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

/** POST /campaigns/:id/batches and GET /campaigns/:id/batches/:n. */
export function normalizeBatchPreview(raw: unknown): VdBatchPreview {
  const o = isObj(raw) ? raw : {};
  const s = isObj(o.summary) ? o.summary : {};
  return {
    ...normalizePreview(raw),
    batchNumber: num(o.batchNumber),
    batchStatus: asBatchStatus(o.batchStatus).status,
    alreadyCommittedRupees: num(s.alreadyCommittedRupees),
    remainingBudgetRupees: num(s.remainingBudgetRupees),
    overBudgetRupees: num(s.overBudgetRupees),
    crossBatchDuplicates: num(s.crossBatchDuplicates),
  };
}

/** POST /campaigns/:id/batches/:n/discard. */
export function normalizeDiscardResult(raw: unknown): VdDiscardResult {
  const o = isObj(raw) ? raw : {};
  return { campaign: normalizeCampaign(o.campaign), batchNumber: num(o.batchNumber), discardedRows: num(o.discardedRows) };
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
    batchNumber: num(o.batchNumber),
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
    canMarkNotBought: bool(o.canMarkNotBought),
    closedNote: str(o.closedNote),
  };
}

function normalizeAlertList(raw: unknown): VdEarlierOrderAlert[] {
  return Array.isArray(raw)
    ? raw.filter(isObj).map((a) => ({
        at: str(a.at),
        firstAt: str(a.firstAt),
        statusHistory: Array.isArray(a.statusHistory) ? a.statusHistory.filter((x): x is string => typeof x === 'string') : [],
        kind: str(a.kind) ?? 'SUPERSEDED',
        batchNumber: num(a.batchNumber),
        rowNumber: num(a.rowNumber),
        referenceId: str(a.referenceId),
        hubbleStatus: str(a.hubbleStatus),
        lastCheckFailedAt: str(a.lastCheckFailedAt),
        resolvedAt: str(a.resolvedAt),
      }))
    : [];
}

function normalizeEarlierOrderAlerts(raw: unknown): VdEarlierOrderAlerts {
  const o = isObj(raw) ? raw : {};
  return { total: num(o.total), items: normalizeAlertList(o.items), resolvedTotal: num(o.resolvedTotal), resolvedItems: normalizeAlertList(o.resolvedItems) };
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
    discardedPendingBatchRows: num(o.discardedPendingBatchRows),
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
  return `Buy and send ${formatCount(s.valid)} ${s.valid === 1 ? 'voucher' : 'vouchers'} · ${formatRupees(s.totalRupees)} total?`;
}

export const RUPEE_DIGITS_ERROR = 'Enter digits only (e.g. 2500 or 2,500).';
const RUPEE_GT0_ERROR = 'Enter a budget in rupees greater than 0.';

export const RUPEE_COMMA_ERROR =
  'Use commas only between thousands (e.g. 2,500 or 1,25,000) — or type the amount without commas.';

/**
 * A rupee amount exactly as typed → its plain digits (the box keeps what was typed). A leading ₹ and outer
 * spaces are dropped; the DECIMAL POINT IS KEPT (so "2500.00" is refused as paise, never read as ₹2,50,000);
 * commas are accepted ONLY as a real thousands grouping — Indian (1,25,000) or Western (1,250,000) — anything
 * else ("25,00") is refused with `RUPEE_COMMA_ERROR`, never silently joined into another number.
 */
export function parseRupeeInput(raw: string): { clean: string; error: string | null } {
  const t = raw.trim().replace(/^₹\s*/, '');
  // A minus is "not above 0"; anything but ASCII digits / comma / point (1e5, 0x10, other scripts' digits,
  // inner spaces) is refused in plain words — never parsed into some other number.
  if (t.startsWith('-')) return { clean: t, error: RUPEE_GT0_ERROR };
  if (!/^[0-9.,]*$/.test(t)) return { clean: t, error: RUPEE_DIGITS_ERROR };
  if (!t.includes(',')) return { clean: t, error: null };
  const [whole, ...rest] = t.split('.');
  const indian = /^\d{1,2}(,\d{2})*,\d{3}$/.test(whole);
  const western = /^\d{1,3}(,\d{3})+$/.test(whole);
  if (rest.length > 1 || (!indian && !western)) return { clean: t, error: RUPEE_COMMA_ERROR };
  return { clean: [whole.replace(/,/g, ''), ...rest].join('.'), error: null };
}

/** "= ₹2,500" echo of what was typed (null when it is not a valid number). */
export function rupeeEcho(raw: string): string | null {
  const { clean, error } = parseRupeeInput(raw);
  if (error || !/^\d+(\.\d+)?$/.test(clean)) return null;
  const n = Number(clean);
  return Number.isFinite(n) && n > 0 ? `= ${formatRupees(n)}` : null;
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
      reason: `The valid rows total ${formatRupees(s.totalRupees)}, which is over the ${formatRupees(s.budgetRupees)} budget. Remove rows and upload again, or raise the budget with Edit campaign on the campaign page.`,
    };
  }
  if (s.valid === null || s.totalRupees === null || !p.previewId) {
    return { blocked: true, reason: "The server's preview reply was incomplete (missing totals or preview id). Upload the file again." };
  }
  if (s.valid <= 0) return { blocked: true, reason: 'There are no valid rows to issue. Fix the file and upload again.' };
  return { blocked: false };
}

/**
 * Why "Buy & send" is blocked for an "Add more people" batch: the server checks spent + committed + this
 * batch against the budget, so the advice is to RAISE the budget (Edit campaign) — not a new campaign.
 */
export function batchConfirmBlock(p: Pick<VdBatchPreview, 'previewId' | 'summary' | 'remainingBudgetRupees' | 'alreadyCommittedRupees'>): ConfirmBlock {
  const s = p.summary;
  if (s.overBudget || (s.totalRupees !== null && p.remainingBudgetRupees !== null && s.totalRupees > p.remainingBudgetRupees)) {
    return {
      blocked: true,
      reason: `This batch's valid rows total ${formatRupees(s.totalRupees)}, but only ${formatRupees(p.remainingBudgetRupees)} of the ${formatRupees(s.budgetRupees)} budget is left (${formatRupees(p.alreadyCommittedRupees)} is already spent or committed). Raise the budget with Edit campaign, or remove rows and upload again.`,
    };
  }
  if (s.valid === null || s.totalRupees === null || !p.previewId) {
    return { blocked: true, reason: "The server's preview reply was incomplete (missing totals or preview id). Upload the file again." };
  }
  if (s.valid <= 0) return { blocked: true, reason: 'There are no valid rows in this batch to issue. Fix the file and upload again, or discard the batch.' };
  return { blocked: false };
}

/**
 * Why the campaign is over budget, from the server's counts (never a guessed cause): purchases bought later after
 * failing, failed purchases back with Hubble, else a neutral pointer to the breakdown.
 */
export function overBudgetCauseText(s: Pick<VdDeliverySummary, 'lateCompletedRows' | 'failedBackWithHubbleRows'>): string {
  const parts: string[] = [];
  const late = s.lateCompletedRows ?? 0;
  const back = s.failedBackWithHubbleRows ?? 0;
  if (late > 0) parts.push(`${plural(late, 'purchase')} ${late === 1 ? 'was' : 'were'} bought later by Hubble after ${late === 1 ? 'it' : 'they'} had failed/refused`);
  if (back > 0) parts.push(`${plural(back, 'failed purchase')} ${back === 1 ? 'is' : 'are'} back with Hubble and count${back === 1 ? 's' : ''} again (${back === 1 ? 'it' : 'they'} may still be bought)`);
  return parts.length ? parts.join('; ') : 'spending is above the budget; see "Budget used" below';
}

/** "batch 1, row 3" (row numbers restart in every batch's file). */
export function rowRefText(r: VdRowRef): string {
  return r.batchNumber !== null ? `batch ${r.batchNumber}, row ${formatCount(r.rowNumber)}` : `row ${formatCount(r.rowNumber)}`;
}

/** "Batch 2" / "—". */
export function batchLabel(n: number | null): string {
  return n === null ? 'Batch —' : `Batch ${n}`;
}

/** A plain-words line for one audited edit change. */
export function editChangeText(c: VdEditChange): string {
  if (c.field === 'budgetRupees') {
    const n = (v: string | number | null) => (typeof v === 'number' ? formatRupees(v) : v === null ? '—' : String(v));
    return `Budget ${n(c.from)} → ${n(c.to)}`;
  }
  if (c.field === 'name') return `Name "${c.from ?? '—'}" → "${c.to ?? '—'}"`;
  return `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`;
}

export interface EditForm {
  name: string;
  budgetRupees: string;
}

/**
 * Edit-dialog validation. `floorRupees` = the server's `budgetFloorRupees` (null = unknown → the server decides
 * and its refusal is shown word-for-word). Nothing changed is an error too (the server refuses it).
 */
export function validateEditForm(f: EditForm, current: Pick<VdCampaign, 'name' | 'budgetRupees'>, floorRupees: number | null): Partial<Record<keyof EditForm | 'form', string>> {
  const errors: Partial<Record<keyof EditForm | 'form', string>> = {};
  const name = f.name.replace(/\s+/g, ' ').trim();
  if (!name) errors.name = 'Enter a campaign name.';
  else if (name.length > VD_NAME_MAX) errors.name = `Keep the campaign name to ${VD_NAME_MAX} characters.`;
  const { clean: raw, error: rawError } = parseRupeeInput(f.budgetRupees);
  const b = Number(raw);
  if (rawError) errors.budgetRupees = rawError;
  else if (raw === '' || !Number.isFinite(b) || b <= 0) errors.budgetRupees = 'Enter a budget in rupees greater than 0.';
  else if (!/^\d+$/.test(raw)) errors.budgetRupees = 'Enter the budget in whole rupees (no paise).';
  else if (b > VD_BUDGET_MAX_RUPEES) errors.budgetRupees = `The budget can be at most ${formatRupees(VD_BUDGET_MAX_RUPEES)} per campaign.`;
  // The floor only limits LOWERING the budget: a rename or a (partial) raise is always allowed, even when the
  // floor is above the current budget (e.g. a refused purchase completed later) — the server agrees.
  else if (floorRupees !== null && current.budgetRupees !== null && b < current.budgetRupees && b < floorRupees) {
    errors.budgetRupees = `The budget can't go below ${formatRupees(floorRupees)} — that much is already spent or committed to purchases in progress.`;
  }
  if (!errors.name && !errors.budgetRupees && name === current.name && b === current.budgetRupees) {
    errors.form = 'Nothing has changed.';
  }
  return errors;
}

/** PATCH body: only the fields that changed. */
export function editPayload(f: EditForm, current: Pick<VdCampaign, 'name' | 'budgetRupees'>): { name?: string; budgetRupees?: number } {
  const name = f.name.replace(/\s+/g, ' ').trim();
  const b = Number(parseRupeeInput(f.budgetRupees).clean);
  return { ...(name !== current.name ? { name } : {}), ...(b !== current.budgetRupees ? { budgetRupees: b } : {}) };
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
  const { clean: raw, error: rawError } = parseRupeeInput(f.budgetRupees);
  const b = Number(raw);
  if (rawError) errors.budgetRupees = rawError;
  else if (raw === '' || !Number.isFinite(b) || b <= 0) errors.budgetRupees = 'Enter a budget in rupees greater than 0.';
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

/** Usage Report: `background` marks an automatic poll / processing nudge (X-Background: 1) — not counted as activity. */
type BgOpt = { background?: boolean };
const bg = (init: RequestInit, o?: BgOpt): RequestInit => (o?.background ? backgroundInit(init) : init);

/** GET /campaigns page size (server CAMPAIGNS_PAGE_SIZE). A full page means there may be another. */
export const VD_CAMPAIGNS_PAGE_SIZE = 50;

const asArray = (d: unknown): unknown[] => (Array.isArray(d) ? d : []);

export const vdApi = {
  brands: () => vdRequest('/brands', {}, (d) => asArray(d).map(normalizeBrand)),

  listCampaigns: (page = 1) =>
    vdRequest(`/campaigns?page=${encodeURIComponent(String(page))}`, {}, (d) => asArray(d).map(normalizeListItem)),

  getCampaign: (id: string, o?: BgOpt) => vdRequest(`/campaigns/${cid(id)}`, bg({}, o), normalizeDetail),

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
  process: (id: string, o?: BgOpt): Promise<VdResult<VdListItem>> => {
    const cur = processInFlight.get(id);
    if (cur) return cur;
    const p = vdRequest(`/campaigns/${cid(id)}/process`, bg(json({}), o), normalizeDetail).finally(() => {
      processInFlight.delete(id);
    });
    processInFlight.set(id, p);
    return p;
  },

  rows: (id: string, opts: { status?: string; page?: number; batch?: number; background?: boolean }) => {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    if (opts.batch) q.set('batch', String(opts.batch));
    const page = opts.page ?? 1;
    q.set('page', String(page));
    return vdRequest(`/campaigns/${cid(id)}/rows?${q.toString()}`, bg({}, opts), (d) => normalizeRowsPage(d, page));
  },

  resend: (id: string, rowId: string) => vdRequest(`/campaigns/${cid(id)}/rows/${cid(rowId)}/resend`, json({}), normalizeRow),

  retryBuy: (id: string, rowId: string) =>
    vdRequest(`/campaigns/${cid(id)}/rows/${cid(rowId)}/retry-buy`, json({}), normalizeRetryResult),

  cancel: (id: string) => vdRequest(`/campaigns/${cid(id)}/cancel`, json({}), normalizeCancelResult),

  /** An admin declares a row NOT BOUGHT (only offered after an unrecognised Hubble status; reason required). */
  markNotBought: (id: string, rowId: string, reason: string) =>
    vdRequest(`/campaigns/${cid(id)}/rows/${cid(rowId)}/mark-not-bought`, json({ reason }), normalizeRow),

  editCampaign: (id: string, body: { name?: string; budgetRupees?: number }) =>
    vdRequest(`/campaigns/${cid(id)}`, { ...json(body), method: 'PATCH' }, normalizeCampaign),

  uploadBatch: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return vdRequest(`/campaigns/${cid(id)}/batches`, { method: 'POST', body: fd }, normalizeBatchPreview);
  },

  getBatch: (id: string, n: number) => vdRequest(`/campaigns/${cid(id)}/batches/${encodeURIComponent(String(n))}`, {}, normalizeBatchPreview),

  confirmBatch: (id: string, n: number, body: ConfirmBody) =>
    vdRequest(`/campaigns/${cid(id)}/batches/${encodeURIComponent(String(n))}/confirm`, json(body), normalizeCampaign),

  discardBatch: (id: string, n: number) =>
    vdRequest(`/campaigns/${cid(id)}/batches/${encodeURIComponent(String(n))}/discard`, json({}), normalizeDiscardResult),
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
