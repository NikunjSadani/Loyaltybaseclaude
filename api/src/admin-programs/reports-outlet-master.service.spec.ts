// Unit tests for ReportsService.outletMaster — the 56-column Outlet Master export.
// Run: npx jest src/admin-programs/reports-outlet-master.service.spec.ts
//
// Asserts: the 56 header strings in exact order; the hierarchy-rung mapping by
// hierarchyLevel.code (a skipped level leaves blanks, not a shift); Profile Status
// Active/Deactivated; and that a doc cell carries a /api/kyc/documents/view link.

import { Test, TestingModule } from '@nestjs/testing';
import { StreamableFile } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { ReportsService } from './reports.service';
import { PrismaService } from '../prisma/prisma.service';
import { KycService } from '../kyc/kyc.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const admin: JwtPayload = { sub: 'a1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };

const EXPECTED_HEADERS = [
  'Zone', 'Outlet Code', 'Outlet Name', 'Outlet Type', 'Program Name', 'Program Category',
  'Distributor Code', 'Distributor Name', 'Metro', 'Beat',
  'XSR ID', 'XSR Name', 'XSR Phone Number',
  'SO ID', 'SO Name', 'SO Phone Number',
  'ASM ID', 'ASM Name', 'ASM Phone Number',
  'RSM ID', 'RSM Name', 'RSM Phone Number',
  'ZNM ID', 'ZNM Name', 'ZNM Phone Number',
  'NSM ID', 'NSM Name', 'NSM Phone Number',
  'Owner Name', 'Phone Number', 'Address', 'City', 'State', 'Pincode',
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

describe('ReportsService.outletMaster (56 columns)', () => {
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

  it('emits exactly the 56 headers in order even when there are no outlets', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.salesUserAssignment.findMany.mockResolvedValue([]);
    mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
    mockPrisma.salesUser.findMany.mockResolvedValue([]);

    const file = await service.outletMaster(admin);
    const aoa = await readSheet(file);
    expect(aoa[0]).toEqual(EXPECTED_HEADERS);
    expect(aoa[0]).toHaveLength(56);
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
        phone: '8000000000', isActive: true, deactivatedAt: null,
        partner: { ownerName: 'Owner One', phone: '7000000000', gstNumber: 'GST123', panNumber: 'PAN123' },
      },
      {
        id: 'o2', partnerId: null, zone: null, outletCode: 'OUT002', name: 'Shop Two',
        outletType: null, programName: null, programCategory: null,
        distributorCode: null, distributorName: null, metro: null, beat: null,
        addressLine1: null, addressLine2: null, city: 'Pune', state: 'MH', pincode: null,
        phone: null, isActive: false, deactivatedAt: new Date('2026-06-01T00:00:00Z'),
        partner: null,
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

    // Profile status.
    expect(r1[idx('Profile Status')]).toBe('Active');
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

    // Doc links point at the FE /api proxy and carry the signed token.
    expect(String(r1[idx('GST Certificate')])).toBe('https://app.example.com/api/kyc/documents/view?token=TOK_docGST');
    expect(String(r1[idx('Address Proof')])).toContain('/api/kyc/documents/view?token=');
    expect(String(r1[idx('Self-Declaration')])).toContain('/api/kyc/documents/view?token=');

    // o2 has no partner/assignment/submission → those cells blank.
    expect(r2[idx('XSR ID')]).toBe('');
    expect(r2[idx('GST Certificate')]).toBe('');
    expect(r2[idx('Deactivated At')]).toBe('2026-06-01');
  });
});
