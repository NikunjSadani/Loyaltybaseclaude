import { Controller, Get, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { TdsReportsService, ReportScope } from './tds-reports.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import {
  PayoutReportQueryDto,
  RecoveryReportQueryDto,
  UnregisteredReportQueryDto,
} from './dto/tds-reports.dto';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Visibility-payout TDS reports controller — Wave 1 Stream C, §6 / §5 portal split.
 *
 *   GET /v1/admin/tds-reports/payouts[/export]       — CLIENT_ADMIN (own) or GIFSY_ADMIN (any)
 *   GET /v1/admin/tds-reports/unregistered[/export]  — GIFSY_ADMIN only (RCM source, D6)
 *   GET /v1/admin/tds-reports/recovery[/export]      — CLIENT_ADMIN (own liability) or GIFSY_ADMIN
 *
 * Tenant scope is resolved HERE from the JWT, never trusted from the query: a CLIENT_ADMIN is
 * always pinned to their own clientId (any ?clientId= is ignored), so a tenant admin can never
 * read another tenant's data; a GIFSY_ADMIN may pass ?clientId= to scope to one tenant or omit
 * it for platform-wide.
 */
@Controller('admin/tds-reports')
export class TdsReportsController {
  constructor(private readonly reports: TdsReportsService) {}

  /**
   * The effective tenant scope: CLIENT_ADMIN → own clientId (query ignored); GIFSY_ADMIN →
   * ?clientId= if supplied else undefined (platform-wide). Mirrors tds.controller's cross-scope
   * rule so a tenant admin is structurally incapable of reading cross-tenant.
   */
  private resolveClientId(user: JwtPayload, queryClientId?: string): string | undefined {
    return user.role === 'GIFSY_ADMIN' ? queryClientId : user.clientId;
  }

  // ─── Payout report (GST reg type + frozen TDS treatment) ───────────────────
  @Get('payouts')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  payouts(@CurrentUser() user: JwtPayload, @Query() q: PayoutReportQueryDto) {
    const scope: ReportScope = { clientId: this.resolveClientId(user, q.clientId), period: q.period };
    return this.reports.payoutReport(scope);
  }

  @Get('payouts/export')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  async payoutsExport(
    @CurrentUser() user: JwtPayload,
    @Query() q: PayoutReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const scope: ReportScope = { clientId: this.resolveClientId(user, q.clientId), period: q.period };
    const { buffer, filename } = await this.reports.payoutReportXlsx(scope);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return new StreamableFile(buffer, { type: XLSX_MIME });
  }

  // ─── Unregistered-retailer / RCM report (GIFSY-only) ───────────────────────
  @Get('unregistered')
  @Roles('GIFSY_ADMIN')
  unregistered(@Query() q: UnregisteredReportQueryDto) {
    // GIFSY-only: clientId is a straight operator filter (no tenant claim to defend against).
    const scope: ReportScope = { clientId: q.clientId, period: q.period };
    return this.reports.unregisteredReport(scope);
  }

  @Get('unregistered/export')
  @Roles('GIFSY_ADMIN')
  async unregisteredExport(
    @Query() q: UnregisteredReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const scope: ReportScope = { clientId: q.clientId, period: q.period };
    const { buffer, filename } = await this.reports.unregisteredReportXlsx(scope);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return new StreamableFile(buffer, { type: XLSX_MIME });
  }

  // ─── TDS liability + tenant-wise recovery / attribution report ─────────────
  @Get('recovery')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  recovery(@CurrentUser() user: JwtPayload, @Query() q: RecoveryReportQueryDto) {
    const scope: ReportScope = { clientId: this.resolveClientId(user, q.clientId), fy: q.fy };
    return this.reports.recoveryReport(scope);
  }

  @Get('recovery/export')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  async recoveryExport(
    @CurrentUser() user: JwtPayload,
    @Query() q: RecoveryReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const scope: ReportScope = { clientId: this.resolveClientId(user, q.clientId), fy: q.fy };
    const { buffer, filename } = await this.reports.recoveryReportXlsx(scope);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return new StreamableFile(buffer, { type: XLSX_MIME });
  }
}
