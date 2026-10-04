import { Controller, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AdminCoreService } from './admin-core.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

/**
 * Employee Rewards Phase A — per-tenant hierarchy LEVELS config (the ladder + custom level names +
 * per-level coarse-role mapping), on /v1/admin/hierarchy-levels. GIFSY_ADMIN or CLIENT_ADMIN.
 *
 * Mirrors AdminHierarchyConfigController. GET returns the RESOLVED config (stored-or-Deoleo). PUT
 * replaces the tenant config; the service validates the shape (contiguous levels, one leaf / one
 * root, unique codes, valid sales userRoles) and upserts the single ProgramSetting row.
 */
@Controller('admin/hierarchy-levels')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class AdminHierarchyLevelsController {
  constructor(private readonly svc: AdminCoreService) {}

  @Get()
  @RequirePermission('sales_org:read')
  get(@CurrentUser() user: JwtPayload) {
    return this.svc.getHierarchyLevels(user);
  }

  /**
   * PUT reads the RAW Express body (not a `@Body()`-bound DTO) for the same reason as
   * hierarchy-config: the global ValidationPipe (whitelist + transform + implicit conversion) can
   * mangle untyped passthrough objects. Accepts `{ levels: [...] }` (or a bare array as a
   * convenience); `setHierarchyLevels` validates every row and rejects anything malformed with a 400.
   */
  @Put()
  @RequirePermission('sales_org:manage_hierarchy')
  save(@CurrentUser() user: JwtPayload, @Req() req: Request) {
    const body = (req.body ?? {}) as { levels?: unknown } | unknown[];
    const levels = Array.isArray(body) ? body : body.levels;
    return this.svc.setHierarchyLevels(user, levels);
  }
}
