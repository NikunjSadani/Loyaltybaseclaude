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
 *   • uploadAchievements — mirrors uploadTargets; blank→omit, 0 verbatim,
 *       unknown outlet rejected, tenant scope, SalesUploadBatch + OutletSalesRecord
 *   • listAchievementBatches — tenant scoped
 *   • listAchievements — requires month param
 *   • getPace — joins target + achievement; divide-by-zero → null
 *
 * All Prisma calls are mocked; the xlsx parse/generate logic is covered
 * separately in targets.helpers.spec.ts.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import { TargetsService } from './targets.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  UpsertKpiDefDto,
  ListKpisQueryDto,
  ListBatchesQueryDto,
  ListTargetsQueryDto,
  TemplateQueryDto,
  ListAchievementBatchesQueryDto,
  ListAchievementsQueryDto,
  PaceQueryDto,
} from './dto/targets.dto';

// ─── Mock Prisma ──────────────────────────────────────────────────────────────

const mockTx = {
  kpiDef:             { upsert: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  targetUploadBatch:  { create: jest.fn() },
  outletTarget:       { upsert: jest.fn() },
  salesUploadBatch:   { create: jest.fn() },
  outletSalesRecord:  { upsert: jest.fn() },
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
  outletSalesRecord: {
    findMany: jest.fn(),
  },
  targetUploadBatch: {
    findMany: jest.fn(),
  },
  salesUploadBatch: {
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
      // Deterministic order: primary tiebreak on `code` so "first primary"
      // can never flip on equal `order`.
      expect(arg.orderBy).toEqual([{ order: 'asc' }, { code: 'asc' }]);
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

    it('DETERMINISM: orderBy carries a `code` tiebreak so equal-`order` rows never flip', async () => {
      // Two KPIs share order=1; only the `code` tiebreak makes their relative
      // order (and therefore the "first primary" pick) stable across queries.
      const a = { ...kpiRow, id: 'a', code: 'AAA', order: 1, isPrimary: true };
      const b = { ...kpiRow, id: 'b', code: 'BBB', order: 1, isPrimary: true };
      mockPrisma.kpiDef.findMany.mockResolvedValue([a, b]);

      await service.listKpis(admin, {} as ListKpisQueryDto);

      const arg = mockPrisma.kpiDef.findMany.mock.calls[0][0];
      // The query asks the DB for [order asc, code asc] — the only thing that
      // guarantees "first match wins" is reproducible on equal `order`.
      expect(arg.orderBy).toEqual([{ order: 'asc' }, { code: 'asc' }]);
      expect(arg.orderBy[0]).toEqual({ order: 'asc' });
      expect(arg.orderBy[1]).toEqual({ code: 'asc' });
    });
  });

  // ─── upsertKpi ─────────────────────────────────────────────────────────────

  describe('upsertKpi', () => {
    it('calls tx.kpiDef.upsert with the correct clientId and code (inside a transaction)', async () => {
      mockTx.kpiDef.upsert.mockResolvedValue(kpiRow);

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

      // The write runs inside $transaction for atomicity with the demotion.
      expect(mockPrisma.$transaction).toHaveBeenCalled();

      const arg = mockTx.kpiDef.upsert.mock.calls[0][0];
      expect(arg.where).toEqual({ clientId_code: { clientId: 'deoleo', code: 'MONTH_TGT' } });
      expect(arg.create.clientId).toBe('deoleo');
      expect(arg.create.code).toBe('MONTH_TGT');
    });

    it('sets enabled=true by default when not supplied', async () => {
      mockTx.kpiDef.upsert.mockResolvedValue(kpiRow);
      const dto: UpsertKpiDefDto = { code: 'NEW_KPI', label: 'New KPI' };
      await service.upsertKpi(admin, dto);

      const arg = mockTx.kpiDef.upsert.mock.calls[0][0];
      expect(arg.create.enabled).toBe(true);
    });

    it('INVARIANT: isPrimary=true demotes every OTHER KPI for the tenant before upserting, in one transaction', async () => {
      mockTx.kpiDef.updateMany.mockResolvedValue({ count: 1 });
      mockTx.kpiDef.upsert.mockResolvedValue({ ...kpiRow, code: 'FOCUS_PACK_1', isPrimary: true });

      const dto: UpsertKpiDefDto = {
        code: 'FOCUS_PACK_1',
        label: 'Focus Pack - 1',
        isPrimary: true,
      };
      await service.upsertKpi(admin, dto);

      // 1) The demotion runs, scoped to the tenant, excluding the incoming code.
      expect(mockTx.kpiDef.updateMany).toHaveBeenCalledTimes(1);
      const demote = mockTx.kpiDef.updateMany.mock.calls[0][0];
      expect(demote.where).toEqual({ clientId: 'deoleo', NOT: { code: 'FOCUS_PACK_1' } });
      expect(demote.data).toEqual({ isPrimary: false });

      // 2) The upsert writes this row as primary — only ONE primary remains.
      const upsertArg = mockTx.kpiDef.upsert.mock.calls[0][0];
      expect(upsertArg.create.isPrimary).toBe(true);
      expect(upsertArg.update.isPrimary).toBe(true);

      // 3) Demotion and upsert share the SAME tx object (atomic).
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('does NOT demote other KPIs when isPrimary is false', async () => {
      mockTx.kpiDef.upsert.mockResolvedValue({ ...kpiRow, isPrimary: false });
      const dto: UpsertKpiDefDto = { code: 'CONSISTENCY', label: 'Consistency', isPrimary: false };
      await service.upsertKpi(admin, dto);

      expect(mockTx.kpiDef.updateMany).not.toHaveBeenCalled();
    });

    it('does NOT demote other KPIs when isPrimary is omitted', async () => {
      mockTx.kpiDef.upsert.mockResolvedValue(kpiRow);
      const dto: UpsertKpiDefDto = { code: 'CONSISTENCY', label: 'Consistency' };
      await service.upsertKpi(admin, dto);

      expect(mockTx.kpiDef.updateMany).not.toHaveBeenCalled();
    });
  });

  // ─── setPrimary ────────────────────────────────────────────────────────────

  describe('setPrimary', () => {
    it('INVARIANT: demotes every OTHER primary (by id) then sets the target one primary, in one transaction', async () => {
      mockTx.kpiDef.findFirst.mockResolvedValue(kpiRow2);
      mockTx.kpiDef.updateMany.mockResolvedValue({ count: 1 });
      mockTx.kpiDef.update.mockResolvedValue({ ...kpiRow2, isPrimary: true });

      await service.setPrimary(admin, 'kpi2');

      // The whole move runs in ONE transaction (atomic).
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);

      // 1) Existence/tenant check on the target KPI.
      const findArg = mockTx.kpiDef.findFirst.mock.calls[0][0];
      expect(findArg.where).toEqual({ id: 'kpi2', clientId: 'deoleo' });

      // 2) Demotion is scoped to the tenant and excludes the target by ID (NOT by code).
      expect(mockTx.kpiDef.updateMany).toHaveBeenCalledTimes(1);
      const demote = mockTx.kpiDef.updateMany.mock.calls[0][0];
      expect(demote.where).toEqual({ clientId: 'deoleo', NOT: { id: 'kpi2' } });
      expect(demote.data).toEqual({ isPrimary: false });

      // 3) The target KPI is set primary.
      const updateArg = mockTx.kpiDef.update.mock.calls[0][0];
      expect(updateArg.where).toEqual({ id: 'kpi2' });
      expect(updateArg.data).toEqual({ isPrimary: true });
    });

    it('throws NotFoundException for a non-existent / other-tenant KPI and never demotes', async () => {
      mockTx.kpiDef.findFirst.mockResolvedValue(null);

      await expect(service.setPrimary(admin, 'kpi-other')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockTx.kpiDef.updateMany).not.toHaveBeenCalled();
      expect(mockTx.kpiDef.update).not.toHaveBeenCalled();
    });

    it('CONFLICT: a P2002 from the transaction surfaces as ConflictException (409)', async () => {
      mockTx.kpiDef.findFirst.mockResolvedValue(kpiRow2);
      mockTx.kpiDef.updateMany.mockResolvedValue({ count: 1 });
      mockTx.kpiDef.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(service.setPrimary(admin, 'kpi2')).rejects.toBeInstanceOf(
        ConflictException,
      );
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

    it('LOCK: a PAST month is skipped (no upsert) and reported in skippedLockedMonths', async () => {
      // "Jan '20 Target" = 2020-01, strictly in the past → locked, not editable.
      const ws = XLSX.utils.aoa_to_sheet([
        ['', '', '', "Jan '20 Target", ''],
        ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Month Target', 'Focus Pack - 1'],
        ['O001', 'Outlet One', 'RETAIL', 100, 50],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Targets');
      const file = {
        buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
        originalname: 'past.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      const result = await service.uploadTargets(admin, file);

      // Locked month → nothing written, but the row still parses (no error).
      expect(mockTx.outletTarget.upsert).not.toHaveBeenCalled();
      expect(result.skippedLockedMonths).toContain('2020-01');
      expect(result.writableMonths).not.toContain('2020-01');
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

  // ─── exportTargetsBuffer (Download Final Targets) ───────────────────────────

  describe('exportTargetsBuffer', () => {
    const XLSX = require('xlsx');

    it('rejects a non-YYYY-MM month', async () => {
      await expect(service.exportTargetsBuffer(admin, 'July')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects when the tenant has no enabled KPIs', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([]);
      await expect(service.exportTargetsBuffer(admin, '2026-07')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('dumps stored targetValues verbatim, blank for an omitted KPI key', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow, kpiRow2]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        // RT-1 has both KPIs; RT-2 only the primary (FOCUS_PACK_1 omitted → blank).
        { outletCode: 'RT-1', outletName: 'Shop One', outletType: 'SSS', targetValues: { MONTH_TGT: 100, FOCUS_PACK_1: 20 } },
        { outletCode: 'RT-2', outletName: 'Shop Two', outletType: 'SSS', targetValues: { MONTH_TGT: 50 } },
      ]);

      const buf = await service.exportTargetsBuffer(admin, '2026-07');

      // Tenant + month scoped read.
      const where = mockPrisma.outletTarget.findMany.mock.calls.at(-1)[0].where;
      expect(where).toEqual({ clientId: 'deoleo', month: '2026-07' });

      const wb = XLSX.read(buf, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
      // 2-row month-group header (matches generateTargetTemplateBuffer) so the
      // "Download Final Targets" export re-uploads cleanly through parseTargetUploadBuffer.
      // Row 0 = month-group label over the KPI columns; row 1 = column labels.
      expect(rows[0][3]).toBe("Jul '26 Target");
      expect(rows[1]).toEqual(['Outlet ID', 'Outlet Name', 'Outlet Type', 'Month Target', 'Focus Pack - 1']);
      expect(rows[2]).toEqual(['RT-1', 'Shop One', 'SSS', 100, 20]);
      // RT-2's omitted FOCUS_PACK_1 cell is blank (empty), not 0.
      expect(rows[3][3]).toBe(50);
      expect(rows[3][4]).toBe('');
    });
  });

  // ─── uploadAchievements ────────────────────────────────────────────────────

  describe('uploadAchievements', () => {
    const mockOutlets = [
      { outletCode: 'O001', name: 'Outlet One', outletType: { code: 'RETAIL' } },
      { outletCode: 'O002', name: 'Outlet Two', outletType: { code: 'HORECA' } },
    ];

    beforeEach(() => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpiRow, kpiRow2]);
      mockPrisma.outlet.findMany.mockResolvedValue(mockOutlets);
      mockTx.salesUploadBatch.create.mockResolvedValue({
        id: 'sales-batch-1',
        clientId: 'deoleo',
        month: '2026-07',
        totalRows: 1,
        acceptedCount: 1,
        rejectedCount: 0,
        status: 'COMPLETED',
      });
      mockTx.outletSalesRecord.upsert.mockResolvedValue({});
    });

    it('throws BadRequestException when no file is provided', async () => {
      await expect(
        service.uploadAchievements(admin, undefined as unknown as Express.Multer.File),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when no enabled KPIs exist', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([]);
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 100, 50]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;
      await expect(service.uploadAchievements(admin, file)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for a corrupted (non-xlsx) buffer', async () => {
      const file = {
        buffer: Buffer.from('NOT AN XLSX FILE'),
        originalname: 'bad.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;
      await expect(service.uploadAchievements(admin, file)).rejects.toThrow(BadRequestException);
    });

    it('writes verbatim kpiValues into OutletSalesRecord and returns batch summary', async () => {
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 55.5, 30]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      const result = await service.uploadAchievements(admin, file);

      expect(result.batchId).toBe('sales-batch-1');
      expect(result.acceptedCount).toBeGreaterThanOrEqual(1);

      const upsertCall = mockTx.outletSalesRecord.upsert.mock.calls[0][0];
      const stored = upsertCall.create.kpiValues as Record<string, number>;
      expect(stored['MONTH_TGT']).toBe(55.5);
      expect(stored['FOCUS_PACK_1']).toBe(30);
    });

    it('CRITICAL: blank cell → key OMITTED from kpiValues (not 0)', async () => {
      // O001: MONTH_TGT=100, FOCUS_PACK_1=blank
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 100, null]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadAchievements(admin, file);

      const upsertCall = mockTx.outletSalesRecord.upsert.mock.calls[0][0];
      const stored = upsertCall.create.kpiValues as Record<string, number>;
      expect(stored['MONTH_TGT']).toBe(100);
      expect('FOCUS_PACK_1' in stored).toBe(false);
    });

    it('CRITICAL: 0 is stored verbatim in kpiValues (0 ≠ blank)', async () => {
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 0, 75]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadAchievements(admin, file);

      const upsertCall = mockTx.outletSalesRecord.upsert.mock.calls[0][0];
      const stored = upsertCall.create.kpiValues as Record<string, number>;
      expect(stored['MONTH_TGT']).toBe(0);
      expect(stored['FOCUS_PACK_1']).toBe(75);
    });

    it('unknown outlet code → rejected, no OutletSalesRecord upsert', async () => {
      const file = {
        buffer: buildTestXlsx([['GHOST', 'Ghost Outlet', 'RETAIL', 100, 50]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadAchievements(admin, file);

      expect(mockTx.outletSalesRecord.upsert).not.toHaveBeenCalled();
    });

    it('tenant-scopes SalesUploadBatch.create with clientId', async () => {
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 10, 20]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadAchievements(admin, file);

      const batchCreate = mockTx.salesUploadBatch.create.mock.calls[0][0];
      expect(batchCreate.data.clientId).toBe('deoleo');
      expect(batchCreate.data.uploadedById).toBe('admin1');
    });

    it('tenant-scopes OutletSalesRecord.upsert with clientId', async () => {
      const file = {
        buffer: buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 10, 20]]),
        originalname: 'test.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      } as Express.Multer.File;

      await service.uploadAchievements(admin, file);

      const upsertCall = mockTx.outletSalesRecord.upsert.mock.calls[0][0];
      expect(upsertCall.create.clientId).toBe('deoleo');
      expect(upsertCall.where.clientId_outletCode_month.clientId).toBe('deoleo');
    });
  });

  // ─── listAchievementBatches ────────────────────────────────────────────────

  describe('listAchievementBatches', () => {
    it('scopes query to caller tenant, newest first', async () => {
      mockPrisma.salesUploadBatch.findMany.mockResolvedValue([]);
      await service.listAchievementBatches(admin, {} as ListAchievementBatchesQueryDto);

      const arg = mockPrisma.salesUploadBatch.findMany.mock.calls[0][0];
      expect(arg.where.clientId).toBe('deoleo');
      expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    });

    it('filters by month when provided', async () => {
      mockPrisma.salesUploadBatch.findMany.mockResolvedValue([]);
      await service.listAchievementBatches(admin, { month: '2026-07' });

      const arg = mockPrisma.salesUploadBatch.findMany.mock.calls[0][0];
      expect(arg.where.month).toBe('2026-07');
    });
  });

  // ─── listAchievements ──────────────────────────────────────────────────────

  describe('listAchievements', () => {
    it('scopes query to tenant and filters by month', async () => {
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
      await service.listAchievements(admin, { month: '2026-07' } as ListAchievementsQueryDto);

      const arg = mockPrisma.outletSalesRecord.findMany.mock.calls[0][0];
      expect(arg.where.clientId).toBe('deoleo');
      expect(arg.where.month).toBe('2026-07');
    });

    it('optionally filters by outletCode', async () => {
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
      await service.listAchievements(admin, { month: '2026-07', outletCode: 'O001' });

      const arg = mockPrisma.outletSalesRecord.findMany.mock.calls[0][0];
      expect(arg.where.outletCode).toBe('O001');
    });

    it('throws BadRequestException when month is not provided', async () => {
      await expect(
        service.listAchievements(admin, {} as ListAchievementsQueryDto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── getPace ───────────────────────────────────────────────────────────────

  describe('getPace', () => {
    beforeEach(() => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
    });

    it('throws BadRequestException when month is not provided', async () => {
      await expect(service.getPace(admin, {} as PaceQueryDto)).rejects.toThrow(BadRequestException);
    });

    it('tenant-scopes both outletTarget and outletSalesRecord queries', async () => {
      await service.getPace(admin, { month: '2026-07' });

      const tArg = mockPrisma.outletTarget.findMany.mock.calls[0][0];
      const aArg = mockPrisma.outletSalesRecord.findMany.mock.calls[0][0];
      expect(tArg.where.clientId).toBe('deoleo');
      expect(tArg.where.month).toBe('2026-07');
      expect(aArg.where.clientId).toBe('deoleo');
      expect(aArg.where.month).toBe('2026-07');
    });

    it('optionally scopes to a single outletCode', async () => {
      await service.getPace(admin, { month: '2026-07', outletCode: 'O001' });

      const tArg = mockPrisma.outletTarget.findMany.mock.calls[0][0];
      expect(tArg.where.outletCode).toBe('O001');
    });

    it('returns empty outlets array when no target or achievement data', async () => {
      const res = await service.getPace(admin, { month: '2026-07' });
      expect(res).toEqual({ month: '2026-07', outlets: [] });
    });

    it('computes pace = achieved / target correctly', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          outletType: 'RETAIL',
          targetValues: { MONTH_TGT: 200 },
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'O001', kpiValues: { MONTH_TGT: 150 } },
      ]);

      const res = await service.getPace(admin, { month: '2026-07' });
      const kpi = res.outlets[0].kpis.find((k: { code: string }) => k.code === 'MONTH_TGT')!;
      expect(kpi.target).toBe(200);
      expect(kpi.achieved).toBe(150);
      expect(kpi.pace).toBeCloseTo(0.75);
    });

    it('CRITICAL: pace is null when target is 0 (divide-by-zero guard)', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          outletType: 'RETAIL',
          targetValues: { MONTH_TGT: 0 },
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'O001', kpiValues: { MONTH_TGT: 50 } },
      ]);

      const res = await service.getPace(admin, { month: '2026-07' });
      const kpi = res.outlets[0].kpis.find((k: { code: string }) => k.code === 'MONTH_TGT')!;
      expect(kpi.pace).toBeNull();
    });

    it('CRITICAL: pace is null when target key is absent', async () => {
      // Target row has no MONTH_TGT key; achievement side has it
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          outletType: 'RETAIL',
          targetValues: {},
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'O001', kpiValues: { MONTH_TGT: 80 } },
      ]);

      const res = await service.getPace(admin, { month: '2026-07' });
      const kpi = res.outlets[0].kpis.find((k: { code: string }) => k.code === 'MONTH_TGT')!;
      expect(kpi.target).toBeNull();
      expect(kpi.pace).toBeNull();
    });

    it('includes outlets with only achievement data (target null)', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'O001', kpiValues: { MONTH_TGT: 40 } },
      ]);

      const res = await service.getPace(admin, { month: '2026-07' });
      expect(res.outlets).toHaveLength(1);
      const kpi = res.outlets[0].kpis[0]!;
      expect(kpi.achieved).toBe(40);
      expect(kpi.target).toBeNull();
      expect(kpi.pace).toBeNull();
    });

    it('includes outlets with only target data (achieved null, pace null)', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          outletType: 'RETAIL',
          targetValues: { MONTH_TGT: 100 },
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);

      const res = await service.getPace(admin, { month: '2026-07' });
      expect(res.outlets).toHaveLength(1);
      const kpi = res.outlets[0].kpis[0]!;
      expect(kpi.target).toBe(100);
      expect(kpi.achieved).toBeNull();
      expect(kpi.pace).toBeNull();
    });

    it('handles outlet with achieved=0 and non-zero target — pace=0 (not null)', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          outletType: 'RETAIL',
          targetValues: { MONTH_TGT: 100 },
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'O001', kpiValues: { MONTH_TGT: 0 } },
      ]);

      const res = await service.getPace(admin, { month: '2026-07' });
      const kpi = res.outlets[0].kpis[0]!;
      expect(kpi.achieved).toBe(0);
      expect(kpi.pace).toBe(0);  // 0 / 100 = 0, NOT null
    });

    it('results are sorted by outletCode', async () => {
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        { outletCode: 'Z999', outletName: 'Z', outletType: 'RETAIL', targetValues: { MONTH_TGT: 1 } },
        { outletCode: 'A001', outletName: 'A', outletType: 'RETAIL', targetValues: { MONTH_TGT: 2 } },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);

      const res = await service.getPace(admin, { month: '2026-07' });
      expect(res.outlets[0].outletCode).toBe('A001');
      expect(res.outlets[1].outletCode).toBe('Z999');
    });
  });
});
