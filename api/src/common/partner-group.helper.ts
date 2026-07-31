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

/**
 * Today's-behaviour default owner-group uniqueness policy (which of GST/phone/bank/UPI are
 * enforced across groups; PAN is always on inside the share-check). Single source of truth so the
 * un-group guard, the add-to-parent check, and the `canUngroup` flag can never desync on a partial
 * settings object. */
export const DEFAULT_UNIQUENESS_POLICY: UniquenessPolicy = { gst: true, phone: true, bank: false, upi: false };

/** Resolve a tenant's uniqueness policy from its effective settings, falling back to the default. */
export function resolveUniquenessPolicy(settings: {
  uniquenessPolicy?: UniquenessPolicy | null;
}): UniquenessPolicy {
  return settings.uniquenessPolicy ?? DEFAULT_UNIQUENESS_POLICY;
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

/** The shared owner-identity block a grouped child's KYC pre-fills from (never photos/address). */
export interface GroupIdentity {
  businessName: string | null;
  ownerName: string | null;
  gstNumber: string | null;
  panNumber: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankAccountHolder: string | null;
  ifscCode: string | null;
  upiId: string | null;
  /**
   * The APPROVED group member (parent or sibling ChannelPartner) this identity was resolved from —
   * the SAME source used for DOCUMENT carry-forward (resolveGroupCarryForwardDocs). Null only when
   * nothing verified exists yet (identity itself would then be null too). Never trust it as a document
   * grant on its own: the carry-forward always re-checks that the child kept the value unchanged.
   */
  sourcePartnerId: string | null;
}

/**
 * The group's canonical owner-identity — what a grouped child's KYC pre-fills (business/owner
 * name, GST, PAN, bank, UPI). Source precedence (owner decision):
 *   1. the PARENT's own details, but ONLY when the parent is APPROVED (`onboardedAt` set) AND
 *      actually carries identity details (an un-approved / bare-anchor parent has unverified /
 *      no values → never pre-fills);
 *   2. else the most-recently-APPROVED grouped SIBLING (a non-parent partner with an outlet in
 *      this group whose KYC is approved) — so the first child establishes the shared identity
 *      and the rest inherit it;
 *   3. else null (nothing verified yet → the child enters its own details).
 * Returns identity TEXT only — store/owner photos, address and location are ALWAYS captured
 * per-store and are never part of this block.
 */
export async function resolveGroupIdentity(
  db: Db,
  clientId: string,
  parentId: string,
): Promise<GroupIdentity | null> {
  // clientId on the parent read is defense-in-depth (parentId is already a same-tenant Outlet.parentId).
  const parent = await db.channelPartner.findFirst({
    where: { id: parentId, clientId },
    select: {
      onboardedAt: true, businessName: true, ownerName: true, gstNumber: true, panNumber: true,
      bankName: true, bankAccountNumber: true, bankAccountHolder: true, ifscCode: true, upiId: true,
    },
  });
  const parentHasDetails = !!(
    parent && (parent.panNumber || parent.gstNumber || parent.bankAccountNumber || parent.upiId)
  );
  // A PARENT's approval marker IS ChannelPartner.onboardedAt (set by ParentsService at approval).
  if (parent && parent.onboardedAt != null && parentHasDetails) {
    return pickGroupIdentity(parent, parentId);
  }

  // Approved SIBLING: a non-parent partner with an outlet in this group whose KYC is APPROVED.
  // ⚠️ An outlet-owner's approval is its KYC status = APPROVED — NOT ChannelPartner.onboardedAt,
  // which is a PARENT-ONLY marker and is NEVER written for an outlet owner (kyc.service approves an
  // outlet by activating it + KycSubmission.status=APPROVED, and never touches onboardedAt). Gating on
  // onboardedAt here would match zero rows in prod (the sibling branch would be dead). Also require the
  // sibling to actually carry identity details, so an approved-but-empty sibling never pre-fills blanks.
  const sibling = await db.channelPartner.findFirst({
    where: {
      clientId,
      isParent: false,
      deletedAt: null,
      kycSubmissions: { some: { status: 'APPROVED' } },
      outlets: { some: { parentId, clientId, deletedAt: null } },
      OR: [
        { panNumber: { not: null } },
        { gstNumber: { not: null } },
        { bankAccountNumber: { not: null } },
        { upiId: { not: null } },
      ],
    },
    // Most-recently-updated approved sibling wins (approval bumps the partner row); ties are low-impact
    // — every pre-filled field except PAN is editable on the child's form.
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      businessName: true, ownerName: true, gstNumber: true, panNumber: true,
      bankName: true, bankAccountNumber: true, bankAccountHolder: true, ifscCode: true, upiId: true,
    },
  });
  return sibling ? pickGroupIdentity(sibling, sibling.id) : null;
}

