/**
 * PointsEngineSettingsController — the dedicated, owner-only writer for the per-tenant Points Engine
 * flags (Wave 2). directCreditEnabled enables an in-portal wallet-crediting shortcut, so — exactly like
 * the TDS-config and notification-templates money/control settings — it is written ONLY here, never via
 * the generic PUT /v1/admin/settings (which is fenced off for the `pointsEngine` key at the data
 * boundary in AdminCoreService.upsertSetting). The write goes through the EXISTING settings write path
 * (upsertSetting with allowPlatformOnlyKey) so the config-change AuditLog fires and the settings cache
 * is busted — never a re-implementation of the settings store.
 *
 *   PUT /v1/admin/points-engine/settings  { clientId, enabled, directCreditEnabled }  (GIFSY_ADMIN-only)
 *   GET /v1/admin/points-engine/settings?clientId=                                     (GIFSY any / tenant own)
 */

import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { AdminCoreService } from '../admin-core/admin-core.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { UpsertSettingDto } from '../admin-core/dto/settings.dto';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide } from '../common/tenant-scope';
import { Roles } from '../common/decorators/roles.decorator';
import {
  GetPointsEngineSettingsQueryDto,
  SetPointsEngineSettingsDto,
} from './dto/points-engine-settings.dto';

@Controller('admin/points-engine/settings')
export class PointsEngineSettingsController {
  constructor(
    private readonly adminCore: AdminCoreService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /**
   * GET the effective per-tenant Points Engine flags. CLIENT_ADMIN is pinned to their own (assumed)
   * tenant; an un-assumed GIFSY_ADMIN may read any tenant via ?clientId= (defaulting to their own).
   */
  @Get()
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  async get(@CurrentUser() user: JwtPayload, @Query() q: GetPointsEngineSettingsQueryDto) {
    const clientId = platformWide(user) && q.clientId ? q.clientId : user.clientId;
    const s = await this.tenantSettings.getEffectiveSettings(clientId);
    return {
      clientId,
      enabled: s.pointsEngine.enabled,
      directCreditEnabled: s.pointsEngine.directCreditEnabled,
    };
  }

  /**
   * SET the per-tenant Points Engine flags (GIFSY_ADMIN-only). Writes under the TARGET tenant's scope
   * via upsertSetting with allowPlatformOnlyKey; operator identity (user.sub) is preserved for the audit.
   */
  @Put()
  @Roles('GIFSY_ADMIN')
  async set(@CurrentUser() user: JwtPayload, @Body() dto: SetPointsEngineSettingsDto) {
    const settingDto: UpsertSettingDto = {
      key: 'pointsEngine',
      value: { enabled: dto.enabled, directCreditEnabled: dto.directCreditEnabled },
      category: 'pointsEngine',
      description:
        'Points Compute Engine per-tenant flags (preview enabled + Gifsy-gated in-portal direct crediting).',
    };
    await this.adminCore.upsertSetting({ ...user, clientId: dto.clientId }, settingDto, {
      allowPlatformOnlyKey: true,
    });
    return {
      clientId: dto.clientId,
      enabled: dto.enabled,
      directCreditEnabled: dto.directCreditEnabled,
    };
  }
}
