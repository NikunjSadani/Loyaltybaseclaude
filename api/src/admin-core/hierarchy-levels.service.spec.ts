/**
 * Employee Rewards Phase A — unit tests for the per-tenant hierarchy LEVELS config
 * (getLevelsConfig fallback + setHierarchyLevels validation) and the Employee cockpit
 * peopleOverview metrics. Constructs AdminCoreService directly with a minimal Prisma mock
 * (only the methods these three code paths touch), matching the dashboards' spec style.
 */
import { BadRequestException } from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { DEOLEO_HIERARCHY, type TenantHierarchyLevel } from './hierarchy-persistence';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

const clientAdmin: JwtPayload = {
  sub: 'ca1',
  role: 'CLIENT_ADMIN',
  clientId: 'acme',
  phone: '',
  name: '',
};

function makeService() {
  const prisma: any = {
    // F3 guard: setHierarchyLevels is EMPLOYEE-tenants-only. Default to an employee tenant so the
    // validation/reconcile tests reach their target; a dedicated test overrides this to TRADE.
    client: {
      findUnique: jest.fn().mockResolvedValue({ loyaltyType: 'EMPLOYEE_REWARDS', features: null }),
    },
    programSetting: {
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    salesUser: {
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]), // reconcile: active employees to remap / referenced parked
    },
    salesHierarchyLevel: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]), // reconcile: existing / all / still-parked level rows
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }), // reconcile: sessionsInvalidBefore stamp + role remap
    },
    userSession: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }), // reconcile: revoke sessions of role-changed users
    },
    // setHierarchyLevels wraps the upsert + reconcile in a tx; run the callback with prisma as tx.
    $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const svc = new AdminCoreService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, prisma };
}

const CUSTOM: TenantHierarchyLevel[] = [
  { tenantId: 'acme', level: 1, roleCode: 'REP', roleLabel: 'Field Rep', isLeaf: true, isRoot: false, userRole: 'SALES_ISR' },
  { tenantId: 'acme', level: 2, roleCode: 'MGR', roleLabel: 'Area Manager', isLeaf: false, isRoot: false, userRole: 'SALES_ASM' },
  { tenantId: 'acme', level: 3, roleCode: 'HEAD', roleLabel: 'Country Head', isLeaf: false, isRoot: true, userRole: 'SALES_HO' },
];

describe('getLevelsConfig — fallback to Deoleo', () => {
  it('returns DEOLEO_HIERARCHY when no hierarchy_levels setting exists', async () => {
    const { svc, prisma } = makeService();
    const levels = await svc.getLevelsConfig('deoleo');
    expect(levels).toEqual(DEOLEO_HIERARCHY);
    expect(prisma.programSetting.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ settingKey: 'hierarchy_levels', clientId: 'deoleo' }),
      }),
    );
  });

  it('falls back to Deoleo when the stored blob is malformed (not an array)', async () => {
    const { svc, prisma } = makeService();
    prisma.programSetting.findFirst.mockResolvedValueOnce({ settingValue: { nope: true } });
    expect(await svc.getLevelsConfig('acme')).toEqual(DEOLEO_HIERARCHY);
  });

  it('falls back to Deoleo when the stored blob is an empty array', async () => {
    const { svc, prisma } = makeService();
    prisma.programSetting.findFirst.mockResolvedValueOnce({ settingValue: [] });
    expect(await svc.getLevelsConfig('acme')).toEqual(DEOLEO_HIERARCHY);
  });

  it('falls back to Deoleo when a stored blob has DUPLICATE levels/codes (audit F6 — avoids a P2002 on upload)', async () => {
    const { svc, prisma } = makeService();
    // Out-of-band blob (bypassing setHierarchyLevels) with two level-1 rows + a dup code.
    prisma.programSetting.findFirst.mockResolvedValueOnce({
      settingValue: [
        { tenantId: 'acme', level: 1, roleCode: 'REP', roleLabel: 'Rep', isLeaf: true, isRoot: false },
        { tenantId: 'acme', level: 1, roleCode: 'REP', roleLabel: 'Rep2', isLeaf: false, isRoot: true },
      ],
    });
    expect(await svc.getLevelsConfig('acme')).toEqual(DEOLEO_HIERARCHY);
  });

  it('returns a stored well-formed 3-level custom config (normalized, sorted by level)', async () => {
    const { svc, prisma } = makeService();
    // Store out-of-order to prove normalizeLevelsBlob sorts by level.
    prisma.programSetting.findFirst.mockResolvedValueOnce({ settingValue: [...CUSTOM].reverse() });
    const levels = await svc.getLevelsConfig('acme');
    expect(levels.map((l) => l.roleCode)).toEqual(['REP', 'MGR', 'HEAD']);
    expect(levels[1]).toMatchObject({ roleCode: 'MGR', roleLabel: 'Area Manager', userRole: 'SALES_ASM' });
  });
});

