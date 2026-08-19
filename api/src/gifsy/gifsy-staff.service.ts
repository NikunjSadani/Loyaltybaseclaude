import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide } from '../common/tenant-scope';
import {
  isActivePhoneConflict,
  ACTIVE_PHONE_IN_USE_MSG,
} from '../common/phone-conflict';
import { CreateGifsyStaffDto, UpdateGifsyStaffDto } from './dto/gifsy-staff.dto';
import { GifsyTenantGrantService } from '../common/rbac/gifsy-tenant-grant.service';

/**
 * RBAC Option-X (P1) — Gifsy STAFF management.
 *
 * "Staff" are platform operators BELOW the GIFSY_ADMIN owner: `role: 'GIFSY_STAFF'`,
 * `clientId: 'gifsy'`, with their effective permission set resolved from an assigned
 * custom `GifsyRole` (user.gifsyRoleId). Owner-only surface: every method re-gates with
 * `platformWide(user)` so an ASSUMED GIFSY operator (JWT pinned to a tenant) is rejected
 * even though @Roles('GIFSY_ADMIN') would admit them.
 *
 * ── The auth invariant this service exists to uphold ──────────────────────────────────
 * `role` AND `gifsyRoleId` ride the JWT. So a live access token keeps the OLD access until
 * it expires, and the holder could REFRESH to mint a fresh one — meaning a deactivated or
 * reassigned staff member would retain their old powers unless we cut the session. Whenever
 * we DEACTIVATE, REASSIGN the role, or CHANGE the phone, we therefore (1) stamp
 * `users.sessionsInvalidBefore = now` (folded into the row mutation — ONE committed
 * statement) and THEN (2) revoke every live session as a SEPARATE committed statement.
 * This ordering — the stamp committed BEFORE the sweep, NOT both inside one interactive
 * $transaction — is the exact guarantee AdminCoreService.revokeAllSessionsForUser and the
 * auth reuse-detection path rely on: the committed stamp is the high-water mark the refresh
 * path's post-mint re-read observes (auth.service.ts:563-584), so an in-flight refresh that
 * mints a successor after our sweep is still caught and cannot out-race the revoke. Wrapping
 * stamp+sweep in a single $transaction would hide the stamp until commit and reopen that
 * race (a permanently-renewable surviving session) — see the inline note in updateStaff.
 * A change that only edits the name/email leaves the token's authority untouched → no revoke.
 */
@Injectable()
export class GifsyStaffService {
  private static readonly GIFSY_CLIENT_ID = 'gifsy';

  private readonly logger = new Logger(GifsyStaffService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: GifsyTenantGrantService,
  ) {}

  /**
   * Validate that every slug is a real tenant (Client row). Rejects typos up-front rather than
   * silently persisting a grant that can never be assumed. Any status is allowed (an ONBOARDING
   * brand like a pre-launch Bajaj is a valid grant target); assume-time re-checks ACTIVE/ONBOARDING.
   */
  private async assertClientsExist(clientIds: string[]): Promise<void> {
    if (clientIds.length === 0) return;
    const found = await this.prisma.client.findMany({
      where: { id: { in: clientIds } },
      select: { id: true },
    });
    const known = new Set(found.map((c) => c.id));
    const unknown = clientIds.filter((c) => !known.has(c));
    if (unknown.length > 0) {
      throw new BadRequestException(`Unknown brand(s): ${unknown.join(', ')}`);
    }
  }

  /**
   * Replace a staff's tenant grants with EXACTLY `clientIds` (set-semantics). Deletes rows no
   * longer present and inserts new ones, then invalidates the resolver cache so the change is
   * effective on the next request. Returns the set that was REMOVED (for the revoke decision).
   * The caller owns session revocation when the removed set is non-empty.
   */
  private async setGrants(
    userId: string,
    clientIds: string[],
    grantedBy: string,
  ): Promise<{ removed: string[] }> {
    const current = await this.prisma.gifsyStaffTenantGrant.findMany({
      where: { userId },
      select: { clientId: true },
    });
    const currentSet = new Set(current.map((g) => g.clientId));
    const nextSet = new Set(clientIds);
    const removed = [...currentSet].filter((c) => !nextSet.has(c));
    const added = clientIds.filter((c) => !currentSet.has(c));

    if (removed.length > 0) {
      await this.prisma.gifsyStaffTenantGrant.deleteMany({
        where: { userId, clientId: { in: removed } },
      });
    }
    if (added.length > 0) {
      await this.prisma.gifsyStaffTenantGrant.createMany({
        data: added.map((clientId) => ({ userId, clientId, grantedBy })),
        skipDuplicates: true,
      });
    }
    // Invalidate immediately so a removed tenant stops resolving on the next request (the
    // refresh backstop + the session sweep below then cut any live assumed session to it).
    this.grants.invalidate(userId);
    return { removed };
  }

