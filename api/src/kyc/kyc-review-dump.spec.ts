// Unit tests for the pure KYC review-dump generator (40-column Lane A export).

import * as XLSX from 'xlsx';
import { KycFieldKey } from '@prisma/client';
import {
  generateKycReviewDumpExcel,
  KYC_DUMP_TOTAL_COLUMN_COUNT,
  KYC_FIELD_ORDER,
  kycFieldDecisionHeader,
  KycReviewDumpEntry,
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

  it('is deterministic in content', () => {
    const a = parse(generateKycReviewDumpExcel([entry()])).rows;
    const b = parse(generateKycReviewDumpExcel([entry()])).rows;
    expect(a).toEqual(b);
  });
});
