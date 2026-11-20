// Overview /kpis — optional program filter (additive; absent param = the pre-filter queries exactly).
// Run: npx jest src/admin-core/dashboard-kpis.program-filter.spec.ts
import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { SalesNotificationsService } from '../notifications/sales-notifications.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  channelPartner: { count: jest.fn() },
  kycSubmission: { count: jest.fn() },
  visibilityCapture: { count: jest.fn() },
  wallet: { aggregate: jest.fn() },
  payoutTransaction: { groupBy: jest.fn() },
  outlet: { findMany: jest.fn() },
};
const mockTenantSettings = { getVisibilityEnabledUncached: jest.fn(), getEffectiveSettings: jest.fn() };
// These legacy cases run as an AMOUNT_UPLOAD tenant (Deoleo-style): the pre-month visibility query, unchanged.
const mockTenant = { resolveClient: jest.fn(), resolveVisibilityCaptureMode: jest.fn().mockResolvedValue('AMOUNT_UPLOAD') };
const user: JwtPayload = { sub: 'ca', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: '' };

describe('AdminCoreService.dashboardKpis — program filter', () => {
  let svc: AdminCoreService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.channelPartner.count.mockResolvedValue(7);
    mockPrisma.kycSubmission.count.mockResolvedValue(3);
    mockPrisma.visibilityCapture.count.mockResolvedValue(2);
    mockPrisma.wallet.aggregate.mockResolvedValue({ _sum: { redeemablePoints: 900 } });
    mockPrisma.payoutTransaction.groupBy.mockResolvedValue([
      { status: 'PAID', _count: { id: 4 }, _sum: { netAmountPaise: BigInt(12345) } },
    ]);
    // Raw DISTINCT values as Postgres returns them — incl. whitespace variants and a blank.
    mockPrisma.outlet.findMany.mockResolvedValue([
      { programName: ' Gold' }, { programName: ' ' }, { programName: 'Gold' }, { programName: 'Gold ' }, { programName: 'Silver' },
    ]);
    mockTenantSettings.getVisibilityEnabledUncached.mockResolvedValue(true);
    mockTenant.resolveVisibilityCaptureMode.mockResolvedValue('AMOUNT_UPLOAD');
    const mod = await Test.createTestingModule({
      providers: [
        AdminCoreService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: SalesNotificationsService, useValue: {} },
      ],
    }).compile();
    svc = mod.get(AdminCoreService);
  });

  it('absent / blank program → identical numbers AND identical where clauses to before', async () => {
    for (const p of [undefined, '', '   ']) {
      jest.clearAllMocks();
      const res = await svc.dashboardKpis(user, p);
      expect(res).toMatchObject({
        activePartners: 7,
        pendingKyc: 3,
        pendingVisibility: 2,
        totalRedeemablePoints: 900,
        payoutSummary: { PAID: { count: 4, amountPaise: 12345 } },
        program: null,
        availablePrograms: ['Gold', 'Silver'],
        notProgramScoped: [],
        visibility: null,
      });
      expect(mockPrisma.channelPartner.count).toHaveBeenCalledWith({
        where: { clientId: 'bajaj', isActive: true, deletedAt: null, isParent: false },
      });
      expect(mockPrisma.kycSubmission.count.mock.calls[0][0].where).toEqual({
        user: { clientId: 'bajaj' },
        status: { in: expect.any(Array) },
      });
      expect(mockPrisma.visibilityCapture.count).toHaveBeenCalledWith({ where: { clientId: 'bajaj', status: 'SUBMITTED' } });
      // Audit item 1 (2026-11-19): liability sums POSITIVE balances only (same total when no wallet is negative).
      expect(mockPrisma.wallet.aggregate.mock.calls[0][0].where).toEqual({ partner: { clientId: 'bajaj' }, redeemablePoints: { gt: 0 } });
      expect(mockPrisma.payoutTransaction.groupBy.mock.calls[0][0].where).toEqual({ partner: { clientId: 'bajaj' } });
    }
  });

  it('N5/N6 a program scopes every metric through LIVE outlet(s), matching every whitespace variant', async () => {
    const res = await svc.dashboardKpis(user, '  Gold ');
    expect(res.program).toBe('Gold');
    const variants = { in: [' Gold', 'Gold', 'Gold '] };
    // Live-outlet condition (same as the billing roster): not deleted / deactivated / parked / not-interested,
    // NULL-safe OR-wrap (Prisma `notIn` drops NULL kycIntent rows).
    const some = { outlets: { some: { programName: variants, deletedAt: null, deactivatedAt: null, OR: [{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }] } } };
    expect(mockPrisma.channelPartner.count.mock.calls[0][0].where).toEqual({
      clientId: 'bajaj', isActive: true, deletedAt: null, isParent: false, ...some,
    });
    expect(mockPrisma.kycSubmission.count.mock.calls[0][0].where.partner).toEqual(some);
    expect(mockPrisma.kycSubmission.count.mock.calls[0][0].where.user).toEqual({ clientId: 'bajaj' });
    expect(mockPrisma.visibilityCapture.count.mock.calls[0][0].where).toEqual({
      clientId: 'bajaj', status: 'SUBMITTED', outlet: { programName: variants },
    });
    expect(mockPrisma.wallet.aggregate.mock.calls[0][0].where).toEqual({ partner: { clientId: 'bajaj', ...some }, redeemablePoints: { gt: 0 } });
    expect(mockPrisma.payoutTransaction.groupBy.mock.calls[0][0].where).toEqual({ partner: { clientId: 'bajaj', ...some } });
    // availablePrograms is the full tenant list, not narrowed by the filter.
    expect(mockPrisma.outlet.findMany.mock.calls[0][0].where).toEqual({ clientId: 'bajaj', deletedAt: null, programName: { not: null } });
    expect(res.availablePrograms).toEqual(['Gold', 'Silver']);
  });

  it('N6 an unknown program matches nothing (`in: []`) — zeros, never an error', async () => {
    await svc.dashboardKpis(user, 'Platinum');
    expect(mockPrisma.channelPartner.count.mock.calls[0][0].where.outlets.some.programName).toEqual({ in: [] });
    expect(mockPrisma.visibilityCapture.count.mock.calls[0][0].where.outlet).toEqual({ programName: { in: [] } });
  });

  it('rejects an over-long or repeated program param', async () => {
    await expect(svc.dashboardKpis(user, 'x'.repeat(201))).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.dashboardKpis(user, ['a', 'b'])).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AdminCoreService.dashboardKpis — owner decisions D1/D2 (points owed, every tenant)', () => {
  it('liability = Σ positive balances; points owed = Σ |negative balances| + how many wallets, never netted', async () => {
    jest.clearAllMocks();
    mockPrisma.channelPartner.count.mockResolvedValue(7);
    mockPrisma.kycSubmission.count.mockResolvedValue(3);
    mockPrisma.visibilityCapture.count.mockResolvedValue(2);
    mockPrisma.payoutTransaction.groupBy.mockResolvedValue([]);
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockTenantSettings.getVisibilityEnabledUncached.mockResolvedValue(true);
    mockPrisma.wallet.aggregate
      .mockResolvedValueOnce({ _sum: { redeemablePoints: 900 } })
      .mockResolvedValueOnce({ _sum: { redeemablePoints: -2986 }, _count: { _all: 2 } });
    const mod = await Test.createTestingModule({
      providers: [
        AdminCoreService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: SalesNotificationsService, useValue: {} },
      ],
    }).compile();
    const res = await mod.get(AdminCoreService).dashboardKpis(user, undefined);
    expect(res).toMatchObject({ totalRedeemablePoints: 900, totalOwedPoints: 2986, owedWallets: 2 });
    expect(mockPrisma.wallet.aggregate.mock.calls[1][0].where).toEqual({ partner: { clientId: 'bajaj' }, redeemablePoints: { lt: 0 } });
  });

  it('a tenant with no negative wallet (Deoleo) → owed 0 / 0, liability unchanged', async () => {
    jest.clearAllMocks();
    mockPrisma.wallet.aggregate.mockResolvedValueOnce({ _sum: { redeemablePoints: 900 } }).mockResolvedValueOnce({ _sum: { redeemablePoints: null }, _count: { _all: 0 } });
    const mod = await Test.createTestingModule({
      providers: [
        AdminCoreService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: SalesNotificationsService, useValue: {} },
      ],
    }).compile();
    const res = await mod.get(AdminCoreService).dashboardKpis(user, undefined);
    expect(res).toMatchObject({ totalRedeemablePoints: 900, totalOwedPoints: 0, owedWallets: 0 });
  });
});

