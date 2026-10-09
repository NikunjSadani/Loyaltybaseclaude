import { Prisma } from '@prisma/client';

/**
 * Employee Rewards Phase B — the tenant-scope `where` fragment for ANY RedemptionOrder read that must
 * span BOTH owner shapes of an order:
 *   - a TRADE order (partner set; tenant via `partner.clientId`), and
 *   - an ACCOUNT-FIRST employee order (partnerId null; tenant via `account.clientId → RewardAccount.clientId`).
 *
 *   scope undefined (platform-wide, un-assumed OWNER) → {}  (all tenants).
 *   scope set (assumed operator / CLIENT_ADMIN / a vendor pinned to its tenant, or an OWNER narrowing
 *     to one clientId) → match EITHER arm:
 *       { OR: [ { partner: { clientId: scope } }, { account: { clientId: scope } } ] }
 *
 * TRADE-SAFETY (why the account arm never widens cross-tenant): a trade order's `account.clientId`
 * EQUALS its `partner.clientId` — both are written from the partner's clientId at order-create
 * (`ensureOutletAccount` creates the account with `partner.clientId`), and clientId is immutable on
 * both ChannelPartner and RewardAccount. So the account arm is a SAME-TENANT superset of the partner
 * arm for trade orders; it only ADDS null-partner employee orders of the SAME tenant. A legacy trade
 * order with `accountId: null` still matches through the `partner` arm — never dropped.
 *
 * COMPOSITION: returns a top-level `OR`, so a caller whose `where` already carries its OWN top-level
 * `OR` must compose this under `AND` rather than spreading it (it would otherwise clobber the other
 * `OR`). All current callers spread it alongside scalar equality filters only (id / orderNumber /
 * fulfilledByVendorId / status / channel / createdAt), which Prisma ANDs with this `OR`.
 */
export function orderTenantScopeWhere(scope: string | undefined): Prisma.RedemptionOrderWhereInput {
  return scope
    ? { OR: [{ partner: { clientId: scope } }, { account: { clientId: scope } }] }
    : {};
}
