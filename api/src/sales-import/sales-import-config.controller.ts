import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { TenantService } from '../tenant/tenant.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalesProfileService } from './kpi/sales-profile.service';
import { SalesKpiDefService, type SalesSegmentOptions } from './kpi/sales-kpi-def.service';
import { assertSalesImportAccess } from './sales-import-access';
import type {
  SalesColumnMapping,
  SalesKpiDefinitionDto,
  SalesKpiDefinitionList,
  SalesKpiDefinitionPatch,
  SalesKpiTestRequest,
  SalesKpiTestResult,
} from './sales-import.contract';

/**
 * Sales Import CONFIG routes (plan §5.2): column mapping + importer-owned KPI definitions.
 *   GET/PUT      admin/sales-import/profile          targets:read / targets:manage_config
 *   GET/POST     admin/sales-import/kpis             targets:read / targets:manage_config
 *   PATCH/DELETE admin/sales-import/kpis/:id         targets:manage_config
 *   POST         admin/sales-import/kpis/test        targets:read  (no write; 404 when `latest` has no READY import)
 *   GET          admin/sales-import/segment-options  targets:read  (Lane F request: outlet types + programmes)
 * OWNER: Lane K. Every handler calls assertSalesImportAccess(user, {tenant, prisma}, {write}) FIRST.
 * Registered BEFORE SalesImportController in SalesImportModule so the static `profile` / `kpis` / `segment-options`
 * segments win over Lane I's `GET admin/sales-import/:id`.
 *
 * Bodies are typed with contract INTERFACES (no class-validator DTO), so the global ValidationPipe passes them through
 * untouched; the services validate every field (and reject unknown filter fields).
 */
@Controller('admin/sales-import')
@Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
export class SalesImportConfigController {
  constructor(
    readonly profiles: SalesProfileService,
    readonly kpis: SalesKpiDefService,
    readonly tenant: TenantService,
    readonly prisma: PrismaService,
  ) {}

  private gate(user: JwtPayload, write: boolean) {
    return assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write });
  }

  @Get('profile')
  @RequirePermission('targets:read')
  async getProfile(@CurrentUser() user: JwtPayload): Promise<SalesColumnMapping | null> {
    await this.gate(user, false);
    return this.profiles.get(user.clientId);
  }

  @Put('profile')
  @RequirePermission('targets:manage_config')
  async putProfile(@CurrentUser() user: JwtPayload, @Body() body: SalesColumnMapping): Promise<SalesColumnMapping> {
    await this.gate(user, true);
    return this.profiles.put(user, body);
  }

  @Get('kpis')
  @RequirePermission('targets:read')
  async listKpis(@CurrentUser() user: JwtPayload): Promise<SalesKpiDefinitionList> {
    await this.gate(user, false);
    return this.kpis.list(user.clientId);
  }

  @Post('kpis/test')
  @RequirePermission('targets:read')
  async testKpi(@CurrentUser() user: JwtPayload, @Body() body: SalesKpiTestRequest): Promise<SalesKpiTestResult> {
    await this.gate(user, false);
    return this.kpis.test(user, body);
  }

  @Post('kpis')
  @RequirePermission('targets:manage_config')
  async createKpi(@CurrentUser() user: JwtPayload, @Body() body: SalesKpiDefinitionDto): Promise<SalesKpiDefinitionDto> {
    await this.gate(user, true);
    return this.kpis.create(user, body);
  }

  @Patch('kpis/:id')
  @RequirePermission('targets:manage_config')
  async patchKpi(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: SalesKpiDefinitionPatch,
  ): Promise<SalesKpiDefinitionDto> {
    await this.gate(user, true);
    return this.kpis.patch(user, id, body);
  }

  @Delete('kpis/:id')
  @RequirePermission('targets:manage_config')
  async deleteKpi(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<SalesKpiDefinitionDto> {
    await this.gate(user, true);
    return this.kpis.disable(user, id);
  }

  @Get('segment-options')
  @RequirePermission('targets:read')
  async segmentOptions(@CurrentUser() user: JwtPayload): Promise<SalesSegmentOptions> {
    await this.gate(user, false);
    return this.kpis.segmentOptions(user.clientId);
  }
}