/** Project a partner row onto the GroupIdentity shape (identity text only) + its source partner id. */
function pickGroupIdentity(p: Partial<GroupIdentity>, sourcePartnerId: string): GroupIdentity {
  return {
    businessName: p.businessName ?? null,
    ownerName: p.ownerName ?? null,
    gstNumber: p.gstNumber ?? null,
    panNumber: p.panNumber ?? null,
    bankName: p.bankName ?? null,
    bankAccountNumber: p.bankAccountNumber ?? null,
    bankAccountHolder: p.bankAccountHolder ?? null,
    ifscCode: p.ifscCode ?? null,
    upiId: p.upiId ?? null,
    sourcePartnerId,
  };
}

/** A carry-forwardable document from the group source's APPROVED submission (verified provenance). */
export interface CarryForwardDoc {
  fileUrl: string;
  fileKey: string;
  fileName: string | null;
  mimeType: string | null;
  fileSizeBytes: number | null;
}

/** The group source's approved GST certificate + cancelled cheque, for child carry-forward. */
export interface GroupCarryForwardDocs {
  gstCertificate: CarryForwardDoc | null;
  cancelledCheque: CarryForwardDoc | null;
}

/** A Prisma client exposing the KycSubmission model (for the document carry-forward read). */
type DbWithKyc = Pick<Prisma.TransactionClient, 'kycSubmission'>;

/**
 * Load the group SOURCE partner's APPROVED GST-certificate + cancelled-cheque documents — the docs a
 * grouped child inherits when it keeps the group's (unchanged) GST number / bank account. The
 * `sourcePartnerId` MUST come from `resolveGroupIdentity(...).sourcePartnerId`, so the DOCUMENT source
 * is exactly the same APPROVED parent/sibling the IDENTITY prefill came from (they can never diverge).
 *
 * Only reads the source's most-recent APPROVED submission (verified provenance); a non-approved or
 * doc-less source yields nulls → the child must upload its own (fail-safe). Tenant-scoped defense-in-
 * depth via the submission's user.clientId. Returns the newest doc per type.
 */
