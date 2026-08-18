import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { GifsyStaffService } from './gifsy-staff.service';
import {
  CurrentUser,
  JwtPayload,
} from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { CreateGifsyStaffDto, UpdateGifsyStaffDto } from './dto/gifsy-staff.dto';

/**
 * RBAC Option-X (P1) — Gifsy STAFF management API: /v1/gifsy/staff.
 *
 * Owner-only surface. Route gating: @Roles('GIFSY_ADMIN') + @RequirePermission('users:manage_roles').
 * IMPORTANT: RolesGuard admits ANY GIFSY_ADMIN — including one ASSUMED into a tenant — so the
 * route @Roles is NOT what blocks an assumed operator. Each SERVICE method re-gates with
 * platformWide() (role === 'GIFSY_ADMIN' && !assumed); that service gate is the SOLE rejecter of
 * an assumed operator and must never be dropped. Controllers return raw payloads (the global
 * TransformInterceptor wraps them as { success, data }).
 */
@Controller('gifsy/staff')
export class GifsyStaffController {
  constructor(private readonly staff: GifsyStaffService) {}

  @Get()
  @Roles('GIFSY_ADMIN')
  @RequirePermission('users:manage_roles')
  list(@CurrentUser() user: JwtPayload) {
    return this.staff.listStaff(user);
  }

  @Post()
  @Roles('GIFSY_ADMIN')
  @RequirePermission('users:manage_roles')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateGifsyStaffDto) {
    return this.staff.createStaff(user, dto);
  }

  // Deactivate / reactivate / reassign-role / edit all flow through this one PATCH,
  // mirroring admin updateUser. The service handles the session-revocation invariant.
  @Patch(':id')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('users:manage_roles')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateGifsyStaffDto,
  ) {
    return this.staff.updateStaff(user, id, dto);
  }
}
