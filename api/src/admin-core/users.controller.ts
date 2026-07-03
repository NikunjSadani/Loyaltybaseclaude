import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  BulkEditUsersDto,
  CreateUserDto,
  ListUsersQueryDto,
  UpdateUserDto,
} from './dto/users.dto';

/**
 * Admin user management — re-homed from platform/src/app/api/admin/users/* onto
 * /v1/admin/users. User-management routes are GIFSY_ADMIN or CLIENT_ADMIN, except
 * DELETE which is GIFSY_ADMIN only (matching the Next route). RBAC via
 * @RequirePermission (flag-gated). Tenant scope comes from @CurrentUser().
 */
@Controller('admin/users')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class AdminUsersController {
  constructor(private readonly svc: AdminCoreService) {}

  @Get()
  @RequirePermission('users:read')
  list(@CurrentUser() user: JwtPayload, @Query() query: ListUsersQueryDto) {
    return this.svc.listUsers(user, query);
  }

  @Post()
  @RequirePermission('users:write')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateUserDto) {
    return this.svc.createUser(user, dto);
  }

  @Post('bulk-edit')
  @RequirePermission('users:write')
  bulkEdit(@CurrentUser() user: JwtPayload, @Body() dto: BulkEditUsersDto) {
    return this.svc.bulkEditUsers(user, dto);
  }

  @Get(':id')
  @RequirePermission('users:read')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.svc.getUser(user, id);
  }

  @Patch(':id')
  @RequirePermission('users:write')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.svc.updateUser(user, id, dto);
  }

  /**
   * POST /admin/users/:id/revoke-sessions — admin per-user "log this user out of all
   * devices" (Feature 10-ii). Same roles + permission as updateUser; the service
   * enforces the tenant scope. Signs the user out within the session window / on next
   * refresh (not instantly — see the service caveat).
   */
  @Post(':id/revoke-sessions')
  @RequirePermission('users:write')
  revokeSessions(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.svc.revokeUserSessions(user, id);
  }

  @Delete(':id')
  @Roles('GIFSY_ADMIN') // DELETE is Gifsy-Admin-only in the source route
  @RequirePermission('users:delete')
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.svc.deleteUser(user, id);
  }
}
