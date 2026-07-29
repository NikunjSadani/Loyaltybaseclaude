import { Controller, Get, Put, Body, Query } from '@nestjs/common';
import { AdminCoreService } from '../admin-core/admin-core.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { UpsertSettingDto } from '../admin-core/dto/settings.dto';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide } from '../common/tenant-scope';
import { Roles } from '../common/decorators/roles.decorator';
import { GetTdsConfigQueryDto, SetTdsConfigDto } from './dto/tds-config.dto';

/**
 * Gifsy per-tenant TDS-policy config — Wave 1 Stream C, §5 portal split.
 *
 *   PUT /v1/admin/tds/config   { clientId, section, methodology }   — GIFSY_ADMIN-only SET
 *   GET /v1/admin/tds/config?clientId=                              — GIFSY (any) / tenant (own)
 *
 * SET is GIFSY-only (Gifsy governs TGSL's deduct/deposit/recovery per tenant — D2/D3). The write
 * goes through the EXISTING settings write path (AdminCoreService.upsertSetting with
 * settingKey='tdsPolicy') so the W0-C config-change AuditLog fires and the TenantSettingsService
 * cache is busted — never a re-implementation of the money-path write. The `section`/`methodology`
 * are @IsEnum-validated against the Prisma enums by the DTO before they reach the store.
 *
 * GET is readable by the owning tenant (CLIENT_ADMIN, pinned to their own clientId) as well as
 * GIFSY (any tenant via ?clientId=), so a tenant can see (read-only) the policy applied to it.
 */
@Controller('admin/tds/config')
export class TdsConfigController {
  constructor(
    private readonly adminCore: AdminCoreService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /**
   * GET the effective per-tenant TDS policy. CLIENT_ADMIN is pinned to their own tenant (any
   * ?clientId= is ignored); GIFSY_ADMIN may read any tenant via ?clientId= (defaulting to their
   * own JWT clientId). Absent config → the default-on default {SEC_194C, GROSS_UP}; a stored
   * malformed value fails closed inside resolveTdsPolicy (money-path hardening, W0-A).
   */
  @Get()
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  async get(@CurrentUser() user: JwtPayload, @Query() q: GetTdsConfigQueryDto) {
    // Only an un-assumed GIFSY may read another tenant via ?clientId=; a tenant admin OR
    // an ASSUMED operator is pinned to their own (assumed) clientId.
    const clientId = platformWide(user) && q.clientId ? q.clientId : user.clientId;
    const policy = await this.tenantSettings.resolveTdsPolicy(clientId);
    return { clientId, section: policy.section, methodology: policy.methodology };
  }

  /**
   * SET the per-tenant TDS policy (GIFSY_ADMIN-only). Writes via upsertSetting under the TARGET
   * tenant's scope by passing a payload whose clientId is dto.clientId — the audit attribution
   * (actorId) stays the real operator (user.sub) and that tenant's settings cache is busted.
   */
  @Put()
  @Roles('GIFSY_ADMIN')
  async set(@CurrentUser() user: JwtPayload, @Body() dto: SetTdsConfigDto) {
    const settingDto: UpsertSettingDto = {
      key: 'tdsPolicy',
      value: { section: dto.section, methodology: dto.methodology },
      category: 'tds',
      description: 'Per-tenant TDS treatment for visibility-stream payouts (section + methodology).',
    };

    // Write under the target tenant's scope; operator identity is preserved for the audit.
    await this.adminCore.upsertSetting({ ...user, clientId: dto.clientId }, settingDto);

    return { clientId: dto.clientId, section: dto.section, methodology: dto.methodology };
  }
}
