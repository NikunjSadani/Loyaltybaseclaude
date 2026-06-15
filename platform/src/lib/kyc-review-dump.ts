/**
 * KYC Review Dump Export
 *
 * Pure, deterministic functions for the Lane A bulk KYC verification dump.
 * Generates one Excel of all PENDING_GIFSY submissions with every filled field,
 * document hyperlinks, and per-field Decision/Remark columns for Gifsy to fill
 * offline (or reflecting prior Excel/portal state).
 *
 * Spec: docs/plans/KYC-APPROVAL-REVAMP.md § The bulk flow (Lane A)
 */

import * as XLSX from 'xlsx';
import type { KycApprovalEntry, KycFieldKey, KycFieldState } from '@/types';

// ─── Field order (7, fixed) ───────────────────────────────────────────────────

export const KYC_FIELD_ORDER: { key: KycFieldKey; label: string }[] = [
  { key: 'PAYMENT',          label: 'Payment (Bank/UPI)' },
  { key: 'GST_VALIDATION',   label: 'GST Validation'     },
  { key: 'GST_DOCUMENT',     label: 'GST Document'       },
  { key: 'ADDRESS',          label: 'Address'            },
  { key: 'ADDRESS_DOCUMENT', label: 'Address Document'   },
  { key: 'BOARD_PHOTO',      label: 'Store Board Photo'  },
  { key: 'OWNER_PHOTO',      label: 'Owner Photo'        },
];

// ─── Header string helpers ────────────────────────────────────────────────────

/** Returns the Decision column header string for a given field label. */
export function kycFieldDecisionHeader(label: string): string {
  return `${label} — Decision`;
}

/** Returns the Remark column header string for a given field label. */
export function kycFieldRemarkHeader(label: string): string {
  return `${label} — Remark`;
}

// ─── Column groups ────────────────────────────────────────────────────────────

/**
 * Context columns (20) — exported read-only for Gifsy reference.
 * These MUST match the parse headers in kyc-bulk-verify.ts exactly.
 */
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

/**
 * Document columns (6) — clickable hyperlinks to KYC documents.
 */
export const KYC_DUMP_DOC_HEADERS = [
  'GST Certificate',
  'Address Document',
  'Self-Declaration',
  'Store Board Photo',
  'Owner Photo',
  'Cancelled Cheque',
] as const;

/**
 * Total column count: 20 context + 6 doc + 14 per-field (7 × 2) = 40.
 */
export const KYC_DUMP_TOTAL_COLUMN_COUNT = 40;

// ─── Excel generator ──────────────────────────────────────────────────────────

/**
 * Generates an Excel workbook with 40 columns:
 *   20 context columns (pre-filled from submission data)
 *    6 document columns (clickable hyperlinks)
 *   14 per-field columns (7 fields × Decision + Remark)
 *
 * Document cells carry .l hyperlinks; Decision = '' for PENDING,
 * 'APPROVE' or 'REJECT' for terminal states (reflects prior Excel/portal work).
 *
 * Returns a `Uint8Array` (same Buffer→Uint8Array wrap as sibling exports).
 */
