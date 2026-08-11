import { Prisma } from '@prisma/client';

/**
 * The PARTIAL unique index that enforces "at most one ACTIVE user per (clientId, phone)"
 * — defined in migration 20260811120000_user_phone_active_partial (WHERE status='ACTIVE').
 * Because it is raw SQL (Prisma cannot express a partial predicate), a P2002 from it reports
 * this index NAME as `meta.target` (a string), not a column array — hence the string match.
 */
export const ACTIVE_PHONE_INDEX = 'users_clientId_phone_active_key';

/** A user-facing message for a phone already held by another ACTIVE user in the tenant. */
export const ACTIVE_PHONE_IN_USE_MSG =
  'This phone number is already in use by another active user. Please use a different phone number.';

/**
 * True when `e` is a Prisma unique-violation (P2002) on the ACTIVE-phone partial index — i.e. an
 * attempt to make a second ACTIVE user hold a phone already held by an ACTIVE user in the tenant.
 * Every write path that can flip a User to ACTIVE (create / reactivate / KYC-approval / parent
 * activation) should map this to a clean domain error instead of leaking a 500.
 */
export function isActivePhoneConflict(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === 'P2002' &&
    String(e.meta?.target ?? '').includes(ACTIVE_PHONE_INDEX)
  );
}
