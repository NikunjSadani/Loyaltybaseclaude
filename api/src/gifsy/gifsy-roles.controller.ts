import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { GifsyRolesService } from './gifsy-roles.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { CreateGifsyRoleDto, UpdateGifsyRoleDto } from './dto/gifsy-roles.dto';

/**
 * RBAC Option-X (P1) — self-service Gifsy role-editor CRUD API.
 * Routes at /v1/gifsy/roles (global /v1 prefix). Owner-only: @Roles('GIFSY_ADMIN') +
 * @RequirePermission('users:manage_roles'). NOTE: RolesGuard admits ANY GIFSY_ADMIN
 * including an ASSUMED one, so the route does NOT block an assumed operator — each SERVICE
 * method re-gates with platformWide() (role === 'GIFSY_ADMIN' && !assumed), which is the
 * sole assumed-operator rejecter and must never be dropped. Controllers return RAW payloads
 * (the global TransformInterceptor wraps them).
 */
@Controller('gifsy/roles')
export class GifsyRolesController {
  constructor(private readonly roles: GifsyRolesService) {}

  @Get()
  @Roles('GIFSY_ADMIN')
  @RequirePermission('users:manage_roles')
  list(@CurrentUser() user: JwtPayload) {
    return this.roles.listRoles(user);
  }

  @Post()
  @Roles('GIFSY_ADMIN')
  @RequirePermission('users:manage_roles')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateGifsyRoleDto) {
    return this.roles.createRole(user, dto);
  }

  @Patch(':id')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('users:manage_roles')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateGifsyRoleDto,
  ) {
    return this.roles.updateRole(user, id, dto);
  }

  @Delete(':id')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('users:manage_roles')
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.roles.deleteRole(user, id);
  }
}
