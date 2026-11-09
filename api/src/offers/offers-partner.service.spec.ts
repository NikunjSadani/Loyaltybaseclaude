// Unit tests for OffersPartnerService — flag gate, active-partner re-auth, IST "today" window,
// segment matching (D4: ANY outlet), per-tile KPI progress over MATCHING outlets only, sort, and
// the partner projection (no targeting/audit leak).
// Run: npx jest src/offers/offers-partner.service.spec.ts --no-coverage

import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { OffersPartnerService } from './offers-partner.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveActivePartnerId } from '../common/partner-group.helper';
import { istDateKey, istMonthKey } from '../common/ist-date';
import { istDayToDate } from './offers.helpers';

jest.mock('../common/partner-group.helper', () => ({ resolveActivePartnerId: jest.fn() }));
const mockResolve = resolveActivePartnerId as jest.MockedFunction<typeof resolveActivePartnerId>;

const mockPrisma = {
  offerTile: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
  outletTarget: { findMany: jest.fn() },
  outletSalesRecord: { findMany: jest.fn() },
  kpiDef: { findMany: jest.fn() },
};
const tenant = { resolveClient: jest.fn() };

const partner: JwtPayload = { sub: 'pu1', role: 'SSS', clientId: 'bajaj', phone: '9999999999', name: '' };

function tile(over: Record<string, unknown> = {}) {
  return {
    id: 't1', clientId: 'bajaj', group: 'TARGET_REWARD', valueType: 'POINTS',
    valueNumber: new Prisma.Decimal('35'), valueText: null, unitLabel: 'per case', product: 'ADHO 50 ml',
    label: 'Earn on every case', details: null,
    validFrom: istDayToDate('2026-01-01'), validTo: istDayToDate('2099-12-31'),
    sortOrder: 0, isActive: true, programNames: [], outletTypeCodes: [], zones: [], states: [],
    kpiCode: null, copiedFromId: null, createdById: 'u1', updatedById: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), deletedAt: null,
    ...over,
  };
}

const OUTLETS = [
  { outletCode: 'O1', programName: 'Gold', zone: 'North', state: 'Maharashtra', outletType: { code: 'SSS' } },
  { outletCode: 'O2', programName: 'Silver', zone: 'North', state: 'Maharashtra', outletType: { code: 'SSS' } },
];

