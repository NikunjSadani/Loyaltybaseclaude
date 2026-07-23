// Unit tests for ParentsService — the parent-child owner-group parent entity
// (docs/plans/PARTNER-MULTI-OUTLET.md §2.2). Proves: parents are created login-less +
// wallet-less; details are cross-group-uniqueness-checked; approval is wallet-less.
// Run: npx jest src/admin-outlets/parents.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ParentsService } from './parents.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  channelPartner: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  outlet: { findFirst: jest.fn() },
  user: { update: jest.fn() },
  auditLog: { create: jest.fn() },
  // acquireIdentityLocks issues a raw advisory-lock statement inside the tx.
  $executeRaw: jest.fn(),
  // createParent/approveParent wrap the uniqueness check + write in one interactive tx.
  // The mock runs the callback with mockPrisma itself as the tx client (same model methods).
  $transaction: jest.fn(),
};

/** Build a Prisma P2002 unique-constraint error (the partial-unique index race path). */
function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

const mockTenantSettings = { getEffectiveSettings: jest.fn() };

const TENANT_A = 'tenant-a';
const admin: JwtPayload = { sub: 'actor1', role: 'GIFSY_ADMIN', clientId: TENANT_A, phone: '', name: '' };

describe('ParentsService', () => {
  let service: ParentsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTenantSettings.getEffectiveSettings.mockResolvedValue({
      uniquenessPolicy: { gst: true, phone: true, bank: true, upi: true },
    });
    mockPrisma.channelPartner.findMany.mockResolvedValue([]); // no uniqueness clashes by default
    mockPrisma.channelPartner.findUnique.mockResolvedValue(null);
    mockPrisma.outlet.findFirst.mockResolvedValue(null);
    mockPrisma.$executeRaw.mockResolvedValue(1);
    // Run the interactive-tx callback with mockPrisma acting as the tx client.
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) =>
      fn(mockPrisma),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ParentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
      ],
    }).compile();
    service = module.get(ParentsService);
  });

  describe('createParent', () => {
    it('creates a bare parent LOGIN-LESS (userId=null) + WALLET-LESS, approved on create', async () => {
      mockPrisma.channelPartner.findUnique.mockResolvedValue(null); // code free
      mockPrisma.channelPartner.create.mockResolvedValue({ id: 'parent1', partnerCode: 'CPP99' });

      const res = await service.createParent(admin, { partnerCode: 'CPP99' });

      const data = mockPrisma.channelPartner.create.mock.calls[0][0].data;
      expect(data.isParent).toBe(true);
      expect(data.userId).toBeNull(); // login-less at create (HARD constraint)
      expect(data.clientId).toBe(TENANT_A);
      // A bare (detail-less) parent has nothing to review → approved on create.
      expect(data.onboardedAt).toBeInstanceOf(Date);
      expect(res.pendingGifsyApproval).toBe(false);
      // ParentsService never injects/creates a Wallet — proven structurally (no wallet model
      // exists on the mock and none is referenced).
      expect((mockPrisma as Record<string, unknown>).wallet).toBeUndefined();
    });

    it('a detailed parent runs uniqueness + is left UNAPPROVED (onboardedAt null) pending Gifsy', async () => {
      mockPrisma.channelPartner.findUnique.mockResolvedValue(null);
      mockPrisma.channelPartner.findMany.mockResolvedValue([]); // no clash
      mockPrisma.channelPartner.create.mockResolvedValue({ id: 'parent1' });

      const res = await service.createParent(admin, {
        partnerCode: 'CPP01',
        panNumber: 'ZXCVB1234Z',
        gstNumber: '27ZXCVB1234Z1Z1',
      });

      const data = mockPrisma.channelPartner.create.mock.calls[0][0].data;
      expect(data.panNumber).toBe('ZXCVB1234Z');
      expect(data.onboardedAt).toBeNull(); // awaiting Gifsy approval
      expect(res.pendingGifsyApproval).toBe(true);
    });

    it('persists NORMALIZED (upper-cased + trimmed) PAN/GST even when supplied lower-case', async () => {
      mockPrisma.channelPartner.findUnique.mockResolvedValue(null);
      mockPrisma.channelPartner.findMany.mockResolvedValue([]); // no clash
      mockPrisma.channelPartner.create.mockResolvedValue({ id: 'parent1' });

      await service.createParent(admin, {
        partnerCode: 'CPP01',
        panNumber: '  zxcvb1234z ',
        gstNumber: '27zxcvb1234z1z1',
      });

      const data = mockPrisma.channelPartner.create.mock.calls[0][0].data;
      // Canonical form = the case-sensitive partial-unique DB index's form → a lower-case value
      // can no longer slip past the app check + the index.
      expect(data.panNumber).toBe('ZXCVB1234Z');
      expect(data.gstNumber).toBe('27ZXCVB1234Z1Z1');
    });

    it('takes the advisory lock + runs the uniqueness check INSIDE the tx before create', async () => {
      mockPrisma.channelPartner.findUnique.mockResolvedValue(null);
      mockPrisma.channelPartner.findMany.mockResolvedValue([]);
      mockPrisma.channelPartner.create.mockResolvedValue({ id: 'parent1' });

      await service.createParent(admin, { partnerCode: 'CPP01', panNumber: 'ZXCVB1234Z' });

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      // acquireIdentityLocks fired for the (enforced) PAN value.
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    });

    it('a bare (detail-less) parent takes NO advisory lock', async () => {
      mockPrisma.channelPartner.findUnique.mockResolvedValue(null);
      mockPrisma.channelPartner.create.mockResolvedValue({ id: 'parent1', partnerCode: 'CPP99' });

      await service.createParent(admin, { partnerCode: 'CPP99' });

      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('maps a partial-unique-index P2002 on create to a clean 400 (not a raw 500)', async () => {
      mockPrisma.channelPartner.findUnique.mockResolvedValue(null);
      mockPrisma.channelPartner.findMany.mockResolvedValue([]);
      mockPrisma.channelPartner.create.mockRejectedValue(p2002());

      await expect(
        service.createParent(admin, { partnerCode: 'CPP01', panNumber: 'ZXCVB1234Z' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a duplicate partnerCode', async () => {
      mockPrisma.channelPartner.findUnique.mockResolvedValue({ id: 'exists' });
      await expect(service.createParent(admin, { partnerCode: 'CPP01' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockPrisma.channelPartner.create).not.toHaveBeenCalled();
    });

    it('rejects when the parent PAN is already used by an outlet outside any group', async () => {
      mockPrisma.channelPartner.findUnique.mockResolvedValue(null);
      // checkGroupUniqueness PAN search finds an existing owner (ungrouped → outside).
      mockPrisma.channelPartner.findMany.mockResolvedValueOnce([
        { id: 'other', outlets: [{ parentId: null }] },
      ]);
      await expect(
        service.createParent(admin, { partnerCode: 'CPP01', panNumber: 'ZXCVB1234Z' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.channelPartner.create).not.toHaveBeenCalled();
    });
  });

  describe('approveParent', () => {
    it('approves WALLET-LESS: sets onboardedAt, never creates a wallet or activates an outlet', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        id: 'parent1',
        userId: null,
        onboardedAt: null,
        gstNumber: null,
        panNumber: 'ZXCVB1234Z',
        bankAccountNumber: null,
        upiId: null,
      });
      // resolveGroupPan → the parent's own PAN → matches itself.
      mockPrisma.channelPartner.findUnique.mockResolvedValue({ panNumber: 'ZXCVB1234Z' });
      mockPrisma.channelPartner.findMany.mockResolvedValue([]); // no outside clash
      mockPrisma.channelPartner.update.mockResolvedValue({ id: 'parent1', onboardedAt: new Date() });

      const res = await service.approveParent(admin, 'parent1');

      expect(res.approved).toBe(true);
      expect(mockPrisma.channelPartner.update.mock.calls[0][0].data.onboardedAt).toBeInstanceOf(Date);
      // No login user to activate.
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      // Structurally wallet-less: no wallet model on the mock, none referenced.
      expect((mockPrisma as Record<string, unknown>).wallet).toBeUndefined();
    });

    it('activates the parent login user when one is present', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        id: 'parent1',
        userId: 'u1',
        onboardedAt: null,
        gstNumber: null,
        panNumber: null,
        bankAccountNumber: null,
        upiId: null,
      });
      mockPrisma.channelPartner.update.mockResolvedValue({ id: 'parent1' });

      await service.approveParent(admin, 'parent1');

      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u1' }, data: { status: 'ACTIVE' } }),
      );
    });

    it('re-persists CANONICAL (upper-cased) identity values, canonicalising a legacy lower-case row', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        id: 'parent1',
        userId: null,
        onboardedAt: null,
        gstNumber: '27zxcvb1234z1z1', // stored lower-case (legacy / pre-fix)
        panNumber: 'zxcvb1234z',
        bankAccountNumber: null,
        upiId: null,
      });
      mockPrisma.channelPartner.findUnique.mockResolvedValue({ panNumber: 'ZXCVB1234Z' });
      mockPrisma.channelPartner.findMany.mockResolvedValue([]);
      mockPrisma.channelPartner.update.mockResolvedValue({ id: 'parent1' });

      await service.approveParent(admin, 'parent1');

      const data = mockPrisma.channelPartner.update.mock.calls[0][0].data;
      expect(data.panNumber).toBe('ZXCVB1234Z');
      expect(data.gstNumber).toBe('27ZXCVB1234Z1Z1');
      // The whole check+write ran inside one tx with the advisory lock taken.
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    });

    it('maps a partial-unique-index P2002 on approve to a clean 400', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        id: 'parent1',
        userId: null,
        onboardedAt: null,
        gstNumber: null,
        panNumber: 'ZXCVB1234Z',
        bankAccountNumber: null,
        upiId: null,
      });
      mockPrisma.channelPartner.findUnique.mockResolvedValue({ panNumber: 'ZXCVB1234Z' });
      mockPrisma.channelPartner.findMany.mockResolvedValue([]);
      mockPrisma.channelPartner.update.mockRejectedValue(p2002());

      await expect(service.approveParent(admin, 'parent1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFound for an unknown parent', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      await expect(service.approveParent(admin, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
