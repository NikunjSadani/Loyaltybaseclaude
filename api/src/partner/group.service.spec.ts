// Unit tests for GroupService — GET /v1/partner/group/wallet (Wave 3 read-only
// parent-group wallet roll-up). Covers:
//   - no parent for the login's phone → { available: false } (no 500)
//   - a parent with 2 children → summed totals + 2 drill-down rows
//   - a child whose partner has no wallet row → zeros
//   - tenant-scoping: every query carries clientId; the aggregate carries the
//     groupId=parentId filter (never sums another tenant's or another group's wallets)
//
// Run: npx jest src/partner/group.service.spec.ts

import { GroupService } from './group.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { visibilityUniverseWhere } from '../visibility/visibility-scope.helper';

const mockPrisma = {
  channelPartner: { findFirst: jest.fn(), findMany: jest.fn() },
  wallet: { aggregate: jest.fn() },
  outlet: { findMany: jest.fn() },
  outletTarget: { findFirst: jest.fn(), findMany: jest.fn() },
  outletSalesRecord: { findMany: jest.fn() },
  kpiDef: { findMany: jest.fn() },
  outletVisibilityRecord: { findMany: jest.fn() },
  visibilityCapture: { findMany: jest.fn() },
  leaderboardSnapshot: { findFirst: jest.fn() },
  leaderboardEntry: { findMany: jest.fn() },
  // fix round 3: the wallet totals + negative split are read in ONE array transaction
  $transaction: jest.fn(async (ops: Promise<unknown>[], _opts?: unknown) => Promise.all(ops)),
};

const mockTenantSettings = { getConversionRate: jest.fn(), getEffectiveSettings: jest.fn() };
const mockTenant = { resolveVisibilityEnabled: jest.fn(), resolveVisibilityCaptureMode: jest.fn() };

const user: JwtPayload = {
  sub: 'u1',
  role: 'WHOLESALER',
  clientId: 'deoleo',
  phone: '9830011252',
  name: 'Parent Owner',
};

function makeService(): GroupService {
  return new GroupService(
    mockPrisma as unknown as PrismaService,
    mockTenantSettings as unknown as TenantSettingsService,
    mockTenant as unknown as TenantService,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTenantSettings.getConversionRate.mockResolvedValue(10);
  mockTenant.resolveVisibilityEnabled.mockResolvedValue(true);
});

