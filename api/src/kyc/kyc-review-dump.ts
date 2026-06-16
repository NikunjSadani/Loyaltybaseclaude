/**
 * kyc-review-dump.ts
 *
 * Pure, deterministic generator for the Lane A bulk KYC verification dump — one
 * Excel of all PENDING_GIFSY submissions with every filled field, clickable
 * document hyperlinks, and a Decision + Remark column per verification field for
 * Gifsy to fill offline (or reflecting prior Excel/portal state).
 *
 * Ported from platform/src/lib/kyc-review-dump.ts — the 40-column layout is kept
 * verbatim so the approvals UI round-trips it unchanged (owner: keep the columns).
 * No DB/I/O here; KycService assembles entries (real query + signed URLs) and
 * calls generateKycReviewDumpExcel(). Field keys come from the shared bridge
 * helper so the 7 fields are defined once.
 */

import * as XLSX from 'xlsx';
import { KycFieldKey, KycFieldDecision, KycFieldSource } from '@prisma/client';
import { KYC_FIELD_KEYS } from './kyc-verification.helper';

// ─── Field order (7, fixed) — key + the human label used in the column header ───
const FIELD_LABELS: Record<KycFieldKey, string> = {
  PAYMENT: 'Payment (Bank/UPI)',
  GST_VALIDATION: 'GST Validation',
  GST_DOCUMENT: 'GST Document',
  ADDRESS: 'Address',
  ADDRESS_DOCUMENT: 'Address Document',
  BOARD_PHOTO: 'Store Board Photo',
  OWNER_PHOTO: 'Owner Photo',
};

export const KYC_FIELD_ORDER: { key: KycFieldKey; label: string }[] = KYC_FIELD_KEYS.map((key) => ({
  key,
  label: FIELD_LABELS[key],
}));

/** Decision column header for a field label. MUST match the bulk-verify parser. */
export function kycFieldDecisionHeader(label: string): string {
  return `${label} — Decision`;
}

/** Remark column header for a field label. */
export function kycFieldRemarkHeader(label: string): string {
  return `${label} — Remark`;
}

// ─── Column groups (kept verbatim from the demo so the UI round-trips) ──────────
/** Context columns (20) — read-only reference. "Partner Class" is the legacy
 *  label that actually carries the outlet TYPE value (per the real model). */
export const KYC_DUMP_CONTEXT_HEADERS = [
  'Submission ID',
  'Outlet Code',
  'Outlet Name',
  'Owner Name',
  'Mobile',
  'Partner Class',
  'GST Number',
  'PAN',
  'Address',
  'City',
  'State',
  'Pincode',
  'Payment Mode',
  'Bank Name',
  'Account Holder',
  'Account Number',
  'IFSC',
  'UPI ID',
  'Board Geo',
  'Name Mismatch',
] as const;

/** Document columns (6) — clickable hyperlinks to KYC documents. */
export const KYC_DUMP_DOC_HEADERS = [
  'GST Certificate',
  'Address Document',
  'Self-Declaration',
  'Store Board Photo',
  'Owner Photo',
  'Cancelled Cheque',
] as const;

/** 20 context + 6 doc + 14 per-field (7 × 2) = 40. */
export const KYC_DUMP_TOTAL_COLUMN_COUNT = 40;

export interface KycReviewDumpFieldState {
  decision: KycFieldDecision;
  remark?: string;
  source?: KycFieldSource;
}

export interface KycReviewDumpEntry {
  submissionId: string;
  outletCode: string;
  outletName: string;
  ownerName: string;
  mobile: string;
  /** Populates the legacy-labeled "Partner Class" column — outlet type value. */
  outletType: string;
  gstNumber: string;
  panNumber: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  paymentMode: string;
  bankName?: string;
  accountHolderName?: string;
  accountNumber?: string;
  ifscCode?: string;
  upiId?: string;
  boardGeo?: { lat: number; lng: number };
  nameMismatch: boolean;
  documents: {
    gstCertificateUrl?: string;
    addressDocUrl?: string;
    selfDeclarationUrl?: string;
    boardPhotoUrl?: string;
    ownerPhotoUrl?: string;
    chequeUrl?: string;
  };
  fields: Record<KycFieldKey, KycReviewDumpFieldState>;
}

