import { Controller, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AdminCoreService } from './admin-core.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { HierarchyConfigDto } from './dto/config.dto';

/**
 * Employee-hierarchy config — re-homed from
 * platform/src/app/api/admin/hierarchy-config/route.ts onto
 * /v1/admin/hierarchy-config. GIFSY_ADMIN or CLIENT_ADMIN.
 *
 * GET returns the denormalized JSON snapshot. PUT stores the snapshot AND
 * persists the authoritative relational tree (levels + Users + SalesUsers).
 */
@Controller('admin/hierarchy-config')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class AdminHierarchyConfigController {
  constructor(private readonly svc: AdminCoreService) {}

  @Get()
  @RequirePermission('sales_org:read')
  get(@CurrentUser() user: JwtPayload) {
    return this.svc.getHierarchyConfig(user);
  }

  /**
   * PUT reads the RAW Express body instead of a `@Body()`-bound DTO on purpose.
   *
   * The `employees` array is a denormalized passthrough blob (the FE round-trips it via the
   * ProgramSetting JSON snapshot; the relational shape is validated by the persistence layer). The
   * GLOBAL ValidationPipe runs `whitelist:true` + `transform:true` + `enableImplicitConversion`,
   * which mangles each untyped (`any`) employee object two ways:
   *   (a) `transform` coerces the object into an Array instance → the JSON snapshot then serializes
   *       every employee to `[]` (stored `[[],[]]`), so the page shows 0 rows after a refresh; and
   *   (b) `whitelist` strips the object's (undeclared) props (`roleCode`, …) so the relational
   *       persist throws on `undefined.trim()`.
   * A method-level `@UsePipes` does NOT fix this — NestJS pipes STACK, so the global pipe still runs.
   * Reading `req.body` (the raw Express-parsed JSON, untouched by the pipe) is the reliable bypass.
   * `saveHierarchyConfig` validates `Array.isArray(employees)`; `persistHierarchy` validates shape.
   */
  @Put()
  @RequirePermission('sales_org:manage_hierarchy')
  save(@CurrentUser() user: JwtPayload, @Req() req: Request) {
    return this.svc.saveHierarchyConfig(user, (req.body ?? {}) as HierarchyConfigDto);
  }
}
