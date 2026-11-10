import type { Prisma } from '@prisma/client';

/**
 * Claim-before-compare for OTP verification (audit 2026-11-10).
 *
 * Every OTP verify used to READ `attempts`, compare the code, then WRITE `attempts + 1` on a miss.
 * N parallel requests all read the same count, so ~100 concurrent guesses got compared before the
 * counter reached maxAttempts — and a correct guess among them succeeded. The fix: before comparing,
 * atomically claim one attempt with a conditional increment. The DB serialises the claims, so at most
 * maxAttempts requests per OTP are EVER compared; a losing claim is refused with the site's existing
 * "too many attempts" error and its code is never looked at.
 */
type OtpAttemptDb = Pick<Prisma.TransactionClient, 'otpCode'>;

/** true → this request may compare the code (one attempt consumed); false → cap spent / OTP used. */
export async function claimOtpAttempt(
  db: OtpAttemptDb,
  record: { id: string; maxAttempts: number },
): Promise<boolean> {
  const { count } = await db.otpCode.updateMany({
    where: { id: record.id, verifiedAt: null, attempts: { lt: record.maxAttempts } },
    data:  { attempts: { increment: 1 } },
  });
  return count > 0;
}

/**
 * Give back a claimed attempt after a CORRECT code, for flows where a correct code must not consume
 * an attempt (the redemption confirm leaves the OTP unverified until its debit transaction commits,
 * so a correct code followed by a failed debit could be retried before this fix). Only reachable
 * with the right code, so it cannot be used to buy extra guesses. Never goes below zero.
 */
export async function refundOtpAttempt(db: OtpAttemptDb, id: string): Promise<void> {
  await db.otpCode.updateMany({
    where: { id, attempts: { gt: 0 } },
    data:  { attempts: { decrement: 1 } },
  });
}
