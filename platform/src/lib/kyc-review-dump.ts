/**
 * KYC Review Dump Export
 *
 * Pure, deterministic functions for the Lane A bulk KYC verification dump.
 * Generates one Excel of all PENDING_GIFSY submissions with every filled field
 * plus blank verification columns for Gifsy to fill offline.
 *
 * Spec: docs/plans/KYC-APPROVAL-REVAMP.md § The bulk flow (Lane A)
 */

import * as XLSX from 'xlsx';

// ─── Row interface ────────────────────────────────────────────────────────────

export interface KycReviewRow {
  submissionId:  string;
  outletCode:    string;
  outletName:    string;
  ownerName:     string;
  phone:         string;
  gstNumber:     string;
  panNumber:     string;
  address:       string;
  city:          string;
  state:         string;
  pincode:       string;
  bankName:      string;
  accountNumber: string;
  ifsc:          string;
  submittedAt:   string;
  salesUser:     string;
}

// ─── Column contract ──────────────────────────────────────────────────────────

/**
 * Context columns (16) — exported read-only for Gifsy reference.
 * These MUST match the parse headers in kyc-bulk-verify.ts exactly.
 */
export const KYC_DUMP_CONTEXT_HEADERS = [
  'Submission ID',
  'Outlet Code',
  'Outlet Name',
  'Owner Name',
  'Phone',
  'GST Number',
  'PAN Number',
  'Address',
  'City',
  'State',
  'Pincode',
  'Bank Name',
  'Account Number',
  'IFSC',
  'Submitted At',
  'Sales User',
] as const;

/**
 * Verification columns (10) — Gifsy fills offline, parsed on upload.
 * These MUST match the parse headers in kyc-bulk-verify.ts exactly.
 */
export const KYC_DUMP_VERIFICATION_HEADERS = [
  'Bank Verified',
  'Bank Name Match',
  'Penny-drop Ref',
  'GST Registration Type',
  'GST Legal Name',
  'GST Status',
  'Address Approved',
  'Owner Approved',
  'Decision',
  'Reason',
] as const;

// ─── Excel generator ──────────────────────────────────────────────────────────

/**
 * Generates an Excel workbook with 26 columns:
 *   16 context columns (pre-filled from submission data)
 *   10 verification columns (blank — Gifsy fills these offline)
 *
 * Returns a `Uint8Array` (same Buffer→Uint8Array wrap as sibling exports).
 */
