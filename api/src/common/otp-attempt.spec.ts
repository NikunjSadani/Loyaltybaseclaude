import { claimOtpAttempt, refundOtpAttempt } from './otp-attempt';

type Row = { id: string; attempts: number; maxAttempts: number; verifiedAt: Date | null };

/**
 * A one-row fake of the OtpCode table. `$queryRaw` simulates the claim's single
 * `UPDATE … WHERE id AND verifiedAt IS NULL AND attempts < max RETURNING attempts` (values = [id, max]);
 * `updateMany` honours the where-clause like the DB (used by the refund).
 */
function fakeDb(row: Row) {
  const $queryRaw = jest.fn(async (q: { text: string; values: unknown[] }) => {
    await new Promise((r) => setImmediate(r)); // interleave concurrent callers
    const [id, max] = q.values as [string, number];
    if (id !== row.id || row.verifiedAt !== null || !(row.attempts < max)) return [];
    row.attempts += 1;
    return [{ attempts: row.attempts }];
  });
  const updateMany = jest.fn(async ({ where, data }: any) => {
    await new Promise((r) => setImmediate(r));
    if (where.id !== row.id) return { count: 0 };
    if (where.attempts?.gt !== undefined && !(row.attempts > where.attempts.gt)) return { count: 0 };
    if (data.attempts?.decrement) row.attempts -= data.attempts.decrement;
    return { count: 1 };
  });
  return { db: { $queryRaw, otpCode: { updateMany } } as any, row, $queryRaw };
}

describe('claimOtpAttempt / refundOtpAttempt', () => {
  it('claims with ONE conditional atomic UPDATE … RETURNING bounded by maxAttempts on an unverified row', async () => {
    const { db, $queryRaw } = fakeDb({ id: 'o1', attempts: 0, maxAttempts: 3, verifiedAt: null });
    await expect(claimOtpAttempt(db, { id: 'o1', maxAttempts: 3 })).resolves.toBe(1);
    expect($queryRaw).toHaveBeenCalledTimes(1);
    const q = $queryRaw.mock.calls[0][0];
    const sql = q.text.replace(/\s+/g, ' ').trim();
    expect(sql).toBe(
      'UPDATE "otp_codes" SET "attempts" = "attempts" + 1, "updatedAt" = (now() AT TIME ZONE \'UTC\') ' +
      'WHERE "id" = $1 AND "verifiedAt" IS NULL AND "attempts" < $2 RETURNING "attempts"',
    );
    expect(q.values).toEqual(['o1', 3]);
  });

  it('returns the POST-increment attempts value of THIS claim (1, 2, 3) then null', async () => {
    const { db } = fakeDb({ id: 'o1', attempts: 0, maxAttempts: 3, verifiedAt: null });
    const rec = { id: 'o1', maxAttempts: 3 };
    expect(await claimOtpAttempt(db, rec)).toBe(1);
    expect(await claimOtpAttempt(db, rec)).toBe(2);
    expect(await claimOtpAttempt(db, rec)).toBe(3);
    expect(await claimOtpAttempt(db, rec)).toBeNull();
  });

  it('100 parallel claims on a fresh row → exactly maxAttempts win, each with a distinct attempt number', async () => {
    const { db, row } = fakeDb({ id: 'o1', attempts: 0, maxAttempts: 3, verifiedAt: null });
    const res = await Promise.all(Array.from({ length: 100 }, () => claimOtpAttempt(db, { id: 'o1', maxAttempts: 3 })));
    const wins = res.filter((v): v is number => v !== null);
    expect(wins.sort()).toEqual([1, 2, 3]);
    expect(row.attempts).toBe(3);
  });

  it('a verified row can never be claimed', async () => {
    const { db } = fakeDb({ id: 'o1', attempts: 0, maxAttempts: 3, verifiedAt: new Date() });
    await expect(claimOtpAttempt(db, { id: 'o1', maxAttempts: 3 })).resolves.toBeNull();
  });

  it('a pg driver returning the value as a string is normalised to a number', async () => {
    const db = { $queryRaw: jest.fn().mockResolvedValue([{ attempts: '2' }]) } as any;
    await expect(claimOtpAttempt(db, { id: 'o1', maxAttempts: 3 })).resolves.toBe(2);
  });

  it('refund decrements once and never below zero', async () => {
    const { db, row } = fakeDb({ id: 'o1', attempts: 1, maxAttempts: 3, verifiedAt: null });
    await refundOtpAttempt(db, 'o1');
    expect(row.attempts).toBe(0);
    await refundOtpAttempt(db, 'o1');
    expect(row.attempts).toBe(0);
  });
});
