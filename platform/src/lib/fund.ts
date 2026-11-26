/**
 * Fund reconciliation — client types + fetch helpers for /api/fund/* (proxied to backend /v1/fund/*).
 * Design: platform/docs/plans/FUND-RECONCILIATION-DESIGN.md.
 *
 * Money from the API is always integer PAISE (format with formatInrPaise). Money typed by an operator is
 * RUPEES and is sent as rupees (`amountRupees`, `thresholdRupees`, `flatRupees`) — the backend converts.
 * Never multiply by 100 here (the retired Fund Management page stored receipts ×100).
 */

export type FundSpendType = 'VOUCHER' | 'CASH_REDEMPTION' | 'CREDIT_PAYOUT' | 'VISIBILITY_PAYOUT' | 'TDS_194C' | 'OFF_PORTAL_PAYMENT';
export type FundEvent = 'OPENING' | 'RECEIPT' | 'ADJUSTMENT' | 'CHARGE' | 'RETURN' | 'RATE_CHANGE';
export type FundStatus = 'COMMITTED' | 'PAID' | 'RETURNED';
export type FundFlag =
  | 'NO_ITEM_RATE'
  | 'NO_FEE_RATE'
  | 'HUBBLE_NEEDS_RECONCILE'
  | 'FAILED_AWAITING_REBANK'
  | 'FACE_RECOMPUTED'
  | 'FACE_UNKNOWN'
  | 'DATE_ESTIMATED'
  | 'TDS_INCLUDES_EARLIER'
  | 'TDS_RUN_UNMATCHED'
  | 'TDS_OTHER_CLIENT_RUN'
  | 'TDS_PAYOUTS_REVERSED'
  | 'GIFT_NO_AGENCY_FEE';

/** Plain words for the last daily low-balance check status (re-audit B2). */
export function alertCheckLabel(status: string): string {
  switch (status) {
    case 'sent': return 'E-mail sent';
    case 'sent-to-test-address': return 'Sent to the test address only (this server does not e-mail clients)';
    case 'already-sent-today': return 'Already e-mailed today';
    case 'not-low': return 'Balance above the threshold — no e-mail needed';
    case 'no-threshold': return 'No threshold set';
    case 'no-recipients': return 'No recipients set — not e-mailed';
    case 'no-opening': return 'Waiting for the opening balance — e-mails start once it is recorded';
    case 'client-inactive': return 'Client not active — not e-mailed';
    case 'disabled-in-environment': return 'Alert e-mails are switched off on this server — not e-mailed';
    case 'test-recipient-not-internal': return 'Not sent — the test address is not internal';
    case 'not-checked-time-budget': return 'Not checked today — the daily step ran out of time';
    case 'email-not-configured': return 'Not sent — e-mail is not set up on this server';
    case 'failed': return 'Not sent — the e-mail failed';
    default: return status;
  }
}

export const SPEND_TYPE_LABELS: Record<FundSpendType, string> = {
  VOUCHER: 'Vouchers',
  CASH_REDEMPTION: 'Cash redemptions',
  CREDIT_PAYOUT: 'Target / credit payouts',
  VISIBILITY_PAYOUT: 'Visibility payouts',
  TDS_194C: 'TDS 194C (gross-up)',
  OFF_PORTAL_PAYMENT: 'Off-portal payments',
};

export const EVENT_LABELS: Record<FundEvent, string> = {
  OPENING: 'Opening balance',
  RECEIPT: 'Advance received',
  ADJUSTMENT: 'Adjustment',
  CHARGE: 'Charge',
  RETURN: 'Returned',
  RATE_CHANGE: 'Rate change',
};

export const STATUS_LABELS: Record<FundStatus, string> = {
  COMMITTED: 'Committed',
  PAID: 'Paid',
  RETURNED: 'Returned',
};

/**
 * Plain-English flag text (short chip label + longer explanation). Shown as VISIBLE text (C4), never hover-only.
 * Client-safe wording everywhere: the voucher supplier is "the voucher provider" (C11).
 */
