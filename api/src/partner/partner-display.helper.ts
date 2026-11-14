import type { Prisma } from '@prisma/client';
import { resolveActivePartnerId } from '../common/partner-group.helper';

/**
 * Partner-shell DISPLAY identity — single source of truth for "which name does the retailer-app
 * header show". Shared by GET /partner/me (PartnerService.getMe / resolvePartnerActivity) and the
 * OTP-login reply (AuthService.verifyOtp), so the header can paint the outlet name from the very
 * first frame after login instead of flashing the PERSON's name (user.name) until /partner/me
 * resolves (owner-approved, platform-wide).
 */

/**
 * The PRIMARY-outlet selection rule. Order by isPrimary desc then createdAt asc and take the first —
 * do NOT filter isPrimary:true (real outlets that never set the flag would return nothing).
 */
export const PRIMARY_OUTLET_ORDER_BY = [
  { isPrimary: 'desc' },
  { createdAt: 'asc' },
] satisfies Prisma.OutletOrderByWithRelationInput[];

/** The partner's outlets eligible for the primary-outlet pick (tenant-scoped, non-deleted). */
export function partnerOutletsWhere(clientId: string, partnerId: string): Prisma.OutletWhereInput {
  return { clientId, partnerId, deletedAt: null };
}

/** The header's outlet name = the primary outlet's MASTER name (Outlet.name); null when none. */
export function pickPrimaryOutletName(outlets: { name: string | null }[]): string | null {
  return outlets[0]?.name ?? null;
}

type Db = Pick<Prisma.TransactionClient, 'channelPartner' | 'outlet'>;

/**
 * The login roles that can own a ChannelPartner / reach the partner shell — mirrors the FE
 * `PORTAL_ROLES.partner` and the backend's existing PARTNER_ROLES lists. Used to skip the
 * display lookup entirely for sales/admin/Gifsy/vendor logins.
 */
export const PARTNER_LOGIN_ROLES: readonly string[] = ['SSS', 'WHOLESALER', 'SUB_STOCKIST'];

export function isPartnerLoginRole(role: string | null | undefined): boolean {
  return !!role && PARTNER_LOGIN_ROLES.includes(role);
}

export interface PartnerDisplayIdentity {
  /** ChannelPartner.businessName — the FE header's fallback when outletName is null. */
  businessName: string | null;
  /** The primary outlet's MASTER name (Outlet.name) — what /partner/me returns as outletName. */
  outletName: string | null;
}

/**
 * Resolve the display identity of the login's DEFAULT (own) outlet — exactly what GET /partner/me
 * returns as businessName/outletName when no `active_partner_id` selector is sent (the selector
 * cookie is cleared at login). Returns null when the login has no channel partner (sales/admin/
 * vendor logins, parent-only phones), so non-partner logins are unchanged.
 */
export async function resolveLoginPartnerDisplay(
  db: Db,
  params: { clientId: string; userSub: string; phone: string | null },
): Promise<PartnerDisplayIdentity | null> {
  const { partnerId } = await resolveActivePartnerId(db, { ...params, requestedPartnerId: null });
  if (!partnerId) return null;

  const [partner, outlets] = await Promise.all([
    db.channelPartner.findFirst({
      where: { id: partnerId, clientId: params.clientId },
      select: { businessName: true },
    }),
    db.outlet.findMany({
      where: partnerOutletsWhere(params.clientId, partnerId),
      orderBy: PRIMARY_OUTLET_ORDER_BY,
      select: { name: true },
      take: 1,
    }),
  ]);
  if (!partner) return null;
  return { businessName: partner.businessName ?? null, outletName: pickPrimaryOutletName(outlets) };
}
