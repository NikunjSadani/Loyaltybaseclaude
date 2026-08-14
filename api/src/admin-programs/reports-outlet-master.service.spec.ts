// Unit tests for ReportsService.outletMaster — the 57-column Outlet Master export.
// Run: npx jest src/admin-programs/reports-outlet-master.service.spec.ts
//
// Asserts: the 57 header strings in exact order (leading columns mirror the upload
// template's order); the hierarchy-rung mapping by hierarchyLevel.code (a skipped level
// leaves blanks, not a shift); the derived Profile Status (real lifecycle stage); and that
// a doc cell carries a /v1/kyc/documents/view link.

import { Test, TestingModule } from '@nestjs/testing';
import { StreamableFile } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { ReportsService } from './reports.service';
import { PrismaService } from '../prisma/prisma.service';
import { KycService } from '../kyc/kyc.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const admin: JwtPayload = { sub: 'a1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };

// Leading columns mirror the outlet upload template's order (OUTLET_UPLOAD_HEADERS);
// the hierarchy block + master-only columns follow.
const EXPECTED_HEADERS = [
  'Outlet Code', 'Outlet Name', 'Program Name', 'Program Category', 'Outlet Type',
  'Beat', 'Distributor Code', 'Distributor Name', 'Metro', 'City', 'State', 'Zone',
  'XSR ID', 'XSR Name', 'XSR Phone Number',
  'SO ID', 'SO Name', 'SO Phone Number',
  'ASM ID', 'ASM Name', 'ASM Phone Number',
  'RSM ID', 'RSM Name', 'RSM Phone Number',
  'ZNM ID', 'ZNM Name', 'ZNM Phone Number',
  'NSM ID', 'NSM Name', 'NSM Phone Number',
  'Parent ID',
  'Owner Name', 'Phone Number', 'Address', 'Pincode',
  'Latitude of Outlet Board', 'Longitude of Outlet Board',
  'Enrollment by Employee ID', 'Enrollment by Employee Name', 'Enrollment by Employee Phone Number',
  'Enrollment Date', 'Enrollment Status', 'Profile Status',
  'Approval by Employee ID', 'Approval by Employee Name', 'Approval by Employee Phone Number',
  'Approval by Gifsy', 'Approval Date of Gifsy',
  'Latitude of Bank Details Collection', 'Longitude of Bank Details Collection',
  'Remarks', 'GST', 'PAN', 'GST Certificate', 'Address Proof', 'Self-Declaration', 'Deactivated At',
];

/** A Decimal-like stub: toString() → the given value (mirrors Prisma.Decimal). */
const dec = (v: string) => ({ toString: () => v }) as never;

const mockPrisma = {
  outlet: { findMany: jest.fn() },
  salesUserAssignment: { findMany: jest.fn() },
  kycSubmission: { findMany: jest.fn() },
  salesUser: { findMany: jest.fn() },
};

const mockKyc = {
  signDocViewToken: jest.fn((docId: string) => `TOK_${docId}`),
};

/** Read sheet 0 back as an array-of-arrays so we can inspect headers + cells. */
async function readSheet(file: StreamableFile): Promise<unknown[][]> {
  const buffer: Buffer = await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = file.getStream();
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][];
}

