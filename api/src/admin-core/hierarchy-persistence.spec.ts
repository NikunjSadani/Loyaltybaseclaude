/**
 * Unit tests for the phone ↔ employeeCode uniqueness guard added to persistHierarchy.
 *
 * A phone is a person's login: it must map to exactly one employee per tenant. Before
 * this guard, a phone already attached to a different SalesUser (or reused twice within
 * one file) blew up as a raw P2002 on SalesUser.userId — a 500 that also rolled back the
 * snapshot ("0 after refresh"). These tests pin the guard's clean 400 behaviour and the
 * blank-phone resolution (blank ≠ a shared empty-string user).
 */
import { BadRequestException } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import {
  persistHierarchy,
  mapRoleCodeToUserRole,
  DEOLEO_HIERARCHY,
  syntheticPlaceholderPhone,
  type HierarchyEmployee,
  type TenantHierarchyLevel,
} from './hierarchy-persistence';

describe('mapRoleCodeToUserRole — Deoleo byte-identical + custom-config resolution', () => {
  // The exact mapping the LEGACY hardcoded switch produced. Deoleo must resolve IDENTICALLY
  // whether it reads DEOLEO_HIERARCHY[].userRole or falls through to the switch.
  const DEOLEO_EXPECTED: Record<string, UserRole> = {
    NSM: 'SALES_HO',
    ZNM: 'SALES_STATE_HEAD',
    RSM: 'SALES_STATE_HEAD',
    ASM: 'SALES_ASM',
    SO: 'SALES_SO',
    XSR: 'SALES_ISR',
  };

  it('resolves every Deoleo code to the SAME UserRole as the old switch (via DEOLEO_HIERARCHY)', () => {
    for (const [code, expected] of Object.entries(DEOLEO_EXPECTED)) {
      expect(mapRoleCodeToUserRole(code, DEOLEO_HIERARCHY)).toBe(expected);
    }
  });

  it('resolves identically with the default arg (no config passed) — legacy single-arg callers', () => {
    for (const [code, expected] of Object.entries(DEOLEO_EXPECTED)) {
      expect(mapRoleCodeToUserRole(code)).toBe(expected);
    }
  });

  it('is case-insensitive and trims (matches the switch) and defaults unknown → SALES_ISR', () => {
    expect(mapRoleCodeToUserRole('  nsm  ', DEOLEO_HIERARCHY)).toBe('SALES_HO');
    expect(mapRoleCodeToUserRole('WHO_KNOWS', DEOLEO_HIERARCHY)).toBe('SALES_ISR');
  });

  it('resolves a CUSTOM config via its per-level userRole mapping', () => {
    const custom: TenantHierarchyLevel[] = [
      { tenantId: 't', level: 1, roleCode: 'REP', roleLabel: 'Rep', isLeaf: true, isRoot: false, userRole: 'SALES_ISR' },
      { tenantId: 't', level: 2, roleCode: 'MGR', roleLabel: 'Manager', isLeaf: false, isRoot: false, userRole: 'SALES_ASM' },
      { tenantId: 't', level: 3, roleCode: 'HEAD', roleLabel: 'Head', isLeaf: false, isRoot: true, userRole: 'SALES_HO' },
    ];
    expect(mapRoleCodeToUserRole('REP', custom)).toBe('SALES_ISR');
    expect(mapRoleCodeToUserRole('mgr', custom)).toBe('SALES_ASM');
    expect(mapRoleCodeToUserRole('HEAD', custom)).toBe('SALES_HO');
  });

  it('falls through to the switch when a matching level lacks an explicit userRole', () => {
    // A Deoleo-code level WITHOUT userRole → the switch still covers it (NSM→SALES_HO).
    const noUserRole: TenantHierarchyLevel[] = [
      { tenantId: 't', level: 1, roleCode: 'NSM', roleLabel: 'NSM', isLeaf: false, isRoot: true },
    ];
    expect(mapRoleCodeToUserRole('NSM', noUserRole)).toBe('SALES_HO');
  });
});

type ExistingUser = { phone: string; salesUser: { employeeCode: string } | null };