export async function resolveGroupCarryForwardDocs(
  db: DbWithKyc,
  clientId: string,
  sourcePartnerId: string,
): Promise<GroupCarryForwardDocs> {
  const sub = await db.kycSubmission.findFirst({
    where: { partnerId: sourcePartnerId, status: 'APPROVED', user: { clientId } },
    orderBy: { updatedAt: 'desc' },
    select: {
      documents: {
        where: { documentType: { in: ['GST_CERTIFICATE', 'CANCELLED_CHEQUE'] } },
        orderBy: { createdAt: 'desc' },
        select: { documentType: true, fileUrl: true, fileKey: true, fileName: true, mimeType: true, fileSizeBytes: true },
      },
    },
  });
  const pick = (type: 'GST_CERTIFICATE' | 'CANCELLED_CHEQUE'): CarryForwardDoc | null => {
    const d = sub?.documents.find((x) => x.documentType === type);
    return d ? { fileUrl: d.fileUrl, fileKey: d.fileKey, fileName: d.fileName, mimeType: d.mimeType, fileSizeBytes: d.fileSizeBytes } : null;
  };
  return { gstCertificate: pick('GST_CERTIFICATE'), cancelledCheque: pick('CANCELLED_CHEQUE') };
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

// ── Un-group SHARE check (the un-group guard ⇔ the group-detail canUngroup flag) ────────────

/** The identity columns of one group member (parent or a sibling's owner) the share-check reads. */
export interface GroupMemberDetails {
  phone: string | null;
  panNumber: string | null;
  gstNumber: string | null;
  bankAccountNumber: string | null;
  upiId: string | null;
}

/** The child outlet's own owner details under an un-group check (carries the partner id). */
export interface ChildOwnerDetails extends GroupMemberDetails {
  id: string;
}

/**
 * Un-group guard (docs/plans/PARTNER-MULTI-OUTLET.md §4.5): does the child still share ANY
 * enforced identity detail with a REMAINING member of its owner group (the parent itself + its
 * sibling child outlets)? PAN is always checked (the group golden key); GST/bank/UPI/PHONE only
 * when the tenant policy enforces them. Exact-match fields (PAN/GST/bank/UPI) compare on the
 * CANONICAL value (PAN/GST upper-cased) so a case-variant share is not under-detected; PHONE
 * compares on last-10-digit normalisation, since phones are stored in varying formats. A pre-KYC
 * child (no owner yet) has no details → shares nothing → un-map is allowed. Bounded reads (2 queries).
 *
 * SHARED so the dedicated un-group action (AdminOutletsService.ungroupOutlet) and the group-detail
 * endpoint's `canUngroup` flag (ParentsService.getParent) are the SAME code path and can never diverge:
 * `canUngroup` is exactly `!childSharesDetailWithGroup(...)`.
 */
export async function childSharesDetailWithGroup(
  db: Db,
  params: {
    clientId: string;
    parentId: string;
    childOutletId: string;
    childPartner: ChildOwnerDetails | null;
    policy: UniquenessPolicy;
  },
): Promise<boolean> {
  const { clientId, parentId, childOutletId, childPartner, policy } = params;
  if (!childPartner) return false; // no owner details to share

  const memberSelect = {
    phone: true,
    panNumber: true,
    gstNumber: true,
    bankAccountNumber: true,
    upiId: true,
  } as const;
  const parent = await db.channelPartner.findUnique({
    where: { id: parentId },
    select: memberSelect,
  });
  const siblingOutlets = await db.outlet.findMany({
    where: {
      clientId,
      parentId,
      id: { not: childOutletId },
      deletedAt: null,
      // Exclude by the child's PARTNER too, not just the child OUTLET: if the child's own
      // ChannelPartner owns a SECOND outlet in this group, that outlet would otherwise load as a
      // "sibling" and self-match on every field → wrongly BLOCK the un-group.
      partner: { isParent: false, deletedAt: null, id: { not: childPartner.id } },
    },
    select: { partner: { select: memberSelect } },
  });

  const members = [parent, ...siblingOutlets.map((s) => s.partner)].filter(
    (m): m is NonNullable<typeof m> => m != null,
  );

  // Exact-match identity fields — compare on the CANONICAL value (PAN/GST upper-cased) so a
  // case-variant share is not under-detected (which would wrongly allow the un-group).
  const fields: { field: UniquenessField; key: keyof PartnerIdentityDetails; enforced: boolean }[] = [
    { field: 'pan', key: 'panNumber', enforced: true }, // PAN is always the group golden-key
    { field: 'gst', key: 'gstNumber', enforced: policy.gst },
    { field: 'bank', key: 'bankAccountNumber', enforced: policy.bank },
    { field: 'upi', key: 'upiId', enforced: policy.upi },
  ];
  for (const f of fields) {
    if (!f.enforced) continue;
    const childValue = normalizeIdentityValue(f.field, childPartner[f.key]);
    if (!childValue) continue;
    for (const m of members) {
      const memberValue = normalizeIdentityValue(f.field, m[f.key]);
      if (memberValue && memberValue === childValue) return true;
    }
  }

  // PHONE (F4) — enforced per policy, compared on last-10 digits (format-insensitive).
  if (policy.phone) {
    const childPhone = normalizePhoneLast10(childPartner.phone);
    if (childPhone) {
      for (const m of members) {
        if (normalizePhoneLast10(m.phone) === childPhone) return true; // both non-empty & equal
      }
    }
  }

  return false;
}

// ── Wave 3: operable-context resolution (login picker + read-only parent overview) ──────────
//
// The login model: a phone → ONE `User` (`@@unique([clientId, phone])`) → ONE own `ChannelPartner`
// (`userId=user.sub`). A person who runs several shops holds a SEPARATE ChannelPartner per shop; only
// one carries the login, the rest are LOGIN-LESS siblings (`userId=null`) in the SAME group, reached
// via this login's picker. A PARENT is a login-less `isParent=true` owner whose phone may match the
// login → grants a read-only "Group Overview" across all its children.
//
// SECURITY INVARIANT (audited): the "operable set" is the ONLY authority for which partner a request
// may act on. Every partner-self-resolution site MUST resolve its target partner through
// `resolveActivePartnerId` (never trust a client-supplied partner id blind). Absent selector → the
// login's OWN partner (today's single-outlet behaviour, unchanged, zero extra query on the hot path).
//
// Why operable siblings are constrained to SAME-GROUP **and** SAME-PHONE (not bare phone-match):
// phone-uniqueness is only enforced when the tenant policy has it on, so two *ungrouped* outlets could
// share a phone under a policy-off tenant and must NEVER be merged into one login. Grouping is the
// mechanism that legitimately allows a shared phone, so operability ⟹ same group. An ungrouped login
// therefore has exactly one operable context (itself) regardless of policy.

/** Last-10-digit phone key — mirrors kyc.service.phoneLast10 (the one match/uniqueness normalization).
 *  Returns null unless exactly 10 digits remain, so we never match on an empty/garbage `endsWith`. */
export function normalizePhoneLast10(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '').slice(-10);
  return digits.length === 10 ? digits : null;
}