export const FLAG_TEXT: Record<FundFlag, { chip: string; detail: string }> = {
  NO_ITEM_RATE: { chip: 'No item discount', detail: 'No voucher discount is set for this voucher item — charged at face value.' },
  NO_FEE_RATE: { chip: 'No agency fee', detail: 'No agency fee is set — no fee was charged on this payout.' },
  HUBBLE_NEEDS_RECONCILE: { chip: 'Awaiting voucher provider', detail: "The voucher provider's outcome is not known yet — counted as committed until it is confirmed." },
  FAILED_AWAITING_REBANK: { chip: 'Failed: re-bank', detail: 'Failed at the bank and not reversed — still committed until it is paid again.' },
  FACE_RECOMPUTED: { chip: 'Face recomputed', detail: "The order's value was worked out again from the copy saved when it was ordered (the stored value had been cleared by a refund)." },
  FACE_UNKNOWN: { chip: 'Face unknown', detail: 'No face value could be found (₹0 charged) — the source record needs checking.' },
  DATE_ESTIMATED: { chip: 'Date estimated', detail: 'The source record has no date for this event: a return is shown on the day it was committed, and a paid date is left blank.' },
  TDS_INCLUDES_EARLIER: { chip: 'Includes earlier TDS', detail: 'Includes TDS for earlier payouts this year — the yearly limit was crossed, so TDS on the earlier payouts became due with this bank run.' },
  TDS_RUN_UNMATCHED: { chip: 'Bank run not identified', detail: 'An older TDS entry whose bank run could not be identified — it is charged in full on the day it was recorded and shown as paid.' },
  TDS_OTHER_CLIENT_RUN: { chip: 'Other client run', detail: "Recovered with a payout run outside this client's statement (the payee's PAN is shared with another client) — charged on the day it was recorded." },
  TDS_PAYOUTS_REVERSED: { chip: 'Payouts reversed', detail: 'The payouts of this bank run were reversed. TDS on a reversed payout stays deposited. It is absorbed only if the same PAN/outlet gets more 194C payouts later in the same financial year; otherwise it is not recovered.' },
  GIFT_NO_AGENCY_FEE: { chip: 'Gift — no fee', detail: 'Off-portal gift — no agency fee charged' },
};

export function flagDetail(flag: string): string {
  return (FLAG_TEXT as Record<string, { detail: string }>)[flag]?.detail ?? flag;
}

export function flagChip(flag: string): string {
  return (FLAG_TEXT as Record<string, { chip: string }>)[flag]?.chip ?? flag;
}

export interface FundTotals {
  openingPaise: number;
  receiptsPaise: number;
  adjustmentsPaise: number;
  committedPaise: number;
  paidPaise: number;
  returnedPaise: number;
  balancePaise: number;
  availablePaise: number;
  faceTotalPaise: number;
  discountTotalPaise: number;
  feeTotalPaise: number;
  tdsTotalPaise: number;
}

export interface FundByTypeRow {
  type: FundSpendType;
  label: string;
  count: number;
  facePaise: number;
  discountPaise: number;
  feePaise: number;
  committedPaise: number;
  paidPaise: number;
  returnedPaise: number;
  /** Items of this type that came back (not in count / face / fee — "N returned, not charged"). */
  returnedCount?: number;
  netChargedPaise: number;
}

export interface FundSummary {
  clientId: string;
  asOf: string;
  openingDate: string | null;
  hasOpening: boolean;
  canManage: boolean;
  totals: FundTotals;
  byType: FundByTypeRow[];
  receivables: {
    totalPaise: number;
    items: Array<{ ref: string; description: string; type: FundSpendType; sourceKind: string; sourceId: string; paidAt: string | null; amountPaise: number }>;
  };
  preOpeningReturns: {
    facePaise: number;
    items: Array<{ ref: string; type: FundSpendType; returnedAt: string; facePaise: number; sourceKind: string; sourceId: string }>;
  };
  excludedEntries: Array<{ id: string; kind: string; amountPaise: number; date: string; ref: string }>;
  flagCounts: Partial<Record<FundFlag, number>>;
  itemsWithoutRate: Array<{ rewardId: string; itemLabel: string; count: number }>;
  /** The Gifsy console link to this client's fund settings — Gifsy operators only, else null. */
  settingsConsoleHref?: string | null;
  lowBalance: {
    thresholdPaise: number | null;
    isLow: boolean;
    /** Why daily e-mails are paused: no opening balance yet, or the client is not active. */
    alertsPaused?: 'NO_OPENING' | 'CLIENT_INACTIVE' | null;
    lastAlertSentOn: string | null;
    /** How many recipients the last e-mail went to (at send time). */
    lastAlertRecipients?: number | null;
    /** Already a client-safe sentence for a client admin (the raw error for Gifsy). */
    lastAlertError: string | null;
    recipients: number;
    /** On this server low-balance e-mails do not reach the client (test address or switched off). */
    emailsSwitchedOff?: boolean;
    /** The last daily low-balance check (status + when) — a skip is never silent. */
    lastCheck?: { status: string; at: string | null } | null;
  };
}

