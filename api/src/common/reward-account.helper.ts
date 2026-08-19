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
