import {
  ensureOutletAccount,
  ensureEmployeeAccount,
  ensureEmployeeAccountsForSalesUsers,
} from './reward-account.helper';

describe('ensureOutletAccount (Employee Rewards Phase 1)', () => {
  const makeTx = (partner: { accountId: string | null; clientId: string } | null) => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0), // per-partner advisory lock
      channelPartner: {
        findUnique: jest.fn().mockResolvedValue(partner),
        update: jest.fn().mockResolvedValue({}),
      },
      rewardAccount: {
        create: jest.fn().mockResolvedValue({ id: 'acc-new' }),
      },
    };
    return tx as never;
  };

  it('returns the existing accountId without creating or linking a new one', async () => {
    const tx = makeTx({ accountId: 'acc-1', clientId: 'deoleo' });
    const id = await ensureOutletAccount(tx, 'p1');
    expect(id).toBe('acc-1');
    expect((tx as never as { rewardAccount: { create: jest.Mock } }).rewardAccount.create).not.toHaveBeenCalled();
    expect((tx as never as { channelPartner: { update: jest.Mock } }).channelPartner.update).not.toHaveBeenCalled();
  });

  it('creates an OUTLET account (partner clientId) and links it when the partner has none', async () => {
    const tx = makeTx({ accountId: null, clientId: 'deoleo' });
    const id = await ensureOutletAccount(tx, 'p1');
    expect(id).toBe('acc-new');
    const t = tx as never as {
      rewardAccount: { create: jest.Mock };
      channelPartner: { update: jest.Mock };
    };
    expect(t.rewardAccount.create).toHaveBeenCalledWith({
      data: { clientId: 'deoleo', accountType: 'OUTLET' },
    });
    expect(t.channelPartner.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { accountId: 'acc-new' },
    });
  });

  it('throws if the partner does not exist', async () => {
    const tx = makeTx(null);
    await expect(ensureOutletAccount(tx, 'gone')).rejects.toThrow(/not found/);
  });
});

describe('ensureEmployeeAccount (Employee Rewards Phase A)', () => {
  const makeTx = (salesUser: { accountId: string | null; clientId: string } | null) => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0), // per-employee advisory lock
      salesUser: {
        findUnique: jest.fn().mockResolvedValue(salesUser),
        update: jest.fn().mockResolvedValue({}),
      },
      rewardAccount: {
        create: jest.fn().mockResolvedValue({ id: 'acc-new' }),
      },
    };
    return tx as never;
  };

  it('returns the existing accountId without creating or linking a new one (idempotent)', async () => {
    const tx = makeTx({ accountId: 'acc-1', clientId: 'acme' });
    const id = await ensureEmployeeAccount(tx, 'su1');
    expect(id).toBe('acc-1');
    const t = tx as never as {
      rewardAccount: { create: jest.Mock };
      salesUser: { update: jest.Mock };
    };
    expect(t.rewardAccount.create).not.toHaveBeenCalled();
    expect(t.salesUser.update).not.toHaveBeenCalled();
  });

  it('creates an EMPLOYEE account (sales-user clientId) and links it when the employee has none', async () => {
    const tx = makeTx({ accountId: null, clientId: 'acme' });
    const id = await ensureEmployeeAccount(tx, 'su1');
    expect(id).toBe('acc-new');
    const t = tx as never as {
      rewardAccount: { create: jest.Mock };
      salesUser: { update: jest.Mock };
    };
    expect(t.rewardAccount.create).toHaveBeenCalledWith({
      data: { clientId: 'acme', accountType: 'EMPLOYEE' },
    });
    expect(t.salesUser.update).toHaveBeenCalledWith({
      where: { id: 'su1' },
      data: { accountId: 'acc-new' },
    });
  });

  it('a second call (now linked) returns the SAME id and creates no new row', async () => {
    // First call creates+links; model the second call as the post-link state (accountId set).
    const tx = makeTx({ accountId: 'acc-new', clientId: 'acme' });
    const id = await ensureEmployeeAccount(tx, 'su1');
    expect(id).toBe('acc-new');
    expect((tx as never as { rewardAccount: { create: jest.Mock } }).rewardAccount.create).not.toHaveBeenCalled();
  });

  it('throws if the sales user does not exist', async () => {
    const tx = makeTx(null);
    await expect(ensureEmployeeAccount(tx, 'gone')).rejects.toThrow(/not found/);
  });

  it('serializes on the TENANT-level lock (same key as the bulk path), not a per-employee key', async () => {
    // REGRESSION GUARD (money audit M1): if this used `reward_account:employee:${salesUserId}` it
    // would hash to a DIFFERENT advisory lock than the bulk roster path, so a concurrent upload +
    // this ensure could each mint an account for the same employee (one orphaned). Both paths MUST
    // share `reward_account:employee:client:${clientId}`.
    const tx = makeTx({ accountId: null, clientId: 'acme' });
    await ensureEmployeeAccount(tx, 'su1');
    const exec = (tx as never as { $executeRaw: jest.Mock }).$executeRaw;
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1]).toBe('reward_account:employee:client:acme');
  });

  it('re-checks AFTER the lock: returns the account a concurrent holder linked while we waited (no second mint)', async () => {
    // findUnique #1 (pre-lock) sees no account; #2 (post-lock re-read) sees it now linked by a
    // concurrent bulk roster save that committed while we blocked on the shared tenant lock.
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce({ accountId: null, clientId: 'acme' })
      .mockResolvedValueOnce({ accountId: 'acc-from-bulk' });
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      salesUser: { findUnique, update: jest.fn().mockResolvedValue({}) },
      rewardAccount: { create: jest.fn().mockResolvedValue({ id: 'acc-should-not-create' }) },
    } as never;
    const id = await ensureEmployeeAccount(tx, 'su1');
    expect(id).toBe('acc-from-bulk');
    expect((tx as never as { rewardAccount: { create: jest.Mock } }).rewardAccount.create).not.toHaveBeenCalled();
    expect((tx as never as { salesUser: { update: jest.Mock } }).salesUser.update).not.toHaveBeenCalled();
  });
});