describe('setHierarchyLevels — validation', () => {
  it('stores a valid custom config and returns the normalized levels', async () => {
    const { svc, prisma } = makeService();
    const res = await svc.setHierarchyLevels(clientAdmin, CUSTOM);
    expect(res.levels).toHaveLength(3);
    expect(prisma.programSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId_settingKey: { clientId: 'acme', settingKey: 'hierarchy_levels' } },
        create: expect.objectContaining({ category: 'hierarchy', updatedById: 'ca1' }),
      }),
    );
  });

  it('rejects an empty config', async () => {
    const { svc } = makeService();
    await expect(svc.setHierarchyLevels(clientAdmin, [])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a TRADE tenant entirely (audit F3 — reconcile must never touch a live trade roster)', async () => {
    const { svc, prisma } = makeService();
    prisma.client.findUnique.mockResolvedValue({ loyaltyType: 'TRADE_LOYALTY', features: null });
    await expect(svc.setHierarchyLevels(clientAdmin, CUSTOM)).rejects.toThrow(/employee-rewards tenants only/i);
    // Nothing is written — the guard is the first thing checked.
    expect(prisma.programSetting.upsert).not.toHaveBeenCalled();
    expect(prisma.salesHierarchyLevel.update).not.toHaveBeenCalled();
  });

  // Structural-rule tests carry a valid userRole on every level (now REQUIRED, audit F1) so they
  // reach the specific structural check under test rather than tripping the userRole requirement.
  const R = { userRole: 'SALES_ISR' as const };

  it('rejects non-contiguous levels (1,2,4)', async () => {
    const { svc } = makeService();
    const bad = [
      { level: 1, roleCode: 'A', isLeaf: true, isRoot: false, ...R },
      { level: 2, roleCode: 'B', isLeaf: false, isRoot: false, ...R },
      { level: 4, roleCode: 'C', isLeaf: false, isRoot: true, ...R },
    ];
    await expect(svc.setHierarchyLevels(clientAdmin, bad)).rejects.toThrow(/contiguous/i);
  });

  it('rejects 0 leaves', async () => {
    const { svc } = makeService();
    const bad = [
      { level: 1, roleCode: 'A', isLeaf: false, isRoot: false, ...R },
      { level: 2, roleCode: 'B', isLeaf: false, isRoot: true, ...R },
    ];
    await expect(svc.setHierarchyLevels(clientAdmin, bad)).rejects.toThrow(/leaf/i);
  });

  it('rejects 2 leaves', async () => {
    const { svc } = makeService();
    const bad = [
      { level: 1, roleCode: 'A', isLeaf: true, isRoot: false, ...R },
      { level: 2, roleCode: 'B', isLeaf: true, isRoot: true, ...R },
    ];
    await expect(svc.setHierarchyLevels(clientAdmin, bad)).rejects.toThrow(/leaf/i);
  });

  it('rejects 0 roots', async () => {
    const { svc } = makeService();
    const bad = [
      { level: 1, roleCode: 'A', isLeaf: true, isRoot: false, ...R },
      { level: 2, roleCode: 'B', isLeaf: false, isRoot: false, ...R },
    ];
    await expect(svc.setHierarchyLevels(clientAdmin, bad)).rejects.toThrow(/root/i);
  });

  it('rejects 2 roots', async () => {
    const { svc } = makeService();
    const bad = [
      { level: 1, roleCode: 'A', isLeaf: true, isRoot: true, ...R },
      { level: 2, roleCode: 'B', isLeaf: false, isRoot: true, ...R },
    ];
    await expect(svc.setHierarchyLevels(clientAdmin, bad)).rejects.toThrow(/root/i);
  });

  it('rejects duplicate role codes (case-insensitive)', async () => {
    const { svc } = makeService();
    const bad = [
      { level: 1, roleCode: 'rep', isLeaf: true, isRoot: false, ...R },
      { level: 2, roleCode: 'REP', isLeaf: false, isRoot: true, ...R },
    ];
    await expect(svc.setHierarchyLevels(clientAdmin, bad)).rejects.toThrow(/more than once/i);
  });

  it('rejects an invalid userRole', async () => {
    const { svc } = makeService();
    const bad = [
      { level: 1, roleCode: 'A', isLeaf: true, isRoot: false, userRole: 'SALES_ISR' },
      { level: 2, roleCode: 'B', isLeaf: false, isRoot: true, userRole: 'GIFSY_ADMIN' },
    ];
    await expect(svc.setHierarchyLevels(clientAdmin, bad)).rejects.toThrow(/valid mapped role/i);
  });

  it('rejects a level MISSING userRole (audit F1 — would silently collapse to SALES_ISR)', async () => {
    const { svc } = makeService();
    const bad = [
      { level: 1, roleCode: 'A', isLeaf: true, isRoot: false, userRole: 'SALES_ISR' },
      { level: 2, roleCode: 'B', isLeaf: false, isRoot: true }, // no userRole
    ];
    await expect(svc.setHierarchyLevels(clientAdmin, bad)).rejects.toThrow(/valid mapped role/i);
  });

  it('rejects a roleCode with HTML/unsafe characters (audit F7)', async () => {
    const { svc } = makeService();
    const bad = [
      { level: 1, roleCode: '<img src=x>', isLeaf: true, isRoot: true, userRole: 'SALES_ISR' },
    ];
    await expect(svc.setHierarchyLevels(clientAdmin, bad)).rejects.toThrow(/letters, numbers/i);
  });
});

