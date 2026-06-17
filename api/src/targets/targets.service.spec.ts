/**
 * Unit tests for TargetsService.
 *
 * Covers:
 *   • listKpis — tenant scoping, enabledOnly filter
 *   • upsertKpi — delegates to prisma.kpiDef.upsert with correct clientId
 *   • deleteKpi — throws NotFoundException for cross-tenant ids
 *   • seedDeoleoKpis — seeds 5 defaults; no-op if tenant already has KPIs
 *   • uploadTargets — verbatim write, blank-cell omission, batch tracking
 *   • listBatches — tenant scoped
 *   • listTargets — requires month param
 *
 * All Prisma calls are mocked; the xlsx parse/generate logic is covered
 * separately in targets.helpers.spec.ts.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { TargetsService } from './targets.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { UpsertKpiDefDto, ListKpisQueryDto, ListBatchesQueryDto, ListTargetsQueryDto, TemplateQueryDto } from './dto/targets.dto';

// ─── Mock Prisma ──────────────────────────────────────────────────────────────

const mockTx = {
  targetUploadBatch: { create: jest.fn() },
  outletTarget: { upsert: jest.fn() },
};

const mockPrisma = {
  kpiDef: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
    createMany: jest.fn(),
  },
  outlet: {
    findMany: jest.fn(),
  },
  outletTarget: {
    findMany: jest.fn(),
  },
  targetUploadBatch: {
    findMany: jest.fn(),
  },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const admin: JwtPayload = {
  sub: 'admin1',
  role: 'CLIENT_ADMIN',
  clientId: 'deoleo',
  phone: '',
  name: '',
};

const kpiRow = {
  id: 'kpi1',
  clientId: 'deoleo',
  code: 'MONTH_TGT',
  label: 'Month Target',
  unit: 'cases',
  isPrimary: true,
  hasNameOverride: false,
  nameOverrideLabel: null,
  order: 1,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const kpiRow2 = {
  id: 'kpi2',
  clientId: 'deoleo',
  code: 'FOCUS_PACK_1',
  label: 'Focus Pack - 1',
  unit: 'cases',
  isPrimary: false,
  hasNameOverride: false,
  nameOverrideLabel: null,
  order: 2,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** Builds an xlsx buffer matching the template layout for tests. */
