// TDD: SkusService
// Covers: create SKU, list with filters, soft delete, category mapping

import { Test, TestingModule } from '@nestjs/testing';
import { SkusService } from './skus.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConflictException, NotFoundException } from '@nestjs/common';

const mockPrisma = {
  sku:                { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
  skuCategoryMapping: { createMany: jest.fn(), deleteMany: jest.fn() },
  category:           { findFirst: jest.fn() },
};

const CLIENT = 'deoleo';

const sku = {
  id: 'sku_1', clientId: CLIENT, skuCode: 'DEO-OIL-500ML',
  name: 'Bertolli Olive Oil 500ml', brand: 'Bertolli',
  uom: 'ML', mrpPaise: 55000, isActive: true, deletedAt: null,
};

describe('SkusService', () => {
  let service: SkusService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SkusService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<SkusService>(SkusService);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(service).toBeDefined());

  // ── Create SKU ────────────────────────────────────────────────────────────

  describe('createSku', () => {
    it('should create a SKU with valid data', async () => {
      mockPrisma.sku.findFirst.mockResolvedValue(null); // no conflict
      mockPrisma.sku.create.mockResolvedValue(sku);

      const result = await service.createSku({
        clientId:   CLIENT,
        skuCode:    'DEO-OIL-500ML',
        name:       'Bertolli Olive Oil 500ml',
        brand:      'Bertolli',
        uom:        'ML',
        mrpPaise:   55000,
      });

      expect(result.skuCode).toBe('DEO-OIL-500ML');
      expect(mockPrisma.sku.create).toHaveBeenCalledTimes(1);
    });

    it('should throw ConflictException if skuCode already exists for client', async () => {
      mockPrisma.sku.findFirst.mockResolvedValue(sku);
      await expect(
        service.createSku({ clientId: CLIENT, skuCode: 'DEO-OIL-500ML', name: 'Duplicate', uom: 'ML', mrpPaise: 55000 }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── List SKUs ─────────────────────────────────────────────────────────────

  describe('listSkus', () => {
    it('should return paginated SKUs for a client', async () => {
      mockPrisma.sku.findMany.mockResolvedValue([sku]);
      mockPrisma.sku.count.mockResolvedValue(1);

      const result = await service.listSkus(CLIENT);
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should filter by brand when provided', async () => {
      mockPrisma.sku.findMany.mockResolvedValue([sku]);
      mockPrisma.sku.count.mockResolvedValue(1);

      await service.listSkus(CLIENT, { brand: 'Bertolli' });

      expect(mockPrisma.sku.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ brand: 'Bertolli' }),
        }),
      );
    });

    it('should exclude soft-deleted SKUs', async () => {
      mockPrisma.sku.findMany.mockResolvedValue([]);
      mockPrisma.sku.count.mockResolvedValue(0);

      await service.listSkus(CLIENT);

      expect(mockPrisma.sku.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null }),
        }),
      );
    });
  });

  // ── Find by code ──────────────────────────────────────────────────────────

  describe('findByCode', () => {
    it('should return a SKU by code and clientId', async () => {
      mockPrisma.sku.findFirst.mockResolvedValue(sku);
      const result = await service.findByCode('DEO-OIL-500ML', CLIENT);
      expect(result.id).toBe('sku_1');
    });

    it('should throw NotFoundException for unknown SKU code', async () => {
      mockPrisma.sku.findFirst.mockResolvedValue(null);
      await expect(service.findByCode('UNKNOWN', CLIENT)).rejects.toThrow(NotFoundException);
    });
  });

  // ── Soft delete ───────────────────────────────────────────────────────────

  describe('deleteSku', () => {
    it('should soft-delete a SKU', async () => {
      mockPrisma.sku.findFirst.mockResolvedValue(sku);
      mockPrisma.sku.update.mockResolvedValue({ ...sku, deletedAt: new Date() });

      await service.deleteSku('sku_1', CLIENT);

      expect(mockPrisma.sku.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deletedAt: expect.any(Date), isActive: false }),
        }),
      );
    });

    it('should throw NotFoundException for unknown SKU', async () => {
      mockPrisma.sku.findFirst.mockResolvedValue(null);
      await expect(service.deleteSku('bad_id', CLIENT)).rejects.toThrow(NotFoundException);
    });
  });
});