describe('setHierarchyLevels — reconcile (audit F2/F4: no manual re-upload after editing levels)', () => {
  it('renames a level code IN PLACE (reuses the row at that level) + remaps roles by level number', async () => {
    const { svc, prisma } = makeService();
    // Existing relational rows: level 1 (id L1, was REP) and level 2 (id L2, was MGR).
    // findMany serves step 1 (level≥0) + step 3 (all rows) with the existing rows, and the step-4b
    // still-parked query (level<0) with none (both rows were reused back to positive).
    prisma.salesHierarchyLevel.findMany.mockImplementation((args: any) => {
      const lvl = args?.where?.level;
      if (lvl && typeof lvl === 'object' && 'lt' in lvl) return Promise.resolve([]);
      return Promise.resolve([
        { id: 'L1', level: 1 },
        { id: 'L2', level: 2 },
      ]);
    });
    // Two active employees: u1 at level 1 (already SALES_ISR → no change), u2 at level 2 (SALES_SO
    // today → will change to the level-2 role).
    prisma.salesUser.findMany.mockResolvedValue([
      { userId: 'u1', hierarchyLevel: { level: 1 }, user: { role: 'SALES_ISR' } },
      { userId: 'u2', hierarchyLevel: { level: 2 }, user: { role: 'SALES_SO' } },
    ]);
    // Rename level-1 code REP→FIELD (userRole same) and level-2 MGR→MANAGER with a DIFFERENT userRole.
    const renamed: TenantHierarchyLevel[] = [
      { tenantId: 'acme', level: 1, roleCode: 'FIELD', roleLabel: 'Field', isLeaf: true, isRoot: false, userRole: 'SALES_ISR' },
      { tenantId: 'acme', level: 2, roleCode: 'MANAGER', roleLabel: 'Manager', isLeaf: false, isRoot: true, userRole: 'SALES_STATE_HEAD' },
    ];
    await svc.setHierarchyLevels(clientAdmin, renamed);

    // The level-1 row (L1) is updated IN PLACE to the new code (not a new row) → employees stay linked.
    expect(prisma.salesHierarchyLevel.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'L1' }, data: expect.objectContaining({ level: 1, code: 'FIELD' }) }),
    );
    expect(prisma.salesHierarchyLevel.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'L2' }, data: expect.objectContaining({ level: 2, code: 'MANAGER' }) }),
    );
    expect(prisma.salesHierarchyLevel.create).not.toHaveBeenCalled(); // same level count → no new rows
    // Only u2's role changed → it gets re-roled...
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['u2'] } }, data: { role: 'SALES_STATE_HEAD' } }),
    );
    // ...its sessionsInvalidBefore is stamped...
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['u2'] } }, data: expect.objectContaining({ sessionsInvalidBefore: expect.any(Date) }) }),
    );
    // ...and its live sessions are revoked (immediate role enforcement, not a ~60m wait).
    expect(prisma.userSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: { in: ['u2'] }, revokedAt: null }, data: expect.objectContaining({ revokedAt: expect.any(Date) }) }),
    );
  });

  it('cleans up UNREFERENCED parked level rows (audit F1 — no __tmp__ orphan accumulation)', async () => {
    const { svc, prisma } = makeService();
    // step 1 (level≥0) + step 3 (all) → one active level; step 4b (level<0) → two leftover parked
    // rows P8, P9.
    prisma.salesHierarchyLevel.findMany.mockImplementation((args: any) => {
      const lvl = args?.where?.level;
      if (lvl && typeof lvl === 'object' && 'lt' in lvl) {
        return Promise.resolve([{ id: 'P8' }, { id: 'P9' }]);
      }
      return Promise.resolve([{ id: 'L1', level: 1 }]);
    });
    // P8 is still referenced by a (deactivated) employee; P9 is not.
    prisma.salesUser.findMany.mockImplementation((args: any) => {
      if (args?.distinct) return Promise.resolve([{ hierarchyLevelId: 'P8' }]);
      return Promise.resolve([]); // remap: no active employees
    });
    const cfg: TenantHierarchyLevel[] = [
      { tenantId: 'acme', level: 1, roleCode: 'ONLY', roleLabel: 'Only', isLeaf: true, isRoot: true, userRole: 'SALES_ISR' },
    ];
    await svc.setHierarchyLevels(clientAdmin, cfg);
    // Only the UNREFERENCED parked row (P9) is deleted; P8 (referenced) is kept.
    expect(prisma.salesHierarchyLevel.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['P9'] } } }),
    );
  });

  it('rejects reducing levels when an active employee sits at a removed level (no silent orphaning)', async () => {
    const { svc, prisma } = makeService();
    // Existing has 3 levels; the new config has 2 → level 3 is removed.
    prisma.salesHierarchyLevel.findMany.mockResolvedValue([
      { id: 'L1', level: 1 },
      { id: 'L2', level: 2 },
      { id: 'L3', level: 3 },
    ]);
    prisma.salesUser.count.mockResolvedValue(4); // 4 active employees still at the removed level
    const shorter: TenantHierarchyLevel[] = [
      { tenantId: 'acme', level: 1, roleCode: 'REP', roleLabel: 'Rep', isLeaf: true, isRoot: false, userRole: 'SALES_ISR' },
      { tenantId: 'acme', level: 2, roleCode: 'HEAD', roleLabel: 'Head', isLeaf: false, isRoot: true, userRole: 'SALES_HO' },
    ];
    await expect(svc.setHierarchyLevels(clientAdmin, shorter)).rejects.toThrow(/removed|reassign/i);
    // Nothing committed (the whole tx would roll back).
    expect(prisma.salesHierarchyLevel.create).not.toHaveBeenCalled();
  });
});

