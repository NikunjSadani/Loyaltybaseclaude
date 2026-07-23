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

/**
 * Whether a field is enforced unique. PAN AND GST are ALWAYS enforced — both are backed by a
 * hard partial-unique DB index (`WHERE groupId IS NULL`), so the tenant `gst` policy flag can't
 * turn GST off (the app check MUST agree with the DB index, else a policy-off tenant would let
 * the app skip GST while the DB still rejects it — a raw 500 / silent cross-group dup). Bank/UPI
 * have no DB index and remain tenant-configurable. (`policy.gst` is now informational only.)
 */
export function isFieldEnforced(field: UniquenessField, policy: UniquenessPolicy): boolean {
  if (field === 'pan' || field === 'gst') return true; // always-on DB-backed golden keys
  return policy[field] === true;
}

/**
 * Canonical form used for comparison, advisory-locking, AND persistence — the three MUST agree
 * or a whitespace/case variant can slip a duplicate past the check (audit finding). PAN and GST
 * are case-insensitive legal IDs → upper-cased; bank/UPI are trimmed only. Empty → null.
 * The caller (kyc.service) persists this exact value, so a stored value always equals its
 * normalized form and the equality query below matches.
 */
export function normalizeIdentityValue(
  field: UniquenessField,
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') return value ?? null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return field === 'pan' || field === 'gst' ? trimmed.toUpperCase() : trimmed;
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
  if (parent?.panNumber) return normalizeIdentityValue('pan', parent.panNumber);

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
  return normalizeIdentityValue('pan', sibling?.partner?.panNumber);
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
  const value = normalizeIdentityValue('pan', pan);
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
    const value = normalizeIdentityValue(field, details[column]);
    if (!value) continue; // nothing to check for an empty value

    // Include PARENTS in the clash search — a parent MAY carry its own GST/PAN/bank/UPI, and
    // bank/UPI have NO DB index, so excluding parents would let a parent + an unrelated outlet
    // silently share a tenant-enforced bank/UPI. A parent anchors its OWN group (id = the parentId
    // its children point at), so its group-membership is `[cand.id]`, not its (empty) owned outlets.
    const where: Record<string, unknown> = { clientId, [column]: value, deletedAt: null };
    if (exceptPartnerId) where.id = { not: exceptPartnerId };

    const candidates = await db.channelPartner.findMany({
      where: where as Prisma.ChannelPartnerWhereInput,
      select: { id: true, isParent: true, outlets: { select: { parentId: true } } },
    });

    for (const cand of candidates) {
      const candGroupIds = cand.isParent ? [cand.id] : cand.outlets.map((o) => o.parentId);
      if (!clashIsOutsideGroup(ourParentId, candGroupIds)) continue; // same-group clash is allowed

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

/**
 * Serialize concurrent writers of the SAME identity value so the read-then-write in
 * `checkGroupUniqueness` can't race. Takes a transaction-scoped Postgres advisory lock per
 * enforced (clientId, field, value) — auto-released when the tx commits/rolls back (never orphaned).
 *
 * MUST be called INSIDE the same interactive `$transaction` as the uniqueness check + the write,
 * BEFORE `checkGroupUniqueness`. Two txns writing the same value take turns: the first commits its
 * row, the second re-runs its check, sees it, and is rejected. For PAN/GST this backstops the
 * partial-unique DB index (belt-and-suspenders); for bank/UPI (no DB rule) it is the ONLY race guard.
 *
 * Keys are locked in deterministic (sorted) order so two txns locking multiple fields can't deadlock.
 */
export async function acquireIdentityLocks(
  tx: Prisma.TransactionClient,
  params: { clientId: string; details: PartnerIdentityDetails; policy: UniquenessPolicy },
): Promise<void> {
  const { clientId, details, policy } = params;
  const keys: string[] = [];
  for (const field of ['pan', 'gst', 'bank', 'upi'] as UniquenessField[]) {
    if (!isFieldEnforced(field, policy)) continue;
    const value = normalizeIdentityValue(field, details[FIELD_COLUMN[field]]);
    if (!value) continue;
    keys.push(`${clientId}:${field}:${value}`);
  }
  keys.sort(); // stable lock order → no deadlock between concurrent multi-field writers
  for (const key of keys) {
    // hashtext → int4 → widened to the bigint pg_advisory_xact_lock expects. A hash collision only
    // means two unrelated values occasionally share a lock (a harmless extra serialization).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
  }
}
