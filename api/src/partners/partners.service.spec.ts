// TDD: PartnersService

import { Test, TestingModule } from '@nestjs/testing';
import { PartnersService } from './partners.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';

const mockPrisma = {
  channelPartner: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  user:           { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  wallet:         { create: jest.fn(), findFirst: jest.fn() },
  partnerClassConfig: { findFirst: jest.fn(), findMany: jest.fn() },
  tierConfig:     { findFirst: jest.fn(), findMany: jest.fn() },
};

const mockPartner = {
  id: 'cp_1', clientId: 'deoleo', partnerCode: 'RT-001',
  businessName: 'Sharma General Store', ownerName: 'Amit Sharma',
  phone: '9876543210', isActive: true, deletedAt: null,
  totalEarnedPoints: 0,
};

describe('PartnersService', () => {
  let service: PartnersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnersService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<PartnersService>(PartnersService);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('createPartner', () => {
    it('should create partner and auto-create wallet', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user_1', clientId: 'deoleo' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null); // no duplicate
      mockPrisma.partnerClassConfig.findFirst.mockResolvedValue({ id: 'class_1', code: 'CP_01' });
      mockPrisma.channelPartner.create.mockResolvedValue(mockPartner);
      mockPrisma.wallet.create.mockResolvedValue({ id: 'wallet_1', partnerId: 'cp_1' });

      const result = await service.createPartner({
        clientId: 'deoleo', userId: 'user_1',
        partnerClassCode: 'CP_01', businessName: 'Sharma General Store',
        ownerName: 'Amit Sharma', phone: '9876543210',
      });

      expect(result.id).toBe('cp_1');
      expect(mockPrisma.wallet.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ partnerId: 'cp_1' }) }),
      );
    });

    it('should throw ConflictException if partner already exists for userId', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user_1', clientId: 'deoleo' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(mockPartner); // already exists
      await expect(service.createPartner({
        clientId: 'deoleo', userId: 'user_1', partnerClassCode: 'CP_01',
        businessName: 'Test', ownerName: 'Test', phone: '9876543210',
      })).rejects.toThrow(ConflictException);
    });
  });

  describe('findById', () => {
    it('should return partner with correct clientId', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(mockPartner);
      const result = await service.findById('cp_1', 'deoleo');
      expect(result.id).toBe('cp_1');
    });

    it('should throw NotFoundException for unknown partner', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      await expect(service.findById('cp_x', 'deoleo')).rejects.toThrow(NotFoundException);
    });

    it('should NOT return partner from different client', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      await expect(service.findById('cp_1', 'other-client')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.channelPartner.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ clientId: 'other-client' }) }),
      );
    });
  });

  describe('Partner code generation', () => {
    it('should generate unique partner code with class prefix', () => {
      const code = service.generatePartnerCode('CP_01', 'deoleo');
      expect(code).toMatch(/^RT-/); // CP_01 = Retailer prefix
    });

    it('should generate WS- prefix for CP_02 (Wholesaler)', () => {
      const code = service.generatePartnerCode('CP_02', 'deoleo');
      expect(code).toMatch(/^WS-/);
    });

    it('should generate SS- prefix for CP_03 (Sub-Stockist)', () => {
      const code = service.generatePartnerCode('CP_03', 'deoleo');
      expect(code).toMatch(/^SS-/);
    });
  });

  describe('Points and tier', () => {
    it('should award points correctly (1 point = 1 INR = 100 paise)', () => {
      // 500 paise = ₹5 = 5 points
      const points = service.paiseToPoints(500);
      expect(points).toBe(5);
    });

    it('should return 0 points for 0 paise', () => {
      expect(service.paiseToPoints(0)).toBe(0);
    });
  });
});