describe('GroupService.getWalletRollup', () => {
  it('returns { available: false } when the phone owns no group parent', async () => {
    // resolveGroupParentByPhone → channelPartner.findFirst for an isParent match returns null.
    mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null);

    const result = await makeService().getWalletRollup(user);

    expect(result).toEqual({ available: false });
    // Short-circuits: no totals/drill-down/rate work when there is no parent.
    expect(mockPrisma.wallet.aggregate).not.toHaveBeenCalled();
    expect(mockPrisma.outlet.findMany).not.toHaveBeenCalled();
    expect(mockTenantSettings.getConversionRate).not.toHaveBeenCalled();

    // The parent-resolution query is phone + tenant + isParent scoped.
    const where = mockPrisma.channelPartner.findFirst.mock.calls[0][0].where;
    expect(where.clientId).toBe('deoleo');
    expect(where.isParent).toBe(true);
  });

  it('sums totals and returns a drill-down row per child for a resolved parent', async () => {
    // 1st findFirst = resolveGroupParentByPhone (isParent match) → parent id.
    // 2nd findFirst = the own-group guard (login's own partner; groupId must match the parent).
    // 3rd findFirst = the parent identity load in getWalletRollup.
    mockPrisma.channelPartner.findFirst
      .mockResolvedValueOnce({ id: 'parent1' })
      .mockResolvedValueOnce({ groupId: 'parent1' })
      .mockResolvedValueOnce({ businessName: 'Group HQ', ownerName: 'Big Boss' });

    mockPrisma.wallet.aggregate.mockResolvedValueOnce({
      _sum: {
        redeemablePoints: 300,
        earnedPoints: 500,
        redeemedPoints: 150,
        expiredPoints: 20,
        lockedPoints: 0,
        lifetimeEarned: 500,
        lifetimeRedeemed: 150,
      },
    });

    mockPrisma.outlet.findMany.mockResolvedValueOnce([
      {
        id: 'o1',
        outletCode: 'OUT-1',
        name: 'Shop One',
        isActive: true,
        partner: {
          id: 'cp1',
          businessName: 'Shop One Traders',
          ownerName: 'Owner A',
          wallets: [
            {
              redeemablePoints: 200,
              earnedPoints: 300,
              redeemedPoints: 90,
              expiredPoints: 10,
              lockedPoints: 0,
            },
          ],
        },
      },
      {
        id: 'o2',
        outletCode: 'OUT-2',
        name: 'Shop Two',
        isActive: false,
        partner: {
          id: 'cp2',
          businessName: 'Shop Two Traders',
          ownerName: 'Owner B',
          wallets: [
            {
              redeemablePoints: 100,
              earnedPoints: 200,
              redeemedPoints: 60,
              expiredPoints: 10,
              lockedPoints: 0,
            },
          ],
        },
      },
    ]);

    const result = await makeService().getWalletRollup(user);

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable'); // narrows the union for TS
    expect(result.parent).toEqual({ businessName: 'Group HQ', ownerName: 'Big Boss' });
    expect(result.conversionRate).toBe(10);
    expect(result.totals).toEqual({
      owedPoints: 0,
      owedWallets: 0,
      redeemablePoints: 300,
      earnedPoints: 500,
      redeemedPoints: 150,
      expiredPoints: 20,
      lockedPoints: 0,
      lifetimeEarned: 500,
      lifetimeRedeemed: 150,
    });
    expect(result.outlets).toHaveLength(2);
    expect(result.outlets[0]).toEqual({
      outletCode: 'OUT-1',
      businessName: 'Shop One Traders',
      ownerName: 'Owner A',
      isActive: true,
      redeemablePoints: 200,
      earnedPoints: 300,
      redeemedPoints: 90,
      expiredPoints: 10,
      lockedPoints: 0,
    });
    expect(result.outlets[1].outletCode).toBe('OUT-2');
    expect(result.outlets[1].isActive).toBe(false);
  });

  it('treats a child with no wallet row as zero balances', async () => {
    mockPrisma.channelPartner.findFirst
      .mockResolvedValueOnce({ id: 'parent1' })
      .mockResolvedValueOnce({ groupId: 'parent1' }) // own-group guard passes
      .mockResolvedValueOnce({ businessName: 'Group HQ', ownerName: 'Big Boss' });

    // Aggregate _sum may be all-null when the group has no wallet rows at all.
    mockPrisma.wallet.aggregate.mockResolvedValueOnce({
      _sum: {
        redeemablePoints: null,
        earnedPoints: null,
        redeemedPoints: null,
        expiredPoints: null,
        lockedPoints: null,
        lifetimeEarned: null,
        lifetimeRedeemed: null,
      },
    });

    mockPrisma.outlet.findMany.mockResolvedValueOnce([
      {
        id: 'o1',
        outletCode: 'OUT-1',
        name: 'Pending Shop',
        isActive: true,
        // Pending child: partner exists but no wallet yet.
        partner: {
          id: 'cp1',
          businessName: 'Pending Traders',
          ownerName: 'Owner A',
          wallets: [],
        },
      },
      {
        id: 'o2',
        outletCode: 'OUT-2',
        name: 'Ownerless Shop',
        isActive: true,
        // Outlet with no owner attached yet (partnerId null).
        partner: null,
      },
    ]);

    const result = await makeService().getWalletRollup(user);

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable'); // narrows the union for TS
    expect(result.totals).toEqual({
      owedPoints: 0,
      owedWallets: 0,
      redeemablePoints: 0,
      earnedPoints: 0,
      redeemedPoints: 0,
      expiredPoints: 0,
      lockedPoints: 0,
      lifetimeEarned: 0,
      lifetimeRedeemed: 0,
    });
    expect(result.outlets[0]).toEqual({
      outletCode: 'OUT-1',
      businessName: 'Pending Traders',
      ownerName: 'Owner A',
      isActive: true,
      redeemablePoints: 0,
      earnedPoints: 0,
      redeemedPoints: 0,
      expiredPoints: 0,
      lockedPoints: 0,
    });
    // Ownerless outlet falls back to the outlet name + null owner, zeros throughout.
    expect(result.outlets[1]).toEqual({
      outletCode: 'OUT-2',
      businessName: 'Ownerless Shop',
      ownerName: null,
      isActive: true,
      redeemablePoints: 0,
      earnedPoints: 0,
      redeemedPoints: 0,
      expiredPoints: 0,
      lockedPoints: 0,
    });
  });

  it('scopes every query by tenant + the resolved group (no cross-tenant / cross-group sums)', async () => {
    mockPrisma.channelPartner.findFirst
      .mockResolvedValueOnce({ id: 'parent1' })
      .mockResolvedValueOnce({ groupId: 'parent1' }) // own-group guard passes
      .mockResolvedValueOnce({ businessName: 'Group HQ', ownerName: 'Big Boss' });
    mockPrisma.wallet.aggregate.mockResolvedValueOnce({ _sum: {} });
    mockPrisma.outlet.findMany.mockResolvedValueOnce([]);

    await makeService().getWalletRollup(user);

    // The own-group guard is tenant + login scoped.
    const ownWhere = mockPrisma.channelPartner.findFirst.mock.calls[1][0].where;
    expect(ownWhere).toMatchObject({ userId: 'u1', clientId: 'deoleo', isParent: false });

    // The parent identity load (3rd findFirst) is tenant-scoped.
    const parentWhere = mockPrisma.channelPartner.findFirst.mock.calls[2][0].where;
    expect(parentWhere).toMatchObject({ id: 'parent1', clientId: 'deoleo' });

    // The totals aggregate MUST carry BOTH the group (via source-of-truth outlet.parentId) AND
    // clientId — the guardrail against summing the whole tenant / another group.
    const aggWhere = mockPrisma.wallet.aggregate.mock.calls[0][0].where;
    expect(aggWhere).toEqual({ partner: { outlets: { some: { parentId: 'parent1', clientId: 'deoleo', deletedAt: null } } } });

    // The drill-down is scoped to the group's child outlets in this tenant only.
    const outletWhere = mockPrisma.outlet.findMany.mock.calls[0][0].where;
    expect(outletWhere).toMatchObject({ parentId: 'parent1', clientId: 'deoleo', deletedAt: null });

    // conversionRate is read for the caller's tenant.
    expect(mockTenantSettings.getConversionRate).toHaveBeenCalledWith('deoleo');
  });

  it('returns { available: false } when the login is a parent-phone collision (own outlet in a DIFFERENT group)', async () => {
    // resolveGroupParentByPhone resolves a parent, but the login's own partner belongs to another
    // group → an admin phone-typo collision must NOT expose this group's numbers (audit LOW-1).
    mockPrisma.channelPartner.findFirst
      .mockResolvedValueOnce({ id: 'parent1' }) // parent-by-phone
      .mockResolvedValueOnce({ groupId: 'OTHER-GROUP' }); // own is in a different group

    const result = await makeService().getWalletRollup(user);

    expect(result).toEqual({ available: false });
    expect(mockPrisma.wallet.aggregate).not.toHaveBeenCalled();
    expect(mockPrisma.outlet.findMany).not.toHaveBeenCalled();
  });

  it('audit item 2: a child in debt does not net against the group available total; the debt is owedPoints', async () => {
    mockPrisma.channelPartner.findFirst
      .mockResolvedValueOnce({ id: 'parent1' })
      .mockResolvedValueOnce({ groupId: 'parent1' })
      .mockResolvedValueOnce({ businessName: 'HQ', ownerName: 'Boss' });
    // all wallets: 5,000 + (−2,986) = 2,014; negative wallets only: −2,986
    mockPrisma.wallet.aggregate
      .mockResolvedValueOnce({ _sum: { redeemablePoints: 2014 } })
      .mockResolvedValueOnce({ _sum: { redeemablePoints: -2986 }, _count: { _all: 1 } });
    mockPrisma.outlet.findMany.mockResolvedValueOnce([]);
    const result = await makeService().getWalletRollup(user);
    if (!result.available) throw new Error('unreachable');
    expect(result.totals).toMatchObject({ redeemablePoints: 5000, owedPoints: 2986, owedWallets: 1 });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'RepeatableRead' }); // one snapshot (item 7)
    expect(mockPrisma.wallet.aggregate.mock.calls[1][0].where.redeemablePoints).toEqual({ lt: 0 });
  });

  it('coerces missing aggregate keys to 0 (partial _sum)', async () => {
    mockPrisma.channelPartner.findFirst
      .mockResolvedValueOnce({ id: 'parent1' })
      .mockResolvedValueOnce({ groupId: 'parent1' }) // own-group guard passes
      .mockResolvedValueOnce({ businessName: 'HQ', ownerName: 'Boss' });
    // Some drivers omit keys entirely rather than returning null.
    mockPrisma.wallet.aggregate.mockResolvedValueOnce({ _sum: { redeemablePoints: 42 } });
    mockPrisma.outlet.findMany.mockResolvedValueOnce([]);

    const result = await makeService().getWalletRollup(user);

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable'); // narrows the union for TS
    expect(result.totals).toEqual({
      owedPoints: 0,
      owedWallets: 0,
      redeemablePoints: 42,
      earnedPoints: 0,
      redeemedPoints: 0,
      expiredPoints: 0,
      lockedPoints: 0,
      lifetimeEarned: 0,
      lifetimeRedeemed: 0,
    });
  });
});

