import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  acquireIdentityLocks,
  checkGroupUniqueness,
  normalizeIdentityValue,
  type PartnerIdentityDetails,
  type UniquenessPolicy,
} from '../common/partner-group.helper';
import { CreateParentDto } from './dto/admin-parents.dto';

/** "" / whitespace → null so blank inputs don't persist empty strings. */
function nullTrim(v: string | undefined | null): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

/**
 * Admin · Parent owners — the non-operating owner entity of the parent-child owner-group
 * feature (docs/plans/PARTNER-MULTI-OUTLET.md §2.2). A parent is a `ChannelPartner` with
 * `isParent=true`; it is created LOGIN-LESS (userId=null) and WALLET-LESS, holds the group's
 * golden-key details, and groups child outlets via `Outlet.parentId` (set by the admin
 * outlet-master upload). Excluded from every partner-facing list/KPI by an `isParent:false`
 * filter (the leak-filter sites).
 *
 * IMPORTANT — a parent must NEVER receive a spendable wallet. Neither `createParent` nor
 * `approveParent` touches `Wallet`, so the parent stays wallet-less by construction. This is
 * a DIFFERENT approval path from the outlet KYC path (kyc.service.approve, which creates a
 * wallet at approval) — see the report / the recommended defence-in-depth guard.
 */
