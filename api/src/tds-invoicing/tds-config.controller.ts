import { BadRequestException, Controller, ForbiddenException, Get, NotFoundException, Put, Body, Query } from '@nestjs/common';
import { AdminCoreService } from '../admin-core/admin-core.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { TdsService } from '../tds/tds.service';
import { TDS_IMPORTED_PAYOUTS_SETTING_KEY, importedCountFromBounds, parseIsoCalendarDate } from '../tds/tds.helpers';
import { UpsertSettingDto } from '../admin-core/dto/settings.dto';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide } from '../common/tenant-scope';
import { Roles } from '../common/decorators/roles.decorator';
import { GetTdsConfigQueryDto, SetImportedPayoutsConfigDto, SetTdsConfigDto } from './dto/tds-config.dto';

/**
 * Gifsy per-tenant TDS-policy config — Wave 1 Stream C, §5 portal split.
 *
 *   PUT /v1/admin/tds/config   { clientId, section, methodology }   — GIFSY_ADMIN-only SET
 *   GET /v1/admin/tds/config?clientId=                              — GIFSY (any) / tenant (own)
 *   PUT /v1/admin/tds/config/imported-payouts { clientId, countFrom } — GIFSY_ADMIN-only SET
 *   GET /v1/admin/tds/config/imported-payouts?clientId=              — GIFSY (any) / tenant (own)
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
    private readonly tds: TdsService,
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

  /**
   * GET the per-tenant "count imported (vendor) payouts in the 194R report from" date.
   * Same scoping as GET above (tenant admin / assumed operator pinned; un-assumed GIFSY may pass
   * ?clientId=). `countFrom` null = OFF (the default — imported payouts excluded from 194R).
   */
  @Get('imported-payouts')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  async getImportedPayouts(@CurrentUser() user: JwtPayload, @Query() q: GetTdsConfigQueryDto) {
    const clientId = platformWide(user) && q.clientId ? q.clientId : user.clientId;
    if (!(await this.tds.clientExists(clientId))) {
      throw new NotFoundException(`Client "${clientId}" does not exist.`);
    }
    // Editor read: a malformed stored value comes back FLAGGED (not thrown) so the card can repair it.
    return { clientId, ...(await this.tds.importedPayoutsSettingForEdit(clientId)) };
  }

  /**
   * SET the per-tenant imported-payouts date (GIFSY_ADMIN-only). REPORT/LIABILITY-ONLY: it widens
   * the 194R report base (TdsService.compute194R) and nothing else — no withholding, TDS invoice or
   * recovery reads it. Written via upsertSetting with allowPlatformOnlyKey (the generic settings PUT
   * is fenced off for this key), which appends the generic + a dedicated `TdsImportedPayouts`
   * AuditLog (old→new) and busts the settings cache. An ASSUMED operator may only set the tenant
   * they are assumed into.
   */
  @Put('imported-payouts')
  @Roles('GIFSY_ADMIN')
  async setImportedPayouts(@CurrentUser() user: JwtPayload, @Body() dto: SetImportedPayoutsConfigDto) {
    if (!platformWide(user) && dto.clientId !== user.clientId) {
      throw new ForbiddenException('You can only change this setting for the tenant you are working in.');
    }
    const countFrom = dto.countFrom === null ? null : parseIsoCalendarDate(dto.countFrom);
    if (dto.countFrom !== null && countFrom === null) {
      throw new BadRequestException('countFrom must be a real calendar date (YYYY-MM-DD), or null to turn it off.');
    }
    if (countFrom !== null) {
      const { min, max } = importedCountFromBounds();
      if (countFrom < min || countFrom > max) {
        throw new BadRequestException(`countFrom must be between ${min} and ${max} (today + 1 year).`);
      }
    }
    if (!(await this.tds.clientExists(dto.clientId))) {
      throw new NotFoundException(`Client "${dto.clientId}" does not exist.`);
    }
    const settingDto: UpsertSettingDto = {
      key: TDS_IMPORTED_PAYOUTS_SETTING_KEY,
      value: { countFrom },
      category: 'tds',
      description:
        'Count imported (vendor) payouts paid on/after countFrom in the 194R report — liability only, no deduction.',
    };
    await this.adminCore.upsertSetting({ ...user, clientId: dto.clientId }, settingDto, {
      allowPlatformOnlyKey: true,
    });
    return { clientId: dto.clientId, countFrom };
  }
}
