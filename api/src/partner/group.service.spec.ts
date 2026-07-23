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
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  channelPartner: { findFirst: jest.fn() },
  wallet: { aggregate: jest.fn() },
  outlet: { findMany: jest.fn() },
};

const mockTenantSettings = { getConversionRate: jest.fn() };

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
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTenantSettings.getConversionRate.mockResolvedValue(10);
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
