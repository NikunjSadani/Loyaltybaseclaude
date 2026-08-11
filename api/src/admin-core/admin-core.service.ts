import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, KycStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SalesNotificationsService } from '../notifications/sales-notifications.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { businessHoursBetween, isValidIsoDate } from '../common/business-hours';
import {
  HOLIDAY_CLIENT_ID,
  Holiday,
  NATIONAL_HOLIDAYS_KEY,
  loadHolidaySet,
  normalizeHolidays,
} from '../common/holiday-calendar';
import {
  REPORTS_CLIENT_ID,
  REPORT_RECIPIENTS_KEY,
  ReportRecipients,
  normalizeReportRecipients,
} from '../common/report-recipients';
import {
  KYC_FIELD_SLA_KEY,
  KYC_GIFSY_SLA_KEY,
  KYC_FIELD_SLA_DEFAULT,
  KYC_GIFSY_SLA_DEFAULT,
  KYC_SLA_MIN_HOURS,
  KYC_SLA_MAX_HOURS,
} from '../common/kyc-sla-stage';
import {
  BulkEditUsersDto,
  CreateUserDto,
  ListUsersQueryDto,
  UpdateUserDto,
} from './dto/users.dto';
import {
  SetHolidaysDto,
  SetPointsExpiryDto,
  SetReportRecipientsDto,
  SetVisibilityCaptureModeDto,
  UpsertSettingDto,
} from './dto/settings.dto';
import { HierarchyConfigDto, TaskConfigDto } from './dto/config.dto';
import {
  DEOLEO_HIERARCHY,
  HierarchyEmployee,
  persistHierarchy,
} from './hierarchy-persistence';
import {
  OTP_EXPIRY_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_WINDOW_HOURS,
  OTP_MAX_RESENDS_PER_WINDOW,
  REFRESH_TTL_DAYS,
  ASSUMED_SESSION_TTL_HOURS,
} from '../auth/auth.constants';

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
    private readonly salesNotifications: SalesNotificationsService,
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
    // A GIFSY_ADMIN may only be MINTED from the platform (gifsy) context. A GIFSY_ADMIN
    // assumed into a tenant creates users stamped with that tenant's clientId, so minting a
    // GIFSY_ADMIN there would produce a mis-scoped operator — block it.
    if (role === 'GIFSY_ADMIN' && !(caller.role === 'GIFSY_ADMIN' && caller.clientId === 'gifsy')) {
      throw new ForbiddenException(
        'A GIFSY_ADMIN can only be created from the platform (gifsy) context',
      );
    }
    if (caller.role === 'GIFSY_ADMIN') return; // otherwise unrestricted (CLIENT_ADMIN in a tenant, tenant/sales roles)
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

  /**
   * POST /v1/admin/users/:id/revoke-sessions — admin per-user "log out of all
   * devices" (#101 / Feature 10-ii). Verifies the target user exists AND belongs
   * to the caller's tenant (mirrors updateUser's tenant scoping — the caller's
   * clientId is the assumed tenant for a GIFSY operator context), then revokes all
   * of that user's non-revoked sessions. Throws NotFound for an unknown/cross-tenant
   * target so an admin can never revoke a user in another tenant.
   *
   * HONESTY CAVEAT: access-token JWTs are verified at the proxy with NO per-request
   * session-revocation check, so revoking sessions kills the REFRESH path (the user's
   * other devices can no longer renew, so they're bounded by the access-token TTL) but
   * does NOT instantly invalidate an already-issued, still-valid access token. The
   * target is therefore signed out within the session window / on their next refresh —
   * not immediately. UI copy must reflect this.
   */
  async revokeUserSessions(
    caller: JwtPayload,
    targetUserId: string,
  ): Promise<{ revoked: number }> {
    const clientId = caller.clientId;

    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, clientId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('User not found');

    const revoked = await this.revokeAllSessionsForUser(targetUserId);

    await this.prisma.auditLog.create({
      data: {
        action: 'LOGOUT',
        entityType: 'SESSION',
        entityId: targetUserId,
        actorId: caller.sub,
        metadata: { event: 'admin_revoke_sessions', targetUserId, by: caller.sub, revoked },
      },
    });

    return { revoked };
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

    const pages = Math.ceil(total / limit);
    return {
      users,
      pagination: {
        page,
        limit,
        total,
        pages,
        hasNextPage: page < pages,
        hasPrevPage: page > 1,
      },
    };
  }

  async createUser(user: JwtPayload, dto: CreateUserDto) {
    const clientId = user.clientId;

    const existing = await this.prisma.user.findFirst({ where: { phone: dto.phone, clientId } });
    if (existing) throw new BadRequestException('User with this phone already exists');

    // Email-uniqueness pre-check: @@unique([clientId, email]) would otherwise surface a colliding
    // email as a Prisma P2002 → HTTP 500. Pre-check so it's a clean, honest 400 like the phone case.
    if (dto.email) {
      const emailTaken = await this.prisma.user.findFirst({ where: { email: dto.email, clientId } });
      if (emailTaken) throw new BadRequestException('User with this email already exists');
    }

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

    // Deactivation guards — fire when the status is set to anything other than
    // ACTIVE (INACTIVE / SUSPENDED / PENDING_VERIFICATION), so a SUSPEND can't
    // bypass the self-lockout / last-admin protections. Never fire on
    // reactivation (→ ACTIVE) or other field edits (status undefined).
    const deactivating = dto.status !== undefined && dto.status !== 'ACTIVE';
    if (deactivating) {
      // Self-deactivate guard: an admin cannot lock themselves out.
      if (id === user.sub) {
        throw new BadRequestException('You cannot deactivate your own account');
      }
      // Last-active-admin guard: never leave a tenant with zero active admins.
      if (target.role === 'GIFSY_ADMIN' || target.role === 'CLIENT_ADMIN') {
        const activeAdmins = await this.prisma.user.count({
          where: {
            clientId,
            status: 'ACTIVE',
            role: { in: ['GIFSY_ADMIN', 'CLIENT_ADMIN'] },
          },
        });
        if (activeAdmins <= 1) {
          throw new BadRequestException('Cannot deactivate the last active admin of this tenant');
        }
      }
    }

    // Phone-uniqueness guard: check BEFORE update to avoid Prisma P2002
    if (dto.phone && dto.phone !== target.phone) {
      const clash = await this.prisma.user.findFirst({
        where: { phone: dto.phone, clientId, id: { not: id } },
      });
      if (clash) throw new ConflictException('Phone number already in use');
    }

    // Email-uniqueness guard: same pre-check for @@unique([clientId, email]) so a colliding
    // email is a clean 409, not a Prisma P2002 → HTTP 500. Only when setting a new non-null email.
    if (dto.email && dto.email !== target.email) {
      const emailClash = await this.prisma.user.findFirst({
        where: { email: dto.email, clientId, id: { not: id } },
      });
      if (emailClash) throw new ConflictException('Email address already in use');
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

      // Notify the new XSR of the outlet(s) reassigned to them for KYC.
      await this.salesNotifications.outletsAssigned(clientId, newXsr.id, outlets.length);

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
    // Two-stage KYC review SLA (replaces the old single slaTargetHours). Each is a
    // per-tenant configurable business-hours target: field stage (submitted → reached
    // Gifsy) and Gifsy stage (latest PENDING_GIFSY entry → decision).
    fieldSlaTargetHours: KYC_FIELD_SLA_DEFAULT,
    gifsySlaTargetHours: KYC_GIFSY_SLA_DEFAULT,
    // OTP knobs are sourced from the enforced auth constants (single source of truth)
    // so this default can never drift from what auth.service.ts actually enforces.
    maxOtpAttempts: OTP_MAX_ATTEMPTS,
    otpExpiryMinutes: OTP_EXPIRY_MINUTES,
    minRedemptionPoints: 100,
    maxDailyVisibilitySubmissions: 10,
    tdsRate: 0.1,
    tdsThresholdPaise: 2000000,
    programName: 'Loyalty Program',
    supportEmail: 'support@platform.com',
    supportPhone: '1800-XXX-XXXX',
  };

  /**
   * Setting keys that were removed and must never surface from getSettings, even if a stale
   * programSetting row still exists in a tenant DB (e.g. deoleo prod's pre-two-stage
   * `slaTargetHours`). Nothing reads these; skipping them keeps the payload honest.
   */
  private static readonly RETIRED_SETTING_KEYS: ReadonlySet<string> = new Set<string>([
    'slaTargetHours',
  ]);

  // ── National holiday calendar (platform-global) ────────────────────────────
  // The KYC review-SLA counts only business hours (Mon–Fri) and PAUSES on this calendar
  // (owner decision 2026-08-10). Storage + defaults + the SLA date-set live in the shared
  // common/holiday-calendar module (used identically by kyc.service slaMetrics), so nothing
  // drifts between the two SLA engines. GIFSY_ADMIN edits it; CLIENT_ADMIN can read it (their
  // KYC list ages rows against it).

  /**
   * The platform national holiday calendar, for the settings UI. Returns the stored override
   * (an array of { date, label }) if present, else the gazetted-national code default. Sorted.
   */
  async getNationalHolidays(): Promise<{ holidays: Holiday[] }> {
    const row = await this.prisma.programSetting.findFirst({
      where: { clientId: HOLIDAY_CLIENT_ID, settingKey: NATIONAL_HOLIDAYS_KEY },
      select: { settingValue: true },
    });
    return { holidays: normalizeHolidays(row?.settingValue) };
  }

  /**
   * Replace the platform national holiday calendar. GIFSY_ADMIN only (role-enforced on the
   * controller; re-checked here). Validates every entry (strict real YYYY-MM-DD + non-empty
   * label), de-dups by date, sorts, and upserts the single platform row.
   */
  async setNationalHolidays(user: JwtPayload, dto: SetHolidaysDto): Promise<{ holidays: Holiday[] }> {
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden - Gifsy Admin only');

    const byDate = new Map<string, string>();
    for (const h of dto.holidays ?? []) {
      const date = (h?.date ?? '').trim();
      const label = (h?.label ?? '').trim();
      if (!isValidIsoDate(date)) {
        throw new BadRequestException(`Invalid holiday date "${h?.date}" — expected a real YYYY-MM-DD.`);
      }
      if (!label) {
        throw new BadRequestException(`Holiday ${date} is missing a label.`);
      }
      byDate.set(date, label); // last write wins on a duplicate date
    }
    const holidays: Holiday[] = [...byDate.entries()]
      .map(([date, label]) => ({ date, label }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Holiday[] is a plain JSON array; cast to Prisma's JSON input type (the object element
    // type lacks the index signature Prisma's InputJsonValue expects).
    const settingValue = holidays as unknown as Prisma.InputJsonValue;
    await this.prisma.programSetting.upsert({
      where: { clientId_settingKey: { clientId: HOLIDAY_CLIENT_ID, settingKey: NATIONAL_HOLIDAYS_KEY } },
      create: {
        clientId: HOLIDAY_CLIENT_ID,
        settingKey: NATIONAL_HOLIDAYS_KEY,
        settingValue,
        category: 'kyc',
      },
      update: { settingValue },
    });
    return { holidays };
  }

  // ── Report recipients (platform-global) ────────────────────────────────────
  // Per Gifsy-configured scheduled report, the list of email addresses that receive it. Storage +
  // defaults + normalizer live in the shared common/report-recipients module (used identically by
  // the scheduled-report runner), so the configured list and the send logic can never drift.
  // GIFSY_ADMIN edits it; CLIENT_ADMIN can read it.

  /**
   * The platform report-recipient lists, for the settings UI. Returns the stored value normalized
   * (valid, lowercased, de-duped emails), else empty lists when no row exists.
   */
  async getReportRecipients(): Promise<{ recipients: ReportRecipients }> {
    const row = await this.prisma.programSetting.findFirst({
      where: { clientId: REPORTS_CLIENT_ID, settingKey: REPORT_RECIPIENTS_KEY },
      select: { settingValue: true },
    });
    return { recipients: normalizeReportRecipients(row?.settingValue) };
  }

  /**
   * Replace the platform report-recipient lists. GIFSY_ADMIN only (role-enforced on the controller;
   * re-checked here). Normalizes each list (valid, lowercased, de-duped emails) and upserts the
   * single platform row.
   */
  async setReportRecipients(
    user: JwtPayload,
    dto: SetReportRecipientsDto,
  ): Promise<{ recipients: ReportRecipients }> {
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden - Gifsy Admin only');

    const recipients = normalizeReportRecipients(dto);

    // ReportRecipients is a plain JSON object; cast to Prisma's JSON input type (the interface
    // lacks the index signature Prisma's InputJsonValue expects).
    const settingValue = recipients as unknown as Prisma.InputJsonValue;
    await this.prisma.programSetting.upsert({
      where: { clientId_settingKey: { clientId: REPORTS_CLIENT_ID, settingKey: REPORT_RECIPIENTS_KEY } },
      create: {
        clientId: REPORTS_CLIENT_ID,
        settingKey: REPORT_RECIPIENTS_KEY,
        settingValue,
        category: 'reports',
      },
      update: { settingValue },
    });
    return { recipients };
  }

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
      // Skip retired keys: the single `slaTargetHours` was replaced by the two-stage
      // field/gifsySlaTargetHours. A leftover DB row (e.g. deoleo prod, pre-migration) must
      // not surface a dead knob in the settings payload — nothing reads it any more.
      if (AdminCoreService.RETIRED_SETTING_KEYS.has(row.settingKey)) continue;
      settings[row.settingKey] = row.settingValue;
    }

    // ── Read-only "Security & Platform Config" (#101 / Feature 9) ──────────────
    // Platform-global security parameters, surfaced for DISPLAY ONLY. These are the
    // EXACT values auth.service.ts enforces (imported from the shared auth.constants
    // single source of truth) plus the env-driven JWT access-token TTL. They are set
    // AFTER the DB-override loop so a stray programSetting row can never make the
    // displayed value diverge from the enforced one — these fields are not editable
    // via the settings API (managed via deployment/env).
    Object.assign(settings, {
      jwtAccessTtl: process.env.JWT_EXPIRES_IN ?? '7d',
      refreshTtlDays: REFRESH_TTL_DAYS,
      assumedSessionTtlHours: ASSUMED_SESSION_TTL_HOURS,
      otpExpiryMinutes: OTP_EXPIRY_MINUTES,
      maxOtpAttempts: OTP_MAX_ATTEMPTS,
      otpResendWindowHours: OTP_RESEND_WINDOW_HOURS,
      otpMaxResendsPerWindow: OTP_MAX_RESENDS_PER_WINDOW,
    });

    return { settings };
  }

  async upsertSetting(user: JwtPayload, dto: UpsertSettingDto) {
    const clientId = user.clientId;

    // Key-specific guard: the two KYC review-SLA targets drive the breach buckets on the
    // KYC dashboard (kycDashboard()). A non-integer / out-of-range value would poison those
    // metrics, so reject anything outside KYC_SLA_MIN_HOURS–KYC_SLA_MAX_HOURS business hours
    // here (the FE SettingRow also enforces the same min/max — defence in depth).
    if (dto.key === KYC_FIELD_SLA_KEY || dto.key === KYC_GIFSY_SLA_KEY) {
      const n = typeof dto.value === 'string' ? parseInt(dto.value, 10) : Number(dto.value);
      if (!Number.isInteger(n) || n < KYC_SLA_MIN_HOURS || n > KYC_SLA_MAX_HOURS) {
        throw new BadRequestException(
          `${dto.key} must be a whole number between ${KYC_SLA_MIN_HOURS} and ${KYC_SLA_MAX_HOURS}.`,
        );
      }
      // Persist a normalised integer so the stored value never carries a stray string/float.
      dto.value = n;
    }

    // For the TDS policy (a money-path config), capture the PRIOR value BEFORE the write so
    // the dedicated audit row below records the exact old→new transition (W0-C).
    const isTdsPolicyWrite = dto.key === 'tdsPolicy' || dto.key === 'tds';
    let priorTdsPolicyValue: unknown = null;
    if (isTdsPolicyWrite) {
      const prior = await this.prisma.programSetting.findUnique({
        where: { clientId_settingKey: { clientId, settingKey: dto.key } },
        select: { settingValue: true },
      });
      priorTdsPolicyValue = prior?.settingValue ?? null;
    }

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

    // W0-C — dedicated TDS-policy audit: entityId = clientId (the policy is per-tenant, not
    // per-settings-row), oldValues/newValues = the prior/next policy. Additive to the generic
    // PROGRAM_SETTINGS row above so the money-path config change is traceable on its own.
    if (isTdsPolicyWrite) {
      await this.prisma.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'TdsPolicy',
          entityId: clientId,
          actorId: user.sub,
          oldValues: (priorTdsPolicyValue ?? undefined) as Prisma.InputJsonValue | undefined,
          newValues: (dto.value ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    }

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
   * Reads the current features (now sourced from the `clients` table), merges
   * only the `visibilityCaptureMode` key (preserves every other feature flag),
   * writes it straight back to `clients.features`, then busts the TenantService
   * in-memory cache so the change is visible immediately.
   *
   * The GET path is already covered by GET /v1/admin/settings/config which
   * returns the full `features` object including `visibilityCaptureMode`.
   */
  async setVisibilityCaptureMode(user: JwtPayload, dto: SetVisibilityCaptureModeDto) {
    const clientId = user.clientId;
    // Read the merge-base FRESH (not the 5-min-cached resolveClient) so a concurrent
    // feature edit on another instance can't be clobbered by this read-modify-write.
    const row = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { features: true },
    });
    if (!row) throw new NotFoundException(`Unknown client: "${clientId}".`);
    const current = (row.features ?? {}) as Record<string, unknown>;

    // Merge — only update visibilityCaptureMode; all other feature flags are preserved.
    const features = {
      ...current,
      visibilityCaptureMode: dto.mode,
    };

    await this.prisma.client.update({
      where: { id: clientId },
      data:  { features: features as any },
    });
    this.tenant.invalidateCache(clientId);

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

  /**
   * GET /v1/admin/settings/points-expiry — read the tenant's default points-expiry.
   *
   * The single source of truth is the ACTIVE DEFAULT PointExpiryConfig row
   * ({ clientId, isDefault: true, isActive: true }) — the same row resolveExpiresAt()
   * falls back to when a lot has no scheme-specific config. Scheme-specific configs are
   * intentionally NOT consulted here; this surface only manages the tenant-wide default.
   *
   * Returns `{ pointsExpiryDays: null }` when there is no active default row (never expire).
   */
  async getPointsExpiry(user: JwtPayload): Promise<{ pointsExpiryDays: number | null }> {
    const config = await this.prisma.pointExpiryConfig.findFirst({
      where: { clientId: user.clientId, isDefault: true, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    return { pointsExpiryDays: config?.expiryDays ?? null };
  }

  /**
   * PUT /v1/admin/settings/points-expiry — set the tenant's default points-expiry.
   *
   * There is NO unique constraint on (clientId, isDefault), so we find-then-update the
   * default row rather than using prisma.upsert. Only the `isDefault: true` row is
   * touched — scheme-specific configs are never modified.
   *
   *   - positive N → upsert the default row to { expiryDays: N, isActive: true }.
   *   - null       → deactivate the default (isActive: false). "Never expire" means the
   *                  default row no longer matches resolveExpiresAt()'s active-default
   *                  fallback; we deactivate (not delete) so a prior value can be restored.
   */
  async setPointsExpiry(
    user: JwtPayload,
    dto: SetPointsExpiryDto,
  ): Promise<{ pointsExpiryDays: number | null }> {
    const clientId = user.clientId;
    // The operator tenant ('gifsy') has no wallets/points — expiry is a loyalty-tenant
    // setting. Require an assumed-tenant context so we never write an orphan config.
    if (clientId === 'gifsy') {
      throw new BadRequestException(
        'Points expiry applies to a loyalty tenant — assume a client before setting it.',
      );
    }

    if (dto.pointsExpiryDays !== null) {
      const days = dto.pointsExpiryDays;
      // Find-then-update the single default row. A partial unique index
      // (clientId WHERE isDefault) guarantees at most one default per tenant, so a
      // concurrent first-write races to P2002 — catch it and retry as an update.
      const upsertDefault = async (): Promise<void> => {
        const existing = await this.prisma.pointExpiryConfig.findFirst({
          where: { clientId, isDefault: true },
          orderBy: { createdAt: 'asc' },
        });
        if (existing) {
          await this.prisma.pointExpiryConfig.update({
            where: { id: existing.id },
            data: { expiryDays: days, isActive: true },
          });
        } else {
          await this.prisma.pointExpiryConfig.create({
            data: {
              clientId,
              schemeId: null,
              isDefault: true,
              isActive: true,
              expiryDays: days,
              warningDaysBefore: 7,
            },
          });
        }
      };
      try {
        await upsertDefault();
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          await upsertDefault(); // row now exists → update path
        } else {
          throw e;
        }
      }
    } else {
      // Never expire — deactivate the default row(s) for this tenant (do NOT delete).
      await this.prisma.pointExpiryConfig.updateMany({
        where: { clientId, isDefault: true },
        data: { isActive: false },
      });
    }

    await this.prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'POINT_EXPIRY_CONFIG',
        entityId: clientId,
        actorId: user.sub,
        metadata: { pointsExpiryDays: dto.pointsExpiryDays },
      },
    });

    return { pointsExpiryDays: dto.pointsExpiryDays };
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
          // isParent:false — parents (owner-group anchors) are non-operating; they must not
          // inflate the active-partners KPI (docs/plans/PARTNER-MULTI-OUTLET.md §9).
          where: { clientId, isActive: true, deletedAt: null, isParent: false },
        }),

        this.prisma.kycSubmission.count({
          where: {
            user: { clientId },
            status: { in: AdminCoreService.PENDING_KYC_STATUSES },
          },
        }),

        // Visibility (POSM) captures awaiting Gifsy approval (keyed per-outlet, clientId direct).
        this.prisma.visibilityCapture.count({
          where: {
            clientId,
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
  // DASHBOARD — admin/dashboard/kyc (KYC program-health aggregation)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Field-approval pending bucket: an addressable outlet whose latest submission
   * sits in any of the pre-Gifsy review states (covers the full SO/ASM/RSM chain
   * that slaMetrics() bug (a) misses).
   */
  private static readonly KYC_PENDING_FIELD_STATUSES: ReadonlySet<KycStatus> = new Set<KycStatus>([
    'SUBMITTED',
    'UNDER_REVIEW',
    'PENDING_PENNY_DROP',
    'PENDING_AGREEMENT',
    'PENDING_SO_APPROVAL',
    'PENDING_ASM_APPROVAL',
    'PENDING_RSM_APPROVAL',
  ]);

  /** Rejected / re-upload / re-KYC / suspended → "not approved, needs action". */
  private static readonly KYC_REJECT_REUPLOAD_STATUSES: ReadonlySet<KycStatus> = new Set<KycStatus>([
    'REJECTED',
    'RE_UPLOAD_REQUIRED',
    'RESUBMISSION_REQUIRED',
    'RE_KYC_REQUIRED',
    'SUSPENDED',
  ]);

  private static readonly KYC_HOUR_MS = 1000 * 60 * 60;

  /**
   * Resolve the tenant's two configurable KYC review-SLA targets (business hours): the
   * field-stage target (submitted → reached Gifsy) and the Gifsy-stage target (latest
   * PENDING_GIFSY entry → decision). Reads the two per-tenant programSetting rows; each is
   * bounds-checked to KYC_SLA_MIN_HOURS–KYC_SLA_MAX_HOURS and falls back to KYC_FIELD_SLA_DEFAULT
   * (24) / KYC_GIFSY_SLA_DEFAULT (96) when the row is absent or holds an out-of-range value.
   */
  private async resolveKycSlaTargets(
    clientId: string,
  ): Promise<{ fieldHrs: number; gifsyHrs: number }> {
    const rows = await this.prisma.programSetting.findMany({
      where: { clientId, settingKey: { in: [KYC_FIELD_SLA_KEY, KYC_GIFSY_SLA_KEY] } },
      select: { settingKey: true, settingValue: true },
    });
    const resolve = (key: string, fallback: number): number => {
      const raw = rows.find((r) => r.settingKey === key)?.settingValue;
      const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
      if (!Number.isInteger(n) || n < KYC_SLA_MIN_HOURS || n > KYC_SLA_MAX_HOURS) return fallback;
      return n;
    };
    return {
      fieldHrs: resolve(KYC_FIELD_SLA_KEY, KYC_FIELD_SLA_DEFAULT),
      gifsyHrs: resolve(KYC_GIFSY_SLA_KEY, KYC_GIFSY_SLA_DEFAULT),
    };
  }

  /** mean of a numeric array; 0 for an empty array (no NaN). */
  private static mean(xs: number[]): number {
    return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  }

  /** % of samples <= threshold; 100 when there are no samples. */
  private static compliancePct(xs: number[], thresholdHours: number): number {
    if (xs.length === 0) return 100;
    return (xs.filter((h) => h <= thresholdHours).length / xs.length) * 100;
  }

  private static round1(n: number): number {
    return Math.round(n * 10) / 10;
  }

  /**
   * GET /v1/admin/dashboard/kyc — real KYC-program-health aggregation.
   *
   * Tenant scope is resolved identically to dashboardKpis(): strictly by
   * `user.clientId`. The proxy/JWT layer sets `clientId` to the assumed tenant
   * for an operator-context GIFSY token and to the operator's own (empty) gifsy
   * tenant when native — so GIFSY-native / assumed-tenant / CLIENT_ADMIN all
   * behave exactly like the rest of the admin dashboard. Every query below is
   * tenant-filtered (no cross-tenant leak — fixes slaMetrics() bug (b)).
   */
  async kycDashboard(user: JwtPayload) {
    const clientId = user.clientId;
    const now = Date.now();
    // KYC SLA ages count BUSINESS hours only (Mon–Fri, minus the national holiday
    // calendar) — the stage targets are business hours, not calendar. The two targets are
    // per-tenant configurable (field 24h / gifsy 96h defaults), resolved once here.
    const holidays = await loadHolidaySet(this.prisma);
    const { fieldHrs, gifsyHrs } = await this.resolveKycSlaTargets(clientId);

    // ── Addressable universe + the canonical per-outlet status derivation ──────
    // ONE findMany with latest-submission include (mirrors buildOutlets): no N+1.
    const [addressableOutlets, notInterested, inactive, reUploadCount, totalSubmissions, rejectionHistory] =
      await Promise.all([
        this.prisma.outlet.findMany({
          // Addressable = every live outlet we are trying to onboard. New outlets are
          // created PENDING (isActive=false) and only flip active on KYC approval, so
          // filtering isActive=true would exclude the entire in-flight KYC population
          // (the very thing this dashboard tracks). The correct exclusions are deleted,
          // NOT_INTERESTED, and genuinely DEACTIVATED (deactivatedAt set) — pending
          // outlets have deactivatedAt=null and stay in the universe.
          where: {
            clientId,
            deletedAt: null,
            deactivatedAt: null,
            // Prisma's `{ notIn }` EXCLUDES NULL rows. Almost every outlet has
            // kycIntent=NULL (only sales-marked ones are NOT_INTERESTED, admin-parked ones
            // PARKED), so an explicit OR is required to keep them — otherwise addressable → 0.
            // BOTH NOT_INTERESTED (declined) and PARKED (admin-removed from pipeline) are
            // excluded from the addressable universe so coverage% isn't depressed by them.
            OR: [{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }],
          },
          select: {
            id: true,
            state: true,
            programName: true,
            outletType: { select: { code: true } },
            partner: {
              select: {
                kycSubmissions: {
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                  select: {
                    status: true,
                    submittedAt: true,
                    approvedAt: true,
                    createdAt: true,
                    statusHistory: {
                      select: { toStatus: true, createdAt: true },
                    },
                  },
                },
              },
            },
          },
        }),

        // Informational counts — NOT part of the coverage denominator.
        this.prisma.outlet.count({
          where: { clientId, deletedAt: null, kycIntent: 'NOT_INTERESTED' },
        }),
        this.prisma.outlet.count({
          // Genuinely DEACTIVATED (not merely KYC-pending) — deactivatedAt is set.
          // OR keeps kycIntent=NULL rows (Prisma `not` would drop them).
          where: {
            clientId,
            deletedAt: null,
            deactivatedAt: { not: null },
            OR: [{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }],
          },
        }),

        // Quality — re-upload rate over ALL submissions in scope (tenant-filtered).
        this.prisma.kycSubmission.count({
          where: { user: { clientId }, status: 'RE_UPLOAD_REQUIRED' },
        }),
        this.prisma.kycSubmission.count({
          where: { user: { clientId } },
        }),

        // Rejection-reason tally — TENANT-FILTERED via kycSubmission → user.clientId
        // (slaMetrics() bug (b) was the missing tenant filter here).
        this.prisma.kycStatusHistory.findMany({
          where: { toStatus: 'REJECTED', kycSubmission: { user: { clientId } } },
          select: { notes: true },
        }),
      ]);

    const addressableCount = addressableOutlets.length;

    // ── Status grouping (buildOutlets derivation, applied per addressable outlet) ──
    let approved = 0;
    let awaitingGifsy = 0;
    let pendingField = 0;
    let rejectedOrReupload = 0;
    let rejectedCount = 0; // currently-REJECTED only (for approvalRate denom)
    let inProgress = 0; // DRAFT
    let notStarted = 0; // no submission

    // Per-stage SLA bucket detail.
    let pendingFieldWithin = 0;
    let pendingFieldBreached = 0;
    let pendingGifsyWithin = 0;
    let pendingGifsyBreached = 0;

    // SLA distributions (over APPROVED submissions with submittedAt present).
    const fieldChainHours: number[] = [];
    const gifsyReviewHours: number[] = [];
    const endToEndHours: number[] = [];

    // coverageBy accumulators
    const byState = new Map<string, { addressable: number; approved: number }>();
    const byType = new Map<string, { addressable: number; approved: number }>();
    const byProgram = new Map<string, { addressable: number; approved: number }>();

    const bump = (
      m: Map<string, { addressable: number; approved: number }>,
      rawKey: string | null | undefined,
      isApproved: boolean,
    ) => {
      const key = rawKey && rawKey.trim().length > 0 ? rawKey : 'Unspecified';
      const e = m.get(key) ?? { addressable: 0, approved: 0 };
      e.addressable += 1;
      if (isApproved) e.approved += 1;
      m.set(key, e);
    };

    // LATEST KycStatusHistory.createdAt where toStatus === 'PENDING_GIFSY'. The Gifsy clock
    // "restarts on re-entry": a bounced KYC that re-enters the Gifsy queue is timed from its
    // most-recent arrival, not its first. Used for the LIVE Gifsy bucket + the Gifsy-review tile.
    const enteredPendingGifsyAt = (
      history: { toStatus: KycStatus; createdAt: Date }[],
    ): Date | null => {
      let latest: Date | null = null;
      for (const h of history) {
        if (h.toStatus !== 'PENDING_GIFSY') continue;
        if (latest === null || h.createdAt.getTime() > latest.getTime()) {
          latest = h.createdAt;
        }
      }
      return latest;
    };

    // FIRST (earliest) entry into PENDING_GIFSY — the field chain's initial hand-off to Gifsy.
    // The field-chain tile must measure submitted → FIRST hand-off (pure field time); using the
    // LATEST entry would wrongly absorb a bounced KYC's first Gifsy review + rework into "field".
    const firstEnteredPendingGifsyAt = (
      history: { toStatus: KycStatus; createdAt: Date }[],
    ): Date | null => {
      let first: Date | null = null;
      for (const h of history) {
        if (h.toStatus !== 'PENDING_GIFSY') continue;
        if (first === null || h.createdAt.getTime() < first.getTime()) {
          first = h.createdAt;
        }
      }
      return first;
    };

    for (const o of addressableOutlets) {
      const sub = o.partner?.kycSubmissions[0] ?? null;
      const status: KycStatus | 'NOT_STARTED' = sub ? sub.status : 'NOT_STARTED';
      const isApproved = status === 'APPROVED';

      if (isApproved) {
        approved += 1;
      } else if (status === 'PENDING_GIFSY') {
        awaitingGifsy += 1;
      } else if (
        status !== 'NOT_STARTED' &&
        AdminCoreService.KYC_PENDING_FIELD_STATUSES.has(status)
      ) {
        pendingField += 1;
      } else if (
        status !== 'NOT_STARTED' &&
        AdminCoreService.KYC_REJECT_REUPLOAD_STATUSES.has(status)
      ) {
        rejectedOrReupload += 1;
        if (status === 'REJECTED') rejectedCount += 1;
      } else if (status === 'DRAFT') {
        inProgress += 1;
      } else {
        notStarted += 1; // NOT_STARTED (no submission)
      }

      bump(byState, o.state, isApproved);
      bump(byType, o.outletType?.code, isApproved);
      bump(byProgram, o.programName ?? 'Unassigned', isApproved);

      // ── Per-stage SLA detail ──
      if (status !== 'NOT_STARTED' && sub) {
        if (AdminCoreService.KYC_PENDING_FIELD_STATUSES.has(status)) {
          // age = business hours since submittedAt (fall back to createdAt if null)
          const startTs = (sub.submittedAt ?? sub.createdAt).getTime();
          const ageH = businessHoursBetween(startTs, now, holidays);
          if (ageH <= fieldHrs) pendingFieldWithin += 1;
          else pendingFieldBreached += 1;
        } else if (status === 'PENDING_GIFSY') {
          // clock = business hours since entering PENDING_GIFSY; fall back submittedAt → createdAt
          const enteredAt = enteredPendingGifsyAt(sub.statusHistory);
          const startTs = (enteredAt ?? sub.submittedAt ?? sub.createdAt).getTime();
          const ageH = businessHoursBetween(startTs, now, holidays);
          if (ageH <= gifsyHrs) pendingGifsyWithin += 1;
          else pendingGifsyBreached += 1;
        }
      }

      // ── SLA distributions over APPROVED submissions (submittedAt present) ──
      // Business hours (Mon–Fri minus holidays) so the turnaround tiles match the SLA clock.
      // Field chain = submitted → FIRST hand-off to Gifsy (pure field time, matching the field
      // SLA). Gifsy review = LATEST Gifsy entry → approval (restart-on-re-entry, matching the
      // Gifsy SLA). For a clean (never-bounced) KYC first === latest, so both are unchanged; for
      // a bounced KYC this keeps the first Gifsy review + rework out of the "field" tile.
      if (isApproved && sub && sub.submittedAt) {
        const submittedTs = sub.submittedAt.getTime();
        const firstEnteredAt = firstEnteredPendingGifsyAt(sub.statusHistory);
        const lastEnteredAt = enteredPendingGifsyAt(sub.statusHistory);
        if (firstEnteredAt) {
          fieldChainHours.push(
            businessHoursBetween(submittedTs, firstEnteredAt.getTime(), holidays),
          );
        }
        if (lastEnteredAt && sub.approvedAt) {
          gifsyReviewHours.push(
            businessHoursBetween(lastEnteredAt.getTime(), sub.approvedAt.getTime(), holidays),
          );
        }
        if (sub.approvedAt) {
          endToEndHours.push(businessHoursBetween(submittedTs, sub.approvedAt.getTime(), holidays));
        }
      }
    }

    const inPipeline = pendingField + awaitingGifsy;

    // ── Headline metrics ──
    const coveragePct =
      addressableCount > 0 ? (approved / addressableCount) * 100 : 0;
    const approvalDenom = approved + rejectedCount;
    const approvalRatePct =
      approvalDenom > 0 ? (approved / approvalDenom) * 100 : 100;

    // ── Quality: rejection reasons (tenant-filtered), top 8 by count desc ──
    const reasonTally: Record<string, number> = {};
    for (const r of rejectionHistory) {
      const reason = r.notes && r.notes.trim().length > 0 ? r.notes : 'Unspecified';
      reasonTally[reason] = (reasonTally[reason] ?? 0) + 1;
    }
    const topRejectionReasons = Object.entries(reasonTally)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    const reUploadRatePct =
      totalSubmissions > 0 ? (reUploadCount / totalSubmissions) * 100 : 0;

    // ── coverageBy serialiser: {key, addressable, approved, coveragePct}, top 25 ──
    const serialiseCoverage = (m: Map<string, { addressable: number; approved: number }>) =>
      Array.from(m.entries())
        .map(([key, v]) => ({
          key,
          addressable: v.addressable,
          approved: v.approved,
          coveragePct:
            v.addressable > 0
              ? AdminCoreService.round1((v.approved / v.addressable) * 100)
              : 0,
        }))
        .sort((a, b) => b.addressable - a.addressable)
        .slice(0, 25);

    // ── Resolve the tenant slug for the scope echo (mirrors getTenantConfig). ──
    let tenantSlug = 'ALL';
    if (clientId) {
      try {
        const cfg = await this.tenant.resolveClient(clientId);
        tenantSlug = cfg.slug;
      } catch {
        // Unknown/unresolvable tenant — fall back to the raw clientId rather than 500.
        tenantSlug = clientId;
      }
    }

    return {
      scope: { tenant: tenantSlug, generatedAt: new Date().toISOString() },
      universe: {
        addressableOutlets: addressableCount,
        notInterested,
        inactive,
      },
      headline: {
        coveragePct: AdminCoreService.round1(coveragePct),
        approved,
        inPipeline,
        pendingField,
        awaitingGifsy,
        rejectedOrReupload,
        notStarted,
        approvalRatePct: AdminCoreService.round1(approvalRatePct),
      },
      funnel: [
        { stage: 'Not started', count: notStarted },
        { stage: 'In progress', count: inProgress },
        { stage: 'Submitted (field approval)', count: pendingField },
        { stage: 'Pending Gifsy', count: awaitingGifsy },
        { stage: 'Approved', count: approved },
      ],
      buckets: {
        pendingFieldApproval: {
          count: pendingField,
          withinSla: pendingFieldWithin,
          breached: pendingFieldBreached,
          slaHours: fieldHrs,
        },
        pendingGifsyApproval: {
          count: awaitingGifsy,
          withinSla: pendingGifsyWithin,
          breached: pendingGifsyBreached,
          slaHours: gifsyHrs,
        },
      },
      sla: {
        fieldChainAvgHours: AdminCoreService.round1(AdminCoreService.mean(fieldChainHours)),
        gifsyReviewAvgHours: AdminCoreService.round1(AdminCoreService.mean(gifsyReviewHours)),
        endToEndAvgHours: AdminCoreService.round1(AdminCoreService.mean(endToEndHours)),
        fieldCompliancePct: AdminCoreService.round1(
          AdminCoreService.compliancePct(fieldChainHours, fieldHrs),
        ),
        gifsyCompliancePct: AdminCoreService.round1(
          AdminCoreService.compliancePct(gifsyReviewHours, gifsyHrs),
        ),
        sampleSize: endToEndHours.length,
      },
      quality: {
        topRejectionReasons,
        reUploadRatePct: AdminCoreService.round1(reUploadRatePct),
      },
      coverageBy: {
        state: serialiseCoverage(byState),
        outletType: serialiseCoverage(byType),
        program: serialiseCoverage(byProgram),
      },
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
