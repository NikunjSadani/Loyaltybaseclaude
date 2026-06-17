import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { SchemesService } from './schemes.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  CreateSchemeDto,
  ListSchemesQueryDto,
  UpdateSchemeDto,
} from './dto/schemes.dto';

/**
 * Schemes API — re-homed from platform/src/app/api/schemes/* onto /v1.
 * Thin adapter: auth (JWT) + tenant scope come from @CurrentUser(); RBAC via
 * @RequirePermission (flag-gated); admin-only writes via @Roles. Responses are
 * enveloped globally by TransformInterceptor. The World-A incentive compute
 * route (schemes/calculate) is intentionally not ported.
 */
@Controller('schemes')
export class SchemesController {
  constructor(private readonly schemes: SchemesService) {}

  @Get()
  @RequirePermission('schemes:read')
  list(@CurrentUser() user: JwtPayload, @Query() query: ListSchemesQueryDto) {
    return this.schemes.list(user, query);
  }

  @Post()
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('schemes:write')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateSchemeDto) {
    return this.schemes.create(user, dto);
  }

  @Get(':id')
  @RequirePermission('schemes:read')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.schemes.getOne(user, id);
  }

  @Patch(':id')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('schemes:write')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateSchemeDto) {
    return this.schemes.update(user, id, dto);
  }

  @Delete(':id')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('schemes:delete')
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.schemes.remove(user, id);
  }
}
