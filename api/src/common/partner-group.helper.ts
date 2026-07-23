import type { Prisma } from '@prisma/client';

/**
 * Partner-child owner GROUP resolution + identity-detail UNIQUENESS.
 *
 * The shared contract for parent-child owner groups (docs/plans/PARTNER-MULTI-OUTLET.md).
 * Streams A/B call this from every KYC/upload write path. The uniqueness checks return a
 * violation object rather than throwing, so the calling service turns a non-null result
 * into a `BadRequestException` (keeps this module Nest-free + easy to test).
 *
 * MODEL RECAP
 *   - A group = all outlets sharing one `Outlet.parentId` (a PARENT ChannelPartner id).
 *     Ungrouped outlet → `parentId = null` → a group of one.
 *   - PAN is the group's golden key: **identical within a group, absent outside it** — one
 *     PAN belongs to at most one group. (Always enforced; not tenant-configurable.)
 *   - GST / bank / UPI: **unique-except-within-group** — may repeat among a group's members
 *     but must be distinct from every outlet outside the group. Enforced per tenant policy.
 *   - PHONE is enforced by the (group-aware) `assertPhoneAvailable` in kyc.service, NOT here:
 *     it needs last-10-digit normalisation AND interacts with `User @@unique([clientId,phone])`
 *     (a group's shared phone maps to ONE login; siblings sharing it are login-less and
 *     reached via that login's picker). Stream A/D own that; this helper covers the
 *     exact-match identity fields (GST/PAN/bank/UPI).
 */

/** Tenant-configurable uniqueness policy — which exact-match fields are enforced. */
export interface UniquenessPolicy {
  gst: boolean;
  phone: boolean;
  bank: boolean;
  upi: boolean;
}

/** The candidate detail values being validated for one outlet's owner. */
export interface PartnerIdentityDetails {
  gstNumber?: string | null;
  panNumber?: string | null;
  bankAccountNumber?: string | null;
  upiId?: string | null;
}

export type UniquenessField = 'gst' | 'pan' | 'bank' | 'upi';

export interface UniquenessViolation {
  field: UniquenessField;
  reason: 'duplicate-outside-group' | 'pan-group-mismatch';
  message: string;
}

/** The ChannelPartner column each field maps to. */
export const FIELD_COLUMN: Record<UniquenessField, keyof PartnerIdentityDetails> = {
  gst: 'gstNumber',
  pan: 'panNumber',
  bank: 'bankAccountNumber',
  upi: 'upiId',
};

const FIELD_LABEL: Record<UniquenessField, string> = {
  gst: 'GST number',
  pan: 'PAN',
  bank: 'bank account number',
  upi: 'UPI ID',
};

/** Any Prisma client (PrismaService or a $transaction client) exposes these two models. */
type Db = Pick<Prisma.TransactionClient, 'channelPartner' | 'outlet'>;

// ── PURE predicates (unit-tested; no DB) ─────────────────────────────────────────────────

/** Whether a policy-gated field is enforced (PAN is always enforced, ignores policy). */
export function isFieldEnforced(field: UniquenessField, policy: UniquenessPolicy): boolean {
  if (field === 'pan') return true; // PAN is always the group golden-key
  return policy[field] === true;
}

/**
 * Given the group of the outlet under validation and the group(s) a clashing partner's
 * outlets belong to, decide whether the clash is a violation. A clash is allowed ONLY when
 * the outlet under validation is grouped (parentId non-null) AND the clashing partner has
 * an outlet in that SAME group.
 */
export function clashIsOutsideGroup(
  ourParentId: string | null,
  clashingPartnerOutletParentIds: (string | null)[],
): boolean {
  if (ourParentId == null) return true; // we're ungrouped → any clash is outside
  return !clashingPartnerOutletParentIds.some((pid) => pid === ourParentId);
}

// ── DB-backed resolution + checks ────────────────────────────────────────────────────────

/** Resolve the group (parentId) of an outlet. Ungrouped → null. */
export async function resolveOutletParentId(db: Db, clientId: string, outletId: string): Promise<string | null> {
  const row = await db.outlet.findFirst({ where: { id: outletId, clientId }, select: { parentId: true } });
  return row?.parentId ?? null;
}

/**
 * The group's canonical PAN: the parent's PAN if set, else any grouped sibling's PAN.
 * Returns null when the group has no PAN on record yet (the first member sets it).
 */
