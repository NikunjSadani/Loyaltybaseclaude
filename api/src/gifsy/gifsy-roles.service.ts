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
  PERMISSION_GROUPS,
  permissionsForGroup,
  isPermission,
} from '../common/rbac/permissions';
import { RESERVED_PERMISSIONS, isReserved } from '../common/rbac/reserved-permissions';
import { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import { CreateGifsyRoleDto, UpdateGifsyRoleDto } from './dto/gifsy-roles.dto';

/**
 * RBAC Option-X (P1) — self-service Gifsy role-editor CRUD backend.
 *
 * These are the custom GifsyRole entities an OWNER (GIFSY_ADMIN) mints and edits
 * to delegate a curated slice of platform power to GIFSY_STAFF. All rows live
 * under the literal clientId 'gifsy' (these roles are platform-scoped, never
 * per-tenant).
 *
 * AUTH posture:
 *  - Every route is @Roles('GIFSY_ADMIN') + @RequirePermission('users:manage_roles').
 *  - Every method here RE-GATES with platformWide(user): an ASSUMED GIFSY operator
 *    (working inside a tenant) is NOT the platform owner and must be rejected even
 *    though @Roles alone would admit them. Fail-closed.
 *  - "Lock 1": granting a RESERVED (money/tenancy/role-admin) permission requires a
 *    conscious `allowReserved: true` override on the payload. Being reserved gates
 *    the GRANT, not the later use (see reserved-permissions.ts).
 */
@Injectable()
export class GifsyRolesService {
  /** All these roles are platform-scoped under this literal tenant key. */
  private static readonly GIFSY_CLIENT_ID = 'gifsy';

  private readonly logger = new Logger(GifsyRolesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gifsyRoles: GifsyRoleService,
  ) {}

  /**
   * Re-gate: reject anyone who is not the platform owner in TRUE platform context
   * (blocks an assumed GIFSY operator that @Roles would otherwise let through).
   */
  private assertOwner(user: JwtPayload): void {
    if (!platformWide(user)) throw new ForbiddenException('Forbidden');
  }

  /**
   * Best-effort audit trail. A role grant/edit/delete is security-relevant (esp. reserved
   * grants), so we record it — but a failed audit write must NEVER break or mask the actual
   * operation it describes (which has already committed), mirroring the auth security-event
   * precedent. Distinctive entityType 'GIFSY_ROLE' makes these queryable in the security feed.
   */
  private async audit(data: Prisma.AuditLogUncheckedCreateInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data });
    } catch (e) {
      this.logger.warn(`gifsy-role audit write failed: ${String(e)}`);
    }
  }

  /**
   * The permission catalog for the FE editor: every group with its permissions,
   * each flagged `reserved` so the editor can grey + warn-to-grant. Also returns
   * the flat reserved list for convenience.
   */
  getPermissionCatalog(user: JwtPayload) {
    this.assertOwner(user);
    return {
      groups: PERMISSION_GROUPS.map((g) => ({
        key: g.key,
        label: g.label,
        capabilityContext: g.capabilityContext,
        permissions: permissionsForGroup(g.key).map((p) => ({
          key: p,
          reserved: isReserved(p),
        })),
      })),
      reserved: [...RESERVED_PERMISSIONS],
    };
  }

  /**
   * List all non-deleted Gifsy roles, system roles first then alphabetical, each
   * with a `usersCount` = number of users assigned to it (all statuses — it is an
   * "assigned" count, used by the FE to block/warn on delete).
   */
  async listRoles(user: JwtPayload) {
    this.assertOwner(user);

    const roles = await this.prisma.gifsyRole.findMany({
      where: { clientId: GifsyRolesService.GIFSY_CLIENT_ID, deletedAt: null },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });

    // One groupBy to get assigned-user counts for all listed roles, then map. Scoped to
    // LIVE staff (deletedAt: null) so the displayed count matches the delete-in-use guard
    // below (a role assigned only to soft-deleted users is freely deletable).
    const ids = roles.map((r) => r.id);
    const counts = ids.length
      ? await this.prisma.user.groupBy({
          by: ['gifsyRoleId'],
          where: { gifsyRoleId: { in: ids }, deletedAt: null },
          _count: true,
        })
      : [];
    const countByRoleId = new Map<string, number>(
      counts.map((c) => [c.gifsyRoleId as string, c._count]),
    );

    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
      isSystem: r.isSystem,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      usersCount: countByRoleId.get(r.id) ?? 0,
    }));
  }

  /**
   * Validate a permission array: dedupe, reject unknown keys, and enforce the
   * reserved-grant "Lock 1" override. Returns the deduped, validated key list.
   * Shared by create + update.
   */
  private validatePermissions(permissions: string[], allowReserved?: boolean): string[] {
    const perms = [...new Set(permissions)];

    const unknowns = perms.filter((p) => !isPermission(p));
    if (unknowns.length) {
      throw new BadRequestException('Unknown permission keys: ' + unknowns.join(', '));
    }

    // Lock 1 — a reserved (money/tenancy/role-admin) grant needs a conscious override.
    const reserved = perms.filter(isReserved);
    if (reserved.length && allowReserved !== true) {
      throw new BadRequestException(
        'These permissions are reserved and require an explicit override to grant: ' +
          reserved.join(', '),
      );
    }

    return perms;
  }

  /** Create a custom role. Owner can never mint a system role (isSystem forced false). */
  async createRole(user: JwtPayload, dto: CreateGifsyRoleDto) {
    this.assertOwner(user);

    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('Role name is required.');

    const perms = this.validatePermissions(dto.permissions, dto.allowReserved);

    let created;
    try {
      created = await this.prisma.gifsyRole.create({
        data: {
          clientId: GifsyRolesService.GIFSY_CLIENT_ID,
          name,
          description: dto.description ?? null,
          permissions: perms,
          isSystem: false, // owners cannot mint system roles
        },
      });
    } catch (err) {
      // Unique (clientId, name) violation → friendly conflict.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('A role with this name already exists.');
      }
      throw err;
    }

    await this.audit({
      action: 'CREATE',
      entityType: 'GIFSY_ROLE',
      entityId: created.id,
      actorId: user.sub,
      metadata: {
        event: 'gifsy_role_created',
        name: created.name,
        permissions: perms,
        reservedGranted: perms.filter(isReserved),
        allowReserved: dto.allowReserved === true,
      },
    });

    return created;
  }

  /**
   * Update a role. Allow-listed fields only (never spread the DTO, never touch
   * isSystem). System roles ARE editable (rename/description/permissions) — the
   * owner curates the seed roles too; only MINTING and DELETING system roles is
   * blocked.
   */
  async updateRole(user: JwtPayload, id: string, dto: UpdateGifsyRoleDto) {
    this.assertOwner(user);

    const role = await this.prisma.gifsyRole.findFirst({
      where: {
        id,
        clientId: GifsyRolesService.GIFSY_CLIENT_ID,
        deletedAt: null,
      },
    });
    if (!role) throw new NotFoundException('Role not found.');

    // Build an allow-listed update object — never spread the DTO, never isSystem.
    const data: Prisma.GifsyRoleUpdateInput = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Role name is required.');
      data.name = name;
    }

    if (dto.description !== undefined) {
      // Allow clearing the description (null) as well as setting it.
      data.description = dto.description ?? null;
    }

    let permissionsChanged = false;
    let validatedPerms: string[] | undefined;
    if (dto.permissions !== undefined) {
      validatedPerms = this.validatePermissions(dto.permissions, dto.allowReserved);
      data.permissions = validatedPerms;
      permissionsChanged = true;
    }

    let updated;
    try {
      updated = await this.prisma.gifsyRole.update({ where: { id }, data });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('A role with this name already exists.');
      }
      throw err;
    }

    // Drop the resolver's in-proc cache so a permissions edit takes effect
    // immediately on THIS instance. Other instances converge within the 30s TTL
    // (GifsyRoleService.CACHE_TTL_MS) — best-effort, not a cross-instance flush.
    if (permissionsChanged) this.gifsyRoles.clearCache();

    await this.audit({
      action: 'UPDATE',
      entityType: 'GIFSY_ROLE',
      entityId: id,
      actorId: user.sub,
      metadata: {
        event: 'gifsy_role_updated',
        nameChanged: dto.name !== undefined,
        descriptionChanged: dto.description !== undefined,
        permissionsChanged,
        // On a permissions change, record the before/after + any reserved keys granted so
        // a sensitive delegation is fully reconstructable from the audit trail.
        ...(permissionsChanged && validatedPerms
          ? {
              previousPermissions: role.permissions,
              permissions: validatedPerms,
              reservedGranted: validatedPerms.filter(isReserved),
              allowReserved: dto.allowReserved === true,
            }
          : {}),
      },
    });

    return updated;
  }

  /**
   * Soft-delete a role. Blocked for system roles and for any role still assigned
   * to staff.
   *
   * IMPORTANT: the users.gifsyRoleId FK is onDelete: SetNull, but that only fires
   * on a HARD delete. We soft-delete via deletedAt, which does NOT null the
   * assigned users' gifsyRoleId — the resolver would then treat the now
   * deletedAt-set role as an empty permission set and SILENTLY strip those staff
   * members' access. So we block a soft-delete while the role is in use and make
   * the owner reassign first.
   */
  async deleteRole(user: JwtPayload, id: string) {
    this.assertOwner(user);

    const role = await this.prisma.gifsyRole.findFirst({
      where: {
        id,
        clientId: GifsyRolesService.GIFSY_CLIENT_ID,
        deletedAt: null,
      },
    });
    if (!role) throw new NotFoundException('Role not found.');

    if (role.isSystem) {
      throw new BadRequestException('System roles cannot be deleted.');
    }

    // In-use guard, scoped to LIVE staff (deletedAt: null): a role still assigned to an
    // active/deactivated staff member can't be soft-deleted (would strip their access via the
    // fail-closed resolver). NOTE: this count→update is a benign TOCTOU — a concurrent
    // createStaff/reassign landing between the count and the soft-delete could leave a staff
    // pointing at a now-deleted role, which fails CLOSED (empty permission set → denied), never
    // an escalation; the owner can reassign to fix. Not worth a table lock for a deny-only race.
    const inUse = await this.prisma.user.count({
      where: { gifsyRoleId: id, deletedAt: null },
    });
    if (inUse > 0) {
      throw new ConflictException(
        'This role is assigned to ' +
          inUse +
          ' staff member(s). Reassign them before deleting.',
      );
    }

    // Soft-delete AND free the (clientId, name) unique slot by mangling the stored name with
    // the role's unique id — so the owner can later create a NEW role reusing the same display
    // name. The mangled name is never shown (every read filters deletedAt: null). We keep the
    // full @@unique([clientId, name]) (the seed upserts by that natural key), so freeing the
    // slot this way is what makes a same-name recreate possible.
    // Self-guarding where (write-sweep LOW-1): scope the mutation itself to the
    // gifsy tenant, not only the preceding findFirst. count!==1 → treat as absent.
    const { count } = await this.prisma.gifsyRole.updateMany({
      where: { id, clientId: GifsyRolesService.GIFSY_CLIENT_ID },
      data: { deletedAt: new Date(), name: `${role.name} (deleted ${role.id})` },
    });
    if (count !== 1) throw new NotFoundException('Role not found.');
    this.gifsyRoles.clearCache();

    await this.audit({
      action: 'DELETE',
      entityType: 'GIFSY_ROLE',
      entityId: id,
      actorId: user.sub,
      metadata: { event: 'gifsy_role_deleted', name: role.name },
    });

    return { id, deleted: true };
  }
}
