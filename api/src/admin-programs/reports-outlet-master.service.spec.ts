// Unit tests for ReportsService.pointsLedger's per-tenant outlet-type label.
// The Outlet Master export moved to the `outlet-master` export kind — its specs (57/59 headers, rung mapping,
// Profile Status, doc links, geo, Bajaj headers, PARITY with the old builder) live in
// src/exports/kinds/batch1/outlet-master.spec.ts.

import { Test, TestingModule } from '@nestjs/testing';
import { ReportsService } from './reports.service';
import { PrismaService } from '../prisma/prisma.service';
import { TargetsService } from '../targets/targets.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const admin: JwtPayload = { sub: 'a1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };

const mockPrisma = {
  outlet: { findMany: jest.fn() },
  outletTypeClientConfig: { findMany: jest.fn() },
};

describe('ReportsService (admin reports)', () => {
  let service: ReportsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: no per-tenant outlet-type display names → export uses the global `name` (Deoleo-identical).
    mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TargetsService, useValue: { getPace: jest.fn() } },
      ],
    }).compile();
    service = module.get(ReportsService);
  });

  // ── pointsLedger: the per-tenant outlet-type display name in the statement rows ──
  describe('pointsLedger (Outlet Type = displayName ?? name)', () => {
    const outletWithLedger = (over: Record<string, unknown> = {}) => ({
      id: 'o1', name: 'Shop One',
      outletType: { id: 'ot_sss', name: 'SSS' },
      partner: { wallets: [{ pointsLedger: [{ transactionType: 'EARN', points: 100, createdAt: new Date('2026-06-10T00:00:00Z') }] }] },
      ...over,
    });

    it('renders the renamed outlet type (scoped to the caller tenant)', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([outletWithLedger()]);
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([{ outletTypeId: 'ot_sss', displayName: 'Retailer' }]);

      const res = (await service.pointsLedger(admin, { from: '2026-06', to: '2026-06' } as never)) as { rows: { outletType?: string }[] };
      expect(res.rows[0].outletType).toBe('Retailer');
      expect(mockPrisma.outletTypeClientConfig.findMany.mock.calls[0][0].where).toMatchObject({ clientId: 'deoleo' });
    });

    it('falls back to outletType.name when the tenant set no displayName (Deoleo parity)', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([outletWithLedger()]);
      // Default [] config (beforeEach) → empty map → original name.
      const res = (await service.pointsLedger(admin, { from: '2026-06', to: '2026-06' } as never)) as { rows: { outletType?: string }[] };
      expect(res.rows[0].outletType).toBe('SSS');
    });
  });
});