function buildTestXlsx(dataRows: (string | number | null)[][]): Buffer {
  // Row 1: group headers
  const row1 = ['', '', '', "Jul '26 Target", ''];
  // Row 2: col headers
  const row2 = ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Month Target', 'Focus Pack - 1'];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([row1, row2, ...dataRows]);
  XLSX.utils.book_append_sheet(wb, ws, 'Targets');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('TargetsService', () => {
  let service: TargetsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TargetsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(TargetsService);
  });

  // ─── listKpis ──────────────────────────────────────────────────────────────

  describe('listKpis', () => {
    it('scopes query to caller tenant, sorted by order', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow]);
      await service.listKpis(admin, {} as ListKpisQueryDto);

      const arg = mockPrisma.kpiDef.findMany.mock.calls[0][0];
      expect(arg.where.clientId).toBe('deoleo');
      expect(arg.orderBy).toEqual({ order: 'asc' });
    });

    it('filters to enabled only when enabledOnly=true', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow]);
      await service.listKpis(admin, { enabledOnly: 'true' });

      const arg = mockPrisma.kpiDef.findMany.mock.calls[0][0];
      expect(arg.where.enabled).toBe(true);
    });

    it('does not filter to enabled when enabledOnly is not set', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow]);
      await service.listKpis(admin, {} as ListKpisQueryDto);

      const arg = mockPrisma.kpiDef.findMany.mock.calls[0][0];
      expect(arg.where.enabled).toBeUndefined();
    });
  });

  // ─── upsertKpi ─────────────────────────────────────────────────────────────

  describe('upsertKpi', () => {
    it('calls prisma.kpiDef.upsert with the correct clientId and code', async () => {
      mockPrisma.kpiDef.upsert.mockResolvedValue(kpiRow);

      const dto: UpsertKpiDefDto = {
        code: 'MONTH_TGT',
        label: 'Month Target',
        unit: 'cases',
        isPrimary: true,
        hasNameOverride: false,
        order: 1,
        enabled: true,
      };
      await service.upsertKpi(admin, dto);

      const arg = mockPrisma.kpiDef.upsert.mock.calls[0][0];
      expect(arg.where).toEqual({ clientId_code: { clientId: 'deoleo', code: 'MONTH_TGT' } });
      expect(arg.create.clientId).toBe('deoleo');
      expect(arg.create.code).toBe('MONTH_TGT');
    });

    it('sets enabled=true by default when not supplied', async () => {
      mockPrisma.kpiDef.upsert.mockResolvedValue(kpiRow);
      const dto: UpsertKpiDefDto = { code: 'NEW_KPI', label: 'New KPI' };
      await service.upsertKpi(admin, dto);

      const arg = mockPrisma.kpiDef.upsert.mock.calls[0][0];
      expect(arg.create.enabled).toBe(true);
    });
  });

  // ─── deleteKpi ─────────────────────────────────────────────────────────────

  describe('deleteKpi', () => {
    it('deletes the KPI when it belongs to the tenant', async () => {
      mockPrisma.kpiDef.findFirst.mockResolvedValue(kpiRow);
      mockPrisma.kpiDef.delete.mockResolvedValue(kpiRow);

      const result = await service.deleteKpi(admin, 'kpi1');
      expect(result).toEqual({ deleted: 'kpi1' });
    });

    it('throws NotFoundException when the KPI does not exist for the tenant', async () => {
      mockPrisma.kpiDef.findFirst.mockResolvedValue(null);
      await expect(service.deleteKpi(admin, 'kpi-other')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── seedDeoleoKpis ────────────────────────────────────────────────────────

  describe('seedDeoleoKpis', () => {
    it('creates 5 default KPIs when tenant has none', async () => {
      mockPrisma.kpiDef.count.mockResolvedValue(0);
      mockPrisma.kpiDef.createMany.mockResolvedValue({ count: 5 });

      const result = await service.seedDeoleoKpis(admin);
      expect(result.seeded).toBe(5);

      const arg = mockPrisma.kpiDef.createMany.mock.calls[0][0];
      expect(arg.data).toHaveLength(5);
      // All have the tenant's clientId
      for (const row of arg.data) {
        expect(row.clientId).toBe('deoleo');
      }
      // Default KPI codes are present
      const codes = arg.data.map((d: { code: string }) => d.code);
      expect(codes).toContain('MONTH_TGT');
      expect(codes).toContain('FOCUS_PACK_1');
    });

    it('is a no-op when tenant already has KPIs', async () => {
      mockPrisma.kpiDef.count.mockResolvedValue(3);

      const result = await service.seedDeoleoKpis(admin);
      expect(result.seeded).toBe(0);
      expect(result.skippedReason).toContain('3');
      expect(mockPrisma.kpiDef.createMany).not.toHaveBeenCalled();
    });
  });

  // ─── uploadTargets ─────────────────────────────────────────────────────────

  describe('uploadTargets', () => {
    const mockOutlets = [
      { outletCode: 'O001', name: 'Outlet One', outletType: { code: 'RETAIL' } },
      { outletCode: 'O002', name: 'Outlet Two', outletType: { code: 'HORECA' } },
    ];

    beforeEach(() => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow, kpiRow2]);
      mockPrisma.outlet.findMany.mockResolvedValue(mockOutlets);
      mockTx.targetUploadBatch.create.mockResolvedValue({
        id: 'batch1',
        clientId: 'deoleo',
        month: '2026-07',
        totalRows: 1,
        acceptedCount: 1,
        rejectedCount: 0,
        status: 'COMPLETED',
      });
      mockTx.outletTarget.upsert.mockResolvedValue({});
    });

    it('throws BadRequestException when no file is provided', async () => {
      await expect(
        service.uploadTargets(admin, undefined as unknown as Express.Multer.File),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when no enabled KPIs exist', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([]);
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 100, 50]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;
      await expect(service.uploadTargets(admin, file)).rejects.toThrow(BadRequestException);
    });

    it('writes verbatim values and returns batch summary', async () => {
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 123.45, 67]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      const result = await service.uploadTargets(admin, file);

      expect(result.batchId).toBe('batch1');
      expect(result.acceptedCount).toBeGreaterThanOrEqual(1);

      // upsert should have been called with verbatim kpiMap (no compute)
      const upsertCall = mockTx.outletTarget.upsert.mock.calls[0][0];
      const stored = upsertCall.create.targetValues as Record<string, number>;
      expect(stored['MONTH_TGT']).toBe(123.45);
      expect(stored['FOCUS_PACK_1']).toBe(67);
    });

    it('CRITICAL: blank cell → key OMITTED — upsert does not store null/0 for blank', async () => {
      // O001: MONTH_TGT=100, FOCUS_PACK_1=blank
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 100, null]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadTargets(admin, file);

      const upsertCall = mockTx.outletTarget.upsert.mock.calls[0][0];
      const stored = upsertCall.create.targetValues as Record<string, number>;
      expect(stored['MONTH_TGT']).toBe(100);
      expect('FOCUS_PACK_1' in stored).toBe(false);
    });

    it('rejected outlet row does not write an OutletTarget', async () => {
      // GHOST is not in the outlet roster
      const file = {
        buffer: buildTestXlsx([['GHOST', 'Ghost Outlet', 'RETAIL', 100, 50]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadTargets(admin, file);

      // No upsert should have been called
      expect(mockTx.outletTarget.upsert).not.toHaveBeenCalled();
    });

    it('records rejectedCount on the batch', async () => {
      const file = {
        buffer: buildTestXlsx([
          ['O001', 'Outlet One', 'RETAIL', 100, 50],  // accepted
          ['GHOST', 'Ghost', 'RETAIL', 10, 20],         // rejected
        ]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadTargets(admin, file);

      const batchCreate = mockTx.targetUploadBatch.create.mock.calls[0][0];
      expect(batchCreate.data.clientId).toBe('deoleo');
      expect(batchCreate.data.rejectedCount).toBe(1);
      expect(batchCreate.data.acceptedCount).toBe(1);
    });
  });

  // ─── listBatches ───────────────────────────────────────────────────────────

  describe('listBatches', () => {
    it('scopes query to caller tenant, newest first', async () => {
      mockPrisma.targetUploadBatch.findMany.mockResolvedValue([]);
      await service.listBatches(admin, {} as ListBatchesQueryDto);

      const arg = mockPrisma.targetUploadBatch.findMany.mock.calls[0][0];
      expect(arg.where.clientId).toBe('deoleo');
      expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    });

    it('filters by month when provided', async () => {
      mockPrisma.targetUploadBatch.findMany.mockResolvedValue([]);
      await service.listBatches(admin, { month: '2026-07' });

      const arg = mockPrisma.targetUploadBatch.findMany.mock.calls[0][0];
      expect(arg.where.month).toBe('2026-07');
    });
  });

  // ─── listTargets ───────────────────────────────────────────────────────────

  describe('listTargets', () => {
    it('scopes query to tenant and filters by month', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      await service.listTargets(admin, { month: '2026-07' } as ListTargetsQueryDto);

      const arg = mockPrisma.outletTarget.findMany.mock.calls[0][0];
      expect(arg.where.clientId).toBe('deoleo');
      expect(arg.where.month).toBe('2026-07');
    });

    it('optionally filters by outletCode', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      await service.listTargets(admin, { month: '2026-07', outletCode: 'O001' });

      const arg = mockPrisma.outletTarget.findMany.mock.calls[0][0];
      expect(arg.where.outletCode).toBe('O001');
    });

    it('throws BadRequestException when month is not provided', async () => {
      await expect(
        service.listTargets(admin, {} as ListTargetsQueryDto),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