export interface FundStatementLine {
  seq: number;
  date: string;
  event: FundEvent;
  type: FundSpendType | null;
  ref: string;
  description: string;
  sourceKind: string;
  sourceId: string;
  facePaise: number;
  discountPaise: number;
  feePaise: number;
  tdsPaise: number;
  chargedPaise: number;
  amountPaise: number;
  balancePaise: number;
  status: FundStatus | null;
  committedAt: string | null;
  paidAt: string | null;
  returnedAt: string | null;
  utr: string | null;
  itemLabel: string | null;
  rateLabel: string | null;
  receivablePaise: number;
  flags: string[];
}

export interface FundStatement {
  lines: FundStatementLine[];
  pagination: { page: number; limit: number; total: number; pages: number };
  period: {
    from: string | null;
    to: string | null;
    /** The period figures always cover ALL types / statuses of the date range — never the other filters. */
    scope?: 'ALL_TYPES_FOR_PERIOD';
    openingBalancePaise: number;
    closingBalancePaise: number;
    openingEntryPaise: number;
    receiptsPaise: number;
    adjustmentsPaise: number;
    chargesPaise: number;
    returnsPaise: number;
    byType: Array<{ type: FundSpendType; label: string; count: number; facePaise: number; discountPaise: number; feePaise: number; chargesPaise: number; returnsPaise: number }>;
  };
}

export interface FundEntry {
  id: string;
  entryType: 'RECEIPT' | 'ADJUSTMENT' | 'OPENING_BALANCE';
  receiptNumber: string | null;
  amountPaise: number;
  date: string;
  paymentMode: string | null;
  referenceNumber: string | null;
  bankName: string | null;
  notes: string | null;
  reason: string | null;
  createdAt: string;
  createdByName: string | null;
}

/** One saved rate (agency fee or voucher item discount). Rates are never edited — a change is a new row. */
export interface FundRateRow {
  id: string;
  feeType: 'PERCENT' | 'FLAT' | null;
  rewardId: string | null;
  rewardLabel: string | null;
  rateBps: number | null;
  flatPaise: number | null;
  effectiveFrom: string;
  note: string | null;
  /** Set when the rate was back-dated: how many committed lines it re-priced and the balance change. */
  repricedLines: number | null;
  repriceDeltaPaise: number | null;
  createdAt: string;
  createdByName: string | null;
}

export interface FundFeeView { feeType: 'PERCENT' | 'FLAT'; rateBps: number | null; flatPaise: number | null; effectiveFrom: string }

export interface FundVoucherItem {
  rewardId: string;
  name: string;
  code: string | null;
  brandText: string | null;
  deleted: boolean;
  active: boolean;
  currentRateBps: number | null;
  currentEffectiveFrom: string | null;
  scheduledRateBps: number | null;
  scheduledFrom: string | null;
}

/** GET /api/fund/settings (read-only) and GET /api/gifsy/clients/:slug/fund (console) — the same shape. */
export interface FundSettings {
  clientId: string;
  canManage: boolean;
  managedInConsole: boolean;
  consoleHref: string | null;
  thresholdPaise: number | null;
  alertRecipients: string[];
  lastAlertSentOn: string | null;
  lastAlertRecipients: number | null;
  lastAlertError: string | null;
  /** Where low-balance e-mails go in this environment — Gifsy only (null for a client admin). */
  alertEnvironment: 'live' | 'test' | 'off' | 'invalid-test' | null;
  /** On this server low-balance e-mails do not reach the client (test address or switched off) — shown to everyone. */
  emailsSwitchedOff?: boolean;
  /** The last daily low-balance check (status + when). */
  lastCheck?: { status: string; at: string | null } | null;
  currentFee: FundFeeView | null;
  scheduledFee: FundFeeView | null;
  feeRates: FundRateRow[];
  discountRates: FundRateRow[];
  items: FundVoucherItem[];
}

/** A console rate save: saved, or (back-dated) a preview that needs an explicit confirm (owner D1). */
export type FundRateSaveResult =
  | {
      saved: true; id: string; scheduled: boolean; effectiveFrom: string; linesRepriced?: number; deltaPaise?: number;
      /** Back-dated confirm: what the preview showed, and whether the stored figures include spend made after it. */
      previewLinesRepriced?: number; previewDeltaPaise?: number; includesSpendAfterPreview?: boolean;
    }
  | {
      saved: false;
      requiresConfirmation: true;
      preview: { linesRepriced: number; deltaPaise: number; effectiveFrom: string; from: string; to: string };
      confirmToken: string;
    };

