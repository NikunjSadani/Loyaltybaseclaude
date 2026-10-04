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
  const prisma = {
    programSetting: {
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    salesUser: {
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    salesHierarchyLevel: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
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