@Injectable()
export class ParentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  private async policy(clientId: string): Promise<UniquenessPolicy> {
    const settings = await this.tenantSettings.getEffectiveSettings(clientId);
    return settings.uniquenessPolicy ?? { gst: true, phone: true, bank: false, upi: false };
  }

  /**
   * GET /v1/admin/parents — the tenant's parent owners (isParent=true).
   * `pendingApproval` = carries details but not yet approved (onboardedAt still null).
   */
  async listParents(user: JwtPayload) {
    const clientId = user.clientId;
    const parents = await this.prisma.channelPartner.findMany({
      where: { clientId, isParent: true, deletedAt: null },
      select: {
        id: true,
        partnerCode: true,
        businessName: true,
        ownerName: true,
        phone: true,
        gstNumber: true,
        panNumber: true,
        bankAccountNumber: true,
        upiId: true,
        isActive: true,
        onboardedAt: true,
        _count: { select: { childOutlets: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return {
      parents: parents.map((p) => {
        const hasDetails = !!(p.gstNumber || p.panNumber || p.bankAccountNumber || p.upiId);
        return {
          ...p,
          childOutletCount: p._count.childOutlets,
          pendingApproval: hasDetails && p.onboardedAt == null,
        };
      }),
    };
  }

  /**
   * POST /v1/admin/parents — create a parent owner. Minimum = `partnerCode`.
   *
   * - Created LOGIN-LESS (userId=null) + WALLET-LESS.
   * - If it carries any identity detail, those details are cross-group-unique-checked
   *   (the parent anchors a brand-new, empty group, so any existing outlet carrying the same
   *   PAN/enforced field is "outside" → blocked). To reuse an existing outlet's PAN, create
   *   the parent WITHOUT that PAN (bare) and let the group PAN derive from the first grouped
   *   child (resolveGroupPan / §8).
   * - When details are present the parent is left UNAPPROVED (onboardedAt=null) awaiting
   *   `approveParent`; a bare ID-only parent has nothing to review → immediately usable.
   */
  async createParent(user: JwtPayload, dto: CreateParentDto) {
    const clientId = user.clientId;
    const partnerCode = dto.partnerCode.trim();
    if (!partnerCode) throw new BadRequestException('Parent ID (partnerCode) is required');

    const existing = await this.prisma.channelPartner.findUnique({
      where: { clientId_partnerCode: { clientId, partnerCode } },
      select: { id: true },
    });
    if (existing) throw new BadRequestException(`A partner with code "${partnerCode}" already exists`);

    // CANONICAL identity values — PAN/GST upper-cased, bank/UPI trimmed (helper §normalizeIdentityValue).
    // The comparison, the advisory lock, the partial-unique DB index, AND the persisted column MUST all
    // use the SAME form; persisting a raw/lower-cased value would let a case variant slip past both the
    // app check (which upper-cases) and the case-sensitive partial-unique index — defeating the golden key.
    const details: PartnerIdentityDetails = {
      gstNumber: normalizeIdentityValue('gst', dto.gstNumber),
      panNumber: normalizeIdentityValue('pan', dto.panNumber),
      bankAccountNumber: normalizeIdentityValue('bank', dto.bankAccountNumber),
      upiId: normalizeIdentityValue('upi', dto.upiId),
    };
    const hasDetails = !!(
      details.gstNumber ||
      details.panNumber ||
      details.bankAccountNumber ||
      details.upiId
    );

    const policy = await this.policy(clientId);
    const now = new Date();

    // The uniqueness CHECK + the CREATE run in ONE interactive tx, with a per-value advisory lock
    // taken BEFORE the check, so a concurrent writer of the same identity value serializes behind us
    // (bank/UPI have NO DB index → this lock is their ONLY race guard). A partial-unique index P2002
    // (a race that beats the lock, or a concurrent same-partnerCode insert) is mapped to a clean 400,
    // never a raw 500 — mirrors kyc.service.createPartnerWithUniqueCode.
    const parent = await this.prisma.$transaction(async (tx) => {
      if (hasDetails) {
        await acquireIdentityLocks(tx, { clientId, details, policy });
        // ourParentId=null → an empty (brand-new) group: any existing match is outside it.
        const violation = await checkGroupUniqueness(tx, {
          clientId,
          ourParentId: null,
          details,
          policy,
          exceptPartnerId: null,
        });
        if (violation) throw new BadRequestException(violation.message);
      }

      try {
        return await tx.channelPartner.create({
          data: {
            clientId,
            partnerCode,
            isParent: true,
            userId: null, // login-less at create (HARD constraint)
            businessName: nullTrim(dto.businessName) ?? partnerCode,
            ownerName: nullTrim(dto.ownerName) ?? 'Owner Group',
            phone: nullTrim(dto.phone),
            email: nullTrim(dto.email),
            gstNumber: details.gstNumber,
            panNumber: details.panNumber,
            bankName: nullTrim(dto.bankName),
            bankAccountNumber: details.bankAccountNumber,
            bankAccountHolder: nullTrim(dto.bankAccountHolder),
            ifscCode: nullTrim(dto.ifscCode),
            upiId: details.upiId,
            isActive: true,
            // onboardedAt = the parent's approval marker. A detailed parent awaits Gifsy review
            // (null); a bare ID-only anchor has nothing to review → approved on create.
            onboardedAt: hasDetails ? null : now,
          },
        });
      } catch (e) {
        // A partial-unique index P2002 (an identity race that beat the advisory lock, or a
        // concurrent insert of the same partnerCode) surfaces as a clean 400. Do NOT retry — the
        // tx is already aborted; a retried statement throws "current transaction is aborted".
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new BadRequestException(
            "This parent's ID or one of its identity details (PAN/GST/bank/UPI) is already registered in this tenant.",
          );
        }
        throw e;
      }
    });

    await this.prisma.auditLog.create({
      data: {
        action: 'CREATE',
        entityType: 'CHANNEL_PARTNER',
        entityId: parent.id,
        actorId: user.sub,
        newValues: { partnerCode, isParent: true, hasDetails },
        metadata: { kind: 'PARENT_OWNER', pendingGifsyApproval: hasDetails },
      },
    });

    return { parent, pendingGifsyApproval: hasDetails };
  }

  /**
   * POST /v1/admin/parents/:id/approve — straight-to-Gifsy approval of a parent's OWN
   * details (§2.2). Skips the sales/first-approver stage entirely. WALLET-LESS: this never
   * creates a `Wallet` and never activates any outlet (a parent operates nothing). Re-runs
   * the cross-group uniqueness check on the parent's details against its (now possibly
   * populated) group before approving.
   */
  async approveParent(user: JwtPayload, parentId: string) {
    const clientId = user.clientId;
    const parent = await this.prisma.channelPartner.findFirst({
      where: { id: parentId, clientId, isParent: true, deletedAt: null },
      select: {
        id: true,
        userId: true,
        onboardedAt: true,
        gstNumber: true,
        panNumber: true,
        bankAccountNumber: true,
        upiId: true,
      },
    });
    if (!parent) throw new NotFoundException('Parent owner not found');

    // CANONICAL identity values (helper §normalizeIdentityValue). Re-persisted on the update below
    // so a parent that was stored un-normalized (e.g. a legacy lower-case PAN/GST) is canonicalised
    // at approval — keeping the stored value equal to the form the app check + partial-unique DB
    // index rely on.
    const policy = await this.policy(clientId);
    const details: PartnerIdentityDetails = {
      gstNumber: normalizeIdentityValue('gst', parent.gstNumber),
      panNumber: normalizeIdentityValue('pan', parent.panNumber),
      bankAccountNumber: normalizeIdentityValue('bank', parent.bankAccountNumber),
      upiId: normalizeIdentityValue('upi', parent.upiId),
    };
    const now = new Date();

    // Check + write in ONE interactive tx, advisory-locked BEFORE the check (bank/UPI have no DB
    // index → the lock is their only race guard). A partial-unique index P2002 → clean 400.
    const updated = await this.prisma.$transaction(async (tx) => {
      await acquireIdentityLocks(tx, { clientId, details, policy });
      const violation = await checkGroupUniqueness(tx, {
        clientId,
        ourParentId: parent.id, // its own group (children share its parentId)
        details,
        policy,
        exceptPartnerId: parent.id, // exclude self from the clash search
      });
      if (violation) throw new BadRequestException(violation.message);

      try {
        const u = await tx.channelPartner.update({
          where: { id: parent.id },
          data: {
            onboardedAt: now,
            isActive: true,
            // Re-persist canonical identity values (defense-in-depth normalisation).
            gstNumber: details.gstNumber,
            panNumber: details.panNumber,
            bankAccountNumber: details.bankAccountNumber,
            upiId: details.upiId,
          },
        });

        // If the parent gained a login user (a phone-backed parent, wired by a later stream),
        // activate it. NO wallet, NO outlet activation — a parent operates nothing. (Same tx, so
        // it rolls back with the update on any failure.)
        if (parent.userId) {
          await tx.user.update({
            where: { id: parent.userId },
            data: { status: 'ACTIVE' },
          });
        }

        return u;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new BadRequestException(
            "This parent's identity details (PAN/GST/bank/UPI) are already registered in this tenant.",
          );
        }
        throw e;
      }
    });

    await this.prisma.auditLog.create({
      data: {
        action: 'APPROVE',
        entityType: 'CHANNEL_PARTNER',
        entityId: parent.id,
        actorId: user.sub,
        oldValues: { onboardedAt: parent.onboardedAt ? parent.onboardedAt.toISOString() : null },
        newValues: { onboardedAt: now.toISOString() },
        metadata: { kind: 'PARENT_OWNER', stage: 'GIFSY' },
      },
    });

    return { parent: updated, approved: true };
  }
}
