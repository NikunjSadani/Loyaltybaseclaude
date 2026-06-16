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
import { KycService } from './kyc.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
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
  kycSubmission: { update: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
  kycVerificationItem: {
    upsert: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
    createMany: jest.fn(),
  },
  kycStatusHistory: { create: jest.fn() },
  auditLog: { create: jest.fn() },
  user: { update: jest.fn() },
  wallet: { findFirst: jest.fn(), create: jest.fn() },
  outlet: { update: jest.fn() },
};

const mockPrisma = {
  channelPartner: { findFirst: jest.fn(), update: jest.fn() },
  kycSubmission: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
  },
  kycStatusHistory: { create: jest.fn(), findMany: jest.fn() },
  kycDocument: { create: jest.fn() },
  otpCode: { findFirst: jest.fn(), update: jest.fn() },
  outlet: { findUnique: jest.fn(), update: jest.fn() },
  salesUser: { findFirst: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

const mockNotifications = { enqueue: jest.fn().mockResolvedValue({ id: 'n1' }) };

const mockStorage = {
  generateKey: jest.fn((folder: string, name: string) => `${folder}/2026-06/uuid-${name}`),
  uploadFile: jest.fn().mockResolvedValue('https://storage.googleapis.com/bucket/key'),
  getSignedUrl: jest.fn(),
  publicUrl: jest.fn((k: string) => `https://storage.googleapis.com/bucket/${k}`),
  deleteFile: jest.fn(),
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const so: JwtPayload = { sub: 'so1', role: 'SALES_SO', clientId: 'deoleo', phone: '', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' };

/** All-7-APPROVED items for the bridge */
const ALL_APPROVED = KYC_FIELD_KEYS.map((k) => ({ fieldKey: k, decision: 'APPROVED' as const }));

describe('KycService', () => {
  let service: KycService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // clearAllMocks does not drain mockResolvedValueOnce queues; reset the
    // salesUser mock explicitly so stale Once-values from prior tests don't bleed.
    mockPrisma.salesUser.findFirst.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: StorageService, useValue: mockStorage },
      ],
    }).compile();
    service = module.get(KycService);
  });

  describe('uploadDocument (GCS)', () => {
    const file = (size: number): Express.Multer.File =>
      ({ buffer: Buffer.from('x'), originalname: 'pan.jpg', mimetype: 'image/jpeg', size }) as Express.Multer.File;

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
  });

  describe('create() document references (tenant safety)', () => {
    const baseDto = {
      partnerName: 'Kumar Store',
      mobile: '9820100001',
      address: '12 SV Road',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400058',
    };

    const primeCreateMocks = () => {
      // resolveInitialRouting: no SalesUser → SUBMITTED (simplest case for doc tests)
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null);
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(null); // no in-flight dup
      mockPrisma.kycSubmission.create.mockResolvedValueOnce({ id: 'sub-1' });
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
  });

  describe('reviewDump (Lane A export)', () => {
    it('rejects a non-Gifsy caller', async () => {
      await expect(service.reviewDump(so)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('queries PENDING_GIFSY scoped to the tenant and returns an xlsx buffer', async () => {
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
      expect(where.user).toEqual({ clientId: 'deoleo' });
      expect(mockStorage.getSignedUrl).toHaveBeenCalledWith('key');
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
  // queries. The salesUser mock is called first (resolveInitialRouting), then the
  // rest of the create() pipeline (channelPartner, kycSubmission, etc.).

  describe('resolveInitialRouting (via create)', () => {
    /** Build a minimal SO-role submitter */
    const isr: JwtPayload = { sub: 'isr1', role: 'SALES_ISR', clientId: 'deoleo', phone: '', name: '' };

    const baseDto = {
      partnerName: 'Test Store',
      mobile: '9000000001',
      address: '1 Main St',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
    };

    /** Prime create() mocks after resolveInitialRouting resolves. */
    const primeCreate = () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null);
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(null);
      mockPrisma.kycSubmission.create.mockResolvedValueOnce({ id: 'sub-rt-1' });
      mockPrisma.kycStatusHistory.create.mockResolvedValueOnce({});
    };

    it('submitter with no SalesUser record → status SUBMITTED, escalatedFrom null', async () => {
      // resolveInitialRouting: no SalesUser → SUBMITTED
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);
      primeCreate();
      const res = await service.create(
        { sub: 'retail1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' },
        baseDto as never,
      );
      expect(res).toMatchObject({ status: 'SUBMITTED', escalatedFrom: null });
      // Confirm the salesUser query was tenant-scoped
      const suWhere = mockPrisma.salesUser.findFirst.mock.calls[0][0].where;
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
      primeCreate();
      const res = await service.create(isr, baseDto as never);
      expect(res).toMatchObject({ status: 'PENDING_SO_APPROVAL', escalatedFrom: null });
      // audit NIT-1: the per-hop manager lookup must ALSO be tenant-scoped, not just
      // the submitter lookup — guard the highest-value invariant of this change.
      expect(mockPrisma.salesUser.findFirst.mock.calls[1][0].where.clientId).toBe('deoleo');
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
      primeCreate();
      const res = await service.create(isr, baseDto as never);
      expect(res).toMatchObject({ status: 'PENDING_ASM_APPROVAL', escalatedFrom: 'SO' });
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
      primeCreate();
      const res = await service.create(isr, baseDto as never);
      expect(res).toMatchObject({ status: 'PENDING_ASM_APPROVAL', escalatedFrom: 'SO' });
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
      primeCreate();
      const res = await service.create(isr, baseDto as never);
      expect(res).toMatchObject({ status: 'PENDING_RSM_APPROVAL', escalatedFrom: 'SO' });
    });

    it('lookup is tenant-scoped (clientId in salesUser where clause)', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);
      primeCreate();
      await service.create(isr, baseDto as never);
      const suWhere = mockPrisma.salesUser.findFirst.mock.calls[0][0].where;
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
      primeCreate();
      const res = await service.create(isr, baseDto as never);
      expect(res.status).toBe('PENDING_RSM_APPROVAL');
    }, 5000);
  });

  describe('create', () => {
    it('rejects a duplicate in-flight submission', async () => {
      // resolveInitialRouting: SO has no SalesUser → SUBMITTED
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null);
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({ id: 'existing' });
      await expect(service.create(so, { partnerName: 'Acme', mobile: '9000000000', address: 'addr1', city: 'X', state: 'Y', pincode: '110011' } as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('creates a submission scoped to the caller and records history', async () => {
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
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      mockPrisma.kycSubmission.findFirst.mockResolvedValue(null);
      mockPrisma.kycSubmission.create.mockResolvedValue({ id: 'sub1' });
      mockPrisma.kycStatusHistory.create.mockResolvedValue({});
      const res = await service.create(so, {
        partnerName: 'Acme',
        mobile: '9000000000',
        address: 'addr1',
        city: 'X',
        state: 'Y',
        pincode: '110011',
      } as never);
      expect(res).toEqual({ submissionId: 'sub1', status: 'PENDING_ASM_APPROVAL', escalatedFrom: null });
      expect(mockPrisma.kycSubmission.create.mock.calls[0][0].data.userId).toBe('so1');
    });
  });

  describe('list', () => {
    it('scopes non-admin sales submitters to their own submissions', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      mockPrisma.kycSubmission.count.mockResolvedValue(0);
      mockPrisma.kycSubmission.groupBy.mockResolvedValue([]);
      await service.list(partner, {});
      const where = mockPrisma.kycSubmission.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ user: { clientId: 'deoleo' }, userId: 'user1' });
    });

    it('scopes a SALES_SO to PENDING_SO_APPROVAL within the tenant', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      mockPrisma.kycSubmission.count.mockResolvedValue(0);
      mockPrisma.kycSubmission.groupBy.mockResolvedValue([]);
      await service.list(so, {});
      const where = mockPrisma.kycSubmission.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ user: { clientId: 'deoleo' }, status: 'PENDING_SO_APPROVAL' });
    });

    it('lets a GIFSY admin filter by status', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      mockPrisma.kycSubmission.count.mockResolvedValue(0);
      mockPrisma.kycSubmission.groupBy.mockResolvedValue([]);
      await service.list(gifsy, { status: 'APPROVED' as never });
      const where = mockPrisma.kycSubmission.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ user: { clientId: 'deoleo' }, status: 'APPROVED' });
    });
  });

  describe('getOne', () => {
    it('throws NotFound when outside the tenant', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue(null);
      await expect(service.getOne(partner, 's1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it("forbids a non-admin from viewing someone else’s submission", async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({ id: 's1', userId: 'other' });
      await expect(service.getOne(partner, 's1')).rejects.toBeInstanceOf(ForbiddenException);
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

    it('transitions to PENDING_GIFSY and notifies the partner', async () => {
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

    it('approves, activates the user, creates a wallet, and enqueues notify post-tx', async () => {
      seedApproveHappyPath();
      const res = await service.approve(gifsy, 's1');
      expect(res).toEqual({ message: 'KYC approved successfully' });
      expect(mockTx.user.update).toHaveBeenCalledWith({
        where: { id: 'user1' },
        data: { status: 'ACTIVE' },
      });
      expect(mockTx.wallet.create).toHaveBeenCalledWith({ data: { partnerId: 'p1' } });
      // B1: notification enqueued via service.notify, not inside the tx
      expect(mockNotifications.enqueue).toHaveBeenCalled();
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

    it('tenant-scopes the in-tx re-assert (wrong tenant → ConflictException)', async () => {
      const otherTenant: JwtPayload = { sub: 'admin2', role: 'GIFSY_ADMIN', clientId: 'other', phone: '', name: '' };
      // The outer findFirst finds nothing (wrong tenant)
      mockPrisma.kycSubmission.findFirst.mockResolvedValueOnce(null);
      await expect(service.approve(otherTenant, 's1')).rejects.toBeInstanceOf(NotFoundException);
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

    it('tenant-scopes the in-tx re-assert', async () => {
      // The in-tx findFirst must include user: { clientId } in the where clause
      mockTx.kycSubmission.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.verifyField(gifsy, 's1', { fieldKey: 'PAYMENT', decision: 'APPROVED' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      const whereArg = mockTx.kycSubmission.findFirst.mock.calls[0][0].where;
      expect(whereArg.user).toEqual({ clientId: 'deoleo' });
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
      const res = await service.consent(partner, {
        submissionId: 's1',
        mobile: '9000000000',
        otp: '123456',
      });
      expect(res).toEqual({ verified: true, submissionId: 's1' });
      expect(mockPrisma.otpCode.findFirst.mock.calls[0][0].where.purpose).toBe('KYC_CONSENT');
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
  });
});
