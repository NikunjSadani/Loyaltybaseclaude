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
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SalesNotificationsService } from '../notifications/sales-notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
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
  // findUnique + delete added for the 48h stale-draft cleanup (cleanupOneStaleDraft).
  kycSubmission: { update: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn(), delete: jest.fn() },
  kycVerificationItem: {
    upsert: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
    createMany: jest.fn(),
  },
  kycStatusHistory: { create: jest.fn() },
  auditLog: { create: jest.fn() },
  user: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  channelPartner: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), create: jest.fn(), delete: jest.fn() },
  userSession: { updateMany: jest.fn() },
  wallet: { findFirst: jest.fn(), create: jest.fn() },
  // outlet.findFirst is used inside the tx by the partner-group helper's resolveGroupPan
  // (PAN golden-key resolution for a GROUPED outlet whose parent carries no PAN).
  // findUnique added for the W4 group-leave login-provisioning (reads the outlet's outletType.code
  // to derive the departing shop's owner role).
  outlet: { update: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
  // $executeRaw is the advisory-lock primitive acquireIdentityLocks issues inside create()'s
  // tx (partner-child owner groups) BEFORE the uniqueness check. A no-op mock here.
  $executeRaw: jest.fn(),
};

const mockPrisma = {
  channelPartner: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  // rejectedExport resolves the rejecter's display name in one round-trip.
  user: { findMany: jest.fn() },
  kycSubmission: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
  },
  kycStatusHistory: { create: jest.fn(), findMany: jest.fn() },
  kycDocument: { create: jest.fn(), findUnique: jest.fn() },
  otpCode: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
  outlet: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  salesUser: { findFirst: jest.fn(), findMany: jest.fn() },
  // assertCanViewSubmission's reassignment-aware allow-path looks up the outlet's
  // CURRENT active assignment (unassignedAt null) to a salesUser in the caller's subtree.
  salesUserAssignment: { findFirst: jest.fn() },
  // ledger() resolves each credit tx's field name from its CreditBatch rows JSON.
  creditBatch: { findMany: jest.fn() },
  // ledger() also unions the outlet's payouts via buildPayoutStatement (shared with the
  // partner wallet) → these findMany must exist (default: no payouts, so ledger resolves).
  payoutTransaction: { findMany: jest.fn().mockResolvedValue([]) },
  creditPayoutEntry: { findMany: jest.fn().mockResolvedValue([]) },
  consentRecord: { create: jest.fn() },
  kycVerificationItem: { upsert: jest.fn() },
  // slaMetrics resolves the TWO per-tenant SLA targets (field/gifsy) via findMany; the holiday
  // calendar loader (loadHolidaySet) reads the single national-holidays row via findFirst.
  programSetting: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

const mockNotifications = { enqueue: jest.fn().mockResolvedValue({ id: 'n1' }) };

const mockMsg91 = {
  sendOtp: jest.fn().mockResolvedValue(undefined),
  sendWhatsappTemplate: jest.fn().mockResolvedValue(undefined),
};