export function generateKycReviewDumpExcel(entries: KycApprovalEntry[]): Uint8Array {
  const wb = XLSX.utils.book_new();

  // ── Build header row ──────────────────────────────────────────────────────
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

  // ── Build data rows ────────────────────────────────────────────────────────
  const dataRows: unknown[][] = entries.map(e => {
    // Context (20)
    const row: unknown[] = [
      e.submissionId,
      e.outletCode,
      e.outletName,
      e.ownerName,
      e.mobile,
      e.partnerClass,
      e.gstNumber,
      e.panNumber,
      e.address,
      e.city,
      e.state,
      e.pincode,
      e.paymentMode,
      e.bankName          ?? '',
      e.accountHolderName ?? '',
      e.accountNumber     ?? '',
      e.ifscCode          ?? '',
      e.upiId             ?? '',
      e.boardGeo ? `${e.boardGeo.lat},${e.boardGeo.lng}` : '',
      e.nameMismatch ? 'Yes' : 'No',
      // Doc columns (6) — placeholders; hyperlinks applied post-process
      e.documents.gstCertificateUrl  ? 'Open' : '',
      e.documents.addressDocUrl      ? 'Open' : '',
      e.documents.selfDeclarationUrl ? 'Open' : '',
      e.documents.boardPhotoUrl      ? 'Open' : '',
      e.documents.ownerPhotoUrl      ? 'Open' : '',
      e.documents.chequeUrl          ? 'Open' : '',
    ];

    // Per-field Decision/Remark (14)
    for (const { key } of KYC_FIELD_ORDER) {
      const fs: KycFieldState = e.fields[key];
      const decision = fs.decision === 'PENDING'
        ? ''
        : fs.decision === 'APPROVED'
          ? 'APPROVE'
          : 'REJECT';
      row.push(decision);
      row.push(fs.remark ?? '');
    }

    return row;
  });

  const wsData = [headerRow, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // ── Post-process: apply hyperlinks to document cells ─────────────────────
  // Doc columns are at indices 20–25 (0-based) in each data row.
  const DOC_URLS: (keyof KycApprovalEntry['documents'])[] = [
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
      // XLSX cell address: row 0 = header, data rows start at row 1
      const cellAddr = XLSX.utils.encode_cell({ r: rowIdx + 1, c: 20 + colOffset });
      const cell = ws[cellAddr];
      if (cell) {
        cell.l = { Target: url };
      }
    });
  });

  // ── Column widths ──────────────────────────────────────────────────────────
  ws['!cols'] = headerRow.map(label => ({ wch: Math.max(label.length + 2, 14) }));

  XLSX.utils.book_append_sheet(wb, ws, 'KYC Review Dump');

  // type:'buffer' returns a Node.js Buffer; wrap in Uint8Array so instanceof
  // checks pass across jsdom/Vitest realms (mirrors sibling exports).
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ─── Demo data ────────────────────────────────────────────────────────────────

/**
 * ~8 deterministic demo pending KYC submissions reusing outlet identities
 * from the outlet-master demo data (Kumar General Store / Singh Supermart / etc.).
 *
 * submissionId uses the pattern KYC-2026-000N.
 * NO randomness — calling twice returns deep-equal output.
 *
 * Mix:
 *   - Some bank, some UPI payment modes
 *   - Some nameMismatch: true
 *   - All entries have boardGeo
 *   - Entries 2 & 3 have a few fields pre-set from EXCEL source (APPROVED / REJECTED)
 *   - All 7 fields always present per entry
 */
