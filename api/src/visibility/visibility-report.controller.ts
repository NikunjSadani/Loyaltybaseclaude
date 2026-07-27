import { Controller, Get, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { VisibilityReportService } from './visibility-report.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { VisibilityReportQueryDto } from './dto/visibility-capture.dto';

/**
 * Visibility (POSM) REPORT API (D15). Base path `/v1/visibility`.
 *   GET report         — GIFSY coverage report
 *   GET report/tenant  — CLIENT_ADMIN read-only (same shape)
 *   GET report/export  — xlsx export (GIFSY + CLIENT_ADMIN)
 * Static `report*` paths do not collide with any `:id` param route.
 */
@Controller('visibility')
export class VisibilityReportController {
  constructor(private readonly report: VisibilityReportService) {}

  // ── GIFSY coverage report ──────────────────────────────────────────────────
  @Get('report')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('visibility:read')
  gifsyReport(@CurrentUser() user: JwtPayload, @Query() query: VisibilityReportQueryDto) {
    return this.report.gifsyReport(user, query.windowKey);
  }

  // ── CLIENT_ADMIN read-only report ──────────────────────────────────────────
  @Get('report/tenant')
  @Roles('CLIENT_ADMIN')
  @RequirePermission('visibility:read')
  tenantReport(@CurrentUser() user: JwtPayload, @Query() query: VisibilityReportQueryDto) {
    return this.report.tenantReport(user, query.windowKey);
  }

  // ── xlsx export (auth-gated media links) ───────────────────────────────────
  @Get('report/export')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('visibility:read')
  async export(
    @CurrentUser() user: JwtPayload,
    @Query() query: VisibilityReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.report.exportCaptures(user, query.windowKey);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    return file;
  }
}
