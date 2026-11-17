/**
 * `kyc-review-dump` and `kyc-rejected` export kinds — PARITY with the old SheetJS generators
 * (generateKycReviewDumpExcel / generateRejectedKycExcel, copied below verbatim), paging through KycService's page
 * methods (> 2,000 rows), hyperlinks, cellSafe, scoping pass-through, heavy rules and access.
 */
import * as XLSX from 'xlsx';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { aoaToSheetSafe } from '../../../common/xlsx';
import { KycService, type KycExportCursor } from '../../../kyc/kyc.service';
import {
  KYC_DUMP_CONTEXT_HEADERS,
  KYC_DUMP_DOC_HEADERS,
  KYC_FIELD_ORDER,
  REJECTED_KYC_IDENTITY_HEADERS,
  REJECTED_KYC_VALUE_HEADERS,
  kycFieldDecisionHeader,
  kycFieldRemarkHeader,
  rejectedFieldRemarkHeader,
  rejectedFieldVerdictHeader,
  type KycReviewDumpEntry,
  type RejectedKycRow,
} from '../../../kyc/kyc-review-dump';
import { KYC_REJECTED_KIND, KYC_REVIEW_DUMP_KIND } from './kyc-dumps';
import { expectSameWorkbook, fakeModuleRef, readBack, runKindToBuffer, seeded } from './parity-testkit-spec';

// ─── The OLD generators, verbatim (kyc-review-dump.ts before 2026-11-13) ─────────────────────────────────────