export function generateKycReviewDumpExcel(rows: KycReviewRow[]): Uint8Array {
  const wb = XLSX.utils.book_new();

  const headerRow: string[] = [
    ...KYC_DUMP_CONTEXT_HEADERS,
    ...KYC_DUMP_VERIFICATION_HEADERS,
  ];

  const dataRows: (string | number)[][] = rows.map(r => [
    // Context cols (16)
    r.submissionId,
    r.outletCode,
    r.outletName,
    r.ownerName,
    r.phone,
    r.gstNumber,
    r.panNumber,
    r.address,
    r.city,
    r.state,
    r.pincode,
    r.bankName,
    r.accountNumber,
    r.ifsc,
    r.submittedAt,
    r.salesUser,
    // Verification cols (10) — blank for Gifsy to fill
    '', '', '', '', '', '', '', '', '', '',
  ]);

  const wsData = [headerRow, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Column widths — based on header label lengths
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
 */
export function demoKycReviewRows(): KycReviewRow[] {
  return [
    {
      submissionId:  'KYC-2026-0001',
      outletCode:    'OUT-2026-K01',
      outletName:    'Kumar General Store',
      ownerName:     'Suresh Kumar',
      phone:         '9820100001',
      gstNumber:     '27ABCDE1234F1ZK',
      panNumber:     'ABCDE1234F',
      address:       '12 SV Road, Andheri West',
      city:          'Mumbai',
      state:         'Maharashtra',
      pincode:       '400058',
      bankName:      'HDFC Bank',
      accountNumber: '50100111222333',
      ifsc:          'HDFC0001234',
      submittedAt:   '2026-05-10T09:00:00Z',
      salesUser:     'Vikram Mehta',
    },
    {
      submissionId:  'KYC-2026-0002',
      outletCode:    'OUT-2026-K04',
      outletName:    'Singh Supermart',
      ownerName:     'Gurpreet Singh',
      phone:         '9820100002',
      gstNumber:     '27BCDEF2345G1ZP',
      panNumber:     'BCDEF2345G',
      address:       '78 Link Road, Malad W',
      city:          'Mumbai',
      state:         'Maharashtra',
      pincode:       '400064',
      bankName:      'ICICI Bank',
      accountNumber: '000101234567890',
      ifsc:          'ICIC0000001',
      submittedAt:   '2026-05-11T10:30:00Z',
      salesUser:     'Vikram Mehta',
    },
    {
      submissionId:  'KYC-2026-0003',
      outletCode:    'OUT-2026-K10',
      outletName:    'Sharma General Store',
      ownerName:     'Ramesh Sharma',
      phone:         '9820100003',
      gstNumber:     '07CDEFG3456H1ZM',
      panNumber:     'CDEFG3456H',
      address:       '5 Sector 18, Noida',
      city:          'Delhi',
      state:         'Delhi',
      pincode:       '201301',
      bankName:      'SBI',
      accountNumber: '31234567891',
      ifsc:          'SBIN0001234',
      submittedAt:   '2026-05-12T11:00:00Z',
      salesUser:     'Arun Pillai',
    },
    {
      submissionId:  'KYC-2026-0004',
      outletCode:    'OUT-2026-K02',
      outletName:    'Sharma Kirana',
      ownerName:     'Amit Sharma',
      phone:         '9820100004',
      gstNumber:     '',
      panNumber:     'DEFGH4567I',
      address:       '5 Station Road, Borivali W',
      city:          'Mumbai',
      state:         'Maharashtra',
      pincode:       '400066',
      bankName:      'HDFC Bank',
      accountNumber: '50100222333444',
      ifsc:          'HDFC0005678',
      submittedAt:   '2026-05-13T08:45:00Z',
      salesUser:     'Vikram Mehta',
    },
    {
      submissionId:  'KYC-2026-0005',
      outletCode:    'OUT-2026-K05',
      outletName:    'Mehta Provisions',
      ownerName:     'Nilesh Mehta',
      phone:         '9820100005',
      gstNumber:     '27EFGHI5678J1ZB',
      panNumber:     'EFGHI5678J',
      address:       '22 Mahavir Nagar, Kandivali',
      city:          'Mumbai',
      state:         'Maharashtra',
      pincode:       '400067',
      bankName:      'Axis Bank',
      accountNumber: '912010012345678',
      ifsc:          'UTIB0000123',
      submittedAt:   '2026-05-14T14:00:00Z',
      salesUser:     'Vikram Mehta',
    },
    {
      submissionId:  'KYC-2026-0006',
      outletCode:    'OUT-2026-K11',
      outletName:    'Krishnamurthy & Sons',
      ownerName:     'T. Krishnamurthy',
      phone:         '9844100006',
      gstNumber:     '29JKLMN9012O1ZQ',
      panNumber:     'JKLMN9012O',
      address:       '14 Commercial Street, Bangalore',
      city:          'Bangalore',
      state:         'Karnataka',
      pincode:       '560001',
      bankName:      'Canara Bank',
      accountNumber: '1234500123456',
      ifsc:          'CNRB0000123',
      submittedAt:   '2026-05-15T09:30:00Z',
      salesUser:     'Suresh Gowda',
    },
    {
      submissionId:  'KYC-2026-0007',
      outletCode:    'OUT-2026-K12',
      outletName:    'Reddy Wholesale',
      ownerName:     'Venkateswara Reddy',
      phone:         '9866100007',
      gstNumber:     '36OPQRS3456T1ZL',
      panNumber:     'OPQRS3456T',
      address:       '9 Tank Bund Road, Hyderabad',
      city:          'Hyderabad',
      state:         'Telangana',
      pincode:       '500080',
      bankName:      'State Bank of India',
      accountNumber: '62012345678',
      ifsc:          'SBIN0020084',
      submittedAt:   '2026-05-16T11:15:00Z',
      salesUser:     'Arjun Reddy',
    },
    {
      submissionId:  'KYC-2026-0008',
      outletCode:    'OUT-2026-001',
      outletName:    'Verma Traders',
      ownerName:     'Rajesh Verma',
      phone:         '9820100008',
      gstNumber:     '27UVWXY7890Z1ZR',
      panNumber:     'UVWXY7890Z',
      address:       '3 MG Road, Vile Parle',
      city:          'Mumbai',
      state:         'Maharashtra',
      pincode:       '400057',
      bankName:      'Kotak Mahindra Bank',
      accountNumber: '1234567890',
      ifsc:          'KKBK0000154',
      submittedAt:   '2026-05-17T13:00:00Z',
      salesUser:     'Vikram Mehta',
    },
  ];
}
