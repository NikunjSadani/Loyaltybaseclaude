import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappAudienceService } from './whatsapp-audience.service';

const mockPrisma: any = {
  outlet: { findMany: jest.fn() },
  salesUser: { findMany: jest.fn() },
  salesUserAssignment: { findMany: jest.fn() },
};

describe('WhatsappAudienceService', () => {
  let service: WhatsappAudienceService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [WhatsappAudienceService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(WhatsappAudienceService);
  });

  describe('resolveExcel — clean/dedup/invalid', () => {
    it('canonicalises, drops invalid, collapses duplicates', async () => {
      const res = await service.resolveExcel('deoleo', [
        { phone: '+91 98300-11252', variables: ['A'] },
        { phone: '9830011252', variables: ['B'] }, // duplicate of the first (same canonical)
        { phone: '123', variables: ['C'] }, // invalid (too short)
      ]);
      expect(res.recipientCount).toBe(1);
      expect(res.dedupedCount).toBe(1);
      expect(res.invalidCount).toBe(1);
      expect(res.recipients[0].phone).toBe('9830011252');
      expect(res.recipients[0].variables).toEqual(['A']); // first occurrence wins
    });
  });

  describe('resolveFilter — OUTLETS prefers owner phone + dedups across scopes', () => {
    it('prefers partner phone over outlet phone and carries fields', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        {
          name: 'Shop1',
          outletCode: 'O1',
          ownerName: 'Raj',
          phone: '8880000001',
          zone: 'North',
          programName: 'P1',
          programCategory: null,
          state: 'MH',
          city: 'Pune',
          district: null,
          partner: { phone: '9990000001', ownerName: 'Raj Owner' },
        },
      ]);
      const res = await service.resolveFilter('deoleo', 'OUTLETS', undefined);
      expect(res.recipientCount).toBe(1);
      expect(res.recipients[0].phone).toBe('9990000001'); // partner wins
      expect(res.recipients[0].fields.ownerName).toBe('Raj Owner');
      expect(res.recipients[0].fields.zone).toBe('North');
    });

    it('BOTH dedups a phone shared by an outlet owner and a sales rep', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        {
          name: 'Shop1', outletCode: 'O1', ownerName: null, phone: null,
          zone: null, programName: null, programCategory: null, state: 'MH', city: 'X', district: null,
          partner: { phone: '9900000041', ownerName: null },
        },
      ]);
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { employeeCode: 'E1', user: { name: 'Rep', phone: '9900000041' } }, // same phone
      ]);
      const res = await service.resolveFilter('deoleo', 'BOTH', undefined);
      expect(res.recipientCount).toBe(1);
      expect(res.dedupedCount).toBe(1);
    });

    it('excludes deactivated outlets by default (broadcast guard)', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      await service.resolveFilter('deoleo', 'OUTLETS', { states: ['MH'] } as any);
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where.deletedAt).toBeNull();
      expect(where.deactivatedAt).toBeNull();
      expect(where.state).toEqual({ in: ['MH'] });
    });

    it('applies city + groupIds facets to the outlet where', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      await service.resolveFilter('deoleo', 'OUTLETS', {
        cities: ['Pune'],
        groupIds: ['grp1'],
      } as any);
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where.city).toEqual({ in: ['Pune'] });
      expect(where.parentId).toEqual({ in: ['grp1'] });
    });
  });

  describe('resolveFilter — SALES honors the filter (no over-send)', () => {
    it('SALES with NO filter → all tenant reps (tenant-wide)', async () => {
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { employeeCode: 'E1', user: { name: 'Rep1', phone: '9900000001' } },
        { employeeCode: 'E2', user: { name: 'Rep2', phone: '9900000002' } },
      ]);
      const res = await service.resolveFilter('deoleo', 'SALES', undefined);
      expect(res.recipientCount).toBe(2);
      // No assignment lookup on the unfiltered path.
      expect(mockPrisma.salesUserAssignment.findMany).not.toHaveBeenCalled();
    });

    it('SALES WITH a filter → only reps assigned to the filtered outlets', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1' }, { id: 'o2' }]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        { salesUserId: 'su1' },
      ]);
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { employeeCode: 'E1', user: { name: 'Rep1', phone: '9900000001' } },
      ]);
      const res = await service.resolveFilter('deoleo', 'SALES', { states: ['MH'] } as any);
      expect(res.recipientCount).toBe(1);
      // Assignments scoped to the filtered outlet ids, active assignments only.
      expect(mockPrisma.salesUserAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { outletId: { in: ['o1', 'o2'] }, unassignedAt: null },
          distinct: ['salesUserId'],
        }),
      );
      // Sales users narrowed to the assigned ids.
      const suWhere = mockPrisma.salesUser.findMany.mock.calls[0][0].where;
      expect(suWhere.id).toEqual({ in: ['su1'] });
    });

    it('SALES with a filter that matches NO outlets → no reps (never the whole force)', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      const res = await service.resolveFilter('deoleo', 'SALES', { states: ['ZZ'] } as any);
      expect(res.recipientCount).toBe(0);
      expect(mockPrisma.salesUser.findMany).not.toHaveBeenCalled();
    });
  });
});