  /** Shared owner-context gate — reject non-owner and assumed-tenant operators. */
  private assertOwner(user: JwtPayload): void {
    if (!platformWide(user)) throw new ForbiddenException('Forbidden');
  }

  /**
   * Best-effort audit trail for staff lifecycle (create / deactivate / reassign / edit). These
   * are security-relevant admin actions, but a failed audit write must NEVER break or mask the
   * operation it describes (which — for deactivate/reassign — has already committed the
   * session revocation), mirroring the auth security-event precedent. Distinctive entityType
   * 'GIFSY_STAFF' makes these queryable in the security feed.
   */
  private async audit(data: Prisma.AuditLogUncheckedCreateInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data });
    } catch (e) {
      this.logger.warn(`gifsy-staff audit write failed: ${String(e)}`);
    }
  }

  /** Fields returned to the UI for a staff row (includes the assigned role's display name). */
  private static readonly STAFF_SELECT = {
    id: true,
    name: true,
    phone: true,
    email: true,
    status: true,
    gifsyRoleId: true,
    gifsyRole: { select: { id: true, name: true } },
  } as const;

  /** List all (non-deleted) Gifsy staff with their assigned role name + tenant grants for display. */
  async listStaff(user: JwtPayload) {
    this.assertOwner(user);
    const staff = await this.prisma.user.findMany({
      where: {
        clientId: GifsyStaffService.GIFSY_CLIENT_ID,
        role: 'GIFSY_STAFF',
        deletedAt: null,
      },
      orderBy: { name: 'asc' },
      select: {
        ...GifsyStaffService.STAFF_SELECT,
        gifsyTenantGrants: { select: { clientId: true } },
      },
    });
    // Flatten grants → assumableClientIds (the FE contract) and drop the raw relation.
    return staff.map(({ gifsyTenantGrants, ...s }) => ({
      ...s,
      assumableClientIds: (gifsyTenantGrants ?? []).map((g) => g.clientId),
    }));
  }

  /** Create a new GIFSY_STAFF user assigned to an existing GifsyRole. */
  async createStaff(user: JwtPayload, dto: CreateGifsyStaffDto) {
    this.assertOwner(user);

    // The assigned role must exist, belong to 'gifsy', and not be soft-deleted.
    const role = await this.prisma.gifsyRole.findFirst({
      where: {
        id: dto.gifsyRoleId,
        clientId: GifsyStaffService.GIFSY_CLIENT_ID,
        deletedAt: null,
      },
    });
    if (!role) throw new BadRequestException('Assigned role not found.');

    // Validate any tenant grants up-front (before creating the user) so a typo fails cleanly.
    const grantClientIds = dto.assumableClientIds ?? [];
    await this.assertClientsExist(grantClientIds);

    let created;
    try {
      created = await this.prisma.user.create({
        data: {
          clientId: GifsyStaffService.GIFSY_CLIENT_ID,
          role: 'GIFSY_STAFF', // pinned — never taken from the client
          status: 'ACTIVE',
          name: dto.name.trim(),
          phone: dto.phone,
          email: dto.email ?? null,
          gifsyRoleId: dto.gifsyRoleId,
        },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          status: true,
          gifsyRoleId: true,
        },
      });
    } catch (e) {
      // A second ACTIVE user cannot hold a phone already held by an ACTIVE user in the tenant.
      if (isActivePhoneConflict(e)) {
        throw new BadRequestException(ACTIVE_PHONE_IN_USE_MSG);
      }
      // email is unique per client (users_clientId_email_key).
      if (this.isEmailConflict(e)) {
        throw new ConflictException('Email already in use.');
      }
      throw e;
    }

    // Create the initial tenant grants (if any). New user → no live sessions → no revoke needed.
    if (grantClientIds.length > 0) {
      await this.setGrants(created.id, grantClientIds, user.sub);
    }

    await this.audit({
      action: 'CREATE',
      entityType: 'GIFSY_STAFF',
      entityId: created.id,
      actorId: user.sub,
      targetUserId: created.id,
      metadata: {
        event: 'gifsy_staff_created',
        gifsyRoleId: dto.gifsyRoleId,
        roleName: role.name,
        phone: dto.phone,
        assumableClientIds: grantClientIds,
      },
    });

    return { ...created, assumableClientIds: grantClientIds };
  }

  /**
   * Update a staff member. Deactivate / reactivate / reassign-role / edit all flow here.
   *
   * Session-revocation contract (see class doc): a change to STATUS-off, gifsyRoleId, or
   * phone invalidates the authority the live JWT carries, so those paths stamp
   * `sessionsInvalidBefore` and revoke sessions ATOMICALLY with the row update. A pure
   * name/email edit does not.
   */
  async updateStaff(user: JwtPayload, id: string, dto: UpdateGifsyStaffDto) {
    this.assertOwner(user);

    const target = await this.prisma.user.findFirst({
      where: {
        id,
        clientId: GifsyStaffService.GIFSY_CLIENT_ID,
        role: 'GIFSY_STAFF',
      },
    });
    if (!target) throw new NotFoundException('Staff member not found.');

    // ── Classify intent ──────────────────────────────────────────────────────────────
    const deactivating = dto.status !== undefined && dto.status !== 'ACTIVE';
    const reactivating = dto.status === 'ACTIVE' && target.status !== 'ACTIVE';
    const reassigning =
      dto.gifsyRoleId !== undefined && dto.gifsyRoleId !== target.gifsyRoleId;
    const phoneChanging = dto.phone !== undefined && dto.phone !== target.phone;

    // A role reassignment must target an existing, live 'gifsy' role.
    if (reassigning) {
      const role = await this.prisma.gifsyRole.findFirst({
        where: {
          id: dto.gifsyRoleId!,
          clientId: GifsyStaffService.GIFSY_CLIENT_ID,
          deletedAt: null,
        },
      });
      if (!role) throw new BadRequestException('Assigned role not found.');
    }

    // Reactivation phone reclaim guard: only an ACTIVE user reserves (clientId, phone).
    // Before flipping this user back to ACTIVE, ensure the number it will hold is not
    // already reserved by another ACTIVE user (mirrors admin updateUser).
    if (reactivating) {
      const phoneToActivate = dto.phone ?? target.phone;
      const clash = await this.prisma.user.findFirst({
        where: {
          clientId: GifsyStaffService.GIFSY_CLIENT_ID,
          phone: phoneToActivate,
          status: 'ACTIVE',
          id: { not: id },
        },
        select: { id: true },
      });
      if (clash) {
        throw new BadRequestException(
          'This phone number is already in use by another active user. Change the phone number before reactivating this account.',
        );
      }
    }

    // ── Allow-listed update payload — NEVER touch `role`. ─────────────────────────────
    const updateData: Prisma.UserUpdateInput = {};
    if (dto.name !== undefined) updateData.name = dto.name.trim();
    if (dto.email !== undefined) updateData.email = dto.email ?? null;
    if (dto.phone !== undefined) updateData.phone = dto.phone;
    if (dto.status !== undefined) updateData.status = dto.status;
    if (dto.gifsyRoleId !== undefined) {
      // Relation field — set via the connect/disconnect scalar shorthand.
      updateData.gifsyRole = { connect: { id: dto.gifsyRoleId } };
    }
    // Reactivation fully restores a soft-deleted row (owner decision, mirrors admin path).
    // Only on reactivation — a plain deactivation must not clear deletedAt.
    if (reactivating) updateData.deletedAt = null;

    // RBAC Option-X (P5) — tenant grants (set-semantics; undefined = leave untouched). Validate
    // up-front, and pre-read whether this change REMOVES any tenant: a removal strips access the
    // live (possibly assumed) session carries, so it joins the revoke set. The grant rows
    // themselves are written AFTER a successful row update (below) so a failed edit (e.g. phone
    // conflict) leaves grants untouched.
    const changingGrants = dto.assumableClientIds !== undefined;
    let grantsReduced = false;
    if (changingGrants) {
      await this.assertClientsExist(dto.assumableClientIds!);
      const currentGrants = await this.prisma.gifsyStaffTenantGrant.findMany({
        where: { userId: id },
        select: { clientId: true },
      });
      const nextSet = new Set(dto.assumableClientIds!);
      grantsReduced = currentGrants.some((g) => !nextSet.has(g.clientId));
    }

    // Deactivate / reassign / phone-change / tenant-grant-removal all strip authority the live
    // JWT carries, so those paths stamp + revoke; a pure name/email edit (or a grant ADD-only) does not.
    const mustRevoke = deactivating || reassigning || phoneChanging || grantsReduced;
    const now = new Date();

    const staffSelect = {
      id: true,
      name: true,
      phone: true,
      email: true,
      status: true,
      gifsyRoleId: true,
    } as const;

    try {
      // (1) Mutate the row, folding in the sessionsInvalidBefore stamp when authority changes.
      //     CRITICAL: the stamp is its OWN committed statement, applied BEFORE the session
      //     sweep below — NOT both wrapped in one $transaction. Under READ COMMITTED a
      //     transaction's writes are invisible to other connections until it commits, so a
      //     combined stamp+sweep txn hides the stamp for the whole (interactive) txn window;
      //     a concurrent token refresh can then mint a successor session that (a) escapes the
      //     not-yet-visible sweep and (b) whose post-mint re-read of sessionsInvalidBefore
      //     misses the not-yet-committed stamp — leaving a live, permanently-renewable session
      //     that survives deactivation/reassignment. Committing the stamp first (then sweeping)
      //     matches every other stamper (AdminCoreService.revokeAllSessionsForUser, auth
      //     reuse-detection) so the refresh path's post-mint re-read observes the committed
      //     stamp (auth.service.ts:563-584).
      const updated = await this.prisma.user.update({
        where: { id },
        data: mustRevoke ? { ...updateData, sessionsInvalidBefore: now } : updateData,
        select: staffSelect,
      });

      // (2) Separate, independently-committed statement: revoke every live session. Because
      //     the stamp above is already committed, any successor a concurrent refresh mints
      //     after this sweep's snapshot is preceded by a committed stamp its post-mint re-read
      //     will observe → it self-revokes. (stamp-before-revoke, same authority logout-all uses.)
      if (mustRevoke) {
        await this.prisma.userSession.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: now },
        });
      }

      // Apply the tenant-grant set change ONLY after the row update + session sweep succeeded,
      // so a failed edit above never mutates grants. setGrants writes + invalidates the resolver
      // cache; any removed tenant's live session was already cut by the sweep (grantsReduced ⊆
      // mustRevoke), and the refresh backstop covers a missed sweep.
      if (changingGrants) {
        await this.setGrants(id, dto.assumableClientIds!, user.sub);
      }

      await this.audit({
        action: 'UPDATE',
        entityType: 'GIFSY_STAFF',
        entityId: id,
        actorId: user.sub,
        targetUserId: id,
        metadata: {
          event: 'gifsy_staff_updated',
          sessionsRevoked: mustRevoke,
          ...(reassigning
            ? { reassignedRole: { from: target.gifsyRoleId, to: dto.gifsyRoleId } }
            : {}),
          ...(deactivating ? { deactivated: dto.status } : {}),
          ...(reactivating ? { reactivated: true } : {}),
          ...(phoneChanging ? { phoneChanged: true } : {}),
          ...(changingGrants
            ? { assumableClientIds: dto.assumableClientIds, grantsReduced }
            : {}),
        },
      });

      return changingGrants
        ? { ...updated, assumableClientIds: dto.assumableClientIds }
        : updated;
    } catch (e) {
      // Backstops a phone edit/reactivation that races past the pre-check into the partial index.
      if (isActivePhoneConflict(e)) {
        throw new BadRequestException(
          reactivating
            ? 'This phone number is already in use by another active user. Change the phone number before reactivating this account.'
            : ACTIVE_PHONE_IN_USE_MSG,
        );
      }
      if (this.isEmailConflict(e)) {
        throw new ConflictException('Email already in use.');
      }
      throw e;
    }
  }

  /** True when `e` is a P2002 on the per-client email unique index (users_clientId_email_key). */
  private isEmailConflict(e: unknown): boolean {
    return (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002' &&
      String(e.meta?.target ?? '').includes('email')
    );
  }
}