// ── GET /v1/partner/group/targets ───────────────────────────────────────────
describe('GroupService.getTargetsRollup', () => {
  it('returns { available: false } when the phone owns no group parent', async () => {
    mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null); // no parent-by-phone

    const result = await makeService().getTargetsRollup(user, {});

    expect(result).toEqual({ available: false });
    expect(mockPrisma.outlet.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.outletTarget.findMany).not.toHaveBeenCalled();
  });

  it('returns { available: false } for a parent-phone collision (own outlet in a different group)', async () => {
    mockPrisma.channelPartner.findFirst
      .mockResolvedValueOnce({ id: 'parent1' }) // parent-by-phone
      .mockResolvedValueOnce({ groupId: 'OTHER-GROUP' }); // own-group guard fails

    const result = await makeService().getTargetsRollup(user, {});

    expect(result).toEqual({ available: false });
    expect(mockPrisma.outlet.findMany).not.toHaveBeenCalled();
  });

  it('rolls up per-outlet KPI rows + group totals for a 2-child group', async () => {
    mockPrisma.channelPartner.findFirst
      .mockResolvedValueOnce({ id: 'parent1' }) // parent-by-phone
      .mockResolvedValueOnce({ groupId: 'parent1' }) // own-group guard passes
      .mockResolvedValueOnce({ businessName: 'Group HQ', ownerName: 'Big Boss' }); // parent identity

    // OUT-1 is authoritatively WHOLESALER now (reclassified), OUT-2 stays RETAIL.
    mockPrisma.outlet.findMany.mockResolvedValueOnce([
      { outletCode: 'OUT-1', outletType: { code: 'WHOLESALER' } },
      { outletCode: 'OUT-2', outletType: { code: 'RETAIL' } },
    ]);

    // Explicit period → no most-recent-month lookup. The denormalized target-type snapshot is gone;
    // outlet type must resolve from the Outlet join (OUT-1 → WHOLESALER).
    mockPrisma.outletTarget.findMany.mockResolvedValueOnce([
      { outletCode: 'OUT-1', outletName: 'Shop One', targetValues: { SALES: 100 } },
      { outletCode: 'OUT-2', outletName: 'Shop Two', targetValues: { SALES: 200 } },
    ]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValueOnce([
      { outletCode: 'OUT-1', kpiValues: { SALES: 50 } },
      { outletCode: 'OUT-2', kpiValues: { SALES: 200 } },
    ]);
    mockPrisma.kpiDef.findMany.mockResolvedValueOnce([
      { code: 'SALES', label: 'Sales', unit: 'cases', isPrimary: true },
    ]);

    const result = await makeService().getTargetsRollup(user, { period: '2026-05' });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable');
    expect(result.parent).toEqual({ businessName: 'Group HQ', ownerName: 'Big Boss' });
    expect(result.period).toBe('2026-05');

    // Per-outlet rows.
    expect(result.outlets).toHaveLength(2);
    expect(result.outlets[0]).toEqual({
      outletCode: 'OUT-1',
      outletName: 'Shop One',
      // AUTHORITATIVE Outlet.outletType.code (WHOLESALER), NOT the frozen "RETAIL" target snapshot.
      outletType: 'WHOLESALER',
      kpis: [{ code: 'SALES', name: 'Sales', target: 100, achieved: 50, pace: 0.5, unit: 'cases', isPrimary: true }],
    });

    // Group total per KPI: target 100+200=300, achieved 50+200=250 → pace 250/300.
    expect(result.kpiTotals).toHaveLength(1);
    expect(result.kpiTotals[0]).toEqual({
      code: 'SALES',
      name: 'Sales',
      target: 300,
      achieved: 250,
      pace: 250 / 300,
      unit: 'cases',
      isPrimary: true,
    });

    // No most-recent-month lookup happened (explicit period given).
    expect(mockPrisma.outletTarget.findFirst).not.toHaveBeenCalled();
    // Both sides + KPI defs are tenant + month + group-outletCode scoped.
    const whereBase = mockPrisma.outletTarget.findMany.mock.calls[0][0].where;
    expect(whereBase).toEqual({ clientId: 'deoleo', month: '2026-05', outletCode: { in: ['OUT-1', 'OUT-2'] } });
    // Group outlet set is sourced from outlet.parentId (source of truth), tenant-scoped.
    const outletWhere = mockPrisma.outlet.findMany.mock.calls[0][0].where;
    expect(outletWhere).toEqual({ parentId: 'parent1', clientId: 'deoleo', deletedAt: null });
  });

  it('defaults to the most-recent month with target data when no period is given', async () => {
    mockPrisma.channelPartner.findFirst
      .mockResolvedValueOnce({ id: 'parent1' })
      .mockResolvedValueOnce({ groupId: 'parent1' })
      .mockResolvedValueOnce({ businessName: 'HQ', ownerName: 'Boss' });
    mockPrisma.outlet.findMany.mockResolvedValueOnce([{ outletCode: 'OUT-1' }]);
    mockPrisma.outletTarget.findFirst.mockResolvedValueOnce({ month: '2026-07' });
    mockPrisma.outletTarget.findMany.mockResolvedValueOnce([]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValueOnce([]);
    mockPrisma.kpiDef.findMany.mockResolvedValueOnce([]);

    const result = await makeService().getTargetsRollup(user, {});

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable');
    expect(result.period).toBe('2026-07');
    // The most-recent-month lookup is scoped to the group's outlet codes in this tenant.
    const latestWhere = mockPrisma.outletTarget.findFirst.mock.calls[0][0].where;
    expect(latestWhere).toEqual({ clientId: 'deoleo', outletCode: { in: ['OUT-1'] } });
  });

  it('returns empty roll-up (no 500) when the group has no outlets', async () => {
    mockPrisma.channelPartner.findFirst
      .mockResolvedValueOnce({ id: 'parent1' })
      .mockResolvedValueOnce({ groupId: 'parent1' })
      .mockResolvedValueOnce({ businessName: 'HQ', ownerName: 'Boss' });
    mockPrisma.outlet.findMany.mockResolvedValueOnce([]);

    const result = await makeService().getTargetsRollup(user, {});

    expect(result).toEqual({
      available: true,
      parent: { businessName: 'HQ', ownerName: 'Boss' },
      period: null,
      kpiTotals: [],
      outlets: [],
    });
    expect(mockPrisma.outletTarget.findMany).not.toHaveBeenCalled();
  });
});

// ── GET /v1/partner/group/visibility ────────────────────────────────────────
describe('GroupService.getVisibilityRollup', () => {
  it('returns { available: false } when the phone owns no group parent', async () => {
    mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null);

    const result = await makeService().getVisibilityRollup(user, {});

    expect(result).toEqual({ available: false });
    expect(mockTenant.resolveVisibilityEnabled).not.toHaveBeenCalled();
  });

  it('returns { visibilityEnabled: false } (no 403) when the tenant flag is OFF', async () => {
    mockPrisma.channelPartner.findFirst
      .mockResolvedValueOnce({ id: 'parent1' })
      .mockResolvedValueOnce({ groupId: 'parent1' })
      .mockResolvedValueOnce({ businessName: 'HQ', ownerName: 'Boss' });
    mockPrisma.outlet.findMany.mockResolvedValueOnce([{ outletCode: 'OUT-1', name: 'Shop One' }]);
    mockTenant.resolveVisibilityEnabled.mockResolvedValueOnce(false);

    const result = await makeService().getVisibilityRollup(user, {});

    expect(result).toEqual({
      available: true,
      visibilityEnabled: false,
      parent: { businessName: 'HQ', ownerName: 'Boss' },
    });
    // Flag OFF short-circuits before any visibility-record read.
    expect(mockPrisma.outletVisibilityRecord.findMany).not.toHaveBeenCalled();
  });

  it('returns per-outlet status rows + roll-up counts when the flag is ON', async () => {
    mockPrisma.channelPartner.findFirst
      .mockResolvedValueOnce({ id: 'parent1' })
      .mockResolvedValueOnce({ groupId: 'parent1' })
      .mockResolvedValueOnce({ businessName: 'HQ', ownerName: 'Boss' });
    mockPrisma.outlet.findMany.mockResolvedValueOnce([
      { outletCode: 'OUT-1', name: 'Shop One' },
      { outletCode: 'OUT-2', name: 'Shop Two' },
      { outletCode: 'OUT-3', name: 'Shop Three' },
    ]);
    mockTenant.resolveVisibilityEnabled.mockResolvedValueOnce(true);
    mockPrisma.outletVisibilityRecord.findMany.mockResolvedValueOnce([
      { outletCode: 'OUT-1', status: 'APPROVED', dateOfCapture: new Date('2026-07-05T00:00:00Z'), approvedBy: 'admin@x' },
      { outletCode: 'OUT-2', status: 'PENDING', dateOfCapture: null, approvedBy: null },
      // OUT-3 has no record for the month.
    ]);

    mockTenant.resolveVisibilityCaptureMode.mockResolvedValueOnce('AMOUNT_UPLOAD');
    const result = await makeService().getVisibilityRollup(user, { month: '2026-07' });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable'); // narrows off the available:false branch
    if (!result.visibilityEnabled) throw new Error('unreachable'); // narrows to the ON branch
    if (result.mode !== 'AMOUNT_UPLOAD') throw new Error('unreachable'); // the Excel-record branch
    expect(result.month).toBe('2026-07');
    expect(result.counts).toEqual({ total: 3, approved: 1, underReview: 0, pending: 1, noRecord: 1 });
    expect(result.outlets).toEqual([
      { outletCode: 'OUT-1', outletName: 'Shop One', status: 'APPROVED', dateOfCapture: '2026-07-05', approvedBy: 'admin@x' },
      { outletCode: 'OUT-2', outletName: 'Shop Two', status: 'PENDING', dateOfCapture: null, approvedBy: null },
      { outletCode: 'OUT-3', outletName: 'Shop Three', status: null, dateOfCapture: null, approvedBy: null },
    ]);
    // The record read is tenant + month + group-outletCode scoped.
    const recWhere = mockPrisma.outletVisibilityRecord.findMany.mock.calls[0][0].where;
    expect(recWhere).toEqual({ clientId: 'deoleo', month: '2026-07', outletCode: { in: ['OUT-1', 'OUT-2', 'OUT-3'] } });
    expect(mockPrisma.visibilityCapture.findMany).not.toHaveBeenCalled();
  });

  // PHOTO_APPROVAL tenants (Bajaj) — the group page must read VisibilityCapture, not the
  // AMOUNT_UPLOAD Excel table (which is empty for a photo tenant → every shop read "No record").
  describe('PHOTO_APPROVAL tenant', () => {
    const groupOutlets = [
      { id: 'o3', outletCode: 'OUT-3', name: 'Shop Three', programName: 'Unnati', programCategory: 'Elite', outletType: { code: 'RETAILER' } },
      { id: 'o1', outletCode: 'OUT-1', name: 'Shop One', programName: 'Unnati', programCategory: 'Elite', outletType: { code: 'RETAILER' } },
      { id: 'o2', outletCode: 'OUT-2', name: 'Shop Two', programName: 'Unnati', programCategory: 'Elite', outletType: { code: 'RETAILER' } },
      { id: 'o4', outletCode: 'OUT-4', name: 'Shop Four', programName: 'Unnati', programCategory: 'Elite', outletType: { code: 'RETAILER' } },
      { id: 'o5', outletCode: 'OUT-5', name: 'Shop Five', programName: 'Unnati', programCategory: 'Elite', outletType: { code: 'RETAILER' } },
      // Out of the visibility scope (type not in outletScope) → listed, not counted.
      { id: 'o9', outletCode: 'OUT-9', name: 'Depot', programName: null, programCategory: null, outletType: { code: 'DISTRIBUTOR' } },
    ];
    beforeEach(() => {
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'parent1' })
        .mockResolvedValueOnce({ groupId: 'parent1' })
        .mockResolvedValueOnce({ businessName: 'HQ', ownerName: 'Boss' });
      mockTenant.resolveVisibilityCaptureMode.mockResolvedValueOnce('PHOTO_APPROVAL');
      mockTenantSettings.getEffectiveSettings.mockResolvedValue({
        visibilityConfig: { outletScope: ['RETAILER'], frequencyPerMonth: 1, allowedSalesLevels: [], geoFence: { enabled: false, radiusMeters: 50 } },
      });
      // 1st outlet.findMany = the shared group load; 2nd = the photo path's group load; 3rd = the in-scope ids
      // (visibilityUniverseWhere — the database decides; the depot is out of scope).
      mockPrisma.outlet.findMany
        .mockResolvedValueOnce(groupOutlets)
        .mockResolvedValueOnce(groupOutlets)
        .mockResolvedValueOnce(groupOutlets.filter((o) => o.id !== 'o9').map((o) => ({ id: o.id })));
    });

    it('reads VisibilityCapture for the CURRENT window and returns plain-status-ready codes + counts', async () => {
      const now = new Date();
      mockPrisma.visibilityCapture.findMany.mockResolvedValueOnce([
        { outletId: 'o1', status: 'APPROVED', receivedAt: now, reviewedAt: now, currentVersion: 1 },
        { outletId: 'o2', status: 'SUBMITTED', receivedAt: now, reviewedAt: null, currentVersion: 1 },
        { outletId: 'o3', status: 'CHANGES_REQUESTED', receivedAt: now, reviewedAt: now, currentVersion: 2 },
        { outletId: 'o4', status: 'REJECTED', receivedAt: now, reviewedAt: now, currentVersion: 1 },
        // o5: no capture yet.
      ]);
      const result = await makeService().getVisibilityRollup(user, {});
      if (!result.available || !result.visibilityEnabled || result.mode !== 'PHOTO_APPROVAL') throw new Error('expected photo branch');

      expect(mockPrisma.outletVisibilityRecord.findMany).not.toHaveBeenCalled();
      const where = mockPrisma.visibilityCapture.findMany.mock.calls[0][0].where;
      expect(where.clientId).toBe('deoleo');
      expect(where.windowKey).toBe(result.windowKey);
      expect(result.windowKey).toMatch(/^\d{4}-\d{2}-P1$/);
      expect(where.outletId.in.sort()).toEqual(['o1', 'o2', 'o3', 'o4', 'o5']); // never the out-of-scope depot
      expect(result.counts).toEqual({ total: 5, approved: 1, waiting: 1, needsRetake: 1, rejected: 1, notCaptured: 1, notInScope: 1 });
      expect(result.outlets.map((o) => [o.outletCode, o.status, o.inScope])).toEqual([
        ['OUT-1', 'APPROVED', true],
        ['OUT-2', 'SUBMITTED', true],
        ['OUT-3', 'CHANGES_REQUESTED', true],
        ['OUT-4', 'REJECTED', true],
        ['OUT-5', null, true],
        ['OUT-9', null, false],
      ]);
      // The photo-path outlet load excludes deactivated outlets (same as the coverage denominator).
      expect(mockPrisma.outlet.findMany.mock.calls[1][0].where).toMatchObject({ parentId: 'parent1', clientId: 'deoleo', deletedAt: null, deactivatedAt: null });
      // In scope = THE shared rule (report / Excel / dashboards / capture list), narrowed to this group.
      const cfg = { outletScope: ['RETAILER'], frequencyPerMonth: 1, allowedSalesLevels: [], geoFence: { enabled: false, radiusMeters: 50 } };
      expect(mockPrisma.outlet.findMany.mock.calls[2][0].where).toEqual({
        AND: [visibilityUniverseWhere('deoleo', cfg), { parentId: 'parent1' }],
      });
    });

    it('a group outlet the shared rule excludes (e.g. KYC not approved yet) is listed as not in scope, never counted', async () => {
      mockPrisma.outlet.findMany.mockReset();
      mockPrisma.outlet.findMany
        .mockResolvedValueOnce(groupOutlets)
        .mockResolvedValueOnce(groupOutlets)
        .mockResolvedValueOnce([{ id: 'o1' }, { id: 'o2' }]); // o3..o5 are RETAILER but not KYC-approved
      mockPrisma.visibilityCapture.findMany.mockResolvedValueOnce([]);
      const result = await makeService().getVisibilityRollup(user, {});
      if (!result.available || !result.visibilityEnabled || result.mode !== 'PHOTO_APPROVAL') throw new Error('expected photo branch');
      expect(mockPrisma.visibilityCapture.findMany.mock.calls[0][0].where.outletId.in.sort()).toEqual(['o1', 'o2']);
      expect(result.counts).toMatchObject({ total: 2, notCaptured: 2, notInScope: 4 });
      expect(result.outlets.find((o) => o.outletCode === 'OUT-3')?.inScope).toBe(false);
    });

    it('a group with no in-scope outlets does not query captures', async () => {
      mockTenantSettings.getEffectiveSettings.mockResolvedValue({
        visibilityConfig: { outletScope: ['NOTHING'], frequencyPerMonth: 2, allowedSalesLevels: [], geoFence: { enabled: false, radiusMeters: 50 } },
      });
      mockPrisma.outlet.findMany.mockReset();
      mockPrisma.outlet.findMany.mockResolvedValueOnce(groupOutlets).mockResolvedValueOnce(groupOutlets).mockResolvedValueOnce([]);
      const result = await makeService().getVisibilityRollup(user, {});
      if (!result.available || !result.visibilityEnabled || result.mode !== 'PHOTO_APPROVAL') throw new Error('expected photo branch');
      expect(mockPrisma.visibilityCapture.findMany).not.toHaveBeenCalled();
      expect(result.counts.total).toBe(0);
      expect(result.counts.notInScope).toBe(6);
    });
  });
});

