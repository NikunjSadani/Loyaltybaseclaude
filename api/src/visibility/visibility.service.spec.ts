// TDD — VisibilityService
// RED: all tests fail until visibility.service.ts is implemented.
//
// Covers:
//   V1: submitPhoto creates a DRAFT submission
//   V2: approveSubmission transitions to APPROVED and awards points (inside $transaction)
//   V3: rejectSubmission transitions to REJECTED with a reason
//   V4: listSubmissions returns paginated list filtered by status
//   VA1: createProgram creates with DRAFT status and correct clientId
//   VA2: updateProgram throws NotFoundException if program not found
//   VA3: listPrograms returns paginated results

import { Test, TestingModule }              from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { VisibilityService }                from './visibility.service';
import { PrismaService }                    from '../prisma/prisma.service';

// ── Shared mock ───────────────────────────────────────────────────────────────

const mockPrisma = {
  $transaction: jest.fn().mockImplementation((fn: any) => fn(mockPrisma)),
  visibilitySubmission: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(),
                          findMany: jest.fn(), count: jest.fn() },
  visibilityApproval:   { create: jest.fn() },
  visibilityProgram:    { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(),
                          findMany: jest.fn(), count: jest.fn() },
  channelPartner:       { findFirst: jest.fn() },
  wallet:               { findFirst: jest.fn(), update: jest.fn() },
  walletTransaction:    { create: jest.fn() },
  pointsLedger:         { create: jest.fn() },
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const program = {
  id: 'prog_1', clientId: 'client_a', name: 'Q1 Visibility',
  status: 'ACTIVE', pointsPerSubmission: 50,
  startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'),
};

const partner  = { id: 'cp_1', userId: 'user_1' };
const wallet   = { id: 'w_1', partnerId: 'cp_1', redeemablePoints: 200 };
const outlet   = { id: 'outlet_1' };

const draftSubmission = {
  id: 'sub_1', programId: 'prog_1', partnerId: 'cp_1',
  outletId: 'outlet_1', status: 'DRAFT',
  imageUrls: ['https://cdn.gifsy.in/vis/test.jpg'],
};

// ─────────────────────────────────────────────────────────────────────────────

