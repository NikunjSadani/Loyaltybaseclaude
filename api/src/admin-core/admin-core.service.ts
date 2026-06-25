import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, KycStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  BulkEditUsersDto,
  CreateUserDto,
  ListUsersQueryDto,
  UpdateUserDto,
} from './dto/users.dto';
import { SetVisibilityCaptureModeDto, UpsertSettingDto } from './dto/settings.dto';
import { HierarchyConfigDto, TaskConfigDto } from './dto/config.dto';
import {
  DEOLEO_HIERARCHY,
  HierarchyEmployee,
  persistHierarchy,
} from './hierarchy-persistence';

/**
 * AdminCoreService — business logic for the ported admin sub-domains
 * (users, settings, hierarchy-config, force-logout-all, dashboard, task-config,
 * gift-config). Re-homed from platform/src/app/api/admin/* onto /v1.
 *
 * Every query is tenant-scoped by `user.clientId` (the old `userId` is `user.sub`).
 * Role/permission gates live on the controllers (@Roles / @RequirePermission);
 * tenant scope + business rules are re-checked here. Controllers stay thin.
 *
 * Single return shape: each method returns the `data` payload directly
 * (the Next `ok(data)` body); the global TransformInterceptor envelopes it.
 */
@Injectable()
export class AdminCoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  // ─── Role assignment allow-list (GLB-4) ─────────────────────────────────────
  /**
   * Roles that a non-GIFSY caller (e.g. CLIENT_ADMIN) is permitted to assign.
   * Only GIFSY_ADMIN may mint a CLIENT_ADMIN or another GIFSY_ADMIN; the
   * operational in-tenant roles below are the maximum a tenant admin can assign.
   */
  private static readonly TENANT_ASSIGNABLE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
    'MIS_USER',
    'SALES_HO',
    'SALES_STATE_HEAD',
    'SALES_ASM',
    'SALES_SO',
    'SALES_ISR',
    'SSS',
    'WHOLESALER',
    'SUB_STOCKIST',
  ]);

  /**
   * Validates that the caller is permitted to assign `role` to another user.
   * GIFSY_ADMIN may assign any role (no restriction).
   * Any other caller is limited to TENANT_ASSIGNABLE_ROLES; attempting to set
   * GIFSY_ADMIN or CLIENT_ADMIN throws ForbiddenException.
   */
  private assertRoleAssignable(caller: JwtPayload, role: UserRole): void {
    if (caller.role === 'GIFSY_ADMIN') return; // unrestricted
    if (!AdminCoreService.TENANT_ASSIGNABLE_ROLES.has(role)) {
      throw new ForbiddenException(
        `Role '${role}' can only be assigned by a GIFSY_ADMIN`,
      );
    }
  }

  // ─── ProgramSetting setting keys (mirror the Next routes) ───────────────────
  private static readonly HIERARCHY_KEY = 'employee_hierarchy';
  private static readonly TASK_CONFIG_KEY = 'task_config';
  private static readonly GIFT_CATALOGUE_KEY = 'gift_catalogue';

  // ════════════════════════════════════════════════════════════════════════
  // Session helpers — ported from platform/src/lib/session.ts
  // ════════════════════════════════════════════════════════════════════════

  /** Revoke all non-revoked sessions for a single user. Returns the count. */
  private async revokeAllSessionsForUser(userId: string): Promise<number> {
    const result = await this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /**
   * Platform-wide kill switch — revokes EVERY non-revoked session across ALL
   * users and ALL tenants. Intentionally global (no userId / clientId filter).
   * GIFSY_ADMIN only — enforced on the controller.
   */
  private async revokeAllSessions(): Promise<number> {
    const result = await this.prisma.userSession.updateMany({
      where: { revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  // ════════════════════════════════════════════════════════════════════════
  // USERS — admin/users, admin/users/[id], admin/users/bulk-edit
  // ════════════════════════════════════════════════════════════════════════

  async listUsers(user: JwtPayload, q: ListUsersQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.UserWhereInput = { clientId: user.clientId };
    if (q.role) where.role = q.role;
    if (q.status) where.status = q.status;
    if (q.search) {
      where.OR = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { phone: { contains: q.search } },
        { email: { contains: q.search, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          phone: true,
          name: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
          salesUser: { select: { id: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { users, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async createUser(user: JwtPayload, dto: CreateUserDto) {
    const clientId = user.clientId;

    const existing = await this.prisma.user.findFirst({ where: { phone: dto.phone, clientId } });
    if (existing) throw new BadRequestException('User with this phone already exists');

    // GLB-4: reject disallowed role assignments before any write
    this.assertRoleAssignable(user, dto.role);

    const created = await this.prisma.user.create({
      data: {
        phone: dto.phone,
        name: dto.name,
        role: dto.role,
        email: dto.email ?? null,
        status: 'ACTIVE',
        clientId,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        action: 'CREATE',
        entityType: 'USER',
        entityId: created.id,
        actorId: user.sub,
        metadata: { role: dto.role, phone: dto.phone },
      },
    });

    return { user: created };
  }

  async getUser(user: JwtPayload, id: string) {
    const found = await this.prisma.user.findFirst({
      where: { id, clientId: user.clientId },
      include: { channelPartner: true, salesUser: true },
    });
    if (!found) throw new NotFoundException('User not found');
    return { user: found };
  }

  async updateUser(user: JwtPayload, id: string, dto: UpdateUserDto) {
    const clientId = user.clientId;

    const target = await this.prisma.user.findFirst({ where: { id, clientId } });
    if (!target) throw new NotFoundException('User not found');

    // Phone-uniqueness guard: check BEFORE update to avoid Prisma P2002
    if (dto.phone && dto.phone !== target.phone) {
      const clash = await this.prisma.user.findFirst({
        where: { phone: dto.phone, clientId, id: { not: id } },
      });
      if (clash) throw new ConflictException('Phone number already in use');
    }

    // GLB-4: validate the requested role change BEFORE any write; silently skip
    // the guard when no role change is requested (dto.role is absent).
    if (dto.role !== undefined) {
      this.assertRoleAssignable(user, dto.role);
    }

    const phoneChanged = Boolean(dto.phone && dto.phone !== target.phone);

    // Build an explicit allow-listed update object — do NOT spread dto directly,
    // which would let any future DTO field silently reach Prisma.
    const updateData: Prisma.UserUpdateInput = { updatedAt: new Date() };
    if (dto.name     !== undefined) updateData.name   = dto.name;
    if (dto.email    !== undefined) updateData.email  = dto.email;
    if (dto.status   !== undefined) updateData.status = dto.status;
    if (dto.role     !== undefined) updateData.role   = dto.role;
    if (dto.phone    !== undefined) updateData.phone  = dto.phone;

    // Defense-in-depth: scope the write to the tenant so a race between the
    // findFirst gate above and the write cannot affect a row from another tenant.
    const { count } = await this.prisma.user.updateMany({
      where: { id, clientId },
      data: updateData,
    });
    if (count === 0) {
      // Row vanished between the gate and the write (race), or clientId mismatch.
      throw new NotFoundException('User not found');
    }

    // Re-fetch the full row to return the correct updated state.
    const updated = await this.prisma.user.findFirst({ where: { id, clientId } });

    // Force re-login on all devices when login identity (phone) changes
    if (phoneChanged) {
      await this.revokeAllSessionsForUser(id);
    }

    await this.prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'USER',
        entityId: id,
        actorId: user.sub,
        metadata: { ...dto },
      },
    });

    return { user: updated };
  }

  async deleteUser(user: JwtPayload, id: string) {
    const clientId = user.clientId;

    if (id === user.sub) throw new BadRequestException('Cannot delete your own account');

    const target = await this.prisma.user.findFirst({ where: { id, clientId } });
    if (!target) throw new NotFoundException('User not found');

    // Soft delete — scoped to tenant for defense-in-depth.
    const { count: deleteCount } = await this.prisma.user.updateMany({
      where: { id, clientId },
      data: { status: 'INACTIVE', deletedAt: new Date() },
    });
    if (deleteCount === 0) {
      throw new NotFoundException('User not found');
    }

    await this.prisma.auditLog.create({
      data: {
        action: 'DELETE',
        entityType: 'USER',
        entityId: id,
        actorId: user.sub,
      },
    });

    return { message: 'User deleted successfully' };
  }

  // ── bulk-edit ──────────────────────────────────────────────────────────────

  async bulkEditUsers(user: JwtPayload, dto: BulkEditUsersDto) {
    const clientId = user.clientId;
    const action = dto.action;

    // ── DEMO_MODE (dev/staging only) ──────────────────────────────────────────
    // Defense-in-depth: never short-circuit a real bulk edit into a fabricated
    // "(demo mode)" response in production, even if DEMO_MODE is misconfigured there.
    if (process.env.DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production') {
      if (action === 'resign') {
        return { resigned: (dto.employeeCodes ?? []).length, message: 'Resigned (demo mode)' };
      }
      if (action === 'reassign_outlet') {
        return { reassigned: (dto.outletIds ?? []).length, message: 'Reassigned (demo mode)' };
      }
      throw new BadRequestException(`Unknown action: ${action}`);
    }

    // ── Resign ──────────────────────────────────────────────────────────────
    if (action === 'resign') {
      const employeeCodes = dto.employeeCodes;
      if (!Array.isArray(employeeCodes) || employeeCodes.length === 0) {
        throw new BadRequestException('employeeCodes must be a non-empty array');
      }
      if (employeeCodes.length > 200) {
        throw new BadRequestException('Maximum 200 employees per bulk-resign request');
      }

      const salesUsers = await this.prisma.salesUser.findMany({
        where: { employeeCode: { in: employeeCodes }, deletedAt: null, user: { clientId } },
        select: { id: true, userId: true, employeeCode: true },
      });

      if (salesUsers.length === 0) {
        throw new BadRequestException('No active employees found for the given codes');
      }

      const salesUserIds = salesUsers.map((s) => s.id);
      const userIds = salesUsers.map((s) => s.userId);
      const now = new Date();

      await this.prisma.$transaction(async (tx) => {
        await tx.salesUser.updateMany({
          where: { id: { in: salesUserIds } },
          data: { isActive: false, deletedAt: now },
        });

        await tx.user.updateMany({
          where: { id: { in: userIds } },
          data: { status: 'INACTIVE' },
        });

        await tx.salesUserAssignment.updateMany({
          where: { salesUserId: { in: salesUserIds }, unassignedAt: null },
          data: { unassignedAt: now },
        });

        await tx.auditLog.create({
          data: {
            action: 'UPDATE',
            entityType: 'SALES_USER',
            entityId: 'BULK',
            actorId: user.sub,
            newValues: { status: 'RESIGNED', employeeCodes },
            metadata: { action: 'bulk_resign', count: salesUsers.length },
          },
        });
      });

      return { resigned: salesUsers.length, notFound: employeeCodes.length - salesUsers.length };
    }

    // ── Reassign outlet XSR ─────────────────────────────────────────────────
    if (action === 'reassign_outlet') {
      const outletIds = dto.outletIds;
      const newXsrEmployeeCode = dto.newXsrEmployeeCode;

      if (!Array.isArray(outletIds) || outletIds.length === 0) {
        throw new BadRequestException('outletIds must be a non-empty array');
      }
      if (!newXsrEmployeeCode || typeof newXsrEmployeeCode !== 'string') {
        throw new BadRequestException('newXsrEmployeeCode is required');
      }
      if (outletIds.length > 200) {
        throw new BadRequestException('Maximum 200 outlets per reassignment request');
      }

      // Validate new XSR — MUST be tenant-scoped (no cross-tenant assignment).
      const newXsr = await this.prisma.salesUser.findFirst({
        where: { employeeCode: newXsrEmployeeCode.trim(), deletedAt: null, isActive: true, clientId },
        select: { id: true },
      });
      if (!newXsr) {
        throw new BadRequestException(
          `XSR with employee code ${newXsrEmployeeCode} not found or inactive`,
        );
      }

      // Verify outlets exist; scope by the outlet's OWN clientId.
      const outlets = await this.prisma.outlet.findMany({
        where: { id: { in: outletIds }, deletedAt: null, clientId },
        select: { id: true, partnerId: true },
      });
      if (outlets.length === 0) {
        throw new BadRequestException('No active outlets found for the given IDs');
      }

      const now = new Date();

      await this.prisma.$transaction(async (tx) => {
        for (const outlet of outlets) {
          await tx.salesUserAssignment.updateMany({
            where: { outletId: outlet.id, unassignedAt: null },
            data: { unassignedAt: now },
          });

          await tx.salesUserAssignment.create({
            data: {
              salesUserId: newXsr.id,
              outletId: outlet.id,
              partnerId: outlet.partnerId,
              assignedAt: now,
            },
          });
        }

        await tx.auditLog.create({
          data: {
            action: 'UPDATE',
            entityType: 'OUTLET',
            entityId: 'BULK',
            actorId: user.sub,
            newValues: { newXsrEmployeeCode, outletIds },
            metadata: { action: 'bulk_reassign_outlet', count: outlets.length },
          },
        });
      });

      return { reassigned: outlets.length, notFound: outletIds.length - outlets.length };
    }

    throw new BadRequestException(
      `Unknown action: ${action}. Valid actions: resign, reassign_outlet`,
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // SETTINGS — admin/settings, admin/settings/config
  // ════════════════════════════════════════════════════════════════════════

  private static readonly SETTINGS_DEFAULTS: Record<string, unknown> = {
    holdingPeriodDays: 30,
    conversionRate: 1,
    slaTargetHours: 48,
    maxOtpAttempts: 3,
    otpExpiryMinutes: 10,
    minRedemptionPoints: 100,
    maxDailyVisibilitySubmissions: 10,
    tdsRate: 0.1,
    tdsThresholdPaise: 2000000,
    programName: 'Loyalty Program',
    supportEmail: 'support@platform.com',
    supportPhone: '1800-XXX-XXXX',
  };

  async getSettings(user: JwtPayload) {
    const rows = await this.prisma.programSetting.findMany({ where: { clientId: user.clientId } });

    const settings: Record<string, unknown> = {
      ...AdminCoreService.SETTINGS_DEFAULTS,
      // conversionRate default is env-derived (single source of truth with the boot guard +
      // TenantSettingsService), not the literal `1` above, so the deploy-wide default and the
      // per-tenant default never diverge. An explicit programSetting row still overrides it.
      conversionRate: TenantSettingsService.envConversionRate(),
    };
    for (const row of rows) {
      settings[row.settingKey] = row.settingValue;
    }

    return { settings };
  }

  async upsertSetting(user: JwtPayload, dto: UpsertSettingDto) {
    const clientId = user.clientId;

    const setting = await this.prisma.programSetting.upsert({
      where: { clientId_settingKey: { clientId, settingKey: dto.key } },
      update: { settingValue: dto.value, updatedById: user.sub },
      create: {
        settingKey: dto.key,
        settingValue: dto.value,
        category: dto.category,
        description: dto.description,
        updatedById: user.sub,
        clientId,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'PROGRAM_SETTINGS',
        entityId: setting.id,
        actorId: user.sub,
        metadata: { key: dto.key, value: dto.value },
      },
    });

    // Bust the typed settings cache so the new value is visible immediately on the money
    // path (conversionRate) and everywhere else — not after the 5-min TTL.
    this.tenantSettings.invalidate(clientId);

    return { setting };
  }

  /**
   * admin/settings/config — branding + feature flags for the caller's tenant.
   * Source used getTenantConfig() (DB-backed loader). Here we resolve via the
   * @Global TenantService (AdminConfig-backed). NEVER expose secrets — only
   * branding + features (+ non-secret metadata) are returned.
   */
  async getTenantConfig(user: JwtPayload) {
    const config = await this.tenant.resolveClient(user.clientId);
    return {
      slug: config.slug,
      internalName: config.name,
      status: config.isActive ? 'ACTIVE' : 'INACTIVE',
      branding: config.branding,
      features: config.features,
    };
  }

  /**
   * admin/settings/visibility-capture-mode — GIFSY_ADMIN-only PUT.
   *
   * Reads the current ClientConfig, merges only the `visibilityCaptureMode`
   * feature key (preserves every other feature flag and all top-level config
   * fields), then persists via TenantService.upsertClientConfig which also
   * busts the in-memory cache.
   *
   * The GET path is already covered by GET /v1/admin/settings/config which
   * returns the full `features` object including `visibilityCaptureMode`.
   */
  async setVisibilityCaptureMode(user: JwtPayload, dto: SetVisibilityCaptureModeDto) {
    const clientId = user.clientId;
    // Load the full current config (throws NotFoundException if not found)
    const config = await this.tenant.resolveClient(clientId);

    // Merge — only update visibilityCaptureMode; all other feature flags are preserved.
    const updatedConfig = {
      ...config,
      features: {
        ...config.features,
        visibilityCaptureMode: dto.mode,
      },
    };

    await this.tenant.upsertClientConfig(clientId, updatedConfig);

    await this.prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'CLIENT_CONFIG',
        entityId: clientId,
        actorId: user.sub,
        metadata: { key: 'visibilityCaptureMode', value: dto.mode },
      },
    });

    return { mode: dto.mode };
  }

  // ════════════════════════════════════════════════════════════════════════
  // HIERARCHY-CONFIG — admin/hierarchy-config
  // ════════════════════════════════════════════════════════════════════════

  async getHierarchyConfig(user: JwtPayload) {
    const setting = await this.prisma.programSetting.findFirst({
      where: { clientId: user.clientId, settingKey: AdminCoreService.HIERARCHY_KEY },
    });
    const employees = (setting?.settingValue as unknown[]) ?? [];
    return { employees };
  }

  async saveHierarchyConfig(user: JwtPayload, dto: HierarchyConfigDto) {
    const clientId = user.clientId;
    const employees = dto.employees;

    if (!Array.isArray(employees)) {
      throw new BadRequestException('Expected { employees: [...] }');
    }
    // The PUT route accepts the raw body (no DTO transform), so reject malformed elements with a
    // clean 400 rather than letting a null/primitive/array element throw a 500 deep in persistHierarchy.
    if (employees.some((e) => e === null || typeof e !== 'object' || Array.isArray(e))) {
      throw new BadRequestException('Each employee must be a JSON object');
    }

    // 1. Keep the denormalized JSON snapshot for the admin UI (GET) AND
    // 2. Persist the authoritative relational tree — both in one transaction.
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.programSetting.upsert({
        where: { clientId_settingKey: { clientId, settingKey: AdminCoreService.HIERARCHY_KEY } },
        update: { settingValue: employees as Prisma.InputJsonValue, updatedById: user.sub },
        create: {
          clientId,
          settingKey: AdminCoreService.HIERARCHY_KEY,
          settingValue: employees as Prisma.InputJsonValue,
          updatedById: user.sub,
        },
      });

      return persistHierarchy(
        clientId,
        employees as HierarchyEmployee[],
        DEOLEO_HIERARCHY,
        tx,
      );
    }, { timeout: 20_000, maxWait: 10_000 });

    return { message: 'Employee hierarchy saved', persisted: result };
  }

  // ════════════════════════════════════════════════════════════════════════
  // FORCE-LOGOUT-ALL — admin/force-logout-all (GIFSY kill switch)
  // ════════════════════════════════════════════════════════════════════════

  async forceLogoutAll(user: JwtPayload) {
    const count = await this.revokeAllSessions();

    await this.prisma.auditLog.create({
      data: {
        action: 'LOGOUT',
        entityType: 'SESSION',
        entityId: 'ALL',
        actorId: user.sub,
        metadata: { revoked: count, reason: 'force-logout-all' },
      },
    });

    return { message: 'All users logged out', revoked: count };
  }

  // ════════════════════════════════════════════════════════════════════════
  // DASHBOARD — admin/dashboard/kpis
  // ════════════════════════════════════════════════════════════════════════

  private static readonly PENDING_KYC_STATUSES: KycStatus[] = [
    'SUBMITTED',
    'UNDER_REVIEW',
    'PENDING_SO_APPROVAL',
    'PENDING_ASM_APPROVAL',
    'PENDING_RSM_APPROVAL',
    'PENDING_GIFSY',
  ];

  async dashboardKpis(user: JwtPayload) {
    const clientId = user.clientId;

    const [activePartners, pendingKyc, pendingVisibilityRaw, walletAggregate, payoutGroups, visibilityEnabled] =
      await Promise.all([
        this.prisma.channelPartner.count({
          where: { clientId, isActive: true, deletedAt: null },
        }),

        this.prisma.kycSubmission.count({
          where: {
            user: { clientId },
            status: { in: AdminCoreService.PENDING_KYC_STATUSES },
          },
        }),

        this.prisma.visibilitySubmission.count({
          where: {
            partner: { clientId },
            status: 'SUBMITTED',
          },
        }),

        this.prisma.wallet.aggregate({
          _sum: { redeemablePoints: true },
          where: { partner: { clientId } },
        }),

        this.prisma.payoutTransaction.groupBy({
          by: ['status'],
          where: { partner: { clientId } },
          _count: { id: true },
          _sum: { netAmountPaise: true },
        }),

        // Master visibility switch — when OFF, the visibility KPI is suppressed so a
        // disabled tenant's residual SUBMITTED rows are not surfaced on the dashboard.
        this.tenantSettings.getVisibilityEnabledUncached(clientId),
      ]);

    // Suppress the visibility KPI for a tenant whose visibility module is OFF.
    const pendingVisibility = visibilityEnabled ? pendingVisibilityRaw : 0;

    const totalRedeemablePoints = walletAggregate._sum.redeemablePoints ?? 0;

    const payoutSummary: Record<string, { count: number; amountPaise: number }> = {};
    for (const g of payoutGroups) {
      payoutSummary[g.status] = {
        count: g._count.id,
        amountPaise: Number(g._sum.netAmountPaise ?? 0),
      };
    }

    return {
      activePartners,
      pendingKyc,
      pendingVisibility,
      totalRedeemablePoints,
      payoutSummary,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // TASK-CONFIG — admin/task-config
  // ════════════════════════════════════════════════════════════════════════

  private static readonly DEFAULT_TASK_CONFIG = {
    customTaskLabel: 'HO Notifications / Reminders',
    customTaskItems: [] as unknown[],
  };

  async getTaskConfig(user: JwtPayload) {
    const row = await this.prisma.programSetting.findFirst({
      where: { clientId: user.clientId, settingKey: AdminCoreService.TASK_CONFIG_KEY },
    });
    const config = row ? (row.settingValue as object) : AdminCoreService.DEFAULT_TASK_CONFIG;
    return { config };
  }

  async saveTaskConfig(user: JwtPayload, dto: TaskConfigDto) {
    const clientId = user.clientId;

    const setting = await this.prisma.programSetting.upsert({
      where: { clientId_settingKey: { clientId, settingKey: AdminCoreService.TASK_CONFIG_KEY } },
      update: { settingValue: dto as unknown as Prisma.InputJsonValue, updatedById: user.sub },
      create: {
        settingKey: AdminCoreService.TASK_CONFIG_KEY,
        settingValue: dto as unknown as Prisma.InputJsonValue,
        category: 'sales_tasks',
        description: 'Sales dashboard task category configuration',
        updatedById: user.sub,
        clientId,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'PROGRAM_SETTINGS',
        entityId: setting.id,
        actorId: user.sub,
        metadata: { key: AdminCoreService.TASK_CONFIG_KEY },
      },
    });

    return { config: dto };
  }

  // ════════════════════════════════════════════════════════════════════════
  // GIFT-CONFIG — admin/gift-config
  // ════════════════════════════════════════════════════════════════════════

  async getGiftConfig(user: JwtPayload) {
    const setting = await this.prisma.programSetting.findFirst({
      where: { clientId: user.clientId, settingKey: AdminCoreService.GIFT_CATALOGUE_KEY },
    });
    const gifts = (setting?.settingValue as unknown[]) ?? [];
    return { gifts };
  }

  async saveGiftConfig(user: JwtPayload, body: unknown) {
    const clientId = user.clientId;
    if (!Array.isArray(body)) {
      throw new BadRequestException('Expected an array of gift items');
    }

    await this.prisma.programSetting.upsert({
      where: { clientId_settingKey: { clientId, settingKey: AdminCoreService.GIFT_CATALOGUE_KEY } },
      update: { settingValue: body as Prisma.InputJsonValue, updatedById: user.sub },
      create: {
        clientId,
        settingKey: AdminCoreService.GIFT_CATALOGUE_KEY,
        settingValue: body as Prisma.InputJsonValue,
        updatedById: user.sub,
      },
    });

    return { message: 'Gift catalogue saved' };
  }
}
