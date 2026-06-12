// TDD: OutletsService
// Covers: create outlet, list by partner, primary outlet guard, soft delete

import { Test, TestingModule } from '@nestjs/testing';
import { OutletsService } from './outlets.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

const mockPrisma = {
  outlet:       { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
  outletType:   { findFirst: jest.fn() },
  channelPartner: { findFirst: jest.fn() },
};

const outletType = { id: 'ot_1', code: 'GT', name: 'General Trade', isActive: true };
const partner    = { id: 'cp_1', clientId: 'deoleo', isActive: true };

const outlet = {
  id: 'outlet_1', partnerId: 'cp_1', outletTypeId: 'ot_1',
  outletCode: 'GT-ABC123', name: 'Test Shop',
  addressLine1: '123 Main St', city: 'Mumbai', state: 'MH', pincode: '400001',
  isActive: true, isPrimary: true, deletedAt: null,
};

describe('OutletsService', () => {
  let service: OutletsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutletsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<OutletsService>(OutletsService);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(service).toBeDefined());

  // ── Create outlet ─────────────────────────────────────────────────────────

  describe('createOutlet', () => {
    it('should create an outlet for a valid partner and outlet type', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(partner);
      mockPrisma.outletType.findFirst.mockResolvedValue(outletType);
      mockPrisma.outlet.findFirst.mockResolvedValue(null); // no primary yet
      mockPrisma.outlet.create.mockResolvedValue(outlet);

      const result = await service.createOutlet({
        partnerId:    'cp_1',
        outletTypeId: 'ot_1',
        name:         'Test Shop',
        addressLine1: '123 Main St',
        city:         'Mumbai',
        state:        'MH',
        pincode:      '400001',
      });

      expect(result.outletCode).toBeDefined();
      expect(mockPrisma.outlet.create).toHaveBeenCalledTimes(1);
    });

    it('should auto-set isPrimary=true if this is the first outlet for the partner', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(partner);
      mockPrisma.outletType.findFirst.mockResolvedValue(outletType);
      mockPrisma.outlet.findFirst.mockResolvedValue(null); // no existing outlets
      mockPrisma.outlet.create.mockResolvedValue({ ...outlet, isPrimary: true });

      const result = await service.createOutlet({
        partnerId: 'cp_1', outletTypeId: 'ot_1', name: 'First Shop',
        addressLine1: '1 Rd', city: 'Delhi', state: 'DL', pincode: '110001',
      });

      expect(mockPrisma.outlet.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isPrimary: true }) }),
      );
    });

    it('should NOT auto-set isPrimary if partner already has a primary outlet', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(partner);
      mockPrisma.outletType.findFirst.mockResolvedValue(outletType);
      mockPrisma.outlet.findFirst.mockResolvedValue(outlet); // existing primary exists
      mockPrisma.outlet.create.mockResolvedValue({ ...outlet, id: 'outlet_2', isPrimary: false });

      await service.createOutlet({
        partnerId: 'cp_1', outletTypeId: 'ot_1', name: 'Second Shop',
        addressLine1: '2 Rd', city: 'Delhi', state: 'DL', pincode: '110001',
      });

      expect(mockPrisma.outlet.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isPrimary: false }) }),
      );
    });

    it('should throw NotFoundException if partner does not exist', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      await expect(
        service.createOutlet({ partnerId: 'bad', outletTypeId: 'ot_1', name: 'x', addressLine1: 'y', city: 'z', state: 'MH', pincode: '400001' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if outlet type does not exist', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(partner);
      mockPrisma.outletType.findFirst.mockResolvedValue(null);
      await expect(
        service.createOutlet({ partnerId: 'cp_1', outletTypeId: 'bad', name: 'x', addressLine1: 'y', city: 'z', state: 'MH', pincode: '400001' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── List outlets ──────────────────────────────────────────────────────────

  describe('listOutlets', () => {
    it('should return active outlets for a partner', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([outlet]);
      mockPrisma.outlet.count.mockResolvedValue(1);

      const result = await service.listOutlets({ partnerId: 'cp_1' });
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should exclude soft-deleted outlets', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      mockPrisma.outlet.count.mockResolvedValue(0);

      await service.listOutlets({ partnerId: 'cp_1' });

      expect(mockPrisma.outlet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null }),
        }),
      );
    });
  });

  // ── Soft delete ───────────────────────────────────────────────────────────

  describe('deleteOutlet', () => {
    it('should soft-delete a non-primary outlet', async () => {
      const nonPrimary = { ...outlet, isPrimary: false };
      mockPrisma.outlet.findFirst.mockResolvedValue(nonPrimary);
      mockPrisma.outlet.update.mockResolvedValue({ ...nonPrimary, deletedAt: new Date() });

      await service.deleteOutlet('outlet_1', 'cp_1');
      expect(mockPrisma.outlet.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
      );
    });

    it('should throw BadRequestException when trying to delete the primary outlet', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue(outlet); // isPrimary: true
      await expect(service.deleteOutlet('outlet_1', 'cp_1')).rejects.toThrow(BadRequestException);
    });
  });

  // ── Outlet code generation ────────────────────────────────────────────────

  describe('generateOutletCode', () => {
    it('should generate a code with the outlet type prefix', () => {
      const code = service.generateOutletCode('GT');
      expect(code).toMatch(/^GT-/);
      expect(code.length).toBeGreaterThan(4);
    });
  });
});
