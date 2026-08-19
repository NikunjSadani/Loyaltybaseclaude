import { ensureOutletAccount } from './reward-account.helper';

describe('ensureOutletAccount (Employee Rewards Phase 1)', () => {
  const makeTx = (partner: { accountId: string | null; clientId: string } | null) => {
    const tx = {
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
