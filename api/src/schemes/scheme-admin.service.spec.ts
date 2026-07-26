/**
 * Unit tests for scheme-admin.service.ts (Wave-0 scheme data-collection authoring).
 *
 * Covers: create (DRAFT default / explicit ACTIVE / inert reward columns / date
 * guard), edit-in-place, status transition, enrollment-form versioning (bump +
 * append snapshot), audience snapshot materialization + chunking, and tenant/404
 * scoping. Prisma is fully mocked.
 *
 * Run: npx jest src/schemes/scheme-admin.service.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SchemeAdminService } from './scheme-admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  scheme: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  schemeEnrollmentForm: { findUnique: jest.fn(), upsert: jest.fn() },
  schemeEnrollmentFormVersion: { create: jest.fn() },
  schemeOutlet: {
    createMany: jest.fn(),
    upsert: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  outlet: { findMany: jest.fn() },
  salesUser: { findMany: jest.fn() },
  // $transaction handles BOTH the callback form (form versioning) and the
  // array form (chunked persistence).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction: jest.fn((arg: any) =>
    Array.isArray(arg) ? Promise.all(arg) : arg(mockPrisma),
  ),
};

const user: JwtPayload = {
  sub: 'u1',
  role: 'GIFSY_ADMIN',
  clientId: 't1',
  phone: '9000000000',
  name: 'Admin',
};

const activeScheme = {
  id: 's1',
  clientId: 't1',
  deletedAt: null,
  startDate: new Date('2026-08-01'),
  endDate: new Date('2026-08-31'),
};

describe('SchemeAdminService', () => {
  let service: SchemeAdminService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [SchemeAdminService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(SchemeAdminService);
  });

  // ── create ────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('defaults status to DRAFT and writes inert reward columns', async () => {
      mockPrisma.scheme.create.mockResolvedValue({ id: 's1' });
      await service.create(user, {
        code: 'SCH1',
        name: 'Scheme One',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
      });
      const data = mockPrisma.scheme.create.mock.calls[0][0].data;
      expect(data.status).toBe('DRAFT');
      expect(data.schemeType).toBe('PURCHASE_INCENTIVE');
      expect(data.rewardType).toBe('POINTS');
      expect(data.clientId).toBe('t1');
      expect(data.createdByUserId).toBe('u1');
    });

    it('honours an explicit ACTIVE status', async () => {
      mockPrisma.scheme.create.mockResolvedValue({ id: 's1' });
      await service.create(user, {
        code: 'SCH1',
        name: 'Scheme One',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
        status: 'ACTIVE',
      });
      expect(mockPrisma.scheme.create.mock.calls[0][0].data.status).toBe('ACTIVE');
    });

    it('rejects endDate <= startDate', async () => {
      await expect(
        service.create(user, {
          code: 'SCH1',
          name: 'Scheme One',
          startDate: '2026-08-31',
          endDate: '2026-08-01',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.scheme.create).not.toHaveBeenCalled();
    });
  });

  // ── update ──────────────────────────────────────────────────────────────────
  describe('update', () => {
    it('edits in place (single update, no create) with only provided fields', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(activeScheme);
      mockPrisma.scheme.update.mockResolvedValue({ id: 's1', name: 'New' });
      await service.update(user, 's1', { name: 'New' });
      expect(mockPrisma.scheme.create).not.toHaveBeenCalled();
      const call = mockPrisma.scheme.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 's1' });
      expect(call.data).toEqual({ name: 'New' });
    });

    it('404s a cross-tenant / deleted scheme', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(null);
      await expect(service.update(user, 'sX', { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('validates the effective date order against the existing start', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(activeScheme);
      await expect(
        service.update(user, 's1', { endDate: '2026-07-01' }), // before existing start
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── setStatus ───────────────────────────────────────────────────────────────
  describe('setStatus', () => {
    it('updates to a valid status', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(activeScheme);
      mockPrisma.scheme.update.mockResolvedValue({ id: 's1', status: 'PAUSED' });
      await service.setStatus(user, 's1', { status: 'PAUSED' as never });
      expect(mockPrisma.scheme.update.mock.calls[0][0].data).toEqual({ status: 'PAUSED' });
    });
  });

  // ── upsertEnrollmentForm (D11 versioning) ────────────────────────────────────
  describe('upsertEnrollmentForm', () => {
    const dto = { campaignType: 'MIXED' as const, formSchema: { fields: [] } };

    it('starts at version 1 and appends a snapshot when no form exists', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(activeScheme);
      mockPrisma.schemeEnrollmentForm.findUnique.mockResolvedValue(null);
      mockPrisma.schemeEnrollmentForm.upsert.mockResolvedValue({ id: 'f1', version: 1 });
      mockPrisma.schemeEnrollmentFormVersion.create.mockResolvedValue({ id: 'fv1', version: 1 });

      await service.upsertEnrollmentForm(user, 's1', dto);

      expect(mockPrisma.schemeEnrollmentForm.upsert.mock.calls[0][0].create.version).toBe(1);
      expect(mockPrisma.schemeEnrollmentForm.upsert.mock.calls[0][0].update.version).toBe(1);
      expect(mockPrisma.schemeEnrollmentFormVersion.create.mock.calls[0][0].data.version).toBe(1);
    });

    it('bumps to the next version and appends a new snapshot on re-save', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(activeScheme);
      mockPrisma.schemeEnrollmentForm.findUnique.mockResolvedValue({ id: 'f1', version: 3 });
      mockPrisma.schemeEnrollmentForm.upsert.mockResolvedValue({ id: 'f1', version: 4 });
      mockPrisma.schemeEnrollmentFormVersion.create.mockResolvedValue({ id: 'fv4', version: 4 });

      await service.upsertEnrollmentForm(user, 's1', dto);

      expect(mockPrisma.schemeEnrollmentForm.upsert.mock.calls[0][0].update.version).toBe(4);
      expect(mockPrisma.schemeEnrollmentFormVersion.create.mock.calls[0][0].data.version).toBe(4);
    });
  });

  // ── setAudience ──────────────────────────────────────────────────────────────
  describe('setAudience', () => {
    it('stores config only for EXCEL mode (no materialization)', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(activeScheme);
      mockPrisma.scheme.update.mockResolvedValue({ id: 's1' });
      const res = await service.setAudience(user, 's1', {
        mode: 'EXCEL',
        selfEnrollAllowed: true,
        frozen: false,
      });
      expect(mockPrisma.outlet.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.schemeOutlet.createMany).not.toHaveBeenCalled();
      expect(res.materializedCount).toBe(0);
    });

    it('does NOT materialize a FILTER live-rule (frozen:false)', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(activeScheme);
      mockPrisma.scheme.update.mockResolvedValue({ id: 's1' });
      await service.setAudience(user, 's1', {
        mode: 'FILTER',
        selfEnrollAllowed: false,
        frozen: false,
        filter: { zones: ['MH'], kycApprovedOnly: false },
      });
      expect(mockPrisma.schemeOutlet.createMany).not.toHaveBeenCalled();
    });

    it('rejects a FILTER audience with no filter facet or kycApprovedOnly (B-MED-1)', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(activeScheme);
      // An empty filter would silently snapshot EVERY tenant outlet → must 400.
      await expect(
        service.setAudience(user, 's1', {
          mode: 'FILTER',
          selfEnrollAllowed: false,
          frozen: true,
          filter: { outletTypeIds: [], kycApprovedOnly: false },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // …and rejects a completely absent filter too.
      await expect(
        service.setAudience(user, 's1', {
          mode: 'FILTER',
          selfEnrollAllowed: false,
          frozen: true,
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Guard runs before any write.
      expect(mockPrisma.scheme.update).not.toHaveBeenCalled();
    });

    it('accepts a FILTER audience narrowed by kycApprovedOnly alone (B-MED-1)', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(activeScheme);
      mockPrisma.scheme.update.mockResolvedValue({ id: 's1' });
      await service.setAudience(user, 's1', {
        mode: 'FILTER',
        selfEnrollAllowed: false,
        frozen: false,
        filter: { kycApprovedOnly: true },
      });
      expect(mockPrisma.scheme.update).toHaveBeenCalled();
    });

    it('materializes a FILTER frozen snapshot, deduped + chunked (100/tx)', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(activeScheme);
      mockPrisma.scheme.update.mockResolvedValue({ id: 's1' });

      // 150 outlets + one duplicate outletCode → 150 unique rows → 2 chunks (100 + 50).
      const outlets = Array.from({ length: 150 }, (_, i) => ({
        id: `o${i}`,
        outletCode: `OUT${i}`,
        name: `Shop ${i}`,
        partnerId: i % 2 === 0 ? `p${i}` : null,
      }));
      outlets.push({ id: 'odup', outletCode: 'OUT0', name: 'Dup', partnerId: null });
      mockPrisma.outlet.findMany.mockResolvedValue(outlets);
      mockPrisma.schemeOutlet.createMany
        .mockResolvedValueOnce({ count: 100 })
        .mockResolvedValueOnce({ count: 50 });

      const res = await service.setAudience(user, 's1', {
        mode: 'FILTER',
        selfEnrollAllowed: false,
        frozen: true,
        filter: { states: ['MH'], kycApprovedOnly: true },
      });

      // filter passed through to the outlet query
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ clientId: 't1', deletedAt: null, state: { in: ['MH'] }, isActive: true });

      // chunked into 2 createMany calls of 100 + 50 (duplicate OUT0 dropped)
      expect(mockPrisma.schemeOutlet.createMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.schemeOutlet.createMany.mock.calls[0][0].data).toHaveLength(100);
      expect(mockPrisma.schemeOutlet.createMany.mock.calls[1][0].data).toHaveLength(50);
      expect(mockPrisma.schemeOutlet.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
      // every row carries the scheme's own id + clientId (§13.3 invariant)
      const firstRow = mockPrisma.schemeOutlet.createMany.mock.calls[0][0].data[0];
      expect(firstRow.schemeId).toBe('s1');
      expect(firstRow.clientId).toBe('t1');
      expect(res.materializedCount).toBe(150);
    });
  });

  // ── uploadRoster ─────────────────────────────────────────────────────────────
  describe('uploadRoster', () => {
    const xlsxBuffer = (aoa: (string | number | null)[][]): Buffer => {
      // Lazy require so the spec has no top-level xlsx dependency ordering issue.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const XLSX = require('xlsx');
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Roster');
      return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    };

    it('parses, matches, and chunk-upserts roster rows', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(activeScheme);
      mockPrisma.outlet.findMany.mockResolvedValue([
        { id: 'o1', outletCode: 'OUT001', partnerId: 'p1' },
      ]);
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'su1', employeeCode: 'EMP01' }]);
      mockPrisma.schemeOutlet.upsert.mockReturnValue(Promise.resolve({}));

      const buf = xlsxBuffer([
        ['Outlet ID', 'Outlet Name', 'Tagged Employee', 'Slab'],
        ['OUT001', 'Shop One', 'EMP01', 'Gold'], // matched
        ['OUT999', 'Standalone', '', ''], // standalone
      ]);

      const res = await service.uploadRoster(
        user,
        's1',
        { buffer: buf } as Express.Multer.File,
        {},
      );

      expect(res.totalRows).toBe(2);
      expect(res.matchedCount).toBe(1);
      expect(res.standaloneCount).toBe(1);
      expect(mockPrisma.schemeOutlet.upsert).toHaveBeenCalledTimes(2);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      // roster upsert keyed by the composite unique
      expect(mockPrisma.schemeOutlet.upsert.mock.calls[0][0].where).toEqual({
        schemeId_outletRef: { schemeId: 's1', outletRef: 'OUT001' },
      });
    });

    it('rejects a file with no data rows', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(activeScheme);
      const buf = xlsxBuffer([['Outlet ID', 'Outlet Name']]);
      await expect(
        service.uploadRoster(user, 's1', { buffer: buf } as Express.Multer.File, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when no file buffer is supplied', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(activeScheme);
      await expect(
        service.uploadRoster(user, 's1', undefined as unknown as Express.Multer.File, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── getRoster ────────────────────────────────────────────────────────────────
  describe('getRoster', () => {
    it('paginates tenant-scoped roster rows', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(activeScheme);
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([{ id: 'ro1' }]);
      mockPrisma.schemeOutlet.count.mockResolvedValue(1);
      const res = await service.getRoster(user, 's1', { page: 1, limit: 50 });
      expect(mockPrisma.schemeOutlet.findMany.mock.calls[0][0].where).toEqual({
        schemeId: 's1',
        clientId: 't1',
      });
      expect(res.pagination).toEqual({ page: 1, limit: 50, total: 1, pages: 1 });
    });
  });
});
