import { negativeBalanceSignals } from './negative-balance.helper';

describe('negativeBalanceSignals (owner decision 2 + D1; fix rounds 3–4: A8/B1/item 2)', () => {
  const db = (last: unknown, reversals: number) => ({
    walletTransaction: {
      findFirst: jest.fn(async () => last),
      count: jest.fn(async () => reversals),
    },
  });

  it('a wallet at 0 or above gets nothing added and no query (every Deoleo wallet — summary byte-identical)', async () => {
    const d = db(null, 1);
    await expect(negativeBalanceSignals(d as never, { id: 'w', redeemablePoints: 0 })).resolves.toEqual({});
    await expect(negativeBalanceSignals(d as never, { id: 'w', redeemablePoints: 7014, movementSeq: 9 })).resolves.toEqual({});
    await expect(negativeBalanceSignals(d as never, null)).resolves.toEqual({});
    expect(d.walletTransaction.findFirst).not.toHaveBeenCalled();
    expect(d.walletTransaction.count).not.toHaveBeenCalled();
  });

  it('sequenced wallet: decided by SEQ — a reversal row with a higher seq than the last row that left it ≥ 0', async () => {
    const d = db({ seq: 7 }, 1);
    await expect(negativeBalanceSignals(d as never, { id: 'w1', redeemablePoints: -2986, movementSeq: 9 })).resolves.toEqual({
      owedPoints: 2986,
      owedFromReversal: true,
    });
    expect(d.walletTransaction.findFirst).toHaveBeenCalledWith({
      where: { walletId: 'w1', balanceAfter: { gte: 0 }, seq: { not: null } },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    expect(d.walletTransaction.count).toHaveBeenCalledWith({
      where: { walletId: 'w1', creditReversalId: { not: null }, seq: { gt: 7 } },
    });
    // an old over-reversal since repaid (the balance went ≥ 0 after it) no longer counts
    await expect(negativeBalanceSignals(db({ seq: 12 }, 0) as never, { id: 'w3', redeemablePoints: -10, movementSeq: 13 })).resolves.toEqual({
      owedPoints: 10,
      owedFromReversal: false,
    });
  });

  it('never-sequenced wallet (imported negative): row times, generic wording when no reversal', async () => {
    const d = db(null, 0);
    await expect(negativeBalanceSignals(d as never, { id: 'w2', redeemablePoints: -841, movementSeq: 0 })).resolves.toEqual({
      owedPoints: 841,
      owedFromReversal: false,
    });
    expect(d.walletTransaction.count).toHaveBeenCalledWith({ where: { walletId: 'w2', referenceType: 'CREDIT_REVERSAL' } });
  });

  it('round 5 B7: sequenced wallet whose last row at or above zero has NO seq (pre-sequencing history) → time comparison', async () => {
    const t = new Date('2026-11-01T00:00:00Z');
    const d = {
      walletTransaction: {
        // the seq probe finds nothing; the time probe finds the pre-sequencing row
        findFirst: jest.fn(async (a: { where: { seq?: unknown } }) => (a.where.seq ? null : { createdAt: t })),
        count: jest.fn(async () => 1),
      },
    };
    await expect(negativeBalanceSignals(d as never, { id: 'w4', redeemablePoints: -50, movementSeq: 5 })).resolves.toEqual({
      owedPoints: 50,
      owedFromReversal: true,
    });
    expect(d.walletTransaction.count).toHaveBeenCalledWith({
      where: { walletId: 'w4', referenceType: 'CREDIT_REVERSAL', createdAt: { gt: t } },
    });
  });
});
