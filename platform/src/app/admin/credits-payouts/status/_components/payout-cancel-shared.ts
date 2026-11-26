'use client';

/**
 * Shared types + helpers for the Payout Status breakdown, the row drill-down and payout cancellation
 * (owner 2026-11-25). Amounts are integer paise — always shown through formatInrPaise.
 */
import { useEffect, type RefObject } from 'react';
import { formatInrPaise } from '@/lib/money-format';

export const inr = formatInrPaise;

export interface Money { count: number; paise: number }

export type BucketKey = 'PAID' | 'PROCESSING' | 'PENDING' | 'FAILED' | 'REVERSED' | 'CANCELLED';
export const BUCKET_ORDER: BucketKey[] = ['PAID', 'PROCESSING', 'PENDING', 'FAILED', 'REVERSED', 'CANCELLED'];

export interface Breakdown {
  buckets: Record<BucketKey, Money>;
  other: Money;
  total: Money;
  paidTdsWithheldPaise: number;
  paidSettledByTds: Money;
  pendingHeldByReversal: Money;
}

export interface PayoutStatusData {
  batch: { id: string; batchCode: string; period: string; status: string; totalPayoutPaise: number; sourceKind: string };
  overall: Breakdown;
  fields: Array<{ fieldId: string; fieldName: string; breakdown: Breakdown }>;
  entriesTotalPaise: number;
  uploadTotalPaise: number;
  reconciles: boolean;
  notes: string[];
  fund: { committed: Money; paid: Money; returned: Money; excludedVendorImport: Money };
  points: {
    creditedRows: number; creditedPoints: number;
    notCreditedRows: number; notCreditedPoints: number;
    deductedRows: number; deductedPoints: number;
  };
}

export type CancelKind = 'UNPAID' | 'FAILED';

export interface PayoutEntryRow {
  id: string;
  batchId: string;
  batchCode: string;
  outletId: string;
  outletName: string;
  fieldId: string;
  fieldName: string;
  period: string;
  amountPaise: number;
  tdsDeductedPaise: number;
  status: string;
  bankFileCode: string | null;
  utr: string | null;
  settledByTds: boolean;
  paidAt: string | null;
  failureReason: string | null;
  attemptedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  heldByReversal: boolean;
  cancelKind: CancelKind | null;
}

/** A row the cancel preview / apply talks about. */
export interface CancelRow {
  entryId: string;
  batchId: string;
  batchCode: string;
  outletId: string;
  outletName: string;
  fieldId: string;
  fieldName: string;
  period: string;
  amountPaise: number;
  status: string;
  kind: CancelKind | null;
  downloadCode: string | null;
  failureReason: string | null;
  attemptedAt: string | null;
  autoInvoiceId: string | null;
}

export interface CancelBlocked { entryId: string; code: string; reason: string; row: CancelRow | null }

export interface InvoiceToVoid {
  id: string;
  invoiceNumber: string | null;
  outletCode: string | null;
  period: string | null;
  totalPaise: number;
  gstHeldPaise: number;
}

export interface CancelTotals { unpaid: Money; failed: Money; all: Money }

export interface CancelPreview {
  kind: CancelKind;
  ok: CancelRow[];
  blocked: CancelBlocked[];
  invoicesToVoid: InvoiceToVoid[];
  totals: CancelTotals;
}

export interface CancelResult {
  cancellationId: string;
  cancelled: CancelRow[];
  invoicesVoided: InvoiceToVoid[];
  totals: CancelTotals;
}

/** Human label of a payout-entry status (drill-down, filters). */
export const ENTRY_STATUS_LABEL: Record<string, string> = {
  PENDING:    'Pending',
  PROCESSING: 'In bank file',
  PAID:       'Paid',
  FAILED:     'Failed',
  REVERSED:   'Reversed',
  CANCELLED:  'Cancelled',
};
export const entryStatusLabel = (s: string) => ENTRY_STATUS_LABEL[s] ?? s;

export const KIND_ACTION_LABEL: Record<CancelKind, string> = {
  UNPAID: 'Cancel unpaid — never sent to the bank',
  FAILED: 'Cancel failed — will not be re-banked',
};

export const CANCEL_REASON_MAX = 500;

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; details?: Record<string, unknown> };

/** Read an enveloped API answer `{ success, data }` / `{ success:false, error, details? }` — never throws. */
export async function apiJson<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    return { ok: false, status: 0, error: `Network error — ${String((e as Error)?.message ?? e)}` };
  }
  const json = await res.json().catch(() => null);
  if (json?.success && json.data !== undefined && json.data !== null) return { ok: true, data: json.data as T };
  return {
    ok: false,
    status: res.status,
    error: json?.error ?? `Request failed (HTTP ${res.status})`,
    ...(json?.details && typeof json.details === 'object' ? { details: json.details as Record<string, unknown> } : {}),
  };
}

/** `details.blocked` of a 409 refusal, when present. */
export function blockedFromDetails<T>(details?: Record<string, unknown>): T[] | null {
  const b = details?.blocked;
  return Array.isArray(b) ? (b as T[]) : null;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** Focus the first control on open; returns a keydown handler: Escape closes, Tab / Shift+Tab stay inside. */
export function useDialogA11y(ref: RefObject<HTMLDivElement | null>, onClose: () => void) {
  useEffect(() => {
    // Focus returns to whatever opened the dialog when it closes.
    const trigger = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      if (trigger && typeof trigger.focus === 'function' && trigger.isConnected) trigger.focus();
    };
  }, [ref]);
  return (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !ref.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
}
