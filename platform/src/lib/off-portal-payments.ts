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
  DUPLICATE: 'Possible repeat',
  REPLACES_TDS_ENTRY: 'Replaces TDS entry',
  BEFORE_FUND_OPENING: 'Before fund opening',
  TDS_NOT_WITHHELD: 'TDS not withheld',
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
