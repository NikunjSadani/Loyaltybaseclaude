/**
 * Off-portal payments register — client types + fetch helpers for /api/admin/off-portal-payments/* (proxied to
 * backend /v1/admin/off-portal-payments/*; api/src/off-portal-payments).
 *
 * Payments ALREADY MADE outside the portal (bank / UPI / gift) are recorded here so TDS, Fund Reconciliation, the
 * outlet's payout history and the Payments Report count them. Uploads + voids: an assumed GIFSY_ADMIN only (the API
 * says so with `canWrite`). The register (list / export / uploads): that admin or the client's CLIENT_ADMIN (PII
 * masked for anyone but a Gifsy admin — `piiMasked`).
 *
 * Money from this API is integer PAISE as a STRING (bigint) — format with formatPaiseString, never Number-multiply.
 */
import { useEffect, useState } from 'react';
import { call, type FundResult } from '@/lib/fund';
import { formatInrPaise } from '@/lib/money-format';

export type OffPortalStream = 'INCENTIVE' | 'VISIBILITY';
export type OffPortalMode = 'CASH' | 'GIFT';
export type OffPortalStatusFilter = 'ACTIVE' | 'VOIDED' | 'ALL';

export interface OffPortalPreviewRow {
  rowNumber: number;
  outletCode: string;
  outletName: string;
  onPortal: boolean;
  portalOutletName: string | null;
  amountPaise: string;
  paymentDate: string;
  period: string;
  payoutStream: OffPortalStream;
  paymentMode: OffPortalMode;
  utr: string | null;
  panNumber: string | null;
  panSource: 'FILE' | 'PORTAL' | 'NONE';
  tdsSection: '194R' | '194C';
  /** The method THIS row follows (194R incentive / gift is always client-borne gross-up). */
  tdsMethodology?: 'DEDUCT' | 'GROSS_UP' | string;
  /** The TDS key the payment counts under (a PAN, or a no-PAN owner / outlet key). */
  tdsKey?: string;
  /** Plain words: how its TDS is treated. */
  tdsTreatment?: string;
  flags: string[];
  notes: string[];
}

export interface OffPortalPreview {
  fileSha256: string;
  rowsInFile: number;
  blankRows: number;
  recordableCount: number;
  recordableTotalPaise: string;
  invalidCount: number;
  tdsPolicy: { visibilitySection: '194R' | '194C'; methodology: 'DEDUCT' | 'GROSS_UP' | string };
  categories: Array<{ category: string; label: string; count: number }>;
  requiredAcknowledgements: string[];
  invalid: Array<{ rowNumber: number; outletCode: string; outletName: string; errors: string[] }>;
  invalidTruncated: boolean;
  rows: OffPortalPreviewRow[];
  rowsTruncated: boolean;
}

export interface OffPortalConfirmResult {
  uploadId: string;
  recorded: number;
  recordedTotalPaise: string;
  skippedInvalid: number;
  acknowledged: Record<string, number>;
  /** 194C gross-up TDS raised at record time (the message already says it in words). */
  tds194c?: { invoices: number; recoveryPaise: string; notInvoiced: string[]; deferred: string[] };
  message: string;
}

export interface OffPortalPayment {
  id: string;
  uploadId: string;
  rowNumber: number;
  outletCode: string;
  outletName: string;
  onPortalAtUpload: boolean;
  onPortalNow: boolean;
  phone: string | null;
  panNumber: string | null;
  panSource: 'FILE' | 'PORTAL' | 'NONE';
  bankAccountNumber: string | null;
  ifsc: string | null;
  upiId: string | null;
  amountPaise: string;
  paymentDate: string;
  utr: string | null;
  payoutStream: OffPortalStream;
  paymentMode: OffPortalMode;
  period: string;
  narration: string | null;
  tdsSection: '194R' | '194C';
  tdsMethodology: string;
  flags: string[];
  replacesTdsEntry: boolean;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
}

export interface OffPortalList {
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  totals: { count: number; amountPaise: string; liveCount: number; liveAmountPaise: string };
  piiMasked: boolean;
  canWrite: boolean;
  rows: OffPortalPayment[];
}

export interface OffPortalUpload {
  id: string;
  fileName: string;
  rowsInFile: number;
  recordedCount: number;
  skippedCount: number;
  totalPaise: string;
  /** Rows of this upload voided since (absent on an older API). */
  voidedCount?: number;
  voidedPaise?: string;
  /** recorded − voided: what still counts. */
  countingCount?: number;
  countingPaise?: string;
  acknowledged: Record<string, number> | null;
  uploadedBy: string | null;
  createdAt: string;
}

export interface OffPortalFilters {
  from?: string;
  to?: string;
  q?: string;
  stream?: OffPortalStream | '';
  mode?: OffPortalMode | '';
  status?: OffPortalStatusFilter;
  uploadId?: string;
}

