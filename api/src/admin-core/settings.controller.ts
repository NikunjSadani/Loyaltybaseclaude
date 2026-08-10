import { Body, Controller, Get, Put } from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  SetHolidaysDto,
  SetPointsExpiryDto,
  SetVisibilityCaptureModeDto,
  UpsertSettingDto,
} from './dto/settings.dto';

/**
 * Tenant program settings + non-secret tenant config — re-homed from
 * platform/src/app/api/admin/settings/* onto /v1/admin/settings.
 *
 * GET (settings + config): GIFSY_ADMIN or CLIENT_ADMIN.
 * PUT (settings upsert):   GIFSY_ADMIN only (matches the source role check).
 *
 * Visibility capture mode:
 *   GET  /config          — already returns features.visibilityCaptureMode (read).
 *   PUT  /visibility-capture-mode — GIFSY_ADMIN only (tenancy:manage_flags).
 */
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(private readonly svc: AdminCoreService) {}

  @Get()
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('tenancy:read')
  get(@CurrentUser() user: JwtPayload) {
    return this.svc.getSettings(user);
  }

  @Put()
  @Roles('GIFSY_ADMIN') // settings PUT is Gifsy-Admin-only in the source route
  @RequirePermission('tenancy:write')
  upsert(@CurrentUser() user: JwtPayload, @Body() dto: UpsertSettingDto) {
    return this.svc.upsertSetting(user, dto);
  }

  @Get('config')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('tenancy:read')
  getConfig(@CurrentUser() user: JwtPayload) {
    return this.svc.getTenantConfig(user);
  }

  /**
   * PUT /v1/admin/settings/visibility-capture-mode
   *
   * Sets the visibility data-capture mode for the caller's tenant.
   * Restricted to GIFSY_ADMIN — visibility capture mode is a tenancy/operating
   * config that only Gifsy operates (per the RBAC model: TENANCY.MANAGE_FLAGS
   * ∈ GIFSY_OPERATED_PERMISSIONS).
   *
   * Body: { mode: 'PHOTO_APPROVAL' | 'AMOUNT_UPLOAD' }
   * Returns: { mode: <saved value> }
   * Errors: 400 if mode is not one of the two valid enum values.
   *
   * The GET side is served by GET /config (features.visibilityCaptureMode).
   */
  @Put('visibility-capture-mode')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:manage_flags')
  setVisibilityCaptureMode(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SetVisibilityCaptureModeDto,
  ) {
    return this.svc.setVisibilityCaptureMode(user, dto);
  }

  /**
   * GET /v1/admin/settings/points-expiry — read the tenant's default points-expiry.
   *
   * GIFSY_ADMIN or CLIENT_ADMIN may read (tenancy:read). Returns
   * { pointsExpiryDays: number | null } where null = points never expire.
   */
  @Get('points-expiry')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('tenancy:read')
  getPointsExpiry(@CurrentUser() user: JwtPayload) {
    return this.svc.getPointsExpiry(user);
  }

  /**
   * PUT /v1/admin/settings/points-expiry — set the tenant's default points-expiry.
   *
   * GIFSY_ADMIN only (mirrors the settings PUT role policy — points expiry is a
   * Gifsy-operated program config). Body: { pointsExpiryDays: number | null }
   * (null = never expire; a positive integer = days).
   */
  @Put('points-expiry')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:write')
  setPointsExpiry(@CurrentUser() user: JwtPayload, @Body() dto: SetPointsExpiryDto) {
    return this.svc.setPointsExpiry(user, dto);
  }

  /**
   * GET /v1/admin/settings/holidays — the PLATFORM-global national holiday calendar the KYC
   * business-hours SLA clock pauses on. GIFSY_ADMIN or CLIENT_ADMIN may read (a tenant admin's
   * KYC list needs it to age rows correctly). Returns { holidays: [{ date, label }] } — the
   * stored override, else the code default (gazetted national holidays).
   */
  @Get('holidays')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('tenancy:read')
  getHolidays() {
    return this.svc.getNationalHolidays();
  }

  /**
   * PUT /v1/admin/settings/holidays — replace the platform national holiday calendar.
   * GIFSY_ADMIN only (it is platform-level operator config, not per-tenant). Body:
   * { holidays: [{ date: 'YYYY-MM-DD', label }] }. Returns the saved, de-duped, sorted list.
   */
  @Put('holidays')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:write')
  setHolidays(@CurrentUser() user: JwtPayload, @Body() dto: SetHolidaysDto) {
    return this.svc.setNationalHolidays(user, dto);
  }
}
