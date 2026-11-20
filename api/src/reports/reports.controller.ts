import { Controller, Get, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { ReportsService, ReportResult } from './reports.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ReportFormat, ReportRangeQueryDto, TdsReportQueryDto } from './dto/reports.dto';
import { ExportsService } from '../exports/exports.service';
import { UsageReportQueryDto } from './dto/usage-report.dto';
import { LocationComplianceQueryDto } from './dto/location-compliance.dto';
import { RedemptionReportQueryDto } from './dto/redemption-report.dto';
import { resolveRedemptionParams } from './redemptions/redemption-report.query';

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
  constructor(
    private readonly reports: ReportsService,
    private readonly exports: ExportsService,
  ) {}

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
  async visibilityStatus(
    @CurrentUser() user: JwtPayload,
    @Query() query: ReportRangeQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // xlsx → the 'visibility-status' export kind: a range of ≤ 1 month streams now (200); open-ended / longer ranges
    // are queued (202 → Downloads). The master-switch 403 is checked first, as before.
    if (query.format === ReportFormat.XLSX) {
      await this.reports.assertVisibilityStatusAllowed(user);
      return this.exports.respond(res, user, 'visibility-status', query);
    }
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

  @Get('session-report')
  @Roles('GIFSY_ADMIN', 'MIS_USER', 'CLIENT_ADMIN')
  @RequirePermission('reports:read')
  async sessionReport(@CurrentUser() user: JwtPayload, @Query() query: ReportRangeQueryDto) {
    return this.respond(await this.reports.sessionReport(user, query));
  }

  /**
   * GET /v1/reports/usage — per-user Usage Report (same access as the Session Report). JSON = one page of rows +
   * totals; `format=xlsx` = every filtered row through the 'usage-report' export kind (streams; 404 when none match).
   */
  @Get('usage')
  @Roles('GIFSY_ADMIN', 'MIS_USER', 'CLIENT_ADMIN')
  @RequirePermission('reports:read')
  async usage(
    @CurrentUser() user: JwtPayload,
    @Query() query: UsageReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (query.format === ReportFormat.XLSX) return this.exports.respond(res, user, 'usage-report', query);
    return this.respond(await this.reports.usageReport(user, query));
  }

  /**
   * GET /v1/reports/location-compliance/enabled — `{ enabled }` for the caller's tenant (features.requireLocation), with
   * EXACTLY the report's roles + permission, so the reports index shows the tile exactly when the report would answer
   * (MIS_USER cannot read /admin/settings/config). Declared before the report route.
   */
  @Get('location-compliance/enabled')
  @Roles('GIFSY_ADMIN', 'MIS_USER', 'CLIENT_ADMIN')
  @RequirePermission('reports:read')
  async locationComplianceEnabled(@CurrentUser() user: JwtPayload) {
    return this.reports.locationComplianceEnabled(user);
  }

  /**
   * GET /v1/reports/location-compliance — per-rep location compliance (LOCATION-GATE.md). Same access as the Usage
   * report. `format=xlsx` = every filtered row through the 'location-compliance' export kind (streams; 404 when none).
   */
  @Get('location-compliance')
  @Roles('GIFSY_ADMIN', 'MIS_USER', 'CLIENT_ADMIN')
  @RequirePermission('reports:read')
  async locationCompliance(
    @CurrentUser() user: JwtPayload,
    @Query() query: LocationComplianceQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (query.format === ReportFormat.XLSX) return this.exports.respond(res, user, 'location-compliance', query);
    return this.respond(await this.reports.locationCompliance(user, query));
  }

  /**
   * GET /v1/reports/redemptions — on-screen summary for the Reports hub "Redemption report" card (totals, per-status
   * counts, whether the Excel will be prepared in the background, zone/state picker values).
   * Roles = the payments-report precedent (money + personal data): GIFSY_ADMIN + CLIENT_ADMIN, NOT MIS_USER.
   * Tenant: CLIENT_ADMIN / assumed operator pinned to the JWT tenant; un-assumed GIFSY_ADMIN must pass ?clientId=.
   */
  @Get('redemptions')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('reports:read')
  async redemptions(@CurrentUser() user: JwtPayload, @Query() query: RedemptionReportQueryDto) {
    return this.reports.redemptionSummary(user, query);
  }

  /**
   * GET /v1/reports/redemptions/export — the 'redemption-report' Excel kind (Redemptions · Status history · Summary ·
   * About). ≤ 31 days streams now (200); longer ranges are prepared on the Downloads page (202). 0 rows → 404.
   * The default range (current IST month) is filled in HERE so a queued request stores explicit dates.
   */
  @Get('redemptions/export')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('reports:read')
  async redemptionsExport(
    @CurrentUser() user: JwtPayload,
    @Query() query: RedemptionReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const p = resolveRedemptionParams(query, user, new Date());
    return this.exports.respond(res, user, 'redemption-report', { ...query, from: p.from, to: p.to });
  }

  @Get('kyc-status')
  @Roles('GIFSY_ADMIN', 'MIS_USER', 'CLIENT_ADMIN')
  @RequirePermission('reports:read')
  async kycStatus(
    @CurrentUser() user: JwtPayload,
    @Query() query: ReportRangeQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // xlsx → the 'kyc-status' export kind (full outlet snapshot → always queued, 202 → Downloads).
    if (query.format === ReportFormat.XLSX) return this.exports.respond(res, user, 'kyc-status', query);
    return this.respond(await this.reports.kycStatus(user, query));
  }
}
