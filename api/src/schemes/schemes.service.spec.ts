// Unit tests for SchemesService — mirrors the tickets/wallet pilot template.
// Covers tenant scoping, the non-admin eligibility filter, soft-delete handling,
// and the target percentage/enrichment logic ported from the Next routes.
// Run: npx jest src/schemes/schemes.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SchemesService } from './schemes.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  scheme: { findMany: jest.fn(), count: jest.fn(), create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  schemeEligibility: { findMany: jest.fn() },
  schemeEnrollmentForm: { upsert: jest.fn(), findUnique: jest.fn() },
  // Wave 3 enrollment threading (submitEnrollment / getMyEnrollment).
  channelPartner: { findFirst: jest.fn() },
  salesUser: { findFirst: jest.fn() },
  salesUserAssignment: { findFirst: jest.fn() },
  outlet: { findMany: jest.fn() },
  schemeEnrollment: { upsert: jest.fn(), findUnique: jest.fn() },
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const clientAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' };

describe('SchemesService', () => {
  let service: SchemesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [SchemesService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(SchemesService);
  });

  describe('list', () => {
    it('scopes admins to non-deleted schemes in their tenant (all statuses when none supplied)', async () => {
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      mockPrisma.scheme.count.mockResolvedValue(0);
      await service.list(clientAdmin, {});
      const where = mockPrisma.scheme.findMany.mock.calls[0][0].where;
      // Default (no status) returns ALL non-deleted statuses so the FE "All" pill works.
      expect(where).toEqual({ clientId: 'deoleo', deletedAt: null });
      expect(mockPrisma.schemeEligibility.findMany).not.toHaveBeenCalled();
    });

    it('restricts non-admins to schemes they are eligible for', async () => {
      mockPrisma.schemeEligibility.findMany.mockResolvedValue([{ schemeId: 's1' }, { schemeId: 's2' }]);
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      mockPrisma.scheme.count.mockResolvedValue(0);
      await service.list(partner, {});
      expect(mockPrisma.schemeEligibility.findMany).toHaveBeenCalledWith({
        where: { specificPartnerId: 'user1' },
        select: { schemeId: true },
      });
      const where = mockPrisma.scheme.findMany.mock.calls[0][0].where;
      // Non-admins keep the ACTIVE-only default (partner/sales enrollment views).
      expect(where).toEqual({ clientId: 'deoleo', status: 'ACTIVE', deletedAt: null, id: { in: ['s1', 's2'] } });
    });

    it('IGNORES an explicit ?status for a non-admin — forced to ACTIVE (no draft/expired leak)', async () => {
      // Security: a partner/sales caller hand-crafting ?status=EXPIRED must NOT bypass the
      // ACTIVE-only default (their eligibility rows could otherwise expose an unpublished
      // scheme's name/code/dates). The status filter is admin-gated.
      mockPrisma.schemeEligibility.findMany.mockResolvedValue([{ schemeId: 's1' }]);
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      mockPrisma.scheme.count.mockResolvedValue(0);
      await service.list(partner, { status: 'EXPIRED' as never });
      const where = mockPrisma.scheme.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('ACTIVE'); // NOT 'EXPIRED'
      expect(where.id).toEqual({ in: ['s1'] });
    });

    it('applies status + type filters when supplied', async () => {
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      mockPrisma.scheme.count.mockResolvedValue(0);
      await service.list(clientAdmin, { status: 'DRAFT' as never, type: 'VISIBILITY' as never });
      const where = mockPrisma.scheme.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('DRAFT');
      expect(where.schemeType).toBe('VISIBILITY');
    });

    it('applies the search OR (name + code) on BOTH find and count, narrowing tenant scope', async () => {
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      mockPrisma.scheme.count.mockResolvedValue(0);
      await service.list(clientAdmin, { search: 'Summer' });
      const expectedOr = [
        { name: { contains: 'Summer', mode: 'insensitive' } },
        { code: { contains: 'Summer', mode: 'insensitive' } },
      ];
      expect(mockPrisma.scheme.findMany.mock.calls[0][0].where.OR).toEqual(expectedOr);
      expect(mockPrisma.scheme.count.mock.calls[0][0].where.OR).toEqual(expectedOr);
      expect(mockPrisma.scheme.findMany.mock.calls[0][0].where.clientId).toBe('deoleo');
    });

    it('paginates: skip/take derive from page/limit and the envelope is canonical', async () => {
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      mockPrisma.scheme.count.mockResolvedValue(0);
      const res = await service.list(clientAdmin, { page: 2, limit: 15 });
      const args = mockPrisma.scheme.findMany.mock.calls[0][0];
      expect(args.skip).toBe(15); // (2 - 1) * 15
      expect(args.take).toBe(15);
      expect(res.pagination).toEqual({ page: 2, limit: 15, total: 0, pages: 0 });
    });
  });

  describe('create', () => {
    it('persists with tenant + creator and normalizes dates', async () => {
      mockPrisma.scheme.create.mockResolvedValue({ id: 's1' });
      await service.create(gifsy, {
        code: 'C1',
        name: 'Scheme',
        schemeType: 'PURCHASE_INCENTIVE' as never,
        rewardType: 'POINTS' as never,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });
      const data = mockPrisma.scheme.create.mock.calls[0][0].data;
      expect(data.clientId).toBe('deoleo');
      expect(data.createdByUserId).toBe('admin1');
      expect(data.status).toBe('ACTIVE');
      expect(data.startDate).toBeInstanceOf(Date);
    });
  });

  describe('getOne', () => {
    it('throws NotFound when missing', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(null);
      await expect(service.getOne(partner, 's1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFound when soft-deleted', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', deletedAt: new Date() });
      await expect(service.getOne(partner, 's1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the scheme when live', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', deletedAt: null });
      await expect(service.getOne(partner, 's1')).resolves.toEqual({ scheme: { id: 's1', deletedAt: null } });
    });
  });

  describe('update', () => {
    it('throws NotFound when the scheme is outside the tenant', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(null);
      await expect(service.update(clientAdmin, 's1', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('only writes whitelisted fields (drops the World-A rules pass-through)', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1' });
      mockPrisma.scheme.update.mockResolvedValue({ id: 's1' });
      await service.update(clientAdmin, 's1', { name: 'New', status: 'PAUSED' as never });
      const data = mockPrisma.scheme.update.mock.calls[0][0].data;
      expect(data.name).toBe('New');
      expect(data.status).toBe('PAUSED');
      expect(data.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('remove', () => {
    it('forbids non-GIFSY admins', async () => {
      await expect(service.remove(clientAdmin, 's1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('soft-deletes and cancels for GIFSY admins', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1' });
      mockPrisma.scheme.update.mockResolvedValue({ id: 's1' });
      const res = await service.remove(gifsy, 's1');
      const data = mockPrisma.scheme.update.mock.calls[0][0].data;
      expect(data.deletedAt).toBeInstanceOf(Date);
      expect(data.status).toBe('CANCELLED');
      expect(res).toEqual({ message: 'Scheme deleted successfully' });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P4.2 — upsertEnrollmentForm
  // ─────────────────────────────────────────────────────────────────────────

  const validFormDto = {
    campaignType: 'LOYALTY_ONLY' as const,
    formSchema: {
      captureGpsOnSubmit: false,
      requireOtp: false,
      fields: [
        {
          id: 'f1',
          type: 'TEXT',
          label: 'Name',
          required: true,
          autoFillFromExcel: false,
          autoFillEditable: false,
          order: 0,
        },
      ],
    },
  };

  describe('upsertEnrollmentForm', () => {
    it('throws Forbidden for non-admin callers', async () => {
      await expect(
        service.upsertEnrollmentForm(partner, 's1', validFormDto),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws NotFound when the schemeId does not belong to the tenant', async () => {
      // findFirst returns null → scheme is missing/cross-tenant
      mockPrisma.scheme.findFirst.mockResolvedValue(null);
      await expect(
        service.upsertEnrollmentForm(clientAdmin, 'unknown-scheme', validFormDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFound for a soft-deleted scheme', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', clientId: 'deoleo', deletedAt: new Date() });
      await expect(
        service.upsertEnrollmentForm(clientAdmin, 's1', validFormDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('upserts the enrollment form with the correct fields', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', clientId: 'deoleo', deletedAt: null });
      const fakeForm = { id: 'ef1', schemeId: 's1', campaignType: 'LOYALTY_ONLY', formSchema: validFormDto.formSchema };
      mockPrisma.schemeEnrollmentForm.upsert.mockResolvedValue(fakeForm);

      const result = await service.upsertEnrollmentForm(clientAdmin, 's1', validFormDto);

      expect(result).toEqual({ enrollmentForm: fakeForm });

      const upsertCall = mockPrisma.schemeEnrollmentForm.upsert.mock.calls[0][0];
      expect(upsertCall.where).toEqual({ schemeId: 's1' });
      expect(upsertCall.create.schemeId).toBe('s1');
      expect(upsertCall.create.campaignType).toBe('LOYALTY_ONLY');
      expect(upsertCall.update.campaignType).toBe('LOYALTY_ONLY');
    });

    it('verifies tenant scope: findFirst is called with both id and clientId', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', clientId: 'deoleo', deletedAt: null });
      mockPrisma.schemeEnrollmentForm.upsert.mockResolvedValue({ id: 'ef1' });

      await service.upsertEnrollmentForm(gifsy, 's1', validFormDto);

      expect(mockPrisma.scheme.findFirst).toHaveBeenCalledWith({
        where: { id: 's1', clientId: 'deoleo' },
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P4.2 — getEnrollmentForm
  // ─────────────────────────────────────────────────────────────────────────

  describe('getEnrollmentForm', () => {
    it('throws NotFound when the schemeId is outside the tenant', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(null);
      await expect(
        service.getEnrollmentForm(partner, 's1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFound when no enrollment form is configured', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', clientId: 'deoleo', deletedAt: null });
      mockPrisma.schemeEnrollmentForm.findUnique.mockResolvedValue(null);
      await expect(
        service.getEnrollmentForm(partner, 's1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the enrollment form when it exists', async () => {
      const fakeForm = { id: 'ef1', schemeId: 's1', campaignType: 'OPEN_CAMPAIGN', formSchema: {} };
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', clientId: 'deoleo', deletedAt: null });
      mockPrisma.schemeEnrollmentForm.findUnique.mockResolvedValue(fakeForm);

      const result = await service.getEnrollmentForm(partner, 's1');
      expect(result).toEqual({ enrollmentForm: fakeForm });
      expect(mockPrisma.schemeEnrollmentForm.findUnique).toHaveBeenCalledWith({
        where: { schemeId: 's1' },
      });
    });

    it('always checks tenant scope before reading the form', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', clientId: 'deoleo', deletedAt: null });
      mockPrisma.schemeEnrollmentForm.findUnique.mockResolvedValue({ id: 'ef1', schemeId: 's1' });

      await service.getEnrollmentForm(partner, 's1');

      // The tenant-scope query always includes clientId from the JWT
      expect(mockPrisma.scheme.findFirst).toHaveBeenCalledWith({
        where: { id: 's1', clientId: 'deoleo' },
      });
    });
  });

});

// ── Wave 3 login picker: enrollment acts on the ACTIVE partner (resolveActivePartnerId) ──────
//
// SchemeEnrollment is now keyed by the SHOP (@@unique[schemeId, partnerId]); userId is optional
// audit metadata. A login-less same-group sibling (userId = null) is therefore FULLY enrollable —
// its enrollment is keyed by its partnerId and records userId = null. Own / absent-header paths stay
// byte-identical (subject = the login's own shop, userId = user.sub). The SALES-on-behalf branch
// targets an explicit outlet and never consults the selector.
describe('SchemesService — Wave 3 enrollment threading', () => {
  let service: SchemesService;

  // An ACTIVE, in-window scheme with NO enrollment form → campaignType defaults MIXED (no KYC gate,
  // no form-values validation), so the enrollment path reaches the upsert.
  const activeScheme = {
    id: 'sch1',
    clientId: 'deoleo',
    status: 'ACTIVE',
    deletedAt: null,
    startDate: new Date('2026-01-01'),
    endDate: new Date('2030-01-01'),
    enrollmentForm: null,
  };

  // Outlet switching needs a real 10-digit phone (operable set = same-group + same-phone).
  const switcher: JwtPayload = { sub: 'user1', role: 'SSS', clientId: 'deoleo', phone: '9800000001', name: '' };
  const salesUser: JwtPayload = { sub: 'salesUser1', role: 'SALES_ISR', clientId: 'deoleo', phone: '9900000041', name: '' };
  const selfDto = () => ({ enrollmentMode: 'SELF' }) as never;
  const salesEnrollDto = () => ({ enrollmentMode: 'SALES', targetPartnerId: 'tp1' }) as never;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.scheme.findFirst.mockResolvedValue(activeScheme);
    mockPrisma.schemeEnrollment.upsert.mockResolvedValue({ id: 'enr1' });
    const module: TestingModule = await Test.createTestingModule({
      providers: [SchemesService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(SchemesService);
  });

  describe('submitEnrollment (SELF)', () => {
    it('no header → enrolls the login’s OWN user (byte-identical to today)', async () => {
      // resolveActivePartnerId own lookup (where.userId) → own; not switched → enrolledUserId = user.sub.
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', groupId: 'g1' });

      await service.submitEnrollment(switcher, 'sch1', selfDto());

      expect(mockPrisma.channelPartner.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user1', clientId: 'deoleo', deletedAt: null, isParent: false },
        select: { id: true, groupId: true },
      });
      expect(mockPrisma.schemeEnrollment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { schemeId_partnerId: { schemeId: 'sch1', partnerId: 'cp1' } },
        }),
      );
      // Subject = own shop (cp1); audit userId = the login.
      const upsertCall = mockPrisma.schemeEnrollment.upsert.mock.calls[0][0];
      expect(upsertCall.create.partnerId).toBe('cp1');
      expect(upsertCall.create.userId).toBe('user1');
    });

    it('forbidden selector (outside the operable set) → ForbiddenException, no enrollment', async () => {
      // own has no group → any non-own selector is a forbidden cross-partner reach.
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', groupId: null });

      await expect(
        service.submitEnrollment(switcher, 'sch1', selfDto(), 'someoneElse'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.schemeEnrollment.upsert).not.toHaveBeenCalled();
    });

    it('switched login-less sibling (userId=null) → SELF-enrolls the SHOP; enrollment userId is null', async () => {
      // own lookup (where.userId) → own (group g1); by-id lookups (helper sibling-auth + the audit
      // userId re-fetch) → the login-less sibling (userId null).
      mockPrisma.channelPartner.findFirst.mockImplementation((args: any) =>
        args.where.userId
          ? Promise.resolve({ id: 'cp1', groupId: 'g1' })
          : Promise.resolve({ id: 'sib1', userId: null }),
      );

      await service.submitEnrollment(switcher, 'sch1', selfDto(), 'sib1');

      // The enrollment is keyed by the SIBLING shop, with a null audit userId (no login of its own).
      expect(mockPrisma.schemeEnrollment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { schemeId_partnerId: { schemeId: 'sch1', partnerId: 'sib1' } },
        }),
      );
      const upsertCall = mockPrisma.schemeEnrollment.upsert.mock.calls[0][0];
      expect(upsertCall.create.partnerId).toBe('sib1');
      expect(upsertCall.create.userId).toBeNull();
    });

    it('no partner at all → today’s no-partner ForbiddenException', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      await expect(service.submitEnrollment(switcher, 'sch1', selfDto())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mockPrisma.schemeEnrollment.upsert).not.toHaveBeenCalled();
    });
  });

  describe('submitEnrollment (SALES on-behalf) — selector must NOT affect it', () => {
    it('ignores x-active-partner-id and enrolls the TARGET partner’s user via the assignment path', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      // Target partner resolved by id (NOT via resolveActivePartnerId's own userId lookup).
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'tp1', userId: 'targetUser' });
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asg1' });

      // A selector IS passed — the SALES branch must ignore it entirely.
      await service.submitEnrollment(salesUser, 'sch1', salesEnrollDto(), 'sib1');

      // Enrollment is keyed to the TARGET shop, not to any switched partner; audit userId = target's.
      expect(mockPrisma.schemeEnrollment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { schemeId_partnerId: { schemeId: 'sch1', partnerId: 'tp1' } },
        }),
      );
      const upsertCall = mockPrisma.schemeEnrollment.upsert.mock.calls[0][0];
      expect(upsertCall.create.userId).toBe('targetUser');
      // Proof the SELF/resolveActivePartnerId path was never taken: no own (where.userId) lookup.
      const ownLookups = mockPrisma.channelPartner.findFirst.mock.calls.filter(
        (c: any) => c[0]?.where?.userId !== undefined,
      );
      expect(ownLookups).toHaveLength(0);
    });
  });

  describe('getMyEnrollment', () => {
    it('no header → reads the login’s OWN enrollment (byte-identical to today)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', groupId: 'g1' });
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue({ id: 'enr1' });

      await service.getMyEnrollment(switcher, 'sch1');

      expect(mockPrisma.schemeEnrollment.findUnique).toHaveBeenCalledWith({
        where: { schemeId_partnerId: { schemeId: 'sch1', partnerId: 'cp1' } },
      });
    });

    it('forbidden selector → ForbiddenException, no enrollment read', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', groupId: null });
      await expect(service.getMyEnrollment(switcher, 'sch1', 'someoneElse')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mockPrisma.schemeEnrollment.findUnique).not.toHaveBeenCalled();
    });

    it('switched login-less sibling → reads the SIBLING shop’s enrollment (keyed by partnerId)', async () => {
      mockPrisma.channelPartner.findFirst.mockImplementation((args: any) =>
        args.where.userId
          ? Promise.resolve({ id: 'cp1', groupId: 'g1' })
          : Promise.resolve({ id: 'sib1', userId: null }),
      );
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue({ id: 'enrSib' });

      const res = await service.getMyEnrollment(switcher, 'sch1', 'sib1');

      expect(res).toEqual({ enrollment: { id: 'enrSib' } });
      expect(mockPrisma.schemeEnrollment.findUnique).toHaveBeenCalledWith({
        where: { schemeId_partnerId: { schemeId: 'sch1', partnerId: 'sib1' } },
      });
    });
  });
});
