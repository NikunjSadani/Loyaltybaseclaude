import { Controller, Delete, Get, Headers, Param, Query } from '@nestjs/common';
import { SchemesService } from './schemes.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ListSchemesQueryDto } from './dto/schemes.dto';

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

  // Open to all in-tenant roles: tenant scheme browsing; service tenant-scopes.
  @Get()
  @RequirePermission('schemes:read')
  list(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListSchemesQueryDto,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.schemes.list(user, query, activePartnerId);
  }

  // Open to all in-tenant roles: tenant scheme browsing; service tenant-scopes.
  @Get(':id')
  @RequirePermission('schemes:read')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.schemes.getOne(user, id);
  }

  @Delete(':id')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('schemes:delete')
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.schemes.remove(user, id);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // P4.2 — Enrollment-form READ route
  // Note: `:id/enrollment-form` is a deeper path than `:id` and does NOT
  // conflict with the existing `:id` param routes — NestJS resolves these
  // routes in declaration order and a sub-path always wins over a bare param.
  // The admin PUT (upsert) now lives in SchemeAdminController; enrollment
  // submission/read moved to SchemeEnrollmentController.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * GET /v1/schemes/:id/enrollment-form
   *
   * Returns the enrollment form for a scheme. Returns 404 if none configured.
   * Validates tenant ownership before reading.
   */
  // Open to all in-tenant roles: tenant scheme browsing; service tenant-scopes.
  @Get(':id/enrollment-form')
  @RequirePermission('schemes:read')
  getEnrollmentForm(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.schemes.getEnrollmentForm(user, id);
  }
}
