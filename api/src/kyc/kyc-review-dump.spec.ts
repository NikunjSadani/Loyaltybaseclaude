// Unit tests for the pure KYC review-dump generator (40-column Lane A export).

import * as XLSX from 'xlsx';
import { KycFieldKey } from '@prisma/client';
import {
  generateKycReviewDumpExcel,
  generateRejectedKycExcel,
  KYC_DUMP_TOTAL_COLUMN_COUNT,
  KYC_FIELD_ORDER,
  kycFieldDecisionHeader,
  rejectedFieldVerdictHeader,
  rejectedFieldRemarkHeader,
  KycReviewDumpEntry,
  RejectedKycRow,
} from './kyc-review-dump';

const allPending = (): KycReviewDumpEntry['fields'] => {
  const f = {} as KycReviewDumpEntry['fields'];
  for (const { key } of KYC_FIELD_ORDER) f[key] = { decision: 'PENDING' };
  return f;
};

const entry = (over: Partial<KycReviewDumpEntry> = {}): KycReviewDumpEntry => ({
  submissionId: 'KYC-1',
  outletCode: 'OUT-1',
  outletName: 'Kumar Store',
  ownerName: 'Suresh',
  mobile: '9820100001',
  outletType: 'SSS',
  gstNumber: '27ABCDE1234F1ZK',
  panNumber: 'ABCDE1234F',
  address: '12 SV Road',
  city: 'Mumbai',
  state: 'Maharashtra',
  pincode: '400058',
  paymentMode: 'bank',
  bankName: 'HDFC',
  accountHolderName: 'Suresh',
  accountNumber: '50100',
  ifscCode: 'HDFC0001',
  boardGeo: { lat: 19.1, lng: 72.8 },
  nameMismatch: false,
  documents: { gstCertificateUrl: 'https://signed/gst' },
  fields: allPending(),
  ...over,
});

const parse = (buf: Buffer) => {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false, header: 1 }) as string[][];
  return { ws, rows };
};

describe('generateKycReviewDumpExcel', () => {
  it('produces the 40-column header layout (Partner Class at index 5)', () => {
    const { rows } = parse(generateKycReviewDumpExcel([entry()]));
    expect(rows[0].length).toBe(KYC_DUMP_TOTAL_COLUMN_COUNT);
    expect(rows[0][0]).toBe('Submission ID');
    expect(rows[0][5]).toBe('Partner Class');
    expect(rows[0]).toContain(kycFieldDecisionHeader('Owner Photo'));
  });

  it('puts the outlet type value into the Partner Class column', () => {
    const { rows } = parse(generateKycReviewDumpExcel([entry({ outletType: 'WHOLESALER' })]));
    expect(rows[1][5]).toBe('WHOLESALER');
  });

  it('maps field decisions APPROVED→APPROVE, REJECTED→REJECT, PENDING→blank', () => {
    const fields = allPending();
    fields.PAYMENT = { decision: 'APPROVED' };
    fields.OWNER_PHOTO = { decision: 'REJECTED', remark: 'blurry' };
    const { rows } = parse(generateKycReviewDumpExcel([entry({ fields })]));
    const payIdx = rows[0].indexOf(kycFieldDecisionHeader('Payment (Bank/UPI)'));
    const ownIdx = rows[0].indexOf(kycFieldDecisionHeader('Owner Photo'));
    const gstIdx = rows[0].indexOf(kycFieldDecisionHeader('GST Validation'));
    expect(rows[1][payIdx]).toBe('APPROVE');
    expect(rows[1][ownIdx]).toBe('REJECT');
    expect(rows[1][gstIdx]).toBe('');
  });

  it('applies a clickable hyperlink to a document cell', () => {
    const { ws } = parse(
      generateKycReviewDumpExcel([entry({ documents: { gstCertificateUrl: 'https://signed/gst' } })]),
    );
    const cell = ws[XLSX.utils.encode_cell({ r: 1, c: 20 })]; // GST Certificate column
    expect((cell as { l?: { Target: string } }).l?.Target).toBe('https://signed/gst');
  });

  it('renders an empty doc cell (no hyperlink) when the URL is absent', () => {
    const { ws } = parse(generateKycReviewDumpExcel([entry({ documents: {} })]));
    const cell = ws[XLSX.utils.encode_cell({ r: 1, c: 20 })];
    expect(cell?.v ?? '').toBe('');
  });

  it('a REJECTED field with no remark gets a placeholder (round-trip stays valid)', () => {
    const fields = allPending();
    fields.PAYMENT = { decision: 'REJECTED' }; // no remark
    const { rows } = parse(generateKycReviewDumpExcel([entry({ fields })]));
    const decIdx = rows[0].indexOf(kycFieldDecisionHeader('Payment (Bank/UPI)'));
    expect(rows[1][decIdx]).toBe('REJECT');
    expect(rows[1][decIdx + 1]).not.toBe(''); // remark column carries a non-empty placeholder
  });

  it('is deterministic in content', () => {
    const a = parse(generateKycReviewDumpExcel([entry()])).rows;
    const b = parse(generateKycReviewDumpExcel([entry()])).rows;
    expect(a).toEqual(b);
  });

  // ─── AF-5: formula-injection hardening (export is a sink — reviewers open it) ──
  it('neutralises formula-injection in user/data string cells', () => {
    const { rows } = parse(
      generateKycReviewDumpExcel([
        entry({
          outletName: '=cmd|\'/c calc\'!A1',
          ownerName: '@SUM(A1)',
          address: '+1+1',
          city: '-2',
          gstNumber: 'Benign Value',
        }),
      ]),
    );
    // header at rows[0]; first data row at rows[1]
    expect(rows[1][2]).toBe('\'=cmd|\'/c calc\'!A1'); // Outlet Name (col 2)
    expect(rows[1][3]).toBe('\'@SUM(A1)'); // Owner Name (col 3)
    expect(rows[1][8]).toBe('\'+1+1'); // Address (col 8)
    expect(rows[1][9]).toBe('\'-2'); // City (col 9)
    expect(rows[1][6]).toBe('Benign Value'); // GST Number (col 6) — unchanged
  });
});

