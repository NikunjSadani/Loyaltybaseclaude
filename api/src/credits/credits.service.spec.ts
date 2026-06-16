// Unit tests for CreditsService — ported from platform/src/app/api/admin/credits/*.
// Covers tenant scoping, batch confirm → payout-entry creation, the maker-checker
// reversal flow, payout-file generation, and the UTR upload parse/apply branches.
// Run: npx jest src/credits/credits.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { CreditsService } from './credits.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  CreateBatchDto,
  CreateReversalDto,
  FieldAction,
  PayoutGroupType,
  ReversalAction,
} from './dto/credits.dto';
import { CreditAwardType } from '@prisma/client';
import { PAYOUT_FILE_HEADERS } from './credits.helpers';

const mockTx = {
  creditBatch: { update: jest.fn() },
  creditPayoutEntry: { createMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  creditPayoutDownload: { create: jest.fn(), update: jest.fn() },
};

const mockPrisma = {
  creditBatch: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), count: jest.fn() },
  creditField: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  creditPayoutEntry: { findMany: jest.fn() },
  creditPayoutDownload: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  creditReversal: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  outlet: { findMany: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

const mockNotifications = { enqueue: jest.fn().mockResolvedValue({ id: 'n1' }) };

const admin: JwtPayload = {
  sub: 'admin1',
  role: 'CLIENT_ADMIN',
  clientId: 'deoleo',
  phone: '',
  name: '',
};
const gifsy: JwtPayload = {
  sub: 'g1',
  role: 'GIFSY_ADMIN',
  clientId: 'deoleo',
  phone: '',
  name: '',
};

describe('CreditsService', () => {
  let service: CreditsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreditsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();
    service = module.get(CreditsService);
  });

  describe('listBatches', () => {
    it('scopes the query to the caller tenant, newest first', async () => {
      mockPrisma.creditBatch.findMany.mockResolvedValue([]);
      await service.listBatches(admin);
      const arg = mockPrisma.creditBatch.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({ clientId: 'deoleo' });
      expect(arg.orderBy).toEqual({ uploadedAt: 'desc' });
    });
  });

  describe('createBatch', () => {
    it('generates a CB code from the per-client count and persists rows', async () => {
      mockPrisma.creditBatch.count.mockResolvedValue(2);
      mockPrisma.creditBatch.create.mockResolvedValue({ id: 'b1' });
      const dto: CreateBatchDto = {
        period: '2026-05',
        totalOutlets: 1,
        totalPoints: 0,
        totalPayoutInr: 100,
        rows: [],
      };
      await service.createBatch(admin, dto);
      const data = mockPrisma.creditBatch.create.mock.calls[0][0].data;
      expect(data.clientId).toBe('deoleo');
      expect(data.batchCode).toBe('CB-2026-05-003');
      expect(data.uploadedBy).toBe('admin1');
    });
  });

  describe('getBatch', () => {
    it('throws NotFound when outside the tenant', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue(null);
      await expect(service.getBatch(admin, 'b1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('confirmBatch', () => {
    it('rejects a batch that is not PENDING_CONFIRM', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED' });
      await expect(service.confirmBatch(admin, 'b1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('confirms and creates payout entries only for PAYOUT+OK rows', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({
        id: 'b1',
        status: 'PENDING_CONFIRM',
        period: '2026-05',
        uploadedBy: 'admin1',
        totalOutlets: 2,
        totalPoints: 0,
        totalPayoutInr: 300,
        rows: [
          { outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F', amount: 100, narration: '', awardType: 'PAYOUT', status: 'OK' },
          { outletId: 'O2', outletName: 'B', fieldId: 'f1', fieldName: 'F', amount: 200, narration: '', awardType: 'PAYOUT', status: 'ERROR' },
          { outletId: 'O3', outletName: 'C', fieldId: 'f1', fieldName: 'F', amount: 50, narration: '', awardType: 'POINTS', status: 'OK' },
        ],
      });
      mockTx.creditBatch.update.mockResolvedValue({ id: 'b1', status: 'CONFIRMED' });
      const res = await service.confirmBatch(admin, 'b1');
      expect(res.payoutEntriesCreated).toBe(1);
      const createManyArg = mockTx.creditPayoutEntry.createMany.mock.calls[0][0].data;
      expect(createManyArg).toHaveLength(1);
      expect(createManyArg[0].outletId).toBe('O1');
      expect(createManyArg[0].clientId).toBe('deoleo');
      expect(mockNotifications.enqueue).toHaveBeenCalled();
    });
  });

  describe('createReversal (maker-checker request)', () => {
    it('rejects when requested amount exceeds original', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      const dto: CreateReversalDto = {
        outletId: 'O1',
        outletName: 'A',
        fieldId: 'f1',
        fieldName: 'F',
        awardType: CreditAwardType.PAYOUT,
        originalAmount: 100,
        requestedAmount: 200,
      };
      await expect(service.createReversal(admin, 'b1', dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects reversing an unconfirmed batch', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'PENDING_CONFIRM', period: '2026-05' });
      const dto: CreateReversalDto = {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.PAYOUT, originalAmount: 100, requestedAmount: 50,
      };
      await expect(service.createReversal(admin, 'b1', dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('blocks a duplicate pending reversal for the same outlet+field', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      mockPrisma.creditReversal.findFirst.mockResolvedValue({ id: 'r-existing' });
      const dto: CreateReversalDto = {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.PAYOUT, originalAmount: 100, requestedAmount: 50,
      };
      await expect(service.createReversal(admin, 'b1', dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates the reversal scoped to tenant + requester', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      mockPrisma.creditReversal.findFirst.mockResolvedValue(null);
      mockPrisma.creditReversal.create.mockResolvedValue({ id: 'r1' });
      const dto: CreateReversalDto = {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.PAYOUT, originalAmount: 100, requestedAmount: 50,
      };
      await service.createReversal(admin, 'b1', dto);
      const data = mockPrisma.creditReversal.create.mock.calls[0][0].data;
      expect(data.clientId).toBe('deoleo');
      expect(data.requestedBy).toBe('admin1');
      expect(data.period).toBe('2026-05');
    });
  });

  describe('patchReversal (checker approve/reject)', () => {
    it('rejects a reversal that is not PENDING_GIFSY', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'APPROVED' });
      await expect(
        service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('marks PARTIAL when approved amount is below requested', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'PENDING_GIFSY', requestedAmount: 100 });
      mockPrisma.creditReversal.update.mockResolvedValue({ id: 'r1' });
      await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedAmount: 40 });
      expect(mockPrisma.creditReversal.update.mock.calls[0][0].data.status).toBe('PARTIAL');
    });

    it('rejects when approved amount exceeds requested', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'PENDING_GIFSY', requestedAmount: 100 });
      await expect(
        service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedAmount: 200 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('eligibleOutlets', () => {
    it('filters to active outlets of active partners in the tenant', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'O1', name: 'A', phone: '900', outletType: { code: 'GT' } },
      ]);
      const res = await service.eligibleOutlets(admin);
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where.partner).toEqual({ clientId: 'deoleo', isActive: true });
      expect(res[0]).toEqual({ id: 'O1', name: 'A', type: 'GT', phone: '900' });
    });
  });

  describe('createField', () => {
    it('rejects a duplicate field name for the tenant', async () => {
      mockPrisma.creditField.findFirst.mockResolvedValue({ id: 'f1' });
      await expect(
        service.createField(admin, { name: 'Vol', isSeparatePayout: false, outletTypeAwards: {} }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('assigns the next order value', async () => {
      mockPrisma.creditField.findFirst
        .mockResolvedValueOnce(null) // duplicate check
        .mockResolvedValueOnce({ order: 4 }); // max order
      mockPrisma.creditField.create.mockResolvedValue({ id: 'f2' });
      await service.createField(admin, { name: 'New', isSeparatePayout: true, outletTypeAwards: {} });
      expect(mockPrisma.creditField.create.mock.calls[0][0].data.order).toBe(5);
    });
  });

  describe('patchField', () => {
    it('maps the deactivate action to isActive=false', async () => {
      mockPrisma.creditField.findFirst.mockResolvedValue({ id: 'f1' });
      mockPrisma.creditField.update.mockResolvedValue({ id: 'f1' });
      await service.patchField(admin, 'f1', { action: FieldAction.deactivate });
      expect(mockPrisma.creditField.update.mock.calls[0][0].data.isActive).toBe(false);
    });
  });

  describe('createPayoutDownload', () => {
    it('throws when no PENDING entries exist for the period', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
      await expect(
        service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.STANDARD }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('groups entries by outlet, marks them PROCESSING, and returns an xlsx buffer', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'e1', outletId: 'O1', outletName: 'A', amountInr: 100, batch: { batchCode: 'CB-1' } },
        { id: 'e2', outletId: 'O1', outletName: 'A', amountInr: 50, batch: { batchCode: 'CB-1' } },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'O1', name: 'A', phone: '900', isActive: true, partner: { bankName: 'HDFC', bankAccountNumber: '123', ifscCode: 'IFSC', upiId: '' } },
      ]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd1', downloadCode: 'PD-2026-05-001' });

      const res = await service.createPayoutDownload(gifsy, {
        period: '2026-05',
        groupType: PayoutGroupType.STANDARD,
      });

      expect(res.downloadCode).toBe('PD-2026-05-001');
      expect(res.downloadId).toBe('d1');
      // Entries marked PROCESSING with the new download id.
      const updateArg = mockTx.creditPayoutEntry.updateMany.mock.calls[0][0];
      expect(updateArg.data).toEqual({ downloadId: 'd1', status: 'PROCESSING' });
      expect(updateArg.where.id.in).toEqual(['e1', 'e2']);

      // The buffer is a real xlsx with the official headers and a single summed row.
      const wb = XLSX.read(res.buffer, { type: 'buffer' });
      const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[wb.SheetNames[0]], {
        header: 1,
        defval: '',
      }) as (string | number)[][];
      expect(aoa[1]).toEqual(PAYOUT_FILE_HEADERS);
      // Outlet O1 → 100 + 50 = 150 in the "Payout Amount" column (index 10).
      expect(aoa[2][1]).toBe('O1');
      expect(aoa[2][10]).toBe(150);
    });
  });

  describe('uploadUtr', () => {
    const downloadCode = 'PD-2026-05-001';

    // Build an in-memory payout xlsx the parser understands (title row, headers, data).
    function buildUtrFile(rows: (string | number)[][]): Express.Multer.File {
      const aoa = [['title'], ['Batch ID', 'Outlet ID', 'UTR', 'Success/Failure', 'Remarks'], ...rows];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Payout');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      return { buffer } as Express.Multer.File;
    }

    it('throws NotFound when the download is outside the tenant', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue(null);
      await expect(
        service.uploadUtr(gifsy, 'd1', buildUtrFile([]), false),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('previews the parse result without applying when apply=false', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1',
        downloadCode,
        period: '2026-05',
        downloadedBy: 'g1',
        entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountInr: 100 }],
      });
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);

      const file = buildUtrFile([[downloadCode, 'O1', 'UTR123456', 'Success', '']]);
      const res = (await service.uploadUtr(gifsy, 'd1', file, false)) as {
        parseResult: { canProceed: boolean; summary: { paidCount: number } };
        downloadCode: string;
      };
      expect(res.downloadCode).toBe(downloadCode);
      expect(res.parseResult.canProceed).toBe(true);
      expect(res.parseResult.summary.paidCount).toBe(1);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('applies PAID, sets the download to PAID, and notifies the outlet', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1',
        downloadCode,
        period: '2026-05',
        downloadedBy: 'g1',
        entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountInr: 100 }],
      });
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'O1', name: 'A', phone: '900', partnerId: 'p1' },
      ]);

      const file = buildUtrFile([[downloadCode, 'O1', 'UTR123456', 'Success', '']]);
      const res = (await service.uploadUtr(gifsy, 'd1', file, true)) as {
        applied: boolean;
        paidCount: number;
      };
      expect(res.applied).toBe(true);
      expect(res.paidCount).toBe(1);
      expect(mockTx.creditPayoutEntry.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { status: 'PAID', utr: 'UTR123456', paidAt: expect.any(Date) },
      });
      expect(mockTx.creditPayoutDownload.update.mock.calls[0][0].data.status).toBe('PAID');
      expect(mockNotifications.enqueue).toHaveBeenCalled();
    });

    it('refuses to apply when the parse result has errors', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1',
        downloadCode,
        period: '2026-05',
        downloadedBy: 'g1',
        entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountInr: 100 }],
      });
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);

      // Bad UTR (too short) → ERROR → canProceed=false.
      const file = buildUtrFile([[downloadCode, 'O1', 'X1', 'Success', '']]);
      await expect(service.uploadUtr(gifsy, 'd1', file, true)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('listReversals', () => {
    it('scopes by tenant and applies status/period filters', async () => {
      mockPrisma.creditReversal.findMany.mockResolvedValue([]);
      await service.listReversals(gifsy, { status: 'PENDING_GIFSY', period: '2026-05' });
      const where = mockPrisma.creditReversal.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ clientId: 'deoleo', status: 'PENDING_GIFSY', period: '2026-05' });
    });
  });
});
