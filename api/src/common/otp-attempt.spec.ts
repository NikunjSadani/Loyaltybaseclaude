import { claimOtpAttempt, refundOtpAttempt } from './otp-attempt';

/** A one-row fake of the OtpCode table whose updateMany honours the where-clause like the DB. */
function fakeDb(row: { id: string; attempts: number; maxAttempts: number; verifiedAt: Date | null }) {
  const updateMany = jest.fn(async ({ where, data }: any) => {
    await new Promise((r) => setImmediate(r)); // interleave concurrent callers
    if (where.id !== row.id) return { count: 0 };
    if ('verifiedAt' in where && where.verifiedAt === null && row.verifiedAt !== null) return { count: 0 };
    if (where.attempts?.lt !== undefined && !(row.attempts < where.attempts.lt)) return { count: 0 };
    if (where.attempts?.gt !== undefined && !(row.attempts > where.attempts.gt)) return { count: 0 };
    if (data.attempts?.increment) row.attempts += data.attempts.increment;
    if (data.attempts?.decrement) row.attempts -= data.attempts.decrement;
    return { count: 1 };
  });
  return { db: { otpCode: { updateMany } } as any, row, updateMany };
}

describe('claimOtpAttempt / refundOtpAttempt', () => {
  it('claims with a conditional atomic increment bounded by maxAttempts on an unverified row', async () => {
    const { db, updateMany } = fakeDb({ id: 'o1', attempts: 0, maxAttempts: 3, verifiedAt: null });
    await expect(claimOtpAttempt(db, { id: 'o1', maxAttempts: 3 })).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', verifiedAt: null, attempts: { lt: 3 } },
      data:  { attempts: { increment: 1 } },
    });
  });

  it('100 parallel claims on a fresh row → exactly maxAttempts win', async () => {
    const { db, row } = fakeDb({ id: 'o1', attempts: 0, maxAttempts: 3, verifiedAt: null });
    const wins = await Promise.all(Array.from({ length: 100 }, () => claimOtpAttempt(db, { id: 'o1', maxAttempts: 3 })));
    expect(wins.filter(Boolean)).toHaveLength(3);
    expect(row.attempts).toBe(3);
  });

  it('a verified row can never be claimed', async () => {
    const { db } = fakeDb({ id: 'o1', attempts: 0, maxAttempts: 3, verifiedAt: new Date() });
    await expect(claimOtpAttempt(db, { id: 'o1', maxAttempts: 3 })).resolves.toBe(false);
  });

  it('refund decrements once and never below zero', async () => {
    const { db, row } = fakeDb({ id: 'o1', attempts: 1, maxAttempts: 3, verifiedAt: null });
    await refundOtpAttempt(db, 'o1');
    expect(row.attempts).toBe(0);
    await refundOtpAttempt(db, 'o1');
    expect(row.attempts).toBe(0);
  });
});
