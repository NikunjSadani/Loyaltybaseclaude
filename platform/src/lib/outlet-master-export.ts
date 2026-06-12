/**
 * Outlet Master Excel Export
 *
 * Generates a comprehensive Excel download of all outlet data,
 * organised into 9 labelled sections (columns A–I in the spec).
 *
 * In DEMO_MODE (or when called with demo rows) the function uses
 * DEMO_OUTLET_MASTER_ROWS. In production the caller supplies rows
 * fetched from the DB.
 */

import * as XLSX from 'xlsx';
import type { OutletMasterRow } from '@/types';

// ─── Column headers (in display order) ───────────────────────────────────────

/** Column header label for each key of OutletMasterRow, in file order. */
const COLUMNS: { key: keyof OutletMasterRow; label: string; section: string }[] = [
  // A: Identity
  { key: 'outletId',        label: 'Outlet ID',          section: 'A: Identity' },
  { key: 'outletCode',      label: 'Outlet Code',        section: 'A: Identity' },
  { key: 'outletName',      label: 'Outlet Name',        section: 'A: Identity' },
  { key: 'outletType',      label: 'Outlet Type',        section: 'A: Identity' },
  { key: 'partnerClass',    label: 'Partner Class',      section: 'A: Identity' },
  { key: 'programName',     label: 'Program Name',       section: 'A: Identity' },
  { key: 'programCategory', label: 'Program Category',   section: 'A: Identity' },
  { key: 'beat',            label: 'Beat',               section: 'A: Identity' },
  { key: 'isMetro',         label: 'Metro',              section: 'A: Identity' },

  // B: Contact / Address
  { key: 'ownerName',    label: 'Owner Name',   section: 'B: Contact/Address' },
  { key: 'phone',        label: 'Phone',        section: 'B: Contact/Address' },
  { key: 'addressLine1', label: 'Address',      section: 'B: Contact/Address' },
  { key: 'addressLine2', label: 'Address Line 2', section: 'B: Contact/Address' },
  { key: 'city',         label: 'City',         section: 'B: Contact/Address' },
  { key: 'state',        label: 'State',        section: 'B: Contact/Address' },
  { key: 'pincode',      label: 'Pincode',      section: 'B: Contact/Address' },

  // C: Program / Distribution
  { key: 'distributorId',   label: 'Distributor ID',   section: 'C: Program/Distribution' },
  { key: 'distributorName', label: 'Distributor Name', section: 'C: Program/Distribution' },

  // D: Sales Hierarchy
  { key: 'hierarchyL1Id',   label: 'ISR ID',   section: 'D: Sales Hierarchy' },
  { key: 'hierarchyL1Name', label: 'ISR Name', section: 'D: Sales Hierarchy' },
  { key: 'hierarchyL2Id',   label: 'SO ID',    section: 'D: Sales Hierarchy' },
  { key: 'hierarchyL2Name', label: 'SO Name',  section: 'D: Sales Hierarchy' },
  { key: 'hierarchyL3Id',   label: 'ASM ID',   section: 'D: Sales Hierarchy' },
  { key: 'hierarchyL3Name', label: 'ASM Name', section: 'D: Sales Hierarchy' },
  { key: 'hierarchyL4Id',   label: 'RSM ID',   section: 'D: Sales Hierarchy' },
  { key: 'hierarchyL4Name', label: 'RSM Name', section: 'D: Sales Hierarchy' },
  { key: 'hierarchyL5Id',   label: 'ZNM ID',   section: 'D: Sales Hierarchy' },
  { key: 'hierarchyL5Name', label: 'ZNM Name', section: 'D: Sales Hierarchy' },
  { key: 'hierarchyL6Id',   label: 'NSM ID',   section: 'D: Sales Hierarchy' },
  { key: 'hierarchyL6Name', label: 'NSM Name', section: 'D: Sales Hierarchy' },

  // E: Enrollment / KYC Status
  { key: 'kycStatus',       label: 'KYC Status',     section: 'E: Enrollment' },
  { key: 'isActive',        label: 'Active',         section: 'E: Enrollment' },
  { key: 'addedDate',       label: 'Date Added',     section: 'E: Enrollment' },
  { key: 'enrolledByName',  label: 'Enrolled By',    section: 'E: Enrollment' },

  // F: KYC / Approval
  { key: 'panNumber',            label: 'PAN Number',        section: 'F: KYC/Approval' },
  { key: 'gstNumber',            label: 'GST Number',        section: 'F: KYC/Approval' },
  { key: 'kycApprovedAt',        label: 'KYC Approved At',   section: 'F: KYC/Approval' },
  { key: 'kycRejectedAt',        label: 'KYC Rejected At',   section: 'F: KYC/Approval' },
  { key: 'kycRejectionReason',   label: 'Rejection Reason',  section: 'F: KYC/Approval' },

  // G: KYC Documents
  { key: 'docAadhaarFront',     label: 'Aadhaar Front',       section: 'G: KYC Documents' },
  { key: 'docAadhaarBack',      label: 'Aadhaar Back',        section: 'G: KYC Documents' },
  { key: 'docPanCard',          label: 'PAN Card',            section: 'G: KYC Documents' },
  { key: 'docGstCertificate',   label: 'GST Certificate',     section: 'G: KYC Documents' },
  { key: 'docTradeLicense',     label: 'Trade License',       section: 'G: KYC Documents' },
  { key: 'docShopEstablishment',label: 'Shop Establishment',  section: 'G: KYC Documents' },
  { key: 'docBankPassbook',     label: 'Bank Passbook',       section: 'G: KYC Documents' },
  { key: 'docCancelledCheque',  label: 'Cancelled Cheque',    section: 'G: KYC Documents' },
  { key: 'docSelfie',           label: 'Owner Selfie',        section: 'G: KYC Documents' },
  { key: 'docBoardPhoto',       label: 'Board Photo',         section: 'G: KYC Documents' },
  { key: 'docSignature',        label: 'Signature',           section: 'G: KYC Documents' },

  // H: Banking
  { key: 'bankName',          label: 'Bank Name',             section: 'H: Banking' },
  { key: 'accountHolderName', label: 'Account Holder Name',   section: 'H: Banking' },
  { key: 'accountNumber',     label: 'Account Number',        section: 'H: Banking' },
  { key: 'ifscCode',          label: 'IFSC Code',             section: 'H: Banking' },
  { key: 'upiId',             label: 'UPI ID',                section: 'H: Banking' },
  { key: 'paymentMode',       label: 'Payment Mode',          section: 'H: Banking' },

  // I: Lifecycle
  { key: 'createdAt',    label: 'Created At',    section: 'I: Lifecycle' },
  { key: 'updatedAt',    label: 'Updated At',    section: 'I: Lifecycle' },
  { key: 'deactivatedAt',label: 'Deactivated At',section: 'I: Lifecycle' },
  { key: 'reactivatedAt',label: 'Reactivated At',section: 'I: Lifecycle' },
];

