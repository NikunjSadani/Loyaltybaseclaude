import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { KycStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  acquireIdentityLocks,
  checkGroupUniqueness,
  childSharesDetailWithGroup,
  normalizeIdentityValue,
  resolveUniquenessPolicy,
  type PartnerIdentityDetails,
  type UniquenessPolicy,
} from '../common/partner-group.helper';
import { deriveKycStatus } from './admin-outlets.service';
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
    return resolveUniquenessPolicy(settings);
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
        _count: { select: { childOutlets: { where: { deletedAt: null } } } },
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
   * GET /v1/admin/parents/:id — one owner group's detail (the admin grouping drill-in).
   * Tenant-scoped EXACTLY like listParents (the caller's clientId; a parent from another tenant
   * → 404). Returns the same parent field-set as a list row + the group's child outlets, each with
   * its derived KYC status and whether it may be un-grouped.
   *
   * `canUngroup` is the EXACT inverse of the un-group block — it calls the SAME shared
   * `childSharesDetailWithGroup` the dedicated un-group action (AdminOutletsService.ungroupOutlet)
   * uses, so the flag the UI shows and the guard the action enforces can never diverge. Groups are
   * small; the per-child share-check (2 bounded reads each) runs concurrently.
   */
  async getParent(user: JwtPayload, parentId: string) {
    const clientId = user.clientId;

    const parent = await this.prisma.channelPartner.findFirst({
      where: { id: parentId, clientId, isParent: true, deletedAt: null },
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
        _count: { select: { childOutlets: { where: { deletedAt: null } } } },
      },
    });
    if (!parent) throw new NotFoundException('Parent owner not found');

    // The group's child outlets (Outlet.parentId = this parent) + the owner details the share-check
    // reads + the fields deriveKycStatus needs. Ordered oldest-first for a stable UI list.
    const childOutlets = await this.prisma.outlet.findMany({
      where: { clientId, parentId: parent.id, deletedAt: null },
      select: {
        id: true,
        outletCode: true,
        name: true,
        isActive: true,
        partnerId: true,
        reKycFlags: true,
        kycIntent: true,
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
      orderBy: { createdAt: 'asc' },
    });

    // Latest KycStatus per child partner (batched, no N+1) — the SAME derivation the admin outlet
    // list uses (shared deriveKycStatus), so the two never disagree.
    const partnerIds = [
      ...new Set(childOutlets.map((o) => o.partnerId).filter((id): id is string => id !== null)),
    ];
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

    const policy = await this.policy(clientId);

    const children = await Promise.all(
      childOutlets.map(async (o) => {
        const shares = await childSharesDetailWithGroup(this.prisma, {
          clientId,
          parentId: parent.id,
          childOutletId: o.id,
          childPartner: o.partner,
          policy,
        });
        return {
          outletCode: o.outletCode,
          name: o.name,
          kycStatus: deriveKycStatus(o.reKycFlags, o.kycIntent, o.partnerId, latestStatusByPartnerId),
          isActive: o.isActive,
          canUngroup: !shares,
          ungroupBlockReason: shares
            ? 'Shares identity details with the group — make them distinct via re-KYC first.'
            : null,
        };
      }),
    );

    const hasDetails = !!(
      parent.gstNumber ||
      parent.panNumber ||
      parent.bankAccountNumber ||
      parent.upiId
    );
    return {
      parent: {
        id: parent.id,
        partnerCode: parent.partnerCode,
        businessName: parent.businessName,
        ownerName: parent.ownerName,
        phone: parent.phone,
        gstNumber: parent.gstNumber,
        panNumber: parent.panNumber,
        bankAccountNumber: parent.bankAccountNumber,
        upiId: parent.upiId,
        isActive: parent.isActive,
        onboardedAt: parent.onboardedAt,
        childOutletCount: parent._count.childOutlets,
        pendingApproval: hasDetails && parent.onboardedAt == null,
      },
      children,
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

  /**
   * POST /v1/admin/parents/:id/deactivate — dissolve (soft-delete) an owner group's parent.
   * Tenant-scoped like the others. GUARDED: refuses while the group still has ANY child outlet
   * (Outlet.parentId = this parent, not soft-deleted) — the admin must un-group them first. Does
   * NOT cascade. Soft-deletes only (deletedAt + isActive=false); the `outlets` trigger keeps the
   * derived groupId in lockstep (we never write it here).
   */
  async deactivateParent(user: JwtPayload, parentId: string) {
    const clientId = user.clientId;

    const parent = await this.prisma.channelPartner.findFirst({
      where: { id: parentId, clientId, isParent: true, deletedAt: null },
      select: { id: true },
    });
    if (!parent) throw new NotFoundException('Parent owner not found');

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // A parent that still groups outlets cannot be dissolved — un-grouping is a dedicated action,
      // so we never orphan or silently un-link children by deactivating their parent. The count runs
      // INSIDE the tx (not before it) so the guard and the soft-delete commit together — a concurrent
      // add-to-parent link can't slip a live child in between a pre-tx check and the delete (TOCTOU).
      const childCount = await tx.outlet.count({
        where: { clientId, parentId: parent.id, deletedAt: null },
      });
      if (childCount > 0) {
        throw new BadRequestException(
          `Cannot deactivate — this owner group still has ${childCount} child outlet(s). Un-group them first.`,
        );
      }
      await tx.channelPartner.update({
        where: { id: parent.id },
        data: { deletedAt: now, isActive: false },
      });
      await tx.auditLog.create({
        data: {
          action: 'DELETE',
          entityType: 'CHANNEL_PARTNER',
          entityId: parent.id,
          actorId: user.sub,
          newValues: { deletedAt: now.toISOString(), isActive: false },
          metadata: { kind: 'PARENT_OWNER', action: 'deactivate' },
        },
      });
    });

    return { id: parent.id, deactivated: true };
  }
}