export function demoKycApprovalEntries(): KycApprovalEntry[] {
  const allPending = (): Record<KycFieldKey, KycApprovalEntry['fields'][KycFieldKey]> => ({
    PAYMENT:          { decision: 'PENDING' },
    GST_VALIDATION:   { decision: 'PENDING' },
    GST_DOCUMENT:     { decision: 'PENDING' },
    ADDRESS:          { decision: 'PENDING' },
    ADDRESS_DOCUMENT: { decision: 'PENDING' },
    BOARD_PHOTO:      { decision: 'PENDING' },
    OWNER_PHOTO:      { decision: 'PENDING' },
  });

  return [
    // ── 1: Kumar General Store — all PENDING, bank payment ──────────────────
    {
      submissionId:       'KYC-2026-0001',
      outletCode:         'OUT-2026-K01',
      outletName:         'Kumar General Store',
      ownerName:          'Suresh Kumar',
      mobile:             '9820100001',
      partnerClass:       'SSS',
      gstNumber:          '27ABCDE1234F1ZK',
      panNumber:          'ABCDE1234F',
      address:            '12 SV Road, Andheri West',
      city:               'Mumbai',
      state:              'Maharashtra',
      pincode:            '400058',
      paymentMode:        'bank',
      bankName:           'HDFC Bank',
      accountHolderName:  'Suresh Kumar',
      accountNumber:      '50100111222333',
      ifscCode:           'HDFC0001234',
      nameMismatch:       false,
      boardGeo:           { lat: 19.1359, lng: 72.8262 },
      documents: {
        gstCertificateUrl:  'https://example.com/kyc/KYC-2026-0001/gst.pdf',
        addressDocUrl:      'https://example.com/kyc/KYC-2026-0001/address.pdf',
        selfDeclarationUrl: 'https://example.com/kyc/KYC-2026-0001/self-declaration.pdf',
        boardPhotoUrl:      'https://picsum.photos/seed/KYC-2026-0001-board/400/300',
        ownerPhotoUrl:      'https://picsum.photos/seed/KYC-2026-0001-owner/400/300',
        chequeUrl:          'https://picsum.photos/seed/KYC-2026-0001-cheque/400/300',
      },
      fields: allPending(),
    },

    // ── 2: Singh Supermart — PAYMENT + GST_VALIDATION pre-approved by Excel ─
    {
      submissionId:       'KYC-2026-0002',
      outletCode:         'OUT-2026-K04',
      outletName:         'Singh Supermart',
      ownerName:          'Gurpreet Singh',
      mobile:             '9820100002',
      partnerClass:       'WHOLESALER',
      gstNumber:          '27BCDEF2345G1ZP',
      panNumber:          'BCDEF2345G',
      address:            '78 Link Road, Malad W',
      city:               'Mumbai',
      state:              'Maharashtra',
      pincode:            '400064',
      paymentMode:        'bank',
      bankName:           'ICICI Bank',
      accountHolderName:  'Gurpreet Singh',
      accountNumber:      '000101234567890',
      ifscCode:           'ICIC0000001',
      nameMismatch:       false,
      boardGeo:           { lat: 19.1863, lng: 72.8487 },
      documents: {
        gstCertificateUrl:  'https://example.com/kyc/KYC-2026-0002/gst.pdf',
        addressDocUrl:      'https://example.com/kyc/KYC-2026-0002/address.pdf',
        selfDeclarationUrl: 'https://example.com/kyc/KYC-2026-0002/self-declaration.pdf',
        boardPhotoUrl:      'https://picsum.photos/seed/KYC-2026-0002-board/400/300',
        ownerPhotoUrl:      'https://picsum.photos/seed/KYC-2026-0002-owner/400/300',
        chequeUrl:          'https://picsum.photos/seed/KYC-2026-0002-cheque/400/300',
      },
      fields: {
        PAYMENT:          { decision: 'APPROVED', source: 'EXCEL' },
        GST_VALIDATION:   { decision: 'APPROVED', source: 'EXCEL' },
        GST_DOCUMENT:     { decision: 'PENDING' },
        ADDRESS:          { decision: 'PENDING' },
        ADDRESS_DOCUMENT: { decision: 'PENDING' },
        BOARD_PHOTO:      { decision: 'PENDING' },
        OWNER_PHOTO:      { decision: 'PENDING' },
      },
    },

    // ── 3: Sharma General Store — OWNER_PHOTO rejected by Excel, nameMismatch ─
    {
      submissionId:       'KYC-2026-0003',
      outletCode:         'OUT-2026-K10',
      outletName:         'Sharma General Store',
      ownerName:          'Ramesh Sharma',
      mobile:             '9820100003',
      partnerClass:       'SSS',
      gstNumber:          '07CDEFG3456H1ZM',
      panNumber:          'CDEFG3456H',
      address:            '5 Sector 18, Noida',
      city:               'Delhi',
      state:              'Delhi',
      pincode:            '201301',
      paymentMode:        'bank',
      bankName:           'SBI',
      accountHolderName:  'Ramesh Kumar',   // different from ownerName → mismatch
      accountNumber:      '31234567891',
      ifscCode:           'SBIN0001234',
      nameMismatch:       true,
      boardGeo:           { lat: 28.5706, lng: 77.3261 },
      documents: {
        gstCertificateUrl:  'https://example.com/kyc/KYC-2026-0003/gst.pdf',
        addressDocUrl:      'https://example.com/kyc/KYC-2026-0003/address.pdf',
        selfDeclarationUrl: 'https://example.com/kyc/KYC-2026-0003/self-declaration.pdf',
        boardPhotoUrl:      'https://picsum.photos/seed/KYC-2026-0003-board/400/300',
        ownerPhotoUrl:      'https://picsum.photos/seed/KYC-2026-0003-owner/400/300',
        chequeUrl:          'https://picsum.photos/seed/KYC-2026-0003-cheque/400/300',
      },
      fields: {
        PAYMENT:          { decision: 'PENDING' },
        GST_VALIDATION:   { decision: 'APPROVED', source: 'EXCEL' },
        GST_DOCUMENT:     { decision: 'APPROVED', source: 'EXCEL' },
        ADDRESS:          { decision: 'PENDING' },
        ADDRESS_DOCUMENT: { decision: 'PENDING' },
        BOARD_PHOTO:      { decision: 'PENDING' },
        OWNER_PHOTO:      { decision: 'REJECTED', remark: 'Photo blurry — owner not identifiable', source: 'EXCEL' },
      },
    },

    // ── 4: Sharma Kirana — UPI payment mode, no bank fields ─────────────────
    {
      submissionId:       'KYC-2026-0004',
      outletCode:         'OUT-2026-K02',
      outletName:         'Sharma Kirana',
      ownerName:          'Amit Sharma',
      mobile:             '9820100004',
      partnerClass:       'SSS',
      gstNumber:          '',
      panNumber:          'DEFGH4567I',
      address:            '5 Station Road, Borivali W',
      city:               'Mumbai',
      state:              'Maharashtra',
      pincode:            '400066',
      paymentMode:        'upi',
      upiId:              'amit.sharma@paytm',
      nameMismatch:       false,
      boardGeo:           { lat: 19.2307, lng: 72.8567 },
      documents: {
        gstCertificateUrl:  undefined,
        addressDocUrl:      'https://example.com/kyc/KYC-2026-0004/address.pdf',
        selfDeclarationUrl: 'https://example.com/kyc/KYC-2026-0004/self-declaration.pdf',
        boardPhotoUrl:      'https://picsum.photos/seed/KYC-2026-0004-board/400/300',
        ownerPhotoUrl:      'https://picsum.photos/seed/KYC-2026-0004-owner/400/300',
        chequeUrl:          undefined,
      },
      fields: allPending(),
    },

    // ── 5: Mehta Provisions — UPI, nameMismatch ──────────────────────────────
    {
      submissionId:       'KYC-2026-0005',
      outletCode:         'OUT-2026-K05',
      outletName:         'Mehta Provisions',
      ownerName:          'Nilesh Mehta',
      mobile:             '9820100005',
      partnerClass:       'SUB_STOCKIST',
      gstNumber:          '27EFGHI5678J1ZB',
      panNumber:          'EFGHI5678J',
      address:            '22 Mahavir Nagar, Kandivali',
      city:               'Mumbai',
      state:              'Maharashtra',
      pincode:            '400067',
      paymentMode:        'upi',
      upiId:              'nilesh.mehta@paytm',
      nameMismatch:       true,
      boardGeo:           { lat: 19.2056, lng: 72.8399 },
      documents: {
        gstCertificateUrl:  'https://example.com/kyc/KYC-2026-0005/gst.pdf',
        addressDocUrl:      'https://example.com/kyc/KYC-2026-0005/address.pdf',
        selfDeclarationUrl: 'https://example.com/kyc/KYC-2026-0005/self-declaration.pdf',
        boardPhotoUrl:      'https://picsum.photos/seed/KYC-2026-0005-board/400/300',
        ownerPhotoUrl:      'https://picsum.photos/seed/KYC-2026-0005-owner/400/300',
        chequeUrl:          undefined,
      },
      fields: allPending(),
    },

    // ── 6: Krishnamurthy & Sons — bank, all PENDING ──────────────────────────
    {
      submissionId:       'KYC-2026-0006',
      outletCode:         'OUT-2026-K11',
      outletName:         'Krishnamurthy & Sons',
      ownerName:          'K. Krishnamurthy',
      mobile:             '9844100006',
      partnerClass:       'WHOLESALER',
      gstNumber:          '29EFGHI5678J1ZR',
      panNumber:          'EFGHI5678J',
      address:            '14 Hosur Road, Koramangala',
      city:               'Bengaluru',
      state:              'Karnataka',
      pincode:            '560034',
      paymentMode:        'bank',
      bankName:           'Canara Bank',
      accountHolderName:  'Krishnamurthy & Sons',
      accountNumber:      '3234500200345',
      ifscCode:           'CNRB0004567',
      nameMismatch:       false,
      boardGeo:           { lat: 12.9352, lng: 77.6245 },
      documents: {
        gstCertificateUrl:  'https://example.com/kyc/KYC-2026-0006/gst.pdf',
        addressDocUrl:      'https://example.com/kyc/KYC-2026-0006/address.pdf',
        selfDeclarationUrl: 'https://example.com/kyc/KYC-2026-0006/self-declaration.pdf',
        boardPhotoUrl:      'https://picsum.photos/seed/KYC-2026-0006-board/400/300',
        ownerPhotoUrl:      'https://picsum.photos/seed/KYC-2026-0006-owner/400/300',
        chequeUrl:          'https://picsum.photos/seed/KYC-2026-0006-cheque/400/300',
      },
      fields: allPending(),
    },

    // ── 7: Reddy Wholesale — bank, all PENDING ───────────────────────────────
    {
      submissionId:       'KYC-2026-0007',
      outletCode:         'OUT-2026-K12',
      outletName:         'Reddy Wholesale',
      ownerName:          'Srinivas Reddy',
      mobile:             '9866100007',
      partnerClass:       'WHOLESALER',
      gstNumber:          '36FGHIJ6789K1ZS',
      panNumber:          'FGHIJ6789K',
      address:            '23 Banjara Hills',
      city:               'Hyderabad',
      state:              'Telangana',
      pincode:            '500034',
      paymentMode:        'bank',
      bankName:           'HDFC Bank',
      accountHolderName:  'Srinivas Reddy',
      accountNumber:      '50100333444555',
      ifscCode:           'HDFC0009988',
      nameMismatch:       false,
      boardGeo:           { lat: 17.4150, lng: 78.4484 },
      documents: {
        gstCertificateUrl:  'https://example.com/kyc/KYC-2026-0007/gst.pdf',
        addressDocUrl:      'https://example.com/kyc/KYC-2026-0007/address.pdf',
        selfDeclarationUrl: 'https://example.com/kyc/KYC-2026-0007/self-declaration.pdf',
        boardPhotoUrl:      'https://picsum.photos/seed/KYC-2026-0007-board/400/300',
        ownerPhotoUrl:      'https://picsum.photos/seed/KYC-2026-0007-owner/400/300',
        chequeUrl:          'https://picsum.photos/seed/KYC-2026-0007-cheque/400/300',
      },
      fields: allPending(),
    },

    // ── 8: Verma Traders — UPI, all PENDING ─────────────────────────────────
    {
      submissionId:       'KYC-2026-0008',
      outletCode:         'OUT-2026-001',
      outletName:         'Verma Traders',
      ownerName:          'Mohan Verma',
      mobile:             '9820100008',
      partnerClass:       'SSS',
      gstNumber:          '27UVWXY7890Z1ZR',
      panNumber:          'UVWXY7890Z',
      address:            '31 Versova Road, Andheri W',
      city:               'Mumbai',
      state:              'Maharashtra',
      pincode:            '400061',
      paymentMode:        'upi',
      upiId:              'mohan.verma@upi',
      nameMismatch:       false,
      boardGeo:           { lat: 19.1313, lng: 72.8187 },
      documents: {
        gstCertificateUrl:  'https://example.com/kyc/KYC-2026-0008/gst.pdf',
        addressDocUrl:      'https://example.com/kyc/KYC-2026-0008/address.pdf',
        selfDeclarationUrl: 'https://example.com/kyc/KYC-2026-0008/self-declaration.pdf',
        boardPhotoUrl:      'https://picsum.photos/seed/KYC-2026-0008-board/400/300',
        ownerPhotoUrl:      'https://picsum.photos/seed/KYC-2026-0008-owner/400/300',
        chequeUrl:          undefined,
      },
      fields: allPending(),
    },
  ];
}