/**
 * Minimal Prisma.TransactionClient mock that records the phones of newly-created users.
 *
 * `existingSalesUsersByCode` maps an employeeCode → its existing SalesUser row (the userId the
 * persist loop resolves via salesUser.findUnique). Codes absent from the map are treated as
 * brand-new employees (findUnique → null → resolve-ACTIVE-holder (none) → user.create runs).
 */
/**
 * Employee Rewards Phase A options:
 *  - loyaltyType: the tenant's loyaltyType the in-tx client.findUnique returns (default TRADE,
 *    so every pre-existing test keeps exercising the trade path unchanged).
 *  - alreadyLinked: when true, the set-based account scan (salesUser.findMany for rows LACKING an
 *    accountId) returns [] — simulating an idempotent re-upload where every employee already has
 *    an account, so no new RewardAccount is created.
 */
interface TxOpts {
  loyaltyType?: string;
  alreadyLinked?: boolean;
}

function makeTx(
  existingUsers: ExistingUser[] = [],
  existingSalesUsersByCode: Record<string, { userId: string; user?: { role: string } }> = {},
  opts: TxOpts = {},
) {
  const upsertedUserPhones: string[] = [];
  // Employee Rewards Phase A trackers.
  const createdRewardAccounts: any[] = []; // every row passed to rewardAccount.createMany
  const linkedAccountSalesUserIds: string[] = []; // salesUser.update calls that set an accountId
  const stampedUserIds: string[] = []; // user.updateMany({sessionsInvalidBefore}) — role-change revoke
  const revokedSessionUserIds: string[] = []; // userSession.updateMany revoke targets
  let userSeq = 0;
  let salesSeq = 0;
  const tx = {
    // $executeRaw serves TWO calls in the EMPLOYEE path: the tenant-level advisory lock (tagged
    // template → first arg is a TemplateStringsArray) and the set-based link UPDATE (function form
    // → first arg is a Prisma.Sql with .sql/.values). Capture the linked sales-user ids from the
    // link statement's values ([su, acc, su, acc, ...] → even indices are sales-user ids).
    $executeRaw: jest.fn().mockImplementation((arg: any) => {
      if (arg && typeof arg === 'object' && typeof arg.sql === 'string' && /UPDATE "sales_users"/.test(arg.sql)) {
        const vals: unknown[] = arg.values ?? [];
        for (let i = 0; i < vals.length; i += 2) linkedAccountSalesUserIds.push(vals[i] as string);
      }
      return Promise.resolve(0);
    }),
    client: {
      // In-tx earner-model read (gate). Default TRADE → OUTLET → account step is skipped.
      findUnique: jest
        .fn()
        .mockResolvedValue({ loyaltyType: opts.loyaltyType ?? 'TRADE_LOYALTY', features: null }),
    },
    user: {
      findMany: jest.fn().mockResolvedValue(existingUsers),
      findUnique: jest.fn().mockResolvedValue(null),
      // Brand-new employee → resolve ACTIVE holder (none here) then create; records created phones.
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((args: any) => {
        upsertedUserPhones.push(args.data.phone);
        return Promise.resolve({ id: `user-${userSeq++}` });
      }),
      update: jest
        .fn()
        .mockImplementation((args: any) => Promise.resolve({ id: args.where.id })),
      // Role-change revoke: the stamp of sessionsInvalidBefore on the changed users.
      updateMany: jest.fn().mockImplementation((args: any) => {
        const ids: string[] = args?.where?.id?.in ?? [];
        if (args?.data && 'sessionsInvalidBefore' in args.data) stampedUserIds.push(...ids);
        return Promise.resolve({ count: ids.length });
      }),
    },
    userSession: {
      updateMany: jest.fn().mockImplementation((args: any) => {
        const ids: string[] = args?.where?.userId?.in ?? [];
        revokedSessionUserIds.push(...ids);
        return Promise.resolve({ count: ids.length });
      }),
    },
    salesHierarchyLevel: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest
        .fn()
        .mockImplementation((args: any) =>
          Promise.resolve({ id: `lvl-${args.where.clientId_code.code}` }),
        ),
    },
    salesUser: {
      findUnique: jest.fn().mockImplementation((args: any) => {
        const code = args.where.clientId_employeeCode.employeeCode;
        return Promise.resolve(existingSalesUsersByCode[code] ?? null);
      }),
      upsert: jest.fn().mockImplementation(() => Promise.resolve({ id: `su-${salesSeq++}` })),
      // Set-based account scan: the supplied ids, minus any already linked (alreadyLinked → none).
      findMany: jest.fn().mockImplementation((args: any) => {
        if (opts.alreadyLinked) return Promise.resolve([]);
        const ids: string[] = args?.where?.id?.in ?? [];
        return Promise.resolve(ids.map((id) => ({ id })));
      }),
      update: jest.fn().mockImplementation((args: any) => {
        if (args?.data && Object.prototype.hasOwnProperty.call(args.data, 'accountId')) {
          linkedAccountSalesUserIds.push(args.where.id);
        }
        return Promise.resolve({});
      }),
    },
    rewardAccount: {
      createMany: jest.fn().mockImplementation((args: any) => {
        createdRewardAccounts.push(...args.data);
        return Promise.resolve({ count: args.data.length });
      }),
      create: jest.fn().mockResolvedValue({ id: 'acc-single' }),
    },
  };
  return { tx: tx as any, upsertedUserPhones, createdRewardAccounts, linkedAccountSalesUserIds, stampedUserIds, revokedSessionUserIds };
}