// ── GET /v1/partner/group/leaderboard ───────────────────────────────────────
describe('GroupService.getLeaderboardRollup', () => {
  it('returns { available: false } when the phone owns no group parent', async () => {
    mockPrisma.channelPartner.findFirst.mockResolvedValueOnce(null);

    const result = await makeService().getLeaderboardRollup(user);

    expect(result).toEqual({ available: false });
    expect(mockPrisma.leaderboardSnapshot.findFirst).not.toHaveBeenCalled();
  });

  it('returns { snapshot: null, entries: [] } when nothing is published', async () => {
    mockPrisma.channelPartner.findFirst
      .mockResolvedValueOnce({ id: 'parent1' })
      .mockResolvedValueOnce({ groupId: 'parent1' })
      .mockResolvedValueOnce({ businessName: 'HQ', ownerName: 'Boss' });
    mockPrisma.channelPartner.findMany.mockResolvedValueOnce([{ id: 'cp1' }, { id: 'cp2' }]);
    mockPrisma.leaderboardSnapshot.findFirst.mockResolvedValueOnce(null);

    const result = await makeService().getLeaderboardRollup(user);

    expect(result).toEqual({
      available: true,
      parent: { businessName: 'HQ', ownerName: 'Boss' },
      snapshot: null,
      entries: [],
    });
    expect(mockPrisma.leaderboardEntry.findMany).not.toHaveBeenCalled();
  });

  it('filters the published snapshot entries to the group partner ids only', async () => {
    mockPrisma.channelPartner.findFirst
      .mockResolvedValueOnce({ id: 'parent1' })
      .mockResolvedValueOnce({ groupId: 'parent1' })
      .mockResolvedValueOnce({ businessName: 'HQ', ownerName: 'Boss' });
    mockPrisma.channelPartner.findMany.mockResolvedValueOnce([{ id: 'cp1' }, { id: 'cp2' }]);
    mockPrisma.leaderboardSnapshot.findFirst.mockResolvedValueOnce({
      id: 'snap1',
      snapshotDate: new Date('2026-07-01T00:00:00Z'),
      periodStartDate: new Date('2026-06-01T00:00:00Z'),
      periodEndDate: new Date('2026-06-30T00:00:00Z'),
    });
    mockPrisma.leaderboardEntry.findMany.mockResolvedValueOnce([
      { rank: 3, partnerId: 'cp1', score: 900, rankChange: 1, partner: { id: 'cp1', businessName: 'Shop One' } },
      { rank: 7, partnerId: 'cp2', score: 400, rankChange: -2, partner: { id: 'cp2', businessName: 'Shop Two' } },
    ]);

    const result = await makeService().getLeaderboardRollup(user);

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable');
    expect(result.entries).toEqual([
      { rank: 3, partnerId: 'cp1', partnerName: 'Shop One', score: 900, rankChange: 1 },
      { rank: 7, partnerId: 'cp2', partnerName: 'Shop Two', score: 400, rankChange: -2 },
    ]);

    // The entry read filters BOTH by the published snapshot AND the group's partner ids.
    const entryWhere = mockPrisma.leaderboardEntry.findMany.mock.calls[0][0].where;
    expect(entryWhere).toEqual({ snapshotId: 'snap1', partnerId: { in: ['cp1', 'cp2'] } });

    // The snapshot selection is tenant-scoped (config.clientId) + published-only.
    const snapWhere = mockPrisma.leaderboardSnapshot.findFirst.mock.calls[0][0].where;
    expect(snapWhere).toEqual({ isPublished: true, config: { clientId: 'deoleo' } });

    // The group partner-id lookup is scoped via outlet.parentId (source of truth) + tenant.
    const partnerWhere = mockPrisma.channelPartner.findMany.mock.calls[0][0].where;
    expect(partnerWhere).toEqual({
      clientId: 'deoleo',
      deletedAt: null,
      outlets: { some: { parentId: 'parent1', clientId: 'deoleo', deletedAt: null } },
    });
  });

  it('skips the entry query when the group has no partners', async () => {
    mockPrisma.channelPartner.findFirst
      .mockResolvedValueOnce({ id: 'parent1' })
      .mockResolvedValueOnce({ groupId: 'parent1' })
      .mockResolvedValueOnce({ businessName: 'HQ', ownerName: 'Boss' });
    mockPrisma.channelPartner.findMany.mockResolvedValueOnce([]); // no group partners
    mockPrisma.leaderboardSnapshot.findFirst.mockResolvedValueOnce({
      id: 'snap1',
      snapshotDate: new Date('2026-07-01T00:00:00Z'),
      periodStartDate: new Date('2026-06-01T00:00:00Z'),
      periodEndDate: new Date('2026-06-30T00:00:00Z'),
    });

    const result = await makeService().getLeaderboardRollup(user);

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable');
    expect(result.entries).toEqual([]);
    expect(mockPrisma.leaderboardEntry.findMany).not.toHaveBeenCalled();
  });
});

