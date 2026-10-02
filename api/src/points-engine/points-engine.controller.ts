/**
 * PointsEngineController — Points Compute Engine rule CRUD (Wave 0).
 *
 * Routes (all under /v1/admin/points-rules):
 *   GET    /v1/admin/points-rules            list rules (query: status, ruleId, program, kpiCode)
 *   GET    /v1/admin/points-rules/:id        get one rule
 *   POST   /v1/admin/points-rules            create a draft (optionally a new version of a ruleId)
 *   PATCH  /v1/admin/points-rules/:id        update a draft (only while status=draft)
 *   POST   /v1/admin/points-rules/:id/publish    publish a draft (→ immutable published version)
 *   POST   /v1/admin/points-rules/:id/archive    archive a rule
 *
 * Thin adapter: auth + tenant scope come from @CurrentUser(); role floor via @Roles and the
 * fine-grained gate via @RequirePermission. Authoring (write) is GIFSY_ADMIN + CLIENT_ADMIN
 * self-serve (decision §12 #5); the MONEY path (direct credit) is gated separately in Wave 2.
 */

import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PointsEngineService } from './points-engine.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  CreatePointsRuleDto,
  ListPointsRulesQueryDto,
  UpdatePointsRuleDto,
} from './dto/points-rule.dto';

@Controller('admin/points-rules')
export class PointsEngineController {
  constructor(private readonly points: PointsEngineService) {}

  /** GET /v1/admin/points-rules — list tenant rules (filterable). */
  @Get()
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('points_rules:read')
  list(@CurrentUser() user: JwtPayload, @Query() q: ListPointsRulesQueryDto) {
    return this.points.list(user, q);
  }

  /** GET /v1/admin/points-rules/:id — get one rule. */
  @Get(':id')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('points_rules:read')
  get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.points.get(user, id);
  }

  /** POST /v1/admin/points-rules — create a draft rule. */
  @Post()
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('points_rules:write')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreatePointsRuleDto) {
    return this.points.createDraft(user, dto);
  }

  /** PATCH /v1/admin/points-rules/:id — update a draft (only while status=draft). */
  @Patch(':id')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('points_rules:write')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdatePointsRuleDto,
  ) {
    return this.points.updateDraft(user, id, dto);
  }

  /** POST /v1/admin/points-rules/:id/publish — publish a draft. */
  @Post(':id/publish')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('points_rules:write')
  publish(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.points.publish(user, id);
  }

  /** POST /v1/admin/points-rules/:id/archive — archive a rule. */
  @Post(':id/archive')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('points_rules:write')
  archive(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.points.archive(user, id);
  }
}