/**
 * Generate the 40-column workbook. Document cells carry .l hyperlinks; a field
 * Decision is '' for PENDING, 'APPROVE'/'REJECT' for terminal states (reflecting
 * prior Excel/portal work so re-export is a faithful round-trip). Returns a
 * Node Buffer (the controller hands it to a StreamableFile).
 */
export function generateKycReviewDumpExcel(entries: KycReviewDumpEntry[]): Buffer {
  const perFieldHeaders: string[] = [];
  for (const { label } of KYC_FIELD_ORDER) {
    perFieldHeaders.push(kycFieldDecisionHeader(label));
    perFieldHeaders.push(kycFieldRemarkHeader(label));
  }

  const headerRow: string[] = [
    ...KYC_DUMP_CONTEXT_HEADERS,
    ...KYC_DUMP_DOC_HEADERS,
    ...perFieldHeaders,
  ];

  const dataRows: unknown[][] = entries.map((e) => {
    const row: unknown[] = [
      e.submissionId,
      e.outletCode,
      e.outletName,
      e.ownerName,
      e.mobile,
      e.outletType,
      e.gstNumber,
      e.panNumber,
      e.address,
      e.city,
      e.state,
      e.pincode,
      e.paymentMode,
      e.bankName ?? '',
      e.accountHolderName ?? '',
      e.accountNumber ?? '',
      e.ifscCode ?? '',
      e.upiId ?? '',
      e.boardGeo ? `${e.boardGeo.lat},${e.boardGeo.lng}` : '',
      e.nameMismatch ? 'Yes' : 'No',
      // Doc columns (6) — placeholder text; hyperlinks applied post-process.
      e.documents.gstCertificateUrl ? 'Open' : '',
      e.documents.addressDocUrl ? 'Open' : '',
      e.documents.selfDeclarationUrl ? 'Open' : '',
      e.documents.boardPhotoUrl ? 'Open' : '',
      e.documents.ownerPhotoUrl ? 'Open' : '',
      e.documents.chequeUrl ? 'Open' : '',
    ];

    for (const { key } of KYC_FIELD_ORDER) {
      const fs = e.fields[key];
      const decision =
        fs.decision === 'PENDING' ? '' : fs.decision === 'APPROVED' ? 'APPROVE' : 'REJECT';
      row.push(decision);
      // A REJECT must carry a remark or the bulk-verify parser rejects the row on
      // re-import; emit a placeholder if one is somehow missing (write paths enforce it).
      row.push(decision === 'REJECT' ? fs.remark || 'Rejected (no remark on file)' : (fs.remark ?? ''));
    }

    return row;
  });

  const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);

  // Apply hyperlinks to the 6 doc cells (0-based columns 20–25).
  const DOC_URLS: (keyof KycReviewDumpEntry['documents'])[] = [
    'gstCertificateUrl',
    'addressDocUrl',
    'selfDeclarationUrl',
    'boardPhotoUrl',
    'ownerPhotoUrl',
    'chequeUrl',
  ];
  entries.forEach((e, rowIdx) => {
    DOC_URLS.forEach((docKey, colOffset) => {
      const url = e.documents[docKey];
      if (!url) return;
      const cellAddr = XLSX.utils.encode_cell({ r: rowIdx + 1, c: 20 + colOffset });
      const cell = ws[cellAddr];
      if (cell) cell.l = { Target: url };
    });
  });

  ws['!cols'] = headerRow.map((label) => ({ wch: Math.max(label.length + 2, 14) }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'KYC Review Dump');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
