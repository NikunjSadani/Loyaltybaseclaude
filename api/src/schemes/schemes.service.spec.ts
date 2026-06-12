// TDD: SchemesService
// Covers: create, activate, pause, expiry guard, eligibility check, points calculation

import { Test, TestingModule } from '@nestjs/testing';
import { SchemesService } from './schemes.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';

const mockPrisma = {
  scheme:           { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
  schemeRule:       { createMany: jest.fn(), findMany: jest.fn() },
  schemeEligibility:{ createMany: jest.fn(), findMany: jest.fn() },
  schemeEnrollment: { findFirst: jest.fn(), create: jest.fn(), count: jest.fn() },
  channelPartner:   { findFirst: jest.fn() },
};

const CLIENT = 'deoleo';

const activeScheme = {
  id: 'scheme_1', clientId: CLIENT, code: 'DEOLEO-Q1-2026',
  status: 'ACTIVE', schemeType: 'PURCHASE_INCENTIVE',
  startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'),
  pointsPerRupee: 1, fixedPoints: null, rewardType: 'POINTS',
  budgetPaise: null, spentPaise: 0, deletedAt: null,
};

describe('SchemesService', () => {
  let service: SchemesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchemesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<SchemesService>(SchemesService);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(service).toBeDefined());

  // ── Create scheme ─────────────────────────────────────────────────────────

  describe('createScheme', () => {
    it('should create a scheme in DRAFT status', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(null); // no code conflict
      mockPrisma.scheme.create.mockResolvedValue({ ...activeScheme, status: 'DRAFT' });

      const result = await service.createScheme({
        clientId:    CLIENT,
        code:        'DEOLEO-Q1-2026',
        name:        'Q1 2026 Purchase Incentive',
        schemeType:  'PURCHASE_INCENTIVE',
        rewardType:  'POINTS',
        startDate:   '2026-01-01',
        endDate:     '2026-12-31',
        pointsPerRupee: 1,
        createdByUserId: 'user_1',
      });

      expect(result.status).toBe('DRAFT');
    });

    it('should throw ConflictException if scheme code already exists for client', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(activeScheme); // conflict
      await expect(
        service.createScheme({ clientId: CLIENT, code: 'DEOLEO-Q1-2026', name: 'Duplicate', schemeType: 'PURCHASE_INCENTIVE', rewardType: 'POINTS', startDate: '2026-01-01', endDate: '2026-12-31' }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw BadRequestException if endDate is before startDate', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(null);
      await expect(
        service.createScheme({ clientId: CLIENT, code: 'BAD-DATES', name: 'Bad', schemeType: 'PURCHASE_INCENTIVE', rewardType: 'POINTS', startDate: '2026-12-31', endDate: '2026-01-01' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── Activate / pause ──────────────────────────────────────────────────────

  describe('activateScheme', () => {
    it('should change DRAFT → ACTIVE', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ ...activeScheme, status: 'DRAFT' });
      mockPrisma.scheme.update.mockResolvedValue({ ...activeScheme, status: 'ACTIVE' });

      const result = await service.activateScheme('scheme_1', CLIENT);
      expect(result.status).toBe('ACTIVE');
    });

    it('should throw if scheme is not in DRAFT or PAUSED', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ ...activeScheme, status: 'EXPIRED' });
      await expect(service.activateScheme('scheme_1', CLIENT)).rejects.toThrow(BadRequestException);
    });
  });

  describe('pauseScheme', () => {
    it('should change ACTIVE → PAUSED', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ ...activeScheme, status: 'ACTIVE' });
      mockPrisma.scheme.update.mockResolvedValue({ ...activeScheme, status: 'PAUSED' });

      const result = await service.pauseScheme('scheme_1', CLIENT);
      expect(result.status).toBe('PAUSED');
    });

    it('should throw if scheme is not ACTIVE', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ ...activeScheme, status: 'DRAFT' });
      await expect(service.pauseScheme('scheme_1', CLIENT)).rejects.toThrow(BadRequestException);
    });
  });

  // ── Eligibility check ─────────────────────────────────────────────────────

  describe('isPartnerEligible', () => {
    it('should return true for a partner with no eligibility restrictions', async () => {
      mockPrisma.schemeEligibility.findMany.mockResolvedValue([]); // no restrictions
      const eligible = await service.isPartnerEligible('scheme_1', 'cp_1', 'CP_01');
      expect(eligible).toBe(true);
    });

    it('should return true when partner class matches an inclusion rule', async () => {
      mockPrisma.schemeEligibility.findMany.mockResolvedValue([
        { partnerClassCode: 'CP_01', isExclusion: false, specificPartnerId: null },
      ]);
      const eligible = await service.isPartnerEligible('scheme_1', 'cp_1', 'CP_01');
      expect(eligible).toBe(true);
    });

    it('should return false when partner class is in an exclusion rule', async () => {
      mockPrisma.schemeEligibility.findMany.mockResolvedValue([
        { partnerClassCode: 'CP_01', isExclusion: true, specificPartnerId: null },
      ]);
      const eligible = await service.isPartnerEligible('scheme_1', 'cp_1', 'CP_01');
      expect(eligible).toBe(false);
    });

    it('should return false when a different class is included (implicit exclusion)', async () => {
      mockPrisma.schemeEligibility.findMany.mockResolvedValue([
        { partnerClassCode: 'CP_02', isExclusion: false, specificPartnerId: null },
      ]);
      // partner is CP_01, scheme includes only CP_02
      const eligible = await service.isPartnerEligible('scheme_1', 'cp_1', 'CP_01');
      expect(eligible).toBe(false);
    });
  });

  // ── Points calculation ────────────────────────────────────────────────────

  describe('calculateEarnedPoints', () => {
    it('should calculate points as floor(amountPaise / 100 * pointsPerRupee) for PURCHASE_INCENTIVE', () => {
      // ₹1,000 × 1 pt/₹ = 1,000 pts
      expect(service.calculateEarnedPoints(100_000, 1)).toBe(1000);
      // ₹1,000 × 1.5 pt/₹ = 1,500 pts
      expect(service.calculateEarnedPoints(100_000, 1.5)).toBe(1500);
      // ₹99 × 1 pt/₹ = 0 pts (floor — 0.99 pts)
      expect(service.calculateEarnedPoints(9_900, 1)).toBe(99);
    });

    it('should return fixedPoints when provided (overrides pointsPerRupee)', () => {
      expect(service.calculateEarnedPoints(100_000, 1, 500)).toBe(500);
    });

    it('should cap at maxPointsPerCycle if provided', () => {
      // ₹10,000 × 1 pt/₹ = 10,000 pts but capped at 500
      expect(service.calculateEarnedPoints(1_000_000, 1, undefined, 500)).toBe(500);
    });
  });

  // ── List schemes ──────────────────────────────────────────────────────────

  describe('listSchemes', () => {
    it('should return paginated schemes for a client', async () => {
      mockPrisma.scheme.findMany.mockResolvedValue([activeScheme]);
      mockPrisma.scheme.count.mockResolvedValue(1);

      const result = await service.listSchemes(CLIENT);
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });
});
