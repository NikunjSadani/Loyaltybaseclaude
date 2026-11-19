import { negativeBalanceSignals } from './negative-balance.helper';

describe('negativeBalanceSignals (owner decision 2 + D1, fix round 3 A8/B1)', () => {
  const db = (last: Date | null, reversals: number) => ({
    walletTransaction: {
      findFirst: jest.fn(async () => (last ? { createdAt: last } : null)),
      count: jest.fn(async () => reversals),
    },
  });

  it('a wallet at 0 or above gets nothing added and no query (every Deoleo wallet — summary byte-identical)', async () => {
    const d = db(null, 1);
    await expect(negativeBalanceSignals(d as never, { id: 'w', redeemablePoints: 0 })).resolves.toEqual({});
    await expect(negativeBalanceSignals(d as never, { id: 'w', redeemablePoints: 7014 })).resolves.toEqual({});
    await expect(negativeBalanceSignals(d as never, null)).resolves.toEqual({});
    expect(d.walletTransaction.findFirst).not.toHaveBeenCalled();
    expect(d.walletTransaction.count).not.toHaveBeenCalled();
  });

  it('negative: owedPoints = −balance; "from a reversed credit" only when a reversal moved it AFTER it was last ≥ 0', async () => {
    const t = new Date('2026-11-19T06:00:00Z');
    const d = db(t, 1);
    await expect(negativeBalanceSignals(d as never, { id: 'w1', redeemablePoints: -2986 })).resolves.toEqual({
      owedPoints: 2986,
      owedFromReversal: true,
    });
    expect(d.walletTransaction.count).toHaveBeenCalledWith({
      where: { walletId: 'w1', referenceType: 'CREDIT_REVERSAL', createdAt: { gt: t } },
    });
    // an imported negative (never ≥ 0, no reversal since) → generic wording
    await expect(negativeBalanceSignals(db(null, 0) as never, { id: 'w2', redeemablePoints: -841 })).resolves.toEqual({
      owedPoints: 841,
      owedFromReversal: false,
    });
    // an old over-reversal that was since repaid (balance went ≥ 0 after it) no longer counts
    await expect(negativeBalanceSignals(db(t, 0) as never, { id: 'w3', redeemablePoints: -10 })).resolves.toEqual({
      owedPoints: 10,
      owedFromReversal: false,
    });
  });
});
