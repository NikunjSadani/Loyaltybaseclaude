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
import {
  canFirstApprove,
  nextStatusAfterFirstApprove,
  initialKycStatus,
  detectEscalation,
} from './kyc-approval.helper';

const mockTx = {
  kycSubmission: { update: jest.fn() },
  kycStatusHistory: { create: jest.fn() },
  auditLog: { create: jest.fn() },
  user: { update: jest.fn() },
  wallet: { findFirst: jest.fn(), create: jest.fn() },
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

describe('KycService', () => {
  let service: KycService;

  beforeEach(async () => {
    jest.clearAllMocks();
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

    it('initialKycStatus routes a SALES_SO submitter to the ASM approver', () => {
      expect(initialKycStatus('SALES_SO')).toBe('PENDING_ASM_APPROVAL');
    });

    it('initialKycStatus falls back to SUBMITTED for non-field roles', () => {
      expect(initialKycStatus('GIFSY_ADMIN')).toBe('SUBMITTED');
    });

    it('detectEscalation flags a skipped manager from the role:status key', () => {
      expect(detectEscalation('SALES_SO', 'PENDING_RSM_APPROVAL')).toBe('ASM');
      expect(detectEscalation('SALES_SO', 'PENDING_ASM_APPROVAL')).toBeNull();
    });
  });

  describe('create', () => {
    it('rejects a duplicate in-flight submission', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({ id: 'existing' });
      await expect(service.create(so, { partnerName: 'Acme', mobile: '9000000000', address: 'addr1', city: 'X', state: 'Y', pincode: '110011' } as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('creates a submission scoped to the caller and records history', async () => {
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

    it('forbids a non-admin from viewing someone else’s submission', async () => {
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

  describe('approve', () => {
    it('blocks approval unless the submission is PENDING_GIFSY', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_SO_APPROVAL',
        partnerId: 'p1',
        user: {},
      });
      await expect(service.approve(gifsy, 's1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('approves, activates the user, creates a wallet, and notifies', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        id: 's1',
        userId: 'user1',
        status: 'PENDING_GIFSY',
        partnerId: 'p1',
        user: { name: 'n', phone: 'p' },
      });
      mockTx.wallet.findFirst.mockResolvedValue(null);
      const res = await service.approve(gifsy, 's1');
      expect(res).toEqual({ message: 'KYC approved successfully' });
      expect(mockTx.user.update).toHaveBeenCalledWith({
        where: { id: 'user1' },
        data: { status: 'ACTIVE' },
      });
      expect(mockTx.wallet.create).toHaveBeenCalledWith({ data: { partnerId: 'p1' } });
      expect(mockNotifications.enqueue).toHaveBeenCalled();
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
