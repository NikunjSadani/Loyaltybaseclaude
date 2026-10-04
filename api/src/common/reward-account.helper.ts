import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

/**
 * Employee Rewards Phase 1 — find-or-create the OUTLET RewardAccount for a channel
 * partner and link it on the partner (`channel_partners.accountId`). Idempotent:
 * returns the already-linked accountId if present, else creates one RewardAccount
 * (accountType OUTLET, the partner's clientId) and links it.
 *
 * Called at every wallet-create and redemption-order-create site so the unified
 * account layer stays POPULATED going forward (dual-write). Outlets keep
 * `partnerId` as the profile; the account is the unified owner. Must run inside the
 * same transaction as the wallet/order create so the link is atomic.
 *
 * OUTLET-only for now; the EMPLOYEE earner (accountType EMPLOYEE, profile = SalesUser)
 * is wired in Phase 2, where employee wallets are created account-first (no partner).
 */
export async function ensureOutletAccount(
  tx: Prisma.TransactionClient,
  partnerId: string,
): Promise<string> {
  // Serialize per-partner (advisory xact lock, held to end of tx) so concurrent FIRST
  // wallet-creates for the same partner — KYC-approval vs a credit-batch confirm, or two
  // credit batches — cannot both pass the check-then-act below and mint TWO accounts /
  // split ownership (partner.accountId != wallet.accountId). Without this the split is
  // permanent: the NULL-only back-fill can't heal two non-null-but-divergent links.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reward_account:${partnerId}`}, 0))`;

  const partner = await tx.channelPartner.findUnique({
    where: { id: partnerId },
    select: { accountId: true, clientId: true },
  });
  if (!partner) {
    throw new Error(`ensureOutletAccount: channel partner ${partnerId} not found`);
  }
  if (partner.accountId) return partner.accountId;

  const account = await tx.rewardAccount.create({
    data: { clientId: partner.clientId, accountType: 'OUTLET' },
  });
  await tx.channelPartner.update({
    where: { id: partnerId },
    data: { accountId: account.id },
  });
  return account.id;
}

/**
 * Employee Rewards Phase A — find-or-create the EMPLOYEE RewardAccount for ONE roster
 * employee and link it on the profile (`sales_users.accountId`). The EMPLOYEE mirror of
 * `ensureOutletAccount`: idempotent, returns the already-linked accountId if present, else
 * creates one RewardAccount (accountType EMPLOYEE, the employee's clientId) and links it.
 *
 * Used by the single-employee edit/activate path (an EMPLOYEE-earner tenant). Must run inside
 * the caller's transaction so the create + link are atomic. Per-employee advisory xact lock
 * (held to end of tx) so two concurrent first-time ensures for the SAME employee cannot both
 * pass the check-then-act below and mint TWO accounts / split ownership.
 */
export async function ensureEmployeeAccount(
  tx: Prisma.TransactionClient,
  salesUserId: string,
): Promise<string> {
  const salesUser = await tx.salesUser.findUnique({
    where: { id: salesUserId },
    select: { accountId: true, clientId: true },
  });
  if (!salesUser) {
    throw new Error(`ensureEmployeeAccount: sales user ${salesUserId} not found`);
  }
  if (salesUser.accountId) return salesUser.accountId;

  // Serialize on the SAME tenant-level key the BULK path (ensureEmployeeAccountsForSalesUsers)
  // uses — NOT a per-employee key. A per-employee lock here would hash to a different advisory
  // lock than the bulk path's tenant lock, so a concurrent roster upload + this single-employee
  // ensure would NOT mutually exclude and could each mint an account for the same employee
  // (one orphaned — the split-ownership hole ensureOutletAccount's per-partner lock prevents).
  // Sharing the tenant key makes bulk and single-edit (and any future per-employee credit path)
  // mutually exclusive on account creation.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reward_account:employee:client:${salesUser.clientId}`}, 0))`;

  // Re-check AFTER acquiring the lock: a concurrent holder (e.g. a bulk roster save) may have
  // created + linked this employee's account while we waited. Without this re-read we'd mint a
  // second account for an employee that is now already linked.
  const linked = await tx.salesUser.findUnique({
    where: { id: salesUserId },
    select: { accountId: true },
  });
  if (linked?.accountId) return linked.accountId;

  const account = await tx.rewardAccount.create({
    data: { clientId: salesUser.clientId, accountType: 'EMPLOYEE' },
  });
  await tx.salesUser.update({
    where: { id: salesUserId },
    data: { accountId: account.id },
  });
  return account.id;
}