// Per-tenant, per-purpose OTP template resolver. Default undefined = "use the global env
// template"; the sendConsentOtp template test overrides it per case.
let mockKycOtpTemplateId: string | undefined = undefined;
// Tenant UPI gate consumed by the create() payout-mandate guard. Default OFF (mirrors the
// EffectiveSettings default salesApp.upiEnabled=false); UPI tests flip it per case.
let mockUpiEnabled = false;
// Parent-child owner-group uniqueness policy consumed by create()/sendConsentOtp (phone flag)
// and checkGroupUniqueness (gst/bank/upi flags). Default mirrors the EffectiveSettings default
// (gst+phone enforced; bank/upi off). Group tests flip fields per case.
let mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
const mockTenantSettings = {
  getOtpTemplateId: jest.fn(async () => mockKycOtpTemplateId),
  getEffectiveSettings: jest.fn(async () => ({
    salesApp: { upiEnabled: mockUpiEnabled },
    uniquenessPolicy: mockUniquenessPolicy,
  })),
};

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
    mockKycOtpTemplateId = undefined; // default: no per-tenant override (global env template)
    mockUpiEnabled = false; // default: tenant UPI gate OFF (payout-mandate guard)
    mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false }; // default policy
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
      // $executeRaw is a top-level jest.fn on mockTx (not a table of ops) — reset it directly.
      if (typeof table === 'function') {
        (table as jest.Mock).mockReset();
        continue;
      }
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
    // Defaults for the create()-path partner uniqueness PRE-CHECKS (createPartnerWithUniqueCode):
    // no existing GST owner, and no existing partnerCode for the outlet base → first code is free.
    // Tests that assert a collision override these with mockResolvedValueOnce.
    mockTx.channelPartner.findFirst.mockResolvedValue(null);
    mockTx.channelPartner.findMany.mockResolvedValue([]);
    // ledger() now unions the outlet's payouts via buildPayoutStatement — default to no
    // payouts so ledger tests that don't exercise them still resolve (reset above wipes
    // definition-level defaults). Payout-specific tests override with mockResolvedValueOnce.
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.payoutTransaction.findMany.mockResolvedValue([]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
        {
          provide: SalesNotificationsService,
          useValue: {
            outletsAssigned: jest.fn(),
            kycSubmittedForApproval: jest.fn(),
            kycBounced: jest.fn(),
            targetsUploaded: jest.fn(),
          },
        },
        { provide: Msg91Service, useValue: mockMsg91 },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
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
      bankName: 'HDFC',
      accountNumber: '50100',
      ifscCode: 'HDFC0001',
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
        requiredPaymentType: 'BANK',
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

    it('rejects a duplicate GST with a clean 400 (not a tx-aborting 500) on the create path', async () => {
      // Regression for the staging KYC-submit 500: a partner-less (ungrouped) outlet whose
      // GST already belongs to another partner in the tenant must return a clean BadRequest.
      // The old code let channelPartner.create() P2002 → the tx aborted → generic 500. GST
      // uniqueness is now enforced GROUP-AWARE by checkGroupUniqueness (tx.channelPartner
      // .findMany) BEFORE the insert; an ungrouped clash (outlets:[] → outside our null group)
      // is a violation.
      primeCreateMocks();
      mockTx.channelPartner.findMany.mockResolvedValueOnce([{ id: 'other-partner', outlets: [] }]);
      await expect(
        service.create(so, {
          ...baseDto,
          gstNumber: '29ABCDE1234F1Z5',
          documents: [{ type: 'GST_CERTIFICATE', fileKey: 'kyc/deoleo/2026-06/uuid.pdf' }],
        } as never),
      ).rejects.toThrow(/GST number is already registered/i);
      // The insert is never attempted → the transaction is never poisoned.
      expect(mockTx.channelPartner.create).not.toHaveBeenCalled();
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
      // Mon 22 Jun → Tue 23 Jun 2026 = 24 BUSINESS hours (weekday span, no weekend to exclude),
      // so the "SLA Age (hrs)" column still reads 24 under the business-hours clock.
      createdAt: new Date('2026-06-22T00:00:00Z'),
      submittedAt: new Date('2026-06-22T00:00:00Z'),
      reviewedAt: new Date('2026-06-23T00:00:00Z'),
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
      statusHistory: [{ createdAt: new Date('2026-06-23T00:00:00Z'), changedByUserId: 'admin1' }],
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

  describe('resolveInitialRouting (via consent — routing happens after the outlet OTP)', () => {
    /** Build a minimal SO-role submitter */
    const isr: JwtPayload = { sub: 'isr1', role: 'SALES_ISR', clientId: 'deoleo', phone: '', name: '' };

    /**
     * Prime the consent() pipeline UP TO resolveInitialRouting.
     *
     * IMPORTANT call-order note. consent() does NOT run assertPhoneAvailable, so
     * unlike create() there is NO leading employee-clash probe. The FIRST
     * salesUser.findFirst call inside consent() IS the resolveInitialRouting
     * submitter lookup. This helper queues the OTP verify + ConsentRecord write +
     * the DRAFT-path submission load, plus the routing update + status-history
     * writes that follow resolveInitialRouting — but NOT the salesUser.findFirst
     * routing chain (each test supplies that itself).
     */
    const primeConsentUpToRouting = () => {
      mockPrisma.otpCode.findFirst.mockResolvedValueOnce({ id: 'o1', code: '123456', attempts: 0, maxAttempts: 3 });
      mockPrisma.otpCode.update.mockResolvedValueOnce({});
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 'sub-rt-1',
        status: 'DRAFT',
        userId: 'isr1',
        submittedAt: new Date('2026-06-30T00:00:00Z'),
        partner: { ownerName: 'Owner', outlets: [{ name: 'Store', programName: 'Olive Oil' }] },
      });
      mockPrisma.consentRecord.create.mockResolvedValueOnce({ id: 'cr1' });
      mockPrisma.kycSubmission.update.mockResolvedValueOnce({});
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
    };
    /**
     * The routing-relevant salesUser.findFirst calls. consent() has no
     * employee-clash probe, so every salesUser.findFirst call here is a routing
     * read; this filter (clientId set, no nested `user`) still selects them and
     * returns their `where` clauses in order.
     */
    const routingCalls = () =>
      mockPrisma.salesUser.findFirst.mock.calls
        .map((c) => c[0].where)
        .filter((w: Record<string, unknown>) => w.clientId !== undefined && w.user === undefined);
    /** The data written by the routing kycSubmission.update: { status, escalatedFrom, submittedAt }. */
    const routedUpdate = () => mockPrisma.kycSubmission.update.mock.calls[0][0].data;

    it('submitter with no SalesUser record → status SUBMITTED, escalatedFrom null', async () => {
      // resolveInitialRouting: no SalesUser → SUBMITTED
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);
      primeConsentUpToRouting();
      await service.consent(
        { sub: 'retail1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' },
        { submissionId: 'sub-rt-1', mobile: '9000000001', otp: '123456' },
      );
      expect(routedUpdate()).toMatchObject({ status: 'SUBMITTED', escalatedFrom: null });
      // Confirm the resolveInitialRouting submitter query was tenant-scoped.
      const suWhere = routingCalls()[0];
      expect(suWhere.clientId).toBe('deoleo');
      expect(suWhere.deletedAt).toBe(null);
    });

    it("direct manager active -- routes to that manager's level status", async () => {
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
      primeConsentUpToRouting();
      await service.consent(isr, { submissionId: 'sub-rt-1', mobile: '9000000001', otp: '123456' });
      expect(routedUpdate()).toMatchObject({ status: 'PENDING_SO_APPROVAL', escalatedFrom: null });
      // audit NIT-1: the per-hop manager lookup must ALSO be tenant-scoped, not just
      // the submitter lookup — guard the highest-value invariant of this change.
      // routingCalls()[1] = the first manager-walk lookup (after the submitter lookup).
      expect(routingCalls()[1].clientId).toBe('deoleo');
    });

    it('direct manager resigned (inactive) → escalates to next active manager, escalatedFrom set', async () => {
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
      primeConsentUpToRouting();
      await service.consent(isr, { submissionId: 'sub-rt-1', mobile: '9000000001', otp: '123456' });
      expect(routedUpdate()).toMatchObject({ status: 'PENDING_ASM_APPROVAL', escalatedFrom: 'SO' });
    });

    it('direct manager soft-deleted → treated as inactive and skipped', async () => {
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
      primeConsentUpToRouting();
      await service.consent(isr, { submissionId: 'sub-rt-1', mobile: '9000000001', otp: '123456' });
      expect(routedUpdate()).toMatchObject({ status: 'PENDING_ASM_APPROVAL', escalatedFrom: 'SO' });
    });

    it('no active manager anywhere up the chain → fallback PENDING_RSM_APPROVAL', async () => {
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
      primeConsentUpToRouting();
      await service.consent(isr, { submissionId: 'sub-rt-1', mobile: '9000000001', otp: '123456' });
      expect(routedUpdate()).toMatchObject({ status: 'PENDING_RSM_APPROVAL', escalatedFrom: 'SO' });
    });

    it('lookup is tenant-scoped (clientId in salesUser where clause)', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);
      primeConsentUpToRouting();
      await service.consent(isr, { submissionId: 'sub-rt-1', mobile: '9000000001', otp: '123456' });
      // The resolveInitialRouting submitter lookup (routingCalls()[0]).
      const suWhere = routingCalls()[0];
      expect(suWhere.clientId).toBe('deoleo');
      expect(suWhere.userId).toBe('isr1');
    });

    it('cycle in reporting chain is bounded (no hang, fallback reached)', async () => {
      // Submitter → a-su (inactive) → b-su (inactive) → a-su (cycle detected by visitedIds).
      // The walk makes exactly 3 salesUser.findFirst calls:
      //   1. submitter lookup  2. a-su  3. b-su  → then a-su is already in visitedIds → break.
      // Fallback: no active manager found → PENDING_RSM_APPROVAL.
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce({ id: 'isr-su', reportingToId: 'a-su' })
        .mockResolvedValueOnce({ id: 'a-su', isActive: false, deletedAt: null, reportingToId: 'b-su', hierarchyLevel: { code: 'SO' } })
        .mockResolvedValueOnce({ id: 'b-su', isActive: false, deletedAt: null, reportingToId: 'a-su', hierarchyLevel: { code: 'SO' } });
      // After those 3, the visited-set guard fires (a-su already seen) → break.
      primeConsentUpToRouting();
      await service.consent(isr, { submissionId: 'sub-rt-1', mobile: '9000000001', otp: '123456' });
      expect(routedUpdate().status).toBe('PENDING_RSM_APPROVAL');
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
        requiredPaymentType: 'BANK',
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
          bankName: 'HDFC',
          accountNumber: '50100',
          ifscCode: 'HDFC0001',
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
        requiredPaymentType: 'BANK',
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
        bankName: 'HDFC',
        accountNumber: '50100',
        ifscCode: 'HDFC0001',
      } as never);
      expect(res).toEqual({ submissionId: 'sub1', status: 'DRAFT', escalatedFrom: null });
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
      // Address-proof-waiver: the mismatch flag defaults to false when the rep does not declare it.
      expect(mockTx.kycSubmission.create.mock.calls[0][0].data.addressNameMismatch).toBe(false);
      // Deactivate-frees-phone (decision #3): the employee-clash probe (first salesUser.findFirst)
      // only counts an ACTIVE sales employee — a DEACTIVATED employee's number is reusable.
      expect(mockPrisma.salesUser.findFirst.mock.calls[0][0].where.user.status).toBe('ACTIVE');
    });

    it('persists addressNameMismatch=true when the rep declares the shop-board/address-proof names differ', async () => {
      // Mirror the partner-less-outlet setup above (assertPhoneAvailable + routing + tx writes).
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null);
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null); // employee-clash null
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce({ id: 'so-su', reportingToId: 'asm-su' })
        .mockResolvedValueOnce({
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
        requiredPaymentType: 'BANK',
      });
      mockTx.user.findFirst.mockResolvedValueOnce(null);
      mockTx.user.create.mockResolvedValueOnce({ id: 'owner-1' });
      mockTx.channelPartner.create.mockResolvedValueOnce({ id: 'cp-new' });
      mockTx.outlet.update.mockResolvedValueOnce({});
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null);
      mockTx.kycSubmission.create.mockResolvedValueOnce({ id: 'sub1' });
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
      await service.create(so, {
        outletId: 'outlet-1',
        partnerName: 'Acme',
        mobile: '9000000000',
        address: 'addr1',
        city: 'X',
        state: 'Y',
        pincode: '110011',
        bankName: 'HDFC',
        accountNumber: '50100',
        ifscCode: 'HDFC0001',
        addressNameMismatch: true,
      } as never);
      expect(mockTx.kycSubmission.create.mock.calls[0][0].data.addressNameMismatch).toBe(true);
    });
  });

  // ─── create() PAYOUT MANDATE (per-outlet requiredPaymentType, backend-authoritative) ─
  // The outlet's requiredPaymentType pins the payout method a KYC submission may capture.
  // The backend rejects a submission whose paymentMode violates the mandate (or the tenant
  // UPI gate), and requires the matching payout fields. The guard runs BEFORE the write
  // transaction, so reject-path tests only need to reach the guard.
  describe('create() payout mandate', () => {
    const dtoBase = {
      outletId: 'outlet-1',
      partnerName: 'Acme',
      mobile: '9000000000',
      address: 'addr1',
      city: 'X',
      state: 'Y',
      pincode: '110011',
    };
    const bankFields = { bankName: 'HDFC', accountNumber: '50100', ifscCode: 'HDFC0001' };

    /** Prime up to the mandate guard only (outlet resolve + assertPhoneAvailable). */
    const primeToGuard = (requiredPaymentType: string) => {
      mockPrisma.outlet.findFirst.mockResolvedValueOnce({
        id: 'outlet-1',
        clientId: 'deoleo',
        partnerId: null,
        outletCode: 'OUT-1',
        outletType: { code: 'SSS' },
        requiredPaymentType,
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null); // partner-clash
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);      // employee-clash
    };

    /** Prime a FULL partner-less happy path (create forces DRAFT; routing is deferred). */
    const primeHappy = (requiredPaymentType: string) => {
      primeToGuard(requiredPaymentType);
      mockTx.user.findFirst.mockResolvedValueOnce(null); // no existing owner
      mockTx.user.create.mockResolvedValueOnce({ id: 'owner-1' });
      mockTx.channelPartner.create.mockResolvedValueOnce({ id: 'cp-new' });
      mockTx.outlet.update.mockResolvedValueOnce({});
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null); // no in-flight dup
      mockTx.kycSubmission.create.mockResolvedValueOnce({ id: 'sub1' });
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
    };

    it('BANK outlet + rep sends bank (with bank fields) → OK', async () => {
      primeHappy('BANK');
      const res = await service.create(so, {
        ...dtoBase, ...bankFields, paymentMode: 'bank',
      } as never);
      expect(res).toMatchObject({ submissionId: 'sub1', status: 'DRAFT' });
    });

    it('BANK outlet + rep sends upi → 400 (mandate violation)', async () => {
      primeToGuard('BANK');
      await expect(
        service.create(so, { ...dtoBase, paymentMode: 'upi', upiId: 'acme@upi' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('BANK outlet + bank mode but MISSING bank fields → 400', async () => {
      primeToGuard('BANK');
      await expect(
        service.create(so, { ...dtoBase, paymentMode: 'bank' } as never),
      ).rejects.toThrow(/Bank payout requires/i);
    });

    it('UPI outlet (tenant upiEnabled) + upi + upiId → OK', async () => {
      mockUpiEnabled = true;
      primeHappy('UPI');
      const res = await service.create(so, {
        ...dtoBase, paymentMode: 'upi', upiId: 'acme@upi',
      } as never);
      expect(res).toMatchObject({ submissionId: 'sub1', status: 'DRAFT' });
    });

    it('UPI outlet (tenant upiEnabled) + upi but MISSING upiId → 400', async () => {
      mockUpiEnabled = true;
      primeToGuard('UPI');
      await expect(
        service.create(so, { ...dtoBase, paymentMode: 'upi' } as never),
      ).rejects.toThrow(/UPI payout requires/i);
    });

    it('ANY outlet accepts either mode (bank OK; upi OK when tenant upiEnabled)', async () => {
      primeHappy('ANY');
      const bankRes = await service.create(so, {
        ...dtoBase, ...bankFields, paymentMode: 'bank',
      } as never);
      expect(bankRes).toMatchObject({ submissionId: 'sub1' });

      mockUpiEnabled = true;
      primeHappy('ANY');
      const upiRes = await service.create(so, {
        ...dtoBase, paymentMode: 'upi', upiId: 'acme@upi',
      } as never);
      expect(upiRes).toMatchObject({ submissionId: 'sub1' });
    });

    it('UPI mode on a upiEnabled=false tenant → 400 (tenant gate wins)', async () => {
      mockUpiEnabled = false; // default, but explicit for the intent
      primeToGuard('ANY');
      await expect(
        service.create(so, { ...dtoBase, paymentMode: 'upi', upiId: 'acme@upi' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ANY outlet with NO paymentMode sent (two modes allowed) → 400 (no silent default)', async () => {
      mockUpiEnabled = true; // ANY + upiEnabled → 2 allowed modes → pinnedPaymentMode is null
      primeToGuard('ANY');
      await expect(
        service.create(so, { ...dtoBase, ...bankFields } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('re-KYC resubmit: a required bank field that is LOCKED (not flagged) and EMPTY does NOT 400 (MED-1)', async () => {
      // Legacy scenario: an outlet back-filled to requiredPaymentType=BANK whose stored bank
      // fields were never captured (it was UPI before). An admin re-KYC flags a NON-bank field
      // only, so the bank fields are LOCKED to their (empty) stored values and the rep cannot
      // fill them. The guard must NOT deadlock the resubmission on those locked-empty fields.
      mockPrisma.outlet.findFirst.mockResolvedValueOnce({
        id: 'outlet-1', clientId: 'deoleo', partnerId: 'cp-existing',
        outletCode: 'OUT-1', outletType: { code: 'SSS' },
        requiredPaymentType: 'BANK',
        reKycFlags: { mobileNumber: true }, // a true, NON-bank flag → lock active; bank locked
        addressLine1: 'addr1', city: 'X', state: 'Y', pincode: '110011',
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null); // partner-clash
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);      // employee-clash
      mockPrisma.channelPartner.findUnique.mockResolvedValueOnce({     // stored bank = EMPTY
        ownerName: 'Acme', phone: '9000000000', gstNumber: null, panNumber: null,
        bankName: '', bankAccountHolder: '', bankAccountNumber: '', ifscCode: '', upiId: '',
      });
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(null);  // no prior docs
      mockTx.channelPartner.update.mockResolvedValueOnce({ id: 'cp-existing' });
      mockTx.outlet.update.mockResolvedValueOnce({});
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null);      // no in-flight dup
      mockTx.kycSubmission.create.mockResolvedValueOnce({ id: 'sub-1' });
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
      // paymentMode='bank', no bank fields sent — they're locked+empty. Must NOT throw.
      const res = await service.create(so, { ...dtoBase, paymentMode: 'bank' } as never);
      expect(res).toMatchObject({ submissionId: 'sub-1' });
    });
  });

  // ─── create() re-KYC LOCK (backend-enforced field/doc lock on resubmit) ───────
  describe('create() re-KYC lock', () => {
    const baseDto = {
      outletId: 'outlet-1',
      partnerName: 'Kumar Store',
      mobile: '9820100001',
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
      upiId: 'suresh@upi',
    };

    /** The CURRENTLY-stored partner values (keyed by DB column names). */
    const STORED_PARTNER = {
      ownerName: 'Kumar Store',
      phone: '9820100001',
      gstNumber: '27ABCDE1234F1ZK',
      panNumber: 'ABCDE1234F',
      bankName: 'HDFC',
      bankAccountHolder: 'Suresh',
      bankAccountNumber: '50100',
      ifscCode: 'HDFC0001',
      upiId: 'suresh@upi',
    };

    /**
     * Prime a re-entry (existing-partner) create() to a happy DRAFT.
     * `reKycFlags` = the Outlet's admin re-KYC request (null = none). Stored partner +
     * outlet address values are the baseline the lock pins non-flagged fields back to.
     */
    const primeReentry = (
      reKycFlags: Record<string, unknown> | null,
      priorDocs: Array<Record<string, unknown>> | null = null,
    ) => {
      mockPrisma.outlet.findFirst.mockResolvedValueOnce({
        id: 'outlet-1',
        clientId: 'deoleo',
        partnerId: 'cp-existing',
        outletCode: 'OUT-1',
        outletType: { code: 'SSS' },
        requiredPaymentType: 'BANK',
        reKycFlags,
        // stored address on the outlet (the lock pins non-flagged address fields to these)
        addressLine1: '12 SV Road',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400058',
      });
      // assertPhoneAvailable: partner-clash null + employee-clash null → available.
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null);
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null); // employee-clash
      // The re-KYC lock loads the currently-stored partner (only when flags present).
      mockPrisma.channelPartner.findUnique.mockResolvedValueOnce(STORED_PARTNER);
      // The doc lock loads the PRIOR submission to carry forward non-flagged docs (only when
      // flags present). Default: no prior → nothing carried.
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(
        priorDocs ? { id: 'prev-sub', documents: priorDocs } : null,
      );
      // tx: GST pre-check (null → free) is defaulted in beforeEach; the partner update + dup guard + create.
      mockTx.channelPartner.update.mockResolvedValueOnce({ id: 'cp-existing' });
      mockTx.outlet.update.mockResolvedValueOnce({});
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null); // no in-flight dup
      mockTx.kycSubmission.create.mockResolvedValueOnce({ id: 'sub-1' });
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
      mockPrisma.kycDocument.create.mockResolvedValue({});
    };

    // Stage-at-approval: a re-KYC no longer writes the partner OR the outlet address at draft time —
    // the re-KYC-LOCK-applied patch (identity/payout AND the outlet address) is STAGED on
    // KycSubmission.proposedPartner (and applied to the partner + primary outlet only at approval).
    // The text-lock behavior is asserted against that single staged patch.
    const partnerUpdateData = () => mockTx.kycSubmission.create.mock.calls[0][0].data.proposedPartner;
    /** The documentTypes actually persisted. */
    const persistedDocTypes = () =>
      mockPrisma.kycDocument.create.mock.calls.map((c) => c[0].data.documentType);

    it('no flags → the full form is editable (lock does NOT load stored, passes through)', async () => {
      primeReentry(null);
      await service.create(so, { ...baseDto, partnerName: 'Changed Name' } as never);
      // hasReKycFlags(null) === false → the stored-partner load is skipped entirely.
      expect(mockPrisma.channelPartner.findUnique).not.toHaveBeenCalled();
      // The DTO change flows straight through.
      expect(partnerUpdateData().ownerName).toBe('Changed Name');
    });

    it('blanket re-KYC (all-false flags) → treated as no-flags, full form editable', async () => {
      primeReentry({ mobileNumber: false, remarks: '' });
      await service.create(so, { ...baseDto, mobile: '9111111111' } as never);
      expect(mockPrisma.channelPartner.findUnique).not.toHaveBeenCalled();
      expect(partnerUpdateData().phone).toBe('9111111111');
    });

    it('flagged text field → the change is ACCEPTED', async () => {
      primeReentry({ mobileNumber: true });
      await service.create(so, { ...baseDto, mobile: '9111111111' } as never);
      expect(partnerUpdateData().phone).toBe('9111111111'); // flagged → accepted
    });

    it('NON-flagged text change → PINNED back to the stored value (not persisted)', async () => {
      // Only mobileNumber flagged; the payload also tampers partnerName + gstNumber (non-flagged).
      primeReentry({ mobileNumber: true });
      await service.create(so, {
        ...baseDto,
        mobile: '9111111111',
        partnerName: 'Tampered Name',
        gstNumber: '99ZZZZZ9999Z9Z9',
      } as never);
      const data = partnerUpdateData();
      expect(data.phone).toBe('9111111111');       // flagged → accepted
      expect(data.ownerName).toBe('Kumar Store');  // non-flagged → pinned to stored
      expect(data.businessName).toBe('Kumar Store');
      expect(data.gstNumber).toBe('27ABCDE1234F1ZK'); // non-flagged → pinned to stored
    });

    it('NON-flagged address change → PINNED to the stored outlet address (staged on proposedPartner)', async () => {
      primeReentry({ mobileNumber: true });
      await service.create(so, {
        ...baseDto,
        mobile: '9111111111',
        address: 'Tampered Address',
        city: 'Delhi',
      } as never);
      // Stage-at-approval: a re-KYC stages the address on proposedPartner; the live outlet is NOT
      // written at draft time.
      expect(mockTx.outlet.update).not.toHaveBeenCalled();
      const data = partnerUpdateData();
      expect(data.addressLine1).toBe('12 SV Road'); // non-flagged → pinned
      expect(data.city).toBe('Mumbai');             // non-flagged → pinned
    });

    it('flagged address field → the change is accepted (staged on proposedPartner, live outlet untouched)', async () => {
      primeReentry({ streetAddress: true });
      await service.create(so, { ...baseDto, address: 'New Address 99' } as never);
      expect(mockTx.outlet.update).not.toHaveBeenCalled();
      expect(partnerUpdateData().addressLine1).toBe('New Address 99');
    });

    it('a document of a FLAGGED type is processed', async () => {
      primeReentry({ gstCertificate: true });
      await service.create(so, {
        ...baseDto,
        documents: [{ type: 'GST_CERTIFICATE', fileKey: 'kyc/deoleo/2026-06/uuid.pdf' }],
      } as never);
      expect(persistedDocTypes()).toContain('GST_CERTIFICATE');
    });

    it('an INCOMING document of a NON-flagged type is IGNORED (not trusted from the payload)', async () => {
      // Only the mobile number is flagged (a text field) → NO document type is allowed, and
      // no prior submission is mocked → nothing to carry forward → no doc persisted.
      primeReentry({ mobileNumber: true });
      await service.create(so, {
        ...baseDto,
        documents: [{ type: 'GST_CERTIFICATE', fileKey: 'kyc/deoleo/2026-06/uuid.pdf' }],
      } as never);
      expect(persistedDocTypes()).not.toContain('GST_CERTIFICATE');
      expect(mockPrisma.kycDocument.create).not.toHaveBeenCalled();
    });

    it('F2: NON-flagged docs are CARRIED FORWARD from the prior submission (not dropped, not trusted)', async () => {
      // Flag GST cert only; the prior submission holds a cheque + a store board photo. The rep's
      // payload tampers the cheque with a NEW fileKey → the crafted upload must be ignored and the
      // PRIOR cheque carried forward instead; the new GST cert (flagged) is accepted.
      primeReentry({ gstCertificate: true }, [
        { documentType: 'CANCELLED_CHEQUE', fileUrl: 'u1', fileKey: 'kyc/deoleo/PRIOR/cheque.pdf', fileName: 'c.pdf', mimeType: 'application/pdf', fileSizeBytes: 10 },
        { documentType: 'STORE_BOARD_PHOTO', fileUrl: 'u2', fileKey: 'kyc/deoleo/PRIOR/board.jpg', fileName: 'b.jpg', mimeType: 'image/jpeg', fileSizeBytes: 20 },
        { documentType: 'SIGNATURE', fileUrl: 'sig', fileKey: 'kyc/deoleo/PRIOR/sig.png', fileName: 's.png', mimeType: 'image/png', fileSizeBytes: 5 },
      ]);
      await service.create(so, {
        ...baseDto,
        documents: [
          { type: 'GST_CERTIFICATE', fileKey: 'kyc/deoleo/2026-06/gst-new.pdf' },
          { type: 'CANCELLED_CHEQUE', fileKey: 'kyc/deoleo/2026-06/cheque-TAMPERED.pdf' },
        ],
      } as never);
      const calls = mockPrisma.kycDocument.create.mock.calls.map((c) => c[0].data);
      const byType = Object.fromEntries(calls.map((d) => [d.documentType, d.fileKey]));
      expect(byType['GST_CERTIFICATE']).toBe('kyc/deoleo/2026-06/gst-new.pdf'); // flagged → new accepted
      expect(byType['CANCELLED_CHEQUE']).toBe('kyc/deoleo/PRIOR/cheque.pdf');    // non-flagged → PRIOR carried, tamper ignored
      expect(byType['STORE_BOARD_PHOTO']).toBe('kyc/deoleo/PRIOR/board.jpg');    // non-flagged → PRIOR carried
      expect(byType['SIGNATURE']).toBeUndefined();                              // signature is re-collected, never carried
    });

    it('mixed docs with NO prior: flagged type kept, non-flagged incoming ignored', async () => {
      primeReentry({ gstCertificate: true });
      await service.create(so, {
        ...baseDto,
        documents: [
          { type: 'GST_CERTIFICATE', fileKey: 'kyc/deoleo/2026-06/gst.pdf' },
          { type: 'CANCELLED_CHEQUE', fileKey: 'kyc/deoleo/2026-06/cheque.pdf' },
        ],
      } as never);
      const types = persistedDocTypes();
      expect(types).toContain('GST_CERTIFICATE');       // flagged → kept
      expect(types).not.toContain('CANCELLED_CHEQUE');  // non-flagged, no prior → nothing
    });

    it('no flags → all documents processed as today', async () => {
      primeReentry(null);
      await service.create(so, {
        ...baseDto,
        documents: [
          { type: 'GST_CERTIFICATE', fileKey: 'kyc/deoleo/2026-06/gst.pdf' },
          { type: 'CANCELLED_CHEQUE', fileKey: 'kyc/deoleo/2026-06/cheque.pdf' },
        ],
      } as never);
      const types = persistedDocTypes();
      expect(types).toContain('GST_CERTIFICATE');
      expect(types).toContain('CANCELLED_CHEQUE');
    });
  });

  // ─── create() GROUP-AWARE identity/phone uniqueness (partner-child owner groups) ──
  // Wave-2 Stream A: checkGroupUniqueness wired into create() + a group-aware
  // assertPhoneAvailable + the login-less-sibling (userId=null) guard. PAN is the group
  // golden-key (identical-within-group); GST/bank/UPI are unique-except-within-group per
  // the tenant policy; an UNGROUPED outlet keeps today's strict behavior.
  describe('create() group-aware uniqueness', () => {
    const groupedDto = {
      outletId: 'outlet-2',
      partnerName: 'Sibling Store',
      mobile: '9000000002',
      address: 'addr2',
      city: 'X',
      state: 'Y',
      pincode: '110022',
      bankName: 'HDFC',
      accountNumber: '50100',
      ifscCode: 'HDFC0001',
    };

    /** Prime a GROUPED (parentId set), partner-less create() up to the tx writes. */
    const primeGroupedCreate = (opts?: { parentPan?: string | null }) => {
      mockPrisma.outlet.findFirst.mockResolvedValueOnce({
        id: 'outlet-2',
        clientId: 'deoleo',
        partnerId: null,
        parentId: 'parent-1', // grouped
        outletCode: 'OUT-2',
        outletType: { code: 'SSS' },
        requiredPaymentType: 'BANK',
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null); // phone partner-clash
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);      // employee-clash
      // Parent PAN lookup (consumed only when the dto carries a PAN → checkPanMatchesGroup).
      mockTx.channelPartner.findUnique.mockResolvedValue({ panNumber: opts?.parentPan ?? null });
      mockTx.user.findFirst.mockResolvedValueOnce(null);
      mockTx.user.create.mockResolvedValueOnce({ id: 'owner-2' });
      mockTx.channelPartner.create.mockResolvedValueOnce({ id: 'cp-2' });
      mockTx.outlet.update.mockResolvedValueOnce({});
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null);
      mockTx.kycSubmission.create.mockResolvedValueOnce({ id: 'sub-2' });
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
      mockPrisma.kycDocument.create.mockResolvedValue({});
    };

    /** Prime an UNGROUPED (parentId null), partner-less create() up to the tx writes. */
    const primeUngroupedCreate = () => {
      mockPrisma.outlet.findFirst.mockResolvedValueOnce({
        id: 'outlet-2',
        clientId: 'deoleo',
        partnerId: null,
        parentId: null, // ungrouped
        outletCode: 'OUT-2',
        outletType: { code: 'SSS' },
        requiredPaymentType: 'BANK',
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null);
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);
      mockTx.user.findFirst.mockResolvedValueOnce(null);
      mockTx.user.create.mockResolvedValueOnce({ id: 'owner-2' });
      mockTx.channelPartner.create.mockResolvedValueOnce({ id: 'cp-2' });
      mockTx.outlet.update.mockResolvedValueOnce({});
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null);
      mockTx.kycSubmission.create.mockResolvedValueOnce({ id: 'sub-2' });
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
      mockPrisma.kycDocument.create.mockResolvedValue({});
    };

    /**
     * Prime a GROUPED RE-KYC create (existing partner `cp-existing` + parentId `parent-1`) up to the
     * tx writes. Used for the Wave-4 group-LEAVE-via-re-KYC path: a grouped child re-KYC whose PAN
     * differs from the group PAN is a DEPARTURE (validated standalone + staged, not blocked).
     * `parentPan` = the group's canonical PAN that resolveGroupPan reads off the parent.
     */
    const primeGroupedReKycCreate = (parentPan: string) => {
      mockPrisma.outlet.findFirst.mockResolvedValueOnce({
        id: 'outlet-2',
        clientId: 'deoleo',
        partnerId: 'cp-existing', // re-KYC branch (existing partner → stage-at-approval)
        parentId: 'parent-1', // grouped
        outletCode: 'OUT-2',
        outletType: { code: 'SSS' },
        requiredPaymentType: 'BANK',
        reKycFlags: null,
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null); // phone partner-clash
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);      // employee-clash
      // resolveGroupPan (inside isGroupDeparture) reads the group's canonical PAN off the parent.
      mockTx.channelPartner.findUnique.mockResolvedValue({ panNumber: parentPan });
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null);
      mockTx.kycSubmission.create.mockResolvedValueOnce({ id: 'sub-dep' });
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
      mockPrisma.kycDocument.create.mockResolvedValue({});
    };

    it('allows a grouped sibling to SHARE GST / bank / UPI with an in-group sibling', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: true, upi: true }; // all enforced
      primeGroupedCreate();
      // Every identity clash resolves to a SAME-GROUP sibling (parentId === our group) → allowed.
      // The partnerCode lookup (where.partnerCode) resolves to no taken codes.
      mockTx.channelPartner.findMany.mockImplementation(async (args: any) => {
        if (args?.where?.partnerCode) return [];
        return [{ id: 'sibling-1', outlets: [{ parentId: 'parent-1' }] }];
      });
      const res = await service.create(so, {
        ...groupedDto,
        gstNumber: '29ABCDE1234F1Z5',
        upiId: 'sib@upi',
      } as never);
      expect(res).toMatchObject({ submissionId: 'sub-2', status: 'DRAFT' });
      expect(mockTx.channelPartner.create).toHaveBeenCalledTimes(1);
    });

    it('BLOCKS a GST that belongs to an outlet OUTSIDE the group', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeGroupedCreate();
      mockTx.channelPartner.findMany.mockImplementation(async (args: any) => {
        if (args?.where?.partnerCode) return [];
        return [{ id: 'outsider', outlets: [{ parentId: null }] }]; // ungrouped outsider
      });
      await expect(
        service.create(so, { ...groupedDto, gstNumber: '29ABCDE1234F1Z5' } as never),
      ).rejects.toThrow(/GST number is already registered to another outlet outside this group/i);
      expect(mockTx.channelPartner.create).not.toHaveBeenCalled();
    });

    it('BLOCKS a bank account that belongs to an outlet OUTSIDE the group (policy bank ON)', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: true, upi: false };
      primeGroupedCreate();
      mockTx.channelPartner.findMany.mockImplementation(async (args: any) => {
        if (args?.where?.partnerCode) return [];
        return [{ id: 'outsider', outlets: [{ parentId: 'other-group' }] }];
      });
      await expect(
        service.create(so, { ...groupedDto } as never), // bankAccountNumber='50100' from groupedDto
      ).rejects.toThrow(/bank account number is already registered to another outlet outside this group/i);
      expect(mockTx.channelPartner.create).not.toHaveBeenCalled();
    });

    it('BLOCKS a UPI that belongs to an outlet OUTSIDE the group (policy upi ON)', async () => {
      mockUniquenessPolicy = { gst: false, phone: true, bank: false, upi: true };
      primeGroupedCreate();
      mockTx.channelPartner.findMany.mockImplementation(async (args: any) => {
        if (args?.where?.partnerCode) return [];
        return [{ id: 'outsider', outlets: [{ parentId: 'other-group' }] }];
      });
      await expect(
        service.create(so, { ...groupedDto, upiId: 'x@upi' } as never),
      ).rejects.toThrow(/UPI ID is already registered to another outlet outside this group/i);
      expect(mockTx.channelPartner.create).not.toHaveBeenCalled();
    });

    it('BLOCKS a PAN that MISMATCHES the group PAN for a BRAND-NEW outlet JOINING a group (golden-key)', async () => {
      // A partner-LESS grouped outlet is a brand-new outlet being onboarded INTO a group — it must
      // SHARE the group PAN (it isn't "leaving", it's joining). Departure (group-LEAVE) applies only
      // to a re-KYC of an EXISTING partner (next test); a brand-new grouped outlet still BLOCKS.
      mockUniquenessPolicy = { gst: false, phone: true, bank: false, upi: false };
      primeGroupedCreate({ parentPan: 'GROUPPAN01F' }); // the group's canonical PAN
      await expect(
        service.create(so, { ...groupedDto, panNumber: 'DIFFERENT9F' } as never),
      ).rejects.toThrow(/group already uses PAN GROUPPAN01F/i);
      expect(mockTx.channelPartner.create).not.toHaveBeenCalled();
    });

    it('re-KYC of a grouped child proposing a PAN != the group PAN STAGES a DEPARTURE (standalone, not blocked)', async () => {
      // Wave-4 group-LEAVE via re-KYC (Option A): a grouped child whose re-KYC proposes a PAN
      // different from the group PAN is an explicit request to LEAVE the group. It is NO LONGER
      // blocked with "group already uses PAN…"; instead the proposed identity is validated as a
      // STANDALONE shop and STAGED on proposedPartner (the parentId detach happens at approval).
      mockUniquenessPolicy = { gst: false, phone: true, bank: false, upi: false };
      primeGroupedReKycCreate('GROUPPAN01F'); // group PAN on record
      // Standalone uniqueness scan finds NO outside outlet holding the departing (new) identity.
      mockTx.channelPartner.findMany.mockImplementation(async () => []);
      const res = await service.create(so, { ...groupedDto, panNumber: 'DIFFERENT9F' } as never);
      expect(res).toMatchObject({ submissionId: 'sub-dep', status: 'DRAFT' });
      // Re-KYC never mutates the live partner at draft time — it only STAGES the departing identity.
      expect(mockTx.channelPartner.create).not.toHaveBeenCalled();
      expect(mockTx.channelPartner.update).not.toHaveBeenCalled();
      const staged = mockTx.kycSubmission.create.mock.calls[0][0].data.proposedPartner;
      expect(staged).toMatchObject({ panNumber: 'DIFFERENT9F' }); // the NEW (departing) PAN is staged
    });

    it('re-KYC DEPARTURE whose new PAN collides with an OUTSIDE outlet → BLOCKED (standalone uniqueness)', async () => {
      // A departure must STILL pass STANDALONE uniqueness: if the proposed PAN already belongs to an
      // outlet outside any group, the create-time early-UX pre-check rejects it (the authoritative
      // check re-runs at approval). Proves the standalone validation isn't a blanket bypass.
      mockUniquenessPolicy = { gst: false, phone: true, bank: false, upi: false };
      primeGroupedReKycCreate('GROUPPAN01F');
      mockTx.channelPartner.findMany.mockImplementation(async (args: any) =>
        args?.where?.partnerCode ? [] : [{ id: 'outsider', isParent: false, outlets: [{ parentId: null }] }],
      );
      await expect(
        service.create(so, { ...groupedDto, panNumber: 'DIFFERENT9F' } as never),
      ).rejects.toThrow(/already registered to another outlet/i);
      expect(mockTx.kycSubmission.create).not.toHaveBeenCalled();
    });

    it('allows a PAN that MATCHES the group PAN', async () => {
      mockUniquenessPolicy = { gst: false, phone: true, bank: false, upi: false };
      primeGroupedCreate({ parentPan: 'GROUPPAN01F' });
      // PAN matches the group → checkPanMatchesGroup passes; the outside-PAN scan finds none.
      mockTx.channelPartner.findMany.mockImplementation(async (args: any) => {
        if (args?.where?.partnerCode) return [];
        return []; // no outside PAN holder
      });
      const res = await service.create(so, { ...groupedDto, panNumber: 'GROUPPAN01F' } as never);
      expect(res).toMatchObject({ submissionId: 'sub-2' });
    });

    it('BLOCKS a PAN duplicate OUTSIDE the group for an UNGROUPED outlet (PAN always enforced)', async () => {
      mockUniquenessPolicy = { gst: false, phone: true, bank: false, upi: false };
      primeUngroupedCreate();
      mockTx.channelPartner.findMany.mockImplementation(async (args: any) => {
        if (args?.where?.partnerCode) return [];
        return [{ id: 'pan-owner', outlets: [] }]; // any clash is "outside" for an ungrouped outlet
      });
      await expect(
        service.create(so, { ...groupedDto, panNumber: 'ABCDE1234F' } as never),
      ).rejects.toThrow(/PAN is already registered to another outlet/i);
    });

    it('policy with bank/UPI OFF does NOT check them — a colliding bank/UPI is allowed', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false }; // bank/upi OFF
      primeUngroupedCreate();
      // Even though every identity query would return an OUTSIDE clash, bank/UPI are never
      // queried (policy off) and the dto carries no GST/PAN → create succeeds.
      mockTx.channelPartner.findMany.mockImplementation(async (args: any) => {
        if (args?.where?.partnerCode) return [];
        return [{ id: 'outsider', outlets: [] }];
      });
      const res = await service.create(so, {
        ...groupedDto, // bank fields present
        upiId: 'x@upi',
      } as never);
      expect(res).toMatchObject({ submissionId: 'sub-2' });
    });

    // ── assertPhoneAvailable group-awareness ──────────────────────────────────────
    it('assertPhoneAvailable EXCLUDES same-group siblings via a NOT filter when grouped', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeGroupedCreate();
      mockTx.channelPartner.findMany.mockResolvedValue([]); // clean identity
      await service.create(so, { ...groupedDto } as never);
      const where = mockPrisma.channelPartner.findFirst.mock.calls[0][0].where;
      // Group-aware: same-group siblings are excluded from the phone clash search.
      expect(where.NOT).toEqual({ outlets: { some: { parentId: 'parent-1' } } });
      expect(where.isParent).toBe(false);
      expect(where.deletedAt).toBeNull();
    });

    it('assertPhoneAvailable STILL blocks a phone on an outlet OUTSIDE the group', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      mockPrisma.outlet.findFirst.mockResolvedValueOnce({
        id: 'outlet-2', clientId: 'deoleo', partnerId: null, parentId: 'parent-1',
        outletCode: 'OUT-2', outletType: { code: 'SSS' }, requiredPaymentType: 'BANK',
      });
      // The NOT-filtered query still finds an OUTSIDE-group partner on this phone → block.
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({ businessName: 'Outside Store' });
      await expect(
        service.create(so, { ...groupedDto } as never),
      ).rejects.toThrow(/already registered to another outlet \(Outside Store\)/i);
    });

    it('assertPhoneAvailable is SKIPPED for the partner-clash when tenant policy.phone is OFF', async () => {
      mockUniquenessPolicy = { gst: true, phone: false, bank: false, upi: false }; // phone OFF
      primeGroupedCreate();
      mockTx.channelPartner.findMany.mockResolvedValue([]);
      await service.create(so, { ...groupedDto } as never);
      // With phone uniqueness disabled, the partner-clash PHONE query is never issued. (Other
      // channelPartner.findFirst reads DO run for the group document carry-forward via
      // resolveGroupIdentity — those are keyed on id/kycSubmissions, never on a `phone` filter.)
      const phoneClashCalls = mockPrisma.channelPartner.findFirst.mock.calls.filter(
        (c: any) => c[0]?.where && 'phone' in c[0].where,
      );
      expect(phoneClashCalls).toHaveLength(0);
    });

    it('ungrouped outlet keeps STRICT phone uniqueness — no NOT filter', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeUngroupedCreate();
      mockTx.channelPartner.findMany.mockResolvedValue([]);
      await service.create(so, { ...groupedDto } as never);
      const where = mockPrisma.channelPartner.findFirst.mock.calls[0][0].where;
      expect(where.NOT).toBeUndefined(); // ungrouped → any clash blocks
    });

    // ── login-less sibling (userId=null) guard ────────────────────────────────────
    it('grouped sibling reusing an existing GROUP phone → login-less partner (userId=null), NO 2nd User', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeGroupedCreate();
      mockTx.channelPartner.findMany.mockResolvedValue([]); // clean identity
      // A User already carries this phone (the group's existing login).
      mockTx.user.findFirst.mockReset();
      mockTx.user.findFirst.mockResolvedValueOnce({ id: 'group-login' });
      // …and it belongs to a SAME-GROUP sibling → reuse it (login-less new partner).
      mockTx.channelPartner.findFirst.mockResolvedValueOnce({ id: 'sibling-cp' });
      await service.create(so, { ...groupedDto } as never);
      // No second User is created (User @@unique([clientId, phone])).
      expect(mockTx.user.create).not.toHaveBeenCalled();
      // The new partner is login-less.
      expect(mockTx.channelPartner.create.mock.calls[0][0].data.userId).toBeNull();
    });

    it('grouped outlet whose existing-phone User is NOT a same-group sibling → rejected', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeGroupedCreate();
      mockTx.channelPartner.findMany.mockResolvedValue([]);
      mockTx.user.findFirst.mockReset();
      mockTx.user.findFirst.mockResolvedValueOnce({ id: 'unrelated-login' });
      mockTx.channelPartner.findFirst.mockResolvedValueOnce(null); // no same-group sibling
      await expect(
        service.create(so, { ...groupedDto } as never),
      ).rejects.toThrow(/already registered to another account/i);
      expect(mockTx.channelPartner.create).not.toHaveBeenCalled();
    });

    // ── Fix-pass Stream 1: advisory lock + write-side normalization + groupId + F2 phone ──

    it('acquires the advisory lock BEFORE the uniqueness-check DB read (lock ordering)', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeGroupedCreate();
      mockTx.channelPartner.findMany.mockImplementation(async (args: any) =>
        args?.where?.partnerCode ? [] : [],
      );
      await service.create(so, { ...groupedDto, gstNumber: '29ABCDE1234F1Z5' } as never);
      // The lock (pg_advisory_xact_lock via $executeRaw) is taken, and its FIRST call precedes
      // the earliest channelPartner.findMany the uniqueness check / partner-create issues.
      expect(mockTx.$executeRaw).toHaveBeenCalled();
      const lockOrder = Math.min(...mockTx.$executeRaw.mock.invocationCallOrder);
      const readOrder = Math.min(...mockTx.channelPartner.findMany.mock.invocationCallOrder);
      expect(lockOrder).toBeLessThan(readOrder);
    });

    // ── GROUP DOCUMENT CARRY-FORWARD (grouped-child KYC inherits the source's GST cert / cheque) ──
    // A brand-new grouped child (parentId set, partnerId null) whose UNCHANGED GST / bank matches the
    // APPROVED group source inherits that source's approved GST certificate / cancelled cheque
    // server-side — the reviewer sees a complete, approved-provenance doc set even if the FE never
    // sent the inherited doc. A CHANGED gst/bank, a rep-uploaded doc, or UPI mode → no carry.
    const GROUP_SOURCE = {
      onboardedAt: new Date('2024-01-01T00:00:00.000Z'),
      businessName: 'Group Owner Co', ownerName: 'Group Owner',
      gstNumber: '29ABCDE1234F1Z5', panNumber: 'ABCDE1234F',
      bankName: 'HDFC', bankAccountNumber: '50100', bankAccountHolder: 'Group Owner',
      ifscCode: 'HDFC0001', upiId: 'owner@upi',
    };
    const SOURCE_DOCS = {
      documents: [
        { documentType: 'GST_CERTIFICATE', fileUrl: 'gu', fileKey: 'kyc/deoleo/SRC/gst.pdf', fileName: 'g.pdf', mimeType: 'application/pdf', fileSizeBytes: 11 },
        { documentType: 'CANCELLED_CHEQUE', fileUrl: 'cu', fileKey: 'kyc/deoleo/SRC/cheque.pdf', fileName: 'c.pdf', mimeType: 'application/pdf', fileSizeBytes: 22 },
      ],
    };
    /** Prime a grouped brand-new child + an APPROVED-parent group source carrying both carry-forward docs. */
    const primeCarryForward = (opts?: { requiredPaymentType?: string; sourceDocs?: unknown }) => {
      mockPrisma.outlet.findFirst.mockResolvedValueOnce({
        id: 'outlet-2', clientId: 'deoleo', partnerId: null, parentId: 'parent-1',
        outletCode: 'OUT-2', outletType: { code: 'SSS' },
        requiredPaymentType: opts?.requiredPaymentType ?? 'BANK',
      });
      // channelPartner.findFirst: 1st call = phone-clash (null); every call after = the APPROVED
      // group source read by resolveGroupIdentity (its parent branch → sourcePartnerId='parent-1').
      // channelPartner.findFirst order matches create()'s real call sequence when phone
      // uniqueness is enforced: (1) the phone-clash read in assertPhoneAvailable (runs BEFORE
      // the carry block) → null; (2+) resolveGroupIdentity's APPROVED-parent read → GROUP_SOURCE
      // (onboardedAt + details → parent branch → sourcePartnerId='parent-1').
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null);
      mockPrisma.channelPartner.findFirst.mockResolvedValue(GROUP_SOURCE);
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);
      mockTx.channelPartner.findMany.mockResolvedValue([]); // no uniqueness clash + free partnerCode
      // The carry tests assert a PAN (childPan != null is now required to inherit any doc). The in-tx
      // checkPanMatchesGroup → resolveGroupPan reads the group's canonical PAN off the parent here;
      // it must MATCH the asserted child PAN ('ABCDE1234F' = GROUP_SOURCE.panNumber) so create proceeds.
      mockTx.channelPartner.findUnique.mockResolvedValue({ panNumber: 'ABCDE1234F' });
      mockTx.user.findFirst.mockResolvedValueOnce(null);
      mockTx.user.create.mockResolvedValueOnce({ id: 'owner-2' });
      mockTx.channelPartner.create.mockResolvedValueOnce({ id: 'cp-2' });
      mockTx.outlet.update.mockResolvedValueOnce({});
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null);
      mockTx.kycSubmission.create.mockResolvedValueOnce({ id: 'sub-2' });
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
      mockPrisma.kycDocument.create.mockResolvedValue({});
      // resolveGroupCarryForwardDocs reads the source's approved submission docs (via this.prisma).
      mockPrisma.kycSubmission.findFirst.mockResolvedValue(opts?.sourceDocs ?? SOURCE_DOCS);
    };
    const createdDocs = (): Array<Record<string, unknown>> =>
      mockPrisma.kycDocument.create.mock.calls.map((c: any) => c[0].data);

    it('CARRIES FORWARD the group GST cert + cheque when GST + bank are UNCHANGED and no doc uploaded', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeCarryForward();
      // Unchanged GST + bank (matches GROUP_SOURCE) + asserted group PAN, no incoming documents.
      await service.create(so, { ...groupedDto, panNumber: 'ABCDE1234F', gstNumber: '29ABCDE1234F1Z5' } as never);
      const docs = createdDocs();
      const gst = docs.find((d) => d.documentType === 'GST_CERTIFICATE');
      expect(gst).toMatchObject({
        kycSubmissionId: 'sub-2', documentType: 'GST_CERTIFICATE',
        fileKey: 'kyc/deoleo/SRC/gst.pdf', status: 'PENDING',
      });
      const cheque = docs.find((d) => d.documentType === 'CANCELLED_CHEQUE');
      expect(cheque).toMatchObject({
        kycSubmissionId: 'sub-2', documentType: 'CANCELLED_CHEQUE',
        fileKey: 'kyc/deoleo/SRC/cheque.pdf', status: 'PENDING',
      });
    });

    it('REJECTS (child must upload its own) when the child CHANGED the GST number', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeCarryForward();
      // Child changed its GST away from the group WHILE the group HAS an approved cert and the rep
      // uploaded none → the cert cannot be inherited and the FE may have waived it → authoritative
      // reject BEFORE any write (no orphaned submission). The rep must upload the child's own cert.
      await expect(
        service.create(so, { ...groupedDto, panNumber: 'ABCDE1234F', gstNumber: '27ZZZZE1234F1Z5' } as never),
      ).rejects.toThrow(/GST certificate is required/i);
      expect(createdDocs().find((d) => d.documentType === 'GST_CERTIFICATE')).toBeUndefined();
    });

    it('child CHANGED the GST + uploads its OWN GST cert → succeeds, the rep’s cert is used (not carried)', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeCarryForward();
      // Escape hatch: a child that diverged from the group GST can still onboard by uploading its own
      // cert — providedTypes suppresses both the carry AND the authoritative "required" throw.
      await service.create(so, {
        ...groupedDto,
        panNumber: 'ABCDE1234F',
        gstNumber: '27ZZZZE1234F1Z5', // changed away from the group
        documents: [{ type: 'GST_CERTIFICATE', fileKey: 'kyc/deoleo/2026-06/child-gst.pdf' }],
      } as never);
      const gstCerts = createdDocs().filter((d) => d.documentType === 'GST_CERTIFICATE');
      expect(gstCerts).toHaveLength(1); // the rep’s own, NOT the group’s carried cert
      expect(gstCerts[0].fileKey).toBe('kyc/deoleo/2026-06/child-gst.pdf');
    });

    it('does NOT overwrite a rep-uploaded GST cert (providedTypes guard)', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeCarryForward();
      await service.create(so, {
        ...groupedDto,
        panNumber: 'ABCDE1234F',
        gstNumber: '29ABCDE1234F1Z5', // unchanged — but the rep uploaded their own cert
        documents: [{ type: 'GST_CERTIFICATE', fileKey: 'kyc/deoleo/2026-06/rep-gst.pdf' }],
      } as never);
      const gstCerts = createdDocs().filter((d) => d.documentType === 'GST_CERTIFICATE');
      expect(gstCerts).toHaveLength(1); // the rep's, not carried on top
      expect(gstCerts[0].fileKey).toBe('kyc/deoleo/2026-06/rep-gst.pdf');
    });

    it('REJECTS (child must upload its own) when the child CHANGED the bank account number', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeCarryForward();
      // GST kept unchanged (so no GST throw) but the bank account diverged WHILE the group HAS an
      // approved cheque and the rep uploaded none → the cheque cannot be inherited → authoritative
      // reject BEFORE any write. The rep must upload the child's own cancelled cheque.
      await expect(
        service.create(so, {
          ...groupedDto, panNumber: 'ABCDE1234F', gstNumber: '29ABCDE1234F1Z5', accountNumber: '99999', // different account
        } as never),
      ).rejects.toThrow(/Cancelled cheque is required/i);
      expect(createdDocs().find((d) => d.documentType === 'CANCELLED_CHEQUE')).toBeUndefined();
    });

    it('child CHANGED the bank + uploads its OWN cancelled cheque → succeeds', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeCarryForward();
      // Escape hatch: a child that diverged from the group bank can still onboard by uploading its own
      // cheque — providedTypes suppresses both the carry AND the authoritative "required" throw.
      await service.create(so, {
        ...groupedDto,
        panNumber: 'ABCDE1234F',
        gstNumber: '29ABCDE1234F1Z5', // unchanged → no GST throw (group GST cert still carries)
        accountNumber: '99999', // changed away from the group
        documents: [{ type: 'CANCELLED_CHEQUE', fileKey: 'kyc/deoleo/2026-06/child-cheque.pdf' }],
      } as never);
      const cheques = createdDocs().filter((d) => d.documentType === 'CANCELLED_CHEQUE');
      expect(cheques).toHaveLength(1); // the rep’s own, NOT the group’s carried cheque
      expect(cheques[0].fileKey).toBe('kyc/deoleo/2026-06/child-cheque.pdf');
    });

    it('does NOT carry the cheque in UPI mode (cheque is a bank-mode doc)', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      mockUpiEnabled = true;
      primeCarryForward({ requiredPaymentType: 'UPI' });
      await service.create(so, {
        ...groupedDto, panNumber: 'ABCDE1234F', gstNumber: '29ABCDE1234F1Z5', paymentMode: 'upi', upiId: 'child@upi',
      } as never);
      expect(createdDocs().find((d) => d.documentType === 'CANCELLED_CHEQUE')).toBeUndefined();
      mockUpiEnabled = false;
    });

    it('persists PAN/GST upper-cased + trimmed (write-side normalization, F5)', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeUngroupedCreate();
      mockTx.channelPartner.findMany.mockImplementation(async (args: any) =>
        args?.where?.partnerCode ? [] : [],
      );
      await service.create(so, {
        ...groupedDto,
        panNumber: '  abcde1234f  ',
        gstNumber: ' 29abcde1234f1z5 ',
      } as never);
      const data = mockTx.channelPartner.create.mock.calls[0][0].data;
      expect(data.panNumber).toBe('ABCDE1234F');
      expect(data.gstNumber).toBe('29ABCDE1234F1Z5');
    });

    it('sets groupId=parentId inline at partner-create for a grouped-before-KYC sibling', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeGroupedCreate();
      mockTx.channelPartner.findMany.mockResolvedValue([]);
      await service.create(so, { ...groupedDto } as never);
      expect(mockTx.channelPartner.create.mock.calls[0][0].data.groupId).toBe('parent-1');
    });

    it('sets groupId=null inline at partner-create for an ungrouped outlet', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeUngroupedCreate();
      mockTx.channelPartner.findMany.mockResolvedValue([]);
      await service.create(so, { ...groupedDto } as never);
      expect(mockTx.channelPartner.create.mock.calls[0][0].data.groupId).toBeNull();
    });

    it('a brand-new-outlet draft stores NO proposedPartner snapshot (undefined → NULL)', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeUngroupedCreate();
      mockTx.channelPartner.findMany.mockResolvedValue([]);
      await service.create(so, { ...groupedDto } as never);
      expect(mockTx.kycSubmission.create.mock.calls[0][0].data.proposedPartner).toBeUndefined();
    });

    it('sibling-login lookup matches by phone LAST-10 (F2), reusing the group login for a 91-prefixed variant', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeGroupedCreate();
      mockTx.channelPartner.findMany.mockResolvedValue([]);
      // An existing group login is found (by last-10) and belongs to a same-group sibling →
      // reused login-less; no 2nd User created.
      mockTx.user.findFirst.mockReset();
      mockTx.user.findFirst.mockResolvedValueOnce({ id: 'group-login' });
      mockTx.channelPartner.findFirst.mockResolvedValueOnce({ id: 'sibling-cp' });
      // 91-prefixed format variant of groupedDto.mobile ('9000000002').
      await service.create(so, { ...groupedDto, mobile: '919000000002' } as never);
      const where = mockTx.user.findFirst.mock.calls[0][0].where;
      expect(where.phone).toEqual({ endsWith: '9000000002' });
      // Deactivate-frees-phone: only an ACTIVE holder counts as a live login to reuse
      // (deletedAt:null is kept alongside the new status filter).
      expect(where.status).toBe('ACTIVE');
      expect(where.deletedAt).toBeNull();
      expect(mockTx.user.create).not.toHaveBeenCalled();
      expect(mockTx.channelPartner.create.mock.calls[0][0].data.userId).toBeNull();
    });

    it('re-KYC create STAGES the proposed patch on proposedPartner and does NOT overwrite the live partner', async () => {
      // Stage-at-approval model: a re-KYC never mutates the already-approved ChannelPartner at
      // draft time — the normalized proposed patch is staged on KycSubmission.proposedPartner and
      // applied to the partner only at Gifsy approval (applyBridgeOutcome).
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      mockPrisma.outlet.findFirst.mockResolvedValueOnce({
        id: 'outlet-9',
        clientId: 'deoleo',
        partnerId: 'cp-existing', // re-KYC branch
        parentId: null,
        outletCode: 'OUT-9',
        outletType: { code: 'SSS' },
        requiredPaymentType: 'BANK',
        reKycFlags: null,
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null); // phone-clash
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null); // employee-clash
      mockTx.channelPartner.findMany.mockResolvedValue([]); // early-UX group-uniqueness → no clash
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null);
      mockTx.kycSubmission.create.mockResolvedValueOnce({ id: 'sub-9' });
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
      mockPrisma.kycDocument.create.mockResolvedValue({});

      await service.create(so, {
        outletId: 'outlet-9',
        partnerName: 'Re Store',
        mobile: '9000000009',
        address: 'a',
        city: 'c',
        state: 's',
        pincode: '110001',
        gstNumber: '29ABCDE1234F1Z5',
        panNumber: 'abcde1234f',
        bankName: 'HDFC',
        accountNumber: '50100',
        ifscCode: 'HDFC0001',
        paymentMode: 'bank',
      } as never);

      // The live partner is NEVER updated (nor snapshot-read) at draft time, and the live outlet
      // address is NOT written either — it too is staged on proposedPartner for apply-at-approval.
      expect(mockTx.channelPartner.update).not.toHaveBeenCalled();
      expect(mockTx.outlet.update).not.toHaveBeenCalled();
      // The proposed patch is staged (normalized: PAN upper-cased) AND now carries the outlet address.
      const staged = mockTx.kycSubmission.create.mock.calls[0][0].data.proposedPartner;
      expect(staged).toMatchObject({
        gstNumber: '29ABCDE1234F1Z5',
        panNumber: 'ABCDE1234F',
        bankAccountNumber: '50100',
        paymentMode: 'bank',
        // Outlet address is now staged alongside the identity/payout fields (stage-at-approval).
        addressLine1: 'a',
        city: 'c',
        state: 's',
        pincode: '110001',
      });
    });

    // ── Safe-orphan reuse (HIGH fix): a PENDING_VERIFICATION owner-login left by the cleanup's
    //    partner hard-delete is REUSED for a fresh KYC on the same ungrouped outlet+phone. ──
    /** Prime an UNGROUPED partner-less create() where an existing User already holds the phone. */
    const primeUngroupedOrphanCreate = () => {
      mockPrisma.outlet.findFirst.mockResolvedValueOnce({
        id: 'outlet-2', clientId: 'deoleo', partnerId: null, parentId: null,
        outletCode: 'OUT-2', outletType: { code: 'SSS' }, requiredPaymentType: 'BANK',
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null); // phone partner-clash
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);      // employee-clash
      mockTx.channelPartner.findMany.mockResolvedValue([]);            // clean identity
      mockTx.channelPartner.create.mockResolvedValueOnce({ id: 'cp-2' });
      mockTx.outlet.update.mockResolvedValueOnce({});
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null);
      mockTx.kycSubmission.create.mockResolvedValueOnce({ id: 'sub-2' });
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
      mockPrisma.kycDocument.create.mockResolvedValue({});
    };

    it('REUSES a safe orphan owner-login (PENDING_VERIFICATION, owner role, no partner) — no 2nd User', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeUngroupedOrphanCreate();
      // An existing User holds this phone: PENDING_VERIFICATION, owner role, and owns NO partner
      // (its partner was hard-deleted by the 48h cleanup) → safe orphan → reuse it.
      mockTx.user.findFirst.mockResolvedValueOnce({ id: 'orphan-1', status: 'PENDING_VERIFICATION', role: 'SSS' });
      mockTx.channelPartner.findFirst.mockResolvedValueOnce(null); // owns no ChannelPartner
      mockTx.user.update.mockResolvedValueOnce({});

      await service.create(so, { ...groupedDto } as never);

      // No SECOND User created (User @@unique([clientId, phone])); the orphan is reused as owner.
      expect(mockTx.user.create).not.toHaveBeenCalled();
      expect(mockTx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'orphan-1' } }),
      );
      expect(mockTx.channelPartner.create.mock.calls[0][0].data.userId).toBe('orphan-1');
    });

    it('does NOT reuse a User that OWNS a partner (real different account) → rejects', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeUngroupedOrphanCreate();
      mockTx.user.findFirst.mockResolvedValueOnce({ id: 'live-1', status: 'PENDING_VERIFICATION', role: 'SSS' });
      mockTx.channelPartner.findFirst.mockResolvedValueOnce({ id: 'owned-cp' }); // owns a partner → NOT an orphan
      await expect(service.create(so, { ...groupedDto } as never)).rejects.toThrow(
        /already registered to another account/i,
      );
      expect(mockTx.user.create).not.toHaveBeenCalled();
      expect(mockTx.channelPartner.create).not.toHaveBeenCalled();
    });

    it('does NOT reuse a non-owner (e.g. admin) role User on the same phone → rejects', async () => {
      mockUniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };
      primeUngroupedOrphanCreate();
      // Right status but an ADMIN role → not an outlet-owner login → never repurposed (H1).
      mockTx.user.findFirst.mockResolvedValueOnce({ id: 'admin-1', status: 'PENDING_VERIFICATION', role: 'CLIENT_ADMIN' });
      await expect(service.create(so, { ...groupedDto } as never)).rejects.toThrow(
        /already registered to another account/i,
      );
      // Role gate short-circuits BEFORE the owns-a-partner read.
      expect(mockTx.channelPartner.findFirst).not.toHaveBeenCalled();
      expect(mockTx.user.create).not.toHaveBeenCalled();
    });
  });

  // ─── 48h STALE-DRAFT CLEANUP (partner-child owner groups) ────────────────────
  describe('cleanupStaleKycDrafts', () => {
    const OLD = new Date('2020-01-01T00:00:00.000Z'); // safely older than now - 48h

    /** A brand-new draft's throwaway partner with NO downstream data of any kind (provably fresh). */
    const freshPartner = (id: string) => ({
      id,
      wallets: [],
      kycSubmissions: [],
      redemptionOrders: [],
      payoutTransactions: [],
      leaderboardEntries: [],
    });

    it('deletes a brand-new stale draft AND its throwaway (fresh) partner', async () => {
      mockPrisma.kycSubmission.findMany
        .mockResolvedValueOnce([{ id: 'd1' }])
        .mockResolvedValue([]);
      mockTx.kycSubmission.findUnique.mockResolvedValueOnce({
        id: 'd1',
        status: 'DRAFT',
        partnerId: 'p1',
        proposedPartner: null, // brand-new (no staged re-KYC patch)
        createdAt: OLD,
      });
      mockTx.channelPartner.findUnique.mockResolvedValueOnce(freshPartner('p1'));
      mockTx.channelPartner.delete.mockResolvedValueOnce({});
      mockTx.kycSubmission.delete.mockResolvedValueOnce({});

      const res = await service.cleanupStaleKycDrafts();
      expect(mockTx.channelPartner.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
      expect(mockTx.kycSubmission.delete).toHaveBeenCalledWith({ where: { id: 'd1' } });
      expect(res).toEqual({ deletedDrafts: 1, deletedPartners: 1 });
    });

    it('re-KYC stale draft (proposedPartner present) → deletes ONLY the draft, partner untouched', async () => {
      // Stage-at-approval: the live partner was never overwritten at draft time, so there is nothing
      // to revert or delete — the abandoned re-KYC draft is simply dropped, partner left intact.
      mockPrisma.kycSubmission.findMany
        .mockResolvedValueOnce([{ id: 'd2' }])
        .mockResolvedValue([]);
      mockTx.kycSubmission.findUnique.mockResolvedValueOnce({
        id: 'd2',
        status: 'DRAFT',
        partnerId: 'p2',
        proposedPartner: { gstNumber: 'NEWGST', panNumber: 'NEWPAN' }, // staged re-KYC patch
        createdAt: OLD,
      });
      mockTx.kycSubmission.delete.mockResolvedValueOnce({});

      const res = await service.cleanupStaleKycDrafts();
      // The partner is NEVER loaded, updated, or deleted for a re-KYC draft.
      expect(mockTx.channelPartner.findUnique).not.toHaveBeenCalled();
      expect(mockTx.channelPartner.update).not.toHaveBeenCalled();
      expect(mockTx.channelPartner.delete).not.toHaveBeenCalled();
      expect(mockTx.kycSubmission.delete).toHaveBeenCalledWith({ where: { id: 'd2' } });
      expect(res).toEqual({ deletedDrafts: 1, deletedPartners: 0 });
    });

    it('leaves a draft that routed since listing (status no longer DRAFT) untouched', async () => {
      mockPrisma.kycSubmission.findMany
        .mockResolvedValueOnce([{ id: 'd3' }])
        .mockResolvedValue([]);
      mockTx.kycSubmission.findUnique.mockResolvedValueOnce({
        id: 'd3',
        status: 'PENDING_SO_APPROVAL',
        partnerId: 'p3',
        proposedPartner: null,
        createdAt: OLD,
      });

      const res = await service.cleanupStaleKycDrafts();
      expect(mockTx.kycSubmission.delete).not.toHaveBeenCalled();
      expect(mockTx.channelPartner.delete).not.toHaveBeenCalled();
      expect(res).toEqual({ deletedDrafts: 0, deletedPartners: 0 });
    });

    it('strengthened deleteSafe: a partner with a REDEMPTION ORDER is NOT deleted (draft still dropped)', async () => {
      mockPrisma.kycSubmission.findMany
        .mockResolvedValueOnce([{ id: 'd4' }])
        .mockResolvedValue([]);
      mockTx.kycSubmission.findUnique.mockResolvedValueOnce({
        id: 'd4',
        status: 'DRAFT',
        partnerId: 'p4',
        proposedPartner: null, // brand-new-shaped
        createdAt: OLD,
      });
      // Provably NOT fresh: a downstream redemption order exists → the partner became real → keep it.
      mockTx.channelPartner.findUnique.mockResolvedValueOnce({
        ...freshPartner('p4'),
        redemptionOrders: [{ id: 'ro-1' }],
      });
      mockTx.kycSubmission.delete.mockResolvedValueOnce({});

      const res = await service.cleanupStaleKycDrafts();
      expect(mockTx.channelPartner.delete).not.toHaveBeenCalled();
      expect(mockTx.kycSubmission.delete).toHaveBeenCalledWith({ where: { id: 'd4' } });
      expect(res).toEqual({ deletedDrafts: 1, deletedPartners: 0 });
    });

    it('strengthened deleteSafe: a partner with a REDEMPTION ORDER is NOT deleted', async () => {
      mockPrisma.kycSubmission.findMany
        .mockResolvedValueOnce([{ id: 'd5' }])
        .mockResolvedValue([]);
      mockTx.kycSubmission.findUnique.mockResolvedValueOnce({
        id: 'd5',
        status: 'DRAFT',
        partnerId: 'p5',
        proposedPartner: null,
        createdAt: OLD,
      });
      mockTx.channelPartner.findUnique.mockResolvedValueOnce({
        ...freshPartner('p5'),
        redemptionOrders: [{ id: 'ro-1' }],
      });
      mockTx.kycSubmission.delete.mockResolvedValueOnce({});

      const res = await service.cleanupStaleKycDrafts();
      expect(mockTx.channelPartner.delete).not.toHaveBeenCalled();
      expect(res).toEqual({ deletedDrafts: 1, deletedPartners: 0 });
    });
  });

  describe('KYC WhatsApp notifications (owner, tenant-gated)', () => {
    const isr: JwtPayload = { sub: 'isr1', role: 'SALES_ISR', clientId: 'deoleo', phone: '', name: '' };

    const baseDto = {
      outletId: 'outlet-1',
      partnerName: 'Acme Owner',
      mobile: '9000000001',
      address: '1 Main St',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
      bankName: 'HDFC',
      accountNumber: '50100',
      ifscCode: 'HDFC0001',
    };

    /** Fully prime a partner-less create() that resolves to SUBMITTED, for `clientId`. */
    const primeSubmit = (clientId: string) => {
      mockPrisma.outlet.findFirst.mockResolvedValueOnce({
        id: 'outlet-1',
        clientId,
        partnerId: null,
        outletCode: 'OUT-1',
        outletType: { code: 'SSS' },
        programName: 'Olive Oil',
        requiredPaymentType: 'BANK',
      });
      // assertPhoneAvailable: partner-clash null, employee-clash null → available.
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null);
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null); // employee-clash
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null); // routing → SUBMITTED
      mockTx.user.findFirst.mockResolvedValueOnce(null);
      mockTx.user.create.mockResolvedValueOnce({ id: 'owner-1' });
      mockTx.channelPartner.create.mockResolvedValueOnce({ id: 'cp-new' });
      mockTx.outlet.update.mockResolvedValueOnce({});
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null);
      mockTx.kycSubmission.create.mockResolvedValueOnce({
        id: 'sub1',
        submittedAt: new Date('2026-06-30T00:00:00Z'),
      });
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
    };

    it('SUBMIT create() does NOT send the WhatsApp — it is deferred to consent (post-OTP)', async () => {
      primeSubmit('deoleo');
      await service.create(isr, baseDto as never);
      // The "KYC submitted" WhatsApp must NOT fire before the outlet-owner OTP is verified.
      expect(mockMsg91.sendWhatsappTemplate).not.toHaveBeenCalled();
    });

    /** Prime a consent() happy path whose submission carries the WhatsApp owner + program. */
    const primeConsent = (clientId: string): JwtPayload => {
      mockPrisma.otpCode.findFirst.mockResolvedValueOnce({ id: 'o1', code: '123456', attempts: 0, maxAttempts: 3 });
      mockPrisma.otpCode.update.mockResolvedValueOnce({});
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 'sub1',
        status: 'DRAFT',
        userId: 'owner1',
        submittedAt: new Date('2026-06-30T00:00:00Z'),
        partner: { ownerName: 'Acme Owner', outlets: [{ name: 'Acme Store', programName: 'Olive Oil' }] },
      });
      mockPrisma.consentRecord.create.mockResolvedValueOnce({ id: 'cr1' });
      // The DRAFT path now routes after the OTP: resolveInitialRouting (→ SUBMITTED),
      // then the routing update + status-history writes.
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null); // resolveInitialRouting → SUBMITTED
      mockPrisma.kycSubmission.update.mockResolvedValueOnce({});
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
      return { sub: 'owner1', role: 'SALES_ISR', clientId, phone: '', name: '' };
    };

    it('CONSENT (deoleo): sends deoleo_kyc_submission to the owner mobile with [ownerName, date, program] AFTER the OTP verifies', async () => {
      const owner = primeConsent('deoleo');
      await service.consent(owner, { submissionId: 'sub1', mobile: '9000000001', otp: '123456' });

      expect(mockMsg91.sendWhatsappTemplate).toHaveBeenCalledTimes(1);
      const [phone, template, values] = mockMsg91.sendWhatsappTemplate.mock.calls[0];
      // Recipient = the just-verified consent mobile (the outlet owner's phone).
      expect(phone).toBe('9000000001');
      expect(template).toBe('deoleo_kyc_submission');
      // [ownerName, submission date (DD MMM YYYY), programName]
      expect(values[0]).toBe('Acme Owner');
      expect(values[1]).toMatch(/^\d{2} [A-Z][a-z]{2} \d{4}$/);
      expect(values[2]).toBe('Olive Oil');
    });

    it('CONSENT (unconfigured tenant clientb): does NOT send a WhatsApp', async () => {
      const owner = primeConsent('clientb');
      await service.consent(owner, { submissionId: 'sub1', mobile: '9000000001', otp: '123456' });
      expect(mockMsg91.sendWhatsappTemplate).not.toHaveBeenCalled();
    });

    it('CONSENT: a thrown sendWhatsappTemplate never fails the consent verification', async () => {
      const owner = primeConsent('deoleo');
      mockMsg91.sendWhatsappTemplate.mockRejectedValueOnce(new Error('MSG91 down'));
      const res = await service.consent(owner, { submissionId: 'sub1', mobile: '9000000001', otp: '123456' });
      expect(res).toMatchObject({ verified: true, submissionId: 'sub1' });
    });

    /** Seed an approve() happy path whose partner carries the WhatsApp owner fields. */
    const seedApproveWithOwner = () => {
      const partnerWithOwner = {
        userId: 'owner-9',
        clientId: 'deoleo',
        ownerName: 'Acme Owner',
        phone: '9000000001',
        outlets: [
          { id: 'outlet-1', isPrimary: true, deletedAt: null, reKycFlags: null, programName: 'Olive Oil' },
        ],
      };
      const row = {
        id: 's1',
        userId: 'user1',
        status: 'PENDING_GIFSY',
        partnerId: 'p1',
        user: { name: 'n', phone: 'p' },
        partner: partnerWithOwner,
      };
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(row);
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(row);
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce([]);
      mockTx.kycVerificationItem.updateMany.mockResolvedValueOnce({ count: 0 });
      mockTx.kycVerificationItem.createMany.mockResolvedValueOnce({ count: 7 });
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce(ALL_APPROVED);
      mockTx.kycSubmission.updateMany.mockResolvedValueOnce({ count: 1 });
      mockTx.wallet.findFirst.mockResolvedValueOnce(null);
      mockTx.wallet.create.mockResolvedValueOnce({ id: 'w1' });
      mockTx.user.update.mockResolvedValueOnce({});
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      mockTx.auditLog.create.mockResolvedValueOnce({});
    };

    it('APPROVE (deoleo): sends deoleo_kyc_approval to the owner mobile with [ownerName, program]', async () => {
      seedApproveWithOwner();
      await service.approve(gifsy, 's1');

      expect(mockMsg91.sendWhatsappTemplate).toHaveBeenCalledTimes(1);
      const [phone, template, values] = mockMsg91.sendWhatsappTemplate.mock.calls[0];
      expect(phone).toBe('9000000001');
      expect(template).toBe('deoleo_kyc_approval');
      expect(values).toEqual(['Acme Owner', 'Olive Oil']);
    });

    it('APPROVE: a thrown sendWhatsappTemplate never fails the KYC approval', async () => {
      seedApproveWithOwner();
      mockMsg91.sendWhatsappTemplate.mockRejectedValueOnce(new Error('MSG91 down'));
      const res = await service.approve(gifsy, 's1');
      expect(res).toEqual({ message: 'KYC approved successfully' });
    });

    /**
     * Seed an approve() happy path whose loaded outlet is `isPrimary: false` — the
     * REAL prod shape (outlets are created with isPrimary=false; only seed/test data
     * flags primary). Before the fix the load filtered on `isPrimary: true`, so this
     * outlet was excluded → outlets[]=[] → whatsappProgramName=null → blank message.
     * The load now orders `isPrimary desc, createdAt asc` (no isPrimary filter), so
     * the non-primary outlet resolves and carries its programName.
     */
    const seedApproveNonPrimaryOutlet = () => {
      const partnerWithOwner = {
        userId: 'owner-9',
        clientId: 'deoleo',
        ownerName: 'Acme Owner',
        phone: '9000000001',
        outlets: [
          { id: 'outlet-1', isPrimary: false, deletedAt: null, reKycFlags: null, programName: 'Wholesale' },
        ],
      };
      const row = {
        id: 's1',
        userId: 'user1',
        status: 'PENDING_GIFSY',
        partnerId: 'p1',
        user: { name: 'n', phone: 'p' },
        partner: partnerWithOwner,
      };
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(row);
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(row);
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce([]);
      mockTx.kycVerificationItem.updateMany.mockResolvedValueOnce({ count: 0 });
      mockTx.kycVerificationItem.createMany.mockResolvedValueOnce({ count: 7 });
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce(ALL_APPROVED);
      mockTx.kycSubmission.updateMany.mockResolvedValueOnce({ count: 1 });
      mockTx.wallet.findFirst.mockResolvedValueOnce(null);
      mockTx.wallet.create.mockResolvedValueOnce({ id: 'w1' });
      mockTx.user.update.mockResolvedValueOnce({});
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      mockTx.auditLog.create.mockResolvedValueOnce({});
    };

    it('APPROVE (regression): resolves whatsappProgramName from a NON-primary outlet (real prod shape)', async () => {
      seedApproveNonPrimaryOutlet();
      await service.approve(gifsy, 's1');

      // The approval WhatsApp must carry the outlet's real programName — not a blank.
      expect(mockMsg91.sendWhatsappTemplate).toHaveBeenCalledTimes(1);
      const [phone, template, values] = mockMsg91.sendWhatsappTemplate.mock.calls[0];
      expect(phone).toBe('9000000001');
      expect(template).toBe('deoleo_kyc_approval');
      // [ownerName, programName] — the 2nd body value must be the outlet's program.
      expect(values).toEqual(['Acme Owner', 'Wholesale']);
      expect(values[1]).toBe('Wholesale');
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
      expect(where).toEqual({
        user: { clientId: 'deoleo' },
        // DRAFT-visibility guard: hide any DRAFT not created by the caller.
        NOT: { AND: [{ status: 'DRAFT' }, { userId: { not: 'user1' } }] },
        userId: { in: ['user1'] },
      });
      // Security: the tab-count groupBy must ALSO carry the DRAFT guard, else the status-tab
      // counts would tally hidden drafts the caller can't see (audit-fixed, two-stage SLA).
      const groupWhere = mockPrisma.kycSubmission.groupBy.mock.calls[0][0].where;
      expect(groupWhere.NOT).toEqual({ AND: [{ status: 'DRAFT' }, { userId: { not: 'user1' } }] });
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
      expect(where).toEqual({
        user: { clientId: 'deoleo' },
        NOT: { AND: [{ status: 'DRAFT' }, { userId: { not: 'so1' } }] },
        userId: { in: ['so1', 'xsr1'] },
      });
    });

    it('lets a GIFSY admin filter by status', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      mockPrisma.kycSubmission.count.mockResolvedValue(0);
      mockPrisma.kycSubmission.groupBy.mockResolvedValue([]);
      await service.list(gifsy, { status: 'APPROVED' as never });
      const where = mockPrisma.kycSubmission.findMany.mock.calls[0][0].where;
      // GIFSY is the cross-tenant operator (#38) — no caller-tenant filter, all brands.
      // The DRAFT guard still applies (a tenant-wide admin has no own-drafts → sees none).
      expect(where).toEqual({
        status: 'APPROVED',
        NOT: { AND: [{ status: 'DRAFT' }, { userId: { not: 'admin1' } }] },
      });
    });

    it('keeps MIS_USER tenant-wide (NOT sales-subtree scoped) — read-only observer', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      mockPrisma.kycSubmission.count.mockResolvedValue(0);
      mockPrisma.kycSubmission.groupBy.mockResolvedValue([]);
      await service.list(mis, {});
      const where = mockPrisma.kycSubmission.findMany.mock.calls[0][0].where;
      expect(where).toEqual({
        user: { clientId: 'deoleo' },
        NOT: { AND: [{ status: 'DRAFT' }, { userId: { not: 'mis1' } }] },
      }); // no userId scoping
      expect(mockPrisma.salesUser.findFirst).not.toHaveBeenCalled(); // never resolves a subtree
    });

    it('surfaces an APPROVED submission whose outlet has reKycFlags as RE_KYC_REQUIRED (re-KYC upload)', async () => {
      // The admin re-KYC upload sets Outlet.reKycFlags but leaves the submission APPROVED
      // → the list must display RE_KYC_REQUIRED so it appears under the rep's Re-KYC filter.
      mockPrisma.salesUser.findFirst.mockResolvedValue(null); // partner → own only
      mockPrisma.kycSubmission.findMany.mockResolvedValue([
        { id: 's1', status: 'APPROVED', partner: { outlets: [{ id: 'o1', reKycFlags: { mobileNumber: true } }] } },
        { id: 's2', status: 'APPROVED', partner: { outlets: [{ id: 'o2', reKycFlags: null }] } },
      ]);
      mockPrisma.kycSubmission.count.mockResolvedValue(2);
      mockPrisma.kycSubmission.groupBy.mockResolvedValue([]);
      const res = await service.list(partner, {});
      expect(res.submissions[0].status).toBe('RE_KYC_REQUIRED'); // reKycFlags → override
      expect(res.submissions[1].status).toBe('APPROVED');        // no flags → unchanged
    });

    it('hides a DRAFT from another user but returns the caller’s OWN DRAFT (owner 2026-08-11)', async () => {
      // DRAFT is a WIP owned by its creator: the where-clause NOT guard excludes any DRAFT
      // whose submitter is not the caller, so an approver/manager queue never sees a foreign
      // draft, while the rep who started one still sees theirs (their userId matches user.sub).
      mockPrisma.salesUser.findFirst.mockResolvedValue(null); // partner → own only
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      mockPrisma.kycSubmission.count.mockResolvedValue(0);
      mockPrisma.kycSubmission.groupBy.mockResolvedValue([]);
      await service.list(partner, {}); // partner.sub === 'user1'
      const where = mockPrisma.kycSubmission.findMany.mock.calls[0][0].where;
      // The guard: a DRAFT AND submitted by someone other than the caller → excluded. A DRAFT
      // whose userId === 'user1' does NOT match (userId is NOT { not: user1 }) → returned.
      expect(where.NOT).toEqual({ AND: [{ status: 'DRAFT' }, { userId: { not: 'user1' } }] });
    });

    it('derives per-row gifsyEnteredAt = latest PENDING_GIFSY entry (ISO) and never leaks statusHistory', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue(null); // partner → own only
      mockPrisma.kycSubmission.findMany.mockResolvedValue([
        {
          id: 's1',
          status: 'PENDING_GIFSY',
          partner: null,
          // Two Gifsy entries (a bounce + re-entry): the LATEST wins. Rows carry toStatus
          // (the query selects it) so latestGifsyEntryMs's re-check passes.
          statusHistory: [
            { toStatus: 'PENDING_GIFSY', createdAt: new Date('2026-01-05T00:00:00Z') },
            { toStatus: 'PENDING_GIFSY', createdAt: new Date('2026-01-08T00:00:00Z') },
          ],
        },
        { id: 's2', status: 'SUBMITTED', partner: null, statusHistory: [] }, // never reached Gifsy
      ]);
      mockPrisma.kycSubmission.count.mockResolvedValue(2);
      mockPrisma.kycSubmission.groupBy.mockResolvedValue([]);

      const res = await service.list(partner, {});
      // s1: latest PENDING_GIFSY entry → ISO; s2: no entry → null.
      expect(res.submissions[0].gifsyEnteredAt).toBe('2026-01-08T00:00:00.000Z');
      expect(res.submissions[1].gifsyEnteredAt).toBeNull();
      // The raw history is an internal detail — it must NOT be surfaced on the response rows.
      expect((res.submissions[0] as Record<string, unknown>).statusHistory).toBeUndefined();
      // The Gifsy-stage query is included on the list read.
      const include = mockPrisma.kycSubmission.findMany.mock.calls[0][0].include;
      expect(include.statusHistory).toEqual({
        where: { toStatus: 'PENDING_GIFSY' },
        select: { toStatus: true, createdAt: true },
      });
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

    it('surfaces the primary outlet reKycFlags (20 booleans + remarks) on the detail payload', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'other', documents: [], statusHistory: [],
        partner: { outlets: [
          { id: 'o-sec', isPrimary: false, reKycFlags: null },
          { id: 'o-pri', isPrimary: true, reKycFlags: { mobileNumber: true, remarks: 'redo phone' } },
        ] },
      });
      const res = await service.getOne(mis, 's1');
      // Detail contract: detail.reKycFlags = the primary outlet's raw stored object.
      expect(res.submission.reKycFlags).toEqual({ mobileNumber: true, remarks: 'redo phone' });
    });

    it('F3: prefers the FLAGGED outlet over the primary when a SECONDARY is the one re-KYC\'d', async () => {
      // The primary has NO flags; a SECONDARY outlet carries the admin re-KYC request. getOne
      // must return the FLAGGED outlet's flags (agreeing with list()/deriveKycStatus, which use
      // "any outlet with flags"), NOT the primary's null — else the detail page would hide the
      // re-KYC banner/lock for a multi-outlet partner whose flagged outlet isn't the primary.
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'other', documents: [], statusHistory: [],
        partner: { outlets: [
          { id: 'o-pri', isPrimary: true, reKycFlags: null },
          { id: 'o-sec', isPrimary: false, reKycFlags: { gstCertificate: true, remarks: 'reupload GST' } },
        ] },
      });
      const res = await service.getOne(mis, 's1');
      expect(res.submission.reKycFlags).toEqual({ gstCertificate: true, remarks: 'reupload GST' });
    });

    it('reKycFlags is null when no outlet has a re-KYC request', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'other', documents: [], statusHistory: [],
        partner: { outlets: [{ id: 'o1', isPrimary: true, reKycFlags: null }] },
      });
      const res = await service.getOne(mis, 's1');
      expect(res.submission.reKycFlags).toBeNull();
    });

    it('reKycFlags is null when the submission has no partner/outlets', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'other', partner: null, documents: [], statusHistory: [],
      });
      const res = await service.getOne(mis, 's1');
      expect(res.submission.reKycFlags).toBeNull();
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

    it("surfaces the outlet owner's payouts (₹ + UTR) via the shared builder, scoped by outlet CODE", async () => {
      // Partner reads their OWN submission (where.userId = sub). Submission has a partner
      // + one outlet code → buildPayoutStatement unions its credit payouts into the ledger.
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1', userId: 'sss1', partnerId: 'p1',
        partner: { clientId: 'deoleo', businessName: 'B', phone: 'p', outlets: [{ outletCode: 'O1' }], wallets: [] },
      });
      mockPrisma.outlet.findMany.mockResolvedValueOnce([{ outletCode: 'O1' }]);
      mockPrisma.payoutTransaction.findMany.mockResolvedValueOnce([]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValueOnce([
        {
          id: 'ce1', period: '2026-05', fieldName: 'Visibility', amountPaise: 500000n,
          narration: 'note', status: 'PAID', utr: 'UTR123',
          paidAt: new Date('2026-05-10'), createdAt: new Date('2026-05-01'),
        },
      ]);
      const res = await service.ledger(sss, 's1');
      expect(res.payouts).toHaveLength(1);
      expect(res.payouts[0]).toMatchObject({
        id: 'ce1', payoutAmountPaise: 500000, utr: 'UTR123', status: 'PAID', kpiLabel: 'Visibility',
      });
      // Credit payouts MUST be keyed on the outlet CODE, not the Outlet PK.
      expect(mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0].where.outletId).toEqual({ in: ['O1'] });
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

    // ── field-name resolution from the CreditBatch rows JSON ──────────────────
    describe('credit field-name resolution', () => {
      const wt = (over: Partial<Record<string, unknown>>) => ({
        id: 'wt', createdAt: new Date('2026-01-01'), description: '',
        transactionType: 'CREDIT_BONUS', points: 100, balanceAfter: 100,
        referenceType: null, referenceId: null, ...over,
      });

      const seedWithTxs = (transactions: unknown[]) =>
        mockPrisma.kycSubmission.findFirst.mockResolvedValue({
          id: 's1', userId: 'sss1',
          partner: {
            clientId: 'deoleo', businessName: 'B', phone: 'p',
            outlets: [{ outletCode: 'OUT-1' }],
            wallets: [{ redeemablePoints: 0, lifetimeEarned: 0, lifetimeRedeemed: 0, transactions }],
          },
        });

      it('resolves fieldName from the batch row by amount when the narration is blank', async () => {
        seedWithTxs([
          wt({ id: 'c1', referenceType: 'CREDIT_BATCH', referenceId: 'b1', points: 300, description: '' }),
        ]);
        mockPrisma.creditBatch.findMany.mockResolvedValue([
          { id: 'b1', rows: [{ outletId: 'OUT-1', fieldName: 'Monthly Scheme', amount: 300, narration: '', awardType: 'POINTS' }] },
        ]);
        const res = await service.ledger(sss, 's1');
        const tx = res.transactions.find((t) => t.id === 'c1');
        expect(tx?.fieldName).toBe('Monthly Scheme');
        // Tenant-scoped batch query.
        expect(mockPrisma.creditBatch.findMany.mock.calls[0][0].where).toEqual({
          id: { in: ['b1'] }, clientId: 'deoleo',
        });
      });

      it('maps two same-amount rows 1:1 by consumption order (oldest→newest)', async () => {
        // transactions come newest-first; c-old was credited first (row A), c-new second (row B).
        seedWithTxs([
          wt({ id: 'c-new', createdAt: new Date('2026-01-02'), referenceType: 'CREDIT_BATCH', referenceId: 'b1', points: 50, description: '' }),
          wt({ id: 'c-old', createdAt: new Date('2026-01-01'), referenceType: 'CREDIT_BATCH', referenceId: 'b1', points: 50, description: '' }),
        ]);
        mockPrisma.creditBatch.findMany.mockResolvedValue([
          { id: 'b1', rows: [
            { outletId: 'OUT-1', fieldName: 'Field A', amount: 50, narration: '', awardType: 'POINTS' },
            { outletId: 'OUT-1', fieldName: 'Field B', amount: 50, narration: '', awardType: 'POINTS' },
          ] },
        ]);
        const res = await service.ledger(sss, 's1');
        expect(res.transactions.find((t) => t.id === 'c-old')?.fieldName).toBe('Field A');
        expect(res.transactions.find((t) => t.id === 'c-new')?.fieldName).toBe('Field B');
      });

      it('gives a redeem (non-credit) tx fieldName null', async () => {
        seedWithTxs([
          wt({ id: 'r1', transactionType: 'DEBIT_REDEMPTION', referenceType: 'REDEMPTION_ORDER', referenceId: 'ord1', points: -20 }),
        ]);
        const res = await service.ledger(sss, 's1');
        expect(res.transactions.find((t) => t.id === 'r1')?.fieldName).toBeNull();
        expect(mockPrisma.creditBatch.findMany).not.toHaveBeenCalled();
      });
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

    it('login-phone change on approval: syncs User.phone to the re-KYC number AND revokes the partner sessions', async () => {
      seedApproveHappyPath();
      // Re-KYC changed the partner's contact phone; the owner's login phone is still the old one.
      mockTx.channelPartner.findUnique.mockResolvedValueOnce({ phone: '9000088888' });
      mockTx.user.findUnique.mockResolvedValueOnce({ phone: '9000011111', clientId: 'deoleo' });
      mockTx.user.findFirst.mockResolvedValueOnce(null); // no other user holds the new number
      mockTx.userSession.updateMany.mockResolvedValueOnce({ count: 2 });

      await service.approve(gifsy, 's1');

      // Login identity moved to the new number on the SAME owner row.
      expect(mockTx.user.update).toHaveBeenCalledWith({
        where: { id: 'owner-9' },
        data: { status: 'ACTIVE', phone: '9000088888' },
      });
      // Old sessions revoked → forced re-login on the new number.
      const revokeArg = mockTx.userSession.updateMany.mock.calls[0][0];
      expect(revokeArg.where).toMatchObject({ userId: 'owner-9', revokedAt: null });
      expect(revokeArg.data.revokedAt).toBeInstanceOf(Date);
    });

    it('login-phone change skipped (no revoke) when the new number is already used by another account', async () => {
      seedApproveHappyPath();
      mockTx.channelPartner.findUnique.mockResolvedValueOnce({ phone: '9000088888' });
      mockTx.user.findUnique.mockResolvedValueOnce({ phone: '9000011111', clientId: 'deoleo' });
      mockTx.user.findFirst.mockResolvedValueOnce({ id: 'someone-else' }); // CLASH

      await service.approve(gifsy, 's1');

      // Login phone NOT changed (kept old), and sessions NOT revoked.
      expect(mockTx.user.update).toHaveBeenCalledWith({
        where: { id: 'owner-9' },
        data: { status: 'ACTIVE' },
      });
      expect(mockTx.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('item #2: on APPROVED, activates the partner\'s outlet(s) AND clears reKycFlags in the tx', async () => {
      seedApproveHappyPath();
      await service.approve(gifsy, 's1');
      // The outlet activation is a partner-scoped updateMany that excludes
      // soft-deleted and NOT_INTERESTED outlets, and CLEARS any re-KYC request
      // (F1 — else a re-KYC'd outlet stays RE_KYC_REQUIRED + locked forever post-approval).
      expect(mockTx.outlet.updateMany).toHaveBeenCalledWith({
        where: {
          partnerId: 'p1',
          deletedAt: null,
          // null-intent (the common case) OR explicitly-not-declined — Prisma's bare
          // `{not}` would exclude NULL rows (the approval no-op BLOCKER).
          OR: [{ kycIntent: null }, { kycIntent: { not: 'NOT_INTERESTED' } }],
        },
        data: {
          isActive: true,
          reactivatedAt: expect.any(Date),
          reKycFlags: Prisma.DbNull,
          // Approval un-parks: a PARKED outlet must not end up active-but-hidden.
          kycIntent: null,
          kycIntentBy: null,
          kycIntentAt: null,
        },
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

  // ─── RE-KYC APPLY AT APPROVAL (stage-at-approval model) ──────────────────────
  describe('approve — re-KYC proposedPartner apply', () => {
    const CURRENT_PHONE = '9000011111';

    /**
     * Seed approve() for a re-KYC where `proposedPartner` is staged on the submission. The apply
     * block runs inside applyBridgeOutcome BEFORE the login-phone-sync + wallet/activation.
     * `opts.appliedPhone` = what a fresh partnerRow read returns after the apply (drives login-sync).
     */
    const seedReKycApprove = (
      proposed: Record<string, unknown>,
      opts: { appliedPhone?: string } = {},
    ) => {
      const partner = {
        userId: 'owner-9',
        clientId: 'deoleo',
        isParent: false,
        ownerName: 'Old Owner',
        phone: CURRENT_PHONE,
        outlets: [{ id: 'outlet-1', isPrimary: true, deletedAt: null, parentId: null, reKycFlags: null }],
      };
      const subRow = {
        id: 's1', userId: 'user1', status: 'PENDING_GIFSY', partnerId: 'p1',
        proposedPartner: proposed, user: { name: 'n', phone: 'p' }, partner,
      };
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(subRow); // outer pre-tx load
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(subRow);     // in-tx re-assert
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce([]);
      mockTx.kycVerificationItem.updateMany.mockResolvedValueOnce({ count: 0 });
      mockTx.kycVerificationItem.createMany.mockResolvedValueOnce({ count: 7 });
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce(ALL_APPROVED);
      mockTx.kycSubmission.updateMany.mockResolvedValueOnce({ count: 1 }); // status flip wins
      // login-phone-sync reads (only consumed once the apply succeeds).
      mockTx.user.findUnique.mockResolvedValueOnce({ phone: CURRENT_PHONE, clientId: 'deoleo' });
      mockTx.channelPartner.findUnique.mockResolvedValueOnce({ phone: opts.appliedPhone ?? CURRENT_PHONE });
      mockTx.wallet.findFirst.mockResolvedValueOnce(null);
      mockTx.wallet.create.mockResolvedValueOnce({ id: 'w1' });
      mockTx.user.update.mockResolvedValueOnce({});
      mockTx.outlet.updateMany.mockResolvedValueOnce({ count: 1 });
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      mockTx.auditLog.create.mockResolvedValueOnce({});
    };

    it('APPLIES the proposed identity patch to the live partner at approval', async () => {
      seedReKycApprove({ gstNumber: '29ABCDE1234F1Z5', panNumber: 'ABCDE1234F', bankName: 'HDFC' });
      mockTx.channelPartner.findMany.mockResolvedValue([]); // group-uniqueness → clean
      mockTx.channelPartner.update.mockResolvedValueOnce({ id: 'p1' }); // the apply

      await service.approve(gifsy, 's1');

      // The ONE channelPartner.update is the apply of the proposed values onto the live partner.
      expect(mockTx.channelPartner.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: expect.objectContaining({
          gstNumber: '29ABCDE1234F1Z5',
          panNumber: 'ABCDE1234F',
          bankName: 'HDFC',
        }),
      });
    });

    it('APPLIES the staged outlet ADDRESS to the PRIMARY outlet at approval (same tx as the identity apply)', async () => {
      seedReKycApprove({ addressLine1: 'New Addr 42', city: 'Pune', state: 'MH', pincode: '411001' });
      mockTx.channelPartner.findMany.mockResolvedValue([]); // group-uniqueness → clean
      mockTx.channelPartner.update.mockResolvedValueOnce({ id: 'p1' }); // identity apply (no-op values)
      mockTx.outlet.update.mockResolvedValueOnce({}); // the address apply

      await service.approve(gifsy, 's1');

      // The staged address is written to the PRIMARY outlet (partner.outlets[0]) in the SAME tx.
      expect(mockTx.outlet.update).toHaveBeenCalledWith({
        where: { id: 'outlet-1' },
        data: { addressLine1: 'New Addr 42', city: 'Pune', state: 'MH', pincode: '411001' },
      });
    });

    it('does NOT write the outlet when the staged patch carries NO address fields (no no-op update)', async () => {
      seedReKycApprove({ gstNumber: '29ABCDE1234F1Z5' }); // identity-only re-KYC
      mockTx.channelPartner.findMany.mockResolvedValue([]);
      mockTx.channelPartner.update.mockResolvedValueOnce({ id: 'p1' });

      await service.approve(gifsy, 's1');

      // No address staged → the primary-outlet address write is skipped entirely.
      expect(mockTx.outlet.update).not.toHaveBeenCalled();
    });

    it('REJECTS approval on a group-uniqueness violation → partner untouched, no activation', async () => {
      // Stage BOTH a conflicting identity AND an address change so the "outlet untouched" assertion
      // below proves atomicity (the throw precedes the address apply), not just the empty-guard skip.
      seedReKycApprove({ gstNumber: '29ABCDE1234F1Z5', addressLine1: 'Rolled Back Addr', city: 'Nowhere' });
      // An outlet OUTSIDE the group already holds this GST → checkGroupUniqueness violation.
      mockTx.channelPartner.findMany.mockImplementation(async (args: any) =>
        args?.where?.partnerCode ? [] : [{ id: 'outsider', isParent: false, outlets: [{ parentId: null }] }],
      );

      await expect(service.approve(gifsy, 's1')).rejects.toBeInstanceOf(ConflictException);
      // The live partner is NEVER mutated, and activation never happened (tx rolled back).
      expect(mockTx.channelPartner.update).not.toHaveBeenCalled();
      // Atomic: the uniqueness check throws BEFORE the identity apply, so the staged address is
      // never written to the outlet either — a rollback leaves partner AND outlet untouched.
      expect(mockTx.outlet.update).not.toHaveBeenCalled();
      expect(mockTx.user.update).not.toHaveBeenCalled();
      expect(mockTx.wallet.create).not.toHaveBeenCalled();
      expect(mockNotifications.enqueue).not.toHaveBeenCalled();
    });

    it('re-KYC phone change to a number TAKEN since draft → approval fails cleanly, partner unchanged', async () => {
      seedReKycApprove({ phone: '9000088888' }); // proposed phone differs from CURRENT_PHONE
      // assertPhoneAvailable finds the new number already on another outlet → clean 400.
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({ businessName: 'Someone Else' });

      await expect(service.approve(gifsy, 's1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockTx.channelPartner.update).not.toHaveBeenCalled();
      expect(mockTx.user.update).not.toHaveBeenCalled();
      expect(mockNotifications.enqueue).not.toHaveBeenCalled();
    });

    it('re-KYC phone change to a FREE number → applied + login-phone-synced + sessions revoked', async () => {
      seedReKycApprove({ phone: '9000088888' }, { appliedPhone: '9000088888' });
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null); // assertPhoneAvailable: free
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);      // not an employee
      mockTx.channelPartner.findMany.mockResolvedValue([]);            // group-uniqueness clean
      mockTx.channelPartner.update.mockResolvedValueOnce({ id: 'p1' }); // apply
      mockTx.user.findFirst.mockResolvedValueOnce(null);               // login-sync: no other user holds it
      mockTx.userSession.updateMany.mockResolvedValueOnce({ count: 3 });

      await service.approve(gifsy, 's1');

      // Contact phone applied to the partner…
      expect(mockTx.channelPartner.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: expect.objectContaining({ phone: '9000088888' }),
      });
      // …and the login phone synced on the SAME owner row + old sessions revoked.
      expect(mockTx.user.update).toHaveBeenCalledWith({
        where: { id: 'owner-9' },
        data: { status: 'ACTIVE', phone: '9000088888' },
      });
      const revokeArg = mockTx.userSession.updateMany.mock.calls[0][0];
      expect(revokeArg.where).toMatchObject({ userId: 'owner-9', revokedAt: null });
      expect(revokeArg.data.revokedAt).toBeInstanceOf(Date);
      // Deactivate-frees-phone: the login-phone-sync clash lookup (the sole tx.user.findFirst on
      // this path) only counts an ACTIVE holder — a deactivated holder doesn't block the sync.
      const clashWhere = mockTx.user.findFirst.mock.calls[0][0].where;
      expect(clashWhere.status).toBe('ACTIVE');
      expect(clashWhere.deletedAt).toBeNull();
    });

    // ── Wave-4: group-LEAVE via re-KYC (Option A) at approval ────────────────────
    /**
     * Seed approve() for a GROUPED child re-KYC (primary outlet parentId `parent-1`). `groupPan` is
     * the group's canonical PAN (read off the parent by resolveGroupPan). A `proposed.panNumber` that
     * DIFFERS from `groupPan` is a DEPARTURE. Mirrors seedReKycApprove but ROUTES channelPartner
     * .findUnique by `where.id` (parent → group PAN; the partner `p1` → applied phone for login-sync)
     * so BOTH the departure detection and the login-phone read resolve correctly.
     */
    const seedGroupedReKycApprove = (proposed: Record<string, unknown>, groupPan: string) => {
      const partner = {
        userId: 'owner-9', clientId: 'deoleo', isParent: false,
        ownerName: 'Old Owner', phone: CURRENT_PHONE,
        outlets: [{ id: 'outlet-1', isPrimary: true, deletedAt: null, parentId: 'parent-1', reKycFlags: null }],
      };
      const subRow = {
        id: 's1', userId: 'user1', status: 'PENDING_GIFSY', partnerId: 'p1',
        proposedPartner: proposed, user: { name: 'n', phone: 'p' }, partner,
      };
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(subRow);
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(subRow);
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce([]);
      mockTx.kycVerificationItem.updateMany.mockResolvedValueOnce({ count: 0 });
      mockTx.kycVerificationItem.createMany.mockResolvedValueOnce({ count: 7 });
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce(ALL_APPROVED);
      mockTx.kycSubmission.updateMany.mockResolvedValueOnce({ count: 1 });
      // findUnique routed by id: parent → group PAN (resolveGroupPan); the partner → applied phone.
      mockTx.channelPartner.findUnique.mockImplementation(async (args: any) =>
        args?.where?.id === 'parent-1' ? { panNumber: groupPan } : { phone: CURRENT_PHONE },
      );
      mockTx.user.findUnique.mockResolvedValueOnce({ phone: CURRENT_PHONE, clientId: 'deoleo' });
      mockTx.wallet.findFirst.mockResolvedValueOnce(null);
      mockTx.wallet.create.mockResolvedValueOnce({ id: 'w1' });
      mockTx.user.update.mockResolvedValueOnce({});
      mockTx.outlet.update.mockResolvedValue({});     // detach (+ address, if any)
      mockTx.outlet.updateMany.mockResolvedValueOnce({ count: 1 });
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      mockTx.auditLog.create.mockResolvedValueOnce({});
    };

    it('DEPARTURE approval: proposed PAN != group PAN → applies identity AND clears outlet.parentId (same tx)', async () => {
      seedGroupedReKycApprove({ panNumber: 'NEWSTANDALONE9F', gstNumber: '29ABCDE1234F1Z5' }, 'GROUPPAN01F');
      mockTx.channelPartner.findMany.mockResolvedValue([]); // standalone uniqueness → no outside clash
      mockTx.channelPartner.update.mockResolvedValueOnce({ id: 'p1' });

      await service.approve(gifsy, 's1');

      // The new (standalone) identity is applied to the live partner…
      expect(mockTx.channelPartner.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: expect.objectContaining({ panNumber: 'NEWSTANDALONE9F', gstNumber: '29ABCDE1234F1Z5' }),
      });
      // …and the primary outlet is DETACHED from the group in the SAME tx (parentId → null). The
      // DB trigger clears groupId, so no manual groupId write is expected.
      expect(mockTx.outlet.update).toHaveBeenCalledWith({
        where: { id: 'outlet-1' },
        data: { parentId: null },
      });
    });

    it('DEPARTURE approval whose new PAN COLLIDES with an outside outlet → ConflictException, parentId NOT cleared', async () => {
      seedGroupedReKycApprove({ panNumber: 'TAKEN9F' }, 'GROUPPAN01F');
      // The proposed (standalone) PAN already belongs to an outlet OUTSIDE any group → violation.
      mockTx.channelPartner.findMany.mockImplementation(async (args: any) =>
        args?.where?.partnerCode ? [] : [{ id: 'outsider', isParent: false, outlets: [{ parentId: null }] }],
      );

      await expect(service.approve(gifsy, 's1')).rejects.toBeInstanceOf(ConflictException);
      // Atomic rollback: identity NOT applied AND the group detach NEVER runs (it is AFTER the check).
      expect(mockTx.channelPartner.update).not.toHaveBeenCalled();
      expect(mockTx.outlet.update).not.toHaveBeenCalledWith({
        where: { id: 'outlet-1' },
        data: { parentId: null },
      });
    });

    it('NON-departure grouped re-KYC (proposed PAN == group PAN) applies identity but leaves parentId INTACT', async () => {
      seedGroupedReKycApprove({ panNumber: 'GROUPPAN01F', bankName: 'HDFC' }, 'GROUPPAN01F');
      mockTx.channelPartner.findMany.mockResolvedValue([]); // in-group PAN match → clean
      mockTx.channelPartner.update.mockResolvedValueOnce({ id: 'p1' });

      await service.approve(gifsy, 's1');

      // Identity applied, but the outlet is NOT detached — the PAN still equals the group PAN.
      expect(mockTx.channelPartner.update).toHaveBeenCalled();
      expect(mockTx.outlet.update).not.toHaveBeenCalledWith({
        where: { id: 'outlet-1' },
        data: { parentId: null },
      });
    });

    // ── Wave-4 MED-1: a LOGIN-LESS departing sibling must get its own login ───────
    /**
     * Seed approve() for a LOGIN-LESS (userId=null) grouped sibling departing. Mirrors
     * seedGroupedReKycApprove but partner.userId=null and primes the login-provisioning reads:
     * the User-distinctness check (`tx.user.findFirst`), the standalone assertPhoneAvailable
     * (`this.prisma.channelPartner/salesUser.findFirst`), the outlet-type read, `user.create`, and
     * the userId-link `channelPartner.update`. `phoneTakenBy` non-null → the effective phone is
     * already held by a User (the shared group phone case) → the provisioning must fail-closed.
     */
    const seedLoginlessDepartureApprove = (
      proposed: Record<string, unknown>,
      opts: { groupPan?: string; phoneTakenBy?: { id: string } | null; partnerPhone?: string } = {},
    ) => {
      const groupPan = opts.groupPan ?? 'GROUPPAN01F';
      const partnerPhone = opts.partnerPhone ?? CURRENT_PHONE;
      const effectivePhone = (proposed.phone as string | undefined) ?? partnerPhone;
      const partner = {
        userId: null, // LOGIN-LESS sibling (reachable only via the group login's picker)
        clientId: 'deoleo', isParent: false,
        ownerName: 'Old Owner', phone: partnerPhone,
        outlets: [{ id: 'outlet-1', isPrimary: true, deletedAt: null, parentId: 'parent-1', reKycFlags: null }],
      };
      const subRow = {
        id: 's1', userId: 'user1', status: 'PENDING_GIFSY', partnerId: 'p1',
        proposedPartner: proposed, user: { name: 'n', phone: 'p' }, partner,
      };
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(subRow);
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(subRow);
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce([]);
      mockTx.kycVerificationItem.updateMany.mockResolvedValueOnce({ count: 0 });
      mockTx.kycVerificationItem.createMany.mockResolvedValueOnce({ count: 7 });
      mockTx.kycVerificationItem.findMany.mockResolvedValueOnce(ALL_APPROVED);
      mockTx.kycSubmission.updateMany.mockResolvedValueOnce({ count: 1 });
      mockTx.channelPartner.findMany.mockResolvedValue([]); // standalone uniqueness → clean
      // findUnique routed by id: parent → group PAN; the partner (login-sync) → effective phone.
      mockTx.channelPartner.findUnique.mockImplementation(async (args: any) =>
        args?.where?.id === 'parent-1' ? { panNumber: groupPan } : { phone: effectivePhone },
      );
      // Login-provisioning: the User @@unique distinctness check.
      mockTx.user.findFirst.mockResolvedValueOnce(opts.phoneTakenBy ?? null);
      // Standalone assertPhoneAvailable reads (this.prisma, outside the tx) — clean.
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      mockPrisma.salesUser.findFirst.mockResolvedValue(null);
      mockTx.outlet.findUnique.mockResolvedValueOnce({ outletType: { code: 'SSS' } });
      mockTx.user.create.mockResolvedValueOnce({ id: 'new-owner' });
      mockTx.channelPartner.update.mockResolvedValue({ id: 'p1' }); // identity apply + userId link
      mockTx.outlet.update.mockResolvedValue({}); // detach (+ address, if any)
      // login-sync (targets the newly-provisioned owner via the mutated in-memory partner.userId).
      mockTx.user.findUnique.mockResolvedValueOnce({ phone: effectivePhone, clientId: 'deoleo' });
      mockTx.wallet.findFirst.mockResolvedValueOnce(null);
      mockTx.wallet.create.mockResolvedValueOnce({ id: 'w1' });
      mockTx.user.update.mockResolvedValueOnce({});
      mockTx.outlet.updateMany.mockResolvedValueOnce({ count: 1 });
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      mockTx.auditLog.create.mockResolvedValueOnce({});
    };

    it('LOGIN-LESS sibling DEPARTURE with a distinct new phone → provisions its OWN login (userId set)', async () => {
      seedLoginlessDepartureApprove({ panNumber: 'NEWSTANDALONE9F', phone: '9000099999' });

      await service.approve(gifsy, 's1');

      // A new owner User is created ACTIVE on the distinct phone, with the outlet-type-derived role…
      expect(mockTx.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            clientId: 'deoleo', phone: '9000099999', role: 'SSS', status: 'ACTIVE',
          }),
        }),
      );
      // …and the departing partner is LINKED to it (channelPartner.userId set to the new login)…
      expect(mockTx.channelPartner.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { userId: 'new-owner' },
      });
      // …and the outlet is detached from the group in the same tx.
      expect(mockTx.outlet.update).toHaveBeenCalledWith({
        where: { id: 'outlet-1' },
        data: { parentId: null },
      });
      // Deactivate-frees-phone: the departing-shop phone-taken guard (first tx.user.findFirst)
      // only treats an ACTIVE holder as blocking — a deactivated holder's number is available.
      const phoneTakenWhere = mockTx.user.findFirst.mock.calls[0][0].where;
      expect(phoneTakenWhere.status).toBe('ACTIVE');
      expect(phoneTakenWhere.deletedAt).toBeNull();
    });

    it('LOGIN-LESS sibling DEPARTURE keeping the shared group phone → BLOCKED (no login possible), tx rolls back', async () => {
      // The effective (unchanged) contact phone is still held by the group's login User → giving this
      // departing shop its own login is impossible → fail-closed with the clear, actionable error.
      seedLoginlessDepartureApprove({ panNumber: 'NEWSTANDALONE9F' }, { phoneTakenBy: { id: 'group-login-user' } });

      await expect(service.approve(gifsy, 's1')).rejects.toBeInstanceOf(ConflictException);
      // No login provisioned and the outlet is NOT detached (whole approval rolled back).
      expect(mockTx.user.create).not.toHaveBeenCalled();
      expect(mockTx.channelPartner.update).not.toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { userId: expect.anything() },
      });
      expect(mockTx.outlet.update).not.toHaveBeenCalledWith({
        where: { id: 'outlet-1' },
        data: { parentId: null },
      });
    });

    it('OWN-LOGIN partner DEPARTURE → keeps its existing login (no new User, userId unchanged)', async () => {
      seedGroupedReKycApprove({ panNumber: 'NEWSTANDALONE9F' }, 'GROUPPAN01F'); // userId='owner-9'
      mockTx.channelPartner.findMany.mockResolvedValue([]);
      mockTx.channelPartner.update.mockResolvedValue({ id: 'p1' });

      await service.approve(gifsy, 's1');

      // An own-login partner is never re-provisioned: no User created and no userId re-link…
      expect(mockTx.user.create).not.toHaveBeenCalled();
      expect(mockTx.channelPartner.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: expect.anything() }) }),
      );
      // …but the outlet is still detached from the group.
      expect(mockTx.outlet.update).toHaveBeenCalledWith({
        where: { id: 'outlet-1' },
        data: { parentId: null },
      });
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
      // The KYC_APPROVED PUSH deep-links to a real authenticated route (a urless push → '/' → /auth/login).
      expect(mockNotifications.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'PUSH',
          variables: expect.objectContaining({ event: 'KYC_APPROVED', url: '/sales/kyc' }),
        }),
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

    it('regression: a field-scoped re-KYC succeeds (no 409) when the only outlet is NON-primary (real prod shape)', async () => {
      // Real prod outlets are isPrimary=false. The load now orders `isPrimary desc,
      // createdAt asc` (no isPrimary:true filter), so the non-primary outlet resolves
      // as outlets[0] → primaryOutlet is non-null → the fieldKeys path writes flags
      // instead of throwing the "no active outlet" 409.
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's-approved',
        userId: 'user1',
        status: 'APPROVED',
        user: { id: 'user1', name: 'Kumar', phone: '9000000001' },
        partner: {
          outlets: [{ id: 'outlet-np', isPrimary: false, reKycFlags: null }],
        },
      });
      mockTx.kycSubmission.update.mockResolvedValueOnce({});
      mockTx.outlet.update.mockResolvedValueOnce({});
      mockTx.kycStatusHistory.create.mockResolvedValueOnce({});
      mockTx.auditLog.create.mockResolvedValueOnce({});

      const res = await service.reKyc(gifsy, 's-approved', {
        reason: 'GST mismatch',
        fieldKeys: ['GST_VALIDATION'],
      });

      // No 409 → status flipped + flags written on the non-primary outlet.
      expect(res.newStatus).toBe('RE_KYC_REQUIRED');
      expect(mockTx.outlet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'outlet-np' },
          data: expect.objectContaining({
            reKycFlags: expect.objectContaining({ gstNumber: true }),
          }),
        }),
      );
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

    it('surfaces the re-KYC proposedPartner (full for Gifsy) alongside the current live partner', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's1',
        userId: 'user1',
        partner: fullPartner, // current (approved) live values
        proposedPartner: { gstNumber: 'NEWGST1234Z', panNumber: 'NEWPAN1234', bankAccountNumber: '999888777' },
        documents: [],
        statusHistory: [],
        user: { id: 'user1', name: 'Kumar', phone: '9000000001', role: 'RETAILER' },
      });
      const res = await service.getOne(gifsy, 's1') as { submission: { proposedPartner: Record<string, unknown> | null; partner: Record<string, unknown> | null } };
      // Current partner unchanged; proposed surfaced in full for a privileged (Gifsy) reviewer.
      expect(res.submission.partner?.gstNumber).toBe('27AABCU9603R1ZM');
      expect(res.submission.proposedPartner).toMatchObject({
        gstNumber: 'NEWGST1234Z',
        panNumber: 'NEWPAN1234',
        bankAccountNumber: '999888777',
      });
    });

    it('surfaces the staged OUTLET ADDRESS on proposedPartner (not PII-masked) alongside the current outlet address', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's1',
        userId: 'other',
        // Current (approved) outlet address lives on the live partner's primary outlet.
        partner: { ...fullPartner, outlets: [{ id: 'outlet-1', isPrimary: true, addressLine1: 'Old Addr 1', city: 'Mumbai', state: 'MH', pincode: '400058' }] },
        // Proposed re-KYC patch carries the new address (+ an identity field to prove masking still runs).
        proposedPartner: { addressLine1: 'New Addr 42', city: 'Pune', state: 'MH', pincode: '411001', panNumber: 'ABCDE1234F' },
        documents: [],
        statusHistory: [],
        user: { id: 'other', name: 'X', phone: '9', role: 'RETAILER' },
      });
      // A masked (MIS) reader: address passes through unchanged; PAN is still last-4 masked.
      const res = await service.getOne(mis, 's1') as {
        submission: {
          proposedPartner: Record<string, unknown> | null;
          partner: { outlets: Array<Record<string, unknown>> } | null;
        };
      };
      // Proposed address surfaced in full (not PII) for the reviewer to diff.
      expect(res.submission.proposedPartner).toMatchObject({
        addressLine1: 'New Addr 42', city: 'Pune', state: 'MH', pincode: '411001',
      });
      // Non-address PII on the proposed patch is still masked.
      expect(res.submission.proposedPartner?.panNumber).toBe('****234F');
      // The live outlet address is UNCHANGED (still the current/approved value) — the proposed
      // address lives only on proposedPartner.
      expect(res.submission.partner?.outlets[0].addressLine1).toBe('Old Addr 1');
    });

    it('MASKS the proposedPartner sensitive fields for a masked (non-owner, non-admin) reader', async () => {
      // A read-only MIS observer must not see full proposed PAN/GST/bank in the raw scalar either.
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce({
        id: 's1',
        userId: 'other',
        partner: fullPartner,
        proposedPartner: { gstNumber: '27AABCU9603R1ZM', panNumber: 'ABCDE1234F', bankAccountNumber: '123456789012' },
        documents: [],
        statusHistory: [],
        user: { id: 'other', name: 'X', phone: '9', role: 'RETAILER' },
      });
      const res = await service.getOne(mis, 's1') as { submission: { proposedPartner: Record<string, unknown> | null } };
      expect(res.submission.proposedPartner?.panNumber).toBe('****234F');
      expect(res.submission.proposedPartner?.gstNumber).toBe('****R1ZM');
      expect(res.submission.proposedPartner?.bankAccountNumber).toBe('****9012');
    });
  });

  // ── Stream C: "verified on parent" per-field signal in getOne() ───────────────
  describe('parentVerified (owner-group signal) in getOne()', () => {
    // A child outlet grouped-before-KYC (outlets[0].parentId set), with its CURRENT
    // (approved) identity/payout values on submission.partner.
    const childPartner = {
      id: 'child-p1',
      clientId: 'deoleo',
      businessName: 'Ravi Traders',
      ownerName: 'Ravi Kumar',
      phone: '9820011111',
      gstNumber: '27AABCU9603R1ZM',
      panNumber: 'ABCDE1234F',
      bankName: 'HDFC',
      bankAccountNumber: '123456789012',
      bankAccountHolder: 'Ravi Kumar',
      ifscCode: 'HDFC0000123',
      upiId: 'ravi@upi',
      outlets: [{ id: 'o1', isPrimary: true, parentId: 'parent-1', reKycFlags: null }],
    };
    const childSubmission = (partner: Record<string, unknown>) => ({
      id: 's1',
      userId: 'other', // non-owner reader path
      partnerId: 'child-p1',
      partner,
      documents: [],
      statusHistory: [],
      user: { id: 'other', name: 'Ravi', phone: '9820011111', role: 'RETAILER' },
    });

    it('marks a field TRUE when the child value equals the approved parent value (case/space-insensitive for PAN), FALSE when it differs', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(childSubmission(childPartner));
      // Approved parent: PAN matches (lower-cased → proves normalization), GST differs.
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({
        businessName: 'Ravi Traders',
        ownerName: 'Ravi Kumar',
        phone: '9820011111',
        gstNumber: 'DIFFERENTGST99',
        panNumber: '  abcde1234f  ',
        bankName: 'HDFC',
        bankAccountNumber: '123456789012',
        bankAccountHolder: 'Ravi Kumar',
        ifscCode: 'HDFC0000123',
        upiId: 'ravi@upi',
      });
      const res = (await service.getOne(mis, 's1')) as {
        submission: { parentVerified: Record<string, boolean> };
      };
      const pv = res.submission.parentVerified;
      expect(pv.panNumber).toBe(true); // normalized (upper+trim) equal
      expect(pv.gstNumber).toBe(false); // differs
      expect(pv.bankAccountNumber).toBe(true);
      expect(pv.ifscCode).toBe(true);
      expect(pv.upiId).toBe(true);
      expect(pv.businessName).toBe(true);
      expect(pv.ownerName).toBe(true);
      expect(pv.phone).toBe(true);
      // Fetched only an APPROVED parent, tenant-scoped to the child.
      const where = mockPrisma.channelPartner.findFirst.mock.calls[0][0].where;
      expect(where.id).toBe('parent-1');
      expect(where.clientId).toBe('deoleo');
      expect(where.isParent).toBe(true);
      expect(where.onboardedAt).toEqual({ not: null });
    });

    it('marks a field FALSE when either side is empty/absent', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(
        childSubmission({ ...childPartner, bankName: '' }), // child bankName empty
      );
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({
        businessName: 'Ravi Traders',
        ownerName: 'Ravi Kumar',
        phone: '9820011111',
        gstNumber: '27AABCU9603R1ZM',
        panNumber: 'ABCDE1234F',
        bankName: 'HDFC', // parent has it, child empty → false
        bankAccountNumber: '123456789012',
        bankAccountHolder: 'Ravi Kumar',
        ifscCode: 'HDFC0000123',
        upiId: null, // parent missing UPI → false even though child has one
      });
      const res = (await service.getOne(mis, 's1')) as {
        submission: { parentVerified: Record<string, boolean> };
      };
      expect(res.submission.parentVerified.bankName).toBe(false); // child empty
      expect(res.submission.parentVerified.upiId).toBe(false); // parent empty
      expect(res.submission.parentVerified.panNumber).toBe(true); // both present + equal (control)
    });

    it('computes correct booleans even when the reader is MASKED (compare runs pre-mask)', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(childSubmission(childPartner));
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({
        panNumber: 'ABCDE1234F',
        gstNumber: '27AABCU9603R1ZM',
        bankAccountNumber: '123456789012',
      });
      const res = (await service.getOne(mis, 's1')) as {
        submission: {
          partner: { panNumber: string; bankAccountNumber: string } | null;
          parentVerified: Record<string, boolean>;
        };
      };
      // The returned child PII is masked to last-4 for the MIS reader…
      expect(res.submission.partner?.panNumber).toBe('****234F');
      expect(res.submission.partner?.bankAccountNumber).toBe('****9012');
      // …yet the parent-verified booleans (computed on the RAW values) are still correct.
      expect(res.submission.parentVerified.panNumber).toBe(true);
      expect(res.submission.parentVerified.gstNumber).toBe(true);
      expect(res.submission.parentVerified.bankAccountNumber).toBe(true);
    });

    it('returns an all-false map and does NOT query for a parent when the outlet is ungrouped', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(
        childSubmission({
          ...childPartner,
          outlets: [{ id: 'o1', isPrimary: true, parentId: null, reKycFlags: null }],
        }),
      );
      const res = (await service.getOne(mis, 's1')) as {
        submission: { parentVerified: Record<string, boolean> };
      };
      expect(mockPrisma.channelPartner.findFirst).not.toHaveBeenCalled();
      const pv = res.submission.parentVerified;
      expect(Object.values(pv).every((v) => v === false)).toBe(true);
      expect(pv).toHaveProperty('panNumber', false);
      expect(pv).toHaveProperty('phone', false);
    });

    it('returns an all-false map when the parent exists but is NOT approved (query returns null)', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(childSubmission(childPartner));
      // The onboardedAt-filtered query finds no approved parent.
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null);
      const res = (await service.getOne(mis, 's1')) as {
        submission: { parentVerified: Record<string, boolean> };
      };
      expect(mockPrisma.channelPartner.findFirst).toHaveBeenCalledTimes(1);
      expect(res.submission.parentVerified.panNumber).toBe(false);
      expect(res.submission.parentVerified.gstNumber).toBe(false);
    });
  });

  // ── Wave-4: group-LEAVE via re-KYC — getOne preview flag ─────────────────────
  describe('willLeaveGroup (group-leave preview) in getOne()', () => {
    // A grouped child (primary outlet parentId set) with a STAGED re-KYC on proposedPartner.
    const groupedChildPartner = {
      id: 'child-p1', clientId: 'deoleo',
      businessName: 'Ravi Traders', ownerName: 'Ravi Kumar', phone: '9820011111',
      gstNumber: '27AABCU9603R1ZM', panNumber: 'GROUPPAN01F',
      bankName: 'HDFC', bankAccountNumber: '123456789012', bankAccountHolder: 'Ravi Kumar',
      ifscCode: 'HDFC0000123', upiId: 'ravi@upi',
      outlets: [{ id: 'o1', isPrimary: true, parentId: 'parent-1', reKycFlags: null }],
    };
    const submissionWith = (
      proposedPartner: unknown,
      partner: Record<string, unknown> = groupedChildPartner,
    ) => ({
      id: 's1', userId: 'other', partnerId: 'child-p1',
      partner, proposedPartner,
      documents: [], statusHistory: [],
      user: { id: 'other', name: 'Ravi', phone: '9820011111', role: 'RETAILER' },
    });

    it('is TRUE when the outlet is grouped and the proposed PAN differs from the group PAN', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(submissionWith({ panNumber: 'DIFFERENT9F' }));
      // resolveGroupPan reads the group's canonical PAN off the parent (findUnique by parentId).
      mockPrisma.channelPartner.findUnique.mockResolvedValue({ panNumber: 'GROUPPAN01F' });
      const res = (await service.getOne(mis, 's1')) as { submission: { willLeaveGroup: boolean } };
      expect(res.submission.willLeaveGroup).toBe(true);
    });

    it('is FALSE when the proposed PAN EQUALS the group PAN (non-departure re-KYC)', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(submissionWith({ panNumber: 'GROUPPAN01F' }));
      mockPrisma.channelPartner.findUnique.mockResolvedValue({ panNumber: 'GROUPPAN01F' });
      const res = (await service.getOne(mis, 's1')) as { submission: { willLeaveGroup: boolean } };
      expect(res.submission.willLeaveGroup).toBe(false);
    });

    it('is FALSE for an UNGROUPED outlet (no parentId) — never queries the group PAN', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(
        submissionWith({ panNumber: 'ANYTHING9F' }, {
          ...groupedChildPartner,
          outlets: [{ id: 'o1', isPrimary: true, parentId: null, reKycFlags: null }],
        }),
      );
      const res = (await service.getOne(mis, 's1')) as { submission: { willLeaveGroup: boolean } };
      expect(res.submission.willLeaveGroup).toBe(false);
      expect(mockPrisma.channelPartner.findUnique).not.toHaveBeenCalled();
    });

    it('is FALSE when there is NO proposedPartner (brand-new / non-re-KYC submission)', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(submissionWith(null));
      const res = (await service.getOne(mis, 's1')) as { submission: { willLeaveGroup: boolean } };
      expect(res.submission.willLeaveGroup).toBe(false);
    });

    it('ships ONLY the boolean — the group PAN never appears in the payload', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(submissionWith({ panNumber: 'DIFFERENT9F' }));
      // A distinctive sentinel group PAN that appears nowhere else in the fixture.
      mockPrisma.channelPartner.findUnique.mockResolvedValue({ panNumber: 'ZZLEAKSENTINEL9F' });
      const res = (await service.getOne(mis, 's1')) as { submission: Record<string, unknown> };
      expect(res.submission.willLeaveGroup).toBe(true);
      expect(JSON.stringify(res.submission)).not.toContain('ZZLEAKSENTINEL9F');
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

    it('an ASSUMED GIFSY operator scopes the review queue to the assumed tenant (no cross-tenant leak)', async () => {
      const assumedGifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '', assumed: true };
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([]);
      await service.reviewQueue(assumedGifsy);
      const where = mockPrisma.kycSubmission.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('PENDING_GIFSY');
      // assumed → pinned to the assumed clientId, not platform-wide.
      expect(where.user).toEqual({ clientId: 'deoleo' });
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

    it('re-KYC: OVERLAYS the staged proposedPartner values over the stale live partner', async () => {
      // Stage-at-approval: the live partner still holds OLD gst/pan; the PROPOSED values under
      // review live on proposedPartner. The reviewer queue must show what is being approved.
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([
        {
          id: 'SUB-Q-RK',
          boardPhotoLat: null,
          boardPhotoLng: null,
          proposedPartner: { gstNumber: 'NEWGST999', panNumber: 'NEWPAN999', upiId: 'new@upi', addressLine1: 'New Addr 42', city: 'Pune', state: 'MH', pincode: '411001' },
          user: { name: 'Owner A', phone: '9820100001', clientId: 'deoleo' },
          partner: {
            businessName: 'Kumar Store',
            ownerName: 'Kumar',
            phone: '9820100001',
            gstNumber: 'OLDGST000', // stale live value
            panNumber: 'OLDPAN000', // stale live value
            bankName: 'HDFC',
            bankAccountNumber: '50100',
            bankAccountHolder: 'Kumar',
            ifscCode: 'HDFC0001',
            upiId: null,
            paymentMode: 'bank',
            outlets: [{ outletCode: 'OUT-Q-RK', name: 'Kumar Store', addressLine1: 'x', addressLine2: null, city: 'M', state: 'MH', pincode: '400058', programName: 'Gold', outletType: { name: 'SSS' } }],
          },
          verificationItems: [],
        },
      ]);

      const result = await service.reviewQueue(gifsy);
      const entry = result.entries[0];
      // The reviewer sees the PROPOSED (pending-approval) identity, not the stale live values.
      expect(entry.gstNumber).toBe('NEWGST999');
      expect(entry.panNumber).toBe('NEWPAN999');
      expect(entry.upiId).toBe('new@upi');
      // ...AND the proposed ADDRESS (overlaid onto outlets[0]), not the stale 'x' — reviewer must
      // not approve an address change against the old address on the bulk/queue surface.
      expect(entry.address).toContain('New Addr 42');
      expect(entry.address).not.toContain('x');
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

  // ── Cross-tenant read boundary: the KYC tenant filter (A1). Feeds ~27 consumers. ──
  describe('kycTenantFilter (assumed-vs-unassumed)', () => {
    // Private; the returned where-fragment IS the whole cross-tenant contract.
    const kycTenantFilter = (u: JwtPayload) =>
      (service as unknown as { kycTenantFilter(user: JwtPayload): unknown }).kycTenantFilter(u);

    const clientAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };
    const assumedGifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '', assumed: true };

    it('(a) un-assumed GIFSY → {} (all tenants)', () => {
      expect(kycTenantFilter(gifsy)).toEqual({});
    });

    it('(b) ASSUMED GIFSY → { user: { clientId: <assumed> } } (scoped, no leak)', () => {
      expect(kycTenantFilter(assumedGifsy)).toEqual({ user: { clientId: 'deoleo' } });
    });

    it('(c) CLIENT_ADMIN → scoped to own clientId', () => {
      expect(kycTenantFilter(clientAdmin)).toEqual({ user: { clientId: 'deoleo' } });
    });
  });

  describe('notInterested', () => {
    it('is idempotent when the outlet is already marked', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue({
        id: 'outlet-cuid-1',
        isActive: false,
        kycIntent: 'NOT_INTERESTED',
      });
      const res = await service.notInterested(partner, { outletId: 'outlet-cuid-1' });
      expect(res).toEqual({ outletId: 'outlet-cuid-1', alreadyMarked: true });
      expect(mockPrisma.outlet.update).not.toHaveBeenCalled();
    });

    it('looks the outlet up by id + tenant (matches the FE contract), marks it NOT_INTERESTED', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue({ id: 'outlet-cuid-1', isActive: true, kycIntent: null });
      mockPrisma.outlet.update.mockResolvedValue({});
      await service.notInterested(partner, { outletId: 'outlet-cuid-1' });
      // The FE sends the Outlet CUID (o.id), so the lookup must be by id, tenant-scoped —
      // NOT clientId_outletCode (that 404'd on every call).
      const findArg = mockPrisma.outlet.findFirst.mock.calls[0][0];
      expect(findArg.where).toEqual({ id: 'outlet-cuid-1', clientId: 'deoleo' });
      const arg = mockPrisma.outlet.update.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'outlet-cuid-1' });
      expect(arg.data.isActive).toBe(false);
      expect(arg.data.kycIntent).toBe('NOT_INTERESTED');
    });

    it('404s when the outlet id is not in this tenant', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue(null);
      await expect(
        service.notInterested(partner, { outletId: 'nope' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.outlet.update).not.toHaveBeenCalled();
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

    // ── Two-stage SLA (owner 2026-08-11): field + gifsy targets, business-hours clock ──
    // The clock counts BUSINESS hours (Mon–Fri, weekends excluded). Two APPROVED submissions
    // from Thu 01 Jan 2026: one decided in 30 business hours (Thu→Fri, no weekend), one in 72
    // (Thu→Tue 06 Jan — the Sat/Sun are excluded, so 72 not 120). The END-TO-END approval
    // turnaround breach is measured against the GIFSY target (the decision-owning stage).
    const twoApprovals = [
      { createdAt: new Date('2026-01-01T00:00:00Z'), statusHistory: [{ createdAt: new Date('2026-01-02T06:00:00Z') }] }, // 30 business h
      { createdAt: new Date('2026-01-01T00:00:00Z'), statusHistory: [{ createdAt: new Date('2026-01-06T00:00:00Z') }] }, // 72 business h
    ];

    // Set both per-tenant targets via the single findMany the resolver issues.
    const setTargets = (fieldHrs: number, gifsyHrs: number) =>
      mockPrisma.programSetting.findMany.mockResolvedValue([
        { settingKey: 'fieldSlaTargetHours', settingValue: fieldHrs },
        { settingKey: 'gifsySlaTargetHours', settingValue: gifsyHrs },
      ]);

    it('resolves both per-tenant targets; approval turnaround breaches against the GIFSY target', async () => {
      setTargets(24, 96);
      mockPrisma.kycSubmission.findMany
        .mockResolvedValueOnce(twoApprovals) // APPROVED query
        .mockResolvedValueOnce([]); // pending query
      mockPrisma.kycStatusHistory.findMany.mockResolvedValue([]);

      const res = await service.slaMetrics(gifsy);
      expect(res.fieldSlaTargetHours).toBe(24);
      expect(res.gifsySlaTargetHours).toBe(96);
      expect(res.slaTargetHours).toBe(96); // legacy field mirrors the gifsy target
      // 30h + 72h both ≤ 96 → no approval breach, 100% compliance.
      expect(res.slaBreachCount).toBe(0);
      expect(res.slaComplianceRate).toBe(100);
      // Both targets read in ONE round-trip, tenant-scoped.
      expect(mockPrisma.programSetting.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            clientId: 'deoleo',
            settingKey: { in: ['fieldSlaTargetHours', 'gifsySlaTargetHours'] },
          },
        }),
      );
    });

    it('breaches the approval turnaround when the 72h decision exceeds a 48h gifsy target', async () => {
      setTargets(24, 48);
      mockPrisma.kycSubmission.findMany
        .mockResolvedValueOnce(twoApprovals)
        .mockResolvedValueOnce([]);
      mockPrisma.kycStatusHistory.findMany.mockResolvedValue([]);

      const res = await service.slaMetrics(gifsy);
      // 72h > 48h gifsy target → 1 breach; the 30h one is fine.
      expect(res.gifsySlaTargetHours).toBe(48);
      expect(res.slaBreachCount).toBe(1);
    });

    it('falls back to the stage defaults (24/96) when no rows exist, and ignores out-of-range values', async () => {
      // No rows → defaults; and an out-of-range pair (9999 / 0) is rejected → defaults kept.
      for (const rows of [[] as unknown[], [
        { settingKey: 'fieldSlaTargetHours', settingValue: 9999 },
        { settingKey: 'gifsySlaTargetHours', settingValue: 0 },
      ]]) {
        mockPrisma.programSetting.findMany.mockResolvedValueOnce(rows);
        mockPrisma.kycSubmission.findMany
          .mockResolvedValueOnce(twoApprovals)
          .mockResolvedValueOnce([]);
        mockPrisma.kycStatusHistory.findMany.mockResolvedValue([]);

        const res = await service.slaMetrics(gifsy);
        expect(res.fieldSlaTargetHours).toBe(24);
        expect(res.gifsySlaTargetHours).toBe(96);
        // 72h ≤ 96 default gifsy target → no approval breach.
        expect(res.slaBreachCount).toBe(0);
      }
    });

    it('drops DRAFT from the pending query and buckets pending rows by stage (field vs gifsy)', async () => {
      jest.useFakeTimers();
      // Fixed "now" = Fri 02 Jan 2026 06:00 UTC (a business day) so the pending ages are
      // deterministic — never anchored to real `now` (that would go flaky over time/weekends).
      jest.setSystemTime(new Date('2026-01-02T06:00:00Z'));
      try {
        setTargets(24, 96);
        const pending = [
          // Field stage: submitted Thu 01 00:00 → 24 (Thu) + 6 (Fri 00–06) = 30 business h → >24 field breach.
          {
            status: 'SUBMITTED',
            submittedAt: new Date('2026-01-01T00:00:00Z'),
            createdAt: new Date('2025-12-01T00:00:00Z'),
            statusHistory: [],
          },
          // Gifsy stage: LATEST PENDING_GIFSY entry Thu 01 00:00 (a bounce Dec 15 is older) → 30 business h → ≤96, no breach.
          {
            status: 'PENDING_GIFSY',
            submittedAt: new Date('2025-12-01T00:00:00Z'),
            createdAt: new Date('2025-12-01T00:00:00Z'),
            statusHistory: [
              { toStatus: 'PENDING_GIFSY', createdAt: new Date('2025-12-15T00:00:00Z') },
              { toStatus: 'PENDING_GIFSY', createdAt: new Date('2026-01-01T00:00:00Z') },
            ],
          },
        ];
        mockPrisma.kycSubmission.findMany
          .mockResolvedValueOnce([]) // APPROVED query (none)
          .mockResolvedValueOnce(pending); // pending query
        mockPrisma.kycStatusHistory.findMany.mockResolvedValue([]);

        const res = await service.slaMetrics(gifsy);

        // DRAFT is NOT in the pending status filter; the field statuses + PENDING_GIFSY are.
        const pendingWhere = mockPrisma.kycSubmission.findMany.mock.calls[1][0].where;
        expect(pendingWhere.status.in).not.toContain('DRAFT');
        expect(pendingWhere.status.in).toEqual(
          expect.arrayContaining(['SUBMITTED', 'PENDING_GIFSY']),
        );

        // Field stage: 1 pending, 30h > 24h target → breached, bucket 24-48h.
        expect(res.field.target).toBe(24);
        expect(res.field.pending).toBe(1);
        expect(res.field.breachCount).toBe(1);
        expect(res.field.aging['24-48h']).toBe(1);
        // Gifsy stage: 1 pending, 30h ≤ 96h → no breach, bucket 24-48h (aged from the LATEST entry).
        expect(res.gifsy.target).toBe(96);
        expect(res.gifsy.pending).toBe(1);
        expect(res.gifsy.breachCount).toBe(0);
        expect(res.gifsy.aging['24-48h']).toBe(1);
        // Combined (legacy) aging = both rows.
        expect(res.pendingAging['24-48h']).toBe(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('ages a field-stage pending row from createdAt when submittedAt is null', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-02T06:00:00Z'));
      try {
        setTargets(24, 96);
        const pending = [
          { status: 'UNDER_REVIEW', submittedAt: null, createdAt: new Date('2026-01-01T00:00:00Z'), statusHistory: [] }, // 30h
        ];
        mockPrisma.kycSubmission.findMany
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce(pending);
        mockPrisma.kycStatusHistory.findMany.mockResolvedValue([]);

        const res = await service.slaMetrics(gifsy);
        expect(res.field.pending).toBe(1);
        expect(res.field.breachCount).toBe(1); // 30h > 24h, aged from the createdAt fallback
      } finally {
        jest.useRealTimers();
      }
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

    it('creates a KYC_CONSENT OtpCode and sends it via MSG91 (global env template when unset)', async () => {
      const res = await service.sendConsentOtp(partner, dto);
      expect(res).toEqual({ success: true, expiresIn: 600 });
      const created = mockPrisma.otpCode.create.mock.calls[0][0].data;
      expect(created.purpose).toBe('KYC_CONSENT');
      expect(created.phone).toBe('7795096288');
      // 4th arg = resolved per-tenant template; undefined here → global env template.
      expect(mockMsg91.sendOtp).toHaveBeenCalledWith('7795096288', expect.any(String), 'SMS', undefined);
      expect(mockTenantSettings.getOtpTemplateId).toHaveBeenCalledWith('deoleo', 'kycConsent');
    });

    it('passes the per-tenant kycConsent template when one is configured', async () => {
      mockKycOtpTemplateId = 'kyc-tpl';
      await service.sendConsentOtp(partner, dto);
      expect(mockMsg91.sendOtp).toHaveBeenCalledWith('7795096288', expect.any(String), 'SMS', 'kyc-tpl');
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
