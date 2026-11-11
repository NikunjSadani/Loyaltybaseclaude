/**
 * claimOtpAttempt against a REAL Postgres (audit 2026-11-11): proves the single
 * `UPDATE "otp_codes" … RETURNING "attempts"` claim on the real table — post-increment values,
 * the maxAttempts cap, the verifiedAt guard, the expiresAt guard (L1) and 30 PARALLEL claims.
 *
 * Runs under `npm run test:e2e` ONLY when BOTH `DATABASE_URL` is set AND `OTP_CLAIM_E2E=1` (explicit
 * opt-in: the spec writes rows), and refuses to run if `current_database()` looks like staging/prod.
 * Every row it writes uses a unique throw-away phone and is deleted in afterAll.
 */
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { claimOtpAttempt } from '../src/common/otp-attempt';

const enabled = !!process.env.DATABASE_URL && process.env.OTP_CLAIM_E2E === '1';
const d = enabled ? describe : describe.skip;

d('claimOtpAttempt × real Postgres', () => {
  let prisma: PrismaService;
  const phone = `e2e-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    const [{ db }] = await prisma.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`;
    if (/prod|staging/i.test(db)) throw new Error(`Refusing to run against ${db}`);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.otpCode.deleteMany({ where: { phone } });
    await prisma.$disconnect();
  });

  const row = (over: { expiresAt?: Date; verifiedAt?: Date | null } = {}) =>
    prisma.otpCode.create({
      data: {
        phone, code: '000000', purpose: 'LOGIN', maxAttempts: 3,
        expiresAt: over.expiresAt ?? new Date(Date.now() + 10 * 60 * 1000),
        verifiedAt: over.verifiedAt ?? null,
      },
    });

  it('returns the post-increment attempts 1, 2, 3 then null, and the row holds 3', async () => {
    const r = await row();
    const rec = { id: r.id, maxAttempts: 3 };
    expect(await claimOtpAttempt(prisma, rec)).toBe(1);
    expect(await claimOtpAttempt(prisma, rec)).toBe(2);
    expect(await claimOtpAttempt(prisma, rec)).toBe(3);
    expect(await claimOtpAttempt(prisma, rec)).toBeNull();
    expect((await prisma.otpCode.findUnique({ where: { id: r.id } }))!.attempts).toBe(3);
  });

  it('30 parallel claims → exactly 3 win with distinct values 1, 2, 3', async () => {
    const r = await row();
    const res = await Promise.all(Array.from({ length: 30 }, () => claimOtpAttempt(prisma, { id: r.id, maxAttempts: 3 })));
    expect(res.filter((v): v is number => v !== null).sort()).toEqual([1, 2, 3]);
  });

  it('never claims a verified row or an expired row (L1)', async () => {
    const verified = await row({ verifiedAt: new Date() });
    expect(await claimOtpAttempt(prisma, { id: verified.id, maxAttempts: 3 })).toBeNull();
    const expired = await row({ expiresAt: new Date(Date.now() - 1000) });
    expect(await claimOtpAttempt(prisma, { id: expired.id, maxAttempts: 3 })).toBeNull();
    expect((await prisma.otpCode.findUnique({ where: { id: expired.id } }))!.attempts).toBe(0);
  });
});
