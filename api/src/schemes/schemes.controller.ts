import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { SchemesService } from './schemes.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  CreateSchemeDto,
  ListSchemesQueryDto,
  UpdateSchemeDto,
  UpsertEnrollmentFormDto,
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

  // ───────────────────────────────────────────────────────────────────────────
  // P4.2 — Enrollment-form routes
  // Note: `:id/enrollment-form` is a deeper path than `:id` and does NOT
  // conflict with the existing `:id` param routes — NestJS resolves these
  // routes in declaration order and a sub-path always wins over a bare param.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * PUT /v1/schemes/:id/enrollment-form
   *
   * Admin-only upsert of the configurable enrollment form for a scheme.
   * Validates tenant ownership + formSchema structure before writing.
   */
  @Put(':id/enrollment-form')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('schemes:write')
  upsertEnrollmentForm(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpsertEnrollmentFormDto,
  ) {
    return this.schemes.upsertEnrollmentForm(user, id, dto);
  }

  /**
   * GET /v1/schemes/:id/enrollment-form
   *
   * Returns the enrollment form for a scheme. Returns 404 if none configured.
   * Validates tenant ownership before reading.
   */
  @Get(':id/enrollment-form')
  @RequirePermission('schemes:read')
  getEnrollmentForm(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.schemes.getEnrollmentForm(user, id);
  }
}
