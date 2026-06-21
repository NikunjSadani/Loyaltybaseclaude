import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { KycStatus, OutletKycIntent, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  BulkDeleteOutletsDto,
  OutletCodesDto,
  OutletUploadRowDto,
  ReKycFlagDto,
  ReKycFlagRowDto,
  UpsertOutletsDto,
} from './dto/admin-outlets.dto';

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

/** create payload for a new Outlet — partnerId omitted (NULL); created PENDING. */
function buildOutletCreate(
  clientId: string,
  outletCode: string,
  data: OutletWriteData,
): Prisma.OutletUncheckedCreateInput {
  return { clientId, outletCode, isActive: false, ...data };
}

/** update payload for an existing Outlet — identity + isActive left untouched. */
function buildOutletUpdate(data: OutletWriteData): Prisma.OutletUncheckedUpdateInput {
  return { ...data };
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
  action: 'CREATE' | 'UPDATE';
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

  constructor(private readonly prisma: PrismaService) {}

  /** GET /v1/admin/outlets — tenant-scoped outlet list with the active XSR and real KYC status. */
  async list(user: JwtPayload) {
    const outlets = await this.prisma.outlet.findMany({
      where: { deletedAt: null, clientId: user.clientId },
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
    });

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

    /**
     * Derive the display KYC status for a single outlet.
     * Priority:
     *   1. reKycFlags non-null ⇒ RE_KYC_REQUIRED
     *   2. kycIntent === NOT_INTERESTED ⇒ NOT_STARTED (outlet declined)
     *   3. Latest submission status mapped to the UI enum
     *   4. No submission ⇒ NOT_STARTED
     */
    function deriveKycStatus(
      reKycFlags: unknown,
      kycIntent: OutletKycIntent | null,
      partnerId: string | null,
    ): string {
      // Only a NON-EMPTY reKycFlags object means re-KYC is pending; an empty {}
      // (or null) must not falsely flag the outlet.
      if (
        reKycFlags !== null &&
        typeof reKycFlags === 'object' &&
        Object.keys(reKycFlags as Record<string, unknown>).length > 0
      ) {
        return 'RE_KYC_REQUIRED';
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
        kycStatus: deriveKycStatus(o.reKycFlags, o.kycIntent, o.partnerId),
        isActive: o.isActive,
        addedDate: o.createdAt.toISOString().slice(0, 10),
      };
    });

    return { outlets: mapped };
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

    const rowResults: UpsertRowResult[] = [];
    let created = 0;
    let updated = 0;
    const now = new Date();

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

      if (errors.length > 0 || !outletTypeId) {
        rowResults.push({ rowNum: row.rowNum, outletId: outletCode, status: 'ERROR', action: 'CREATE', errors });
        continue;
      }

      const data = mapRowToOutletData(row, outletTypeId);

      // 3. Upsert the outlet + (re)tag to the XSR in one transaction.
      const action = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.outlet.findUnique({
          where: { clientId_outletCode: { clientId, outletCode } },
          select: { id: true },
        });

        const outlet = await tx.outlet.upsert({
          where: { clientId_outletCode: { clientId, outletCode } },
          create: buildOutletCreate(clientId, outletCode, data),
          update: buildOutletUpdate(data),
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

        return existing ? ('UPDATE' as const) : ('CREATE' as const);
      });

      if (action === 'CREATE') created++;
      else updated++;
      rowResults.push({ rowNum: row.rowNum, outletId: outletCode, status: 'OK', action, errors: [] });
    }

    const errorRows = rowResults.filter((r) => r.status === 'ERROR');
    return {
      created,
      updated,
      errors: errorRows,
      rows: rowResults,
      message: `${created} created, ${updated} updated${errorRows.length ? `, ${errorRows.length} row(s) failed` : ''}`,
    };
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
      throw new BadRequestException('No active outlets found for the given outlet codes');
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
    });

    const notFound = outletCodes.filter((c) => !outlets.some((o) => o.outletCode === c));

    return {
      deactivated: outlets.length,
      notFound,
      message: `${outlets.length} outlet(s) deactivated${notFound.length > 0 ? `. ${notFound.length} code(s) not found or already inactive.` : '.'}`,
    };
  }

  /**
   * POST /v1/admin/outlets/reactivate — flip inactive (not soft-deleted) outlets
   * back to active by outletCode.
   */
  async reactivate(user: JwtPayload, dto: OutletCodesDto) {
    const clientId = user.clientId;
    const { outletCodes } = dto;

    const outlets = await this.prisma.outlet.findMany({
      where: { outletCode: { in: outletCodes }, isActive: false, deletedAt: null, clientId },
      select: { id: true, outletCode: true },
    });

    if (outlets.length === 0) {
      throw new BadRequestException('No inactive outlets found for the given outlet codes');
    }

    const inactiveIds = outlets.map((o) => o.id);

    await this.prisma.outlet.updateMany({
      where: { id: { in: inactiveIds } },
      data: { isActive: true, reactivatedAt: new Date() },
    });

    const notFound = outletCodes.filter((c) => !outlets.some((o) => o.outletCode === c));

    return {
      reactivated: outlets.length,
      notFound,
      message: `${outlets.length} outlet(s) reactivated${notFound.length > 0 ? `. ${notFound.length} code(s) not found or already active.` : '.'}`,
    };
  }
}