export interface OperablePartner {
  partnerId: string;
  outletId: string | null;
  outletCode: string | null;
  businessName: string | null;
  ownerName: string | null;
  isOwnLogin: boolean; // true = the login's own partner (userId = user.sub)
}

export interface GroupParentRef {
  parentId: string;
  businessName: string | null;
  ownerName: string | null;
}

export interface OperableContexts {
  ownPartnerId: string | null;
  /** All partners this login may operate (own + login-less same-group same-phone siblings). Own-first. */
  operable: OperablePartner[];
  /** Read-only group overview target, when this login's phone is a parent's phone. */
  groupParent: GroupParentRef | null;
}

/** Only an active (approved+active) outlet is operable — a representative outlet for display. */
const OPERABLE_OUTLET_SELECT = {
  where: { isActive: true, deletedAt: null },
  select: { id: true, outletCode: true, name: true, isPrimary: true, createdAt: true },
  orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  take: 1,
} satisfies Prisma.ChannelPartner$outletsArgs;

function pickOutlet(outlets: { id: string; outletCode: string | null; name: string | null }[] | undefined) {
  const o = outlets?.[0];
  return { outletId: o?.id ?? null, outletCode: o?.outletCode ?? null };
}

/**
 * Resolve everything a login can touch — the picker payload for `/partner/me`.
 * `phone` is the login's JWT phone (authoritative); `userSub` its user id.
 */