// ─── Demo data (10 rows) ─────────────────────────────────────────────────────

export const DEMO_OUTLET_MASTER_ROWS: OutletMasterRow[] = [
  {
    outletId: 'OUT-2026-K01', outletName: 'Kumar General Store', outletType: 'SSS',
    programName: 'Trade Loyalty', programCategory: 'Standard', beat: 'Andheri Beat', isMetro: true,
    ownerName: 'Suresh Kumar', phone: '9820100001', addressLine1: '12 SV Road, Andheri West', city: 'Mumbai', state: 'Maharashtra', pincode: '400058',
    distributorId: 'DIST-01', distributorName: 'Mumbai Distributors Pvt Ltd',
    hierarchyL1Id: 'ISR-M001', hierarchyL1Name: 'Anil Sharma',
    hierarchyL2Id: 'SO-M01',   hierarchyL2Name: 'Vikram Mehta',
    hierarchyL3Id: 'ASM-W01',  hierarchyL3Name: 'Priya Iyer',
    hierarchyL4Id: 'RSM-MH01', hierarchyL4Name: 'Rajesh Nair',
    hierarchyL5Id: 'ZNM-W01',  hierarchyL5Name: 'Suresh Gupta',
    hierarchyL6Id: 'NSM-01',   hierarchyL6Name: 'Mohan Das',
    kycStatus: 'APPROVED', isActive: true, addedDate: '2026-03-01',
    panNumber: 'ABCDE1234F', gstNumber: '27ABCDE1234F1ZK', kycApprovedAt: '2026-03-15',
    docGstCertificate: 'DEMO:GST_CERTIFICATE:kyc-001', docCancelledCheque: 'DEMO:CANCELLED_CHEQUE:kyc-001',
    docSelfie: 'DEMO:SELFIE:kyc-001', docSignature: 'DEMO:SIGNATURE:kyc-001',
    bankName: 'HDFC Bank', accountHolderName: 'Suresh Kumar', accountNumber: '50100111222333', ifscCode: 'HDFC0001234', paymentMode: 'bank',
    createdAt: '2026-03-01T09:00:00Z', updatedAt: '2026-03-15T14:00:00Z',
  },
  {
    outletId: 'OUT-2026-K04', outletName: 'Singh Supermart', outletType: 'WHOLESALER',
    programName: 'Trade Loyalty', programCategory: 'Premium', beat: 'Malad Beat', isMetro: true,
    ownerName: 'Gurpreet Singh', phone: '9820100002', addressLine1: '78 Link Road, Malad W', city: 'Mumbai', state: 'Maharashtra', pincode: '400064',
    distributorId: 'DIST-01', distributorName: 'Mumbai Distributors Pvt Ltd',
    hierarchyL1Id: 'ISR-M001', hierarchyL1Name: 'Anil Sharma',
    hierarchyL2Id: 'SO-M01',   hierarchyL2Name: 'Vikram Mehta',
    hierarchyL3Id: 'ASM-W01',  hierarchyL3Name: 'Priya Iyer',
    hierarchyL4Id: 'RSM-MH01', hierarchyL4Name: 'Rajesh Nair',
    hierarchyL5Id: 'ZNM-W01',  hierarchyL5Name: 'Suresh Gupta',
    hierarchyL6Id: 'NSM-01',   hierarchyL6Name: 'Mohan Das',
    kycStatus: 'APPROVED', isActive: true, addedDate: '2026-03-01',
    panNumber: 'BCDEF2345G', gstNumber: '27BCDEF2345G1ZP', kycApprovedAt: '2026-03-20',
    docGstCertificate: 'DEMO:GST_CERTIFICATE:kyc-002', docCancelledCheque: 'DEMO:CANCELLED_CHEQUE:kyc-002',
    docSelfie: 'DEMO:SELFIE:kyc-002', docSignature: 'DEMO:SIGNATURE:kyc-002',
    bankName: 'ICICI Bank', accountHolderName: 'Gurpreet Singh', accountNumber: '000101234567890', ifscCode: 'ICIC0000001', paymentMode: 'bank',
    createdAt: '2026-03-01T09:30:00Z', updatedAt: '2026-03-20T11:00:00Z',
  },
  {
    outletId: 'OUT-2026-K10', outletName: 'Sharma General Store', outletType: 'SSS',
    programName: 'Trade Loyalty', programCategory: 'Standard', beat: 'Noida Beat', isMetro: true,
    ownerName: 'Ramesh Sharma', phone: '9820100003', addressLine1: '5 Sector 18, Noida', city: 'Delhi', state: 'Delhi', pincode: '201301',
    distributorId: 'DIST-03', distributorName: 'Delhi Distributors Ltd',
    hierarchyL1Id: 'ISR-P001', hierarchyL1Name: 'Deepa Nair',
    hierarchyL2Id: 'SO-D01',   hierarchyL2Name: 'Arun Pillai',
    hierarchyL3Id: 'ASM-N01',  hierarchyL3Name: 'Sanjay Mishra',
    hierarchyL4Id: 'RSM-DL01', hierarchyL4Name: 'Lalit Verma',
    hierarchyL5Id: 'ZNM-N01',  hierarchyL5Name: 'Pradeep Singh',
    hierarchyL6Id: 'NSM-01',   hierarchyL6Name: 'Mohan Das',
    kycStatus: 'APPROVED', isActive: true, addedDate: '2026-03-15',
    panNumber: 'CDEFG3456H', gstNumber: '07CDEFG3456H1ZM', kycApprovedAt: '2026-03-28',
    docGstCertificate: 'DEMO:GST_CERTIFICATE:kyc-003', docCancelledCheque: 'DEMO:CANCELLED_CHEQUE:kyc-003',
    docSelfie: 'DEMO:SELFIE:kyc-003', docSignature: 'DEMO:SIGNATURE:kyc-003',
    bankName: 'SBI', accountHolderName: 'Ramesh Sharma', accountNumber: '31234567891', ifscCode: 'SBIN0001234', paymentMode: 'bank',
    createdAt: '2026-03-15T10:00:00Z', updatedAt: '2026-03-28T15:00:00Z',
  },
  {
    outletId: 'OUT-2026-K02', outletName: 'Sharma Kirana', outletType: 'SSS',
    programName: 'Trade Loyalty', programCategory: 'Standard', beat: 'Borivali Beat', isMetro: true,
    ownerName: 'Amit Sharma', phone: '9820100004', addressLine1: '5 Station Road, Borivali W', city: 'Mumbai', state: 'Maharashtra', pincode: '400066',
    distributorId: 'DIST-01', distributorName: 'Mumbai Distributors Pvt Ltd',
    hierarchyL1Id: 'ISR-M001', hierarchyL1Name: 'Anil Sharma',
    hierarchyL2Id: 'SO-M01',   hierarchyL2Name: 'Vikram Mehta',
    hierarchyL3Id: 'ASM-W01',  hierarchyL3Name: 'Priya Iyer',
    hierarchyL4Id: 'RSM-MH01', hierarchyL4Name: 'Rajesh Nair',
    hierarchyL5Id: 'ZNM-W01',  hierarchyL5Name: 'Suresh Gupta',
    hierarchyL6Id: 'NSM-01',   hierarchyL6Name: 'Mohan Das',
    kycStatus: 'PENDING_SO_APPROVAL', isActive: false, addedDate: '2026-04-01',
    panNumber: 'DEFGH4567I',
    docGstCertificate: 'DEMO:GST_CERTIFICATE:kyc-004', docSelfie: 'DEMO:SELFIE:kyc-004',
    bankName: 'HDFC Bank', accountHolderName: 'Amit Sharma', accountNumber: '50100222333444', ifscCode: 'HDFC0005678', paymentMode: 'bank',
    createdAt: '2026-04-01T09:00:00Z', updatedAt: '2026-04-01T09:00:00Z',
    deactivatedAt: '2026-04-02T12:00:00Z',
  },
  {
    outletId: 'OUT-2026-K05', outletName: 'Mehta Provisions', outletType: 'SUB_STOCKIST',
    programName: 'Trade Loyalty', programCategory: 'Economy', beat: 'Kandivali Beat', isMetro: false,
    ownerName: 'Nilesh Mehta', phone: '9820100005', addressLine1: '22 Mahavir Nagar, Kandivali', city: 'Mumbai', state: 'Maharashtra', pincode: '400067',
    distributorId: 'DIST-02', distributorName: 'Suburban Distributors',
    hierarchyL1Id: 'ISR-M001', hierarchyL1Name: 'Anil Sharma',
    hierarchyL2Id: 'SO-M01',   hierarchyL2Name: 'Vikram Mehta',
    hierarchyL3Id: 'ASM-W01',  hierarchyL3Name: 'Priya Iyer',
    hierarchyL4Id: 'RSM-MH01', hierarchyL4Name: 'Rajesh Nair',
    hierarchyL5Id: 'ZNM-W01',  hierarchyL5Name: 'Suresh Gupta',
    hierarchyL6Id: 'NSM-01',   hierarchyL6Name: 'Mohan Das',
    kycStatus: 'SUBMITTED', isActive: false, addedDate: '2026-04-15',
    docGstCertificate: 'DEMO:GST_CERTIFICATE:kyc-005',
    upiId: 'nilesh.mehta@paytm', paymentMode: 'upi',
    createdAt: '2026-04-15T11:00:00Z', updatedAt: '2026-04-15T11:00:00Z',
  },
  {
    outletId: 'OUT-2026-K03', outletName: 'Patel Grocery', outletType: 'SSS',
    programName: 'Trade Loyalty', programCategory: 'Standard', beat: 'Thane Beat', isMetro: false,
    ownerName: 'Suresh Patel', phone: '9820100006', addressLine1: 'Shop 3, MG Road, Thane W', city: 'Thane', state: 'Maharashtra', pincode: '400601',
    distributorId: 'DIST-02', distributorName: 'Suburban Distributors',
    hierarchyL1Id: 'ISR-M002', hierarchyL1Name: 'PLACEHOLDER',
    hierarchyL2Id: 'SO-M01',   hierarchyL2Name: 'Vikram Mehta',
    hierarchyL3Id: 'ASM-W01',  hierarchyL3Name: 'Priya Iyer',
    hierarchyL4Id: 'RSM-MH01', hierarchyL4Name: 'Rajesh Nair',
    hierarchyL5Id: 'ZNM-W01',  hierarchyL5Name: 'Suresh Gupta',
    hierarchyL6Id: 'NSM-01',   hierarchyL6Name: 'Mohan Das',
    kycStatus: 'REJECTED', isActive: false, addedDate: '2026-04-01',
    gstNumber: '27XYZAB5678C1ZQ', kycRejectedAt: '2026-04-10', kycRejectionReason: 'GST certificate invalid — number mismatch',
    bankName: 'Axis Bank', accountHolderName: 'Suresh Patel', accountNumber: '9120003456789', ifscCode: 'UTIB0000234', paymentMode: 'bank',
    createdAt: '2026-04-01T09:00:00Z', updatedAt: '2026-04-10T10:00:00Z',
  },
  {
    outletId: 'OUT-2026-K11', outletName: 'Krishnamurthy & Sons', outletType: 'WHOLESALER',
    programName: 'Gold Programme', programCategory: 'Premium', beat: 'Koramangala Beat', isMetro: true,
    ownerName: 'K. Krishnamurthy', phone: '9820100007', addressLine1: '14 Hosur Road, Koramangala', city: 'Bengaluru', state: 'Karnataka', pincode: '560034',
    distributorId: 'DIST-05', distributorName: 'Karnataka Wholesale',
    hierarchyL1Id: 'ISR-P001', hierarchyL1Name: 'Deepa Nair',
    hierarchyL2Id: 'SO-B01',   hierarchyL2Name: 'Karthik Rajan',
    hierarchyL3Id: 'ASM-S01',  hierarchyL3Name: 'Shweta Reddy',
    hierarchyL4Id: 'RSM-KA01', hierarchyL4Name: 'Mahesh Gowda',
    hierarchyL5Id: 'ZNM-S01',  hierarchyL5Name: 'Pradeep Singh',
    hierarchyL6Id: 'NSM-01',   hierarchyL6Name: 'Mohan Das',
    kycStatus: 'RE_KYC_REQUIRED', isActive: true, addedDate: '2026-03-10',
    panNumber: 'EFGHI5678J', gstNumber: '29EFGHI5678J1ZR', kycApprovedAt: '2026-03-25',
    docGstCertificate: 'DEMO:GST_CERTIFICATE:kyc-006', docCancelledCheque: 'DEMO:CANCELLED_CHEQUE:kyc-006',
    docSelfie: 'DEMO:SELFIE:kyc-006', docSignature: 'DEMO:SIGNATURE:kyc-006',
    bankName: 'Canara Bank', accountHolderName: 'Krishnamurthy & Sons', accountNumber: '3234500200345', ifscCode: 'CNRB0004567', paymentMode: 'bank',
    createdAt: '2026-03-10T09:00:00Z', updatedAt: '2026-05-01T16:00:00Z',
  },
  {
    outletId: 'OUT-2026-001', outletName: 'Verma Traders', outletType: 'SSS',
    programName: 'Trade Loyalty', programCategory: 'Standard', beat: 'Andheri Beat', isMetro: true,
    ownerName: 'Mohan Verma', phone: '9820100008', addressLine1: '31 Versova Road, Andheri W', city: 'Mumbai', state: 'Maharashtra', pincode: '400061',
    hierarchyL1Id: 'ISR-M001', hierarchyL1Name: 'Anil Sharma',
    hierarchyL2Id: 'SO-M01',   hierarchyL2Name: 'Vikram Mehta',
    hierarchyL3Id: 'ASM-W01',  hierarchyL3Name: 'Priya Iyer',
    hierarchyL4Id: 'RSM-MH01', hierarchyL4Name: 'Rajesh Nair',
    hierarchyL5Id: 'ZNM-W01',  hierarchyL5Name: 'Suresh Gupta',
    hierarchyL6Id: 'NSM-01',   hierarchyL6Name: 'Mohan Das',
    kycStatus: 'NOT_STARTED', isActive: false, addedDate: '2026-05-01',
    createdAt: '2026-05-01T09:00:00Z', updatedAt: '2026-05-01T09:00:00Z',
  },
  {
    outletId: 'OUT-2026-002', outletName: 'Joshi Provisions', outletType: 'SSS',
    programName: 'Trade Loyalty', programCategory: 'Standard', beat: 'Andheri Beat', isMetro: true,
    ownerName: 'Anita Joshi', phone: '9820100009', addressLine1: '7 Lokhandwala, Andheri W', city: 'Mumbai', state: 'Maharashtra', pincode: '400053',
    hierarchyL1Id: 'ISR-M001', hierarchyL1Name: 'Anil Sharma',
    hierarchyL2Id: 'SO-M01',   hierarchyL2Name: 'Vikram Mehta',
    hierarchyL3Id: 'ASM-W01',  hierarchyL3Name: 'Priya Iyer',
    hierarchyL4Id: 'RSM-MH01', hierarchyL4Name: 'Rajesh Nair',
    hierarchyL5Id: 'ZNM-W01',  hierarchyL5Name: 'Suresh Gupta',
    hierarchyL6Id: 'NSM-01',   hierarchyL6Name: 'Mohan Das',
    kycStatus: 'NOT_STARTED', isActive: false, addedDate: '2026-05-01',
    createdAt: '2026-05-01T10:00:00Z', updatedAt: '2026-05-01T10:00:00Z',
  },
  {
    outletId: 'OUT-2026-K12', outletName: 'Reddy Wholesale', outletType: 'WHOLESALER',
    programName: 'Gold Programme', programCategory: 'Premium', beat: 'Banjara Beat', isMetro: true,
    ownerName: 'Srinivas Reddy', phone: '9820100010', addressLine1: '23 Banjara Hills', city: 'Hyderabad', state: 'Telangana', pincode: '500034',
    distributorId: 'DIST-06', distributorName: 'Telangana Wholesale',
    hierarchyL1Id: 'ISR-H001', hierarchyL1Name: 'Kavya Prasad',
    hierarchyL2Id: 'SO-H01',   hierarchyL2Name: 'Sudhir Rao',
    hierarchyL3Id: 'ASM-T01',  hierarchyL3Name: 'Ravi Varma',
    hierarchyL4Id: 'RSM-TS01', hierarchyL4Name: 'Pramod Sharma',
    hierarchyL5Id: 'ZNM-S01',  hierarchyL5Name: 'Pradeep Singh',
    hierarchyL6Id: 'NSM-01',   hierarchyL6Name: 'Mohan Das',
    kycStatus: 'APPROVED', isActive: true, addedDate: '2026-02-15',
    panNumber: 'FGHIJ6789K', gstNumber: '36FGHIJ6789K1ZS', kycApprovedAt: '2026-03-01',
    docGstCertificate: 'DEMO:GST_CERTIFICATE:kyc-007', docCancelledCheque: 'DEMO:CANCELLED_CHEQUE:kyc-007',
    docSelfie: 'DEMO:SELFIE:kyc-007', docSignature: 'DEMO:SIGNATURE:kyc-007',
    bankName: 'HDFC Bank', accountHolderName: 'Srinivas Reddy', accountNumber: '50100333444555', ifscCode: 'HDFC0009988', paymentMode: 'bank',
    createdAt: '2026-02-15T09:00:00Z', updatedAt: '2026-03-01T12:00:00Z',
  },
];