/** Plain words for the warning categories (the API also sends its own label — that one is shown when present). */
export const CATEGORY_SHORT: Record<string, string> = {
  INVALID: 'Has errors',
  NEW_PAYEE: 'Not on portal',
  NAME_DIFFERS: 'Name differs',
  PAN_MISMATCH: 'PAN differs',
  NO_PAN: 'No PAN',
  FILE_PAN_ONLY: 'File PAN only',
  PORTAL_PAN_USED: 'Portal PAN used',
  DUPLICATE: 'Repeat',
  POSSIBLE_DUPLICATE: 'Possible repeat',
  PAID_ON_PORTAL: 'Paid on portal',
  REPLACES_TDS_ENTRY: 'Replaces TDS entry',
  TDS_ENTRY_OTHER_PAYEE: 'TDS entry, other payee',
  NO_FUND_OPENING: 'No fund opening',
  BEFORE_FUND_OPENING: 'Before fund opening',
  GIFT_NO_AGENCY_FEE: 'Gift — no fee',
  TDS_NOT_WITHHELD: 'TDS not withheld',
  GROSS_UP_TDS_NOT_INVOICED: '194C not invoiced yet',
};

export const categoryShort = (c: string): string => CATEGORY_SHORT[c] ?? c;

export const STREAM_LABEL: Record<OffPortalStream, string> = { INCENTIVE: 'Incentive', VISIBILITY: 'Visibility' };
export const MODE_LABEL: Record<OffPortalMode, string> = { CASH: 'Cash', GIFT: 'Gift' };

/** Void reason bounds (api: at least 5 characters after trimming, at most 500). */
export const VOID_REASON_MIN = 5;
export const VOID_REASON_MAX = 500;

/** "123450" (paise, bigint string) → "₹1,234.50" (en-IN; formatInrPaise is exact on bigint strings). */
export function formatPaiseString(v: string | number | null | undefined): string {
  return formatInrPaise(v ?? 0);
}

const BASE = '/api/admin/off-portal-payments';

/** Query string for the list / export (drops empty values). */
export function offPortalQuery(f: OffPortalFilters, paging?: { page?: number; pageSize?: number }): string {
  const params = new URLSearchParams();
  const put = (k: string, v: string | number | undefined | null) => {
    if (v === undefined || v === null || v === '') return;
    params.set(k, String(v));
  };
  put('from', f.from);
  put('to', f.to);
  put('q', f.q?.trim());
  put('stream', f.stream);
  put('mode', f.mode);
  put('status', f.status);
  put('uploadId', f.uploadId);
  if (paging) {
    put('page', paging.page);
    put('pageSize', paging.pageSize);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export const offPortalApi = {
  templateUrl: `${BASE}/template`,
  exportUrl: (f: OffPortalFilters) => `${BASE}/export${offPortalQuery(f)}`,
  list: (f: OffPortalFilters, paging: { page: number; pageSize: number }): Promise<FundResult<OffPortalList>> =>
    call<OffPortalList>(`${BASE}${offPortalQuery(f, paging)}`),
  uploads: (): Promise<FundResult<OffPortalUpload[]>> => call<OffPortalUpload[]>(`${BASE}/uploads`),
  presence: (): Promise<FundResult<{ hasEntries: boolean; canWrite: boolean }>> =>
    call<{ hasEntries: boolean; canWrite: boolean }>(`${BASE}/presence`),
  preview: (file: File): Promise<FundResult<OffPortalPreview>> => {
    const form = new FormData();
    form.append('file', file);
    // No Content-Type — the browser sets the multipart boundary.
    return call<OffPortalPreview>(`${BASE}/preview`, { method: 'POST', body: form });
  },
  confirm: (file: File, fileSha256: string, acknowledged: string[]): Promise<FundResult<OffPortalConfirmResult>> => {
    const form = new FormData();
    form.append('file', file);
    form.append('fileSha256', fileSha256);
    form.append('acknowledged', acknowledged.join(','));
    return call<OffPortalConfirmResult>(`${BASE}/confirm`, { method: 'POST', body: form });
  },
  void: (id: string, reason: string): Promise<FundResult<{ id: string; voidedAt: string; message: string }>> =>
    call(`${BASE}/${encodeURIComponent(id)}/void`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }),
};

/** The refused confirm's missing ticks: `details.missingAcknowledgements` (empty when absent). */
export function missingAcknowledgementsOf(r: { ok: false; details?: Record<string, unknown> }): string[] {
  const m = r.details?.missingAcknowledgements;
  return Array.isArray(m) ? m.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * B7 nav gate: should the "Off-portal Payments" item show? GIFSY_ADMIN → always (no request). CLIENT_ADMIN → only
 * when the client has entries; FAIL-OPEN: shown while loading and when the presence read fails (never hidden on an
 * error). Any other role → false (the API refuses them).
 */
export function useOffPortalNavVisible(role: string | null | undefined): boolean {
  const [hasEntries, setHasEntries] = useState<boolean | null>(null);
  const isClient = role === 'CLIENT_ADMIN';
  useEffect(() => {
    if (!isClient) return;
    let cancelled = false;
    void offPortalApi
      .presence()
      .then((r) => {
        if (cancelled) return;
        // Only a successful, explicit `hasEntries: false` hides the item.
        setHasEntries(r.ok && r.data && typeof r.data.hasEntries === 'boolean' ? r.data.hasEntries : null);
      })
      .catch(() => { if (!cancelled) setHasEntries(null); });
    return () => { cancelled = true; };
  }, [isClient]);
  if (role === 'GIFSY_ADMIN') return true;
  if (!isClient) return false;
  return hasEntries !== false;
}
