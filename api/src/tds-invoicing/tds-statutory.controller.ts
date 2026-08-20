import { Body, Controller, ForbiddenException, Get, Put } from '@nestjs/common';
import { AdminCoreService } from '../admin-core/admin-core.service';
import { UpsertSettingDto } from '../admin-core/dto/settings.dto';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide } from '../common/tenant-scope';
import { Roles } from '../common/decorators/roles.decorator';
import {
  TdsStatutoryConfigService,
  TDS_STATUTORY_CLIENT_ID,
  TDS_STATUTORY_SETTING_KEY,
  validateStatutoryEntries,
} from '../tds/tds-statutory.config.service';
import { SetTdsStatutoryDto } from './dto/tds-statutory.dto';

/**
 * Platform-level, effective-by-FY statutory TDS config (rates + thresholds).
 *
 *   GET /v1/admin/tds/statutory              — CLIENT_ADMIN + GIFSY_ADMIN (read-only view;
 *                                              values are platform-wide, no tenant data)
 *   PUT /v1/admin/tds/statutory { entries }  — GIFSY_ADMIN ONLY, UN-ASSUMED platform context
 *
 * The PUT is intentionally gated on the GIFSY_ADMIN role WITHOUT a @RequirePermission decorator:
 * this keeps a GIFSY_STAFF (permission-gated operator) OUT even if granted any permission (there
 * is no fine gate for RolesGuard to defer to, so a non-owner falls through to the @Roles allow-list
 * → 403). It ADDITIONALLY requires un-assumed platform context (platformWide) — a GIFSY_ADMIN
 * assumed into a tenant gets 403, mirroring the 194C platform-level endpoints. The write goes
 * through AdminCoreService.upsertSetting (settingKey='tdsStatutory', clientId='gifsy') so the
 * config-change AuditLog fires; then the resolver cache is invalidated.
 */
@Controller('admin/tds/statutory')
export class TdsStatutoryController {
  constructor(
    private readonly adminCore: AdminCoreService,
    private readonly statutory: TdsStatutoryConfigService,
  ) {}

  /** GET the raw entries + built-in defaults + the config resolved for the current FY. */
  @Get()
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  async get() {
    return this.statutory.getAll();
  }

  /**
   * PUT the effective-dated statutory entries. GIFSY_ADMIN + un-assumed only. Strict-validates,
   * persists via the existing settings write path (audit + cache-bust), invalidates the resolver
   * cache, and returns the refreshed getAll().
   */
  @Put()
  @Roles('GIFSY_ADMIN')
  async put(@CurrentUser() user: JwtPayload, @Body() dto: SetTdsStatutoryDto) {
    // Platform-level setting — an assumed GIFSY_ADMIN (working inside a tenant) must not edit it.
    if (!platformWide(user)) {
      throw new ForbiddenException(
        'TDS statutory config is a platform-level setting — exit the assumed tenant to edit it.',
      );
    }

    // Strict money-path validation (throws BadRequest naming the offending field).
    const entries = validateStatutoryEntries(dto.entries);

    const settingDto: UpsertSettingDto = {
      key: TDS_STATUTORY_SETTING_KEY,
      value: { entries },
      category: 'tds',
      description:
        'Platform-level statutory TDS rates + thresholds, effective-dated by financial year.',
    };

    // Write under the platform ('gifsy') scope; the real operator identity is preserved for the
    // audit. upsertSetting appends the PROGRAM_SETTINGS AuditLog and busts the tenant-settings cache.
    await this.adminCore.upsertSetting({ ...user, clientId: TDS_STATUTORY_CLIENT_ID }, settingDto);

    // Bust THIS service's resolver cache so the new config is effective immediately.
    this.statutory.invalidate();

    return this.statutory.getAll();
  }
}