describe('AdminCoreService.dashboardKpis — Pending Visibility Approvals (PHOTO_APPROVAL, month-wise)', () => {
  let svc: AdminCoreService;
  const groupBy = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: new Date('2026-11-20T06:30:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    mockPrisma.channelPartner.count.mockResolvedValue(7);
    mockPrisma.kycSubmission.count.mockResolvedValue(3);
    mockPrisma.wallet.aggregate.mockResolvedValue({ _sum: { redeemablePoints: 0 }, _count: { _all: 0 } });
    mockPrisma.payoutTransaction.groupBy.mockResolvedValue([]);
    mockPrisma.outlet.findMany.mockResolvedValue([{ programName: 'Gold' }, { programName: 'Silver' }]);
    groupBy.mockResolvedValue([
      { status: 'SUBMITTED', _count: { _all: 5 } },
      { status: 'CHANGES_REQUESTED', _count: { _all: 2 } },
      { status: 'APPROVED', _count: { _all: 9 } },
    ]);
    mockTenantSettings.getVisibilityEnabledUncached.mockResolvedValue(true);
    mockTenantSettings.getEffectiveSettings.mockResolvedValue({
      visibilityConfig: { outletScope: ['SSS'], frequencyPerMonth: 1, programs: [], subPrograms: [] },
    });
    const tenant = { resolveClient: jest.fn(), resolveVisibilityCaptureMode: jest.fn().mockResolvedValue('PHOTO_APPROVAL') };
    const mod = await Test.createTestingModule({
      providers: [
        AdminCoreService,
        { provide: PrismaService, useValue: { ...mockPrisma, visibilityCapture: { count: mockPrisma.visibilityCapture.count, groupBy } } },
        { provide: TenantService, useValue: tenant },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: SalesNotificationsService, useValue: {} },
      ],
    }).compile();
    svc = mod.get(AdminCoreService);
  });
  afterEach(() => jest.useRealTimers());

  it('default month = current IST month; Waiting for review and Needs re-take shown separately; in-scope outlets only', async () => {
    const res = await svc.dashboardKpis(user, undefined, undefined);
    expect(res.pendingVisibility).toBe(5);
    expect(res.visibility).toEqual({ month: '2026-11', waiting: 5, needsRetake: 2 });
    const where = groupBy.mock.calls[0][0].where;
    expect(where.windowKey).toEqual({ startsWith: '2026-11-P' });
    expect(where.outlet).toMatchObject({ isActive: true, outletType: { code: { in: ['SSS'] } } });
    // The legacy all-time count is NOT used for a photo tenant.
    expect(mockPrisma.visibilityCapture.count).not.toHaveBeenCalled();
  });

  it('a picked month (history incl. imported records) + the program filter ANDed onto the in-scope rule', async () => {
    const res = await svc.dashboardKpis(user, 'Gold', '2025-06');
    expect(res.visibility?.month).toBe('2025-06');
    const where = groupBy.mock.calls[0][0].where;
    expect(where.windowKey).toEqual({ startsWith: '2025-06-P' });
    expect(where.outlet.AND[1]).toEqual({ programName: { in: ['Gold'] } });
    expect(where.outlet.AND[0].isActive).toBe(true);
  });

  it('a malformed month → 400; visibility OFF → 0 and null', async () => {
    await expect(svc.dashboardKpis(user, undefined, '2026-13')).rejects.toBeInstanceOf(BadRequestException);
    mockTenantSettings.getVisibilityEnabledUncached.mockResolvedValue(false);
    const res = await svc.dashboardKpis(user, undefined, undefined);
    expect(res).toMatchObject({ pendingVisibility: 0, visibility: null });
    expect(groupBy).not.toHaveBeenCalled();
  });
});
