import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { GifsyService } from './gifsy.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { CreateClientDto, UpdateOutletTypeConfigDto } from './dto/gifsy.dto';

/**
 * GIFSY platform super-admin API — re-homed from
 * platform/src/app/api/gifsy/clients/* onto /v1. Every route is GIFSY_ADMIN-only
 * (@Roles) and operates cross-tenant by design: client listing spans all tenants
 * and outlet-type configs are keyed by the path :slug, not the caller's clientId.
 * RBAC via @RequirePermission (flag-gated); responses enveloped globally.
 */
@Controller('gifsy')
export class GifsyController {
  constructor(private readonly gifsy: GifsyService) {}

  @Get('overview')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:read')
  getOverview(@CurrentUser() user: JwtPayload) {
    return this.gifsy.getOverview(user);
  }

  @Post('clients')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:write')
  createClient(@CurrentUser() user: JwtPayload, @Body() dto: CreateClientDto) {
    return this.gifsy.createClient(user, dto);
  }

  @Get('clients')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:read')
  listClients(@CurrentUser() user: JwtPayload) {
    return this.gifsy.listClients(user);
  }

  @Get('clients/:slug')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:read')
  getClientDetail(@CurrentUser() user: JwtPayload, @Param('slug') slug: string) {
    return this.gifsy.getClientDetail(user, slug);
  }

  @Get('clients/:slug/outlet-type-configs')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:read')
  getOutletTypeConfigs(@CurrentUser() user: JwtPayload, @Param('slug') slug: string) {
    return this.gifsy.getOutletTypeConfigs(user, slug);
  }

  @Put('clients/:slug/outlet-type-configs/:code')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('tenancy:write')
  updateOutletTypeConfig(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Param('code') code: string,
    @Body() dto: UpdateOutletTypeConfigDto,
  ) {
    return this.gifsy.updateOutletTypeConfig(user, slug, code, dto);
  }
}