/** Agency fee in words: "3% of each payout" / "₹25.00 flat per payout". */
export function feeLabelOf(f: { feeType: 'PERCENT' | 'FLAT' | null; rateBps: number | null; flatPaise: number | null }, formatPaise: (p: number) => string): string {
  return f.feeType === 'FLAT' ? `${formatPaise(f.flatPaise ?? 0)} flat per payout` : `${bpsToPercentLabel(f.rateBps)} of each payout`;
}

/** 300 bps → "3%", 250 → "2.5%", 275 → "2.75%". */
export function bpsToPercentLabel(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return '—';
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** Today's date in IST as YYYY-MM-DD (default for date inputs). */
export function todayIstKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Parse a rupee amount typed by an operator ("1,500.50" → 1500.5). Returns null when it is not a number or has
 * more than 2 decimals. The value is sent AS RUPEES — never converted to paise on the client.
 */
export function parseRupees(input: string): number | null {
  // C10: accept a leading "+" and the Unicode minus "−" (U+2212) that some keyboards / copied text produce.
  const s = input.replace(/[,\s₹]/g, '').replace(/\u2212/g, '-').replace(/^\+(?=\d)/, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** `details` = the server's opt-in error details (e.g. a refused confirm's `missingAcknowledgements`), when sent. */
export type FundResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; status?: number; details?: Record<string, unknown> };

/** Server error text: `{ success:false, error }` or Nest `{ message }` (string or string[]). */
function errorText(body: unknown, status: number): string {
  const b = body as { error?: unknown; message?: unknown } | null;
  const raw = b?.error ?? b?.message;
  if (Array.isArray(raw)) return raw.join(', ');
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (raw && typeof raw === 'object' && typeof (raw as { message?: unknown }).message === 'string') {
    return (raw as { message: string }).message;
  }
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return "You don't have permission to do this.";
  return `Something went wrong (error ${status}). Please try again.`;
}

/** Fetch a `{ success, data }` envelope (also used by lib/off-portal-payments.ts). Never throws. */
export async function call<T>(url: string, init?: RequestInit): Promise<FundResult<T>> {
  let res: Response;
  try {
    res = await (init ? fetch(url, init) : fetch(url));
  } catch {
    return { ok: false, message: "Couldn't reach the server. Check your connection and try again." };
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  const status = typeof res.status === 'number' ? res.status : 0;
  const success = (body as { success?: unknown } | null)?.success;
  if (!res.ok || success === false) {
    const d = (body as { details?: unknown } | null)?.details;
    return {
      ok: false, status, message: errorText(body, status),
      ...(d && typeof d === 'object' && !Array.isArray(d) ? { details: d as Record<string, unknown> } : {}),
    };
  }
  const data = body && typeof body === 'object' && 'data' in body ? (body as { data: T }).data : (body as T);
  if (data == null) return { ok: false, status, message: 'The server reply was empty. Please refresh the page.' };
  return { ok: true, data };
}

export const fundApi = {
  summary: () => call<FundSummary>('/api/fund/summary'),
  statement: (params: URLSearchParams) => call<FundStatement>(`/api/fund/statement?${params.toString()}`),
  entries: () => call<{ entries: FundEntry[] }>('/api/fund/entries'),
  settings: () => call<FundSettings>('/api/fund/settings'),
  post: <T = unknown>(path: string, body: unknown, method: 'POST' | 'PUT' = 'POST') =>
    call<T>(`/api/fund/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
};

/** Gifsy console — a client's fund settings (owner D6). `slug` is the client id. */
export function fundConsoleApi(slug: string) {
  const base = `/api/gifsy/clients/${encodeURIComponent(slug)}/fund`;
  const send = <T,>(path: string, method: 'POST' | 'PUT', body: unknown) =>
    call<T>(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return {
    get: () => call<FundSettings>(base),
    saveAlerts: (body: { thresholdRupees: number | null; alertRecipients: string[] }) =>
      send<{ thresholdPaise: number | null; alertRecipients: string[] }>('/alerts', 'PUT', body),
    saveFee: (body: Record<string, unknown>) => send<FundRateSaveResult>('/rates/fee', 'POST', body),
    saveDiscount: (body: Record<string, unknown>) => send<FundRateSaveResult>('/rates/discount', 'POST', body),
  };
}