describe('generateRejectedKycExcel', () => {
  const allPendingRej = (): RejectedKycRow['fields'] => {
    const f = {} as RejectedKycRow['fields'];
    for (const { key } of KYC_FIELD_ORDER) f[key] = { decision: 'PENDING' };
    return f;
  };

  const row = (over: Partial<RejectedKycRow> = {}): RejectedKycRow => ({
    outletCode: 'OUT-1',
    outletName: 'Kumar Store',
    ownerName: 'Suresh',
    mobile: '9820100001',
    salesRep: 'Rep A',
    submittedDate: '2026-06-20',
    rejectedDate: '2026-06-21',
    rejectedBy: 'Gifsy Admin',
    rejectionReason: 'GST mismatch',
    slaAgeHrs: 24,
    fields: allPendingRej(),
    gstNumber: '27ABCDE1234F1ZK',
    panNumber: 'ABCDE1234F',
    address: '12 SV Road',
    city: 'Mumbai',
    state: 'Maharashtra',
    pincode: '400058',
    bankName: 'HDFC',
    accountHolderName: 'Suresh',
    accountNumber: '50100',
    ifscCode: 'HDFC0001',
    upiId: '',
    ...over,
  });

  const byHeader = (rows: string[][], data: string[], name: string) => data[rows[0].indexOf(name)];

  it('emits the per-field verdict + remark columns and the rejected-fields summary', () => {
    const fields = allPendingRej();
    fields.GST_DOCUMENT = { decision: 'REJECTED', remark: 'illegible' };
    fields.PAYMENT = { decision: 'APPROVED' };
    const { rows } = parse(generateRejectedKycExcel([row({ fields })]));
    const data = rows[1];

    expect(rows[0]).toContain(rejectedFieldVerdictHeader('GST Document'));
    expect(rows[0]).toContain(rejectedFieldRemarkHeader('GST Document'));
    expect(byHeader(rows, data, rejectedFieldVerdictHeader('GST Document'))).toBe('REJECTED');
    expect(byHeader(rows, data, rejectedFieldRemarkHeader('GST Document'))).toBe('illegible');
    expect(byHeader(rows, data, rejectedFieldVerdictHeader('Payment (Bank/UPI)'))).toBe('OK');
    expect(byHeader(rows, data, rejectedFieldVerdictHeader('Owner Photo'))).toBe('PENDING');
    expect(byHeader(rows, data, 'Rejected Fields')).toBe('GST Document');
  });

  it('maps identity + KYC value columns', () => {
    const { rows } = parse(generateRejectedKycExcel([row()]));
    const data = rows[1];
    expect(byHeader(rows, data, 'Outlet ID')).toBe('OUT-1');
    expect(byHeader(rows, data, 'Rejected By')).toBe('Gifsy Admin');
    expect(byHeader(rows, data, 'Overall Rejection Reason')).toBe('GST mismatch');
    expect(byHeader(rows, data, 'GST Number')).toBe('27ABCDE1234F1ZK');
    expect(byHeader(rows, data, 'IFSC')).toBe('HDFC0001');
    expect(byHeader(rows, data, 'SLA Age (hrs)')).toBe('24');
  });

  it('neutralises formula-injection in user-supplied cells (AF-5)', () => {
    const fields = allPendingRej();
    fields.ADDRESS = { decision: 'REJECTED', remark: '=cmd|\'/c calc\'!A1' };
    const { rows } = parse(
      generateRejectedKycExcel([
        row({ outletName: '=HYPERLINK("http://evil")', ownerName: '@SUM(A1)', city: '-2', fields }),
      ]),
    );
    const data = rows[1];
    expect(byHeader(rows, data, 'Outlet Name')).toBe('\'=HYPERLINK("http://evil")');
    expect(byHeader(rows, data, 'Owner Name')).toBe('\'@SUM(A1)');
    expect(byHeader(rows, data, 'City')).toBe('\'-2');
    // The injected remark is neutralised too (per-field remarks are user-supplied).
    expect(byHeader(rows, data, rejectedFieldRemarkHeader('Address'))).toBe('\'=cmd|\'/c calc\'!A1');
  });

  it('is deterministic in content', () => {
    const a = parse(generateRejectedKycExcel([row()])).rows;
    const b = parse(generateRejectedKycExcel([row()])).rows;
    expect(a).toEqual(b);
  });
});
