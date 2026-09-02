import type { Prisma } from '@prisma/client';

/**
 * Per-outlet-type Loyalty (Rewards) eligibility.
 *
 * A tenant governs whether the Rewards catalogue/redeem is available PER OUTLET TYPE via
 * `OutletTypeClientConfig.loyaltyEnabled` (keyed by (clientId, outletTypeId), schema default `true`).
 * This is the single source of truth used by BOTH the `/partner/me` `loyaltyEnabled` signal (the FE
 * gate) and the server-side rewards enforcement (defense-in-depth — the FE gate is bypassable via a
 * direct API call).
 *
 * NEVER hide on a missing config: when there is no `OutletTypeClientConfig` row for the (clientId,
 * outletTypeId) pair — or the partner has no outlet / the outlet has no type — the result is `true`,
 * matching the schema default. Only an EXPLICIT `loyaltyEnabled = false` row turns Loyalty off.
 */

/**
 * Any Prisma client (the PrismaService or a `$transaction` client) exposing the two models this
 * helper reads. Mirrors the `Db` pattern in partner-group.helper so the helper can be called with
 * either the PrismaService or a tx client.
 */
type Db = Pick<Prisma.TransactionClient, 'outlet' | 'outletTypeClientConfig'>;

/**
 * Is Loyalty (Rewards) enabled for a partner's PRIMARY outlet type?
 *
 * Resolves the partner's PRIMARY outlet (isPrimary desc, then oldest — the codebase's primary-outlet
 * convention; do NOT filter isPrimary:true, which is empty for real outlets that never set the flag),
 * reads that outlet type's `loyaltyEnabled` config, and defaults to `true` on any missing piece.
 */
export async function isLoyaltyEnabledForPartner(
  db: Db,
  clientId: string,
  partnerId: string,
): Promise<boolean> {
  const outlet = await db.outlet.findFirst({
    where: { clientId, partnerId, deletedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: { outletTypeId: true },
  });
  const outletTypeId = outlet?.outletTypeId;
  if (!outletTypeId) return true; // no outlet / type → schema default (never hide on missing)

  const cfg = await db.outletTypeClientConfig.findUnique({
    where: { clientId_outletTypeId: { clientId, outletTypeId } },
    select: { loyaltyEnabled: true },
  });
  return cfg?.loyaltyEnabled ?? true; // no config row → schema default true
}
