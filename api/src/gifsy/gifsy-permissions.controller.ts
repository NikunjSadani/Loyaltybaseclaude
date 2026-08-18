import { Controller, Get } from '@nestjs/common';
import { GifsyRolesService } from './gifsy-roles.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

/**
 * RBAC Option-X (P1) — the permission catalog surface for the FE role editor.
 * Route at /v1/gifsy/permissions. Shares the 'gifsy' base path with the existing
 * GifsyController (allowed — the method paths differ). OWNER-only, same gate as
 * the role CRUD; the service re-gates with platformWide().
 */
@Controller('gifsy')
export class GifsyPermissionsController {
  constructor(private readonly roles: GifsyRolesService) {}

  @Get('permissions')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('users:manage_roles')
  getPermissionCatalog(@CurrentUser() user: JwtPayload) {
    return this.roles.getPermissionCatalog(user);
  }
}