// ─── Excel generator ─────────────────────────────────────────────────────────

/**
 * Generates an Excel workbook (.xlsx) containing the outlet master data.
 *
 * Returns a `Uint8Array` (Buffer) suitable for sending as a file download.
 *
 * @param rows  Outlet master rows to include. Defaults to `DEMO_OUTLET_MASTER_ROWS`.
 */
export function generateOutletMasterExcel(
  rows: OutletMasterRow[] = DEMO_OUTLET_MASTER_ROWS,
): Uint8Array {
  const wb = XLSX.utils.book_new();

  // ── Section grouping row (row 1) ──
  const sectionRow: string[] = COLUMNS.map(c => c.section);

  // ── Header row (row 2) ──
  const headerRow: string[] = COLUMNS.map(c => c.label);

  // ── Data rows ──
  const dataRows: (string | number | boolean | undefined)[][] = rows.map(row =>
    COLUMNS.map(({ key }) => {
      const val = row[key];
      if (val === undefined || val === null) return '';
      if (typeof val === 'boolean') return val ? 'Yes' : 'No';
      return val as string | number;
    }),
  );

  const wsData = [sectionRow, headerRow, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // ── Column widths ──
  ws['!cols'] = COLUMNS.map(({ label }) => ({
    wch: Math.max(label.length + 2, 18),
  }));

  // ── Bold header style ──
  // Note: xlsx CE (community edition) does not support cell styles.
  // For styled headers, use exceljs in production.

  XLSX.utils.book_append_sheet(wb, ws, 'Outlet Master');

  // type: 'buffer' returns a Node.js Buffer.  Wrap it in an explicit
  // Uint8Array view so instanceof checks pass across jsdom / Vitest realms.
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Total column count for the outlet master sheet (used in tests). */
export const OUTLET_MASTER_COLUMN_COUNT = COLUMNS.length;