// ── APPLIES-TO D6: each outlet row is a single-outlet view ─────────────────────────────────────
describe('GroupService.getTargetsRollup — APPLIES-TO KPI scope', () => {
  function prime(kpis: unknown[]) {
    mockPrisma.channelPartner.findFirst
      .mockResolvedValueOnce({ id: 'parent1' })
      .mockResolvedValueOnce({ groupId: 'parent1' })
      .mockResolvedValueOnce({ businessName: 'HQ', ownerName: 'Boss' });
    mockPrisma.outlet.findMany.mockResolvedValueOnce([
      { outletCode: 'OUT-1', programName: 'RLP', programCategory: null, outletType: { code: 'SSS' } },
      { outletCode: 'OUT-2', programName: 'BSC', programCategory: null, outletType: { code: 'SSS' } },
    ]);
    mockPrisma.outletTarget.findMany.mockResolvedValueOnce([
      { outletCode: 'OUT-1', outletName: 'One', targetValues: { PRI: 100, B: 10 } },
      { outletCode: 'OUT-2', outletName: 'Two', targetValues: { PRI: 200, B: 20 } }, // PRI stale on a BSC outlet
    ]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValueOnce([]);
    mockPrisma.kpiDef.findMany.mockResolvedValueOnce(kpis);
  }
  const u = { outletType: null, outletTypes: [], programs: [], subPrograms: [] };

  it('hides an out-of-scope KPI per outlet, excludes it from group totals, and falls back the primary', async () => {
    prime([
      { code: 'PRI', label: 'Pri', unit: '', isPrimary: true, order: 1, ...u, programs: ['RLP'] },
      { code: 'B', label: 'B', unit: '', isPrimary: false, order: 2, ...u },
    ]);
    const r: any = await makeService().getTargetsRollup(user, { period: '2026-05' });
    if (!r.available) throw new Error('unreachable');
    const one = r.outlets.find((o: any) => o.outletCode === 'OUT-1')!;
    const two = r.outlets.find((o: any) => o.outletCode === 'OUT-2')!;
    expect(one.kpis.map((k: any) => [k.code, k.isPrimary])).toEqual([['PRI', true], ['B', false]]);
    expect(two.kpis.map((k: any) => [k.code, k.isPrimary])).toEqual([['B', true]]); // fallback primary
    expect(r.kpiTotals.find((k: any) => k.code === 'PRI')!.target).toBe(100); // OUT-2's stale 200 not summed
  });

  it('UNSCOPED tenant (Deoleo) → every KPI shown on every outlet with the tenant flags', async () => {
    prime([
      { code: 'PRI', label: 'Pri', unit: '', isPrimary: true, order: 1, ...u },
      { code: 'B', label: 'B', unit: '', isPrimary: false, order: 2, ...u },
    ]);
    const r: any = await makeService().getTargetsRollup(user, { period: '2026-05' });
    if (!r.available) throw new Error('unreachable');
    for (const o of r.outlets) expect(o.kpis.map((k: any) => [k.code, k.isPrimary])).toEqual([['PRI', true], ['B', false]]);
    expect(r.kpiTotals.find((k: any) => k.code === 'PRI')!.target).toBe(300);
  });

  it('primary fallback never picks a DISABLED KPI (audit #7)', async () => {
    prime([
      { code: 'PRI', label: 'Pri', unit: '', isPrimary: true, order: 1, enabled: true, ...u, programs: ['RLP'] },
      { code: 'DIS', label: 'Dis', unit: '', isPrimary: false, order: 0, enabled: false, ...u },
      { code: 'B', label: 'B', unit: '', isPrimary: false, order: 2, enabled: true, ...u },
    ]);
    const r: any = await makeService().getTargetsRollup(user, { period: '2026-05' });
    if (!r.available) throw new Error('unreachable');
    const two = r.outlets.find((o: any) => o.outletCode === 'OUT-2')!;
    expect(two.kpis.map((k: any) => [k.code, k.isPrimary])).toEqual([['B', true]]);
  });
});
