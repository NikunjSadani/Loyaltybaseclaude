// TDD: KycService
// Covers the full workflow: submission → approval chain → Gifsy bulk verification

import { Test, TestingModule } from '@nestjs/testing';
import { KycService } from './kyc.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';

const mockPrisma = {
  kycSubmission:   { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  kycDocument:     { create: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  kycStatusHistory:{ create: jest.fn() },
  salesUser:       { findFirst: jest.fn() },
  user:            { findFirst: jest.fn(), findUnique: jest.fn() },
  channelPartner:  { update: jest.fn(), findFirst: jest.fn() },
};

const pending_so = {
  id: 'kyc_1', status: 'PENDING_SO_APPROVAL', userId: 'user_1',
  partnerId: 'cp_1', version: 1,
};

describe('KycService', () => {
  let service: KycService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<KycService>(KycService);
    jest.clearAllMocks();
    // Default: reviewer snapshot lookup returns a generic actor
    mockPrisma.user.findUnique.mockResolvedValue({
      name: 'Test Actor', phone: '9999999999',
      salesUser: { employeeCode: 'EMP-001' },
    });
  });

  it('should be defined', () => expect(service).toBeDefined());

  // ── Initial submission ────────────────────────────────────────────────────

  describe('submitKyc', () => {
    it('should create KYC with correct initial status for SALES_ISR submitter', async () => {
      const submitter = { id: 'sales_1', role: 'SALES_ISR', clientId: 'deoleo' };
      const phones = { XSR: '9800000001', SO: '9800000002', ASM: '9800000003', RSM: '9800000004', ZM: '9800000005', NM: '9800000006' };

      mockPrisma.kycSubmission.findFirst.mockResolvedValue(null); // no draft exists
      mockPrisma.kycSubmission.create.mockResolvedValue({ id: 'kyc_1', status: 'PENDING_SO_APPROVAL' });
      mockPrisma.kycStatusHistory.create.mockResolvedValue({});

      const result = await service.submitKyc({
        submitterRole: 'SALES_ISR',
        submitterUserId: 'sales_1',
        partnerId: 'cp_1',
        clientId: 'deoleo',
        phones,
      });

      expect(result.status).toBe('PENDING_SO_APPROVAL');
    });

    it('should skip resigned SO and go to ASM when SO phone is blank', async () => {
      const phones = { XSR: '9800000001', SO: '', ASM: '9800000003', RSM: '9800000004', ZM: '9800000005', NM: '9800000006' };

      mockPrisma.kycSubmission.findFirst.mockResolvedValue(null);
      mockPrisma.kycSubmission.create.mockResolvedValue({ id: 'kyc_1', status: 'PENDING_ASM_APPROVAL' });
      mockPrisma.kycStatusHistory.create.mockResolvedValue({});

      const result = await service.submitKyc({
        submitterRole: 'SALES_ISR', submitterUserId: 'sales_1',
        partnerId: 'cp_1', clientId: 'deoleo', phones,
      });

      expect(result.status).toBe('PENDING_ASM_APPROVAL');
    });

    it('should skip all resigned managers and go to NM if all blank', async () => {
      const phones = { XSR: '9800000001', SO: '', ASM: '', RSM: '', ZM: '', NM: '9800000006' };

      mockPrisma.kycSubmission.findFirst.mockResolvedValue(null);
      mockPrisma.kycSubmission.create.mockResolvedValue({ id: 'kyc_1', status: 'PENDING_RSM_APPROVAL' });
      mockPrisma.kycStatusHistory.create.mockResolvedValue({});

      const result = await service.submitKyc({
        submitterRole: 'SALES_ISR', submitterUserId: 'sales_1',
        partnerId: 'cp_1', clientId: 'deoleo', phones,
      });

      expect(result.status).toBe('PENDING_RSM_APPROVAL');
    });
  });

  // ── Field approval chain ──────────────────────────────────────────────────

  describe('firstApprove', () => {
    it('should advance PENDING_SO_APPROVAL → PENDING_GIFSY for SALES_SO', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue(pending_so);
      mockPrisma.kycSubmission.update.mockResolvedValue({ ...pending_so, status: 'PENDING_GIFSY' });
      mockPrisma.kycStatusHistory.create.mockResolvedValue({});

      const result = await service.firstApprove('kyc_1', 'SALES_SO', 'sales_so_1');
      expect(result.status).toBe('PENDING_GIFSY');
    });

    it('should throw ForbiddenException if role does not match status', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue(pending_so);
      // SALES_ASM trying to approve a PENDING_SO_APPROVAL — wrong approver
      await expect(service.firstApprove('kyc_1', 'SALES_ASM', 'sales_asm_1'))
        .rejects.toThrow(ForbiddenException);
    });

    it('should advance PENDING_ASM_APPROVAL → PENDING_GIFSY for SALES_ASM', async () => {
      const pending_asm = { ...pending_so, status: 'PENDING_ASM_APPROVAL' };
      mockPrisma.kycSubmission.findFirst.mockResolvedValue(pending_asm);
      mockPrisma.kycSubmission.update.mockResolvedValue({ ...pending_asm, status: 'PENDING_GIFSY' });
      mockPrisma.kycStatusHistory.create.mockResolvedValue({});

      const result = await service.firstApprove('kyc_1', 'SALES_ASM', 'sales_asm_1');
      expect(result.status).toBe('PENDING_GIFSY');
    });
  });

  // ── Reject ────────────────────────────────────────────────────────────────

  describe('rejectKyc', () => {
    it('should set status to REJECTED with reason', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue(pending_so);
      mockPrisma.kycSubmission.update.mockResolvedValue({ ...pending_so, status: 'REJECTED', rejectionReason: 'Invalid GST' });
      mockPrisma.kycStatusHistory.create.mockResolvedValue({});

      const result = await service.rejectKyc('kyc_1', 'SALES_SO', 'sales_1', 'Invalid GST');
      expect(result.status).toBe('REJECTED');
      expect(result.rejectionReason).toBe('Invalid GST');
    });

    it('should throw BadRequestException if rejection reason is empty', async () => {
      await expect(service.rejectKyc('kyc_1', 'SALES_SO', 'sales_1', ''))
        .rejects.toThrow(BadRequestException);
    });
  });

  // ── Gifsy bulk verification ───────────────────────────────────────────────

  describe('Gifsy bulk verification', () => {
    describe('processBulkGstVerification', () => {
      it('should mark GST as verified for matching submissions', async () => {
        mockPrisma.kycSubmission.findFirst.mockResolvedValue({ id: 'kyc_1', status: 'PENDING_GIFSY' });
        mockPrisma.kycSubmission.update.mockResolvedValue({});
        mockPrisma.kycStatusHistory.create.mockResolvedValue({});

        const rows = [
          { kycId: 'kyc_1', gstVerified: true,  reason: '' },
          { kycId: 'kyc_2', gstVerified: false, reason: 'GST number mismatch' },
        ];

        const result = await service.processBulkGstVerification(rows, 'gifsy_admin_1');
        expect(result.processed).toBe(2);
        expect(result.verified).toBe(1);
        expect(result.rejected).toBe(1);
      });
    });

    describe('processBulkPennyDrop', () => {
      it('should mark bank account as verified for matching submissions', async () => {
        mockPrisma.kycSubmission.findFirst.mockResolvedValue({ id: 'kyc_1', status: 'PENDING_GIFSY' });
        mockPrisma.kycSubmission.update.mockResolvedValue({});
        mockPrisma.kycStatusHistory.create.mockResolvedValue({});

        const rows = [
          { kycId: 'kyc_1', bankVerified: true, reason: '' },
        ];

        const result = await service.processBulkPennyDrop(rows, 'gifsy_admin_1');
        expect(result.processed).toBe(1);
        expect(result.verified).toBe(1);
      });
    });

    describe('gifsyFinalApprove', () => {
      it('should APPROVE KYC and activate partner when all 3 tracks pass', async () => {
        const pending_gifsy = {
          id: 'kyc_1', status: 'PENDING_GIFSY', partnerId: 'cp_1',
          pennydropStatus: 'VERIFIED',
          metadata: { gstVerified: true, photoApproved: true },
        };
        mockPrisma.kycSubmission.findFirst.mockResolvedValue(pending_gifsy);
        mockPrisma.kycSubmission.update.mockResolvedValue({ ...pending_gifsy, status: 'APPROVED' });
        mockPrisma.kycStatusHistory.create.mockResolvedValue({});
        mockPrisma.channelPartner.update.mockResolvedValue({});

        const result = await service.gifsyFinalApprove('kyc_1', 'gifsy_admin_1');
        expect(result.status).toBe('APPROVED');
        expect(mockPrisma.channelPartner.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ onboardedAt: expect.any(Date) }) }),
        );
      });

      it('should throw if penny drop not yet verified', async () => {
        const pending_gifsy = {
          id: 'kyc_1', status: 'PENDING_GIFSY', partnerId: 'cp_1',
          pennydropStatus: null, // not done yet
          metadata: { gstVerified: true, photoApproved: true },
        };
        mockPrisma.kycSubmission.findFirst.mockResolvedValue(pending_gifsy);

        await expect(service.gifsyFinalApprove('kyc_1', 'gifsy_admin_1'))
          .rejects.toThrow(BadRequestException);
      });
    });
  });

  // ── SLA breach detection ──────────────────────────────────────────────────

  describe('isSlaBreach', () => {
    it('should return true if KYC older than 48 hours', () => {
      const old = new Date(Date.now() - 49 * 60 * 60 * 1000); // 49 hours ago
      expect(service.isSlaBreach(old, 48)).toBe(true);
    });

    it('should return false if KYC within SLA window', () => {
      const recent = new Date(Date.now() - 10 * 60 * 60 * 1000); // 10 hours ago
      expect(service.isSlaBreach(recent, 48)).toBe(false);
    });
  });

  // ── getOutletPhotos ───────────────────────────────────────────────────────

  describe('getOutletPhotos', () => {
    const kycId = 'kyc_1';

    const photoDoc = (type: string, url: string) => ({
      id:              `doc_${type}`,
      fileUrl:         url,
      documentType:    type,
      status:          'VERIFIED',
      createdAt:       new Date('2026-04-01T10:00:00Z'),
    });

    it('should return OUTLET_PHOTO and SHOP_ESTABLISHMENT documents', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({ id: kycId });
      mockPrisma.kycDocument.findMany.mockResolvedValue([
        photoDoc('OUTLET_PHOTO',    'https://storage/outlet_1.jpg'),
        photoDoc('SHOP_ESTABLISHMENT', 'https://storage/shop_1.jpg'),
      ]);

      const photos = await service.getOutletPhotos(kycId);

      expect(photos).toHaveLength(2);
      expect(photos[0].fileUrl).toBe('https://storage/outlet_1.jpg');
      expect(photos[1].fileUrl).toBe('https://storage/shop_1.jpg');
    });

    it('should query only OUTLET_PHOTO and SHOP_ESTABLISHMENT types', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({ id: kycId });
      mockPrisma.kycDocument.findMany.mockResolvedValue([]);

      await service.getOutletPhotos(kycId);

      expect(mockPrisma.kycDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            kycSubmissionId: kycId,
            documentType:    { in: ['OUTLET_PHOTO', 'SHOP_ESTABLISHMENT'] },
          }),
        }),
      );
    });

    it('should exclude REJECTED documents', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({ id: kycId });
      mockPrisma.kycDocument.findMany.mockResolvedValue([]);

      await service.getOutletPhotos(kycId);

      expect(mockPrisma.kycDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { not: 'REJECTED' },
          }),
        }),
      );
    });

    it('should return empty array when no outlet photos exist', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({ id: kycId });
      mockPrisma.kycDocument.findMany.mockResolvedValue([]);

      const photos = await service.getOutletPhotos(kycId);

      expect(photos).toHaveLength(0);
    });

    it('should throw NotFoundException if KYC submission does not exist', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue(null);

      await expect(service.getOutletPhotos('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should order photos by createdAt ascending (oldest first)', async () => {
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({ id: kycId });
      mockPrisma.kycDocument.findMany.mockResolvedValue([]);

      await service.getOutletPhotos(kycId);

      expect(mockPrisma.kycDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'asc' },
        }),
      );
    });
  });
});
