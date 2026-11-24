import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import {
  TenantSettingsService,
  VisibilityConfigSettings,
} from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { validateFormSchema } from './visibility-form.helper';
import { SetVisibilityConfigDto, ScopeOutletsQueryDto } from './dto/visibility-admin.dto';
import { resolveVisibilityProgramLists, visibilityUniverseBase, withVisibilityProgramWhere } from './visibility-scope.helper';

/**
 * VisibilityAdminService — GIFSY_ADMIN authoring for the Visibility (POSM) feature:
 *   • config (outlet scope / monthly frequency / allowed sales levels / geo-fence),
 *     stored in `program_settings` under the `visibilityConfig` key (the same store
 *     the Gifsy Settings panel uses), and
 *   • the versioned capture FORM (VisibilityForm + append-only VisibilityFormVersion),
 *     mirroring the Scheme enrollment-form versioning.
 *
 * Every method is gated on the per-tenant master switch `visibilityEnabled`; the write
 * methods additionally require capture-mode PHOTO_APPROVAL (the AMOUNT_UPLOAD Excel path
 * is a different, untouched surface). Config/form are singular per tenant (D17).
 */
@Injectable()
export class VisibilityAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  // ── Gates ───────────────────────────────────────────────────────────────────

  /** Master switch — every visibility method 403s when the tenant is OFF (fail-closed). */
  private async assertEnabled(clientId: string): Promise<void> {
    if (!(await this.tenant.resolveVisibilityEnabled(clientId))) {
      throw new ForbiddenException('Visibility is not enabled for this tenant.');
    }
  }

  /** Writes only apply in PHOTO_APPROVAL mode (the AMOUNT_UPLOAD path is separate). */
  private async assertPhotoMode(clientId: string): Promise<void> {
    const mode = await this.tenant.resolveVisibilityCaptureMode(clientId);
    if (mode !== 'PHOTO_APPROVAL') {
      throw new ForbiddenException(
        'Visibility photo-approval mode is not active for this tenant.',
      );
    }
  }

  // ── Config (settings-backed) ─────────────────────────────────────────────────

  /** The tenant's effective visibility config (typed + validated by the settings reader). */
  async getConfig(clientId: string): Promise<VisibilityConfigSettings> {
    await this.assertEnabled(clientId);
    const settings = await this.tenantSettings.getEffectiveSettings(clientId);
    return settings.visibilityConfig;
  }

  /**
   * Write the WHOLE visibilityConfig block (REPLACE-WHOLE nested key — the settings
   * overlay rebuilds the complete config from a partial/malformed value, so the writer
   * must always send the full object; the DTO enforces every field is present). Mirrors
   * AdminCoreService.upsertSetting: upsert the program_settings row, audit it, and bust
   * the typed-settings cache so the new config is visible immediately. Returns the
   * re-read effective config (normalized by the overlay).
   */
  async setConfig(
    user: JwtPayload,
    dto: SetVisibilityConfigDto,
  ): Promise<{ visibilityConfig: VisibilityConfigSettings }> {
    const clientId = user.clientId;
    await this.assertEnabled(clientId);
    await this.assertPhotoMode(clientId);

    // APPLIES-TO (plan §4): programs / subPrograms — an ABSENT key carries over the stored list (a
    // stale editor tab must never wipe it); a present key is validated + canonicalised (400 on an
    // unknown value). They are written ONLY when non-empty (the settings overlay defaults an absent
    // key to [] = all), so a tenant that never sets them stores exactly the pre-scope JSON.
    // Fresh read (cache busted) so the carry-over never copies a ≤5-min-stale list from another instance.
    this.tenantSettings.invalidate(clientId);
    const current = await this.tenantSettings.getEffectiveSettings(clientId);
    const lists = await resolveVisibilityProgramLists(
      this.prisma,
      clientId,
      current,
      { programs: dto.programs, subPrograms: dto.subPrograms },
      current.visibilityConfig,
    );

    // Sales photo view levels (tenant-scoped): ABSENT → carry the stored list; present → trimmed + de-duplicated. Stored
    // only when non-empty, so a tenant that never turns it on keeps exactly today's JSON.
    const photoLevels =
      dto.salesPhotoViewLevels === undefined || dto.salesPhotoViewLevels === null
        ? [...(current.visibilityConfig.salesPhotoViewLevels ?? [])]
        : [...new Set(dto.salesPhotoViewLevels.map((s) => String(s).trim()).filter(Boolean))];

    const value: Prisma.InputJsonValue = {
      outletScope: dto.outletScope,
      frequencyPerMonth: dto.frequencyPerMonth,
      allowedSalesLevels: dto.allowedSalesLevels,
      geoFence: { enabled: dto.geoFence.enabled, radiusMeters: dto.geoFence.radiusMeters },
      ...(lists.programs.length ? { programs: lists.programs } : {}),
      ...(lists.subPrograms.length ? { subPrograms: lists.subPrograms } : {}),
      ...(photoLevels.length ? { salesPhotoViewLevels: photoLevels } : {}),
    };

    const setting = await this.prisma.programSetting.upsert({
      where: { clientId_settingKey: { clientId, settingKey: 'visibilityConfig' } },
      update: { settingValue: value, updatedById: user.sub },
      create: {
        clientId,
        settingKey: 'visibilityConfig',
        settingValue: value,
        category: 'visibility',
        description: 'Visibility (POSM) capture configuration',
        updatedById: user.sub,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'PROGRAM_SETTINGS',
        entityId: setting.id,
        actorId: user.sub,
        metadata: { key: 'visibilityConfig', value },
      },
    });

    // Bust the per-instance settings cache so the overlay re-reads this write.
    this.tenantSettings.invalidate(clientId);

    const settings = await this.tenantSettings.getEffectiveSettings(clientId);
    return { visibilityConfig: settings.visibilityConfig };
  }

  // ── Capture form (versioned) ─────────────────────────────────────────────────

  /** The tenant's current capture form, or null if none has been authored yet. */
  async getForm(clientId: string) {
    await this.assertEnabled(clientId);
    return this.prisma.visibilityForm.findUnique({ where: { clientId } });
  }

  /** A specific historical form version (for rendering an old capture coherently, D11). */
  async getFormVersion(clientId: string, version: number) {
    await this.assertEnabled(clientId);
    const snap = await this.prisma.visibilityFormVersion.findUnique({
      where: { clientId_version: { clientId, version } },
    });
    if (!snap) throw new NotFoundException('Visibility form version not found.');
    return snap;
  }

  /**
   * Upsert the current form AND append an immutable version snapshot in ONE transaction
   * (mirrors SchemeAdminService.upsertEnrollmentForm). The version bumps on every call;
   * the append is guaranteed unique by the monotonically-increasing version
   * (@@unique[clientId, version]). Validated via the pure helper before persisting.
   */
  async upsertForm(user: JwtPayload, formSchema: Record<string, unknown>) {
    const clientId = user.clientId;
    await this.assertEnabled(clientId);
    await this.assertPhotoMode(clientId);

    const errors = validateFormSchema(formSchema);
    if (errors.length > 0) {
      throw new BadRequestException(`Form validation failed: ${errors.join(' | ')}`);
    }
    const schemaJson = formSchema as Prisma.InputJsonValue;

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.visibilityForm.findUnique({ where: { clientId } });
      const nextVersion = (existing?.version ?? 0) + 1;

      const form = await tx.visibilityForm.upsert({
        where: { clientId },
        update: { formSchema: schemaJson, version: nextVersion, updatedAt: new Date() },
        create: { clientId, formSchema: schemaJson, version: nextVersion },
      });

      const formVersion = await tx.visibilityFormVersion.create({
        data: { clientId, version: nextVersion, formSchema: schemaJson },
      });

      return { form, formVersion };
    });
  }

  // ── Outlets in scope (admin view) ────────────────────────────────────────────

  /**
   * The outlets in visibility scope — THE single in-scope rule (visibilityUniverseWhere: not soft-deleted /
   * deactivated, KYC-approved `isActive`, kycIntent not NOT_INTERESTED / PARKED, outletType.code ∈
   * config.outletScope, and the optional programs / subPrograms narrowing). An empty scope yields no outlets
   * (an `in: []` match). Optional name/code/zone/state filters narrow further.
   */
  async listOutletsInScope(clientId: string, filters: ScopeOutletsQueryDto = {}) {
    await this.assertEnabled(clientId);
    const config = await this.getConfig(clientId);

    // THE single in-scope rule (visibilityUniverseBase — the same outlets the report counts and reps can capture).
    // It owns the top-level OR (kycIntent), so the text search goes under AND.
    const where: Prisma.OutletWhereInput = { ...visibilityUniverseBase(clientId, config.outletScope) };
    if (filters.zone) where.zone = filters.zone;
    if (filters.state) where.state = filters.state;
    if (filters.q) {
      where.AND = [
        {
          OR: [
            { name: { contains: filters.q, mode: 'insensitive' } },
            { outletCode: { contains: filters.q, mode: 'insensitive' } },
          ],
        },
      ];
    }

    const outlets = await this.prisma.outlet.findMany({
      // APPLIES-TO (D12): programs/subPrograms narrow the type scope (no-op → `where` unchanged).
      where: withVisibilityProgramWhere(where, config),
      select: {
        id: true,
        outletCode: true,
        name: true,
        outletTypeId: true,
        zone: true,
        state: true,
        latitude: true,
        longitude: true,
        outletType: { select: { code: true, name: true } },
      },
      orderBy: { name: 'asc' },
    });

    return { outlets, outletScope: config.outletScope, total: outlets.length };
  }
}