describe('VisibilityService', () => {
  let service: VisibilityService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VisibilityService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<VisibilityService>(VisibilityService);
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation((fn: any) => fn(mockPrisma));
  });

  it('should be defined', () => expect(service).toBeDefined());

  // ── Submit photo ──────────────────────────────────────────────────────────

  describe('submitPhoto', () => {
    it('V1: creates a DRAFT submission with the provided image URL', async () => {
      mockPrisma.visibilityProgram.findFirst.mockResolvedValue(program);
      mockPrisma.channelPartner.findFirst.mockResolvedValue(partner);
      mockPrisma.visibilitySubmission.create.mockResolvedValue(draftSubmission);

      const result = await service.submitPhoto('user_1', 'client_a', {
        programId: 'prog_1',
        outletId:  'outlet_1',
        imageUrl:  'https://cdn.gifsy.in/vis/test.jpg',
        latitude:  null,
        longitude: null,
      });

      expect(result.status).toBe('DRAFT');
      expect(mockPrisma.visibilitySubmission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            programId: 'prog_1',
            partnerId: 'cp_1',
            outletId:  'outlet_1',
            status:    'DRAFT',
          }),
        }),
      );
    });

    it('V1b: throws NotFoundException if visibility program not found', async () => {
      mockPrisma.visibilityProgram.findFirst.mockResolvedValue(null);

      await expect(
        service.submitPhoto('user_1', 'client_a', {
          programId: 'missing', outletId: 'outlet_1',
          imageUrl: 'https://cdn.gifsy.in/test.jpg', latitude: null, longitude: null,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Approve ───────────────────────────────────────────────────────────────

  describe('approveSubmission', () => {
    it('V2: transitions to APPROVED and awards points inside $transaction', async () => {
      mockPrisma.visibilitySubmission.findFirst.mockResolvedValue({
        ...draftSubmission, status: 'SUBMITTED', program,
      });
      mockPrisma.visibilitySubmission.update.mockResolvedValue({
        ...draftSubmission, status: 'APPROVED', pointsAwarded: 50,
      });
      mockPrisma.visibilityApproval.create.mockResolvedValue({});
      mockPrisma.wallet.findFirst.mockResolvedValue(wallet);
      mockPrisma.wallet.update.mockResolvedValue({
        ...wallet, redeemablePoints: 250,
      });
      mockPrisma.walletTransaction.create.mockResolvedValue({});
      mockPrisma.pointsLedger.create.mockResolvedValue({});

      const result = await service.approveSubmission('sub_1', 'reviewer_1', 'client_a');

      expect(result.status).toBe('APPROVED');
      expect(result.pointsAwarded).toBe(50);
      // All writes must be inside a transaction
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      // Points credited atomically
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            redeemablePoints: { increment: 50 },
            earnedPoints:     { increment: 50 },
            lifetimeEarned:   { increment: 50 },
          }),
        }),
      );
    });

    it('V2b: throws NotFoundException if submission not found', async () => {
      mockPrisma.visibilitySubmission.findFirst.mockResolvedValue(null);

      await expect(
        service.approveSubmission('missing_sub', 'reviewer_1', 'client_a'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Reject ────────────────────────────────────────────────────────────────

  describe('rejectSubmission', () => {
    it('V3: transitions to REJECTED with a reason', async () => {
      mockPrisma.visibilitySubmission.findFirst.mockResolvedValue({
        ...draftSubmission, status: 'SUBMITTED',
      });
      mockPrisma.visibilitySubmission.update.mockResolvedValue({
        ...draftSubmission, status: 'REJECTED',
        rejectionReason: 'Image unclear',
      });
      mockPrisma.visibilityApproval.create.mockResolvedValue({});

      const result = await service.rejectSubmission(
        'sub_1', 'reviewer_1', 'client_a', 'Image unclear',
      );

      expect(result.status).toBe('REJECTED');
      expect(mockPrisma.visibilitySubmission.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status:          'REJECTED',
            rejectionReason: 'Image unclear',
          }),
        }),
      );
    });
  });

  // ── List ──────────────────────────────────────────────────────────────────

  describe('listSubmissions', () => {
    it('V4: returns paginated list filtered by status', async () => {
      mockPrisma.visibilitySubmission.findMany.mockResolvedValue([draftSubmission]);
      mockPrisma.visibilitySubmission.count.mockResolvedValue(1);

      const result = await service.listSubmissions('client_a', { status: 'DRAFT', page: 1, limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  // ── Admin: Program management ─────────────────────────────────────────────

  describe('Admin programs', () => {
    const createDto = {
      code: 'VIS001', name: 'Q2 Visibility Drive',
      startDate: '2026-07-01', endDate: '2026-09-30',
      pointsPerSubmission: 75,
    };

    it('VA1: createProgram creates with DRAFT status and correct clientId', async () => {
      mockPrisma.visibilityProgram.create.mockResolvedValue({
        id: 'prg_new', clientId: 'client_a', status: 'DRAFT', ...createDto,
      });

      const result = await (service as any).createProgram('client_a', 'user_1', createDto);

      expect(result.status).toBe('DRAFT');
      expect(result.clientId).toBe('client_a');
      expect(mockPrisma.visibilityProgram.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ clientId: 'client_a', status: 'DRAFT' }),
        }),
      );
    });

    it('VA2: updateProgram throws NotFoundException if program not found', async () => {
      mockPrisma.visibilityProgram.findFirst.mockResolvedValue(null);

      await expect(
        (service as any).updateProgram('bad_id', 'client_a', { name: 'Updated' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('VA3: listPrograms returns paginated results', async () => {
      mockPrisma.visibilityProgram.findMany.mockResolvedValue([program]);
      mockPrisma.visibilityProgram.count.mockResolvedValue(1);

      const result = await (service as any).listPrograms('client_a', {});

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });
});
