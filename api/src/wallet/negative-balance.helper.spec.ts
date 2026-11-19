import { negativeBalanceSignals } from './negative-balance.helper';

describe('negativeBalanceSignals (owner decision 2, 2026-11-19)', () => {
  const db = (n: number) => ({ creditReversalAllocation: { count: jest.fn(async () => n) } });

  it('a wallet at 0 or above gets nothing added and no query (every Deoleo wallet — summary byte-identical)', async () => {
    const d = db(1);
    await expect(negativeBalanceSignals(d as never, { id: 'w', redeemablePoints: 0 })).resolves.toEqual({});
    await expect(negativeBalanceSignals(d as never, { id: 'w', redeemablePoints: 7014 })).resolves.toEqual({});
    await expect(negativeBalanceSignals(d as never, null)).resolves.toEqual({});
    expect(d.creditReversalAllocation.count).not.toHaveBeenCalled();
  });

  it('a negative wallet: owedPoints = −balance; owedFromReversal from its over-reversal allocations', async () => {
    const d = db(1);
    await expect(negativeBalanceSignals(d as never, { id: 'w1', redeemablePoints: -2986 })).resolves.toEqual({
      owedPoints: 2986,
      owedFromReversal: true,
    });
    expect(d.creditReversalAllocation.count).toHaveBeenCalledWith({
      where: { overReversalDebt: true, position: { walletId: 'w1' } },
    });
    await expect(negativeBalanceSignals(db(0) as never, { id: 'w2', redeemablePoints: -841 })).resolves.toEqual({
      owedPoints: 841,
      owedFromReversal: false,
    });
  });
});
