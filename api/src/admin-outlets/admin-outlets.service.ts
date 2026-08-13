import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { KycStatus, OutletKycIntent, OutletPaymentType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SalesNotificationsService } from '../notifications/sales-notifications.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isReKycPending, isKycInFlight } from '../common/kyc-rekyc.helper';
import { parseOutletPaymentType } from '../common/payment-type.helper';
import {
  acquireIdentityLocks,
  checkGroupUniqueness,
  childSharesDetailWithGroup,
  resolveUniquenessPolicy,
  type PartnerIdentityDetails,
  type UniquenessPolicy,
} from '../common/partner-group.helper';
import {
  BulkDeleteOutletsDto,
  ListOutletsQueryDto,
  OutletCodesDto,
  OutletUploadRowDto,
  OutletKycFilter,
  ReKycFlagDto,
  ReKycFlagRowDto,
  UpsertOutletsDto,
} from './dto/admin-outlets.dto';

/**
 * Derive the display KYC status for a single outlet from its reKycFlags / kycIntent /
 * partner + the latest KycSubmission status for that partner. SINGLE source of truth
 * for the derivation, shared by list() (paginated page) and listIds() (unpaginated
 * validation projection) so both agree with buildKycStatusWhere.
 *
 * Priority:
 *   1. non-empty reKycFlags AND latest submission NOT in-flight ⇒ RE_KYC_REQUIRED
 *   2. kycIntent NOT_INTERESTED ⇒ NOT_STARTED      (outlet declined)
 *   3. no partner               ⇒ NOT_STARTED
 *   4. latest submission status ⇒ mapped bucket
 *   5. no submission            ⇒ NOT_STARTED
 *
 * reKycFlags stay set from the admin request until Gifsy approval clears them, so a
 * just-resubmitted re-KYC still carries flags WHILE its new submission is under review.
 * Priority 1 therefore yields to an in-flight latest submission — the under-review status
 * shows through, not RE_KYC_REQUIRED. (The approver highlight reads the flags directly,
 * so it still shows what was flagged during review.)
 */
export function deriveKycStatus(
  reKycFlags: unknown,
  kycIntent: OutletKycIntent | null,
  partnerId: string | null,
  latestStatusByPartnerId: Map<string, KycStatus>,
): string {
  const latestForReKyc = partnerId ? latestStatusByPartnerId.get(partnerId) : undefined;
  if (isReKycPending(reKycFlags) && !isKycInFlight(latestForReKyc)) {
    return 'RE_KYC_REQUIRED';
  }
  // Admin-PARKED outlet — its own distinct display bucket (NOT folded into NOT_STARTED), so
  // the admin can see + un-park it. Checked BEFORE NOT_INTERESTED (PARKED is a separate state).
  if (kycIntent === OutletKycIntent.PARKED) {
    return 'PARKED';
  }
  if (kycIntent === OutletKycIntent.NOT_INTERESTED) {
    return 'NOT_STARTED';
  }
  if (!partnerId) {
    return 'NOT_STARTED';
  }
  const latest = latestStatusByPartnerId.get(partnerId);
  if (!latest) {
    return 'NOT_STARTED';
  }
  switch (latest) {
    case KycStatus.APPROVED:
      return 'APPROVED';
    case KycStatus.REJECTED:
      return 'REJECTED';
    case KycStatus.SUBMITTED:
      return 'SUBMITTED';
    case KycStatus.RE_KYC_REQUIRED:
      return 'RE_KYC_REQUIRED';
    case KycStatus.UNDER_REVIEW:
    case KycStatus.PENDING_PENNY_DROP:
    case KycStatus.PENDING_AGREEMENT:
    case KycStatus.PENDING_SO_APPROVAL:
    case KycStatus.PENDING_ASM_APPROVAL:
    case KycStatus.PENDING_RSM_APPROVAL:
    case KycStatus.PENDING_GIFSY:
    case KycStatus.RE_UPLOAD_REQUIRED:
    case KycStatus.RESUBMISSION_REQUIRED:
    case KycStatus.DRAFT:
      return 'IN_PROGRESS';
    case KycStatus.SUSPENDED:
    case KycStatus.NOT_INTERESTED:
      return 'NOT_STARTED';
    default:
      return 'NOT_STARTED';
  }
}