const CLIENT = 'deoleo';

function emp(over: Partial<HierarchyEmployee>): HierarchyEmployee {
  return {
    id: 'XSR-1',
    roleCode: 'XSR',
    reportsToId: null,
    name: 'Anil',
    mobile: '9900000001',
    status: 'ACTIVE',
    ...over,
  };
}

describe('persistHierarchy — phone ↔ employeeCode guard', () => {
  it('rejects two employee codes that share the same phone within one file', async () => {
    const employees = [
      emp({ id: 'XSR-1', mobile: '9900000001' }),
      emp({ id: 'XSR-2', mobile: '9900000001' }), // same phone, different code
    ];
    const { tx } = makeTx([]);
    await expect(persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx),
    ).rejects.toThrow(/more than one employee/i);
  });

  it('rejects a phone already owned by a DIFFERENT existing employee code', async () => {
    const employees = [emp({ id: 'XSR-NEW', mobile: '9875436349' })];
    const { tx } = makeTx([{ phone: '9875436349', salesUser: { employeeCode: 'XSR-OLD' } }]);
    await expect(
      persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx),
    ).rejects.toThrow(/already belongs to employee XSR-OLD/i);
  });

  it('rejects a phone already used by a non-sales account (no salesUser)', async () => {
    const employees = [emp({ id: 'XSR-NEW', mobile: '6289864191' })];
    const { tx } = makeTx([{ phone: '6289864191', salesUser: null }]);
    await expect(
      persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx),
    ).rejects.toThrow(/already used by another account/i);
  });

  it("scopes the DB phone-conflict scan to ACTIVE users (a deactivated user's freed phone no longer blocks)", async () => {
    // Deactivate-frees-phone: only an ACTIVE user reserves a (clientId, phone). The freed
    // number of an INACTIVE user must no longer be returned by the conflict scan — the DB
    // (ACTIVE-only) yields no holder here, so a brand-new employee on that phone uploads clean.
    const employees = [emp({ id: 'XSR-NEW', mobile: '9875436349' })];
    const { tx } = makeTx([]); // ACTIVE-only query finds no holder
    await persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx);
    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
  });

  it('allows an idempotent re-upload of the SAME (code, phone)', async () => {
    const employees = [emp({ id: 'XSR-1', mobile: '9900000001' })];
    const { tx } = makeTx([{ phone: '9900000001', salesUser: { employeeCode: 'XSR-1' } }]);
    const result = await persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx);
    expect(result.salesUsersUpserted).toBe(1);
  });

  it('rejects a blank Employee ID (would otherwise P2002 on employeeCode)', async () => {
    const employees = [emp({ id: '   ', mobile: '9900000001' })];
    const { tx } = makeTx([]);
    await expect(
      persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx),
    ).rejects.toThrow(/non-blank Employee ID/i);
  });

  it('rejects a duplicate Employee ID within the upload', async () => {
    const employees = [
      emp({ id: 'XSR-1', mobile: '9900000001' }),
      emp({ id: 'XSR-1', mobile: '9900000002' }), // same code, different phone
    ];
    const { tx } = makeTx([]);
    await expect(
      persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx),
    ).rejects.toThrow(/appears more than once/i);
  });

  it('updates the SAME User row in place when an existing employee’s phone is corrected (no orphan)', async () => {
    // XSR-1 already exists: SalesUser(employeeCode=XSR-1) → User(id=user-existing) at phone P1.
    // Re-upload the SAME code with a NEW phone P2. The fix must UPDATE user-existing to P2
    // (freeing P1 on the same row), NOT create a second User and orphan the old one.
    const employees = [emp({ id: 'XSR-1', mobile: '9900000002' })]; // P2
    const { tx, upsertedUserPhones } = makeTx(
      // §0b guard: P2 is not yet owned by anyone → no conflict.
      [],
      // §2: XSR-1 already has a canonical User.
      { 'XSR-1': { userId: 'user-existing' } },
    );

    await persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx);

    // (a) the existing User row was updated in place to the new phone P2…
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-existing' },
      data: expect.objectContaining({ phone: '9900000002' }),
    });
    // (b) …and NO new User was created for this existing employee (no orphan left behind).
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(upsertedUserPhones).toEqual([]);
    // the SalesUser is re-pointed at the SAME resolved user id, not a fresh one.
    expect(tx.salesUser.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ userId: 'user-existing' }),
      }),
    );
  });

  it('creates a fresh User via the phone-keyed upsert for a BRAND-NEW employee', async () => {
    // No existing SalesUser for XSR-NEW → findUnique returns null → the create branch runs.
    const employees = [emp({ id: 'XSR-NEW', mobile: '9900000009' })];
    const { tx, upsertedUserPhones } = makeTx([], {}); // no existing salesUser
    await persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(upsertedUserPhones).toEqual(['9900000009']);
  });

  it('gives each blank-phone employee a UNIQUE synthetic phone (no empty-string collapse)', async () => {
    const employees = [
      emp({ id: 'XSR-A', name: 'A', mobile: '' }),
      emp({ id: 'XSR-B', name: 'B', mobile: '' }),
    ];
    const { tx, upsertedUserPhones } = makeTx([]);
    await persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx);
    expect(upsertedUserPhones).toEqual([
      syntheticPlaceholderPhone('XSR-A'),
      syntheticPlaceholderPhone('XSR-B'),
    ]);
    // distinct → no two users collapse onto one (clientId, '') row
    expect(new Set(upsertedUserPhones).size).toBe(2);
  });
});