export async function resolveOperableContexts(
  db: Db,
  params: { clientId: string; userSub: string; phone: string | null },
): Promise<OperableContexts> {
  const { clientId, userSub, phone } = params;
  const last10 = normalizePhoneLast10(phone);

  const own = await db.channelPartner.findFirst({
    where: { userId: userSub, clientId, deletedAt: null },
    select: {
      id: true,
      businessName: true,
      ownerName: true,
      groupId: true,
      isParent: true,
      outlets: OPERABLE_OUTLET_SELECT,
    },
  });

  const operable: OperablePartner[] = [];
  if (own && !own.isParent) {
    operable.push({
      partnerId: own.id,
      ...pickOutlet(own.outlets),
      businessName: own.businessName,
      ownerName: own.ownerName,
      isOwnLogin: true,
    });
  }

  // Login-less siblings: same group + same phone + no login of their own. Only when we have a real
  // group AND a valid phone (else there is nothing to safely merge — see the SECURITY INVARIANT above).
  if (own?.groupId && last10) {
    const siblings = await db.channelPartner.findMany({
      where: {
        clientId,
        deletedAt: null,
        isParent: false,
        userId: null,
        groupId: own.groupId,
        id: { not: own.id },
        phone: { endsWith: last10 },
      },
      select: {
        id: true,
        businessName: true,
        ownerName: true,
        outlets: OPERABLE_OUTLET_SELECT,
      },
    });
    for (const s of siblings) {
      // Only surface a sibling that actually has an operable (active) outlet.
      if (!s.outlets?.length) continue;
      operable.push({
        partnerId: s.id,
        ...pickOutlet(s.outlets),
        businessName: s.businessName,
        ownerName: s.ownerName,
        isOwnLogin: false,
      });
    }
  }

  let groupParent: GroupParentRef | null = null;
  if (last10) {
    const parent = await db.channelPartner.findFirst({
      where: { clientId, deletedAt: null, isParent: true, phone: { endsWith: last10 } },
      select: { id: true, businessName: true, ownerName: true },
    });
    if (parent) groupParent = { parentId: parent.id, businessName: parent.businessName, ownerName: parent.ownerName };
  }

  return { ownPartnerId: own?.id ?? null, operable, groupParent };
}

/**
 * Authorize + resolve the partner a request should ACT ON, from an optional client-supplied selector.
 *
 * - Absent / empty / equal-to-own selector → the login's OWN partner (fast path: one query).
 * - A selector naming a valid operable sibling → that sibling.
 * - A selector naming anything else → `forbidden` (the caller throws ForbiddenException). NEVER trust
 *   the selector without this re-authorization — it is the whole access boundary for outlet switching.
 *
 * Returns `partnerId=null, forbidden=false` when the login has no partner at all (e.g. a parent-only
 * phone) — the caller treats that as "no operable outlet" exactly as today.
 */
export async function resolveActivePartnerId(
  db: Db,
  params: { clientId: string; userSub: string; phone: string | null; requestedPartnerId?: string | null },
): Promise<{ partnerId: string | null; forbidden: boolean; isSwitched: boolean }> {
  const { clientId, userSub, phone, requestedPartnerId } = params;

  const own = await db.channelPartner.findFirst({
    // isParent:false — a parent is login-less by construction, so a login never resolves to one;
    // filtering it defends against a model violation (a parent with a userId) letting a login
    // enumerate every child of its own group via the switch query below (audit LOW-2).
    where: { userId: userSub, clientId, deletedAt: null, isParent: false },
    select: { id: true, groupId: true },
  });

  const requested = (requestedPartnerId ?? '').trim() || null;
  if (!requested || requested === own?.id) {
    return { partnerId: own?.id ?? null, forbidden: false, isSwitched: false };
  }

  // A switch was requested — it is valid ONLY if it names a login-less sibling in the login's own
  // group carrying the login's phone AND with an ACTIVE outlet (the same constraint the picker
  // applies — else a crafted header could operate an inactive sibling the UI never surfaces).
  // Anything else is a forbidden cross-partner reach.
  const last10 = normalizePhoneLast10(phone);
  if (!own?.groupId || !last10) return { partnerId: null, forbidden: true, isSwitched: false };

  const sibling = await db.channelPartner.findFirst({
    where: {
      id: requested,
      clientId,
      deletedAt: null,
      isParent: false,
      userId: null,
      groupId: own.groupId,
      phone: { endsWith: last10 },
      outlets: { some: { isActive: true, deletedAt: null } },
    },
    select: { id: true },
  });
  if (!sibling) return { partnerId: null, forbidden: true, isSwitched: false };
  return { partnerId: sibling.id, forbidden: false, isSwitched: true };
}

/** Resolve the read-only group-overview parent for a login's phone (auth = phone owns the parent). */
export async function resolveGroupParentByPhone(
  db: Db,
  params: { clientId: string; phone: string | null },
): Promise<string | null> {
  const last10 = normalizePhoneLast10(params.phone);
  if (!last10) return null;
  const parent = await db.channelPartner.findFirst({
    where: { clientId: params.clientId, deletedAt: null, isParent: true, phone: { endsWith: last10 } },
    select: { id: true },
  });
  return parent?.id ?? null;
}