describe('ReportsService.outletMaster (57 columns)', () => {
  let service: ReportsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: KycService, useValue: mockKyc },
      ],
    }).compile();
    service = module.get(ReportsService);
  });

  it('emits exactly the 57 headers in order even when there are no outlets', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.salesUserAssignment.findMany.mockResolvedValue([]);
    mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
    mockPrisma.salesUser.findMany.mockResolvedValue([]);

    const file = await service.outletMaster(admin);
    const aoa = await readSheet(file);
    expect(aoa[0]).toEqual(EXPECTED_HEADERS);
    expect(aoa[0]).toHaveLength(57);
  });

  it('maps rungs by hierarchyLevel.code (a skipped level leaves its cells blank, not shifted) and sets doc links + status', async () => {
    // Chain: XSR → (SO skipped) → ASM → RSM. ZNM/NSM absent.
    const rsm = {
      employeeCode: 'E-RSM', hierarchyLevel: { code: 'RSM' },
      user: { name: 'Rsm Name', phone: '9000000004' }, reportingTo: null,
    };
    const asm = {
      employeeCode: 'E-ASM', hierarchyLevel: { code: 'ASM' },
      user: { name: 'Asm Name', phone: '9000000003' }, reportingTo: rsm,
    };
    const xsr = {
      employeeCode: 'E-XSR', hierarchyLevel: { code: 'XSR' },
      user: { name: 'Xsr Name', phone: '9000000001' }, reportingTo: asm,
    };

    mockPrisma.outlet.findMany.mockResolvedValue([
      {
        id: 'o1', partnerId: 'p1', zone: 'North', outletCode: 'OUT001', name: 'Shop One',
        outletType: { name: 'SSS' }, programName: 'Prog', programCategory: 'Cat',
        distributorCode: 'D1', distributorName: 'Dist One', metro: 'Metro', beat: 'Beat-7',
        addressLine1: 'A1', addressLine2: 'A2', city: 'Pune', state: 'MH', pincode: '411001',
        phone: '8000000000', isActive: true, deactivatedAt: null, kycIntent: null, reKycFlags: null,
        partner: { ownerName: 'Owner One', phone: '7000000000', gstNumber: 'GST123', panNumber: 'PAN123' },
        parent: { partnerCode: 'CPP01' },
      },
      {
        id: 'o2', partnerId: null, zone: null, outletCode: 'OUT002', name: 'Shop Two',
        outletType: null, programName: null, programCategory: null,
        distributorCode: null, distributorName: null, metro: null, beat: null,
        addressLine1: null, addressLine2: null, city: 'Pune', state: 'MH', pincode: null,
        phone: null, isActive: false, deactivatedAt: new Date('2026-06-01T00:00:00Z'),
        kycIntent: null, reKycFlags: null,
        partner: null,
        parent: null,
      },
    ]);

    mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
      { outletId: 'o1', assignedAt: new Date(), salesUser: xsr },
    ]);

    mockPrisma.kycSubmission.findMany.mockResolvedValue([
      {
        id: 's1', partnerId: 'p1', status: 'APPROVED',
        submittedAt: new Date('2026-05-10T00:00:00Z'), createdAt: new Date('2026-05-09T00:00:00Z'),
        approvedAt: new Date('2026-05-20T00:00:00Z'),
        rejectionReason: null, reviewerNotes: 'looks good',
        boardPhotoLat: dec('18.52000000'), boardPhotoLng: dec('73.85000000'),
        paymentLat: dec('18.53000000'), paymentLng: dec('73.86000000'),
        user: { id: 'enrUser', name: 'Enroller', phone: '6000000000' },
        documents: [
          { id: 'docGST', documentType: 'GST_CERTIFICATE', createdAt: new Date() },
          { id: 'docADDR', documentType: 'SHOP_ESTABLISHMENT', createdAt: new Date() },
          { id: 'docSELF', documentType: 'SELF_DECLARATION', createdAt: new Date() },
        ],
        statusHistory: [
          { toStatus: 'PENDING_GIFSY', changedByUserId: 'apprUser', createdAt: new Date('2026-05-15T00:00:00Z'), metadata: { stage: 'FIRST_APPROVER' } },
          { toStatus: 'APPROVED', changedByUserId: 'gifsyUser', createdAt: new Date('2026-05-20T00:00:00Z'), metadata: { stage: 'GIFSY' } },
        ],
      },
    ]);

    // enroller + approver SalesUser lookups by userId.
    mockPrisma.salesUser.findMany.mockResolvedValue([
      { userId: 'enrUser', employeeCode: 'EMP-ENR', user: { name: 'Enroller', phone: '6000000000' } },
      { userId: 'apprUser', employeeCode: 'EMP-APP', user: { name: 'Approver', phone: '5000000000' } },
    ]);

    const req = { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.example.com' } } as never;
    const file = await service.outletMaster(admin, req);
    const aoa = await readSheet(file);
    const headers = aoa[0] as string[];
    const idx = (h: string) => headers.indexOf(h);
    const r1 = aoa[1] as unknown[]; // outlet o1
    const r2 = aoa[2] as unknown[]; // outlet o2 (no partner/assignment)

    expect(headers).toEqual(EXPECTED_HEADERS);

    // Rung mapping by code: XSR/ASM/RSM filled, SO + ZNM + NSM blank (skipped, not shifted).
    expect(r1[idx('XSR ID')]).toBe('E-XSR');
    expect(r1[idx('ASM ID')]).toBe('E-ASM');
    expect(r1[idx('RSM ID')]).toBe('E-RSM');
    expect(r1[idx('SO ID')]).toBe('');   // skipped level → blank
    expect(r1[idx('ZNM ID')]).toBe('');
    expect(r1[idx('NSM ID')]).toBe('');
    expect(r1[idx('RSM Name')]).toBe('Rsm Name');

    // Parent ID = the owner-group parent's partnerCode (round-trips through the upload).
    expect(r1[idx('Parent ID')]).toBe('CPP01');
    expect(r2[idx('Parent ID')]).toBe(''); // no parent group

    // Profile status — o1's latest submission is APPROVED (was a bare "Active"); o2 is
    // genuinely deactivated (deactivatedAt set), NOT merely never-approved.
    expect(r1[idx('Profile Status')]).toBe('Approved');
    expect(r2[idx('Profile Status')]).toBe('Deactivated');

    // Enrollment + approval employee resolution.
    expect(r1[idx('Enrollment by Employee ID')]).toBe('EMP-ENR');
    expect(r1[idx('Enrollment by Employee Name')]).toBe('Enroller');
    expect(r1[idx('Approval by Employee ID')]).toBe('EMP-APP');
    expect(r1[idx('Approval by Employee Name')]).toBe('Approver');

    // Gifsy approval.
    expect(r1[idx('Approval by Gifsy')]).toBe('Yes');
    expect(r1[idx('Approval Date of Gifsy')]).toBe('2026-05-20');

    // Address join + geo.
    expect(r1[idx('Address')]).toBe('A1, A2');
    expect(r1[idx('Latitude of Outlet Board')]).toBe('18.52000000');
    expect(r1[idx('Latitude of Bank Details Collection')]).toBe('18.53000000');

    // Remarks (no rejectionReason → reviewerNotes).
    expect(r1[idx('Remarks')]).toBe('looks good');

    // Doc links point DIRECTLY at the backend /v1 @Public route and carry the signed token.
    expect(String(r1[idx('GST Certificate')])).toBe('https://app.example.com/v1/kyc/documents/view?token=TOK_docGST');
    expect(String(r1[idx('Address Proof')])).toContain('/v1/kyc/documents/view?token=');
    expect(String(r1[idx('Self-Declaration')])).toContain('/v1/kyc/documents/view?token=');

    // o2 has no partner/assignment/submission → those cells blank.
    expect(r2[idx('XSR ID')]).toBe('');
    expect(r2[idx('GST Certificate')]).toBe('');
    expect(r2[idx('Deactivated At')]).toBe('2026-06-01');
  });

  it('derives Profile Status from lifecycle stage (deactivated/parked/re-KYC/approval-level), not a bare active flag', async () => {
    // Each outlet carries a distinct partner; each partner has ONE submission with the
    // named status (except the two intent-only / no-submission cases). We then assert the
    // derived Profile Status per row. Precedence: deactivatedAt > kycIntent > re-KYC > status.
    type Case = {
      code: string;
      deactivatedAt?: Date | null;
      kycIntent?: string | null;
      reKycFlags?: unknown;
      status?: string | null; // undefined = no submission
      expected: string;
    };
    const cases: Case[] = [
      // deactivatedAt wins even over an APPROVED submission (was active, then turned off).
      { code: 'C_DEACT', deactivatedAt: new Date('2026-06-01T00:00:00Z'), status: 'APPROVED', expected: 'Deactivated' },
      { code: 'C_PARK',  kycIntent: 'PARKED',         status: 'PENDING_SO_APPROVAL', expected: 'Parked' },
      { code: 'C_NI',    kycIntent: 'NOT_INTERESTED', status: null,                  expected: 'Not Interested' },
      // re-KYC flagged AND not under review → Re-KYC Required; flagged but a fresh
      // submission is in-flight → the in-flight stage shows through (not Re-KYC Required).
      { code: 'C_REKYC',    reKycFlags: { gstNumber: true }, status: 'APPROVED',            expected: 'Re-KYC Required' },
      { code: 'C_REKYC_IF', reKycFlags: { gstNumber: true }, status: 'PENDING_ASM_APPROVAL', expected: 'Awaiting ASM Approval' },
      { code: 'C_SO',    status: 'PENDING_SO_APPROVAL',  expected: 'Awaiting SO Approval' },
      { code: 'C_SUB',   status: 'SUBMITTED',            expected: 'Awaiting SO Approval' },
      { code: 'C_ASM',   status: 'PENDING_ASM_APPROVAL', expected: 'Awaiting ASM Approval' },
      { code: 'C_RSM',   status: 'PENDING_RSM_APPROVAL', expected: 'Awaiting RSM Approval' },
      { code: 'C_GIFSY', status: 'PENDING_GIFSY',        expected: 'Awaiting Gifsy Approval' },
      { code: 'C_APPR',  status: 'APPROVED',             expected: 'Approved' },
      { code: 'C_REJ',   status: 'REJECTED',             expected: 'Rejected' },
      { code: 'C_RESUB', status: 'RESUBMISSION_REQUIRED', expected: 'Resubmission Required' },
      { code: 'C_NONE',  status: null,                   expected: 'KYC Pending' },
    ];

    mockPrisma.outlet.findMany.mockResolvedValue(
      cases.map((c, i) => ({
        id: `id_${i}`, partnerId: c.status != null ? `pt_${i}` : null,
        zone: 'Z', outletCode: c.code, name: c.code, outletType: null,
        programName: null, programCategory: null, distributorCode: null, distributorName: null,
        metro: null, beat: null, addressLine1: null, addressLine2: null, city: null, state: null,
        pincode: null, phone: null,
        isActive: c.deactivatedAt ? false : true,
        deactivatedAt: c.deactivatedAt ?? null,
        kycIntent: c.kycIntent ?? null,
        reKycFlags: c.reKycFlags ?? null,
        partner: null, parent: null,
      })),
    );
    mockPrisma.salesUserAssignment.findMany.mockResolvedValue([]);
    mockPrisma.salesUser.findMany.mockResolvedValue([]);
    mockPrisma.kycSubmission.findMany.mockResolvedValue(
      cases
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.status != null)
        .map(({ c, i }) => ({
          id: `s_${i}`, partnerId: `pt_${i}`, status: c.status,
          submittedAt: new Date('2026-05-01T00:00:00Z'), createdAt: new Date('2026-05-01T00:00:00Z'),
          approvedAt: null, rejectionReason: null, reviewerNotes: null,
          boardPhotoLat: null, boardPhotoLng: null, paymentLat: null, paymentLng: null,
          user: null, documents: [], statusHistory: [],
        })),
    );

    const file = await service.outletMaster(admin);
    const aoa = await readSheet(file);
    const headers = aoa[0] as string[];
    const codeCol = headers.indexOf('Outlet Code');
    const psCol = headers.indexOf('Profile Status');
    const byCode = new Map<string, string>();
    for (let r = 1; r < aoa.length; r++) byCode.set(String(aoa[r][codeCol]), String(aoa[r][psCol]));

    for (const c of cases) {
      expect(`${c.code}=${byCode.get(c.code)}`).toBe(`${c.code}=${c.expected}`);
    }
  });
});