/**
 * Employee Rewards Phase A — SET-BASED bulk variant of `ensureEmployeeAccount` for the roster
 * upload path (`persistHierarchy`), which can carry thousands of rows. Rather than a per-row
 * advisory lock + create, it:
 *   1. takes ONE tenant-level advisory xact lock (hash of clientId) so two concurrent bulk
 *      roster saves for the same tenant can't both pass the "lacking accountId" check and mint
 *      duplicate accounts;
 *   2. selects, in one query, the supplied SalesUsers that still LACK an accountId (idempotent —
 *      a re-upload finds its employees already linked and creates nothing);
 *   3. `createMany`s one EMPLOYEE RewardAccount per such employee (ids generated up-front so each
 *      new account can be paired back to its employee);
 *   4. links each SalesUser.accountId to its new account (PK updates — no per-row locks).
 *
 * Returns the number of accounts created. Must run inside the caller's transaction.
 *
 * Account ids are generated with `randomUUID()` (node:crypto, zero-dependency) rather than a cuid
 * generator: the id column is an opaque TEXT PK joined by value, so the format is irrelevant and
 * this avoids taking a new/transitive npm dependency just to mint ids.
 */
export async function ensureEmployeeAccountsForSalesUsers(
  tx: Prisma.TransactionClient,
  clientId: string,
  salesUserIds: string[],
): Promise<number> {
  if (salesUserIds.length === 0) return 0;

  // ONE tenant-level lock (NOT per-row) — serialize concurrent bulk roster saves for this tenant.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reward_account:employee:client:${clientId}`}, 0))`;

  // Set-based + idempotent: only the employees in this batch that still have no account.
  const needing = await tx.salesUser.findMany({
    where: { id: { in: salesUserIds }, clientId, accountId: null },
    select: { id: true },
  });
  if (needing.length === 0) return 0;

  const pairs = needing.map((su) => ({ salesUserId: su.id, accountId: randomUUID() }));

  await tx.rewardAccount.createMany({
    data: pairs.map((p) => ({
      id: p.accountId,
      clientId,
      accountType: 'EMPLOYEE' as const,
    })),
  });

  // Link every profile to its freshly-minted account in ONE set-based statement (UPDATE ... FROM
  // VALUES) rather than N sequential per-row updates. The roster upload runs inside
  // saveHierarchyConfig's `$transaction(..., { timeout: 20_000 })` on top of persistHierarchy's
  // own per-row loop; a per-employee link round-trip for a multi-thousand-row roster could blow
  // the tx timeout and roll back EVERYTHING (incl. the hierarchy + the JSON snapshot). One
  // statement keeps the link O(1) round-trips. The `accountId IS NULL` guard is defense-in-depth:
  // the tenant lock above already serialises creators, so every row here is still unlinked.
  const valuesList = Prisma.join(
    pairs.map((p) => Prisma.sql`(${p.salesUserId}::text, ${p.accountId}::text)`),
  );
  await tx.$executeRaw(
    Prisma.sql`UPDATE "sales_users" AS s SET "accountId" = v.acc
               FROM (VALUES ${valuesList}) AS v(id, acc)
               WHERE s.id = v.id AND s."accountId" IS NULL`,
  );

  return pairs.length;
}