describe('persistHierarchy — Employee Rewards Phase A (gated EMPLOYEE RewardAccount)', () => {
  it('EMPLOYEE tenant: each ACTIVE employee gets exactly ONE RewardAccount + a linked accountId', async () => {
    const employees = [
      emp({ id: 'XSR-1', name: 'A', mobile: '9900000001' }),
      emp({ id: 'XSR-2', name: 'B', mobile: '9900000002' }),
    ];
    const { tx, createdRewardAccounts, linkedAccountSalesUserIds } = makeTx([], {}, {
      loyaltyType: 'EMPLOYEE_REWARDS',
    });

    const result = await persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx);

    // one EMPLOYEE account per active employee…
    expect(tx.rewardAccount.createMany).toHaveBeenCalledTimes(1);
    expect(createdRewardAccounts).toHaveLength(2);
    for (const acc of createdRewardAccounts) {
      expect(acc.accountType).toBe('EMPLOYEE');
      expect(acc.clientId).toBe(CLIENT);
      expect(typeof acc.id).toBe('string'); // app-generated id, paired to a sales user
    }
    // …and each active SalesUser had its accountId linked.
    expect(linkedAccountSalesUserIds).toHaveLength(2);
    expect(result.employeeAccountsEnsured).toBe(2);
    // OUTLET helper must never run on this path.
    expect(tx.channelPartner).toBeUndefined();
  });

  it('EMPLOYEE tenant idempotent re-upload: NO duplicate accounts created', async () => {
    const employees = [emp({ id: 'XSR-1', name: 'A', mobile: '9900000001' })];
    // alreadyLinked → the lacking-account scan returns [] (all employees already have accounts).
    const { tx, createdRewardAccounts, linkedAccountSalesUserIds } = makeTx([], {}, {
      loyaltyType: 'EMPLOYEE_REWARDS',
      alreadyLinked: true,
    });

    const result = await persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx);

    expect(tx.rewardAccount.createMany).not.toHaveBeenCalled();
    expect(createdRewardAccounts).toHaveLength(0);
    expect(linkedAccountSalesUserIds).toHaveLength(0);
    expect(result.employeeAccountsEnsured).toBe(0);
  });

  it('TRADE tenant: NO RewardAccount created and NO accountId written (Deoleo byte-identical)', async () => {
    const employees = [
      emp({ id: 'XSR-1', name: 'A', mobile: '9900000001' }),
      emp({ id: 'XSR-2', name: 'B', mobile: '9900000002' }),
    ];
    // Default loyaltyType is TRADE_LOYALTY → earnerModel OUTLET → the whole account step is skipped.
    const { tx, createdRewardAccounts, linkedAccountSalesUserIds } = makeTx([], {});

    const result = await persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx);

    expect(tx.rewardAccount.createMany).not.toHaveBeenCalled();
    expect(tx.rewardAccount.create).not.toHaveBeenCalled();
    expect(tx.salesUser.findMany).not.toHaveBeenCalled(); // account scan never happens
    expect(createdRewardAccounts).toHaveLength(0);
    expect(linkedAccountSalesUserIds).toHaveLength(0); // no SalesUser.accountId ever written
    expect(result.employeeAccountsEnsured).toBe(0);
  });

  it('EMPLOYEE tenant: a synthetic VACANT node is NOT given an account (only active earners)', async () => {
    const employees = [
      emp({ id: 'XSR-1', name: 'A', mobile: '9900000001' }), // active earner
      emp({ id: 'XSR-2', name: null, mobile: '', status: 'PLACEHOLDER' }), // vacant placeholder
    ];
    const { tx, createdRewardAccounts } = makeTx([], {}, { loyaltyType: 'EMPLOYEE_REWARDS' });

    const result = await persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx);

    // Only the ONE active employee is handed to the account scan + createMany.
    const scanArgs = (tx.salesUser.findMany as jest.Mock).mock.calls[0][0];
    expect(scanArgs.where.id.in).toHaveLength(1);
    expect(createdRewardAccounts).toHaveLength(1);
    expect(result.employeeAccountsEnsured).toBe(1);
  });
});

