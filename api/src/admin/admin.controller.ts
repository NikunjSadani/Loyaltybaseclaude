import {
  Controller, Get, Post, Put, Body, Param, Query,
  ForbiddenException, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Roles }    from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

import { TenantService }           from '../tenant/tenant.service';
import { UsersService }            from '../users/users.service';
import { OutletTypeConfigService } from './outlet-type-config.service';
import { UpsertClientDto, CreateClientUserDto, UpsertOutletTypeConfigDto } from './dto/admin.dto';

// ── Helper ────────────────────────────────────────────────────────────────────

/** Throws if a non-GIFSY_ADMIN user tries to act on a different client. */
function assertTenantAccess(requestedSlug: string, user: JwtPayload): void {
  if (user.role === 'GIFSY_ADMIN') return;
  if (user.clientId !== requestedSlug) {
    throw new ForbiddenException(
      'You can only manage resources for your own client.',
    );
  }
}

// ── Controller ────────────────────────────────────────────────────────────────

@Controller('admin')
export class AdminController {
  constructor(
    private readonly tenantSvc:          TenantService,
    private readonly usersSvc:           UsersService,
    private readonly outletTypeConfigSvc: OutletTypeConfigService,
  ) {}

  // ── Client management (GIFSY_ADMIN only) ──────────────────────────────────

  /** List all onboarded clients */
  @Get('clients')
  @Roles('GIFSY_ADMIN')
  listClients(@CurrentUser() _user: JwtPayload) {
    return this.tenantSvc.listAllClients();
  }

  /** Get one client by slug */
  @Get('clients/:slug')
  @Roles('GIFSY_ADMIN')
  getClient(@Param('slug') slug: string, @CurrentUser() _user: JwtPayload) {
    return this.tenantSvc.resolveClient(slug);
  }

  /** Create or update a client's configuration */
  @Post('clients')
  @Roles('GIFSY_ADMIN')
  @HttpCode(HttpStatus.OK)
  async upsertClient(@Body() dto: UpsertClientDto, @CurrentUser() _user: JwtPayload) {
    await this.tenantSvc.upsertClientConfig(dto.slug, dto as any);
    return { ok: true, slug: dto.slug };
  }

  /** Create a user under a specific client tenant */
  @Post('clients/:slug/users')
  @Roles('GIFSY_ADMIN')
  createClientUser(
    @Param('slug') slug: string,
    @Body()        dto:  CreateClientUserDto,
    @CurrentUser() _user: JwtPayload,
  ) {
    return this.usersSvc.createUser({ ...dto, clientId: slug });
  }

  /** List users under a specific client tenant */
  @Get('clients/:slug/users')
  @Roles('GIFSY_ADMIN')
  listClientUsers(
    @Param('slug') slug: string,
    @Query()       query: { role?: string; status?: string; page?: string; limit?: string },
    @CurrentUser() _user: JwtPayload,
  ) {
    return this.usersSvc.listUsers(slug, {
      role:   query.role,
      status: query.status,
      page:   query.page  ? +query.page  : 1,
      limit:  query.limit ? +query.limit : 20,
    });
  }

  // ── Outlet type configs (GIFSY_ADMIN or CLIENT_ADMIN of that tenant) ───────

  /** Get all outlet type configs for a client */
  @Get('clients/:slug/outlet-type-configs')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  async getOutletTypeConfigs(
    @Param('slug') slug: string,
    @CurrentUser() user: JwtPayload,
  ) {
    assertTenantAccess(slug, user);
    return this.outletTypeConfigSvc.getAll(slug);
  }

  /** Upsert outlet type config for one outlet type code */
  @Put('clients/:slug/outlet-type-configs/:code')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  async upsertOutletTypeConfig(
    @Param('slug') slug: string,
    @Param('code') code: string,
    @Body()        dto:  UpsertOutletTypeConfigDto,
    @CurrentUser() user: JwtPayload,
  ) {
    assertTenantAccess(slug, user);
    return this.outletTypeConfigSvc.upsert(slug, code, dto);
  }
}
