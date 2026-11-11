import { Prisma } from '@prisma/client';

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
type OtpClaimDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Claim one attempt ATOMICALLY and return the row's POST-increment `attempts` value (1..maxAttempts),
 * or null when the claim is refused (cap spent / OTP already verified / EXPIRED / row gone).
 * The expiry guard (audit L1) means a code superseded (expired) by a parallel resend between a site's
 * read and its claim can never be claimed; every caller already refuses an expired row before claiming,
 * so honest flows are unchanged. `expiresAt` is stored as UTC wall-clock (Prisma DateTime).
 *
 * ONE statement — the conditional increment and the read of its result happen together, so the value
 * returned is exactly this request's attempt number even under parallel guesses (2026-11-11). Callers
 * compute "N attempts remaining" as `maxAttempts - claimed`, never from the earlier (possibly stale) read.
 * `updatedAt` is set as Prisma's @updatedAt would (UTC wall-clock, matching how Prisma stores DateTime).
 */
export async function claimOtpAttempt(
  db: OtpClaimDb,
  record: { id: string; maxAttempts: number },
): Promise<number | null> {
  const rows = await db.$queryRaw<Array<{ attempts: number }>>(Prisma.sql`
    UPDATE "otp_codes"
       SET "attempts" = "attempts" + 1, "updatedAt" = (now() AT TIME ZONE 'UTC')
     WHERE "id" = ${record.id} AND "verifiedAt" IS NULL AND "attempts" < ${record.maxAttempts}
       AND "expiresAt" > (now() AT TIME ZONE 'UTC')
    RETURNING "attempts"`);
  return rows.length > 0 ? Number(rows[0].attempts) : null;
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

/**
 * Consume (mark used) an OTP CONDITIONALLY — only if no one else consumed it first. Returns false when
 * the row is already verified, so two parallel correct submissions can never both succeed (each site
 * then raises its existing "OTP not found / no active OTP" error). Works with a transaction client.
 */
export async function markOtpUsed(db: OtpAttemptDb, id: string, at: Date = new Date()): Promise<boolean> {
  const { count } = await db.otpCode.updateMany({
    where: { id, verifiedAt: null },
    data:  { verifiedAt: at },
  });
  return count === 1;
}
