import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { VisibilityReportService } from './visibility-report.service';
import { ExportsService } from '../exports/exports.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { VisibilityReportQueryDto } from './dto/visibility-capture.dto';
import { VisibilityMonthReportQueryDto, VisibilityReportOutletsQueryDto } from './dto/visibility-report.dto';

/**
 * Visibility (POSM) REPORT API (D15). Base path `/v1/visibility`.
 *   GET report                 — GIFSY month report (?month=YYYY-MM [&windowKey=])
 *   GET report/outlets         — GIFSY: the outlets behind a tile / breakdown row (paged)
 *   GET report/tenant          — CLIENT_ADMIN read-only (same shape)
 *   GET report/tenant/outlets  — CLIENT_ADMIN read-only outlet list
 *   GET report/export  — xlsx export (GIFSY + CLIENT_ADMIN)
 * Static `report*` paths do not collide with any `:id` param route.
 */
@Controller('visibility')
export class VisibilityReportController {
  constructor(
    private readonly report: VisibilityReportService,
    private readonly exports: ExportsService,
  ) {}

  // ── GIFSY coverage report ──────────────────────────────────────────────────
  @Get('report')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('visibility:read')
  gifsyReport(@CurrentUser() user: JwtPayload, @Query() query: VisibilityMonthReportQueryDto) {
    return this.report.gifsyReport(user, query);
  }

  @Get('report/outlets')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('visibility:read')
  gifsyOutlets(@CurrentUser() user: JwtPayload, @Query() query: VisibilityReportOutletsQueryDto) {
    return this.report.gifsyOutlets(user, query);
  }

  // ── CLIENT_ADMIN read-only report ──────────────────────────────────────────
  @Get('report/tenant')
  @Roles('CLIENT_ADMIN')
  @RequirePermission('visibility:read')
  tenantReport(@CurrentUser() user: JwtPayload, @Query() query: VisibilityMonthReportQueryDto) {
    return this.report.tenantReport(user, query);
  }

  @Get('report/tenant/outlets')
  @Roles('CLIENT_ADMIN')
  @RequirePermission('visibility:read')
  tenantOutlets(@CurrentUser() user: JwtPayload, @Query() query: VisibilityReportOutletsQueryDto) {
    return this.report.tenantOutlets(user, query);
  }

  // ── xlsx export (photo links → the portal's sign-in-gated photo viewer page) ───────────────────────────────────
  // The 'visibility-captures' export kind (the monthly Visibility report): `?windowKey=` (one window) streams now
  // (200); `?month=YYYY-MM` or nothing (= the current IST month) is queued (202 → Downloads page). The master switch is
  // checked first so a disabled tenant still gets a plain 403.
  @Get('report/export')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('visibility:read')
  async export(
    @CurrentUser() user: JwtPayload,
    @Query() query: VisibilityReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.report.assertEnabled(user.clientId);
    await this.report.assertExportScope(user.clientId, query);
    return this.exports.respond(res, user, 'visibility-captures', query);
  }
}
