// Unit tests for SalesService — ported sales-org domain.
// Covers the hierarchy ownership / cross-tenant IDOR guard (isSelfOrDescendant)
// and tenant scoping (clientId from the JWT) on the ported real routes.
// Run: npx jest src/sales/sales.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SalesService } from './sales.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isSelfOrDescendant } from './sales-hierarchy-access.helper';

const mockPrisma = {
  salesUser: { findFirst: jest.fn(), findMany: jest.fn() },
  salesUserAssignment: { findMany: jest.fn() },
};

const caller: JwtPayload = { sub: 'user-mgr', role: 'SALES', clientId: 'deoleo', phone: '', name: '' };

describe('SalesService', () => {
  let service: SalesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [SalesService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(SalesService);
  });

  describe('getTeam', () => {
    it('scopes the lookup to the caller and their tenant', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue(null);
      const res = await service.getTeam(caller);
      const where = mockPrisma.salesUser.findFirst.mock.calls[0][0].where;
      expect(where).toEqual({
        userId: 'user-mgr',
        user: { clientId: 'deoleo' },
        deletedAt: null,
      });
      // No SalesUser → empty team, not an error.
      expect(res).toEqual({ salesUser: null, members: [] });
    });

    it('maps subordinates into member rows', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({
        id: 'mgr1',
        employeeCode: 'E1',
        region: 'North',
        zone: null,
        hierarchyLevel: { code: 'ASM', name: 'Area Sales Manager', level: 2 },
        subordinates: [
          {
            id: 'sub1',
            employeeCode: 'E2',
            region: 'NCR',
            zone: null,
            joinedAt: new Date('2024-01-01T00:00:00.000Z'),
            user: { name: 'Sub One' },
            hierarchyLevel: { code: 'SO', name: 'Sales Officer', level: 1 },
            _count: { subordinates: 3 },
          },
        ],
      });
      const res = await service.getTeam(caller);
      expect(res.members).toEqual([
        {
          id: 'sub1',
          employeeCode: 'E2',
          name: 'Sub One',
          role: 'SO',
          roleLabel: 'Sales Officer',
          territory: 'NCR',
          teamSize: 3,
          joinedAt: '2024-01-01T00:00:00.000Z',
        },
      ]);
    });
  });

  describe('hierarchy ownership / IDOR guard (getMember)', () => {
    it('throws Forbidden when the caller has no SalesUser record', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null); // caller lookup
      await expect(service.getMember(caller, 'target1')).rejects.toBeInstanceOf(ForbiddenException);
      // Never reaches the edge-list load.
      expect(mockPrisma.salesUser.findMany).not.toHaveBeenCalled();
    });

    it('throws Forbidden when the target is not in the caller subtree (incl. cross-tenant)', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce({ id: 'caller-su' }); // caller lookup
      // Edge list is tenant-scoped; target is absent → outside the subtree.
      mockPrisma.salesUser.findMany.mockResolvedValueOnce([
        { id: 'caller-su', reportingToId: null },
        { id: 'other', reportingToId: 'caller-su' },
      ]);
      await expect(service.getMember(caller, 'target-out-of-tenant')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      // The edge query is tenant-scoped.
      const where = mockPrisma.salesUser.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ user: { clientId: 'deoleo' }, deletedAt: null });
    });

    it('passes the guard for a descendant, then 404s when the member is missing', async () => {
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce({ id: 'caller-su' }) // caller lookup
        .mockResolvedValueOnce(null); // member detail lookup
      mockPrisma.salesUser.findMany.mockResolvedValueOnce([
        { id: 'caller-su', reportingToId: null },
        { id: 'target1', reportingToId: 'caller-su' },
      ]);
      await expect(service.getMember(caller, 'target1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it("INCLUDES partner-less (un-KYC'd) outlets in outlets[] and COUNTS them in kycPending", async () => {
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce({ id: 'caller-su' }) // caller lookup (guard)
        .mockResolvedValueOnce({
          // member-detail lookup
          id: 'target1',
          employeeCode: 'E9',
          region: 'NCR',
          zone: null,
          user: { name: 'Rep Nine', phone: '555' },
          hierarchyLevel: { code: 'SO', name: 'Sales Officer', level: 1 },
          _count: { subordinates: 0 },
          assignments: [
            {
              // KYC'd / partnered outlet → APPROVED
              outlet: {
                id: 'o1',
                name: 'Outlet 1',
                city: 'Delhi',
                outletCode: 'OC1',
                phone: '999',
                partner: {
                  id: 'cp1',
                  kycSubmissions: [{ id: 'k1', status: 'APPROVED' }],
                },
              },
            },
            {
              // partner-less outlet (uploaded, not yet KYC'd) → NOT_STARTED.
              // MUST be included AND counted in kycPending (the bug being fixed).
              outlet: {
                id: 'o2',
                name: 'Outlet 2',
                city: 'Mumbai',
                outletCode: 'OC2',
                phone: '777',
                partner: null,
              },
            },
          ],
        });
      mockPrisma.salesUser.findMany.mockResolvedValueOnce([
        { id: 'caller-su', reportingToId: null },
        { id: 'target1', reportingToId: 'caller-su' },
      ]);

      const res = await service.getMember(caller, 'target1');

      // The detail query selects partner.id so the projection works for both.
      const include = mockPrisma.salesUser.findFirst.mock.calls[1][0].include;
      expect(include.assignments.include.outlet.include.partner.select.id).toBe(true);

      expect(res.member.kycDone).toBe(1);
      expect(res.member.kycPending).toBe(1); // the partner-less NOT_STARTED outlet
      expect(res.member.outlets).toHaveLength(2);

      const o2 = res.member.outlets.find((o) => o.id === 'o2')!;
      expect(o2).toMatchObject({
        id: 'o2',
        partnerId: null,
        name: 'Outlet 2',
        location: 'Mumbai',
        outletCode: 'OC2',
        mobile: '777',
        kycId: '',
        kycStatus: 'NOT_STARTED',
        targetPct: 0,
      });
    });
  });

  describe('getMemberOutlets', () => {
    it('enforces the guard before loading outlets', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null); // caller lookup → Forbidden
      await expect(service.getMemberOutlets(caller, 'target1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mockPrisma.salesUserAssignment.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getMyOutlets', () => {
    it('returns an empty list when the caller is not a sales user', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue(null);
      const res = await service.getMyOutlets(caller);
      expect(res).toEqual({ outlets: [] });
    });

    it('scopes to the caller and INCLUDES partner-less (un-KYC\'d) outlets as NOT_STARTED so the rep can enrol them', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'caller-su' });
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        {
          outlet: {
            id: 'o1',
            outletCode: 'OC1',
            name: 'Outlet 1',
            phone: '999',
            city: 'Delhi',
            district: 'Central',
            state: 'DL',
            outletType: { code: 'RETAIL' },
            partner: {
              id: 'cp1',
              phone: '888',
              wallets: [{ redeemablePoints: 1500 }],
              kycSubmissions: [
                { id: 'k1', status: 'APPROVED', createdAt: new Date('2024-05-01T00:00:00.000Z') },
              ],
            },
          },
        },
        // partner-less outlet (uploaded via master file, not yet KYC'd) → MUST be
        // surfaced (this was the bug: a rep whose outlets were all un-KYC'd saw none).
        {
          outlet: {
            id: 'o2',
            outletCode: 'OC2',
            name: 'Outlet 2',
            phone: '777',
            city: 'Mumbai',
            district: 'West',
            state: 'MH',
            outletType: { code: 'RETAIL' },
            partner: null,
          },
        },
      ]);
      const res = await service.getMyOutlets(caller);
      const where = mockPrisma.salesUserAssignment.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ salesUserId: 'caller-su', outletId: { not: null }, unassignedAt: null });

      expect(res.outlets).toHaveLength(2);
      expect(res.outlets[0]).toMatchObject({
        id: 'o1', partnerId: 'cp1', balance: 1500, kycId: 'k1', kycStatus: 'APPROVED', kycSubmittedAt: '2024-05-01',
      });
      // the un-KYC'd outlet: surfaced, partner-derived fields null/0, NOT_STARTED.
      expect(res.outlets[1]).toMatchObject({
        id: 'o2', partnerId: null, balance: 0, kycId: '',
        outletCode: 'OC2', name: 'Outlet 2', mobile: '777', location: 'Mumbai',
        type: 'RETAIL', kycStatus: 'NOT_STARTED', targetPct: 0,
      });
      expect(res.outlets[1].kycSubmittedAt).toBeUndefined();
    });
  });
});

// Direct coverage of the ported pure access helper (cross-tenant IDOR fix).
describe('isSelfOrDescendant', () => {
  const edges = [
    { id: 'rsm', reportingToId: null },
    { id: 'asm', reportingToId: 'rsm' },
    { id: 'so', reportingToId: 'asm' },
    { id: 'other', reportingToId: null },
  ];

  it('returns true for self', () => {
    expect(isSelfOrDescendant('asm', 'asm', edges)).toBe(true);
  });

  it('returns true for a descendant (transitively)', () => {
    expect(isSelfOrDescendant('so', 'rsm', edges)).toBe(true);
  });

  it('returns false for a non-descendant in the same tenant', () => {
    expect(isSelfOrDescendant('other', 'asm', edges)).toBe(false);
  });

  it('returns false when the target is absent from the edge list (cross-tenant)', () => {
    expect(isSelfOrDescendant('foreign-id', 'rsm', edges)).toBe(false);
  });

  it('guards against cycles', () => {
    const cyclic = [
      { id: 'a', reportingToId: 'b' },
      { id: 'b', reportingToId: 'a' },
    ];
    expect(isSelfOrDescendant('a', 'caller', cyclic)).toBe(false);
  });
});
