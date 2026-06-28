// Unit tests for KycService — ported from platform/src/app/api/kyc/*.
// Covers tenant scoping, the multi-level approval transitions, and role gates.
// Run: npx jest src/kyc/kyc.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { KycService } from './kyc.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { StorageService } from '../storage/storage.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { KYC_FIELD_KEYS } from './kyc-verification.helper';
import {
  canFirstApprove,
  nextStatusAfterFirstApprove,
} from './kyc-approval.helper';

// ─── Shared transaction mock ──────────────────────────────────────────────────
// Includes all table operations needed by the new approve(), verifyField(),
// and the shared applyBridgeOutcome() helper.
const mockTx = {
  kycSubmission: { update: jest.fn(), findFirst: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  kycVerificationItem: {
    upsert: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
    createMany: jest.fn(),
  },
  kycStatusHistory: { create: jest.fn() },
  auditLog: { create: jest.fn() },
  user: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  channelPartner: { update: jest.fn(), create: jest.fn() },
  wallet: { findFirst: jest.fn(), create: jest.fn() },
  outlet: { update: jest.fn(), updateMany: jest.fn() },
};

const mockPrisma = {
  channelPartner: { findFirst: jest.fn(), update: jest.fn() },
  // rejectedExport resolves the rejecter's display name in one round-trip.
  user: { findMany: jest.fn() },
  kycSubmission: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
  },
  kycStatusHistory: { create: jest.fn(), findMany: jest.fn() },
  kycDocument: { create: jest.fn(), findUnique: jest.fn() },
  otpCode: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
  outlet: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  salesUser: { findFirst: jest.fn(), findMany: jest.fn() },
  // assertCanViewSubmission's reassignment-aware allow-path looks up the outlet's
  // CURRENT active assignment (unassignedAt null) to a salesUser in the caller's subtree.
  salesUserAssignment: { findFirst: jest.fn() },
  consentRecord: { create: jest.fn() },
  kycVerificationItem: { upsert: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

const mockNotifications = { enqueue: jest.fn().mockResolvedValue({ id: 'n1' }) };

const mockMsg91 = { sendOtp: jest.fn().mockResolvedValue(undefined) };

const mockStorage = {
  generateKey: jest.fn((folder: string, name: string) => `${folder}/2026-06/uuid-${name}`),
  uploadFile: jest.fn().mockResolvedValue('https://storage.googleapis.com/bucket/key'),
  getSignedUrl: jest.fn(),
  downloadAsDataUrl: jest.fn(),
  downloadBytes: jest.fn(),
  publicUrl: jest.fn((k: string) => `https://storage.googleapis.com/bucket/${k}`),
  deleteFile: jest.fn(),
};

const mockJwt = {
  sign: jest.fn(() => 'signed.jwt.token'),
  verify: jest.fn(),
};
const mockConfig = { get: jest.fn(() => 'test-secret') };

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const so: JwtPayload = { sub: 'so1', role: 'SALES_SO', clientId: 'deoleo', phone: '', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' };
// A real channel-partner role (one of SSS / WHOLESALER / SUB_STOCKIST) — used to
// prove the intra-tenant read-leak fix (a partner may only read their own KYC).
const sss: JwtPayload = { sub: 'sss1', role: 'SSS', clientId: 'deoleo', phone: '', name: '' };
// Tenant-side read-only observer (Q5) — must keep tenant-wide KYC read after the
// sales-subtree scoping change (it is NOT a sales user, so it must not collapse to "own only").
const mis: JwtPayload = { sub: 'mis1', role: 'MIS_USER', clientId: 'deoleo', phone: '', name: '' };

/** All-7-APPROVED items for the bridge */
const ALL_APPROVED = KYC_FIELD_KEYS.map((k) => ({ fieldKey: k, decision: 'APPROVED' as const }));

/**
 * Prime the salesUser mocks used by the hierarchy-scoping helpers
 * (resolveSalesScope / assertCanViewSubmission / assertRoutedApprover).
 * `nodes` are SalesUser rows, each linked to a User via `userId`. findFirst resolves
 * a row by its where.userId; findMany returns the whole node set. isActive defaults true.
 */
function primeSalesNodes(
  nodes: { id: string; reportingToId: string | null; userId: string; isActive?: boolean }[],
): void {
  mockPrisma.salesUser.findFirst.mockImplementation((args: { where?: { userId?: string } }) => {
    const uid = args?.where?.userId;
    const n = nodes.find((x) => x.userId === uid);
    return Promise.resolve(n ? { id: n.id } : null);
  });
  mockPrisma.salesUser.findMany.mockResolvedValue(
    nodes.map((n) => ({
      id: n.id,
      reportingToId: n.reportingToId,
      userId: n.userId,
      isActive: n.isActive ?? true,
    })),
  );
}

describe('KycService', () => {
  let service: KycService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // clearAllMocks does not drain mockResolvedValueOnce queues nor clear a
    // mockResolvedValue impl; reset the mocks that create() now also touches so
    // stale values from prior suites (sendConsentOtp etc.) don't bleed.
    // create() order on mockPrisma: outlet.findFirst → channelPartner.findFirst
    // (assertPhoneAvailable partner-clash) → salesUser.findFirst (assertPhoneAvailable
    // employee-clash, nested where.user) → salesUser.findFirst (resolveInitialRouting).
    mockPrisma.salesUser.findFirst.mockReset();
    mockPrisma.channelPartner.findFirst.mockReset();
    mockPrisma.outlet.findFirst.mockReset();
    // The shared mockTx is a module-level singleton. clearAllMocks() clears its
    // call records but does NOT drain mockResolvedValueOnce queues — so a test that
    // throws before consuming all its primed Once-values leaks residue into the next
    // test's tx (the "passes in isolation, fails in-suite" symptom). Fully reset every
    // mockTx op so each test starts with empty queues.
    for (const table of Object.values(mockTx)) {
      for (const fn of Object.values(table)) {
        (fn as jest.Mock).mockReset();
      }
    }
    // Same hazard on mockPrisma table ops (kycSubmission.findFirst etc. are primed
    // with mockResolvedValueOnce across approve/verifyField/reKyc/consent suites).
    // Reset every table op but PRESERVE $transaction's impl (cb → mockTx).
    for (const [key, val] of Object.entries(mockPrisma)) {
      if (key === '$transaction') continue;
      for (const fn of Object.values(val as Record<string, unknown>)) {
        (fn as jest.Mock).mockReset();
      }
    }
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: Msg91Service, useValue: mockMsg91 },
        { provide: StorageService, useValue: mockStorage },
        { provide: JwtService, useValue: mockJwt },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get(KycService);
  });

  describe('uploadDocument (GCS)', () => {
    // A minimal but VALID JPEG signature (FF D8 FF ...) so the magic-bytes guard passes.
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const file = (size: number, buffer: Buffer = JPEG): Express.Multer.File =>
      ({ buffer, originalname: 'pan.jpg', mimetype: 'image/jpeg', size }) as Express.Multer.File;

    it('uploads under a tenant folder and returns the object reference', async () => {
      const res = await service.uploadDocument(so, file(1024), { documentType: 'PAN_CARD' });
      expect(mockStorage.generateKey).toHaveBeenCalledWith('kyc/deoleo', 'pan.jpg');
      expect(mockStorage.uploadFile).toHaveBeenCalledTimes(1);
      expect(res).toMatchObject({
        documentType: 'PAN_CARD',
        fileKey: expect.any(String),
        fileUrl: 'https://storage.googleapis.com/bucket/key',
        fileSizeBytes: 1024,
      });
    });

    it('rejects when no file is provided', async () => {
      await expect(
        service.uploadDocument(so, undefined as unknown as Express.Multer.File, { documentType: 'PAN_CARD' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    });

    it('rejects a file over 5 MB without uploading', async () => {
      await expect(
        service.uploadDocument(so, file(6 * 1024 * 1024), { documentType: 'PAN_CARD' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    });

    it('AF-10: rejects a spoofed file (HTML payload labelled image/jpeg) without uploading', async () => {
      const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');
      await expect(
        service.uploadDocument(so, file(html.length, html), { documentType: 'PAN_CARD' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    });

    it('AF-10: stores the SNIFFED mimetype, not the client-supplied one', async () => {
      // Client claims image/png but the bytes are a PDF → stored mime must be the real type.
      const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
      const spoof = ({ buffer: pdf, originalname: 'doc', mimetype: 'image/png', size: pdf.length }) as Express.Multer.File;
      const res = await service.uploadDocument(so, spoof, { documentType: 'PAN_CARD' });
      expect(res.mimeType).toBe('application/pdf');
      // uploadFile is handed the sniffed mime, never the client's.
      expect(mockStorage.uploadFile).toHaveBeenCalledWith(pdf, expect.any(String), 'application/pdf');
    });
  });

  describe('create() document references (tenant safety)', () => {
    const baseDto = {
      outletId: 'outlet-1',
      partnerName: 'Kumar Store',
      mobile: '9820100001',
      address: '12 SV Road',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400058',
    };

    const primeCreateMocks = () => {
      // Outlet-driven create(): resolve a partner-less outlet, then find-or-create
      // the owner + partner inside the tx.
      mockPrisma.outlet.findFirst.mockResolvedValueOnce({
        id: 'outlet-1',
        clientId: 'deoleo',
        partnerId: null,
        outletCode: 'OUT-1',
        outletType: { code: 'SSS' },
      });
      // assertPhoneAvailable: partner-clash null + employee-clash null → phone available.
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null);
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);
      // resolveInitialRouting: no SalesUser → SUBMITTED (simplest case for doc tests)
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);
      mockTx.user.findFirst.mockResolvedValueOnce(null); // no existing owner user
      mockTx.user.create.mockResolvedValueOnce({ id: 'owner-1' });
      mockTx.channelPartner.create.mockResolvedValueOnce({ id: 'cp-1' });
      mockTx.outlet.update.mockResolvedValueOnce({});
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null); // no in-flight dup
      mockTx.kycSubmission.create.mockResolvedValueOnce({ id: 'sub-1' });
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
      mockPrisma.kycDocument.create.mockResolvedValue({});
    };

    it('rejects a document fileKey belonging to another tenant', async () => {
      primeCreateMocks();
      await expect(
        service.create(so, {
          ...baseDto,
          documents: [{ type: 'GST_CERTIFICATE', fileKey: 'kyc/OTHER-TENANT/2026-06/uuid.pdf' }],
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.kycDocument.create).not.toHaveBeenCalled();
    });

    it('accepts an own-tenant fileKey and stores the server-reconstructed URL', async () => {
      primeCreateMocks();
      const res = await service.create(so, {
        ...baseDto,
        documents: [{ type: 'GST_CERTIFICATE', fileKey: 'kyc/deoleo/2026-06/uuid.pdf' }],
      } as never);
      expect(res).toMatchObject({ submissionId: 'sub-1' });
      expect(mockStorage.publicUrl).toHaveBeenCalledWith('kyc/deoleo/2026-06/uuid.pdf');
      expect(mockPrisma.kycDocument.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            fileKey: 'kyc/deoleo/2026-06/uuid.pdf',
            fileUrl: 'https://storage.googleapis.com/bucket/kyc/deoleo/2026-06/uuid.pdf',
          }),
        }),
      );
    });

    it('normalises a blank gstNumber to undefined — no empty-string @@unique([clientId, gstNumber]) collision', async () => {
      primeCreateMocks();
      await service.create(so, {
        ...baseDto,
        gstNumber: '   ', // whitespace-only → must be treated as "no GST"
        documents: [{ type: 'GST_CERTIFICATE', fileKey: 'kyc/deoleo/2026-06/uuid.pdf' }],
      } as never);
      // partnerDetails.gstNumber must be undefined (→ stored NULL), never '' (which
      // would make a SECOND no-GST outlet collide on the unique index → P2002).
      expect(mockTx.channelPartner.create.mock.calls[0][0].data.gstNumber).toBeUndefined();
    });
  });

  describe('reviewDump (Lane A export)', () => {
    it('rejects a non-Gifsy caller', async () => {
      await expect(service.reviewDump(so)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('queries PENDING_GIFSY cross-tenant (Gifsy, #38) and returns an xlsx buffer', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([
        {
          id: 'KYC-1',
          boardPhotoLat: 19.1,
          boardPhotoLng: 72.8,
          user: { name: 'A', phone: '9820100001' },
          partner: {
            businessName: 'Kumar Store',
            ownerName: 'Suresh',
            phone: '9820100001',
            gstNumber: 'G',
            panNumber: 'P',
            bankName: 'HDFC',
            bankAccountNumber: '50100',
            bankAccountHolder: 'Ramesh', // differs from owner → nameMismatch
            ifscCode: 'HDFC0001',
            upiId: null,
            paymentMode: 'bank',
            outlets: [
              {
                outletCode: 'OUT-1',
                name: 'Kumar Store',
                addressLine1: '12 SV Road',
                addressLine2: null,
                city: 'Mumbai',
                state: 'Maharashtra',
                pincode: '400058',
                programName: 'Gold',
                outletType: { name: 'SSS' },
              },
            ],
          },
          documents: [
            {
              documentType: 'GST_CERTIFICATE',
              fileUrl: 'https://storage.googleapis.com/bucket/key',
              fileKey: 'key',
              fileName: 'gst.pdf',
            },
          ],
          verificationItems: [
            { fieldKey: 'PAYMENT', decision: 'APPROVED', remark: null, source: 'EXCEL' },
          ],
        },
      ]);
      mockStorage.getSignedUrl.mockResolvedValueOnce('https://signed/gst');

      const buf = await service.reviewDump(gifsy);

      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(0);
      const where = mockPrisma.kycSubmission.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('PENDING_GIFSY');
      expect(where.user).toBeUndefined(); // GIFSY is cross-tenant (#38) — no caller-tenant filter
      expect(mockStorage.getSignedUrl).toHaveBeenCalledWith('key');
    });
  });

  describe('rejectedExport (Rejected outlets export)', () => {
    const rejectedSub = () => ({
      id: 'KYC-R1',
      createdAt: new Date('2026-06-20T00:00:00Z'),
      submittedAt: new Date('2026-06-20T00:00:00Z'),
      reviewedAt: new Date('2026-06-21T00:00:00Z'),
      rejectionReason: 'GST mismatch',
      user: { name: 'Rep A', phone: '9820100001' },
      partner: {
        businessName: 'Kumar Store',
        ownerName: 'Suresh',
        phone: '9820100001',
        gstNumber: '27ABCDE1234F1ZK',
        panNumber: 'ABCDE1234F',
        bankName: 'HDFC',
        bankAccountNumber: '50100',
        bankAccountHolder: 'Suresh',
        ifscCode: 'HDFC0001',
        upiId: null,
        paymentMode: 'bank',
        outlets: [
          {
            outletCode: 'OUT-1',
            name: 'Kumar Store',
            addressLine1: '12 SV Road',
            addressLine2: null,
            city: 'Mumbai',
            state: 'Maharashtra',
            pincode: '400058',
            programName: 'Gold',
            outletType: { name: 'SSS' },
          },
        ],
      },
      verificationItems: [
        { fieldKey: 'GST_DOCUMENT', decision: 'REJECTED', remark: 'illegible', source: 'PORTAL' },
        { fieldKey: 'PAYMENT', decision: 'APPROVED', remark: null, source: 'PORTAL' },
      ],
      statusHistory: [{ createdAt: new Date('2026-06-21T00:00:00Z'), changedByUserId: 'admin1' }],
    });

    const parseSheet = (buf: Buffer) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const XLSX = require('xlsx');
      const wb = XLSX.read(buf, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      return XLSX.utils.sheet_to_json(ws, { defval: '', raw: false, header: 1 }) as string[][];
    };

    it('rejects a non-Gifsy caller', async () => {
      await expect(service.rejectedExport(so)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('queries status:REJECTED cross-tenant (Gifsy) and returns an xlsx buffer', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([rejectedSub()]);
      mockPrisma.user.findMany.mockResolvedValueOnce([{ id: 'admin1', name: 'Gifsy Admin' }]);

      const buf = await service.rejectedExport(gifsy);

      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(0);
      const where = mockPrisma.kycSubmission.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('REJECTED');
      expect(where.user).toBeUndefined(); // GIFSY is cross-tenant — no caller-tenant filter
    });

    it('scopes the rejected-date source to the REJECTED status-history transition', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([]);
      await service.rejectedExport(gifsy);
      const args = mockPrisma.kycSubmission.findMany.mock.calls[0][0];
      expect(args.include.statusHistory.where).toMatchObject({ toStatus: 'REJECTED' });
      expect(args.include.statusHistory.orderBy).toMatchObject({ createdAt: 'desc' });
      // No actor lookup when there are no submissions (avoids an empty IN query).
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    });

    it('surfaces a REJECTED field in the per-field verdict + remark and maps identity/KYC values', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([rejectedSub()]);
      mockPrisma.user.findMany.mockResolvedValueOnce([{ id: 'admin1', name: 'Gifsy Admin' }]);

      const rows = parseSheet(await service.rejectedExport(gifsy));
      const header = rows[0];
      const data = rows[1];

      // Identity / outcome
      expect(data[header.indexOf('Outlet ID')]).toBe('OUT-1');
      expect(data[header.indexOf('Owner Name')]).toBe('Suresh');
      expect(data[header.indexOf('Sales Rep')]).toBe('Rep A');
      expect(data[header.indexOf('Rejected By')]).toBe('Gifsy Admin');
      expect(data[header.indexOf('Overall Rejection Reason')]).toBe('GST mismatch');
      // Rejected-fields summary lists the GST Document label.
      expect(data[header.indexOf('Rejected Fields')]).toContain('GST Document');

      // Per-field verdict + remark for the rejected field.
      expect(data[header.indexOf('GST Document — Verdict')]).toBe('REJECTED');
      expect(data[header.indexOf('GST Document — Remark')]).toBe('illegible');
      // An approved field reads OK; an untouched one reads PENDING.
      expect(data[header.indexOf('Payment (Bank/UPI) — Verdict')]).toBe('OK');
      expect(data[header.indexOf('Owner Photo — Verdict')]).toBe('PENDING');

      // KYC values
      expect(data[header.indexOf('GST Number')]).toBe('27ABCDE1234F1ZK');
      expect(data[header.indexOf('PAN')]).toBe('ABCDE1234F');
      expect(data[header.indexOf('Address')]).toBe('12 SV Road');
      expect(data[header.indexOf('IFSC')]).toBe('HDFC0001');
      // SLA age = 24h (submitted → rejected, one day apart).
      expect(data[header.indexOf('SLA Age (hrs)')]).toBe('24');
    });
  });

  describe('approval routing helpers (pure)', () => {
    it('canFirstApprove matches role to its pending status only', () => {
      expect(canFirstApprove('SALES_SO', 'PENDING_SO_APPROVAL')).toBe(true);
      expect(canFirstApprove('SALES_ASM', 'PENDING_ASM_APPROVAL')).toBe(true);
      expect(canFirstApprove('SALES_STATE_HEAD', 'PENDING_RSM_APPROVAL')).toBe(true);
      expect(canFirstApprove('SALES_SO', 'PENDING_ASM_APPROVAL')).toBe(false);
      expect(canFirstApprove('GIFSY_ADMIN', 'PENDING_SO_APPROVAL')).toBe(false);
    });

    it('nextStatusAfterFirstApprove funnels all field stages to PENDING_GIFSY', () => {
      expect(nextStatusAfterFirstApprove('PENDING_SO_APPROVAL')).toBe('PENDING_GIFSY');
      expect(nextStatusAfterFirstApprove('PENDING_ASM_APPROVAL')).toBe('PENDING_GIFSY');
      expect(nextStatusAfterFirstApprove('PENDING_RSM_APPROVAL')).toBe('PENDING_GIFSY');
    });
  });

  // ─── resolveInitialRouting (DB-backed) ────────────────────────────────────────
  // These tests exercise the private method via create() with mocked SalesUser
  // queries. NOTE: create() runs assertPhoneAvailable (channelPartner.findFirst +
  // salesUser.findFirst employee-clash) BEFORE resolveInitialRouting, so the first
  // salesUser.findFirst call is the employee-clash probe, not the routing submitter.
  // primePhoneAvailable() handles that; routingCalls() selects the routing reads.

  describe('resolveInitialRouting (via create)', () => {
    /** Build a minimal SO-role submitter */
    const isr: JwtPayload = { sub: 'isr1', role: 'SALES_ISR', clientId: 'deoleo', phone: '', name: '' };

    const baseDto = {
      outletId: 'outlet-1',
      partnerName: 'Test Store',
      mobile: '9000000001',
      address: '1 Main St',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
    };

    /**
     * Prime the create() pipeline AFTER resolveInitialRouting.
     *
     * IMPORTANT call-order note. The order of reads on mockPrisma inside create() is:
     *   1. outlet.findFirst                       (outlet load)
     *   2. channelPartner.findFirst               (assertPhoneAvailable partner-clash)
     *   3. salesUser.findFirst (nested where.user) (assertPhoneAvailable employee-clash)
     *   4. salesUser.findFirst (flat where.clientId+userId) (resolveInitialRouting submitter)
     *   5+. salesUser.findFirst                    (resolveInitialRouting walk)
     * So the FIRST salesUser.findFirst.mockResolvedValueOnce a test queues is consumed
     * by the employee-clash probe, NOT the routing submitter. Each routing test must
     * therefore queue an employee-clash `null` FIRST (via primePhoneAvailable) so the
     * phone is "available", then its routing values. primeCreate() handles the outlet
     * load + channelPartner-clash null + the in-tx writes.
     */
    const primePhoneAvailable = () => {
      // assertPhoneAvailable: partner-clash null, then employee-clash null → available.
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null);
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);
    };
    const primeCreate = () => {
      mockPrisma.outlet.findFirst.mockResolvedValueOnce({
        id: 'outlet-1',
        clientId: 'deoleo',
        partnerId: null,
        outletCode: 'OUT-1',
        outletType: { code: 'SSS' },
      });
      mockTx.user.findFirst.mockResolvedValueOnce(null);
      mockTx.user.create.mockResolvedValueOnce({ id: 'owner-rt-1' });
      mockTx.channelPartner.create.mockResolvedValueOnce({ id: 'cp-rt-1' });
      mockTx.outlet.update.mockResolvedValueOnce({});
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null);
      mockTx.kycSubmission.create.mockResolvedValueOnce({ id: 'sub-rt-1' });
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
    };
    /**
     * After a create() that primed phone-availability, the routing-relevant
     * salesUser.findFirst calls are every call EXCEPT the first (the employee-clash
     * probe). This returns those calls' `where` clauses in order so assertions can
     * target resolveInitialRouting without coupling to the absolute call index.
     */
    const routingCalls = () =>
      mockPrisma.salesUser.findFirst.mock.calls
        .map((c) => c[0].where)
        .filter((w: Record<string, unknown>) => w.clientId !== undefined && w.user === undefined);

    it('submitter with no SalesUser record → status SUBMITTED, escalatedFrom null', async () => {
      primePhoneAvailable();
      // resolveInitialRouting: no SalesUser → SUBMITTED
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);
      primeCreate();
      const res = await service.create(
        { sub: 'retail1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' },
        baseDto as never,
      );
      expect(res).toMatchObject({ status: 'SUBMITTED', escalatedFrom: null });
      // Confirm the resolveInitialRouting submitter query was tenant-scoped (the
      // routing call, not the assertPhoneAvailable employee-clash probe).
      const suWhere = routingCalls()[0];
      expect(suWhere.clientId).toBe('deoleo');
      expect(suWhere.deletedAt).toBe(null);
    });

    it("direct manager active -- routes to that manager's level status", async () => {
      primePhoneAvailable();
      // Submitter SalesUser → reportingToId = 'so-id'
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce({ id: 'isr-su', reportingToId: 'so-su' }) // submitter
        .mockResolvedValueOnce({                                           // manager (SO)
          id: 'so-su',
          isActive: true,
          deletedAt: null,
          reportingToId: 'asm-su',
          hierarchyLevel: { code: 'SO' },
        });
      primeCreate();
      const res = await service.create(isr, baseDto as never);
      expect(res).toMatchObject({ status: 'PENDING_SO_APPROVAL', escalatedFrom: null });
      // audit NIT-1: the per-hop manager lookup must ALSO be tenant-scoped, not just
      // the submitter lookup — guard the highest-value invariant of this change.
      // routingCalls()[1] = the first manager-walk lookup (after the submitter lookup).
      expect(routingCalls()[1].clientId).toBe('deoleo');
    });

    it('direct manager resigned (inactive) → escalates to next active manager, escalatedFrom set', async () => {
      primePhoneAvailable();
      // Submitter → SO (inactive) → ASM (active)
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce({ id: 'isr-su', reportingToId: 'so-su' })   // submitter
        .mockResolvedValueOnce({                                              // SO — inactive
          id: 'so-su',
          isActive: false,
          deletedAt: null,
          reportingToId: 'asm-su',
          hierarchyLevel: { code: 'SO' },
        })
        .mockResolvedValueOnce({                                              // ASM — active
          id: 'asm-su',
          isActive: true,
          deletedAt: null,
          reportingToId: null,
          hierarchyLevel: { code: 'ASM' },
        });
      primeCreate();
      const res = await service.create(isr, baseDto as never);
      expect(res).toMatchObject({ status: 'PENDING_ASM_APPROVAL', escalatedFrom: 'SO' });
    });

    it('direct manager soft-deleted → treated as inactive and skipped', async () => {
      primePhoneAvailable();
      // Submitter → SO (deletedAt set) → ASM (active)
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce({ id: 'isr-su', reportingToId: 'so-su' })
        .mockResolvedValueOnce({
          id: 'so-su',
          isActive: true,
          deletedAt: new Date('2024-01-01'),  // soft-deleted counts as inactive
          reportingToId: 'asm-su',
          hierarchyLevel: { code: 'SO' },
        })
        .mockResolvedValueOnce({
          id: 'asm-su',
          isActive: true,
          deletedAt: null,
          reportingToId: null,
          hierarchyLevel: { code: 'ASM' },
        });
      primeCreate();
      const res = await service.create(isr, baseDto as never);
      expect(res).toMatchObject({ status: 'PENDING_ASM_APPROVAL', escalatedFrom: 'SO' });
    });

    it('no active manager anywhere up the chain → fallback PENDING_RSM_APPROVAL', async () => {
      primePhoneAvailable();
      // Submitter → SO (inactive) → no further manager
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce({ id: 'isr-su', reportingToId: 'so-su' })
        .mockResolvedValueOnce({
          id: 'so-su',
          isActive: false,
          deletedAt: null,
          reportingToId: null,
          hierarchyLevel: { code: 'SO' },
        });
      primeCreate();
      const res = await service.create(isr, baseDto as never);
      expect(res).toMatchObject({ status: 'PENDING_RSM_APPROVAL', escalatedFrom: 'SO' });
    });

    it('lookup is tenant-scoped (clientId in salesUser where clause)', async () => {
      primePhoneAvailable();
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);
      primeCreate();
      await service.create(isr, baseDto as never);
      // The resolveInitialRouting submitter lookup (routingCalls()[0]), not the
      // assertPhoneAvailable employee-clash probe.
      const suWhere = routingCalls()[0];
      expect(suWhere.clientId).toBe('deoleo');
      expect(suWhere.userId).toBe('isr1');
    });

    it('cycle in reporting chain is bounded (no hang, fallback reached)', async () => {
      // Submitter → a-su (inactive) → b-su (inactive) → a-su (cycle detected by visitedIds).
      // The walk makes exactly 3 salesUser.findFirst calls:
      //   1. submitter lookup  2. a-su  3. b-su  → then a-su is already in visitedIds → break.
      // Fallback: no active manager found → PENDING_RSM_APPROVAL.
      primePhoneAvailable();
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce({ id: 'isr-su', reportingToId: 'a-su' })
        .mockResolvedValueOnce({ id: 'a-su', isActive: false, deletedAt: null, reportingToId: 'b-su', hierarchyLevel: { code: 'SO' } })
        .mockResolvedValueOnce({ id: 'b-su', isActive: false, deletedAt: null, reportingToId: 'a-su', hierarchyLevel: { code: 'SO' } });
      // After those 3, the visited-set guard fires (a-su already seen) → break.
      primeCreate();
      const res = await service.create(isr, baseDto as never);
      expect(res.status).toBe('PENDING_RSM_APPROVAL');
    }, 5000);
  });

  describe('create', () => {
    it('404s when the target outlet is missing in this tenant', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.create(so, {
          outletId: 'nope',
          partnerName: 'Acme',
          mobile: '9000000000',
          address: 'addr1',
          city: 'X',
          state: 'Y',
          pincode: '110011',
        } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a duplicate in-flight submission scoped to the OUTLET partner', async () => {
      // Outlet already has a partner → we update its details, then the per-partner
      // dup guard finds an in-flight submission → BadRequest (rolls back the tx).
      mockPrisma.outlet.findFirst.mockResolvedValueOnce({
        id: 'outlet-1',
        clientId: 'deoleo',
        partnerId: 'cp-existing',
        outletCode: 'OUT-1',
        outletType: { code: 'SSS' },
      });
      // assertPhoneAvailable (exceptPartnerId='cp-existing'): both clashes null → available.
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null);
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null); // employee-clash null
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null); // routing submitter → SUBMITTED
      mockTx.channelPartner.update.mockResolvedValueOnce({ id: 'cp-existing' });
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce({ id: 'existing' });
      await expect(
        service.create(so, {
          outletId: 'outlet-1',
          partnerName: 'Acme',
          mobile: '9000000000',
          address: 'addr1',
          city: 'X',
          state: 'Y',
          pincode: '110011',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      // The dup guard keys on the resolved OUTLET partner, not the rep.
      expect(mockTx.kycSubmission.findFirst.mock.calls[0][0].where.partnerId).toBe('cp-existing');
    });

    it('creates owner User + ChannelPartner for a partner-less outlet, links it, files under the rep', async () => {
      // assertPhoneAvailable: partner-clash null + employee-clash null → available.
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null);
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null); // employee-clash null
      // resolveInitialRouting: SO → ASM (active)
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce({ id: 'so-su', reportingToId: 'asm-su' })  // submitter
        .mockResolvedValueOnce({                                             // ASM manager
          id: 'asm-su',
          isActive: true,
          deletedAt: null,
          reportingToId: null,
          hierarchyLevel: { code: 'ASM' },
        });
      mockPrisma.outlet.findFirst.mockResolvedValueOnce({
        id: 'outlet-1',
        clientId: 'deoleo',
        partnerId: null,
        outletCode: 'OUT-1',
        outletType: { code: 'WHOLESALER' },
      });
      mockTx.user.findFirst.mockResolvedValueOnce(null); // no existing owner
      mockTx.user.create.mockResolvedValueOnce({ id: 'owner-1' });
      mockTx.channelPartner.create.mockResolvedValueOnce({ id: 'cp-new' });
      mockTx.outlet.update.mockResolvedValueOnce({});
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null);
      mockTx.kycSubmission.create.mockResolvedValueOnce({ id: 'sub1' });
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
      const res = await service.create(so, {
        outletId: 'outlet-1',
        partnerName: 'Acme',
        mobile: '9000000000',
        address: 'addr1',
        city: 'X',
        state: 'Y',
        pincode: '110011',
      } as never);
      expect(res).toEqual({ submissionId: 'sub1', status: 'PENDING_ASM_APPROVAL', escalatedFrom: null });
      // Owner created in PENDING_VERIFICATION with the outletType-mapped role.
      expect(mockTx.user.create.mock.calls[0][0].data).toMatchObject({
        status: 'PENDING_VERIFICATION',
        role: 'WHOLESALER',
      });
      // Partner code derived from the outletCode; outlet linked to the new partner.
      expect(mockTx.channelPartner.create.mock.calls[0][0].data.partnerCode).toBe('CP-OUT-1');
      // Outlet linked to the new partner AND the KYC-captured address persisted onto it.
      expect(mockTx.outlet.update.mock.calls[0][0].data).toMatchObject({
        partnerId: 'cp-new',
        addressLine1: 'addr1', city: 'X', state: 'Y', pincode: '110011',
      });
      // Submission filed BY the rep but ABOUT the outlet's partner.
      expect(mockTx.kycSubmission.create.mock.calls[0][0].data.userId).toBe('so1');
      expect(mockTx.kycSubmission.create.mock.calls[0][0].data.partnerId).toBe('cp-new');
    });
  });

  describe('list', () => {
    it('scopes a non-sales caller (partner) to their own submissions', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue(null); // not a sales user → own only
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      mockPrisma.kycSubmission.count.mockResolvedValue(0);
      mockPrisma.kycSubmission.groupBy.mockResolvedValue([]);
      await service.list(partner, {});
      const where = mockPrisma.kycSubmission.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ user: { clientId: 'deoleo' }, userId: { in: ['user1'] } });
    });

    it('scopes a SALES_SO to their whole downline by submitter (Q4), not a tenant-wide status', async () => {
      // SO 'so1' has one XSR ('xsr1') reporting to them → both in the subtree.
      primeSalesNodes([
        { id: 'so-su', reportingToId: null, userId: 'so1' },
        { id: 'xsr-su', reportingToId: 'so-su', userId: 'xsr1' },
      ]);
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      mockPrisma.kycSubmission.count.mockResolvedValue(0);
      mockPrisma.kycSubmission.groupBy.mockResolvedValue([]);
      await service.list(so, {});
      const where = mockPrisma.kycSubmission.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ user: { clientId: 'deoleo' }, userId: { in: ['so1', 'xsr1'] } });
    });

    it('lets a GIFSY admin filter by status', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      mockPrisma.kycSubmission.count.mockResolvedValue(0);
      mockPrisma.kycSubmission.groupBy.mockResolvedValue([]);
      await service.list(gifsy, { status: 'APPROVED' as never });
      const where = mockPrisma.kycSubmission.findMany.mock.calls[0][0].where;
      // GIFSY is the cross-tenant operator (#38) — no caller-tenant filter, all brands.
      expect(where).toEqual({ status: 'APPROVED' });
    });

    it('keeps MIS_USER tenant-wide (NOT sales-subtree scoped) — read-only observer', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      mockPrisma.kycSubmission.count.mockResolvedValue(0);
      mockPrisma.kycSubmission.groupBy.mockResolvedValue([]);
      await service.list(mis, {});
      const where = mockPrisma.kycSubmission.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ user: { clientId: 'deoleo' } }); // no userId scoping
      expect(mockPrisma.salesUser.findFirst).not.toHaveBeenCalled(); // never resolves a subtree
    });
  });

  describe('getOne', () => {
    it('throws NotFound when outside the tenant', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue(null);
      await expect(service.getOne(partner, 's1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('forbids a PARTNER from viewing someone else’s submission', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({ id: 's1', userId: 'other' });
      await expect(service.getOne(sss, 's1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows a SALES reviewer to view a DOWNLINE submission (own subtree)', async () => {
      // Owner 2026-06-24: a manager sees their downline's KYC. 'other' reports to the SO.
      primeSalesNodes([
        { id: 'so-su', reportingToId: null, userId: 'so1' },
        { id: 'xsr-su', reportingToId: 'so-su', userId: 'other' },
      ]);
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'other', partner: null, documents: [], statusHistory: [],
      });
      const res = await service.getOne(so, 's1');
      expect(res.submission.id).toBe('s1');
    });

    it('forbids a SALES reviewer from viewing an OUT-OF-CHAIN submission', async () => {
      // 'other' is NOT in the SO's subtree → Forbidden ("some other SO cannot view").
      primeSalesNodes([
        { id: 'so-su', reportingToId: null, userId: 'so1' },
        { id: 'far-su', reportingToId: null, userId: 'other' },
      ]);
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'other', partner: null, documents: [], statusHistory: [],
      });
      await expect(service.getOne(so, 's1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows a SALES manager to view when the outlet is CURRENTLY assigned into their subtree (reassignment case)', async () => {
      // Reassignment divergence: the submission was created by 'far-submitter' (a rep in
      // a DIFFERENT branch, NOT in the SO's subtree), but the outlet has since been
      // reassigned to 'xsr-su' (in the SO's subtree). The list/targets views show the
      // outlet (active assignment), so the detail must open too. The submitter-chain
      // check FAILS → the assignment-aware path must allow it.
      primeSalesNodes([
        { id: 'so-su', reportingToId: null, userId: 'so1' },
        { id: 'xsr-su', reportingToId: 'so-su', userId: 'current-rep' },
        { id: 'far-su', reportingToId: null, userId: 'far-submitter' },
      ]);
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'far-submitter', partnerId: 'p1', partner: null,
        documents: [], statusHistory: [],
      });
      // The outlet's CURRENT active assignment is to 'xsr-su' (in so1's subtree).
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asg1' });
      const res = await service.getOne(so, 's1');
      expect(res.submission.id).toBe('s1');
      // The widened lookup scoped to the active assignment of the partner's outlet,
      // restricted to the caller's SalesUser subtree.
      const where = mockPrisma.salesUserAssignment.findFirst.mock.calls[0][0].where;
      expect(where.unassignedAt).toBeNull();
      expect(where.salesUserId.in).toEqual(expect.arrayContaining(['so-su', 'xsr-su']));
      expect(where.outlet.partnerId).toBe('p1');
    });

    it('still forbids an UNRELATED SO — neither submitter-chain NOR current-assignee-chain', async () => {
      // 'far-submitter' is out of chain AND the outlet's current assignment is NOT in the
      // SO's subtree → the assignment lookup returns null → Forbidden preserved.
      primeSalesNodes([
        { id: 'so-su', reportingToId: null, userId: 'so1' },
        { id: 'far-su', reportingToId: null, userId: 'far-submitter' },
      ]);
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'far-submitter', partnerId: 'p1', partner: null,
        documents: [], statusHistory: [],
      });
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue(null); // not assigned into this SO's subtree
      await expect(service.getOne(so, 's1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('does NOT widen for a PARTNER caller (no SalesUser → own-only, ignores assignment)', async () => {
      // A partner has no SalesUser, so resolveSalesScope is null → Forbidden regardless of
      // any active assignment. Belt-and-braces: the assignment lookup must not be consulted.
      mockPrisma.salesUser.findFirst.mockResolvedValue(null);
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asg1' });
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'other', partnerId: 'p1', partner: null, documents: [], statusHistory: [],
      });
      await expect(service.getOne(sss, 's1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.salesUserAssignment.findFirst).not.toHaveBeenCalled();
    });

    it('lets MIS_USER view any tenant submission (tenant-wide read), no subtree lookup', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'other', partner: null, documents: [], statusHistory: [],
      });
      const res = await service.getOne(mis, 's1');
      expect(res.submission.id).toBe('s1');
      expect(mockPrisma.salesUser.findFirst).not.toHaveBeenCalled();
    });

    it('inlines a private GCS document as a data URL (read, not signed) so the reviewer can open it', async () => {
      // Signed URLs fail on Cloud Run here; we inline via the SA's object-read grant.
      primeSalesNodes([
        { id: 'so-su', reportingToId: null, userId: 'so1' },
        { id: 'xsr-su', reportingToId: 'so-su', userId: 'other' },
      ]);
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'other', partner: null, statusHistory: [],
        documents: [
          { documentType: 'STORE_BOARD_PHOTO', status: 'PENDING',
            fileUrl: 'https://storage.googleapis.com/bucket/kyc/deoleo/board.jpg',
            fileKey: 'kyc/deoleo/board.jpg', mimeType: 'image/jpeg' },
        ],
      });
      mockStorage.downloadAsDataUrl.mockResolvedValueOnce('data:image/jpeg;base64,ZZZ');
      const res = await service.getOne(so, 's1');
      expect(mockStorage.downloadAsDataUrl).toHaveBeenCalledWith(
        'kyc/deoleo/board.jpg', 'image/jpeg', expect.any(Number),
      );
      expect(mockStorage.getSignedUrl).not.toHaveBeenCalled();
      expect(res.submission.documents[0].viewUrl).toBe('data:image/jpeg;base64,ZZZ');
    });

    it('threads a shrinking per-response inline budget across documents (caps total payload)', async () => {
      primeSalesNodes([
        { id: 'so-su', reportingToId: null, userId: 'so1' },
        { id: 'xsr-su', reportingToId: 'so-su', userId: 'other' },
      ]);
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'other', partner: null, statusHistory: [],
        documents: [
          { documentType: 'STORE_BOARD_PHOTO', status: 'PENDING',
            fileUrl: 'https://storage.googleapis.com/bucket/a.jpg', fileKey: 'a.jpg', mimeType: 'image/jpeg' },
          { documentType: 'SELFIE', status: 'PENDING',
            fileUrl: 'https://storage.googleapis.com/bucket/b.jpg', fileKey: 'b.jpg', mimeType: 'image/jpeg' },
        ],
      });
      const first = `data:image/jpeg;base64,${'A'.repeat(1000)}`;
      mockStorage.downloadAsDataUrl.mockResolvedValueOnce(first).mockResolvedValueOnce('data:image/jpeg;base64,B');
      await service.getOne(so, 's1');
      const firstCap = mockStorage.downloadAsDataUrl.mock.calls[0][2] as number;
      const secondCap = mockStorage.downloadAsDataUrl.mock.calls[1][2] as number;
      // The second doc's budget is the first doc's budget minus the bytes already inlined.
      expect(secondCap).toBe(firstCap - first.length);
    });

    it('nulls the viewUrl (placeholder) when the GCS read throws — never leaks a raw private URL', async () => {
      primeSalesNodes([
        { id: 'so-su', reportingToId: null, userId: 'so1' },
        { id: 'xsr-su', reportingToId: 'so-su', userId: 'other' },
      ]);
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'other', partner: null, statusHistory: [],
        documents: [
          { documentType: 'STORE_BOARD_PHOTO', status: 'PENDING',
            fileUrl: 'https://storage.googleapis.com/bucket/kyc/deoleo/board.jpg',
            fileKey: 'kyc/deoleo/board.jpg', mimeType: 'image/jpeg' },
        ],
      });
      mockStorage.downloadAsDataUrl.mockRejectedValueOnce(new Error('boom'));
      const res = await service.getOne(so, 's1');
      expect(res.submission.documents[0].viewUrl).toBeNull();
    });

    it('passes through an inline data URL and nulls a not-yet-uploaded pending:// ref', async () => {
      primeSalesNodes([
        { id: 'so-su', reportingToId: null, userId: 'so1' },
        { id: 'xsr-su', reportingToId: 'so-su', userId: 'other' },
      ]);
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'other', partner: null, statusHistory: [],
        documents: [
          { documentType: 'SIGNATURE', status: 'PENDING', fileUrl: 'data:image/png;base64,AAAA', fileKey: 'k1' },
          { documentType: 'PAN_CARD', status: 'PENDING', fileUrl: 'pending://kyc/s1/PAN_CARD', fileKey: 'k2' },
        ],
      });
      const res = await service.getOne(so, 's1');
      expect(res.submission.documents[0].viewUrl).toBe('data:image/png;base64,AAAA');
      expect(res.submission.documents[1].viewUrl).toBeNull();
      expect(mockStorage.downloadAsDataUrl).not.toHaveBeenCalled();
      expect(mockStorage.getSignedUrl).not.toHaveBeenCalled();
    });
  });

  describe('ledger (intra-tenant read-leak fix)', () => {
    const seedLedgerSubmission = (userId: string) =>
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1',
        userId,
        partner: { businessName: 'B', phone: 'p', outlets: [], wallets: [] },
      });

    it('restricts a partner caller to their own submission (where.userId = user.sub)', async () => {
      seedLedgerSubmission('sss1');
      await service.ledger(sss, 's1');
      const where = mockPrisma.kycSubmission.findFirst.mock.calls[0][0].where;
      expect(where).toEqual({ id: 's1', user: { clientId: 'deoleo' }, userId: 'sss1' });
    });

    it('does NOT where-restrict a sales reviewer by userId (subtree checked post-fetch)', async () => {
      // 'someone-else' is in the SO's downline → the post-fetch subtree guard passes.
      primeSalesNodes([
        { id: 'so-su', reportingToId: null, userId: 'so1' },
        { id: 'xsr-su', reportingToId: 'so-su', userId: 'someone-else' },
      ]);
      seedLedgerSubmission('someone-else');
      await service.ledger(so, 's1');
      const where = mockPrisma.kycSubmission.findFirst.mock.calls[0][0].where;
      expect(where).toEqual({ id: 's1', user: { clientId: 'deoleo' } });
      expect(where.userId).toBeUndefined();
    });

    it('forbids a sales reviewer from reading an OUT-OF-CHAIN ledger', async () => {
      primeSalesNodes([
        { id: 'so-su', reportingToId: null, userId: 'so1' },
        { id: 'far-su', reportingToId: null, userId: 'someone-else' },
      ]);
      seedLedgerSubmission('someone-else');
      await expect(service.ledger(so, 's1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows the ledger read when the outlet is CURRENTLY assigned into the subtree (reassignment case)', async () => {
      // Same widening as getOne: submitter is out of chain, but the outlet's current
      // active assignment is in the SO's subtree → the ledger read is allowed.
      primeSalesNodes([
        { id: 'so-su', reportingToId: null, userId: 'so1' },
        { id: 'xsr-su', reportingToId: 'so-su', userId: 'current-rep' },
        { id: 'far-su', reportingToId: null, userId: 'far-submitter' },
      ]);
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'far-submitter', partnerId: 'p1',
        partner: { businessName: 'B', phone: 'p', outlets: [], wallets: [] },
      });
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asg1' });
      await expect(service.ledger(so, 's1')).resolves.toBeDefined();
    });

    it('forbids the ledger read when the outlet is NOT assigned into the subtree (unrelated SO preserved)', async () => {
      primeSalesNodes([
        { id: 'so-su', reportingToId: null, userId: 'so1' },
        { id: 'far-su', reportingToId: null, userId: 'far-submitter' },
      ]);
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'far-submitter', partnerId: 'p1',
        partner: { businessName: 'B', phone: 'p', outlets: [], wallets: [] },
      });
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue(null);
      await expect(service.ledger(so, 's1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('does NOT restrict a GIFSY admin by userId (cross-tenant)', async () => {
      seedLedgerSubmission('someone-else');
      await service.ledger(gifsy, 's1');
      const where = mockPrisma.kycSubmission.findFirst.mock.calls[0][0].where;
      expect(where).toEqual({ id: 's1' });
      expect(where.userId).toBeUndefined();
    });

    it('throws NotFound when the (scoped) submission is not found', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue(null);
      await expect(service.ledger(sss, 's1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('firstApprove', () => {
    it('rejects a role that does not match the current status', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_ASM_APPROVAL',
        user: { name: 'n', phone: 'p' },
      });
      await expect(service.firstApprove(so, 's1', {})).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('transitions to PENDING_GIFSY and notifies the partner (routed approver acts)', async () => {
      // The SO is the submitter's first active manager → the routed approver.
      primeSalesNodes([
        { id: 'so-su', reportingToId: null, userId: 'so1' },
        { id: 'xsr-su', reportingToId: 'so-su', userId: 'user1' },
      ]);
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_SO_APPROVAL',
        user: { name: 'n', phone: 'p' },
      });
      const res = await service.firstApprove(so, 's1', { remarks: 'ok' });
      expect(res.nextStatus).toBe('PENDING_GIFSY');
      expect(mockTx.kycSubmission.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { status: 'PENDING_GIFSY', reviewedAt: expect.any(Date) },
      });
      expect(mockNotifications.enqueue).toHaveBeenCalled();
    });

    it('forbids a same-level manager in a DIFFERENT branch from approving', async () => {
      // The SO caller is NOT the submitter's reporting manager → Forbidden, even though
      // their role matches the PENDING_SO_APPROVAL status.
      primeSalesNodes([
        { id: 'so-su', reportingToId: null, userId: 'so1' }, // the caller (other branch)
        { id: 'other-so-su', reportingToId: null, userId: 'other-so' },
        { id: 'xsr-su', reportingToId: 'other-so-su', userId: 'user1' }, // reports elsewhere
      ]);
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_SO_APPROVAL',
        user: { name: 'n', phone: 'p' },
      });
      await expect(service.firstApprove(so, 's1', { remarks: 'ok' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('reject (GIFSY_ADMIN final-stage rejection)', () => {
    it('lets GIFSY_ADMIN reject a PENDING_GIFSY submission — exempt from the routed-approver check', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'user1', status: 'PENDING_GIFSY', user: { name: 'n', phone: 'p' },
      });
      const res = await service.reject(gifsy, 's1', { reason: 'fraudulent documents' });
      expect(res.message).toMatch(/rejected/i);
      expect(mockTx.kycSubmission.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { status: 'REJECTED', rejectionReason: 'fraudulent documents' },
      });
      // Gifsy acts at the final stage — no subtree / routed-approver lookup.
      expect(mockPrisma.salesUser.findFirst).not.toHaveBeenCalled();
    });

    it('supports a Gifsy RE_UPLOAD_REQUIRED request (re-upload, not outright reject)', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'user1', status: 'PENDING_GIFSY', user: { name: 'n', phone: 'p' },
      });
      await service.reject(gifsy, 's1', { reason: 'blurry cheque', status: 'RE_UPLOAD_REQUIRED' });
      expect(mockTx.kycSubmission.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { status: 'RE_UPLOAD_REQUIRED', rejectionReason: 'blurry cheque' },
      });
    });

    it('refuses to re-reject an already-REJECTED submission', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'user1', status: 'REJECTED', user: { name: 'n', phone: 'p' },
      });
      await expect(service.reject(gifsy, 's1', { reason: 'x' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('approve (re-gated, §5 convenience path)', () => {
    /** Seed the pre-tx findFirst (outer load) and the in-tx sub re-assert. */
    const seedApproveHappyPath = () => {
      // Outer pre-tx load
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_GIFSY',
        partnerId: 'p1',
        user: { name: 'n', phone: 'p' },
        partner: { userId: 'owner-9', outlets: [{ id: 'outlet-1', isPrimary: true, deletedAt: null, reKycFlags: null }] },
      });
      // In-tx re-assert
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_GIFSY',
        partnerId: 'p1',
        user: { name: 'n', phone: 'p' },
        partner: { userId: 'owner-9', outlets: [{ id: 'outlet-1', isPrimary: true, deletedAt: null, reKycFlags: null }] },
      });
      // Step 1: load existing items (none yet, so all 7 are missing)
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce([]);
      // updateMany for PENDING→APPROVED (no-op since no rows)
      mockTx.kycVerificationItem.updateMany.mockResolvedValueOnce({ count: 0 });
      // createMany for the 7 missing fields
      mockTx.kycVerificationItem.createMany.mockResolvedValueOnce({ count: 7 });
      // Step c: load all 7 after upsert → all APPROVED
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce(ALL_APPROVED);
      // Conditional flip succeeds
      mockTx.kycSubmission.updateMany.mockResolvedValueOnce({ count: 1 });
      mockTx.wallet.findFirst.mockResolvedValueOnce(null);
      mockTx.wallet.create.mockResolvedValueOnce({ id: 'w1' });
      mockTx.user.update.mockResolvedValueOnce({});
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      mockTx.auditLog.create.mockResolvedValueOnce({});
    };

    it('blocks approval unless the submission is PENDING_GIFSY', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_SO_APPROVAL',
        partnerId: 'p1',
        user: {},
        partner: null,
      });
      await expect(service.approve(gifsy, 's1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('approves, activates the OWNER (not the submitter), creates a wallet, and enqueues notify post-tx', async () => {
      seedApproveHappyPath();
      const res = await service.approve(gifsy, 's1');
      expect(res).toEqual({ message: 'KYC approved successfully' });
      // STEP 2: activate the outlet OWNER (partner.userId='owner-9'), NOT the
      // submitter/rep (submission.userId='user1'). For self-enrol they're equal.
      expect(mockTx.user.update).toHaveBeenCalledWith({
        where: { id: 'owner-9' },
        data: { status: 'ACTIVE' },
      });
      expect(mockTx.wallet.create).toHaveBeenCalledWith({ data: { partnerId: 'p1' } });
      // B1: notification enqueued via service.notify, not inside the tx
      expect(mockNotifications.enqueue).toHaveBeenCalled();
    });

    it('item #2: on APPROVED, activates the partner\'s outlet(s) in the tx (isActive=true)', async () => {
      seedApproveHappyPath();
      await service.approve(gifsy, 's1');
      // The outlet activation is a partner-scoped updateMany that excludes
      // soft-deleted and NOT_INTERESTED outlets.
      expect(mockTx.outlet.updateMany).toHaveBeenCalledWith({
        where: {
          partnerId: 'p1',
          deletedAt: null,
          // null-intent (the common case) OR explicitly-not-declined — Prisma's bare
          // `{not}` would exclude NULL rows (the approval no-op BLOCKER).
          OR: [{ kycIntent: null }, { kycIntent: { not: 'NOT_INTERESTED' } }],
        },
        data: { isActive: true, reactivatedAt: expect.any(Date) },
      });
    });

    it('item #2: does NOT activate outlets when the partner is null (no partnerId)', async () => {
      // Outer pre-tx load with no partner
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_GIFSY',
        partnerId: null,
        user: { name: 'n', phone: 'p' },
        partner: null,
      });
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_GIFSY',
        partnerId: null,
        user: { name: 'n', phone: 'p' },
        partner: null,
      });
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce([]);
      mockTx.kycVerificationItem.updateMany.mockResolvedValueOnce({ count: 0 });
      mockTx.kycVerificationItem.createMany.mockResolvedValueOnce({ count: 7 });
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce(ALL_APPROVED);
      mockTx.kycSubmission.updateMany.mockResolvedValueOnce({ count: 1 });
      mockTx.user.update.mockResolvedValueOnce({});
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      mockTx.auditLog.create.mockResolvedValueOnce({});

      await service.approve(gifsy, 's1');
      expect(mockTx.wallet.create).not.toHaveBeenCalled();
      expect(mockTx.outlet.updateMany).not.toHaveBeenCalled();
    });

    it('does NOT create a wallet when one already exists', async () => {
      seedApproveHappyPath();
      // Override wallet.findFirst to return an existing wallet
      mockTx.wallet.findFirst.mockReset();
      mockTx.wallet.findFirst.mockResolvedValueOnce({ id: 'existing-wallet' });
      await service.approve(gifsy, 's1');
      expect(mockTx.wallet.create).not.toHaveBeenCalled();
    });

    it('throws ConflictException when any field is already REJECTED (no side effects)', async () => {
      // Outer pre-tx load
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_GIFSY',
        partnerId: 'p1',
        user: { name: 'n', phone: 'p' },
        partner: { outlets: [{ id: 'outlet-1', isPrimary: true, deletedAt: null, reKycFlags: null }] },
      });
      // In-tx re-assert
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_GIFSY',
        partnerId: 'p1',
        user: { name: 'n', phone: 'p' },
        partner: { outlets: [{ id: 'outlet-1', isPrimary: true, deletedAt: null, reKycFlags: null }] },
      });
      // Existing items: 6 APPROVED + 1 REJECTED (OWNER_PHOTO)
      const existingItems = KYC_FIELD_KEYS.map((k) => ({
        fieldKey: k,
        decision: k === 'OWNER_PHOTO' ? ('REJECTED' as const) : ('APPROVED' as const),
      }));
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce(existingItems);
      mockTx.kycVerificationItem.updateMany.mockResolvedValueOnce({ count: 0 });
      mockTx.kycVerificationItem.createMany.mockResolvedValueOnce({ count: 0 });
      // Bridge after approve-all: OWNER_PHOTO is still REJECTED (updateMany only touched PENDING)
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce(existingItems);

      await expect(service.approve(gifsy, 's1')).rejects.toBeInstanceOf(ConflictException);
      // No flip, no user activation, no wallet, no notification
      expect(mockTx.kycSubmission.updateMany).not.toHaveBeenCalled();
      expect(mockTx.user.update).not.toHaveBeenCalled();
      expect(mockTx.wallet.create).not.toHaveBeenCalled();
      expect(mockNotifications.enqueue).not.toHaveBeenCalled();
    });

    it('approve of a missing submission → NotFound (Gifsy is cross-tenant, #38)', async () => {
      // GIFSY_ADMIN reaches any brand's record (no caller-tenant filter); a NotFound
      // now means the record genuinely does not exist, not a tenant mismatch.
      const gifsyOther: JwtPayload = { sub: 'admin2', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: '' };
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(null);
      await expect(service.approve(gifsyOther, 's1')).rejects.toBeInstanceOf(NotFoundException);
      const where = mockPrisma.kycSubmission.findFirst.mock.calls[0][0].where;
      expect(where.user).toBeUndefined();
    });

    it('B1 regression: tx failure → notification NOT enqueued', async () => {
      // Outer pre-tx load
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_GIFSY',
        partnerId: 'p1',
        user: { name: 'n', phone: 'p' },
        partner: { outlets: [{ id: 'outlet-1', isPrimary: true, deletedAt: null, reKycFlags: null }] },
      });
      // In-tx re-assert
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_GIFSY',
        partnerId: 'p1',
        user: { name: 'n', phone: 'p' },
        partner: { outlets: [{ id: 'outlet-1', isPrimary: true, deletedAt: null, reKycFlags: null }] },
      });
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce([]);
      mockTx.kycVerificationItem.updateMany.mockResolvedValueOnce({ count: 0 });
      mockTx.kycVerificationItem.createMany.mockResolvedValueOnce({ count: 7 });
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce(ALL_APPROVED);
      mockTx.kycSubmission.updateMany.mockResolvedValueOnce({ count: 1 });
      mockTx.wallet.findFirst.mockResolvedValueOnce(null);
      mockTx.wallet.create.mockResolvedValueOnce({});
      mockTx.user.update.mockResolvedValueOnce({});
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      // auditLog throws → tx would roll back
      mockTx.auditLog.create.mockRejectedValueOnce(new Error('DB write failed'));

      await expect(service.approve(gifsy, 's1')).rejects.toThrow();
      expect(mockNotifications.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('verifyField (POST /v1/kyc/:id/verify)', () => {
    /** Seed a in-tx PENDING_GIFSY re-assert. */
    const seedVerifyTx = (overrides?: Partial<{ outlets: unknown[] }>) => {
      const outlets = overrides?.outlets ?? [{ id: 'outlet-1', isPrimary: true, deletedAt: null, reKycFlags: null }];
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_GIFSY',
        partnerId: 'p1',
        user: { name: 'n', phone: 'p' },
        partner: { outlets },
      });
    };

    it('approving a single field when others are still PENDING → stays PENDING_GIFSY', async () => {
      seedVerifyTx();
      // Upsert succeeds
      mockTx.kycVerificationItem.upsert.mockResolvedValueOnce({});
      // Load all 7 → only 1 APPROVED, rest PENDING
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce([
        { fieldKey: 'PAYMENT', decision: 'APPROVED' },
      ]);

      const res = await service.verifyField(gifsy, 's1', {
        fieldKey: 'PAYMENT',
        decision: 'APPROVED',
      });

      expect(res.derivedStatus).toBe('PENDING_GIFSY');
      expect(res.outcome).toBe('recorded');
      // No status flip — bridge returned PENDING_GIFSY so applyBridgeOutcome was not called
      expect(mockTx.kycSubmission.updateMany).not.toHaveBeenCalled();
      expect(mockNotifications.enqueue).not.toHaveBeenCalled();
    });

    it('rejecting a field with a remark records the decision', async () => {
      seedVerifyTx();
      mockTx.kycVerificationItem.upsert.mockResolvedValueOnce({});
      // Rejected field + 6 still PENDING → bridge stays PENDING_GIFSY
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce([
        { fieldKey: 'PAYMENT', decision: 'REJECTED' },
      ]);

      const res = await service.verifyField(gifsy, 's1', {
        fieldKey: 'PAYMENT',
        decision: 'REJECTED',
        remark: 'Bank details mismatch',
      });

      expect(res.derivedStatus).toBe('PENDING_GIFSY');
      expect(mockTx.kycVerificationItem.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ decision: 'REJECTED', remark: 'Bank details mismatch', source: 'PORTAL' }),
        }),
      );
    });

    it('all 7 APPROVED after verifying the last field → APPROVED + activate + wallet + notify', async () => {
      seedVerifyTx();
      mockTx.kycVerificationItem.upsert.mockResolvedValueOnce({});
      // All 7 APPROVED → bridge = APPROVED
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce(ALL_APPROVED);
      mockTx.kycSubmission.updateMany.mockResolvedValueOnce({ count: 1 });
      mockTx.wallet.findFirst.mockResolvedValueOnce(null);
      mockTx.wallet.create.mockResolvedValueOnce({ id: 'w1' });
      mockTx.user.update.mockResolvedValueOnce({});
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      mockTx.auditLog.create.mockResolvedValueOnce({});

      const res = await service.verifyField(gifsy, 's1', {
        fieldKey: 'OWNER_PHOTO',
        decision: 'APPROVED',
      });

      expect(res.derivedStatus).toBe('APPROVED');
      expect(res.outcome).toBe('approved');
      expect(mockTx.user.update).toHaveBeenCalledWith({ where: { id: 'user1' }, data: { status: 'ACTIVE' } });
      expect(mockTx.wallet.create).toHaveBeenCalledWith({ data: { partnerId: 'p1' } });
      // B1: notification enqueued post-tx, not inside tx
      expect(mockNotifications.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ variables: expect.objectContaining({ event: 'KYC_APPROVED' }) }),
      );
    });

    it('all 7 terminal with 1 REJECTED → RE_UPLOAD_REQUIRED + reKycFlags', async () => {
      seedVerifyTx();
      mockTx.kycVerificationItem.upsert.mockResolvedValueOnce({});
      const items = KYC_FIELD_KEYS.map((k) => ({
        fieldKey: k,
        decision: k === 'OWNER_PHOTO' ? ('REJECTED' as const) : ('APPROVED' as const),
      }));
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce(items);
      mockTx.kycSubmission.updateMany.mockResolvedValueOnce({ count: 1 });
      mockTx.outlet.update.mockResolvedValueOnce({});
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      mockTx.auditLog.create.mockResolvedValueOnce({});

      const res = await service.verifyField(gifsy, 's1', {
        fieldKey: 'PAYMENT',
        decision: 'APPROVED',
      });

      expect(res.derivedStatus).toBe('RE_UPLOAD_REQUIRED');
      expect(res.outcome).toBe('reupload');
      expect(mockTx.outlet.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ reKycFlags: expect.objectContaining({ ownerPhoto: true }) }) }),
      );
    });

    it('throws NotFoundException when submission is not PENDING_GIFSY or not in tenant', async () => {
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.verifyField(gifsy, 'no-such-sub', { fieldKey: 'PAYMENT', decision: 'APPROVED' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('item #1: RE_UPLOAD outcome with no primary outlet → ConflictException (not 500) and no id leak', async () => {
      // Partner has NO primary outlet → applyBridgeOutcome cannot attach reKycFlags.
      seedVerifyTx({ outlets: [] });
      mockTx.kycVerificationItem.upsert.mockResolvedValueOnce({});
      // All 7 terminal with 1 REJECTED → bridge = RE_UPLOAD_REQUIRED
      const items = KYC_FIELD_KEYS.map((k) => ({
        fieldKey: k,
        decision: k === 'OWNER_PHOTO' ? ('REJECTED' as const) : ('APPROVED' as const),
      }));
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce(items);

      const err = await service
        .verifyField(gifsy, 's1', { fieldKey: 'PAYMENT', decision: 'APPROVED' })
        .catch((e) => e);

      // Clean 4xx, not a raw Error → 500.
      expect(err).toBeInstanceOf(ConflictException);
      // The message must NOT leak the internal submission id.
      expect(err.message).not.toContain('s1');
      // No status flip happened (thrown before the conditional updateMany).
      expect(mockTx.kycSubmission.updateMany).not.toHaveBeenCalled();
      expect(mockTx.outlet.update).not.toHaveBeenCalled();
      expect(mockNotifications.enqueue).not.toHaveBeenCalled();
    });

    it('Gifsy in-tx re-assert is cross-tenant (id+status only, #38)', async () => {
      // GIFSY is cross-tenant (#38): the in-tx re-assert is by id+status only, with NO
      // caller-tenant filter (scoped by the record's own tenant).
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.verifyField(gifsy, 's1', { fieldKey: 'PAYMENT', decision: 'APPROVED' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      const whereArg = mockTx.kycSubmission.findFirst.mock.calls[0][0].where;
      expect(whereArg.user).toBeUndefined();
      expect(whereArg.status).toBe('PENDING_GIFSY');
    });

    it('B1 regression: tx failure → notification NOT enqueued', async () => {
      seedVerifyTx();
      mockTx.kycVerificationItem.upsert.mockResolvedValueOnce({});
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce(ALL_APPROVED);
      mockTx.kycSubmission.updateMany.mockResolvedValueOnce({ count: 1 });
      mockTx.wallet.findFirst.mockResolvedValueOnce(null);
      mockTx.wallet.create.mockResolvedValueOnce({});
      mockTx.user.update.mockResolvedValueOnce({});
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      // auditLog throws → tx would roll back
      mockTx.auditLog.create.mockRejectedValueOnce(new Error('audit write failed'));

      await expect(
        service.verifyField(gifsy, 's1', { fieldKey: 'OWNER_PHOTO', decision: 'APPROVED' }),
      ).rejects.toThrow();
      expect(mockNotifications.enqueue).not.toHaveBeenCalled();
    });

    it('rejects a REJECTED decision with no remark before opening a tx (service guard)', async () => {
      await expect(
        service.verifyField(gifsy, 's1', { fieldKey: 'OWNER_PHOTO', decision: 'REJECTED' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    it('forbids a field approver who is not the current approver', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_ASM_APPROVAL',
        user: { phone: 'p' },
      });
      await expect(service.reject(so, 's1', { reason: 'bad' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('lets GIFSY reject at any stage and records the GIFSY stage', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_SO_APPROVAL',
        user: { phone: 'p' },
      });
      const res = await service.reject(gifsy, 's1', { reason: 'fraud' });
      expect(res.message).toBe('KYC rejected successfully');
      const historyArg = mockTx.kycStatusHistory.create.mock.calls[0][0].data;
      expect(historyArg.metadata.stage).toBe('GIFSY');
    });
  });

  describe('consent', () => {
    it('throws 401 when no valid OTP exists', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(null);
      const err = await service
        .consent(partner, { submissionId: 's1', mobile: '9000000000', otp: '123456' })
        .catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(401);
    });

    it('scopes the OTP lookup to the KYC_CONSENT purpose', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'o1',
        code: '123456',
        attempts: 0,
        maxAttempts: 3,
      });
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({ id: 's1' });
      mockPrisma.consentRecord.create.mockResolvedValue({ id: 'cr1' });
      const res = await service.consent(partner, {
        submissionId: 's1',
        mobile: '9000000000',
        otp: '123456',
      });
      expect(res).toEqual({ verified: true, submissionId: 's1' });
      expect(mockPrisma.otpCode.findFirst.mock.calls[0][0].where.purpose).toBe('KYC_CONSENT');
    });

    // ── Task 3.5: ConsentRecord persistence ──────────────────────────────────
    it('Task 3.5: writes a ConsentRecord with correct userId/kycSubmissionId/consentType/version on OTP success', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValueOnce({
        id: 'o1',
        code: '111111',
        attempts: 0,
        maxAttempts: 3,
      });
      mockPrisma.otpCode.update.mockResolvedValueOnce({});
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce({ id: 'sub-consent-1' });
      mockPrisma.consentRecord.create.mockResolvedValueOnce({ id: 'cr-1' });

      await service.consent(partner, { submissionId: 'sub-consent-1', mobile: '9000000001', otp: '111111' });

      expect(mockPrisma.consentRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user1',
          kycSubmissionId: 'sub-consent-1',
          consentType: 'KYC_TERMS',
          version: expect.any(String),
          consentedAt: expect.any(Date),
        }),
      });
    });

    it('Task 3.5: does NOT write a ConsentRecord when OTP is wrong (still returns 401)', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValueOnce({
        id: 'o2',
        code: '999999',
        attempts: 0,
        maxAttempts: 3,
      });
      mockPrisma.otpCode.update.mockResolvedValueOnce({});

      const err = await service
        .consent(partner, { submissionId: 's1', mobile: '9000000001', otp: '000000' })
        .catch((e) => e);

      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(401);
      expect(mockPrisma.consentRecord.create).not.toHaveBeenCalled();
    });

    it('Task 3.5: does NOT write a ConsentRecord when OTP is expired (findFirst returns null)', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValueOnce(null);

      const err = await service
        .consent(partner, { submissionId: 's1', mobile: '9000000001', otp: '111111' })
        .catch((e) => e);

      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(401);
      expect(mockPrisma.consentRecord.create).not.toHaveBeenCalled();
    });
  });

  // ── Task 3.6: Manual re-KYC trigger ──────────────────────────────────────────
  describe('reKyc (POST /v1/kyc/:id/re-kyc)', () => {
    /** A happy-path APPROVED submission with a primary outlet. */
    const seedApprovedSubmission = (outletOverrides?: Partial<{ id: string; reKycFlags: unknown }>) => {
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's-approved',
        userId: 'user1',
        status: 'APPROVED',
        user: { id: 'user1', name: 'Kumar', phone: '9000000001' },
        partner: {
          outlets: [{ id: outletOverrides?.id ?? 'outlet-1', reKycFlags: outletOverrides?.reKycFlags ?? null }],
        },
      });
    };

    it('sets status to RE_KYC_REQUIRED and writes history + auditLog', async () => {
      seedApprovedSubmission();
      mockTx.kycSubmission.update.mockResolvedValueOnce({});
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      mockTx.auditLog.create.mockResolvedValueOnce({});

      const res = await service.reKyc(gifsy, 's-approved', { reason: 'documents expired' });

      expect(res.newStatus).toBe('RE_KYC_REQUIRED');
      expect(mockTx.kycSubmission.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'RE_KYC_REQUIRED' } }),
      );
      expect(mockTx.kycStatusHistory.create).toHaveBeenCalled();
      expect(mockTx.auditLog.create).toHaveBeenCalled();
    });

    it('sets reKycFlags on the primary outlet when fieldKeys are provided (tenant-scoped)', async () => {
      seedApprovedSubmission({ id: 'outlet-2', reKycFlags: null });
      mockTx.kycSubmission.update.mockResolvedValueOnce({});
      mockTx.outlet.update.mockResolvedValueOnce({});
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      mockTx.auditLog.create.mockResolvedValueOnce({});

      await service.reKyc(gifsy, 's-approved', {
        reason: 'GST mismatch',
        fieldKeys: ['GST_VALIDATION'],
      });

      expect(mockTx.outlet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'outlet-2' },
          data: expect.objectContaining({
            reKycFlags: expect.objectContaining({ gstNumber: true, panNumber: true }),
          }),
        }),
      );
    });

    it('throws ConflictException when submission is NOT APPROVED', async () => {
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's-pending',
        userId: 'user1',
        status: 'PENDING_GIFSY',
        user: { id: 'user1', name: 'Kumar', phone: '9000000001' },
        partner: { outlets: [] },
      });

      await expect(
        service.reKyc(gifsy, 's-pending', { reason: 'test' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockTx.kycSubmission.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when submission is outside the tenant', async () => {
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.reKyc(gifsy, 'no-such', { reason: 'test' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('item #1: throws ConflictException (rolls back, no id leak) when fieldKeys given but no primary outlet', async () => {
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's-approved',
        userId: 'user1',
        status: 'APPROVED',
        user: { id: 'user1', name: 'Kumar', phone: '9000000001' },
        partner: { outlets: [] }, // no primary outlet
      });

      const err = await service
        .reKyc(gifsy, 's-approved', { reason: 'test', fieldKeys: ['PAYMENT'] })
        .catch((e) => e);

      // Clean 4xx instead of a raw Error → 500.
      expect(err).toBeInstanceOf(ConflictException);
      // The message must NOT leak the internal submission id.
      expect(err.message).not.toContain('s-approved');
      // status must NOT have been flipped
      expect(mockTx.kycSubmission.update).not.toHaveBeenCalled();
    });

    it('requires reason (empty string should be caught at DTO level, service receives non-empty)', async () => {
      // reason is validated as MinLength(1) in DTO; testing service does not crash with reason
      seedApprovedSubmission();
      mockTx.kycSubmission.update.mockResolvedValueOnce({});
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      mockTx.auditLog.create.mockResolvedValueOnce({});
      const res = await service.reKyc(gifsy, 's-approved', { reason: 'fraud detected' });
      expect(res.message).toBe('Re-KYC triggered successfully');
    });

    it('B1 regression: notification enqueued post-tx (not inside the tx)', async () => {
      seedApprovedSubmission();
      mockTx.kycSubmission.update.mockResolvedValueOnce({});
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      mockTx.auditLog.create.mockResolvedValueOnce({});

      await service.reKyc(gifsy, 's-approved', { reason: 'doc expired' });

      // notification must have been sent after the tx
      expect(mockNotifications.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: expect.objectContaining({ event: 'KYC_RE_KYC_REQUIRED' }),
        }),
      );
    });

    it('B1 regression: tx failure → notification NOT enqueued', async () => {
      seedApprovedSubmission();
      mockTx.kycSubmission.update.mockResolvedValueOnce({});
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      // auditLog throws → tx rolls back
      mockTx.auditLog.create.mockRejectedValueOnce(new Error('DB write failed'));

      await expect(service.reKyc(gifsy, 's-approved', { reason: 'test' })).rejects.toThrow();
      expect(mockNotifications.enqueue).not.toHaveBeenCalled();
    });

    it('is Gifsy-only (non-Gifsy caller gets ForbiddenException)', async () => {
      await expect(service.reKyc(so, 's-approved', { reason: 'test' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  // ── Task 3.4e: GST details + DPDP masking ─────────────────────────────────────
  describe('gstDetails (POST /v1/kyc/:id/gst-details)', () => {
    it('persists entityType + gstRegistrationType on the partner (tenant-scoped)', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 'sub-gst-1',
        userId: 'user1',
        partner: { id: 'p1', clientId: 'deoleo' },
      });
      mockPrisma.channelPartner.update.mockResolvedValueOnce({ id: 'p1' });

      const res = await service.gstDetails(gifsy, 'sub-gst-1', {
        entityType: 'INDIVIDUAL',
        gstRegistrationType: 'REGULAR',
      });

      expect(res.entityType).toBe('INDIVIDUAL');
      expect(res.gstRegistrationType).toBe('REGULAR');
      expect(mockPrisma.channelPartner.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'p1' },
          data: { entityType: 'INDIVIDUAL', gstRegistrationType: 'REGULAR' },
        }),
      );
    });

    it('is Gifsy-only (non-Gifsy caller gets ForbiddenException)', async () => {
      await expect(
        service.gstDetails(so, 'sub-gst-1', { entityType: 'INDIVIDUAL', gstRegistrationType: 'REGULAR' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws NotFoundException when submission does not belong to tenant', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.gstDetails(gifsy, 'no-such', { entityType: 'COMPANY', gstRegistrationType: 'COMPOSITE' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('stores gstLegalName/gstStatus in KycVerificationItem.evidence for GST_VALIDATION', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 'sub-gst-2',
        userId: 'user1',
        partner: { id: 'p2', clientId: 'deoleo' },
      });
      mockPrisma.channelPartner.update.mockResolvedValueOnce({ id: 'p2' });
      mockPrisma.kycVerificationItem.upsert.mockResolvedValueOnce({});

      await service.gstDetails(gifsy, 'sub-gst-2', {
        entityType: 'HUF',
        gstRegistrationType: 'UNREGISTERED',
        gstLegalName: 'Kumar HUF',
        gstStatus: 'Active',
      });

      expect(mockPrisma.kycVerificationItem.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { kycSubmissionId_fieldKey: { kycSubmissionId: 'sub-gst-2', fieldKey: 'GST_VALIDATION' } },
          create: expect.objectContaining({ evidence: { legalName: 'Kumar HUF', status: 'Active' } }),
          update: expect.objectContaining({ evidence: { legalName: 'Kumar HUF', status: 'Active' } }),
        }),
      );
    });
  });

  // ── Task 3.4e: DPDP masking in getOne() ──────────────────────────────────────
  describe('DPDP masking in getOne()', () => {
    const fullPartner = {
      id: 'p1',
      bankAccountNumber: '123456789012',
      panNumber: 'ABCDE1234F',
      gstNumber: '27AABCU9603R1ZM',
    };

    it('shows full sensitive fields to the submission OWNER (their own data is not masked)', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's1',
        userId: 'user1', // === partner.sub → the owner
        partner: fullPartner,
        documents: [],
        statusHistory: [],
        user: { id: 'user1', name: 'Kumar', phone: '9000000001', role: 'RETAILER' },
      });

      const res = await service.getOne(partner, 's1');

      expect(res.submission.partner?.bankAccountNumber).toBe('123456789012');
      expect(res.submission.partner?.panNumber).toBe('ABCDE1234F');
      expect(res.submission.partner?.gstNumber).toBe('27AABCU9603R1ZM');
    });

    it('maskPartnerSensitiveFields masks to last-4 when masking is on (defensive cover for future non-owner reads)', () => {
      const mask = (
        service as unknown as {
          maskPartnerSensitiveFields: (p: typeof fullPartner, m: boolean) => typeof fullPartner;
        }
      ).maskPartnerSensitiveFields(fullPartner, true);
      expect(mask.bankAccountNumber).toBe('****9012');
      expect(mask.panNumber).toBe('****234F');
      expect(mask.gstNumber).toBe('****R1ZM');
    });

    it('shows FULL GST/PAN/bank to a SALES reviewer viewing a downline submission (owner 2026-06-25)', async () => {
      primeSalesNodes([
        { id: 'so-su', reportingToId: null, userId: 'so1' },
        { id: 'xsr-su', reportingToId: 'so-su', userId: 'other' },
      ]);
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's1', userId: 'other', partner: fullPartner, documents: [], statusHistory: [],
        user: { id: 'other', name: 'X', phone: '9', role: 'RETAILER' },
      });
      const res = await service.getOne(so, 's1');
      expect(res.submission.partner?.panNumber).toBe('ABCDE1234F');
      expect(res.submission.partner?.gstNumber).toBe('27AABCU9603R1ZM');
      expect(res.submission.partner?.bankAccountNumber).toBe('123456789012');
    });

    it('STILL masks sensitive fields for MIS_USER (a read-only observer, not a reviewer)', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's1', userId: 'other', partner: fullPartner, documents: [], statusHistory: [],
        user: { id: 'other', name: 'X', phone: '9', role: 'RETAILER' },
      });
      const res = await service.getOne(mis, 's1');
      expect(res.submission.partner?.panNumber).toBe('****234F');
      expect(res.submission.partner?.gstNumber).toBe('****R1ZM');
    });

    it('shows full sensitive fields for Gifsy admin callers', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's1',
        userId: 'admin1',
        partner: fullPartner,
        documents: [],
        statusHistory: [],
        user: { id: 'admin1', name: 'Admin', phone: '9000000002', role: 'GIFSY_ADMIN' },
      });

      const res = await service.getOne(gifsy, 's1');

      expect(res.submission.partner?.bankAccountNumber).toBe('123456789012');
      expect(res.submission.partner?.panNumber).toBe('ABCDE1234F');
      expect(res.submission.partner?.gstNumber).toBe('27AABCU9603R1ZM');
    });
  });

  // ── Task 3.4d: review-queue ──────────────────────────────────────────────────
  describe('reviewQueue (GET /v1/kyc/review-queue)', () => {
    it('is Gifsy-only — non-Gifsy caller gets ForbiddenException', async () => {
      await expect(service.reviewQueue(so)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('queries PENDING_GIFSY cross-tenant (Gifsy, #38)', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([]);
      await service.reviewQueue(gifsy);
      const where = mockPrisma.kycSubmission.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('PENDING_GIFSY');
      expect(where.user).toBeUndefined(); // GIFSY is cross-tenant (#38) — no caller-tenant filter
    });

    it('returns entries array with submissionId, identity, and 7-field state', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([
        {
          id: 'SUB-Q-1',
          boardPhotoLat: 19.1,
          boardPhotoLng: 72.8,
          user: { name: 'Owner A', phone: '9820100001' },
          partner: {
            businessName: 'Kumar Store',
            ownerName: 'Kumar',
            phone: '9820100001',
            gstNumber: 'GSTXXX',
            panNumber: 'PANXXX',
            bankName: 'HDFC',
            bankAccountNumber: '50100',
            bankAccountHolder: 'Kumar', // same as owner → nameMismatch=false
            ifscCode: 'HDFC0001',
            upiId: null,
            paymentMode: 'bank',
            outlets: [
              {
                outletCode: 'OUT-Q-1',
                name: 'Kumar Store',
                addressLine1: '12 SV Road',
                addressLine2: null,
                city: 'Mumbai',
                state: 'Maharashtra',
                pincode: '400058',
                programName: 'Gold',
                outletType: { name: 'SSS' },
              },
            ],
          },
          verificationItems: [
            { fieldKey: 'PAYMENT', decision: 'APPROVED', remark: null, source: 'PORTAL' },
          ],
        },
      ]);

      const result = await service.reviewQueue(gifsy);

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];
      expect(entry.submissionId).toBe('SUB-Q-1');
      expect(entry.outletCode).toBe('OUT-Q-1');
      expect(entry.outletName).toBe('Kumar Store');
      expect(entry.mobile).toBe('9820100001');
      // 7 fields present
      expect(Object.keys(entry.fields)).toHaveLength(7);
      // PAYMENT is APPROVED (from verificationItems)
      expect(entry.fields['PAYMENT'].decision).toBe('APPROVED');
      expect(entry.fields['PAYMENT'].source).toBe('PORTAL');
    });

    it('defaults missing verification fields to PENDING', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([
        {
          id: 'SUB-Q-2',
          boardPhotoLat: null,
          boardPhotoLng: null,
          user: { name: 'B', phone: '9000000002' },
          partner: {
            businessName: 'B Store',
            ownerName: 'B',
            phone: '9000000002',
            gstNumber: null,
            panNumber: null,
            bankName: null,
            bankAccountNumber: null,
            bankAccountHolder: null,
            ifscCode: null,
            upiId: null,
            paymentMode: null,
            outlets: [],
          },
          verificationItems: [], // no items → all 7 should default to PENDING
        },
      ]);

      const result = await service.reviewQueue(gifsy);

      const entry = result.entries[0];
      expect(Object.keys(entry.fields)).toHaveLength(7);
      for (const decision of Object.values(entry.fields)) {
        expect((decision as { decision: string }).decision).toBe('PENDING');
      }
      expect(entry.boardGeo).toBeNull();
    });

    it('returns an empty entries array when no PENDING_GIFSY submissions exist', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([]);
      const result = await service.reviewQueue(gifsy);
      expect(result.entries).toEqual([]);
    });
  });

  describe('notInterested', () => {
    it('is idempotent when the outlet is already marked', async () => {
      mockPrisma.outlet.findUnique.mockResolvedValue({
        isActive: false,
        kycIntent: 'NOT_INTERESTED',
      });
      const res = await service.notInterested(partner, { outletId: 'OUT1' });
      expect(res).toEqual({ outletId: 'OUT1', alreadyMarked: true });
      expect(mockPrisma.outlet.update).not.toHaveBeenCalled();
    });

    it('marks an active outlet as NOT_INTERESTED scoped by tenant', async () => {
      mockPrisma.outlet.findUnique.mockResolvedValue({ isActive: true, kycIntent: null });
      mockPrisma.outlet.update.mockResolvedValue({});
      await service.notInterested(partner, { outletId: 'OUT1' });
      const arg = mockPrisma.outlet.update.mock.calls[0][0];
      expect(arg.where).toEqual({ clientId_outletCode: { clientId: 'deoleo', outletCode: 'OUT1' } });
      expect(arg.data.isActive).toBe(false);
    });
  });

  describe('slaMetrics', () => {
    it('forbids non-GIFSY callers', async () => {
      await expect(service.slaMetrics(so)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('uses the cross-tenant (A1) filter for GIFSY — no caller-tenant user filter (#38)', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      mockPrisma.kycSubmission.count.mockResolvedValue(0);
      mockPrisma.kycStatusHistory.findMany.mockResolvedValue([]);
      await service.slaMetrics(gifsy);
      // First findMany is the APPROVED query; GIFSY → kycTenantFilter() returns {}
      // so there is NO `user.clientId` scope (would otherwise hide every brand's data).
      const approvedWhere = mockPrisma.kycSubmission.findMany.mock.calls[0][0].where;
      expect(approvedWhere.status).toBe('APPROVED');
      expect(approvedWhere.user).toBeUndefined();
    });
  });

  // ─── sendConsentOtp (the previously-missing OTP send) + phone validation ───────
  describe('sendConsentOtp', () => {
    const dto = { submissionId: 'sub1', mobile: '7795096288' };

    beforeEach(() => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({ id: 'sub1', partnerId: null });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      mockPrisma.salesUser.findFirst.mockReset();
      mockPrisma.salesUser.findFirst.mockResolvedValue(null);
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });
    });

    it('creates a KYC_CONSENT OtpCode and sends it via MSG91', async () => {
      const res = await service.sendConsentOtp(partner, dto);
      expect(res).toEqual({ success: true, expiresIn: 600 });
      const created = mockPrisma.otpCode.create.mock.calls[0][0].data;
      expect(created.purpose).toBe('KYC_CONSENT');
      expect(created.phone).toBe('7795096288');
      expect(mockMsg91.sendOtp).toHaveBeenCalledWith('7795096288', expect.any(String), 'SMS');
    });

    it('rejects a number already registered to another enrolled outlet', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ businessName: 'Ravi Stores' });
      await expect(service.sendConsentOtp(partner, dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.otpCode.create).not.toHaveBeenCalled();
      expect(mockMsg91.sendOtp).not.toHaveBeenCalled();
    });

    it('rejects a sales-employee number', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      mockPrisma.salesUser.findFirst.mockResolvedValue({ user: { name: 'Anil Sharma' } });
      await expect(service.sendConsentOtp(partner, dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockMsg91.sendOtp).not.toHaveBeenCalled();
    });

    it('excludes the submission\'s own partner so Re-KYC of the same outlet does not self-collide', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({ id: 'sub1', partnerId: 'cpSelf' });
      await service.sendConsentOtp(partner, dto);
      const where = mockPrisma.channelPartner.findFirst.mock.calls[0][0].where;
      expect(where.id).toEqual({ not: 'cpSelf' });
    });

    it('404s when the submission is not the caller\'s', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue(null);
      await expect(service.sendConsentOtp(partner, dto)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── consent honors FIXED_OTP (staging) when the gate allows it ────────────────
  describe('consent — FIXED_OTP bypass', () => {
    // Surgical save/restore of ONLY the keys we touch — never replace the whole
    // process.env object (that breaks Node env handling for sibling suites).
    const keys = ['NODE_ENV', 'FIXED_OTP', 'DATABASE_URL'] as const;
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => { for (const k of keys) saved[k] = process.env[k]; });
    afterEach(() => {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it('accepts FIXED_OTP even when it differs from the stored code, when isFixedOtpAllowed', async () => {
      // non-prod NODE_ENV → isFixedOtpAllowed() true
      process.env.NODE_ENV = 'development';
      process.env.FIXED_OTP = '123456';
      process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5433/gifsy_dev';
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'o1', code: '999999', attempts: 0, maxAttempts: 3,
      });
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({ id: 'sub1', userId: 'user1' });
      mockPrisma.consentRecord.create.mockResolvedValue({ id: 'c1' });

      // Stored code is 999999 but the user enters the fixed 123456 → accepted.
      await expect(
        service.consent(partner, { submissionId: 'sub1', mobile: '7795096288', otp: '123456' }),
      ).resolves.toBeDefined();
      // marked verified (not an attempt-increment / throw)
      expect(mockPrisma.consentRecord.create).toHaveBeenCalled();
    });
  });

  // ─── Tokenized document-view (security-critical) ────────────────────────────
  describe('signDocViewToken + viewDocument', () => {
    it('signs a token with sub/clientId/typ=docview and 30d expiry', () => {
      mockJwt.sign.mockReturnValueOnce('the.signed.token');
      const tok = service.signDocViewToken('doc1', 'deoleo');
      expect(tok).toBe('the.signed.token');
      expect(mockJwt.sign).toHaveBeenCalledWith(
        { sub: 'doc1', clientId: 'deoleo', typ: 'docview' },
        expect.objectContaining({ expiresIn: '30d' }),
      );
    });

    it('valid token → returns the bytes with the doc content-type', async () => {
      mockJwt.verify.mockReturnValueOnce({ sub: 'doc1', clientId: 'deoleo', typ: 'docview' });
      mockPrisma.kycDocument.findUnique.mockResolvedValueOnce({
        fileKey: 'kyc/2026-06/x-gst.pdf',
        mimeType: 'application/pdf',
        kycSubmission: { user: { clientId: 'deoleo' } },
      });
      const bytes = Buffer.from('PDFDATA');
      mockStorage.downloadBytes.mockResolvedValueOnce({ bytes, contentType: 'application/octet-stream' });

      const res = await service.viewDocument('valid.token');
      // mimeType on the doc wins over the storage content-type; pdf is safe → inline.
      expect(res).toEqual({ bytes, contentType: 'application/pdf', inline: true });
      expect(mockStorage.downloadBytes).toHaveBeenCalledWith('kyc/2026-06/x-gst.pdf');
    });

    it('stored-XSS guard: an unsafe client-supplied mime is served as octet-stream, NOT inline', async () => {
      mockJwt.verify.mockReturnValueOnce({ sub: 'doc1', clientId: 'deoleo', typ: 'docview' });
      mockPrisma.kycDocument.findUnique.mockResolvedValueOnce({
        fileKey: 'kyc/2026-06/evil.svg',
        mimeType: 'image/svg+xml', // attacker-uploaded "document" that could run script
        kycSubmission: { user: { clientId: 'deoleo' } },
      });
      const bytes = Buffer.from('<svg onload=alert(1)>');
      mockStorage.downloadBytes.mockResolvedValueOnce({ bytes, contentType: 'image/svg+xml' });

      const res = await service.viewDocument('valid.token');
      expect(res).toEqual({ bytes, contentType: 'application/octet-stream', inline: false });
    });

    it('expired / invalid signature → 404 (verify throws)', async () => {
      mockJwt.verify.mockImplementationOnce(() => {
        throw new Error('jwt expired');
      });
      await expect(service.viewDocument('expired.token')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.kycDocument.findUnique).not.toHaveBeenCalled();
    });

    it("token missing typ:'docview' (e.g. a replayed access token) → 404", async () => {
      // Looks like a normal access token: has sub/clientId but no typ.
      mockJwt.verify.mockReturnValueOnce({ sub: 'doc1', clientId: 'deoleo', role: 'GIFSY_ADMIN' });
      await expect(service.viewDocument('access.token')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.kycDocument.findUnique).not.toHaveBeenCalled();
    });

    it("doc belonging to ANOTHER tenant → 404 (cross-tenant)", async () => {
      mockJwt.verify.mockReturnValueOnce({ sub: 'doc1', clientId: 'deoleo', typ: 'docview' });
      // The document actually belongs to tenant 'other', not 'deoleo'.
      mockPrisma.kycDocument.findUnique.mockResolvedValueOnce({
        fileKey: 'kyc/2026-06/x.pdf',
        mimeType: 'application/pdf',
        kycSubmission: { user: { clientId: 'other' } },
      });
      await expect(service.viewDocument('valid.token')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.downloadBytes).not.toHaveBeenCalled();
    });

    it('missing token → 404', async () => {
      await expect(service.viewDocument('')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockJwt.verify).not.toHaveBeenCalled();
    });

    it('object missing in storage → 404', async () => {
      mockJwt.verify.mockReturnValueOnce({ sub: 'doc1', clientId: 'deoleo', typ: 'docview' });
      mockPrisma.kycDocument.findUnique.mockResolvedValueOnce({
        fileKey: 'kyc/gone.pdf',
        mimeType: 'application/pdf',
        kycSubmission: { user: { clientId: 'deoleo' } },
      });
      mockStorage.downloadBytes.mockResolvedValueOnce(null);
      await expect(service.viewDocument('valid.token')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
