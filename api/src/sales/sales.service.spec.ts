// TDD: SalesService
// Covers: upload creation, points-award row processing, duplicate detection

import { Test, TestingModule } from '@nestjs/testing';
import { SalesService } from './sales.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';

const mockPrisma = {
  salesUpload: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  outlet:      { findFirst: jest.fn() },
};

const mockWallet = {
  earnPoints:      jest.fn(),
  burnPoints:      jest.fn(),
  getBalance:      jest.fn(),
  getTransactions: jest.fn(),
};

const CLIENT = 'deoleo';
const USER   = 'user_admin_1';

describe('SalesService', () => {
  let service: SalesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SalesService,
        { provide: PrismaService,  useValue: mockPrisma  },
        { provide: WalletService,  useValue: mockWallet  },
      ],
    }).compile();
    service = module.get<SalesService>(SalesService);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(service).toBeDefined());

  // ── Create upload record ──────────────────────────────────────────────────

  describe('createUpload', () => {
    it('should create a SalesUpload record with PENDING status', async () => {
      mockPrisma.salesUpload.create.mockResolvedValue({
        id: 'upload_1', status: 'PENDING', clientId: CLIENT,
      });

      const result = await service.createUpload({
        clientId:         CLIENT,
        uploadedByUserId: USER,
        fileName:         'points_jul_2026.xlsx',
        fileUrl:          'https://storage.googleapis.com/gifsy/points_jul.xlsx',
        fileKey:          'sales/points_jul.xlsx',
      });

      expect(result.status).toBe('PENDING');
      expect(mockPrisma.salesUpload.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }),
      );
    });
  });

  // ── Process points-award rows ─────────────────────────────────────────────

  describe('processPointsAwardRows', () => {
    const outlet = { id: 'outlet_1', outletCode: 'OUT-001', partnerId: 'cp_1', isActive: true };

    const validRow = {
      outletCode:    'OUT-001',
      month:         '2026-07',
      parameterName: 'Soybean Oil',
      points:        150,
    };

    it('should credit wallet points for a valid row', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue(outlet);
      mockWallet.earnPoints.mockResolvedValue({ redeemablePoints: 150 });
      mockPrisma.salesUpload.update.mockResolvedValue({});

      const result = await service.processPointsAwardRows(CLIENT, 'upload_1', [validRow]);

      expect(result.successRows).toBe(1);
      expect(result.failedRows).toBe(0);
      expect(mockWallet.earnPoints).toHaveBeenCalledWith(
        expect.objectContaining({
          partnerId:     'cp_1',
          points:        150,
          referenceType: 'POINTS_AWARD',
          referenceId:   'upload_1',
        }),
      );
    });

    it('should set wallet transaction description to "parameterName – month"', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue(outlet);
      mockWallet.earnPoints.mockResolvedValue({ redeemablePoints: 150 });
      mockPrisma.salesUpload.update.mockResolvedValue({});

      await service.processPointsAwardRows(CLIENT, 'upload_1', [validRow]);

      expect(mockWallet.earnPoints).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Soybean Oil – 2026-07',
        }),
      );
    });

    it('should record an error and skip if outletCode is not found', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue(null);  // outlet not found
      mockPrisma.salesUpload.update.mockResolvedValue({});

      const result = await service.processPointsAwardRows(CLIENT, 'upload_1', [validRow]);

      expect(result.failedRows).toBe(1);
      expect(result.successRows).toBe(0);
      expect(result.errors[0]).toContain('OUT-001');
      expect(mockWallet.earnPoints).not.toHaveBeenCalled();
    });

    it('should record an error and skip if points is zero or negative', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue(outlet);
      mockPrisma.salesUpload.update.mockResolvedValue({});

      const zeroRow    = { ...validRow, points: 0  };
      const negRow     = { ...validRow, points: -10 };

      const r1 = await service.processPointsAwardRows(CLIENT, 'upload_1', [zeroRow]);
      const r2 = await service.processPointsAwardRows(CLIENT, 'upload_2', [negRow]);

      expect(r1.failedRows).toBe(1);
      expect(r2.failedRows).toBe(1);
      expect(mockWallet.earnPoints).not.toHaveBeenCalled();
    });

    it('should aggregate counts across multiple rows (some valid, some not)', async () => {
      // First row: valid outlet
      // Second row: outlet not found
      mockPrisma.outlet.findFirst
        .mockResolvedValueOnce(outlet)
        .mockResolvedValueOnce(null);

      mockWallet.earnPoints.mockResolvedValue({ redeemablePoints: 150 });
      mockPrisma.salesUpload.update.mockResolvedValue({});

      const rows = [
        validRow,
        { outletCode: 'UNKNOWN-999', month: '2026-07', parameterName: 'Sunflower Oil', points: 100 },
      ];

      const result = await service.processPointsAwardRows(CLIENT, 'upload_1', rows);

      expect(result.processedRows).toBe(2);
      expect(result.successRows).toBe(1);
      expect(result.failedRows).toBe(1);
    });

    it('should credit separate wallet transactions per parameter per outlet', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue(outlet);
      mockWallet.earnPoints.mockResolvedValue({ redeemablePoints: 300 });
      mockPrisma.salesUpload.update.mockResolvedValue({});

      const rows = [
        { outletCode: 'OUT-001', month: '2026-07', parameterName: 'Soybean Oil',    points: 150 },
        { outletCode: 'OUT-001', month: '2026-07', parameterName: 'Sunflower Oil',  points: 100 },
      ];

      const result = await service.processPointsAwardRows(CLIENT, 'upload_1', rows);

      expect(result.successRows).toBe(2);
      // earnPoints called twice — once per parameter
      expect(mockWallet.earnPoints).toHaveBeenCalledTimes(2);
      expect(mockWallet.earnPoints).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Soybean Oil – 2026-07',   points: 150 }),
      );
      expect(mockWallet.earnPoints).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Sunflower Oil – 2026-07', points: 100 }),
      );
    });

    it('should mark upload as COMPLETED after processing', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue(outlet);
      mockWallet.earnPoints.mockResolvedValue({ redeemablePoints: 150 });
      mockPrisma.salesUpload.update.mockResolvedValue({});

      await service.processPointsAwardRows(CLIENT, 'upload_1', [validRow]);

      expect(mockPrisma.salesUpload.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'COMPLETED' }),
        }),
      );
    });

    it('should mark upload as FAILED if all rows fail', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue(null);  // all outlets unknown
      mockPrisma.salesUpload.update.mockResolvedValue({});

      await service.processPointsAwardRows(CLIENT, 'upload_1', [validRow]);

      expect(mockPrisma.salesUpload.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
    });
  });

  // ── List uploads ──────────────────────────────────────────────────────────

  describe('listUploads', () => {
    it('should return paginated uploads for a client', async () => {
      mockPrisma.salesUpload.findMany.mockResolvedValue([{ id: 'upload_1' }]);
      mockPrisma.salesUpload.count.mockResolvedValue(1);

      const result = await service.listUploads(CLIENT, { page: 1, limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });
});
