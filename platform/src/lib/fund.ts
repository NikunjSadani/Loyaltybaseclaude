/**
 * Fund reconciliation — client types + fetch helpers for /api/fund/* (proxied to backend /v1/fund/*).
 * Design: platform/docs/plans/FUND-RECONCILIATION-DESIGN.md.
 *
 * Money from the API is always integer PAISE (format with formatInrPaise). Money typed by an operator is
 * RUPEES and is sent as rupees (`amountRupees`, `thresholdRupees`, `flatRupees`) — the backend converts.
 * Never multiply by 100 here (the retired Fund Management page stored receipts ×100).
 */

export type FundSpendType = 'VOUCHER' | 'CASH_REDEMPTION' | 'CREDIT_PAYOUT' | 'VISIBILITY_PAYOUT' | 'TDS_194C';
export type FundEvent = 'OPENING' | 'RECEIPT' | 'ADJUSTMENT' | 'CHARGE' | 'RETURN';
export type FundStatus = 'COMMITTED' | 'PAID' | 'RETURNED';
export type FundFlag =
  | 'NO_BRAND_RATE'
  | 'NO_FEE_RATE'
  | 'HUBBLE_NEEDS_RECONCILE'
  | 'FAILED_AWAITING_REBANK'
  | 'FACE_RECOMPUTED'
  | 'FACE_UNKNOWN';

export const SPEND_TYPE_LABELS: Record<FundSpendType, string> = {
  VOUCHER: 'Vouchers',
  CASH_REDEMPTION: 'Cash redemptions',
  CREDIT_PAYOUT: 'Target / credit payouts',
  VISIBILITY_PAYOUT: 'Visibility payouts',
  TDS_194C: 'TDS 194C (gross-up)',
};

export const EVENT_LABELS: Record<FundEvent, string> = {
  OPENING: 'Opening balance',
  RECEIPT: 'Advance received',
  ADJUSTMENT: 'Adjustment',
  CHARGE: 'Charge',
  RETURN: 'Returned',
};

export const STATUS_LABELS: Record<FundStatus, string> = {
  COMMITTED: 'Committed',
  PAID: 'Paid',
  RETURNED: 'Returned',
};

/** Plain-English flag text (short chip label + longer explanation). */
export const FLAG_TEXT: Record<FundFlag, { chip: string; detail: string }> = {
  NO_BRAND_RATE: { chip: 'No brand rate', detail: 'No voucher discount is set for this brand — charged at face value.' },
  NO_FEE_RATE: { chip: 'No agency fee', detail: 'No agency fee is set — no fee was charged on this payout.' },
  HUBBLE_NEEDS_RECONCILE: { chip: 'Hubble: reconcile', detail: 'The Hubble outcome is unknown — counted as committed until reconciled.' },
  FAILED_AWAITING_REBANK: { chip: 'Failed: re-bank', detail: 'Failed at the bank and not reversed — still committed until it is re-banked.' },
  FACE_RECOMPUTED: { chip: 'Face recomputed', detail: "The order's value was re-derived from its snapshot." },
  FACE_UNKNOWN: { chip: 'Face unknown', detail: 'No face value could be found (₹0 charged) — check the source record.' },
};

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
  brandsWithoutRate: Array<{ brandKey: string; brandLabel: string; count: number }>;
  lowBalance: {
    thresholdPaise: number | null;
    isLow: boolean;
    lastAlertSentOn: string | null;
    lastAlertError: string | null;
    recipients: number;
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
  brandLabel: string | null;
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

export interface FundFeeRate {
  id: string;
  feeType: 'PERCENT' | 'FLAT';
  rateBps: number | null;
  flatPaise: number | null;
  effectiveFrom: string;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
}

export interface FundDiscountRate {
  id: string;
  brandKey: string;
  brandLabel: string;
  rateBps: number;
  effectiveFrom: string;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
}

export interface FundSettings {
  canManage: boolean;
  thresholdPaise: number | null;
  alertRecipients: string[];
  lastAlertSentOn: string | null;
  lastAlertError: string | null;
  currentFee: { feeType: 'PERCENT' | 'FLAT'; rateBps: number | null; flatPaise: number | null; effectiveFrom: string } | null;
  feeRates: FundFeeRate[];
  discountRates: FundDiscountRate[];
  brands: Array<{ brandKey: string; brandLabel: string; items: string[]; currentRateBps: number | null; currentEffectiveFrom: string | null }>;
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
  const s = input.replace(/[,\s₹]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export type FundResult<T> = { ok: true; data: T } | { ok: false; message: string; status?: number };

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

async function call<T>(url: string, init?: RequestInit): Promise<FundResult<T>> {
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
  if (!res.ok || success === false) return { ok: false, status, message: errorText(body, status) };
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