describe('persistHierarchy — role-change session revoke (immediate enforcement, all tenants)', () => {
  it('revokes sessions of a user whose coarse role CHANGES on a re-upload', async () => {
    const employees = [emp({ id: 'XSR-1', roleCode: 'XSR', mobile: '9900000001' })]; // XSR → SALES_ISR
    const { tx, stampedUserIds, revokedSessionUserIds } = makeTx(
      [],
      { 'XSR-1': { userId: 'u-1', user: { role: 'SALES_SO' } } }, // was SALES_SO → now SALES_ISR (changes)
    );
    const res = await persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx);
    expect(res.rolesRevoked).toBe(1);
    expect(stampedUserIds).toEqual(['u-1']); // sessionsInvalidBefore stamped first
    expect(revokedSessionUserIds).toEqual(['u-1']); // then live sessions revoked
  });

  it('does NOT revoke when the role is unchanged (idempotent re-upload)', async () => {
    const employees = [emp({ id: 'XSR-1', roleCode: 'XSR', mobile: '9900000001' })]; // XSR → SALES_ISR
    const { tx, revokedSessionUserIds } = makeTx(
      [],
      { 'XSR-1': { userId: 'u-1', user: { role: 'SALES_ISR' } } }, // already SALES_ISR → no change
    );
    const res = await persistHierarchy(CLIENT, employees, DEOLEO_HIERARCHY, tx);
    expect(res.rolesRevoked).toBe(0);
    expect(revokedSessionUserIds).toEqual([]);
  });
});