function oldReviewDump(entries: KycReviewDumpEntry[]): Buffer {
  const perFieldHeaders: string[] = [];
  for (const { label } of KYC_FIELD_ORDER) {
    perFieldHeaders.push(kycFieldDecisionHeader(label));
    perFieldHeaders.push(kycFieldRemarkHeader(label));
  }
  // + the trailing "Routing" column (GIFSY-reject fast-track, 2026-11-17) — the ONLY intended layout change.
  const headerRow: string[] = [...KYC_DUMP_CONTEXT_HEADERS, ...KYC_DUMP_DOC_HEADERS, ...perFieldHeaders, 'Routing'];
  const dataRows: unknown[][] = entries.map((e) => {
    const row: unknown[] = [
      e.submissionId, e.outletCode, e.outletName, e.ownerName, e.mobile, e.outletType, e.gstNumber, e.panNumber,
      e.address, e.city, e.state, e.pincode, e.paymentMode, e.bankName ?? '', e.accountHolderName ?? '',
      e.accountNumber ?? '', e.ifscCode ?? '', e.upiId ?? '', e.boardGeo ? `${e.boardGeo.lat},${e.boardGeo.lng}` : '',
      e.nameMismatch ? 'Yes' : 'No',
      e.documents.gstCertificateUrl ? 'Open' : '', e.documents.addressDocUrl ? 'Open' : '',
      e.documents.selfDeclarationUrl ? 'Open' : '', e.documents.boardPhotoUrl ? 'Open' : '',
      e.documents.ownerPhotoUrl ? 'Open' : '', e.documents.chequeUrl ? 'Open' : '',
    ];
    for (const { key } of KYC_FIELD_ORDER) {
      const fs = e.fields[key];
      const decision = fs.decision === 'PENDING' ? '' : fs.decision === 'APPROVED' ? 'APPROVE' : 'REJECT';
      row.push(decision);
      row.push(decision === 'REJECT' ? fs.remark || 'Rejected (no remark on file)' : (fs.remark ?? ''));
    }
    row.push(e.fastTrack ? 'Direct to GIFSY (resubmitted after GIFSY rejection)' : '');
    return row;
  });
  const ws = aoaToSheetSafe([headerRow, ...dataRows]);
  const DOC_URLS: (keyof KycReviewDumpEntry['documents'])[] = [
    'gstCertificateUrl', 'addressDocUrl', 'selfDeclarationUrl', 'boardPhotoUrl', 'ownerPhotoUrl', 'chequeUrl',
  ];
  entries.forEach((e, rowIdx) => {
    DOC_URLS.forEach((docKey, colOffset) => {
      const url = e.documents[docKey];
      if (!url) return;
      const cell = ws[XLSX.utils.encode_cell({ r: rowIdx + 1, c: 20 + colOffset })];
      if (cell) cell.l = { Target: url };
    });
  });
  ws['!cols'] = headerRow.map((label) => ({ wch: Math.max(label.length + 2, 14) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'KYC Review Dump');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function oldRejected(rows: RejectedKycRow[]): Buffer {
  const verdictLabel = (d: string) => (d === 'APPROVED' ? 'OK' : d === 'REJECTED' ? 'REJECTED' : 'PENDING');
  const perFieldHeaders: string[] = [];
  for (const { label } of KYC_FIELD_ORDER) {
    perFieldHeaders.push(rejectedFieldVerdictHeader(label));
    perFieldHeaders.push(rejectedFieldRemarkHeader(label));
  }
  // + the trailing "Routing" column (GIFSY-reject fast-track, 2026-11-17) — the ONLY intended layout change.
  const headerRow: string[] = [...REJECTED_KYC_IDENTITY_HEADERS, ...perFieldHeaders, ...REJECTED_KYC_VALUE_HEADERS, 'Routing'];
  const dataRows: unknown[][] = rows.map((r) => {
    const rejectedFields = KYC_FIELD_ORDER.filter(({ key }) => r.fields[key]?.decision === 'REJECTED').map(({ label }) => label).join(', ');
    const row: unknown[] = [r.outletCode, r.outletName, r.ownerName, r.mobile, r.salesRep, r.submittedDate, r.rejectedDate, r.rejectedBy, r.rejectionReason, rejectedFields];
    for (const { key } of KYC_FIELD_ORDER) {
      const fs = r.fields[key];
      row.push(verdictLabel(fs?.decision ?? 'PENDING'));
      row.push(fs?.remark ?? '');
    }
    row.push(r.gstNumber, r.panNumber, r.address, r.city, r.state, r.pincode, r.bankName ?? '', r.accountHolderName ?? '',
      r.accountNumber ?? '', r.ifscCode ?? '', r.upiId ?? '', r.slaAgeHrs != null ? String(r.slaAgeHrs) : '',
      r.fastTrack ? 'Direct to GIFSY (resubmitted after GIFSY rejection)' : '');
    return row;
  });
  const ws = aoaToSheetSafe([headerRow, ...dataRows]);
  ws['!cols'] = headerRow.map((label) => ({ wch: Math.max(label.length + 2, 14) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Rejected Outlets');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ─── Fixtures + a paging KycService stand-in ─────────────────────────────────────────────────────────────────

function fields(rnd: () => number) {
  const f = {} as KycReviewDumpEntry['fields'];
  for (const { key } of KYC_FIELD_ORDER) {
    const d = (['PENDING', 'APPROVED', 'REJECTED'] as const)[Math.floor(rnd() * 3)];
    f[key] = { decision: d, ...(rnd() < 0.6 ? { remark: rnd() < 0.1 ? '=HYPERLINK("x")' : 'remark' } : {}) };
  }
  return f;
}

function entries(n: number): KycReviewDumpEntry[] {
  const rnd = seeded(21);
  const url = (i: number, k: string) => (rnd() < 0.5 ? `https://storage.example/${k}/${i}?sig=a%2Bb` : undefined);
  return Array.from({ length: n }, (_, i) => ({
    submissionId: `KYC-${i}`, outletCode: `OUT-${i}`, outletName: i === 1 ? '=cmd()' : `Store ${i}`, ownerName: 'Owner',
    mobile: '98201', outletType: 'SSS', gstNumber: 'G', panNumber: 'P', address: '12 Road', city: '-2', state: 'MH',
    pincode: '400058', paymentMode: 'bank', bankName: rnd() < 0.5 ? 'HDFC' : undefined, accountHolderName: undefined,
    accountNumber: '50100', ifscCode: 'HDFC0001', upiId: undefined, boardGeo: rnd() < 0.5 ? { lat: 19.1, lng: 72.8 } : undefined,
    nameMismatch: rnd() < 0.3,
    documents: { gstCertificateUrl: url(i, 'g'), addressDocUrl: url(i, 'a'), selfDeclarationUrl: url(i, 's'), boardPhotoUrl: url(i, 'b'), ownerPhotoUrl: url(i, 'o'), chequeUrl: url(i, 'c') },
    fields: fields(rnd),
    // Some GIFSY-reject fast-tracked rows exercise the trailing "Routing" label (no rnd() draw → fixtures unchanged).
    fastTrack: i % 7 === 3 ? { previousSubmissionId: `KYC-P${i}`, previousRejectedAt: new Date(0).toISOString() } : null,
  }));
}

function rejectedRows(n: number): RejectedKycRow[] {
  const rnd = seeded(33);
  return Array.from({ length: n }, (_, i) => ({
    outletCode: `OUT-${i}`, outletName: i === 2 ? '@SUM(A1)' : `Store ${i}`, ownerName: 'Owner', mobile: '9', salesRep: 'Rep',
    submittedDate: '2026-06-20', rejectedDate: rnd() < 0.9 ? '2026-06-21' : '', rejectedBy: 'Gifsy', rejectionReason: 'GST',
    slaAgeHrs: rnd() < 0.8 ? Math.floor(rnd() * 100) : undefined, fields: fields(rnd), gstNumber: 'G', panNumber: 'P',
    address: 'A', city: 'C', state: 'S', pincode: '1', bankName: rnd() < 0.5 ? 'HDFC' : undefined, accountHolderName: undefined,
    accountNumber: undefined, ifscCode: 'I', upiId: rnd() < 0.5 ? 'x@upi' : undefined,
    fastTrack: i % 5 === 1 ? { previousSubmissionId: `P${i}`, previousRejectedAt: new Date(0).toISOString() } : null,
  }));
}

/** Serves `all` in (createdAt, id) keyset pages like the real page methods; records the cursors it was given. */
function pagingKyc(allEntries: KycReviewDumpEntry[], allRows: RejectedKycRow[]) {
  const cursors: Array<KycExportCursor | null> = [];
  const users: JwtPayload[] = [];
  const page = <T,>(all: T[], after: KycExportCursor | null, take: number) => {
    const start = after ? Number(after.id) + 1 : 0;
    const slice = all.slice(start, start + take);
    const next = slice.length === take ? { createdAt: new Date(0), id: String(start + take - 1) } : null;
    return { slice, next };
  };
  return {
    cursors,
    users,
    reviewDumpPage: async (u: JwtPayload, after: KycExportCursor | null, take: number) => {
      cursors.push(after);
      users.push(u);
      const { slice, next } = page(allEntries, after, take);
      return { entries: slice, next };
    },
    rejectedExportPage: async (u: JwtPayload, after: KycExportCursor | null, take: number, holidays: Set<string>) => {
      cursors.push(after);
      users.push(u);
      expect(holidays).toBeInstanceOf(Set);
      const { slice, next } = page(allRows, after, take);
      return { rows: slice, next };
    },
  };
}

const gifsy: JwtPayload = { sub: 'g', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: '' };
// loadHolidaySet reads one programSetting row (none here → empty set).
const prisma = { programSetting: { findFirst: async () => null } };

// Thousands of rows through two full xlsx builds per test: allow for a loaded CI box.
jest.setTimeout(120_000);

describe('kyc-review-dump export kind', () => {
  it('PARITY (4,100 entries = 3 pages): headers, cells, hyperlink targets equal the old generator', async () => {
    const all = entries(4100);
    const kyc = pagingKyc(all, []);
    const res = await runKindToBuffer(KYC_REVIEW_DUMP_KIND, {}, { prisma, moduleRef: fakeModuleRef([[KycService, kyc]]), user: gifsy });
    const got = expectSameWorkbook(res.buffer, oldReviewDump(all));
    expect(res.rowCount).toBe(4100);
    expect(kyc.cursors).toEqual([null, { createdAt: new Date(0), id: '1999' }, { createdAt: new Date(0), id: '3999' }]);
    expect(kyc.users.every((u) => u === gifsy)).toBe(true); // KycService scopes with the requester (kycTenantFilter)
    expect(Object.keys(got.links['KYC Review Dump']).length).toBeGreaterThan(1000);
    expect(JSON.stringify(got.rows)).toContain("'=cmd()");
    expect(res.heavy).toBe(false);
    expect(res.fileName).toBe('kyc-review-dump.xlsx');
  });

  it('PARITY (empty queue): header row only', async () => {
    const res = await runKindToBuffer(KYC_REVIEW_DUMP_KIND, {}, { prisma, moduleRef: fakeModuleRef([[KycService, pagingKyc([], [])]]), user: gifsy });
    const got = expectSameWorkbook(res.buffer, oldReviewDump([]));
    expect(got.rows['KYC Review Dump']).toHaveLength(1);
  });
});

describe('kyc-rejected export kind', () => {
  it('PARITY (2,600 rows = 2 pages)', async () => {
    const all = rejectedRows(2600);
    const kyc = pagingKyc([], all);
    const res = await runKindToBuffer(KYC_REJECTED_KIND, {}, { prisma, moduleRef: fakeModuleRef([[KycService, kyc]]), user: gifsy });
    expectSameWorkbook(res.buffer, oldRejected(all));
    expect(kyc.cursors).toHaveLength(2);
    expect(JSON.stringify(readBack(res.buffer).rows)).toContain("'@SUM(A1)");
    expect(res.heavy).toBe(true);
    expect(res.fileName).toBe('kyc-rejected.xlsx');
  });

  it('access is Gifsy-only + kyc:read for both kinds', () => {
    expect(KYC_REJECTED_KIND.access).toEqual({ roles: ['GIFSY_ADMIN'], permission: 'kyc:read' });
    expect(KYC_REVIEW_DUMP_KIND.access).toEqual({ roles: ['GIFSY_ADMIN'], permission: 'kyc:read' });
  });
});