// The raw KycStatus values that each DERIVED display bucket maps to (mirrors the
// switch in deriveKycStatus). RE_KYC_REQUIRED / NOT_STARTED are handled specially
// (they also depend on reKycFlags / kycIntent / the absence of a submission), so
// only the "latest submission is exactly one of these" buckets live here.
const KYC_STATUS_BY_BUCKET: Record<OutletKycFilter, KycStatus[]> = {
  APPROVED: [KycStatus.APPROVED],
  REJECTED: [KycStatus.REJECTED],
  SUBMITTED: [KycStatus.SUBMITTED],
  IN_PROGRESS: [
    KycStatus.UNDER_REVIEW,
    KycStatus.PENDING_PENNY_DROP,
    KycStatus.PENDING_AGREEMENT,
    KycStatus.PENDING_SO_APPROVAL,
    KycStatus.PENDING_ASM_APPROVAL,
    KycStatus.PENDING_RSM_APPROVAL,
    KycStatus.PENDING_GIFSY,
    KycStatus.RE_UPLOAD_REQUIRED,
    KycStatus.RESUBMISSION_REQUIRED,
    KycStatus.DRAFT,
  ],
  // These are derived (not a direct submission-status match) — never read from
  // this table directly; buildKycStatusWhere handles them via partnerId sets / kycIntent.
  RE_KYC_REQUIRED: [KycStatus.RE_KYC_REQUIRED],
  NOT_STARTED: [],
  // PARKED is a pure kycIntent match (no submission involvement) — handled directly.
  PARKED: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Ported pure logic — outlet-persist.ts + the Re-KYC helpers of outlet-upload.ts.
// Kept local (no Prisma, no I/O) so the mapping stays unit-testable, exactly as in
// the platform libs. partnerId is left NULL (owner attached at KYC); addressLine1/
// pincode are KYC-captured. New outlets are created PENDING (isActive = false).
// ─────────────────────────────────────────────────────────────────────────────

/** The Outlet column data common to create + update (excludes identity + isActive). */
interface OutletWriteData {
  outletTypeId: string;
  name: string;
  city: string;
  state: string;
  distributorCode: string | null;
  distributorName: string | null;
  beat: string | null;
  metro: string | null;
  zone: string | null;
  programName: string | null;
  programCategory: string | null;
}

/** "" → null so blank cells don't overwrite with empty strings. */
function nullIfBlank(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

/**
 * The tenant-uniqueness policy applied when the tenant settings blob carries none — today's
 * behaviour (GST + phone enforced; PAN is always on inside the helper; bank/UPI off). Shared by
 * the upload's add-to-parent check and the dedicated un-group action so the two never diverge.
 */

/** Map a validated upload row + resolved OutletType id to the Outlet column data. */
function mapRowToOutletData(row: OutletUploadRowDto, outletTypeId: string): OutletWriteData {
  return {
    outletTypeId,
    name: (row.outletName ?? '').trim(),
    city: (row.city ?? '').trim(),
    state: (row.state ?? '').trim(),
    distributorCode: nullIfBlank(row.distributorId),
    distributorName: nullIfBlank(row.distributorName),
    beat: nullIfBlank(row.beat),
    metro: nullIfBlank(row.metro),
    zone: nullIfBlank(row.zone),
    programName: nullIfBlank(row.programName),
    programCategory: nullIfBlank(row.programCategory),
  };
}

/** create payload for a new Outlet — partnerId omitted (NULL); created PENDING.
 *  A CREATE always persists a payout mandate — a blank cell defaults to BANK.
 *  parentId (owner-group link) is written only when a Parent ID resolved to a parent. */
function buildOutletCreate(
  clientId: string,
  outletCode: string,
  data: OutletWriteData,
  requiredPaymentType: OutletPaymentType,
  parentId?: string | null,
): Prisma.OutletUncheckedCreateInput {
  return {
    clientId,
    outletCode,
    isActive: false,
    requiredPaymentType,
    ...(parentId ? { parentId } : {}),
    ...data,
  };
}

/** update payload for an existing Outlet — identity + isActive left untouched. The payout
 *  mandate is overwritten ONLY when the column was present/non-blank (null = leave as-is),
 *  so a blank cell never wipes an outlet's existing requiredPaymentType.
 *  parentIdChange: `undefined` = leave grouping unchanged; a string = link to that parent;
 *  `null` = un-map (un-group) — only reached after the un-group guard passed. */
function buildOutletUpdate(
  data: OutletWriteData,
  requiredPaymentType: OutletPaymentType | null,
  parentIdChange?: string | null,
): Prisma.OutletUncheckedUpdateInput {
  return {
    ...data,
    ...(requiredPaymentType !== null ? { requiredPaymentType } : {}),
    ...(parentIdChange !== undefined ? { parentId: parentIdChange } : {}),
  };
}

/** The 20 Re-KYC field flags persisted onto Outlet.reKycFlags (+ remarks). */
interface ReKycFlags {
  outletName: boolean;
  ownerName: boolean;
  mobileNumber: boolean;
  gstNumber: boolean;
  panNumber: boolean;
  streetAddress: boolean;
  city: boolean;
  pincode: boolean;
  state: boolean;
  bankName: boolean;
  accountHolderName: boolean;
  accountNumber: boolean;
  ifscCode: boolean;
  upiId: boolean;
  gstCertificate: boolean;
  ownerPhoto: boolean;
  addressProof: boolean;
  storeBoardPhoto: boolean;
  cancelledCheque: boolean;
  selfDeclaration: boolean;
  remarks: string;
}

/** The flag property names on a ReKycFlagRow (also the persisted-flag keys). */
const REKYC_FLAG_PROPS: (keyof Omit<ReKycFlags, 'remarks'>)[] = [
  'outletName',
  'ownerName',
  'mobileNumber',
  'gstNumber',
  'panNumber',
  'streetAddress',
  'city',
  'pincode',
  'state',
  'bankName',
  'accountHolderName',
  'accountNumber',
  'ifscCode',
  'upiId',
  'gstCertificate',
  'ownerPhoto',
  'addressProof',
  'storeBoardPhoto',
  'cancelledCheque',
  'selfDeclaration',
];

/** "Yes" / "YES" / "yes" → true. Everything else → false. */
function isYes(val: string | undefined): boolean {
  return (val ?? '').trim().toLowerCase() === 'yes';
}

/** Build the persisted ReKycFlags object from a parsed Re-KYC flag row. */
function buildReKycFlags(row: ReKycFlagRowDto): ReKycFlags {
  const flags = { remarks: row.remarks ?? '' } as ReKycFlags;
  const rowAsRecord = row as unknown as Record<string, string>;
  for (const flagProp of REKYC_FLAG_PROPS) {
    flags[flagProp] = isYes(rowAsRecord[flagProp]);
  }
  return flags;
}

/** True when no field is flagged for re-capture (all-false / blank row). */
function isReKycFlagsEmpty(flags: ReKycFlags): boolean {
  return REKYC_FLAG_PROPS.every((flagProp) => flags[flagProp] === false);
}

/** One per-row outcome of the outlet-master upsert (mirrors the source report shape). */
export interface UpsertRowResult {
  rowNum: number;
  outletId: string;
  status: 'OK' | 'ERROR';
  action: 'CREATE' | 'UPDATE' | 'REACTIVATE';
  errors: string[];
}

/** One per-row outcome of the re-KYC flag upsert. */
export interface ReKycRowResult {
  rowNum: number;
  outletId: string;
  status: 'OK' | 'ERROR';
  action: 'FLAGGED' | 'CLEARED';
  errors: string[];
}

/**
 * Thrown INSIDE the per-row upsert transaction when the add-to-parent group-uniqueness check
 * (run under the advisory lock) fails, so the failed check aborts the row's transaction rather
 * than committing a bad link. Caught by upsert() and turned into a per-row ERROR result — it
 * never escapes the batch. A plain marker class so `instanceof` can distinguish it from a real
 * DB error (which must still surface).
 */
class RowGroupingError extends Error {}

/**
 * Admin · Outlets — ported from platform/src/app/api/admin/outlets/* onto /v1.
 * Tenant-scoped by the outlet's OWN clientId (from the session-bound JWT): outlets
 * uploaded via the master file have no partner until KYC, so every query filters on
 * Outlet.clientId directly (never a partner→user join). Admin-only is enforced by
 * @Roles on the controller; tenant scope is re-checked here. The controller is a
 * thin HTTP adapter — business logic + the ported upsert/flag mapping live here.
 */
@Injectable()
export class AdminOutletsService {
  private readonly logger = new Logger(AdminOutletsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly salesNotifications: SalesNotificationsService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /**
   * Translate a DERIVED KYC display bucket into a Prisma OutletWhereInput that,
   * combined with the tenant scope, selects exactly the outlets that
   * deriveKycStatus would classify into that bucket. This keeps server-side
   * pagination correct — filtering only the current page would silently drop
   * matches on other pages.
   *
   * The derivation priority (see deriveKycStatus) is honoured:
   *   1. non-empty reKycFlags  ⇒ RE_KYC_REQUIRED   (wins over everything)
   *   2. kycIntent NOT_INTERESTED ⇒ NOT_STARTED
   *   3. partnerId null           ⇒ NOT_STARTED
   *   4. latest submission status ⇒ mapped bucket
   *   5. no submission            ⇒ NOT_STARTED
   *
   * reKycFlags is a JSON column; we can express "has a non-empty object" only
   * approximately in Prisma, so the reKycFlags-driven RE_KYC_REQUIRED members
   * are resolved from a pre-computed id set (`reKycOutletIds`) instead. The
   * latest-status-per-partner buckets are resolved from `latestStatusByPartnerId`.
   */
  private buildKycStatusWhere(
    bucket: OutletKycFilter,
    latestStatusByPartnerId: Map<string, KycStatus>,
    reKycOutletIds: string[],
  ): Prisma.OutletWhereInput {
    // Null-safe "kycIntent is not NOT_INTERESTED" — priority 2 in deriveKycStatus makes a
    // NOT_INTERESTED outlet always NOT_STARTED, ahead of any latest-submission bucket. The
    // submission-driven branches AND this in so those outlets aren't mis-bucketed. Using
    // `{ not: NOT_INTERESTED }` alone would DROP NULL-kycIntent rows (Prisma NULL semantics),
    // so we OR in the null case.
    const NOT_NOT_INTERESTED: Prisma.OutletWhereInput = {
      OR: [
        { kycIntent: null },
        { kycIntent: { not: OutletKycIntent.NOT_INTERESTED } },
      ],
    };

    // Null-safe "kycIntent is not PARKED". A PARKED outlet has its own display bucket
    // (deriveKycStatus returns 'PARKED', ahead of every submission bucket), so it must be
    // EXCLUDED from NOT_STARTED (a pending PARKED outlet is partnerId:null, which would
    // otherwise match NOT_STARTED's `{ partnerId: null }` branch). `{ not: PARKED }` alone
    // drops NULL-kycIntent rows (Prisma NULL semantics), so OR-in the null case.
    const NOT_PARKED: Prisma.OutletWhereInput = {
      OR: [
        { kycIntent: null },
        { kycIntent: { not: OutletKycIntent.PARKED } },
      ],
    };

    // PARKED bucket = a pure kycIntent match (no partner/submission involvement).
    if (bucket === 'PARKED') {
      return { kycIntent: OutletKycIntent.PARKED };
    }

    // Partner ids whose LATEST submission maps to the requested bucket.
    const wantedStatuses = new Set(KYC_STATUS_BY_BUCKET[bucket]);
    const partnerIdsInBucket: string[] = [];
    for (const [partnerId, status] of latestStatusByPartnerId) {
      if (wantedStatuses.has(status)) partnerIdsInBucket.push(partnerId);
    }

    if (bucket === 'RE_KYC_REQUIRED') {
      // A member iff: reKycFlags non-empty (id set) OR latest submission is
      // RE_KYC_REQUIRED. (An outlet with re-KYC flags is caught by the id set
      // regardless of partner/submission state.)
      const or: Prisma.OutletWhereInput[] = [];
      if (reKycOutletIds.length > 0) or.push({ id: { in: reKycOutletIds } });
      if (partnerIdsInBucket.length > 0) {
        // Latest-submission RE_KYC_REQUIRED only counts when reKycFlags is NOT
        // set (priority 1 already covered those). Exclude the flagged ids so a
        // flagged outlet isn't double-required — harmless for membership, but
        // keeps the semantics clean. Also exclude NOT_INTERESTED outlets:
        // deriveKycStatus priority 2 (kycIntent NOT_INTERESTED ⇒ NOT_STARTED)
        // wins over a latest-submission bucket (priority 4). Null-safe so a NULL
        // kycIntent is still included ({not} would drop NULLs).
        or.push({
          partnerId: { in: partnerIdsInBucket },
          id: { notIn: reKycOutletIds },
          AND: [NOT_NOT_INTERESTED],
        });
      }
      // No members at all → an impossible predicate (id: null won't match).
      return or.length > 0 ? { OR: or } : { id: { in: [] } };
    }

    if (bucket === 'NOT_STARTED') {
      // NOT_STARTED = NOT any other bucket. Concretely, an outlet is NOT_STARTED
      // when it is NOT re-KYC-flagged AND (kycIntent NOT_INTERESTED OR no partner
      // OR the partner has no submission OR the latest maps to NOT_STARTED —
      // SUSPENDED / NOT_INTERESTED). Everything with a partner whose latest maps
      // to another bucket is excluded.
      const partnerIdsNotStarted: string[] = [];
      for (const [partnerId, status] of latestStatusByPartnerId) {
        if (status === KycStatus.SUSPENDED || status === KycStatus.NOT_INTERESTED) {
          partnerIdsNotStarted.push(partnerId);
        }
      }
      // Partner ids that have ANY submission mapping to a NON-NOT_STARTED bucket.
      const partnerIdsElsewhere: string[] = [];
      for (const [partnerId, status] of latestStatusByPartnerId) {
        if (status !== KycStatus.SUSPENDED && status !== KycStatus.NOT_INTERESTED) {
          partnerIdsElsewhere.push(partnerId);
        }
      }
      return {
        // Never re-KYC-flagged (those are RE_KYC_REQUIRED by priority 1).
        id: { notIn: reKycOutletIds },
        // Never PARKED — a PARKED outlet has its own bucket (else its partnerId:null would
        // match the `{ partnerId: null }` branch below and leak into NOT_STARTED).
        AND: [NOT_PARKED],
        OR: [
          { kycIntent: OutletKycIntent.NOT_INTERESTED },
          { partnerId: null },
          { partnerId: { in: partnerIdsNotStarted } },
          // Has a partner, but NOT one whose latest maps elsewhere ⇒ no submission.
          { partnerId: { notIn: partnerIdsElsewhere } },
        ],
      };
    }

    // APPROVED / REJECTED / SUBMITTED / IN_PROGRESS: latest submission maps to the
    // bucket AND the outlet is not re-KYC-flagged (priority 1 pulls flagged ones out)
    // AND the outlet isn't NOT_INTERESTED (priority 2 makes those NOT_STARTED, ahead of
    // the submission bucket — else a Not-Interested outlet whose partner still has an
    // APPROVED/REJECTED submission would show under the wrong tab + double-count).
    if (partnerIdsInBucket.length === 0) return { id: { in: [] } };
    return {
      partnerId: { in: partnerIdsInBucket },
      id: { notIn: reKycOutletIds },
      AND: [NOT_NOT_INTERESTED],
    };
  }

  /**
   * GET /v1/admin/outlets — tenant-scoped, server-paginated + server-filtered
   * outlet list with the active XSR and real KYC status.
   *
   * `search` spans outlet code / name / ISR name / beat / city (the same fields
   * the FE filtered client-side); `kycStatus` filters on the DERIVED display
   * bucket. Envelope mirrors channel-partners:
   *   { outlets, pagination: { page, limit, total, pages }, outletTypes }
   */
  async list(user: JwtPayload, q: ListOutletsQueryDto = {}) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const skip = (page - 1) * limit;

    // ── Base tenant scope (unchanged: the outlet's OWN clientId, never a partner join). ──
    const baseWhere: Prisma.OutletWhereInput = { deletedAt: null, clientId: user.clientId };

    // ── Owner-group filter — narrow to one parent's group (the admin grouping UI's drill-in). ──
    // `parentId` is the parent ChannelPartner's CUID (exact match, not the partnerCode). Absent =
    // unchanged behaviour. Combined into baseWhere so it applies to both the search and the kycStatus
    // paths (kycStatus wraps AND[baseWhere, bucket]).
    if (q.parentId && q.parentId.trim()) {
      baseWhere.parentId = q.parentId.trim();
    }

    // ── Text search across the same fields the FE searched (case-insensitive). ──
    // ISR name lives on the active SalesUserAssignment → salesUser → user.name;
    // it is expressed as a relation filter so search still spans it server-side.
    if (q.search && q.search.trim()) {
      const s = q.search.trim();
      baseWhere.OR = [
        { outletCode: { contains: s, mode: 'insensitive' } },
        { name: { contains: s, mode: 'insensitive' } },
        { beat: { contains: s, mode: 'insensitive' } },
        { city: { contains: s, mode: 'insensitive' } },
        {
          salesAssignments: {
            some: {
              unassignedAt: null,
              salesUser: { user: { name: { contains: s, mode: 'insensitive' } } },
            },
          },
        },
      ];
    }

    // ── KYC display-status filter (derived) ──────────────────────────────────
    // The bucket predicate depends on per-partner latest submission status and on
    // which outlets carry non-empty reKycFlags, both of which must be resolved
    // BEFORE the paginated query so the page/count are computed over the filtered
    // set. We resolve them tenant-wide (bounded by the tenant's own outlets).
    let where: Prisma.OutletWhereInput = baseWhere;
    if (q.kycStatus) {
      // (a) Latest KycStatus per partner, for the tenant's outlets with an owner. Resolved
      //     FIRST because a flagged outlet whose latest submission is under review must NOT
      //     count as RE_KYC_REQUIRED (the flags persist until approval).
      const partnerRows = await this.prisma.outlet.findMany({
        where: { ...baseWhere, partnerId: { not: null } },
        select: { partnerId: true },
        distinct: ['partnerId'],
      });
      const partnerIds = partnerRows
        .map((o) => o.partnerId)
        .filter((id): id is string => id !== null);
      const latestStatusByPartnerId = new Map<string, KycStatus>();
      if (partnerIds.length > 0) {
        const subs = await this.prisma.kycSubmission.findMany({
          where: { partnerId: { in: partnerIds } },
          select: { partnerId: true, status: true },
          orderBy: { createdAt: 'desc' },
        });
        for (const sub of subs) {
          if (sub.partnerId && !latestStatusByPartnerId.has(sub.partnerId)) {
            latestStatusByPartnerId.set(sub.partnerId, sub.status);
          }
        }
      }

      // (b) Outlets carrying a NON-EMPTY reKycFlags object whose latest submission is NOT
      //     in-flight. reKycFlags is a nullable Json; `{ not: DbNull }` excludes SQL NULL but
      //     NOT an empty {} — post-filter for a non-empty object in JS. A resubmitted (under
      //     review) re-KYC keeps its flags but buckets by its in-flight status, so it is
      //     excluded here (deriveKycStatus applies the identical guard for the display).
      const flagCandidates = await this.prisma.outlet.findMany({
        where: { ...baseWhere, reKycFlags: { not: Prisma.DbNull } },
        select: { id: true, partnerId: true, reKycFlags: true },
      });
      const reKycOutletIds = flagCandidates
        .filter(
          (o) =>
            o.reKycFlags !== null &&
            typeof o.reKycFlags === 'object' &&
            Object.keys(o.reKycFlags as Record<string, unknown>).length > 0 &&
            !(o.partnerId && isKycInFlight(latestStatusByPartnerId.get(o.partnerId))),
        )
        .map((o) => o.id);

      const kycWhere = this.buildKycStatusWhere(
        q.kycStatus,
        latestStatusByPartnerId,
        reKycOutletIds,
      );
      // AND the base scope (incl. search) with the bucket predicate.
      where = { AND: [baseWhere, kycWhere] };
    }

    const [outlets, total] = await Promise.all([
      this.prisma.outlet.findMany({
        where,
        skip,
        take: limit,
        select: {
          outletCode: true,
          name: true,
          outletTypeId: true,
          city: true,
          state: true,
          isActive: true,
          createdAt: true,
          distributorCode: true,
          beat: true,
          metro: true,
          programName: true,
          programCategory: true,
          // Fields needed for real KYC-status derivation
          partnerId: true,
          reKycFlags: true,
          kycIntent: true,
          // Owner-group link (the admin grouping UI): the raw parent FK + the parent's
          // partnerCode/businessName (via the OutletParent relation, flattened below).
          parentId: true,
          parent: { select: { partnerCode: true, businessName: true } },
          salesAssignments: {
            where: { unassignedAt: null },
            take: 1,
            orderBy: { assignedAt: 'desc' },
            select: {
              salesUser: {
                select: { employeeCode: true, user: { select: { name: true } } },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.outlet.count({ where }),
    ]);

    // ── Batched KYC-status lookup (no N+1) ───────────────────────────────────────
    // Collect all distinct partnerIds for outlets that have an owner (post-KYC-start).
    const partnerIds = [...new Set(
      outlets.map((o) => o.partnerId).filter((id): id is string => id !== null),
    )];

    // For each partnerId, fetch only the single latest KycSubmission (ordered by createdAt desc).
    // We do this with a single findMany then group in JS to avoid N+1.
    const latestSubmissions = partnerIds.length > 0
      ? await this.prisma.kycSubmission.findMany({
          where: { partnerId: { in: partnerIds } },
          select: { partnerId: true, status: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        })
      : [];

    // Build a map: partnerId → latest KycStatus
    const latestStatusByPartnerId = new Map<string, KycStatus>();
    for (const sub of latestSubmissions) {
      if (sub.partnerId && !latestStatusByPartnerId.has(sub.partnerId)) {
        // findMany is ordered desc so the first hit per partnerId is the latest
        latestStatusByPartnerId.set(sub.partnerId, sub.status);
      }
    }

    const mapped = outlets.map((o) => {
      const xsr = o.salesAssignments[0]?.salesUser;
      return {
        outletId: o.outletCode,
        outletName: o.name,
        outletType: o.outletTypeId,
        programName: o.programName ?? '',
        programCategory: o.programCategory ?? '',
        beat: o.beat ?? '',
        distributorId: o.distributorCode ?? '',
        city: o.city,
        state: o.state,
        metro: !!(o.metro && o.metro.trim()),
        xsrId: xsr?.employeeCode ?? '',
        xsrName: xsr?.user?.name ?? '',
        kycStatus: deriveKycStatus(o.reKycFlags, o.kycIntent, o.partnerId, latestStatusByPartnerId),
        isActive: o.isActive,
        addedDate: o.createdAt.toISOString().slice(0, 10),
        // Owner-group grouping fields (null when the outlet is ungrouped).
        parentId: o.parentId ?? null,
        parentCode: o.parent?.partnerCode ?? null,
        parentBusinessName: o.parent?.businessName ?? null,
      };
    });

    // The tenant's enabled outlet-type codes — the FE validates uploads against THESE
    // (not a hardcoded list) so it never green-lights a type the upsert will reject as
    // "Unknown outlet type". Empty ⇒ no types enabled for this tenant: outlets cannot be
    // added until an operator enables outlet types (the false-success this used to hide).
    const typeConfigs = await this.prisma.outletTypeClientConfig.findMany({
      where: { clientId: user.clientId, isEnabled: true, outletType: { isActive: true } },
      select: { outletType: { select: { code: true } } },
    });
    const outletTypes = typeConfigs.map((c) => c.outletType.code).sort();

    return {
      outlets: mapped,
      // Envelope mirrors channel-partners: { page, limit, total, pages }.
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      outletTypes,
    };
  }

  /**
   * GET /v1/admin/outlets/ids — the FULL tenant outlet list, UNPAGINATED, projected
   * to only the 3 fields the FE upload validators + header stats need
   * (outletId, isActive, kycStatus). Replaces the FE's ~23-request page-through of
   * GET /admin/outlets (capped at limit=100) that existed purely to build the
   * client-side validation list.
   *
   * kycStatus is derived with the SAME deriveKycStatus used by list() (shared
   * module-scope fn + isReKycPending helper), so the two never diverge.
   * Envelope is applied globally by TransformInterceptor: { success, data:{ outlets } }.
   */
  async listIds(user: JwtPayload) {
    const baseWhere: Prisma.OutletWhereInput = { deletedAt: null, clientId: user.clientId };

    const outlets = await this.prisma.outlet.findMany({
      where: baseWhere,
      select: {
        outletCode: true,
        isActive: true,
        // Fields needed for real KYC-status derivation (mirrors list()).
        partnerId: true,
        reKycFlags: true,
        kycIntent: true,
      },
    });

    // Batched latest-submission lookup (no N+1) — mirrors list().
    const partnerIds = [
      ...new Set(outlets.map((o) => o.partnerId).filter((id): id is string => id !== null)),
    ];
    const latestSubmissions =
      partnerIds.length > 0
        ? await this.prisma.kycSubmission.findMany({
            where: { partnerId: { in: partnerIds } },
            select: { partnerId: true, status: true },
            orderBy: { createdAt: 'desc' },
          })
        : [];
    const latestStatusByPartnerId = new Map<string, KycStatus>();
    for (const sub of latestSubmissions) {
      if (sub.partnerId && !latestStatusByPartnerId.has(sub.partnerId)) {
        latestStatusByPartnerId.set(sub.partnerId, sub.status);
      }
    }

    return {
      outlets: outlets.map((o) => ({
        outletId: o.outletCode,
        isActive: o.isActive,
        kycStatus: deriveKycStatus(o.reKycFlags, o.kycIntent, o.partnerId, latestStatusByPartnerId),
      })),
    };
  }

  /**
   * GET /v1/admin/outlets/parked — the tenant's currently PARKED outlets, UNPAGINATED,
   * projected to only the fields the FE "Download Parked Outlets" export needs
   * (outletId, name, city). PARKED is the same intent Park sets: kycIntent PARKED on a
   * non-deleted outlet, tenant-scoped by clientId (never cross-tenant).
   * Envelope is applied globally by TransformInterceptor: { success, data:{ outlets } }.
   */
  async listParked(user: JwtPayload) {
    const rows = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, deletedAt: null, kycIntent: OutletKycIntent.PARKED },
      select: { outletCode: true, name: true, city: true },
      orderBy: { outletCode: 'asc' },
    });

    return {
      outlets: rows.map((o) => ({ outletId: o.outletCode, name: o.name ?? '', city: o.city ?? '' })),
    };
  }

  /**
   * POST /v1/admin/outlets/upsert — persists the Outlet Master upload.
   * Enforces the two write-time invariants (OutletType-by-code + XSR-by-employeeCode,
   * both tenant-scoped), upserts each Outlet on (clientId, outletCode), and (re)tags
   * it to the resolved XSR via SalesUserAssignment. partnerId is left NULL.
   */
  async upsert(user: JwtPayload, dto: UpsertOutletsDto) {
    const clientId = user.clientId;

    // Resolve the tenant's enabled outlet types once (code → id). OutletType is a
    // global catalog; per-tenant enablement lives on OutletTypeClientConfig.
    const typeConfigs = await this.prisma.outletTypeClientConfig.findMany({
      where: { clientId, isEnabled: true },
      select: { outletType: { select: { id: true, code: true, isActive: true } } },
    });
    const typeIdByCode = new Map<string, string>();
    for (const c of typeConfigs) {
      if (c.outletType.isActive) typeIdByCode.set(c.outletType.code.toUpperCase(), c.outletType.id);
    }

    // The tenant's UPI gate + owner-group uniqueness policy — read once for the whole batch.
    // The UPI gate is the AUTHORITATIVE guard for the payout-mandate column (a UPI row is
    // rejected, not silently coerced, when the tenant has UPI disabled; ANY degrades to
    // bank-only downstream). The policy drives the add-to-parent / un-group checks below.
    const settings = await this.tenantSettings.getEffectiveSettings(clientId);
    const upiEnabled = settings.salesApp.upiEnabled === true;
    // Fall back to today's-behaviour default if a partial settings object is returned.
    const policy: UniquenessPolicy = resolveUniquenessPolicy(settings);

    // ── Owner-group PRELOADS (batched over the LINK rows only) ────────────────────
    // A Parent ID cell only ever does work when it carries a partnerCode (LINK / add-to-parent).
    // A blank cell is a NO-OP (un-grouping is a separate explicit action — ungroupOutlet — so a
    // routine re-upload can never silently un-group). An absent column is likewise untouched.
    // These two lookups are the only BATCHED (set-based) reads; the per-row uniqueness check
    // below is delegated to the frozen helper (checkGroupUniqueness), which issues its own
    // bounded reads per link row — that part is inherently per-row and runs INSIDE the row's
    // transaction so it is race-proof (advisory-locked), not N+1-free.
    const linkRows = dto.rows.filter(
      (r) => r.parentId !== undefined && r.parentId.trim() !== '',
    );
    // parentCode → the resolved PARENT ChannelPartner (must have isParent=true; not soft-deleted).
    const parentByCode = new Map<string, { id: string; isParent: boolean }>();
    // outletCode → the link outlet's current owner details (the add-to-parent uniqueness input).
    const existingByCode = new Map<
      string,
      {
        id: string;
        // The outlet's CURRENT owner group — used to BLOCK a bulk-upload move between groups
        // (un-grouping is a dedicated action only; a re-upload must never silently re-link A→B).
        parentId: string | null;
        partner: {
          id: string;
          panNumber: string | null;
          gstNumber: string | null;
          bankAccountNumber: string | null;
          upiId: string | null;
        } | null;
      }
    >();
    if (linkRows.length > 0) {
      const parentCodes = [
        ...new Set(linkRows.map((r) => (r.parentId ?? '').trim()).filter(Boolean)),
      ];
      if (parentCodes.length > 0) {
        const parents = await this.prisma.channelPartner.findMany({
          // A SOFT-DELETED parent is not a valid link target (F8) — mirror listParents' filter.
          where: { clientId, partnerCode: { in: parentCodes }, deletedAt: null },
          select: { partnerCode: true, id: true, isParent: true },
        });
        for (const p of parents) parentByCode.set(p.partnerCode, { id: p.id, isParent: p.isParent });
      }
      const linkOutletCodes = [
        ...new Set(linkRows.map((r) => r.outletId.trim()).filter(Boolean)),
      ];
      if (linkOutletCodes.length > 0) {
        const existingOutlets = await this.prisma.outlet.findMany({
          where: { clientId, outletCode: { in: linkOutletCodes }, deletedAt: null },
          select: {
            id: true,
            outletCode: true,
            parentId: true,
            partner: {
              select: {
                id: true,
                panNumber: true,
                gstNumber: true,
                bankAccountNumber: true,
                upiId: true,
              },
            },
          },
        });
        for (const o of existingOutlets) {
          existingByCode.set(o.outletCode, { id: o.id, parentId: o.parentId, partner: o.partner });
        }
      }
    }

    const rowResults: UpsertRowResult[] = [];
    let created = 0;
    let updated = 0;
    let reactivated = 0;
    const now = new Date();
    // Per-rep tally of NEWLY CREATED outlets — notify each rep once after the loop
    // (a bulk upload assigning many outlets → one "N new outlets" push per rep, not N).
    const newlyAssigned = new Map<string, number>();

    for (const row of dto.rows) {
      const errors: string[] = [];
      const outletCode = row.outletId.trim();

      // 1. Resolve outlet type (tenant-scoped).
      const outletTypeId = typeIdByCode.get((row.outletType ?? '').trim().toUpperCase());
      if (!outletTypeId) {
        errors.push(`Unknown outlet type: ${row.outletType}`);
      }

      // 2. Resolve XSR (sales hierarchy must already be built).
      let salesUserId: string | null = null;
      const xsrId = (row.xsrId ?? '').trim();
      if (xsrId) {
        const su = await this.prisma.salesUser.findUnique({
          where: { clientId_employeeCode: { clientId, employeeCode: xsrId } },
          select: { id: true },
        });
        if (!su) {
          errors.push(`XSR ${xsrId} not found — upload the sales hierarchy first`);
        } else {
          salesUserId = su.id;
        }
      }

      // 2b. Resolve the payout MANDATE (optional column). Blank → null here (CREATE defaults it
      //     to BANK; UPDATE leaves the existing value untouched). A non-blank cell must parse to
      //     BANK/UPI/ANY, and a UPI cell is REJECTED when the tenant has UPI disabled.
      let requiredPaymentType: OutletPaymentType | null = null;
      const rawPayout = (row.payoutMethod ?? '').trim();
      if (rawPayout) {
        requiredPaymentType = parseOutletPaymentType(rawPayout);
        if (requiredPaymentType === null) {
          errors.push(`Invalid Payout Method "${row.payoutMethod}" — must be BANK, UPI, or ANY`);
        } else if (requiredPaymentType === OutletPaymentType.UPI && !upiEnabled) {
          errors.push('UPI is disabled for this tenant — cannot set outlet to UPI');
        }
      }

      // 2c. Resolve the Parent ID column (owner-group link). Three intents:
      //       - column ABSENT (undefined)  → leave grouping UNCHANGED (routine re-upload).
      //       - present but BLANK ("")      → NO-OP. Un-grouping is a SEPARATE explicit action
      //         (ungroupOutlet); a blank upload cell NEVER un-groups, so a routine re-upload
      //         that clears the column by accident can't silently dissolve a group.
      //       - a partnerCode ("CPP01")     → LINK / add-to-parent (§4.4). Parent existence /
      //         kind is resolved here from the batched preload; the group-uniqueness check runs
      //         INSIDE the row transaction below (advisory-locked) so a concurrent cross-group
      //         link can't race the read-then-write.
      let linkParentId: string | undefined = undefined;
      if (row.parentId !== undefined) {
        const rawParent = row.parentId.trim();
        if (rawParent) {
          const parent = parentByCode.get(rawParent);
          if (!parent) {
            errors.push(`Parent ID "${rawParent}" not found`);
          } else if (!parent.isParent) {
            errors.push(`"${rawParent}" is not a parent owner — it cannot group outlets`);
          } else {
            linkParentId = parent.id;
          }
        }
        // blank cell → no-op (never un-groups).
      }

      if (errors.length > 0 || !outletTypeId) {
        rowResults.push({ rowNum: row.rowNum, outletId: outletCode, status: 'ERROR', action: 'CREATE', errors });
        continue;
      }

      const data = mapRowToOutletData(row, outletTypeId);

      // 3. Upsert the outlet + (re)tag to the XSR in one transaction. When the row LINKS to a
      //    parent, the add-to-parent uniqueness check runs HERE — inside the same tx, AFTER
      //    acquiring the per-value advisory lock — so the check→write is atomic and race-proof.
      //    A group-fit violation throws RowGroupingError, which is caught below and turned into
      //    a per-row ERROR (keeping the report shape); any other error still aborts the batch.
      let action: 'CREATE' | 'UPDATE' | 'REACTIVATE';
      try {
        action = await this.prisma.$transaction(async (tx) => {
          if (linkParentId !== undefined) {
            // §4.5 GUARD — un-grouping / moving between groups is a DEDICATED action only. An outlet
            // ALREADY grouped under a DIFFERENT parent must NOT be silently moved A→B by a bulk
            // upload; the admin has to un-group it via the dedicated action first. Re-affirming the
            // SAME parent falls through (harmless no-op); linking an ungrouped outlet is allowed.
            const currentParentId = existingByCode.get(outletCode)?.parentId ?? null;
            if (currentParentId && currentParentId !== linkParentId) {
              throw new RowGroupingError(
                'Outlet is already grouped under another parent; un-group it via the dedicated action first',
              );
            }

            // The outlet's OWN owner details must fit the target group — PAN identical to the
            // group + no enforced field colliding with an outlet outside it. A pre-KYC outlet
            // (no partner yet) has no details → passes trivially.
            const cp = existingByCode.get(outletCode)?.partner ?? null;
            const details: PartnerIdentityDetails = {
              gstNumber: cp?.gstNumber ?? null,
              panNumber: cp?.panNumber ?? null,
              bankAccountNumber: cp?.bankAccountNumber ?? null,
              upiId: cp?.upiId ?? null,
            };
            // Advisory-lock the enforced values FIRST, then re-check inside the lock so a
            // concurrent writer of the same value serializes behind us (helper §acquireIdentityLocks).
            await acquireIdentityLocks(tx, { clientId, details, policy });
            const violation = await checkGroupUniqueness(tx, {
              clientId,
              ourParentId: linkParentId,
              details,
              policy,
              exceptPartnerId: cp?.id ?? null,
            });
            if (violation) {
              throw new RowGroupingError(
                violation.reason === 'pan-group-mismatch'
                  ? `${violation.message} Re-KYC the outlet to align its PAN before adding it to this group.`
                  : violation.message,
              );
            }
          }

          const existing = await tx.outlet.findUnique({
            where: { clientId_outletCode: { clientId, outletCode } },
            select: { id: true, isActive: true, deactivatedAt: true },
          });

          // Re-uploading a previously-DEACTIVATED outlet (it was active, then turned
          // off → deactivatedAt set) REACTIVATES it. A still-PENDING outlet (created
          // inactive, never deactivated → deactivatedAt null) is NOT activated here —
          // only KYC approval activates a pending outlet, so a re-upload can't bypass
          // KYC. (buildOutletUpdate deliberately leaves isActive untouched.)
          const reactivate = !!existing && !existing.isActive && existing.deactivatedAt != null;

          const outlet = await tx.outlet.upsert({
            where: { clientId_outletCode: { clientId, outletCode } },
            // CREATE always writes a mandate (blank cell → BANK); parentId only when linked.
            create: buildOutletCreate(
              clientId,
              outletCode,
              data,
              requiredPaymentType ?? OutletPaymentType.BANK,
              linkParentId,
            ),
            // UPDATE only overwrites the mandate when the column was present/non-blank, and
            // only touches parentId when a Parent ID column resolved to a link.
            update: reactivate
              ? {
                  ...buildOutletUpdate(data, requiredPaymentType, linkParentId),
                  isActive: true,
                  reactivatedAt: now,
                  deactivatedAt: null,
                  // Re-opening an outlet for enrollment clears the not-interested intent.
                  kycIntent: null,
                  kycIntentBy: null,
                  kycIntentAt: null,
                }
              : buildOutletUpdate(data, requiredPaymentType, linkParentId),
          });

          // Re-tag: close any active assignment for this outlet, then attach the XSR.
          if (salesUserId) {
            await tx.salesUserAssignment.updateMany({
              where: { outletId: outlet.id, unassignedAt: null },
              data: { unassignedAt: now },
            });
            await tx.salesUserAssignment.create({
              data: { salesUserId, outletId: outlet.id, assignedAt: now },
            });
          }

          return !existing ? ('CREATE' as const) : reactivate ? ('REACTIVATE' as const) : ('UPDATE' as const);
        });
      } catch (e) {
        if (e instanceof RowGroupingError) {
          rowResults.push({
            rowNum: row.rowNum,
            outletId: outletCode,
            status: 'ERROR',
            action: 'CREATE',
            errors: [e.message],
          });
          continue;
        }
        throw e;
      }

      if (action === 'CREATE') created++;
      else if (action === 'REACTIVATE') reactivated++;
      else updated++;
      // A brand-new outlet assigned to a rep = a new KYC for them to do.
      if (action === 'CREATE' && salesUserId) {
        newlyAssigned.set(salesUserId, (newlyAssigned.get(salesUserId) ?? 0) + 1);
      }
      rowResults.push({ rowNum: row.rowNum, outletId: outletCode, status: 'OK', action, errors: [] });
    }

    // Notify each rep of the new outlet(s) assigned to them for KYC (one push per rep).
    for (const [salesUserId, count] of newlyAssigned) {
      await this.salesNotifications.outletsAssigned(clientId, salesUserId, count);
    }

    const errorRows = rowResults.filter((r) => r.status === 'ERROR');
    return {
      created,
      updated,
      reactivated,
      errors: errorRows,
      rows: rowResults,
      message: `${created} created, ${updated} updated${reactivated ? `, ${reactivated} reactivated` : ''}${errorRows.length ? `, ${errorRows.length} row(s) failed` : ''}`,
    };
  }

  /**
   * Resolve the tenant's owner-group uniqueness policy (which of GST/phone/bank/UPI are enforced;
   * PAN is always on inside the helper). Falls back to today's-behaviour default for a partial
   * settings object. Shared by the dedicated un-group action.
   */
  private async uniquenessPolicy(clientId: string): Promise<UniquenessPolicy> {
    const settings = await this.tenantSettings.getEffectiveSettings(clientId);
    return resolveUniquenessPolicy(settings);
  }

  /**
   * POST /v1/admin/outlets/:outletCode/ungroup — the DEDICATED, explicit un-group action (§4.5).
   * Removes ONE outlet from its owner group. Un-grouping is NEVER triggered by a blank upload
   * cell (that is a no-op) — only by this action — so a routine re-upload can't dissolve a group.
   *
   * Blocked while the child still shares ANY enforced identity detail (PAN always + GST/bank/UPI/
   * phone per tenant policy) with a REMAINING group member: the admin must re-KYC the child to
   * make its details distinct first (else the DB partial-unique backstop would reject it anyway,
   * with a far uglier error). On pass, clears Outlet.parentId — the `outlets` trigger then clears
   * the partner's derived `groupId` automatically (we NEVER write groupId ourselves).
   * GIFSY_ADMIN / CLIENT_ADMIN only (controller @Roles), tenant-scoped by the outlet's own clientId.
   */
  async ungroupOutlet(user: JwtPayload, outletCode: string) {
    const clientId = user.clientId;
    const code = (outletCode ?? '').trim();

    const outlet = await this.prisma.outlet.findFirst({
      where: { clientId, outletCode: code, deletedAt: null },
      select: {
        id: true,
        parentId: true,
        partner: {
          select: {
            id: true,
            phone: true,
            panNumber: true,
            gstNumber: true,
            bankAccountNumber: true,
            upiId: true,
          },
        },
      },
    });
    if (!outlet) throw new NotFoundException(`Outlet ${code} not found`);

    // Already ungrouped → idempotent no-op (nothing to clear, nothing to check).
    if (!outlet.parentId) {
      return { outletCode: code, ungrouped: false, alreadyUngrouped: true };
    }

    const policy = await this.uniquenessPolicy(clientId);
    // SAME shared code path as the group-detail endpoint's `canUngroup` flag (ParentsService.getParent)
    // — the guard and the flag can never diverge.
    const shares = await childSharesDetailWithGroup(this.prisma, {
      clientId,
      parentId: outlet.parentId,
      childOutletId: outlet.id,
      childPartner: outlet.partner,
      policy,
    });
    if (shares) {
      throw new BadRequestException(
        `Cannot un-group ${code} — it still shares identity details with its owner group. Make its details distinct via re-KYC first.`,
      );
    }

    const previousParentId = outlet.parentId;
    await this.prisma.$transaction(async (tx) => {
      // Only Outlet.parentId is cleared — the DB trigger on `outlets` mirrors this into the
      // partner's derived groupId. We never touch channel_partners.groupId directly.
      await tx.outlet.update({ where: { id: outlet.id }, data: { parentId: null } });
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'OUTLET',
          entityId: outlet.id,
          actorId: user.sub,
          oldValues: { parentId: previousParentId },
          newValues: { parentId: null },
          metadata: { action: 'ungroup', outletCode: code },
        },
      });
    });

    return { outletCode: code, ungrouped: true };
  }

  /**
   * POST /v1/admin/outlets/rekyc-flag — persists the Re-KYC flag upload.
   * Turns each row into the ReKycFlags JSON (map-driven) and writes it onto
   * Outlet.reKycFlags, tenant-scoped on (clientId, outletCode). All-false rows clear
   * the flags back to SQL NULL (re-KYC no longer pending). Nothing else is touched.
   */
  async rekycFlag(user: JwtPayload, dto: ReKycFlagDto) {
    const clientId = user.clientId;

    const rowResults: ReKycRowResult[] = [];
    let flagged = 0;
    let cleared = 0;

    for (const row of dto.rows) {
      const outletCode = row.outletId.trim();

      if (!outletCode) {
        rowResults.push({ rowNum: row.rowNum, outletId: outletCode, status: 'ERROR', action: 'FLAGGED', errors: ['Outlet ID is required'] });
        continue;
      }

      const flags = buildReKycFlags(row);
      const clearing = isReKycFlagsEmpty(flags);

      const existing = await this.prisma.outlet.findUnique({
        where: { clientId_outletCode: { clientId, outletCode } },
        select: { id: true },
      });
      if (!existing) {
        rowResults.push({ rowNum: row.rowNum, outletId: outletCode, status: 'ERROR', action: clearing ? 'CLEARED' : 'FLAGGED', errors: [`Outlet ${outletCode} not found`] });
        continue;
      }

      // Only Outlet.reKycFlags is written — no other outlet field is touched.
      // DbNull writes a real SQL NULL to the nullable Json column; JS null is not
      // accepted by Prisma's Json input type.
      await this.prisma.outlet.update({
        where: { clientId_outletCode: { clientId, outletCode } },
        data: { reKycFlags: clearing ? Prisma.DbNull : (flags as unknown as Prisma.InputJsonValue) },
      });

      if (clearing) cleared++;
      else flagged++;
      rowResults.push({ rowNum: row.rowNum, outletId: outletCode, status: 'OK', action: clearing ? 'CLEARED' : 'FLAGGED', errors: [] });
    }

    const errorRows = rowResults.filter((r) => r.status === 'ERROR');
    return {
      flagged,
      cleared,
      errors: errorRows,
      rows: rowResults,
      message: `${flagged} flagged${cleared ? `, ${cleared} cleared` : ''}${errorRows.length ? `, ${errorRows.length} row(s) failed` : ''}`,
    };
  }

  /**
   * POST /v1/admin/outlets/bulk-delete — soft-delete by Prisma CUID ids.
   * Sets deletedAt + isActive=false, closes open SalesUserAssignments, writes audit.
   */
  async bulkDelete(user: JwtPayload, dto: BulkDeleteOutletsDto) {
    const clientId = user.clientId;
    const { outletIds } = dto;

    // Scope by the outlet's OWN clientId — ownerless (pre-KYC) outlets have no partner.
    const outlets = await this.prisma.outlet.findMany({
      where: { id: { in: outletIds }, deletedAt: null, clientId },
      select: { id: true },
    });

    if (outlets.length === 0) {
      throw new BadRequestException('No active outlets found for the given IDs');
    }

    const activeOutletIds = outlets.map((o) => o.id);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.outlet.updateMany({
        where: { id: { in: activeOutletIds } },
        data: { deletedAt: now, isActive: false },
      });
      await tx.salesUserAssignment.updateMany({
        where: { outletId: { in: activeOutletIds }, unassignedAt: null },
        data: { unassignedAt: now },
      });
      await tx.auditLog.create({
        data: {
          action: 'DELETE',
          entityType: 'OUTLET',
          entityId: 'BULK',
          actorId: user.sub,
          oldValues: { outletIds: activeOutletIds },
          metadata: { action: 'bulk_soft_delete', count: activeOutletIds.length },
        },
      });
    });

    return {
      deleted: activeOutletIds.length,
      notFound: outletIds.length - activeOutletIds.length,
    };
  }

  /**
   * POST /v1/admin/outlets/deactivate — mark active outlets inactive by outletCode.
   * Closes open SalesUserAssignments so the ISR loses visibility.
   */
  async deactivate(user: JwtPayload, dto: OutletCodesDto) {
    const clientId = user.clientId;
    const { outletCodes } = dto;

    const outlets = await this.prisma.outlet.findMany({
      where: { outletCode: { in: outletCodes }, isActive: true, deletedAt: null, clientId },
      select: { id: true, outletCode: true },
    });

    if (outlets.length === 0) {
      // Benign no-op (nothing active among these codes) — return zero + notFound rather than a 400,
      // consistent with park()/unpark(), so a multi-batch deactivate isn't aborted (and earlier
      // batches discarded) by an all-no-op tail. No write happens.
      return {
        deactivated: 0,
        notFound: outletCodes,
        message: `0 outlet(s) deactivated. ${outletCodes.length} code(s) not found or already inactive.`,
      };
    }

    const activeIds = outlets.map((o) => o.id);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.outlet.updateMany({
        where: { id: { in: activeIds } },
        data: { isActive: false, deactivatedAt: now },
      });
      await tx.salesUserAssignment.updateMany({
        where: { outletId: { in: activeIds }, unassignedAt: null },
        data: { unassignedAt: now },
      });

      // Kick partners whose LAST active outlet was just deactivated: revoke their
      // live sessions so an already-open app stops working immediately (the login
      // + refresh gates in AuthService then block re-entry). A multi-outlet partner
      // who still has an active outlet keeps their session. 3 set-based queries,
      // independent of batch size.
      const deactivated = await tx.outlet.findMany({
        where: { id: { in: activeIds } },
        select: { partnerId: true },
      });
      const partnerIds = [
        ...new Set(deactivated.map((o) => o.partnerId).filter((p): p is string => !!p)),
      ];
      if (partnerIds.length > 0) {
        const stillActive = await tx.outlet.groupBy({
          by: ['partnerId'],
          where: { partnerId: { in: partnerIds }, clientId, isActive: true, deletedAt: null },
        });
        const stillActiveIds = new Set(stillActive.map((g) => g.partnerId));
        const strandedPartnerIds = partnerIds.filter((p) => !stillActiveIds.has(p));
        if (strandedPartnerIds.length > 0) {
          const partners = await tx.channelPartner.findMany({
            where: { id: { in: strandedPartnerIds } },
            select: { userId: true },
          });
          const userIds = partners.map((p) => p.userId).filter((u): u is string => !!u);
          if (userIds.length > 0) {
            // AUTHORITATIVE (1b): STAMP BEFORE REVOKE — stamp the stranded owners so a
            // concurrent refresh can't mint a surviving successor of a now-deactivated
            // outlet's owner, then revoke their live sessions. Consistent with logout-all /
            // KYC-phone-change (see auth.service.refreshToken's post-mint re-read).
            await tx.user.updateMany({
              where: { id: { in: userIds } },
              data: { sessionsInvalidBefore: now },
            });
            await tx.userSession.updateMany({
              where: { userId: { in: userIds }, revokedAt: null },
              data: { revokedAt: now },
            });
          }
        }
      }
    });

    const notFound = outletCodes.filter((c) => !outlets.some((o) => o.outletCode === c));

    return {
      deactivated: outlets.length,
      notFound,
      message: `${outlets.length} outlet(s) deactivated${notFound.length > 0 ? `. ${notFound.length} code(s) not found or already inactive.` : '.'}`,
    };
  }

  /**
   * POST /v1/admin/outlets/reactivate — flip a genuinely-DEACTIVATED outlet back
   * to active by outletCode.
   *
   * SECURITY: the match REQUIRES `deactivatedAt != null` — i.e. the outlet was once
   * active and then turned off. A KYC-PENDING outlet (created `isActive:false` with
   * `deactivatedAt:null`, never approved) MUST NOT be reachable here: activating it
   * would bypass the KYC-approval gate that is the only intended activator of a
   * pending outlet, inserting a never-vetted outlet into "active" counts and silently
   * clearing a rep's NOT_INTERESTED mark. This mirrors the bulk-upsert reactivate
   * guard (`!isActive && deactivatedAt != null`, see buildOutletUpdate).
   */
  async reactivate(user: JwtPayload, dto: OutletCodesDto) {
    const clientId = user.clientId;
    const { outletCodes } = dto;

    const outlets = await this.prisma.outlet.findMany({
      // `deactivatedAt: { not: null }` selects only rows that were explicitly
      // deactivated (never-approved PENDING outlets have deactivatedAt=null and are
      // excluded). Prisma's `{ not: null }` here is the intended NULL-exclusion,
      // NOT the trap-2 NULL-drop — we WANT to drop the null (pending) rows.
      where: {
        outletCode: { in: outletCodes },
        isActive: false,
        deactivatedAt: { not: null },
        deletedAt: null,
        clientId,
      },
      select: { id: true, outletCode: true },
    });

    if (outlets.length === 0) {
      throw new BadRequestException(
        'No deactivated outlets found for the given outlet codes. ' +
          'A KYC-pending outlet that was never approved cannot be reactivated — ' +
          'only outlets that were previously active and then deactivated.',
      );
    }

    const inactiveIds = outlets.map((o) => o.id);

    await this.prisma.outlet.updateMany({
      where: { id: { in: inactiveIds } },
      // Clear deactivatedAt so a reactivated outlet no longer reads as "deactivated"
      // (e.g. in the Outlet Master export's Deactivated-At column).
      // Also clear the not-interested intent: re-opening an outlet for enrollment
      // (admin-only) un-marks it as "Not Interested".
      data: {
        isActive: true,
        reactivatedAt: new Date(),
        deactivatedAt: null,
        kycIntent: null,
        kycIntentBy: null,
        kycIntentAt: null,
      },
    });

    const notFound = outletCodes.filter((c) => !outlets.some((o) => o.outletCode === c));

    return {
      reactivated: outlets.length,
      notFound,
      message: `${outlets.length} outlet(s) reactivated${notFound.length > 0 ? `. ${notFound.length} code(s) not found or already active.` : '.'}`,
    };
  }

  /**
   * POST /v1/admin/outlets/park — PARK KYC-pending outlets by outletCode so they are
   * FULLY hidden from sales reps (sales.buildOutlets / rollups / getMember all exclude
   * PARKED). Reversible via unpark(). PARKED is a NEW, distinct state — it does NOT touch
   * the NOT_INTERESTED path.
   *
   * SECURITY: only NOT-YET-APPROVED pending outlets are eligible — a pending outlet is
   * created `isActive:false` and only flips to `isActive:true` on KYC approval, so the
   * `isActive:false` filter guarantees an approved/active outlet is SKIPPED (those are
   * removed via Deactivate, not Park). No partner/login exists on a pending outlet, so no
   * session-revoke is needed and a single updateMany suffices.
   */
  async park(user: JwtPayload, dto: OutletCodesDto) {
    const clientId = user.clientId;
    const { outletCodes } = dto;

    // Match TRUE KYC-pending outlets only: non-deleted, not-yet-approved (isActive:false),
    // and NEVER-deactivated (deactivatedAt:null). Approved/active outlets (isActive:true) are
    // excluded → Park never hides a live outlet. Genuinely-deactivated outlets (deactivatedAt
    // set) belong to the deactivate/reactivate lifecycle — keeping Park to deactivatedAt:null
    // keeps the two lifecycles cleanly separate (a deactivated outlet is already hidden; its
    // restore path is reactivate, which requires deactivatedAt!=null).
    const outlets = await this.prisma.outlet.findMany({
      where: {
        outletCode: { in: outletCodes },
        clientId,
        deletedAt: null,
        isActive: false,
        deactivatedAt: null,
        // Skip outlets ALREADY parked so a re-upload doesn't overwrite the original
        // kycIntentBy/At (preserves who first parked it). {not:'PARKED'} drops NULLs, so
        // the {null} OR-branch keeps the common null-intent pending outlets.
        OR: [{ kycIntent: null }, { kycIntent: { not: OutletKycIntent.PARKED } }],
      },
      select: { id: true, outletCode: true },
    });

    if (outlets.length === 0) {
      // Benign no-op (all codes already parked / not pending) — return zero + report every code
      // as notFound rather than a 400, and never write (can't hide a live outlet). This keeps a
      // multi-batch upload from aborting and discarding earlier successful batches on an
      // all-no-op tail batch (the batched FE treats any non-2xx as a hard, work-discarding failure).
      return { parked: 0, notFound: outletCodes };
    }

    const ids = outlets.map((o) => o.id);
    await this.prisma.outlet.updateMany({
      where: { id: { in: ids } },
      data: { kycIntent: OutletKycIntent.PARKED, kycIntentBy: user.sub, kycIntentAt: new Date() },
    });

    const notFound = outletCodes.filter((c) => !outlets.some((o) => o.outletCode === c));

    return { parked: outlets.length, notFound };
  }

  /**
   * POST /v1/admin/outlets/unpark — reverse park(): clear the PARKED intent by outletCode
   * so the outlet is visible to reps again. Only rows currently `kycIntent:'PARKED'` in the
   * caller's tenant are matched, so a NOT_INTERESTED (or clean) outlet is never disturbed.
   */
  async unpark(user: JwtPayload, dto: OutletCodesDto) {
    const clientId = user.clientId;
    const { outletCodes } = dto;

    const outlets = await this.prisma.outlet.findMany({
      where: { outletCode: { in: outletCodes }, clientId, kycIntent: OutletKycIntent.PARKED },
      select: { id: true, outletCode: true },
    });

    if (outlets.length === 0) {
      // Benign no-op (nothing currently parked among these codes) — return zero + notFound rather
      // than a 400, so a multi-batch un-park (or the master upload's un-park step) isn't aborted
      // and earlier successful batches aren't discarded.
      return { unparked: 0, notFound: outletCodes };
    }

    const ids = outlets.map((o) => o.id);
    await this.prisma.outlet.updateMany({
      where: { id: { in: ids } },
      data: { kycIntent: null, kycIntentBy: null, kycIntentAt: null },
    });

    const notFound = outletCodes.filter((c) => !outlets.some((o) => o.outletCode === c));

    return { unparked: outlets.length, notFound };
  }
}
