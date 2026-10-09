import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { JwtPayload } from './decorators/current-user.decorator';
import { resolveCapabilities } from './loyalty-capabilities.helper';

/**
 * Employee Rewards Workstream 2 (Wave 2) — the SHARED, read-only resolution of the LOGGED-IN
 * employee's own context, used by every account-first EMPLOYEE read rail (wallet summary, passbook,
 * orders, affordability-aware catalogue). It is the READ mirror of the resolution inside
 * `RewardsService.redeemForEmployee` (the write path), extracted here so BOTH WalletService and
 * RewardsService resolve the employee identically and the live TRADE/partner read paths are never
 * touched.
 *
 * Resolution (in order):
 *   1. EMPLOYEE-earner TENANT gate (fail-safe). An unknown/absent loyaltyType resolves to the
 *      TRADE/OUTLET capability defaults (see loyalty-capabilities.helper), so a trade tenant can
 *      NEVER reach an employee read rail — it is rejected here with a clean 400.
 *   2. The caller's OWN SalesUser (userId + clientId, non-deleted). THIS is the identity
 *      authorization — an employee only ever resolves to THEIR OWN account. A non-employee caller
 *      (e.g. a CLIENT_ADMIN with no SalesUser row) is rejected with a clean 403.
 *
 * DIFFERENCE FROM THE WRITE PATH: reads NEVER create/provision anything. The employee's
 * `accountId` may be NULL (a roster employee who has not yet been provisioned a RewardAccount, e.g.
 * never credited). Callers treat a null accountId as an EMPTY wallet / no orders (zeroed summary,
 * empty page) — they do NOT crash and do NOT mint an account. Inactivity is NOT blocked for reads:
 * viewing your own wallet/orders is harmless and carries no money movement (the redeem write path
 * still blocks an inactive employee).
 */

/** The Prisma surface this resolver reads (PrismaService or a $transaction client both satisfy it). */
type Db = Pick<Prisma.TransactionClient, 'client' | 'salesUser'>;

/** The resolved employee read context. `accountId` null ⇒ not yet provisioned ⇒ empty reads. */
export interface EmployeeReadContext {
  /** The caller's own SalesUser id (never another employee's). */
  salesUserId: string;
  /** The employee's EMPLOYEE RewardAccount id, or null when not yet provisioned (→ empty reads). */
  accountId: string | null;
  /** The employee's tenant hierarchy-level CODE (drives the catalogue visibility gate); may be null. */
  roleCode: string | null;
  /** The employee's region (drives the catalogue visibility gate); may be null. */
  region: string | null;
  /** The employee's tenant-unique employeeCode (used to replay credit-batch field names in the passbook). */
  employeeCode: string;
}

/**
 * Resolve the logged-in employee's own read context, or throw (400 for a non-employee tenant, 403
 * for a non-employee caller). Pure resolution — no writes, no account creation.
 */
export async function resolveEmployeeReadContext(
  db: Db,
  user: JwtPayload,
): Promise<EmployeeReadContext> {
  // 1. EMPLOYEE-earner tenant gate (fail-safe → TRADE defaults for an unknown/absent loyaltyType).
  const client = await db.client.findUnique({
    where: { id: user.clientId },
    select: { loyaltyType: true, features: true },
  });
  const capabilities = resolveCapabilities(
    client?.loyaltyType as string | null | undefined,
    (client?.features ?? null) as Record<string, unknown> | null,
  );
  if (capabilities.earnerModel !== 'EMPLOYEE') {
    throw new BadRequestException(
      'Employee self-service rewards apply to employee-rewards tenants only.',
    );
  }

  // 2. The caller's OWN SalesUser — the identity authorization (own account only).
  const salesUser = await db.salesUser.findFirst({
    where: { userId: user.sub, clientId: user.clientId, deletedAt: null },
    select: {
      id: true,
      accountId: true,
      region: true,
      employeeCode: true,
      hierarchyLevel: { select: { code: true } },
    },
  });
  if (!salesUser) {
    throw new ForbiddenException('Only employees may view their own rewards.');
  }

  return {
    salesUserId: salesUser.id,
    accountId: salesUser.accountId ?? null,
    roleCode: salesUser.hierarchyLevel?.code ?? null,
    region: salesUser.region ?? null,
    employeeCode: salesUser.employeeCode,
  };
}