describe('peopleOverview — tenant-scoped roster metrics', () => {
  it('returns correct counts + perLevel breakdown', async () => {
    const { svc, prisma } = makeService();
    // count() is called 4×, in order: total, active, placeholders, rewardAccounts.
    prisma.salesUser.count
      .mockResolvedValueOnce(10) // totalEmployees
      .mockResolvedValueOnce(8) // activeEmployees
      .mockResolvedValueOnce(2) // placeholders
      .mockResolvedValueOnce(5); // rewardAccounts
    prisma.salesHierarchyLevel.count.mockResolvedValueOnce(3); // levelCount
    prisma.salesHierarchyLevel.findMany.mockResolvedValueOnce([
      { id: 'L1', code: 'REP', name: 'Field Rep', level: 1 },
      { id: 'L2', code: 'MGR', name: 'Area Manager', level: 2 },
      { id: 'L3', code: 'HEAD', name: 'Country Head', level: 3 },
    ]);
    prisma.salesUser.groupBy.mockResolvedValueOnce([
      { hierarchyLevelId: 'L1', _count: { _all: 7 } },
      { hierarchyLevelId: 'L2', _count: { _all: 2 } },
      // L3 absent → should surface as 0
    ]);

    const res = await svc.peopleOverview(clientAdmin);

    expect(res).toMatchObject({
      totalEmployees: 10,
      activeEmployees: 8,
      placeholders: 2,
      levelCount: 3,
      rewardAccounts: 5,
    });
    expect(res.perLevel).toEqual([
      { levelId: 'L1', code: 'REP', name: 'Field Rep', level: 1, employeeCount: 7 },
      { levelId: 'L2', code: 'MGR', name: 'Area Manager', level: 2, employeeCount: 2 },
      { levelId: 'L3', code: 'HEAD', name: 'Country Head', level: 3, employeeCount: 0 },
    ]);

    // Every roster query is tenant-scoped by clientId.
    for (const call of prisma.salesUser.count.mock.calls) {
      expect(call[0].where.clientId).toBe('acme');
    }
    expect(prisma.salesUser.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ clientId: 'acme', deletedAt: null }) }),
    );
    // Parked/superseded levels (negative `level`) are excluded from the KPI + breakdown (audit F3).
    expect(prisma.salesHierarchyLevel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ clientId: 'acme', level: { gt: 0 } }) }),
    );
    expect(prisma.salesHierarchyLevel.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ level: { gt: 0 } }) }),
    );
  });
});
