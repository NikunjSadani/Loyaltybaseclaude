import type { Prisma } from '@prisma/client';

/**
 * Per-outlet-type "Sales-Assisted Redemption" eligibility — whether a sales rep may redeem
 * on behalf of an outlet ("Redeem for Outlet").
 *
 * Governed PER OUTLET TYPE via `OutletTypeClientConfig.salesAssistedRedeemEnabled`
 * (keyed by (clientId, outletTypeId)). This is the single source of truth used by BOTH the
 * sales "Redeem for Outlet" button (via the KYC-detail effective flag) and the server-side
 * enforcement in `redeemForOutlet` / `confirmRedeemForOutlet` (defense-in-depth — the FE gate
 * is bypassable via a direct API call).
 *
 * The column is NULLABLE so "unset" is distinct from "explicitly off":
 *   - explicit true/false  → use it.
 *   - unset (null) / no row → PRESERVE-TODAY default: enabled only for the WHOLESALER type
 *     (the platform's prior "wholesalers only" behaviour), off for every other type.
 * This keeps every existing tenant (incl. live Deoleo) behaving exactly as before with no data
 * backfill; a Gifsy admin then turns individual types on/off in Outlet Type Configuration.
 *
 * Nothing is hardcoded to a role: the WHOLESALER reference is only the DEFAULT for a type whose
 * flag has never been set — an explicit per-type setting always wins.
 */

/** Any Prisma client (PrismaService or a `$transaction` client) exposing the two models read. */
type Db = Pick<Prisma.TransactionClient, 'outlet' | 'outletTypeClientConfig'>;

export async function isSalesRedeemEnabledForPartner(
  db: Db,
  clientId: string,
  partnerId: string,
): Promise<boolean> {
  // Resolve the partner's PRIMARY outlet (isPrimary desc, then oldest — codebase convention;
  // do NOT filter isPrimary:true, which is empty for real outlets that never set the flag).
  const outlet = await db.outlet.findFirst({
    where: { clientId, partnerId, deletedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: { outletTypeId: true, outletType: { select: { code: true } } },
  });
  const outletTypeId = outlet?.outletTypeId;
  // No outlet / no type → cannot establish an eligible type → conservative OFF for a money path.
  if (!outletTypeId) return false;

  const cfg = await db.outletTypeClientConfig.findUnique({
    where: { clientId_outletTypeId: { clientId, outletTypeId } },
    select: { salesAssistedRedeemEnabled: true },
  });
  // Explicit per-type setting wins.
  if (cfg?.salesAssistedRedeemEnabled != null) return cfg.salesAssistedRedeemEnabled;
  // Unset → preserve-today default (wholesalers only).
  return outlet?.outletType?.code === 'WHOLESALER';
}