export async function resolveGroupPan(
  db: Db,
  clientId: string,
  parentId: string,
  exceptPartnerId?: string | null,
): Promise<string | null> {
  const parent = await db.channelPartner.findUnique({ where: { id: parentId }, select: { panNumber: true } });
  if (parent?.panNumber) return parent.panNumber.trim();

  const sibling = await db.outlet.findFirst({
    where: {
      clientId,
      parentId,
      deletedAt: null,
      partner: {
        isParent: false,
        deletedAt: null,
        panNumber: { not: null },
        ...(exceptPartnerId ? { id: { not: exceptPartnerId } } : {}),
      },
    },
    select: { partner: { select: { panNumber: true } } },
  });
  return sibling?.partner?.panNumber?.trim() ?? null;
}

/**
 * Enforce that a grouped outlet's PAN equals the group's canonical PAN (identical-within-group).
 * No-op when ungrouped, when no PAN is supplied, or when the group has no PAN yet.
 */
export async function checkPanMatchesGroup(
  db: Db,
  params: { clientId: string; ourParentId: string | null; pan?: string | null; exceptPartnerId?: string | null },
): Promise<UniquenessViolation | null> {
  const { clientId, ourParentId, pan, exceptPartnerId } = params;
  if (ourParentId == null) return null; // ungrouped → no group PAN to match
  const value = typeof pan === 'string' ? pan.trim() : pan;
  if (!value) return null; // no PAN yet → nothing to match
  const groupPan = await resolveGroupPan(db, clientId, ourParentId, exceptPartnerId);
  if (groupPan && groupPan !== value) {
    return {
      field: 'pan',
      reason: 'pan-group-mismatch',
      message: `This group already uses PAN ${groupPan}. Every outlet in a group must share the same PAN.`,
    };
  }
  return null;
}

/**
 * Check exact-match identity uniqueness for one outlet's owner details against its group.
 * Returns the FIRST violation found, or null if clean. Covers PAN (identical-within-group,
 * absent-outside) + GST/bank/UPI (unique-except-within-group, per policy).
 *
 * @param ourParentId     the group of the outlet under validation (null = ungrouped)
 * @param exceptPartnerId the partner being updated (re-KYC) — excluded from the clash search
 */
export async function checkGroupUniqueness(
  db: Db,
  params: {
    clientId: string;
    ourParentId: string | null;
    details: PartnerIdentityDetails;
    policy: UniquenessPolicy;
    exceptPartnerId?: string | null;
  },
): Promise<UniquenessViolation | null> {
  const { clientId, ourParentId, details, policy, exceptPartnerId } = params;

  // PAN must also MATCH the group's canonical PAN (checkGroupUniqueness below only proves
  // no same-PAN outlet exists OUTSIDE the group; this proves ours equals the group's).
  const panMatch = await checkPanMatchesGroup(db, { clientId, ourParentId, pan: details.panNumber, exceptPartnerId });
  if (panMatch) return panMatch;

  for (const field of ['pan', 'gst', 'bank', 'upi'] as UniquenessField[]) {
    if (!isFieldEnforced(field, policy)) continue;
    const column = FIELD_COLUMN[field];
    const rawValue = details[column];
    const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
    if (!value) continue; // nothing to check for an empty value

    const where: Record<string, unknown> = { clientId, [column]: value, isParent: false, deletedAt: null };
    if (exceptPartnerId) where.id = { not: exceptPartnerId };

    const candidates = await db.channelPartner.findMany({
      where: where as Prisma.ChannelPartnerWhereInput,
      select: { id: true, outlets: { select: { parentId: true } } },
    });

    for (const cand of candidates) {
      const candParentIds = cand.outlets.map((o) => o.parentId);
      if (!clashIsOutsideGroup(ourParentId, candParentIds)) continue; // same-group clash is allowed

      const message =
        field === 'pan'
          ? ourParentId == null
            ? `This ${FIELD_LABEL.pan} is already registered to another outlet. Group them under one parent to share a PAN.`
            : `This ${FIELD_LABEL.pan} belongs to an outlet outside this group. A group shares exactly one PAN.`
          : `This ${FIELD_LABEL[field]} is already registered to another outlet outside this group.`;
      return {
        field,
        reason: field === 'pan' && ourParentId != null ? 'pan-group-mismatch' : 'duplicate-outside-group',
        message,
      };
    }
  }

  return null;
}