describe('OffersPartnerService', () => {
  let service: OffersPartnerService;

  beforeEach(async () => {
    jest.clearAllMocks();
    tenant.resolveClient.mockResolvedValue({ features: { offerTiles: true } });
    mockResolve.mockResolvedValue({ partnerId: 'p1', forbidden: false, isSwitched: false });
    mockPrisma.offerTile.findMany.mockResolvedValue([]);
    mockPrisma.outlet.findMany.mockResolvedValue(OUTLETS);
    mockPrisma.outletTarget.findMany.mockResolvedValue([]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
    mockPrisma.kpiDef.findMany.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OffersPartnerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: tenant },
      ],
    }).compile();
    service = module.get(OffersPartnerService);
  });

  it('0. flag OFF → empty tiles, no partner resolution, no offer query', async () => {
    tenant.resolveClient.mockResolvedValue({ features: {} });
    const res = await service.listForPartner(partner);
    expect(res.tiles).toEqual([]);
    expect(res.asOf).toBe(istDateKey(new Date()));
    expect(res.month).toBe(istMonthKey(new Date()));
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockPrisma.offerTile.findMany).not.toHaveBeenCalled();
  });

  it('1. no partner → empty tiles, offer query never run', async () => {
    mockResolve.mockResolvedValue({ partnerId: null, forbidden: false, isSwitched: false });
    const res = await service.listForPartner(partner);
    expect(res).toEqual({ asOf: istDateKey(new Date()), month: istMonthKey(new Date()), tiles: [] });
    expect(mockPrisma.offerTile.findMany).not.toHaveBeenCalled();
  });

  it('2. forged x-active-partner-id → 403; selector forwarded for re-auth', async () => {
    mockResolve.mockResolvedValue({ partnerId: null, forbidden: true, isSwitched: false });
    await expect(service.listForPartner(partner, 'forged')).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockResolve).toHaveBeenCalledWith(mockPrisma, {
      clientId: 'bajaj', userSub: 'pu1', phone: '9999999999', requestedPartnerId: 'forged',
    });
  });

  it('3. queries only active, non-deleted, tenant tiles valid TODAY (IST)', async () => {
    await service.listForPartner(partner);
    const today = istDayToDate(istDateKey(new Date()));
    expect(mockPrisma.offerTile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId: 'bajaj', deletedAt: null, isActive: true, validFrom: { lte: today }, validTo: { gte: today } },
      }),
    );
    // zero tiles → hot path stops before reading outlets
    expect(mockPrisma.outlet.findMany).not.toHaveBeenCalled();
  });

  it('4. segment filtering: ANY of the partner outlets matching keeps the tile', async () => {
    mockPrisma.offerTile.findMany.mockResolvedValue([
      tile({ id: 'gold', programNames: ['gold'] }),
      tile({ id: 'plat', programNames: ['Platinum'] }),
      tile({ id: 'all' }),
    ]);
    const res = await service.listForPartner(partner);
    expect(mockPrisma.outlet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: 'bajaj', partnerId: 'p1', isActive: true, deletedAt: null } }),
    );
    expect(res.tiles.map((t) => t.id)).toEqual(['gold', 'all']);
  });

  it('4b. partner with no active outlets → empty', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.offerTile.findMany.mockResolvedValue([tile()]);
    const res = await service.listForPartner(partner);
    expect(res.tiles).toEqual([]);
  });

  it('5. KPI progress sums target/achieved only over MATCHING outlets for the current IST month; __names ignored', async () => {
    mockPrisma.offerTile.findMany.mockResolvedValue([tile({ id: 'k', kpiCode: 'ADHO50', programNames: ['Gold'] })]);
    mockPrisma.outletTarget.findMany.mockResolvedValue([
      { outletCode: 'O1', targetValues: { ADHO50: 200, __names: { ADHO50: 'Custom' } } },
      { outletCode: 'O2', targetValues: { ADHO50: 1000 } },
    ]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
      { outletCode: 'O1', kpiValues: { ADHO50: 120 } },
      { outletCode: 'O2', kpiValues: { ADHO50: 999 } },
    ]);
    mockPrisma.kpiDef.findMany.mockResolvedValue([{ code: 'ADHO50', label: 'ADHO 50 ml', unit: 'cases' }]);
    const res = await service.listForPartner(partner);
    const month = istMonthKey(new Date());
    expect(mockPrisma.outletTarget.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: 'bajaj', month, outletCode: { in: ['O1'] } } }),
    );
    expect(mockPrisma.outletSalesRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: 'bajaj', month, outletCode: { in: ['O1'] } } }),
    );
    expect(mockPrisma.kpiDef.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: 'bajaj', code: { in: ['ADHO50'] } } }),
    );
    expect(res.tiles[0].progress).toEqual({
      kpiCode: 'ADHO50', kpiName: 'ADHO 50 ml', unit: 'cases', target: 200, achieved: 120, pct: 60, unlocked: false,
    });
  });

  it('5b. multi-outlet sum across two matching outlets → unlocked at ≥100%', async () => {
    mockPrisma.offerTile.findMany.mockResolvedValue([tile({ id: 'k', kpiCode: 'ADHO50' })]);
    mockPrisma.outletTarget.findMany.mockResolvedValue([
      { outletCode: 'O1', targetValues: { ADHO50: 100 } },
      { outletCode: 'O2', targetValues: { ADHO50: 100 } },
    ]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
      { outletCode: 'O1', kpiValues: { ADHO50: 150 } },
      { outletCode: 'O2', kpiValues: { ADHO50: '60' } },
    ]);
    const res = await service.listForPartner(partner);
    expect(res.tiles[0].progress).toMatchObject({ target: 200, achieved: 210, pct: 105, unlocked: true, kpiName: 'ADHO50', unit: '' });
  });

  it('6. KPI-linked tile with no target row → target null, pct null, not unlocked — still returned', async () => {
    mockPrisma.offerTile.findMany.mockResolvedValue([tile({ id: 'k', kpiCode: 'ADHO50' })]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([{ outletCode: 'O1', kpiValues: { ADHO50: 5 } }]);
    const res = await service.listForPartner(partner);
    expect(res.tiles).toHaveLength(1);
    expect(res.tiles[0].progress).toMatchObject({ target: null, achieved: 5, pct: null, unlocked: false });
  });

  it('6b. no KPI-linked tile → no target/achievement/kpi queries; progress null', async () => {
    mockPrisma.offerTile.findMany.mockResolvedValue([tile()]);
    const res = await service.listForPartner(partner);
    expect(res.tiles[0].progress).toBeNull();
    expect(mockPrisma.outletTarget.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.outletSalesRecord.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.kpiDef.findMany).not.toHaveBeenCalled();
  });

  it('7. sort: TARGET_REWARD before EXTRA_SCHEME, then sortOrder, then createdAt', async () => {
    mockPrisma.offerTile.findMany.mockResolvedValue([
      tile({ id: 'e', group: 'EXTRA_SCHEME' }),
      tile({ id: 't2', sortOrder: 2 }),
      tile({ id: 't1b', sortOrder: 1, createdAt: new Date('2026-02-02T00:00:00Z') }),
      tile({ id: 't1a', sortOrder: 1, createdAt: new Date('2026-02-01T00:00:00Z') }),
    ]);
    const res = await service.listForPartner(partner);
    expect(res.tiles.map((t) => t.id)).toEqual(['t1a', 't1b', 't2', 'e']);
  });

  it('8. partner projection exposes no targeting/audit fields; Decimal→number, Date→YYYY-MM-DD', async () => {
    mockPrisma.offerTile.findMany.mockResolvedValue([tile({ valueNumber: new Prisma.Decimal('2.50'), valueType: 'PERCENT' })]);
    const res = await service.listForPartner(partner);
    const t = res.tiles[0];
    expect(Object.keys(t)).toEqual([
      'id', 'group', 'valueType', 'valueNumber', 'valueText', 'unitLabel', 'product', 'label', 'details', 'validTo', 'progress',
    ]);
    expect(t.valueNumber).toBe(2.5);
    expect(t.validTo).toBe('2099-12-31');
  });
});