describe('ensureEmployeeAccountsForSalesUsers (Employee Rewards Phase A — bulk, set-based)', () => {
  const makeTx = (needing: string[]) => {
    const createdRewardAccounts: any[] = [];
    const linkedSalesUserIds: string[] = [];
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0), // ONE tenant-level advisory lock
      salesUser: {
        findMany: jest.fn().mockResolvedValue(needing.map((id) => ({ id }))),
        update: jest.fn().mockImplementation((args: any) => {
          linkedSalesUserIds.push(args.where.id);
          return Promise.resolve({});
        }),
      },
      rewardAccount: {
        createMany: jest.fn().mockImplementation((args: any) => {
          createdRewardAccounts.push(...args.data);
          return Promise.resolve({ count: args.data.length });
        }),
      },
    };
    return { tx: tx as never, createdRewardAccounts, linkedSalesUserIds };
  };

  it('no-ops on an empty id list (no lock, no scan)', async () => {
    const { tx } = makeTx([]);
    const n = await ensureEmployeeAccountsForSalesUsers(tx, 'acme', []);
    expect(n).toBe(0);
    expect((tx as never as { $executeRaw: jest.Mock }).$executeRaw).not.toHaveBeenCalled();
  });

  it('locks on the TENANT-level key + createMany + ONE set-based link UPDATE (no per-row link)', async () => {
    const { tx, createdRewardAccounts, linkedSalesUserIds } = makeTx(['su1', 'su2', 'su3']);
    const n = await ensureEmployeeAccountsForSalesUsers(tx, 'acme', ['su1', 'su2', 'su3']);
    expect(n).toBe(3);
    const exec = (tx as never as { $executeRaw: jest.Mock }).$executeRaw;
    // Exactly TWO raw statements: [0] the ONE tenant-level advisory lock, [1] the set-based link.
    expect(exec).toHaveBeenCalledTimes(2);
    // REGRESSION GUARD (money audit M1): the lock MUST be the TENANT-level key so this bulk path
    // and the single-edit path (ensureEmployeeAccount) mutually exclude on the SAME advisory lock.
    // A per-employee key here would reopen the double-mint/orphan hole.
    expect(exec.mock.calls[0][1]).toBe('reward_account:employee:client:acme');
    // The link is ONE set-based UPDATE over sales_users (not N per-row updates), carrying every pair.
    const linkSql = exec.mock.calls[1][0] as { sql: string; values: unknown[] };
    expect(String(linkSql.sql)).toMatch(/UPDATE "sales_users"/);
    expect(String(linkSql.sql)).toMatch(/"accountId" IS NULL/);
    expect(linkSql.values).toEqual(expect.arrayContaining(['su1', 'su2', 'su3']));
    // The profiles are NOT linked via per-row salesUser.update anymore.
    expect(linkedSalesUserIds).toHaveLength(0);
    // one batched createMany with distinct ids, all EMPLOYEE/acme
    expect((tx as never as { rewardAccount: { createMany: jest.Mock } }).rewardAccount.createMany).toHaveBeenCalledTimes(1);
    expect(createdRewardAccounts).toHaveLength(3);
    const ids = createdRewardAccounts.map((a) => a.id);
    expect(new Set(ids).size).toBe(3); // unique ids paired to each employee
    for (const a of createdRewardAccounts) {
      expect(a.accountType).toBe('EMPLOYEE');
      expect(a.clientId).toBe('acme');
    }
  });

  it('idempotent: when no employee lacks an account, nothing is created', async () => {
    const { tx, createdRewardAccounts, linkedSalesUserIds } = makeTx([]); // scan returns none
    const n = await ensureEmployeeAccountsForSalesUsers(tx, 'acme', ['su1', 'su2']);
    expect(n).toBe(0);
    expect((tx as never as { rewardAccount: { createMany: jest.Mock } }).rewardAccount.createMany).not.toHaveBeenCalled();
    expect(createdRewardAccounts).toHaveLength(0);
    expect(linkedSalesUserIds).toHaveLength(0);
  });
});
