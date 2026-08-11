import { Prisma } from '@prisma/client';
import { isActivePhoneConflict, ACTIVE_PHONE_INDEX, ACTIVE_PHONE_IN_USE_MSG } from './phone-conflict';

/** Build a Prisma P2002 known-request error with the given meta.target shape. */
function p2002(target: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

describe('isActivePhoneConflict', () => {
  it('is TRUE for a P2002 on the active-phone partial index (string target)', () => {
    expect(isActivePhoneConflict(p2002(ACTIVE_PHONE_INDEX))).toBe(true);
    expect(isActivePhoneConflict(p2002(`some_prefix_${ACTIVE_PHONE_INDEX}`))).toBe(true);
  });

  it('is FALSE for a P2002 on a DIFFERENT index (e.g. email, identity)', () => {
    expect(isActivePhoneConflict(p2002('users_clientId_email_key'))).toBe(false);
    expect(isActivePhoneConflict(p2002(['clientId', 'panNumber']))).toBe(false);
  });

  it('is FALSE for a non-P2002 Prisma error and for non-Prisma errors', () => {
    const notFound = new Prisma.PrismaClientKnownRequestError('nope', { code: 'P2025', clientVersion: 'test', meta: {} });
    expect(isActivePhoneConflict(notFound)).toBe(false);
    expect(isActivePhoneConflict(new Error('boom'))).toBe(false);
    expect(isActivePhoneConflict(null)).toBe(false);
    expect(isActivePhoneConflict(undefined)).toBe(false);
  });

  it('exposes a plain-English message', () => {
    expect(ACTIVE_PHONE_IN_USE_MSG).toMatch(/already in use by another active user/i);
  });
});
