import type { Prisma } from '@prisma/client';
import { isLoyaltyEnabledForPartner } from './loyalty-eligibility';
import {
  PRIMARY_OUTLET_ORDER_BY,
  partnerOutletsWhere,
} from '../partner/partner-display.helper';

/**
 * Per-outlet WALLET ACTIVITY — the single source of truth for "which wallet cards does this
 * outlet get". Shared by the partner's own wallet (GET /v1/partner/me → hasPointsActivity /
 * hasPayoutActivity / loyaltyEnabled / outletType) and the sales outlet ledger
 * (GET /v1/kyc/:id/ledger → meta), so the sales view of an outlet's wallet can never draw a
 * different set of cards than the outlet sees itself (owner-approved, platform-wide, 2026-11-19).
 *
 * Presence-based, never keyed off a single "mode": a partner can hold points AND payouts.
 *   - hasPointsActivity: the partner's Wallet has redeemablePoints > 0 OR lifetimeEarned > 0,
 *     OR any PointsLedger row exists for that wallet.
 *   - hasPayoutActivity: any CreditPayoutEntry (PENDING/PROCESSING/PAID) for one of the partner's
 *     outlets, OR any non-FAILED/REVERSED PayoutTransaction for the partner — the SAME status set
 *     the payout LIST (buildPayoutStatement) surfaces, so the card and the list can never disagree.
 *   - loyaltyEnabled: the per-outlet-type Loyalty gate (defaults true on any missing config).
 *   - outletType: the PRIMARY outlet's OutletType.code.
 *
 * Tenant scope / caller authorization of `partnerId` is the CALLER's responsibility.
 */

type Db = Pick<
  Prisma.TransactionClient,
  | 'outlet'
  | 'outletTypeClientConfig'
  | 'wallet'
  | 'pointsLedger'
  | 'creditPayoutEntry'
  | 'payoutTransaction'
>;

/** The partner's outlets, PRIMARY first — the fields every consumer of the activity needs. */
export const ACTIVITY_OUTLET_SELECT = {
  name: true,
  outletCode: true,
  outletTypeId: true,
  outletType: { select: { code: true } },
  // The partner shell's delivery-address pre-fill reads the SAME primary-outlet row (no extra query).
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  pincode: true,
} satisfies Prisma.OutletSelect;

export type ActivityOutlet = Prisma.OutletGetPayload<{
  select: typeof ACTIVITY_OUTLET_SELECT;
}>;

export interface OutletWalletActivity {
  /** The partner's outlets, PRIMARY first (isPrimary desc, createdAt asc). */
  outlets: ActivityOutlet[];
  outletType: string | null;
  hasPointsActivity: boolean;
  hasPayoutActivity: boolean;
  loyaltyEnabled: boolean;
}

export async function resolveOutletWalletActivity(
  db: Db,
  clientId: string,
  partnerId: string,
): Promise<OutletWalletActivity> {
  // NB: CreditPayoutEntry.outletId stores the outlet CODE (not the Outlet PK) — it is a bare
  // string set from the uploaded "Outlet ID". So the credit-payout scope MUST key on outletCode.
  const outlets = await db.outlet.findMany({
    where: partnerOutletsWhere(clientId, partnerId),
    orderBy: PRIMARY_OUTLET_ORDER_BY,
    select: ACTIVITY_OUTLET_SELECT,
  });
  const outletType = outlets[0]?.outletType?.code ?? null;
  const outletCodes = outlets.map((o) => o.outletCode);

  const loyaltyEnabled = await isLoyaltyEnabledForPartner(
    db,
    clientId,
    partnerId,
  );

  // Wallet reality — the partner's wallet balances + any ledger row.
  const wallet = await db.wallet.findFirst({
    where: { partnerId },
    select: { id: true, redeemablePoints: true, lifetimeEarned: true },
  });
  let hasPointsActivity =
    !!wallet && (wallet.redeemablePoints > 0 || wallet.lifetimeEarned > 0);
  if (!hasPointsActivity && wallet) {
    const ledgerRow = await db.pointsLedger.findFirst({
      where: { walletId: wallet.id },
      select: { id: true },
    });
    hasPointsActivity = !!ledgerRow;
  }

  // Payout reality — either presence flips the flag.
  const [payoutEntry, payoutTxn] = await Promise.all([
    outletCodes.length
      ? db.creditPayoutEntry.findFirst({
          where: {
            clientId,
            outletId: { in: outletCodes },
            status: { in: ['PENDING', 'PROCESSING', 'PAID'] },
          },
          select: { id: true },
        })
      : Promise.resolve(null),
    // Match the LIST rail: a FAILED/REVERSED redemption is hidden from the statement,
    // so it must not flip the card on either (else card shows, list empty).
    db.payoutTransaction.findFirst({
      where: { partnerId, status: { notIn: ['FAILED', 'REVERSED'] } },
      select: { id: true },
    }),
  ]);
  const hasPayoutActivity = !!payoutEntry || !!payoutTxn;

  return {
    outlets,
    outletType,
    hasPointsActivity,
    hasPayoutActivity,
    loyaltyEnabled,
  };
}
