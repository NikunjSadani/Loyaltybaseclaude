import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { ReportsService, ReportResult } from './reports.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ReportRangeQueryDto, TdsReportQueryDto } from './dto/reports.dto';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Reporting & Analytics API — re-homed from platform/src/app/api/reports/* onto
 * /v1. Thin adapter: auth (JWT) + tenant scope come from @CurrentUser(); RBAC
 * via @RequirePermission (flag-gated) and the GIFSY_ADMIN | MIS_USER role gate
 * the source routes enforced. JSON responses are enveloped globally; xlsx
 * responses are returned as a StreamableFile, which the interceptor passes
 * through unwrapped as an attachment download.
 *
 * SKIPPED: GET /reports/billing-trends — its only source is SalesInvoice, a
 * dropped World-A model. Not ported.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Turns a service ReportResult into either a plain JSON payload or a download. */
  private respond(result: ReportResult): unknown | StreamableFile {
    if (result.kind === 'xlsx') {
      return new StreamableFile(result.buffer, {
        type: XLSX_MIME,
        disposition: `attachment; filename="${result.filename}"`,
      });
    }
    return result.data;
  }

  @Get('visibility-status')
  @Roles('GIFSY_ADMIN', 'MIS_USER')
  @RequirePermission('reports:read')
  async visibilityStatus(@CurrentUser() user: JwtPayload, @Query() query: ReportRangeQueryDto) {
    return this.respond(await this.reports.visibilityStatus(user, query));
  }

  @Get('scheme-performance')
  @Roles('GIFSY_ADMIN', 'MIS_USER')
  @RequirePermission('reports:read')
  async schemePerformance(@CurrentUser() user: JwtPayload, @Query() query: ReportRangeQueryDto) {
    return this.respond(await this.reports.schemePerformance(user, query));
  }

  @Get('tds')
  @Roles('GIFSY_ADMIN', 'MIS_USER')
  @RequirePermission('reports:read')
  async tds(@CurrentUser() user: JwtPayload, @Query() query: TdsReportQueryDto) {
    return this.respond(await this.reports.tds(user, query));
  }

  @Get('payout-liability')
  @Roles('GIFSY_ADMIN', 'MIS_USER')
  @RequirePermission('reports:read')
  async payoutLiability(@CurrentUser() user: JwtPayload, @Query() query: ReportRangeQueryDto) {
    return this.respond(await this.reports.payoutLiability(user, query));
  }

  @Get('engagement')
  @Roles('GIFSY_ADMIN', 'MIS_USER')
  @RequirePermission('reports:read')
  async engagement(@CurrentUser() user: JwtPayload, @Query() query: ReportRangeQueryDto) {
    return this.respond(await this.reports.engagement(user, query));
  }

  @Get('kyc-status')
  @Roles('GIFSY_ADMIN', 'MIS_USER')
  @RequirePermission('reports:read')
  async kycStatus(@CurrentUser() user: JwtPayload, @Query() query: ReportRangeQueryDto) {
    return this.respond(await this.reports.kycStatus(user, query));
  }
}
